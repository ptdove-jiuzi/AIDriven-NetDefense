/**
 * errors.js — the only error type this package throws.
 *
 * Design rule (mirrors `packages/detection`): **data never throws**. A malformed
 * target, an unknown action or a stale approval all degrade to a decision object
 * with a stable reason code. This class exists for the two situations where a
 * decision is the wrong shape of answer:
 *
 *   1. `normalizeTarget` / `normalizeParameters` are also used as standalone
 *      validators. A caller that explicitly asks "normalise this" needs to know
 *      *why* the input was rejected instead of receiving a boolean.
 *   2. Catalog construction: a table that contradicts itself is a programming
 *      error, not attacker-controlled data.
 *
 * `evaluateResponsePolicy` catches every `PolicyError` and turns it into a
 * `deny` decision, so a leaked throw can never upgrade an outcome.
 */

/** @typedef {'DENY_UNKNOWN_ACTION' | string} PolicyErrorCode */

export class PolicyError extends Error {
  /**
   * @param {PolicyErrorCode} code Stable machine-readable code; identical to the
   *   reason code the same failure produces inside a decision.
   * @param {string} path Location inside the caller's input, `$` prefixed.
   * @param {string} message Human readable explanation.
   * @param {Record<string, unknown>} [detail] Optional structured detail.
   */
  constructor(code, path, message, detail) {
    super(`${code}: ${message}`);
    this.name = 'PolicyError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.path = typeof path === 'string' && path.length > 0 ? path : '$';
    if (detail !== undefined) {
      /** @type {Record<string, unknown> | undefined} */
      this.detail = detail;
    }
  }
}

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} True when `value` is a `PolicyError`.
 */
export function isPolicyError(value) {
  return value instanceof PolicyError;
}

/**
 * @param {PolicyErrorCode} code Reason code.
 * @param {string} path Dot path inside the caller input.
 * @param {string} message Human readable message.
 * @param {Record<string, unknown>} [detail] Structured detail.
 * @returns {never}
 */
export function policyFail(code, path, message, detail) {
  throw new PolicyError(code, path, message, detail);
}
