import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_CODES,
  LIMITS,
  advanceGeneration,
  createEventFactory,
  createGenerationState,
  evaluateSourceIdentity,
  normalizeSeverity,
  resolveLimits,
} from '../../packages/collectors/common/index.js';

const SOURCE_ID = 'windows.security-log';
const INSTANCE_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BASE = 1_700_000_000_000;

function rejectsWithCode(code) {
  return (error) => error.name === 'CollectorError' && error.code === code;
}

test('resolveLimits only accepts known keys with sane values and returns a frozen copy', () => {
  const resolved = resolveLimits({ queueMaxEvents: 10, queuePriorityReserveRatio: 0.2 });

  assert.equal(resolved.queueMaxEvents, 10);
  assert.equal(resolved.queuePriorityReserveRatio, 0.2);
  assert.equal(resolved.queueMaxBytes, LIMITS.queueMaxBytes);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(LIMITS.queueMaxEvents, 100_000, 'the shared limit table is never mutated');
  assert.notEqual(resolved, LIMITS);

  assert.throws(() => resolveLimits({ unknownLimit: 1 }), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(
    () => resolveLimits({ queuePriorityReserveRatio: 1 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(
    () => resolveLimits({ queuePriorityReserveRatio: 0 }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
  assert.throws(() => resolveLimits({ dedupeTtlMs: 1.5 }), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => resolveLimits({ gapMaxTotal: 0 }), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => resolveLimits(null), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
});

test('source identity changes map to initial, continue or a generation advance', () => {
  assert.deepEqual(
    evaluateSourceIdentity({ previous: null, current: { fileId: 'file-a', size: 100 } }),
    { action: 'initial', reason: 'initial' },
  );
  assert.deepEqual(
    evaluateSourceIdentity({ previous: { fileId: 'file-a', size: 100 }, current: { fileId: 'file-a', size: 100 } }),
    { action: 'continue', reason: null },
  );
  assert.deepEqual(
    evaluateSourceIdentity({ previous: { fileId: 'file-a', size: 100 }, current: { fileId: 'file-a', size: 101 } }),
    { action: 'continue', reason: null },
  );
  assert.deepEqual(
    evaluateSourceIdentity({ previous: { fileId: 'file-a', size: 100 }, current: { fileId: 'file-b', size: 100 } }),
    { action: 'advance_generation', reason: 'log_rotated' },
  );
  assert.deepEqual(
    evaluateSourceIdentity({ previous: { fileId: 'file-a', size: 100 }, current: { fileId: 'file-a', size: 40 } }),
    { action: 'advance_generation', reason: 'log_truncated' },
  );
});

test('a record id that moves backwards proves id reuse even when the file grew', () => {
  assert.deepEqual(
    evaluateSourceIdentity({
      previous: { fileId: 'file-a', size: 900, lastRecordId: 5_000 },
      current: { fileId: 'file-a', size: 1_200, firstRecordId: 1 },
    }),
    { action: 'advance_generation', reason: 'record_id_reuse' },
  );
  assert.deepEqual(
    evaluateSourceIdentity({
      previous: { fileId: 'file-a', size: 900, lastRecordId: 5_000 },
      current: { fileId: 'file-a', size: 1_200, firstRecordId: 5_001 },
    }),
    { action: 'continue', reason: null },
  );
  assert.deepEqual(
    evaluateSourceIdentity({
      previous: { fileId: 'file-a', size: 900, lastRecordId: 5_000 },
      current: { fileId: 'file-a', size: 1_200 },
    }),
    { action: 'continue', reason: null },
    'without a firstRecordId the check cannot run',
  );
  assert.deepEqual(
    evaluateSourceIdentity({
      previous: { fileId: 'file-a', size: 900, lastRecordId: 5_000 },
      current: { fileId: 'file-b', size: 1_200, firstRecordId: 1 },
    }),
    { action: 'advance_generation', reason: 'log_rotated' },
    'rotation is reported before id reuse',
  );
  assert.throws(
    () => evaluateSourceIdentity({
      previous: { fileId: 'file-a', size: 900, lastRecordId: -1 },
      current: { fileId: 'file-a', size: 1_200 },
    }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('advancing a generation resets sequence and cursor', () => {
  const state = createGenerationState({ generation: 3, sequence: 9, cursor: 'cursor-9' });
  assert.deepEqual(state, { generation: 3, sequence: 9, cursor: 'cursor-9' });
  assert.equal(Object.isFrozen(state), true);

  const advanced = advanceGeneration(state, { reason: 'record_id_reuse' });
  assert.deepEqual(advanced, { generation: 4, sequence: -1, cursor: null, reason: 'record_id_reuse' });
  assert.throws(
    () => advanceGeneration(state, { reason: 'not_a_reason' }),
    rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT),
  );
});

test('severity defaults to info and rejects unknown values', () => {
  assert.equal(normalizeSeverity(undefined), 'info');
  assert.equal(normalizeSeverity(null), 'info');
  assert.equal(normalizeSeverity('critical'), 'critical');
  assert.equal(normalizeSeverity('low'), 'low');
  assert.throws(() => normalizeSeverity('urgent'), rejectsWithCode(ERROR_CODES.INVALID_RECORD));
});

test('the event factory emits exactly the TelemetryEvent fields in snake_case', () => {
  const factory = createEventFactory({
    clock: () => BASE + 5,
    idFactory: () => 'event-id-1',
    bootId: 'boot-1',
  });

  const event = factory.create({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    generation: 0,
    sequence: 7,
    nativeRecordId: 4624,
    observedAt: BASE,
    type: 'logon',
    severity: 'high',
    payload: { user: 'synthetic' },
  });

  assert.deepEqual(Object.keys(event), [
    'schemaVersion',
    'event_id',
    'stable_source_id',
    'collector_instance_id',
    'source_generation',
    'boot_id',
    'native_record_id',
    'source_seq',
    'observed_at',
    'received_at',
    'type',
    'severity',
    'payload',
    'integrity',
  ]);
  assert.equal(event.schemaVersion, '1.0');
  assert.equal(event.event_id, 'event-id-1');
  assert.equal(event.stable_source_id, SOURCE_ID);
  assert.equal(event.collector_instance_id, INSTANCE_ID);
  assert.equal(event.source_generation, 0);
  assert.equal(event.boot_id, 'boot-1');
  assert.equal(event.native_record_id, '4624');
  assert.equal(event.source_seq, 7);
  assert.equal(event.observed_at, '2023-11-14T22:13:20.000Z');
  assert.equal(event.received_at, '2023-11-14T22:13:20.005Z');
  assert.equal(event.type, 'logon');
  assert.equal(event.severity, 'high');
  assert.deepEqual(event.payload, { user: 'synthetic' });
  // A2-SHAPE §1/§3: `integrity` is a required envelope member, computed once by the
  // factory as {algorithm:'sha256', digest: canonicalDigest(payload)}. It used to be
  // `null`, which the TelemetryEvent contract and the store (integrity_digest NOT NULL)
  // both reject — every real event was refused with ERR_NULL_NOT_ALLOWED (CL-4).
  assert.equal(event.integrity.algorithm, 'sha256');
  assert.match(event.integrity.digest, /^[0-9a-f]{64}$/u);
  // The stable key is the dedupe identity, not an envelope field: the closed
  // TelemetryEvent contract rejects unknown fields.
  assert.equal('stable_key' in event, false);
  assert.equal(Object.isFrozen(event), true);

  const sequenceEvent = factory.create({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    generation: 1,
    sequence: 0,
    type: 'process_start',
  });
  // `native_record_id` is optional but not nullable in the contract (schema.js:142), so a
  // record without a native id omits the key instead of emitting null.
  assert.equal('native_record_id' in sequenceEvent, false);
  assert.equal(sequenceEvent.severity, 'info');
  assert.deepEqual(sequenceEvent.payload, {});
});

test('the event factory rejects records outside the contract', () => {
  const factory = createEventFactory({ clock: () => BASE, idFactory: () => 'event-id-2' });

  const base = { stableSourceId: SOURCE_ID, collectorInstanceId: INSTANCE_ID, generation: 0, sequence: 0, type: 'x' };
  assert.throws(() => factory.create({ ...base, type: '' }), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => factory.create({ ...base, sequence: -1 }), rejectsWithCode(ERROR_CODES.INVALID_ARGUMENT));
  assert.throws(() => factory.create({ ...base, payload: [] }), rejectsWithCode(ERROR_CODES.INVALID_RECORD));
  assert.throws(() => factory.create({ ...base, severity: 'urgent' }), rejectsWithCode(ERROR_CODES.INVALID_RECORD));
  assert.throws(
    () => factory.create({ ...base, stableSourceId: 'NotStable' }),
    rejectsWithCode(ERROR_CODES.INVALID_SOURCE_ID),
  );
});
