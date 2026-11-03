/**
 * Execution grant checks: action binding, parameter binding, target binding,
 * approval identity, epoch, window and replay.
 *
 * The point of these cases is that a grant is *evidence*, not a bypass. Even a
 * perfectly shaped grant returns `allow` with `authorizesExecution === false`:
 * the signature is only checked for shape here, because this layer holds no key
 * and design §10.2 gives signature verification to the helper.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateExecutionGrant } from '@aegisharness/contracts';
import {
  EXECUTION_ID,
  GRANT_NONCE,
  OTHER_EPOCH,
  SIGNATURE,
  approvedTerminateScenario,
  buildGrant,
  paramsFor,
} from './helpers.js';
import {
  actionDigest,
  createReplayRegistry,
  evaluateResponsePolicy,
} from '../../packages/response-policy/index.js';

/**
 * @param {object} grant Contracts record or raw DTO.
 * @param {object} [overrides] Request overrides.
 * @returns {object} Decision result.
 */
function decideWithGrant(grant, overrides = {}) {
  const scenario = approvedTerminateScenario();
  return evaluateResponsePolicy({ ...scenario.request, grant, ...overrides });
}

describe('execution grant checks', () => {
  it('allows a fully bound grant but still refuses to authorise execution', () => {
    const decision = decideWithGrant(approvedTerminateScenario().grant);
    assert.equal(decision.outcome, 'allow');
    assert.equal(decision.authorizesExecution, false);
    assert.equal(decision.structuralValidationOnly, true);
    for (const requirement of [
      'grant_signature',
      'grant_nonce_single_use',
      'grant_epoch',
      'helper_action_allowlist',
      'helper_target_rebinding',
      'helper_recovery_manifest',
    ]) {
      assert.ok(decision.helperVerificationRequired.includes(requirement), requirement);
    }
    assert.ok(decision.notes.some((note) => note.includes('signature is verified by the helper')));
  });

  it('rejects a grant that is not valid yet', () => {
    const scenario = approvedTerminateScenario();
    const grant = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
      notBefore: '2026-11-02T00:05:00Z',
      expiresAt: '2026-11-02T00:20:00Z',
    });
    const decision = decideWithGrant(grant);
    assert.equal(decision.reasonCode, 'DENY_GRANT_NOT_YET_VALID');
  });

  it('rejects an expired grant', () => {
    const scenario = approvedTerminateScenario();
    const grant = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
      notBefore: '2026-11-01T23:50:00Z',
      expiresAt: '2026-11-01T23:59:00Z',
    });
    const decision = decideWithGrant(grant);
    assert.equal(decision.reasonCode, 'DENY_GRANT_EXPIRED');
  });

  it('rejects a grant that reuses the approval nonce', () => {
    const scenario = approvedTerminateScenario();
    const grant = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
      nonce: scenario.approval.value.nonce,
    });
    const decision = decideWithGrant(grant);
    assert.equal(decision.reasonCode, 'DENY_GRANT_APPROVAL_MISMATCH');
    assert.equal(decision.detail.field, 'nonce');
  });

  it('rejects a grant whose window is wider than the approval it consumes', () => {
    const scenario = approvedTerminateScenario();
    const late = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
      notBefore: '2026-11-02T00:30:00Z',
      expiresAt: '2026-11-02T00:40:00Z',
    });
    assert.equal(decideWithGrant(late).reasonCode, 'DENY_GRANT_NOT_YET_VALID');

    const overlong = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
      expiresAt: '2026-11-02T00:40:00Z',
    });
    assert.equal(decideWithGrant(overlong).reasonCode, 'DENY_GRANT_APPROVAL_MISMATCH');
  });

  it('rejects a grant issued for another action, by id or by digest', () => {
    const scenario = approvedTerminateScenario();
    const otherAction = buildGrant({
      actionId: 'network.isolate',
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
    });
    assert.equal(decideWithGrant(otherAction).reasonCode, 'DENY_GRANT_ACTION_MISMATCH');

    const forgedDigest = validateExecutionGrant({
      ...scenario.grant.value,
      action_digest: 'e'.repeat(64),
    });
    const decision = decideWithGrant(forgedDigest);
    assert.equal(decision.reasonCode, 'DENY_GRANT_ACTION_MISMATCH');
    assert.equal(decision.detail.field, 'action_id');
  });

  it('rejects a grant whose parameters digest does not match the request', () => {
    const scenario = approvedTerminateScenario();
    const otherParams = paramsFor('process.terminate', { grace_period_ms: 9000 });
    const grant = buildGrant({
      parametersDigest: otherParams.digest,
      targetDigest: scenario.target.digest,
    });
    const decision = decideWithGrant(grant);
    assert.equal(decision.reasonCode, 'DENY_GRANT_PARAMETERS_DRIFT');
    assert.equal(decision.detail.field, 'parameters_digest');
  });

  it('rejects a grant bound to another target', () => {
    const scenario = approvedTerminateScenario();
    const grant = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: 'f'.repeat(64),
    });
    const decision = decideWithGrant(grant);
    assert.equal(decision.reasonCode, 'DENY_GRANT_TARGET_DRIFT');
  });

  it('rejects a grant that names another approval', () => {
    const scenario = approvedTerminateScenario();
    const grant = buildGrant({
      approvalId: '77777777-7777-4777-8777-777777777777',
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
    });
    const decision = decideWithGrant(grant);
    assert.equal(decision.reasonCode, 'DENY_GRANT_APPROVAL_MISMATCH');
    assert.equal(decision.detail.field, 'approval_id');
  });

  it('rejects a foreign epoch', () => {
    const scenario = approvedTerminateScenario();
    const grant = buildGrant({
      parametersDigest: scenario.parameters.digest,
      targetDigest: scenario.target.digest,
      epoch: OTHER_EPOCH,
    });
    assert.equal(decideWithGrant(grant).reasonCode, 'DENY_GRANT_EPOCH');
  });

  it('rejects a grant presented without the approval it claims to consume', () => {
    const scenario = approvedTerminateScenario();
    const decision = evaluateResponsePolicy({ ...scenario.request, approval: undefined });
    assert.equal(decision.outcome, 'deny');
    assert.equal(decision.reasonCode, 'DENY_GRANT_APPROVAL_MISMATCH');
    assert.match(decision.detail.reason, /without the approval/u);
  });

  it('rejects a replayed grant nonce and a replayed execution id', () => {
    const scenario = approvedTerminateScenario();
    const nonce = decideWithGrant(scenario.grant, { replay: { grantNonces: [GRANT_NONCE] } });
    assert.equal(nonce.reasonCode, 'DENY_GRANT_NONCE_REPLAY');

    const execution = decideWithGrant(scenario.grant, { replay: { executionIds: [EXECUTION_ID] } });
    assert.equal(execution.reasonCode, 'DENY_GRANT_EXECUTION_REPLAY');
  });

  it('rejects a grant whose signature is not even well formed', () => {
    const scenario = approvedTerminateScenario();
    const decision = decideWithGrant({ ...scenario.grant.value, signature: 'not base64!' });
    assert.equal(decision.reasonCode, 'DENY_GRANT_INVALID');
    assert.equal(decision.detail.contractCode, 'ERR_FIELD_PATTERN');
  });

  it('accepts a shape-valid signature because verification belongs to the helper', () => {
    // This is the honest boundary: `AAAA…` is valid base64 and useless as a
    // signature. The gate says "allow" (policy is satisfied) but flags
    // `grant_signature` as helper work, so a caller cannot read `allow` as
    // "signature already checked".
    const scenario = approvedTerminateScenario();
    assert.equal(scenario.grant.value.signature, SIGNATURE);
    const decision = decideWithGrant(scenario.grant);
    assert.equal(decision.reasonCode, 'ALLOWED');
    assert.ok(decision.helperVerificationRequired.includes('grant_signature'));
  });

  it('records consumption in a caller-owned registry so a second attempt denies', () => {
    const scenario = approvedTerminateScenario();
    const registry = createReplayRegistry();
    const first = evaluateResponsePolicy({ ...scenario.request, replay: registry.view() });
    assert.equal(first.reasonCode, 'ALLOWED');

    assert.equal(registry.consumeApproval(scenario.approval.value.nonce), true);
    assert.equal(registry.consumeApproval(scenario.approval.value.nonce), false);
    assert.equal(registry.consumeGrant(scenario.grant.value.nonce, scenario.grant.value.execution_id), true);
    assert.equal(registry.consumeGrant(scenario.grant.value.nonce, scenario.grant.value.execution_id), false);
    assert.equal(registry.consumeGrant('', 'x'), false);

    const second = evaluateResponsePolicy({ ...scenario.request, replay: registry.view() });
    assert.equal(second.outcome, 'deny');
    assert.equal(second.reasonCode, 'DENY_APPROVAL_NONCE_REPLAY');

    assert.equal(registry.hasApproval(scenario.approval.value.nonce), true);
    assert.equal(registry.hasGrant(scenario.grant.value.nonce), true);
    assert.equal(registry.hasExecution(scenario.grant.value.execution_id), true);
    assert.equal(registry.size(), 3);
  });

  it('binds the catalog digest the grant must quote', () => {
    const scenario = approvedTerminateScenario();
    assert.equal(scenario.grant.value.action_digest, actionDigest('process.terminate'));
    assert.notEqual(scenario.grant.value.action_digest, actionDigest('network.isolate'));
  });
});
