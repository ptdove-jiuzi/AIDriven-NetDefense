/**
 * state-store.js — bounded fingerprint state with deterministic eviction and TTL.
 *
 * Every collection here is a hard bound: the store never holds more than
 * `maxFingerprints` entries, and one sweep removes at most `maxSweepPerCall`
 * expired entries so a sweep cannot stall ingestion.
 */

import { createRateState } from './rate-limit.js';
import { severityRank } from './severity.js';

/**
 * Create the fingerprint state store.
 *
 * @param {{ maxFingerprints: number, stateTtlMs: number, maxSweepPerCall: number }} options Hard limits.
 * @returns {{
 *   get: (fingerprint: string) => object | undefined,
 *   ensure: (fingerprint: string, onEvict: (entry: object) => void) => object,
 *   touch: (entry: object, at: number) => void,
 *   size: () => number,
 *   fingerprints: () => string[],
 *   sweep: (at: number, onSweep: (removed: object[]) => void) => number
 * }} Store handle. `sweep()` reports the removed entries so the caller can drop
 * referenced alert handles, and returns how many entries were removed.
 */
export function createStateStore(options) {
  const { maxFingerprints, stateTtlMs, maxSweepPerCall } = options;
  const entries = new Map();

  function victimOf() {
    let victim = null;
    for (const entry of entries.values()) {
      if (victim === null || compareVictims(entry, victim) < 0) {
        victim = entry;
      }
    }
    return victim;
  }

  function ensure(fingerprint, onEvict) {
    const existing = entries.get(fingerprint);
    if (existing !== undefined) {
      return existing;
    }
    while (entries.size >= maxFingerprints) {
      const victim = victimOf();
      if (victim === null) {
        break;
      }
      entries.delete(victim.fingerprint);
      onEvict(victim);
    }
    const entry = {
      fingerprint,
      alert: null,
      inherited: null,
      closedWindowStart: null,
      lastSeen: 0,
      rate: createRateState(),
    };
    entries.set(fingerprint, entry);
    return entry;
  }

  function sweep(at, onSweep) {
    if (entries.size === 0) {
      return 0;
    }
    const expired = [];
    for (const entry of entries.values()) {
      if (at - entry.lastSeen >= stateTtlMs) {
        expired.push(entry);
      }
    }
    expired.sort(compareByAge);
    const removed = [];
    for (const entry of expired) {
      if (removed.length >= maxSweepPerCall) {
        break;
      }
      entries.delete(entry.fingerprint);
      removed.push(entry);
    }
    if (removed.length > 0) {
      onSweep(removed);
    }
    return removed.length;
  }

  return {
    get(fingerprint) {
      return entries.get(fingerprint);
    },
    ensure,
    touch(entry, at) {
      if (at > entry.lastSeen) {
        entry.lastSeen = at;
      }
    },
    size() {
      return entries.size;
    },
    fingerprints() {
      return [...entries.keys()].sort();
    },
    sweep,
  };
}

/** Effective severity of an entry: the open alert, otherwise the inherited value
 * of the window that was just closed. */
function entrySeverity(entry) {
  if (entry.alert !== null) {
    return entry.alert.severity;
  }
  return entry.inherited === null ? null : entry.inherited.severity;
}

function compareVictims(left, right) {
  const leftRank = severityRank(entrySeverity(left));
  const rightRank = severityRank(entrySeverity(right));
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (left.lastSeen !== right.lastSeen) {
    return left.lastSeen - right.lastSeen;
  }
  if (left.fingerprint === right.fingerprint) {
    return 0;
  }
  return left.fingerprint < right.fingerprint ? -1 : 1;
}

function compareByAge(left, right) {
  if (left.lastSeen !== right.lastSeen) {
    return left.lastSeen - right.lastSeen;
  }
  if (left.fingerprint === right.fingerprint) {
    return 0;
  }
  return left.fingerprint < right.fingerprint ? -1 : 1;
}
