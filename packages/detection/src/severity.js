/**
 * severity.js — severity levels, rank ordering and safe parsing.
 *
 * Ranks are fixed: info=0, low=1, medium=2, high=3, critical=4. Unknown values
 * rank as -1 so callers can use a single numeric comparison without throwing.
 */

/** Ordered severity levels, lowest first. @type {readonly string[]} */
export const SEVERITY_LEVELS = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

const RANK_BY_LEVEL = new Map(SEVERITY_LEVELS.map((level, index) => [level, index]));

/**
 * Parse a caller supplied severity value.
 *
 * @param {unknown} value Candidate value.
 * @returns {string | null} Canonical level, or `null` when the value is not a known level.
 */
export function parseSeverity(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return RANK_BY_LEVEL.has(normalized) ? normalized : null;
}

/**
 * Report whether a value is a known severity level.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` when {@link parseSeverity} succeeds.
 */
export function isSeverity(value) {
  return parseSeverity(value) !== null;
}

/**
 * Rank of a severity value.
 *
 * @param {unknown} value Candidate value.
 * @returns {number} `0..4` for known levels, `-1` otherwise.
 */
export function severityRank(value) {
  const parsed = parseSeverity(value);
  return parsed === null ? -1 : RANK_BY_LEVEL.get(parsed);
}

/**
 * Level for a numeric rank.
 *
 * @param {number} rank Rank value.
 * @returns {string | null} Level, or `null` when the rank is outside `0..4`.
 */
export function severityByRank(rank) {
  if (!Number.isInteger(rank) || rank < 0 || rank >= SEVERITY_LEVELS.length) {
    return null;
  }
  return SEVERITY_LEVELS[rank];
}

/**
 * Compare two severity values by rank.
 *
 * @param {unknown} left First value.
 * @param {unknown} right Second value.
 * @returns {-1 | 0 | 1} Negative when `left` is lower, positive when higher.
 */
export function compareSeverity(left, right) {
  const delta = severityRank(left) - severityRank(right);
  if (delta === 0) {
    return 0;
  }
  return delta < 0 ? -1 : 1;
}

/**
 * Highest of two severity values, ignoring unknown values.
 *
 * @param {string | null} left First value.
 * @param {string | null} right Second value.
 * @returns {string | null} Highest known level, or `null` when both are unknown.
 */
export function maxSeverity(left, right) {
  if (severityRank(left) >= severityRank(right)) {
    return left ?? null;
  }
  return right ?? null;
}
