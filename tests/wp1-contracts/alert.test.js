import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALERT_STATUSES,
  parseAlert,
  validateAlert,
} from '../../packages/contracts/src/index.js';
import {
  expectCode,
  UUID_C,
  UUID_D,
  validAlert,
} from './helpers.js';

test('Alert 合法样例通过：schemaVersion、64 位摘要与深冻结', () => {
  const record = validateAlert(validAlert());
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.event_ids));
});

test('Alert 状态词汇固定为 new / acknowledged / resolved / suppressed', () => {
  assert.deepStrictEqual([...ALERT_STATUSES], ['new', 'acknowledged', 'resolved', 'suppressed']);
  for (const status of ALERT_STATUSES) {
    assert.equal(validateAlert(validAlert({ status })).value.status, status);
  }
});

test('Alert 缺字段报 ERR_MISSING_FIELD', () => {
  const value = validAlert();
  delete value.window_start;
  expectCode(() => validateAlert(value), 'ERR_MISSING_FIELD', '$.window_start');
});

test('Alert 未知字段报 ERR_UNKNOWN_FIELD', () => {
  expectCode(() => validateAlert({ ...validAlert(), sequence_in_hour: 1 }), 'ERR_UNKNOWN_FIELD', '$.sequence_in_hour');
});

test('Alert 空原型对象报 ERR_INPUT_NOT_OBJECT', () => {
  const value = Object.assign(Object.create(null), validAlert());
  expectCode(() => validateAlert(value), 'ERR_INPUT_NOT_OBJECT', '$');
});

test('Alert 非枚举未知键报 ERR_UNKNOWN_FIELD', () => {
  const value = validAlert();
  Object.defineProperty(value, 'auto_resolve', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  expectCode(() => validateAlert(value), 'ERR_UNKNOWN_FIELD', '$.auto_resolve');
});

test('Alert 带 Symbol 键报 ERR_UNKNOWN_FIELD', () => {
  const value = validAlert();
  value[Symbol('hidden')] = 1;
  expectCode(() => validateAlert(value), 'ERR_UNKNOWN_FIELD', '$');
});

test('Alert 类型错报 ERR_FIELD_TYPE', () => {
  expectCode(() => validateAlert(validAlert({ event_ids_truncated: 'false' })), 'ERR_FIELD_TYPE', '$.event_ids_truncated');
});

test('Alert status 枚举越界报 ERR_FIELD_ENUM', () => {
  expectCode(() => validateAlert(validAlert({ status: 'closed' })), 'ERR_FIELD_ENUM', '$.status');
});

test('Alert rule_version 不是严格 semver 时报 ERR_FIELD_PATTERN', () => {
  expectCode(() => validateAlert(validAlert({ rule_version: '1.0' })), 'ERR_FIELD_PATTERN', '$.rule_version');
});

test('Alert window_start 晚于 window_end 报 ERR_TIMESTAMP_ORDER', () => {
  expectCode(
    () => validateAlert(validAlert({ window_start: '2026-01-01T00:16:00Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.window_end',
  );
});

test('Alert first_seen 晚于 last_seen 报 ERR_TIMESTAMP_ORDER', () => {
  expectCode(
    () => validateAlert(validAlert({ first_seen: '2026-01-01T00:10:00Z', last_seen: '2026-01-01T00:01:00Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.last_seen',
  );
});

test('Alert first_seen 早于窗口起点报 ERR_TIMESTAMP_ORDER', () => {
  expectCode(
    () => validateAlert(validAlert({ first_seen: '2025-12-31T23:59:59Z', window_start: '2026-01-01T00:00:00Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.first_seen',
  );
});

test('Alert last_seen 晚于窗口终点报 ERR_TIMESTAMP_ORDER', () => {
  expectCode(
    () => validateAlert(validAlert({ last_seen: '2026-01-01T00:15:01Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.last_seen',
  );
});

test('Alert count 小于 event_ids 条数报 ERR_BINDING_MISMATCH', () => {
  const error = expectCode(
    () => validateAlert(validAlert({ event_ids: [UUID_C, UUID_D], count: 1 })),
    'ERR_BINDING_MISMATCH',
    '$.count',
  );
  assert.equal(error.details.count, 1);
  assert.equal(error.details.eventIds, 2);
});

test('Alert 声称截断却没有丢条目时报 ERR_BINDING_MISMATCH', () => {
  const error = expectCode(
    () => validateAlert(validAlert({ event_ids_truncated: true, count: 1 })),
    'ERR_BINDING_MISMATCH',
    '$.event_ids_truncated',
  );
  assert.equal(error.path, '$.event_ids_truncated');
});

test('Alert 截断为真且 count 大于条数时合法', () => {
  const record = validateAlert(validAlert({ event_ids_truncated: true, count: 40 }));
  assert.equal(record.value.event_ids_truncated, true);
  assert.equal(record.value.count, 40);
});

test('Alert 未截断但 count 大于条数同样合法（capped 之前的历史计数）', () => {
  const record = validateAlert(validAlert({ event_ids_truncated: false, count: 7 }));
  assert.equal(record.value.count, 7);
});

test('parseAlert 接受 JSON 文本与已解析对象，产出相同 digest', () => {
  const object = validAlert();
  const fromText = parseAlert(JSON.stringify(object));
  const fromObject = parseAlert(object);
  assert.equal(fromText.digest, fromObject.digest);
  assert.equal(fromText.value.window_start, object.window_start);
});

test('parseAlert 拒绝非法 JSON', () => {
  expectCode(() => parseAlert('not json'), 'ERR_JSON_SYNTAX', '$');
});

test('Alert 的 upsert 键 (fingerprint, window_start) 全部在 DTO 内可读', () => {
  const value = validateAlert(validAlert()).value;
  assert.equal(typeof value.fingerprint, 'string');
  assert.equal(value.window_start, '2026-01-01T00:00:00Z');
});
