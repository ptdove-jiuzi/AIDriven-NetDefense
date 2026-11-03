/**
 * Stable source identity and stable event keys (§5.2).
 *
 * `stable_source_id` identifies the logical source (channel, log, path family).
 * `collector_instance_id` identifies one collector process and is diagnostic only:
 * it must never appear inside a stable key, otherwise a restart would duplicate events.
 */

import { randomUUID as createUuid } from 'node:crypto';
import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  toIsoTimestamp,
} from './errors.js';

export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){1,4}$/;
export const MAX_SOURCE_ID_LENGTH = 96;
export const MAX_NATIVE_RECORD_ID_LENGTH = 256;

const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_KEY_PATTERN = /^(?<source>[^#]+)#g(?<generation>\d{1,16}):(?<kind>[ns])(?<value>.+)$/;

export function isValidStableSourceId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SOURCE_ID_LENGTH
    && SOURCE_ID_PATTERN.test(value);
}

export function assertStableSourceId(value) {
  if (!isValidStableSourceId(value)) {
    throw new CollectorError(
      ERROR_CODES.INVALID_SOURCE_ID,
      'stable source id must be lowercase dot-separated segments such as windows.security-log or linux.journald',
      { value: typeof value === 'string' ? value : null },
    );
  }
  return value;
}

export function createCollectorInstanceId(randomUuid = createUuid) {
  if (typeof randomUuid !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'random UUID factory must be a function');
  }
  const value = randomUuid();
  return assertCollectorInstanceId(value);
}

export function assertCollectorInstanceId(value) {
  if (typeof value !== 'string' || !INSTANCE_ID_PATTERN.test(value)) {
    throw new CollectorError(
      ERROR_CODES.INVALID_INSTANCE_ID,
      'collector instance id must be a UUID v4 string',
      { value: typeof value === 'string' ? value : null },
    );
  }
  return value;
}

function normalizeNativeRecordId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CollectorError(
        ERROR_CODES.INVALID_ARGUMENT,
        'nativeRecordId numbers must be non-negative safe integers',
        { value },
      );
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NATIVE_RECORD_ID_LENGTH) {
      throw new CollectorError(
        ERROR_CODES.INVALID_ARGUMENT,
        `nativeRecordId strings must be 1-${MAX_NATIVE_RECORD_ID_LENGTH} characters`,
        { value: trimmed },
      );
    }
    if (trimmed.includes('#') || trimmed.includes(':')) {
      throw new CollectorError(
        ERROR_CODES.INVALID_ARGUMENT,
        "nativeRecordId must not contain '#' or ':' because both delimit a stable key",
        { value: trimmed },
      );
    }
    // Surrounding whitespace is never part of an identity: 'abc ' and 'abc' must map to
    // the same stable key or a padding difference would duplicate every record.
    return trimmed;
  }
  throw new CollectorError(
    ERROR_CODES.INVALID_ARGUMENT,
    'nativeRecordId must be a string or a non-negative safe integer',
    { value: value === undefined ? null : String(value) },
  );
}

export function buildStableKey({
  stableSourceId,
  generation,
  nativeRecordId = null,
  sequence = null,
} = {}) {
  assertStableSourceId(stableSourceId);
  assertInteger('generation', generation, { min: 0 });

  if (nativeRecordId !== null && nativeRecordId !== undefined) {
    return `${stableSourceId}#g${generation}:n${normalizeNativeRecordId(nativeRecordId)}`;
  }

  assertInteger('sequence', sequence, { min: 0 });
  return `${stableSourceId}#g${generation}:s${sequence}`;
}

export function parseStableKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'stable key must be a non-empty string');
  }

  const match = STABLE_KEY_PATTERN.exec(key);
  if (match === null) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `Malformed stable key: ${key}`);
  }

  const { source, generation: generationText, kind, value } = match.groups;
  if (!isValidStableSourceId(source)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `Malformed stable key source id: ${source}`);
  }

  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `Malformed stable key generation: ${generationText}`);
  }

  if (kind === 'n') {
    return Object.freeze({ stableSourceId: source, generation, kind: 'native', value });
  }

  if (!/^\d{1,16}$/.test(value)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `Malformed stable key sequence: ${value}`);
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `Malformed stable key sequence: ${value}`);
  }
  return Object.freeze({ stableSourceId: source, generation, kind: 'sequence', value: sequence });
}

export function buildSourceIdentity({ stableSourceId, collectorInstanceId, startedAt } = {}) {
  assertStableSourceId(stableSourceId);
  assertCollectorInstanceId(collectorInstanceId);
  return Object.freeze({
    stableSourceId,
    collectorInstanceId,
    startedAt: toIsoTimestamp(startedAt),
  });
}
