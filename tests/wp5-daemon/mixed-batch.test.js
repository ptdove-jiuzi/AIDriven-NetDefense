/**
 * mixed-batch.test.js — ADR-0006 的跨包回归：**重放事件与新观测同批**。
 *
 * 这是 M5 P1 的原始复现场景，必须在**真实 SQLite 适配器**上验证，
 * 而不能只靠内存替身：判重键语义的差异正是"内存对、真库错"的那类问题。
 *
 * 三条不变量（每个用例都重复断言，因为它们是这条修复的全部意义）：
 * 1. `alert.count` 只增加**真实新观测**的数量；
 * 2. 告警 `event_ids` 里的每一个 id 都能在 `telemetry_event` 里查到（无悬空证据）；
 * 3. 重放不产生第二次分析请求投递。
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

/**
 * 起一套"真库 + 真检测引擎 + pipeline"，并返回一个只读句柄用来核对落库结果。
 *
 * @param {object} t node:test 上下文。
 * @returns {Promise<{store: object, pipeline: object, clock: object, read: () => object}>} 组件。
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
    detection: makeEngine(clock),
    createDetection: () => makeEngine(clock),
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

  return { store, pipeline, clock, read };
}

/**
 * 抓取"证据完整性"快照：事件行数、每个告警的计数与证据 id、outbox 条数。
 *
 * @param {object} handle 只读句柄。
 * @returns {{events: string[], alerts: object[], analyses: object[]}} 快照。
 */
function evidence(handle) {
  const events = handle.all('SELECT event_id FROM telemetry_event').map((row) => String(row.event_id));
  const alerts = handle.all(
    'SELECT alert_id, fingerprint, window_start, count, event_ids_json, event_ids_truncated FROM alert ORDER BY window_start',
  ).map((row) => ({
    alert_id: String(row.alert_id),
    fingerprint: String(row.fingerprint),
    count: Number(row.count),
    event_ids_truncated: Number(row.event_ids_truncated) === 1,
    event_ids: JSON.parse(String(row.event_ids_json)),
  }));
  const analyses = handle.all('SELECT analysis_id, alert_id, idempotency_key FROM analysis_outbox').map((row) => ({
    analysis_id: String(row.analysis_id),
    alert_id: String(row.alert_id),
    idempotency_key: String(row.idempotency_key),
  }));
  return { events, alerts, analyses };
}


/**
 * PERF-CPU N-034: a batched run must not bypass an injected store failure.
 *
 * The pipeline commits a run of alert-free events through `store.ingestBatch()`. These fixtures
 * inject failures by wrapping `store.ingest()`, so without this seam a batched write would skip the
 * injection and the test would quietly stop testing what it claims to. The seam mirrors the same
 * per-record decision into the batch entry point and commits the surviving records in ONE
 * transaction, which is exactly the production shape.
 *
 * @param {object} store Event store (real adapter).
 * @param {(request: object) => (Error|null)} decide Per-record decision; returns an error to inject.
 * @param {(request: object, value: object|undefined) => void} [onCommitted] Book-keeping for rows
 *   that the batch actually committed.
 * @returns {() => void} Restores the original batch entry point.
 */
function mirrorBatchSeam(store, decide, onCommitted) {
  const original = store.ingestBatch;
  const batch = typeof original === 'function' ? original.bind(store) : null;
  if (batch === null) {
    return () => {};
  }
  store.ingestBatch = (requests) => {
    const blocked = new Map();
    const allowed = [];
    requests.forEach((request, index) => {
      const error = decide(request);
      if (error !== null && error !== undefined) {
        blocked.set(index, error);
      } else {
        allowed.push(index);
      }
    });
    const out = allowed.length === 0
      ? { accepted: 0, duplicates: 0, failed: 0, results: [] }
      : batch(allowed.map((index) => requests[index]));
    const results = new Array(requests.length);
    allowed.forEach((originalIndex, position) => {
      results[originalIndex] = out.results[position];
      if (onCommitted !== undefined) {
        onCommitted(requests[originalIndex], out.results[position]?.value);
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
  return () => {
    store.ingestBatch = original;
  };
}

describe('ADR-0006 混合批次：重放事件 + 新观测', () => {
  it('alert.count 只增加真实新观测，且没有悬空 event id', async (t) => {
    const { pipeline, read } = await boot(t);

    const first = makeEvent({ source_seq: 1, observed_at: '2026-11-02T00:00:00.000Z' });
    const batch1 = pipeline.ingestBatch([first]);
    assert.equal(batch1.accepted, 1);
    assert.equal(pipeline.stats().analysis_requests, 1);

    // 同一 source_seq、全新 event_id 的重放 + 一条真实新观测，同批下发。
    // 修复前：预过滤按 event_id 放行重放，检测把它当新观测，T1 却一个字节都没写，
    // 于是 alert.count 变成 3、event_ids 里多出一个从未入库的 id。
    const replay = makeEvent({ source_seq: 1, observed_at: '2026-11-02T00:00:00.000Z' });
    const fresh = makeEvent({ source_seq: 2, observed_at: '2026-11-02T00:00:00.000Z' });
    const batch2 = pipeline.ingestBatch([replay, fresh]);

    assert.equal(batch2.duplicate, 1, '重放必须在预过滤阶段就被判成重复');
    assert.equal(batch2.accepted, 1, '只有真实新观测被写入');
    assert.equal(batch2.store_errors, 0);
    // 检测引擎只在告警**首次打开**时投递分析请求，所以整段只有 1 次；
    // 若重放被当成新告警，这里会变成 2（同一幂等键会被吸收，但请求已经投递过）。
    assert.equal(pipeline.stats().analysis_requests, 1, '重放不得再投递一次分析请求');

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 2, '入库事件只有两条');
    assert.equal(snapshot.alerts.length, 1, '一个指纹一个窗口一行');
    assert.equal(snapshot.alerts[0].count, snapshot.events.length, 'count 必须等于真实入库观测数');
    assert.equal(snapshot.alerts[0].count, 2);

    const stored = new Set(snapshot.events);
    for (const id of snapshot.alerts[0].event_ids) {
      assert.ok(stored.has(id), `event_ids 里的 ${id} 必须能在事件表里查到`);
    }
    assert.equal(stored.has(replay.event_id), false, '重放的 event_id 不属于任何已入库行');
    assert.equal(snapshot.alerts[0].event_ids.includes(replay.event_id), false, '悬空证据必须被拦下');
    assert.equal(snapshot.analyses.length, 1, '同一告警同一小时的请求被幂等键吸收');
  });

  it('批内全是重放：不写任何行，也不新增分析请求', async (t) => {
    const { pipeline, read } = await boot(t);

    pipeline.ingestBatch([makeEvent({ source_seq: 7 })]);
    const before = evidence(read());
    const requestsBefore = pipeline.stats().analysis_requests;

    const summary = pipeline.ingestBatch([
      makeEvent({ source_seq: 7 }),
      makeEvent({ source_seq: 7, native_record_id: undefined }),
    ]);
    assert.equal(summary.duplicate, 2);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.store_errors, 0);
    assert.equal(pipeline.stats().analysis_requests, requestsBefore);

    const after = evidence(read());
    assert.deepEqual(after.events, before.events);
    assert.deepEqual(after.alerts.map((alert) => alert.count), before.alerts.map((alert) => alert.count));
    assert.equal(after.analyses.length, before.analyses.length);
  });

  it('代次递增后同一 source_seq 是另一条事件（不能把清空的日志静默合并）', async (t) => {
    const { pipeline, read } = await boot(t);

    pipeline.ingestBatch([makeEvent({ source_seq: 9, source_generation: 1 })]);
    const summary = pipeline.ingestBatch([makeEvent({ source_seq: 9, source_generation: 2 })]);
    assert.equal(summary.accepted, 1, '代次变化必须被当作新事件');
    assert.equal(summary.duplicate, 0);

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.alerts[0].count, 2, '两个代次各贡献一次观测');
  });
});

describe('第 6 轮 P1 回归：跨批保留与批内同键', () => {
  it('保留贡献的证据无法核实时，不写出悬空 event_id', async (t) => {
    const { store, pipeline, read } = await boot(t);

    const original = store.ingest.bind(store);
    let calls = 0;
    const decide = () => {
      calls += 1;
      return calls === 1 ? new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure') : null;
    };
    store.ingest = (request) => {
      const error = decide();
      if (error !== null) {
        throw error;
      }
      return original(request);
    };
    const restoreBatch = mirrorBatchSeam(store, decide);

    const failed = makeEvent({ source_seq: 41 });
    const first = pipeline.ingestBatch([failed]);
    assert.equal(first.store_errors, 1);
    assert.equal(pipeline.stats().contributions_pending, 1, '失败的那条告警贡献被保留');

    store.ingest = original;
    // 下一批是**另一条**事件，失败事件没有重投：它的 id 永远不会入库。
    const second = pipeline.ingestBatch([makeEvent({ source_seq: 42 })]);
    assert.equal(second.store_errors, 0);

    const snapshot = evidence(read());
    const stored = new Set(snapshot.events);
    assert.equal(stored.has(failed.event_id), false, '失败事件的 event 行不存在');
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 1, 'count 只能统计有事件行的观测');
    assert.equal(snapshot.alerts[0].count, snapshot.events.length);
    assert.equal(snapshot.alerts[0].event_ids.includes(failed.event_id), false, '不得引用从未入库的 id');
    for (const id of snapshot.alerts[0].event_ids) {
      assert.ok(stored.has(id), `event_ids 里的 ${id} 必须能在事件表里查到`);
    }
    assert.equal(snapshot.alerts[0].event_ids_truncated, false);
  });

  it('批内两条同稳定键事件不会毒化后续批次', async (t) => {
    const { pipeline, read } = await boot(t);

    // 同一 source_seq、不同 event_id：T1 会判后者为重复，所以预过滤就该拦下它，
    // 否则重复的 id 会进到告警证据里，让之后每一次 attach 都因重复元素整笔失败。
    const first = pipeline.ingestBatch([
      makeEvent({ source_seq: 51 }),
      makeEvent({ source_seq: 51 }),
    ]);
    assert.equal(first.duplicate, 1, '第二条同键事件在预过滤阶段被拦下');
    assert.equal(first.accepted, 1);
    assert.equal(first.store_errors, 0);
    // 关键：重复的那条根本没进检测引擎（否则它会被算成一次新观测）。
    assert.equal(pipeline.stats().detection.events, 1, '重复事件不得进入检测');

    for (let index = 0; index < 3; index += 1) {
      const summary = pipeline.ingestBatch([makeEvent({ source_seq: 60 + index })]);
      assert.equal(summary.store_errors, 0, `第 ${index + 1} 个后续批次必须能正常写入`);
      assert.equal(summary.accepted, 1);
    }

    const snapshot = evidence(read());
    const stored = new Set(snapshot.events);
    assert.equal(snapshot.events.length, 4);
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 4);
    assert.equal(new Set(snapshot.alerts[0].event_ids).size, snapshot.alerts[0].event_ids.length, '证据 id 不得重复');
    for (const id of snapshot.alerts[0].event_ids) {
      assert.ok(stored.has(id));
    }
    assert.equal(pipeline.stats().contributions_dropped, 0, '不得靠丢弃来恢复');
  });
});

describe('ADR-0006 事务失败：不留半批状态', () => {
  it('第一条写入失败后，库里只有第二条的完整状态', async (t) => {
    const { store, pipeline, read } = await boot(t);

    const original = store.ingest.bind(store);
    let calls = 0;
    const decide = () => {
      calls += 1;
      return calls === 1 ? new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure') : null;
    };
    store.ingest = (request) => {
      const error = decide();
      if (error !== null) {
        throw error;
      }
      return original(request);
    };
    const restoreBatch = mirrorBatchSeam(store, decide);

    const summary = pipeline.ingestBatch([
      makeEvent({ source_seq: 11, observed_at: '2026-11-02T00:00:00.000Z' }),
      makeEvent({ source_seq: 12, observed_at: '2026-11-02T00:00:00.000Z' }),
    ]);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.dropped, 1);
    assert.equal(summary.store_errors, 1, '失败要如实计数，不能吞掉');
    assert.equal(pipeline.stats().store_errors_consecutive, 1);

    const snapshot = evidence(read());
    // 半批的核心含义：写入成功的那一条自成完整事务，失败那条一个副作用都没有。
    assert.equal(snapshot.events.length, 1, '失败事件的 event 行不得存在');
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].count, 1, '失败的观测不得先计进 count');
    assert.equal(snapshot.alerts[0].count, snapshot.events.length, 'count 必须等于真实入库观测数');
    const stored = new Set(snapshot.events);
    for (const id of snapshot.alerts[0].event_ids) {
      assert.ok(stored.has(id), '成功事务的证据 id 必须都能查到');
    }
    // 没有 outbox 行指向不存在的告警，也没有指向失败事件的请求。
    for (const analysis of snapshot.analyses) {
      assert.ok(
        snapshot.alerts.some((alert) => alert.alert_id === analysis.alert_id),
        'outbox 不得指向不存在的告警',
      );
    }
    assert.equal(snapshot.analyses.length, 1);
    // 被剥离的观测改为**延后补记**：失败事件的 finding 没有告警贡献可保留（保留队列只收
    // 告警与请求），但它的观测已经从第二条的告警里被扣掉了。若就此作罢，等这条事件重试
    // 成功时，库里会有 2 条事件而 count 永远停在 1 —— 证据可查、行却不认。
    // 所以剥离时额外保留一份"只有这一条证据"的告警贡献，等它自己的事件重新入库时补回。
    assert.equal(pipeline.stats().contributions_pending, 1, '被剥离的观测必须留一份延后补记的贡献');
  });

  it('锚点事件写入失败时，贡献被保留并计入 pending（不是静默消失）', async (t) => {
    const { store, pipeline, read } = await boot(t);

    const original = store.ingest.bind(store);
    let calls = 0;
    const decide = () => {
      calls += 1;
      return calls === 2 ? new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure') : null;
    };
    store.ingest = (request) => {
      const error = decide();
      if (error !== null) {
        throw error;
      }
      return original(request);
    };
    mirrorBatchSeam(store, decide);

    const summary = pipeline.ingestBatch([
      makeEvent({ source_seq: 31, observed_at: '2026-11-02T00:00:00.000Z' }),
      makeEvent({ source_seq: 32, observed_at: '2026-11-02T00:00:00.000Z' }),
    ]);
    assert.equal(summary.accepted, 1);
    assert.equal(summary.store_errors, 1);

    const snapshot = evidence(read());
    // 告警骑在最后一个锚点事件上，锚点失败 → 一行都没有，而不是半行。
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.alerts.length, 0, '不得留下半条告警行');
    assert.equal(snapshot.analyses.length, 0, '不得留下指向不存在告警的 outbox 行');
    assert.equal(pipeline.stats().contributions_pending, 1, '告警贡献必须被保留待补');
  });

  it('预过滤读失败时整批都不写（不猜"不存在"）', async (t) => {
    const { store, pipeline, read } = await boot(t);

    store.hasStableKeys = () => {
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'probe unavailable');
    };
    const summary = pipeline.ingestBatch([makeEvent({ source_seq: 21 }), makeEvent({ source_seq: 22 })]);
    assert.equal(summary.store_errors, 1);
    assert.equal(summary.accepted, 0);
    assert.equal(summary.dropped, 2, '整批按未验证处理');
    assert.equal(pipeline.stats().store_errors_consecutive, 1);

    const snapshot = evidence(read());
    assert.equal(snapshot.events.length, 0);
    assert.equal(snapshot.alerts.length, 0);
    assert.equal(snapshot.analyses.length, 0);
  });
});


describe('第 7 轮 P1 回归：锚点不得早于它引用的证据', () => {
  /**
   * 复现第 7 轮 P1-3：一批里产生 ≥2 条告警贡献（这里是两个聚合窗口），两条写入都失败 →
   * 两份保留贡献；调度器原样重放同一批，重放中后位事件再次失败。
   *
   * 旧实现用"逆序轮转"分配锚点，会把 W1 的告警挂到 eB 上、把 W2 的告警挂到 eA 上：
   * eA 那次 T1 于是提交了一行"证据指向 eB"的告警，而 eB 随后写入失败 ——
   * W2 窗口里一条事件行都没有，告警却宣称 count=1、truncated=false。
   */
  it('两条保留贡献跨窗口时，重放失败的证据不得被写成悬空 id', async (t) => {
    const { store, pipeline, read } = await boot(t);

    const written = new Set();
    const violations = [];
    const failIds = new Set();
    const original = store.ingest.bind(store);
    store.ingest = (request) => {
      // 一次 T1 只先写自己的事件、再写告警：告警能引用的 id 只能是"已写成功的"与"本次这条"。
      for (const alert of request.alerts ?? []) {
        for (const id of alert.event_ids ?? []) {
          if (id !== request.event.event_id && !written.has(id)) {
            violations.push({ cited: id, anchor: request.event.event_id });
          }
        }
      }
      if (failIds.has(request.event.event_id)) {
        throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure');
      }
      const out = original(request);
      if (out.duplicate !== true) {
        written.add(request.event.event_id);
      }
      return out;
    };

    const early = makeEvent({
      source_seq: 201,
      observed_at: '2026-11-02T00:05:00.000Z',
      received_at: '2026-11-02T00:05:01.000Z',
    });
    const late = makeEvent({
      source_seq: 202,
      observed_at: '2026-11-02T00:20:00.000Z',
      received_at: '2026-11-02T00:20:01.000Z',
    });

    // 第 1 批：两条都写失败 → 两份保留贡献（各属一个 15 分钟窗口）。
    failIds.add(early.event_id);
    failIds.add(late.event_id);
    const first = pipeline.ingestBatch([early, late]);
    assert.equal(first.store_errors, 2);
    assert.equal(pipeline.stats().contributions_pending, 2, '两条告警贡献都被保留');

    // 第 2 批：同一批原样重放（游标不推进时就是这样），且后位事件再次失败。
    failIds.clear();
    failIds.add(late.event_id);
    pipeline.ingestBatch([early, late]);
    failIds.clear();

    assert.deepEqual(violations, [], '告警不得引用在它之后才写入、或永远不入库的事件');

    const snapshot = evidence(read());
    const stored = new Set(snapshot.events);
    assert.equal(stored.has(late.event_id), false, '后位事件确实没有入库');
    for (const alert of snapshot.alerts) {
      for (const id of alert.event_ids) {
        assert.ok(stored.has(id), `event_ids 里的 ${id} 必须能在事件表里查到`);
      }
      assert.equal(
        alert.event_ids_truncated,
        alert.count > alert.event_ids.length,
        'truncated 必须当且仅当 count 大于证据条数',
      );
    }
  });
});

describe('第 8 轮 P1 回归：写入顺序与观测顺序不一致', () => {
  /**
   * 第 8 轮 P1-4：`buildWritePlan` 曾按 `observed_at` 挑锚点，而 `ingestBatch` 按数组下标写。
   * 批内乱序（迟到记录、采集器时钟偏移）时，锚点可能排在它所引用事件**之前**；
   * 后面那条写失败，已提交的告警行就永久悬空。
   */
  it('批内乱序且后位写入失败时，告警不得引用更晚写入的事件', async (t) => {
    const { store, pipeline, read } = await boot(t);

    const written = new Set();
    const violations = [];
    const original = store.ingest.bind(store);
    let calls = 0;
    const decide = (request) => {
      for (const alert of request.alerts ?? []) {
        for (const id of alert.event_ids ?? []) {
          if (id !== request.event.event_id && !written.has(id)) {
            violations.push({ cited: id, anchor: request.event.event_id });
          }
        }
      }
      calls += 1;
      return calls === 2 ? new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected write failure') : null;
    };
    store.ingest = (request) => {
      const error = decide(request);
      if (error !== null) {
        throw error;
      }
      const out = original(request);
      if (out.duplicate !== true) {
        written.add(request.event.event_id);
      }
      return out;
    };
    mirrorBatchSeam(store, decide, (request, value) => {
      if (value !== undefined && value.duplicate !== true) {
        written.add(request.event.event_id);
      }
    });

    // 数组顺序与观测时间顺序相反，但同属一个 15 分钟窗口。
    const later = makeEvent({
      source_seq: 301,
      observed_at: '2026-11-02T00:05:00.000Z',
      received_at: '2026-11-02T00:05:01.000Z',
    });
    const earlier = makeEvent({
      source_seq: 302,
      observed_at: '2026-11-02T00:00:30.000Z',
      received_at: '2026-11-02T00:00:31.000Z',
    });

    const summary = pipeline.ingestBatch([later, earlier]);
    assert.equal(summary.store_errors, 1);

    assert.deepEqual(violations, [], '锚点必须取"被引用事件在本批的最大下标"');
    const snapshot = evidence(read());
    const stored = new Set(snapshot.events);
    for (const alert of snapshot.alerts) {
      for (const id of alert.event_ids) {
        assert.ok(stored.has(id), `event_ids 里的 ${id} 必须能在事件表里查到`);
      }
      assert.equal(alert.event_ids_truncated, alert.count > alert.event_ids.length);
    }
  });

  it('一条合同外事件不会让整批退回 event_id 判定', async (t) => {
    const { store } = await boot(t);

    const storedEvent = makeEvent({ source_seq: 311 });
    store.ingest({ event: storedEvent });

    const replay = makeEvent({ source_seq: 311 });
    assert.notEqual(replay.event_id, storedEvent.event_id);
    const broken = { ...makeEvent({ source_seq: 312 }), source_generation: undefined };

    const flags = store.hasStableKeys([replay, broken]);
    assert.equal(flags[0], true, '合法事件仍按稳定键判定（不得整批退回 event_id）');
    assert.equal(flags[1], false, '坏事件报"未知"，交给 T1 单独拒绝');
  });
});
