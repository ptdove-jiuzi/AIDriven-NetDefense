import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  LIMITS,
  createCollectorRuntime,
  createCursorStore,
  createDedupeWindow,
  createEventQueue,
  createGapLedger,
  createRateLimiter,
  createSourceCollector,
  resolveLimits,
  toIsoTimestamp,
} from '../../packages/collectors/common/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';

const SOURCE_A = 'windows.security-log';
const SOURCE_B = 'linux.journald';
const INSTANCE_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BASE = 1_700_000_000_000;

function createSandbox(t) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-' });
  t.after(sandbox.cleanup);
  return { sandbox, directory: join(sandbox.workRoot, 'state') };
}

test('the default limits match the designed admission rates', () => {
  assert.equal(LIMITS.perSourceEventsPerSecond, 100);
  assert.equal(LIMITS.globalEventsPerSecond, 1_000);
  assert.equal(resolveLimits({ perSourceEventsPerSecond: 5 }).perSourceEventsPerSecond, 5);
});

test('a source is limited to its own token bucket', () => {
  const now = BASE;
  const limiter = createRateLimiter({
    perSourcePerSecond: 100,
    globalPerSecond: 1_000,
    clock: () => now,
  });

  for (let index = 0; index < 100; index += 1) {
    assert.equal(limiter.tryAcquire({ sourceId: SOURCE_A, at: now }).allowed, true, `event ${index}`);
  }

  const denied = limiter.tryAcquire({ sourceId: SOURCE_A, at: now });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, 'source');
  assert.equal(denied.retryAfterMs, 10);

  // A different source starts with its own full bucket.
  assert.equal(limiter.tryAcquire({ sourceId: SOURCE_B, at: now }).allowed, true);
  assert.equal(limiter.stats().sourceCount, 2);
  assert.equal(limiter.stats().perSourcePerSecond, 100);
});

test('tokens refill lazily with elapsed time and never after a backwards clock', () => {
  let now = BASE;
  const limiter = createRateLimiter({ perSourcePerSecond: 100, globalPerSecond: 1_000, clock: () => now });

  for (let index = 0; index < 100; index += 1) {
    limiter.tryAcquire({ sourceId: SOURCE_A, at: now });
  }
  assert.equal(limiter.tryAcquire({ sourceId: SOURCE_A, at: now }).allowed, false);

  now += 10;
  assert.equal(limiter.tryAcquire({ sourceId: SOURCE_A, at: now }).allowed, true, '10ms at 100/s is one token');
  assert.equal(limiter.tryAcquire({ sourceId: SOURCE_A, at: now }).allowed, false);

  now -= 5_000;
  assert.equal(limiter.tryAcquire({ sourceId: SOURCE_A, at: now }).allowed, false, 'a clock jump refunds nothing');
});

test('the global bucket is shared across sources', () => {
  const now = BASE;
  const limiter = createRateLimiter({ perSourcePerSecond: 100, globalPerSecond: 10, clock: () => now });

  for (let index = 0; index < 6; index += 1) {
    assert.equal(limiter.tryAcquire({ sourceId: SOURCE_A, at: now }).allowed, true);
  }
  for (let index = 0; index < 4; index += 1) {
    assert.equal(limiter.tryAcquire({ sourceId: SOURCE_B, at: now }).allowed, true);
  }

  const denied = limiter.tryAcquire({ sourceId: SOURCE_B, at: now });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, 'global');
  assert.equal(limiter.stats().globalTokens, 0);
});

test('the collector drops rate limited records and records a rate_limited gap', (t) => {
  const { directory } = createSandbox(t);
  let now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 1_000, maxBytes: 10_000_000, priorityReserveRatio: 0.1 });
  const gaps = createGapLedger({ clock });
  const collector = createSourceCollector({
    source: { stableSourceId: SOURCE_A, kind: 'poll', intervalMs: 5_000 },
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps,
    rateLimiter: createRateLimiter({ perSourcePerSecond: 100, globalPerSecond: 1_000, clock }),
    instanceId: INSTANCE_ID,
    clock,
  });

  const records = Array.from({ length: 101 }, (_, index) => ({
    type: 'process_start',
    sourceSequence: index,
    observedAt: now,
    payload: { pid: index },
  }));
  const result = collector.publishAndCommit({ records, nextCursor: 'cursor-101' });

  assert.equal(result.published, 100);
  assert.equal(result.dropped, 1);
  assert.equal(result.items[100].dropReason, 'rate_limited');
  assert.equal(queue.stats().events, 100);

  const gap = gaps.list({ stableSourceId: SOURCE_A }).find((item) => item.reason === 'rate_limited');
  assert.notEqual(gap, undefined);
  assert.equal(gap.count, 1);
  assert.equal(gap.start, toIsoTimestamp(now));

  // A later second refills the buckets again.
  now += 1_000;
  const refilled = collector.publishAndCommit({
    records: [{ type: 'process_start', sourceSequence: 101, observedAt: now, payload: { pid: 101 } }],
    nextCursor: 'cursor-102',
  });
  assert.equal(refilled.published, 1);
  assert.equal(refilled.dropped, 0);
});

test('the runtime injects one shared limiter so the global bound applies across sources', (t) => {
  const { directory } = createSandbox(t);
  const now = BASE;
  const clock = () => now;

  const queue = createEventQueue({ maxEvents: 1_000, maxBytes: 10_000_000, priorityReserveRatio: 0.1 });
  const runtime = createCollectorRuntime({
    store: createCursorStore({ directory, clock }),
    queue,
    dedupe: createDedupeWindow({ clock }),
    gaps: createGapLedger({ clock }),
    clock,
    limits: resolveLimits({ globalEventsPerSecond: 5 }),
  });

  const first = runtime.addSource({ stableSourceId: SOURCE_A, kind: 'poll' });
  const second = runtime.addSource({ stableSourceId: SOURCE_B, kind: 'poll' });

  const firstBatch = first.publishAndCommit({
    records: Array.from({ length: 4 }, (_, index) => ({ type: 'process_start', sourceSequence: index, observedAt: now })),
    nextCursor: 'c-a',
  });
  const secondBatch = second.publishAndCommit({
    records: Array.from({ length: 4 }, (_, index) => ({ type: 'process_start', sourceSequence: index, observedAt: now })),
    nextCursor: 'c-b',
  });

  assert.equal(firstBatch.published, 4);
  assert.equal(secondBatch.published, 1, 'the shared bucket allows only 5 events per second');
  assert.equal(secondBatch.dropped, 3);
  assert.deepEqual(secondBatch.items.map((item) => item.dropReason), [
    null,
    'rate_limited',
    'rate_limited',
    'rate_limited',
  ]);
  assert.equal(queue.stats().events, 5);
  assert.equal(runtime.report(now).queue.events, 5);
});
