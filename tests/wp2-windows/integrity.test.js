/**
 * A2-SHAPE §1/§3: the normalized event envelope and its `integrity` digest.
 *
 * The contract requires `integrity = {algorithm:'sha256', digest: canonicalDigest(payload)}`
 * and the store column is `integrity_digest TEXT NOT NULL`; the factory used to write
 * `integrity: null`, so a real host had every event rejected with `ERR_NULL_NOT_ALLOWED`
 * (COLLECTOR-LIVE §4 CL-4, 8 082 rejections in ten minutes).
 *
 * The collector packages do not depend on `@aegisharness/contracts`, so the digest is
 * implemented twice. These tests are the guard that the two implementations agree
 * **byte for byte** — a drift here would reject every event with
 * `ERR_INTEGRITY_DIGEST_MISMATCH` instead.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_MAX_DEPTH,
  canonicalDigest,
  canonicalPayloadText,
  createEventFactory,
  payloadIntegrity,
} from '../../packages/collectors/common/index.js';
import {
  LIMITS,
  canonicalDigest as contractDigest,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';

const BASE = 1_700_000_000_000;
const SOURCE_ID = 'windows.process-table';
const INSTANCE_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function makeFactory(overrides = {}) {
  return createEventFactory({
    clock: () => BASE,
    idFactory: () => '5f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    bootId: '0123456789abcdef0123456789abcdef',
    ...overrides,
  });
}

function makeEvent(overrides = {}) {
  return makeFactory().create({
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    generation: 0,
    sequence: 1,
    type: 'windows.process',
    severity: 'info',
    payload: { process_name: 'demo.exe', pid: 4242 },
    observedAt: BASE,
    ...overrides,
  });
}

test('the canonical encoder agrees with the contracts implementation', () => {
  assert.equal(CANONICAL_MAX_DEPTH, LIMITS.maxDepth, 'the depth bound must not drift');
  const cases = [
    {},
    { a: 1, b: 'x' },
    { pid: 4242, image_path: 'C:\\Windows\\System32\\svchost.exe', present: true },
    { zh: '进程表', emoji: '🙂', array: [1, 2, 3] },
    { nested: { z: 1, a: [{ y: 2, x: 3 }] } },
    { 'k': 'tab\there\nnewline\rreturn' },
    { negative: -17, zero: 0, big: Number.MAX_SAFE_INTEGER },
    { quotes: 'a "quoted" \\ path' },
  ];
  for (const value of cases) {
    assert.equal(canonicalDigest(value), contractDigest(value), `digest for ${JSON.stringify(value)}`);
  }
});

test('the digest is UTF-8 based and stable across key order', () => {
  assert.equal(canonicalDigest({ a: 1, b: 2 }), canonicalDigest({ b: 2, a: 1 }));
  assert.notEqual(canonicalDigest({ a: 1 }), canonicalDigest({ a: 2 }));
  assert.match(canonicalDigest({}), /^[0-9a-f]{64}$/u);
});

test('the event factory always writes a matching integrity member', () => {
  const event = makeEvent();
  assert.equal(event.integrity.algorithm, 'sha256');
  assert.equal(event.integrity.digest, canonicalDigest(event.payload));
  // The whole point: an event the factory produced must pass the real contract.
  assert.doesNotThrow(() => validateTelemetryEvent(event));
});

test('a caller-supplied integrity is verified, never trusted', () => {
  const factory = makeFactory();
  const base = {
    stableSourceId: SOURCE_ID,
    collectorInstanceId: INSTANCE_ID,
    generation: 0,
    sequence: 1,
    type: 'windows.process',
    payload: { pid: 1 },
  };
  const good = payloadIntegrity(base.payload);
  assert.equal(factory.create({ ...base, integrity: good }).integrity.digest, good.digest);

  assert.throws(
    () => factory.create({ ...base, integrity: { algorithm: 'sha256', digest: 'f'.repeat(64) } }),
    (error) => error.code === 'INVALID_RECORD',
  );
  assert.throws(
    () => factory.create({ ...base, integrity: { algorithm: 'md5', digest: good.digest } }),
    (error) => error.code === 'INVALID_RECORD',
  );
});

test('a record without a native id omits the field instead of writing null', () => {
  // `native_record_id` is optional but NOT nullable in the contract (schema.js:142), so an
  // explicit null is rejected with ERR_NULL_NOT_ALLOWED.
  const event = makeEvent();
  assert.equal('native_record_id' in event, false);
  assert.doesNotThrow(() => validateTelemetryEvent(event));

  const withId = makeEvent({ nativeRecordId: 4624 });
  assert.equal(withId.native_record_id, '4624');
  assert.doesNotThrow(() => validateTelemetryEvent(withId));
});

test('the payload encoding rejects what cannot be canonicalized unambiguously', () => {
  assert.throws(() => canonicalPayloadText({ accessor: Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 }) }),
    (error) => error.code === 'INVALID_RECORD');
  const symbolized = {};
  Object.defineProperty(symbolized, Symbol('hidden'), { value: 1, enumerable: true });
  assert.throws(() => canonicalPayloadText(symbolized), (error) => error.code === 'INVALID_RECORD');
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => canonicalPayloadText({ list: [1, , 3] }), (error) => error.code === 'INVALID_RECORD');
  assert.throws(() => canonicalPayloadText({ n: Number.NaN }), (error) => error.code === 'INVALID_RECORD');
  assert.throws(() => canonicalPayloadText({ n: Number.MAX_SAFE_INTEGER + 2 }), (error) => error.code === 'INVALID_RECORD');
  assert.throws(() => canonicalPayloadText({ s: '\uD800' }), (error) => error.code === 'INVALID_RECORD');
});

test('integrity cannot be computed over a non-object payload', () => {
  assert.throws(() => payloadIntegrity([]), (error) => error.code === 'INVALID_RECORD');
  assert.throws(() => payloadIntegrity('x'), (error) => error.code === 'INVALID_RECORD');
});
