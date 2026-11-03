import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseFinding,
  validateFinding,
} from '../../packages/contracts/src/index.js';
import {
  expectCode,
  HEX_A,
  UUID_B,
  UUID_C,
  validFinding,
} from './helpers.js';

test('Finding 合法样例通过：schemaVersion、64 位摘要与深冻结', () => {
  const record = validateFinding(validFinding());
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.event_ids));
  assert.ok(Object.isFrozen(record.value.evidence_refs));
  assert.equal(record.value.count, 3);
});

test('Finding 缺字段报 ERR_MISSING_FIELD', () => {
  const value = validFinding();
  delete value.rule_version;
  expectCode(() => validateFinding(value), 'ERR_MISSING_FIELD', '$.rule_version');
});

test('Finding 未知字段报 ERR_UNKNOWN_FIELD', () => {
  expectCode(
    () => validateFinding({ ...validFinding(), auto_approve: true }),
    'ERR_UNKNOWN_FIELD',
    '$.auto_approve',
  );
});

test('Finding 空原型对象报 ERR_INPUT_NOT_OBJECT', () => {
  const value = Object.assign(Object.create(null), validFinding());
  expectCode(() => validateFinding(value), 'ERR_INPUT_NOT_OBJECT', '$');
});

test('Finding 非枚举未知键报 ERR_UNKNOWN_FIELD', () => {
  const value = validFinding();
  Object.defineProperty(value, 'hidden_flag', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  expectCode(() => validateFinding(value), 'ERR_UNKNOWN_FIELD', '$.hidden_flag');
});

test('Finding 类型错报 ERR_FIELD_TYPE', () => {
  expectCode(() => validateFinding(validFinding({ count: '3' })), 'ERR_FIELD_TYPE', '$.count');
});

test('Finding severity 枚举越界报 ERR_FIELD_ENUM', () => {
  expectCode(() => validateFinding(validFinding({ severity: 'urgent' })), 'ERR_FIELD_ENUM', '$.severity');
});

test('Finding status 枚举越界报 ERR_FIELD_ENUM', () => {
  expectCode(() => validateFinding(validFinding({ status: 'closed' })), 'ERR_FIELD_ENUM', '$.status');
});

test('Finding rule_version 不是严格 semver 时报 ERR_FIELD_PATTERN', () => {
  for (const ruleVersion of ['1.0', '01.0.0', '1.0.0.0', 'v1.0.0']) {
    expectCode(() => validateFinding(validFinding({ rule_version: ruleVersion })), 'ERR_FIELD_PATTERN', '$.rule_version');
  }
});

test('Finding event_ids 空数组报 ERR_ARRAY_EMPTY', () => {
  expectCode(() => validateFinding(validFinding({ event_ids: [] })), 'ERR_ARRAY_EMPTY', '$.event_ids');
});

test('Finding event_ids 重复报 ERR_DUPLICATE_ARRAY_ELEMENT', () => {
  expectCode(
    () => validateFinding(validFinding({ event_ids: [UUID_B, UUID_B], count: 2 })),
    'ERR_DUPLICATE_ARRAY_ELEMENT',
    '$.event_ids[1]',
  );
});

test('Finding evidence_refs 不是不透明令牌时报 ERR_ARRAY_ELEMENT_TYPE', () => {
  expectCode(
    () => validateFinding(validFinding({ evidence_refs: ['short'] })),
    'ERR_ARRAY_ELEMENT_TYPE',
    '$.evidence_refs[0]',
  );
});

test('Finding first_seen 晚于 last_seen 报 ERR_TIMESTAMP_ORDER', () => {
  const error = expectCode(
    () => validateFinding(validFinding({ first_seen: '2026-01-01T00:10:00Z', last_seen: '2026-01-01T00:00:00Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.last_seen',
  );
  assert.equal(error.path, '$.last_seen');
});

test('Finding count 小于 event_ids 条数报 ERR_BINDING_MISMATCH', () => {
  const error = expectCode(
    () => validateFinding(validFinding({ event_ids: [UUID_B, UUID_C], count: 1 })),
    'ERR_BINDING_MISMATCH',
    '$.count',
  );
  assert.equal(error.details.count, 1);
  assert.equal(error.details.eventIds, 2);
});

test('Finding count 等于 event_ids 条数是合法边界（截断后不再多带）', () => {
  const record = validateFinding(validFinding({ event_ids: [UUID_B, UUID_C], count: 2 }));
  assert.equal(record.value.event_ids.length, 2);
  assert.equal(record.value.count, 2);
});

test('Finding event_ids 可被截断：count 大于条数仍然合法', () => {
  const record = validateFinding(validFinding({ count: 99 }));
  assert.equal(record.value.count, 99);
  assert.equal(record.value.event_ids.length, 1);
});

test('parseFinding 接受 JSON 文本与已解析对象，产出相同 digest', () => {
  const object = validFinding();
  const fromText = parseFinding(JSON.stringify(object));
  const fromBytes = parseFinding(new TextEncoder().encode(JSON.stringify(object)));
  const fromObject = parseFinding(object);
  assert.equal(fromText.digest, fromObject.digest);
  assert.equal(fromBytes.digest, fromObject.digest);
});

test('parseFinding 拒绝非法 JSON', () => {
  expectCode(() => parseFinding('{"schemaVersion":'), 'ERR_JSON_SYNTAX', '$');
});

test('Finding 摘要随内容变化，不依赖键序', () => {
  const base = validateFinding(validFinding()).digest;
  const reordered = validateFinding({ ...validFinding(), fingerprint: HEX_A }).digest;
  assert.equal(base, reordered);
  assert.notEqual(base, validateFinding(validFinding({ count: 4 })).digest);
});
