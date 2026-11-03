/**
 * Snapshot diffing for table-like Linux sources (processes, connections, units, cron
 * entries, directory entries).
 *
 * Why a diff: a 5 s `/proc` poll otherwise re-emits the whole table several times a minute.
 * Only `added` / `changed` / `removed` transitions are worth an event.
 *
 * Why the tracked table is in memory and not in the cursor: it is as large as the object
 * table (thousands of entries) and the cursor file is rewritten on every commit. The
 * documented consequence is that the first read after a restart emits one `snapshot`
 * batch whose stable keys are byte-identical to the batch emitted before the restart, so
 * the dedupe window (and, beyond the persisted 2 048 keys, the downstream unique
 * constraint) absorbs the overlap.
 *
 * This module is intentionally a local copy rather than an import from
 * `packages/collectors/windows/diff.js`: each platform adapter owns its own scope, and a
 * cross-adapter import would make one team's refactor silently change the other's
 * identity semantics. The algorithms are identical on purpose.
 *
 * Identity: `<entityId>-<digest8>`. An entity in the same state always produces the same
 * native record id; any state change produces a new one. `entityId` must not contain `#`
 * or `:`, because both delimit a stable key.
 */

import { createHash } from 'node:crypto';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonEmptyString,
  assertPositiveInteger,
} from './errors.js';

export const DEFAULT_MAX_ENTITIES = 20_000;
export const DIGEST_LENGTH = 8;

const FORBIDDEN_ID_CHARS = /[#:]/;
const MAX_ENTITY_ID_LENGTH = 200;

/** Deterministic JSON: object keys sorted, no whitespace, undefined dropped. */
export function canonicalize(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const body = keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return 'null';
}

/** 8 hex characters of SHA-256 over the canonical state. */
export function stateDigest(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
}

/** Longer digest for cases where 32 bits of collision space is too small (socket inodes). */
export function shortHash(value, length = 16) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex').slice(0, length);
}

export function assertEntityId(entityId) {
  assertNonEmptyString('entityId', entityId);
  if (FORBIDDEN_ID_CHARS.test(entityId)) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      "entityId must not contain '#' or ':' because both delimit a stable key",
      { entityId },
    );
  }
  if (entityId.length > MAX_ENTITY_ID_LENGTH) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'entityId is too long for a native record id',
      { length: entityId.length },
    );
  }
  return entityId;
}

/**
 * Build the record shape the source collector expects. `payload.change` is the transition:
 * `snapshot` on the first read after start, then `added` / `changed` / `removed`.
 */
export function buildSnapshotRecord({
  type,
  entityId,
  digest,
  observedAt,
  payload,
  change,
  severity = 'info',
}) {
  assertEntityId(entityId);
  if (typeof digest !== 'string' || digest.length !== DIGEST_LENGTH) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `digest must be ${DIGEST_LENGTH} hex characters`,
    );
  }
  return {
    nativeRecordId: `${entityId}-${digest}`,
    type,
    severity,
    observedAt,
    payload: { ...payload, change },
  };
}

export function createSnapshotDiffer({ maxEntities = DEFAULT_MAX_ENTITIES } = {}) {
  assertPositiveInteger('maxEntities', maxEntities);

  let tracked = new Map();
  let initialized = false;
  const totals = {
    added: 0,
    changed: 0,
    removed: 0,
    snapshot: 0,
    truncatedReads: 0,
    suppressedRemovals: 0,
    duplicateEntities: 0,
  };
  // `suppressedRemovals` in the return value is per call; the cumulative number stays in
  // `stats()`. A cumulative value in the read result would make every later healthy read look
  // like it lost something.
  let suppressedThisCall = 0;

  return Object.freeze({
    /**
     * Diff the current table against the previous read.
     *
     * `suppressRemovalsFor` is the permission-safety valve: when part of the table could not
     * be read, "the entity is gone" and "the entity is invisible" are indistinguishable, so
     * the caller suppresses removals instead of publishing fabricated negative evidence.
     * A suppressed entity stays tracked at its previous state, which means the diff will
     * report it as unchanged next time rather than as a new addition.
     *
     * @param {Array<{entityId: string, digest: string, payload: object}>} items
     * @param {{suppressRemovalsFor?: ((entry: {entityId: string, item: object}) => boolean)|null}} [options]
     */
    diff(items, { suppressRemovalsFor = null } = {}) {
      if (!Array.isArray(items)) {
        throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'diff input must be an array');
      }
      if (suppressRemovalsFor !== null && typeof suppressRemovalsFor !== 'function') {
        throw new LinuxCollectorError(
          LINUX_ERROR_CODES.INVALID_ARGUMENT,
          'suppressRemovalsFor must be null or a function',
        );
      }
      const truncated = items.length > maxEntities;
      const considered = truncated ? items.slice(0, maxEntities) : items;

      // Validate (and index) everything before touching `tracked`, so a rejected item cannot
      // advance the differ and silently lose the next real transition.
      const next = new Map();
      for (const item of considered) {
        if (item === null || typeof item !== 'object') {
          throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'every diff item must be an object');
        }
        assertEntityId(item.entityId);
        if (typeof item.digest !== 'string' || item.digest.length !== DIGEST_LENGTH) {
          throw new LinuxCollectorError(
            LINUX_ERROR_CODES.INVALID_ARGUMENT,
            `digest must be ${DIGEST_LENGTH} hex characters`,
            { entityId: item.entityId },
          );
        }
        if (next.has(item.entityId)) {
          // Two rows with the same identity would make the emitted record depend on row
          // order. Keep the first deterministically and report the collision.
          totals.duplicateEntities += 1;
          continue;
        }
        next.set(item.entityId, item);
      }

      suppressedThisCall = 0;
      const entries = [];
      for (const [entityId, item] of next) {
        const previous = tracked.get(entityId);
        if (previous === undefined) {
          entries.push({
            kind: initialized ? 'added' : 'snapshot',
            entityId,
            digest: item.digest,
            item,
            previous: null,
          });
        } else if (previous.digest !== item.digest) {
          entries.push({
            kind: 'changed',
            entityId,
            digest: item.digest,
            item,
            previous,
          });
        }
      }
      for (const [entityId, previous] of tracked) {
        if (!next.has(entityId)) {
          if (suppressRemovalsFor !== null && suppressRemovalsFor({ entityId, item: previous }) === true) {
            totals.suppressedRemovals += 1;
            suppressedThisCall += 1;
            next.set(entityId, previous);
            continue;
          }
          entries.push({
            kind: 'removed',
            entityId,
            // The key must describe the state that was last observed, not a new one.
            digest: previous.digest,
            item: previous,
            previous,
          });
        }
      }

      const snapshot = !initialized;
      tracked = next;
      initialized = true;
      if (truncated) {
        totals.truncatedReads += 1;
      }
      for (const entry of entries) {
        totals[entry.kind] += 1;
      }

      return {
        entries,
        snapshot,
        truncated,
        tracked: tracked.size,
        suppressedRemovals: suppressedThisCall,
        duplicateEntities: totals.duplicateEntities,
      };
    },

    reset() {
      tracked = new Map();
      initialized = false;
    },

    size() {
      return tracked.size;
    },

    stats() {
      return Object.freeze({ ...totals, tracked: tracked.size });
    },
  });
}
