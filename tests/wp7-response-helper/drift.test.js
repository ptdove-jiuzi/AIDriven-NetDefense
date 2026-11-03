/**
 * Target existence, object identity and drift.
 *
 * Design §10.2 forbids acting on a bare PID or a path string: the helper must bind
 * the *object*. These tests exercise the four ways that binding fails in practice —
 * the object is gone, the coordinates now hold a different object, the same PID was
 * reused, or the identity moved — plus the two ways the probe itself fails (denied
 * and malformed), because "cannot verify" must never read as "gone".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DRIFT_REASONS,
  buildSnapshot,
  detectDrift,
  refusalCodeForDrift,
} from '../../apps/response-helper/index.js';
import {
  OTHER_OBJECT_ID,
  alertEnvelope,
  createHelper,
  envelopeFor,
  fileTarget,
  networkTarget,
  observationFor,
  processTarget,
} from './helpers.js';

describe('snapshot', () => {
  it('records the object it saw, by digest, without the raw path', () => {
    const target = processTarget();
    const snapshot = buildSnapshot({
      target,
      observation: observationFor(target),
      capturedAt: '2026-11-02T00:00:00Z',
    });
    assert.equal(snapshot.state, 'present');
    assert.equal(snapshot.target_digest, target.digest);
    assert.equal(snapshot.observed_object_id, target.objectId);
    assert.equal(snapshot.identity_matches, true);
    assert.match(snapshot.observed_identity_digest, /^[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(snapshot).includes('TestSandbox'), false);
    assert.equal(Object.isFrozen(snapshot), true);
  });

  it('refuses a snapshot whose timestamp is not strict RFC3339 UTC', () => {
    const target = processTarget();
    assert.throws(
      () => buildSnapshot({ target, observation: observationFor(target), capturedAt: '2026-11-02 00:00' }),
      /capturedAt/,
    );
  });
});

describe('drift detection', () => {
  it('reports clean when the same object is still there', () => {
    const target = processTarget();
    const snapshot = buildSnapshot({
      target,
      observation: observationFor(target),
      capturedAt: '2026-11-02T00:00:00Z',
    });
    const drift = detectDrift({ target, snapshot });
    assert.equal(drift.status, 'clean');
    assert.deepEqual([...drift.reasons], []);
    assert.equal(refusalCodeForDrift(drift), null);
  });

  it('names the four failure modes distinctly, not as one generic "changed"', () => {
    const process = processTarget();
    const file = fileTarget();
    const network = networkTarget();
    const cases = [
      {
        label: 'missing',
        target: process,
        observation: { state: 'absent', reason: 'not_found' },
        expected: DRIFT_REASONS.TARGET_MISSING,
      },
      {
        label: 'unverifiable',
        target: process,
        observation: { state: 'unverifiable', reason: 'permission_denied' },
        expected: DRIFT_REASONS.TARGET_UNVERIFIABLE,
      },
      {
        label: 'pid reuse',
        target: process,
        observation: observationFor(process, { objectId: OTHER_OBJECT_ID, pid: process.pid }),
        expected: DRIFT_REASONS.PID_REUSE,
      },
      {
        label: 'path replaced',
        target: file,
        observation: observationFor(file, { objectId: OTHER_OBJECT_ID }),
        expected: DRIFT_REASONS.PATH_REPLACED,
      },
      {
        label: 'network object mismatch',
        target: network,
        observation: observationFor(network, { objectId: OTHER_OBJECT_ID }),
        expected: DRIFT_REASONS.OBJECT_ID_MISMATCH,
      },
      {
        label: 'identity drift',
        target: process,
        observation: observationFor(process, {
          identity: { ...process.identity, start_time: '2026-10-02T04:05:06.000Z' },
        }),
        expected: DRIFT_REASONS.IDENTITY_DRIFT,
      },
      {
        label: 'os mismatch',
        target: process,
        observation: observationFor(process, { os: 'linux' }),
        expected: DRIFT_REASONS.OS_MISMATCH,
      },
    ];
    for (const entry of cases) {
      const snapshot = buildSnapshot({
        target: entry.target,
        observation: entry.observation,
        capturedAt: '2026-11-02T00:00:00Z',
      });
      const drift = detectDrift({ target: entry.target, snapshot });
      assert.equal(drift.status, 'drifted', entry.label);
      assert.deepEqual(drift.reasons.map((reason) => reason.code), [entry.expected], entry.label);
      assert.equal(typeof refusalCodeForDrift(drift), 'string', entry.label);
    }
  });
});

describe('target probes in the pipeline', () => {
  it('refuses a mutating dispatch when the target is gone', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      targetProbe: { source: 'static', observe: () => ({ state: 'absent', reason: 'not_found' }) },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_TARGET_MISSING');
    assert.equal(response.plan, null);
    assert.deepEqual(response.detail.drift, [DRIFT_REASONS.TARGET_MISSING]);
  });

  it('refuses when existence could not be established, instead of assuming absence', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      targetProbe: { source: 'static', observe: () => ({ state: 'unverifiable', reason: 'access_denied' }) },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_TARGET_UNVERIFIABLE');
  });

  it('refuses a PID-reuse race on a terminate', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      observation: observationFor(target, { objectId: OTHER_OBJECT_ID }),
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_TARGET_DRIFT');
    assert.deepEqual(response.detail.drift, [DRIFT_REASONS.PID_REUSE]);
  });

  it('refuses a path-replacement race on a quarantine', () => {
    const target = fileTarget();
    const helper = createHelper({
      target,
      observation: observationFor(target, { objectId: OTHER_OBJECT_ID }),
    });
    const response = helper.prepare(envelopeFor({ actionId: 'file.quarantine', target }));
    assert.equal(response.code, 'HELPER_TARGET_DRIFT');
    assert.deepEqual(response.detail.drift, [DRIFT_REASONS.PATH_REPLACED]);
  });

  it('refuses when the object moved even though its id matched', () => {
    const target = fileTarget();
    const helper = createHelper({
      target,
      observation: observationFor(target, { identity: { ...target.identity, path: 'C:\\TestSandbox\\moved.pdf' } }),
    });
    const response = helper.prepare(envelopeFor({ actionId: 'file.quarantine', target }));
    assert.equal(response.code, 'HELPER_TARGET_DRIFT');
    assert.deepEqual(response.detail.drift, [DRIFT_REASONS.IDENTITY_DRIFT]);
  });

  it('refuses when the probe reports another OS family for the object', () => {
    const target = processTarget();
    const helper = createHelper({ target, observation: observationFor(target, { os: 'linux' }) });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.code, 'HELPER_OS_MISMATCH');
  });

  it('refuses a malformed observation rather than treating it as absent', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      targetProbe: { source: 'broken', observe: () => ({ state: 'present' }) },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.status, 'refused');
    assert.equal(response.code, 'HELPER_PROBE_INVALID');
  });

  it('treats a throwing probe as unverifiable', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      targetProbe: {
        source: 'broken',
        observe() {
          throw new Error('handle closed');
        },
      },
    });
    const response = helper.prepare(envelopeFor({ target }));
    assert.equal(response.code, 'HELPER_TARGET_UNVERIFIABLE');
  });

  it('still plans an alert-only action when the target has disappeared, and says why', () => {
    const target = processTarget();
    const helper = createHelper({
      target,
      targetProbe: { source: 'static', observe: () => ({ state: 'absent', reason: 'not_found' }) },
    });
    const response = helper.prepare(alertEnvelope(target));
    assert.equal(response.status, 'planned');
    assert.equal(response.plan.drift.status, 'drifted');
    assert.equal(response.plan.would_mutate_target, false);
    assert.ok(
      response.plan.notes.includes('target drift observed, but this action never touches the target'),
    );
  });

  it('exposes the drift reasons on the plan, not only in the refusal', () => {
    const target = processTarget();
    const helper = createHelper({ target, observation: observationFor(target, { os: 'linux' }) });
    const response = helper.prepare(alertEnvelope(target));
    assert.equal(response.status, 'planned');
    assert.deepEqual(response.plan.drift.reasons.map((reason) => reason.code), [DRIFT_REASONS.OS_MISMATCH]);
  });
});
