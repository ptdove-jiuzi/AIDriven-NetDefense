import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEventQueue,
  measureEventBytes,
  priorityOfEvent,
} from '../../packages/collectors/common/index.js';

function eventOfBytes(totalBytes) {
  // `{"pad":"..."}` costs 10 bytes of JSON framing, so the pad length controls the size.
  return { pad: 'x'.repeat(totalBytes - 10) };
}

test('the entry limit reserves a share for high priority events', () => {
  const queue = createEventQueue({ maxEvents: 10, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });

  for (let index = 0; index < 9; index += 1) {
    const admission = queue.admit({ sequence: index, severity: 'info' });
    assert.equal(admission.accepted, true);
    assert.equal(admission.events, index + 1);
  }

  const normalOverflow = queue.admit({ sequence: 9, severity: 'info' });
  assert.equal(normalOverflow.accepted, false);
  assert.equal(normalOverflow.reason, 'queue_full_events');
  assert.equal(normalOverflow.limits.normalEventsLimit, 9);

  const highFirst = queue.admit({ sequence: 10, severity: 'critical' }, { priority: 'high' });
  assert.equal(highFirst.accepted, true);
  assert.equal(highFirst.events, 10);

  const highOverflow = queue.admit({ sequence: 11, severity: 'high' }, { priority: 'high' });
  assert.equal(highOverflow.accepted, false);
  assert.equal(highOverflow.reason, 'queue_full_events');
  assert.equal(queue.stats().events, 10);
});

test('the byte limit reserves a share for high priority events', () => {
  const queue = createEventQueue({ maxEvents: 10_000, maxBytes: 1_000, priorityReserveRatio: 0.1 });
  const sample = eventOfBytes(100);
  assert.equal(measureEventBytes(sample), 100);

  for (let index = 0; index < 9; index += 1) {
    assert.equal(queue.admit(sample).accepted, true);
  }
  assert.equal(queue.stats().bytes, 900);

  const normalOverflow = queue.admit(sample);
  assert.equal(normalOverflow.accepted, false);
  assert.equal(normalOverflow.reason, 'queue_full_bytes');
  assert.equal(normalOverflow.sizeBytes, 100);
  assert.equal(normalOverflow.limits.normalBytesLimit, 900);

  const highFirst = queue.admit(sample, { priority: 'high' });
  assert.equal(highFirst.accepted, true);
  assert.equal(highFirst.bytes, 1_000);

  const highOverflow = queue.admit(sample, { priority: 'high' });
  assert.equal(highOverflow.accepted, false);
  assert.equal(highOverflow.reason, 'queue_full_bytes');
  assert.equal(queue.stats().bytes, 1_000);
});

test('a single event larger than maxEventBytes is rejected as too large', () => {
  const queue = createEventQueue({
    maxEvents: 100,
    maxBytes: 1_000,
    maxEventBytes: 500,
    priorityReserveRatio: 0.1,
  });
  const oversized = eventOfBytes(600);

  const admission = queue.admit(oversized, { priority: 'high' });
  assert.equal(admission.accepted, false);
  assert.equal(admission.reason, 'event_too_large');
  assert.equal(admission.sizeBytes, 600);
  assert.equal(admission.limits.maxEventBytes, 500);
  assert.equal(queue.stats().events, 0);
  assert.equal(queue.stats().rejected.byReason.event_too_large, 1);
});

test('the single-event bound is maxEventBytes, not the whole queue byte budget', () => {
  // 400 bytes is above the normal byte share (180) but below maxEventBytes, so it must be
  // rejected by the byte dimension instead of being labelled event_too_large.
  const queue = createEventQueue({ maxEvents: 100, maxBytes: 200, maxEventBytes: 1_000, priorityReserveRatio: 0.1 });
  const admission = queue.admit(eventOfBytes(400));

  assert.equal(admission.accepted, false);
  assert.equal(admission.reason, 'queue_full_bytes');
  assert.equal(admission.sizeBytes, 400);
});

test('entry and byte limits are enforced independently', () => {
  const queue = createEventQueue({ maxEvents: 10, maxBytes: 1_000, priorityReserveRatio: 0.1 });
  const large = eventOfBytes(200);

  for (let index = 0; index < 4; index += 1) {
    assert.equal(queue.admit(large).accepted, true);
  }
  assert.equal(queue.stats().events, 4);
  assert.equal(queue.stats().bytes, 800);

  const byteBound = queue.admit(large);
  assert.equal(byteBound.accepted, false);
  assert.equal(byteBound.reason, 'queue_full_bytes');
  assert.equal(queue.stats().events, 4);

  const reservedAdmission = queue.admit(eventOfBytes(100), { priority: 'high' });
  assert.equal(reservedAdmission.accepted, true);
  assert.equal(reservedAdmission.events, 5);
  assert.equal(reservedAdmission.bytes, 900);
});

test('dequeue drains high priority events first while keeping FIFO order per channel', () => {
  const queue = createEventQueue({ maxEvents: 100, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });

  queue.admit({ id: 'normal-1' });
  queue.admit({ id: 'high-1' }, { priority: 'high' });
  queue.admit({ id: 'normal-2' });
  queue.admit({ id: 'high-2' }, { priority: 'high' });

  assert.deepEqual(
    [queue.dequeue(), queue.dequeue(), queue.dequeue(), queue.dequeue()],
    [{ id: 'high-1' }, { id: 'high-2' }, { id: 'normal-1' }, { id: 'normal-2' }],
  );
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.stats().events, 0);
  assert.equal(queue.stats().bytes, 0);
});

test('stats report accepted, rejected reasons, per-channel totals and peak occupancy', () => {
  const queue = createEventQueue({ maxEvents: 4, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(queue.admit({ id: `n${index}` }).accepted, true);
  }
  for (let index = 0; index < 2; index += 1) {
    assert.equal(queue.admit({ id: `overflow${index}` }).accepted, false);
  }
  assert.equal(queue.admit({ id: 'h0' }, { priority: 'high' }).accepted, true);
  assert.equal(queue.admit({ id: 'h1' }, { priority: 'high' }).accepted, false);

  const stats = queue.stats();
  assert.equal(stats.events, 4);
  assert.equal(stats.highEvents, 1);
  assert.equal(stats.normalEvents, 3);
  assert.equal(stats.accepted, 4);
  assert.equal(stats.rejected.total, 3);
  assert.equal(stats.rejected.byReason.queue_full_events, 3);
  assert.equal(stats.rejected.byReason.queue_full_bytes, 0);
  assert.equal(stats.rejected.byReason.event_too_large, 0);
  assert.deepEqual(stats.peak, { events: 4, bytes: stats.bytes });
  assert.deepEqual(stats.limits, {
    maxEvents: 4,
    maxBytes: 1_000_000,
    maxEventBytes: 256 * 1024,
    normalEventsLimit: 3,
    normalBytesLimit: 900_000,
  });

  assert.equal(queue.drain().length, 4);
  assert.equal(queue.stats().events, 0);
  assert.deepEqual(queue.stats().peak, stats.peak);
  assert.equal(queue.admit({ id: 'after-drain' }).accepted, true);
});

test('priority defaults to the event severity', () => {
  assert.equal(priorityOfEvent({ severity: 'critical' }), 'high');
  assert.equal(priorityOfEvent({ severity: 'high' }), 'high');
  assert.equal(priorityOfEvent({ severity: 'medium' }), 'normal');
  assert.equal(priorityOfEvent({ severity: 'info' }), 'normal');

  const queue = createEventQueue({ maxEvents: 10, maxBytes: 1_000_000, priorityReserveRatio: 0.1 });
  for (let index = 0; index < 9; index += 1) {
    assert.equal(queue.admit({ severity: 'low' }).accepted, true);
  }
  assert.equal(queue.admit({ severity: 'critical' }).accepted, true);
  assert.equal(queue.stats().highEvents, 1);
  assert.equal(queue.stats().normalEvents, 9);
});

test('admit reuses a precomputed size instead of measuring the event again', () => {
  let measured = 0;
  const queue = createEventQueue({
    maxEvents: 10,
    maxBytes: 1_000,
    priorityReserveRatio: 0,
    measure: () => {
      measured += 1;
      return 1;
    },
  });

  const admission = queue.admit({ id: 'precomputed' }, { sizeBytes: 200 });
  assert.equal(admission.accepted, true);
  assert.equal(admission.sizeBytes, 200);
  assert.equal(measured, 0);
  assert.equal(queue.stats().bytes, 200);
});

test('a full 100k queue drains in linear time', () => {
  const queue = createEventQueue({ maxEvents: 100_000, maxBytes: 1_000_000_000, priorityReserveRatio: 0 });
  const startedAt = Date.now();

  for (let index = 0; index < 100_000; index += 1) {
    queue.admit({ index });
  }
  assert.equal(queue.stats().events, 100_000);

  let drained = 0;
  while (queue.dequeue() !== null) {
    drained += 1;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(drained, 100_000);
  assert.equal(queue.stats().events, 0);
  assert.ok(elapsedMs < 5_000, `admitting and draining 100k events took ${elapsedMs}ms`);
});

test('FIFO order survives the backing array compaction', () => {
  const queue = createEventQueue({ maxEvents: 5_000, maxBytes: 10_000_000, priorityReserveRatio: 0 });

  for (let index = 0; index < 3_000; index += 1) {
    queue.admit({ index });
  }

  const first = [];
  for (let index = 0; index < 2_000; index += 1) {
    first.push(queue.dequeue().index);
  }
  assert.deepEqual(first, Array.from({ length: 2_000 }, (_, index) => index));
  assert.equal(queue.stats().events, 1_000);
  assert.equal(queue.stats().normalEvents, 1_000);

  for (let index = 3_000; index < 6_000; index += 1) {
    queue.admit({ index });
  }
  assert.equal(queue.stats().events, 4_000);

  const rest = [];
  let drained = queue.dequeue();
  while (drained !== null) {
    rest.push(drained.index);
    drained = queue.dequeue();
  }
  assert.deepEqual(rest, Array.from({ length: 4_000 }, (_, index) => index + 2_000));
  assert.equal(queue.stats().events, 0);
  assert.equal(queue.stats().bytes, 0);
  assert.equal(queue.stats().peak.events, 4_000);
});
