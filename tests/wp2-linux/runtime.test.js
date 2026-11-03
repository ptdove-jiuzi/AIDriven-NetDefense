/**
 * Runtime integration: the rules that decide whether a Linux source is healthy, degraded or
 * unavailable, exercised against the real shared cursor store (in a temporary sandbox) and
 * the real `packages/collectors/common` collector.
 *
 * The central assertion of this file is the one the task calls out explicitly: a read that
 * was denied must not be published, must not advance the cursor, and must not be reported as
 * a healthy empty source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildStableKey,
  createCursorStore,
  createEventQueue,
  createGapLedger,
  parseStableKey,
} from '../../packages/collectors/common/index.js';
import {
  PROCESS_SOURCE_ID,
  createAuthLogSource,
  createJournaldSource,
  createLinuxCollectorRuntime,
  createMemoryFileSystem,
  createProcfsProcessSource,
  createScriptedCommandRunner,
} from '../../packages/collectors/linux/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';

const BASE = 1_700_000_000_000;
const AUTH_LOG = '/var/log/auth.log';
const AUTH_LOG_SOURCE_ID = 'linux.auth-log';

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

function sandboxFor(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-linux-' });
  t.after(sandbox.cleanup);
  return { sandbox, directory: join(sandbox.workRoot, 'state') };
}

function buildRuntime({ directory, queue = null, clock = () => BASE }) {
  const store = createCursorStore({ directory, clock });
  const gaps = createGapLedger({ clock });
  const runtime = createLinuxCollectorRuntime({ store, gaps, queue, clock });
  return { store, gaps, runtime };
}

test('a successful poll commits the cursor and leaves the source ready', async (t) => {
  const { directory } = sandboxFor(t);
  const { store, runtime } = buildRuntime({ directory, queue: createEventQueue() });
  const fileSystem = createMemoryFileSystem(fixture('procfs.json'));
  runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem, clock: () => BASE }) });

  const result = await runtime.readSource(PROCESS_SOURCE_ID);
  assert.equal(result.status, 'ok');
  assert.equal(result.committed, true);
  assert.equal(result.published, 3);
  assert.equal(result.lifecycle, 'ready');

  const persisted = store.load(PROCESS_SOURCE_ID);
  assert.notEqual(persisted, null, 'a successful read must advance the durable cursor');
  assert.equal(persisted.sequence, 2);
  assert.deepEqual(runtime.report().unavailable, []);
});

test('a denied read publishes nothing, keeps the cursor and reports the source unavailable', async (t) => {
  const { directory } = sandboxFor(t);
  const queue = createEventQueue();
  const { store, runtime, gaps } = buildRuntime({ directory, queue });
  const fileSystem = createMemoryFileSystem(fixture('procfs-denied.json'));
  const collector = runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem, clock: () => BASE }) });

  const before = collector.identity();
  const result = await runtime.readSource(PROCESS_SOURCE_ID);

  assert.equal(result.status, 'denied');
  assert.equal(result.committed, false);
  assert.equal(result.published, 0);
  assert.equal(collector.identity().sequence, before.sequence, 'a denied read must not advance the sequence');
  assert.equal(store.load(PROCESS_SOURCE_ID), null, 'a denied read must not create a durable cursor');
  assert.equal(queue.stats().events, 0, 'a denied read must not enqueue events');

  const snapshot = runtime.report().sources.find((source) => source.stableSourceId === PROCESS_SOURCE_ID);
  assert.equal(snapshot.lifecycle, 'unavailable');
  assert.equal(snapshot.freshness, 'unavailable');
  assert.deepEqual([...snapshot.permissions.missing], ['/proc']);
  assert.equal(snapshot.lastError.code, 'permission_denied');
  assert.ok(gaps.list().some((gap) => gap.reason === 'permission_denied'));
});

test('a source that was denied becomes ready again once the read succeeds', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  const fileSystem = createMemoryFileSystem(fixture('procfs-denied.json'));
  runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem, clock: () => BASE }) });

  const denied = await runtime.readSource(PROCESS_SOURCE_ID);
  assert.equal(denied.lifecycle, 'unavailable');

  // Simulate the operator granting access: the same paths become readable.
  fileSystem.setDenied('/proc', false);
  fileSystem.write('/proc/1/stat', '1 (systemd) S 0 1 1 0 -1 4194560 5000 0 0 0 50 30 0 0 20 0 1 0 12 123456 3000\n');
  fileSystem.write('/proc/1/status', 'Name:\tsystemd\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n');
  fileSystem.write('/proc/1/cmdline', '/sbin/init\u0000');

  const recovered = await runtime.readSource(PROCESS_SOURCE_ID);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.lifecycle, 'ready', 'a successful read must unlatch the permission verdict');
  const snapshot = runtime.report().sources.find((source) => source.stableSourceId === PROCESS_SOURCE_ID);
  assert.deepEqual([...snapshot.permissions.missing], []);
  assert.notEqual(snapshot.recoveredAt, null);
});

test('a partial read publishes what it has and stays degraded', async (t) => {
  const { directory } = sandboxFor(t);
  const queue = createEventQueue();
  const { runtime, gaps } = buildRuntime({ directory, queue });
  const fileSystem = createMemoryFileSystem(fixture('procfs-partial.json'));
  runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem, clock: () => BASE }) });

  const result = await runtime.readSource(PROCESS_SOURCE_ID);
  assert.equal(result.status, 'partial');
  assert.equal(result.committed, true);
  assert.equal(result.published, 1, 'the readable processes are still delivered');
  assert.equal(result.lifecycle, 'degraded');
  assert.ok(gaps.list().some((gap) => gap.reason === 'permission_denied'));

  const snapshot = runtime.report().sources[0];
  assert.equal(snapshot.declaredLifecycle, 'degraded');
  assert.equal(snapshot.freshness, 'fresh', 'degraded is not the same as stale');
  assert.equal(queue.stats().events, 1);
});

test('a rotated auth log advances the generation instead of reusing the old offset', async (t) => {
  const { directory } = sandboxFor(t);
  const { store, runtime } = buildRuntime({ directory });
  const fileSystem = createMemoryFileSystem({
    files: { [AUTH_LOG]: { content: fixture('auth-log.json').content, ino: 700 } },
  });
  const collector = runtime.addSource({ adapter: createAuthLogSource({ fileSystem, clock: () => BASE }) });

  const first = await runtime.readSource(AUTH_LOG_SOURCE_ID);
  assert.equal(first.status, 'ok');
  assert.equal(collector.identity().generation, 0);

  fileSystem.write(AUTH_LOG, 'Oct 31 11:00:00 lab-host sshd[1]: after rotation\n', { ino: 999 });
  const rotated = await runtime.readSource(AUTH_LOG_SOURCE_ID);

  assert.equal(rotated.status, 'rotated');
  assert.equal(rotated.committed, false);
  assert.equal(collector.identity().generation, 1, 'the generation must advance past the rotation');
  const persisted = store.load(AUTH_LOG_SOURCE_ID);
  assert.equal(persisted.generation, 1);
  assert.equal(persisted.generationReason, 'log_rotated');

  const next = await runtime.readSource(AUTH_LOG_SOURCE_ID);
  assert.equal(next.status, 'ok');
  assert.equal(next.published, 1, 'the new file is read from its head under the new generation');
});

test('auth log records are keyed by byte offset, and re-reading rebuilds the same keys', async (t) => {
  const { directory } = sandboxFor(t);
  const queue = createEventQueue();
  const { runtime } = buildRuntime({ directory, queue });
  const fileSystem = createMemoryFileSystem({
    files: { [AUTH_LOG]: { content: fixture('auth-log.json').content, ino: 700 } },
  });
  runtime.addSource({
    adapter: createAuthLogSource({ fileSystem, clock: () => BASE, initialPosition: 'start' }),
  });

  const first = await runtime.readSource(AUTH_LOG_SOURCE_ID);
  assert.equal(first.published, 4);
  const events = queue.drain();
  assert.equal(events.length, 4);

  const offsets = events.map((event) => parseStableKey(buildStableKey({
    stableSourceId: event.stable_source_id,
    generation: event.source_generation,
    sequence: event.source_seq,
  })).value);
  assert.equal(new Set(offsets).size, offsets.length, 'no byte offset may be reused');
  // The queue is priority-ordered, so compare the set of offsets, not the delivery order.
  assert.deepEqual([...offsets].sort((a, b) => a - b), [0, 108, 209, 310]);

  // Replaying the same range produces the same keys, which is what lets the dedupe window
  // discard the overlap instead of double-delivering it.
  const replayQueue = createEventQueue();
  const replayRuntime = buildRuntime({ directory: join(directory, 'replay'), queue: replayQueue });
  replayRuntime.runtime.addSource({
    adapter: createAuthLogSource({
      fileSystem: createMemoryFileSystem({ files: { [AUTH_LOG]: { content: fixture('auth-log.json').content, ino: 700 } } }),
      clock: () => BASE,
      initialPosition: 'start',
    }),
  });
  await replayRuntime.runtime.readSource(AUTH_LOG_SOURCE_ID);
  const replayOffsets = replayQueue.drain().map((event) => parseStableKey(buildStableKey({
    stableSourceId: event.stable_source_id,
    generation: event.source_generation,
    sequence: event.source_seq,
  })).value);
  assert.deepEqual(replayOffsets, offsets);
});

test('a rotation leaves the source degraded and puts the unknown gap in the result', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  const fileSystem = createMemoryFileSystem({
    files: { [AUTH_LOG]: { content: fixture('auth-log.json').content, ino: 700 } },
  });
  runtime.addSource({ adapter: createAuthLogSource({ fileSystem, clock: () => BASE }) });

  await runtime.readSource(AUTH_LOG_SOURCE_ID);
  fileSystem.write(AUTH_LOG, 'Oct 31 11:00:00 lab-host sshd[1]: after rotation\n', { ino: 999 });
  const rotated = await runtime.readSource(AUTH_LOG_SOURCE_ID);

  assert.equal(rotated.status, 'rotated');
  // A source that just lost an unknown number of records is not healthy.
  assert.equal(rotated.lifecycle, 'degraded');
  const gap = rotated.gaps.find((entry) => entry.reason === 'log_rotated');
  assert.notEqual(gap, undefined, 'the rotation gap must be reported, not only stored in the ledger');
  assert.equal(gap.count, 0);
  assert.equal(gap.unknownCount, true);
});

test('a truncated read and a full backlog page both reach the gap ledger', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime, gaps } = buildRuntime({ directory });
  const truncatedAdapter = {
    descriptor: { stableSourceId: 'linux.truncated', kind: 'poll', intervalMs: 5_000 },
    async read() {
      return {
        status: 'ok',
        records: [],
        denials: [],
        permissions: { granted: [], missing: [] },
        nextCursor: null,
        truncated: true,
      };
    },
  };
  const backlogAdapter = {
    descriptor: { stableSourceId: 'linux.backlog', kind: 'poll', intervalMs: 5_000 },
    async read() {
      return {
        status: 'ok',
        records: [],
        denials: [],
        permissions: { granted: [], missing: [] },
        nextCursor: null,
        backlogRisk: true,
      };
    },
  };
  runtime.addSource({ adapter: truncatedAdapter });
  runtime.addSource({ adapter: backlogAdapter });

  const truncated = await runtime.readSource('linux.truncated');
  assert.ok(truncated.gaps.some((gap) => gap.reason === 'io_error'));
  assert.equal(truncated.lifecycle, 'degraded');

  const backlog = await runtime.readSource('linux.backlog');
  assert.ok(backlog.gaps.some((gap) => gap.reason === 'read_overlap_skipped'));
  assert.equal(backlog.lifecycle, 'degraded');

  const reasons = gaps.list().map((gap) => gap.reason);
  assert.ok(reasons.includes('io_error'));
  assert.ok(reasons.includes('read_overlap_skipped'));
});

test('the journald event source is probed separately from its reads', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  const data = fixture('journald-output.json');
  const oneEntry = `${JSON.stringify(data.entries[0])}\n`;
  const page = `${data.entries.slice(0, 2).map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const runner = createScriptedCommandRunner([
    { match: ['--lines=1'], stdout: '', stderr: 'Journal file access denied', exitCode: 1 },
    { match: ['--lines=1'], stdout: oneEntry },
    { stdout: page },
  ]);
  runtime.addSource({ adapter: createJournaldSource({ runner, clock: () => BASE }) });

  const failed = await runtime.probeSource('linux.journald');
  assert.equal(failed.ok, false);
  assert.equal(failed.lifecycle, 'degraded');

  const healthy = await runtime.probeSource('linux.journald');
  assert.equal(healthy.ok, true);
  assert.equal(healthy.lifecycle, 'ready', 'a healthy probe must clear the subscription failure');

  const read = await runtime.readSource('linux.journald');
  assert.equal(read.status, 'ok');
  assert.equal(read.published, 2);
});

test('an invalid journald cursor forces a generation reset', async (t) => {
  const { directory } = sandboxFor(t);
  const { store, runtime } = buildRuntime({ directory });
  const data = fixture('journald-output.json');
  const page = `${data.entries.slice(0, 2).map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const runner = createScriptedCommandRunner([
    { stdout: page },
    { stdout: '', stderr: 'Failed to seek to cursor s=dead: Invalid argument', exitCode: 1 },
  ]);
  const collector = runtime.addSource({ adapter: createJournaldSource({ runner, clock: () => BASE }) });

  const healthy = await runtime.readSource('linux.journald');
  assert.equal(healthy.status, 'ok');
  assert.equal(collector.identity().generation, 0, 'the first generation of a source is 0');

  const result = await runtime.readSource('linux.journald');
  assert.equal(result.status, 'error');
  assert.equal(collector.identity().generation, 1, 'a rejected cursor must advance the generation');
  assert.equal(store.load('linux.journald').generationReason, 'adapter_reset');
  assert.ok(result.gaps.some((gap) => gap.reason === 'cursor_reset'));
});

test('an adapter that throws degrades its own source and never breaks the runtime', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime, gaps } = buildRuntime({ directory });
  runtime.addSource({
    adapter: {
      descriptor: { stableSourceId: 'linux.broken', kind: 'poll', intervalMs: 5_000 },
      async read() {
        throw new Error('panicked while reading');
      },
    },
  });

  const result = await runtime.readSource('linux.broken');
  assert.equal(result.status, 'error');
  assert.equal(result.committed, false);
  assert.equal(result.lifecycle, 'degraded');
  assert.match(result.error.message, /panicked/);
  assert.ok(gaps.list().some((gap) => gap.reason === 'io_error'));
});

test('a malformed read result degrades that one source instead of throwing out of the loop', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  runtime.addSource({
    adapter: {
      descriptor: { stableSourceId: 'linux.liar', kind: 'poll', intervalMs: 5_000 },
      // Claims "ok" while admitting it could not read a path.
      async read() {
        return {
          status: 'ok',
          records: [],
          denials: [{ path: '/etc/shadow', code: 'EACCES', outcome: 'permission_denied' }],
          permissions: { granted: [], missing: [] },
          nextCursor: null,
        };
      },
    },
  });

  // The result claims "ok" while carrying a denial. That is an adapter contract violation:
  // the read must not be published, and it must not escape as a rejected promise either --
  // a daemon loop cannot absorb that and the other sources would stop with it.
  const result = await runtime.readSource('linux.liar');
  assert.equal(result.status, 'error');
  assert.equal(result.committed, false);
  assert.equal(result.error.code, 'ADAPTER_CONTRACT_VIOLATION');
  assert.match(result.error.message, /partial or denied/);
  assert.equal(result.lifecycle, 'degraded');
  assert.ok(result.gaps.some((gap) => gap.reason === 'io_error'));
});

test('registration rejects unknown sources and event sources without a probe', (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  assert.throws(
    () => runtime.addSource({
      adapter: {
        descriptor: { stableSourceId: 'linux.x', kind: 'event', intervalMs: 1, subscriptionProbeIntervalMs: 1 },
        read: async () => ({}),
      },
    }),
    /must expose probe\(\)/,
  );
  assert.throws(() => runtime.addSource({ adapter: {} }), /read\(\)/);
  assert.equal(runtime.has('linux.nothing'), false);
  assert.deepEqual([...runtime.ids()], []);
});

test('a denied journald read leaves the source unavailable with the permission named', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  const runner = createScriptedCommandRunner([
    { stdout: '', stderr: 'No journal files were found.', exitCode: 1 },
  ]);
  runtime.addSource({ adapter: createJournaldSource({ runner, clock: () => BASE }) });

  const result = await runtime.readSource('linux.journald');
  assert.equal(result.status, 'denied');
  assert.equal(result.committed, false);
  const snapshot = runtime.report().sources[0];
  assert.equal(snapshot.lifecycle, 'unavailable');
  assert.match(snapshot.permissions.missing[0], /systemd-journal/);
  assert.match(snapshot.remediation, /Grant this account read access/);
});

test('gap drains return the recorded gaps and empty afterwards', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  const fileSystem = createMemoryFileSystem(fixture('procfs-denied.json'));
  runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem, clock: () => BASE }) });

  await runtime.readSource(PROCESS_SOURCE_ID);
  const drained = runtime.gaps.drain();
  assert.ok(drained.length > 0);
  assert.equal(drained[0].reason, 'permission_denied');
  assert.equal(drained[0].count, 0, 'a permission gap has an unknown record count');
  assert.deepEqual(runtime.gaps.drain(), []);
});

test('closing the runtime marks every source stopped', async (t) => {
  const { directory } = sandboxFor(t);
  const { runtime } = buildRuntime({ directory });
  const fileSystem = createMemoryFileSystem(fixture('procfs.json'));
  runtime.addSource({ adapter: createProcfsProcessSource({ fileSystem, clock: () => BASE }) });

  const closed = runtime.close();
  assert.deepEqual([...closed], [PROCESS_SOURCE_ID]);
  assert.equal(runtime.report().sources[0].lifecycle, 'stopped');
});
