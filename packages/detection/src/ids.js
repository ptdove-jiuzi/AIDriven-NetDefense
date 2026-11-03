/**
 * ids.js — the only place in the package that is allowed to create randomness.
 *
 * Alert, detection and analysis-request identifiers must be opaque and
 * non-enumerable, so they can never be derived from content. That rules out the
 * old `shortHash` identifiers: a content derived id repeats across runs and
 * leaks the fingerprint/window it was built from.
 *
 * Replays therefore have to inject a deterministic factory instead of relying on
 * content derived ids: `createSequenceIdFactory()` produces the same canonical
 * UUIDv4 sequence on every construction, so byte identical replays keep working
 * while production ids stay random.
 */

import { randomUUID } from 'node:crypto';
import { DetectionConfigError } from './errors.js';

/** Identifier kinds this package mints. @type {readonly string[]} */
export const ID_KINDS = Object.freeze(['detection', 'alert', 'analysis-request']);

/**
 * Brand every factory carries. It is deliberately **not** exported from the
 * package entry point: callers must obtain a factory from one of the three
 * constructors below, and the engine uses the brand to reject hand rolled
 * `{ next() {} }` objects that would bypass validation.
 */
export const ID_FACTORY_BRAND = Symbol('aegisharness.detection.idFactory');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_SEQUENCE = 0xffffffff;
const FACTORY_THREW = 'id factory threw during construction probe';
const FACTORY_THREW_AT_CALL = 'id factory threw while minting an id';
const INVALID_FACTORY = 'id factory must return a canonical UUIDv4';

/**
 * Report whether a value is a canonical lowercase UUIDv4.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} `true` when the value matches the canonical UUIDv4 form.
 */
export function isUuidV4(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function assertKind(kind) {
  if (!ID_KINDS.includes(kind)) {
    throw new DetectionConfigError(`unknown id kind: ${String(kind)}`, {
      path: 'ids',
      detail: { allowed: [...ID_KINDS] },
    });
  }
}

function invalidFactory(message) {
  return new DetectionConfigError(message, { path: 'ids' });
}

function branded(next) {
  return Object.freeze({ next, [ID_FACTORY_BRAND]: true });
}

/**
 * Build a factory backed by the platform CSPRNG.
 *
 * @returns {{ next: (kind: string) => string }} Frozen id factory.
 */
export function createRandomIdFactory() {
  return branded((kind) => {
    assertKind(kind);
    return randomUUID();
  });
}

/**
 * Build a replayable factory: the n-th id is `hex8(n)-0000-4000-8000-000000000000`.
 *
 * The counter occupies the first field, the version nibble is fixed to 4 and the
 * variant nibble to 8, so every value is a canonical UUIDv4 that differs from
 * the others. Exhausting the 32-bit range raises instead of wrapping: a repeat
 * would silently break alert idempotency.
 *
 * @param {number} [start] First counter value, `1..0xffffffff`.
 * @returns {{ next: (kind: string) => string }} Frozen id factory.
 * @throws {DetectionConfigError} When `start` is out of range.
 */
export function createSequenceIdFactory(start = 1) {
  if (!Number.isInteger(start) || start < 1 || start > MAX_SEQUENCE) {
    throw new DetectionConfigError(`sequence id factory start must be an integer in 1..${MAX_SEQUENCE}`, {
      path: 'ids',
      detail: { start },
    });
  }
  let counter = start;
  return branded((kind) => {
    assertKind(kind);
    if (counter > MAX_SEQUENCE) {
      throw new DetectionConfigError('sequence id factory is exhausted', { path: 'ids' });
    }
    const value = `${counter.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    counter += 1;
    return value;
  });
}

/**
 * Build a factory around a caller supplied generator.
 *
 * The generator is probed once at construction time, so a broken id source fails
 * at wiring time instead of halfway through an ingest batch. The probe asks for
 * `ID_KINDS[0]` — a real kind, so generators that validate the kind themselves
 * are not rejected for seeing a made up one. The cost is that construction
 * consumes one value: a stateful generator's first live id is its second value.
 *
 * @param {(kind: string) => unknown} generate Generator receiving the requested kind.
 * @returns {{ next: (kind: string) => string }} Frozen id factory.
 * @throws {DetectionConfigError} When the generator throws, or returns a non UUIDv4.
 */
export function createCustomIdFactory(generate) {
  if (typeof generate !== 'function') {
    throw invalidFactory('id factory must be a function receiving the id kind');
  }
  let probe;
  try {
    probe = generate(ID_KINDS[0]);
  } catch (error) {
    throw new DetectionConfigError(FACTORY_THREW, {
      path: 'ids',
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!isUuidV4(probe)) {
    throw invalidFactory(INVALID_FACTORY);
  }
  return branded((kind) => {
    assertKind(kind);
    let value;
    try {
      value = generate(kind);
    } catch (error) {
      // 调用期抛错必须与"返回值不合法"区分：前者是生成器坏了，后者是生成器
      // 交出了不合规的值，排障方向完全不同（审查 P2-R2-3）。
      throw new DetectionConfigError(FACTORY_THREW_AT_CALL, {
        path: 'ids',
        detail: { kind, message: error instanceof Error ? error.message : String(error) },
      });
    }
    if (!isUuidV4(value)) {
      throw new DetectionConfigError(INVALID_FACTORY, { path: 'ids', detail: { kind } });
    }
    return value;
  });
}
