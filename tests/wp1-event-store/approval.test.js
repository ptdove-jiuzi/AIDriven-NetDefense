/**
 * T3a：pending → approved，并创建 execution(approved)。
 *
 * 这一组用例的关键是"同一事务内重新检查"：角色、再认证时效、策略版本、TTL、epoch。
 * 任何一项只要能被"审批之后单独改掉"绕过，审批就退化成一张便利贴。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveExecution,
  createApproval,
  ingestTelemetry,
  registerProposal,
} from '../../packages/event-store/src/index.js';

import {
  canonicalDigest,
  expectStoreError,
  isoFromMs,
  makeAlert,
  makeAnalysisRequest,
  makeApproval,
  makeEvent,
  makeProposal,
  msFromIso,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

const WINDOW = {
  window_start: '2026-11-01T00:00:00.000Z',
  window_end: '2026-11-01T00:15:00.000Z',
};

const MINUTE = 60000;

function seed(t) {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`a-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ observed_at: now, received_at: now, native_record_id: `n-${analysis.analysis_id}` }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  const proposalValue = makeProposal({
    analysis_id: analysis.analysis_id,
    expires_at: isoFromMs(msFromIso(now) + 60 * MINUTE),
  });
  const proposal = registerProposal(store, { proposal: proposalValue, now });
  return { store, clock, alert, analysis, proposalValue, proposal, now };
}

function pendingApproval(context, overrides = {}) {
  return makeApproval({
    proposal_digest: context.proposal.digest,
    target_digest: context.proposalValue.normalized_target.digest,
    epoch: context.store.epoch(),
    issued_at: context.now,
    reauthenticated_at: context.now,
    expires_at: isoFromMs(msFromIso(context.now) + 30 * MINUTE),
    ...overrides,
  });
}

test('registerProposal 是幂等的，重复登记返回原摘要', (t) => {
  const context = seed(t);
  const again = registerProposal(context.store, { proposal: context.proposalValue, now: context.now });
  assert.equal(again.created, false);
  assert.equal(again.digest, context.proposal.digest);
  assert.equal(Number(context.store.get('SELECT COUNT(*) AS c FROM response_proposal').c), 1);
});

test('registerProposal 引用未知 analysis 被拒', (t) => {
  const context = seed(t);
  expectStoreError(
    () => registerProposal(context.store, {
      proposal: makeProposal({ analysis_id: uuid(), expires_at: isoFromMs(msFromIso(context.now) + 3600000) }),
      now: context.now,
    }),
    'ERR_ANALYSIS_NOT_FOUND',
  );
});

test('创建待审批：状态为 pending 并绑定 proposal/target 摘要', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context);
  const created = createApproval(context.store, {
    approval: approval,
    proposal_id: context.proposalValue.proposal_id,
    now: context.now,
  });
  assert.equal(created.state, 'pending');
  const row = context.store.get('SELECT * FROM approval WHERE approval_id = ?', [approval.approval_id]);
  assert.equal(String(row.state), 'pending');
  assert.equal(String(row.proposal_digest), context.proposal.digest);
  assert.equal(String(row.target_digest), context.proposalValue.normalized_target.digest);
});

test('proposal_digest 与库内不一致时拒绝创建（绑定校验）', (t) => {
  const context = seed(t);
  expectStoreError(
    () => createApproval(context.store, {
      approval: pendingApproval(context, { proposal_digest: sha256Hex('wrong-proposal') }),
      proposal_id: context.proposalValue.proposal_id,
      now: context.now,
    }),
    'ERR_BINDING_MISMATCH',
  );
});

test('target_digest 与 proposal 目标不一致时拒绝创建', (t) => {
  const context = seed(t);
  expectStoreError(
    () => createApproval(context.store, {
      approval: pendingApproval(context, { target_digest: sha256Hex('wrong-target') }),
      proposal_id: context.proposalValue.proposal_id,
      now: context.now,
    }),
    'ERR_BINDING_MISMATCH',
  );
});

test('批准成功：approval→approved，execution→approved，审计两条', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context);
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });

  const approved = approveExecution(context.store, {
    approval_id: approval.approval_id,
    roles: ['responder'],
    actorId: 'AEGIS\\responder',
    now: context.now,
  });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.duplicate, false);

  const approvalRow = context.store.get('SELECT state FROM approval WHERE approval_id = ?', [approval.approval_id]);
  assert.equal(String(approvalRow.state), 'approved');
  const execution = context.store.get('SELECT * FROM execution WHERE execution_id = ?', [approved.execution_id]);
  assert.equal(String(execution.state), 'approved');
  assert.equal(String(execution.approval_id), approval.approval_id);
  assert.equal(String(execution.proposal_id), context.proposalValue.proposal_id);

  const actions = context.store
    .all('SELECT action FROM audit_event ORDER BY sequence')
    .map((row) => String(row.action));
  assert.ok(actions.includes('approval.approve'));
  assert.ok(actions.includes('execution.create'));
});

test('execution 的动作/目标/参数摘要由 proposal 派生，不信调用方自报', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context);
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  const approved = approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now });

  const execution = context.store.get('SELECT * FROM execution WHERE execution_id = ?', [approved.execution_id]);
  assert.equal(String(execution.action_id), context.proposalValue.action_id);
  assert.equal(String(execution.action_digest), canonicalDigest({ action_id: context.proposalValue.action_id }));
  assert.equal(String(execution.target_digest), context.proposalValue.normalized_target.digest);
  assert.equal(
    String(execution.parameters_digest),
    canonicalDigest({ target: context.proposalValue.normalized_target }),
  );
});

test('角色不含 responder 时拒绝审批', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context);
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });

  expectStoreError(
    () => approveExecution(context.store, { approval_id: approval.approval_id, roles: ['analyst'], actorId: 'AEGIS\\responder', now: context.now }),
    'ERR_ROLE_NOT_PERMITTED',
  );
  const row = context.store.get('SELECT state FROM approval WHERE approval_id = ?', [approval.approval_id]);
  assert.equal(String(row.state), 'pending', 'rejected approval must not change state');
});

test('审批 TTL 过期后拒绝', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context, { expires_at: isoFromMs(msFromIso(context.now) + MINUTE) });
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  const later = isoFromMs(msFromIso(context.now) + 2 * MINUTE);
  expectStoreError(
    () => approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: later }),
    'ERR_APPROVAL_EXPIRED',
  );
});

test('proposal 过期后即使 approval 未过期也拒绝', (t) => {
  const { store, clock } = openTestStore(t);
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`b-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ observed_at: now, received_at: now, native_record_id: 'short-proposal' }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  const proposalValue = makeProposal({
    analysis_id: analysis.analysis_id,
    expires_at: isoFromMs(msFromIso(now) + MINUTE),
  });
  const proposal = registerProposal(store, { proposal: proposalValue, now });
  const approval = makeApproval({
    proposal_digest: proposal.digest,
    target_digest: proposalValue.normalized_target.digest,
    epoch: store.epoch(),
    issued_at: now,
    reauthenticated_at: now,
    expires_at: isoFromMs(msFromIso(now) + 30 * MINUTE),
  });
  createApproval(store, { approval, proposal_id: proposalValue.proposal_id, now });
  const later = isoFromMs(msFromIso(now) + 2 * MINUTE);
  const error = expectStoreError(
    () => approveExecution(store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: later }),
    'ERR_APPROVAL_EXPIRED',
  );
  assert.match(error.message, /proposal/iu);
});

test('epoch 不匹配时拒绝（恢复后的旧审批失效）', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context, { epoch: uuid() });
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  expectStoreError(
    () => approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now }),
    'ERR_EPOCH_MISMATCH',
  );
});

test('策略版本不匹配时拒绝', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context, { policy_version: '9.9' });
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  expectStoreError(
    () => approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now }),
    'ERR_APPROVAL_POLICY_MISMATCH',
  );
});

test('再认证超过 5 分钟时拒绝（即使合同层当时合法）', (t) => {
  const context = seed(t);
  const nowMs = msFromIso(context.now);
  const approval = pendingApproval(context, {
    issued_at: isoFromMs(nowMs - 6 * MINUTE),
    reauthenticated_at: isoFromMs(nowMs - 7 * MINUTE),
    expires_at: isoFromMs(nowMs + 30 * MINUTE),
  });
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  const error = expectStoreError(
    () => approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now }),
    'ERR_ROLE_NOT_PERMITTED',
  );
  assert.match(error.message, /reauthentication/iu);
});

test('重复批准是幂等的，不会创建第二个 execution', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context);
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  const first = approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now });
  const second = approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now });
  assert.equal(second.duplicate, true);
  assert.equal(second.execution_id, first.execution_id);
  assert.equal(Number(context.store.get('SELECT COUNT(*) AS c FROM execution').c), 1);
});

test('已被拒绝的审批不能再批准', (t) => {
  const context = seed(t);
  const approval = pendingApproval(context);
  createApproval(context.store, { approval, proposal_id: context.proposalValue.proposal_id, now: context.now });
  context.store.run("UPDATE approval SET state = 'rejected' WHERE approval_id = ?", [approval.approval_id]);
  expectStoreError(
    () => approveExecution(context.store, { approval_id: approval.approval_id, roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now }),
    'ERR_APPROVAL_STATE',
  );
});

test('未知 approval 报 ERR_APPROVAL_NOT_FOUND', (t) => {
  const context = seed(t);
  expectStoreError(
    () => approveExecution(context.store, { approval_id: uuid(), roles: ['responder'], actorId: 'AEGIS\\responder', now: context.now }),
    'ERR_APPROVAL_NOT_FOUND',
  );
});
