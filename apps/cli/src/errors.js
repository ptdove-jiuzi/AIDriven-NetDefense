/**
 * errors.js — the closed error and exit-code vocabulary of the read-only CLI.
 *
 * Three rules the rest of this package depends on:
 *
 * 1. **A code is an interface.** Scripts branch on the exit code and operators grep
 *    the code, so both tables are closed and enumerated. Nothing is derived from an
 *    error message, and an unregistered code can never leak out: it is replaced by
 *    `INTERNAL`.
 * 2. **No error carries a secret.** `details` is rendered verbatim into `--json`
 *    output, so it is filtered through an allowlist of identifier-shaped keys. Even
 *    if a caller passes the bearer token by mistake, it cannot be rendered — not
 *    even a prefix, a length or a digest of it.
 * 3. **One code per operator problem.** A 401 caused by a missing token and a 401
 *    caused by a wrong token are the same thing to the person at the keyboard, so
 *    they share `AUTH`; the daemon's own code travels separately as `daemon_code`
 *    (also allowlisted and shape-checked) so diagnostics are not lost.
 *
 * The exit codes are the API for scripts. They are deliberately distinct per cause:
 * a caller cannot tell "daemon is down" from "the token is wrong" by parsing prose,
 * and this CLI will not ask it to.
 */

/** Exit codes. Stable, documented in `--help`, asserted by the tests. */
export const CLI_EXIT = Object.freeze({
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  UNREACHABLE: 4,
  AUTH: 5,
  FORBIDDEN: 6,
  TIMEOUT: 7,
  BAD_RESPONSE: 8,
  TOO_LARGE: 9,
  UNSUPPORTED: 10,
  RATE_LIMITED: 11,
  DAEMON_ERROR: 12,
  UNHEALTHY: 13,
});

/** Stable error codes carried in `error.code` of the JSON envelope. */
export const CLI_CODES = Object.freeze({
  OK: 'OK',
  USAGE: 'USAGE',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
  ENDPOINT_REJECTED: 'ENDPOINT_REJECTED',
  TOKEN_UNPROTECTED: 'TOKEN_UNPROTECTED',
  UNREACHABLE: 'UNREACHABLE',
  AUTH: 'AUTH',
  FORBIDDEN: 'FORBIDDEN',
  TIMEOUT: 'TIMEOUT',
  BAD_RESPONSE: 'BAD_RESPONSE',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  ENDPOINT_UNAVAILABLE: 'ENDPOINT_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  DAEMON_ERROR: 'DAEMON_ERROR',
  UNHEALTHY: 'UNHEALTHY',
  INTERNAL: 'INTERNAL',
});

const CODE_SET = new Set(Object.values(CLI_CODES));

/** Code → exit status. Every code appears exactly once; there is no default path. */
const EXIT_BY_CODE = Object.freeze({
  [CLI_CODES.OK]: CLI_EXIT.OK,
  [CLI_CODES.USAGE]: CLI_EXIT.USAGE,
  [CLI_CODES.CONFIG_NOT_FOUND]: CLI_EXIT.CONFIG,
  [CLI_CODES.CONFIG_INVALID]: CLI_EXIT.CONFIG,
  [CLI_CODES.ENDPOINT_REJECTED]: CLI_EXIT.CONFIG,
  [CLI_CODES.TOKEN_UNPROTECTED]: CLI_EXIT.CONFIG,
  [CLI_CODES.UNREACHABLE]: CLI_EXIT.UNREACHABLE,
  [CLI_CODES.AUTH]: CLI_EXIT.AUTH,
  [CLI_CODES.FORBIDDEN]: CLI_EXIT.FORBIDDEN,
  [CLI_CODES.TIMEOUT]: CLI_EXIT.TIMEOUT,
  [CLI_CODES.BAD_RESPONSE]: CLI_EXIT.BAD_RESPONSE,
  [CLI_CODES.RESPONSE_TOO_LARGE]: CLI_EXIT.TOO_LARGE,
  [CLI_CODES.ENDPOINT_UNAVAILABLE]: CLI_EXIT.UNSUPPORTED,
  [CLI_CODES.RATE_LIMITED]: CLI_EXIT.RATE_LIMITED,
  [CLI_CODES.DAEMON_ERROR]: CLI_EXIT.DAEMON_ERROR,
  [CLI_CODES.UNHEALTHY]: CLI_EXIT.UNHEALTHY,
  [CLI_CODES.INTERNAL]: CLI_EXIT.INTERNAL,
});

/**
 * Keys that may be rendered in `error.details`.
 *
 * Everything here is a status, a counter, a size or a name the CLI itself produced.
 * There is deliberately no `token`, `authorization`, `header` or `body` entry, and
 * adding one would defeat the whole point of the allowlist.
 */
const ALLOWED_DETAIL_KEYS = Object.freeze([
  'status',
  'daemon_code',
  'limit_bytes',
  'received_bytes',
  'timeout_ms',
  'command',
  'field',
  'reason',
  // The name of a rejected query parameter. Contract §8 puts it in `details.parameter`
  // and it is the one diagnostic that turns "the daemon refused the query" into a fix, so
  // it is carried through — but only when it looks like a parameter name, never as free
  // text (see `isParameterName`).
  'parameter',
]);

const DAEMON_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/u;
const REASON_PATTERN = /^[A-Z0-9_]{1,40}$/u;
const PARAMETER_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

/**
 * The literal contract §8 substitutes for a query-parameter name too long to echo.
 *
 * It is a fixed string the daemon sends, not caller text, so it is admitted alongside real
 * parameter names rather than filtered out with them.
 */
export const PARAMETER_SENTINEL = '<unknown>';

/**
 * Whether a value may be rendered as a rejected query-parameter name.
 *
 * Shared by the HTTP layer (which recovers the value from the daemon envelope) and by the
 * details allowlist below, so the two cannot disagree about what a parameter name is. A
 * value that fails this test is dropped rather than escaped: a name that is not shaped
 * like a name has no diagnostic value, and dropping it keeps arbitrary daemon text out of
 * both prose and `--json`.
 *
 * @param {unknown} value Candidate.
 * @returns {boolean} `true` for a parameter-shaped value or the contract's sentinel.
 */
export function isParameterName(value) {
  return typeof value === 'string' && (value === PARAMETER_SENTINEL || PARAMETER_PATTERN.test(value));
}

/**
 * Filter details down to allowlisted keys with primitive values of a sane shape.
 *
 * @param {Record<string, unknown>} details Candidate details.
 * @returns {Record<string, string|number|boolean>} Renderable details.
 */
function filterDetails(details) {
  const output = {};
  for (const key of ALLOWED_DETAIL_KEYS) {
    const value = details[key];
    if (value === undefined) {
      continue;
    }
    if (key === 'daemon_code') {
      if (typeof value === 'string' && DAEMON_CODE_PATTERN.test(value)) {
        output.daemon_code = value;
      }
      continue;
    }
    if (key === 'reason') {
      if (typeof value === 'string' && REASON_PATTERN.test(value)) {
        output.reason = value;
      }
      continue;
    }
    if (key === 'parameter') {
      // A query-parameter name, not a message: the alphabet is the one a legal parameter
      // uses, so a daemon that echoed something longer or stranger loses the field instead
      // of putting it on the terminal. Contract §8 already replaces an over-long name with
      // `"<unknown>"`; that sentinel is admitted, and the check itself is shared with the
      // HTTP layer so the two cannot drift.
      if (isParameterName(value)) {
        output.parameter = value;
      }
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    if (typeof value === 'string' && value.length <= 128) {
      output[key] = value;
    }
  }
  return output;
}

/** A handled CLI failure: carries a stable code, a curated message and safe details. */
export class CliError extends Error {
  /**
   * @param {string} code One of {@link CLI_CODES}; unknown codes become `INTERNAL`.
   * @param {string} message Human readable, already free of secrets.
   * @param {Record<string, unknown>} [details] Allowlisted identifiers only.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CliError';
    /** @type {string} */
    this.code = CODE_SET.has(code) ? code : CLI_CODES.INTERNAL;
    /** @type {Record<string, string|number|boolean>} */
    this.details = details === undefined ? Object.freeze({}) : Object.freeze(filterDetails(details));
    Error.captureStackTrace?.(this, CliError);
  }

  /** @returns {number} Exit status for this code. */
  exitCode() {
    return exitForCode(this.code);
  }
}

/**
 * Map an error code to its exit status.
 *
 * @param {string} code Candidate code.
 * @returns {number} Exit status (`INTERNAL` for anything unregistered).
 */
export function exitForCode(code) {
  return EXIT_BY_CODE[code] ?? CLI_EXIT.INTERNAL;
}

/**
 * @param {unknown} error Candidate value.
 * @returns {boolean} `true` for a handled CLI error.
 */
export function isCliError(error) {
  return error instanceof CliError;
}

/**
 * Normalize any thrown value into a CLI error.
 *
 * A programming fault keeps its message (it is our own text, not daemon output) but never
 * its stack, and the message is collapsed to a single printable line: a throw from a
 * nested frame can carry newlines, and a `--json` consumer must not receive a message
 * that is secretly three lines long. Rendering sanitizes again, but the invariant belongs
 * on the object that everything downstream reads.
 *
 * @param {unknown} error Thrown value.
 * @returns {CliError} Handled error.
 */
export function toCliError(error) {
  if (error instanceof CliError) {
    return error;
  }
  const raw = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  const message = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim().slice(0, 200);
  return new CliError(CLI_CODES.INTERNAL, message.length === 0 ? 'unexpected internal failure' : message);
}
