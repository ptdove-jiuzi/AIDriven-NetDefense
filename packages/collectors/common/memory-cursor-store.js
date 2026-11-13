/**
 * In-memory cursor store with the same read → publish → commit contract as
 * {@link createCursorStore}, but without a file.
 *
 * Why it exists: the daemon already persists every source cursor in its own checkpoint
 * (`daemon-state.json`, written on a 250 ms debounce and on shutdown), so a host that
 * wires a platform collector into the daemon does not need a *second* durable cursor
 * file — it needs a store that satisfies `createCollectorRuntime({ store })` and that
 * can be **seeded from the daemon checkpoint** on the first poll (A2-SHAPE §6).
 *
 * Durability is therefore the daemon's: a crash loses at most one debounce interval of
 * cursor progress, and the replay is absorbed by the store's stable-key idempotency,
 * which is exactly the documented behaviour of the scheduler.
 *
 * The conflict rules are kept identical to the durable store so a bug in publish/commit
 * ordering fails the same way it would in production: a generation mismatch or a
 * sequence regression is an error, not silently accepted.
 */

import { CollectorError, ERROR_CODES, assertInteger, isPlainObject } from './errors.js';
import { assertGenerationReason } from './generation.js';
import { assertStableSourceId } from './ids.js';
import { LIMITS } from './limits.js';

function cloneCursor(cursor) {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  if (typeof cursor === 'string' || typeof cursor === 'number' || typeof cursor === 'boolean') {
    return cursor;
  }
  return structuredClone(cursor);
}

export function createMemoryCursorStore({
  clock = Date.now,
  persistedKeyWindow = LIMITS.persistedKeyWindow,
  initial = null,
} = {}) {
  assertInteger('persistedKeyWindow', persistedKeyWindow, { min: 1 });
  if (typeof clock !== 'function') {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      'clock must be a function returning epoch milliseconds',
    );
  }
  if (initial !== null && !isPlainObject(initial)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'initial state must be a plain object or null');
  }

  /** @type {Map<string, {stableSourceId: string, generation: number, cursor: any, sequence: number, generationReason: string|null, recentKeys: string[]}>} */
  const sources = new Map();

  function freeze(state) {
    return Object.freeze({
      stableSourceId: state.stableSourceId,
      generation: state.generation,
      cursor: cloneCursor(state.cursor),
      sequence: state.sequence,
      generationReason: state.generationReason,
      recentKeys: Object.freeze([...state.recentKeys]),
    });
  }

  function normalizeSeed(stableSourceId, value) {
    if (!isPlainObject(value)) {
      throw new CollectorError(
        ERROR_CODES.INVALID_ARGUMENT,
        `initial cursor state for ${stableSourceId} must be a plain object`,
      );
    }
    const generation = Number.isSafeInteger(value.generation) && value.generation >= 0
      ? value.generation
      : 0;
    const sequence = Number.isSafeInteger(value.sequence) && value.sequence >= -1 ? value.sequence : -1;
    return {
      stableSourceId,
      generation,
      cursor: cloneCursor(value.cursor ?? null),
      sequence,
      generationReason: null,
      recentKeys: [],
      seeded: true,
    };
  }

  for (const [stableSourceId, value] of Object.entries(initial ?? {})) {
    assertStableSourceId(stableSourceId);
    sources.set(stableSourceId, normalizeSeed(stableSourceId, value));
  }

  function appendRecentKeys(existing, additions) {
    const ordered = new Map();
    for (const key of existing) {
      ordered.delete(key);
      ordered.set(key, true);
    }
    for (const key of additions) {
      ordered.delete(key);
      ordered.set(key, true);
    }
    const keys = [...ordered.keys()];
    return keys.length > persistedKeyWindow ? keys.slice(keys.length - persistedKeyWindow) : keys;
  }

  return Object.freeze({
    /**
     * Seed a source that has no state yet — used on the first poll to restore the
     * position the daemon checkpoint remembered. A second seed for the same source is a
     * no-op: the collector is already authoritative for it.
     *
     * @param {{stableSourceId: string, generation?: number, cursor?: any, sequence?: number}} state State.
     * @returns {boolean} `true` when the state was applied.
     */
    seed(state) {
      if (!isPlainObject(state)) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'seed state must be a plain object');
      }
      const stableSourceId = assertStableSourceId(state.stableSourceId);
      if (sources.has(stableSourceId)) {
        return false;
      }
      sources.set(stableSourceId, normalizeSeed(stableSourceId, state));
      return true;
    },

    load(stableSourceId) {
      assertStableSourceId(stableSourceId);
      const state = sources.get(stableSourceId);
      return state === undefined ? null : freeze(state);
    },

    list() {
      return [...sources.keys()]
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((stableSourceId) => freeze(sources.get(stableSourceId)));
    },

    commit({
      stableSourceId,
      generation,
      cursor = null,
      sequence,
      recentKeys = [],
      generationReason = null,
    } = {}) {
      assertStableSourceId(stableSourceId);
      assertInteger('generation', generation, { min: 0 });
      assertInteger('sequence', sequence, { min: -1 });
      if (!Array.isArray(recentKeys) || recentKeys.some((key) => typeof key !== 'string')) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'recentKeys must be an array of strings');
      }
      if (generationReason !== null) {
        assertGenerationReason(generationReason);
      }

      const existing = sources.get(stableSourceId) ?? null;
      if (existing !== null) {
        if (existing.seeded !== true) {
          if (generation !== existing.generation) {
            throw new CollectorError(
              ERROR_CODES.CURSOR_STORE_CONFLICT,
              `Generation mismatch for ${stableSourceId}: stored ${existing.generation}, received ${generation}`,
              { stableSourceId, storedGeneration: existing.generation, receivedGeneration: generation },
            );
          }
          if (sequence < existing.sequence) {
            throw new CollectorError(
              ERROR_CODES.CURSOR_STORE_CONFLICT,
              `Sequence regression for ${stableSourceId}: stored ${existing.sequence}, received ${sequence}`,
              { stableSourceId, storedSequence: existing.sequence, receivedSequence: sequence },
            );
          }
        }
      }

      const next = {
        stableSourceId,
        generation,
        cursor: cloneCursor(cursor),
        sequence,
        generationReason: generationReason ?? existing?.generationReason ?? null,
        recentKeys: appendRecentKeys(existing?.recentKeys ?? [], recentKeys),
        seeded: false,
      };
      sources.set(stableSourceId, next);
      return freeze(next);
    },

    advanceGeneration({ stableSourceId, reason, cursor = null } = {}) {
      assertStableSourceId(stableSourceId);
      assertGenerationReason(reason);
      const existing = sources.get(stableSourceId) ?? null;
      const next = {
        stableSourceId,
        generation: existing === null ? 0 : existing.generation + 1,
        cursor: cloneCursor(cursor),
        sequence: -1,
        generationReason: reason,
        recentKeys: [],
        seeded: false,
      };
      sources.set(stableSourceId, next);
      return freeze(next);
    },

    quarantine() {
      return Object.freeze({ quarantined: false, path: null });
    },

    stats() {
      return Object.freeze({ sources: sources.size, bytes: 0, kind: 'memory' });
    },
  });
}
