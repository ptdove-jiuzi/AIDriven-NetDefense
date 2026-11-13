/**
 * Normalized telemetry event construction (§4.2).
 *
 * Field names are snake_case to match the TelemetryEvent contract, which is a closed
 * object: an unexpected field would make the whole event invalid downstream. That is why
 * the stable key is NOT part of the envelope even though it is the dedupe identity; it is
 * returned by `source-collector.publish()` as `items[].stableKey` and can always be
 * recomputed with `buildStableKey`.
 *
 * Size enforcement is deliberately not done here: the source collector applies
 * `maxEventBytes` so the same event object is still available to the gap ledger.
 *
 * `integrity` is part of the envelope and is computed **here, once** (A2-SHAPE §3):
 * `{algorithm:'sha256', digest: canonicalDigest(payload)}`. A caller may still pass a
 * value, but it is only accepted when it equals the recomputed digest — a second
 * implementation of the digest would otherwise drift and the store would reject every
 * event with `ERR_INTEGRITY_DIGEST_MISMATCH`.
 */

import { randomUUID as createUuid } from 'node:crypto';
import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertNonEmptyString,
  assertTimestamp,
  isPlainObject,
  toIsoTimestamp,
} from './errors.js';
import { assertCollectorInstanceId, assertStableSourceId } from './ids.js';
import { payloadIntegrity } from './integrity.js';

export const EVENT_SCHEMA_VERSION = '1.0';

export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

const SEVERITY_SET = new Set(SEVERITIES);
const HIGH_PRIORITY_SEVERITIES = new Set(['high', 'critical']);

export function normalizeSeverity(value) {
  if (value === undefined || value === null) {
    return 'info';
  }
  if (typeof value !== 'string' || !SEVERITY_SET.has(value)) {
    throw new CollectorError(
      ERROR_CODES.INVALID_RECORD,
      `Unknown severity: ${String(value)}`,
      { value: typeof value === 'string' ? value : null },
    );
  }
  return value;
}

export function priorityOfEvent(event) {
  const severity = event === null || typeof event !== 'object' ? null : event.severity;
  return HIGH_PRIORITY_SEVERITIES.has(severity) ? 'high' : 'normal';
}

export function measureEventBytes(event) {
  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch (error) {
    // Circular references and BigInt payloads throw a bare TypeError from JSON; the
    // collector needs a typed error it can attribute to the record, not to itself.
    throw new CollectorError(
      ERROR_CODES.INVALID_RECORD,
      `event must be JSON serializable: ${error.message}`,
      { reason: error.name },
    );
  }
  if (typeof serialized !== 'string') {
    throw new CollectorError(ERROR_CODES.INVALID_RECORD, 'event must be JSON serializable');
  }
  return Buffer.byteLength(serialized, 'utf8');
}

/**
 * Compute (or verify) the `integrity` member of the envelope.
 *
 * @param {unknown} provided Caller-supplied integrity, if any.
 * @param {object} payload Normalized payload.
 * @returns {{algorithm: string, digest: string}} Integrity object.
 * @throws {CollectorError} `INVALID_RECORD` when a supplied value disagrees with the payload.
 */
function resolveIntegrity(provided, payload) {
  const computed = payloadIntegrity(payload);
  if (provided === undefined || provided === null) {
    return computed;
  }
  if (!isPlainObject(provided)
    || provided.algorithm !== computed.algorithm
    || provided.digest !== computed.digest) {
    throw new CollectorError(
      ERROR_CODES.INVALID_RECORD,
      'integrity must be null/undefined or equal { algorithm: "sha256", digest: canonicalDigest(payload) }',
      {
        expected: computed.digest,
        received: isPlainObject(provided) && typeof provided.digest === 'string' ? provided.digest.slice(0, 128) : null,
      },
    );
  }
  return computed;
}

export function createEventFactory({
  clock = Date.now,
  idFactory = createUuid,
  bootId = null,
} = {}) {
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }
  if (typeof idFactory !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'idFactory must be a function returning an id');
  }
  if (bootId !== null && (typeof bootId !== 'string' || bootId.length === 0)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'bootId must be null or a non-empty string');
  }

  return Object.freeze({
    create(record = {}) {
      if (!isPlainObject(record)) {
        throw new CollectorError(ERROR_CODES.INVALID_RECORD, 'record must be a plain object');
      }

      const stableSourceId = assertStableSourceId(record.stableSourceId);
      const collectorInstanceId = assertCollectorInstanceId(record.collectorInstanceId);
      const generation = assertInteger('generation', record.generation, { min: 0 });
      const sequence = assertInteger('sequence', record.sequence, { min: 0 });
      const type = assertNonEmptyString('type', record.type);
      const severity = normalizeSeverity(record.severity);
      const payload = record.payload === undefined ? {} : record.payload;
      if (!isPlainObject(payload)) {
        throw new CollectorError(ERROR_CODES.INVALID_RECORD, 'payload must be a plain object');
      }

      const nativeRecordId = record.nativeRecordId === undefined || record.nativeRecordId === null
        ? null
        : String(record.nativeRecordId);
      // A2-SHAPE §1/§3: `integrity` is required by the contract *and* NOT NULL in
      // `telemetry_event.integrity_digest`, so it is always computed, never omitted.
      const integrity = resolveIntegrity(record.integrity, payload);
      const observedAtMs = record.observedAt === undefined || record.observedAt === null
        ? clock()
        : assertTimestamp('observedAt', record.observedAt);
      const receivedAtMs = Math.trunc(clock());
      const eventId = idFactory();
      assertNonEmptyString('event_id', eventId);

      const envelope = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        event_id: eventId,
        stable_source_id: stableSourceId,
        collector_instance_id: collectorInstanceId,
        source_generation: generation,
        boot_id: bootId,
        // `native_record_id` is optional but *not nullable* in the contract
        // (`schema.js:142` rejects an explicit null with ERR_NULL_NOT_ALLOWED). A source
        // without a native id must therefore omit the key instead of emitting null; the
        // store's column stays NULL and the stable key already uses `source_seq`.
        ...(nativeRecordId === null ? {} : { native_record_id: nativeRecordId }),
        source_seq: sequence,
        observed_at: toIsoTimestamp(observedAtMs),
        received_at: toIsoTimestamp(receivedAtMs),
        type,
        severity,
        payload,
        integrity,
      };
      return Object.freeze(envelope);
    },
  });
}
