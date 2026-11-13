/**
 * api/console-errors.js — the error vocabulary of the console v2 surface.
 *
 * `src/errors.js` stays frozen: its codes describe *daemon conditions* (store down,
 * lifecycle wrong) and its constructor snaps an unknown code to `INTERNAL`. The ten
 * console routes need a different, larger vocabulary — a provider URL that fails
 * ADR-0010 is a caller fault at 400, a broker that cannot start is a 503, a busy
 * chat is a 429 — and folding all of it into the daemon's closed set would make
 * "did the daemon break or did the caller?" unreadable, exactly the reason
 * `api/errors.js` was split out before it.
 *
 * So this is the third small registry, with the same discipline:
 *
 * 1. every code is stable, enumerable, and mapped to exactly one HTTP status
 *    (contract §2.1's status table, verbatim);
 * 2. `details` carries identifiers, enumerations and counters only — never a
 *    path, never key material, never an upstream body;
 * 3. `ConsoleError` never extends `DaemonError`, so an API code can never be
 *    silently rewritten into `INTERNAL` by that constructor's guard.
 *
 * The 502/504 family is produced *after* a broker child reported an upstream
 * failure; it is still an HTTP error envelope here because the SSE route may not
 * have flushed its headers yet.
 */

/** Stable console-only code registry (contract §2.1). */
export const CONSOLE_CODES = Object.freeze({
  PROVIDER_UNKNOWN: 'PROVIDER_UNKNOWN',
  PROVIDER_INVALID: 'PROVIDER_INVALID',
  PROVIDER_LIMIT: 'PROVIDER_LIMIT',
  PROVIDER_DUPLICATE: 'PROVIDER_DUPLICATE',
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  EGRESS_DISABLED: 'EGRESS_DISABLED',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',
  CREDENTIAL_INVALID: 'CREDENTIAL_INVALID',
  CREDENTIAL_STORE_UNAVAILABLE: 'CREDENTIAL_STORE_UNAVAILABLE',
  MODEL_UNKNOWN: 'MODEL_UNKNOWN',
  SETTINGS_INVALID: 'SETTINGS_INVALID',
  SETTINGS_LOCKED: 'SETTINGS_LOCKED',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  CHAT_INVALID: 'CHAT_INVALID',
  CHAT_BUSY: 'CHAT_BUSY',
  ALERT_NOT_FOUND: 'ALERT_NOT_FOUND',
  CALL_UNKNOWN: 'CALL_UNKNOWN',
  EXECUTION_DISABLED: 'EXECUTION_DISABLED',
  UPSTREAM_FAILED: 'UPSTREAM_FAILED',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  UPSTREAM_REDIRECT: 'UPSTREAM_REDIRECT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  // OPS-DIAG (contract §2.1 diagnostics): a malformed body on the diagnostics
  // actions is a caller fault, not a daemon fault.
  DIAGNOSTICS_INVALID: 'DIAGNOSTICS_INVALID',
});

/** HTTP status for every console code (contract §2.1). */
export const CONSOLE_STATUS_BY_CODE = Object.freeze({
  [CONSOLE_CODES.PROVIDER_UNKNOWN]: 404,
  [CONSOLE_CODES.PROVIDER_INVALID]: 400,
  [CONSOLE_CODES.PROVIDER_LIMIT]: 409,
  [CONSOLE_CODES.PROVIDER_DUPLICATE]: 409,
  [CONSOLE_CODES.PROVIDER_DISABLED]: 409,
  [CONSOLE_CODES.EGRESS_DISABLED]: 409,
  [CONSOLE_CODES.CREDENTIAL_MISSING]: 409,
  [CONSOLE_CODES.CREDENTIAL_INVALID]: 400,
  [CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE]: 503,
  [CONSOLE_CODES.MODEL_UNKNOWN]: 404,
  [CONSOLE_CODES.SETTINGS_INVALID]: 400,
  [CONSOLE_CODES.SETTINGS_LOCKED]: 409,
  [CONSOLE_CODES.ENGINE_UNAVAILABLE]: 503,
  [CONSOLE_CODES.CHAT_INVALID]: 400,
  [CONSOLE_CODES.CHAT_BUSY]: 429,
  [CONSOLE_CODES.ALERT_NOT_FOUND]: 404,
  [CONSOLE_CODES.CALL_UNKNOWN]: 409,
  [CONSOLE_CODES.EXECUTION_DISABLED]: 409,
  [CONSOLE_CODES.UPSTREAM_FAILED]: 502,
  [CONSOLE_CODES.UPSTREAM_TIMEOUT]: 504,
  [CONSOLE_CODES.UPSTREAM_REDIRECT]: 502,
  [CONSOLE_CODES.NOT_IMPLEMENTED]: 501,
  [CONSOLE_CODES.DIAGNOSTICS_INVALID]: 400,
});

/**
 * Guidance value attached to upstream failures (contract §2.4/§3.2).
 *
 * The UI renders one sentence per value; an unknown action is a programming
 * fault, so the union is closed and checked.
 */
export const UPSTREAM_ACTIONS = Object.freeze([
  'CHECK_KEY',
  'CHECK_BASE_URL_OR_NETWORK',
  'CHECK_REDIRECT',
  'CHECK_PROVIDER_QUOTA',
  'RETRY_LATER',
  'OPEN_SETTINGS_MODELS',
  'RETRY',
  'NONE',
]);

const UPSTREAM_ACTION_SET = new Set(UPSTREAM_ACTIONS);
const CONSOLE_CODE_SET = new Set(Object.values(CONSOLE_CODES));

/**
 * Caller-facing console error.
 *
 * Unknown codes normalize to `PROVIDER_INVALID` (400) rather than throwing: a bad
 * code inside this class is a programming fault, and the only safe rendering of
 * "the request was not understood" is a client error, never a 500 that suggests
 * the daemon broke.
 */
export class ConsoleError extends Error {
  /**
   * @param {string} code One of {@link CONSOLE_CODES}.
   * @param {string} message Stable English sentence, never containing a secret.
   * @param {object} [details] Identifiers, enumerations and counters only.
   * @param {{retryAfterSeconds?: number, action?: string}} [options] Transport hints.
   */
  constructor(code, message, details = undefined, options = undefined) {
    super(message);
    this.name = 'ConsoleError';
    /** @type {string} */
    this.code = CONSOLE_CODE_SET.has(code) ? code : CONSOLE_CODES.PROVIDER_INVALID;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
    if (options?.action !== undefined && UPSTREAM_ACTION_SET.has(options.action)) {
      this.action = options.action;
    }
    Error.captureStackTrace?.(this, ConsoleError);
  }
}

/**
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` for a console error (by class or by code shape).
 */
export function isConsoleError(value) {
  return value instanceof ConsoleError
    || (value !== null && typeof value === 'object' && typeof value.code === 'string' && CONSOLE_CODE_SET.has(value.code));
}

/**
 * Map a broker/upstream condition onto a console code.
 *
 * The broker speaks its own vocabulary (and may add adapter-specific errors), so
 * the translation is a closed table with a `UPSTREAM_FAILED` default: an
 * unrecognized upstream code must never be reported as a success, and must never
 * leak the upstream message to the client.
 *
 * @param {string|undefined} code Upstream code.
 * @returns {string} Console code.
 */
export function upstreamCodeToConsole(code) {
  switch (code) {
    case 'CREDENTIAL_MISSING':
      return CONSOLE_CODES.CREDENTIAL_MISSING;
    case 'CREDENTIAL_INVALID':
      return CONSOLE_CODES.CREDENTIAL_INVALID;
    case 'CREDENTIAL_STORE_UNAVAILABLE':
      return CONSOLE_CODES.CREDENTIAL_STORE_UNAVAILABLE;
    case 'PROVIDER_UNKNOWN':
      return CONSOLE_CODES.PROVIDER_UNKNOWN;
    case 'PROVIDER_INVALID':
      return CONSOLE_CODES.PROVIDER_INVALID;
    case 'PROVIDER_DISABLED':
      return CONSOLE_CODES.PROVIDER_DISABLED;
    case 'EGRESS_DISABLED':
      return CONSOLE_CODES.EGRESS_DISABLED;
    case 'MODEL_UNKNOWN':
      return CONSOLE_CODES.MODEL_UNKNOWN;
    case 'CHAT_INVALID':
      return CONSOLE_CODES.CHAT_INVALID;
    case 'CHAT_BUSY':
      return CONSOLE_CODES.CHAT_BUSY;
    case 'PROVIDER_DUPLICATE':
      return CONSOLE_CODES.PROVIDER_DUPLICATE;
    case 'PROVIDER_LIMIT':
      return CONSOLE_CODES.PROVIDER_LIMIT;
    case 'UPSTREAM_TIMEOUT':
      return CONSOLE_CODES.UPSTREAM_TIMEOUT;
    case 'UPSTREAM_REDIRECT':
      return CONSOLE_CODES.UPSTREAM_REDIRECT;
    case 'UPSTREAM_FAILED':
      return CONSOLE_CODES.UPSTREAM_FAILED;
    case 'NOT_IMPLEMENTED':
      return CONSOLE_CODES.NOT_IMPLEMENTED;
    case 'ENGINE_UNAVAILABLE':
      return CONSOLE_CODES.ENGINE_UNAVAILABLE;
    default:
      return CONSOLE_CODES.UPSTREAM_FAILED;
  }
}
