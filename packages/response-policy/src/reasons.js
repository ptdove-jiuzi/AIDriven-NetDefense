/**
 * reasons.js — the closed set of decision outcomes and reason codes.
 *
 * Reason codes are part of the public contract: UI text, audit rows and helper
 * logs all key off them, so they are **never** reworded and never composed at
 * runtime (no `DENY_${kind}` string building). Adding a code is an additive
 * change; renaming one is a breaking change.
 *
 * Every code declares its outcome explicitly instead of being inferred from a
 * `DENY_` prefix. That way a future code such as `HOLD_FOR_REVIEW` cannot
 * silently fall through to `allow` because of its spelling.
 */

/** @typedef {'allow' | 'needs_approval' | 'deny'} Outcome */

/** @type {Readonly<Record<string, Outcome>>} */
export const OUTCOMES = Object.freeze({
  ALLOW: 'allow',
  NEEDS_APPROVAL: 'needs_approval',
  DENY: 'deny',
});

export const REASON_CODES = Object.freeze({
  /** The policy gate permits the caller to continue. Never an execution authorisation. */
  ALLOWED: 'ALLOWED',
  /** A human approval is mandatory for this action and none was supplied. */
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',

  // ---- request / environment -------------------------------------------
  DENY_INPUT_INVALID: 'DENY_INPUT_INVALID',
  DENY_POLICY_VERSION_UNSUPPORTED: 'DENY_POLICY_VERSION_UNSUPPORTED',
  DENY_POLICY_VERSION_STALE: 'DENY_POLICY_VERSION_STALE',
  DENY_OS_UNKNOWN: 'DENY_OS_UNKNOWN',
  DENY_OS_UNSUPPORTED: 'DENY_OS_UNSUPPORTED',
  /** No epoch was supplied, so a stale snapshot cannot be distinguished from a fresh one. */
  DENY_EPOCH_REQUIRED: 'DENY_EPOCH_REQUIRED',

  // ---- action catalog ---------------------------------------------------
  DENY_UNKNOWN_ACTION: 'DENY_UNKNOWN_ACTION',
  DENY_ACTION_FORBIDDEN: 'DENY_ACTION_FORBIDDEN',

  // ---- target -----------------------------------------------------------
  DENY_TARGET_SHAPE: 'DENY_TARGET_SHAPE',
  DENY_TARGET_KIND_UNSUPPORTED: 'DENY_TARGET_KIND_UNSUPPORTED',
  DENY_TARGET_KIND_MISMATCH: 'DENY_TARGET_KIND_MISMATCH',
  DENY_TARGET_NONCANONICAL: 'DENY_TARGET_NONCANONICAL',
  DENY_TARGET_TRAVERSAL: 'DENY_TARGET_TRAVERSAL',
  DENY_TARGET_DEVICE_PATH: 'DENY_TARGET_DEVICE_PATH',
  DENY_TARGET_ADS: 'DENY_TARGET_ADS',
  DENY_TARGET_RESERVED_NAME: 'DENY_TARGET_RESERVED_NAME',
  DENY_TARGET_TOO_LARGE: 'DENY_TARGET_TOO_LARGE',
  DENY_TARGET_INSUFFICIENT_IDENTITY: 'DENY_TARGET_INSUFFICIENT_IDENTITY',
  DENY_TARGET_OS_MISMATCH: 'DENY_TARGET_OS_MISMATCH',
  DENY_TARGET_DRIFT: 'DENY_TARGET_DRIFT',

  // ---- parameters -------------------------------------------------------
  DENY_PARAMETER_SHAPE: 'DENY_PARAMETER_SHAPE',
  DENY_PARAMETER_UNKNOWN_FIELD: 'DENY_PARAMETER_UNKNOWN_FIELD',
  DENY_PARAMETER_MISSING: 'DENY_PARAMETER_MISSING',
  DENY_PARAMETER_TYPE: 'DENY_PARAMETER_TYPE',
  DENY_PARAMETER_ENUM: 'DENY_PARAMETER_ENUM',
  DENY_PARAMETER_RANGE: 'DENY_PARAMETER_RANGE',
  DENY_PARAMETER_TOO_LARGE: 'DENY_PARAMETER_TOO_LARGE',
  DENY_PARAMETER_PATH_TRAVERSAL: 'DENY_PARAMETER_PATH_TRAVERSAL',
  DENY_PARAMETER_DEVICE_PATH: 'DENY_PARAMETER_DEVICE_PATH',
  DENY_PARAMETER_ADS: 'DENY_PARAMETER_ADS',
  DENY_PARAMETER_RESERVED_NAME: 'DENY_PARAMETER_RESERVED_NAME',
  DENY_PARAMETER_OUTSIDE_ROOT: 'DENY_PARAMETER_OUTSIDE_ROOT',
  DENY_PARAMETER_COMMAND_STRING: 'DENY_PARAMETER_COMMAND_STRING',
  DENY_PARAMETER_NONCANONICAL: 'DENY_PARAMETER_NONCANONICAL',

  // ---- risk / role ------------------------------------------------------
  DENY_RISK_UNDERSTATED: 'DENY_RISK_UNDERSTATED',
  DENY_ROLE_INSUFFICIENT: 'DENY_ROLE_INSUFFICIENT',

  // ---- proposal ---------------------------------------------------------
  DENY_PROPOSAL_INVALID: 'DENY_PROPOSAL_INVALID',
  /** A human-approvable action was evaluated without the proposal its approval binds. */
  DENY_PROPOSAL_REQUIRED: 'DENY_PROPOSAL_REQUIRED',
  DENY_PROPOSAL_MISMATCH: 'DENY_PROPOSAL_MISMATCH',
  DENY_PROPOSAL_EXPIRED: 'DENY_PROPOSAL_EXPIRED',

  // ---- approval ---------------------------------------------------------
  DENY_APPROVAL_INVALID: 'DENY_APPROVAL_INVALID',
  DENY_APPROVAL_STATE: 'DENY_APPROVAL_STATE',
  DENY_APPROVAL_ROLE: 'DENY_APPROVAL_ROLE',
  DENY_APPROVAL_EXPIRED: 'DENY_APPROVAL_EXPIRED',
  DENY_APPROVAL_NOT_YET_VALID: 'DENY_APPROVAL_NOT_YET_VALID',
  DENY_APPROVAL_TARGET_DRIFT: 'DENY_APPROVAL_TARGET_DRIFT',
  DENY_APPROVAL_PROPOSAL_MISMATCH: 'DENY_APPROVAL_PROPOSAL_MISMATCH',
  DENY_APPROVAL_EPOCH: 'DENY_APPROVAL_EPOCH',
  DENY_APPROVAL_NONCE_REPLAY: 'DENY_APPROVAL_NONCE_REPLAY',

  // ---- execution grant --------------------------------------------------
  DENY_GRANT_INVALID: 'DENY_GRANT_INVALID',
  DENY_GRANT_ACTION_MISMATCH: 'DENY_GRANT_ACTION_MISMATCH',
  DENY_GRANT_PARAMETERS_DRIFT: 'DENY_GRANT_PARAMETERS_DRIFT',
  DENY_GRANT_TARGET_DRIFT: 'DENY_GRANT_TARGET_DRIFT',
  DENY_GRANT_APPROVAL_MISMATCH: 'DENY_GRANT_APPROVAL_MISMATCH',
  DENY_GRANT_EPOCH: 'DENY_GRANT_EPOCH',
  DENY_GRANT_NOT_YET_VALID: 'DENY_GRANT_NOT_YET_VALID',
  DENY_GRANT_EXPIRED: 'DENY_GRANT_EXPIRED',
  DENY_GRANT_NONCE_REPLAY: 'DENY_GRANT_NONCE_REPLAY',
  DENY_GRANT_EXECUTION_REPLAY: 'DENY_GRANT_EXECUTION_REPLAY',
});

/**
 * Explicit outcome per reason code.
 *
 * @type {Readonly<Record<string, Outcome>>}
 */
export const REASON_OUTCOMES = Object.freeze(
  Object.fromEntries(
    Object.values(REASON_CODES).map((code) => [
      code,
      code === REASON_CODES.ALLOWED
        ? OUTCOMES.ALLOW
        : code === REASON_CODES.APPROVAL_REQUIRED
          ? OUTCOMES.NEEDS_APPROVAL
          : OUTCOMES.DENY,
    ]),
  ),
);

/**
 * @param {string} code Reason code.
 * @returns {Outcome} The outcome that code implies.
 * @throws {TypeError} When `code` is not a declared reason code — an undeclared
 *   code must never be able to reach a caller, because callers branch on it.
 */
export function outcomeFor(code) {
  const outcome = REASON_OUTCOMES[code];
  if (outcome === undefined) {
    throw new TypeError(`unknown reason code: ${String(code)}`);
  }
  return outcome;
}

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} True when `value` is a declared reason code.
 */
export function isReasonCode(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REASON_OUTCOMES, value);
}
