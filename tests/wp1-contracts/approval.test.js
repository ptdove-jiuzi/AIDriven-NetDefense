import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVAL_STATES,
  canonicalDigest,
  ROLE_NAMES,
  validateApproval,
} from '../../packages/contracts/src/index.js';
import { expectCode, validApproval } from './helpers.js';

function withIdentity(identity) {
  return validApproval({ approver_identity: { ...validApproval().approver_identity, ...identity } });
}

test('合法审批通过且状态集合完整', () => {
  const record = validateApproval(validApproval());
  assert.equal(record.digest, canonicalDigest(record.value));
  assert.equal(record.value.state, 'approved');
  assert.deepStrictEqual([...APPROVAL_STATES], [
    'proposed',
    'pending',
    'approved',
    'rejected',
    'expired',
    'consumed',
    'invalidated',
  ]);
});

test('身份快照缺少 responder 角色被拒绝', () => {
  expectCode(
    () => validateApproval(withIdentity({ role_snapshot: ['analyst'] })),
    'ERR_ROLE_NOT_PERMITTED',
    '$.approver_identity.role_snapshot',
  );
});

test('空角色快照被拒绝', () => {
  expectCode(
    () => validateApproval(withIdentity({ role_snapshot: [] })),
    'ERR_ARRAY_EMPTY',
    '$.approver_identity.role_snapshot',
  );
});

test('角色快照重复被拒绝', () => {
  expectCode(
    () => validateApproval(withIdentity({ role_snapshot: ['responder', 'responder'] })),
    'ERR_DUPLICATE_ARRAY_ELEMENT',
    '$.approver_identity.role_snapshot',
  );
});

test('再认证超过 5 分钟被拒绝', () => {
  expectCode(
    () => validateApproval(withIdentity({ reauthenticated_at: '2025-12-31T23:53:30Z' })),
    'ERR_REAUTH_TOO_STALE',
    '$.approver_identity.reauthenticated_at',
  );
});

test('再认证时间晚于签发时间被拒绝', () => {
  expectCode(
    () => validateApproval(withIdentity({ reauthenticated_at: '2026-01-01T00:00:11Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.approver_identity.reauthenticated_at',
  );
});

test('恰好 300 秒的再认证窗口被接受', () => {
  const record = validateApproval(withIdentity({ reauthenticated_at: '2025-12-31T23:55:10Z' }));
  assert.equal(record.value.approver_identity.reauthenticated_at, '2025-12-31T23:55:10Z');
});

test('expires_at 不晚于 issued_at 被拒绝', () => {
  expectCode(
    () => validateApproval(validApproval({ expires_at: '2026-01-01T00:00:10Z' })),
    'ERR_TIMESTAMP_ORDER',
    '$.expires_at',
  );
});

test('state 不在枚举内被拒绝', () => {
  expectCode(
    () => validateApproval(validApproval({ state: 'granted' })),
    'ERR_FIELD_ENUM',
    '$.state',
  );
});

test('policy_version 形态非法被拒绝', () => {
  expectCode(
    () => validateApproval(validApproval({ policy_version: 'v1' })),
    'ERR_FIELD_PATTERN',
    '$.policy_version',
  );
});

test('审批 nonce 过短被拒绝', () => {
  expectCode(
    () => validateApproval(validApproval({ nonce: 'short-nonce' })),
    'ERR_FIELD_PATTERN',
    '$.nonce',
  );
});

test('role_snapshot 枚举错误折叠后仍保留 allowed（不丢诊断信息）', () => {
  const error = expectCode(
    () => validateApproval(withIdentity({ role_snapshot: ['admin', 'x'] })),
    'ERR_ARRAY_ELEMENT_TYPE',
    '$.approver_identity.role_snapshot[1]',
  );
  assert.equal(error.details.cause, 'ERR_FIELD_ENUM');
  assert.ok(Array.isArray(error.details.causeDetails.allowed));
  assert.deepStrictEqual(
    [...error.details.causeDetails.allowed].sort(),
    [...ROLE_NAMES].sort(),
  );
  assert.ok(error.message.includes('ERR_FIELD_ENUM'));
});
