/**
 * Collector error taxonomy shared by every platform-neutral collector module.
 *
 * All validation failures use `CollectorError` so adapters can classify a failure
 * (permission, persistence, staleness) without parsing messages.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_SOURCE_ID: 'INVALID_SOURCE_ID',
  INVALID_INSTANCE_ID: 'INVALID_INSTANCE_ID',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_RECORD: 'INVALID_RECORD',
  EVENT_TOO_LARGE: 'EVENT_TOO_LARGE',
  CURSOR_STORE_CORRUPT: 'CURSOR_STORE_CORRUPT',
  CURSOR_STORE_IO: 'CURSOR_STORE_IO',
  CURSOR_STORE_CONFLICT: 'CURSOR_STORE_CONFLICT',
  INVALID_GAP_REASON: 'INVALID_GAP_REASON',
  UNCOMMITTED_BATCH: 'UNCOMMITTED_BATCH',
  STALE_BATCH: 'STALE_BATCH',
  ADAPTER_DEGRADED: 'ADAPTER_DEGRADED',
  SOURCE_UNKNOWN: 'SOURCE_UNKNOWN',
  RUNTIME_CLOSED: 'RUNTIME_CLOSED',
});

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

export class CollectorError extends Error {
  code;

  details;

  constructor(code, message, details = undefined) {
    if (!KNOWN_CODES.has(code)) {
      throw new TypeError(`Unknown collector error code: ${String(code)}`);
    }
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.details = details;
  }
}

export function assertInteger(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a safe integer between ${min} and ${max}`,
      { name, value, min, max },
    );
  }
  return value;
}

export function assertTimestamp(name, value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  if (value instanceof Date) {
    const epochMs = value.getTime();
    if (Number.isSafeInteger(epochMs)) {
      return epochMs;
    }
  }
  if (typeof value === 'string' && value.length > 0) {
    const epochMs = Date.parse(value);
    if (Number.isSafeInteger(epochMs)) {
      return epochMs;
    }
  }
  throw new CollectorError(
    ERROR_CODES.INVALID_ARGUMENT,
    `${name} must be epoch milliseconds, a Date, or an ISO 8601 timestamp`,
    { name, value: value === undefined ? null : String(value) },
  );
}

export function toIsoTimestamp(epochMs) {
  return new Date(assertTimestamp('timestamp', epochMs)).toISOString();
}

export function assertNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a non-empty string`,
      { name, value: value === undefined ? null : String(value) },
    );
  }
  return value;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
