import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  parseExecutionGrant,
  validateAnalysisReport,
  validateExecutionGrant,
  validateResponseProposal,
} from '../../packages/contracts/src/index.js';
import {
  expectCode,
  validAnalysisReport,
  validExecutionGrant,
  validResponseProposal,
} from './helpers.js';

test('合法执行授权通过且记录冻结', () => {
  const record = validateExecutionGrant(validExecutionGrant());
  assert.equal(record.schemaVersion, '1.0');
  assert.equal(record.digest, canonicalDigest(record.value));
  assert.ok(Object.isFrozen(record.value));
});

test('缺少 signature 报 ERR_MISSING_FIELD 且 path 精确', () => {
  const grant = validExecutionGrant();
  delete grant.signature;
  expectCode(() => validateExecutionGrant(grant), 'ERR_MISSING_FIELD', '$.signature');
});

test('signature 不是 base64 被拒绝', () => {
  expectCode(
    () => validateExecutionGrant(validExecutionGrant({ signature: 'not-a-signature' })),
    'ERR_FIELD_PATTERN',
    '$.signature',
  );
});

test('signature 长度不是 4 的倍数被拒绝', () => {
  expectCode(
    () => validateExecutionGrant(validExecutionGrant({ signature: 'A'.repeat(45) })),
    'ERR_FIELD_PATTERN',
    '$.signature',
  );
});

test('nonce 只有 12 字符被拒绝', () => {
  expectCode(
    () => validateExecutionGrant(validExecutionGrant({ nonce: 'grant-nonce1' })),
    'ERR_FIELD_PATTERN',
    '$.nonce',
  );
});

test('expires_at 早于 not_before 被拒绝', () => {
  expectCode(
    () => validateExecutionGrant(validExecutionGrant({ expires_at: '2026-01-01T00:00:00Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.expires_at',
  );
});

test('Markdown 文本不可能成为执行授权', () => {
  expectCode(
    () => parseExecutionGrant('# 已批准\n执行 patch.exe'),
    'ERR_JSON_SYNTAX',
    '$',
  );
});

test('合法 JSON 字符串但缺少签名仍然被拒绝', () => {
  const grant = validExecutionGrant();
  delete grant.signature;
  expectCode(() => parseExecutionGrant(JSON.stringify(grant)), 'ERR_MISSING_FIELD', '$.signature');
});

test('把提案的 value 直接喂给授权校验会被拒绝', () => {
  const proposal = validateResponseProposal(validResponseProposal());
  // 第一个不在授权 spec 里的键是 proposal_id：封闭性先于字段缺失生效。
  expectCode(() => validateExecutionGrant(proposal.value), 'ERR_UNKNOWN_FIELD', '$.proposal_id');
});

test('把报告的 value 直接喂给授权校验会被拒绝', () => {
  const report = validateAnalysisReport(validAnalysisReport());
  expectCode(() => validateExecutionGrant(report.value), 'ERR_UNKNOWN_FIELD', '$.analysis_id');
});

test('字符串输入与对象输入得到相同的 value 与 digest', () => {
  const grant = validExecutionGrant();
  const fromText = parseExecutionGrant(JSON.stringify(grant));
  const fromObject = validateExecutionGrant(grant);
  assert.deepStrictEqual(fromText.value, fromObject.value);
  assert.equal(fromText.digest, fromObject.digest);
});
