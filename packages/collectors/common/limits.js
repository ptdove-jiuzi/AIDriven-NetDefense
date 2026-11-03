/**
 * Hard limits from the design (§5.1, §5.2). Every module takes a limits object so
 * tests and future adapters can shrink the bounds without touching this table.
 */

import { CollectorError, ERROR_CODES, isPlainObject } from './errors.js';

export const LIMITS = Object.freeze({
  queueMaxEvents: 100_000,
  queueMaxBytes: 256 * 1024 * 1024,
  queuePriorityReserveRatio: 0.1,
  maxEventBytes: 256 * 1024,
  perSourceEventsPerSecond: 100,
  globalEventsPerSecond: 1_000,
  dedupeMaxPerSource: 50_000,
  dedupeMaxGlobal: 200_000,
  dedupeTtlMs: 86_400_000,
  pollStaleCycles: 2,
  subscriptionProbeIntervalMs: 30_000,
  subscriptionStaleProbes: 2,
  gapMaxPerSource: 256,
  gapMaxTotal: 4_096,
  gapMergeWindowMs: 1_000,
  persistedKeyWindow: 2_048,
});

const KNOWN_KEYS = Object.freeze(Object.keys(LIMITS));
const RATIO_KEYS = Object.freeze(['queuePriorityReserveRatio']);

export function resolveLimits(overrides = {}) {
  if (!isPlainObject(overrides)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'limits overrides must be a plain object');
  }

  const resolved = { ...LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, `Unknown limit key: ${key}`, { key });
    }
    if (RATIO_KEYS.includes(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        throw new CollectorError(
          ERROR_CODES.INVALID_ARGUMENT,
          `${key} must be a finite ratio strictly between 0 and 1`,
          { key, value },
        );
      }
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new CollectorError(
        ERROR_CODES.INVALID_ARGUMENT,
        `${key} must be a positive integer`,
        { key, value },
      );
    }
    resolved[key] = value;
  }

  return Object.freeze(resolved);
}
