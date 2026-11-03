/**
 * state-store.js — the daemon's small durable checkpoint.
 *
 * What lives here and why:
 *
 * - **`epoch`** — the recovery epoch the analysis requests are bound to (design
 *   §7.3). It must survive a restart, otherwise every restart would silently
 *   churn a new epoch and invalidate outstanding work.
 * - **per-source cursors** — where each collector stopped reading. The collector
 *   adapter owns the meaning of a cursor; the daemon only persists it.
 * - **counters** — cumulative ingest/alert/analysis tallies, so `status` keeps
 *   reporting the same totals across a restart instead of resetting to zero.
 *
 * What does NOT live here: telemetry, alerts, audit. Those belong to the single
 * writer (event-store). Duplicating them would create a second, unaudited truth.
 *
 * Write discipline: temp file in the same directory → `fsync` → `rename`. A crash
 * therefore leaves either the previous complete file or the new complete file,
 * never a half-written one. A corrupt file is **quarantined by rename**, not
 * deleted: an operator needs it to understand what happened.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { DaemonError, DAEMON_CODES } from './errors.js';
import { toIso } from './clock.js';

/** On-disk checkpoint schema version. Bumped only with a migration. */
export const STATE_SCHEMA_VERSION = 1;

const MAX_STATE_BYTES = 512 * 1024;
const MAX_SOURCES_RECORDED = 512;

/** An epoch must be a UUIDv4: it is copied verbatim into `AnalysisRequest.epoch`. */
const EPOCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Fresh empty state with the given epoch. */
export function createEmptyState(epoch) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    epoch,
    sources: {},
    counters: {
      polls: 0,
      events_received: 0,
      events_accepted: 0,
      events_duplicate: 0,
      events_invalid: 0,
      alerts_written: 0,
      findings_written: 0,
      analysis_requests: 0,
      source_failures: 0,
    },
    updated_at: null,
  };
}

function assertFiniteCount(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Normalize a decoded checkpoint into the shape the daemon expects.
 *
 * A structurally wrong file is treated as corrupt rather than "best effort"
 * repaired: silently keeping half of a checkpoint would resume collection from an
 * unknown position.
 *
 * @param {unknown} raw Decoded JSON.
 * @returns {object} Normalized state.
 * @throws {Error} When the shape cannot be trusted.
 */
export function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('state must be an object');
  }
  if (raw.schema_version !== STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported state schema ${String(raw.schema_version)}`);
  }
  if (typeof raw.epoch !== 'string' || !EPOCH_UUID.test(raw.epoch)) {
    throw new Error('state.epoch must be a UUIDv4');
  }
  if (raw.sources !== null && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) {
    // ok
  } else if (raw.sources !== undefined) {
    throw new Error('state.sources must be an object');
  }
  const sources = {};
  for (const [id, record] of Object.entries(raw.sources ?? {}).slice(0, MAX_SOURCES_RECORDED)) {
    if (typeof id !== 'string' || record === null || typeof record !== 'object') {
      throw new Error('state.sources entries must be objects keyed by source id');
    }
    sources[id] = {
      cursor: record.cursor === undefined ? null : record.cursor,
      generation: assertFiniteCount(record.generation, 0),
      sequence: assertFiniteCount(record.sequence, 0),
      last_success_at: typeof record.last_success_at === 'string' ? record.last_success_at : null,
      events: assertFiniteCount(record.events, 0),
    };
  }
  const counters = {};
  for (const [key, value] of Object.entries(raw.counters ?? {})) {
    if (typeof key !== 'string' || key.length > 64) {
      continue;
    }
    counters[key] = assertFiniteCount(value, 0);
  }
  return {
    schema_version: STATE_SCHEMA_VERSION,
    epoch: raw.epoch,
    sources,
    counters,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

/**
 * Write JSON atomically (temp file, fsync, rename).
 *
 * @param {string} filePath Destination path.
 * @param {unknown} value JSON-serializable value.
 * @param {{fsModule?: typeof fs}} [deps] Injectable fs for tests.
 * @returns {void}
 */
export function atomicWriteJson(filePath, value, deps = {}) {
  const fsModule = deps.fsModule ?? fs;
  const directory = path.dirname(filePath);
  fsModule.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const text = `${JSON.stringify(value, null, 1)}\n`;
  let handle = null;
  try {
    handle = fsModule.openSync(temporary, 'w', 0o600);
    fsModule.writeFileSync(handle, text);
    // fsync before rename: without it a power loss can leave a renamed but empty file.
    fsModule.fsyncSync(handle);
    fsModule.closeSync(handle);
    handle = null;
    fsModule.renameSync(temporary, filePath);
  } catch (error) {
    if (handle !== null) {
      try {
        fsModule.closeSync(handle);
      } catch {
        // Already unusable.
      }
    }
    try {
      fsModule.rmSync(temporary, { force: true });
    } catch {
      // Leftover temp files are harmless; the next write uses a unique name.
    }
    throw new DaemonError(DAEMON_CODES.STATE_WRITE_FAILED, 'daemon state could not be written', {
      reason: error?.code ?? 'UNKNOWN',
    });
  }
}

/**
 * Create a checkpoint file handle.
 *
 * @param {{
 *   path: string,
 *   clock: {nowMs: () => number, nowIso: () => string},
 *   logger?: object,
 *   fsModule?: typeof fs
 * }} options Options.
 * @returns {{
 *   path: string,
 *   load: () => {state: object|null, corrupt: boolean, restored_from: string|null},
 *   save: (state: object) => object,
 *   counters: () => {writes: number, quarantines: number},
 *   close: () => void
 * }} State file handle.
 */
export function createStateFile(options) {
  const filePath = options.path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'state file requires a path');
  }
  const fsModule = options.fsModule ?? fs;
  const clock = options.clock;
  const logger = options.logger ?? null;
  const stats = { writes: 0, quarantines: 0 };
  let closed = false;

  function quarantine(reason) {
    const stamp = toIso(clock.nowMs()).replace(/[:.]/gu, '-');
    const target = `${filePath}.corrupt-${stamp}`;
    try {
      fsModule.renameSync(filePath, target);
      stats.quarantines += 1;
      logger?.warn?.('daemon state quarantined', { reason, quarantined_as: path.basename(target) });
      return target;
    } catch (error) {
      logger?.error?.('daemon state could not be quarantined', { reason, code: error?.code ?? 'UNKNOWN' });
      return null;
    }
  }

  return Object.freeze({
    path: filePath,
    /**
     * Load the checkpoint.
     *
     * @returns {{state: object|null, corrupt: boolean, restored_from: string|null}}
     *   `state` is `null` only when no checkpoint exists yet.
     */
    load() {
      let text;
      try {
        text = fsModule.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { state: null, corrupt: false, restored_from: null };
        }
        const restored = quarantine('unreadable');
        return { state: null, corrupt: true, restored_from: restored };
      }
      if (text.length > MAX_STATE_BYTES) {
        const restored = quarantine('oversized');
        return { state: null, corrupt: true, restored_from: restored };
      }
      let parsed;
      try {
        parsed = normalizeState(JSON.parse(text));
      } catch (error) {
        const restored = quarantine(error?.message === 'oversized' ? 'oversized' : 'corrupt');
        return { state: null, corrupt: true, restored_from: restored };
      }
      return { state: parsed, corrupt: false, restored_from: null };
    },
    /**
     * Persist a checkpoint.
     *
     * @param {object} state State produced by the daemon.
     * @returns {object} The state as written (with `updated_at` set).
     */
    save(state) {
      if (closed) {
        throw new DaemonError(DAEMON_CODES.STATE_WRITE_FAILED, 'state file is closed');
      }
      const record = {
        ...state,
        schema_version: STATE_SCHEMA_VERSION,
        updated_at: clock.nowIso(),
      };
      atomicWriteJson(filePath, record, { fsModule });
      stats.writes += 1;
      return record;
    },
    counters: () => ({ ...stats }),
    close() {
      closed = true;
    },
  });
}
