/**
 * errors.js — error types raised by the detection package.
 *
 * Data-level problems never throw: they degrade to decisions, gaps and rule
 * isolation. Two classes do throw: registration failures (engine construction,
 * rule pack loading) and caller programming errors (a non-array `ingest`
 * argument, an unavailable id factory). The latter freeze the engine — see the
 * header of `engine.js` — because a batch that throws is not rolled back.
 */

/**
 * Raised when a rule or rule pack fails declarative validation.
 *
 * @param {string} message Human readable message.
 * @param {{ code?: string, path?: string, detail?: unknown }} [options] Machine readable metadata.
 */
export class RuleDefinitionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RuleDefinitionError';
    /** @type {string} stable error code for callers and tests */
    this.code = options.code ?? 'RULE_DEFINITION_INVALID';
    if (options.path !== undefined) {
      /** @type {string} location inside the rule pack, for example `rules[2].when.all[0]` */
      this.path = options.path;
    }
    if (options.detail !== undefined) {
      /** @type {unknown} structured detail, always JSON serializable */
      this.detail = options.detail;
    }
  }
}

/**
 * Raised when engine configuration values are missing or out of range.
 *
 * @param {string} message Human readable message.
 * @param {{ code?: string, path?: string, detail?: unknown }} [options] Machine readable metadata.
 *   `code` defaults to `DETECTION_CONFIG_INVALID`; callers that need a distinct
 *   machine readable reason (for example the frozen-engine guard) may override it.
 */
export class DetectionConfigError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DetectionConfigError';
    /** @type {string} stable error code for callers and tests */
    this.code = options.code ?? 'DETECTION_CONFIG_INVALID';
    if (options.path !== undefined) {
      this.path = options.path;
    }
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }
}

/**
 * Raised when a *field of the event* cannot be read (a throwing getter, a Proxy
 * trap, a getter that mutates the object mid-read).
 *
 * Why this is a distinct type: `evaluateRule` used to treat every exception the
 * same way and isolate the rule permanently. That conflates two very different
 * failures — a rule that throws is a code bug worth isolating, while an event
 * whose fields are unreadable is *data*, and one malformed event must never be
 * able to silence a rule for every later batch (data driven detection DoS).
 *
 * The engine therefore downgrades this type to "this event did not match, plus a
 * gap", and keeps the rule enabled.
 *
 * @param {string} message Human readable message.
 * @param {{ path?: string, detail?: unknown }} [options] Machine readable metadata.
 */
export class UnreadableFieldError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'UnreadableFieldError';
    /** @type {string} stable error code for callers and tests */
    this.code = options.code ?? 'DETECTION_FIELD_UNREADABLE';
    /** @type {string | null} dotted path that could not be read */
    this.path = typeof options.path === 'string' ? options.path : null;
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
  }
}

/**
 * @param {unknown} value Candidate error.
 * @returns {boolean} `true` for an unreadable-event-field failure.
 */
export function isUnreadableFieldError(value) {
  return value instanceof UnreadableFieldError;
}

