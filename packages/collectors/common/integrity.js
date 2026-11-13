/**
 * Canonical JSON + SHA-256 digest of a telemetry `payload` (A2-SHAPE §3).
 *
 * Why this module exists: the TelemetryEvent contract requires
 * `integrity = { algorithm: 'sha256', digest: canonicalDigest(payload) }` and the
 * event store has `integrity_digest TEXT NOT NULL`. The collector factory used to
 * write `integrity: null` for every event, so a real host had 8 082 events rejected
 * with `ERR_NULL_NOT_ALLOWED` in ten minutes (COLLECTOR-LIVE §4 CL-4).
 *
 * The collector packages deliberately have no dependency on `@aegisharness/contracts`
 * (they are shipped standalone), so the encoding is implemented here — and it must be
 * **byte-identical** to `packages/contracts/src/canonical.js`, otherwise the store
 * rejects every event with `ERR_INTEGRITY_DIGEST_MISMATCH`. That equality is not left
 * to review: `tests/wp2-windows/integrity.test.js` compares both implementations over
 * ASCII/CJK/control-character/nesting cases.
 *
 * Rules (mirroring the contract):
 * - `null` → `null`; booleans as literals;
 * - numbers: non-finite and unsafe integers are rejected, `-0` is `0`;
 * - strings: only `"`, `\` and U+0000–U+001F are escaped (`\u00xx`, lower-case hex),
 *   everything else is emitted verbatim; lone surrogates are rejected;
 * - arrays: dense, no keys other than `length` and indices inside the length;
 * - objects: plain (`Object.prototype` or `null` prototype), enumerable own string
 *   keys only, sorted, no accessors and no symbol keys;
 * - no whitespace between tokens; depth is bounded like the contract.
 */

import { createHash } from 'node:crypto';
import { CollectorError, ERROR_CODES, isPlainObject } from './errors.js';

/**
 * Depth bound, mirroring `LIMITS.maxDepth` in `packages/contracts`.
 * `tests/wp2-windows/integrity.test.js` asserts the two constants agree.
 */
export const CANONICAL_MAX_DEPTH = 6;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/u;

function fail(message, details) {
  throw new CollectorError(ERROR_CODES.INVALID_RECORD, `payload cannot be canonicalized: ${message}`, details);
}

function quote(value, path) {
  if (LONE_SURROGATE.test(value)) {
    fail('string contains a lone surrogate, so two different inputs could share a digest', { path });
  }
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22) {
      out += '\\"';
    } else if (unit === 0x5c) {
      out += '\\\\';
    } else if (unit < 0x20) {
      out += `\\u${unit.toString(16).padStart(4, '0')}`;
    } else {
      out += value[index];
    }
  }
  return `${out}"`;
}

function writeNumber(value, path) {
  if (!Number.isFinite(value)) {
    fail('non-finite number', { path });
  }
  if (value === 0) {
    return '0';
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    fail('integer outside the safe range would lose precision', { path });
  }
  return String(value);
}

function readDataProperty(target, key, path) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, key);
  } catch (error) {
    fail(`unreadable property "${key}": ${error?.message ?? error}`, { path });
  }
  if (descriptor === undefined) {
    fail(`property "${key}" disappeared during traversal`, { path });
  }
  if (!('value' in descriptor)) {
    // Same reason as the contract: a getter could return different data on a second
    // read, so the digest would stop being a function of the content.
    fail(`property "${key}" is an accessor; only plain data can be canonicalized`, { path });
  }
  return descriptor.value;
}

function assertArrayShape(value, length, path) {
  let names;
  try {
    names = Object.getOwnPropertyNames(value);
  } catch (error) {
    fail(`unreadable array: ${error?.message ?? error}`, { path });
  }
  for (const key of names) {
    if (key === 'length') {
      continue;
    }
    if (!ARRAY_INDEX.test(key) || !(Number(key) < length)) {
      fail(`array carries the non-index key "${key}"`, { path });
    }
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      fail(`array index "${key}" is not enumerable`, { path });
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail('array carries symbol keys', { path });
  }
  for (let index = 0; index < length; index += 1) {
    if (Object.getOwnPropertyDescriptor(value, String(index)) === undefined) {
      fail(`array is sparse at index ${index}`, { path });
    }
  }
}

function serialize(value, path, stack, depth) {
  if (value === null) {
    return 'null';
  }
  const type = typeof value;
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'string') {
    return quote(value, path);
  }
  if (type === 'number') {
    return writeNumber(value, path);
  }
  if (type === 'object') {
    if (depth > CANONICAL_MAX_DEPTH) {
      fail(`nested deeper than ${CANONICAL_MAX_DEPTH} levels`, { path });
    }
    if (stack.includes(value)) {
      fail('circular structure', { path });
    }
    stack.push(value);
    let out;
    if (Array.isArray(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0) {
        fail('array with an invalid length', { path });
      }
      assertArrayShape(value, length, path);
      const items = [];
      for (let index = 0; index < length; index += 1) {
        const itemPath = `${path}[${index}]`;
        items.push(serialize(readDataProperty(value, String(index), itemPath), itemPath, stack, depth + 1));
      }
      out = `[${items.join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        fail('only plain objects and arrays can be canonicalized', { path });
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        fail('object carries symbol keys', { path });
      }
      const names = Object.getOwnPropertyNames(value);
      for (const key of names) {
        if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
          fail(`object carries the hidden key "${key}"`, { path });
        }
      }
      const keys = names.sort();
      out = `{${keys
        .map((key) => {
          const keyPath = `${path}.${key}`;
          return `${quote(key, path)}:${serialize(readDataProperty(value, key, keyPath), keyPath, stack, depth + 1)}`;
        })
        .join(',')}}`;
    }
    stack.pop();
    return out;
  }
  fail(`a value of type ${type} is not representable in canonical JSON`, { path });
  return '';
}

/**
 * Canonical JSON text of a payload.
 *
 * @param {unknown} value Payload (plain data only).
 * @returns {string} Canonical text.
 * @throws {CollectorError} `INVALID_RECORD` when the payload cannot be canonicalized.
 */
export function canonicalPayloadText(value) {
  return serialize(value, '$', [], 1);
}

/**
 * `sha256(canonicalPayloadText(value))` as 64 lower-case hex characters.
 *
 * @param {unknown} value Payload.
 * @returns {string} Digest.
 */
export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalPayloadText(value), 'utf8').digest('hex');
}

/**
 * The `integrity` object the TelemetryEvent contract requires.
 *
 * @param {unknown} payload Payload of the event.
 * @returns {{algorithm: 'sha256', digest: string}} Frozen integrity object.
 */
export function payloadIntegrity(payload) {
  if (!isPlainObject(payload)) {
    throw new CollectorError(ERROR_CODES.INVALID_RECORD, 'integrity can only be computed over a plain payload object');
  }
  return Object.freeze({ algorithm: 'sha256', digest: canonicalDigest(payload) });
}
