/**
 * cross-source-pending.test.js — 第 8 轮 P1-5 的反例集：**延后补记只能由它自己的来源排空**。
 *
 * 根因不是锚点、也不是 `count` 的加法，而是 `pendingContributions` 的**作用域**：daemon 只建
 * 一个 pipeline（`daemon.js`），`scheduler.js` 每个 tick 把**所有**到期来源的批次都交给它。
 * 第 8 轮之前这个队列是全局的，`attachRetained` 不比较来源：
 *
 * 1. 早期形态：来源 A 的部分写失败留下补记，来源 B 的下一批先到 → B 查不到 A 的 id
 *    （不在本批、也不在库里）→ 当作"证据不可核实"丢弃 → 事件 A 随后重投成功、引擎已见过
 *    它不再检测 → 事件入库、`count` 永不认领，**永久少计 1**；
 * 2. 延后一拍之后（第 8 轮 19:50 的 `carried`）：B 不再当拍丢弃，但每次 attach 仍给 A 的
 *    条目 `+1 attempts` → B 连打 9 批就能把 A 的补记预算耗尽 → 同样是永久少计，只是晚几拍。
 *
 * 所以这里断言的不是"某次调用的顺序"，而是三条与来源无关的不变式：
 * - **不被无关来源消费**：别的来源的批次不增加 `contributions_attach_attempts`、
 *   不减少 `contributions_pending`、不增加 `contributions_dropped`；
 * - **能补回来**：A 重投成功后，该窗口 `count` 必须等于库里该窗口的事件数（不多不少）；
 * - **证据可查**：每个 `event_id` 都能在 `telemetry_event` 查到，`truncated` 当且仅当 `count > ids`。
 *
 * 用真实 scheduler + 两个 `createScriptedSource` + 真 SQLite + 真检测引擎；时间注入，
 * 不含 sleep，批次顺序用 `pollNow` 显式驱动，只有"同一 tick 并发"那条用 `tick()`。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { openStore } from '../../packages/event-store/src/index.js';
import { createEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { createScheduler } from '../../apps/daemon/src/scheduler.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createPipeline } from '../../apps/daemon/src/pipeline.js';
import { DAEMON_CODES, DaemonError } from '../../apps/daemon/src/errors.js';

import {
  BASE_MS,
  TEST_EPOCH,
  createScriptedSource,
  makeEngine,
  makeEvent,
  makeTempDir,
  waitFor,
} from './helpers.js';

const ALLOWED_SUMMARY_FIELDS = ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'];

/** 分钟偏移 → RFC3339（基准 2026-11-02T00:00:00Z，告警窗口 15 分钟）。 */
function at(minute, second = 0) {
  return new Date(BASE_MS + minute * 60000 + second * 1000).toISOString();
}

/**
 * 造一条时间自洽的事件（`received_at` 不早于 `observed_at`）。
 *
 * @param {string} source 稳定来源 id。
 * @param {number} minute 观测分钟（相对基准）。
 * @param {number} seq 来源内序号。
 * @param {number} [second] 观测秒。
 * @returns {object} 合同事件。
 */
function event(source, minute, seq, second = 0) {
  const observedAt = at(minute, second);
  return makeEvent({
    stable_source_id: source,
    source_seq: seq,
    observed_at: observedAt,
    received_at: new Date(Date.parse(observedAt) + 1000).toISOString(),
  });
}

/**
 * 起一套"真库 + 真引擎 + pipeline + 真 scheduler"，并装一个可注入写失败的写入记录器。
 *
 * @param {object} t node:test 上下文。
 * @param {{sources: readonly object[], tickMs?: number, dir?: string}} options 选项。
 * @returns {Promise<object>} 组件。
 */
async function boot(t, options) {
  const dir = options.dir ?? makeTempDir();
  const file = join(dir, 'aegis.db');
  const clock = createManualClock(BASE_MS);
  const parts = await openPipeline(file, clock);
  const scheduler = createScheduler({
    sources: options.sources,
    pipeline: parts.pipeline,
    clock,
    tickMs: options.tickMs ?? 1000,
    sourceTimeoutMs: 5000,
    maxBatchEvents: 100,
    staleAfterMs: 30000,
    maxSources: 32,
  });

  t.after(() => {
    try {
      parts.store.close();
    } catch {
      // 已关过。
    }
  });

  return { dir, file, clock, scheduler, ...parts };
}

/**
 * 打开一个真实 store + pipeline（重启用例要能在同一个库上再来一次）。
 *
 * @param {string} file 数据库路径。
 * @param {object} clock 手动时钟。
 * @returns {Promise<{store: object, pipeline: object, injected: object, violations: object[]}>} 组件。
 */
async function openPipeline(file, clock) {
  const store = createEventStoreAdapter({
    path: file,
    clock,
    allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
  });
  await store.open();

  const pipeline = createPipeline({
    store,
    detection: makeEngine(clock),
    createDetection: () => makeEngine(clock),
    epoch: TEST_EPOCH,
    allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
    budgetClass: 'standard',
    alertStatus: 'new',
    clock,
  });

  const written = new Set();
  const violations = [];
  const trace = [];
  const injected = { failSeqs: new Set(), calls: 0 };
  const ingest = store.ingest.bind(store);
  store.ingest = (request) => {
    injected.calls += 1;
    trace.push(request.event.source_seq);
    for (const alert of request.alerts ?? []) {
      for (const id of alert.event_ids ?? []) {
        if (id !== request.event.event_id && !written.has(id)) {
          violations.push({ source_seq: request.event.source_seq, cited: id });
        }
      }
    }
    if (injected.failSeqs.has(request.event.source_seq)) {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
    }
    const result = ingest(request);
    if (result.duplicate !== true) {
      written.add(request.event.event_id);
    }
    return result;
  };

  return { store, pipeline, injected, violations, trace };
}

/**
 * 读证据快照（只读句柄，不碰写句柄）。
 *
 * @param {string} file 数据库路径。
 * @param {object} clock 手动时钟。
 * @returns {{events: object[], alerts: object[]}} 快照。
 */
function evidence(file, clock) {
  const handle = openStore({ path: file, readOnly: true, clock });
  try {
    const events = handle.all('SELECT event_id, source_seq, observed_at FROM telemetry_event').map((row) => ({
      event_id: String(row.event_id),
      source_seq: Number(row.source_seq),
      observed_at: String(row.observed_at),
    }));
    const alerts = handle.all(
      'SELECT alert_id, fingerprint, window_start, window_end, count, event_ids_json, event_ids_truncated FROM alert ORDER BY window_start, fingerprint',
    ).map((row) => ({
      alert_id: String(row.alert_id),
      fingerprint: String(row.fingerprint),
      window_start: String(row.window_start),
      window_end: String(row.window_end),
      count: Number(row.count),
      truncated: Number(row.event_ids_truncated) === 1,
      event_ids: JSON.parse(String(row.event_ids_json)),
    }));
    return { events, alerts };
  } finally {
    handle.close();
  }
}

/**
 * 硬约束：证据可查、id 不重复、`truncated` 当且仅当 `count > ids`、
 * 且每个窗口的 `count` 等于该窗口已入库的事件数（既不少计也不虚增）。
 *
 * @param {{events: object[], alerts: object[]}} snapshot 快照。
 * @param {string} label 断言前缀。
 * @returns {void}
 */
function assertCountsFollowEvidence(snapshot, label) {
  const stored = new Set(snapshot.events.map((entry) => entry.event_id));
  for (const alert of snapshot.alerts) {
    assert.equal(
      new Set(alert.event_ids).size,
      alert.event_ids.length,
      `${label}: 告警 ${alert.window_start} 的证据 id 不得重复`,
    );
    for (const id of alert.event_ids) {
      assert.ok(stored.has(id), `${label}: 证据 ${id} 必须能在事件表里查到`);
    }
    assert.equal(
      alert.truncated,
      alert.count > alert.event_ids.length,
      `${label}: truncated 必须当且仅当 count 大于证据条数`,
    );
    if (alert.truncated === false) {
      assert.equal(alert.count, alert.event_ids.length, `${label}: 未截断时 count 必须等于证据条数`);
    }
    const inWindow = snapshot.events.filter(
      (entry) => entry.observed_at >= alert.window_start && entry.observed_at < alert.window_end,
    );
    assert.equal(
      alert.count,
      inWindow.length,
      `${label}: 窗口 ${alert.window_start} 的 count 必须等于该窗口已入库事件数（不得少计/虚增）`,
    );
  }
}

/** 等所有 poll 落定。 */
async function drain(scheduler) {
  await waitFor(() => scheduler.status().every((entry) => entry.polling === false), {
    label: 'scheduler polls settle',
  });
}

describe('第 8 轮 P1-5 反例：跨来源并发', () => {
  it('两个来源在同一 tick 进入同一窗口：先到的批次不得消费 A 的延后证据', async (t) => {
    const a1 = event('synthetic.a', 1, 101);
    const a2 = event('synthetic.a', 2, 102);
    const b1 = event('synthetic.b', 3, 201);

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [[a1, a2], [a1, a2], []] }),
        createScriptedSource({ id: 'synthetic.b', script: [[b1], []] }),
      ],
    });
    env.injected.failSeqs.add(101);

    // 同一 tick 启动两个来源的 poll：A 部分失败、B 正常写入。
    env.scheduler.tick();
    await drain(env.scheduler);

    // 这条用例的判别力依赖"A 的批次确实先于 B 写入"。把顺序显式钉住：一旦 scheduler 的
    // poll 完成顺序改变，这里会明确变红，而不是让用例悄悄退化成"两个来源各写各的"。
    assert.deepEqual(env.trace.slice(0, 3), [101, 102, 201], '前提：A 先写入（101 失败、102 成功），B 后写入');

    const afterFirstTick = evidence(env.file, env.clock);
    assert.equal(afterFirstTick.events.length, 2, 'A 的 a2 与 B 的 b1 都应入库');
    assert.equal(env.pipeline.stats().contributions_pending, 1, 'A 被剥离的观测必须还留在队列里');
    assert.equal(
      env.pipeline.stats().contributions_attach_attempts,
      0,
      'B 的批次不得对 A 的条目发起 attach（更不得消耗它的重试预算）',
    );
    assert.equal(env.pipeline.stats().contributions_dropped, 0, '不得把 A 的证据当垃圾丢掉');
    assert.equal(env.pipeline.stats().alerts_dropped, 0, '无关来源的批次不得让 dropped 增长');

    // A 重投成功：事件入库后必须被 count 认领。
    env.injected.failSeqs.clear();
    env.clock.advance(1000);
    env.scheduler.tick();
    await drain(env.scheduler);

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 3, 'a1 必须真的入库');
    assert.equal(snapshot.alerts.length, 1, '同一指纹同一窗口只有一行');
    assert.equal(snapshot.alerts[0].count, 3, '三条可核实事件都必须被 count 认领');
    assertCountsFollowEvidence(snapshot, '跨来源并发');
    assert.equal(env.pipeline.stats().contributions_pending, 0, '补记完成后队列必须清空');
    assert.deepEqual(env.violations, [], '任何一次 T1 调用都不得引用尚未写入的事件');
  });
});

describe('第 8 轮 P1-5 反例：A 失败 / B 正常', () => {
  it('B 连打 9 批不得把 A 的补记预算耗尽（永久少计的反证）', async (t) => {
    const a1 = event('synthetic.a', 1, 101);
    const a2 = event('synthetic.a', 2, 102);
    const bBatches = Array.from({ length: 9 }, (_unused, index) => [event('synthetic.b', 3 + index, 300 + index)]);

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [[a1, a2], [a1, a2], []] }),
        createScriptedSource({ id: 'synthetic.b', script: bBatches }),
      ],
    });

    env.injected.failSeqs.add(101);
    await env.scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1);

    for (let index = 0; index < bBatches.length; index += 1) {
      await env.scheduler.pollNow('synthetic.b');
    }
    assert.equal(env.pipeline.stats().contributions_pending, 1, 'B 的 9 个批次不得排空 A 的条目');
    assert.equal(env.pipeline.stats().contributions_attach_attempts, 0, 'B 不得消耗 A 的重试预算');
    assert.equal(env.pipeline.stats().contributions_dropped, 0, 'A 的证据不得被预算耗尽而丢弃');
    assert.equal(evidence(env.file, env.clock).events.length, 10, 'A 的 a2 与 B 的 9 条都应入库');

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 11, 'a1 必须真的入库');
    assert.equal(snapshot.alerts[0].count, 11, 'count 必须追平该窗口已入库事件数');
    assertCountsFollowEvidence(snapshot, 'A 失败 B 正常');
    assert.equal(env.pipeline.stats().contributions_pending, 0);
  });
});

describe('第 8 轮 P1-5 反例：A 重投', () => {
  it('补齐后再次重投：不重复计数、不重复投递请求', async (t) => {
    const a1 = event('synthetic.a', 1, 111);
    const a2 = event('synthetic.a', 2, 112);
    const b1 = event('synthetic.b', 4, 211);
    const batch = [a1, a2];

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [batch, batch, batch] }),
        createScriptedSource({ id: 'synthetic.b', script: [[b1]] }),
      ],
    });

    env.injected.failSeqs.add(111);
    await env.scheduler.pollNow('synthetic.a');
    await env.scheduler.pollNow('synthetic.b');

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');
    const first = evidence(env.file, env.clock);
    assert.equal(first.alerts[0].count, 3);
    assert.equal(env.pipeline.stats().analysis_requests, 1, '同一告警只投递一次分析请求');

    // 第三次：整批被稳定键预过滤，计数不得再动。
    await env.scheduler.pollNow('synthetic.a');
    const second = evidence(env.file, env.clock);
    assert.equal(second.events.length, 3);
    assert.equal(second.alerts[0].count, 3, '重放不得把同一次观测计两遍');
    assertCountsFollowEvidence(second, 'A 重投');
    assert.equal(env.pipeline.stats().analysis_requests, 1);
    assert.deepEqual(env.violations, []);
  });
});

describe('第 8 轮 P1-5 反例：部分写成功', () => {
  it('A 先成一条、后一条失败：B 的批次进入后再重投，count 仍要追平', async (t) => {
    const survivor = event('synthetic.a', 1, 121);
    const doomed = event('synthetic.a', 2, 122);
    const b1 = event('synthetic.b', 5, 221);
    const batch = [survivor, doomed];

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [batch, batch] }),
        createScriptedSource({ id: 'synthetic.b', script: [[b1]] }),
      ],
    });

    // 锚点在后位，失败的也是后位：这一批一行告警都没写出来。
    env.injected.failSeqs.add(122);
    await env.scheduler.pollNow('synthetic.a');
    const partial = evidence(env.file, env.clock);
    assert.equal(partial.events.length, 1, '只有前一条入库');
    assert.equal(partial.alerts.length, 0, '锚点失败时不得写出没有证据的行');
    assert.equal(env.pipeline.stats().contributions_pending, 1);

    await env.scheduler.pollNow('synthetic.b');
    assert.equal(env.pipeline.stats().contributions_pending, 1, 'B 不得排空 A 的条目');
    assert.equal(env.pipeline.stats().contributions_attach_attempts, 0);

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 3);
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 3, 'survivor / doomed / b1 三条都必须被认领');
    assertCountsFollowEvidence(snapshot, '部分写成功');
    assert.deepEqual(env.violations, []);
  });
});

describe('第 8 轮 P1-5 反例：同一指纹跨窗口', () => {
  it('B 的批次落在另一个窗口时，A 在窗口 1 的证据不得被它排空', async (t) => {
    const earlyFail = event('synthetic.a', 1, 131);
    const earlyOk = event('synthetic.a', 2, 132);
    const lateB = event('synthetic.b', 20, 231);
    const anotherB = event('synthetic.b', 34, 232);
    const batch = [earlyFail, earlyOk];

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [batch, batch] }),
        createScriptedSource({ id: 'synthetic.b', script: [[lateB], [anotherB]] }),
      ],
    });

    env.injected.failSeqs.add(131);
    await env.scheduler.pollNow('synthetic.a');
    await env.scheduler.pollNow('synthetic.b');
    await env.scheduler.pollNow('synthetic.b');
    assert.equal(env.pipeline.stats().contributions_pending, 1, 'A 的条目必须跨两个 B 批次存活');
    assert.equal(env.pipeline.stats().contributions_attach_attempts, 0);

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 4);
    assert.equal(snapshot.alerts.length, 3, '三个窗口各一行');
    const byWindow = new Map(snapshot.alerts.map((alert) => [alert.window_start, alert]));
    assert.equal(byWindow.get('2026-11-02T00:00:00.000Z').count, 2, '窗口 00:00 有两条可核实事件');
    assert.equal(byWindow.get('2026-11-02T00:15:00.000Z').count, 1);
    assert.equal(byWindow.get('2026-11-02T00:30:00.000Z').count, 1);
    assertCountsFollowEvidence(snapshot, '同一指纹跨窗口');
    assert.deepEqual(env.violations, []);
  });
});

describe('第 8 轮 P1-5 反例：重启恢复', () => {  it('补记队列随进程丢失后，重放仍必须把 count 补齐（正确性不依赖内存队列）', async (t) => {
    const a1 = event('synthetic.a', 1, 141);
    const a2 = event('synthetic.a', 2, 142);
    const batch = [a1, a2];

    const dir = makeTempDir();
    const file = join(dir, 'aegis.db');
    const clock = createManualClock(BASE_MS);

    const first = await openPipeline(file, clock);
    const firstScheduler = createScheduler({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch] })],
      pipeline: first.pipeline,
      clock,
      tickMs: 1000,
      sourceTimeoutMs: 5000,
      maxBatchEvents: 100,
      staleAfterMs: 30000,
      maxSources: 32,
    });
    first.injected.failSeqs.add(141);
    await firstScheduler.pollNow('synthetic.a');
    assert.equal(first.pipeline.stats().contributions_pending, 1, '进程内有未补记的条目');
    assert.equal(evidence(file, clock).alerts[0].count, 1);

    // 崩溃：队列只在内存，随进程一起消失；游标未推进，来源会原样重投。
    first.store.close();

    const second = await openPipeline(file, clock);
    t.after(() => {
      try {
        second.store.close();
      } catch {
        // 已关过。
      }
    });
    const secondScheduler = createScheduler({
      sources: [createScriptedSource({ id: 'synthetic.a', script: [batch] })],
      pipeline: second.pipeline,
      clock,
      tickMs: 1000,
      sourceTimeoutMs: 5000,
      maxBatchEvents: 100,
      staleAfterMs: 30000,
      maxSources: 32,
    });
    await secondScheduler.pollNow('synthetic.a');

    const snapshot = evidence(file, clock);
    assert.equal(second.pipeline.stats().contributions_pending, 0, '新进程没有需要补记的条目');
    assert.equal(snapshot.events.length, 2, '重放把失败的那条补上');
    assert.equal(snapshot.alerts[0].count, 2, '重建后的引擎重新检测到它，count 追平');
    assertCountsFollowEvidence(snapshot, '重启恢复');
    assert.deepEqual(second.violations, []);
  });
});

describe('第 8 轮 P1-5 反例：队列容量（不再有容量淘汰）', () => {
  it('B 的 33 条积压既不得挤掉 A 的延后证据，也不得丢掉 B 自己的条目', async (t) => {
    const a1 = event('synthetic.a', 1, 151);
    const a2 = event('synthetic.a', 2, 152);
    // 33 条事件分属 33 个窗口：每条都是自己窗口的锚点，每条写失败都会留下一个条目。
    const backlog = Array.from({ length: 33 }, (_unused, index) => event('synthetic.b', 3 + index * 15, 400 + index));

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [[a1, a2], [a1, a2]] }),
        createScriptedSource({ id: 'synthetic.b', script: [backlog] }),
      ],
    });

    env.injected.failSeqs.add(151);
    await env.scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1, 'A 留下一条延后补记');

    for (const entry of backlog) {
      env.injected.failSeqs.add(entry.source_seq);
    }
    await env.scheduler.pollNow('synthetic.b');

    // 任何容量淘汰都会丢掉"马上就要变可核实"的证据（游标不推进，批次会重放），
    // 所以队列只按工作量增长：1 条 A + 33 条 B 全留，且一条都不许丢。
    assert.equal(env.pipeline.stats().contributions_dropped, 0, '容量不得丢弃任何延后证据');
    assert.equal(env.pipeline.stats().contributions_pending, 34, '1 条 A + 33 条 B 都必须留在队列里');
    assert.equal(env.pipeline.stats().contributions_attach_attempts, 0, 'B 不得触碰 A 的条目');

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 2, '库里只有 A 的两条（B 全部写失败）');
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 2, 'A 的证据没有被任何淘汰挤掉，count 必须追平');
    assertCountsFollowEvidence(snapshot, '队列容量');
    assert.equal(env.pipeline.stats().contributions_pending, 33, 'A 的条目被排空后只剩 B 的 33 条');
  });

  it('B 的积压不会让 A 的新条目被拒收（拒收外来新条目的反证）', async (t) => {
    // A 的事件时间必须**晚于** B 的积压：检测引擎按观测时间推进窗口，早于当前窗口的事件
    // 不会再产生告警贡献（那是引擎的既有语义，不是本用例要测的东西）。
    const a1 = event('synthetic.a', 600, 155);
    const a2 = event('synthetic.a', 601, 156);
    const backlog = Array.from({ length: 33 }, (_unused, index) => event('synthetic.b', 3 + index * 15, 500 + index));

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.b', script: [backlog] }),
        createScriptedSource({ id: 'synthetic.a', script: [[a1, a2], [a1, a2]] }),
      ],
    });

    for (const entry of backlog) {
      env.injected.failSeqs.add(entry.source_seq);
    }
    await env.scheduler.pollNow('synthetic.b');
    assert.equal(env.pipeline.stats().contributions_dropped, 0);
    assert.equal(env.pipeline.stats().contributions_pending, 33);

    // A 随后才产生第一条延后补记：不得因为队列里已有别人的 33 条而被拒收。
    env.injected.failSeqs.add(155);
    await env.scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_dropped, 0, '不得因为别人的积压而丢掉 A 的观测');
    assert.equal(env.pipeline.stats().contributions_pending, 34, 'A 的条目必须进队列');

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.alerts[0].count, 2, 'A 的延后证据必须能被补回');
    assertCountsFollowEvidence(snapshot, '队列配额反向');
    assert.equal(env.pipeline.stats().contributions_pending, 33, '只剩 B 的 33 条');
  });

  it('单来源一次 99 事件全写失败：重放后每个窗口都必须有告警行，count 追平（容量丢弃的反证）', async (t) => {
    // 第 12 轮 P1-8 的形态：99 条同批、分属 99 个窗口、全部写失败。
    // 一旦有容量上限，超出的条目会被丢掉，而游标不推进 → 下一拍整批重放 → 事件全部入库，
    // 那些窗口却永远没有告警行，`count` 与库内事件数脱节且 `truncated=false`。
    const burst = Array.from({ length: 99 }, (_unused, index) => event('synthetic.a', 10 + index * 15, 700 + index));

    const env = await boot(t, {
      sources: [createScriptedSource({ id: 'synthetic.a', script: [burst, burst] })],
    });

    for (const entry of burst) {
      env.injected.failSeqs.add(entry.source_seq);
    }
    const first = await env.scheduler.pollNow('synthetic.a');
    assert.equal(first.lifecycle, 'degraded', '整批写失败必须把来源标降级');
    assert.equal(env.pipeline.stats().contributions_pending, 99, '99 条失败观测必须全部留下');
    assert.equal(env.pipeline.stats().contributions_dropped, 0, '不得按容量丢弃任何一条');

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 99, '重放把 99 条都写进去');
    assert.equal(snapshot.alerts.length, 99, '每个窗口都必须有告警行');
    for (const alert of snapshot.alerts) {
      assert.equal(alert.count, 1, `窗口 ${alert.window_start} 必须认领自己那一条事件`);
    }
    assertCountsFollowEvidence(snapshot, '99 条降级批次');
    assert.equal(env.pipeline.stats().contributions_pending, 0, '重放后队列必须清空');
    assert.equal(env.pipeline.stats().contributions_dropped, 0);
  });
});

describe('第 8 轮 P1-5 反例：同来源重试预算', () => {
  it('同来源连续 9 批都核验不了：第 9 批按预算丢弃并计数，count 仍等于库内事件数', async (t) => {
    const doomed = event('synthetic.a', 1, 161);
    const survivor = event('synthetic.a', 2, 162);
    // 后续 9 批都不含 a1（模拟来源在一个降级批次之后先推进到别的记录）。
    const later = Array.from({ length: 9 }, (_unused, index) => [event('synthetic.a', 4 + index, 170 + index)]);

    const env = await boot(t, {
      sources: [
        createScriptedSource({ id: 'synthetic.a', script: [[doomed, survivor], ...later] }),
      ],
    });

    env.injected.failSeqs.add(161);
    await env.scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1);
    assert.equal(env.pipeline.stats().contributions_attach_attempts, 0);

    for (let index = 0; index < later.length; index += 1) {
      await env.scheduler.pollNow('synthetic.a');
    }

    // 预算是 8 次：前 8 批各消耗一次，第 9 批发现 attempts 已到上限 → 丢弃并计数。
    assert.equal(env.pipeline.stats().contributions_pending, 0, '预算耗尽后队列不得永久占用');
    assert.equal(env.pipeline.stats().contributions_dropped, 1, '丢弃必须被计数');
    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.some((entry) => entry.source_seq === 161), false, '该事件确实没入库');
    assert.equal(snapshot.alerts[0].count, snapshot.events.length, '没入库的观测不得计入 count');
    assertCountsFollowEvidence(snapshot, '同来源预算');
    assert.deepEqual(env.violations, []);
  });
});

describe('第 8 轮 P1-5 反例：同来源延后保留', () => {
  it('同来源下一批不含该事件时先留着，等它真回来再补（不得当拍丢弃）', async (t) => {
    const doomed = event('synthetic.a', 1, 181);
    const survivor = event('synthetic.a', 2, 182);
    const middle = event('synthetic.a', 5, 183);
    const interloper = event('synthetic.b', 8, 281);

    const env = await boot(t, {
      sources: [
        // A 的第 2 批不含 a1：这正是"延后一拍"要处理的情形。
        createScriptedSource({ id: 'synthetic.a', script: [[doomed, survivor], [middle], [doomed]] }),
        createScriptedSource({ id: 'synthetic.b', script: [[interloper]] }),
      ],
    });

    env.injected.failSeqs.add(181);
    await env.scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1);

    await env.scheduler.pollNow('synthetic.a');
    assert.equal(env.pipeline.stats().contributions_pending, 1, '核验不了要留着，不能当拍丢弃');
    assert.equal(env.pipeline.stats().contributions_dropped, 0);
    assert.equal(env.pipeline.stats().alerts_dropped, 0);

    await env.scheduler.pollNow('synthetic.b');
    assert.equal(env.pipeline.stats().contributions_attach_attempts, 1, '只有 A 自己的批次消耗了预算');
    assert.equal(env.pipeline.stats().contributions_pending, 1);

    env.injected.failSeqs.clear();
    await env.scheduler.pollNow('synthetic.a');

    const snapshot = evidence(env.file, env.clock);
    assert.equal(snapshot.events.length, 4, 'a2 / middle / b1 / a1 四条');
    assert.equal(snapshot.alerts[0].count, 4, '延后补记必须把 a1 补回 count');
    assertCountsFollowEvidence(snapshot, '同来源延后保留');
    assert.deepEqual(env.violations, []);
  });
});
