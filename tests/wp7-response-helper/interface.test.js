/**
 * The narrow daemon ↔ helper interface: four methods, one closed envelope.
 *
 * The tests that matter here are the negative ones. A dry-run helper whose
 * interface can be widened by a field (`execute: true`, `dryRun: false`,
 * `force: true`) is a dry-run helper with a one-line bypass, so every such field
 * is asserted to be a refusal rather than "ignored".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENVELOPE_KEYS,
  HELPER_METHODS,
  INTERFACE_VERSION,
  createStaticOsProbe,
  validateEnvelope,
} from '../../apps/response-helper/index.js';
import {
  ATTEMPT_ID,
  EXECUTION_ID,
  OTHER_ATTEMPT_ID,
  OTHER_EXECUTION_ID,
  createHelper,
  envelopeFor,
  processTarget,
} from './helpers.js';

const RESULT_KEYS = Object.freeze([
  'authorizes_execution',
  'code',
  'decision',
  'detail',
  'dry_run',
  'duplicate',
  'executable',
  'performed',
  'plan',
  'status',
]);

describe('interface: describe', () => {
  it('publishes exactly the four documented methods and nothing else', () => {
    const helper = createHelper({ target: processTarget() });
    assert.deepEqual([...HELPER_METHODS], ['describe', 'prepare', 'dryRun', 'executeStub']);
    assert.deepEqual(Object.keys(helper).sort(), ['describe', 'dryRun', 'executeStub', 'prepare']);
    assert.equal(Object.isFrozen(helper), true);
  });

  it('reports this build as dry-run only, with execution compiled out', () => {
    const helper = createHelper();
    const description = helper.describe();
    assert.equal(description.build.execution_enabled, false);
    assert.equal(description.build.dry_run_only, true);
    assert.equal(description.build.mode, 'dry_run_only');
    assert.equal(description.interface.dryRunOnly, true);
    assert.equal(description.interface.authorizesExecution, false);
    assert.equal(description.interface_version, INTERFACE_VERSION);
  });

  it('reports the host OS family from the probe, not from the request', () => {
    assert.equal(createHelper({ os: 'linux' }).describe().host.os_family, 'linux');
    assert.equal(createHelper({ os: 'windows' }).describe().host.os_family, 'windows');
    assert.equal(
      createHelper({ osProbe: createStaticOsProbe('solaris') }).describe().host.os_family,
      'unsupported',
    );
  });

  it('describes every allowlisted action with the facts the daemon needs', () => {
    const description = createHelper().describe();
    assert.equal(description.actions.length, 6);
    for (const action of description.actions) {
      assert.equal(typeof action.action_id, 'string');
      assert.deepEqual(Object.keys(action.os_support).sort(), ['linux', 'windows']);
      assert.equal(Array.isArray(action.required_capabilities), true);
      assert.equal(typeof action.irreversible, 'boolean');
      assert.equal(typeof action.requires_approval, 'boolean');
      assert.equal(typeof action.would_mutate_target, 'boolean');
    }
    const suspend = description.actions.find((entry) => entry.action_id === 'process.suspend');
    assert.equal(suspend.os_support.windows.status, 'unsupported');
    assert.equal(suspend.irreversible, false);
    const terminate = description.actions.find((entry) => entry.action_id === 'process.terminate');
    assert.equal(terminate.irreversible, true);
    assert.equal(terminate.requires_approval, true);
  });

  it('is a frozen value tree, so a caller cannot mutate the contract', () => {
    const description = createHelper().describe();
    assert.equal(Object.isFrozen(description), true);
    assert.equal(Object.isFrozen(description.interface), true);
    assert.equal(Object.isFrozen(description.actions), true);
    assert.throws(() => {
      'use strict';
      description.actions[0].irreversible = true;
    }, TypeError);
  });
});

describe('interface: envelope validation', () => {
  it('accepts the full declared envelope', () => {
    const envelope = validateEnvelope(envelopeFor({ target: processTarget() }));
    assert.equal(Object.isFrozen(envelope), true);
    assert.equal(envelope.schemaVersion, INTERFACE_VERSION);
    assert.equal(envelope.execution_id, EXECUTION_ID);
    assert.equal(envelope.attempt_id, ATTEMPT_ID);
    assert.deepEqual(Object.keys(envelope).sort(), [...ENVELOPE_KEYS].sort());
  });

  it('refuses a non-object envelope instead of throwing', () => {
    const helper = createHelper({ target: processTarget() });
    for (const value of [null, undefined, 'dispatch', 42, [], true]) {
      const response = helper.prepare(value);
      assert.equal(response.status, 'refused');
      assert.equal(response.code, 'HELPER_ENVELOPE_INVALID');
      assert.equal(response.plan, null);
    }
  });

  it('refuses an undeclared field: this is the one-line bypass a permissive parser would allow', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const base = envelopeFor({ target });
    for (const injected of [
      { execute: true },
      { dryRun: false },
      { force: true },
      { allowReal: true },
      { skipApproval: true },
      { command: 'cmd.exe /c whoami' },
      { argv: ['-9', '4321'] },
      { shell: true },
      { env: { PATH: '.' } },
    ]) {
      const response = helper.prepare({ ...base, ...injected });
      assert.equal(response.status, 'refused', `field ${Object.keys(injected)[0]} must be refused`);
      assert.equal(response.code, 'HELPER_ENVELOPE_INVALID');
      assert.equal(response.plan, null);
    }
  });

  it('refuses a symbol key, which a key-name allowlist cannot see', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const envelope = { ...envelopeFor({ target }), [Symbol('execute')]: true };
    const response = helper.prepare(envelope);
    assert.equal(response.code, 'HELPER_ENVELOPE_INVALID');
  });

  it('refuses an unsupported interface version rather than best-effort parsing it', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const response = helper.prepare({ ...envelopeFor({ target }), schemaVersion: '2.0' });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_VERSION_UNSUPPORTED');
  });

  it('refuses malformed identifiers, sequence numbers and timestamps', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const base = envelopeFor({ target });
    const cases = [
      { execution_id: 'not-a-uuid' },
      { attempt_id: 'not-a-uuid' },
      { lease_id: 'short' },
      { sequence: -1 },
      { sequence: 1.5 },
      { os: 'plan9' },
      { now: '2026-11-02 00:00:00' },
      { epoch: 'epoch-1' },
      { actionId: '' },
      { actorRoles: [] },
      { actorRoles: ['responder', 'responder', 'responder', 'responder', 'responder', 'responder'] },
    ];
    for (const patch of cases) {
      const response = helper.prepare({ ...base, ...patch });
      assert.equal(response.status, 'refused', `case ${JSON.stringify(patch)} must be refused`);
      assert.equal(response.plan, null);
    }
  });

  it('refuses a target or parameters value that is not an object', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const base = envelopeFor({ target });
    assert.equal(helper.prepare({ ...base, target: 'C:\\TestSandbox\\x.exe' }).code, 'HELPER_ENVELOPE_INVALID');
    assert.equal(helper.prepare({ ...base, parameters: 'grace_period_ms=0' }).code, 'HELPER_ENVELOPE_INVALID');
    assert.equal(helper.prepare({ ...base, proposal: 'approved' }).code, 'HELPER_ENVELOPE_INVALID');
  });

  it('never invokes a caller getter: an accessor in the envelope is refused outright', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    let reads = 0;
    const hostile = { ...envelopeFor({ target }) };
    Object.defineProperty(hostile, 'target', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        throw new Error('boom');
      },
    });
    let response;
    assert.doesNotThrow(() => {
      response = helper.prepare(hostile);
    });
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_ENVELOPE_INVALID');
    // The value is read through a data descriptor, so the getter is never called:
    // a getter that answers once for the gate and once for the helper cannot exist.
    assert.equal(reads, 0);
  });

  it('snapshots nested values, so mutating the caller object afterwards changes nothing', () => {
    const target = processTarget();
    const base = envelopeFor({ target });
    // The contracts validator freezes its own record, so build a mutable one to
    // model a caller that keeps a handle on the object it dispatched.
    const mutableGrant = { ...base.grant, value: { ...base.grant.value } };
    const validated = validateEnvelope({ ...base, grant: mutableGrant });
    const before = validated.grant.value.execution_id;
    mutableGrant.value.execution_id = '00000000-0000-4000-8000-000000000000';
    assert.equal(before, EXECUTION_ID);
    assert.equal(validated.grant.value.execution_id, before);
    assert.equal(Object.isFrozen(validated.grant.value), true);
    assert.equal(Object.isFrozen(validated.actorRoles), true);
  });

  it('never echoes a raw path back through the decision it returns', () => {
    const target = processTarget();
    const base = envelopeFor({ target });
    // A traversal target: the policy gate refuses it and, internally, its `detail`
    // quotes the offending value. That value must not travel back out to a log.
    const hostileTarget = {
      os: 'windows',
      kind: 'file',
      path: 'C:\\TestSandbox\\..\\evil.exe',
      object_id: 'AAAAAAAAAAAAAAAAAAAAAA',
      object_id_source: 'file_handle',
    };
    const response = createHelper({ target }).prepare({ ...base, target: hostileTarget });
    assert.equal(response.status, 'refused');
    assert.equal(response.code.startsWith('DENY_TARGET_'), true);
    assert.equal(JSON.stringify(response).includes('evil.exe'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response.decision, 'detail'), false);
  });

  it('returns exactly the documented result shape for every status', () => {
    const target = processTarget();
    const planned = createHelper({ target }).prepare(envelopeFor({ target }));
    const refused = createHelper({ target }).prepare(null);
    const blocked = createHelper({ target, capabilities: { process_control: 'denied' } }).prepare(
      envelopeFor({ target, executionId: OTHER_EXECUTION_ID, attemptId: OTHER_ATTEMPT_ID }),
    );
    const dryRunOnly = createHelper({ target }).executeStub();
    const outcomes = [planned, refused, blocked, dryRunOnly];
    assert.deepEqual(
      outcomes.map((entry) => entry.status),
      ['planned', 'refused', 'blocked', 'dry_run_only'],
    );
    for (const outcome of outcomes) {
      assert.deepEqual(Object.keys(outcome).sort(), [...RESULT_KEYS].sort(), outcome.status);
    }
  });
});

describe('interface: idempotent redelivery', () => {
  it('returns the original outcome for a redelivered execution/attempt', () => {
    const target = processTarget();
    const helper = createHelper({ target });
    const envelope = envelopeFor({ target });
    const first = helper.prepare(envelope);
    const second = helper.prepare(envelope);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.status, first.status);
    assert.equal(second.plan.plan_id, first.plan.plan_id);
  });

  it('does not recompute a refusal on redelivery', () => {
    const target = processTarget();
    const now = '2026-11-02T09:00:00Z';
    const helper = createHelper({ target, now });
    const envelope = { ...envelopeFor({ target }), now };
    const first = helper.prepare(envelope);
    assert.equal(first.status, 'refused');
    const second = helper.prepare(envelope);
    assert.equal(second.status, 'refused');
    assert.equal(second.code, first.code);
    assert.equal(second.duplicate, true);
  });
});
