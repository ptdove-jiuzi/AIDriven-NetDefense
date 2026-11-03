/**
 * health.test.js — liveness / readiness / health aggregation and the status payload.
 *
 * The distinction that matters operationally: a degraded collector must not make
 * the daemon unready (the core keeps working), while a missing store must. And the
 * status payload must never carry a secret.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HEALTH_LEVELS, buildStatusPayload, computeHealth, isStoreOpen } from '../../apps/daemon/src/health.js';
import { createManualClock } from '../../apps/daemon/src/clock.js';
import { BASE_ISO, BASE_MS, TEST_TOKEN } from './helpers.js';

const HEALTHY_STORE = { open: true, errors: 0 };
const HEALTHY_DETECTION = { faults: 0, frozen: false };
const HEALTHY_SOURCE = { id: 'synthetic.process', lifecycle: 'ok', stale: false, consecutive_failures: 0 };

describe('computeHealth', () => {
  it('is ok when running, stored and collected', () => {
    const health = computeHealth({
      lifecycle: 'running',
      store: HEALTHY_STORE,
      detection: HEALTHY_DETECTION,
      sources: [HEALTHY_SOURCE],
    });
    assert.equal(health.status, 'ok');
    assert.deepEqual(health.reasons, []);
    assert.equal(health.ready, true);
  });

  it('stays ready but degraded when a single source fails', () => {
    const health = computeHealth({
      lifecycle: 'running',
      store: HEALTHY_STORE,
      detection: HEALTHY_DETECTION,
      sources: [HEALTHY_SOURCE, { id: 'synthetic.bad', lifecycle: 'degraded', stale: false, consecutive_failures: 3 }],
    });
    assert.equal(health.status, 'degraded');
    assert.ok(health.reasons.includes('sources:degraded:1'));
    assert.equal(health.ready, true, 'a degraded source must not stop the core');
  });

  it('is degraded when no source is configured', () => {
    const health = computeHealth({ lifecycle: 'running', store: HEALTHY_STORE, detection: HEALTHY_DETECTION, sources: [] });
    assert.equal(health.status, 'degraded');
    assert.ok(health.reasons.includes('sources:none'));
  });

  it('is failed and unready without a store', () => {
    const health = computeHealth({
      lifecycle: 'running',
      store: { open: false, errors: 0 },
      detection: HEALTHY_DETECTION,
      sources: [HEALTHY_SOURCE],
    });
    assert.equal(health.status, 'failed');
    assert.equal(health.ready, false);
    assert.ok(health.reasons.includes('store:unavailable'));
  });

  it('is degraded on store write errors, still ready', () => {
    const health = computeHealth({
      lifecycle: 'running',
      store: { open: true, errors: 2 },
      detection: HEALTHY_DETECTION,
      sources: [HEALTHY_SOURCE],
    });
    assert.equal(health.status, 'degraded');
    assert.ok(health.reasons.includes('store:write-errors'));
    assert.equal(health.ready, true);
  });

  it('is degraded on a frozen or faulting detection engine', () => {
    const frozen = computeHealth({
      lifecycle: 'running',
      store: HEALTHY_STORE,
      detection: { faults: 1, frozen: true },
      sources: [HEALTHY_SOURCE],
    });
    assert.equal(frozen.status, 'degraded');
    assert.ok(frozen.reasons.includes('detection:frozen'));
    const faulted = computeHealth({
      lifecycle: 'running',
      store: HEALTHY_STORE,
      detection: { faults: 2, frozen: false },
      sources: [HEALTHY_SOURCE],
    });
    assert.ok(faulted.reasons.includes('detection:faults'));
  });

  it('is not ready while starting or stopping', () => {
    for (const lifecycle of ['created', 'starting', 'stopping', 'stopped']) {
      const health = computeHealth({
        lifecycle,
        store: HEALTHY_STORE,
        detection: HEALTHY_DETECTION,
        sources: [HEALTHY_SOURCE],
      });
      assert.equal(health.ready, false, `${lifecycle} must not be ready`);
      assert.notEqual(health.status, 'ok');
    }
  });

  it('reports a failed lifecycle as failed', () => {
    const health = computeHealth({ lifecycle: 'failed', store: HEALTHY_STORE, detection: HEALTHY_DETECTION, sources: [] });
    assert.equal(health.status, 'failed');
  });

  it('counts stale sources as a reason', () => {
    const health = computeHealth({
      lifecycle: 'running',
      store: HEALTHY_STORE,
      detection: HEALTHY_DETECTION,
      sources: [{ ...HEALTHY_SOURCE, stale: true }],
    });
    assert.ok(health.reasons.includes('sources:stale:1'));
    assert.equal(health.status, 'degraded');
  });

  it('exposes the ordered level vocabulary', () => {
    assert.deepEqual([...HEALTH_LEVELS], ['ok', 'degraded', 'failed']);
  });
});

describe('isStoreOpen', () => {
  it('accepts a method, a boolean and nothing else', () => {
    assert.equal(isStoreOpen({ isOpen: () => true }), true);
    assert.equal(isStoreOpen({ isOpen: () => false }), false);
    assert.equal(isStoreOpen({ isOpen: true }), true);
    assert.equal(isStoreOpen({}), false);
    assert.equal(isStoreOpen(null), false);
  });
});

describe('buildStatusPayload', () => {
  function makePayload(overrides = {}) {
    const clock = createManualClock(BASE_MS);
    clock.advance(1500);
    return buildStatusPayload({
      version: 'test',
      lifecycle: 'running',
      startedAt: BASE_ISO,
      startedAtMs: BASE_MS,
      clock,
      epoch: '3f7c1a9e-6b2d-4c8f-9a01-2b3c4d5e6f70',
      mode: 'mock',
      scheduler: {
        status: () => [{
          id: 'synthetic.process',
          kind: 'process',
          lifecycle: 'ok',
          stale: false,
          polling: false,
          polls: 3,
          events: 5,
          accepted: 5,
          failures: 0,
          consecutive_failures: 0,
          last_poll_at: BASE_ISO,
          last_success_at: BASE_ISO,
          last_event_at: BASE_ISO,
          last_error_code: null,
          last_error_at: null,
          dropped_events: 0,
        }],
        summary: () => ({ sources: 1, polling: 0, stale: 0, degraded: 0, ok: 1, uptime_mono_ms: 10 }),
      },
      pipeline: {
        stats: () => ({
          batches: 1,
          events_accepted: 5,
          events_duplicate: 0,
          alerts_written: 1,
          findings_written: 5,
          analysis_requests: 1,
          store_errors: 0,
          detection_faults: 0,
          detection: { fatal: null },
        }),
      },
      store: {
        kind: 'memory',
        isOpen: () => true,
        stats: () => ({ events: 5, alerts: 1, findings: 5, analyses: 1 }),
      },
      health: { status: 'ok', ready: true, reasons: [] },
      counters: { events_received: 5, events_accepted: 5 },
      ...overrides,
    });
  }

  it('describes the daemon without any secret or event content', () => {
    const payload = makePayload();
    assert.equal(payload.lifecycle, 'running');
    assert.equal(payload.health.ready, true);
    assert.equal(payload.scheduler.sources.length, 1);
    assert.equal(payload.scheduler.sources[0].id, 'synthetic.process');
    assert.equal(payload.pipeline.alerts_written, 1);
    assert.equal(payload.store.events, 5);
    assert.equal(payload.counters.events_received, 5);
    assert.equal(payload.uptime_ms, 1500);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(TEST_TOKEN), false);
    assert.equal(serialized.includes('authorization'), false);
    // No telemetry payload content is echoed either.
    assert.equal(serialized.includes('evil.exe'), false);
  });

  it('reports the live store open state through the adapter method', () => {
    const payload = makePayload({
      store: { kind: 'sqlite', isOpen: () => false, stats: () => ({ events: 0, alerts: 0, findings: 0, analyses: 0 }) },
    });
    assert.equal(payload.store.open, false);
  });

  it('carries the schema version the console will negotiate on', () => {
    assert.equal(makePayload().schema_version, '1.0');
  });
});
