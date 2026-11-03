/**
 * windows.js — bounded sliding window counters for threshold rules.
 *
 * Two hard bounds apply. Each group keeps at most `maxEvents` timestamps:
 * overflow drops the oldest timestamp and reports the drop, so the visible count
 * never exceeds what the queue can hold. The rule keeps at most `maxGroups`
 * groups: a new group evicts the least recently hit one and reports it, so a
 * high cardinality `groupBy` cannot grow memory without limit.
 */

/**
 * Create the window state of one threshold rule.
 *
 * @param {{ windowMs: number, maxEvents: number, threshold: number, maxGroups: number }} options Rule window parameters.
 * @returns {{
 *   record: (groupKey: string, at: number) => { count: number, fired: boolean, dropped: number, evictedGroups: number },
 *   prune: (at: number) => void,
 *   reset: () => void,
 *   groupCount: () => number
 * }} Window handle. `evictedGroups` reports groups dropped by the cardinality bound.
 */
export function createWindowState(options) {
  const { windowMs, maxEvents, threshold, maxGroups } = options;
  const groups = new Map();

  function record(groupKey, at) {
    let group = groups.get(groupKey);
    let evictedGroups = 0;
    if (group === undefined) {
      if (groups.size >= maxGroups) {
        evictedGroups = evictLeastRecentlyHit(groups);
      }
      group = { stamps: [], armed: true, lastHit: at };
      groups.set(groupKey, group);
    }
    const last = group.stamps.length > 0 ? group.stamps[group.stamps.length - 1] : -Infinity;
    const stamp = at > last ? at : last;
    pruneGroup(group, stamp, windowMs);
    group.stamps.push(stamp);
    group.lastHit = stamp;
    let dropped = 0;
    while (group.stamps.length > maxEvents) {
      group.stamps.shift();
      dropped += 1;
    }
    const count = group.stamps.length;
    let fired = false;
    if (count >= threshold) {
      if (group.armed) {
        fired = true;
        group.armed = false;
      }
    } else {
      group.armed = true;
    }
    return { count, fired, dropped, evictedGroups };
  }

  function prune(at) {
    for (const group of groups.values()) {
      pruneGroup(group, at, windowMs);
      if (group.stamps.length < threshold) {
        group.armed = true;
      }
    }
  }

  function reset() {
    groups.clear();
  }

  return {
    record,
    prune,
    reset,
    groupCount() {
      return groups.size;
    },
  };
}

function evictLeastRecentlyHit(groups) {
  let victimKey = null;
  let victimHit = 0;
  for (const [key, group] of groups) {
    if (victimKey === null || group.lastHit < victimHit || (group.lastHit === victimHit && key < victimKey)) {
      victimKey = key;
      victimHit = group.lastHit;
    }
  }
  if (victimKey !== null) {
    groups.delete(victimKey);
    return 1;
  }
  return 0;
}

function pruneGroup(group, at, windowMs) {
  const cutoff = at - windowMs;
  let index = 0;
  while (index < group.stamps.length && group.stamps[index] <= cutoff) {
    index += 1;
  }
  if (index > 0) {
    group.stamps.splice(0, index);
  }
}
