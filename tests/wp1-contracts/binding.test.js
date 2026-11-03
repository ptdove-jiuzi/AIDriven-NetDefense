import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  verifyGrantApprovalBinding,
  verifyProposalApprovalBinding,
  validateApproval,
  validateExecutionGrant,
  validateResponseProposal,
} from '../../packages/contracts/src/index.js';
import {
  expectCode,
  HEX_C,
  UUID_A,
  UUID_C,
  validApproval,
  validExecutionGrant,
  validResponseProposal,
} from './helpers.js';

function buildLinked() {
  const proposal = validateResponseProposal(validResponseProposal());
  const approval = validateApproval(validApproval({
    proposal_digest: proposal.digest,
    target_digest: proposal.value.normalized_target.digest,
  }));
  const grant = validateExecutionGrant(validExecutionGrant({ target_digest: approval.value.target_digest }));
  return { proposal, approval, grant };
}

function expectReason(fn, reason, pathContains) {
  const error = expectCode(fn, 'ERR_BINDING_MISMATCH', pathContains);
  assert.equal(error.details?.reason, reason);
}

test('提案与审批绑定校验通过', () => {
  const { proposal, approval } = buildLinked();
  assert.equal(verifyProposalApprovalBinding(proposal, approval), true);
});

test('proposal_digest 改一位即绑定失败', () => {
  const { proposal, approval } = buildLinked();
  const digest = approval.value.proposal_digest;
  const flipped = `${digest[0] === 'a' ? 'b' : 'a'}${digest.slice(1)}`;
  const tampered = validateApproval(validApproval({
    proposal_digest: flipped,
    target_digest: approval.value.target_digest,
  }));
  expectReason(
    () => verifyProposalApprovalBinding(proposal, tampered),
    'proposal_digest',
    '$.value.proposal_digest',
  );
});

test('target_digest 不一致导致绑定失败', () => {
  const { proposal, approval } = buildLinked();
  const tampered = validateApproval(validApproval({
    proposal_digest: approval.value.proposal_digest,
    target_digest: 'e'.repeat(64),
  }));
  expectReason(
    () => verifyProposalApprovalBinding(proposal, tampered),
    'target_digest',
    '$.value.target_digest',
  );
});

test('授权与审批绑定校验通过', () => {
  const { approval, grant } = buildLinked();
  assert.equal(verifyGrantApprovalBinding(grant, approval), true);
});

test('approval_id 不一致导致绑定失败', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    approval_id: UUID_A,
  }));
  expectReason(() => verifyGrantApprovalBinding(grant, approval), 'approval_id', '$.value.approval_id');
});

test('epoch 不一致导致绑定失败', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    epoch: UUID_C,
  }));
  expectReason(() => verifyGrantApprovalBinding(grant, approval), 'epoch', '$.value.epoch');
});

test('待审批状态不能被消费', () => {
  const { proposal } = buildLinked();
  const pending = validateApproval(validApproval({
    proposal_digest: proposal.digest,
    target_digest: HEX_C,
    state: 'pending',
  }));
  const grant = validateExecutionGrant(validExecutionGrant({ target_digest: HEX_C }));
  expectReason(() => verifyGrantApprovalBinding(grant, pending), 'approval_state', '$.value.state');
});

test('授权复用审批 nonce 被拒绝', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    nonce: approval.value.nonce,
  }));
  expectReason(() => verifyGrantApprovalBinding(grant, approval), 'nonce_reuse', '$.value.nonce');
});

test('授权有效期超过审批有效期被拒绝', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    expires_at: '2026-01-01T00:06:00Z',
  }));
  expectReason(() => verifyGrantApprovalBinding(grant, approval), 'expires_at', '$.value.expires_at');
});

test('授权生效时间早于审批签发时间被拒绝', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    not_before: '2026-01-01T00:00:05Z',
  }));
  expectReason(() => verifyGrantApprovalBinding(grant, approval), 'not_before', '$.value.not_before');
});

test('授权目标摘要不一致导致绑定失败', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: 'f'.repeat(64),
  }));
  expectReason(() => verifyGrantApprovalBinding(grant, approval), 'target_digest', '$.value.target_digest');
});

test('传入裸值而不是合同记录报 ERR_INPUT_NOT_OBJECT', () => {
  const { proposal, approval } = buildLinked();
  expectCode(
    () => verifyProposalApprovalBinding(proposal.value, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  expectCode(
    () => verifyGrantApprovalBinding({ ...approval.value }, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
});

test('伪造的提案记录因摘要与 value 不符被拒绝', () => {
  const { proposal } = buildLinked();
  // 攻击者自造记录：digest 形状合法，但从未被 canonicalDigest 覆盖。
  const forged = {
    schemaVersion: '1.0',
    digest: proposal.digest,
    value: { ...proposal.value, risk: 'low' },
  };
  const approval = validateApproval(validApproval({
    proposal_digest: forged.digest,
    target_digest: forged.value.normalized_target.digest,
  }));
  const error = expectCode(
    () => verifyProposalApprovalBinding(forged, approval),
    'ERR_DIGEST_MISMATCH',
    '$.digest',
  );
  assert.equal(error.details.expected, canonicalDigest(forged.value));
  assert.equal(error.details.label, 'proposal');
});

test('伪造的授权记录因摘要与 value 不符被拒绝', () => {
  const { approval } = buildLinked();
  const forged = {
    schemaVersion: '1.0',
    digest: 'f'.repeat(64),
    value: approval.value,
  };
  const error = expectCode(
    () => verifyGrantApprovalBinding(forged, approval),
    'ERR_DIGEST_MISMATCH',
    '$.digest',
  );
  assert.equal(error.details.expected, canonicalDigest(approval.value));
  assert.equal(error.details.label, 'grant');
});

test('记录多带一个键报 ERR_INPUT_NOT_OBJECT', () => {
  const { proposal, approval } = buildLinked();
  const extra = {
    schemaVersion: proposal.schemaVersion,
    digest: proposal.digest,
    value: proposal.value,
    approval_hint: 'auto',
  };
  const error = expectCode(
    () => verifyProposalApprovalBinding(extra, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  assert.equal(error.details.label, 'proposal');
});

/*
 * 记录形状检查过去只看 Object.keys：非枚举自有键与 Symbol 键既不计入键数，
 * 也不被 canonicalDigest 覆盖，等于允许记录夹带"看不见又不进摘要"的旁路数据。
 */
test('记录携带非枚举键或 Symbol 键时报 ERR_INPUT_NOT_OBJECT', () => {
  const { proposal, grant, approval } = buildLinked();
  const hidden = {
    schemaVersion: proposal.schemaVersion,
    digest: proposal.digest,
    value: proposal.value,
  };
  Object.defineProperty(hidden, 'approval_hint', {
    value: 'auto_approve',
    enumerable: false,
    writable: true,
    configurable: true,
  });
  assert.deepStrictEqual(Object.keys(hidden), ['schemaVersion', 'digest', 'value']);
  const hiddenError = expectCode(
    () => verifyProposalApprovalBinding(hidden, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  assert.equal(hiddenError.details.label, 'proposal');

  const symbolKeyed = {
    schemaVersion: grant.schemaVersion,
    digest: grant.digest,
    value: grant.value,
  };
  symbolKeyed[Symbol('auto_approve')] = true;
  const symbolError = expectCode(
    () => verifyGrantApprovalBinding(symbolKeyed, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  assert.equal(symbolError.details.label, 'grant');
});

/*
 * record.schemaVersion 与 record.value.schemaVersion 都是调用方可写的字段：
 * 只校验 value 内部版本会放过"外壳声明 1.0、内容其实是别的版本"的错配记录。
 */
test('record.schemaVersion 与 value.schemaVersion 不一致被拒绝', () => {
  const { proposal, grant, approval } = buildLinked();
  const mismatchedProposal = {
    schemaVersion: '1.0.0',
    digest: proposal.digest,
    value: proposal.value,
  };
  const proposalError = expectCode(
    () => verifyProposalApprovalBinding(mismatchedProposal, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  assert.equal(proposalError.details.label, 'proposal');
  assert.match(proposalError.message, /schemaVersion does not match/);

  const mismatchedGrant = {
    schemaVersion: '2.0',
    digest: grant.digest,
    value: grant.value,
  };
  const grantError = expectCode(
    () => verifyGrantApprovalBinding(mismatchedGrant, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  assert.equal(grantError.details.label, 'grant');

  // 外壳与内容都声明 1.0 的正常记录不受影响。
  assert.equal(verifyProposalApprovalBinding(proposal, approval), true);
  assert.equal(verifyGrantApprovalBinding(grant, approval), true);
});

test('记录少一个键（只有 digest 与 value）报 ERR_INPUT_NOT_OBJECT', () => {
  const { proposal, approval } = buildLinked();
  const partial = { digest: proposal.digest, value: proposal.value };
  const error = expectCode(
    () => verifyProposalApprovalBinding(partial, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
  assert.equal(error.details.label, 'proposal');
  expectCode(
    () => verifyGrantApprovalBinding({ digest: approval.digest, value: approval.value }, approval),
    'ERR_INPUT_NOT_OBJECT',
    '$',
  );
});

/*
 * 摘要自洽不等于记录合法：手工拼一份从未过 validateResponseProposal 的 value，
 * 缺 target_kind 也能让 canonicalDigest 对上。这里要求按 label 重跑 DTO 校验器，
 * 形状错误原样上抛，而不是被折成 ERR_BINDING_MISMATCH。
 */
test('摘要自洽但缺 target_kind 的手工提案记录被拒绝（形状错误）', () => {
  const { proposal } = buildLinked();
  const value = structuredClone(proposal.value);
  delete value.normalized_target.target_kind;
  const forged = {
    schemaVersion: '1.0',
    digest: canonicalDigest(value),
    value,
  };
  const approval = validateApproval(validApproval({
    proposal_digest: forged.digest,
    target_digest: value.normalized_target.digest,
  }));
  const error = expectCode(
    () => verifyProposalApprovalBinding(forged, approval),
    'ERR_MISSING_FIELD',
    '$.normalized_target.target_kind',
  );
  assert.notEqual(error.code, 'ERR_BINDING_MISMATCH');
});

test('手工构造缺 signature 的授权记录被拒绝（形状错误）', () => {
  const { approval } = buildLinked();
  const value = structuredClone(validateExecutionGrant(validExecutionGrant({
    target_digest: approval.value.target_digest,
  })).value);
  delete value.signature;
  const forged = {
    schemaVersion: '1.0',
    digest: canonicalDigest(value),
    value,
  };
  const error = expectCode(
    () => verifyGrantApprovalBinding(forged, approval),
    'ERR_MISSING_FIELD',
    '$.signature',
  );
  assert.notEqual(error.code, 'ERR_BINDING_MISMATCH');
});

test('反例：冻结 / JSON 往返 / structuredClone 三种来源的正常记录仍然绑定成功', () => {
  const { proposal, approval, grant } = buildLinked();
  // 1) 冻结：validateXxx 直接产出
  assert.equal(verifyProposalApprovalBinding(proposal, approval), true);
  assert.equal(verifyGrantApprovalBinding(grant, approval), true);
  assert.ok(Object.isFrozen(proposal) && Object.isFrozen(proposal.value));
  // 2) JSON 往返：全部键都可枚举，重跑校验器结论不变
  const jsonProposal = JSON.parse(JSON.stringify(proposal));
  const jsonApproval = JSON.parse(JSON.stringify(approval));
  const jsonGrant = JSON.parse(JSON.stringify(grant));
  assert.equal(verifyProposalApprovalBinding(jsonProposal, jsonApproval), true);
  assert.equal(verifyGrantApprovalBinding(jsonGrant, jsonApproval), true);
  // 3) structuredClone：同样是普通对象
  assert.equal(verifyProposalApprovalBinding(structuredClone(proposal), structuredClone(approval)), true);
  assert.equal(verifyGrantApprovalBinding(structuredClone(grant), structuredClone(approval)), true);
});

test('绑定失败路径精确指向 $.value.<字段>', () => {
  const { approval } = buildLinked();
  const grant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    epoch: UUID_C,
  }));
  const error = expectCode(() => verifyGrantApprovalBinding(grant, approval), 'ERR_BINDING_MISMATCH');
  assert.equal(error.details.reason, 'epoch');
  assert.equal(error.path, '$.value.epoch');
  // 其余失败路径同样落在被检查字段的真实位置上。
  const nonceGrant = validateExecutionGrant(validExecutionGrant({
    target_digest: HEX_C,
    epoch: approval.value.epoch,
    nonce: approval.value.nonce,
  }));
  const nonceError = expectCode(() => verifyGrantApprovalBinding(nonceGrant, approval), 'ERR_BINDING_MISMATCH');
  assert.equal(nonceError.path, '$.value.nonce');
});
