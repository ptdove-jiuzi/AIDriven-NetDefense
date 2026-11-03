import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  validateAnalysisReport,
} from '../../packages/contracts/src/index.js';
import { expectCode, UUID_A, UUID_B, UUID_C, UUID_D, validAnalysisReport } from './helpers.js';

test('合法分析报告通过且结果冻结', () => {
  const record = validateAnalysisReport(validAnalysisReport());
  assert.equal(record.schemaVersion, '1.0');
  assert.equal(record.digest, canonicalDigest(record.value));
  assert.ok(Object.isFrozen(record.value));
  assert.ok(Object.isFrozen(record.value.model_meta));
});

test('confidence 超出 [0,1] 报 ERR_NUMBER_RANGE', () => {
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ confidence: 1.5 })),
    'ERR_NUMBER_RANGE',
    '$.confidence',
  );
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ confidence: -0.1 })),
    'ERR_NUMBER_RANGE',
    '$.confidence',
  );
});

test('confidence 为字符串报 ERR_FIELD_TYPE', () => {
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ confidence: '0.5' })),
    'ERR_FIELD_TYPE',
    '$.confidence',
  );
});

test('evidence_ids 重复被拒绝', () => {
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ evidence_ids: [UUID_A, UUID_A] })),
    'ERR_DUPLICATE_ARRAY_ELEMENT',
    '$.evidence_ids[1]',
  );
});

test('model_meta.request_ids 超过 3 项被拒绝', () => {
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({
      model_meta: {
        provider_id: 'provider.local',
        model_id: 'model.small.v1',
        request_ids: [UUID_A, UUID_B, UUID_C, UUID_D],
      },
    })),
    'ERR_MAX_ARRAY_ITEMS',
    '$.model_meta.request_ids',
  );
});

test('evidence_ids 元素不是 UUIDv4 报 ERR_ARRAY_ELEMENT_TYPE', () => {
  const error = expectCode(
    () => validateAnalysisReport(validAnalysisReport({ evidence_ids: ['not-a-uuid'] })),
    'ERR_ARRAY_ELEMENT_TYPE',
    '$.evidence_ids[0]',
  );
  assert.equal(error.path, '$.evidence_ids[0]');
  assert.equal(error.details.cause, 'ERR_FIELD_PATTERN');
});

test('report 的 limitations 元素类型错误也折叠为 ERR_ARRAY_ELEMENT_TYPE', () => {
  const error = expectCode(
    () => validateAnalysisReport(validAnalysisReport({ limitations: ['ok', 42] })),
    'ERR_ARRAY_ELEMENT_TYPE',
    '$.limitations[1]',
  );
  assert.equal(error.details.cause, 'ERR_FIELD_TYPE');
});

test('证据与限制字段的结构性错误保持原始错误码', () => {
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ limitations: ['a\u0001b'] })),
    'ERR_STRING_CONTROL_CHARACTER',
    '$.limitations[0]',
  );
});

test('数组元素错误折叠后 message 带上原始错误码，不再笼统写成"不是合法 string"', () => {
  const error = expectCode(
    () => validateAnalysisReport(validAnalysisReport({ evidence_ids: ['not-a-uuid'] })),
    'ERR_ARRAY_ELEMENT_TYPE',
    '$.evidence_ids[0]',
  );
  assert.equal(error.details.cause, 'ERR_FIELD_PATTERN');
  assert.ok(
    error.message.includes('ERR_FIELD_PATTERN'),
    `message 应包含原始错误码，实际 "${error.message}"`,
  );
  // 原始 details 整体并入 causeDetails（本例没有额外 details，至少必须是对象）。
  assert.equal(typeof error.details.causeDetails, 'object');
});

test('报告里出现 approval_id 被拒绝（仅展示）', () => {
  expectCode(
    () => validateAnalysisReport({ ...validAnalysisReport(), approval_id: UUID_A }),
    'ERR_UNKNOWN_FIELD',
    '$.approval_id',
  );
});

test('报告里出现 signature 被拒绝（仅展示）', () => {
  expectCode(
    () => validateAnalysisReport({ ...validAnalysisReport(), signature: 'A'.repeat(44) }),
    'ERR_UNKNOWN_FIELD',
    '$.signature',
  );
});

test('报告里出现 state 被拒绝（仅展示）', () => {
  expectCode(
    () => validateAnalysisReport({ ...validAnalysisReport(), state: 'approved' }),
    'ERR_UNKNOWN_FIELD',
    '$.state',
  );
});

test('limitations 超过 32 项被拒绝', () => {
  const limitations = Array.from({ length: 33 }, (unused, index) => `限制 ${index}`);
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ limitations })),
    'ERR_MAX_ARRAY_ITEMS',
    '$.limitations',
  );
});

test('报告整体超过 64 KiB 被拒绝', () => {
  const limitations = Array.from({ length: 32 }, () => 'x'.repeat(4000));
  expectCode(
    () => validateAnalysisReport(validAnalysisReport({ limitations })),
    'ERR_OBJECT_TOO_LARGE',
    '$',
  );
});
