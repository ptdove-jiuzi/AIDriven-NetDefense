/**
 * time.js — strict RFC3339 UTC parsing for the policy gate.
 *
 * The policy layer must never consult a clock: every timestamp comparison is
 * made against the `now` supplied by the caller, so a decision is reproducible
 * from its inputs alone. This module therefore only *parses*, it never reads the
 * current time.
 *
 * Format is deliberately identical to the contracts layer: `YYYY-MM-DDTHH:MM:SS`
 * with an optional `.mmm` and a literal uppercase `Z`. Numeric offsets are
 * rejected because two spellings of the same instant would otherwise produce
 * two different digests.
 */

const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Parse a strict RFC3339 UTC timestamp into epoch milliseconds.
 *
 * @param {unknown} value Candidate timestamp.
 * @returns {number | null} Epoch milliseconds, or `null` when the value is not a
 *   valid, calendar-correct RFC3339 UTC timestamp.
 */
export function parseUtcMs(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339_UTC.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milli = match[7] === undefined ? 0 : Number(match[7]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milli);
  return date.getTime();
}

/**
 * @param {unknown} value Candidate timestamp.
 * @returns {boolean} True when `value` parses as strict RFC3339 UTC.
 */
export function isUtcTimestamp(value) {
  return parseUtcMs(value) !== null;
}
