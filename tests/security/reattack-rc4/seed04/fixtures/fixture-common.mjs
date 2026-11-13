/**
 * fixture-common.mjs — minimal `commonModule` for the SEED-04 fixture.
 *
 * `apps/daemon/bin.js` calls exactly two things on the common module:
 *   - `createMemoryCursorStore({clock})`   (the daemon owns durable cursors)
 *   - the named `createRuntime` entry point from the collectors spec
 *
 * The fixture's sources never consult the runtime cursor store (they emit a strictly
 * increasing `source_seq` themselves), so a memory-only implementation is enough; the
 * point of this file is that the fixture exercises the real daemon seam without
 * borrowing anything from the Windows collector package.
 */

export function createRuntime(options = {}) {
  return {
    bootId: options.bootId ?? null,
    clock: options.clock ?? Date.now,
    rateLimiter: options.rateLimiter ?? null,
  };
}

export function createMemoryCursorStore() {
  const rows = new Map();
  return {
    seed(entry) {
      if (entry !== null && typeof entry === 'object' && typeof entry.stableSourceId === 'string') {
        rows.set(entry.stableSourceId, { ...entry });
      }
    },
    get(stableSourceId) {
      return rows.get(stableSourceId) ?? null;
    },
    set(stableSourceId, entry) {
      rows.set(stableSourceId, { ...entry });
    },
    snapshot() {
      return [...rows.entries()];
    },
  };
}
