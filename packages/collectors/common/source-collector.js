/**
 * Source collector: the read → publish → commit pipeline for one stable source (§5.2).
 *
 * Crash semantics:
 * - `publish` only mutates in-memory dedupe/queue/gap state. Nothing is durable until
 *   `commit`.
 * - A crash after publish and before commit leaves the persisted cursor untouched, so the
 *   adapter replays the overlap. Replay rebuilds the exact same stable keys because the
 *   key material comes from the adapter (`sourceSequence` / `nativeRecordId`) or from the
 *   persisted sequence counter, which is only advanced by `commit`.
 * - A crash after commit instead leaves the stable keys in the persisted ring, so the
 *   dedupe window seeded on restart discards the overlap locally.
 *
 * Adapter contract: a source without a native record id must supply `sourceSequence` (a
 * stable per-generation position: file offset, line number, journald cursor index, ...)
 * whenever it may re-read an already delivered range. Without `sourceSequence` the key is
 * built from the internal arrival counter, so an overlapping re-read after commit gets
 * *new* keys and produces duplicates; absorbing those is then the downstream consumer's
 * job via `items[].stableKey`. That is a documented adapter responsibility, not a defect.
 *
 * Batching: `publish` is two phase. Phase one validates and normalizes every record and
 * builds the event drafts; it throws before any state changes. Phase two only applies
 * dedupe lookups, size/rate/queue admission, gap accounting and dedupe insertion, and it
 * is not expected to throw for input that passed phase one. A rejected batch therefore
 * leaves the collector exactly as it was and can be retried.
 *
 * Delivery contract for `queue.admit`: it must not throw before returning; it reports
 * refusal through `{ accepted: false }`. If it does throw, the delivery result is unknown,
 * so the collector treats the record as *possibly delivered*: the stable key stays
 * remembered (and is persisted on commit) and the record is reported as `dropped` with an
 * `adapter_degraded` gap. This is at-most-once on purpose — a duplicate is worse than a
 * gap that the operator can see. A batch where every record failed this way is not
 * committed at all: `publish` throws `ADAPTER_DEGRADED` and the source is degraded.
 */

import { isDeepStrictEqual } from 'node:util';
import { createCapability } from './capability.js';
import { createDedupeWindow } from './dedupe-window.js';
import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertTimestamp,
  isPlainObject,
} from './errors.js';
import { createEventQueue } from './event-queue.js';
import { createEventFactory, measureEventBytes, priorityOfEvent } from './events.js';
import { createGapLedger } from './gap-ledger.js';
import { evaluateSourceIdentity } from './generation.js';
import {
  assertCollectorInstanceId,
  assertStableSourceId,
  buildStableKey,
  createCollectorInstanceId,
} from './ids.js';
import { LIMITS } from './limits.js';

const GAP_REASON_BY_GENERATION_REASON = Object.freeze({
  log_rotated: 'log_rotated',
  log_truncated: 'log_truncated',
});

// Identity token of a published batch. It never leaves this module except as a
// non-enumerable symbol property, so a structurally identical clone cannot be committed.
const BATCH_TOKEN = Symbol('collectorBatchToken');

function generationGapReason(reason) {
  return GAP_REASON_BY_GENERATION_REASON[reason] ?? 'generation_reset';
}

function assertSerializableCursor(nextCursor) {
  if (nextCursor === null) {
    return;
  }
  let raw;
  try {
    raw = JSON.stringify(nextCursor);
  } catch (error) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      `nextCursor must be JSON serializable: ${error.message}`,
      { reason: error.name },
    );
  }
  if (raw === undefined) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      'nextCursor must be JSON serializable',
      { type: typeof nextCursor },
    );
  }

  let restored;
  try {
    restored = JSON.parse(raw);
  } catch (error) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      `nextCursor must survive a JSON round trip: ${error.message}`,
      { reason: error.name },
    );
  }

  if (JSON.stringify(restored) !== raw) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'nextCursor must survive a JSON round trip');
  }
  // The string comparison alone accepts lossy values (NaN becomes null, a Date becomes a
  // string), so compare the structure as well: the persisted cursor must read back with
  // the same types it was written with.
  if (!isDeepStrictEqual(restored, nextCursor)) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      'nextCursor must survive a JSON round trip without type changes',
    );
  }
}

function cloneCursor(cursor) {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  if (typeof cursor !== 'object') {
    return cursor;
  }
  return structuredClone(cursor);
}

export function createSourceCollector({
  source,
  store,
  queue = null,
  dedupe = null,
  gaps = null,
  capability = null,
  rateLimiter = null,
  instanceId = null,
  clock = Date.now,
  idFactory = undefined,
  bootId = null,
  limits = LIMITS,
} = {}) {
  if (!isPlainObject(source)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'source configuration must be a plain object');
  }
  if (!store || typeof store.load !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'a cursor store is required');
  }
  if (!isPlainObject(limits)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'limits must be an object');
  }
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }
  if (rateLimiter !== null && typeof rateLimiter.tryAcquire !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'rateLimiter must be null or expose tryAcquire');
  }

  const stableSourceId = assertStableSourceId(source.stableSourceId);
  const kind = source.kind ?? 'poll';
  const intervalMs = source.intervalMs ?? 5_000;
  const subscriptionProbeIntervalMs = source.subscriptionProbeIntervalMs ?? LIMITS.subscriptionProbeIntervalMs;
  const collectorInstanceId = instanceId === null || instanceId === undefined
    ? createCollectorInstanceId()
    : assertCollectorInstanceId(instanceId);

  const queueRef = queue ?? createEventQueue({
    maxEvents: limits.queueMaxEvents,
    maxBytes: limits.queueMaxBytes,
    maxEventBytes: limits.maxEventBytes,
    priorityReserveRatio: limits.queuePriorityReserveRatio,
  });
  const dedupeRef = dedupe ?? createDedupeWindow({
    maxPerSource: limits.dedupeMaxPerSource,
    maxGlobal: limits.dedupeMaxGlobal,
    ttlMs: limits.dedupeTtlMs,
    clock,
  });
  const gapsRef = gaps ?? createGapLedger({
    maxPerSource: limits.gapMaxPerSource,
    maxTotal: limits.gapMaxTotal,
    mergeWindowMs: limits.gapMergeWindowMs,
    clock,
  });
  const capabilityRef = capability ?? createCapability({
    stableSourceId,
    collectorInstanceId,
    kind,
    intervalMs,
    subscriptionProbeIntervalMs,
    clock,
  });

  const factory = createEventFactory({ clock, ...(idFactory === undefined ? {} : { idFactory }), bootId });
  const persisted = store.load(stableSourceId);

  let generation = persisted === null ? 0 : persisted.generation;
  let sequence = persisted === null ? -1 : persisted.sequence;
  let cursor = persisted === null ? null : persisted.cursor;
  let lastObservedAtMs = null;

  if (persisted !== null && persisted.recentKeys.length > 0) {
    const seededAt = Math.trunc(assertTimestamp('collector clock', clock()));
    dedupeRef.seed(persisted.recentKeys.map((key) => ({
      key,
      stableSourceId,
      priority: 'normal',
      outcome: 'published',
      seenAt: seededAt,
    })));
  }

  let pending = null;
  let publishedTotal = 0;
  let duplicatesTotal = 0;
  let droppedTotal = 0;

  function readClock() {
    return Math.trunc(assertTimestamp('collector clock', clock()));
  }

  function identity() {
    return Object.freeze({
      stableSourceId,
      collectorInstanceId,
      generation,
      cursor: cloneCursor(cursor),
      sequence,
    });
  }

  /**
   * Publish one read batch without persisting anything.
   *
   * Adapter contract: `record.sourceSequence` is the stable position of the record inside
   * the current generation (file offset, line number, journald cursor index, ...). A
   * source without a native record id MUST set it whenever an overlapping re-read is
   * possible; without it the key falls back to the internal arrival counter, so a
   * committed range that is read again yields new keys and the duplicates can only be
   * absorbed downstream through `items[].stableKey`.
   */
  function publish({ records = [], nextCursor = null, generation: batchGeneration = generation, at = undefined } = {}) {
    if (pending !== null) {
      throw new CollectorError(
        ERROR_CODES.UNCOMMITTED_BATCH,
        `A published batch for ${stableSourceId} is still waiting for commit`,
      );
    }
    if (!Array.isArray(records)) {
      throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'publish records must be an array');
    }

    const batchGen = assertInteger('generation', batchGeneration, { min: 0 });
    if (batchGen !== generation) {
      throw new CollectorError(
        ERROR_CODES.STALE_BATCH,
        `Batch generation ${batchGen} does not match collector generation ${generation}`,
        { stableSourceId, batchGeneration: batchGen, generation },
      );
    }

    const publishAtMs = at === undefined || at === null ? null : Math.trunc(assertTimestamp('publish at', at));
    // A cursor the store cannot serialize would only fail later inside `commit`, after the
    // queue and the dedupe window were already mutated. Reject it up front instead.
    assertSerializableCursor(nextCursor);
    const ingestAtMs = readClock();
    let localSequence = sequence;
    let batchMaxObservedMs = null;

    // ---- phase one: validate, normalize, precompute. No shared state is touched. ----
    const drafts = [];
    for (const record of records) {
      if (!isPlainObject(record)) {
        throw new CollectorError(ERROR_CODES.INVALID_RECORD, 'each record must be a plain object');
      }

      const nativeRecordId = record.nativeRecordId === undefined ? null : record.nativeRecordId;
      const sourceSequence = record.sourceSequence === undefined || record.sourceSequence === null
        ? null
        : assertInteger('sourceSequence', record.sourceSequence, { min: 0 });
      const observedAtMs = record.observedAt === undefined || record.observedAt === null
        ? (publishAtMs ?? ingestAtMs)
        : Math.trunc(assertTimestamp('record observedAt', record.observedAt));

      // Every record consumes a counter tick even if it later turns out to be a duplicate,
      // so key assignment never depends on dedupe outcomes.
      let eventSequence;
      if (sourceSequence === null) {
        localSequence += 1;
        eventSequence = localSequence;
      } else {
        eventSequence = sourceSequence;
        if (sourceSequence > localSequence) {
          localSequence = sourceSequence;
        }
      }

      const stableKey = buildStableKey({
        stableSourceId,
        generation: batchGen,
        nativeRecordId,
        sequence: nativeRecordId === null ? eventSequence : null,
      });

      const event = factory.create({
        stableSourceId,
        collectorInstanceId,
        generation: batchGen,
        sequence: eventSequence,
        nativeRecordId,
        observedAt: observedAtMs,
        type: record.type,
        severity: record.severity,
        payload: record.payload,
        integrity: record.integrity,
      });

      drafts.push(Object.freeze({
        record,
        stableKey,
        event,
        observedAtMs,
        priority: priorityOfEvent(event),
        sizeBytes: measureEventBytes(event),
      }));

      if (batchMaxObservedMs === null || observedAtMs > batchMaxObservedMs) {
        batchMaxObservedMs = observedAtMs;
      }
    }

    // The watermark only advances once the whole batch has been validated, and phase two
    // never writes it again, so a rejected batch cannot poison the next generation gap.
    if (batchMaxObservedMs !== null && (lastObservedAtMs === null || batchMaxObservedMs > lastObservedAtMs)) {
      lastObservedAtMs = batchMaxObservedMs;
    }

    // ---- phase two: side effects only. Validated input must not throw here. ----
    const items = [];
    const gapAggregate = new Map();
    let publishedCount = 0;
    let duplicateCount = 0;
    let droppedCount = 0;

    function addGap(gapSourceId, reason, momentMs, count = 1) {
      const bucketKey = `${gapSourceId}\u0000${reason}`;
      const current = gapAggregate.get(bucketKey)
        ?? { stableSourceId: gapSourceId, reason, startMs: momentMs, endMs: momentMs, count: 0 };
      current.startMs = Math.min(current.startMs, momentMs);
      current.endMs = Math.max(current.endMs, momentMs);
      current.count += count;
      gapAggregate.set(bucketKey, current);
    }

    function rememberQuietly(draft) {
      try {
        dedupeRef.remember(draft.stableKey, {
          stableSourceId,
          priority: draft.priority,
          outcome: 'dropped',
          at: ingestAtMs,
        });
      } catch {
        // If the dedupe window itself is failing there is nothing left to protect.
      }
    }

    for (const draft of drafts) {
      if (dedupeRef.has(draft.stableKey)) {
        duplicateCount += 1;
        items.push(Object.freeze({
          stableKey: draft.stableKey,
          record: draft.record,
          event: null,
          outcome: 'duplicate',
          dropReason: null,
        }));
        continue;
      }

      let outcome = 'published';
      let dropReason = null;
      let admitted = false;

      try {
        if (draft.sizeBytes > limits.maxEventBytes) {
          outcome = 'dropped';
          dropReason = 'event_too_large';
        } else {
          const gate = rateLimiter === null
            ? null
            : rateLimiter.tryAcquire({ sourceId: stableSourceId, at: ingestAtMs });

          if (gate !== null && gate.allowed !== true) {
            outcome = 'dropped';
            dropReason = 'rate_limited';
          } else {
            const admission = queueRef.admit(draft.event, {
              priority: draft.priority,
              sourceId: stableSourceId,
              sizeBytes: draft.sizeBytes,
            });
            if (admission.accepted) {
              admitted = true;
            } else {
              outcome = 'dropped';
              dropReason = admission.reason;
            }
          }
        }

        // Retention is measured from ingest, not from the record timestamp, so a backfill
        // of old records still occupies a dedupe slot for the full TTL.
        const remembered = dedupeRef.remember(draft.stableKey, {
          stableSourceId,
          priority: draft.priority,
          outcome,
          at: ingestAtMs,
        });

        if (admitted) {
          publishedCount += 1;
          capabilityRef.recordEvent(draft.observedAtMs);
        } else {
          droppedCount += 1;
          addGap(stableSourceId, dropReason, draft.observedAtMs);
        }
        // Evictions are reported against the source that owned the evicted key, which may
        // not be the source being published when the window is shared.
        for (const eviction of remembered.evictions) {
          addGap(eviction.stableSourceId, 'dedupe_capacity', draft.observedAtMs, eviction.count);
        }
      } catch (error) {
        // An adapter that throws has an unknown delivery result, so the key stays
        // remembered (at-most-once) instead of being released for a second delivery. The
        // claim is also what gets persisted, so a restart replay treats it as duplicate.
        rememberQuietly(draft);
        if (admitted) {
          publishedCount += 1;
          capabilityRef.recordEvent(draft.observedAtMs);
          outcome = 'published';
          dropReason = null;
          // Delivered, but the bookkeeping failed afterwards: account for the degradation
          // with an unknown (zero) count so it never inflates `dropped`.
          addGap(stableSourceId, 'adapter_degraded', draft.observedAtMs, 0);
        } else {
          outcome = 'dropped';
          dropReason = 'adapter_degraded';
          droppedCount += 1;
          addGap(stableSourceId, 'adapter_degraded', draft.observedAtMs, 1);
        }
      }

      items.push(Object.freeze({
        stableKey: draft.stableKey,
        record: draft.record,
        event: draft.event,
        outcome,
        dropReason,
      }));
    }

    const gapRecords = [];
    for (const entry of gapAggregate.values()) {
      gapRecords.push(gapsRef.record({
        stableSourceId: entry.stableSourceId,
        // The window does not track the generation of a foreign source, so an eviction
        // gap for another source is attributed to generation 0.
        generation: entry.stableSourceId === stableSourceId ? batchGen : 0,
        reason: entry.reason,
        start: entry.startMs,
        end: entry.endMs,
        count: entry.count,
      }));
    }

    // A batch where literally nothing was delivered and every failure came from the
    // adapter is not a successful read: refuse to commit it (the cursor must not advance)
    // and degrade the source so it cannot keep reporting healthy.
    const adapterFailures = items.filter((item) => item.dropReason === 'adapter_degraded').length;
    if (records.length > 0 && publishedCount === 0 && duplicateCount === 0 && adapterFailures === items.length) {
      capabilityRef.recordError({
        code: 'adapter_degraded',
        message: 'The collector adapter failed for every record of the batch',
        remediation: 'Verify the collector adapter queue and restart the source',
      });
      throw new CollectorError(
        ERROR_CODES.ADAPTER_DEGRADED,
        `Adapter failed for every record of ${stableSourceId}; the batch was not committed`,
        { stableSourceId, records: records.length, gaps: gapRecords.length },
      );
    }

    const result = {
      generation: batchGen,
      nextCursor,
      sequence: localSequence,
      items: Object.freeze(items),
      published: publishedCount,
      duplicates: duplicateCount,
      dropped: droppedCount,
      gaps: Object.freeze(gapRecords),
    };
    const token = Symbol('collectorBatch');
    Object.defineProperty(result, BATCH_TOKEN, { value: token, enumerable: false });
    Object.freeze(result);

    // Every key of this batch is persisted, including records lost to an adapter failure:
    // those keys were kept remembered for at-most-once delivery.
    const persistedKeys = items.map((item) => item.stableKey);

    pending = Object.freeze({ result, keys: Object.freeze(persistedKeys), token });
    publishedTotal += publishedCount;
    duplicatesTotal += duplicateCount;
    droppedTotal += droppedCount;
    return result;
  }

  function commit(result) {
    if (pending === null) {
      throw new CollectorError(ERROR_CODES.STALE_BATCH, `No published batch is waiting for commit on ${stableSourceId}`);
    }
    if (result === null || typeof result !== 'object' || result[BATCH_TOKEN] === undefined
      || result[BATCH_TOKEN] !== pending.token) {
      throw new CollectorError(
        ERROR_CODES.STALE_BATCH,
        'Batch does not belong to the pending publish of this collector',
        { stableSourceId },
      );
    }

    const pendingResult = pending.result;
    let cursorState;
    try {
      cursorState = store.commit({
        stableSourceId,
        generation: pendingResult.generation,
        cursor: pendingResult.nextCursor,
        sequence: pendingResult.sequence,
        recentKeys: pending.keys,
        generationReason: null,
      });
    } catch (error) {
      // A failed commit must not wedge the source: drop the pending batch, re-align with
      // whatever the store really holds (it may have advanced before failing), and let the
      // caller retry or read again.
      pending = null;
      try {
        const reloaded = store.load(stableSourceId);
        if (reloaded !== null) {
          generation = reloaded.generation;
          sequence = reloaded.sequence;
          cursor = cloneCursor(reloaded.cursor);
        }
      } catch {
        // If even the reload fails, keep the in-memory state; the commit error is the
        // actionable one for the caller.
      }
      throw error;
    }

    generation = pendingResult.generation;
    cursor = cloneCursor(pendingResult.nextCursor);
    sequence = pendingResult.sequence;
    pending = null;
    // A committed batch means the read itself succeeded, even when every record was
    // dropped: poll freshness must advance on reads, not on delivered events.
    capabilityRef.recordSuccess(readClock());
    return cursorState;
  }

  /**
   * Discard the pending batch without persisting it. The stable keys stay in the dedupe
   * window on purpose: those events may already be queued, so forgetting them would let a
   * retry deliver them twice.
   */
  function abortPending() {
    if (pending === null) {
      return Object.freeze([]);
    }
    const keys = [...pending.keys];
    pending = null;
    return Object.freeze(keys);
  }

  function publishAndCommit(args = {}) {
    const result = publish(args);
    const cursorState = commit(result);
    return Object.freeze({ ...result, committed: true, cursorState });
  }

  function advanceGeneration({
    reason,
    cursor: nextCursor = null,
    gapStart = undefined,
    gapEnd = undefined,
  } = {}) {
    if (pending !== null) {
      throw new CollectorError(
        ERROR_CODES.UNCOMMITTED_BATCH,
        `Cannot advance the generation of ${stableSourceId} while a batch is uncommitted`,
      );
    }

    const state = store.advanceGeneration({ stableSourceId, reason, cursor: nextCursor });
    generation = state.generation;
    sequence = state.sequence;
    cursor = state.cursor;

    const nowMs = readClock();
    const startMs = gapStart === undefined || gapStart === null
      ? (lastObservedAtMs ?? nowMs)
      : Math.trunc(assertTimestamp('gapStart', gapStart));
    const requestedEndMs = gapEnd === undefined || gapEnd === null
      ? nowMs
      : Math.trunc(assertTimestamp('gapEnd', gapEnd));
    const endMs = Math.max(startMs, requestedEndMs);

    const gap = gapsRef.record({
      stableSourceId,
      generation,
      reason: generationGapReason(reason),
      start: startMs,
      end: endMs,
      count: 0,
    });
    capabilityRef.recordGap(gap);
    return identity();
  }

  return Object.freeze({
    identity,

    beginRead() {
      return identity();
    },

    publish,
    commit,
    abortPending,
    publishAndCommit,
    advanceGeneration,

    detectIdentityChange(current, previous) {
      return evaluateSourceIdentity({ previous, current });
    },

    noteError(args = {}) {
      return capabilityRef.recordError(args);
    },

    probeSubscription({ ok, at = undefined } = {}) {
      return capabilityRef.recordSubscriptionProbe({ ok, at: at === undefined ? readClock() : at });
    },

    snapshot(at = undefined) {
      return Object.freeze({
        ...capabilityRef.snapshot(at),
        queue: queueRef.stats(),
        identity: identity(),
      });
    },

    stats() {
      return Object.freeze({
        identity: identity(),
        published: publishedTotal,
        duplicates: duplicatesTotal,
        dropped: droppedTotal,
        gaps: gapsRef.stats(),
      });
    },
  });
}
