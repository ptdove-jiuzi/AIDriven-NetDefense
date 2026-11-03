import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SUBSCRIPTION_REMEDIATION,
  ERROR_CODES,
  createCapability,
  toIsoTimestamp,
} from '../../packages/collectors/common/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';

const SOURCE_ID = 'windows.security-log';
const INSTANCE_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BASE = 1_700_000_000_000;

test('a poll source that stops progressing becomes stale and is never reported healthy', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;

  const capability = createCapability({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    kind: 'poll',
    intervalMs: 5_000,
    clock: () => now,
  });

  assert.equal(capability.snapshot().freshness, 'starting');
  assert.equal(capability.snapshot().lifecycle, 'starting');

  capability.recordSuccess(BASE);
  const healthy = capability.snapshot();
  assert.equal(healthy.freshness, 'fresh');
  assert.equal(healthy.lifecycle, 'ready');
  assert.equal(healthy.declaredLifecycle, 'ready');
  assert.equal(healthy.stale, false);
  assert.equal(healthy.lastSuccess, toIsoTimestamp(BASE));

  now = BASE + 10_000;
  assert.equal(capability.snapshot().stale, false, 'exactly at the threshold the source is still fresh');

  now = BASE + 10_001;
  const stale = capability.snapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.lifecycle, 'degraded');
  assert.equal(stale.declaredLifecycle, 'ready');
  assert.equal(stale.staleReason, 'no_progress');
  assert.equal(stale.staleForMs, 10_001);
});

test('an event source with 24h of zero business events stays fresh while probes succeed', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;

  const capability = createCapability({
    stableSourceId: 'linux.journald',
    collectorInstanceId: INSTANCE_ID,
    kind: 'event',
    clock: () => now,
  });

  for (let probe = 0; probe < 2_880; probe += 1) {
    now += 30_000;
    capability.recordSubscriptionProbe({ ok: true, at: now });
  }

  const snapshot = capability.snapshot();
  assert.equal(snapshot.freshness, 'fresh');
  assert.equal(snapshot.lifecycle, 'ready');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.lastEvent, null);
  assert.equal(snapshot.lastValidSubscription, toIsoTimestamp(now));
});

test('an event source goes stale only when subscription probes stop, and recovers', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;

  const capability = createCapability({
    stableSourceId: 'linux.journald',
    collectorInstanceId: INSTANCE_ID,
    kind: 'event',
    clock: () => now,
  });

  capability.recordSubscriptionProbe({ ok: true, at: now });
  now = BASE + 60_000;
  assert.equal(capability.snapshot().stale, false);

  now = BASE + 60_001;
  const stale = capability.snapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'subscription_probe_overdue');
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.lifecycle, 'degraded');

  const failedProbe = capability.recordSubscriptionProbe({ ok: false, at: now });
  assert.equal(failedProbe.lifecycle, 'degraded');
  assert.equal(failedProbe.lastError.code, 'subscription_probe_failed');
  assert.equal(failedProbe.remediation, DEFAULT_SUBSCRIPTION_REMEDIATION);

  now += 30_000;
  const recovered = capability.recordSubscriptionProbe({ ok: true, at: now });
  assert.equal(recovered.freshness, 'fresh');
  assert.equal(recovered.lifecycle, 'ready');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.remediation, null);
});

test('errors require remediation and permission failures are unavailable', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  const now = BASE;

  const capability = createCapability({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    clock: () => now,
  });

  assert.throws(
    () => capability.recordError({ code: 'io_error', message: 'read failed' }),
    (error) => error.name === 'CollectorError' && error.code === ERROR_CODES.INVALID_ARGUMENT,
  );
  assert.throws(
    () => capability.recordError({ code: 'io_error', message: 'read failed', remediation: '   ' }),
    (error) => error.code === ERROR_CODES.INVALID_ARGUMENT,
  );

  const degraded = capability.recordError({
    code: 'io_error',
    message: 'read failed',
    remediation: 'Retry the read after checking disk health',
  });
  assert.equal(degraded.lifecycle, 'degraded');
  assert.equal(degraded.freshness, 'starting');
  assert.equal(degraded.lastError.code, 'io_error');

  const denied = capability.recordError({
    code: 'permission_denied',
    message: 'EvtSubscribe access denied',
    remediation: 'Grant read access to the Security channel to the collector account',
  });
  assert.equal(denied.lifecycle, 'unavailable');
  assert.equal(denied.freshness, 'unavailable');
  assert.equal(denied.stale, false);
  assert.equal(denied.lastError.code, 'permission_denied');
  assert.match(denied.remediation, /Grant read access/);

  const other = createCapability({
    stableSourceId: 'linux.journald',
    collectorInstanceId: INSTANCE_ID,
    clock: () => now,
  });
  const withPermissions = other.setPermissions({ granted: ['read:auth.log'], missing: ['read:journald'] });
  assert.equal(withPermissions.lifecycle, 'unavailable');
  assert.match(withPermissions.remediation, /read:journald/);
  assert.deepEqual(withPermissions.permissions, {
    granted: ['read:auth.log'],
    missing: ['read:journald'],
  });
});

test('a stopped source reports stopped freshness regardless of its last success', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;

  const capability = createCapability({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    kind: 'poll',
    intervalMs: 1_000,
    clock: () => now,
  });
  capability.recordSuccess(now);

  now += 60_000;
  assert.equal(capability.snapshot().freshness, 'stale');

  const stopping = capability.markStopping();
  assert.equal(stopping.freshness, 'stopped');
  assert.equal(stopping.stale, false);
  assert.equal(stopping.lifecycle, 'stopping');

  const stopped = capability.markStopped();
  assert.equal(stopped.freshness, 'stopped');
  assert.equal(stopped.lifecycle, 'stopped');
  assert.equal(stopped.lastSuccess, toIsoTimestamp(BASE));
});

test('business events alone never prove subscription health', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;

  const capability = createCapability({
    stableSourceId: 'linux.journald',
    collectorInstanceId: INSTANCE_ID,
    kind: 'event',
    clock: () => now,
  });

  for (let index = 0; index < 100; index += 1) {
    now += 1_000;
    capability.recordEvent(now);
  }

  const snapshot = capability.snapshot();
  assert.notEqual(snapshot.lastEvent, null);
  assert.equal(snapshot.lastValidSubscription, null);
  assert.equal(snapshot.stale, true, '100 seconds without a probe exceeds two 30s probe cycles');
  assert.equal(snapshot.freshness, 'stale');
  assert.equal(snapshot.staleReason, 'subscription_probe_overdue');
  assert.equal(snapshot.lifecycle, 'degraded');
});

test('restoring a denied permission unlatches unavailable and keeps the error history', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  const now = BASE;

  const capability = createCapability({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    kind: 'poll',
    intervalMs: 5_000,
    clock: () => now,
  });
  capability.recordSuccess(BASE);

  const denied = capability.recordError({
    code: 'permission_denied',
    message: 'EvtSubscribe access denied',
    remediation: 'Grant read access to the Security channel',
  });
  assert.equal(denied.lifecycle, 'unavailable');
  assert.equal(denied.freshness, 'unavailable');

  const recovered = capability.setPermissions({ granted: ['read:security-channel'], missing: [] });
  assert.equal(recovered.lifecycle, 'ready');
  assert.equal(recovered.freshness, 'fresh');
  assert.equal(recovered.remediation, null);
  assert.equal(recovered.lastError.code, 'permission_denied', 'lastError stays as history');
  assert.equal(recovered.recoveredAt, toIsoTimestamp(now));
  assert.deepEqual(recovered.permissions, {
    granted: ['read:security-channel'],
    missing: [],
  });
});

test('a backwards wall clock is reported as stale, never as fresh', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;

  const capability = createCapability({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    kind: 'poll',
    intervalMs: 5_000,
    clock: () => now,
  });
  capability.recordSuccess(BASE);

  now = BASE - 3_600_000;
  const snapshot = capability.snapshot();
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.staleReason, 'clock_regression');
  assert.equal(snapshot.freshness, 'stale');
  assert.equal(snapshot.lifecycle, 'degraded');
  assert.equal(snapshot.staleForMs, 3_600_000);
});

test('an injected monotonic clock keeps freshness stable across wall clock jumps', (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  let now = BASE;
  let monotonicMs = 1_000;

  const capability = createCapability({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    kind: 'poll',
    intervalMs: 10_000,
    clock: () => now,
    monotonic: () => monotonicMs,
  });
  capability.recordSuccess();

  now += 3_600_000;
  monotonicMs += 3_000;
  assert.equal(capability.snapshot().freshness, 'fresh');

  monotonicMs += 30_000;
  assert.equal(capability.snapshot().staleReason, 'no_progress');
});
