/**
 * Source generation handling (§5.2).
 *
 * A generation is bumped whenever the previous cursor stops being meaningful for the
 * current data set: log rotation, truncation, cleared log, reused record ids or a
 * recovered/rolled-back store. Keys from a superseded generation never collide with
 * keys from the new generation, so the same native id is legitimately a new event.
 */

import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  isPlainObject,
} from './errors.js';

export const GENERATION_REASONS = Object.freeze([
  'initial',
  'log_rotated',
  'log_truncated',
  'log_cleared',
  'record_id_reuse',
  'adapter_reset',
  'store_recovered',
]);

const GENERATION_REASON_SET = new Set(GENERATION_REASONS);

export function assertGenerationReason(reason) {
  if (!GENERATION_REASON_SET.has(reason)) {
    throw new CollectorError(
      ERROR_CODES.INVALID_ARGUMENT,
      `Unknown generation reason: ${String(reason)}`,
      { reason: typeof reason === 'string' ? reason : null },
    );
  }
  return reason;
}

function assertFileIdentity(name, value) {
  if (!isPlainObject(value)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `${name} must be an object with fileId and size`);
  }
  if (typeof value.fileId !== 'string' || value.fileId.length === 0) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `${name}.fileId must be a non-empty string`);
  }
  assertInteger(`${name}.size`, value.size, { min: 0 });
  return value;
}

function optionalRecordId(name, value) {
  if (value === undefined || value === null) {
    return null;
  }
  return assertInteger(name, value, { min: 0 });
}

export function evaluateSourceIdentity({ previous = null, current } = {}) {
  const next = assertFileIdentity('current', current);
  const nextFirstRecordId = optionalRecordId('current.firstRecordId', current.firstRecordId);

  if (previous === null || previous === undefined) {
    return Object.freeze({ action: 'initial', reason: 'initial' });
  }

  const prior = assertFileIdentity('previous', previous);
  const priorLastRecordId = optionalRecordId('previous.lastRecordId', previous.lastRecordId);

  if (prior.fileId !== next.fileId) {
    return Object.freeze({ action: 'advance_generation', reason: 'log_rotated' });
  }
  if (next.size < prior.size) {
    return Object.freeze({ action: 'advance_generation', reason: 'log_truncated' });
  }
  // A cleared log can restart record ids while the file keeps growing (same file id,
  // size >= previous). Seeing the id counter go backwards proves the ids were reused.
  if (priorLastRecordId !== null && nextFirstRecordId !== null && nextFirstRecordId <= priorLastRecordId) {
    return Object.freeze({ action: 'advance_generation', reason: 'record_id_reuse' });
  }
  return Object.freeze({ action: 'continue', reason: null });
}

export function createGenerationState({ generation = 0, sequence = -1, cursor = null } = {}) {
  assertInteger('generation', generation, { min: 0 });
  assertInteger('sequence', sequence, { min: -1 });
  return Object.freeze({ generation, sequence, cursor });
}

export function advanceGeneration(state, { reason, cursor = null } = {}) {
  assertGenerationReason(reason);
  const current = state ?? createGenerationState();
  assertInteger('generation', current.generation, { min: 0 });

  return Object.freeze({
    generation: current.generation + 1,
    sequence: -1,
    cursor,
    reason,
  });
}
