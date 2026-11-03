import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_CODES,
  GAP_REASONS,
  createGapLedger,
  toIsoTimestamp,
} from '../../packages/collectors/common/index.js';

const SOURCE_ID = 'windows.file.config-path';
const BASE = 1_700_000_000_000;

function rejectsWithCode(code) {
  return (error) => error.name === 'CollectorError' && error.code === code;
}

test('adjacent gaps with the same source, generation and reason merge into one entry', () => {
  const ledger = createGapLedger({ mergeWindowMs: 1_000, clock: () => BASE });

  ledger.record({ stableSourceId: SOURCE_ID, reason: 'queue_full_events', start: BASE, end: BASE + 100, count: 2 });
  const merged = ledger.record({
    stableSourceId: SOURCE_ID,
    reason: 'queue_full_events',
    start: BASE + 600,
    end: BASE + 700,
    count: 3,
  });

  assert.equal(merged.count, 5);
  assert.equal(merged.mergedCount, 1);
  assert.equal(merged.start, toIsoTimestamp(BASE));
  assert.equal(merged.end, toIsoTimestamp(BASE + 700));
  assert.equal(merged.durationMs, 700);
  assert.deepEqual(merged.byReason, { queue_full_events: 5 });
  assert.equal(merged.approximate, false);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.stats().droppedCount, 5);
});

test('gaps with a different reason or generation stay separate', () => {
  const ledger = createGapLedger({ mergeWindowMs: 1_000, clock: () => BASE });

  ledger.record({ stableSourceId: SOURCE_ID, reason: 'queue_full_events', start: BASE, end: BASE + 10, count: 1 });
  ledger.record({ stableSourceId: SOURCE_ID, reason: 'queue_full_bytes', start: BASE + 20, end: BASE + 30, count: 1 });
  ledger.record({
    stableSourceId: SOURCE_ID,
    generation: 1,
    reason: 'queue_full_events',
    start: BASE + 40,
    end: BASE + 50,
    count: 1,
  });
  ledger.record({ stableSourceId: SOURCE_ID, reason: 'queue_full_events', start: BASE + 5_000, count: 1 });

  assert.equal(ledger.list().length, 4);
  assert.deepEqual(ledger.list().map((gap) => gap.reason), [
    'queue_full_events',
    'queue_full_bytes',
    'queue_full_events',
    'queue_full_events',
  ]);
  assert.deepEqual(ledger.list().map((gap) => gap.generation), [0, 0, 1, 0]);
});

test('exceeding the per-source bound folds the two oldest gaps without losing counts', () => {
  const ledger = createGapLedger({ maxPerSource: 4, maxTotal: 1_000, mergeWindowMs: 1_000, clock: () => BASE });

  for (let index = 0; index < 5; index += 1) {
    ledger.record({
      stableSourceId: SOURCE_ID,
      reason: 'io_error',
      start: BASE + index * 10_000,
      end: BASE + index * 10_000 + 50,
      count: 1,
    });
  }

  const stats = ledger.stats();
  assert.equal(stats.total, 4);
  assert.equal(stats.droppedCount, 5);
  assert.equal(stats.overflowMerges, 1);
  assert.equal(stats.perSource[SOURCE_ID], 4);

  const overflow = ledger.list().filter((gap) => gap.reason === 'gap_ledger_overflow');
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].count, 2);
  assert.equal(overflow[0].mergedCount, 1);
  assert.equal(overflow[0].start, toIsoTimestamp(BASE));
  assert.equal(overflow[0].end, toIsoTimestamp(BASE + 10_000 + 50));
});

test('gap intervals are RFC3339, durations are exact and a zero count is unknown', () => {
  const ledger = createGapLedger({ clock: () => BASE });

  const recorded = ledger.record({
    stableSourceId: SOURCE_ID,
    reason: 'log_rotated',
    start: new Date(BASE),
    end: toIsoTimestamp(BASE + 2_500),
    count: 3,
  });
  assert.equal(recorded.start, '2023-11-14T22:13:20.000Z');
  assert.equal(recorded.end, '2023-11-14T22:13:22.500Z');
  assert.equal(recorded.durationMs, 2_500);
  assert.equal(recorded.unknownCount, false);

  const unknown = ledger.record({
    stableSourceId: SOURCE_ID,
    reason: 'cursor_reset',
    start: BASE + 9_000,
    count: 0,
  });
  assert.equal(unknown.unknownCount, true);
  assert.equal(unknown.count, 0);
  assert.equal(unknown.durationMs, 0);

  assert.throws(
    () => ledger.record({ stableSourceId: SOURCE_ID, reason: 'not_a_reason', start: BASE }),
    rejectsWithCode(ERROR_CODES.INVALID_GAP_REASON),
  );
  assert.throws(
    () => ledger.record({ stableSourceId: SOURCE_ID, reason: 'io_error', start: BASE, count: -1 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.equal(GAP_REASONS.includes('gap_ledger_overflow'), true);

  assert.deepEqual(recorded.byReason, { log_rotated: 3 });
  assert.equal(recorded.approximate, false);
});

test('a backwards interval collapses to the start instead of throwing', () => {
  const ledger = createGapLedger({ clock: () => BASE });

  const backwards = ledger.record({
    stableSourceId: SOURCE_ID,
    reason: 'io_error',
    start: BASE + 5_000,
    end: BASE,
    count: 2,
  });

  assert.equal(backwards.start, toIsoTimestamp(BASE + 5_000));
  assert.equal(backwards.end, toIsoTimestamp(BASE + 5_000));
  assert.equal(backwards.durationMs, 0);
  assert.equal(backwards.approximate, true);
  assert.equal(backwards.count, 2);
});

test('folded gaps keep a per-reason breakdown that still sums to the dropped count', () => {
  const ledger = createGapLedger({ maxPerSource: 6, maxTotal: 1_000, mergeWindowMs: 100, clock: () => BASE });
  const reasons = ['io_error', 'queue_full_events', 'permission_denied'];

  for (let index = 0; index < 60; index += 1) {
    ledger.record({
      stableSourceId: SOURCE_ID,
      reason: reasons[index % reasons.length],
      start: BASE + index * 10_000,
      end: BASE + index * 10_000 + 100,
      count: 1,
    });
  }

  const stats = ledger.stats();
  assert.equal(stats.total, 6);
  assert.equal(stats.droppedCount, 60);
  assert.ok(stats.overflowMerges > 0);

  const byReason = { io_error: 0, queue_full_events: 0, permission_denied: 0 };
  let countSum = 0;
  for (const gap of ledger.list()) {
    countSum += gap.count;
    for (const [reason, value] of Object.entries(gap.byReason)) {
      byReason[reason] = (byReason[reason] ?? 0) + value;
    }
  }

  assert.equal(countSum, 60);
  assert.deepEqual(byReason, { io_error: 20, queue_full_events: 20, permission_denied: 20 });

  const overflow = ledger.list().filter((gap) => gap.reason === 'gap_ledger_overflow');
  assert.ok(overflow.length > 0);
  for (const gap of overflow) {
    assert.equal(gap.approximate, true);
    const reasonSum = Object.values(gap.byReason).reduce((total, value) => total + value, 0);
    assert.equal(reasonSum, gap.count);
  }
});

test('drain returns the recorded gaps and clears the ledger', () => {
  const ledger = createGapLedger({ clock: () => BASE });

  ledger.record({ stableSourceId: SOURCE_ID, reason: 'permission_denied', start: BASE, count: 4 });
  ledger.record({ stableSourceId: 'linux.journald', reason: 'subscription_failed', start: BASE + 5, count: 1 });

  const drained = ledger.drain();
  assert.equal(drained.length, 2);
  assert.deepEqual(drained.map((gap) => gap.stableSourceId), [SOURCE_ID, 'linux.journald']);
  assert.deepEqual(ledger.list(), []);
  assert.deepEqual(ledger.stats(), {
    total: 0,
    perSource: {},
    droppedCount: 0,
    overflowMerges: 0,
  });
});
