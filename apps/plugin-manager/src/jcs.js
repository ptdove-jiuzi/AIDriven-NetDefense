// AegisHarness plugin manager — author: PT-dove
// RFC 8785 (JCS) canonical JSON plus SHA-256 helpers. Canonicalisation is the only
// comparison primitive used for digests and for overlay tamper checks.

import { createHash } from 'node:crypto';
import { ERROR_CODES, PluginCheckError } from './errors.js';
import { parseStrictJson } from './json.js';

const SHORT_ESCAPES = new Map([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
]);

const MAX_CANONICAL_DEPTH = 128;

function invalid(detail) {
  return new PluginCheckError(ERROR_CODES.INVALID_VALUE, `cannot canonicalise value: ${detail}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function escapeString(value) {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const ch = value[index];
    if (ch === '"') {
      out += '\\"';
      continue;
    }
    if (ch === '\\') {
      out += '\\\\';
      continue;
    }
    const short = SHORT_ESCAPES.get(code);
    if (short !== undefined) {
      out += short;
      continue;
    }
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) throw invalid('lone high surrogate in string');
      out += ch + value[index + 1];
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw invalid('lone low surrogate in string');
    out += ch;
  }
  return `${out}"`;
}

function serializeNumber(value) {
  if (!Number.isFinite(value)) throw invalid('number is not finite');
  if (value === 0) return '0';
  return String(value);
}

function serialize(value, stack, depth) {
  if (depth > MAX_CANONICAL_DEPTH) throw invalid(`nesting deeper than ${MAX_CANONICAL_DEPTH} levels`);
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'string') return escapeString(value);
  if (kind === 'number') return serializeNumber(value);
  if (kind !== 'object') throw invalid(`unsupported value of type ${kind}`);
  if (stack.has(value)) throw invalid('circular reference');

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const parts = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw invalid('sparse array is not canonical JSON');
        parts.push(serialize(value[index], stack, depth + 1));
      }
      return `[${parts.join(',')}]`;
    }
    if (!isPlainObject(value)) {
      const name = Object.prototype.toString.call(value);
      throw invalid(`unsupported object ${name}`);
    }
    const keys = Object.keys(value);
    keys.sort();
    const parts = [];
    for (const key of keys) {
      parts.push(`${escapeString(key)}:${serialize(value[key], stack, depth + 1)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

/**
 * Produces the RFC 8785 canonical text of a JSON value.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  return serialize(value, new Set(), 1);
}

/**
 * Parses strict JSON and canonicalises the result.
 * @param {string} text
 * @param {object} [options]
 * @returns {string}
 */
export function canonicalizeJson(text, options) {
  return canonicalize(parseStrictJson(text, options));
}

/**
 * SHA-256 as lowercase hex.
 * @param {string|Uint8Array} input
 * @returns {string}
 */
export function sha256Hex(input) {
  const hash = createHash('sha256');
  if (typeof input === 'string') {
    hash.update(input, 'utf8');
  } else if (input instanceof Uint8Array) {
    hash.update(input);
  } else {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      'sha256Hex expects a string, Buffer or Uint8Array',
    );
  }
  return hash.digest('hex');
}

/**
 * Canonical digest of a JSON value.
 * @param {unknown} value
 * @returns {string}
 */
export function digestOf(value) {
  return sha256Hex(canonicalize(value));
}
