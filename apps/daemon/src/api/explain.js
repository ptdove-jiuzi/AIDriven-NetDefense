/**
 * api/explain.js — `POST /api/v1/alerts/:id/explain` (SSE, §2.6).
 *
 * An explanation is a chat turn with a **server-built prompt**: the operator's alert
 * is projected onto the twelve public fields and nothing else. This module is where
 * that containment is enforced, and it is the reason the route exists at all instead
 * of the browser sending an alert summary: the browser does not get to decide what
 * leaves the machine, and it does not get to include `event_ids`, raw event bodies or
 * `canonical_json`.
 *
 * The prompt has two halves, both constants:
 * - a one-sentence task instruction in the request's language (this file);
 * - one `user` line per projected field, with the value stringified as data.
 *
 * Rate limits (§2.6): one in flight per alert and five starts per rolling minute for
 * the whole process. Both are refusals *before* the child exists, so a 429 costs no
 * spawn and no egress.
 *
 * Nothing is persisted: an explanation is a view, not an analysis record.
 */

import { createRequire } from 'node:module';

import { CONSOLE_CODES, ConsoleError } from './console-errors.js';
import { CHAT_LOCALES, runStreamingTurn, selectModelAndProvider } from './chat.js';
import { MODEL_ID_PATTERN } from './settings-schema.js';
import { DaemonError, DAEMON_CODES } from '../errors.js';

/**
 * Guarded load of the routing judge (`packages/policy/src/model-routing.js`).
 *
 * The judge is **not** part of the packaged daemon layout: `packages/policy` is not a
 * workspace package and is not bundled, and the release tree places this file at
 * `…/app/node_modules/@aegisharness/daemon/src/api/explain.js`, where four levels of
 * `..` land in `app/node_modules/packages/policy/…` (absent). Because `daemon.js`
 * imports this module **statically**, a static import would fail while the daemon is
 * booting — turning "no escalation judge" into "the product does not start".
 *
 * So the module is loaded once, guarded and synchronously (Node 24 can `require()` ESM):
 * - repository layout: the judge is available and routing behaves as before;
 * - packaged layout: `routingModule` stays `null`, severity routing degrades to the
 *   pre-existing `defaultTier` selection, and the reason is visible in the
 *   `explain.route` log line / `routing.last()` (never a silent upgrade, never a 4xx).
 */
const requireFromHere = createRequire(import.meta.url);

/** Relative location of the judge from this file (same depth in repo and bundle). */
export const ROUTING_MODULE_SPECIFIER = '../../../../packages/policy/src/model-routing.js';

/** @type {{selectRoute: Function, HOUR_MS?: number}|null} */
let routingModule = null;
/** @type {string|null} Why the judge is unavailable (`null` when it loaded). */
let routingLoadError = null;
try {
  const loaded = requireFromHere(ROUTING_MODULE_SPECIFIER);
  if (typeof loaded?.selectRoute === 'function') {
    routingModule = loaded;
  } else {
    routingLoadError = 'E_ROUTING_SHAPE';
  }
} catch (error) {
  routingLoadError = typeof error?.code === 'string' ? error.code : 'MODULE_NOT_FOUND';
}

/**
 * Report whether the routing judge could be loaded.
 *
 * @returns {{available: boolean, error: string|null}} Availability (no paths exposed).
 */
export function routingJudgeStatus() {
  return { available: routingModule !== null, error: routingLoadError };
}


/** Rolling window for the process-wide explain budget. */
export const EXPLAIN_WINDOW_MS = 60_000;

/** Starts allowed per rolling window, process-wide. */
export const EXPLAIN_PER_MINUTE = 5;

/** In-flight explanations allowed per alert. */
export const EXPLAIN_PER_ALERT = 1;

/**
 * The only fields that may leave for an explanation (contract §2.6).
 *
 * Written as a list rather than as deletions from the stored row: the next schema
 * migration must not be able to add a field that silently travels.
 */
export const EXPLAIN_FIELDS = Object.freeze([
  'alert_id',
  'rule_id',
  'rule_version',
  'severity',
  'status',
  'count',
  'first_seen',
  'last_seen',
  'window_start',
  'window_end',
  'evidence_count',
  'evidence_truncated',
]);

/**
 * Fixed one-sentence task instructions, per locale.
 *
 * The instruction owns the answer's framing; it also repeats the product's
 * non-negotiables (no invented assets, no credential output) so a provider-side
 * prompt-injection attempt in an alert field has less room.
 */
export const EXPLAIN_SYSTEM_PROMPTS = Object.freeze({
  en: 'Explain the alert described by the JSON fields below for a defender. Use only those fields, do not invent host or asset details, do not output credentials or raw log lines, and end with one concrete next step.',
  'zh-CN': '请向防守方解释下面这些告警字段。只能依据给出的字段作答，不编造主机或资产信息，不输出凭据或原始日志内容，最后给出一个可执行的下一步。',
  ja: '以下の JSON フィールドで示されたアラートを防御者向けに説明してください。与えられたフィールドのみを使い、ホストや資産の情報を捏造せず、資格情報や生ログを出力せず、最後に具体的な次の一手を一つ示してください。',
  ko: '아래 JSON 필드로 설명된 경고를 방어자에게 설명하십시오. 주어진 필드만 사용하고, 호스트나 자산 정보를 꾸며내지 말고, 자격 증명이나 원시 로그를 출력하지 말며, 마지막에 구체적인 다음 조치 하나를 제시하십시오.',
  es: 'Explica al defensor la alerta descrita por los campos JSON siguientes. Usa solo esos campos, no inventes hosts ni activos, no muestres credenciales ni registros sin procesar, y termina con un paso siguiente concreto.',
  ru: 'Объясните защитнику оповещение, описанное приведёнными полями JSON. Используйте только эти поля, не выдумывайте данные о хостах или активах, не выводите учётные данные и необработанные журналы и завершите одним конкретным следующим шагом.',
  th: 'อธิบายการแจ้งเตือนที่อธิบายด้วยฟิลด์ JSON ด้านล่างให้ผู้ป้องกัน ใช้เฉพาะฟิลด์เหล่านั้น อย่าสร้างรายละเอียดโฮสต์หรือสินทรัพย์ขึ้นเอง อย่าแสดงข้อมูลรับรองหรือบันทึกดิบ และปิดท้ายด้วยขั้นตอนถัดไปที่ทำได้จริงหนึ่งข้อ',
});

/**
 * Resolve the explanation instruction for a locale.
 *
 * @param {string} locale Locale.
 * @returns {string} Instruction text.
 */
export function explainSystemPromptFor(locale) {
  if (typeof locale === 'string' && Object.hasOwn(EXPLAIN_SYSTEM_PROMPTS, locale)) {
    return EXPLAIN_SYSTEM_PROMPTS[locale];
  }
  return EXPLAIN_SYSTEM_PROMPTS.en;
}

/**
 * Project an alert row onto {@link EXPLAIN_FIELDS}.
 *
 * @param {object} row Stored alert row (SQLite row or memory record).
 * @returns {object} Projected alert.
 */
export function projectAlertForPrompt(row) {
  const source = row ?? {};
  let evidenceCount = null;
  if (Array.isArray(source.event_ids)) {
    evidenceCount = source.event_ids.length;
  } else if (typeof source.evidence_count === 'number') {
    evidenceCount = source.evidence_count;
  } else if (typeof source.event_ids_json === 'string') {
    try {
      const parsed = JSON.parse(source.event_ids_json);
      evidenceCount = Array.isArray(parsed) ? parsed.length : null;
    } catch {
      evidenceCount = null;
    }
  }
  const truncatedRaw = source.event_ids_truncated ?? source.evidence_truncated;
  const text = (value) => (typeof value === 'string' ? value : null);
  const integer = (value) => (Number.isSafeInteger(value) ? value : (typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null));
  return {
    alert_id: text(source.alert_id),
    rule_id: text(source.rule_id),
    rule_version: text(source.rule_version),
    severity: text(source.severity),
    status: text(source.status),
    count: integer(source.count),
    first_seen: text(source.first_seen),
    last_seen: text(source.last_seen),
    window_start: text(source.window_start),
    window_end: text(source.window_end),
    evidence_count: evidenceCount,
    evidence_truncated: truncatedRaw === true || truncatedRaw === 1,
  };
}

/**
 * Build the single user message carrying the projection.
 *
 * Values are newline-free JSON scalars, so the message stays a data list and cannot
 * be turned into an instruction block by an alert field. A value that is `null` is
 * written as `null`, never dropped: "missing" is information.
 *
 * @param {object} projection Projected alert.
 * @returns {string} Message content.
 */
export function buildExplainMessage(projection) {
  return EXPLAIN_FIELDS
    .map((field) => `${field}: ${JSON.stringify(projection[field] ?? null)}`)
    .join('\n');
}

/**
 * Create the alert lookup used before streaming.
 *
 * Memory mode reads the adapter's introspection; full mode opens a read-only handle
 * and uses the store package's `getAlertById`. Opening per call is deliberate: an
 * explanation is rare, and a cached reader would have to be closed on shutdown for a
 * route that runs a handful of times per session.
 *
 * @param {{store: object, storePath: string, clock: object, logger?: object}} options Options.
 * @returns {(alertId: string) => Promise<object|null>} Lookup.
 */
export function createAlertLookup(options) {
  const store = options.store;
  const storePath = options.storePath;
  const clock = options.clock;
  const logger = options.logger ?? null;

  return async function lookup(alertId) {
    if (typeof alertId !== 'string' || alertId.length === 0 || alertId.length > 128) {
      return null;
    }
    if (store?.kind === 'memory') {
      let snapshot;
      try {
        snapshot = store.dump();
      } catch {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'alert lookup is unavailable', {
          reason: 'NO_INTROSPECTION',
        });
      }
      const row = (snapshot?.alerts ?? []).find((entry) => entry.alert_id === alertId) ?? null;
      return row === null ? null : projectAlertForPrompt(row);
    }
    if (store?.kind !== 'sqlite') {
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'alert lookup is unavailable', {
        reason: 'UNSUPPORTED_STORE_KIND',
      });
    }
    let api;
    let db;
    try {
      api = await import('@aegisharness/event-store');
      db = api.openStore({ path: storePath, readOnly: true, clock, busyTimeoutMs: 1000 });
    } catch (error) {
      logger?.warn?.('alert lookup could not open the store', { reason: error?.code ?? 'OPEN_FAILED' });
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'alert lookup is unavailable', { reason: 'OPEN_FAILED' });
    }
    try {
      const row = api.getAlertById(db, alertId);
      return row === null || row === undefined ? null : projectAlertForPrompt(row);
    } catch (error) {
      logger?.warn?.('alert lookup query failed', { reason: error?.code ?? 'QUERY_FAILED' });
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'alert lookup is unavailable', { reason: 'QUERY_FAILED' });
    } finally {
      try {
        db.close();
      } catch {
        // The handle never escaped this function.
      }
    }
  };
}

/**
 * Create the explain rate limiter.
 *
 * Two buckets: one in-flight explanation per alert, and a rolling five-per-minute
 * process budget. A refusal leaves the counters untouched.
 *
 * @param {{clock?: object, perAlert?: number, perMinute?: number, windowMs?: number}} [options] Options.
 * @returns {{acquire: Function, release: Function, stats: Function}} Limiter.
 */
export function createExplainLimiter(options = {}) {
  const clock = options.clock;
  const perAlert = options.perAlert ?? EXPLAIN_PER_ALERT;
  const perMinute = options.perMinute ?? EXPLAIN_PER_MINUTE;
  const windowMs = options.windowMs ?? EXPLAIN_WINDOW_MS;
  /** @type {Map<string, number>} */
  const active = new Map();
  /** @type {number[]} */
  let starts = [];
  let rejected = 0;

  function nowMs() {
    if (typeof clock?.nowMs === 'function') {
      return clock.nowMs();
    }
    return Date.now();
  }

  function prune(now) {
    starts = starts.filter((start) => now - start < windowMs);
  }

  return {
    /**
     * @param {string} alertId Alert id.
     * @returns {{ok: true}|{ok: false, reason: 'ALERT_BUSY'|'MINUTE_BUDGET'}} Decision.
     */
    acquire(alertId) {
      const now = nowMs();
      prune(now);
      if (starts.length >= perMinute) {
        rejected += 1;
        return { ok: false, reason: 'MINUTE_BUDGET' };
      }
      if ((active.get(alertId) ?? 0) >= perAlert) {
        rejected += 1;
        return { ok: false, reason: 'ALERT_BUSY' };
      }
      active.set(alertId, (active.get(alertId) ?? 0) + 1);
      starts.push(now);
      return { ok: true };
    },

    /**
     * @param {string} alertId Alert id.
     * @returns {void}
     */
    release(alertId) {
      const current = active.get(alertId) ?? 0;
      if (current <= 1) {
        active.delete(alertId);
        return;
      }
      active.set(alertId, current - 1);
    },

    stats: () => ({ active: active.size, window_starts: starts.length, rejected }),
  };
}

/** Rolling window of the in-process escalation history (ADR-0010 §2.5 第 4 条, 1 h). */
export const ESCALATION_HISTORY_MS = 60 * 60 * 1000;

/**
 * Create the escalation history `selectRoute` needs.
 *
 * `packages/policy` deliberately reads no clock and no store: the caller passes
 * `recent[]`. 0.0.1 has no escalation record table, so the history is a rolling
 * in-memory list holding one entry per escalation that reached the wire. It is
 * injectable (and inspectable) so the hourly cap and the cooldown can actually fire
 * instead of being decorative.
 *
 * @param {{clock?: object, windowMs?: number}} [options] Options.
 * @returns {{recent: Function, record: Function, clear: Function, size: Function, windowMs: number}} History.
 */
export function createEscalationHistory(options = {}) {
  const clock = options.clock;
  const windowMs = options.windowMs ?? ESCALATION_HISTORY_MS;
  /** @type {{fingerprint: string, at: number}[]} */
  let records = [];
  const nowMs = () => (typeof clock?.nowMs === 'function' ? clock.nowMs() : Date.now());
  return {
    windowMs,
    recent() {
      const now = nowMs();
      records = records.filter((record) => now - record.at < windowMs);
      return records.map((record) => ({ fingerprint: record.fingerprint, at: record.at }));
    },
    record(fingerprint) {
      if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
        return;
      }
      records.push({ fingerprint, at: nowMs() });
    },
    clear() {
      records = [];
    },
    size: () => records.length,
  };
}

/**
 * Decide which model/provider one explanation runs on.
 *
 * Two obligations, in this order:
 * 1. `selectRoute` (ADR-0010 §2.5) owns the tiered decision: severity drives
 *    watch/triage/respond, and `escalation.enabled|minSeverity|cooldownSeconds|maxPerHour`
 *    are honoured. Its `modelId`/`providerId` are resolved back to the settings objects
 *    the streaming turn needs.
 * 2. A judge that says "no" must never turn a working explanation into a 4xx. The refusal
 *    is recorded on the result (`deniedCode` / `deniedField`) and the turn continues on the
 *    pre-existing `defaultTier` selection. Low/medium alerts therefore stay on the default
 *    tier and "escalation denied" stays observable instead of silent.
 *
 * @param {{
 *   settings: object,
 *   alert: object,
 *   requestedModelId?: string|null,
 *   history?: {recent: Function}|null,
 *   nowMs?: () => number,
 *   routingModule?: {selectRoute: Function}|null
 * }} options Options. `routingModule` is injectable (tests / degraded layouts); omit it to
 *   use the guarded module-level judge.
 * @returns {{model: object, provider: object, tier: string, source: 'selectRoute'|'fallback',
 *   escalate: boolean, reason: string|null, deniedCode: string|null, deniedField: string|null,
 *   fingerprint: string|null, escalatedFrom: string|null, mode: string|null}} Selection.
 * @throws {ConsoleError} `MODEL_UNKNOWN` / `PROVIDER_UNKNOWN` from the fallback selection.
 */
export function selectExplainRoute(options) {
  const settings = options.settings;
  const alert = options.alert ?? {};
  const requestedModelId = options.requestedModelId ?? null;
  const history = options.history ?? null;
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const judge = options.routingModule === undefined ? routingModule : options.routingModule;

  const fallback = (denied) => {
    const selected = selectModelAndProvider(settings, requestedModelId);
    return {
      model: selected.model,
      provider: selected.provider,
      tier: selected.model.tier,
      source: 'fallback',
      escalate: false,
      reason: denied?.reason ?? null,
      deniedCode: denied?.code ?? null,
      deniedField: denied?.field ?? null,
      fingerprint: null,
      escalatedFrom: null,
      mode: null,
    };
  };

  // An explicit `modelId` is the operator overriding the judge, exactly as before.
  if (requestedModelId !== null) {
    return fallback(null);
  }

  // No judge at all (packaged layout without `packages/policy`): degrade to the old
  // default-tier selection, but say why — "missing judge" must not look like "judged ok".
  if (judge === null || judge === undefined || typeof judge.selectRoute !== 'function') {
    return fallback({
      code: 'E_ROUTING_UNAVAILABLE',
      field: 'routingModule',
      reason: routingLoadError === null ? 'routing-unavailable' : `routing-unavailable:${routingLoadError}`,
    });
  }

  const routing = settings.models.routing;
  const decision = judge.selectRoute({
    mode: routing.mode,
    uniformModelId: routing.uniformModelId,
    defaultTier: routing.defaultTier,
    models: settings.models.models,
    signal: {
      severity: alert.severity,
      // An alert row is already a structured conclusion (rule id + counts + window), never
      // a raw log dump; the evidence pointer stays a short id, not the event bodies.
      hasStructuredConclusion: true,
      evidenceRef: `alert:${String(alert.alert_id ?? 'unknown').slice(0, 128)}`,
      fingerprint: String(alert.alert_id ?? 'unknown'),
      at: nowMs(),
    },
    escalation: {
      enabled: routing.escalation.enabled,
      minSeverity: routing.escalation.minSeverity,
      cooldownSeconds: routing.escalation.cooldownSeconds,
      // Settings spell it `maxEscalationsPerHour`; the judge takes `maxPerHour`.
      maxPerHour: routing.escalation.maxEscalationsPerHour,
    },
    recent: history === null ? [] : history.recent(),
  });
  if (decision.ok !== true) {
    return fallback({ code: decision.code, field: decision.detail?.field ?? null });
  }
  const model = settings.models.models.find((entry) => entry.id === decision.modelId) ?? null;
  const provider = model === null
    ? null
    : settings.models.providers.find((entry) => entry.id === decision.providerId) ?? null;
  if (model === null || provider === null) {
    // The judge routed to a model the settings document cannot resolve: fail closed to the
    // old selection and record why, rather than streaming to a half-known target.
    return fallback({ code: 'E_ROUTE_UNRESOLVED', field: model === null ? 'models.models' : 'models.providers' });
  }
  return {
    model,
    provider,
    tier: decision.tier,
    source: 'selectRoute',
    escalate: decision.escalate === true,
    reason: decision.reason,
    deniedCode: null,
    deniedField: null,
    fingerprint: decision.fingerprint,
    escalatedFrom: decision.escalatedFrom ?? null,
    mode: decision.mode,
  };
}

/**
 * Validate the explain body: both fields optional, nothing else.
 *
 * @param {unknown} body Request body.
 * @returns {{modelId: string|null, locale: string|null}} Parsed body.
 */
function parseExplainBody(body) {
  const invalid = (field, rule) => {
    throw new ConsoleError(CONSOLE_CODES.CHAT_INVALID, 'explain request is not valid', { field, rule });
  };
  if (body === undefined || body === null) {
    return { modelId: null, locale: null };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    invalid('body', 'object');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'modelId' && key !== 'locale') {
      invalid(key.slice(0, 64), 'unknown_field');
    }
  }
  let modelId = null;
  if (body.modelId !== undefined) {
    if (typeof body.modelId !== 'string' || !MODEL_ID_PATTERN.test(body.modelId)) {
      invalid('modelId', 'pattern');
    }
    modelId = body.modelId;
  }
  let locale = null;
  if (body.locale !== undefined) {
    if (typeof body.locale !== 'string' || !CHAT_LOCALES.includes(body.locale)) {
      invalid('locale', 'enum');
    }
    locale = body.locale;
  }
  return { modelId, locale };
}

/**
 * Create the explain handler.
 *
 * @param {{
 *   settingsStore: object,
 *   engine: object,
 *   alertLookup: (alertId: string) => Promise<object|null>,
 *   limiter: object,
 *   clock: object,
 *   logger?: object,
 *   sseOptions?: object,
 *   escalationHistory?: object,
 *   routingModule?: {selectRoute: Function}|null
 * }} options Options. `routingModule` defaults to the guarded loader; passing `null`
 *   states "no judge is available" and exercises the degraded branch.
 * @returns {{explain: Function, routing: object}} Handler plus routing diagnostics.
 */
export function createExplainHandlers(options) {
  const settingsStore = options.settingsStore;
  const engine = options.engine;
  const alertLookup = options.alertLookup;
  const limiter = options.limiter;
  const clock = options.clock;
  const logger = options.logger ?? null;
  const sseOptions = options.sseOptions ?? {};
  const nowMs = () => (typeof clock?.nowMs === 'function' ? clock.nowMs() : Date.now());
  const escalationHistory = options.escalationHistory ?? createEscalationHistory({ clock });
  // `routingModule` present (even as `null`) means "use this judge"; absent means the loader's.
  const routingOverride = Object.hasOwn(options, 'routingModule') ? { value: options.routingModule } : null;
  const effectiveJudge = () => {
    if (routingOverride === null) {
      return routingJudgeStatus();
    }
    const value = routingOverride.value;
    const usable = value !== null && value !== undefined && typeof value.selectRoute === 'function';
    return { available: usable, error: usable ? null : 'E_INJECTED_UNAVAILABLE' };
  };
  /** Last routing decision (tier/model/refusal), for evidence and for the tier owner. */
  let lastRoute = null;

  /**
   * `POST /api/v1/alerts/:id/explain`.
   *
   * @param {{params: {id: string}, body: unknown}} ctx Request context.
   * @returns {Promise<void>} Resolves at a terminal state or after a JSON refusal.
   */
  async function explain(ctx) {
    const parsed = parseExplainBody(ctx.body);
    const settings = settingsStore.current();
    const locale = parsed.locale ?? settings.ui.locale;

    // Pre-check before any SSE header: an unknown alert is a JSON 404 (contract §2.6).
    const alert = await alertLookup(ctx.params.id);
    if (alert === null) {
      throw new ConsoleError(CONSOLE_CODES.ALERT_NOT_FOUND, 'alert is not found', {
        alertId: String(ctx.params.id).slice(0, 128),
      });
    }

    const route = selectExplainRoute({
      settings,
      alert,
      requestedModelId: parsed.modelId,
      history: escalationHistory,
      nowMs,
      // Injectable for tests and for a packaged layout that cannot load the judge.
      routingModule: routingOverride === null ? undefined : routingOverride.value,
    });
    const { model, provider } = route;
    if (settings.models.egressEnabled !== true) {
      throw new ConsoleError(CONSOLE_CODES.EGRESS_DISABLED, 'model egress is disabled', {});
    }
    if (provider.enabled !== true) {
      throw new ConsoleError(CONSOLE_CODES.PROVIDER_DISABLED, 'provider is disabled', { providerId: provider.id });
    }
    engine.requireEngine(settings.models.agent.engine);

    // Only an escalation that survived admission counts against the cooldown/hour cap.
    if (route.escalate === true) {
      escalationHistory.record(route.fingerprint);
    }
    lastRoute = {
      alertId: alert.alert_id ?? String(ctx.params.id).slice(0, 128),
      severity: alert.severity,
      tier: route.tier,
      modelId: model.id,
      providerId: provider.id,
      source: route.source,
      mode: route.mode,
      escalate: route.escalate === true,
      escalatedFrom: route.escalatedFrom,
      reason: route.reason,
      deniedCode: route.deniedCode,
      deniedField: route.deniedField,
    };
    // Observable, but never in the stream: a refusal must not displace the SSE frame set.
    logger?.info?.('explain.route', lastRoute);

    /** Reason the limiter refused, captured for the 429 detail. */
    let refusal = null;
    const outcome = await runStreamingTurn({
      ctx,
      engine,
      settings,
      model,
      provider,
      locale,
      messages: [{ role: 'user', content: buildExplainMessage(alert) }],
      systemPrompt: explainSystemPromptFor(locale),
      approvals: null,
      sessionId: null,
      alertId: alert.alert_id ?? String(ctx.params.id).slice(0, 128),
      ensureQuota: () => {
        const decision = limiter.acquire(ctx.params.id);
        if (decision.ok !== true) {
          refusal = decision.reason;
          return false;
        }
        return true;
      },
      releaseQuota: () => limiter.release(ctx.params.id),
      logFields: { alertId: alert.alert_id ?? null, kind: 'explain' },
      logger,
      sseOptions,
    });
    if (outcome.refused === true) {
      throw new ConsoleError(CONSOLE_CODES.CHAT_BUSY, 'too many concurrent explanations', {
        alertId: alert.alert_id ?? null,
        reason: refusal,
      }, { retryAfterSeconds: 1 });
    }
  }

  return {
    explain,
    /**
     * Routing evidence: the history the judge consulted and the last decision.
     *
     * @returns {{history: object, last: () => object|null}} Diagnostics.
     */
    routing: {
      history: escalationHistory,
      last: () => (lastRoute === null ? null : { ...lastRoute }),
      judge: () => effectiveJudge(),
    },
  };
}
