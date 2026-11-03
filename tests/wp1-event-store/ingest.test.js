/**
 * T1 摄入事务。
 *
 * 关注点不是"函数返回值对不对"，而是：
 * - 同一稳定来源键只落一行（幂等），且重复提交**不产生**任何新副作用；
 * - 告警按 `(fingerprint, window_start)` 聚合，严重度取高、状态不回退；
 * - 事件、告警、outbox、审计是同一个事务，任一步失败就一个字节都不留。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { countEvents, getEvent, ingestTelemetry } from '../../packages/event-store/src/index.js';

import {
  canonicalDigest,
  expectContractError,
  expectStoreError,
  makeAlert,
  makeAnalysisRequest,
  makeEvent,
  makeFinding,
  openStore,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

const WINDOW = {
  window_start: '2026-11-01T00:00:00.000Z',
  window_end: '2026-11-01T00:15:00.000Z',
};

function ingest(store, overrides = {}) {
  return ingestTelemetry(store, {
    event: makeEvent(),
    now: '2026-11-01T00:00:02.000Z',
    ...overrides,
  });
}

test('首次摄入写入事件、告警、outbox 与一条审计', (t) => {
  const { store } = openTestStore(t);
  const alert = makeAlert(WINDOW);
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch() });

  const result = ingestTelemetry(store, {
    event: makeEvent(),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now: '2026-11-01T00:00:02.000Z',
  });

  assert.equal(result.duplicate, false);
  assert.equal(result.ingest_seq, 1);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].alert_id, alert.alert_id);
  assert.equal(result.analysis_id, analysis.analysis_id);
  assert.equal(countEvents(store), 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM alert').c), 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM analysis_outbox').c), 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c), 1);
});

test('同一 event_id 重复提交是幂等的：不新增行、不新增审计', (t) => {
  const { store } = openTestStore(t);
  const event = makeEvent({ native_record_id: '4688:1' });
  const first = ingestTelemetry(store, { event, now: '2026-11-01T00:00:02.000Z' });
  const before = Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c);

  const second = ingestTelemetry(store, { event, now: '2026-11-01T00:00:03.000Z' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event_id, first.event_id);
  assert.equal(second.ingest_seq, first.ingest_seq);
  assert.equal(second.audit_sequence, null);
  assert.equal(countEvents(store), 1);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c), before);
});

test('同稳定键不同 event_id 也按幂等处理（原生记录 ID 去重）', (t) => {
  const { store } = openTestStore(t);
  const first = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: '4688:7' }),
    now: '2026-11-01T00:00:02.000Z',
  });
  const second = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: '4688:7' }),
    now: '2026-11-01T00:00:03.000Z',
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.event_id, first.event_id);
  assert.equal(countEvents(store), 1);
});

test('source_generation 变化视为新事件（日志清空/ID 重用的唯一正确表达）', (t) => {
  const { store } = openTestStore(t);
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: '4688:7', source_generation: 1 }),
    now: '2026-11-01T00:00:02.000Z',
  });
  const second = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: '4688:7', source_generation: 2 }),
    now: '2026-11-01T00:00:03.000Z',
  });
  assert.equal(second.duplicate, false);
  assert.equal(countEvents(store), 2);
});

test('不同原生记录 ID、相同 source_seq 是两条事件', (t) => {
  const { store } = openTestStore(t);
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'a', source_seq: 100 }),
    now: '2026-11-01T00:00:02.000Z',
  });
  const second = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'b', source_seq: 100 }),
    now: '2026-11-01T00:00:03.000Z',
  });
  assert.equal(second.duplicate, false);
  assert.equal(countEvents(store), 2);
});

test('没有原生 ID 时按 source_seq 去重', (t) => {
  const { store } = openTestStore(t);
  ingestTelemetry(store, { event: makeEvent({ source_seq: 5 }), now: '2026-11-01T00:00:02.000Z' });
  const second = ingestTelemetry(store, { event: makeEvent({ source_seq: 5 }), now: '2026-11-01T00:00:03.000Z' });
  assert.equal(second.duplicate, true);
  assert.equal(countEvents(store), 1);
});

test('ingest_seq 单调递增且唯一', (t) => {
  const { store } = openTestStore(t);
  const seqs = [];
  for (let index = 0; index < 5; index += 1) {
    seqs.push(ingestTelemetry(store, {
      event: makeEvent({ native_record_id: `rec-${index}` }),
      now: '2026-11-01T00:00:02.000Z',
    }).ingest_seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

test('同 (fingerprint, window_start) 的告警合并为一行并累加计数', (t) => {
  const { store } = openTestStore(t);
  const fingerprint = sha256Hex('same-fp');
  const first = makeAlert({ ...WINDOW, fingerprint, event_ids: [uuid(), uuid()], count: 2 });
  const second = makeAlert({ ...WINDOW, fingerprint, event_ids: [uuid()], count: 1 });

  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'e1' }),
    alerts: [first],
    now: '2026-11-01T00:00:02.000Z',
  });
  const merged = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'e2' }),
    alerts: [second],
    now: '2026-11-01T00:00:03.000Z',
  });

  assert.equal(merged.alerts.length, 1);
  assert.equal(merged.alerts[0].alert_id, first.alert_id, 'window identity wins over incoming alert_id');
  assert.equal(merged.alerts[0].created, false);
  assert.equal(merged.alerts[0].count, 3);
  const row = store.get('SELECT * FROM alert WHERE alert_id = ?', [first.alert_id]);
  assert.equal(Number(row.count), 3);
  assert.equal(JSON.parse(String(row.event_ids_json)).length, 3);
});

test('合并时严重度取更高一方，状态保持既有，first/last_seen 取区间并集', (t) => {
  const { store } = openTestStore(t);
  const fingerprint = sha256Hex('severity-fp');
  const first = makeAlert({
    ...WINDOW,
    fingerprint,
    severity: 'medium',
    status: 'acknowledged',
    first_seen: '2026-11-01T00:00:00.000Z',
    last_seen: '2026-11-01T00:00:05.000Z',
  });
  const second = makeAlert({
    ...WINDOW,
    fingerprint,
    severity: 'critical',
    status: 'new',
    first_seen: '2026-11-01T00:00:03.000Z',
    last_seen: '2026-11-01T00:00:09.000Z',
  });

  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'x1' }), alerts: [first], now: '2026-11-01T00:00:10.000Z' });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'x2' }), alerts: [second], now: '2026-11-01T00:00:11.000Z' });

  const row = store.get('SELECT * FROM alert WHERE alert_id = ?', [first.alert_id]);
  assert.equal(String(row.severity), 'critical');
  assert.equal(String(row.status), 'acknowledged', 'acknowledged must not silently fall back to new');
  assert.equal(String(row.first_seen), '2026-11-01T00:00:00.000Z');
  assert.equal(String(row.last_seen), '2026-11-01T00:00:09.000Z');
});

test('不同窗口的同指纹告警是两行', (t) => {
  const { store } = openTestStore(t);
  const fingerprint = sha256Hex('window-fp');
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'w1' }),
    alerts: [makeAlert({ ...WINDOW, fingerprint })],
    now: '2026-11-01T00:00:10.000Z',
  });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'w2' }),
    alerts: [makeAlert({
      fingerprint,
      window_start: '2026-11-01T00:15:00.000Z',
      window_end: '2026-11-01T00:30:00.000Z',
      first_seen: '2026-11-01T00:15:00.000Z',
      last_seen: '2026-11-01T00:15:10.000Z',
    })],
    now: '2026-11-01T00:30:10.000Z',
  });
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM alert').c), 2);
});

test('event_ids 合并超过 256 条时截断并置 event_ids_truncated', (t) => {
  const { store } = openTestStore(t);
  const fingerprint = sha256Hex('cap-fp');
  const firstIds = Array.from({ length: 200 }, () => uuid());
  const secondIds = Array.from({ length: 200 }, () => uuid());
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'c1' }),
    alerts: [makeAlert({ ...WINDOW, fingerprint, event_ids: firstIds, count: 200 })],
    now: '2026-11-01T00:00:10.000Z',
  });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'c2' }),
    alerts: [makeAlert({ ...WINDOW, fingerprint, event_ids: secondIds, count: 200 })],
    now: '2026-11-01T00:00:11.000Z',
  });
  const row = store.get('SELECT * FROM alert WHERE fingerprint = ?', [fingerprint]);
  assert.equal(JSON.parse(String(row.event_ids_json)).length, 256);
  assert.equal(Number(row.count), 400);
  assert.equal(Number(row.event_ids_truncated), 1);
});

test('finding 以 finding_id 为键 upsert，计数与时间区间单调推进', (t) => {
  const { store } = openTestStore(t);
  const findingId = uuid();
  const eventIds = [uuid()];
  const first = makeFinding({ finding_id: findingId, event_ids: eventIds, count: 1 });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'f1' }),
    findings: [first],
    now: '2026-11-01T00:00:10.000Z',
  });
  const second = makeFinding({
    finding_id: findingId,
    event_ids: [uuid()],
    count: 1,
    last_seen: '2026-11-01T00:00:09.000Z',
  });
  const result = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'f2' }),
    findings: [second],
    now: '2026-11-01T00:00:11.000Z',
  });
  assert.equal(result.findings[0].created, false);
  const row = store.get('SELECT * FROM finding WHERE finding_id = ?', [findingId]);
  assert.equal(Number(row.count), 2);
  assert.equal(JSON.parse(String(row.event_ids_json)).length, 2);
});

test('analysis outbox 以 idempotency_key 去重，不产生第二条请求', (t) => {
  const { store } = openTestStore(t);
  const alert = makeAlert(WINDOW);
  const key = 'shared-idempotency-key-0001';
  const analysisA = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), idempotency_key: key });
  const analysisB = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), idempotency_key: key });

  const first = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'o1' }),
    alerts: [alert],
    analysisRequest: analysisA,
    allowedSummaryFields: ['process_name'],
    now: '2026-11-01T00:00:10.000Z',
  });
  const second = ingestTelemetry(store, {
    event: makeEvent({ native_record_id: 'o2' }),
    alerts: [alert],
    analysisRequest: analysisB,
    allowedSummaryFields: ['process_name'],
    now: '2026-11-01T00:00:11.000Z',
  });
  assert.equal(first.analysis_id, analysisA.analysis_id);
  assert.equal(second.analysis_id, analysisA.analysis_id);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM analysis_outbox').c), 1);
});

test('analysis 请求引用未知 alert 报 ERR_STORE_INPUT 并整体回滚', (t) => {
  const { store } = openTestStore(t);
  const analysis = makeAnalysisRequest({ alert_id: uuid(), epoch: store.epoch() });
  expectStoreError(
    () => ingestTelemetry(store, {
      event: makeEvent({ native_record_id: 'orphan' }),
      analysisRequest: analysis,
      allowedSummaryFields: ['process_name'],
      now: '2026-11-01T00:00:10.000Z',
    }),
    'ERR_STORE_INPUT',
  );
  assert.equal(countEvents(store), 0);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c), 0);
});

test('事件 DTO 非法（payload 摘要不符）时一个字节都不写', (t) => {
  const { store } = openTestStore(t);
  const event = makeEvent({ native_record_id: 'bad-digest' });
  event.integrity = { algorithm: 'sha256', digest: canonicalDigest({ tampered: true }) };
  expectContractError(
    () => ingestTelemetry(store, { event, now: '2026-11-01T00:00:10.000Z' }),
    'ERR_INTEGRITY_DIGEST_MISMATCH',
  );
  assert.equal(countEvents(store), 0);
});

test('summary 字段不在白名单时整批拒绝', (t) => {
  const { store } = openTestStore(t);
  const alert = makeAlert(WINDOW);
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch() });
  expectContractError(
    () => ingestTelemetry(store, {
      event: makeEvent({ native_record_id: 'allowlist' }),
      alerts: [alert],
      analysisRequest: analysis,
      allowedSummaryFields: [],
      now: '2026-11-01T00:00:10.000Z',
    }),
    'ERR_SUMMARY_FIELD_NOT_ALLOWED',
  );
  assert.equal(countEvents(store), 0);
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM alert').c), 0);
});

test('告警 DTO 非法时事件也不落库（T1 原子性）', (t) => {
  const { store } = openTestStore(t);
  // 故意绕过 makeAlert 的校验，直接造一个自相矛盾的 DTO：
  // count=1 却带 2 个 event_ids —— 合同层必须拒绝。
  const brokenAlert = {
    schemaVersion: '1.0',
    alert_id: uuid(),
    rule_id: 'proc_persist',
    rule_version: '1.0.0',
    fingerprint: sha256Hex('broken-fp'),
    severity: 'high',
    status: 'new',
    first_seen: WINDOW.window_start,
    last_seen: '2026-11-01T00:00:01.000Z',
    window_start: WINDOW.window_start,
    window_end: WINDOW.window_end,
    count: 1,
    event_ids: [uuid(), uuid()],
    event_ids_truncated: false,
    evidence_refs: [],
  };
  expectContractError(
    () => ingestTelemetry(store, {
      event: makeEvent({ native_record_id: 'atomic' }),
      alerts: [brokenAlert],
      now: '2026-11-01T00:00:10.000Z',
    }),
    'ERR_BINDING_MISMATCH',
  );
  assert.equal(countEvents(store), 0);
});

test('payload 与 canonical 列按规范化 JSON 落库，可原样取回', (t) => {
  const { store } = openTestStore(t);
  const payload = { process_name: 'demo.exe', pid: 4321 };
  const event = makeEvent({ native_record_id: 'payload', payload });
  ingestTelemetry(store, { event, now: '2026-11-01T00:00:10.000Z' });
  const row = getEvent(store, event.event_id);
  assert.deepEqual(JSON.parse(String(row.payload_json)), payload);
  assert.equal(String(row.payload_digest), canonicalDigest(payload));
});

test('只读库上调用 T1 被拒绝', (t) => {
  const { store, dir } = openTestStore(t);
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'ro' }), now: '2026-11-01T00:00:02.000Z' });
  store.close();
  const reader = openStore({ path: `${dir}/aegis-harness.db`, readOnly: true });
  t.after(() => reader.close());
  expectStoreError(
    () => ingestTelemetry(reader, { event: makeEvent({ native_record_id: 'ro2' }), now: '2026-11-01T00:00:03.000Z' }),
    'ERR_STORE_READ_ONLY',
  );
});
