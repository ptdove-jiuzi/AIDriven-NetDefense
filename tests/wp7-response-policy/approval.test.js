/**
 * Approval checks: state, policy version, role, window, target binding, epoch,
 * nonce replay.
 *
 * A structurally valid `Approval` is not permission. Each test below starts from
 * a *contracts-valid* record and changes exactly one semantic field, so a failure
 * can only come from the policy check and never from shape validation.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPROVAL_NONCE,
  EPOCH,
  NOW,
  OTHER_EPOCH,
  approvedTerminateScenario,
  buildApproval,
  buildProposal,
  windowsNetworkTarget,
} from './helpers.js';
import { evaluateResponsePolicy, roleSatisfies } from '../../packages/response-policy/index.js';

/**
 * Build a request for `process.terminate` around one approval record.
 *
 * @param {object} approvalRecord Contracts record or raw DTO.
 * @param {object} [overrides] Request overrides.
 * @returns {object} Decision result.
 */
function decideWithApproval(approvalRecord, overrides = {}) {
  const scenario = approvedTerminateScenario();
  return evaluateResponsePolicy({
    ...scenario.request,
    approval: approvalRecord,
    ...overrides,
  });
}

describe('approval checks', () => {
  it('allows a fully approved request but still refuses to authorise execution', () => {
    const decision = decideWithApproval(approvedTerminateScenario().approval);
    assert.equal(decision.outcome, 'allow');
    assert.equal(decision.reasonCode, 'ALLOWED');
    assert.equal(decision.authorizesExecution, false);
    assert.equal(decision.structuralValidationOnly, true);
    assert.ok(decision.helperVerificationRequired.includes('helper_target_rebinding'));
    assert.ok(decision.helperVerificationRequired.includes('helper_recovery_manifest'));
  });

  it('rejects an approval that is not in the approved state', () => {
    for (const state of ['proposed', 'pending', 'rejected', 'expired', 'consumed', 'invalidated']) {
      const scenario = approvedTerminateScenario();
      const approval = buildApproval({
        proposalDigest: scenario.proposal.digest,
        targetDigest: scenario.target.digest,
        state,
      });
      const decision = decideWithApproval(approval);
      assert.equal(decision.reasonCode, 'DENY_APPROVAL_STATE', state);
      assert.equal(decision.detail.state, state);
    }
  });

  it('rejects an approval issued under a different policy version', () => {
    const scenario = approvedTerminateScenario();
    const approval = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: scenario.target.digest,
      policyVersion: '0.9',
    });
    const decision = decideWithApproval(approval);
    assert.equal(decision.reasonCode, 'DENY_POLICY_VERSION_STALE');
    assert.equal(decision.detail.approvalPolicyVersion, '0.9');
    assert.equal(decision.detail.currentPolicyVersion, '1.0');
  });

  it('accepts an approver whose snapshot also carries admin, but admin alone is not a responder', () => {
    const scenario = approvedTerminateScenario();
    const approval = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: scenario.target.digest,
      roles: ['responder', 'admin'],
    });
    assert.equal(decideWithApproval(approval).reasonCode, 'ALLOWED');
    assert.equal(roleSatisfies(['admin'], 'responder'), false);
    assert.equal(roleSatisfies(['viewer', 'analyst'], 'responder'), false);
  });

  it('rejects an approval without the responder role at the contract level', () => {
    const scenario = approvedTerminateScenario();
    assert.throws(
      () => buildApproval({
        proposalDigest: scenario.proposal.digest,
        targetDigest: scenario.target.digest,
        roles: ['viewer', 'analyst'],
      }),
      (error) => error.code === 'ERR_ROLE_NOT_PERMITTED',
    );
  });

  it('rejects an expired approval', () => {
    const scenario = approvedTerminateScenario();
    const approval = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: scenario.target.digest,
      issuedAt: '2026-11-01T23:58:00Z',
      expiresAt: '2026-11-01T23:59:00Z',
    });
    const decision = decideWithApproval(approval);
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_EXPIRED');
    assert.equal(decision.detail.expiresAt, '2026-11-01T23:59:00Z');
  });

  it('rejects an approval issued after now', () => {
    const scenario = approvedTerminateScenario();
    const approval = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: scenario.target.digest,
      reauthenticatedAt: '2026-11-02T00:09:00Z',
      issuedAt: '2026-11-02T00:10:00Z',
      expiresAt: '2026-11-02T00:30:00Z',
    });
    const decision = decideWithApproval(approval);
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_NOT_YET_VALID');
  });

  it('rejects an approval bound to a different target digest', () => {
    const scenario = approvedTerminateScenario();
    const approval = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: 'b'.repeat(64),
    });
    const decision = decideWithApproval(approval);
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_TARGET_DRIFT');
    assert.equal(decision.detail.field, 'target_digest');
  });

  it('rejects an approval that does not match the supplied proposal', () => {
    const scenario = approvedTerminateScenario();
    const approval = buildApproval({
      proposalDigest: 'c'.repeat(64),
      targetDigest: scenario.target.digest,
    });
    const decision = decideWithApproval(approval);
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_PROPOSAL_MISMATCH');
  });

  it('refuses to evaluate an approval without the proposal it binds', () => {
    // Without the proposal, `approval.proposal_digest` is unverifiable — and that
    // digest is the only field tying an approval to one action. Omitting it used
    // to let a `network.block_connection` approval clear `network.isolate`.
    const scenario = approvedTerminateScenario();
    const decision = decideWithApproval(scenario.approval, { proposal: undefined });
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_PROPOSAL_REQUIRED');
    assert.equal(decision.detail.actionId, 'process.terminate');
  });

  it('does not let one action\'s approval clear another action', () => {
    const target = windowsNetworkTarget();
    const otherProposal = buildProposal({ target, actionId: 'network.block_connection' });
    const approval = buildApproval({
      proposalDigest: otherProposal.digest,
      targetDigest: target.digest,
    });
    const base = {
      os: 'windows',
      policyVersion: '1.0',
      now: NOW,
      actionId: 'network.isolate',
      target,
      parameters: { direction: 'both' },
      actorRoles: ['responder'],
      epoch: EPOCH,
      approval,
    };
    // No proposal at all: the action binding is unverifiable, so it denies.
    assert.equal(evaluateResponsePolicy(base).reasonCode, 'DENY_PROPOSAL_REQUIRED');
    // With the *correct* proposal for this action, the approval's proposal digest
    // no longer matches and the cross-action reuse is caught explicitly.
    const correct = buildProposal({ target, actionId: 'network.isolate' });
    assert.equal(
      evaluateResponsePolicy({ ...base, proposal: correct }).reasonCode,
      'DENY_APPROVAL_PROPOSAL_MISMATCH',
    );
  });

  it('rejects a foreign epoch and an absent epoch', () => {
    const scenario = approvedTerminateScenario();
    const foreign = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: scenario.target.digest,
      epoch: OTHER_EPOCH,
    });
    assert.equal(decideWithApproval(foreign).reasonCode, 'DENY_APPROVAL_EPOCH');

    const absent = decideWithApproval(scenario.approval, { epoch: undefined });
    assert.equal(absent.reasonCode, 'DENY_EPOCH_REQUIRED');
    assert.equal(absent.detail.field, 'epoch');
  });

  it('rejects an approval nonce that was already consumed', () => {
    const scenario = approvedTerminateScenario();
    const decision = decideWithApproval(scenario.approval, {
      replay: { approvalNonces: [APPROVAL_NONCE] },
    });
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_NONCE_REPLAY');
    assert.equal(decision.detail.field, 'nonce');
  });

  it('rejects a tampered approval envelope', () => {
    const scenario = approvedTerminateScenario();
    const decision = decideWithApproval({ ...scenario.approval, digest: 'd'.repeat(64) });
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_INVALID');
  });

  it('rejects a structurally invalid approval with the contract code attached', () => {
    const scenario = approvedTerminateScenario();
    const dto = { ...scenario.approval.value };
    delete dto.nonce;
    const decision = decideWithApproval(dto);
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_INVALID');
    assert.equal(decision.detail.contractCode, 'ERR_MISSING_FIELD');
  });

  it('returns the approval as a contracts record, not as a permission token', () => {
    const scenario = approvedTerminateScenario();
    assert.deepEqual(Object.keys(scenario.approval).sort(), ['digest', 'schemaVersion', 'value']);
    assert.match(scenario.approval.digest, /^[0-9a-f]{64}$/u);
    assert.equal(scenario.approval.value.state, 'approved');
    assert.equal(Object.prototype.hasOwnProperty.call(scenario.approval.value, 'authorizes_execution'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(scenario.approval.value, 'execution_id'), false);
  });
});
