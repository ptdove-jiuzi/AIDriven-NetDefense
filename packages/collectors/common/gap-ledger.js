/**
 * Gap ledger: every dropped or skipped range is persisted as source + interval + reason
 * + count (§5.2). Adjacent gaps with the same cause merge into one entry; when the
 * bounds are exceeded the two oldest entries of a source fold into a
 * `gap_ledger_overflow` entry so the drop counts stay reconcilable.
 *
 * Folded entries keep a `byReason` breakdown (each original reason keeps its own count),
 * use the union interval of the folded children and are marked `approximate: true`, so a
 * reader can never mistake a folded interval for an exactly observed one.
 */

import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertTimestamp,
  toIsoTimestamp,
} from './errors.js';
import { assertStableSourceId } from './ids.js';
import { LIMITS } from './limits.js';

export const GAP_REASONS = Object.freeze([
  'queue_full_events',
  'queue_full_bytes',
  'event_too_large',
  'dedupe_capacity',
  'rate_limited',
  'read_overlap_skipped',
  'log_rotated',
  'log_truncated',
  'generation_reset',
  'permission_denied',
  'subscription_failed',
  'io_error',
  'cursor_reset',
  'adapter_degraded',
  'gap_ledger_overflow',
]);

const GAP_REASON_SET = new Set(GAP_REASONS);
const OVERFLOW_REASON = 'gap_ledger_overflow';

function freezeGap({
  stableSourceId,
  generation,
  reason,
  startMs,
  endMs,
  count,
  mergedCount,
  unknownCount,
  byReason,
  approximate,
}) {
  return Object.freeze({
    stableSourceId,
    generation,
    reason,
    start: toIsoTimestamp(startMs),
    end: toIsoTimestamp(endMs),
    durationMs: endMs - startMs,
    count,
    mergedCount,
    unknownCount,
    byReason: Object.freeze({ ...byReason }),
    approximate,
  });
}

function sumByReason(target, source) {
  for (const [reason, value] of Object.entries(source)) {
    target[reason] = (target[reason] ?? 0) + value;
  }
  return target;
}

export function createGapLedger({
  maxPerSource = LIMITS.gapMaxPerSource,
  maxTotal = LIMITS.gapMaxTotal,
  mergeWindowMs = LIMITS.gapMergeWindowMs,
  clock = Date.now,
} = {}) {
  assertInteger('maxPerSource', maxPerSource, { min: 2 });
  assertInteger('maxTotal', maxTotal, { min: 1 });
  assertInteger('mergeWindowMs', mergeWindowMs, { min: 0 });
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }

  /** @type {Map<string, ReadonlyArray<object>>} */
  const buckets = new Map();
  let recordCount = 0;
  let overflowMerges = 0;

  function sourceCount() {
    return recordCount;
  }

  function overflowMerge(stableSourceId) {
    const list = buckets.get(stableSourceId);
    if (list === undefined || list.length < 2) {
      return false;
    }

    const indexed = list
      .map((record, index) => ({ record, index, startMs: Date.parse(record.start) }))
      .sort((left, right) => left.startMs - right.startMs || left.index - right.index);
    const [first, second] = indexed;

    const startMs = Math.min(first.startMs, second.startMs, Date.parse(first.record.end), Date.parse(second.record.end));
    const endMs = Math.max(first.startMs, second.startMs, Date.parse(first.record.end), Date.parse(second.record.end));
    const byReason = sumByReason(sumByReason({}, first.record.byReason), second.record.byReason);

    const merged = freezeGap({
      stableSourceId,
      generation: first.record.generation,
      reason: OVERFLOW_REASON,
      startMs,
      endMs,
      count: first.record.count + second.record.count,
      mergedCount: first.record.mergedCount + second.record.mergedCount + 1,
      unknownCount: first.record.unknownCount || second.record.unknownCount,
      byReason,
      approximate: true,
    });

    const insertAt = Math.min(first.index, second.index);
    const rest = list.filter((_, index) => index !== first.index && index !== second.index);
    rest.splice(insertAt, 0, merged);
    buckets.set(stableSourceId, rest);
    recordCount -= 1;
    overflowMerges += 1;
    return true;
  }

  function enforceLimits() {
    for (;;) {
      let merged = false;
      for (const [stableSourceId, list] of buckets) {
        const overSource = list.length > maxPerSource;
        const overTotal = sourceCount() > maxTotal;
        if ((overSource || overTotal) && list.length >= 2) {
          merged = overflowMerge(stableSourceId);
          if (merged) {
            break;
          }
        }
      }
      if (!merged) {
        return;
      }
    }
  }

  function listGaps({ stableSourceId } = {}) {
    const collected = [];
    if (stableSourceId === undefined || stableSourceId === null) {
      for (const list of buckets.values()) {
        collected.push(...list);
      }
    } else {
      assertStableSourceId(stableSourceId);
      collected.push(...(buckets.get(stableSourceId) ?? []));
    }

    return collected
      .map((record, index) => ({ record, index }))
      .sort((left, right) => Date.parse(left.record.start) - Date.parse(right.record.start) || left.index - right.index)
      .map((item) => item.record);
  }

  return Object.freeze({
    record({
      stableSourceId,
      generation = 0,
      reason,
      start,
      end = undefined,
      count = 1,
    } = {}) {
      assertStableSourceId(stableSourceId);
      assertInteger('generation', generation, { min: 0 });
      if (!GAP_REASON_SET.has(reason)) {
        throw new CollectorError(
          ERROR_CODES.INVALID_GAP_REASON,
          `Unknown gap reason: ${String(reason)}`,
          { reason: typeof reason === 'string' ? reason : null },
        );
      }
      const startMs = Math.trunc(assertTimestamp('gap start', start));
      const requestedEndMs = end === undefined || end === null
        ? startMs
        : Math.trunc(assertTimestamp('gap end', end));
      // A backwards interval means the wall clock moved; collapse it to the start point
      // instead of throwing, and mark the entry approximate so it is not read as exact.
      const clamped = requestedEndMs < startMs;
      const endMs = clamped ? startMs : requestedEndMs;
      assertInteger('gap count', count, { min: 0 });

      const list = buckets.get(stableSourceId) ?? [];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const last = list[index];
        if (last.generation !== generation || last.reason !== reason) {
          continue;
        }
        const lastEndMs = Date.parse(last.end);
        if (startMs - lastEndMs <= mergeWindowMs) {
          const mergedEndMs = Math.max(lastEndMs, endMs);
          const mergedStartMs = Math.min(Date.parse(last.start), startMs);
          const merged = freezeGap({
            stableSourceId,
            generation,
            reason,
            startMs: mergedStartMs,
            endMs: mergedEndMs,
            count: last.count + count,
            mergedCount: last.mergedCount + 1,
            unknownCount: last.unknownCount || count === 0,
            byReason: sumByReason({ ...last.byReason }, { [reason]: count }),
            approximate: last.approximate || clamped,
          });
          list[index] = merged;
          buckets.set(stableSourceId, list);
          return merged;
        }
        break;
      }

      const created = freezeGap({
        stableSourceId,
        generation,
        reason,
        startMs,
        endMs,
        count,
        mergedCount: 0,
        unknownCount: count === 0,
        byReason: { [reason]: count },
        approximate: clamped,
      });
      list.push(created);
      buckets.set(stableSourceId, list);
      recordCount += 1;
      enforceLimits();
      return created;
    },

    list({ stableSourceId } = {}) {
      return listGaps({ stableSourceId });
    },

    drain() {
      const drained = listGaps();
      buckets.clear();
      recordCount = 0;
      overflowMerges = 0;
      return drained;
    },

    stats() {
      const perSource = {};
      for (const [stableSourceId, list] of buckets) {
        perSource[stableSourceId] = list.length;
      }
      let droppedCount = 0;
      for (const list of buckets.values()) {
        for (const record of list) {
          droppedCount += record.count;
        }
      }
      return Object.freeze({
        total: recordCount,
        perSource: Object.freeze(perSource),
        droppedCount,
        overflowMerges,
      });
    },
  });
}
