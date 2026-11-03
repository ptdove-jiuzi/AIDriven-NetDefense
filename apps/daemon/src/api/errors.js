/**
 * api/errors.js — the API layer's own error vocabulary.
 *
 * `src/errors.js` holds the *daemon's* closed code set. That set belongs to another
 * module and describes conditions the daemon must degrade on (store down, source
 * busy, lifecycle wrong). It deliberately does not grow for this API: a bad
 * `?limit=` is not a daemon condition, it is a caller mistake, and folding it into
 * `DAEMON_CODES` would make every future "did the daemon or the caller fail?" check
 * read the same vocabulary.
 *
 * `ApiError` therefore does not extend `DaemonError`. `DaemonError` snaps an unknown
 * code to `INTERNAL` (a closed-set guard), so an `ApiError` code would either be
 * erased or force that guard open. Keeping the two classes apart keeps the daemon's
 * code set closed and lets the server render `QUERY_INVALID` / `CURSOR_INVALID` at
 * `400` instead of falling through to the `500` catch-all.
 *
 * The class carries the same discipline as its daemon sibling: `code` is one of two
 * stable values, and `details` is for identifiers and short reason words only —
 * never a path, a stack, a token or a cursor body.
 */

/** Stable API-only code registry. */
export const API_CODES = Object.freeze({
  QUERY_INVALID: 'QUERY_INVALID',
  CURSOR_INVALID: 'CURSOR_INVALID',
});

/** Status code for each API-only code. Both are caller faults, both are `400`. */
export const API_STATUS_BY_CODE = Object.freeze({
  [API_CODES.QUERY_INVALID]: 400,
  [API_CODES.CURSOR_INVALID]: 400,
});

const API_CODE_SET = new Set(Object.values(API_CODES));

/**
 * Caller-facing API error.
 *
 * The constructor normalizes an unknown code to `QUERY_INVALID` instead of throwing:
 * a wrong code inside this class is a programming fault, and the only safe rendering
 * of "the request was not understood" is a `400`, never a `500` that suggests the
 * daemon broke.
 */
export class ApiError extends Error {
  /**
   * @param {string} code One of {@link API_CODES}.
   * @param {string} message Human readable, never containing a secret.
   * @param {object} [details] Identifier and short reason fields only.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    /** @type {string} */
    this.code = API_CODE_SET.has(code) ? code : API_CODES.QUERY_INVALID;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
    Error.captureStackTrace?.(this, ApiError);
  }
}

/**
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` for an API error (by class or by code shape).
 */
export function isApiError(value) {
  return value instanceof ApiError
    || (value !== null && typeof value === 'object' && typeof value.code === 'string' && API_CODE_SET.has(value.code));
}
