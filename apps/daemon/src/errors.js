/**
 * errors.js — the closed error vocabulary of the daemon control plane.
 *
 * Two rules that the rest of the package depends on:
 *
 * 1. **Every code is stable and enumerable.** The control API renders `code` to
 *    clients and the status file quotes it, so a code is part of the interface.
 * 2. **No error carries a secret.** Details objects are logged and may be echoed,
 *    so callers must only ever put identifiers, counters and codes there.
 *
 * A `DaemonError` is a *handled* failure: something the daemon knows how to
 * degrade on. An unknown throw is a programming fault and is always reported as
 * `INTERNAL` at the API boundary, with the original message kept only in logs.
 */

/** Stable error code registry. */
export const DAEMON_CODES = Object.freeze({
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_NOT_LOOPBACK: 'CONFIG_NOT_LOOPBACK',
  CONFIG_PATH_ESCAPE: 'CONFIG_PATH_ESCAPE',

  LIFECYCLE_INVALID_TRANSITION: 'LIFECYCLE_INVALID_TRANSITION',
  LIFECYCLE_ALREADY_STARTED: 'LIFECYCLE_ALREADY_STARTED',
  LIFECYCLE_NOT_RUNNING: 'LIFECYCLE_NOT_RUNNING',
  LIFECYCLE_START_FAILED: 'LIFECYCLE_START_FAILED',
  SHUTDOWN_TIMEOUT: 'SHUTDOWN_TIMEOUT',

  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  STORE_REQUIRED: 'STORE_REQUIRED',
  STORE_WRITE_FAILED: 'STORE_WRITE_FAILED',

  SOURCE_INVALID: 'SOURCE_INVALID',
  SOURCE_FAILED: 'SOURCE_FAILED',
  SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
  SOURCE_UNKNOWN: 'SOURCE_UNKNOWN',
  SOURCE_BUSY: 'SOURCE_BUSY',
  BATCH_INVALID: 'BATCH_INVALID',

  DETECTION_UNAVAILABLE: 'DETECTION_UNAVAILABLE',
  DETECTION_FROZEN: 'DETECTION_FROZEN',

  STATE_CORRUPT: 'STATE_CORRUPT',
  STATE_WRITE_FAILED: 'STATE_WRITE_FAILED',

  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  CSRF_REQUIRED: 'CSRF_REQUIRED',
  HOST_REJECTED: 'HOST_REJECTED',
  ORIGIN_REJECTED: 'ORIGIN_REJECTED',
  PEER_REJECTED: 'PEER_REJECTED',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  CONTENT_TYPE_REJECTED: 'CONTENT_TYPE_REJECTED',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
});

const CODE_SET = new Set(Object.values(DAEMON_CODES));

/** Error carrying a stable daemon code plus identifier-only details. */
export class DaemonError extends Error {
  /**
   * @param {string} code One of {@link DAEMON_CODES}.
   * @param {string} message Human readable, never containing a secret.
   * @param {object} [details] Identifier and counter fields only.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DaemonError';
    /** @type {string} */
    this.code = CODE_SET.has(code) ? code : DAEMON_CODES.INTERNAL;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
    Error.captureStackTrace?.(this, DaemonError);
  }
}

/**
 * @param {unknown} error Candidate value.
 * @returns {boolean} `true` for a daemon error.
 */
export function isDaemonError(error) {
  return error instanceof DaemonError
    || (error !== null && typeof error === 'object' && typeof error.code === 'string' && CODE_SET.has(error.code));
}

/**
 * Normalize any thrown value into a daemon error.
 *
 * Unknown throws keep their message for the log but are given the `INTERNAL` code,
 * which is the only code the API renders without a curated message.
 *
 * @param {unknown} error Thrown value.
 * @returns {DaemonError} Daemon error.
 */
export function toDaemonError(error) {
  if (error instanceof DaemonError) {
    return error;
  }
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  const wrapped = new DaemonError(DAEMON_CODES.INTERNAL, message);
  if (error !== null && typeof error === 'object') {
    wrapped.cause = error;
  }
  return wrapped;
}
