/**
 * Grant, approval and replay: the checks that decide whether *this* dispatch may be
 * planned at all.
 *
 * The policy gate owns the allow/needs_approval/deny verdict, so most refusals here
 * carry a policy reason code and the test asserts that the helper did not replace it
 * with a home-grown one. The helper's own codes appear only where the policy layer
 * deliberately has no opinion: a missing grant for an approvable action, a grant
 * bound to another execution, an unverifiable signature, and nonce/attempt reuse.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_CLOCK_SKEW_MS,
  createMemoryInbox,
  createMemoryManifestStore,
  createNullGrantVerifier,
} from '../../apps/response-helper/index.js';
import {
  APPROVAL_NONCE,
  EXECUTION_ID,
  GRANT_NONCE,
  OTHER_ATTEMPT_ID,
  OTHER_EPOCH,
  OTHER_EXECUTION_ID,
  alertEnvelope,
  buildApproval,
  buildGrant,
  buildProposal,
  createHelper,
  envelopeFor,
  fileTarget,
  networkTarget,
  paramsFor,
  processTarget,
} from './helpers.js';

describe('grant time window', () => {
  it('refuses an expired grant', () => {
    const target = processTarget();
    const response = createHelper({ target, now: '2026-11-02T00:20:00Z' }).prepare(
      envelopeFor({ target, now: '2026-11-02T00:20:00Z' }),
    );
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'DENY_GRANT_EXPIRED');
    assert.equal(response.plan, null);
  });

  it('refuses a grant that is not valid yet', () => {
    const target = processTarget();
    const grant = buildGrant({
      parametersDigest: envelopeFor({ target }).grant.value.parameters_digest,
      targetDigest: target.digest,
      notBefore: '2026-11-02T00:05:00Z',
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, grant }));
    assert.equal(response.code, 'DENY_GRANT_NOT_YET_VALID');
  });

  it('refuses a dispatch whose approval expired before the grant did', () => {
    const target = processTarget();
    const now = '2026-11-02T00:31:00Z';
    const proposal = buildProposal({ target, expiresAt: '2026-11-02T02:00:00Z' });
    const response = createHelper({ target, now }).prepare(
      envelopeFor({ target, proposal, now }),
    );
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'DENY_APPROVAL_EXPIRED');
  });
});

describe('clock freshness', () => {
  it('refuses a dispatch whose now is far from the helper clock', () => {
    const target = processTarget();
    // Same envelope, honest clock: an expired grant cannot be made valid by
    // declaring an earlier `now`.
    const helper = createHelper({ target, now: '2026-11-02T00:20:00Z' });
    const response = helper.prepare(envelopeFor({ target, now: '2026-11-02T00:00:00Z' }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_CLOCK_SKEW');
    assert.equal(response.detail.skew_ms, -20 * 60 * 1000);
    assert.equal(response.plan, null);
  });

  it('tolerates ordinary skew inside the declared bound', () => {
    const target = processTarget();
    const helper = createHelper({ target, now: '2026-11-02T00:00:20Z' });
    const response = helper.prepare(envelopeFor({ target, now: '2026-11-02T00:00:00Z' }));
    assert.equal(response.status, 'planned');
    assert.equal(MAX_CLOCK_SKEW_MS, 30_000);
  });

  it('refuses when the clock cannot be read at all', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      clock: {
        source: 'broken',
        nowMs() {
          throw new Error('clock unavailable');
        },
      },
    });
    assert.equal(helper.prepare(envelopeFor({ target })).code, 'HELPER_CLOCK_SKEW');
  });
});

describe('approval presence', () => {
  it('refuses a dispatch with no approval at all', () => {
    const target = processTarget();
    const envelope = envelopeFor({ target });
    delete envelope.approval;
    delete envelope.grant;
    const response = createHelper({ target }).prepare(envelope);
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'APPROVAL_REQUIRED');
    assert.equal(response.decision.outcome, 'needs_approval');
    assert.equal(response.plan, null);
  });

  it('refuses an approval that was rejected', () => {
    const target = processTarget();
    const proposal = buildProposal({ target });
    const approval = buildApproval({
      proposalDigest: proposal.digest,
      targetDigest: target.digest,
      state: 'rejected',
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, proposal, approval }));
    assert.equal(response.code, 'DENY_APPROVAL_STATE');
  });

  it('refuses an approval that approved a different proposal', () => {
    const target = processTarget();
    const proposal = buildProposal({ target });
    const otherProposal = buildProposal({ target, expiresAt: '2026-11-02T00:29:00Z' });
    const approval = buildApproval({
      proposalDigest: otherProposal.digest,
      targetDigest: target.digest,
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, proposal, approval }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'DENY_APPROVAL_PROPOSAL_MISMATCH');
  });

  it('refuses an approvable action that arrives without its grant', () => {
    const target = processTarget();
    const envelope = envelopeFor({ target });
    delete envelope.grant;
    const response = createHelper({ target }).prepare(envelope);
    // Policy allows (an approval is not a grant), but nothing may be planned to run.
    assert.equal(response.decision.outcome, 'allow');
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_GRANT_MISSING');
    assert.equal(response.plan, null);
  });
});

describe('grant binding', () => {
  it('refuses a grant issued for a different target', () => {
    const target = processTarget();
    const other = processTarget({ object_id: 'BBBBBBBBBBBBBBBBBBBBBB' });
    const base = envelopeFor({ target });
    const grant = buildGrant({
      parametersDigest: base.grant.value.parameters_digest,
      targetDigest: other.digest,
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, grant }));
    assert.equal(response.code, 'DENY_GRANT_TARGET_DRIFT');
  });

  it('refuses a grant issued for different parameters', () => {
    const target = processTarget();
    const base = envelopeFor({ target });
    const grant = buildGrant({
      parametersDigest: base.grant.value.parameters_digest,
      targetDigest: target.digest,
    });
    const response = createHelper({ target }).prepare(
      envelopeFor({ target, parameters: { grace_period_ms: 0 } }),
    );
    // The fixture built its own grant for the original parameters; splice the old
    // one in to model "parameters replaced after approval".
    const spliced = createHelper({ target }).prepare(
      envelopeFor({ target, parameters: { grace_period_ms: 0 }, grant }),
    );
    assert.equal(spliced.code, 'DENY_GRANT_PARAMETERS_DRIFT');
    assert.equal(response.status, 'planned');
  });

  it('refuses a grant issued for another execution, even though the policy gate does not compare that field', () => {
    const target = processTarget();
    const base = envelopeFor({ target });
    const grant = buildGrant({
      parametersDigest: base.grant.value.parameters_digest,
      targetDigest: target.digest,
      executionId: OTHER_EXECUTION_ID,
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, grant }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_BINDING_MISMATCH');
    assert.deepEqual(response.detail, { field: 'execution_id' });
  });

  it('refuses a grant from another epoch', () => {
    const target = processTarget();
    const base = envelopeFor({ target });
    const grant = buildGrant({
      parametersDigest: base.grant.value.parameters_digest,
      targetDigest: target.digest,
      epoch: OTHER_EPOCH,
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, grant }));
    assert.equal(response.code, 'DENY_GRANT_EPOCH');
  });
});

describe('grant signature', () => {
  it('blocks the plan when no trust root can verify the signature', () => {
    const target = processTarget();
    const helper = createHelper({ target, grantVerifier: createNullGrantVerifier() });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'blocked');
    assert.equal(response.code, 'HELPER_GRANT_UNVERIFIED');
    assert.equal(response.plan.grant.signature_verified, false);
    assert.equal(response.plan.grant.signature_source, 'null');
    assert.equal(response.plan.grant_valid, false);
    assert.equal(response.plan.ready_for_execution, false);
    assert.equal(response.plan.executable, false);
  });

  it('treats a throwing verifier as unverified, never as verified', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      grantVerifier: {
        source: 'broken',
        verify() {
          throw new Error('trust store unreadable');
        },
      },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.code, 'HELPER_GRANT_UNVERIFIED');
    assert.equal(response.plan.grant.signature_verified, false);
  });

  it('marks a verified grant as verified but still not executable', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(envelopeFor({ target }));
    assert.equal(response.plan.grant.signature_verified, true);
    assert.equal(response.plan.grant_valid, true);
    assert.equal(response.plan.ready_for_execution, true);
    assert.equal(response.plan.executable, false);
  });
});

describe('replay and duplicate execution', () => {
  it('refuses a grant nonce already spent by this helper', () => {
    const target = processTarget();
    const inbox = createMemoryInbox();
    const helper = createHelper({ target, inbox });
    const first = helper.prepare(envelopeFor({ target }));
    assert.equal(first.status, 'planned');

    const base = envelopeFor({ target, executionId: OTHER_EXECUTION_ID });
    const replayed = buildGrant({
      parametersDigest: base.grant.value.parameters_digest,
      targetDigest: target.digest,
      executionId: OTHER_EXECUTION_ID,
      nonce: GRANT_NONCE,
    });
    const second = helper.prepare(envelopeFor({ target, executionId: OTHER_EXECUTION_ID, grant: replayed }));
    assert.equal(second.status, 'refused');
    assert.equal(second.code, 'HELPER_NONCE_REPLAY');
  });

  it('refuses a second attempt id claiming an execution already accepted', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    helper.prepare(envelopeFor({ target }));
    const second = helper.prepare(envelopeFor({ target, attemptId: OTHER_ATTEMPT_ID }));
    assert.equal(second.status, 'refused');
    assert.equal(second.code, 'HELPER_EXECUTION_CONFLICT');
    assert.deepEqual(second.detail, { reason: 'attempt_id_mismatch' });
  });

  it('tracks exactly one execution for a redelivered dispatch', () => {
    const target = processTarget();
    const inbox = createMemoryInbox();
    const helper = createHelper({ target, inbox });
    const envelope = envelopeFor({ target });
    const first = helper.prepare(envelope);
    const second = helper.prepare(envelope);
    const third = helper.prepare(envelope);
    assert.equal(inbox.size(), 1);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(third.plan.plan_id, first.plan.plan_id);
    assert.equal(inbox.lookup(EXECUTION_ID).state, 'planned');
  });

  it('keeps the approval nonce and the grant nonce distinct', () => {
    const target = processTarget();
    const base = envelopeFor({ target });
    const grant = buildGrant({
      parametersDigest: base.grant.value.parameters_digest,
      targetDigest: target.digest,
      nonce: APPROVAL_NONCE,
    });
    const response = createHelper({ target }).prepare(envelopeFor({ target, grant }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'DENY_GRANT_APPROVAL_MISMATCH');
  });
});

describe('mutating actions need a grant (P1-4)', () => {
  // Round 3 measured a `ready_for_execution: true` dispatch with no grant at all:
  // Linux `process.suspend` is the one catalog action that mutates the target while
  // `requiresApproval: false`, so the policy gate allows it and the helper used to
  // plan it. Six of the seven bindings design §10.2 asks for were absent — only the
  // allowlist and the target were checked.

  /**
   * @returns {object} A Linux suspend envelope with no proposal/approval/grant.
   */
  function suspendEnvelope() {
    const target = processTarget({ os: 'linux' });
    return {
      target,
      envelope: envelopeFor({ actionId: 'process.suspend', os: 'linux', target }),
    };
  }

  it('refuses a zero-grant suspend instead of planning it', () => {
    const { target, envelope } = suspendEnvelope();
    // The policy verdict is consumed, not re-derived: it still says allow.
    const response = createHelper({ os: 'linux', target }).prepare(envelope);
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_GRANT_MISSING');
    assert.equal(response.detail.reason, 'mutating_action_requires_a_grant');
    assert.equal(response.plan, null);
    assert.equal(response.executable, false);
    assert.equal(response.authorizes_execution, false);
  });

  it('never returns ready_for_execution for a mutating action without a grant', () => {
    const { target, envelope } = suspendEnvelope();
    const response = createHelper({ os: 'linux', target }).dryRun(envelope);
    assert.equal(response.plan, null);
    assert.equal(response.dry_run_plan, null);
  });

  it('refuses a suspend grant too, because policy denies a grant with no approval', () => {
    const { target } = suspendEnvelope();
    const parameters = paramsFor('process.suspend', undefined, 'linux');
    const grant = buildGrant({
      actionId: 'process.suspend',
      parametersDigest: parameters.digest,
      targetDigest: target.digest,
    });
    const envelope = envelopeFor({ actionId: 'process.suspend', os: 'linux', target, grant });
    const response = createHelper({ os: 'linux', target }).prepare(envelope);
    // Documented consequence, not a helper bug: the policy layer treats a grant as
    // "consumes an approval" and denies one without it. Until the catalog marks
    // `process.suspend` as requiring approval, suspend is unplannable — denied is a
    // safe answer, `ready_for_execution: true` was not.
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'DENY_GRANT_APPROVAL_MISMATCH');
    assert.equal(response.plan, null);
  });

  it('refuses every mutating action once its grant is removed', () => {
    const cases = [
      { actionId: 'process.suspend', os: 'linux', target: processTarget({ os: 'linux' }) },
      { actionId: 'process.terminate', os: 'windows', target: processTarget() },
      { actionId: 'network.block_connection', os: 'windows', target: networkTarget() },
      { actionId: 'network.isolate', os: 'windows', target: networkTarget() },
      { actionId: 'file.quarantine', os: 'windows', target: fileTarget() },
    ];
    for (const entry of cases) {
      const envelope = envelopeFor({ actionId: entry.actionId, os: entry.os, target: entry.target });
      delete envelope.grant;
      const helper = createHelper({ os: entry.os, target: entry.target });
      const response = helper.prepare(envelope);
      assert.equal(response.status, 'refused', `${entry.actionId} must not be planned without a grant`);
      assert.equal(response.code, 'HELPER_GRANT_MISSING', entry.actionId);
      assert.equal(response.plan, null, entry.actionId);
    }
  });

  it('leaves the alert-only action planable without a grant, and says grant_valid is false', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(alertEnvelope(target));
    // The new rule must not become "everything needs a grant": the alert-only path
    // touches no object, so there is nothing for a grant to authorise.
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.would_mutate_target, false);
    assert.equal(response.plan.grant.present, false);
    assert.equal(response.plan.grant_valid, false);
    assert.equal(response.plan.ready_for_execution, true);
  });

  it('still plans an approved terminate whose grant verified', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(envelopeFor({ target }));
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.would_mutate_target, true);
    assert.equal(response.plan.grant_valid, true);
    assert.equal(response.plan.ready_for_execution, true);
  });
});

describe('inbox capacity', () => {
  it('refuses a new claim when the dedupe inbox is full, instead of evicting a tombstone', () => {
    const target = processTarget();
    const inbox = createMemoryInbox({ maxEntries: 1 });
    const helper = createHelper({ target, inbox });
    const first = helper.prepare(envelopeFor({ target }));
    assert.equal(first.status, 'planned');

    const secondBase = envelopeFor({
      target,
      executionId: OTHER_EXECUTION_ID,
      attemptId: OTHER_ATTEMPT_ID,
    });
    // A distinct nonce, so the capacity check is what fires — a reused nonce would
    // (correctly) be reported as a replay first.
    const secondGrant = buildGrant({
      parametersDigest: secondBase.grant.value.parameters_digest,
      targetDigest: target.digest,
      executionId: OTHER_EXECUTION_ID,
      nonce: 'grant-nonce-000000000002',
    });
    const second = helper.prepare(envelopeFor({
      target,
      executionId: OTHER_EXECUTION_ID,
      attemptId: OTHER_ATTEMPT_ID,
      grant: secondGrant,
    }));
    assert.equal(second.status, 'refused');
    assert.equal(second.code, 'HELPER_INBOX_FULL');

    // The first execution's tombstone must still be there: evicting it would have
    // turned a redelivery into a fresh plan and disabled attempt-conflict detection.
    assert.equal(inbox.size(), 1);
    assert.ok(inbox.lookup(EXECUTION_ID));
    const redelivered = helper.prepare(envelopeFor({ target }));
    assert.equal(redelivered.duplicate, true);
    assert.equal(redelivered.plan.plan_id, first.plan.plan_id);
  });
});
