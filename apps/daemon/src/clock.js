/**
 * clock.js — wall clock, monotonic clock and RFC3339 rendering for the daemon.
 *
 * The daemon needs three distinct notions of time and must not conflate them:
 *
 * - **wall** (`nowMs`) — used for `received_at`, alert windows and state files.
 *   It can be stepped backwards by NTP or by an operator.
 * - **monotonic** (`monoMs`) — used for timeouts and staleness. It never goes
 *   backwards, so a wall clock step cannot make a stuck source look fresh.
 * - **duration** — always measured as `monoMs() - start`.
 *
 * Timestamps are rendered as `YYYY-MM-DDTHH:MM:SS.mmmZ`, matching the closed
 * contracts' `rfc3339Utc` field type. Rendering uses `Date#toISOString`, which is
 * defined in UTC and therefore independent of the host time zone.
 */

import { DaemonError, DAEMON_CODES } from './errors.js';

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/**
 * Render epoch milliseconds as an RFC3339 UTC timestamp.
 *
 * @param {number} epochMs Non-negative safe integer.
 * @returns {string} `YYYY-MM-DDTHH:MM:SS.mmmZ`.
 * @throws {DaemonError} When the value cannot be rendered.
 */
export function toIso(epochMs) {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'timestamp must be a non-negative safe integer', {
      value: typeof epochMs,
    });
  }
  const rendered = new Date(epochMs).toISOString();
  if (!RFC3339_UTC.test(rendered)) {
    throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'timestamp is outside the RFC3339 four-digit year range');
  }
  return rendered;
}

/**
 * Parse an RFC3339 UTC timestamp.
 *
 * Only the exact millisecond form the contracts accept is parsed: accepting a
 * looser grammar here would let one component read a time the others reject.
 *
 * @param {string} iso Timestamp text.
 * @returns {number} Epoch milliseconds.
 * @throws {DaemonError} When the text is not a renderable RFC3339 UTC timestamp.
 */
export function fromIso(iso) {
  if (typeof iso !== 'string' || !RFC3339_UTC.test(iso)) {
    throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'timestamp must be RFC3339 UTC with milliseconds');
  }
  const ms = Date.parse(iso);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'timestamp is not representable');
  }
  return ms;
}

/**
 * Real clock backed by the host.
 *
 * @returns {{nowMs: () => number, nowIso: () => string, monoMs: () => number}} Clock.
 */
export function createSystemClock() {
  const origin = performance.now();
  return Object.freeze({
    nowMs: () => Date.now(),
    nowIso: () => new Date(Date.now()).toISOString(),
    // `performance.now()` is monotonic and unaffected by wall clock steps.
    monoMs: () => Math.floor(performance.now() - origin),
  });
}

/**
 * Deterministic clock for tests and replay.
 *
 * Wall and monotonic time advance independently so a test can reproduce an NTP
 * step (`advanceWall`) or a suspend/resume (`advanceMono`) without sleeping.
 *
 * @param {number} [startMs] Initial wall time.
 * @returns {object} Clock with `advance`, `advanceWall` and `advanceMono`.
 */
export function createManualClock(startMs = 1_700_000_000_000) {
  if (!Number.isSafeInteger(startMs) || startMs < 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'manual clock start must be a non-negative safe integer');
  }
  let wall = startMs;
  let mono = 0;
  const clock = {
    nowMs: () => wall,
    nowIso: () => new Date(wall).toISOString(),
    monoMs: () => mono,
    /** Advance wall and monotonic time together (normal elapsed time). */
    advance(deltaMs) {
      if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
        throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'advance requires a non-negative integer');
      }
      wall += deltaMs;
      mono += deltaMs;
      return wall;
    },
    /** Advance wall time only (NTP step, manual `date` change). */
    advanceWall(deltaMs) {
      wall += deltaMs;
      return wall;
    },
    /** Advance monotonic time only (suspend/resume). */
    advanceMono(deltaMs) {
      mono += deltaMs;
      return mono;
    },
    /** Set wall time absolutely, leaving the monotonic origin alone. */
    setWall(nextMs) {
      if (!Number.isSafeInteger(nextMs) || nextMs < 0) {
        throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'setWall requires a non-negative safe integer');
      }
      wall = nextMs;
      return wall;
    },
  };
  return Object.freeze(clock);
}

/**
 * Assert a value is a usable clock.
 *
 * @param {unknown} clock Candidate.
 * @returns {{nowMs: () => number, nowIso: () => string, monoMs: () => number}} The clock.
 * @throws {DaemonError} When a required method is missing.
 */
export function assertClock(clock) {
  if (clock === null || typeof clock !== 'object') {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'clock must be an object');
  }
  for (const method of ['nowMs', 'nowIso', 'monoMs']) {
    if (typeof clock[method] !== 'function') {
      throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, `clock.${method} must be a function`);
    }
  }
  return clock;
}
