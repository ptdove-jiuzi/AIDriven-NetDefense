import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  ERROR_CODES,
  createCollectorRuntime,
  createCursorStore,
  createDedupeWindow,
  createEventQueue,
  createGapLedger,
  createSourceCollector,
} from '../../packages/collectors/common/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';

const POLL_SOURCE = Object.freeze({ stableSourceId: 'windows.process-table', kind: 'poll', intervalMs: 5_000 });
const EVENT_SOURCE = Object.freeze({ stableSourceId: 'linux.journald', kind: 'event', intervalMs: 5_000 });
const INSTANCE_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BASE = 1_700_000_000_000;

function createSandbox(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  return { sandbox, directory: join(sandbox.workRoot, 'state') };
}

test('a poll source with zero events stays fresh while committed reads keep advancing', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const collector = createSourceCollector({
    source: POLL_SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_ID,
    clock,
  });

  for (let hour = 1; hour <= 24; hour += 1) {
    now = BASE + hour * 3_600_000;
    const result = collector.publishAndCommit({ records: [], nextCursor: `cursor-${hour}` });
    assert.equal(result.published, 0);
    assert.equal(result.committed, true);

    const snapshot = collector.snapshot();
    assert.equal(snapshot.freshness, 'fresh', `hour ${hour} must stay fresh`);
    assert.equal(snapshot.lifecycle, 'ready');
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.lastEvent, null);
  }

  assert.equal(queue.stats().events, 0);
  assert.equal(collector.stats().published, 0);
  assert.equal(collector.stats().identity.sequence, -1);
});

test('an event source with 24h of zero events stays fresh while health probes succeed', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const collector = createSourceCollector({
    source: EVENT_SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_ID,
    clock,
  });

  for (let probe = 0; probe < 2_880; probe += 1) {
    now += 30_000;
    collector.probeSubscription({ ok: true });
  }

  const snapshot = collector.snapshot();
  assert.equal(snapshot.freshness, 'fresh');
  assert.equal(snapshot.lifecycle, 'ready');
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.lastEvent, null);
  assert.notEqual(snapshot.lastValidSubscription, null);
  assert.equal(queue.stats().events, 0);

  now += 60_001;
  const stale = collector.snapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'subscription_probe_overdue');
});

test('one unavailable source degrades alone while the other sources stay ready', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const dedupe = createDedupeWindow({ clock });
  const gaps = createGapLedger({ clock });
  const runtime = createCollectorRuntime({
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe,
    gaps,
    clock,
  });

  const denied = runtime.addSource({ stableSourceId: 'windows.security-log', kind: 'poll', intervalMs: 5_000 });
  const healthy = runtime.addSource({ stableSourceId: 'linux.process-table', kind: 'poll', intervalMs: 5_000 });

  denied.noteError({
    code: 'permission_denied',
    message: 'EvtSubscribe access denied',
    remediation: 'Grant read access to the Security channel to the collector account',
  });
  healthy.publishAndCommit({ records: [], nextCursor: 'cursor-process-1' });

  now += 1_000;
  const report = runtime.report(now);
  assert.deepEqual(report.degraded, ['windows.security-log']);
  assert.deepEqual(report.stale, []);
  assert.equal(report.sources.length, 2);
  assert.equal(report.dedupe.entries, 0);
  assert.equal(report.dedupe.sources, 0);
  assert.equal(report.dedupe.maxGlobal, 200_000);
  assert.equal(report.dedupe.maxPerSource, 50_000);
  assert.equal(report.gaps.total, 0);
  assert.deepEqual(report.gaps.perSource, {});
  assert.equal(report.queue.events, 0);

  const deniedSnapshot = report.sources.find((item) => item.stableSourceId === 'windows.security-log');
  assert.equal(deniedSnapshot.lifecycle, 'unavailable');
  assert.equal(deniedSnapshot.freshness, 'unavailable');
  assert.match(deniedSnapshot.remediation, /Grant read access/);

  const healthySnapshot = report.sources.find((item) => item.stableSourceId === 'linux.process-table');
  assert.equal(healthySnapshot.lifecycle, 'ready');
  assert.equal(healthySnapshot.freshness, 'fresh');

  assert.equal(runtime.get('linux.process-table'), healthy);
  assert.equal(runtime.get('missing.source'), undefined);
  assert.throws(
    () => runtime.addSource({ stableSourceId: 'linux.process-table' }),
    (error) => error.name === 'CollectorError' && error.code === ERROR_CODES.INVALID_ARGUMENT,
  );

  runtime.close();
  const closed = runtime.report(now);
  assert.deepEqual(closed.sources.map((item) => item.freshness), ['stopped', 'stopped']);
  assert.equal(gaps.stats().total, 0);
});
