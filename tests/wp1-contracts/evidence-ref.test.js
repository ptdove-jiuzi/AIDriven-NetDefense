import assert from 'node:assert/strict';
import test from 'node:test';

import { LIMITS, parseEvidenceRef, validateEvidenceRef } from '../../packages/contracts/src/index.js';
import { expectCode, validEvidenceRef } from './helpers.js';

function uniqueFieldNames(count) {
  return Array.from({ length: count }, (_unused, index) => `field_${index}`);
}

test('EvidenceRef 合法样例通过：schemaVersion、64 位摘要与深冻结', () => {
  const record = validateEvidenceRef(validEvidenceRef());
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.allowed_fields));
  assert.equal(record.value.max_bytes, LIMITS.maxToolResultBytes);
});

test('EvidenceRef 缺字段报 ERR_MISSING_FIELD', () => {
  const value = validEvidenceRef();
  delete value.expires_at;
  expectCode(() => validateEvidenceRef(value), 'ERR_MISSING_FIELD', '$.expires_at');
});

test('EvidenceRef 未知字段报 ERR_UNKNOWN_FIELD', () => {
  expectCode(
    () => validateEvidenceRef({ ...validEvidenceRef(), raw_text: 'secret' }),
    'ERR_UNKNOWN_FIELD',
    '$.raw_text',
  );
});

test('EvidenceRef 空原型对象报 ERR_INPUT_NOT_OBJECT', () => {
  const value = Object.assign(Object.create(null), validEvidenceRef());
  expectCode(() => validateEvidenceRef(value), 'ERR_INPUT_NOT_OBJECT', '$');
});

test('EvidenceRef 非枚举未知键报 ERR_UNKNOWN_FIELD', () => {
  const value = validEvidenceRef();
  Object.defineProperty(value, 'allow_all', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  expectCode(() => validateEvidenceRef(value), 'ERR_UNKNOWN_FIELD', '$.allow_all');
});

test('EvidenceRef 类型错报 ERR_FIELD_TYPE', () => {
  expectCode(() => validateEvidenceRef(validEvidenceRef({ max_bytes: '65536' })), 'ERR_FIELD_TYPE', '$.max_bytes');
});

test('EvidenceRef allowed_fields 为空报 ERR_ARRAY_EMPTY', () => {
  expectCode(() => validateEvidenceRef(validEvidenceRef({ allowed_fields: [] })), 'ERR_ARRAY_EMPTY', '$.allowed_fields');
});

test('EvidenceRef allowed_fields 键名不符报 ERR_ARRAY_ELEMENT_TYPE', () => {
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ allowed_fields: ['Sequence'] })),
    'ERR_ARRAY_ELEMENT_TYPE',
    '$.allowed_fields[0]',
  );
});

test('EvidenceRef allowed_fields 重复报 ERR_DUPLICATE_ARRAY_ELEMENT', () => {
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ allowed_fields: ['severity_rank', 'severity_rank'] })),
    'ERR_DUPLICATE_ARRAY_ELEMENT',
    '$.allowed_fields[1]',
  );
});

test('EvidenceRef allowed_fields 超过 maxEvidenceFields 报 ERR_MAX_ARRAY_ITEMS', () => {
  const fields = uniqueFieldNames(LIMITS.maxEvidenceFields);
  assert.equal(validateEvidenceRef(validEvidenceRef({ allowed_fields: fields })).value.allowed_fields.length, fields.length);
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ allowed_fields: uniqueFieldNames(LIMITS.maxEvidenceFields + 1) })),
    'ERR_MAX_ARRAY_ITEMS',
    '$.allowed_fields',
  );
});

test('EvidenceRef max_bytes 越界报 ERR_INTEGER_RANGE', () => {
  expectCode(() => validateEvidenceRef(validEvidenceRef({ max_bytes: 0 })), 'ERR_INTEGER_RANGE', '$.max_bytes');
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ max_bytes: LIMITS.maxToolResultBytes + 1 })),
    'ERR_INTEGER_RANGE',
    '$.max_bytes',
  );
});

test('EvidenceRef evidence_id 不是高熵令牌时报 ERR_FIELD_PATTERN', () => {
  expectCode(() => validateEvidenceRef(validEvidenceRef({ evidence_id: 'short' })), 'ERR_FIELD_PATTERN', '$.evidence_id');
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ evidence_id: 'has space in the token 0123456' })),
    'ERR_FIELD_PATTERN',
    '$.evidence_id',
  );
});

test('EvidenceRef analysis_id / alert_id 只接受 UUIDv4', () => {
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ analysis_id: 'a'.repeat(32) })),
    'ERR_FIELD_PATTERN',
    '$.analysis_id',
  );
  expectCode(
    () => validateEvidenceRef(validEvidenceRef({ alert_id: 'a'.repeat(32) })),
    'ERR_FIELD_PATTERN',
    '$.alert_id',
  );
});

test('parseEvidenceRef 接受 JSON 文本与已解析对象，产出相同 digest', () => {
  const object = validEvidenceRef();
  assert.equal(parseEvidenceRef(JSON.stringify(object)).digest, parseEvidenceRef(object).digest);
});

test('parseEvidenceRef 拒绝非法 JSON', () => {
  expectCode(() => parseEvidenceRef('{"allowed_fields":'), 'ERR_JSON_SYNTAX', '$');
});
