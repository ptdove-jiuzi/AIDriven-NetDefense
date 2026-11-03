/**
 * Thin multi-source orchestration (§5.1 single-source failure isolation).
 *
 * Each source owns its own capability state, so one degraded or unavailable source never
 * marks the others as unhealthy; the runtime only aggregates the per-source view.
 *
 * A single rate limiter is shared by every source by default, which is what makes the
 * global 1,000 events/s bound meaningful. Pass an explicit `rateLimiter` to share it with
 * other runtimes, or `null` to run without admission limiting.
 */

import { createCapability } from './capability.js';
import { CollectorError, ERROR_CODES, isPlainObject } from './errors.js';
import { assertStableSourceId, createCollectorInstanceId } from './ids.js';
import { LIMITS } from './limits.js';
import { createRateLimiter } from './rate-limiter.js';
import { createSourceCollector } from './source-collector.js';

const DEGRADED_LIFECYCLES = new Set(['degraded', 'unavailable']);

export function createCollectorRuntime({
  store,
  queue = null,
  dedupe = null,
  gaps = null,
  rateLimiter = undefined,
  clock = Date.now,
  limits = LIMITS,
  bootId = null,
} = {}) {
  if (!store || typeof store.load !== 'function') {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'a cursor store is required');
  }
  if (!isPlainObject(limits)) {
    throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'limits must be an object');
  }

  const limiter = rateLimiter === undefined
    ? createRateLimiter({
      perSourcePerSecond: limits.perSourceEventsPerSecond ?? LIMITS.perSourceEventsPerSecond,
      globalPerSecond: limits.globalEventsPerSecond ?? LIMITS.globalEventsPerSecond,
      clock,
    })
    : rateLimiter;

  /** @type {Map<string, ReturnType<typeof createSourceCollector>>} */
  const collectors = new Map();
  /** @type {Map<string, ReturnType<typeof createCapability>>} */
  const capabilities = new Map();

  return Object.freeze({
    addSource(sourceConfig) {
      if (!isPlainObject(sourceConfig)) {
        throw new CollectorError(ERROR_CODES.INVALID_ARGUMENT, 'source configuration must be a plain object');
      }
      const stableSourceId = assertStableSourceId(sourceConfig.stableSourceId);
      if (collectors.has(stableSourceId)) {
        throw new CollectorError(
          ERROR_CODES.INVALID_ARGUMENT,
          `Source ${stableSourceId} is already registered in this runtime`,
          { stableSourceId },
        );
      }

      const collectorInstanceId = createCollectorInstanceId();
      const capability = createCapability({
        stableSourceId,
        collectorInstanceId,
        kind: sourceConfig.kind ?? 'poll',
        intervalMs: sourceConfig.intervalMs ?? 5_000,
        subscriptionProbeIntervalMs: sourceConfig.subscriptionProbeIntervalMs ?? LIMITS.subscriptionProbeIntervalMs,
        clock,
      });
      const collector = createSourceCollector({
        source: sourceConfig,
        store,
        queue,
        dedupe,
        gaps,
        capability,
        rateLimiter: limiter,
        instanceId: collectorInstanceId,
        clock,
        bootId,
        limits,
      });

      collectors.set(stableSourceId, collector);
      capabilities.set(stableSourceId, capability);
      return collector;
    },

    get(stableSourceId) {
      return collectors.get(stableSourceId);
    },

    report(at = undefined) {
      const sources = [];
      const degraded = [];
      const stale = [];

      for (const [stableSourceId, collector] of collectors) {
        const snapshot = collector.snapshot(at);
        sources.push(snapshot);
        if (DEGRADED_LIFECYCLES.has(snapshot.lifecycle)) {
          degraded.push(stableSourceId);
        }
        if (snapshot.stale === true) {
          stale.push(stableSourceId);
        }
      }

      return Object.freeze({
        sources: Object.freeze(sources),
        degraded: Object.freeze(degraded),
        stale: Object.freeze(stale),
        queue: queue === null ? null : queue.stats(),
        dedupe: dedupe === null ? null : dedupe.stats(),
        gaps: gaps === null ? null : gaps.stats(),
      });
    },

    drainGaps() {
      return gaps === null ? [] : gaps.drain();
    },

    close() {
      for (const capability of capabilities.values()) {
        capability.markStopped();
      }
      return [...collectors.keys()];
    },
  });
}
