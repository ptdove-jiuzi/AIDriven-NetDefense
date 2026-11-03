/**
 * Integration with `ResponseProposal` / `Approval` / `ExecutionGrant`.
 *
 * The one claim this file exists to defend: **structural validity is not
 * authorisation.** Every "valid" case below builds records through the contracts
 * validators, confirms the cross-record bindings with the contracts' own
 * `verify*Binding` helpers, and then still asserts that the policy decision says
 * `authorizesExecution === false`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalDigest,
  validateResponseProposal,
  verifyGrantApprovalBinding,
  verifyProposalApprovalBinding,
} from '@aegisharness/contracts';
import {
  ANALYSIS_ID,
  EVIDENCE_ID,
  OBJECT_ID,
  OTHER_OBJECT_ID,
  PROPOSAL_ID,
  approvedTerminateScenario,
  buildApproval,
  buildProposal,
  windowsFileTarget,
  windowsProcessTarget,
} from './helpers.js';
import {
  DEFAULT_PARAMETER_ROOTS,
  POLICY_GATE_CONTRACT,
  assertGateNeverAuthorizes,
  contractTarget,
  decisionSummary,
  evaluateResponsePolicy,
} from '../../packages/response-policy/index.js';

/**
 * @param {object} [overrides] Request overrides.
 * @returns {object} Decision for the fully approved scenario.
 */
function decide(overrides = {}) {
  return evaluateResponsePolicy({ ...approvedTerminateScenario().request, ...overrides });
}

describe('contracts integration', () => {
  it('projects a normalised target onto the exact proposal target shape', () => {
    const scenario = approvedTerminateScenario();
    const projected = contractTarget(scenario.target);
    assert.deepEqual(projected, scenario.proposal.value.normalized_target);
    assert.deepEqual(Object.keys(projected).sort(), ['digest', 'object_id', 'target_kind']);
  });

  it('refuses to project a target that was never normalised', () => {
    assert.throws(
      () => contractTarget({ os: 'windows', kind: 'process' }),
      (error) => error.code === 'DENY_TARGET_SHAPE',
    );
  });

  it('confirms proposal/approval and grant/approval bindings with the contracts helpers', () => {
    const scenario = approvedTerminateScenario();
    assert.equal(verifyProposalApprovalBinding(scenario.proposal, scenario.approval), true);
    assert.equal(verifyGrantApprovalBinding(scenario.grant, scenario.approval), true);
  });

  it('allows a fully bound request while refusing to call it an authorisation', () => {
    const scenario = approvedTerminateScenario();
    const decision = decide();
    assert.equal(decision.outcome, 'allow');
    assert.equal(decision.authorizesExecution, false);
    assert.equal(assertGateNeverAuthorizes(decision), true);

    const summary = decisionSummary(decision);
    assert.equal(summary.authorizes_execution, false);
    assert.equal(summary.outcome, 'allow');
    assert.equal(summary.target_digest, scenario.target.digest);
    assert.equal(summary.parameters_digest, scenario.parameters.digest);
    assert.equal(Object.isFrozen(summary), true);
    // The summary must stay free of raw target data.
    assert.equal(JSON.stringify(summary).includes('TestSandbox'), false);
    assert.equal(JSON.stringify(summary).includes('CORP'), false);
  });

  it('denies when the proposal names another action', () => {
    const target = windowsProcessTarget();
    const proposal = buildProposal({ target, actionId: 'process.terminate', actionIdOverride: 'network.isolate' });
    const decision = decide({ proposal });
    assert.equal(decision.reasonCode, 'DENY_PROPOSAL_MISMATCH');
    assert.equal(decision.detail.field, 'action_id');
  });

  it('denies when the proposal is bound to a different target', () => {
    const other = windowsProcessTarget({ object_id: OTHER_OBJECT_ID });
    const proposal = buildProposal({ target: other, actionId: 'process.terminate' });
    const decision = decide({ proposal });
    assert.equal(decision.reasonCode, 'DENY_TARGET_DRIFT');
    assert.equal(decision.detail.field, 'normalized_target');
  });

  it('denies when the proposal understates risk', () => {
    const target = windowsProcessTarget();
    const proposal = buildProposal({ target, actionId: 'process.terminate', risk: 'low' });
    const decision = decide({ proposal });
    assert.equal(decision.reasonCode, 'DENY_RISK_UNDERSTATED');
    assert.equal(decision.detail.source, 'proposal');
  });

  it('denies an expired proposal', () => {
    const target = windowsProcessTarget();
    const proposal = buildProposal({
      target,
      actionId: 'process.terminate',
      expiresAt: '2026-11-01T23:00:00Z',
    });
    const decision = decide({ proposal });
    assert.equal(decision.reasonCode, 'DENY_PROPOSAL_EXPIRED');
  });

  it('denies a proposal that fails contracts validation', () => {
    const decision = decide({ proposal: { schemaVersion: '1.0' } });
    assert.equal(decision.reasonCode, 'DENY_PROPOSAL_INVALID');
    assert.equal(decision.detail.contractCode, 'ERR_MISSING_FIELD');
  });

  it('denies a proposal whose target kind disagrees with the evaluated target', () => {
    const target = windowsProcessTarget();
    const crafted = validateResponseProposal({
      schemaVersion: '1.0',
      proposal_id: PROPOSAL_ID,
      analysis_id: ANALYSIS_ID,
      action_id: 'process.terminate',
      normalized_target: { target_kind: 'file', digest: target.digest, object_id: OBJECT_ID },
      justification_evidence: [EVIDENCE_ID],
      risk: 'critical',
      expires_at: '2026-11-02T00:30:00Z',
    });
    const decision = decide({ proposal: crafted });
    assert.equal(decision.reasonCode, 'DENY_TARGET_KIND_MISMATCH');
    assert.equal(decision.detail.proposalKind, 'file');
  });

  it('rejects a tampered approval envelope even when the proposal is valid', () => {
    const scenario = approvedTerminateScenario();
    const validProposal = validateResponseProposal(scenario.proposal.value);
    const decision = decide({
      proposal: validProposal,
      approval: { ...scenario.approval, digest: 'e'.repeat(64) },
    });
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_INVALID');
  });

  it('rejects a structurally perfect but not-yet-approved record', () => {
    const scenario = approvedTerminateScenario();
    const pending = buildApproval({
      proposalDigest: scenario.proposal.digest,
      targetDigest: scenario.target.digest,
      state: 'pending',
    });
    // A fresh digest, so the envelope is self-consistent: only the state check can
    // stop this record, which is exactly what the test needs to prove.
    assert.equal(canonicalDigest(pending.value), pending.digest);
    const decision = decide({ approval: pending });
    assert.equal(decision.reasonCode, 'DENY_APPROVAL_STATE');
    assert.equal(decision.detail.state, 'pending');
  });

  it('documents its own interface, and the documentation matches the decision', () => {
    assert.deepEqual([...POLICY_GATE_CONTRACT.outputs].sort(), Object.keys(decide()).sort());
    assert.ok(POLICY_GATE_CONTRACT.notGuaranteed.some((item) => item.includes('signature')));
    assert.ok(POLICY_GATE_CONTRACT.guarantees.some((item) => item.includes('authorizesExecution')));
    assert.equal(POLICY_GATE_CONTRACT.policyVersion, '1.0');
  });

  it('states the trust assumptions it does not verify', () => {
    const text = [...POLICY_GATE_CONTRACT.notGuaranteed].join(' | ');
    // 这几条是本层明确"不保证"的，必须在契约里写出来，否则下游会误以为已核对。
    assert.match(text, /authenticity of the supplied Approval/u);
    assert.match(text, /parameter binding of an Approval/u);
    assert.match(text, /completeness of the replay view/u);
    assert.match(text, /freshness of actorRoles/u);
    assert.match(text, /request\.os equals the real host OS/u);
    assert.match(text, /policyRoots came from deployment config/u);
    assert.match(text, /which deny code a caught exception carries/u);
  });

  it('declares every input it actually reads', () => {
    for (const input of ['os', 'policyVersion', 'now', 'actionId', 'target', 'actorRoles', 'epoch', 'options.policyRoots']) {
      assert.ok(POLICY_GATE_CONTRACT.inputs.includes(input), input);
    }
  });

  it('works with a file target end to end, including a different action', () => {
    const target = windowsFileTarget();
    const proposal = buildProposal({ target, actionId: 'file.quarantine' });
    const decision = evaluateResponsePolicy({
      os: 'windows',
      policyVersion: '1.0',
      now: '2026-11-02T00:00:00Z',
      actionId: 'file.quarantine',
      target,
      parameters: { quarantine_root: DEFAULT_PARAMETER_ROOTS.windows.quarantine[0] },
      actorRoles: ['responder'],
      epoch: '11111111-1111-4111-8111-111111111111',
      proposal,
    });
    assert.equal(decision.outcome, 'needs_approval');
    assert.equal(decision.reasonCode, 'APPROVAL_REQUIRED');
    assert.equal(decision.targetDigest, target.digest);
  });
});
