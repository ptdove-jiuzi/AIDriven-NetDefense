/**
 * attach-anchor.test.js — 第 7 轮 P1-3 的反例集：**告警锚点不得早于它引用的证据**。
 *
 * 第 7 轮独立复核发现 `attachRetained` 用"逆序轮转"给保留贡献分配锚点：保留告警被挂到
 * 位置 i 的事件上，却引用位置 j>i 的事件（i 的 T1 先提交）。j 的写入随后失败时，
 * 那一行就成了"证据指向一条从未入库的事件、`count` 虚增、`truncated=false`"的悬空行。
 *
 * 这条不变式在**每一次 T1 调用内部**都成立，所以这里用一个记录器在写入时逐条核对：
 * 告警引用的 id 只能是"自己这条事件"或"本进程里已经写成功的事件"。它不是事后看数据库
 * ——事后看数据库只能发现永久悬空，发现不了"先悬空、后来补上"的顺序违规。
 *
 * 五个场景分别对应收口要求：
 * 1. 多指纹跨窗口：一批里出现 ≥2 条告警贡献（P1-3 的触发条件）；
 * 2. 后续 T1 失败：锚点之后的事件写失败，锚点那次调用不得引用它；
 * 3. 同批重放：游标不推进，整批原样重投，不得重复计数；
 * 4. 部分写成功：先部分落库、再重放补齐，`count` 必须追平可核实的事件数；
 * 5. 保留贡献让位：引擎重建后同一次观测被重新检测，保留那份必须让位而不是重复计。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';

import { openStore } from '../../packages/event-store/src/index.js';
import { createEventStoreAdapter } from '../../apps/daemon/src/adapters/event-store.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { createPipeline } from '../../apps/daemon/src/pipeline.js';
import { DAEMON_CODES, DaemonError } from '../../apps/daemon/src/errors.js';

import { BASE_MS, TEST_EPOCH, makeEngine, makeEvent, makeTempDir } from './helpers.js';

const ALLOWED_SUMMARY_FIELDS = ['alert_count', 'rule_type', 'sequence_in_hour', 'severity_rank'];

// 两个指纹需要两条规则：`process_name` 参与指纹，helpers.js 的默认规则只认 evil.exe。
const PACK = {
  schemaVersion: '1.0',
  packId: 'wp5-anchor-pack',
  packVersion: '1.0.0',
  rules: [
    {
      ruleId: 'proc.evil-start',
      version: '1.0.0',
      type: 'condition',
      severity: 'high',
      fields: ['process_name'],
      fingerprint: ['process_name'],
      when: { field: 'process_name', operator: 'eq', value: 'evil.exe' },
    },
    {
      ruleId: 'proc.bad-start',
      version: '1.0.0',
      type: 'condition',
      severity: 'high',
      fields: ['process_name'],
      fingerprint: ['process_name'],
      when: { field: 'process_name', operator: 'eq', value: 'bad.exe' },
    },
  ],
};

/** 分钟偏移 → ISO 时间戳（基准 2026-11-02T00:00:00Z，告警窗口 15 分钟）。 */
function at(minute) {
  return new Date(BASE_MS + minute * 60000).toISOString();
}

/**
 * 造一条时间自洽的事件：`received_at` 必须不早于 `observed_at`，否则合同会拒收。
 *
 * @param {number} minute 观测时刻（相对基准的分钟数）。
 * @param {object} [overrides] 其余字段覆盖。
 * @returns {object} 合同事件。
 */
function event(minute, overrides = {}) {
  const observedAt = at(minute);
  return makeEvent({
    observed_at: observedAt,
    received_at: new Date(Date.parse(observedAt) + 1000).toISOString(),
    ...overrides,
  });
}

/**
 * 起一套"真库 + 真检测引擎 + pipeline"，并装一个**按序**核对告警证据的写入记录器。
 *
 * 记录器做两件事：
 * - `failWhen(request)` 返回 true 时抛写入失败（模拟 T1 失败，事件整笔回滚）；
 * - 每次写入前核对：告警引用的每个 id 要么是本次事件自己，要么在本进程里已经写成功。
 *
 * @param {object} t node:test 上下文。
 * @returns {object} 组件。
 */
async function boot(t) {
  const dir = makeTempDir();
  const file = join(dir, 'aegis-harness.db');
  const clock = createManualClock(BASE_MS);
  const store = createEventStoreAdapter({
    path: file,
    clock,
    allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
  });
  await store.open();

  const pipeline = createPipeline({
    store,
    detection: makeEngine(clock, PACK),
    createDetection: () => makeEngine(clock, PACK),
    epoch: TEST_EPOCH,
    allowedSummaryFields: ALLOWED_SUMMARY_FIELDS,
    budgetClass: 'standard',
    alertStatus: 'new',
    clock,
  });

  const readers = [];
  const read = () => {
    const handle = openStore({ path: file, readOnly: true, clock });
    readers.push(handle);
    return handle;
  };

  const written = new Set();
  const violations = [];
  const recorder = {
    /** @type {(request: object) => boolean} */
    failWhen: () => false,
    calls: 0,
  };
  const ingest = store.ingest.bind(store);
  store.ingest = (request) => {
    recorder.calls += 1;
    for (const alert of request.alerts ?? []) {
      for (const id of alert.event_ids ?? []) {
        if (id !== request.event.event_id && !written.has(id)) {
          violations.push({ source_seq: request.event.source_seq, cited: id });
        }
      }
    }
    if (recorder.failWhen(request) === true) {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
    }
    const result = ingest(request);
    if (result.duplicate !== true) {
      written.add(request.event.event_id);
    }
    return result;
  };

  // PERF-CPU N-034: the pipeline commits a run of alert-free events through `store.ingestBatch()`.
  // This fixture used to wrap only `ingest()`, so a batched write would bypass both the injected
  // failure and the `written` book-keeping, and the suite would quietly stop testing what it claims
  // to. Mirror the same rules into the batch entry point: decide per record, commit the survivors in
  // ONE transaction (the production shape).
  if (typeof store.ingestBatch === 'function') {
    const batchIngest = store.ingestBatch.bind(store);
    store.ingestBatch = (requests) => {
      const blocked = new Map();
      const allowed = [];
      requests.forEach((request, index) => {
        recorder.calls += 1;
        // A batched run never carries alerts (the pipeline only batches alert-free events), so this
        // dangling-citation scan has nothing to inspect here; it is kept for a future batching rule.
        for (const alert of request.alerts ?? []) {
          for (const id of alert.event_ids ?? []) {
            if (id !== request.event.event_id && !written.has(id)) {
              violations.push({ source_seq: request.event.source_seq, cited: id });
            }
          }
        }
        if (recorder.failWhen(request) === true) {
          blocked.set(index, new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure'));
        } else {
          allowed.push(index);
        }
      });
      const out = allowed.length === 0
        ? { accepted: 0, duplicates: 0, failed: 0, results: [] }
        : batchIngest(allowed.map((index) => requests[index]));
      const results = new Array(requests.length);
      allowed.forEach((originalIndex, position) => {
        results[originalIndex] = out.results[position];
        const value = out.results[position]?.value;
        if (value !== undefined && value.duplicate !== true) {
          written.add(requests[originalIndex].event.event_id);
        }
      });
      for (const [index, error] of blocked) {
        results[index] = { ok: false, error };
      }
      return {
        received: requests.length,
        accepted: out.accepted,
        duplicates: out.duplicates,
        failed: (out.failed ?? 0) + blocked.size,
        results,
      };
    };
  }

  t.after(() => {
    for (const handle of readers) {
      try {
        handle.close();
      } catch {
        // 已关过。
      }
    }
    try {
      store.close();
    } catch {
      // 已关过。
    }
  });

  return { store, pipeline, clock, read, violations, recorder };
}

/**
 * 读取证据快照。
 *
 * @param {object} handle 只读句柄。
 * @returns {object} 快照。
 */
function evidence(handle) {
  const events = handle.all('SELECT event_id FROM telemetry_event').map((row) => String(row.event_id));
  const alerts = handle.all(
    'SELECT alert_id, fingerprint, window_start, window_end, count, event_ids_json, event_ids_truncated FROM alert ORDER BY window_start, fingerprint',
  ).map((row) => ({
    alert_id: String(row.alert_id),
    fingerprint: String(row.fingerprint),
    window_start: String(row.window_start),
    window_end: String(row.window_end),
    count: Number(row.count),
    event_ids_truncated: Number(row.event_ids_truncated) === 1,
    event_ids: JSON.parse(String(row.event_ids_json)),
  }));
  const analyses = handle.all('SELECT alert_id FROM analysis_outbox').map((row) => String(row.alert_id));
  return { events, alerts, analyses };
}

/**
 * 每条告警的硬约束：证据可查、id 不重复、`truncated` 当且仅当计数大于证据条数、count 不为 0。
 *
 * @param {object} snapshot 快照。
 * @param {string} label 断言前缀。
 * @returns {void}
 */
function assertAlertEvidence(snapshot, label) {
  const stored = new Set(snapshot.events);
  for (const alert of snapshot.alerts) {
    assert.equal(
      new Set(alert.event_ids).size,
      alert.event_ids.length,
      `${label}: 告警 ${alert.fingerprint}/${alert.window_start} 的证据 id 不得重复`,
    );
    for (const id of alert.event_ids) {
      assert.ok(stored.has(id), `${label}: 证据 ${id} 必须能在事件表里查到`);
    }
    assert.equal(
      alert.event_ids_truncated,
      alert.count > alert.event_ids.length,
      `${label}: truncated 必须当且仅当 count 大于证据条数`,
    );
    if (alert.event_ids_truncated === false) {
      assert.equal(alert.count, alert.event_ids.length, `${label}: 未截断时 count 必须等于证据条数`);
    }
    assert.ok(alert.count > 0, `${label}: 不得写出 count 为 0 的告警行`);
  }
}

describe('第 7 轮 P1-3 反例：多指纹跨窗口 + 后续写入失败', () => {
  it('两个指纹两个窗口的贡献都失败后重放，告警只引用当时已入库的证据', async (t) => {
    const { pipeline, read, violations, recorder } = await boot(t);

    const earlyEvil = event(5, { source_seq: 11 });
    const earlyBad = event(5, { source_seq: 12, payload: { process_name: 'bad.exe', pid: 1 } });
    const lateEvil = event(20, { source_seq: 13 });
    const lateBad = event(20, { source_seq: 14, payload: { process_name: 'bad.exe', pid: 2 } });
    const batch = [earlyEvil, earlyBad, lateEvil, lateBad];

    // 第 1 批：四条全失败 → 两份保留贡献（两个窗口 × 两个指纹）。
    recorder.failWhen = () => true;
    const first = pipeline.ingestBatch(batch);
    assert.equal(first.store_errors, 4);
    assert.equal(first.accepted, 0);
    assert.ok(pipeline.stats().contributions_pending >= 2, '多指纹多窗口必须留下多条保留贡献');

    // 第 2 批：同一批原样重放，后位（00:20 的两条）再次失败。
    recorder.failWhen = (request) => request.event.source_seq >= 13;
    const second = pipeline.ingestBatch(batch);
    assert.equal(second.accepted, 2);
    assert.equal(second.store_errors, 2);
    recorder.failWhen = () => false;

    assert.deepEqual(violations, [], '任何一次 T1 调用都不得引用当时还没写入的事件');

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 2, '只有 00:05 的两条入库');
    assert.equal(snapshot.alerts.length, 2, '两个指纹各一行，窗口 00:00–00:15');
    for (const alert of snapshot.alerts) {
      assert.equal(alert.window_start, '2026-11-02T00:00:00.000Z');
      assert.equal(alert.count, 1, '每个指纹在这一批里只有一次真实观测');
    }
    assertAlertEvidence(snapshot, '多指纹跨窗口');
    const counted = new Set(snapshot.alerts.flatMap((alert) => alert.event_ids));
    assert.equal(counted.has(lateEvil.event_id), false, '写失败的事件不得出现在证据里');
    assert.equal(counted.has(lateBad.event_id), false, '写失败的事件不得出现在证据里');
    assert.equal(snapshot.analyses.length, 2, '每条告警一次分析请求');
  });
});

describe('第 7 轮 P1-3 反例：同批内后续写入失败', () => {
  it('同窗口三条中第二条失败：锚点行只统计已落库的观测', async (t) => {
    const { pipeline, read, violations, recorder } = await boot(t);

    const firstEvent = event(1, { source_seq: 21 });
    const doomed = event(2, { source_seq: 22 });
    const lastEvent = event(3, { source_seq: 23 });

    recorder.failWhen = (request) => request.event.source_seq === 22;
    const summary = pipeline.ingestBatch([firstEvent, doomed, lastEvent]);
    assert.equal(summary.accepted, 2);
    assert.equal(summary.store_errors, 1);

    assert.deepEqual(violations, [], '锚点写在最后一条事件上，但不得引用失败的那条');

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.alerts.length, 1, '一个指纹一个窗口一行');
    assert.equal(snapshot.alerts[0].count, 2, '失败的观测不得计入 count');
    assert.equal(snapshot.alerts[0].event_ids.includes(doomed.event_id), false, '不得引用失败的事件');
    assertAlertEvidence(snapshot, '同批后续失败');
  });

  it('失败的那条后来重试成功，count 必须追平可核实的事件数', async (t) => {
    const { pipeline, read, violations, recorder } = await boot(t);

    const firstEvent = event(1, { source_seq: 31 });
    const doomed = event(2, { source_seq: 32 });
    const lastEvent = event(3, { source_seq: 33 });
    const batch = [firstEvent, doomed, lastEvent];

    recorder.failWhen = (request) => request.event.source_seq === 32;
    pipeline.ingestBatch(batch);
    const partial = evidence(read());
    assert.equal(partial.alerts[0].count, 2, '先只统计真的落库的那两条');

    // 被剥离的观测必须留一份延后补记的贡献，而不是随事件一起丢弃。
    assert.ok(pipeline.stats().contributions_pending >= 1, '被剥离的观测必须留待补记');

    recorder.failWhen = () => false;
    pipeline.ingestBatch(batch);

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 3, '重放把缺口补上');
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 3, '每一行事件都必须被 count 认领');
    assert.equal(new Set(snapshot.alerts[0].event_ids).size, 3);
    assertAlertEvidence(snapshot, '后续重试补齐');
    assert.deepEqual(violations, []);
  });
});

describe('第 7 轮 P1-3 反例：同批重放', () => {
  it('整批失败后原样重放：不重复计数、不留悬空、不重复投递请求', async (t) => {
    const { pipeline, read, violations, recorder } = await boot(t);

    const early = event(5, { source_seq: 41 });
    const late = event(20, { source_seq: 42 });
    const batch = [early, late];

    recorder.failWhen = () => true;
    const first = pipeline.ingestBatch(batch);
    assert.equal(first.store_errors, 2);
    assert.equal(pipeline.stats().analysis_requests, 0);

    recorder.failWhen = () => false;
    const second = pipeline.ingestBatch(batch);
    assert.equal(second.accepted, 2, '重放把两条都写进去');
    assert.equal(pipeline.stats().analysis_requests, 1, '同一告警的请求被幂等键吸收');

    // 再重放一次：应当被稳定键预过滤整体拦下。
    const third = pipeline.ingestBatch(batch);
    assert.equal(third.duplicate, 2);
    assert.equal(third.accepted, 0);

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.alerts.length, 2, '两个窗口各一行');
    for (const alert of snapshot.alerts) {
      assert.equal(alert.count, 1, '重放不得把同一次观测计两遍');
      assert.equal(alert.event_ids.length, 1);
    }
    assertAlertEvidence(snapshot, '同批重放');
    assert.equal(snapshot.analyses.length, 1);
    assert.deepEqual(violations, []);
  });
});

describe('第 7 轮 P1-3 反例：部分写成功', () => {
  it('同窗口先成功一条、后重放补齐另一条：count 跟随证据而不是跟随写入次数', async (t) => {
    const { pipeline, read, violations, recorder } = await boot(t);

    const doomed = event(3, { source_seq: 51 });
    const survivor = event(4, { source_seq: 52 });
    const batch = [doomed, survivor];

    recorder.failWhen = (request) => request.event.source_seq === 51;
    const first = pipeline.ingestBatch(batch);
    assert.equal(first.accepted, 1);
    assert.equal(first.store_errors, 1);

    const partialSnapshot = evidence(read());
    assert.equal(partialSnapshot.events.length, 1);
    assert.equal(partialSnapshot.alerts[0].count, 1, '先只统计真的落库的那一条');
    assert.equal(partialSnapshot.alerts[0].event_ids_truncated, false);

    recorder.failWhen = () => false;
    const second = pipeline.ingestBatch(batch);
    assert.equal(second.accepted, 1, '只有失败的那条是新的');
    assert.equal(second.duplicate, 1, '成功那条被稳定键预过滤');

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 2, '两条可核实事件必须都被 count 认领');
    assert.equal(snapshot.alerts[0].event_ids.length, 2);
    assertAlertEvidence(snapshot, '部分写成功');
    assert.deepEqual(violations, []);
    assert.equal(pipeline.stats().contributions_pending, 0, '补记完成后保留队列必须清空');
  });
});

describe('第 7 轮 P1-3 反例：保留贡献让位', () => {
  it('引擎重建后重新检测到同一次观测：保留的那份让位，计数不翻倍', async (t) => {
    const { pipeline, read, violations, recorder, clock } = await boot(t);

    const single = event(5, { source_seq: 61 });
    recorder.failWhen = () => true;
    pipeline.ingestBatch([single]);
    assert.equal(pipeline.stats().contributions_pending, 1);

    // 引擎重建会清空 seenEventIds：同一条事件被重新检测，产生新的贡献。
    recorder.failWhen = () => false;
    pipeline.replaceEngine(makeEngine(clock, PACK));
    const summary = pipeline.ingestBatch([single]);
    assert.equal(summary.accepted, 1);
    assert.equal(pipeline.stats().contributions_superseded, 1, '保留的那份必须让位');

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 1, '同一次观测不能被计两遍');
    assertAlertEvidence(snapshot, '保留让位');
    assert.deepEqual(violations, []);
  });

  it('让位是按 (指纹, 窗口) 的：另一个窗口的保留贡献不会被写进本行，也不会被误判为丢失', async (t) => {
    const { pipeline, read, violations, recorder, clock } = await boot(t);

    const firstWindow = event(5, { source_seq: 71 });
    const secondWindow = event(20, { source_seq: 72 });
    recorder.failWhen = () => true;
    pipeline.ingestBatch([firstWindow, secondWindow]);
    assert.equal(pipeline.stats().contributions_pending, 2);

    recorder.failWhen = () => false;
    pipeline.replaceEngine(makeEngine(clock, PACK));
    // 只重放第一个窗口的事件：第二个窗口那份贡献的锚点事件没有回来。
    pipeline.ingestBatch([firstWindow]);

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.alerts.length, 1, '第二个窗口没有可核实证据，不得写出');
    assert.equal(snapshot.alerts[0].count, 1);
    assert.equal(snapshot.alerts[0].window_start, '2026-11-02T00:00:00.000Z');
    assertAlertEvidence(snapshot, '按窗口让位');
    assert.equal(pipeline.stats().contributions_superseded, 1, '只有被重新观测的窗口让位');
    // 未被核验的那份**延后**而不是当场判死：它的来源还没重投，直接丢掉就是永久少计。
    assert.equal(pipeline.stats().alerts_dropped, 0, '证据只是还没到，不得当场计为丢失');
    assert.ok(pipeline.stats().contributions_pending >= 1, '不可核验的证据必须留在队列里等它的事件');
    assert.deepEqual(violations, []);

    // 若该事件永远不再回来：重试预算耗尽后丢弃并计数，不会无限占用队列。
    const before = pipeline.stats().contributions_dropped;
    for (let round = 0; round < 10; round += 1) {
      recorder.failWhen = () => false;
      pipeline.ingestBatch([event(60 + round, { source_seq: 200 + round })]);
    }
    assert.ok(
      pipeline.stats().contributions_dropped > before,
      '重试预算耗尽后必须丢弃并计入 contributions_dropped',
    );
    const after = evidence(read());
    assert.equal(
      after.alerts.some((alert) => alert.window_start === '2026-11-02T00:15:00.000Z'),
      false,
      '证据从未入库的窗口不得凭空长出告警行',
    );
    assertAlertEvidence(after, '预算耗尽');
  });
});

describe('第 8 轮 P1-5 回归：延后补记不能被别的来源排空', () => {
  it('来源 A 的延后证据遇到来源 B 的批次时保留，A 重投后 count 追平', async (t) => {
    const { pipeline, read, violations, recorder } = await boot(t);

    const doomed = event(3, { source_seq: 81, stable_source_id: 'source.a' });
    const survivor = event(4, { source_seq: 82, stable_source_id: 'source.a' });

    // A 的部分写失败：告警只统计 survivor，doomed 的观测进入延后补记。
    recorder.failWhen = (request) => request.event.source_seq === 81;
    pipeline.ingestBatch([doomed, survivor], { source_id: 'source.a' });
    const partial = evidence(read());
    assert.equal(partial.alerts[0].count, 1);
    assert.ok(pipeline.stats().contributions_pending >= 1);

    // 另一个来源的批次先到：它的窗口与证据都跟 A 无关。旧实现会在这里把 A 的
    // 延后贡献当作"不可核实"丢掉，于是 A 之后重投成功也补不回 count。
    recorder.failWhen = () => false;
    pipeline.ingestBatch([event(50, { source_seq: 91, stable_source_id: 'source.b' })], { source_id: 'source.b' });
    assert.equal(pipeline.stats().alerts_dropped, 0, '别的来源不得把 A 的延后证据判死');
    assert.ok(pipeline.stats().contributions_pending >= 1, '延后证据必须继续等待它自己的事件');

    // A 重投：引擎已经见过这条事件，不会重新检测，只能靠延后补记把 count 补上。
    pipeline.ingestBatch([doomed, survivor], { source_id: 'source.a' });

    const snapshot = evidence(read());
    const aWindow = snapshot.alerts.filter((alert) => alert.window_start === '2026-11-02T00:00:00.000Z');
    assert.equal(aWindow.length, 1);
    assert.equal(aWindow[0].count, 2, 'A 的两条事件都必须被 count 认领');
    assert.equal(snapshot.events.filter((row) => row !== undefined).length >= 3, true);
    assertAlertEvidence(snapshot, '跨来源延后补记');
    assert.deepEqual(violations, []);
    assert.equal(pipeline.stats().contributions_pending, 0, '补记完成后队列必须清空');
  });
});
