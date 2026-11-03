/**
 * engine.js — orchestration of ingestion, alert aggregation, analysis requests,
 * rule isolation and time advancement.
 *
 * The engine is deterministic: identical event sequences and identical clock
 * advances produce byte-identical results. It never throws while processing
 * data — with two deliberate exceptions, both caller programming errors:
 * a non-array `ingest` argument and an unavailable id factory (a factory that
 * throws or returns a non-UUIDv4). Those fail closed with
 * `DetectionConfigError` instead of being silently degraded: a broken id
 * source is a wiring fault, not a rule fault, so it must not be recorded as
 * `rule-isolated`. Only construction and rule pack loading raise otherwise.
 *
 * Determinism includes the budget: the per-rule CPU budget is metered by a
 * deterministic step clock unless the caller explicitly injects a wall clock
 * *and* accepts the loss with `allowNondeterministicBudget: true`. Metering a
 * wall clock by default made the isolated-rule set — and therefore detections —
 * depend on host speed, which is the one thing this header promises not to do.
 * See `clock.js` for the two modes and `INTEGRATION.md` §7 for the trade-off.
 *
 * ## Batches are not atomic, and a failed batch is fatal
 *
 * `ingest`, `advanceTo` and `flush` mutate engine state while they run: alert
 * windows, fingerprints, rate counters and counters are updated as each event is
 * processed. An id factory that fails halfway through a batch therefore leaves
 * the engine with the events processed before the failure already applied and
 * the remainder silently dropped. Rolling that back would require snapshotting
 * the whole state graph per batch, which is neither cheap nor honest — a partial
 * state is a real state.
 *
 * The contract is therefore explicit rather than implied:
 *
 * 1. Any exception escaping a batch **freezes the engine**. Every later call
 *    raises `DetectionConfigError` with `code: 'ENGINE_FROZEN'` and the batch
 *    that caused it, so a caller can never mistake a half-applied engine for a
 *    healthy one, and a naive retry cannot double-apply the events that did land.
 * 2. Recovery is "discard and rebuild": construct a new engine and replay from
 *    the last durable position the caller persisted. The engine holds no durable
 *    state of its own, so this is always possible.
 * 3. `stats().fatal` reports the freeze for monitoring.
 *
 * Input validation (`ingest` argument is an array, `advanceTo` is a non-negative
 * integer) happens *before* the freeze check, so a typo in a call never kills a
 * healthy engine.
 */

import {
  addObservation,
  advanceAlert,
  alertView,
  closeAlert,
  createAlert,
  observeSeverity,
  setAlertStatus as applyAlertStatus,
  settlePendingEscalation,
  windowStartFor,
} from './aggregate.js';
import { createAllowlistRuntime } from './allowlist.js';
import { createRuleBudget } from './budget.js';
import {
  DEFAULT_BUDGET_QUANTUM_MS,
  assertBudgetClock,
  assertClock,
  createStepClock,
  isRealtimeClock,
} from './clock.js';
import { canonicalStringify } from './canonical.js';
import { createCorrelationState, createSlotRegistry } from './correlation.js';
import { DetectionConfigError, RuleDefinitionError, isUnreadableFieldError } from './errors.js';
import { evaluateExpression } from './expression.js';
import { ID_FACTORY_BRAND, createRandomIdFactory } from './ids.js';
import {
  attachFieldReadCache,
  buildFingerprintKeys,
  buildGroupKey,
  computeFingerprint,
  resolveField,
} from './normalize.js';
import { requestAnalysis } from './rate-limit.js';
import { validateRulePack } from './rule-pack.js';
import { SEVERITY_LEVELS, parseSeverity } from './severity.js';
import { createStateStore } from './state-store.js';
import { createWindowState } from './windows.js';

/** Default engine limits. */
export const DEFAULT_LIMITS = Object.freeze({
  aggregationWindowMs: 900000,
  escalationCooldownMs: 300000,
  downgradeDwellMs: 900000,
  escalationStep: 1,
  maxFingerprints: 20000,
  maxCorrelationSlots: 4096,
  maxEventsPerThresholdWindow: 4096,
  maxThresholdGroups: 4096,
  maxSeenEventIds: 20000,
  stateTtlMs: 86400000,
  maxEventIdsPerAlert: 32,
  maxSuppressionRecords: 64,
  /** Budget of one rule per batch, in virtual milliseconds (see `clock.js`). */
  ruleCpuBudgetMs: 50,
  maxEvaluationsPerRulePerBatch: 20000,
  maxSweepPerCall: 64,
  analysisPerFingerprintPerHour: 4,
  analysisMinSeverity: 'medium',
  maxFingerprintValueLength: 256,
});

/** Every gap kind the engine can emit. @type {readonly string[]} */
export const GAP_KINDS = Object.freeze([
  'invalid-event',
  'duplicate-event',
  'fingerprint-limit',
  'state-expired',
  'correlation-slot-limit',
  'threshold-window-overflow',
  'threshold-group-limit',
  'late-window',
  'ingest-batch-limit',
  'rule-isolated',
  // 事件字段读不出来（getter / Proxy 陷阱）：降级本事件 + 记缺口，不隔离规则（DEF-11）。
  'unreadable-field',
]);

const INTEGER_LIMITS = Object.freeze({
  aggregationWindowMs: [1000, 86400000],
  escalationCooldownMs: [0, 86400000],
  downgradeDwellMs: [0, 86400000],
  escalationStep: [1, 4],
  maxFingerprints: [1, 1000000],
  maxCorrelationSlots: [1, 1000000],
  maxEventsPerThresholdWindow: [1, 1000000],
  maxThresholdGroups: [1, 1000000],
  maxSeenEventIds: [1, 10000000],
  stateTtlMs: [1000, 31536000000],
  maxEventIdsPerAlert: [1, 1024],
  maxSuppressionRecords: [1, 1024],
  ruleCpuBudgetMs: [1, 600000],
  maxEvaluationsPerRulePerBatch: [1, 100000000],
  maxSweepPerCall: [1, 100000],
  analysisPerFingerprintPerHour: [0, 1000],
  maxFingerprintValueLength: [8, 4096],
});

/**
 * Resolve and validate engine limits.
 *
 * Unknown keys are ignored; missing keys fall back to {@link DEFAULT_LIMITS}.
 *
 * @param {unknown} overrides Caller supplied limits.
 * @returns {typeof DEFAULT_LIMITS} Complete limits object.
 * @throws {DetectionConfigError} When a value is missing, non-integer or out of range.
 */
export function resolveLimits(overrides) {
  const source = overrides === undefined || overrides === null ? {} : overrides;
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new DetectionConfigError('limits must be an object', { path: 'limits' });
  }
  const resolved = {};
  for (const [key, range] of Object.entries(INTEGER_LIMITS)) {
    const value = source[key] === undefined ? DEFAULT_LIMITS[key] : source[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new DetectionConfigError(`limits.${key} must be an integer in ${range[0]}..${range[1]}`, {
        path: `limits.${key}`,
        detail: { min: range[0], max: range[1] },
      });
    }
    resolved[key] = value;
  }
  const minSeverity = source.analysisMinSeverity === undefined ? DEFAULT_LIMITS.analysisMinSeverity : source.analysisMinSeverity;
  if (typeof minSeverity !== 'string' || !SEVERITY_LEVELS.includes(minSeverity)) {
    throw new DetectionConfigError(`limits.analysisMinSeverity must be one of ${SEVERITY_LEVELS.join(', ')}`, {
      path: 'limits.analysisMinSeverity',
    });
  }
  resolved.analysisMinSeverity = minSeverity;
  return Object.freeze(resolved);
}

/**
 * Create a detection engine.
 *
 * @param {{
 *   rulePack: object,
 *   clock: { now: () => number },
 *   cpuClock?: { now: () => number },
 *   budgetQuantumMs?: number,
 *   allowNondeterministicBudget?: boolean,
 *   ids?: { next: (kind: string) => string },
 *   limits?: object,
 *   analysisGate?: (alert: object, context: object) => boolean,
 *   maxEventsPerIngest?: number
 * }} options Engine options. `clock` is required; `rulePack` is validated immediately.
 *   `ids` must come from `src/ids.js`; omitting it uses the CSPRNG factory.
 *   Omitting `cpuClock` installs the deterministic step clock (see
 *   {@link DEFAULT_BUDGET_QUANTUM_MS}); injecting a wall clock requires
 *   `allowNondeterministicBudget: true`.
 * @returns {{
 *   ingest: (events: readonly object[]) => object,
 *   advanceTo: (at: number) => object,
 *   flush: () => object,
 *   stats: () => object,
 *   ruleStates: () => object[],
 *   rehabilitateRule: (ruleId: string) => boolean,
 *   setAlertStatus: (alertId: string, status: string) => boolean,
 *   getAlert: (alertId: string) => object | null,
 *   suppressions: () => object[],
 *   limits: () => object
 * }} Engine handle.
 * @throws {RuleDefinitionError} When the rule pack is invalid.
 * @throws {DetectionConfigError} When clock, limits, budget clock or batch size
 *   are invalid.
 *
 * ## Budget metering is deterministic by default
 *
 * The per-rule CPU budget is metered by an injected budget clock. Omitting
 * `cpuClock` installs a step clock whose value only depends on how many times it
 * was read, so the isolation decision is a pure function of the event sequence
 * (`budgetQuantumMs` tunes the quantum). Injecting a wall clock from
 * `createRealtimeClock()` is refused unless the caller also passes
 * `allowNondeterministicBudget: true`, because then replays may isolate
 * different rules — and isolation is permanent until `rehabilitateRule`.
 *
 * `ingest` and `advanceTo` throw only for caller programming errors, and such a
 * throw **freezes the handle** (`code: 'ENGINE_FROZEN'`; `stats().fatal` is set,
 * see the file header). A non-array `ingest` argument and a negative or
 * non-integer `advanceTo` argument are rejected *before* that freeze check and
 * therefore never freeze a healthy engine.
 */
export function createDetectionEngine(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DetectionConfigError('engine options must be an object', { path: 'options' });
  }
  const clock = assertClock(options.clock, 'clock');
  const budgetQuantumMs =
    options.budgetQuantumMs === undefined ? DEFAULT_BUDGET_QUANTUM_MS : options.budgetQuantumMs;
  if (typeof budgetQuantumMs !== 'number' || !Number.isFinite(budgetQuantumMs) || budgetQuantumMs <= 0 || budgetQuantumMs > 1000) {
    throw new DetectionConfigError('budgetQuantumMs must be a finite number in (0, 1000]', {
      path: 'budgetQuantumMs',
      detail: { value: budgetQuantumMs },
    });
  }
  const allowNondeterministicBudget =
    options.allowNondeterministicBudget === undefined ? false : options.allowNondeterministicBudget;
  if (typeof allowNondeterministicBudget !== 'boolean') {
    throw new DetectionConfigError('allowNondeterministicBudget must be a boolean', {
      path: 'allowNondeterministicBudget',
    });
  }
  const cpuClock = options.cpuClock === undefined
    ? null
    : assertBudgetClock(options.cpuClock, 'cpuClock');
  if (cpuClock !== null && isRealtimeClock(cpuClock) && !allowNondeterministicBudget) {
    throw new DetectionConfigError(
      'cpuClock is a wall clock: metering it makes rule isolation depend on host speed, so the same events '
        + 'can produce different detections. Pass allowNondeterministicBudget: true to accept that trade-off, '
        + 'or omit cpuClock to use the deterministic step clock.',
      { path: 'cpuClock', code: 'NONDETERMINISTIC_BUDGET' },
    );
  }
  const budgetClockMode = cpuClock === null ? 'step' : isRealtimeClock(cpuClock) ? 'realtime' : 'custom';
  // 预算表是**每规则**的，默认因此每规则一个步进时钟：共用一只全局步进时钟会让
  // 单规则的计量随规则条数线性膨胀（60 条规则时 83 个事件就把 50ms 花光，
  // 实测 detections 从 60000 掉到 4980），那是另一个"预算形同虚设"的变体。
  const budgetClockFor = () => (cpuClock === null ? createStepClock({ quantumMs: budgetQuantumMs }) : cpuClock);
  const limits = resolveLimits(options.limits);
  const idFactory = options.ids === undefined ? createRandomIdFactory() : options.ids;
  if (
    idFactory === null ||
    typeof idFactory !== 'object' ||
    idFactory[ID_FACTORY_BRAND] !== true ||
    typeof idFactory.next !== 'function'
  ) {
    throw new DetectionConfigError('ids must be an id factory created by ids.js', { path: 'ids' });
  }
  const nextId = idFactory.next;
  const analysisGate = options.analysisGate;
  if (analysisGate !== undefined && typeof analysisGate !== 'function') {
    throw new DetectionConfigError('analysisGate must be a function', { path: 'analysisGate' });
  }
  const maxEventsPerIngest = options.maxEventsPerIngest === undefined ? 1000 : options.maxEventsPerIngest;
  if (!Number.isInteger(maxEventsPerIngest) || maxEventsPerIngest < 1 || maxEventsPerIngest > 100000) {
    throw new DetectionConfigError('maxEventsPerIngest must be an integer in 1..100000', { path: 'maxEventsPerIngest' });
  }
  if (options.rulePack === undefined) {
    throw new RuleDefinitionError('rulePack is required', { code: 'RULE_PACK_MISSING', path: 'rulePack' });
  }
  const pack = validateRulePack(options.rulePack);
  const allowlistRuntime = createAllowlistRuntime(pack.allowlist);
  const slotRegistry = createSlotRegistry(limits.maxCorrelationSlots);
  const store = createStateStore({
    maxFingerprints: limits.maxFingerprints,
    stateTtlMs: limits.stateTtlMs,
    maxSweepPerCall: limits.maxSweepPerCall,
  });

  const rules = pack.rules.map((rule) => ({
    rule,
    enabled: rule.enabled,
    isolation: null,
    budgetClock: budgetClockFor(),
    budget: createRuleBudget({
      cpuBudgetMs: limits.ruleCpuBudgetMs,
      maxSteps: limits.maxEvaluationsPerRulePerBatch,
    }),
    window:
      rule.type === 'threshold'
        ? createWindowState({
            windowMs: rule.windowMs,
            maxEvents: Math.min(rule.maxEvents ?? limits.maxEventsPerThresholdWindow, limits.maxEventsPerThresholdWindow),
            threshold: rule.count.value,
            maxGroups: limits.maxThresholdGroups,
          })
        : null,
    correlation:
      rule.type === 'correlation'
        ? createCorrelationState({ steps: rule.steps, withinMs: rule.withinMs, registry: slotRegistry })
        : null,
  }));

  const seenEventIds = new Set();
  const openAlerts = new Map();
  const suppressionRecords = [];
  const counters = {
    events: 0,
    eventsSuppressed: 0,
    duplicateEvents: 0,
    invalidEvents: 0,
    detections: 0,
    alerts: 0,
    closedAlerts: 0,
    analysisRequests: 0,
    analysisDenied: 0,
    ruleIsolations: 0,
    evictions: 0,
    expiredStates: 0,
    // 字段读不出来而被降级的事件数（不计入 invalidEvents：事件本身没被判为非法，
    // 只是这条规则读不到它需要的字段）。
    unreadableFields: 0,
  };
  const gapsByKind = {};
  for (const kind of GAP_KINDS) {
    gapsByKind[kind] = 0;
  }
  let currentAt = clock.now();
  let batchSequence = 0;

  /**
   * Set once a batch throws. `{ batch, at, reason }` after the freeze, else `null`.
   *
   * See the file header: a batch that throws is not rolled back, so the only
   * truthful thing the engine can do is refuse to continue.
   */
  let fatal = null;

  /**
   * Refuse to run a batch when a previous one already failed.
   *
   * @throws {DetectionConfigError} With `code: 'ENGINE_FROZEN'` naming the failed batch.
   */
  function assertNotFrozen() {
    if (fatal === null) {
      return;
    }
    throw new DetectionConfigError(
      `detection engine is frozen: batch ${fatal.batch} failed at ${fatal.at} (${fatal.reason}). `
        + 'Events before the failure were already applied and cannot be rolled back. '
        + 'Discard this engine and rebuild it from the last durable position; '
        + 'do not replay the failed batch into this instance.',
      {
        path: 'engine',
        code: 'ENGINE_FROZEN',
        detail: { batch: fatal.batch, at: fatal.at, reason: fatal.reason },
      },
    );
  }

  /**
   * Record a fatal batch failure, keeping the first one.
   *
   * @param {unknown} error Error that escaped the batch.
   * @returns {void}
   */
  function freeze(error) {
    if (fatal !== null) {
      return;
    }
    fatal = { batch: batchSequence, at: currentAt, reason: messageOf(error) };
  }

  function addGap(batch, gap) {
    gapsByKind[gap.kind] = (gapsByKind[gap.kind] ?? 0) + gap.count;
    const key = `${gap.kind}|${gap.ruleId ?? ''}|${gap.detail === undefined ? '' : canonicalStringify(gap.detail)}`;
    const existing = batch.gapIndex.get(key);
    if (existing !== undefined) {
      existing.count += gap.count;
      if (gap.at < existing.at) {
        existing.at = gap.at;
      }
      if (
        existing.detail !== undefined &&
        gap.detail !== undefined &&
        typeof existing.detail.dropped === 'number' &&
        typeof gap.detail.dropped === 'number'
      ) {
        existing.detail.dropped += gap.detail.dropped;
      }
      return;
    }
    const entry = { kind: gap.kind, count: gap.count, at: gap.at };
    if (gap.ruleId !== undefined) {
      entry.ruleId = gap.ruleId;
    }
    if (gap.detail !== undefined) {
      entry.detail = gap.detail;
    }
    batch.gapIndex.set(key, entry);
    batch.gaps.push(entry);
  }

  function createBatch(at) {
    return {
      at,
      eventsProcessed: 0,
      eventsSuppressed: 0,
      decisions: [],
      detections: [],
      alerts: new Map(),
      closedAlerts: new Map(),
      analysisRequests: [],
      analysisDenied: [],
      gaps: [],
      gapIndex: new Map(),
      ruleIsolations: [],
    };
  }

  function isolateRule(runtime, failure, batch) {
    if (runtime.isolation !== null) {
      return;
    }
    const reason = failure.reason ?? failure.kind;
    // 预算耗尽的实测值必须留下：旧实现把它丢掉，运维只能看到"被隔离了"，
    // 无法判断是 51ms 还是 5000ms，也就无法区分"规则太慢"和"预算配太小"。
    const cpuUsedMs = typeof failure.cpuUsedMs === 'number' ? failure.cpuUsedMs : null;
    const steps = typeof failure.steps === 'number' ? failure.steps : null;
    runtime.isolation = {
      ruleId: runtime.rule.ruleId,
      state: 'isolated',
      kind: failure.kind,
      reason,
      isolatedAt: batch.at,
      batchId: `batch-${batchSequence}`,
      cpuUsedMs,
      steps,
    };
    counters.ruleIsolations += 1;
    batch.ruleIsolations.push({ ruleId: runtime.rule.ruleId, kind: failure.kind, reason, at: batch.at, cpuUsedMs, steps });
    if (runtime.window !== null) {
      runtime.window.reset();
    }
    if (runtime.correlation !== null) {
      runtime.correlation.reset();
    }
    addGap(batch, { kind: 'rule-isolated', count: 1, at: batch.at, ruleId: runtime.rule.ruleId, detail: { reason } });
  }

  function resolveSeverity(rule, event) {
    if (rule.severityFrom !== null) {
      const raw = resolveField(event, rule.severityFrom);
      const parsed = typeof raw === 'string' ? parseSeverity(raw) : null;
      if (parsed !== null) {
        return parsed;
      }
    }
    return rule.severity;
  }

  function createDetection(runtime, event, extra) {
    const rule = runtime.rule;
    const fingerprint = computeFingerprint({
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      specification: rule.fingerprint,
      event,
      maxPreviewLength: limits.maxFingerprintValueLength,
    });
    const detection = {
      detectionId: nextId('detection'),
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ruleType: rule.type,
      eventIds: [event.eventId],
      fingerprint: fingerprint.fingerprint,
      fingerprintPreview: fingerprint.preview,
      severity: resolveSeverity(rule, event),
      observedAt: event.observedAt,
    };
    if (extra.matchedSteps !== undefined) {
      detection.matchedSteps = [...extra.matchedSteps];
    }
    if (extra.observations !== undefined) {
      detection.observations = extra.observations;
    }
    detection.tags = [...rule.tags];
    return detection;
  }

  function evaluateRule(runtime, event, batch) {
    const rule = runtime.rule;
    const counter = { steps: 0 };
    let detection = null;
    try {
      if (rule.type === 'condition') {
        if (evaluateExpression(rule.when, event, counter)) {
          detection = createDetection(runtime, event, {});
        }
      } else if (rule.type === 'threshold') {
        const hit = rule.when === null ? true : evaluateExpression(rule.when, event, counter);
        if (hit) {
          const outcome = runtime.window.record(buildGroupKey(rule.groupBy, event), event.observedAt);
          if (outcome.evictedGroups > 0) {
            addGap(batch, {
              kind: 'threshold-group-limit',
              count: outcome.evictedGroups,
              at: event.observedAt,
              ruleId: rule.ruleId,
            });
          }
          if (outcome.dropped > 0) {
            addGap(batch, {
              kind: 'threshold-window-overflow',
              count: outcome.dropped,
              at: event.observedAt,
              ruleId: rule.ruleId,
              detail: { dropped: outcome.dropped },
            });
          }
          if (outcome.fired) {
            detection = createDetection(runtime, event, { observations: outcome.count });
          }
        }
      } else {
        const groupKey =
          rule.groupBy === null
            ? canonicalStringify(buildFingerprintKeys(rule.fingerprint, event))
            : buildGroupKey(rule.groupBy, event);
        const outcome = runtime.correlation.observe(groupKey, event, event.observedAt, counter);
        if (outcome.expired > 0) {
          counters.expiredStates += outcome.expired;
        }
        if (outcome.slotLimited) {
          addGap(batch, {
            kind: 'correlation-slot-limit',
            count: 1,
            at: event.observedAt,
            ruleId: rule.ruleId,
          });
        }
        if (outcome.fired) {
          detection = createDetection(runtime, event, { matchedSteps: outcome.matchedSteps });
        }
      }
    } catch (error) {
      // 配置/工厂故障不是规则故障：id 工厂不可用是调用方接线错误，
      // 必须 fail-closed 抛出，不能静默记成 rule-isolated（那会把它归因给规则）。
      if (error instanceof DetectionConfigError) {
        throw error;
      }
      // 事件字段不可读（getter / Proxy 陷阱）是**数据**故障，不是规则代码 bug（DEF-11）。
      // 旧实现把两者都送进 isolateRule，于是"一条畸形事件"就能让一条规则在后续所有
      // 批次里永久闭嘴，直到有人手工 rehabilitateRule —— 数据驱动的检测 DoS。
      // 现在只降级本事件：不命中、记一条 unreadable-field 缺口、规则保持启用。
      if (isUnreadableFieldError(error)) {
        counters.unreadableFields += 1;
        addGap(batch, {
          kind: 'unreadable-field',
          count: 1,
          at: event.observedAt,
          ruleId: runtime.rule.ruleId,
          detail: {
            path: error.path,
            reason: typeof error.detail?.reason === 'string' ? error.detail.reason : messageOf(error),
          },
        });
        return null;
      }
      isolateRule(runtime, { kind: 'error', reason: messageOf(error) }, batch);
      return null;
    }
    // 预算记账刻意放在 try 之外：`budgetClock.now()` 抛错是接线故障，不是规则故障。
    // 留在 try 里会被 isolateRule 吞成 rule-isolated，把"时钟坏了"错误地归因给规则
    // （独立审查 P2-1 实测）。放在这里，它会逃出批次并冻结引擎，与 id 工厂故障一致。
    runtime.budget.addSteps(counter.steps);
    const exceeded = runtime.budget.exceeded(runtime.budgetClock.now());
    if (exceeded !== null) {
      isolateRule(runtime, exceeded, batch);
      return null;
    }
    return detection;
  }

  function releaseAnalysis(alert, entry, at, batch) {
    const outcome = requestAnalysis({
      alert,
      alertView: alertView(alert),
      fingerprint: alert.fingerprint,
      ruleId: alert.ruleId,
      at,
      rateState: entry.rate,
      limits,
      gate: analysisGate,
      nextId,
    });
    if (outcome.status === 'released') {
      alert.analysisRequested += 1;
      batch.analysisRequests.push(outcome.request);
      counters.analysisRequests += 1;
      return;
    }
    if (outcome.status === 'denied') {
      batch.analysisDenied.push(outcome.denial);
      counters.analysisDenied += 1;
    }
  }

  function closeEntryAlert(entry, batch) {
    const alert = entry.alert;
    closeAlert(alert);
    batch.closedAlerts.set(alert.alertId, alert);
    openAlerts.delete(alert.alertId);
    counters.closedAlerts += 1;
    entry.alert = null;
    entry.closedWindowStart = alert.windowStart;
    entry.inherited = {
      severity: alert.severity,
      lastEscalationAt: alert.lastEscalationAt,
      pendingEscalation: alert.pendingEscalation === null ? null : { ...alert.pendingEscalation },
    };
    return entry.inherited;
  }

  function aggregate(detection, batch) {
    const windowStart = windowStartFor(detection.observedAt, limits.aggregationWindowMs);
    let entry = store.get(detection.fingerprint);
    if (entry !== undefined) {
      const behindClosed = entry.closedWindowStart !== null && windowStart <= entry.closedWindowStart;
      const behindOpen = entry.alert !== null && windowStart < entry.alert.windowStart;
      if (behindClosed || behindOpen) {
        addGap(batch, {
          kind: 'late-window',
          count: 1,
          at: detection.observedAt,
          detail: { fingerprint: detection.fingerprint },
        });
        return 'late-window';
      }
    }
    let inherited = null;
    if (entry === undefined) {
      entry = store.ensure(detection.fingerprint, (victim) => {
        counters.evictions += 1;
        if (victim.alert !== null) {
          openAlerts.delete(victim.alert.alertId);
          batch.alerts.delete(victim.alert.alertId);
        }
        addGap(batch, {
          kind: 'fingerprint-limit',
          count: 1,
          at: batch.at,
          detail: { fingerprint: victim.fingerprint },
        });
      });
    } else if (entry.alert !== null && entry.alert.windowStart < windowStart) {
      inherited = closeEntryAlert(entry, batch);
    }
    let alert = entry.alert;
    let created = false;
    if (alert === null) {
      inherited = inherited ?? entry.inherited;
      alert = createAlert({
        fingerprint: detection.fingerprint,
        ruleId: detection.ruleId,
        ruleVersion: detection.ruleVersion,
        ruleType: detection.ruleType,
        windowStart,
        windowMs: limits.aggregationWindowMs,
        inherited,
        nextId,
      });
      entry.alert = alert;
      entry.inherited = null;
      openAlerts.set(alert.alertId, alert);
      counters.alerts += 1;
      created = true;
    }
    addObservation(alert, {
      observedAt: detection.observedAt,
      eventId: detection.eventIds[0],
      maxEventIds: limits.maxEventIdsPerAlert,
    });
    store.touch(entry, Math.max(detection.observedAt, batch.at));
    if (settlePendingEscalation(alert, detection.observedAt).escalated) {
      releaseAnalysis(alert, entry, detection.observedAt, batch);
    }
    const transition = observeSeverity(alert, detection.severity, detection.observedAt, limits);
    if (created || transition.escalated) {
      releaseAnalysis(alert, entry, detection.observedAt, batch);
    }
    batch.alerts.set(alert.alertId, alert);
    return 'applied';
  }

  function advanceEntry(entry, at, batch) {
    const alert = entry.alert;
    if (alert === null) {
      return;
    }
    const transition = advanceAlert(alert, at, limits);
    if (transition.escalated) {
      releaseAnalysis(alert, entry, at, batch);
    }
    if (transition.changed) {
      batch.alerts.set(alert.alertId, alert);
    }
  }

  function countCorrelationSlots() {
    let total = 0;
    for (const runtime of rules) {
      if (runtime.correlation !== null) {
        total += runtime.correlation.slotCount();
      }
    }
    return total;
  }

  function countThresholdGroups() {
    let total = 0;
    for (const runtime of rules) {
      if (runtime.window !== null) {
        total += runtime.window.groupCount();
      }
    }
    return total;
  }

  function sweepExpired(at, batch) {
    store.sweep(at, (removed) => {
      for (const entry of removed) {
        if (entry.alert !== null) {
          openAlerts.delete(entry.alert.alertId);
        }
      }
      counters.expiredStates += removed.length;
      addGap(batch, { kind: 'state-expired', count: removed.length, at });
    });
  }

  function processEvent(rawEvent, batch) {
    batch.eventsProcessed += 1;
    counters.events += 1;
    const shape = readEventShape(rawEvent);
    if (shape.reason !== null) {
      counters.invalidEvents += 1;
      batch.decisions.push(
        shape.eventId === undefined
          ? { outcome: 'invalid', reason: shape.reason }
          : { eventId: shape.eventId, outcome: 'invalid', reason: shape.reason },
      );
      addGap(batch, { kind: 'invalid-event', count: 1, at: batch.at });
      return;
    }
    const event = shape.event;
    if (seenEventIds.has(event.eventId)) {
      counters.duplicateEvents += 1;
      batch.decisions.push({ eventId: event.eventId, outcome: 'duplicate' });
      return;
    }
    rememberEventId(event.eventId);

    let suppressedRuleIds = null;
    let matchedAllowId = null;
    try {
      const counter = { steps: 0 };
      const match = allowlistRuntime.match(event, batch.at, counter);
      if (match.entry !== null) {
        matchedAllowId = match.entry.allowId;
        counters.eventsSuppressed += 1;
        batch.eventsSuppressed += 1;
        recordSuppression({ allowId: matchedAllowId, eventId: event.eventId, at: batch.at, reason: match.entry.reason });
        suppressedRuleIds = match.entry.ruleIds === null ? null : new Set(match.entry.ruleIds);
        if (match.entry.ruleIds === null) {
          batch.decisions.push({ eventId: event.eventId, outcome: 'suppressed', allowId: matchedAllowId });
          return;
        }
      }
    } catch {
      suppressedRuleIds = null;
      matchedAllowId = null;
    }

    const matchedRuleIds = [];
    let applied = 0;
    let late = 0;
    for (const runtime of rules) {
      if (runtime.isolation !== null || !runtime.enabled) {
        continue;
      }
      if (suppressedRuleIds !== null && suppressedRuleIds.has(runtime.rule.ruleId)) {
        continue;
      }
      const detection = evaluateRule(runtime, event, batch);
      if (detection !== null) {
        if (aggregate(detection, batch) === 'late-window') {
          late += 1;
        } else {
          counters.detections += 1;
          batch.detections.push(detection);
          matchedRuleIds.push(detection.ruleId);
          applied += 1;
        }
      }
    }
    if (matchedAllowId === null) {
      if (applied === 0 && late > 0) {
        batch.decisions.push({ eventId: event.eventId, outcome: 'late-window' });
        return;
      }
      batch.decisions.push({ eventId: event.eventId, outcome: 'evaluated', ruleIds: matchedRuleIds });
      return;
    }
    batch.decisions.push({
      eventId: event.eventId,
      outcome: 'suppressed',
      allowId: matchedAllowId,
      ruleIds: matchedRuleIds,
    });
  }

  function rememberEventId(eventId) {
    if (seenEventIds.size >= limits.maxSeenEventIds) {
      const oldest = seenEventIds.values().next().value;
      seenEventIds.delete(oldest);
    }
    seenEventIds.add(eventId);
  }

  function recordSuppression(record) {
    suppressionRecords.push(record);
    while (suppressionRecords.length > limits.maxSuppressionRecords) {
      suppressionRecords.shift();
    }
  }

  function buildResult(batch) {
    const detections = batch.detections.slice().sort(compareDetections);
    const alerts = [...batch.alerts.values()].map(alertView).sort(compareAlertViews);
    const closedAlerts = [...batch.closedAlerts.values()].map(alertView).sort(compareAlertViews);
    const analysisRequests = batch.analysisRequests.slice().sort(compareRequests);
    const analysisDenied = batch.analysisDenied.slice().sort(compareDenials);
    const gaps = batch.gaps.slice().sort(compareGaps);
    const ruleIsolations = batch.ruleIsolations.slice().sort(compareIsolations);
    return {
      at: batch.at,
      eventsProcessed: batch.eventsProcessed,
      eventsSuppressed: batch.eventsSuppressed,
      detections,
      alerts,
      closedAlerts,
      analysisRequests,
      analysisDenied,
      gaps,
      ruleIsolations,
      decisions: batch.decisions,
    };
  }

  function ingest(events) {
    if (!Array.isArray(events)) {
      throw new DetectionConfigError('ingest expects an array of events', { path: 'events' });
    }
    assertNotFrozen();
    try {
      return runIngest(events);
    } catch (error) {
      freeze(error);
      throw error;
    }
  }

  /**
   * Ingest a batch. Only called by {@link ingest}, after the array check and the
   * frozen-engine guard, so that argument errors never freeze a healthy engine.
   *
   * @param {readonly object[]} events Events of the batch.
   * @returns {object} Batch result.
   */
  function runIngest(events) {
    batchSequence += 1;
    const at = clock.now();
    if (at > currentAt) {
      currentAt = at;
    }
    const batch = createBatch(currentAt);
    sweepExpired(currentAt, batch);
    if (events.length > maxEventsPerIngest) {
      addGap(batch, { kind: 'ingest-batch-limit', count: events.length - maxEventsPerIngest, at: currentAt });
    }
    const limit = Math.min(events.length, maxEventsPerIngest);
    for (const runtime of rules) {
      runtime.budget.begin(runtime.budgetClock.now());
    }
    for (let index = 0; index < limit; index += 1) {
      processEvent(events[index], batch);
    }
    for (const fingerprint of store.fingerprints()) {
      const entry = store.get(fingerprint);
      if (entry !== undefined) {
        advanceEntry(entry, currentAt, batch);
      }
    }
    return buildResult(batch);
  }

  function advanceTo(at) {
    if (!Number.isInteger(at) || at < 0) {
      throw new DetectionConfigError('advanceTo expects a non-negative integer timestamp', { path: 'at' });
    }
    assertNotFrozen();
    try {
      return runAdvanceTo(at);
    } catch (error) {
      freeze(error);
      throw error;
    }
  }

  /**
   * Advance the clock. Only called by {@link advanceTo}, after validation and the
   * frozen-engine guard.
   *
   * @param {number} at Non-negative integer timestamp.
   * @returns {object} Batch result.
   */
  function runAdvanceTo(at) {
    batchSequence += 1;
    if (at < currentAt) {
      return buildResult(createBatch(currentAt));
    }
    currentAt = at;
    const batch = createBatch(currentAt);
    for (const runtime of rules) {
      if (runtime.correlation !== null) {
        const expired = runtime.correlation.sweep(at);
        counters.expiredStates += expired;
      }
      if (runtime.window !== null) {
        runtime.window.prune(at);
      }
    }
    for (const fingerprint of store.fingerprints()) {
      const entry = store.get(fingerprint);
      if (entry === undefined) {
        continue;
      }
      advanceEntry(entry, at, batch);
      if (entry.alert !== null && entry.alert.windowEnd <= at) {
        closeEntryAlert(entry, batch);
      }
    }
    sweepExpired(at, batch);
    return buildResult(batch);
  }

  return {
    ingest,
    advanceTo,
    flush() {
      return advanceTo(clock.now());
    },
    /** Snapshot of engine counters.
     *
     * `thresholdGroups` sums the group tables of every threshold rule while
     * `limits.maxThresholdGroups` bounds a single rule; `correlationSlots` sums
     * per-rule slots while `limits.maxCorrelationSlots` is the shared global
     * bound. Summed counters and configured bounds are therefore not directly
     * comparable.
     *
     * `budgetClock` names the metering mode (`'step'` by default, `'custom'` for
     * an injected clock, `'realtime'` for an accepted wall clock that gives up
     * replay determinism), `budgetQuantumMs` is the step quantum (or `null` when
     * the caller supplied the clock) and `nondeterministicBudget` is the
     * explicit admission that replays may isolate different rules.
     *
     * @returns {object} Counters, `gapsByKind`, capacity gauges, rule tallies,
     *   the budget-metering mode and the `fatal` freeze record (`null` while the
     *   engine is healthy).
     */
    stats() {
      let rulesEnabled = 0;
      let rulesIsolated = 0;
      for (const runtime of rules) {
        if (runtime.isolation !== null) {
          rulesIsolated += 1;
        } else if (runtime.enabled) {
          rulesEnabled += 1;
        }
      }
      return {
        events: counters.events,
        eventsSuppressed: counters.eventsSuppressed,
        duplicateEvents: counters.duplicateEvents,
        invalidEvents: counters.invalidEvents,
        detections: counters.detections,
        alerts: counters.alerts,
        openFingerprints: store.size(),
        thresholdGroups: countThresholdGroups(),
        closedAlerts: counters.closedAlerts,
        analysisRequests: counters.analysisRequests,
        analysisDenied: counters.analysisDenied,
        ruleIsolations: counters.ruleIsolations,
        evictions: counters.evictions,
        expiredStates: counters.expiredStates,
        unreadableFields: counters.unreadableFields,
        allowlistExpired: allowlistRuntime.expiredCount(),
        correlationSlots: countCorrelationSlots(),
        gapsByKind: { ...gapsByKind },
        rulesEnabled,
        rulesIsolated,
        budgetClock: budgetClockMode,
        budgetQuantumMs: budgetClockMode === 'step' ? budgetQuantumMs : null,
        nondeterministicBudget: budgetClockMode === 'realtime',
        fatal: fatal === null ? null : { batch: fatal.batch, at: fatal.at, reason: fatal.reason },
      };
    },
    ruleStates() {
      return rules
        .map((runtime) => ({
          ruleId: runtime.rule.ruleId,
          state: runtime.isolation !== null ? 'isolated' : runtime.enabled ? 'enabled' : 'disabled',
          kind: runtime.isolation === null ? null : runtime.isolation.kind,
          reason: runtime.isolation === null ? null : runtime.isolation.reason,
          isolatedAt: runtime.isolation === null ? null : runtime.isolation.isolatedAt,
          batchId: runtime.isolation === null ? null : runtime.isolation.batchId,
          cpuUsedMs: runtime.isolation === null ? null : runtime.isolation.cpuUsedMs,
          steps: runtime.isolation === null ? null : runtime.isolation.steps,
        }))
        .sort((left, right) => compareText(left.ruleId, right.ruleId));
    },
    rehabilitateRule(ruleId) {
      // 冻结后不再接受任何状态变更：让调用方以为"康复规则"还能救活一个已经
      // 半落地的引擎，只会掩盖必须重建这一事实（审查 P2-2）。
      assertNotFrozen();
      const runtime = rules.find((candidate) => candidate.rule.ruleId === ruleId);
      if (runtime === undefined) {
        return false;
      }
      runtime.isolation = null;
      runtime.enabled = true;
      if (runtime.window !== null) {
        runtime.window.reset();
      }
      if (runtime.correlation !== null) {
        runtime.correlation.reset();
      }
      return true;
    },
    setAlertStatus(alertId, status) {
      assertNotFrozen();
      const alert = openAlerts.get(alertId);
      if (alert === undefined) {
        return false;
      }
      return applyAlertStatus(alert, status);
    },
    getAlert(alertId) {
      const alert = openAlerts.get(alertId);
      return alert === undefined ? null : alertView(alert);
    },
    suppressions() {
      return suppressionRecords.map((record) => ({ ...record }));
    },
    limits() {
      return { ...limits };
    },
  };
}

/**
 * Read and validate the event shape exactly once.
 *
 * Every property access is guarded: a hostile or broken getter degrades the
 * single event into an `invalid` decision instead of escaping to the caller. The
 * returned `event` is a plain snapshot of the validated top level fields, so
 * later evaluation never re-enters a getter.
 *
 * @param {unknown} rawEvent Caller supplied event.
 * @returns {{ reason: string | null, eventId?: string, event?: object }} Shape result.
 *   `reason` is `null` when the event is usable.
 */
function readEventShape(rawEvent) {
  let eventId;
  try {
    if (rawEvent === null || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      return { reason: 'event-must-be-object' };
    }
    eventId = rawEvent.eventId;
    if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 256) {
      return {
        reason: 'invalid-event-id',
        eventId: typeof eventId === 'string' ? eventId : undefined,
      };
    }
    const observedAt = rawEvent.observedAt;
    if (!Number.isInteger(observedAt) || observedAt < 0) {
      return { reason: 'invalid-observed-at', eventId };
    }
    const type = rawEvent.type;
    if (typeof type !== 'string' || type.length === 0 || type.length > 128) {
      return { reason: 'invalid-type', eventId };
    }
    const source = rawEvent.source;
    if (typeof source !== 'string' || source.length === 0 || source.length > 256) {
      return { reason: 'invalid-source', eventId };
    }
    const severity = rawEvent.severity;
    if (severity !== undefined && parseSeverity(severity) === null) {
      return { reason: 'invalid-severity', eventId };
    }
    const fields = rawEvent.fields;
    if (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields))) {
      return { reason: 'invalid-fields', eventId };
    }
    const event = { eventId, observedAt, type, source };
    if (severity !== undefined) {
      event.severity = severity;
    }
    if (fields !== undefined) {
      event.fields = fields;
    }
    // DEF-09：给快照挂上"每个属性只读一次"的缓存。`fields` 仍是调用方对象的引用，
    // 但没有这层缓存时 `resolveField` 每次求值都会重新进 getter：条件在 v1 上命中，
    // 指纹却可能用 v2 算出来。缓存让同一事件内的读取结果一致。
    attachFieldReadCache(event);
    return { reason: null, eventId, event };
  } catch {
    return { reason: 'unreadable-event', eventId: typeof eventId === 'string' ? eventId : undefined };
  }
}

function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return 'rule-evaluation-failed';
}

function compareText(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareDetections(left, right) {
  if (left.observedAt !== right.observedAt) {
    return left.observedAt - right.observedAt;
  }
  if (left.ruleId !== right.ruleId) {
    return compareText(left.ruleId, right.ruleId);
  }
  return compareText(left.fingerprint, right.fingerprint);
}

function compareAlertViews(left, right) {
  if (left.windowStart !== right.windowStart) {
    return left.windowStart - right.windowStart;
  }
  return compareText(left.fingerprint, right.fingerprint);
}

function compareRequests(left, right) {
  if (left.hourStart !== right.hourStart) {
    return left.hourStart - right.hourStart;
  }
  if (left.fingerprint !== right.fingerprint) {
    return compareText(left.fingerprint, right.fingerprint);
  }
  return left.sequenceInHour - right.sequenceInHour;
}

function compareDenials(left, right) {
  if (left.hourStart !== right.hourStart) {
    return left.hourStart - right.hourStart;
  }
  if (left.fingerprint !== right.fingerprint) {
    return compareText(left.fingerprint, right.fingerprint);
  }
  return compareText(left.reason, right.reason);
}

function compareGaps(left, right) {
  if (left.kind !== right.kind) {
    return compareText(left.kind, right.kind);
  }
  const leftRule = left.ruleId ?? '';
  const rightRule = right.ruleId ?? '';
  if (leftRule !== rightRule) {
    return compareText(leftRule, rightRule);
  }
  return left.at - right.at;
}

function compareIsolations(left, right) {
  if (left.ruleId !== right.ruleId) {
    return compareText(left.ruleId, right.ruleId);
  }
  return left.at - right.at;
}
