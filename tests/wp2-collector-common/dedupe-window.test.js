import assert from 'node:assert/strict';
import test from 'node:test';
import { createDedupeWindow } from '../../packages/collectors/common/index.js';

const SOURCE_A = 'windows.security-log';
const SOURCE_B = 'linux.journald';
const SOURCE_C = 'windows.file.config-path';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Array based oracle for the dedupe window. It intentionally shares no code with the
 * implementation: it keeps entries in insertion order and picks eviction victims by a
 * linear scan, so any drift in the intrusive lists shows up as a stats mismatch.
 */
function createReferenceWindow({ maxPerSource, maxGlobal, ttlMs }) {
  let list = [];
  let lastInsertedAt = null;
  let evictions = 0;

  function prune(at) {
    const kept = [];
    let removed = 0;
    for (const entry of list) {
      if (at - entry.seenAt > ttlMs) {
        removed += 1;
        continue;
      }
      kept.push(entry);
    }
    list = kept;
    return removed;
  }

  function evictOneOfSource(stableSourceId) {
    const index = list.findIndex((entry) => entry.stableSourceId === stableSourceId);
    if (index === -1) {
      return false;
    }
    list.splice(index, 1);
    evictions += 1;
    return true;
  }

  function evictOldestOfLowestPriority() {
    for (const priority of ['low', 'normal', 'high']) {
      const index = list.findIndex((entry) => entry.priority === priority);
      if (index !== -1) {
        list.splice(index, 1);
        evictions += 1;
        return true;
      }
    }
    return false;
  }

  return {
    prune,
    has(key, at) {
      prune(at);
      return list.some((entry) => entry.key === key);
    },
    remember(key, { stableSourceId, priority = 'normal', at }) {
      prune(at);
      if (list.some((entry) => entry.key === key)) {
        return true;
      }
      const seenAt = lastInsertedAt === null || at >= lastInsertedAt ? at : lastInsertedAt;
      lastInsertedAt = seenAt;
      list.push({ key, stableSourceId, priority, seenAt });
      while (list.filter((entry) => entry.stableSourceId === stableSourceId).length > maxPerSource) {
        if (!evictOneOfSource(stableSourceId)) {
          break;
        }
      }
      while (list.length > maxGlobal) {
        if (!evictOldestOfLowestPriority()) {
          break;
        }
      }
      return false;
    },
    forget(key) {
      const index = list.findIndex((entry) => entry.key === key);
      if (index === -1) {
        return false;
      }
      list.splice(index, 1);
      return true;
    },
    stats() {
      return {
        entries: list.length,
        sources: new Set(list.map((entry) => entry.stableSourceId)).size,
        evictions,
      };
    },
  };
}

test('a repeated key is a duplicate that consumes no capacity', () => {
  const clock = () => 1_700_000_000_000;
  const window = createDedupeWindow({ clock });

  const first = window.remember('key-1', { stableSourceId: SOURCE_A });
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.evictions, []);
  assert.equal(window.stats().entries, 1);

  const again = window.remember('key-1', { stableSourceId: SOURCE_A });
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.evictions, []);
  assert.equal(window.stats().entries, 1);
  assert.equal(window.stats().sources, 1);
  assert.equal(window.has('key-1'), true);
  assert.deepEqual(window.lookup('key-1'), {
    key: 'key-1',
    stableSourceId: SOURCE_A,
    priority: 'normal',
    outcome: 'published',
    seenAt: 1_700_000_000_000,
  });
  assert.equal(window.lookup('key-2'), null);
});

test('entries expire one millisecond after the TTL and can be remembered again', () => {
  let now = 1_700_000_000_000;
  const window = createDedupeWindow({ clock: () => now });

  window.remember('key-1', { stableSourceId: SOURCE_A });
  now += 86_400_000;
  assert.equal(window.has('key-1'), true, 'exactly at the TTL the key is still remembered');

  now += 1;
  assert.equal(window.has('key-1'), false);
  assert.equal(window.stats().entries, 0);

  const remembered = window.remember('key-1', { stableSourceId: SOURCE_A });
  assert.equal(remembered.duplicate, false);
  assert.equal(window.stats().entries, 1);
});

test('exceeding the per-source bound evicts the oldest entry of that source', () => {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const window = createDedupeWindow({ maxPerSource: 3, maxGlobal: 100, clock });

  for (const key of ['k1', 'k2', 'k3']) {
    now += 10;
    window.remember(key, { stableSourceId: SOURCE_A });
  }
  now += 10;
  const result = window.remember('k4', { stableSourceId: SOURCE_A });

  assert.equal(result.duplicate, false);
  assert.deepEqual(result.evictions, [{ stableSourceId: SOURCE_A, count: 1, reason: 'dedupe_capacity' }]);
  assert.equal(window.has('k1'), false);
  assert.equal(window.has('k2'), true);
  assert.equal(window.has('k3'), true);
  assert.equal(window.has('k4'), true);
  assert.equal(window.stats().entries, 3);
});

test('exceeding the global bound evicts the oldest low priority entry first', () => {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const window = createDedupeWindow({ maxPerSource: 100, maxGlobal: 3, clock });

  now += 10;
  window.remember('low-1', { stableSourceId: SOURCE_A, priority: 'low' });
  now += 10;
  window.remember('low-2', { stableSourceId: SOURCE_A, priority: 'low' });
  now += 10;
  window.remember('high-1', { stableSourceId: SOURCE_B, priority: 'high' });
  assert.equal(window.stats().entries, 3);

  now += 10;
  const firstEviction = window.remember('high-2', { stableSourceId: SOURCE_B, priority: 'high' });
  assert.deepEqual(firstEviction.evictions, [{ stableSourceId: SOURCE_A, count: 1, reason: 'dedupe_capacity' }]);
  assert.equal(window.has('low-1'), false);
  assert.equal(window.has('low-2'), true);
  assert.equal(window.has('high-1'), true);
  assert.equal(window.has('high-2'), true);

  now += 10;
  const secondEviction = window.remember('normal-1', { stableSourceId: SOURCE_A, priority: 'normal' });
  assert.deepEqual(secondEviction.evictions, [{ stableSourceId: SOURCE_A, count: 1, reason: 'dedupe_capacity' }]);
  assert.equal(window.has('low-2'), false);
  assert.equal(window.has('normal-1'), true);
  assert.equal(window.stats().evictions.count, 2);
  assert.equal(window.stats().evictions.byReason.dedupe_capacity, 2);
});

test('seeding restores keys persisted from a previous process', () => {  const now = 1_700_000_000_000;
  const window = createDedupeWindow({ clock: () => now });

  const seeded = window.seed([
    { key: 'persisted-1', stableSourceId: SOURCE_A, outcome: 'published', seenAt: now - 5_000 },
    { key: 'persisted-2', stableSourceId: SOURCE_B, outcome: 'duplicate', seenAt: now - 4_000 },
  ]);

  assert.equal(seeded.seeded, 2);
  assert.equal(window.has('persisted-1'), true);
  assert.equal(window.has('persisted-2'), true);
  assert.equal(window.stats().entries, 2);
  assert.equal(window.lookup('persisted-2').outcome, 'duplicate');

  const replay = window.remember('persisted-1', { stableSourceId: SOURCE_A });
  assert.equal(replay.duplicate, true);

  window.clear();
  assert.equal(window.has('persisted-1'), false);
  assert.equal(window.stats().entries, 0);
  assert.equal(window.stats().evictions.count, 0);
});

test('maintenance work stays bounded as the window grows', () => {
  const now = 1_700_000_000_000;
  const window = createDedupeWindow({ clock: () => now, maxPerSource: 100_000, maxGlobal: 200_000 });

  for (let index = 0; index < 20_000; index += 1) {
    window.remember(`key-${index}`, { stableSourceId: SOURCE_A, at: now });
  }
  assert.equal(window.stats().entries, 20_000);

  const before = window.stats().maintenance.scannedEntries;
  for (let index = 0; index < 20_000; index += 1) {
    window.has(`key-${index}`);
    window.remember(`extra-${index}`, { stableSourceId: SOURCE_A, at: now });
  }
  const scanned = window.stats().maintenance.scannedEntries - before;

  // A full-table scan per operation would examine ~20k entries each time (4e8 total);
  // the O(1) implementation only touches the bucket heads.
  assert.ok(scanned < 400_000, `maintenance scanned ${scanned} entries for 40k operations`);
  assert.equal(window.stats().entries, 40_000);
});

test('a saturated window keeps every operation O(1)', () => {
  const now = 1_700_000_000_000;
  const window = createDedupeWindow({ clock: () => now, maxPerSource: 50_000, maxGlobal: 50_000 });

  for (let index = 0; index < 50_000; index += 1) {
    window.remember(`key-${index}`, { stableSourceId: SOURCE_A, at: now });
  }
  assert.equal(window.stats().entries, 50_000);

  const before = window.stats().maintenance.scannedEntries;
  let worstHasCost = 0;
  for (let index = 0; index < 50_000; index += 1) {
    // Every insert is over the bound, so every operation also runs one eviction.
    window.remember(`extra-${index}`, { stableSourceId: SOURCE_A, at: now });
    const beforeHas = window.stats().maintenance.scannedEntries;
    window.has(`key-${index + 1_000}`);
    const hasCost = window.stats().maintenance.scannedEntries - beforeHas;
    if (hasCost > worstHasCost) {
      worstHasCost = hasCost;
    }
  }
  const scanned = window.stats().maintenance.scannedEntries - before;

  // Measured on this machine: ~0.65 us/op after the intrusive-list rewrite versus
  // ~12.8 us/op with the tombstone Set implementation (100k operations, 50k window).
  // No timing assertion here: the counter below is the deterministic regression guard.
  assert.ok(worstHasCost <= 2, `has() visited ${worstHasCost} nodes`);
  assert.ok(scanned < 200_000, `maintenance scanned ${scanned} nodes for 100k operations`);
  assert.equal(window.stats().entries, 50_000);
});

test('a backdated seenAt is clamped so insertion order stays time order', () => {
  let now = 1_700_000_000_000;
  const window = createDedupeWindow({ clock: () => now });

  window.remember('fresh', { stableSourceId: SOURCE_A });
  now += 1_000;
  const backdated = window.remember('backdated', {
    stableSourceId: SOURCE_A,
    at: 1_700_000_000_000 - 10 * 86_400_000,
  });

  assert.equal(backdated.duplicate, false);
  assert.equal(
    window.lookup('backdated').seenAt,
    1_700_000_000_000,
    'the backdated stamp is lifted to the previous insertion time',
  );

  now += 86_400_001;
  assert.equal(window.has('fresh'), false);
  assert.equal(window.has('backdated'), false);
  assert.equal(window.stats().entries, 0, 'both entries expire on schedule');
});

test('remember/forget/has/prune match the reference model under a deterministic fuzz', () => {
  const rng = mulberry32(0x5eed_1234);
  let now = 1_700_000_000_000;
  const options = { maxPerSource: 4, maxGlobal: 6, ttlMs: 60_000 };
  const window = createDedupeWindow({ ...options, clock: () => now });
  const reference = createReferenceWindow(options);
  const sources = [SOURCE_A, SOURCE_B, SOURCE_C];
  const priorities = ['low', 'normal', 'high'];

  for (let step = 0; step < 2_000; step += 1) {
    const roll = rng();
    const key = `k${Math.floor(rng() * 10)}`;
    const stableSourceId = sources[Math.floor(rng() * sources.length)];
    const priority = priorities[Math.floor(rng() * priorities.length)];

    if (roll < 0.5) {
      const actual = window.remember(key, { stableSourceId, priority, at: now });
      const duplicate = reference.remember(key, { stableSourceId, priority, at: now });
      assert.equal(actual.duplicate, duplicate, `duplicate mismatch at step ${step}`);
    } else if (roll < 0.7) {
      assert.equal(window.forget(key), reference.forget(key), `forget mismatch at step ${step}`);
    } else if (roll < 0.85) {
      assert.equal(window.has(key), reference.has(key, now), `has mismatch at step ${step}`);
    } else {
      now += 1 + Math.floor(rng() * 30_000);
      assert.equal(window.prune(now), reference.prune(now), `prune count mismatch at step ${step}`);
    }

    const actualStats = window.stats();
    const expectedStats = reference.stats();
    assert.equal(actualStats.entries, expectedStats.entries, `entries mismatch at step ${step}`);
    assert.equal(actualStats.sources, expectedStats.sources, `sources mismatch at step ${step}`);
    assert.equal(actualStats.evictions.count, expectedStats.evictions, `evictions mismatch at step ${step}`);
  }

  assert.ok(window.stats().evictions.count > 0, 'the fuzz must actually exercise evictions');
});
