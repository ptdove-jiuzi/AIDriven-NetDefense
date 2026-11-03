// Import note: `packages/collectors/common` is not part of the root workspaces, and the
// workspace link for `@aegisharness/test-support` is recreated by `npm install` (a parallel
// reinstall removes it temporarily), so both are imported by relative path. Once
// `packages/collectors/common` is added to the root workspaces and the link is stable, the
// test-support import should be switched back to the package name.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  CollectorError,
  ERROR_CODES,
  buildStableKey,
  createCursorStore,
  createDedupeWindow,
  createEventQueue,
  createGapLedger,
  createSourceCollector,
  parseStableKey,
  toIsoTimestamp,
} from '../../packages/collectors/common/index.js';
import { createSnapshotGuard, createTestSandbox } from '../../packages/test-support/index.js';

const SOURCE_ID = 'windows.security-log';
const SOURCE = Object.freeze({ stableSourceId: SOURCE_ID, kind: 'poll', intervalMs: 5_000 });
const INSTANCE_A = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const INSTANCE_B = '7a1b2c3d-4e5f-4a6b-9c8d-1f2e3d4c5b6a';
const BASE = 1_700_000_000_000;

function createSandbox(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  return { sandbox, directory: join(sandbox.workRoot, 'state') };
}

function listFiles(root) {
  const collected = new Set();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else {
        collected.add(absolute);
      }
    }
  }
  return collected;
}

function createFlakyStore(inner, { failCommits = 1 } = {}) {
  let remaining = failCommits;
  return {
    load: (stableSourceId) => inner.load(stableSourceId),
    advanceGeneration: (args) => inner.advanceGeneration(args),
    commit: (args) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new CollectorError(ERROR_CODES.CURSOR_STORE_IO, 'injected commit failure');
      }
      return inner.commit(args);
    },
  };
}

function createThrowingQueue(inner, failOnCall = 2, options = {}) {
  const { failCount = 1, throwAfterDelegation = false } = options;
  let calls = 0;
  let failuresDone = 0;
  return {
    stats: () => inner.stats(),
    drain: () => inner.drain(),
    clear: () => inner.clear(),
    admit: (event, admitOptions) => {
      calls += 1;
      const shouldFail = calls >= failOnCall && failuresDone < failCount;
      if (shouldFail && throwAfterDelegation) {
        inner.admit(event, admitOptions);
        failuresDone += 1;
        throw new Error('injected post-delegation adapter failure');
      }
      if (shouldFail) {
        failuresDone += 1;
        throw new Error('injected adapter failure');
      }
      return inner.admit(event, admitOptions);
    },
  };
}

function createThrowingDedupe(inner, failOnRememberCall) {
  let calls = 0;
  return {
    has: (key) => inner.has(key),
    lookup: (key) => inner.lookup(key),
    remember: (key, options) => {
      calls += 1;
      if (calls === failOnRememberCall) {
        throw new Error('injected dedupe failure');
      }
      return inner.remember(key, options);
    },
    forget: (key) => inner.forget(key),
    seed: (entries) => inner.seed(entries),
    prune: (at) => inner.prune(at),
    stats: () => inner.stats(),
    clear: () => inner.clear(),
  };
}

function createPostCommitThrowingStore(inner, failCount = 1) {
  let remaining = failCount;
  return {
    load: (stableSourceId) => inner.load(stableSourceId),
    advanceGeneration: (args) => inner.advanceGeneration(args),
    commit: (args) => {
      const state = inner.commit(args);
      if (remaining > 0) {
        remaining -= 1;
        throw new CollectorError(ERROR_CODES.CURSOR_STORE_IO, 'injected post-commit failure');
      }
      return state;
    },
  };
}

function createRuntimeDeps(clock, queue) {
  return {
    queue: queue ?? createEventQueue({ maxEvents: 1_000, maxBytes: 10_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
  };
}

function sampleRecords(now) {
  return [
    { type: 'process_start', observedAt: now, payload: { pid: 100, image: 'synthetic-a' } },
    { type: 'process_start', observedAt: now + 1, payload: { pid: 101, image: 'synthetic-b' } },
    { type: 'process_start', observedAt: now + 2, payload: { pid: 102, image: 'synthetic-c' } },
  ];
}

test('a crash after publish but before commit replays into the exact same stable keys', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const firstStore = createCursorStore({ directory, clock });
  const firstDeps = createRuntimeDeps(clock);
  const firstCollector = createSourceCollector({
    source: SOURCE,
    store: firstStore,
    queue: firstDeps.queue,
    dedupe: firstDeps.dedupe,
    gaps: firstDeps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = sampleRecords(now);
  const firstPublish = firstCollector.publish({ records, nextCursor: 'cursor-10' });
  assert.equal(firstPublish.published, 3);
  assert.equal(firstDeps.queue.stats().events, 3);
  assert.equal(firstStore.load(SOURCE_ID), null, 'an uncommitted publish must not persist anything');

  const restartedStore = createCursorStore({ directory, clock });
  const restartedDeps = createRuntimeDeps(clock);
  const restartedCollector = createSourceCollector({
    source: SOURCE,
    store: restartedStore,
    queue: restartedDeps.queue,
    dedupe: restartedDeps.dedupe,
    gaps: restartedDeps.gaps,
    instanceId: INSTANCE_B,
    clock,
  });

  assert.deepEqual(restartedCollector.beginRead(), {
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_B,
    generation: 0,
    cursor: null,
    sequence: -1,
  });

  const replayed = restartedCollector.publish({ records, nextCursor: 'cursor-10' });
  assert.equal(replayed.published, 3);
  assert.deepEqual(
    replayed.items.map((item) => item.stableKey),
    firstPublish.items.map((item) => item.stableKey),
  );
  assert.deepEqual(
    replayed.items.map((item) => item.event.source_seq),
    firstPublish.items.map((item) => item.event.source_seq),
  );
  assert.deepEqual(replayed.items.map((item) => item.event.source_seq), [0, 1, 2]);
  assert.equal(firstPublish.items[0].stableKey.includes(INSTANCE_A), false);
  assert.equal(replayed.items[0].stableKey.includes(INSTANCE_B), false);
});

test('an overlap replay after commit is discarded by the reseeded dedupe window', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 1_000, maxBytes: 10_000_000, priorityReserveRatio: 0.1 });
  const firstDeps = createRuntimeDeps(clock, queue);
  const firstCollector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: firstDeps.dedupe,
    gaps: firstDeps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  // Overlap replay is only identifiable for sources with a native record id; see the
  // sequence-only case in the uncommitted test above.
  const records = [
    { type: 'logon', nativeRecordId: 100, observedAt: now, payload: { record: 100 } },
    { type: 'logon', nativeRecordId: 101, observedAt: now, payload: { record: 101 } },
    { type: 'logon', nativeRecordId: 102, observedAt: now, payload: { record: 102 } },
  ];
  const committed = firstCollector.publishAndCommit({ records, nextCursor: 'cursor-3' });
  assert.equal(committed.committed, true);
  assert.equal(committed.sequence, 2);
  assert.equal(queue.stats().events, 3);

  const restartedStore = createCursorStore({ directory, clock });
  const persisted = restartedStore.load(SOURCE_ID);
  assert.equal(persisted.generation, 0);
  assert.equal(persisted.cursor, 'cursor-3');
  assert.equal(persisted.sequence, 2);
  assert.equal(persisted.recentKeys.length, 3);

  const restartedDeps = createRuntimeDeps(clock, queue);
  const restartedCollector = createSourceCollector({
    source: SOURCE,
    store: restartedStore,
    queue,
    dedupe: restartedDeps.dedupe,
    gaps: restartedDeps.gaps,
    instanceId: INSTANCE_B,
    clock,
  });

  const replay = restartedCollector.publish({ records, nextCursor: 'cursor-3' });
  assert.equal(replay.duplicates, 3);
  assert.equal(replay.published, 0);
  assert.equal(replay.dropped, 0);
  // The counter advances for every record before the duplicate check, so the sequence is
  // deterministic and never depends on which records happened to be duplicates.
  assert.equal(replay.sequence, 5);
  assert.deepEqual(replay.items.map((item) => item.outcome), ['duplicate', 'duplicate', 'duplicate']);
  assert.deepEqual(replay.items.map((item) => item.event), [null, null, null]);
  assert.equal(queue.stats().events, 3, 'duplicates must not reach the queue');
});

test('log rotation advances the generation and keeps reused record ids distinct', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const deps = createRuntimeDeps(clock);
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory: join(directory, 'single'), clock }),
    queue: deps.queue,
    dedupe: deps.dedupe,
    gaps: deps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const beforeRotation = collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: now, payload: { record: 1 } }],
    nextCursor: 'cursor-before',
  });
  const oldKey = beforeRotation.items[0].stableKey;
  assert.equal(oldKey, `${SOURCE_ID}#g0:n1`);

  const decision = collector.detectIdentityChange(
    { fileId: 'file-b', size: 0 },
    { fileId: 'file-a', size: 900 },
  );
  assert.deepEqual(decision, { action: 'advance_generation', reason: 'log_rotated' });

  now += 1_000;
  const advanced = collector.advanceGeneration({ reason: decision.reason });
  assert.equal(advanced.generation, 1);
  assert.equal(advanced.sequence, -1);
  assert.equal(advanced.cursor, null);

  const afterRotation = collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: now, payload: { record: 1 } }],
    nextCursor: 'cursor-after',
  });
  const newKey = afterRotation.items[0].stableKey;

  assert.equal(newKey, `${SOURCE_ID}#g1:n1`);
  assert.notEqual(newKey, oldKey);
  assert.equal(afterRotation.published, 1);
  assert.equal(afterRotation.duplicates, 0);
  assert.equal(afterRotation.items[0].event.source_seq, 0, 'the new generation restarts the sequence at zero');
  assert.equal(deps.queue.stats().events, 2);
  assert.equal(parseStableKey(oldKey).generation, 0);
  assert.equal(parseStableKey(newKey).generation, 1);

  const gaps = deps.gaps.list({ stableSourceId: SOURCE_ID });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, 'log_rotated');
  assert.equal(gaps[0].generation, 1);
  assert.equal(gaps[0].count, 0);
  assert.equal(gaps[0].unknownCount, true);
});

test('a truncated log advances the generation so a reused record id is a new event', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const deps = createRuntimeDeps(clock);
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: deps.queue,
    dedupe: deps.dedupe,
    gaps: deps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const first = collector.publishAndCommit({
    records: [{ type: 'file_change', nativeRecordId: 'id-7', observedAt: now, payload: { path: 'synthetic' } }],
    nextCursor: 'cursor-7',
  });

  const decision = collector.detectIdentityChange(
    { fileId: 'file-a', size: 400 },
    { fileId: 'file-a', size: 900 },
  );
  assert.deepEqual(decision, { action: 'advance_generation', reason: 'log_truncated' });

  now += 500;
  const advanced = collector.advanceGeneration({ reason: decision.reason });
  assert.equal(advanced.generation, 1);

  const replayAfterTruncation = collector.publishAndCommit({
    records: [{ type: 'file_change', nativeRecordId: 'id-7', observedAt: now, payload: { path: 'synthetic' } }],
    nextCursor: 'cursor-7b',
  });

  assert.notEqual(replayAfterTruncation.items[0].stableKey, first.items[0].stableKey);
  assert.equal(replayAfterTruncation.published, 1);
  assert.equal(replayAfterTruncation.duplicates, 0);
  assert.deepEqual(
    deps.gaps.list({ stableSourceId: SOURCE_ID }).map((gap) => gap.reason),
    ['log_truncated'],
  );
});

test('a generation advanced before a restart survives with its cursor and sequence', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const firstDeps = createRuntimeDeps(clock);
  const firstCollector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: firstDeps.queue,
    dedupe: firstDeps.dedupe,
    gaps: firstDeps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  firstCollector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: now, payload: {} }],
    nextCursor: 'cursor-gen0',
  });
  firstCollector.advanceGeneration({ reason: 'log_cleared' });
  now += 2_000;
  firstCollector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 5, observedAt: now, payload: {}, }],
    nextCursor: 'cursor-gen1',
  });

  const restartedStore = createCursorStore({ directory, clock });
  const restored = restartedStore.load(SOURCE_ID);
  assert.equal(restored.generation, 1);
  assert.equal(restored.cursor, 'cursor-gen1');
  assert.equal(restored.sequence, 0);
  assert.equal(restored.generationReason, 'log_cleared');

  const restartedDeps = createRuntimeDeps(clock);
  const restartedCollector = createSourceCollector({
    source: SOURCE,
    store: restartedStore,
    queue: restartedDeps.queue,
    dedupe: restartedDeps.dedupe,
    gaps: restartedDeps.gaps,
    instanceId: INSTANCE_B,
    clock,
  });

  assert.deepEqual(restartedCollector.beginRead(), {
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_B,
    generation: 1,
    cursor: 'cursor-gen1',
    sequence: 0,
  });

  const published = restartedCollector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: now, payload: {} }],
    nextCursor: 'cursor-gen1-b',
  });
  assert.equal(published.published, 1, 'a record id that only existed in generation 0 is not a duplicate');
  assert.equal(published.duplicates, 0);
  assert.equal(
    published.items[0].stableKey,
    buildStableKey({ stableSourceId: SOURCE_ID, generation: 1, nativeRecordId: 1 }),
  );
  assert.notEqual(
    published.items[0].stableKey,
    buildStableKey({ stableSourceId: SOURCE_ID, generation: 0, nativeRecordId: 1 }),
  );
});

test('queue overflow during publish is accounted as a gap without losing events', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 4, maxBytes: 1_000_000, priorityReserveRatio: 0 });
  const deps = createRuntimeDeps(clock, queue);
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: deps.dedupe,
    gaps: deps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = Array.from({ length: 10 }, (_, index) => ({
    type: 'process_start',
    observedAt: now + index,
    payload: { pid: index },
  }));
  const result = collector.publish({ records, nextCursor: 'cursor-overflow' });

  assert.equal(result.published + result.dropped, 10);
  assert.equal(result.published, 4);
  assert.equal(result.dropped, 6);
  assert.equal(queue.stats().events, 4);
  assert.equal(queue.stats().rejected.byReason.queue_full_events, 6);

  const gap = result.gaps.find((item) => item.reason === 'queue_full_events');
  assert.notEqual(gap, undefined);
  assert.equal(gap.count, 6);
  assert.equal(gap.generation, 0);
  assert.equal(gap.start, toIsoTimestamp(now + 4));
  assert.equal(gap.end, toIsoTimestamp(now + 9));
  assert.equal(gap.durationMs, 5);
  assert.deepEqual(deps.gaps.stats().perSource, { [SOURCE_ID]: 1 });
  assert.equal(deps.gaps.stats().droppedCount, 6);

  const committed = collector.commit(result);
  assert.equal(committed.sequence, 9, 'dropped records still consume sequence numbers');
  assert.equal(result.items.filter((item) => item.outcome === 'dropped').length, 6);
  assert.deepEqual(
    result.items.filter((item) => item.outcome === 'dropped').map((item) => item.dropReason),
    Array.from({ length: 6 }, () => 'queue_full_events'),
  );
});

test('the full publish and commit path touches nothing outside workRoot', (t) => {
  const { sandbox, directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  // A sentinel inside the protected "real" directory: if anything writes there the guard
  // fails on the byte digest, not merely on an empty directory staying empty.
  const sentinel = join(sandbox.mockRealRoot, 'sentinel.bin');
  writeFileSync(sentinel, 'do-not-touch\n');

  const guard = createSnapshotGuard({ sandboxRoot: sandbox.root, protectedRoot: sandbox.mockRealRoot });
  const before = guard.capture();
  const treeBefore = listFiles(sandbox.root);

  const deps = createRuntimeDeps(clock);
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: deps.queue,
    dedupe: deps.dedupe,
    gaps: deps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });
  collector.publishAndCommit({ records: sampleRecords(now), nextCursor: 'cursor-guard' });
  collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 3, observedAt: now, payload: {} }],
    nextCursor: 'cursor-guard-2',
  });
  collector.advanceGeneration({ reason: 'log_cleared' });

  assert.equal(guard.assertUnchanged(before), true);
  assert.equal(readFileSync(sentinel, 'utf8'), 'do-not-touch\n');
  assert.equal(deps.queue.stats().events, 4);

  const created = [...listFiles(sandbox.root)].filter((path) => !treeBefore.has(path));
  assert.ok(created.length > 0, 'the collector must have produced files');
  for (const createdPath of created) {
    assert.ok(
      createdPath.startsWith(sandbox.workRoot),
      `collector wrote outside workRoot: ${createdPath}`,
    );
  }
  assert.deepEqual(
    [...listFiles(sandbox.mockRealRoot)],
    [sentinel],
    'the protected directory must stay byte-identical',
  );
});

test('a sequence source with sourceSequence discards a committed overlap', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 1_000, maxBytes: 10_000_000, priorityReserveRatio: 0.1 });
  const firstDeps = createRuntimeDeps(clock, queue);
  const firstCollector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: firstDeps.dedupe,
    gaps: firstDeps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = [0, 1, 2].map((index) => ({
    type: 'file_change',
    sourceSequence: index,
    observedAt: now + index,
    payload: { line: index },
  }));

  const committed = firstCollector.publishAndCommit({ records, nextCursor: 'offset-3' });
  assert.equal(committed.published, 3);
  assert.deepEqual(committed.items.map((item) => item.stableKey), [
    `${SOURCE_ID}#g0:s0`,
    `${SOURCE_ID}#g0:s1`,
    `${SOURCE_ID}#g0:s2`,
  ]);
  assert.equal(committed.sequence, 2);
  assert.equal(queue.stats().events, 3);

  const restartedDeps = createRuntimeDeps(clock, queue);
  const restartedCollector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: restartedDeps.dedupe,
    gaps: restartedDeps.gaps,
    instanceId: INSTANCE_B,
    clock,
  });

  const replay = restartedCollector.publishAndCommit({ records, nextCursor: 'offset-3' });
  assert.equal(replay.duplicates, 3);
  assert.equal(replay.published, 0);
  assert.equal(replay.dropped, 0);
  assert.equal(replay.sequence, 2);
  assert.equal(queue.stats().events, 3, 'the overlapping re-read must not deliver again');
});

test('a duplicate hit still advances the arrival counter', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const deps = createRuntimeDeps(clock);
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: deps.queue,
    dedupe: deps.dedupe,
    gaps: deps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 7, observedAt: now, payload: {} }],
    nextCursor: 'c1',
  });
  assert.equal(collector.identity().sequence, 0);

  const result = collector.publishAndCommit({
    records: [
      { type: 'logon', nativeRecordId: 7, observedAt: now, payload: {} },
      { type: 'logon', nativeRecordId: 8, observedAt: now + 1, payload: {} },
    ],
    nextCursor: 'c2',
  });

  assert.equal(result.duplicates, 1);
  assert.equal(result.published, 1);
  assert.equal(result.sequence, 2, 'the duplicate consumed sequence 1, the new record 2');
  assert.deepEqual(result.items.map((item) => item.stableKey), [
    `${SOURCE_ID}#g0:n7`,
    `${SOURCE_ID}#g0:n8`,
  ]);
  assert.deepEqual(collector.identity().sequence, 2);
});

test('a rejected batch leaves no side effects and can be retried', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const deps = createRuntimeDeps(clock, queue);
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: deps.dedupe,
    gaps: deps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const brokenBatch = [
    { type: 'process_start', observedAt: now, payload: { pid: 1 } },
    { type: 'process_start', observedAt: now + 1, payload: { pid: 2 } },
    { type: 'process_start', severity: 'bogus', observedAt: now + 2, payload: { pid: 3 } },
  ];

  assert.throws(
    () => collector.publish({ records: brokenBatch, nextCursor: 'cursor-broken' }),
    (error) => error.code === 'INVALID_RECORD',
  );

  assert.equal(queue.stats().events, 0, 'nothing may be queued by a rejected batch');
  assert.equal(deps.dedupe.stats().entries, 0, 'nothing may be remembered by a rejected batch');
  assert.equal(deps.gaps.stats().total, 0);
  assert.equal(collector.identity().sequence, -1);
  assert.equal(collector.identity().cursor, null);

  const retried = collector.publishAndCommit({ records: sampleRecords(now), nextCursor: 'cursor-ok' });
  assert.equal(retried.published, 3);
  assert.equal(retried.duplicates, 0);
  assert.equal(queue.stats().events, 3);
  assert.deepEqual(retried.items.map((item) => item.stableKey), [
    `${SOURCE_ID}#g0:s0`,
    `${SOURCE_ID}#g0:s1`,
    `${SOURCE_ID}#g0:s2`,
  ]);
});

test('dedupe capacity evictions are recorded as dedupe_capacity gaps', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const dedupe = createDedupeWindow({ maxPerSource: 4, maxGlobal: 100, clock });
  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe,
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = Array.from({ length: 10 }, (_, index) => ({
    type: 'process_start',
    sourceSequence: index,
    observedAt: now + index,
    payload: { pid: index },
  }));
  const result = collector.publish({ records, nextCursor: 'cursor-dedupe' });

  assert.equal(result.published, 10);
  assert.equal(dedupe.stats().evictions.count, 6);

  const gap = gaps.list({ stableSourceId: SOURCE_ID }).find((item) => item.reason === 'dedupe_capacity');
  assert.notEqual(gap, undefined);
  assert.equal(gap.count, 6);
  assert.equal(gap.start, toIsoTimestamp(now + 4));
  assert.equal(gap.end, toIsoTimestamp(now + 9));
  assert.deepEqual(gap.byReason, { dedupe_capacity: 6 });
  assert.equal(gaps.stats().droppedCount, 6);
});

test('the persisted key window bounds how much overlap a restart can discard', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const store = createCursorStore({ directory, clock });
  const queue = createEventQueue({ maxEvents: 10_000, maxBytes: 100_000_000, priorityReserveRatio: 0.1 });
  const firstDeps = createRuntimeDeps(clock, queue);
  const firstCollector = createSourceCollector({
    source: SOURCE,
    store,
    queue,
    dedupe: firstDeps.dedupe,
    gaps: firstDeps.gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = Array.from({ length: 3_000 }, (_, index) => ({
    type: 'process_start',
    sourceSequence: index,
    observedAt: now,
    payload: { pid: index },
  }));
  const committed = firstCollector.publishAndCommit({ records, nextCursor: 'cursor-3000' });
  assert.equal(committed.published, 3_000);
  assert.equal(store.load(SOURCE_ID).recentKeys.length, 2_048);

  const restartedDeps = createRuntimeDeps(clock, queue);
  const restartedCollector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: restartedDeps.dedupe,
    gaps: restartedDeps.gaps,
    instanceId: INSTANCE_B,
    clock,
  });
  const replay = restartedCollector.publish({ records, nextCursor: 'cursor-3000' });

  assert.equal(replay.duplicates, 2_048, 'only the persisted ring can be discarded locally');
  assert.equal(replay.published, 952);
  assert.equal(replay.duplicates + replay.published, 3_000);
});

test('advanceGeneration records the adapter supplied gap window', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: now, payload: {} }],
    nextCursor: 'cursor-before-clear',
  });

  now += 30_000;
  const identity = collector.advanceGeneration({
    reason: 'log_cleared',
    gapStart: BASE + 1_000,
    gapEnd: BASE + 25_000,
  });

  assert.equal(identity.generation, 1);
  const gap = gaps.list({ stableSourceId: SOURCE_ID })[0];
  assert.equal(gap.reason, 'generation_reset');
  assert.equal(gap.generation, 1);
  assert.equal(gap.start, toIsoTimestamp(BASE + 1_000));
  assert.equal(gap.end, toIsoTimestamp(BASE + 25_000));
  assert.equal(gap.durationMs, 24_000);
  assert.equal(gap.count, 0);
  assert.equal(gap.unknownCount, true);
  assert.equal(gap.approximate, false);
});

test('advanceGeneration falls back to the last observed event when no window is given', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: BASE - 5_000, payload: {} }],
    nextCursor: 'cursor-a',
  });
  collector.advanceGeneration({ reason: 'log_rotated' });

  const gap = gaps.list({ stableSourceId: SOURCE_ID })[0];
  assert.equal(gap.start, toIsoTimestamp(BASE - 5_000), 'the gap starts at the last delivered event');
  assert.equal(gap.end, toIsoTimestamp(BASE));
  assert.equal(gap.durationMs, 5_000);
});

test('identity returns a cursor copy so callers cannot rewrite collector state', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  collector.publishAndCommit({
    records: [{ type: 'logon', nativeRecordId: 1, observedAt: now, payload: {} }],
    nextCursor: { offset: 5, token: 'abc' },
  });

  const identity = collector.identity();
  assert.deepEqual(identity.cursor, { offset: 5, token: 'abc' });
  identity.cursor.offset = 9_999;
  identity.cursor.token = 'tampered';

  assert.deepEqual(collector.identity().cursor, { offset: 5, token: 'abc' });
  assert.deepEqual(collector.beginRead().cursor, { offset: 5, token: 'abc' });
});

test('a cursor the store cannot serialize is rejected before any side effect', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const dedupe = createDedupeWindow({ clock });
  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe,
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  assert.throws(
    () => collector.publish({ records: sampleRecords(now), nextCursor: 9_007_199_254_740_993n }),
    (error) => error.name === 'CollectorError' && error.code === ERROR_CODES.INVALID_ARGUMENT,
  );

  assert.equal(queue.stats().events, 0);
  assert.equal(dedupe.stats().entries, 0);
  assert.equal(gaps.stats().total, 0);
  assert.equal(collector.identity().sequence, -1);

  const ok = collector.publishAndCommit({ records: sampleRecords(now), nextCursor: 'cursor-ok' });
  assert.equal(ok.published, 3, 'the source keeps working after the rejected cursor');
});

test('a failed commit re-aligns state instead of wedging the source', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const innerStore = createCursorStore({ directory, clock });
  const store = createFlakyStore(innerStore, { failCommits: 1 });
  const collector = createSourceCollector({
    source: SOURCE,
    store,
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  assert.throws(
    () => collector.publishAndCommit({ records: sampleRecords(now), nextCursor: 'cursor-broken' }),
    (error) => error.code === ERROR_CODES.CURSOR_STORE_IO,
  );

  assert.equal(innerStore.load(SOURCE_ID), null, 'nothing was persisted');
  assert.deepEqual(collector.identity(), {
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_A,
    generation: 0,
    cursor: null,
    sequence: -1,
  });

  const retry = collector.publishAndCommit({
    records: [{ type: 'process_start', sourceSequence: 10, observedAt: now, payload: { pid: 10 } }],
    nextCursor: 'cursor-recovered',
  });

  assert.equal(retry.committed, true);
  assert.equal(retry.published, 1);
  assert.equal(innerStore.load(SOURCE_ID).cursor, 'cursor-recovered');
  assert.equal(collector.identity().sequence, 10);
});

test('abortPending drops the pending batch and allows a new publish', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const store = createCursorStore({ directory, clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store,
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  const first = collector.publish({ records: sampleRecords(now), nextCursor: 'cursor-abandoned' });
  assert.equal(first.published, 3);
  assert.equal(collector.identity().sequence, -1);

  const abandoned = collector.abortPending();
  assert.equal(abandoned.length, 3);
  assert.deepEqual(abandoned, first.items.map((item) => item.stableKey));
  assert.deepEqual(collector.abortPending(), []);
  assert.equal(store.load(SOURCE_ID), null, 'an aborted batch is never persisted');

  const second = collector.publishAndCommit({ records: sampleRecords(now), nextCursor: 'cursor-retry' });
  assert.equal(second.duplicates, 3, 'abandoned keys stay in the dedupe window');
  assert.equal(second.committed, true);
  assert.equal(store.load(SOURCE_ID).cursor, 'cursor-retry');
});

test('commit without a pending publish is rejected as stale', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  assert.throws(
    () => collector.commit({ generation: 0, sequence: 0, nextCursor: 'nothing' }),
    (error) => error.code === ERROR_CODES.STALE_BATCH,
  );
});

test('a structurally identical clone cannot be committed', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  const result = collector.publish({ records: sampleRecords(now), nextCursor: 'cursor-token' });
  const clone = { ...result };

  assert.throws(
    () => collector.commit(clone),
    (error) => error.code === ERROR_CODES.STALE_BATCH,
    'equal fields are not enough: the batch token must match',
  );

  const cursorState = collector.commit(result);
  assert.equal(cursorState.cursor, 'cursor-token');
  assert.equal(queue.stats().events, 3);
});

test('an unexpected queue failure drops one record with an adapter_degraded gap', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const innerQueue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const queue = createThrowingQueue(innerQueue, 2);
  const dedupe = createDedupeWindow({ clock });
  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe,
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = [0, 1, 2].map((index) => ({
    type: 'process_start',
    sourceSequence: index,
    observedAt: now + index,
    payload: { pid: index },
  }));
  const result = collector.publishAndCommit({ records, nextCursor: 'cursor-degraded' });

  assert.equal(result.committed, true, 'a partially successful batch still commits');
  assert.equal(result.published, 2);
  assert.equal(result.dropped, 1);
  assert.deepEqual(result.items.map((item) => item.outcome), ['published', 'dropped', 'published']);
  assert.equal(result.items[1].dropReason, 'adapter_degraded');
  assert.equal(queue.stats().events, 2);

  const gap = gaps.list({ stableSourceId: SOURCE_ID }).find((item) => item.reason === 'adapter_degraded');
  assert.notEqual(gap, undefined);
  assert.equal(gap.count, 1);
  assert.equal(gap.start, toIsoTimestamp(now + 1));
  assert.equal(gap.approximate, false);

  // At-most-once: the throwing adapter may already have queued the record, so the key
  // stays remembered and a retry reports a duplicate instead of delivering it twice.
  const retry = collector.publishAndCommit({ records, nextCursor: 'cursor-degraded-2' });
  assert.equal(retry.duplicates, 3);
  assert.equal(retry.published, 0);
  assert.equal(queue.stats().events, 2);
  assert.equal(result.dropped, gaps.stats().droppedCount);
});

test('a rejected batch does not poison the generation gap window', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const pollutedMoment = now + 10_000_000;
  assert.throws(
    () => collector.publish({
      records: [
        { type: 'process_start', observedAt: pollutedMoment, payload: { pid: 1 } },
        { type: 'process_start', severity: 'bogus', observedAt: pollutedMoment, payload: { pid: 2 } },
      ],
      nextCursor: 'cursor-bad',
    }),
    (error) => error.code === ERROR_CODES.INVALID_RECORD,
  );

  collector.advanceGeneration({ reason: 'log_rotated' });
  const gap = gaps.list({ stableSourceId: SOURCE_ID })[0];

  assert.equal(gap.start, toIsoTimestamp(now), 'the watermark only advances inside a validated batch');
  assert.notEqual(gap.start, toIsoTimestamp(pollutedMoment));
  assert.equal(gap.count, 0);
});

test('a dedupe eviction of another source is recorded against that source', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const store = createCursorStore({ directory, clock });
  const dedupe = createDedupeWindow({ clock, maxPerSource: 100, maxGlobal: 6 });
  const gaps = createGapLedger({ clock });
  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });

  const build = (stableSourceId, instanceId) => createSourceCollector({
    source: { stableSourceId, kind: 'poll', intervalMs: 5_000 },
    store,
    queue,
    dedupe,
    gaps,
    instanceId,
    clock,
  });
  const sourceB = build('linux.journald', INSTANCE_B);
  const sourceA = build(SOURCE_ID, INSTANCE_A);

  const batch = (offset) => [0, 1, 2].map((index) => ({
    type: 'process_start',
    sourceSequence: offset + index,
    observedAt: now,
    payload: { pid: offset + index },
  }));

  sourceB.publishAndCommit({ records: batch(0), nextCursor: 'b-1' });
  sourceA.publishAndCommit({ records: batch(0), nextCursor: 'a-1' });
  // Two more inserts on A push the window past maxGlobal twice; both victims are B's
  // oldest keys because B published first.
  sourceA.publishAndCommit({ records: batch(3).slice(0, 2), nextCursor: 'a-2' });

  assert.equal(dedupe.stats().entries, 6);
  assert.equal(dedupe.stats().evictions.count, 2);

  const bGaps = gaps.list({ stableSourceId: 'linux.journald' }).filter((gap) => gap.reason === 'dedupe_capacity');
  assert.equal(bGaps.length, 1);
  assert.equal(bGaps[0].count, 2, 'the two evicted keys belonged to the journald source');
  assert.equal(bGaps[0].generation, 0);

  const aGaps = gaps.list({ stableSourceId: SOURCE_ID }).filter((gap) => gap.reason === 'dedupe_capacity');
  assert.equal(aGaps.length, 0, 'the publishing source must not claim another source eviction');
});

test('a cyclic payload is a typed INVALID_RECORD and leaves no side effects', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  const dedupe = createDedupeWindow({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe,
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  const cyclic = { pid: 1 };
  cyclic.self = cyclic;

  assert.throws(
    () => collector.publish({ records: [{ type: 'process_start', payload: cyclic }], nextCursor: 'cursor-cyclic' }),
    (error) => error.name === 'CollectorError' && error.code === ERROR_CODES.INVALID_RECORD,
  );

  assert.equal(queue.stats().events, 0);
  assert.equal(dedupe.stats().entries, 0);
  assert.equal(collector.identity().sequence, -1);
});

test('a record delivered before the bookkeeping failed is not counted as dropped', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const innerQueue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  // The third admit succeeds (event queued), then the dedupe write throws: the record was
  // delivered, so it must not be reported as a drop.
  const dedupe = createThrowingDedupe(createDedupeWindow({ clock }), 3);
  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: innerQueue,
    dedupe,
    gaps,
    instanceId: INSTANCE_A,
    clock,
  });

  const records = [0, 1, 2].map((index) => ({
    type: 'process_start',
    sourceSequence: index,
    observedAt: now + index,
    payload: { pid: index },
  }));
  const result = collector.publishAndCommit({ records, nextCursor: 'cursor-delivered' });

  assert.equal(result.published, 3);
  assert.equal(result.dropped, 0);
  assert.equal(innerQueue.stats().events, 3);
  assert.equal(gaps.stats().droppedCount, 0, 'a delivered record must not inflate droppedCount');
  assert.equal(result.dropped, gaps.stats().droppedCount);

  const gap = gaps.list({ stableSourceId: SOURCE_ID }).find((item) => item.reason === 'adapter_degraded');
  assert.notEqual(gap, undefined);
  assert.equal(gap.count, 0, 'the degradation is recorded with an unknown count');
  assert.equal(gap.unknownCount, true);
});

test('a batch where the adapter failed for every record is not committed and degrades the source', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const innerQueue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  // The first three admits throw, so the whole batch fails at the adapter.
  const queue = createThrowingQueue(innerQueue, 1, { failCount: 3 });
  const store = createCursorStore({ directory, clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store,
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  const records = sampleRecords(now);
  assert.throws(
    () => collector.publish({ records, nextCursor: 'cursor-broken-adapter' }),
    (error) => error.name === 'CollectorError' && error.code === ERROR_CODES.ADAPTER_DEGRADED,
  );

  assert.equal(collector.identity().sequence, -1, 'the cursor must not advance');
  assert.equal(collector.identity().cursor, null);
  assert.equal(store.load(SOURCE_ID), null, 'nothing may be persisted for a fully failed batch');
  assert.equal(innerQueue.stats().events, 0);

  const snapshot = collector.snapshot();
  assert.equal(snapshot.lifecycle, 'degraded');
  assert.equal(snapshot.declaredLifecycle, 'degraded');
  assert.equal(snapshot.lastError.code, 'adapter_degraded');
  assert.match(snapshot.remediation, /adapter queue/);

  // The pending slot is free again, so the source keeps working once the adapter recovers.
  const recovered = collector.publishAndCommit({
    records: [
      { type: 'process_start', sourceSequence: 100, observedAt: now, payload: { pid: 100 } },
      { type: 'process_start', sourceSequence: 101, observedAt: now, payload: { pid: 101 } },
      { type: 'process_start', sourceSequence: 102, observedAt: now, payload: { pid: 102 } },
    ],
    nextCursor: 'cursor-recovered-adapter',
  });
  assert.equal(recovered.committed, true);
  assert.equal(recovered.published, 3);
});

test('a throwing adapter keeps the key so a restart replay does not deliver twice', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const innerQueue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  // The second admit delegates (event queued) and only then throws: the delivery result is
  // unknown, so the key must stay remembered and be persisted.
  const queue = createThrowingQueue(innerQueue, 2, { throwAfterDelegation: true });
  const store = createCursorStore({ directory, clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store,
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  const records = [0, 1].map((index) => ({
    type: 'process_start',
    sourceSequence: index,
    observedAt: now + index,
    payload: { pid: index },
  }));
  const result = collector.publishAndCommit({ records, nextCursor: 'cursor-unknown' });

  assert.equal(result.published, 1);
  assert.equal(result.dropped, 1);
  assert.equal(result.items[1].dropReason, 'adapter_degraded');
  assert.equal(innerQueue.stats().events, 2, 'the event reached the queue before the throw');

  const restartedDeps = createRuntimeDeps(clock, innerQueue);
  const restarted = createSourceCollector({
    source: SOURCE,
    store: createCursorStore({ directory, clock }),
    queue: innerQueue,
    dedupe: restartedDeps.dedupe,
    gaps: restartedDeps.gaps,
    instanceId: INSTANCE_B,
    clock,
  });
  const replay = restarted.publishAndCommit({ records, nextCursor: 'cursor-unknown' });

  assert.equal(replay.duplicates, 2);
  assert.equal(replay.published, 0);
  assert.equal(innerQueue.stats().events, 2, 'a restart must not deliver the unknown record again');
});

test('a cursor must survive a JSON round trip without type changes', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const store = createCursorStore({ directory, clock });
  const collector = createSourceCollector({
    source: SOURCE,
    store,
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  const rejects = (cursor) => assert.throws(
    () => collector.publish({ records: sampleRecords(now), nextCursor: cursor }),
    (error) => error.name === 'CollectorError' && error.code === ERROR_CODES.INVALID_ARGUMENT,
  );

  rejects({ offset: Number.NaN });
  rejects(new Date(0));
  rejects({ when: new Date(0) });
  rejects({ offset: 1, extra: undefined });
  assert.equal(collector.identity().sequence, -1);

  const accepted = collector.publishAndCommit({
    records: sampleRecords(now),
    nextCursor: { offset: 123, fileId: 'a' },
  });
  assert.equal(accepted.committed, true);
  assert.deepEqual(store.load(SOURCE_ID).cursor, { offset: 123, fileId: 'a' });

  const reopened = createCursorStore({ directory, clock });
  assert.deepEqual(reopened.load(SOURCE_ID).cursor, { offset: 123, fileId: 'a' });
});

test('a commit that persisted before failing re-aligns memory with the store', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const innerStore = createCursorStore({ directory, clock });
  const store = createPostCommitThrowingStore(innerStore, 1);
  const collector = createSourceCollector({
    source: SOURCE,
    store,
    queue: createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 }),
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    instanceId: INSTANCE_A,
    clock,
  });

  assert.throws(
    () => collector.publishAndCommit({ records: sampleRecords(now), nextCursor: 'cursor-post-1' }),
    (error) => error.code === ERROR_CODES.CURSOR_STORE_IO,
  );

  const persisted = innerStore.load(SOURCE_ID);
  assert.equal(persisted.cursor, 'cursor-post-1', 'the commit did land before the failure');
  assert.equal(persisted.sequence, 2);

  const identity = collector.identity();
  assert.equal(identity.generation, persisted.generation);
  assert.equal(identity.sequence, persisted.sequence);
  assert.deepEqual(identity.cursor, persisted.cursor);

  const next = collector.publishAndCommit({
    records: [{ type: 'process_start', sourceSequence: 9, observedAt: now, payload: { pid: 9 } }],
    nextCursor: 'cursor-post-2',
  });
  assert.equal(next.committed, true);
  assert.equal(next.published, 1);
  assert.equal(innerStore.load(SOURCE_ID).cursor, 'cursor-post-2');
});
