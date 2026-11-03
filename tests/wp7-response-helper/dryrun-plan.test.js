/**
 * The dry-run plan: what the helper would do, written down before anything does.
 *
 * Two things this file pins down that prose cannot:
 *
 *   - the manifest step precedes the OS action step, because design §10.2 makes
 *     "record first, act second" the crash-recovery boundary;
 *   - the plan carries digests, never raw paths, addresses or parameter values, so
 *     a plan that is logged or shown in a console cannot leak local paths or echo
 *     attacker-supplied text back into a terminal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXECUTION_ENABLED,
  STEP_KINDS,
  createMemoryManifestStore,
  planSummary,
  stepsFor,
} from '../../apps/response-helper/index.js';
import {
  WINDOWS_IMAGE_PATH,
  alertEnvelope,
  createHelper,
  envelopeFor,
  fileTarget,
  networkTarget,
  processTarget,
} from './helpers.js';

describe('dry-run plan: structure', () => {
  it('is a frozen document that says, in four separate fields, that it cannot execute', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(envelopeFor({ target }));
    assert.equal(response.status, 'planned');
    const plan = response.plan;
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.executable, false);
    assert.equal(plan.execution_disabled, true);
    assert.equal(plan.authorizes_execution, false);
    assert.equal(EXECUTION_ENABLED, false);
  });

  it('binds the plan to the execution, attempt, lease and sequence it answers', () => {
    const target = processTarget();
    const envelope = envelopeFor({ target });
    const plan = createHelper({ target }).prepare(envelope).plan;
    assert.equal(plan.execution_id, envelope.execution_id);
    assert.equal(plan.attempt_id, envelope.attempt_id);
    assert.equal(plan.lease_id, envelope.lease_id);
    assert.equal(plan.sequence, envelope.sequence);
    assert.equal(plan.interface_version, '1.0');
  });

  it('summarises the policy verdict instead of re-deriving it', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(envelopeFor({ target }));
    assert.equal(response.decision.outcome, 'allow');
    assert.equal(response.plan.policy.outcome, 'allow');
    assert.equal(response.plan.policy.reason_code, 'ALLOWED');
    assert.equal(response.plan.policy.target_digest, target.digest);
    assert.equal(response.plan.policy.risk, 'critical');
    assert.equal(response.plan.policy.required_role, 'responder');
    assert.equal(response.plan.policy.requires_approval, true);
  });

  it('produces a stable plan id for the same dispatch', () => {
    const target = processTarget();
    const envelope = envelopeFor({ target });
    const a = createHelper({ target }).prepare(envelope).plan.plan_id;
    const b = createHelper({ target }).prepare(envelope).plan.plan_id;
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/u);
  });

  it('produces a different plan id when the target object changes', () => {
    const first = createHelper({ target: processTarget() });
    const second = createHelper({ target: processTarget({ object_id: 'BBBBBBBBBBBBBBBBBBBBBB' }) });
    const a = first.prepare(envelopeFor({ target: processTarget() })).plan.plan_id;
    const b = second.prepare(envelopeFor({ target: processTarget({ object_id: 'BBBBBBBBBBBBBBBBBBBBBB' }) })).plan.plan_id;
    assert.notEqual(a, b);
  });
});

describe('dry-run plan: steps', () => {
  it('numbers the steps and keeps only declared step kinds', () => {
    const steps = stepsFor('process.terminate');
    assert.deepEqual(steps.map((step) => step.index), [1, 2, 3, 4, 5]);
    for (const step of steps) {
      assert.ok(STEP_KINDS.includes(step.kind), `undeclared step kind ${step.kind}`);
      assert.equal(Object.isFrozen(step), true);
    }
  });

  it('records the recovery manifest before the OS action step', () => {
    const steps = stepsFor('process.terminate');
    const manifestIndex = steps.findIndex((step) => step.kind === 'record_manifest');
    const actionIndex = steps.findIndex((step) => step.kind === 'os_action');
    assert.ok(manifestIndex >= 0, 'a mutating plan must record a manifest');
    assert.ok(actionIndex > manifestIndex, 'the manifest must precede the side effect');
  });

  it('marks exactly one mutating step and attaches the capability it needs', () => {
    for (const actionId of [
      'process.terminate',
      'network.block_connection',
      'network.isolate',
      'file.quarantine',
    ]) {
      const mutating = stepsFor(actionId).filter((step) => step.would_mutate);
      assert.equal(mutating.length, 1, `${actionId} must declare one mutating step`);
      assert.equal(mutating[0].kind, 'os_action');
      assert.equal(mutating[0].requires.length, 1);
    }
    assert.equal(stepsFor('observe.record_alert').some((step) => step.would_mutate), false);
  });

  it('keeps step text static: a parameter value never reaches the plan', () => {
    const target = processTarget();
    const envelope = envelopeFor({ target, parameters: { grace_period_ms: 59999 } });
    const plan = createHelper({ target }).prepare(envelope).plan;
    assert.equal(JSON.stringify(plan.steps).includes('59999'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(plan, 'parameters'), false);
    for (const step of plan.steps) {
      assert.equal(step.description, stepsFor(plan.action_id)[step.index - 1].description);
    }
  });

  it('keeps raw paths out of the plan', () => {
    const target = processTarget();
    const plan = createHelper({ target }).prepare(envelopeFor({ target })).plan;
    const serialised = JSON.stringify(plan);
    assert.equal(serialised.includes('TestSandbox'), false);
    assert.equal(serialised.includes(WINDOWS_IMAGE_PATH), false);
    assert.equal(serialised.includes('sample.exe'), false);
  });

  it('keeps a quarantine destination path out of the plan', () => {
    const target = fileTarget();
    const envelope = envelopeFor({ actionId: 'file.quarantine', target });
    const plan = createHelper({ target }).prepare(envelope).plan;
    const serialised = JSON.stringify(plan);
    assert.equal(serialised.includes('invoice.pdf'), false);
    assert.equal(serialised.includes('AegisHarness'), false);
  });
});

describe('dry-run plan: effects and manifest', () => {
  it('declares replacement of the target as irreversible for a terminate', () => {
    const target = processTarget();
    const plan = createHelper({ target }).prepare(envelopeFor({ target })).plan;
    assert.equal(plan.would_mutate_target, true);
    assert.equal(plan.irreversible, true);
  });

  it('records a prepared recovery manifest for a mutating action', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(envelopeFor({ target }));
    const manifest = response.plan.manifest;
    assert.ok(manifest, 'a mutating plan must carry a manifest');
    assert.equal(manifest.phase, 'prepared');
    assert.equal(manifest.action_id, 'process.terminate');
    assert.equal(manifest.execution_id, response.plan.execution_id);
    assert.equal(manifest.attempt_id, response.plan.attempt_id);
    assert.equal(manifest.operation_id, target.objectId);
    assert.equal(manifest.target_digest, target.digest);
    assert.equal(manifest.expected_state, 'terminated');
    assert.equal(manifest.durable, true);
    assert.equal(Object.isFrozen(manifest), true);
  });

  it('records no manifest for an alert-only action', () => {
    const target = processTarget();
    const response = createHelper({ target }).prepare(alertEnvelope(target));
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.manifest, null);
    assert.equal(response.plan.would_mutate_target, false);
  });

  it('blocks the plan when the manifest cannot be made durable', () => {
    const target = processTarget();
    const response = createHelper({ target, manifestDurable: false }).prepare(envelopeFor({ target }));
    // The packaged store is deliberately non-durable; a real writer must be
    // injected explicitly. Design §10.2 forbids a side effect before the flush.
    assert.equal(response.status, 'blocked');
    assert.equal(response.code, 'HELPER_MANIFEST_UNAVAILABLE');
    assert.equal(response.plan.manifest.durable, false);
    assert.equal(response.plan.ready_for_execution, false);
    assert.equal(response.plan.executable, false);
  });

  it('the packaged manifest store can never claim durability, whatever it is passed', () => {
    const target = processTarget();
    const store = createMemoryManifestStore({ durable: true });
    const entry = store.record({
      execution_id: '55555555-5555-4555-8555-555555555555',
      attempt_id: '88888888-8888-4888-8888-888888888888',
      operation_id: 'AAAAAAAAAAAAAAAAAAAAAA',
      action_id: 'process.terminate',
      target_digest: target.digest,
      object_identity: { kind: 'process' },
      prior_state: { state: 'present' },
      expected_state: 'terminated',
    });
    assert.equal(entry.durable, false);
    assert.equal(entry.phase, 'prepared');
  });

  it('records no manifest at all when the dispatch is already blocked', () => {
    const target = processTarget();
    const response = createHelper({
      target,
      capabilities: { process_control: 'denied' },
    }).prepare(envelopeFor({ target }));
    assert.equal(response.status, 'blocked');
    // A blocked dispatch is never going to run, so a real durable store must not be
    // left holding a recovery intent that will only ever read `manual_required`.
    assert.equal(response.plan.manifest, null);
    assert.ok(response.plan.notes.includes('recovery manifest not recorded: the dispatch is already blocked'));
  });
});

describe('dry-run document', () => {
  it('adds effects and a simulated before/after without performing anything', () => {
    const target = processTarget();
    const response = createHelper({ target }).dryRun(envelopeFor({ target }));
    assert.equal(response.status, 'planned');
    const document = response.dry_run_plan;
    assert.ok(document);
    assert.equal(document.side_effects_performed, false);
    assert.equal(document.effects.would_mutate_target, true);
    assert.equal(document.effects.irreversible, true);
    assert.equal(document.effects.touches_process, true);
    assert.equal(document.effects.touches_network, false);
    assert.equal(document.effects.touches_file, false);
    assert.equal(document.simulated_state_before, 'present');
    assert.equal(document.simulated_state_after, 'terminated');
    assert.equal(response.summary.plan_id, response.plan.plan_id);
    assert.equal(response.summary.authorizes_execution, false);
  });

  it('reports network and file effects for their actions', () => {
    const network = networkTarget();
    const networkResponse = createHelper({ target: network }).dryRun(
      envelopeFor({ actionId: 'network.isolate', target: network }),
    );
    assert.equal(networkResponse.dry_run_plan.effects.touches_network, true);
    assert.equal(networkResponse.dry_run_plan.simulated_state_after, 'isolated_owned');

    const file = fileTarget();
    const fileResponse = createHelper({ target: file }).dryRun(
      envelopeFor({ actionId: 'file.quarantine', target: file }),
    );
    assert.equal(fileResponse.dry_run_plan.effects.touches_file, true);
    assert.equal(fileResponse.dry_run_plan.simulated_state_after, 'relocated_to_quarantine');
  });

  it('leaves the simulated state unchanged for an alert-only action', () => {
    const target = processTarget();
    const response = createHelper({ target }).dryRun(alertEnvelope(target));
    assert.equal(response.dry_run_plan.simulated_state_before, 'present');
    assert.equal(response.dry_run_plan.simulated_state_after, 'present');
    assert.equal(response.dry_run_plan.effects.would_mutate_target, false);
  });

  it('returns no dry-run document when the dispatch is refused', () => {
    const response = createHelper({ target: processTarget() }).dryRun(null);
    assert.equal(response.status, 'refused');
    assert.equal(response.dry_run_plan, null);
    assert.equal(response.summary, null);
  });
});

describe('plan summary', () => {
  it('is flat, audit-safe and never claims authority', () => {
    const target = processTarget();
    const plan = createHelper({ target }).prepare(envelopeFor({ target })).plan;
    const summary = planSummary(plan);
    assert.equal(summary.authorizes_execution, false);
    assert.equal(summary.dry_run, true);
    assert.equal(summary.executable, false);
    assert.equal(summary.reason_code, 'ALLOWED');
    assert.equal(summary.target_digest, target.digest);
    assert.deepEqual(Object.keys(summary).sort(), [
      'action_id',
      'authorizes_execution',
      'blocked_codes',
      'dry_run',
      'executable',
      'os',
      'plan_id',
      'reason_code',
      'status',
      'target_digest',
      'would_mutate_target',
    ]);
  });
});
