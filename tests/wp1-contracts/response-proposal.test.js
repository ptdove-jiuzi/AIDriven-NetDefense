import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  validateResponseProposal,
} from '../../packages/contracts/src/index.js';
import { expectCode, HEX_C, UUID_A, validResponseProposal } from './helpers.js';

test('合法的待审批提案通过', () => {
  const record = validateResponseProposal(validResponseProposal());
  assert.equal(record.schemaVersion, '1.0');
  assert.equal(record.digest, canonicalDigest(record.value));
  assert.equal(record.value.normalized_target.digest, HEX_C);
});

test('risk 不在枚举内被拒绝', () => {
  expectCode(
    () => validateResponseProposal(validResponseProposal({ risk: 'severe' })),
    'ERR_FIELD_ENUM',
    '$.risk',
  );
});

test('空 justification_evidence 被拒绝', () => {
  expectCode(
    () => validateResponseProposal(validResponseProposal({ justification_evidence: [] })),
    'ERR_ARRAY_EMPTY',
    '$.justification_evidence',
  );
});

test('normalized_target 里出现原始 path 被拒绝', () => {
  const proposal = validResponseProposal();
  proposal.normalized_target = { ...proposal.normalized_target, path: 'C:/Windows/System32/patch.exe' };
  expectCode(
    () => validateResponseProposal(proposal),
    'ERR_UNKNOWN_FIELD',
    '$.normalized_target.path',
  );
});

test('target_kind 不在枚举内被拒绝', () => {
  const proposal = validResponseProposal();
  proposal.normalized_target = { ...proposal.normalized_target, target_kind: 'registry' };
  expectCode(() => validateResponseProposal(proposal), 'ERR_FIELD_ENUM', '$.normalized_target.target_kind');
});

test('object_id 过短被拒绝', () => {
  const proposal = validResponseProposal();
  proposal.normalized_target = { ...proposal.normalized_target, object_id: 'too-short' };
  expectCode(() => validateResponseProposal(proposal), 'ERR_FIELD_PATTERN', '$.normalized_target.object_id');
});

test('expires_at 格式非法被拒绝', () => {
  expectCode(
    () => validateResponseProposal(validResponseProposal({ expires_at: '2026-01-01T00:10:00+00:00' })),
    'ERR_TIMESTAMP_FORMAT',
    '$.expires_at',
  );
});

test('提案里塞报告字段被拒绝', () => {
  expectCode(
    () => validateResponseProposal({ ...validResponseProposal(), summary: '自由文本' }),
    'ERR_UNKNOWN_FIELD',
    '$.summary',
  );
  expectCode(
    () => validateResponseProposal({ ...validResponseProposal(), confidence: 0.9 }),
    'ERR_UNKNOWN_FIELD',
    '$.confidence',
  );
});

test('提案里塞审批字段被拒绝', () => {
  expectCode(
    () => validateResponseProposal({ ...validResponseProposal(), approval_id: UUID_A }),
    'ERR_UNKNOWN_FIELD',
    '$.approval_id',
  );
});
