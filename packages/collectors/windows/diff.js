/**
 * Snapshot diffing for table-like Windows sources (processes, connections, services,
 * scheduled tasks, Run keys, file metadata).
 *
 * Why a diff at all: a 5 s process poll otherwise emits the identical table hundreds of
 * times per minute. Only `added` / `changed` / `removed` transitions are worth an event.
 *
 * Why the state lives in memory and not in the cursor: the tracked digest table is as
 * large as the object table (thousands of entries). Persisting it would grow the cursor
 * file without bound, and the cursor file is rewritten on every commit. The documented
 * consequence is that after a collector restart the first read re-emits one `snapshot`
 * batch. For every entity that was never observed in another state the replayed key is the
 * key it was first published under (revision 1), so the dedupe window absorbs the overlap.
 * An entity that changed at least once before the restart is re-emitted once under revision 1
 * instead of its last revision, which the dedupe window can no longer recognise: the restart
 * replays that entity once. That replay is bounded by the number of entities that changed,
 * happens once per restart, and is strictly preferable to dropping transitions.
 *
 * Identity: `<entityId>-<digest16>-<p|r><revision>`.
 *
 * Why the revision suffix: the common layer deduplicates by stable key, and the stable key is
 * derived from the native record id. With an id of `<entityId>-<digest>` a removal reuses the
 * digest of the state that was last observed, so its key was byte-identical to the `present`
 * event published before it — the dedupe window (50 000 keys / 24 h) swallowed the removal and
 * there was no second chance. The same held for any state the entity had already been seen in
 * (A → B → A), which made a reverted change invisible. A per-entity `revision`, incremented on
 * every emitted transition and also for a removal, makes every transition a distinct key while
 * keeping a genuinely repeated, unchanged read key-identical (the differ emits nothing for it,
 * and a restart replay of an unchanged table keeps revision 1 and is still absorbed).
 *
 * `entityId` itself must not contain `#` or `:`, because those delimit a stable key.
 */

import { createHash } from 'node:crypto';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from './errors.js';
import { normalizePayload } from './payload.js';

export const DEFAULT_MAX_ENTITIES = 20_000;

// 64 bits of SHA-256. 8 hex characters (32 bit) was too weak: at the 20 000-entity bound the
// birthday collision probability is ~4.6 %, and a collision would silently merge two distinct
// services, tasks or registry values into one identity.
const DIGEST_LENGTH = 16;
const FORBIDDEN_ID_CHARS = /[#:]/;
const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,45}$/;

/**
 * Turn an arbitrary Windows identifier (service name, registry value name, relative path)
 * into a token that is safe inside an entity id.
 *
 * Entity ids must not contain '#' or ':' (both delimit a stable key) and are capped at 200
 * characters, but Windows identifiers are much freer than that. Replacing the offending
 * characters with '-' is not injective — `2001:db8::1` and `2001-db8--1`, or two registry
 * value names differing only in a colon, would collapse into one identity. Hashing the
 * whole value instead keeps the mapping deterministic *and* injective.
 */
export function identityToken(value) {
  const text = String(value ?? '');
  if (SAFE_TOKEN.test(text)) {
    return text;
  }
  return `h${stateDigest(text)}`;
}

/** Deterministic JSON: object keys sorted, no whitespace. */
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

export function assertEntityId(entityId) {
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'entityId must be a non-empty string');
  }
  if (FORBIDDEN_ID_CHARS.test(entityId)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      "entityId must not contain '#' or ':' because both delimit a stable key",
      { details: { entityId } },
    );
  }
  if (entityId.length > 200) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'entityId is too long for a native record id',
      { details: { length: entityId.length } },
    );
  }
  return entityId;
}

export function assertDigest(digest) {
  if (typeof digest !== 'string' || digest.length !== DIGEST_LENGTH || !/^[0-9a-f]+$/.test(digest)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      `digest must be ${DIGEST_LENGTH} lowercase hex characters`,
      { details: { type: typeof digest } },
    );
  }
  return digest;
}

/**
 * Build the record the source collector expects. `payload.change` is the transition kind:
 * `snapshot` on the first read after start, then `added` / `changed` / `removed`.
 *
 * `revision` must be the per-entity transition counter handed out by `createSnapshotDiffer`.
 * It is what keeps a `removed` (or a reverted state) from colliding with the key of the event
 * that reported the entity as present. Callers outside the differ default to 1, which is only
 * correct for a first observation.
 *
 * The payload is normalized here as a last line of defence: a source that forgets to call
 * `buildPayload` still cannot emit a camelCase key or a `null` value into a contract that
 * rejects both.
 */
export function buildSnapshotRecord({
  type,
  entityId,
  digest,
  observedAt,
  payload,
  change,
  revision = 1,
  severity = 'info',
}) {
  assertEntityId(entityId);
  assertDigest(digest);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'revision must be a positive integer',
      { details: { type: typeof revision } },
    );
  }
  const { payload: normalized, dropped } = normalizePayload({ ...payload, change });
  // `p` / `r` makes the presence side of the transition part of the identity, so a removal can
  // never be mistaken for the event that announced the entity, even if revision bookkeeping
  // were ever lost for one entity.
  const presence = change === 'removed' ? 'r' : 'p';
  return {
    nativeRecordId: `${entityId}-${digest}-${presence}${revision}`,
    type,
    severity,
    observedAt,
    payload: normalized,
    ...(dropped.length === 0 ? {} : { payloadDropped: dropped }),
  };
}

export function createSnapshotDiffer({ maxEntities = DEFAULT_MAX_ENTITIES } = {}) {
  if (!Number.isSafeInteger(maxEntities) || maxEntities < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'maxEntities must be a positive integer');
  }

  let tracked = new Map();
  // Last revision handed out per entity, including entities that were removed. Keeping the
  // tombstone is what makes `present → removed → present` produce a fresh key instead of
  // re-using the revision of the first observation. The map is bounded to twice `maxEntities`
  // by dropping tombstones for entities that are no longer tracked (see below).
  const revisions = new Map();
  let initialized = false;
  const totals = {
    added: 0,
    changed: 0,
    removed: 0,
    snapshot: 0,
    truncatedReads: 0,
    duplicateEntities: 0,
    suppressedRemovals: 0,
  };

  /**
   * Hand out the next transition number for one entity. It never repeats within this differ,
   * so two different transitions of the same entity can never collide on a stable key, even
   * when they end in the same digest.
   */
  function advanceRevision(entityId) {
    const value = (revisions.get(entityId) ?? 0) + 1;
    revisions.set(entityId, value);
    return value;
  }

  return Object.freeze({
    /**
     * Diff the current table against the previous read.
     * @param {Array<{entityId: string, digest: string, payload: object}>} items
     * @param {{suppressRemovalsFor?: ((entry: {entityId: string, item: object}) => boolean)|null}} [options]
     */
    diff(items, { suppressRemovalsFor = null } = {}) {
      if (!Array.isArray(items)) {
        throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'diff input must be an array');
      }
      if (suppressRemovalsFor !== null && typeof suppressRemovalsFor !== 'function') {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
          'suppressRemovalsFor must be null or a function',
        );
      }
      const truncated = items.length > maxEntities;
      const considered = truncated ? items.slice(0, maxEntities) : items;

      // Phase one: validate everything before touching `tracked`. The previous version
      // committed `tracked = next` first and validated the digest later, inside
      // buildSnapshotRecord; a rejected batch therefore advanced the differ, and the
      // retry after the error emitted nothing for the same table — silent event loss.
      const next = new Map();
      let duplicates = 0;
      for (const item of considered) {
        if (item === null || typeof item !== 'object') {
          throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'every diff item must be an object');
        }
        assertEntityId(item.entityId);
        assertDigest(item.digest);
        if (next.has(item.entityId)) {
          // Two rows claiming the same identity would make the emitted record depend on
          // row order. Keep the first occurrence deterministically and report the collision
          // instead of silently overwriting.
          duplicates += 1;
          continue;
        }
        next.set(item.entityId, item);
      }

      const entries = [];
      for (const [entityId, item] of next) {
        const previous = tracked.get(entityId);
        if (previous === undefined) {
          entries.push({
            kind: initialized ? 'added' : 'snapshot',
            entityId,
            digest: item.digest,
            revision: advanceRevision(entityId),
            item,
            previous: null,
          });
        } else if (previous.digest !== item.digest) {
          entries.push({
            kind: 'changed',
            entityId,
            digest: item.digest,
            revision: advanceRevision(entityId),
            item,
            // `tracked` stores the item itself, not a wrapper around it. The original code
            // read `previous.item` here and on the removal path, which was always
            // `undefined` and crashed the caller as soon as anything was removed.
            previous,
          });
        }
      }

      // A truncated read only saw the first `maxEntities` rows. Reporting the rest as
      // `removed` would claim that thousands of live objects disappeared, so removals are
      // suppressed for that read; the source surfaces `truncated` instead so the caller
      // can degrade the source and record a gap.
      let suppressedRemovals = 0;
      if (truncated) {
        for (const [entityId, previous] of tracked) {
          if (!next.has(entityId)) {
            suppressedRemovals += 1;
            next.set(entityId, previous);
          }
        }
      } else {
        for (const [entityId, previous] of tracked) {
          if (!next.has(entityId)) {
            // A subtree that could not be read this cycle says nothing about whether its
            // entries still exist, so the caller can suppress removals for it instead of
            // reporting a permission failure as a mass deletion.
            if (suppressRemovalsFor !== null
              && suppressRemovalsFor({ entityId, item: previous }) === true) {
              suppressedRemovals += 1;
              next.set(entityId, previous);
              continue;
            }
            entries.push({
              kind: 'removed',
              entityId,
              // The key must describe the state that was last observed, but its revision must
              // be *new*: reusing the digest alone made the removal key identical to the
              // `present` event that preceded it, and the dedupe window dropped it forever.
              digest: previous.digest,
              revision: advanceRevision(entityId),
              item: previous,
              previous,
            });
          }
        }
      }

      const snapshot = !initialized;
      tracked = next;
      // Bound the tombstone map: once it holds twice the tracked table, the oldest revisions of
      // entities that are no longer tracked are dropped. A pruned entity that reappears starts
      // again at revision 1, which is the same bounded restart trade-off described above.
      if (revisions.size > maxEntities * 2) {
        for (const entityId of revisions.keys()) {
          if (revisions.size <= maxEntities * 2) {
            break;
          }
          if (!tracked.has(entityId)) {
            revisions.delete(entityId);
          }
        }
      }
      initialized = true;
      if (truncated) {
        totals.truncatedReads += 1;
      }
      totals.duplicateEntities += duplicates;
      totals.suppressedRemovals += suppressedRemovals;
      for (const entry of entries) {
        totals[entry.kind] += 1;
      }

      return {
        entries,
        snapshot,
        truncated,
        tracked: tracked.size,
        duplicateEntities: duplicates,
        suppressedRemovals,
      };
    },

    reset() {
      tracked = new Map();
      revisions.clear();
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
