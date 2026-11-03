import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  validateAnalysisRequest,
} from '../../packages/contracts/src/index.js';
import { expectCode, validAnalysisRequest } from './helpers.js';

function requestWith(summaryDto) {
  return validAnalysisRequest({ summary_dto: summaryDto });
}

test('D0 摘要 DTO 在显式 allowlist 下通过', () => {
  const record = validateAnalysisRequest(
    requestWith({ classification: 'D0', fields: { event_count: 12, host_name: 'wkstn-01' } }),
    { allowedSummaryFields: ['event_count', 'host_name'] },
  );
  assert.equal(record.schemaVersion, '1.0');
  assert.equal(record.digest, canonicalDigest(record.value));
  assert.deepStrictEqual(record.value.summary_dto, {
    classification: 'D0',
    fields: { event_count: 12, host_name: 'wkstn-01' },
  });
});

test('D1 分级被接受', () => {
  const record = validateAnalysisRequest(
    requestWith({ classification: 'D1', fields: { event_count: 3 } }),
    { allowedSummaryFields: ['event_count'] },
  );
  assert.equal(record.value.summary_dto.classification, 'D1');
});

test('D2 在默认分级集合下被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(requestWith({ classification: 'D2', fields: {} })),
    'ERR_CLASSIFICATION_NOT_EXPORTABLE',
    '$.summary_dto.classification',
  );
});

test('显式放开 D2 后可以出域', () => {
  const record = validateAnalysisRequest(
    requestWith({ classification: 'D2', fields: {} }),
    { allowClassification: ['D0', 'D1', 'D2'] },
  );
  assert.equal(record.value.summary_dto.classification, 'D2');
});

test('未知分级值报 ERR_FIELD_ENUM', () => {
  expectCode(
    () => validateAnalysisRequest(requestWith({ classification: 'D9', fields: {} })),
    'ERR_FIELD_ENUM',
    '$.summary_dto.classification',
  );
});

test('未授权的摘要字段被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(
      requestWith({ classification: 'D0', fields: { secret_path: 'C:/x' } }),
      { allowedSummaryFields: ['event_count'] },
    ),
    'ERR_SUMMARY_FIELD_NOT_ALLOWED',
    '$.summary_dto.fields.secret_path',
  );
});

test('不传 allowedSummaryFields 时默认拒绝一切字段', () => {
  expectCode(
    () => validateAnalysisRequest(requestWith({ classification: 'D0', fields: { event_count: 1 } })),
    'ERR_SUMMARY_FIELD_NOT_ALLOWED',
    '$.summary_dto.fields.event_count',
  );
});

test('摘要字段值出现嵌套对象被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(
      requestWith({ classification: 'D0', fields: { nested: { deep: 1 } } }),
      { allowedSummaryFields: ['nested'] },
    ),
    'ERR_FIELD_TYPE',
    '$.summary_dto.fields.nested',
  );
});

test('摘要字段整体超过 16 KiB 被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(
      requestWith({
        classification: 'D0',
        fields: { first: 'a'.repeat(9000), second: 'b'.repeat(9000) },
      }),
      { allowedSummaryFields: ['first', 'second'] },
    ),
    'ERR_OBJECT_TOO_LARGE',
    '$.summary_dto.fields',
  );
});

test('budget_class 含大写被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(validAnalysisRequest({ budget_class: 'Standard' })),
    'ERR_FIELD_PATTERN',
    '$.budget_class',
  );
});

test('idempotency_key 过短被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(validAnalysisRequest({ idempotency_key: 'short-88' })),
    'ERR_FIELD_PATTERN',
    '$.idempotency_key',
  );
});

test('epoch 不是 UUIDv4 被拒绝', () => {
  expectCode(
    () => validateAnalysisRequest(validAnalysisRequest({ epoch: 'epoch-1' })),
    'ERR_FIELD_PATTERN',
    '$.epoch',
  );
});

function buildSummaryFields(count) {
  const fields = {};
  const allowed = [];
  for (let index = 0; index < count; index += 1) {
    const key = `f${index}`;
    fields[key] = index;
    allowed.push(key);
  }
  return { fields, allowed };
}

test('摘要字段 128 个键被接受', () => {
  const { fields, allowed } = buildSummaryFields(128);
  const record = validateAnalysisRequest(
    requestWith({ classification: 'D0', fields }),
    { allowedSummaryFields: allowed },
  );
  assert.equal(Object.keys(record.value.summary_dto.fields).length, 128);
});

test('摘要字段 129 个键报 ERR_MAX_OBJECT_KEYS', () => {
  const { fields, allowed } = buildSummaryFields(129);
  expectCode(
    () => validateAnalysisRequest(
      requestWith({ classification: 'D0', fields }),
      { allowedSummaryFields: allowed },
    ),
    'ERR_MAX_OBJECT_KEYS',
    '$.summary_dto.fields',
  );
});

test('summary_dto 的必填字段同样不从原型链读取', () => {
  try {
    Object.defineProperty(Object.prototype, 'classification', {
      value: 'D0',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expectCode(
      () => validateAnalysisRequest(requestWith({ fields: {} }), { allowedSummaryFields: [] }),
      'ERR_MISSING_FIELD',
      '$.summary_dto.classification',
    );
  } finally {
    delete Object.prototype.classification;
  }
  assert.equal(({}).classification, undefined);
});

test('summary_dto.fields 带 Symbol 键被拒绝', () => {
  const fields = { event_count: 1 };
  fields[Symbol('hidden_field')] = 2;
  const error = expectCode(
    () => validateAnalysisRequest(
      requestWith({ classification: 'D0', fields }),
      { allowedSummaryFields: ['event_count'] },
    ),
    'ERR_UNKNOWN_FIELD',
    '$.summary_dto.fields',
  );
  assert.ok(Array.isArray(error.details.symbols));
  assert.ok(error.details.symbols.length > 0);
});

/*
 * fields 必须是普通对象：只判 typeof === 'object' 会放过类实例，
 * 而类实例可以把 normalize 之外的行为（getter / 原型方法）带进摘要通道。
 */
test('summary_dto.fields 为类实例被拒绝（不是普通对象）', () => {
  class Fields {
    constructor() {
      this.event_count = 1;
    }
  }
  const error = expectCode(
    () => validateAnalysisRequest(
      requestWith({ classification: 'D0', fields: new Fields() }),
      { allowedSummaryFields: ['event_count'] },
    ),
    'ERR_FIELD_TYPE',
    '$.summary_dto.fields',
  );
  assert.equal(error.code, 'ERR_FIELD_TYPE');
});

test('summary_dto.fields 为 Object.create(null) 被拒绝', () => {
  const fields = Object.create(null);
  fields.event_count = 1;
  expectCode(
    () => validateAnalysisRequest(
      requestWith({ classification: 'D0', fields }),
      { allowedSummaryFields: ['event_count'] },
    ),
    'ERR_FIELD_TYPE',
    '$.summary_dto.fields',
  );
  // 普通对象（含 JSON 往返产物）仍然通过，证明只拒绝了无原型对象。
  const record = validateAnalysisRequest(
    requestWith({ classification: 'D0', fields: JSON.parse('{"event_count":1}') }),
    { allowedSummaryFields: ['event_count'] },
  );
  assert.equal(record.value.summary_dto.fields.event_count, 1);
});
