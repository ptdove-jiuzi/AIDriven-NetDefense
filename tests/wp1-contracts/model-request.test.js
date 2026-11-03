import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIMITS,
  MODEL_REQUEST_STATES,
  parseModelRequest,
  validateModelRequest,
} from '../../packages/contracts/src/index.js';
import { expectCode, validModelRequest } from './helpers.js';

const USAGE = Object.freeze({ input_tokens: 1200, output_tokens: 240 });

test('ModelRequest 合法样例通过：schemaVersion、64 位摘要与深冻结', () => {
  const record = validateModelRequest(validModelRequest());
  assert.equal(record.schemaVersion, '1.0');
  assert.match(record.digest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(record.value));
  assert.equal(record.value.usage, undefined);
});

test('ModelRequest 状态词汇固定为 reserved / sent / settled / unknown / void', () => {
  assert.deepStrictEqual([...MODEL_REQUEST_STATES], ['reserved', 'sent', 'settled', 'unknown', 'void']);
});

test('ModelRequest settled 必须带 usage 且深冻结', () => {
  const record = validateModelRequest(validModelRequest({ state: 'settled', usage: { ...USAGE } }));
  assert.equal(record.value.state, 'settled');
  assert.equal(record.value.usage.input_tokens, 1200);
  assert.ok(Object.isFrozen(record.value.usage));
});

test('ModelRequest 缺字段报 ERR_MISSING_FIELD', () => {
  const value = validModelRequest();
  delete value.serialized_digest;
  expectCode(() => validateModelRequest(value), 'ERR_MISSING_FIELD', '$.serialized_digest');
});

test('ModelRequest 未知字段报 ERR_UNKNOWN_FIELD', () => {
  expectCode(
    () => validateModelRequest({ ...validModelRequest(), prompt: 'text' }),
    'ERR_UNKNOWN_FIELD',
    '$.prompt',
  );
});

test('ModelRequest 空原型对象报 ERR_INPUT_NOT_OBJECT', () => {
  const value = Object.assign(Object.create(null), validModelRequest());
  expectCode(() => validateModelRequest(value), 'ERR_INPUT_NOT_OBJECT', '$');
});

test('ModelRequest 非枚举未知键报 ERR_UNKNOWN_FIELD', () => {
  const value = validModelRequest();
  Object.defineProperty(value, 'billable', {
    value: false,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  expectCode(() => validateModelRequest(value), 'ERR_UNKNOWN_FIELD', '$.billable');
});

test('ModelRequest 类型错报 ERR_FIELD_TYPE', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ input_upper: '4096' })),
    'ERR_FIELD_TYPE',
    '$.input_upper',
  );
});

test('ModelRequest state 枚举越界报 ERR_FIELD_ENUM', () => {
  expectCode(() => validateModelRequest(validModelRequest({ state: 'pending' })), 'ERR_FIELD_ENUM', '$.state');
});

test('ModelRequest request_seq 超出 maxRequestIds 报 ERR_INTEGER_RANGE', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ request_seq: LIMITS.maxRequestIds + 1 })),
    'ERR_INTEGER_RANGE',
    '$.request_seq',
  );
  expectCode(
    () => validateModelRequest(validModelRequest({ request_seq: 0 })),
    'ERR_INTEGER_RANGE',
    '$.request_seq',
  );
});

test('ModelRequest input_upper 与 output_limit 都有硬上限', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ input_upper: LIMITS.maxInputUpperTokens + 1 })),
    'ERR_INTEGER_RANGE',
    '$.input_upper',
  );
  expectCode(
    () => validateModelRequest(validModelRequest({ output_limit: LIMITS.maxOutputLimitTokens + 1 })),
    'ERR_INTEGER_RANGE',
    '$.output_limit',
  );
});

test('ModelRequest reserved_at 必须是 RFC3339 UTC', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ reserved_at: '2026-01-01 00:00:00' })),
    'ERR_TIMESTAMP_FORMAT',
    '$.reserved_at',
  );
});

test('ModelRequest settled 缺 usage 报 ERR_USAGE_STATE_MISMATCH', () => {
  const error = expectCode(
    () => validateModelRequest(validModelRequest({ state: 'settled' })),
    'ERR_USAGE_STATE_MISMATCH',
    '$.usage',
  );
  assert.equal(error.code, 'ERR_USAGE_STATE_MISMATCH');
  assert.equal(error.path, '$.usage');
});

test('ModelRequest settled 且 usage 为 null 仍报 ERR_USAGE_STATE_MISMATCH', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ state: 'settled', usage: null })),
    'ERR_USAGE_STATE_MISMATCH',
    '$.usage',
  );
});

test('ModelRequest reserved 带 usage 报 ERR_USAGE_STATE_MISMATCH', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ state: 'reserved', usage: { ...USAGE } })),
    'ERR_USAGE_STATE_MISMATCH',
    '$.usage',
  );
});

test('ModelRequest void 带 usage 报 ERR_USAGE_STATE_MISMATCH', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ state: 'void', usage: { ...USAGE } })),
    'ERR_USAGE_STATE_MISMATCH',
    '$.usage',
  );
});

test('ModelRequest sent 与 unknown 允许带或不带 usage', () => {
  assert.equal(validateModelRequest(validModelRequest({ state: 'sent' })).value.usage, undefined);
  assert.equal(
    validateModelRequest(validModelRequest({ state: 'unknown', usage: { ...USAGE } })).value.usage.output_tokens,
    240,
  );
});

test('ModelRequest usage 两个计数都是必填', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ state: 'settled', usage: { input_tokens: 1 } })),
    'ERR_MISSING_FIELD',
    '$.usage.output_tokens',
  );
  expectCode(
    () => validateModelRequest(validModelRequest({ state: 'settled', usage: { output_tokens: 1 } })),
    'ERR_MISSING_FIELD',
    '$.usage.input_tokens',
  );
});

test('ModelRequest usage 计数不能为负', () => {
  expectCode(
    () => validateModelRequest(validModelRequest({ state: 'settled', usage: { input_tokens: -1, output_tokens: 1 } })),
    'ERR_INTEGER_RANGE',
    '$.usage.input_tokens',
  );
});

test('parseModelRequest 接受 JSON 文本与已解析对象，产出相同 digest', () => {
  const object = validModelRequest({ state: 'settled', usage: { ...USAGE } });
  assert.equal(parseModelRequest(JSON.stringify(object)).digest, parseModelRequest(object).digest);
});

test('parseModelRequest 拒绝非法 JSON', () => {
  expectCode(() => parseModelRequest('[1,2'), 'ERR_JSON_SYNTAX', '$');
});
