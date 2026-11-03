/**
 * Durable, atomic, recoverable cursor store for one collector state directory.
 *
 * Single-writer assumption: exactly one live instance may own a `directory` at a time.
 * Tests simulate a crash/restart by discarding the first instance before creating the
 * next one; two concurrent writers would race on the same temp file name.
 *
 * Durability: every commit writes `<fileName>.tmp`, fsyncs it, renames it over the
 * target and then best-effort fsyncs the directory. A crash therefore leaves either the
 * previous file or the new file, never a partially written one.
 *
 * Corruption: an unreadable or schema-invalid file is renamed to
 * `<fileName>.corrupt-<epochMs>` and the store continues with empty state. The original
 * bytes stay on disk for diagnosis instead of being deleted and recreated.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertNonEmptyString,
  assertTimestamp,
  isPlainObject,
  toIsoTimestamp,
} from './errors.js';
import { GENERATION_REASONS, assertGenerationReason } from './generation.js';
import { assertStableSourceId, isValidStableSourceId } from './ids.js';
import { LIMITS } from './limits.js';

const FORMAT_VERSION = 1;
const TOP_LEVEL_KEYS = Object.freeze(['formatVersion', 'updatedAt', 'sources']);
const SOURCE_KEYS = Object.freeze([
  'stableSourceId',
  'generation',
  'cursor',
  'sequence',
  'generationReason',
  'recentKeys',
  'updatedAt',
]);
const DIRECTORY_FSYNC_ERRORS = new Set(['EPERM', 'EISDIR', 'EINVAL', 'EACCES', 'EBADF', 'ENOTSUP', 'ENOSYS']);

function corrupt(reason, details = undefined) {
  return new CollectorError(ERROR_CODES.CURSOR_STORE_CORRUPT, reason, details);
}

function cloneCursor(cursor) {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  if (typeof cursor === 'string' || typeof cursor === 'number' || typeof cursor === 'boolean') {
    return cursor;
  }
  return structuredClone(cursor);
}

function appendRecentKeys(existing, additions, windowSize) {
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
  return keys.length > windowSize ? keys.slice(keys.length - windowSize) : keys;
}

function validateSourceEntry(stableSourceId, value) {
  if (!isValidStableSourceId(stableSourceId)) {
    throw corrupt(`Invalid stable source id in cursor store: ${JSON.stringify(stableSourceId)}`);
  }
  if (!isPlainObject(value)) {
    throw corrupt(`Cursor entry for ${stableSourceId} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!SOURCE_KEYS.includes(key)) {
      throw corrupt(`Unknown field "${key}" in cursor entry ${stableSourceId}`);
    }
  }
  if (value.stableSourceId !== stableSourceId) {
    throw corrupt(`Cursor entry key mismatch for ${stableSourceId}`);
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) {
    throw corrupt(`Cursor entry ${stableSourceId} has an invalid generation`);
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < -1) {
    throw corrupt(`Cursor entry ${stableSourceId} has an invalid sequence`);
  }
  if (value.cursor === undefined) {
    throw corrupt(`Cursor entry ${stableSourceId} has an invalid cursor`);
  }
  if (value.generationReason !== null && !GENERATION_REASONS.includes(value.generationReason)) {
    throw corrupt(`Cursor entry ${stableSourceId} has an unknown generationReason`);
  }
  if (!Array.isArray(value.recentKeys) || value.recentKeys.some((key) => typeof key !== 'string')) {
    throw corrupt(`Cursor entry ${stableSourceId} has invalid recentKeys`);
  }
  if (typeof value.updatedAt !== 'string' || !Number.isSafeInteger(Date.parse(value.updatedAt))) {
    throw corrupt(`Cursor entry ${stableSourceId} has an invalid updatedAt`);
  }
}

function parseStoreFile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corrupt('Cursor store file is not valid JSON', { message: error.message });
  }
  if (!isPlainObject(parsed)) {
    throw corrupt('Cursor store file must contain a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw corrupt(`Unknown top-level field in cursor store: ${key}`);
    }
  }
  if (parsed.formatVersion !== FORMAT_VERSION) {
    throw corrupt(`Unsupported cursor store formatVersion: ${String(parsed.formatVersion)}`);
  }
  if (!isPlainObject(parsed.sources)) {
    throw corrupt('Cursor store "sources" must be an object');
  }
  for (const [stableSourceId, value] of Object.entries(parsed.sources)) {
    validateSourceEntry(stableSourceId, value);
  }
  return parsed;
}

function freezeState(state) {
  return Object.freeze({
    stableSourceId: state.stableSourceId,
    generation: state.generation,
    cursor: cloneCursor(state.cursor),
    sequence: state.sequence,
    generationReason: state.generationReason,
    recentKeys: Object.freeze([...state.recentKeys]),
    updatedAt: state.updatedAt,
  });
}

export function createCursorStore({
  directory,
  fileName = 'collector-cursors.json',
  persistedKeyWindow = LIMITS.persistedKeyWindow,
  clock = Date.now,
} = {}) {
  assertNonEmptyString('cursor store directory', directory);
  assertNonEmptyString('cursor store fileName', fileName);
  assertInteger('persistedKeyWindow', persistedKeyWindow, { min: 1 });
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }

  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, fileName);
  const tempPath = `${filePath}.tmp`;
  let loaded = false;
  let sources = new Map();
  let quarantineInfo = Object.freeze({ quarantined: false, path: null });

  function syncDirectory() {
    let directoryFd = null;
    try {
      directoryFd = openSync(dirname(filePath), 'r');
      fsyncSync(directoryFd);
    } catch (error) {
      if (!DIRECTORY_FSYNC_ERRORS.has(error.code)) {
        throw error;
      }
    } finally {
      if (directoryFd !== null) {
        try {
          closeSync(directoryFd);
        } catch {
          // Closing a directory handle is best effort.
        }
      }
    }
  }

  function persist() {
    const nowMs = Math.trunc(assertTimestamp('cursor store clock', clock()));
    const orderedSources = {};
    for (const stableSourceId of [...sources.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
      const state = sources.get(stableSourceId);
      orderedSources[stableSourceId] = {
        stableSourceId: state.stableSourceId,
        generation: state.generation,
        cursor: state.cursor,
        sequence: state.sequence,
        generationReason: state.generationReason,
        recentKeys: [...state.recentKeys],
        updatedAt: state.updatedAt,
      };
    }
    const payload = {
      formatVersion: FORMAT_VERSION,
      updatedAt: toIsoTimestamp(nowMs),
      sources: orderedSources,
    };

    let fd = null;
    try {
      fd = openSync(tempPath, 'w');
      // Compact JSON: this file is machine written and rewritten on every commit, so
      // pretty printing would multiply the write amplification for no reader benefit.
      writeSync(fd, JSON.stringify(payload), null, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tempPath, filePath);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Ignore close failures; the original error is the useful one.
        }
      }
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // A leftover temp file must not mask the persistence error.
      }
      throw new CollectorError(
        ERROR_CODES.CURSOR_STORE_IO,
        `Failed to persist cursor store: ${error.message}`,
        { code: error.code ?? null },
      );
    }

    try {
      syncDirectory();
    } catch (error) {
      throw new CollectorError(
        ERROR_CODES.CURSOR_STORE_IO,
        `Failed to fsync cursor store directory: ${error.message}`,
        { code: error.code ?? null },
      );
    }
  }

  function quarantine(reason) {
    const epochMs = Math.trunc(assertTimestamp('cursor store clock', clock()));
    let sequence = 0;
    let target = `${filePath}.corrupt-${epochMs}-${sequence}`;
    // Two quarantines inside the same millisecond (or a previous crash leaving the same
    // name behind) must not overwrite the older evidence file.
    while (existsSync(target)) {
      sequence += 1;
      target = `${filePath}.corrupt-${epochMs}-${sequence}`;
    }
    try {
      renameSync(filePath, target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new CollectorError(
          ERROR_CODES.CURSOR_STORE_IO,
          `Failed to quarantine corrupt cursor store: ${error.message}`,
          { code: error.code ?? null, reason },
        );
      }
    }
    sources = new Map();
    quarantineInfo = Object.freeze({ quarantined: true, path: target });
  }

  function ensureLoaded() {
    if (loaded) {
      return;
    }

    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        sources = new Map();
        loaded = true;
        return;
      }
      throw new CollectorError(
        ERROR_CODES.CURSOR_STORE_IO,
        `Failed to read cursor store: ${error.message}`,
        { code: error.code ?? null },
      );
    }

    let parsed;
    try {
      parsed = parseStoreFile(raw);
    } catch (error) {
      quarantine(error.message);
      loaded = true;
      return;
    }

    sources = new Map();
    for (const [stableSourceId, value] of Object.entries(parsed.sources)) {
      sources.set(stableSourceId, {
        stableSourceId,
        generation: value.generation,
        cursor: cloneCursor(value.cursor),
        sequence: value.sequence,
        generationReason: value.generationReason,
        recentKeys: [...value.recentKeys],
        updatedAt: value.updatedAt,
      });
    }
    loaded = true;
  }

  function upsert(stableSourceId, next) {
    const nowMs = Math.trunc(assertTimestamp('cursor store clock', clock()));
    sources.set(stableSourceId, { ...next, updatedAt: toIsoTimestamp(nowMs) });
    persist();
    return freezeState(sources.get(stableSourceId));
  }

  return Object.freeze({
    load(stableSourceId) {
      assertStableSourceId(stableSourceId);
      ensureLoaded();
      const state = sources.get(stableSourceId);
      return state === undefined ? null : freezeState(state);
    },

    list() {
      ensureLoaded();
      return [...sources.keys()]
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((stableSourceId) => freezeState(sources.get(stableSourceId)));
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

      ensureLoaded();
      const existing = sources.get(stableSourceId) ?? null;
      if (existing !== null) {
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

      return upsert(stableSourceId, {
        stableSourceId,
        generation,
        cursor: cloneCursor(cursor),
        sequence,
        generationReason: generationReason ?? existing?.generationReason ?? null,
        recentKeys: appendRecentKeys(existing?.recentKeys ?? [], recentKeys, persistedKeyWindow),
      });
    },

    advanceGeneration({ stableSourceId, reason, cursor = null } = {}) {
      assertStableSourceId(stableSourceId);
      assertGenerationReason(reason);
      ensureLoaded();

      const existing = sources.get(stableSourceId) ?? null;
      return upsert(stableSourceId, {
        stableSourceId,
        generation: existing === null ? 0 : existing.generation + 1,
        cursor: cloneCursor(cursor),
        sequence: -1,
        generationReason: reason,
        recentKeys: [],
      });
    },

    quarantine() {
      ensureLoaded();
      return quarantineInfo;
    },

    stats() {
      ensureLoaded();
      let bytes = 0;
      try {
        bytes = statSync(filePath).size;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new CollectorError(
            ERROR_CODES.CURSOR_STORE_IO,
            `Failed to stat cursor store: ${error.message}`,
            { code: error.code ?? null },
          );
        }
      }
      return Object.freeze({ sources: sources.size, bytes });
    },
  });
}
