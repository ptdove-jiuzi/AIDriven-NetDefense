/**
 * errors.js — the closed set of helper-side refusal codes.
 *
 * These are **helper** codes, deliberately disjoint from
 * `packages/response-policy`'s reason codes. The policy layer answers "may this
 * action be requested at all"; the helper answers "can this particular dispatch,
 * on this particular object, right now, be turned into a plan". Keeping the two
 * vocabularies apart means an audit row can tell "policy said no" from
 * "policy said yes but the helper could not bind the object".
 *
 * A helper code is never an authorisation and never a success: every code in this
 * table maps to a refusal or a blocked plan. There is no `HELPER_OK`.
 */

/** @type {Readonly<Record<string, string>>} */
export const HELPER_CODES = Object.freeze({
  /** The dispatch envelope is not the closed shape the interface declares. */
  HELPER_ENVELOPE_INVALID: 'HELPER_ENVELOPE_INVALID',
  /** The envelope declares an interface version this build does not speak. */
  HELPER_VERSION_UNSUPPORTED: 'HELPER_VERSION_UNSUPPORTED',
  /** The action is not on the helper's own allowlist (defence in depth). */
  HELPER_ACTION_NOT_ALLOWED: 'HELPER_ACTION_NOT_ALLOWED',
  /** The host OS family could not be determined, so nothing may be planned. */
  HELPER_OS_UNKNOWN: 'HELPER_OS_UNKNOWN',
  /** The dispatch targets a different OS family than the host runs. */
  HELPER_OS_MISMATCH: 'HELPER_OS_MISMATCH',
  /** The OS capability the action needs is explicitly denied. */
  HELPER_CAPABILITY_DENIED: 'HELPER_CAPABILITY_DENIED',
  /** The OS capability could not be established; unknown is treated as denied. */
  HELPER_CAPABILITY_UNKNOWN: 'HELPER_CAPABILITY_UNKNOWN',
  /** The target object no longer exists. */
  HELPER_TARGET_MISSING: 'HELPER_TARGET_MISSING',
  /** Existence could not be established (probe denied or silent); never read as "absent". */
  HELPER_TARGET_UNVERIFIABLE: 'HELPER_TARGET_UNVERIFIABLE',
  /** The object at the target's coordinates is a different object than authorised. */
  HELPER_TARGET_DRIFT: 'HELPER_TARGET_DRIFT',
  /** A probe port returned something that is not its declared shape. */
  HELPER_PROBE_INVALID: 'HELPER_PROBE_INVALID',
  /** A grant, decision and dispatch disagree about what is being authorised. */
  HELPER_BINDING_MISMATCH: 'HELPER_BINDING_MISMATCH',
  /** The action needs an approval, so a dispatch without a grant cannot be planned. */
  HELPER_GRANT_MISSING: 'HELPER_GRANT_MISSING',
  /** The grant signature could not be verified against a configured trust root. */
  HELPER_GRANT_UNVERIFIED: 'HELPER_GRANT_UNVERIFIED',
  /** The grant nonce was already consumed by this helper instance. */
  HELPER_NONCE_REPLAY: 'HELPER_NONCE_REPLAY',
  /** A different attempt claims an execution id this helper already accepted. */
  HELPER_EXECUTION_CONFLICT: 'HELPER_EXECUTION_CONFLICT',
  /** Real execution is compiled out of this build. */
  HELPER_EXECUTION_DISABLED: 'HELPER_EXECUTION_DISABLED',
  /** The dispatch timestamp is too far from this helper's own clock to be fresh. */
  HELPER_CLOCK_SKEW: 'HELPER_CLOCK_SKEW',
  /** The dedupe inbox is full; a new claim is refused rather than evicting an old one. */
  HELPER_INBOX_FULL: 'HELPER_INBOX_FULL',
  /**
   * The dedupe inbox threw, or answered something that is not its declared shape.
   *
   * A port that throws must never escape `prepare`/`dryRun`: over an IPC boundary a
   * thrown error is indistinguishable from "the check never ran", which is exactly
   * the confusion the dedupe check exists to prevent. This code says "the inbox
   * could not be consulted", never "the dispatch was accepted".
   */
  HELPER_INBOX_UNAVAILABLE: 'HELPER_INBOX_UNAVAILABLE',
  /** The recovery manifest recorder refused or is not configured. */
  HELPER_MANIFEST_UNAVAILABLE: 'HELPER_MANIFEST_UNAVAILABLE',
});

const CODE_VALUES = new Set(Object.values(HELPER_CODES));

/**
 * A refusal raised inside the helper.
 *
 * `path` is a bounded field path, never a raw object value: a refusal ends up in
 * an audit row and a UI toast, and echoing attacker-controlled text there is how
 * a path or a parameter becomes a rendering bug.
 */
export class HelperError extends Error {
  /**
   * @param {string} code One of {@link HELPER_CODES}.
   * @param {string} path Bounded field path such as `$.target`.
   * @param {string} message Short static description.
   * @param {object} [detail] Optional bounded detail (primitives only).
   */
  constructor(code, path, message, detail) {
    super(`${code}: ${message}`);
    this.name = 'HelperError';
    this.code = code;
    this.path = path;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * @param {string} code Candidate code.
 * @param {string} path Field path.
 * @param {string} message Static description.
 * @param {object} [detail] Bounded detail.
 * @returns {never} Always throws.
 */
export function helperFail(code, path, message, detail) {
  if (!CODE_VALUES.has(code)) {
    throw new HelperError(
      HELPER_CODES.HELPER_ENVELOPE_INVALID,
      path,
      'helper raised an undeclared refusal code',
    );
  }
  throw new HelperError(code, path, message, detail);
}

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} True when `value` is a helper refusal raised by this module.
 */
export function isHelperError(value) {
  return value instanceof HelperError
    && typeof value.code === 'string'
    && CODE_VALUES.has(value.code);
}

/**
 * @param {unknown} code Candidate.
 * @returns {boolean} True when `code` is a declared helper code.
 */
export function isHelperCode(code) {
  return typeof code === 'string' && CODE_VALUES.has(code);
}
