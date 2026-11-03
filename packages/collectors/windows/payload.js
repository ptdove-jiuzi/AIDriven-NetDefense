/**
 * Contract-safe payload construction (§4.2, `contracts/src/objects/telemetry-event.js`).
 *
 * Why this module exists: the TelemetryEvent payload is a *closed* object with stricter
 * rules than a plain JSON body, and the Windows adapter originally violated all of them:
 *
 * 1. Keys must match `/^[a-z][a-z0-9_]{0,63}$/`. `imagePath`, `recordId`, `localAddress`
 *    are rejected outright, so every record of the process/connection/event-log sources
 *    would have failed validation at delivery time.
 * 2. Values must be `string | safe integer | boolean` (or a homogeneous array of those).
 *    `null` is rejected, so "unknown pid" cannot be expressed as `null`; the key has to be
 *    omitted and the absence recorded elsewhere (`attribution: 'unavailable'`).
 * 3. Strings must be NFC, must not contain C0/C1 control characters, bidi controls or
 *    zero-width characters. Real Windows data breaks all three: event log messages are
 *    multi-line, command lines contain tabs, and provider text can carry RTL marks.
 * 4. The payload must stay under `maxPayloadBytes` (16 KiB) canonical bytes, which is a
 *    *total* budget, not a per-field one.
 *
 * The split of responsibilities is deliberate:
 * - A **key** that violates the pattern is a programming error in this package, so it
 *   throws `INVALID_RECORD`. A typo must fail loudly at the first test run.
 * - A **value** that cannot be represented is runtime data, so it is dropped and counted in
 *   `dropped`. Throwing would let a single odd row (a provider string containing a bad
 *   surrogate, a 40-bit integer) kill the whole batch and hide the other records.
 */

import { WINDOWS_ERROR_CODES, WindowsCollectorError } from './errors.js';

/** Mirrors `contracts` `PAYLOAD_KEY_PATTERN`. */
export const PAYLOAD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const MAX_PAYLOAD_STRING_BYTES = 16 * 1024;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const MAX_PAYLOAD_KEYS = 128;
export const MAX_PAYLOAD_ARRAY_ITEMS = 256;

// \t \n \r become a space (they are line structure, not content, and the contract rejects
// them outside `payload.raw_evidence`); every other C0/C1 character is removed.
const LINE_STRUCTURE = /[\t\n\r]+/g;
const OTHER_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;
const ZERO_WIDTH = /[\u200B-\u200F\uFEFF\u2060]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Make an arbitrary Windows string representable in a payload string field.
 * Order matters: strip first, normalize last, so the result is guaranteed NFC.
 */
export function sanitizeText(value, { maxBytes = MAX_PAYLOAD_STRING_BYTES } = {}) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(BIDI_CONTROLS, '')
    .replace(ZERO_WIDTH, '')
    .replace(LINE_STRUCTURE, ' ')
    .replace(OTHER_CONTROLS, '')
    .normalize('NFC');
  return truncateUtf8(cleaned, maxBytes);
}

/** Cut on a code-point boundary so a truncated string stays well formed and NFC-safe. */
export function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  // Below four bytes there is no room for both content and the ellipsis marker; returning an
  // over-long string would break the budget this function exists to enforce.
  if (maxBytes < 4) {
    return '';
  }
  const budget = maxBytes - 3;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > budget) {
      break;
    }
    bytes += size;
    end += character.length;
  }
  return `${text.slice(0, end)}...`;
}

function normalizeValue(value, key, dropped) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    // The contract only accepts safe integers; a float or a huge value is dropped instead
    // of being rounded, because a rounded pid or port would point at a different object.
    if (!Number.isSafeInteger(value)) {
      dropped.push({ key, reason: 'non_integer_number' });
      return undefined;
    }
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'string') {
    const cleaned = sanitizeText(value);
    return cleaned === null ? undefined : cleaned;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    const limited = value.slice(0, MAX_PAYLOAD_ARRAY_ITEMS);
    if (limited.length !== value.length) {
      dropped.push({ key, reason: 'array_too_long', count: value.length - limited.length });
    }
    const scalars = [];
    let kind = null;
    for (const entry of limited) {
      if (entry === null || entry === undefined || typeof entry === 'object') {
        dropped.push({ key, reason: 'non_scalar_array_item' });
        continue;
      }
      const scalar = normalizeValue(entry, key, dropped);
      if (scalar === undefined) {
        continue;
      }
      const entryKind = typeof scalar;
      if (kind === null) {
        kind = entryKind;
      } else if (kind !== entryKind) {
        dropped.push({ key, reason: 'mixed_array_types' });
        return undefined;
      }
      scalars.push(scalar);
    }
    return scalars.length === 0 ? undefined : scalars;
  }
  dropped.push({ key, reason: 'unsupported_type', type: typeof value });
  return undefined;
}

function measured(payload) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Shrink the payload to the byte budget.
 *
 * First truncate the longest string; when no string is left to shrink (or it is already tiny),
 * drop the largest remaining value. Arrays were the hole in the first version: only
 * `typeof value === 'string'` was considered, so a 256-item array of long strings produced a
 * 52 KiB payload that the contract then rejected — silently defeating the whole point of this
 * module.
 */
function enforceByteBudget(payload, dropped, maxPayloadBytes) {
  let guard = 0;
  while (measured(payload) > maxPayloadBytes && guard < 128) {
    guard += 1;
    let longestKey = null;
    let longestBytes = 0;
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value !== 'string') {
        continue;
      }
      const size = Buffer.byteLength(value, 'utf8');
      if (size > longestBytes) {
        longestBytes = size;
        longestKey = key;
      }
    }
    if (longestKey !== null && longestBytes > 8) {
      const overflow = measured(payload) - maxPayloadBytes;
      const target = Math.max(8, longestBytes - overflow - 4);
      payload[longestKey] = truncateUtf8(payload[longestKey], target);
      dropped.push({ key: longestKey, reason: 'payload_budget', bytes: longestBytes - target });
      continue;
    }

    // No string left to shrink: remove the largest remaining key outright so the payload can
    // never exceed the budget it promises to respect.
    let largestKey = null;
    let largestSize = -1;
    for (const [key, value] of Object.entries(payload)) {
      const size = Buffer.byteLength(JSON.stringify(value), 'utf8') + key.length;
      if (size > largestSize) {
        largestSize = size;
        largestKey = key;
      }
    }
    if (largestKey === null) {
      break;
    }
    delete payload[largestKey];
    dropped.push({ key: largestKey, reason: 'payload_budget_dropped', bytes: largestSize });
  }
  return payload;
}

/**
 * Build a payload that satisfies the TelemetryEvent contract.
 *
 * @param {Record<string, unknown>} source
 * @param {{ maxPayloadBytes?: number, maxKeys?: number }} [options]
 * @returns {{ payload: Record<string, unknown>, dropped: Array<{key: string, reason: string}> }}
 */
export function normalizePayload(source, { maxPayloadBytes = MAX_PAYLOAD_BYTES, maxKeys = MAX_PAYLOAD_KEYS } = {}) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_RECORD, 'payload source must be a plain object');
  }

  const dropped = [];
  const payload = {};
  let keyCount = 0;

  for (const key of Object.keys(source)) {
    if (!PAYLOAD_KEY_PATTERN.test(key)) {
      throw new WindowsCollectorError(
        WINDOWS_ERROR_CODES.INVALID_RECORD,
        `payload key "${key}" violates the contract pattern ${PAYLOAD_KEY_PATTERN.source}; use snake_case`,
        { details: { key } },
      );
    }
    if (keyCount >= maxKeys) {
      dropped.push({ key, reason: 'too_many_keys' });
      continue;
    }
    const value = normalizeValue(source[key], key, dropped);
    if (value === undefined) {
      continue;
    }
    payload[key] = value;
    keyCount += 1;
  }

  return {
    payload: enforceByteBudget(payload, dropped, maxPayloadBytes),
    dropped: Object.freeze(dropped.map((entry) => Object.freeze(entry))),
  };
}

/** Convenience wrapper for sources that treat a dropped value as a defect worth surfacing. */
export function buildPayload(source, options) {
  const { payload, dropped } = normalizePayload(source, options);
  return Object.freeze({ payload: Object.freeze(payload), dropped });
}
