/**
 * canonical.js — deterministic serialization, content derived identifiers and
 * preview truncation.
 *
 * The canonical form sorts object keys by UTF-16 code unit order and renders
 * unsupported values as `null`, so two structurally equal inputs always produce
 * the same bytes on every platform.
 */

import { createHash } from 'node:crypto';

/** Length of a full SHA-256 hex digest. */
export const SHA256_HEX_LENGTH = 64;

/**
 * Serialize a value into a stable canonical JSON string.
 *
 * Supported inputs: `null`, booleans, finite numbers, strings, arrays and plain
 * objects. `undefined` object members are omitted, `undefined` array members and
 * non-finite numbers become `null`.
 *
 * @param {unknown} value Value to serialize.
 * @returns {string} Canonical JSON text.
 */
export function canonicalStringify(value) {
  return encode(value);
}

function encode(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (type === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      parts.push(encode(item));
    }
    return `[${parts.join(',')}]`;
  }
  if (type === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const parts = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${encode(record[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/**
 * Lowercase hex SHA-256 digest of the UTF-8 encoding of `input`.
 *
 * @param {string} input Text to digest.
 * @returns {string} 64 lowercase hexadecimal characters.
 */
export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

/**
 * Deterministic short identifier derived from text: the leading hex characters
 * of its SHA-256 digest.
 *
 * @param {string} input Text to digest.
 * @param {number} [length] Number of hex characters to keep, `1..64`.
 * @returns {string} Lowercase hexadecimal identifier.
 * @throws {RangeError} When `length` is outside `1..64`.
 */
export function shortHash(input, length = 32) {
  if (!Number.isInteger(length) || length < 1 || length > SHA256_HEX_LENGTH) {
    throw new RangeError(`short hash length must be an integer in 1..${SHA256_HEX_LENGTH}`);
  }
  return sha256Hex(input).slice(0, length);
}

/**
 * Truncate a preview to a maximum length counted in Unicode code points.
 *
 * When truncation happens the last kept character is replaced by an ellipsis so
 * the result never exceeds `maxLength` code points.
 *
 * @param {unknown} value Value to render.
 * @param {number} maxLength Maximum preview length, at least `1`.
 * @returns {string} Preview text.
 * @throws {RangeError} When `maxLength` is not a positive integer.
 */
export function truncatePreview(value, maxLength) {
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError('preview limit must be a positive integer');
  }
  const text = typeof value === 'string' ? value : String(value ?? '');
  const characters = Array.from(text);
  if (characters.length <= maxLength) {
    return text;
  }
  return `${characters.slice(0, maxLength - 1).join('')}…`;
}
