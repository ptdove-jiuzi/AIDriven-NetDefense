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
        : record.nativeRecordId;
      const observedAtMs = record.observedAt === undefined || record.observedAt === null
        ? clock()
        : assertTimestamp('observedAt', record.observedAt);
      const receivedAtMs = Math.trunc(clock());
      const eventId = idFactory();
      assertNonEmptyString('event_id', eventId);

      return Object.freeze({
        schemaVersion: EVENT_SCHEMA_VERSION,
        event_id: eventId,
        stable_source_id: stableSourceId,
        collector_instance_id: collectorInstanceId,
        source_generation: generation,
        boot_id: bootId,
        native_record_id: nativeRecordId === null ? null : String(nativeRecordId),
        source_seq: sequence,
        observed_at: toIsoTimestamp(observedAtMs),
        received_at: toIsoTimestamp(receivedAtMs),
        type,
        severity,
        payload,
        integrity: record.integrity === undefined ? null : record.integrity,
      });
    },
  });
}
