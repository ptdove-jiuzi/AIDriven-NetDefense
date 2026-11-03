/**
 * OS family and permission capability: the two questions that decide whether a
 * plan is even addressable on this host.
 *
 * The rule under test is fail-closed in both directions: an OS family the helper
 * cannot name refuses the dispatch, and a privilege it cannot prove is a blocked
 * plan (`granted` is the only usable answer — `unknown` is not "probably fine").
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createFixedClock,
  createNullCapabilityProbe,
  createResponseHelper,
  createStaticOsProbe,
} from '../../apps/response-helper/index.js';
import {
  ALL_GRANTED,
  NOW,
  createHelper,
  envelopeFor,
  fileTarget,
  networkTarget,
  processTarget,
} from './helpers.js';

describe('OS family', () => {
  it('refuses every dispatch when the host family cannot be determined', () => {
    const target = processTarget();
    const helper = createHelper({ target, osProbe: createStaticOsProbe('solaris') });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_OS_UNKNOWN');
    assert.equal(response.plan, null);
  });

  it('treats a throwing OS probe as undetermined rather than guessing', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      osProbe: {
        source: 'broken',
        osFamily() {
          throw new Error('probe exploded');
        },
      },
    });
    assert.equal(helper.prepare(envelopeFor({ target })).code, 'HELPER_OS_UNKNOWN');
  });

  it('refuses a dispatch for another OS family than the host', () => {
    const target = processTarget({ os: 'linux' });
    // `process.terminate` on purpose: it carries a grant, so this test is about the
    // host/declaration mismatch and nothing else. `process.suspend` is no longer
    // planable at all (see grant.test.js: a mutating action needs a grant, and the
    // policy layer denies a grant for an action that requires no approval).
    const envelope = envelopeFor({ os: 'linux', target });
    const onLinux = createHelper({ os: 'linux', target });
    assert.equal(onLinux.prepare(envelope).status, 'planned');

    const onWindows = createHelper({ os: 'windows', target });
    const response = onWindows.prepare(envelope);
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_OS_MISMATCH');
    assert.deepEqual(response.detail, { declared: 'linux', host: 'windows' });
  });

  it('leaves a target/host OS disagreement to the policy gate', () => {
    // The helper checks host vs dispatch. A Linux target inside a Windows dispatch
    // is a policy question, and the policy vocabulary is the audited one.
    const target = fileTarget({ os: 'linux' });
    const helper = createHelper({ os: 'windows', target });
    const response = helper.prepare(envelopeFor({ actionId: 'file.quarantine', os: 'windows', target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'DENY_TARGET_OS_MISMATCH');
  });

  it('plans a Linux dispatch on a Linux host', () => {
    const target = fileTarget({ os: 'linux' });
    const helper = createHelper({ os: 'linux', target });
    const response = helper.prepare(envelopeFor({ actionId: 'file.quarantine', os: 'linux', target }));
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.os, 'linux');
  });
});

describe('capability probing', () => {
  it('blocks the plan when the action privilege is explicitly denied', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      capabilities: { ...ALL_GRANTED, process_control: 'denied' },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'blocked');
    assert.equal(response.code, 'HELPER_CAPABILITY_DENIED');
    assert.equal(response.plan.ready_for_execution, false);
    assert.equal(response.plan.executable, false);
    assert.deepEqual([...response.plan.capabilities.missing], ['process_control']);
    assert.equal(response.plan.capabilities.satisfied, false);
  });

  it('treats an unknown privilege as unusable, not as probably granted', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      capabilities: { ...ALL_GRANTED, process_control: 'unknown' },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'blocked');
    assert.equal(response.code, 'HELPER_CAPABILITY_UNKNOWN');
  });

  it('treats a silently absent privilege as unknown', () => {
    const target = processTarget();
    const helper = createHelper({ target, capabilities: {} });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'blocked');
    assert.equal(response.code, 'HELPER_CAPABILITY_UNKNOWN');
  });

  it('asks for the capability the action actually needs', () => {
    const cases = [
      { actionId: 'process.terminate', target: processTarget, denied: 'process_control' },
      { actionId: 'network.isolate', target: networkTarget, denied: 'network_control' },
      { actionId: 'file.quarantine', target: fileTarget, denied: 'file_control' },
    ];
    for (const entry of cases) {
      const target = entry.target();
      const helper = createHelper({
        target,
        capabilities: { ...ALL_GRANTED, [entry.denied]: 'denied' },
      });
      const response = helper.prepare(envelopeFor({ actionId: entry.actionId, target }));
      assert.equal(response.status, 'blocked', `${entry.actionId} must block on ${entry.denied}`);
      assert.deepEqual([...response.plan.capabilities.missing], [entry.denied]);
      assert.deepEqual([...response.plan.capabilities.required], [entry.denied]);
    }
  });

  it('plans an alert-only action even when every privilege is denied', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      capabilities: { process_control: 'denied', network_control: 'denied', file_control: 'denied' },
    });
    const envelope = envelopeFor({ actionId: 'observe.record_alert', actorRoles: ['viewer'], target });
    const response = helper.prepare(envelope);
    assert.equal(response.status, 'planned');
    assert.deepEqual([...response.plan.capabilities.required], []);
  });

  it('refuses when the capability probe breaks its own contract', () => {
    const target = processTarget();
    for (const broken of ['granted', 42, null, []]) {
      const helper = createHelper({
        target,
        capabilityProbe: { source: 'broken', capabilities: () => broken },
      });
      const response = helper.prepare(envelopeFor({ target }));
      assert.equal(response.status, 'refused');
      assert.equal(response.code, 'HELPER_PROBE_INVALID');
    }
  });

  it('refuses an undeclared capability state', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      capabilityProbe: { source: 'broken', capabilities: () => ({ process_control: 'probably' }) },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.code, 'HELPER_PROBE_INVALID');
  });

  it('refuses when the capability probe throws', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      capabilityProbe: {
        source: 'broken',
        capabilities() {
          throw new Error('access denied while querying');
        },
      },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_PROBE_INVALID');
  });

  it('passes a bounded context to the probe, never the target path', () => {
    const target = processTarget();
    let seen = null;
    const helper = createHelper({
      target,
      capabilityProbe: {
        source: 'recording',
        capabilities(request) {
          seen = request;
          return ALL_GRANTED;
        },
      },
    });
    helper.prepare(envelopeFor({ target }));
    assert.equal(seen.os, 'windows');
    assert.equal(seen.actionId, 'process.terminate');
    assert.equal(seen.target.kind, 'process');
    assert.equal(seen.target.digest, target.digest);
    // The probe needs to know which surface to check, not where the object is.
    assert.equal(JSON.stringify(seen).includes('TestSandbox'), false);
    assert.equal(JSON.stringify(seen).includes('sample.exe'), false);
  });

  it('a helper built with no probe ports can never plan a mutating dispatch', () => {
    const target = processTarget();
    // Only a clock is injected, so the dispatch is judged by the fail-closed
    // defaults: no privileges known, no way to confirm the object exists.
    const bare = createResponseHelper({ clock: createFixedClock(NOW) });
    const response = bare.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_TARGET_UNVERIFIABLE');
    assert.equal(response.plan, null);
    assert.equal(bare.describe().build.execution_enabled, false);
  });

  it('the default capability probe answers unknown for every surface', () => {
    const probe = createNullCapabilityProbe();
    const table = probe.capabilities({});
    assert.deepEqual(table, {
      process_control: 'unknown',
      network_control: 'unknown',
      file_control: 'unknown',
    });
  });
});
