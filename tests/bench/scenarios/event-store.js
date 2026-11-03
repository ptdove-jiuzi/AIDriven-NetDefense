/**
 * scenarios/event-store.js — event-store 的 T1/T2 吞吐、WAL、备份与内存。
 *
 * 为什么这么切：
 *
 * | 阶段 | 测的是什么 | 为什么必须单独测 |
 * |---|---|---|
 * | t1.event_only | 纯事件写入事务 | 基线；不含 finding/alert 的额外 UPSERT |
 * | t1.aggregate_insert | 事件 + 新建 finding/alert | 每次新建聚合行，索引增长最快 |
 * | t1.aggregate_update | 事件 + 命中已有聚合行 | UPDATE 路径与 INSERT 路径成本不同，混在一起就互相掩盖 |
 * | t1.duplicate | 重复投递 | 判重是**读路径 + 空事务**，快得多；混进吞吐会把吞吐虚高 |
 * | t2.budget_cycle | 预占→发送→结算 | T2 是另一类事务，且有预算上限，需要显式放宽才能测吞吐 |
 * | backup | 在线备份 + checkpoint | 备份前会先做一次 TRUNCATE checkpoint，成本必须算进去 |
 *
 * 所有阶段都**不主动 checkpoint**（除备份阶段显式记录的那一次），否则 WAL 增长
 * 就测不到——手动 checkpoint 会把被测对象擦掉。
 */

import { canonicalDigest } from '../../../packages/contracts/src/index.js';
import {
  createBackup,
  ingestTelemetry,
  markModelRequestSent,
  migrate,
  openStore,
  reserveModelRequest,
  settleModelRequest,
} from '../../../packages/event-store/src/index.js';
import { memorySnapshot, storePhysicalStats, tableCounts } from '../lib/sampler.js';
import { elapsedMs, mib, nowNs, summarize } from '../lib/stats.js';
import { createBenchClock, createWorkload } from '../lib/synthetic.js';
import { assertHarmlessPath } from '../lib/tempdir.js';

/** 每个档位的负载规模。内存只有 ~1.8 GiB 空闲，规模刻意保守。 */
const SCALE = Object.freeze({
  quick: { t1Events: 2000, aggregateEvents: 800, updateEvents: 1500, duplicateSample: 200, t2Cycles: 300 },
  standard: { t1Events: 20000, aggregateEvents: 4000, updateEvents: 4000, duplicateSample: 1000, t2Cycles: 1000 },
});

/** 生成批次大小：生成在计时区之外发生，批次越大生成开销占比越低。 */
const GEN_CHUNK = 256;

/**
 * 采样 WAL/DB 物理大小的间隔（按操作数，不按时间）。
 *
 * 按操作数采样而不是按时间，是因为"每 N 次事务看一次 WAL"才和写入量直接对应；
 * 按时间采样会让快机器采到更多点，图看起来更细，但纵向不可比。
 */
const PHYSICAL_EVERY = 256;

/**
 * 对一组操作计时并收集单次延迟（毫秒）。
 *
 * @param {number} count 次数。
 * @param {(index: number) => void} operation 被测操作。
 * @param {(index: number) => void} [onEach] 每次操作后的采样钩子。
 * @returns {number[]} 单次延迟（毫秒）。
 */
function timeEach(count, operation, onEach) {
  const latencies = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const start = nowNs();
    operation(index);
    latencies[index] = elapsedMs(start, nowNs());
    if (onEach !== undefined) {
      onEach(index);
    }
  }
  return latencies;
}

/**
 * 由延迟样本算吞吐。
 *
 * 两种口径都给，因为两者含义不同：
 * - `ops_per_second_summed`：把单次延迟相加当分母。反映**被测操作本身**的速度，
 *   不含负载生成与采样开销。
 * - `ops_per_second_wall`：整段墙钟时间。反映**含生成开销**的端到端速度，
 *   是上层能观察到的数字。
 * 只报前者会把基准工具的开销藏起来；只报后者会让"生成器写得很慢"看起来像存储慢。
 *
 * @param {number[]} latencies 单次延迟（毫秒）。
 * @param {number} wallMs 墙钟总时长（毫秒）。
 * @returns {{ops_per_second_summed: number|null, ops_per_second_wall: number|null, total_op_ms: number}} 吞吐。
 */
function throughputOf(latencies, wallMs) {
  let total = 0;
  for (const value of latencies) {
    total += value;
  }
  return {
    ops_per_second_summed: total > 0 ? Number(((latencies.length / total) * 1000).toFixed(2)) : null,
    ops_per_second_wall: wallMs > 0 ? Number(((latencies.length / wallMs) * 1000).toFixed(2)) : null,
    total_op_ms: Number(total.toFixed(3)),
  };
}

/**
 * 运行 event-store 场景。
 *
 * @param {{seed: number, profile: 'quick'|'standard', tempRoot: object}} options 选项。
 * @returns {Promise<{scenario: object, checks: object[], raw: object}>} 场景结果。
 */
export async function runEventStoreScenario(options) {
  const scale = SCALE[options.profile] ?? SCALE.quick;
  const workload = createWorkload({ seed: options.seed, label: 'event-store' });
  const dbPath = assertHarmlessPath(options.tempRoot.dir('store/aegis-bench.db'), 'bench store path');
  const backupDir = assertHarmlessPath(options.tempRoot.dir('store/backups'), 'bench backup dir');
  const clock = createBenchClock();
  const checks = [];
  const observations = [];
  const raw = { phases: {} };

  const store = openStore({ path: dbPath, clock, auditKey: 'bench-only-key-0123456789abcdef' });
  const migration = migrate(store);
  const pragmas = {
    journal_mode: String(store.get('PRAGMA journal_mode').journal_mode),
    synchronous: Number(store.get('PRAGMA synchronous').synchronous),
    page_size: Number(store.get('PRAGMA page_size').page_size),
    wal_autocheckpoint: Number(store.get('PRAGMA wal_autocheckpoint').wal_autocheckpoint),
    cache_size: Number(store.get('PRAGMA cache_size').cache_size),
  };
  raw.migration = migration;
  raw.pragmas = pragmas;
  // 只留文件名，不把绝对临时路径写进仓库里的证据。
  raw.db_file = dbPath.split(/[\\/]/u).pop();

  const memory = { start: memorySnapshot() };
  /** 物理大小采样序列：`[{op, wal_bytes, db_bytes, rss}]`。 */
  const physicalSeries = [];
  let opCounter = 0;

  const samplePhysical = (phase) => {
    const stats = storePhysicalStats(store);
    physicalSeries.push({
      phase,
      op: opCounter,
      wal_bytes: stats.wal_bytes_measured,
      db_bytes: stats.db_bytes_measured,
      rss: process.memoryUsage().rss,
    });
    opCounter += 1;
  };

  /**
   * 跑一次 T1 事件写入。
   *
   * @param {string} phase 阶段名。
   * @param {{count: number, withAggregates: 'none'|'insert'|'update', startIndex: number}} plan 计划。
   * @returns {object} 阶段统计。
   */
  function runT1(phase, plan) {
    const wallStart = nowNs();
    let nextStart = plan.startIndex;
    let localIndex = 0;
    let duplicates = 0;
    const aggregateStats = { findings: 0, alerts: 0 };
    const latencies = new Array(plan.count);

    /**
     * 预热生成一整块记录。**这一步必须在计时区之外**。
     *
     * 早期版本在 `timeEach` 的闭包里调用生成器，于是每 256 次操作就有一次
     * "构造 256 条事件 + 两次契约校验 + 三次 canonicalDigest" 被计进单次延迟：
     * 结果是 `ops_per_second_summed` 与 `ops_per_second_wall` 只差 0.08%，
     * 双口径失去诊断力，而且生成尖峰（实测 max 46ms）污染了延迟分布。
     *
     * 聚合行的指纹/窗口规则：
     * - `insert`：每个事件唯一指纹 + 唯一窗口 → 每次新建行；
     * - `update`：固定的 32 个指纹 + 固定窗口 → 命中已有行，走 UPDATE。
     */
    const buildChunk = (base, size) => {
      const chunk = new Array(size);
      for (let offset = 0; offset < size; offset += 1) {
        const globalIndex = base + offset;
        const owningEvent = workload.event(globalIndex);
        const record = { event: owningEvent };
        if (plan.withAggregates === 'insert') {
          record.findings = [workload.finding(owningEvent, globalIndex)];
          record.alerts = [workload.alert(owningEvent, globalIndex)];
        } else if (plan.withAggregates === 'update') {
          const slot = globalIndex % 32;
          // 窗口必须是**整个阶段固定**的一个值：upsert 的查找键是
          // `(fingerprint, window_start)`，而 alert_id 又是唯一索引。
          // 如果 window_start 随事件变化，同一个 alert_id 会落到不同的键上，
          // 第二次插入就撞 UNIQUE —— 那不是被测代码的问题，是夹具写错了。
          const fixedWindowStart = '2026-11-02T00:00:00.000Z';
          const fixedWindowEnd = '2026-11-02T00:15:00.000Z';
          record.findings = [{
            ...workload.finding(owningEvent, globalIndex - slot, `slot-${slot}`),
            finding_id: `00000000-0000-4000-8000-${String(slot).padStart(12, '0')}`,
            first_seen: fixedWindowStart,
            last_seen: owningEvent.received_at,
          }];
          record.alerts = [{
            ...workload.alert(owningEvent, globalIndex - slot, `slot-${slot}`),
            alert_id: `00000000-0000-4000-8000-${String(slot + 1000).padStart(12, '0')}`,
            window_start: fixedWindowStart,
            window_end: fixedWindowEnd,
            first_seen: fixedWindowStart,
            last_seen: owningEvent.received_at,
          }];
        }
        chunk[offset] = record;
      }
      return chunk;
    };

    while (localIndex < plan.count) {
      const size = Math.min(GEN_CHUNK, plan.count - localIndex);
      const chunk = buildChunk(nextStart, size);
      nextStart += size;
      for (let offset = 0; offset < size; offset += 1) {
        const start = nowNs();
        const result = ingestTelemetry(store, chunk[offset]);
        latencies[localIndex + offset] = elapsedMs(start, nowNs());
        if (result.duplicate === true) {
          duplicates += 1;
        }
        aggregateStats.findings += result.findings.length;
        aggregateStats.alerts += result.alerts.length;
      }
      localIndex += size;
      samplePhysical(phase);
    }
    const wallMs = elapsedMs(wallStart, nowNs());
    const throughput = throughputOf(latencies, wallMs);
    const phasePhysical = physicalSeries.filter((entry) => entry.phase === phase);

    return {
      phase,
      events: plan.count,
      duplicates_observed: duplicates,
      findings_returned: aggregateStats.findings,
      alerts_returned: aggregateStats.alerts,
      latency_ms: summarize(latencies),
      wall_ms: Number(wallMs.toFixed(3)),
      ...throughput,
      wal_bytes_max: phasePhysical.length === 0 ? null : Math.max(...phasePhysical.map((entry) => entry.wal_bytes)),
      db_bytes_max: phasePhysical.length === 0 ? null : Math.max(...phasePhysical.map((entry) => entry.db_bytes)),
      rss_max: phasePhysical.length === 0 ? null : Math.max(...phasePhysical.map((entry) => entry.rss)),
      memory_after: memorySnapshot(),
    };
  }

  try {
    // --- T1: 纯事件 ---------------------------------------------------------
    raw.phases.t1_event_only = runT1('t1_event_only', {
      count: scale.t1Events,
      withAggregates: 'none',
      startIndex: 1,
    });

    // --- T1: 聚合行新建 -----------------------------------------------------
    const aggStart = scale.t1Events + 1;
    raw.phases.t1_aggregate_insert = runT1('t1_aggregate_insert', {
      count: scale.aggregateEvents,
      withAggregates: 'insert',
      startIndex: aggStart,
    });

    // --- T1: 聚合行更新 -----------------------------------------------------
    raw.phases.t1_aggregate_update = runT1('t1_aggregate_update', {
      count: scale.updateEvents,
      withAggregates: 'update',
      startIndex: aggStart + scale.aggregateEvents + 1,
    });

    // --- T1: 重复投递（判重路径） -------------------------------------------
    const beforeDuplicateEvents = tableCounts(store).telemetry_event;
    const duplicateStart = nowNs();
    let duplicateHits = 0;
    const duplicateLatencies = timeEach(scale.duplicateSample, (index) => {
      // 重投前 1..sample 号事件：它们的 `(stable_source_id, source_generation, dedupe_key)`
      // 已经在库里，因此必须走 duplicate 分支。
      const result = ingestTelemetry(store, { event: workload.event(index + 1) });
      if (result.duplicate === true) {
        duplicateHits += 1;
      }
    });
    const duplicateWallMs = elapsedMs(duplicateStart, nowNs());
    const afterDuplicateEvents = tableCounts(store).telemetry_event;
    raw.phases.t1_duplicate = {
      attempts: scale.duplicateSample,
      duplicates_observed: duplicateHits,
      latency_ms: summarize(duplicateLatencies),
      wall_ms: Number(duplicateWallMs.toFixed(3)),
      ...throughputOf(duplicateLatencies, duplicateWallMs),
      events_before: beforeDuplicateEvents,
      events_after: afterDuplicateEvents,
    };

    // --- T2: 预占 → 发送 → 结算 --------------------------------------------
    raw.phases.t2_budget = runT2BudgetCycles(store, workload, scale.t2Cycles, clock);

    // --- 备份与 checkpoint --------------------------------------------------
    const beforeBackup = storePhysicalStats(store);
    const checkpointStart = nowNs();
    store.checkpoint('TRUNCATE');
    const checkpointMs = elapsedMs(checkpointStart, nowNs());
    const afterCheckpoint = storePhysicalStats(store);

    const backupStart = nowNs();
    // `createBackup` 是存储层唯一的异步事务面函数：内部先做 TRUNCATE checkpoint，
    // 再 await SQLite 的在线备份。计时必须覆盖到 await 完成，否则测的是"启动备份"的耗时。
    const backupResult = await createBackup(store, { directory: backupDir, now: clock.nowIso() });
    const backupMs = elapsedMs(backupStart, nowNs());

    const afterBackup = storePhysicalStats(store);
    const counts = tableCounts(store);
    memory.end = memorySnapshot();

    const t1EventOnly = raw.phases.t1_event_only;
    const t1Insert = raw.phases.t1_aggregate_insert;
    const t1Update = raw.phases.t1_aggregate_update;
    const t1Duplicate = raw.phases.t1_duplicate;
    const t2 = raw.phases.t2_budget;

    // +1 是 T2 阶段用来造 analysis_outbox 的那条锚点事件：它同样走真实 T1 链路，
    // 不把它算进来，"写入行数等于生成数"这条检查会误报。
    const expectedEvents = scale.t1Events + scale.aggregateEvents + scale.updateEvents + 1;
    const walPeak = Math.max(
      ...physicalSeries.filter((entry) => entry.phase !== 'backup').map((entry) => entry.wal_bytes),
    );
    const rssPeak = physicalSeries.length === 0
      ? memory.end.rss
      : Math.max(...physicalSeries.map((entry) => entry.rss));

    const metrics = [
      { name: 'T1 纯事件吞吐（计时和口径）', value: t1EventOnly.ops_per_second_summed, unit: 'ops/s' },
      { name: 'T1 纯事件吞吐（墙钟口径）', value: t1EventOnly.ops_per_second_wall, unit: 'ops/s' },
      { name: 'T1 纯事件 p50', value: t1EventOnly.latency_ms.p50, unit: 'ms' },
      { name: 'T1 纯事件 p99', value: t1EventOnly.latency_ms.p99, unit: 'ms' },
      { name: 'T1 事件+新建聚合 吞吐', value: t1Insert.ops_per_second_summed, unit: 'ops/s' },
      { name: 'T1 事件+更新聚合 吞吐', value: t1Update.ops_per_second_summed, unit: 'ops/s' },
      { name: 'T1 重复投递吞吐（判重）', value: t1Duplicate.ops_per_second_summed, unit: 'ops/s' },
      { name: 'T2 预算周期吞吐', value: t2.cycles_per_second, unit: 'cycles/s' },
      { name: '数据库大小', value: mib(afterBackup.db_bytes_measured), unit: 'MiB' },
      { name: 'WAL 峰值（事务期间）', value: mib(walPeak), unit: 'MiB' },
      { name: 'WAL（checkpoint 后）', value: mib(afterCheckpoint.wal_bytes_measured), unit: 'MiB' },
      { name: '备份耗时', value: Number(backupMs.toFixed(2)), unit: 'ms' },
      { name: '备份产物大小', value: mib(backupResult.bytes), unit: 'MiB' },
      { name: 'checkpoint(TRUNCATE) 耗时', value: Number(checkpointMs.toFixed(2)), unit: 'ms' },
      { name: '事件行数', value: counts.telemetry_event, unit: 'row' },
      { name: 'RSS（末态）', value: mib(memory.end.rss), unit: 'MiB' },
      { name: 'RSS（起点）', value: mib(memory.start.rss), unit: 'MiB' },
      { name: 'RSS（事务期间峰值）', value: mib(rssPeak), unit: 'MiB' },
      { name: 'RSS 末态/起点', value: memory.start.rss === 0 ? null : Number((memory.end.rss / memory.start.rss).toFixed(2)), unit: '倍' },
    ];

    const tables = [
      {
        title: '各阶段延迟分布（毫秒）',
        rows: [
          { name: 'T1 纯事件', value: `${t1EventOnly.latency_ms.p50} / ${t1EventOnly.latency_ms.p95} / ${t1EventOnly.latency_ms.p99}`, unit: 'p50 / p95 / p99', note: `n=${t1EventOnly.latency_ms.count}` },
          { name: 'T1 新建聚合', value: `${t1Insert.latency_ms.p50} / ${t1Insert.latency_ms.p95} / ${t1Insert.latency_ms.p99}`, unit: 'p50 / p95 / p99', note: `n=${t1Insert.latency_ms.count}` },
          { name: 'T1 更新聚合', value: `${t1Update.latency_ms.p50} / ${t1Update.latency_ms.p95} / ${t1Update.latency_ms.p99}`, unit: 'p50 / p95 / p99', note: `n=${t1Update.latency_ms.count}` },
          { name: 'T1 重复投递', value: `${t1Duplicate.latency_ms.p50} / ${t1Duplicate.latency_ms.p95} / ${t1Duplicate.latency_ms.p99}`, unit: 'p50 / p95 / p99', note: `n=${t1Duplicate.latency_ms.count}` },
          { name: 'T2 预算周期', value: `${t2.latency_ms.p50} / ${t2.latency_ms.p95} / ${t2.latency_ms.p99}`, unit: 'p50 / p95 / p99', note: `n=${t2.latency_ms.count}` },
        ],
      },
      {
        title: 'SQLite 运行参数',
        rows: Object.entries(pragmas).map(([name, value]) => ({ name, value, unit: '' })),
      },
      {
        title: '表行数（阶段末）',
        rows: Object.entries(counts).map(([name, value]) => ({ name, value, unit: 'row' })),
      },
    ];

    observations.push(
      `T1 纯事件阶段共写入 ${t1EventOnly.events} 条，其中被判重 ${t1EventOnly.duplicates_observed} 条（必须为 0）。`,
      `判重阶段重投 ${t1Duplicate.attempts} 次，事件行数从 ${beforeDuplicateEvents} 变为 ${afterDuplicateEvents}（必须不变）。`,
      `WAL 峰值 ${mib(walPeak)} MiB，checkpoint 后 ${mib(afterCheckpoint.wal_bytes_measured)} MiB。`
        + ` autocheckpoint=${pragmas.wal_autocheckpoint} 页，synchronous=${pragmas.synchronous}。`,
      `RSS 从 ${mib(memory.start.rss)} MiB 到 ${mib(memory.end.rss)} MiB（${Number((memory.end.rss / memory.start.rss).toFixed(2))} 倍），`
        + `事务期间峰值 ${mib(rssPeak)} MiB。`
        + '**原因未定位**：`cache_size=-2000`（约 2 MiB）说明这不是 SQLite 页缓存，'
        + '候选是 V8 堆膨胀、预编译语句缓存、以及 canonical_json 字符串驻留。'
        + '本基准只如实报告这条曲线，不下"泄漏/非泄漏"的结论；`physical_series` 里有逐点 RSS 便于复核。',
    );

    // --- 检查项 -------------------------------------------------------------
    checks.push({
      id: 'store.events_committed',
      description: '写入的事件行数等于生成的事件数',
      expected: expectedEvents,
      actual: counts.telemetry_event,
      passed: counts.telemetry_event === expectedEvents,
    });
    checks.push({
      id: 'store.no_silent_duplicate',
      description: '全新事件不应被判重（否则吞吐是假的）',
      expected: 0,
      actual: t1EventOnly.duplicates_observed + t1Insert.duplicates_observed + t1Update.duplicates_observed,
      passed: t1EventOnly.duplicates_observed + t1Insert.duplicates_observed + t1Update.duplicates_observed === 0,
    });
    checks.push({
      id: 'store.duplicate_is_duplicate',
      description: '重复投递必须**全部**被判重（duplicate===true），且不新增行',
      expected: `${scale.duplicateSample} duplicates / ${beforeDuplicateEvents} rows`,
      actual: `${t1Duplicate.duplicates_observed} duplicates / ${afterDuplicateEvents} rows`,
      passed: t1Duplicate.duplicates_observed === scale.duplicateSample
        && afterDuplicateEvents === beforeDuplicateEvents,
    });
    // 聚合 UPDATE 阶段必须真的是 UPDATE。只在报告里"展示"行数、不写断言，
    // 一旦冲突键被改动或夹具窗口变随事件变化，这一阶段就静默变成 INSERT，
    // 而指标仍叫"更新聚合"——所有检查照常通过。
    const expectedFindingRows = scale.aggregateEvents + 32;
    const expectedAlertRows = scale.aggregateEvents + 32 + 1;
    checks.push({
      id: 'store.aggregate_update_is_update',
      description: '聚合更新阶段的 finding/alert 行数只应等于"新建阶段行数 + 32 个槽位"',
      expected: `finding=${expectedFindingRows} alert=${expectedAlertRows}`,
      actual: `finding=${counts.finding} alert=${counts.alert}`,
      passed: counts.finding === expectedFindingRows && counts.alert === expectedAlertRows,
    });
    // 阈值必须与配置挂钩。原来写死 256 MiB 时，实测峰值只有 4 MiB（= autocheckpoint
    // 1000 页 × 4 KiB 的精确上限），需要 64 倍退化才可能触发 —— 那条"WAL 有界"等于恒真。
    // 改成 autocheckpoint 上限的 3 倍：checkpoint 一旦失效，WAL 会连续跨过这个界。
    const walCeilingBytes = pragmas.wal_autocheckpoint * pragmas.page_size * 3;
    checks.push({
      id: 'store.wal_bounded',
      description: '自动 checkpoint 生效：WAL 峰值不超过 autocheckpoint 上限的 3 倍',
      expected: `<= ${mib(walCeilingBytes)} MiB 且 > 0`,
      actual: `${mib(walPeak)} MiB`,
      passed: walPeak > 0 && walPeak <= walCeilingBytes,
    });
    checks.push({
      id: 'store.wal_actually_measured',
      description: 'WAL 采样确实读到非零值（否则"WAL 有界"是无意义的）',
      expected: '> 0',
      actual: mib(walPeak),
      passed: walPeak > 0,
    });
    // 地板必须有诊断力：原来写 20 ops/s 时实测 462，余量 23 倍，掉 5 倍也不会红。
    // 收到 150 ops/s（余量约 3 倍）并升为 blocker —— 这是"回归守卫"，不是性能目标；
    // 换机器后必须按新机器重设，并在报告里说明本值来自哪台机器。
    checks.push({
      id: 'store.t1_floor',
      description: 'T1 纯事件吞吐回归地板（本机基准约 460 ops/s，留约 3 倍余量）',
      expected: '>= 150 ops/s',
      actual: t1EventOnly.ops_per_second_summed,
      passed: typeof t1EventOnly.ops_per_second_summed === 'number'
        && t1EventOnly.ops_per_second_summed >= 150,
    });
    checks.push({
      id: 'store.rss_growth_bounded',
      description: '单次运行内 RSS 末态不超过起点的 6 倍（拦"数量级"级别的内存异常，不判泄漏）',
      expected: '<= 6 倍',
      actual: memory.start.rss === 0 ? null : Number((memory.end.rss / memory.start.rss).toFixed(2)),
      passed: memory.start.rss > 0 && memory.end.rss / memory.start.rss <= 6,
      severity: 'warn',
      note: '本机实测约 4.6 倍；成因未定位，见 observations。该阈值只拦数量级异常。',
    });
    checks.push({
      id: 'store.backup_completed',
      description: '在线备份产生非空文件，且自校验通过',
      expected: '> 0 bytes 且 integrity=ok',
      actual: `${backupResult.bytes} bytes / integrity=${backupResult.integrity}`,
      passed: backupResult.bytes > 0 && backupResult.integrity === 'ok',
    });

    const scenario = {
      id: 'event-store',
      title: 'event-store（T1 / T2 / WAL / 备份 / 内存）',
      summary: `规模：${expectedEvents} 条事件 + ${scale.updateEvents} 次聚合更新 + `
        + `${scale.duplicateSample} 次重复投递 + ${scale.t2Cycles} 个 T2 周期。`
        + '所有写入走真实事务（BEGIN IMMEDIATE），未主动 checkpoint，除备份阶段那一次。',
      parameters: {
        profile: options.profile,
        t1_events: scale.t1Events,
        aggregate_events: scale.aggregateEvents,
        update_events: scale.updateEvents,
        duplicate_sample: scale.duplicateSample,
        t2_cycles: scale.t2Cycles,
        payload_bytes: 220,
        physical_sampling_every_ops: PHYSICAL_EVERY,
      },
      metrics,
      tables,
      observations,
    };
    raw.physical_series = physicalSeries;
    return { scenario, checks, raw };
  } finally {
    try {
      store.close();
    } catch {
      // 关库失败不影响已经取到的数字。
    }
  }
}

/**
 * 跑 T2 预算周期：预占 → 标记已发送 → 结算。
 *
 * 预算上限必须显式放宽：默认 `perAnalysisRequests: 3`、`dailyInputTokens: 30000`
 * 会在几百次之后开始抛 `ERR_BUDGET_EXCEEDED`。如果照默认跑，测出来的"吞吐"
 * 其实是"抛错的速度"——这正是自欺式指标的典型形态，所以在参数里写明放宽了什么。
 *
 * @param {object} store 存储句柄。
 * @param {object} workload 负载生成器。
 * @param {number} cycles 周期数。
 * @param {object} clock 时钟。
 * @returns {object} 周期统计。
 */
function runT2BudgetCycles(store, workload, cycles, clock) {
  const policy = {
    perAnalysisInputTokens: 1_000_000_000,
    perAnalysisOutputTokens: 1_000_000_000,
    perAnalysisRequests: 1_000_000,
    dailyInputTokens: 1_000_000_000,
    dailyOutputTokens: 1_000_000_000,
  };

  // 先造一个 analysis_outbox 行：T2 要求 analysis 存在且 epoch 一致。
  // 用真实 T1 链路造，而不是直接 INSERT，避免"绕过被测代码准备夹具"。
  const owningEvent = workload.event(900_000);
  const seedAlert = workload.alert(owningEvent, 900_000, 't2-anchor');
  const ingest = ingestTelemetry(store, {
    event: owningEvent,
    alerts: [seedAlert],
    analysisRequest: {
      schemaVersion: '1.0',
      analysis_id: '00000000-0000-4000-8000-00000000beef',
      alert_id: seedAlert.alert_id,
      budget_class: 'standard',
      summary_dto: { classification: 'D1', fields: { rule_id: 'synthetic.process-start' } },
      created_at: clock.nowIso(),
      idempotency_key: canonicalDigest({ anchor: 't2' }).slice(0, 32),
      epoch: store.epoch(),
    },
    allowedSummaryFields: ['rule_id'],
  });
  if (ingest.analysis_id === null) {
    throw new Error('T2 setup failed: analysis request was not enqueued');
  }
  const analysisId = String(ingest.analysis_id);

  const latencies = new Array(cycles);
  for (let index = 0; index < cycles; index += 1) {
    const start = nowNs();
    const reserved = reserveModelRequest(store, {
      analysis_id: analysisId,
      input_upper: 100,
      output_limit: 20,
      serialized_digest: canonicalDigest({ cycle: index }),
      policy,
    });
    markModelRequestSent(store, { request_id: reserved.request_id });
    settleModelRequest(store, {
      request_id: reserved.request_id,
      usage: { input_tokens: 62, output_tokens: 11 },
    });
    latencies[index] = elapsedMs(start, nowNs());
  }
  let total = 0;
  for (const value of latencies) {
    total += value;
  }
  return {
    cycles,
    analysis_id: analysisId,
    policy_relaxed: Object.keys(policy),
    latency_ms: summarize(latencies),
    cycles_per_second: total > 0 ? Number(((cycles / total) * 1000).toFixed(2)) : null,
    total_ms: Number(total.toFixed(3)),
  };
}
