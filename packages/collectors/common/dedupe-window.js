/**
 * Bounded dedupe window for stable keys (§5.2).
 *
 * The window is deliberately memory only: durability comes from the cursor store, which
 * persists the newest stable keys alongside the cursor and seeds this window on restart.
 * When a bound is exceeded the oldest visible entries are evicted and reported, so the
 * caller can record a resource gap instead of allocating unbounded memory.
 *
 * Complexity contract: every operation is O(1) amortised. The three indexes are
 * *intrusive doubly linked lists* over the same node objects, so there is no key
 * duplication, no tombstone prefix and no scanning:
 * - `order` is the global arrival order used for TTL pruning (head only),
 * - `byPriority[priority]` gives the least valuable entry globally at its head,
 * - `bySource[sourceId]` gives the oldest entry of that source at its head.
 * Unlinking one node removes it from all three lists and the lookup map in O(1).
 *
 * Time invariant: `seenAt` is clamped to be non-decreasing across insertions, so
 * "insertion order" really is "time order" and TTL pruning can stop at the first entry
 * that is still inside the TTL. Callers are expected to pass a monotonic ingest time; a
 * backwards `at` is lifted to the previous insertion time instead of corrupting the order.
 *
 * `stats().maintenance.scannedEntries` counts every node the window actually visits, so a
 * regression back to full-table scans shows up as a counter that grows with the window
 * size instead of with the operation count.
 */

import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertNonEmptyString,
  assertTimestamp,
  isPlainObject,
} from './errors.js';
import { assertStableSourceId } from './ids.js';
import { LIMITS } from './limits.js';

export const DEDUPE_PRIORITIES = Object.freeze(['low', 'normal', 'high']);

const PRIORITY_ORDER = Object.freeze(['low', 'normal', 'high']);
const EVICTION_REASON = 'dedupe_capacity';

export function createDedupeWindow({
  maxPerSource = LIMITS.dedupeMaxPerSource,
  maxGlobal = LIMITS.dedupeMaxGlobal,
  ttlMs = LIMITS.dedupeTtlMs,
  clock = Date.now,
} = {}) {
  assertInteger('maxPerSource', maxPerSource, { min: 1 });
  assertInteger('maxGlobal', maxGlobal, { min: 1 });
  assertInteger('ttlMs', ttlMs, { min: 1 });
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }

  /** @type {Map<string, object>} key -> node */
  const entries = new Map();
  /** @type {Map<string, number>} sourceId -> live entry count */
  const sourceCounts = new Map();

  let orderHead = null;
  let orderTail = null;
  const priorityHeads = new Map(PRIORITY_ORDER.map((priority) => [priority, null]));
  const priorityTails = new Map(PRIORITY_ORDER.map((priority) => [priority, null]));
  const sourceHeads = new Map();
  const sourceTails = new Map();

  let lastInsertedAt = null;
  let scannedEntries = 0;
  let evictionCount = 0;
  const evictionByReason = { [EVICTION_REASON]: 0 };

  function now() {
    return Math.trunc(assertTimestamp('dedupe clock', clock()));
  }

  function linkOrder(node) {
    node.orderPrev = orderTail;
    node.orderNext = null;
    if (orderTail === null) {
      orderHead = node;
    } else {
      orderTail.orderNext = node;
    }
    orderTail = node;
  }

  function unlinkOrder(node) {
    if (node.orderPrev === null) {
      orderHead = node.orderNext;
    } else {
      node.orderPrev.orderNext = node.orderNext;
    }
    if (node.orderNext === null) {
      orderTail = node.orderPrev;
    } else {
      node.orderNext.orderPrev = node.orderPrev;
    }
    node.orderPrev = null;
    node.orderNext = null;
  }

  function linkPriority(node) {
    const tail = priorityTails.get(node.priority);
    node.prioPrev = tail;
    node.prioNext = null;
    if (tail === null) {
      priorityHeads.set(node.priority, node);
    } else {
      tail.prioNext = node;
    }
    priorityTails.set(node.priority, node);
  }

  function unlinkPriority(node) {
    if (node.prioPrev === null) {
      priorityHeads.set(node.priority, node.prioNext);
    } else {
      node.prioPrev.prioNext = node.prioNext;
    }
    if (node.prioNext === null) {
      priorityTails.set(node.priority, node.prioPrev);
    } else {
      node.prioNext.prioPrev = node.prioPrev;
    }
    node.prioPrev = null;
    node.prioNext = null;
  }

  function linkSource(node) {
    const tail = sourceTails.get(node.stableSourceId) ?? null;
    node.srcPrev = tail;
    node.srcNext = null;
    if (tail === null) {
      sourceHeads.set(node.stableSourceId, node);
    } else {
      tail.srcNext = node;
    }
    sourceTails.set(node.stableSourceId, node);
    sourceCounts.set(node.stableSourceId, (sourceCounts.get(node.stableSourceId) ?? 0) + 1);
  }

  function unlinkSource(node) {
    if (node.srcPrev === null) {
      sourceHeads.set(node.stableSourceId, node.srcNext);
    } else {
      node.srcPrev.srcNext = node.srcNext;
    }
    if (node.srcNext === null) {
      sourceTails.set(node.stableSourceId, node.srcPrev);
    } else {
      node.srcNext.srcPrev = node.srcPrev;
    }
    node.srcPrev = null;
    node.srcNext = null;

    const remaining = (sourceCounts.get(node.stableSourceId) ?? 1) - 1;
    if (remaining <= 0) {
      sourceCounts.delete(node.stableSourceId);
      sourceHeads.delete(node.stableSourceId);
      sourceTails.delete(node.stableSourceId);
    } else {
      sourceCounts.set(node.stableSourceId, remaining);
    }
  }

  function insert({ key, stableSourceId, priority, outcome, seenAt }) {
    const seen = lastInsertedAt === null || seenAt >= lastInsertedAt ? seenAt : lastInsertedAt;
    lastInsertedAt = seen;
    const node = {
      key,
      stableSourceId,
      priority,
      outcome,
      seenAt: seen,
      orderPrev: null,
      orderNext: null,
      prioPrev: null,
      prioNext: null,
      srcPrev: null,
      srcNext: null,
    };
    entries.set(key, node);
    linkOrder(node);
    linkPriority(node);
    linkSource(node);
    return node;
  }

  function unlinkAll(node) {
    unlinkOrder(node);
    unlinkPriority(node);
    unlinkSource(node);
    entries.delete(node.key);
    return node;
  }

  function pruneExpired(at) {
    let removed = 0;
    let node = orderHead;
    while (node !== null) {
      scannedEntries += 1;
      if (at - node.seenAt <= ttlMs) {
        break;
      }
      const next = node.orderNext;
      unlinkAll(node);
      node = next;
      removed += 1;
    }
    return removed;
  }

  function evictOldestOfSource(stableSourceId, evicted) {
    while ((sourceCounts.get(stableSourceId) ?? 0) > maxPerSource) {
      const node = sourceHeads.get(stableSourceId) ?? null;
      if (node === null) {
        return;
      }
      scannedEntries += 1;
      evicted.push(unlinkAll(node));
    }
  }

  function evictLowestPriorityOldest(evicted) {
    for (const priority of PRIORITY_ORDER) {
      const node = priorityHeads.get(priority) ?? null;
      if (node === null) {
        continue;
      }
      scannedEntries += 1;
      evicted.push(unlinkAll(node));
      return true;
    }
    return false;
  }

  function enforceLimits(stableSourceId, evicted) {
    evictOldestOfSource(stableSourceId, evicted);
    while (entries.size > maxGlobal) {
      if (!evictLowestPriorityOldest(evicted)) {
        break;
      }
    }
  }

  function summarize(evicted) {
    if (evicted.length === 0) {
      return [];
    }
    evictionCount += evicted.length;
    evictionByReason[EVICTION_REASON] += evicted.length;

    const aggregate = new Map();
    for (const node of evicted) {
      const current = aggregate.get(node.stableSourceId) ?? {
        stableSourceId: node.stableSourceId,
        count: 0,
        reason: EVICTION_REASON,
      };
      current.count += 1;
      aggregate.set(node.stableSourceId, current);
    }
    return [...aggregate.values()].map((item) => Object.freeze({ ...item }));
  }

  function validatePriority(priority) {
    if (!priorityHeads.has(priority)) {
      throw new CollectorError(
        ERROR_CODES.INVALID_ARGUMENT,
        `Unknown dedupe priority: ${String(priority)}`,
        { priority: typeof priority === 'string' ? priority : null },
      );
    }
    return priority;
  }

  function publicEntry(node) {
    return {
      key: node.key,
      stableSourceId: node.stableSourceId,
      priority: node.priority,
      outcome: node.outcome,
      seenAt: node.seenAt,
    };
  }

  return Object.freeze({
    has(key) {
      assertNonEmptyString('stable key', key);
      pruneExpired(now());
      return entries.has(key);
    },

    lookup(key) {
      assertNonEmptyString('stable key', key);
      pruneExpired(now());
      const node = entries.get(key);
      return node === undefined ? null : publicEntry(node);
    },

    remember(key, { stableSourceId, priority = 'normal', outcome = 'published', at = undefined } = {}) {
      assertNonEmptyString('stable key', key);
      assertStableSourceId(stableSourceId);
      validatePriority(priority);
      assertNonEmptyString('outcome', outcome);
      const seenAt = at === undefined ? now() : Math.trunc(assertTimestamp('seenAt', at));

      pruneExpired(seenAt);
      if (entries.has(key)) {
        return Object.freeze({ duplicate: true, evictions: Object.freeze([]) });
      }

      insert({ key, stableSourceId, priority, outcome, seenAt });
      const evicted = [];
      enforceLimits(stableSourceId, evicted);
      return Object.freeze({ duplicate: false, evictions: Object.freeze(summarize(evicted)) });
    },

    /**
     * Drop a key that must not stay remembered, e.g. because delivering that record failed
     * after the dedupe claim was taken. O(1); returns whether the key existed.
     */
    forget(key) {
      assertNonEmptyString('stable key', key);
      const node = entries.get(key);
      if (node === undefined) {
        return false;
      }
      unlinkAll(node);
      return true;
    },

    seed(seedEntries = []) {
      if (!Array.isArray(seedEntries)) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'seed entries must be an array');
      }
      const seededAt = now();
      const insertedSources = new Set();
      let seeded = 0;

      for (const item of seedEntries) {
        if (!isPlainObject(item)) {
          throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'seed entries must be plain objects');
        }
        const { key, stableSourceId, priority = 'normal', outcome = 'published', seenAt } = item;
        assertNonEmptyString('stable key', key);
        assertStableSourceId(stableSourceId);
        validatePriority(priority);
        assertNonEmptyString('outcome', outcome);
        if (entries.has(key)) {
          continue;
        }
        const at = seenAt === undefined || seenAt === null
          ? seededAt
          : Math.trunc(assertTimestamp('seed seenAt', seenAt));
        insert({ key, stableSourceId, priority, outcome, seenAt: at });
        insertedSources.add(stableSourceId);
        seeded += 1;
      }

      pruneExpired(seededAt);
      const evicted = [];
      for (const stableSourceId of insertedSources) {
        evictOldestOfSource(stableSourceId, evicted);
      }
      while (entries.size > maxGlobal && evictLowestPriorityOldest(evicted)) {
        // Keep evicting until the global bound holds.
      }
      return Object.freeze({ seeded, evictions: Object.freeze(summarize(evicted)) });
    },

    prune(at = undefined) {
      return pruneExpired(at === undefined ? now() : Math.trunc(assertTimestamp('prune at', at)));
    },

    stats() {
      return Object.freeze({
        entries: entries.size,
        sources: sourceCounts.size,
        maxGlobal,
        maxPerSource,
        ttlMs,
        evictions: Object.freeze({
          count: evictionCount,
          byReason: Object.freeze({ ...evictionByReason }),
        }),
        maintenance: Object.freeze({ scannedEntries }),
      });
    },

    clear() {
      entries.clear();
      sourceCounts.clear();
      sourceHeads.clear();
      sourceTails.clear();
      orderHead = null;
      orderTail = null;
      for (const priority of PRIORITY_ORDER) {
        priorityHeads.set(priority, null);
        priorityTails.set(priority, null);
      }
      lastInsertedAt = null;
      scannedEntries = 0;
      evictionCount = 0;
      evictionByReason[EVICTION_REASON] = 0;
    },
  });
}
