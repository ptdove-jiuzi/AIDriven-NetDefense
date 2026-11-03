/**
 * scenarios/detection.js — detection 批量摄入吞吐、告警抑制与规则预算。
 *
 * 这里最容易出的自欺式指标有三种，本文件针对性地各设一条检查：
 *
 * 1. **把"没检测到"当成"很快"**。所以每阶段都同时记录 `detections`，并把
 *    `stats().events` 与投递事件数对账（`detection.counts_consistent`）。
 * 2. **告警抑制靠"根本没生成告警"实现**。所以抑制阶段要求 `detections` 接近事件数、
 *    而 `alerts` 远小于事件数——两者必须**同时**成立，才说明聚合真的在工作。
 * 3. **预算形同虚设**。所以压力阶段把 `maxEvaluationsPerRulePerBatch` 调到 20，
 *    投 500 条匹配事件：引擎**必须**隔离规则或产出 gap，且检出数必须被压到预算之内。
 *    如果它照样检出 500 条，"规则预算"就只是文档里的字。
 *
 * 引擎的预算时钟默认是确定性步进时钟（每个评估 1 虚拟毫秒），所以预算行为不随机器
 * 快慢变化——这也是本基准能跨机器比较的原因。
 */

import {
  createDetectionEngine,
  createManualClock,
  createRateState,
  requestAnalysis,
  validateRulePack,
} from '../../../packages/detection/index.js';
import { makeBenchRulePack } from '../lib/rulepack.js';
import { elapsedMs, nowNs, summarize } from '../lib/stats.js';
import { createWorkload } from '../lib/synthetic.js';

/** 每个档位的负载规模。 */
const SCALE = Object.freeze({
  // 每档事件数按"最大批大小 × 100"取：batch=512 时才有 100 个批次样本，
  // p99 才不会退化成"就是最大值"。nearest-rank 在 n<100 时 p99 恒等于 max。
  quick: { eventsPerBatchSize: 512 * 24, aggregateEvents: 1200, budgetEvents: 500 },
  standard: { eventsPerBatchSize: 512 * 100, aggregateEvents: 4000, budgetEvents: 500 },
});

/** 与事件时基对齐的时钟起点。用 0（1970）会让引擎的窗口过期/告警推进全部空转。 */
const CLOCK_ORIGIN_MS = Date.UTC(2026, 10, 2);

/** 批大小档位；上限受 `maxEventsPerIngest` 默认值 1000 约束，故最高取 512。 */
const BATCH_SIZES = Object.freeze([1, 16, 64, 256, 512]);

/**
 * 构造一个引擎。
 *
 * @param {{seed: number, limits?: object, clock: object, rulePack?: object}} options 选项。
 * @returns {object} 引擎句柄。
 */
function makeEngine(options) {
  const pack = options.rulePack ?? makeBenchRulePack({ seed: options.seed }).pack;
  const configuration = {
    rulePack: validateRulePack(pack),
    clock: { now: () => options.clock.now() },
  };
  if (options.limits !== undefined) {
    configuration.limits = options.limits;
  }
  return createDetectionEngine(configuration);
}

/**
 * 构造"同一指纹"的事件：进程名固定，用户固定，只有 eventId 与时间不同。
 *
 * 指纹相同 → 落进同一个聚合行，这正是"告警抑制"该被观察到的地方。
 *
 * @param {object} workload 负载生成器。
 * @param {number} index 序号。
 * @param {string} processName 固定进程名。
 * @returns {object} 引擎事件。
 */
function fixedFingerprintEvent(workload, index, processName) {
  const event = workload.detectionEvent(index);
  event.fields.process.name = processName;
  event.fields.user.name = 'synthetic-user';
  return event;
}

/**
 * 运行 detection 场景。
 *
 * @param {{seed: number, profile: 'quick'|'standard'}} options 选项。
 * @returns {{scenario: object, checks: object[], raw: object}} 场景结果。
 */
export function runDetectionScenario(options) {
  const scale = SCALE[options.profile] ?? SCALE.quick;
  const workload = createWorkload({ seed: options.seed, label: 'detection' });
  const checks = [];
  const observations = [];
  const raw = { phases: {} };
  const { composition } = makeBenchRulePack({ seed: options.seed });

  // --- 1. 批大小对吞吐的影响 ------------------------------------------------
  const throughputRows = [];
  const throughputRaw = {};
  for (const batchSize of BATCH_SIZES) {
    // 预热：用一个**丢弃的**引擎跑 3 个同规模批次，让 JIT 与规则编译热起来。
    // 不能用正式引擎预热——那会把预热批次的状态（窗口、指纹、限流计数）留在里面。
    {
      const warmClock = createManualClock(CLOCK_ORIGIN_MS);
      const warmEngine = makeEngine({ seed: options.seed, clock: warmClock });
      for (let round = 0; round < 3; round += 1) {
        warmEngine.ingest(workload.batch(round * batchSize, batchSize));
        warmClock.advance(batchSize);
      }
    }
    const clock = createManualClock(CLOCK_ORIGIN_MS);
    const engine = makeEngine({ seed: options.seed, clock });
    const total = scale.eventsPerBatchSize;
    const batchLatencies = [];
    let detections = 0;
    let alerts = 0;
    let cursor = 0;
    const wallStart = nowNs();
    while (cursor < total) {
      const size = Math.min(batchSize, total - cursor);
      const batch = workload.batch(cursor, size);
      const start = nowNs();
      const result = engine.ingest(batch);
      batchLatencies.push(elapsedMs(start, nowNs()));
      detections += result.detections.length;
      alerts += result.alerts.length;
      cursor += size;
      // 注意：窗口是按事件的 `observedAt` 切分的，而 `workload.detectionEvent()`
      // 已经给每个事件 +1ms，所以各档的窗口跨度天然一致，这里推进时钟只影响
      // 引擎的 housekeeping（窗口过期、告警推进）。
      // （早期注释声称"按批推进会让各档跨度不同"，那个说法是错的：批推进不影响
      //  observedAt。真正的错是时钟停在 1970，导致 housekeeping 全程空转。）
      clock.advance(size);
    }
    const wallMs = elapsedMs(wallStart, nowNs());
    const stats = engine.stats();
    const entry = {
      batch_size: batchSize,
      events: total,
      batches: batchLatencies.length,
      detections,
      alerts,
      batch_latency_ms: summarize(batchLatencies),
      events_per_second_wall: Number(((total / wallMs) * 1000).toFixed(2)),
      detections_per_second_wall: Number(((detections / wallMs) * 1000).toFixed(2)),
      engine_stats: {
        events: stats.events,
        detections: stats.detections,
        alerts: stats.alerts,
        events_suppressed: stats.eventsSuppressed,
        duplicate_events: stats.duplicateEvents,
        invalid_events: stats.invalidEvents,
        rule_isolations: stats.ruleIsolations,
        open_fingerprints: stats.openFingerprints,
        fatal: stats.fatal,
      },
    };
    throughputRaw[`batch_${batchSize}`] = entry;
    throughputRows.push({
      name: `batch=${batchSize}`,
      value: `${entry.events_per_second_wall} ev/s · p50 ${entry.batch_latency_ms.p50}ms · p99 ${entry.batch_latency_ms.p99}ms`,
      unit: '',
      note: `n=${batchLatencies.length}${batchLatencies.length < 100 ? '（n<100，p99 即最大值，不具尾部分辨力）' : ''}`
        + ` · detections=${detections} alerts=${alerts}`,
    });
  }
  raw.phases.throughput = throughputRaw;

  // --- 2. 告警抑制（同指纹聚合） --------------------------------------------
  const aggregateClock = createManualClock(CLOCK_ORIGIN_MS);
  const aggregateEngine = makeEngine({ seed: options.seed, clock: aggregateClock });
  const aggregateName = workload.detectionEvent(0).fields.process.name;
  let aggregateDetections = 0;
  let aggregateAlerts = 0;
  let aggregateRequests = 0;
  let aggregateDenied = 0;
  const aggregateStart = nowNs();
  {
    let cursor = 0;
    while (cursor < scale.aggregateEvents) {
      const size = Math.min(256, scale.aggregateEvents - cursor);
      const batch = new Array(size);
      for (let offset = 0; offset < size; offset += 1) {
        batch[offset] = fixedFingerprintEvent(workload, cursor + offset, aggregateName);
      }
      const result = aggregateEngine.ingest(batch);
      aggregateDetections += result.detections.length;
      aggregateAlerts += result.alerts.length;
      aggregateRequests += result.analysisRequests.length;
      aggregateDenied += result.analysisDenied.length;
      cursor += size;
      // 60 秒一步：跨过阈值规则窗口，避免所有事件挤在一个窗口里。
      aggregateClock.advance(60000);
    }
  }
  const aggregateWallMs = elapsedMs(aggregateStart, nowNs());
  const aggregateStats = aggregateEngine.stats();
  raw.phases.aggregation = {
    events: scale.aggregateEvents,
    detections: aggregateDetections,
    alerts: aggregateAlerts,
    analysis_requests: aggregateRequests,
    analysis_denied: aggregateDenied,
    events_per_second_wall: Number(((scale.aggregateEvents / aggregateWallMs) * 1000).toFixed(2)),
    engine_stats: {
      events: aggregateStats.events,
      detections: aggregateStats.detections,
      alerts: aggregateStats.alerts,
      events_suppressed: aggregateStats.eventsSuppressed,
      open_fingerprints: aggregateStats.openFingerprints,
      fatal: aggregateStats.fatal,
    },
  };

  // --- 3. 正常预算下的规则状态 ----------------------------------------------
  const normalClock = createManualClock(CLOCK_ORIGIN_MS);
  const normalEngine = makeEngine({ seed: options.seed, clock: normalClock });
  {
    let cursor = 0;
    while (cursor < scale.eventsPerBatchSize) {
      const size = Math.min(256, scale.eventsPerBatchSize - cursor);
      normalEngine.ingest(workload.batch(cursor, size));
      cursor += size;
      normalClock.advance(size);
    }
  }
  const normalStates = normalEngine.ruleStates();
  const normalIsolated = normalStates.filter((state) => state.state === 'isolated').length;
  raw.phases.budget_normal = {
    rules: normalStates,
    isolated: normalIsolated,
    // 引擎只在**隔离时**记录 steps / cpuUsedMs；健康规则这两个字段是 null。
    // 这里如实保留 null，而不是填 0——填 0 会被读成"每条规则评估了 0 个事件"。
    step_metering_available_for_healthy_rules: false,
  };

  // --- 4. 预算压力：步数预算必须真的咬住 ------------------------------------
  // 先跑一个**对照组**：同样的批次、默认预算。没有对照组，"检出少了"就无法
  // 归因到预算——也可能只是规则本来就不匹配。
  const baselineClock = createManualClock(CLOCK_ORIGIN_MS);
  const baselineEngine = makeEngine({ seed: options.seed, clock: baselineClock });
  const baselineResult = baselineEngine.ingest(workload.batch(0, scale.budgetEvents));
  const baselineStats = baselineEngine.stats();

  const pressureClock = createManualClock(CLOCK_ORIGIN_MS);
  const pressureEngine = makeEngine({
    seed: options.seed,
    clock: pressureClock,
    // 只收紧"每规则每批评估步数"，CPU 预算保持默认：这样预算触发是**确定性**的，
    // 不依赖机器快慢，跨机器结论一致。
    limits: { maxEvaluationsPerRulePerBatch: 20 },
  });
  const pressureBatch = workload.batch(0, scale.budgetEvents);
  const pressureStart = nowNs();
  const pressureResult = pressureEngine.ingest(pressureBatch);
  const pressureMs = elapsedMs(pressureStart, nowNs());
  const pressureStats = pressureEngine.stats();
  raw.phases.budget_pressure = {
    events: scale.budgetEvents,
    step_budget_per_rule: 20,
    detections: pressureResult.detections.length,
    alerts: pressureResult.alerts.length,
    rule_isolations: pressureResult.ruleIsolations.length,
    gaps: pressureResult.gaps,
    elapsed_ms: Number(pressureMs.toFixed(3)),
    baseline: {
      limits: 'default',
      detections: baselineResult.detections.length,
      alerts: baselineResult.alerts.length,
      rule_isolations: baselineResult.ruleIsolations.length,
      engine_events: baselineStats.events,
    },
    engine_stats: {
      events: pressureStats.events,
      detections: pressureStats.detections,
      rule_isolations: pressureStats.ruleIsolations,
      fatal: pressureStats.fatal,
    },
  };

  // --- 5. 分析请求限流 ------------------------------------------------------
  // 5a：引擎路径。默认上限 4，但幂等键是 `fingerprint|hourStart|severity`，
  // 同一指纹同一小时同一严重度只放 1 个请求，跨窗口也不会重复。所以这一阶段观察到
  // 的是"幂等生效"（12 个窗口不等于 12 个请求），而不是"上限被撞到"。
  const rateClock = createManualClock(CLOCK_ORIGIN_MS);
  const rateEngine = makeEngine({
    seed: options.seed,
    clock: rateClock,
    limits: { aggregationWindowMs: 60000 },
  });
  const rateName = workload.detectionEvent(0).fields.process.name;
  const rateBatches = 12;
  const rateBatchSize = 64;
  let rateRequests = 0;
  let rateDenied = 0;
  let rateAlerts = 0;
  const rateFingerprints = new Set();
  for (let batchIndex = 0; batchIndex < rateBatches; batchIndex += 1) {
    const batch = new Array(rateBatchSize);
    for (let offset = 0; offset < rateBatchSize; offset += 1) {
      batch[offset] = fixedFingerprintEvent(workload, batchIndex * rateBatchSize + offset, rateName);
    }
    const result = rateEngine.ingest(batch);
    rateRequests += result.analysisRequests.length;
    rateDenied += result.analysisDenied.length;
    rateAlerts += result.alerts.length;
    for (const request of result.analysisRequests) {
      rateFingerprints.add(request.fingerprint);
    }
    // 60 秒一步 = 一个聚合窗口，全部落在同一个 UTC 小时内。
    rateClock.advance(60000);
  }
  raw.phases.rate_limit_engine = {
    events: rateBatches * rateBatchSize,
    windows: rateBatches,
    alerts: rateAlerts,
    analysis_requests: rateRequests,
    analysis_denied: rateDenied,
    distinct_fingerprints: rateFingerprints.size,
    per_fingerprint_per_hour_limit: 4,
    aggregation_window_ms: 60000,
    distinct_hours: 1,
  };

  // 5b：限流器本体（`requestAnalysis` 是 detection 的公共导出）。
  // 直接驱动它，才能把上限真的撞到：同一指纹、同一小时、三个不同严重度 = 3 个不同
  // 幂等键；把上限设为 2，第 3 个必然被拒。这是**确定性**的，不依赖机器速度。
  const directLimits = { analysisPerFingerprintPerHour: 2, analysisMinSeverity: 'medium' };
  const directState = createRateState();
  const directFingerprint = 'bench-fingerprint';
  const directOutcomes = [];
  const directLatencies = [];
  const severities = ['medium', 'high', 'critical'];
  for (const severity of severities) {
    const start = nowNs();
    const outcome = requestAnalysis({
      alert: {
        alertId: `alert-${severity}`,
        severity,
        status: 'new',
        count: 1,
        ruleType: 'condition',
      },
      alertView: {},
      fingerprint: directFingerprint,
      ruleId: 'bench.rate.00',
      at: 1_000,
      rateState: directState,
      limits: directLimits,
    });
    directLatencies.push(elapsedMs(start, nowNs()));
    directOutcomes.push({ severity, status: outcome.status, reason: outcome.reason ?? null });
  }
  raw.phases.rate_limit_direct = {
    limit_per_fingerprint_per_hour: directLimits.analysisPerFingerprintPerHour,
    severities,
    outcomes: directOutcomes,
    released: directOutcomes.filter((entry) => entry.status === 'released').length,
    denied: directOutcomes.filter((entry) => entry.status === 'denied').length,
    latency_ms: summarize(directLatencies),
  };

  const t = raw.phases.throughput.batch_256;
  const pressure = raw.phases.budget_pressure;
  const aggregation = raw.phases.aggregation;
  const rateEnginePhase = raw.phases.rate_limit_engine;
  const rateDirect = raw.phases.rate_limit_direct;

  const metrics = [
    { name: '吞吐（batch=256，墙钟）', value: t.events_per_second_wall, unit: 'events/s' },
    { name: '吞吐（batch=256，检出）', value: t.detections_per_second_wall, unit: 'detections/s' },
    { name: '批延迟 p50（batch=256）', value: t.batch_latency_ms.p50, unit: 'ms' },
    { name: '批延迟 p99（batch=256）', value: t.batch_latency_ms.p99, unit: 'ms' },
    { name: '单事件吞吐（batch=1）', value: raw.phases.throughput.batch_1.events_per_second_wall, unit: 'events/s' },
    { name: '抑制阶段事件/告警比', value: aggregation.alerts === 0 ? null : Number((aggregation.events / aggregation.alerts).toFixed(2)), unit: 'events per alert' },
    { name: '抑制阶段检出数', value: aggregation.detections, unit: 'detection' },
    { name: '抑制阶段告警数', value: aggregation.alerts, unit: 'alert' },
    { name: '预算压力阶段检出数', value: pressure.detections, unit: 'detection' },
    { name: '预算压力阶段规则隔离', value: pressure.rule_isolations, unit: 'rule' },
    { name: '对照组检出数（默认预算）', value: pressure.baseline.detections, unit: 'detection' },
    { name: '正常预算下被隔离规则数', value: raw.phases.budget_normal.isolated, unit: 'rule' },
    { name: '引擎限流：12 窗口内的分析请求', value: rateEnginePhase.analysis_requests, unit: 'request', note: `指纹数 ${rateEnginePhase.distinct_fingerprints}` },
    { name: '限流器（上限 2）放行', value: rateDirect.released, unit: 'request' },
    { name: '限流器（上限 2）拒绝', value: rateDirect.denied, unit: 'request' },
  ];

  const tables = [
    { title: '批大小 → 吞吐与延迟', rows: throughputRows },
    {
      title: '规则构成',
      rows: [
        { name: 'condition', value: composition.conditions, unit: 'rule' },
        { name: 'threshold', value: composition.thresholds, unit: 'rule' },
        { name: 'correlation', value: composition.correlations, unit: 'rule' },
        { name: '合计', value: composition.total, unit: 'rule' },
      ],
    },
    {
      title: '预算压力阶段的 gap',
      rows: (pressure.gaps ?? []).map((gap) => ({
        name: gap.kind,
        value: gap.count,
        unit: 'count',
        note: gap.ruleId === undefined ? '' : `rule=${gap.ruleId}`,
      })),
    },
  ];

  observations.push(
    `引擎计数与投递事件数对账：batch=256 阶段投递 ${t.events} 条，引擎记 ${t.engine_stats.events} 条。`,
    `各批大小档的检出数相同（${t.detections}），说明负载与规则匹配一致、批大小只影响吞吐；`
      + '而"返回的告警数"随批大小下降（batch=1 时每个事件返回一条、batch=512 时每批只返回一条），'
      + '那是**引擎每次调用返回的告警对象数**，不是库里的行数——同一窗口内的后续批次由存储层合并。'
      + '把这两个数字当成"聚合强度"会得出错误结论。',
    `抑制阶段 ${aggregation.events} 条同指纹事件 → ${aggregation.detections} 次检出 / ${aggregation.alerts} 条告警；`
      + '检出接近事件数、告警远小于事件数，才说明聚合真的在工作。',
    `预算压力阶段（每规则每批 20 步）${pressure.events} 条匹配事件只产生 ${pressure.detections} 次检出、`
      + `${pressure.rule_isolations} 条规则隔离；同样批次在默认预算下产生 ${pressure.baseline.detections} 次检出——`
      + '两者的差距就是"预算真的生效"的证据。',
    `限流（引擎路径）：${rateEnginePhase.events} 条事件跨 ${rateEnginePhase.windows} 个聚合窗口，`
      + `只放出 ${rateEnginePhase.analysis_requests} 个分析请求（涉及 ${rateEnginePhase.distinct_fingerprints} 个指纹）。`
      + '幂等键是 `fingerprint|hourStart|severity`，所以同一指纹同一小时同一严重度不会因为窗口多而重复请求。',
    `限流（限流器本体，上限 2）：${rateDirect.severities.join('/')} 三个严重度 → `
      + `放行 ${rateDirect.released}、拒绝 ${rateDirect.denied}；`
      + `结果 ${rateDirect.outcomes.map((entry) => `${entry.severity}:${entry.status}`).join(' / ')}。`,
    '由幂等键构成可推知：默认上限 4 在**单个指纹**上实际不可达——过 `analysisMinSeverity` 的'
      + '只有 medium/high/critical 三档，最多 3 个不同键。这是观察，不是缺陷，未改生产代码。',
    '引擎只在规则被隔离时才记录 `steps` / `cpuUsedMs`；健康规则的这两个字段为 null，'
      + '所以本报告不给出"正常预算下每条规则用了多少步"——给不出来，也不编一个 0 出来。',
  );

  checks.push({
    id: 'detection.counts_consistent',
    description: '引擎记到的事件数与投递数一致（batch=256 阶段）',
    expected: t.events,
    actual: t.engine_stats.events,
    passed: t.engine_stats.events === t.events,
  });
  checks.push({
    id: 'detection.no_freeze',
    description: '所有阶段引擎都未冻结（fatal === null）',
    expected: 'null',
    actual: String(t.engine_stats.fatal ?? pressure.engine_stats.fatal ?? aggregation.engine_stats.fatal),
    passed: t.engine_stats.fatal === null
      && pressure.engine_stats.fatal === null
      && aggregation.engine_stats.fatal === null,
  });
  // `> 0` 太弱：规则集从 15 条退化成 1 条、或匹配率掉 99.99% 也会过。
  // 本负载下每条事件会被多条规则命中（实测约 2.6 次检出/事件），所以要求
  // detections >= events 是一个有内容的下界，同时不绑定具体规则条数。
  checks.push({
    id: 'detection.actually_detects',
    description: '吞吐阶段每条事件至少产生 1 次检出（否则"快"是因为没干活）',
    expected: `>= ${t.events}`,
    actual: t.detections,
    passed: t.detections >= t.events,
  });
  checks.push({
    id: 'detection.aggregation_collapses_alerts',
    description: '同指纹事件被聚合：告警数远小于事件数，但检出数接近事件数',
    expected: `alerts <= events/10 且 detections >= events/2`,
    actual: `alerts=${aggregation.alerts} detections=${aggregation.detections} events=${aggregation.events}`,
    passed: aggregation.alerts > 0
      && aggregation.alerts <= aggregation.events / 10
      && aggregation.detections >= aggregation.events / 2,
  });
  checks.push({
    id: 'detection.budget_enforced',
    description: '步数预算必须咬住：20 步/批的检出数应远低于默认预算对照组',
    expected: 'detections < 对照组/4 且 rule_isolations >= 1',
    actual: `detections=${pressure.detections} baseline=${pressure.baseline.detections} `
      + `isolations=${pressure.rule_isolations}`,
    passed: pressure.rule_isolations >= 1
      && pressure.detections < pressure.baseline.detections / 4,
  });
  // 原写法是 `requests <= distinct_fingerprints`，而 distinct_fingerprints 正是从
  // `analysisRequests` 里收集出来的 —— 那是"实测值和它自己的派生值比较"：引擎若一个
  // 请求都不产出，`0 <= 0` 照样通过。改成"必须有请求，且不超过告警数"，
  // 下限与上限都能被违反。
  checks.push({
    id: 'detection.rate_limit_idempotent',
    description: '必须真的放出分析请求，且请求数不超过告警数（同键不重复）',
    expected: `1 <= requests <= alerts(${rateEnginePhase.alerts})`,
    actual: `requests=${rateEnginePhase.analysis_requests}`,
    passed: rateEnginePhase.analysis_requests >= 1
      && rateEnginePhase.analysis_requests <= rateEnginePhase.alerts,
  });
  checks.push({
    id: 'detection.rate_limit_enforced',
    description: '限流器在达到每小时上限后必须拒绝（上限显式设为 2）',
    expected: 'released == 2 且 denied == 1',
    actual: `released=${rateDirect.released} denied=${rateDirect.denied}`,
    passed: rateDirect.released === 2 && rateDirect.denied === 1,
  });
  // 地板从 500 收到 8000（本机实测约 3 万，留约 3.7 倍余量）并升为 blocker：
  // 500 的话掉 60 倍仍然通过，等于没有门禁。这是回归守卫，不是性能目标。
  checks.push({
    id: 'detection.throughput_floor',
    description: '检出吞吐回归地板（本机基准约 3 万 events/s，留约 3.7 倍余量）',
    expected: '>= 8000 events/s',
    actual: t.events_per_second_wall,
    passed: t.events_per_second_wall >= 8000,
  });

  const scenario = {
    id: 'detection',
    title: 'detection（批量摄入 / 告警抑制 / 规则预算 / 限流）',
    summary: `规则集 ${composition.total} 条（condition ${composition.conditions}、threshold ${composition.thresholds}、`
      + `correlation ${composition.correlations}）；批大小 ${BATCH_SIZES.join('/')}；`
      + '预算时钟为确定性步进时钟（每评估 1 虚拟毫秒），预算行为与机器速度无关。',
    parameters: {
      profile: options.profile,
      events_per_batch_size: scale.eventsPerBatchSize,
      aggregate_events: scale.aggregateEvents,
      budget_events: scale.budgetEvents,
      rate_batches: rateBatches,
      rate_batch_size: rateBatchSize,
      batch_sizes: BATCH_SIZES,
      step_budget_pressure: 20,
      rate_limit_aggregation_window_ms: 60000,
      rate_limit_direct_limit: 2,
    },
    metrics,
    tables,
    observations,
  };
  return { scenario, checks, raw };
}
