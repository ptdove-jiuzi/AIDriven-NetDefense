/**
 * Admission rate limiting (§5.2): 100 events/s per source, 1,000 events/s globally.
 *
 * Token bucket with lazy refill: each bucket holds at most `rate` tokens and refills at
 * `rate / 1000` tokens per millisecond. The clock is injected, so the limiter is pure
 * logic and never sleeps. A backwards clock adds no tokens instead of refunding them.
 */

import {
  CollectorError,
  ERROR_CODES,
  assertInteger,
  assertNonEmptyString,
  assertTimestamp,
} from './errors.js';
import { LIMITS } from './limits.js';

function refill(bucket, nowMs, rate) {
  if (nowMs <= bucket.updatedAt) {
    return bucket.tokens;
  }
  const elapsedMs = nowMs - bucket.updatedAt;
  const refilled = bucket.tokens + (elapsedMs * rate) / 1_000;
  bucket.tokens = Math.min(rate, refilled);
  bucket.updatedAt = nowMs;
  return bucket.tokens;
}

function retryAfterMs(bucket, rate) {
  const deficit = 1 - bucket.tokens;
  return deficit <= 0 ? 0 : Math.ceil((deficit * 1_000) / rate);
}

export function createRateLimiter({
  perSourcePerSecond = LIMITS.perSourceEventsPerSecond,
  globalPerSecond = LIMITS.globalEventsPerSecond,
  clock = Date.now,
} = {}) {
  assertInteger('perSourcePerSecond', perSourcePerSecond, { min: 1 });
  assertInteger('globalPerSecond', globalPerSecond, { min: 1 });
  if (typeof clock !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'clock must be a function returning epoch milliseconds');
  }

  const startMs = Math.trunc(assertTimestamp('rate limiter clock', clock()));
  const globalBucket = { tokens: globalPerSecond, updatedAt: startMs };
  /** @type {Map<string, { tokens: number, updatedAt: number }>} */
  const sourceBuckets = new Map();

  function bucketFor(sourceId, nowMs) {
    let bucket = sourceBuckets.get(sourceId);
    if (bucket === undefined) {
      bucket = { tokens: perSourcePerSecond, updatedAt: nowMs };
      sourceBuckets.set(sourceId, bucket);
    }
    return bucket;
  }

  return Object.freeze({
    tryAcquire({ sourceId, at = undefined } = {}) {
      assertNonEmptyString('sourceId', sourceId);
      const nowMs = at === undefined || at === null
        ? Math.trunc(assertTimestamp('rate limiter clock', clock()))
        : Math.trunc(assertTimestamp('tryAcquire at', at));

      const sourceBucket = bucketFor(sourceId, nowMs);
      refill(globalBucket, nowMs, globalPerSecond);
      refill(sourceBucket, nowMs, perSourcePerSecond);

      if (sourceBucket.tokens < 1) {
        return Object.freeze({ allowed: false, scope: 'source', retryAfterMs: retryAfterMs(sourceBucket, perSourcePerSecond) });
      }
      if (globalBucket.tokens < 1) {
        return Object.freeze({ allowed: false, scope: 'global', retryAfterMs: retryAfterMs(globalBucket, globalPerSecond) });
      }

      sourceBucket.tokens -= 1;
      globalBucket.tokens -= 1;
      return Object.freeze({ allowed: true });
    },

    stats() {
      return Object.freeze({
        sourceCount: sourceBuckets.size,
        globalTokens: Math.floor(globalBucket.tokens),
        globalPerSecond,
        perSourcePerSecond,
      });
    },
  });
}
