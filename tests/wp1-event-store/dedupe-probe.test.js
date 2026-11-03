/**
 * ADR-0006：稳定键只读存在性探测 `hasDedupeKeys` 的契约测试。
 *
 * 这组用例只测"接口本身"，不测 daemon：目的是把三条边界钉死——
 * 1. 判重语义与 T1 一致（同表同三列），因此"换 event_id 但同 source_seq"必须被认出；
 * 2. 只返回布尔，不泄露任何事件内容或可用于推断的计数；
 * 3. 只读、无副作用、错误信息不回显键值。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  countEvents,
  dedupeKeyOf,
  getEvent,
  hasDedupeKeys,
  ingestTelemetry,
  isDedupeKey,
  stableKeyOf,
} from '../../packages/event-store/src/index.js';
import { openStore } from '../../packages/event-store/src/db.js';

import { expectStoreError, makeAlert, makeEvent, openTestStore, sha256Hex } from './helpers.js';

const KIND_NATIVE = 'native';
const KIND_SEQ = 'seq';

function keyOf(event) {
  return stableKeyOf(event);
}

function countRows(store, table) {
  return Number(store.get(`SELECT COUNT(*) AS c FROM ${table}`).c);
}

test('dedupeKeyOf：优先原生记录 ID，缺省退回 source_seq', () => {
  assert.equal(dedupeKeyOf({ native_record_id: '4688-77', source_seq: 9 }), 'native:4688-77');
  assert.equal(dedupeKeyOf({ source_seq: 9 }), 'seq:9');
  // 空字符串不算"有原生 ID"——T1 的判据是长度 > 0，探测必须逐字一致。
  assert.equal(dedupeKeyOf({ native_record_id: '', source_seq: 9 }), 'seq:9');
  assert.ok(isDedupeKey('native:abc'));
  assert.ok(isDedupeKey('seq:0'));
  assert.ok(!isDedupeKey('native:'));
  assert.ok(!isDedupeKey('seq:-1'));
  assert.ok(!isDedupeKey('abc'));
  assert.ok(!isDedupeKey(9));
});

test('stableKeyOf 返回冻结的三元组，且不含其他字段', () => {
  const key = stableKeyOf({
    stable_source_id: 'windows.security.4688',
    source_generation: 2,
    native_record_id: 'x',
  });
  assert.equal(key.stable_source_id, 'windows.security.4688');
  assert.equal(key.source_generation, 2);
  assert.equal(key.dedupe_key, 'native:x');
  assert.deepEqual(Object.keys(key).sort(), ['dedupe_key', 'source_generation', 'stable_source_id']);
  assert.ok(Object.isFrozen(key), 'key must be frozen so a caller cannot mutate a batch mid-flight');
});

test('空输入返回空数组，且不发任何 SQL', (t) => {
  const { store } = openTestStore(t);
  let queries = 0;
  const originalGet = store.get.bind(store);
  store.get = (sql, params) => {
    queries += 1;
    return originalGet(sql, params);
  };
  const result = hasDedupeKeys(store, []);
  assert.deepEqual(result, []);
  assert.ok(Object.isFrozen(result));
  assert.equal(queries, 0, 'an empty probe must not open a connection round-trip');
  store.get = originalGet;
});

test('返回值等长同序，且只含布尔', (t) => {
  const { store } = openTestStore(t);
  const stored = makeEvent({ source_seq: 11, native_record_id: 'r-11' });
  const other = makeEvent({ source_seq: 12, native_record_id: 'r-12' });
  ingestTelemetry(store, { event: stored });

  const keys = [keyOf(stored), keyOf(other), keyOf(stored)];
  const result = hasDedupeKeys(store, keys);
  assert.equal(result.length, keys.length);
  assert.deepEqual([...result], [true, false, true]);
  for (const value of result) {
    assert.equal(typeof value, 'boolean');
  }
  // 深遍历：不允许是对象、数组、数字或字符串（数字也能侧面暴露"第几行"）。
  for (const value of result) {
    assert.ok(value === true || value === false);
  }
});

test('换 event_id 但稳定键相同 → 仍判定为"已存在"（M5 P1 的核心场景）', (t) => {
  const { store } = openTestStore(t);
  const first = makeEvent({ source_seq: 21, native_record_id: 'r-21' });
  ingestTelemetry(store, { event: first });

  const replay = makeEvent({ source_seq: 21, native_record_id: 'r-21' });
  assert.notEqual(replay.event_id, first.event_id, 'precondition: the replay carries a fresh event_id');

  // 旧实现只按 event_id 判断，这里会给 false，从而把重放事件放行给检测。
  assert.equal(store.get('SELECT 1 AS present FROM telemetry_event WHERE event_id = ?', [replay.event_id]), null);
  assert.deepEqual([...hasDedupeKeys(store, [keyOf(replay)])], [true]);
});

test('代次或来源不同 → 不是同一个稳定键', (t) => {
  const { store } = openTestStore(t);
  const stored = makeEvent({ source_seq: 31, source_generation: 1, stable_source_id: 'src.a' });
  ingestTelemetry(store, { event: stored });

  const nextGeneration = { ...stored, event_id: '11111111-1111-4111-8111-111111111111', source_generation: 2 };
  const otherSource = { ...stored, event_id: '22222222-2222-4222-8222-222222222222', stable_source_id: 'src.b' };
  const sameKey = { ...stored, event_id: '33333333-3333-4333-8333-333333333333' };

  const result = hasDedupeKeys(store, [keyOf(stored), keyOf(nextGeneration), keyOf(otherSource), keyOf(sameKey)]);
  assert.deepEqual([...result], [true, false, false, true]);
});

test('无原生 ID 时以 source_seq 判重，且 T1 的判定与探测一致', (t) => {
  const { store } = openTestStore(t);
  const first = makeEvent({ source_seq: 41 });
  ingestTelemetry(store, { event: first });

  const replay = makeEvent({ source_seq: 41 });
  assert.equal(dedupeKeyOf(replay).startsWith('seq:'), true, `expected ${KIND_SEQ} key`);

  // 探测说"已存在" → T1 也必须真判成重复，否则预过滤会丢真实新事件。
  assert.deepEqual([...hasDedupeKeys(store, [keyOf(replay)])], [true]);
  const result = ingestTelemetry(store, { event: replay });
  assert.equal(result.duplicate, true);
  assert.equal(countEvents(store), 1);
});

test('原生 ID 优先于 source_seq：同 seq 不同原生 ID 是两条事件', (t) => {
  const { store } = openTestStore(t);
  const first = makeEvent({ source_seq: 51, native_record_id: 'r-51-a' });
  ingestTelemetry(store, { event: first });

  const second = makeEvent({ source_seq: 51, native_record_id: 'r-51-b' });
  assert.equal(dedupeKeyOf(second).startsWith('native:'), true, `expected ${KIND_NATIVE} key`);
  assert.deepEqual([...hasDedupeKeys(store, [keyOf(second)])], [false]);
  assert.equal(ingestTelemetry(store, { event: second }).duplicate, false);
});

test('只读、无副作用：行数与审计链头都不变', (t) => {
  const { store } = openTestStore(t);
  ingestTelemetry(store, { event: makeEvent({ source_seq: 61, native_record_id: 'r-61' }) });
  const before = {
    events: countRows(store, 'telemetry_event'),
    audit: countRows(store, 'audit_event'),
    alerts: countRows(store, 'alert'),
  };

  const keys = [keyOf(makeEvent({ source_seq: 61, native_record_id: 'r-61' })), keyOf(makeEvent({ source_seq: 62 }))];
  for (let round = 0; round < 3; round += 1) {
    hasDedupeKeys(store, keys);
  }

  assert.equal(countRows(store, 'telemetry_event'), before.events);
  assert.equal(countRows(store, 'audit_event'), before.audit, 'a probe must never append an audit row');
  assert.equal(countRows(store, 'alert'), before.alerts);
});

test('只读句柄可调用（只读连接不参与写锁）', (t) => {
  const { store, dir } = openTestStore(t);
  const stored = makeEvent({ source_seq: 71, native_record_id: 'r-71' });
  ingestTelemetry(store, { event: stored });

  const reader = openStore({ path: path.join(dir, 'aegis-harness.db'), readOnly: true });
  t.after(() => {
    try {
      reader.close();
    } catch {
      // 用例里可能已经关过。
    }
  });
  assert.deepEqual([...hasDedupeKeys(reader, [keyOf(stored), keyOf(makeEvent({ source_seq: 72 }))])], [true, false]);
  // 只读句柄上写操作仍然被拒（证明我们没顺手放开写路径）。
  expectStoreError(() => reader.run('DELETE FROM telemetry_event'), 'ERR_STORE_READ_ONLY');
});

test('键形态非法 → ERR_STORE_INPUT，details 只报位置与字段', (t) => {
  const { store } = openTestStore(t);

  const missing = expectStoreError(() => hasDedupeKeys(store, [{}]), 'ERR_STORE_INPUT');
  assert.equal(missing.details.field, 'stable_source_id');
  assert.equal(missing.details.index, 'keys[0]');

  const badGeneration = expectStoreError(
    () => hasDedupeKeys(store, [{ stable_source_id: 's', source_generation: -1, dedupe_key: 'seq:1' }]),
    'ERR_STORE_INPUT',
  );
  assert.equal(badGeneration.details.field, 'source_generation');

  const badKey = expectStoreError(
    () => hasDedupeKeys(store, [{ stable_source_id: 's', source_generation: 1, dedupe_key: 'free text' }]),
    'ERR_STORE_INPUT',
  );
  assert.equal(badKey.details.field, 'dedupe_key');

  const notObject = expectStoreError(() => hasDedupeKeys(store, ['seq:1']), 'ERR_STORE_INPUT');
  assert.equal(notObject.details.field, 'key');

  const second = expectStoreError(
    () => hasDedupeKeys(store, [
      { stable_source_id: 's', source_generation: 1, dedupe_key: 'seq:1' },
      { stable_source_id: 's', source_generation: 1 },
    ]),
    'ERR_STORE_INPUT',
  );
  assert.equal(second.details.index, 'keys[1]', 'the reported index must point at the offending key');
});

test('错误信息与 details 不回显键值（避免把证据写进日志）', (t) => {
  const { store } = openTestStore(t);
  const secret = 'C:\\Users\\alice\\secret\\payload.bin';
  const error = expectStoreError(
    () => hasDedupeKeys(store, [{ stable_source_id: 's', source_generation: 1, dedupe_key: secret }]),
    'ERR_STORE_INPUT',
  );
  const serialized = JSON.stringify({ message: error.message, details: error.details ?? null });
  assert.equal(serialized.includes(secret), false, `key value leaked into the error: ${serialized}`);
  assert.equal(serialized.includes('alice'), false);
});

test('非数组 / 缺句柄 → ERR_STORE_INPUT', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(() => hasDedupeKeys(store, 'seq:1'), 'ERR_STORE_INPUT');
  expectStoreError(() => hasDedupeKeys(null, []), 'ERR_STORE_INPUT');
  expectStoreError(() => hasDedupeKeys({}, []), 'ERR_STORE_INPUT');
});

test('大批量（300 键，含重复与缺键）逐位正确', (t) => {
  const { store } = openTestStore(t);
  const storedKeys = [];
  for (let index = 0; index < 100; index += 1) {
    const event = makeEvent({ source_seq: 1000 + index, native_record_id: `bulk-${index}` });
    ingestTelemetry(store, { event });
    storedKeys.push(keyOf(event));
  }
  const absentKeys = [];
  for (let index = 0; index < 100; index += 1) {
    absentKeys.push(keyOf(makeEvent({ source_seq: 9000 + index, native_record_id: `absent-${index}` })));
  }
  const keys = [...storedKeys, ...absentKeys, ...storedKeys];
  const result = hasDedupeKeys(store, keys);
  assert.equal(result.length, 300);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(result[index], true, `stored key at ${index} must be present`);
    assert.equal(result[100 + index], false, `absent key at ${100 + index} must be absent`);
    assert.equal(result[200 + index], true, `duplicated stored key at ${200 + index} must be present`);
  }
});

test('探测命中的行确实可读回，且探测自身不改写它', (t) => {
  const { store } = openTestStore(t);
  const event = makeEvent({ source_seq: 81, native_record_id: 'r-81' });
  ingestTelemetry(store, { event });
  const before = getEvent(store, event.event_id);
  assert.deepEqual([...hasDedupeKeys(store, [keyOf(event)])], [true]);
  const after = getEvent(store, event.event_id);
  assert.equal(after.ingest_seq, before.ingest_seq);
  assert.equal(after.canonical_digest, before.canonical_digest);
});

test('告警行不影响稳定键判定（探测只读 telemetry_event）', (t) => {
  const { store } = openTestStore(t);
  const event = makeEvent({ source_seq: 91, native_record_id: 'r-91' });
  ingestTelemetry(store, {
    event,
    alerts: [makeAlert({ event_ids: [event.event_id], fingerprint: sha256Hex('fp-91') })],
  });
  assert.deepEqual([...hasDedupeKeys(store, [keyOf(event)])], [true]);
  assert.equal(countRows(store, 'alert'), 1);
  // 同稳定键的事件被探测命中后，调用方应跳过检测；这里只确认探测结果与 T1 一致。
  assert.equal(ingestTelemetry(store, { event: { ...event, event_id: '44444444-4444-4444-8444-444444444444' } }).duplicate, true);
  assert.equal(countRows(store, 'alert'), 1);
});
