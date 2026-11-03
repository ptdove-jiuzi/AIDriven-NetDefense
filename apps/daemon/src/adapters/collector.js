/**
 * adapters/collector.js — the collector contract the scheduler drives.
 *
 * The platform collectors (`packages/collectors/windows`, `.../linux`) publish
 * normalized telemetry through their own `SourceCollector` pipeline. The daemon
 * must not embed, fork or re-implement that logic — it needs only a narrow
 * *pull* contract per source:
 *
 * ```js
 * {
 *   id: string,                        // stable_source_id, the logical source identity
 *   kind: string,                      // informational: 'process' | 'network' | ...
 *   intervalMs?: number,               // optional per-source cadence override
 *   poll(ctx) => { events, cursor?, gap? } | Promise<...>
 * }
 * ```
 *
 * `ctx` is `{ signal, cursor, nowMs, source_id, poll_index }`. `signal` aborts on
 * timeout or shutdown, and a source that ignores it is simply abandoned — the
 * scheduler never waits on a hung adapter forever.
 *
 * The daemon owns three things a source must not:
 * 1. **Scheduling** — the cadence, the no-overlap rule and the per-source timeout.
 * 2. **Durability** — the cursor is persisted by the daemon after a successful
 *    commit, not by the adapter.
 * 3. **Degradation** — a failing source is marked degraded and the others keep
 *    running (design §12: "单采集源失败 → 标降级/缺口，其他源继续").
 */

import { DaemonError, DAEMON_CODES } from '../errors.js';

/** Source kinds the first version declares (design §5.1). */
export const SOURCE_KINDS = Object.freeze([
  'process',
  'network',
  'file',
  'auth-log',
  'service',
  'persistence',
  'synthetic',
]);

const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Validate a collector source descriptor.
 *
 * @param {unknown} source Candidate.
 * @returns {{id: string, kind: string, intervalMs: number|null, poll: Function}} Frozen descriptor.
 * @throws {DaemonError} When the descriptor is unusable.
 */
export function assertSource(source) {
  if (source === null || typeof source !== 'object') {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'collector source must be an object');
  }
  if (typeof source.id !== 'string' || !SOURCE_ID.test(source.id)) {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'collector source id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,127}');
  }
  if (typeof source.kind !== 'string' || !SOURCE_KINDS.includes(source.kind)) {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, `collector source kind must be one of ${SOURCE_KINDS.join(', ')}`, {
      source_id: source.id,
    });
  }
  if (typeof source.poll !== 'function') {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'collector source must implement poll(ctx)', {
      source_id: source.id,
    });
  }
  let intervalMs = null;
  if (source.intervalMs !== undefined && source.intervalMs !== null) {
    if (!Number.isInteger(source.intervalMs) || source.intervalMs < 1) {
      throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'collector source intervalMs must be a positive integer', {
        source_id: source.id,
      });
    }
    intervalMs = source.intervalMs;
  }
  return Object.freeze({ id: source.id, kind: source.kind, intervalMs, poll: source.poll });
}

/**
 * Validate a source list: unique ids, bounded count.
 *
 * @param {readonly unknown[]} sources Candidate descriptors.
 * @param {number} maxSources Upper bound.
 * @returns {readonly object[]} Frozen descriptors.
 * @throws {DaemonError} When the list is malformed or has duplicate ids.
 */
export function assertSources(sources, maxSources) {
  if (!Array.isArray(sources)) {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'sources must be an array');
  }
  if (sources.length > maxSources) {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, `at most ${maxSources} collector sources are supported`, {
      count: sources.length,
    });
  }
  const seen = new Set();
  const normalized = [];
  for (const candidate of sources) {
    const source = assertSource(candidate);
    if (seen.has(source.id)) {
      throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'collector source ids must be unique', {
        source_id: source.id,
      });
    }
    seen.add(source.id);
    normalized.push(source);
  }
  return Object.freeze(normalized);
}

/**
 * Scripted source for mock mode and tests.
 *
 * Each step is one `poll()` result:
 *   `[...events]`            → emit those events
 *   `{error: 'CODE'}`        → throw a SOURCE_FAILED error
 *   `{hang: true}`           → return a promise that only settles on abort
 *   `{delayMs, events}`      → wait, then emit
 *   `'end'` / exhaustion     → emit nothing (source stays healthy but idle)
 *
 * The script is consumed once; re-polling after exhaustion returns an empty batch,
 * which is what a quiet source looks like.
 *
 * @param {{
 *   id: string,
 *   kind?: string,
 *   intervalMs?: number,
 *   script?: readonly unknown[]
 * }} options Options.
 * @returns {{id: string, kind: string, intervalMs: number|null, poll: Function, remaining: () => number}} Source.
 */
export function createScriptedSource(options) {
  if (typeof options.id !== 'string') {
    throw new DaemonError(DAEMON_CODES.SOURCE_INVALID, 'scripted source requires an id');
  }
  const script = [...(options.script ?? [])];
  let index = 0;
  return {
    id: options.id,
    kind: options.kind ?? 'synthetic',
    intervalMs: options.intervalMs ?? null,
    remaining: () => Math.max(0, script.length - index),
    async poll(ctx) {
      const step = script[index];
      index += 1;
      if (step === undefined) {
        return { events: [] };
      }
      if (Array.isArray(step)) {
        return { events: step, cursor: { index } };
      }
      if (step !== null && typeof step === 'object') {
        if (step.error !== undefined) {
          throw new DaemonError(DAEMON_CODES.SOURCE_FAILED, 'scripted source failure', {
            step: index,
            reason: String(step.error).slice(0, 64),
          });
        }
        if (step.hang === true) {
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new DaemonError(DAEMON_CODES.SOURCE_TIMEOUT, 'scripted source aborted'));
            if (ctx?.signal?.aborted === true) {
              abort();
              return;
            }
            ctx?.signal?.addEventListener?.('abort', abort, { once: true });
          });
        }
        if (typeof step.delayMs === 'number') {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, step.delayMs);
            ctx?.signal?.addEventListener?.('abort', () => {
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
        }
        if (step.events !== undefined) {
          return { events: step.events, cursor: step.cursor, gap: step.gap };
        }
      }
      return { events: [] };
    },
  };
}
