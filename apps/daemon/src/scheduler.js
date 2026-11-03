/**
 * scheduler.js — per-source collection cadence with independent degradation.
 *
 * Invariants:
 *
 * 1. **No overlap per source.** A source already polling is skipped, so a slow
 *    adapter cannot pile up concurrent reads of the same cursor.
 * 2. **Sources are independent.** One hung or failing source never delays another;
 *    each poll has its own timeout and its own abort controller.
 * 3. **A hung adapter is abandoned, not awaited.** On timeout the controller is
 *    aborted and the source is marked degraded. A poll that later resolves is
 *    ignored (`settled` guard), so a late batch cannot be written out of order.
 * 4. **Cursors only advance after a successful ingest.** A crash or a store error
 *    leaves the cursor where it was, which is what lets the adapter replay.
 * 5. **Staleness uses the monotonic clock.** A wall clock step must not make a
 *    dead source look fresh.
 * 6. **Batches are bounded.** A source returning more than `maxBatchEvents` has the
 *    surplus dropped and *counted*, never buffered without limit.
 */

import { DaemonError, DAEMON_CODES, isDaemonError } from './errors.js';
import { assertSources } from './adapters/collector.js';

const SOURCE_LIFECYCLES = Object.freeze(['idle', 'polling', 'ok', 'degraded', 'stopped']);

function sourceState(source, nowIso) {
  return {
    id: source.id,
    kind: source.kind,
    interval_ms: source.intervalMs,
    lifecycle: 'idle',
    polls: 0,
    events: 0,
    accepted: 0,
    failures: 0,
    consecutive_failures: 0,
    stale: false,
    cursor: null,
    generation: 0,
    sequence: 0,
    last_poll_at: null,
    last_success_at: null,
    last_event_at: null,
    last_error_code: null,
    last_error_at: null,
    dropped_events: 0,
  };
}

/**
 * Create the collection scheduler.
 *
 * @param {{
 *   sources: readonly object[],
 *   pipeline: {ingestBatch: (events: readonly object[], meta?: object) => object},
 *   clock: {nowMs: () => number, nowIso: () => string, monoMs: () => number},
 *   tickMs: number,
 *   sourceTimeoutMs: number,
 *   maxBatchEvents: number,
 *   staleAfterMs: number,
 *   maxSources?: number,
 *   cursors?: object,
 *   onCursor?: (sourceId: string, record: object) => void,
 *   logger?: object
 * }} options Options.
 * @returns {object} Scheduler handle.
 */
export function createScheduler(options) {
  const sources = assertSources(options.sources ?? [], options.maxSources ?? 32);
  const pipeline = options.pipeline;
  if (pipeline === null || typeof pipeline !== 'object' || typeof pipeline.ingestBatch !== 'function') {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'scheduler requires a pipeline with ingestBatch');
  }
  const clock = options.clock;
  const tickMs = options.tickMs;
  const sourceTimeoutMs = options.sourceTimeoutMs;
  const maxBatchEvents = options.maxBatchEvents;
  const staleAfterMs = options.staleAfterMs;
  const logger = options.logger ?? null;
  const onCursor = typeof options.onCursor === 'function' ? options.onCursor : null;

  const states = new Map();
  for (const source of sources) {
    const state = sourceState(source, clock.nowIso());
    const restored = options.cursors?.[source.id];
    if (restored !== undefined && restored !== null) {
      state.cursor = restored.cursor ?? null;
      state.generation = Number.isSafeInteger(restored.generation) ? restored.generation : 0;
      state.sequence = Number.isSafeInteger(restored.sequence) ? restored.sequence : 0;
      state.last_success_at = typeof restored.last_success_at === 'string' ? restored.last_success_at : null;
    }
    // `last_poll_mono` is deliberately not restored: staleness after a restart is
    // measured from this process's start, so a stopped daemon is never reported
    // "fresh" on the basis of a previous run. It is backdated by one interval so
    // the first scheduling pass polls immediately instead of waiting a full tick.
    state.last_poll_mono = clock.monoMs() - (source.intervalMs ?? tickMs);
    states.set(source.id, state);
  }

  /** @type {Map<string, {controller: AbortController, promise: Promise<void>, settled: boolean}>} */
  const inFlight = new Map();
  let interval = null;
  let started = false;
  let stopping = false;
  let startedAtMono = clock.monoMs();

  function markDegraded(state, code) {
    state.lifecycle = 'degraded';
    state.failures += 1;
    state.consecutive_failures += 1;
    state.last_error_code = code;
    state.last_error_at = clock.nowIso();
  }

  async function runPoll(source, state, controller) {
    state.lifecycle = 'polling';
    state.polls += 1;
    const entry = { controller, promise: null, settled: false };
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DaemonError(DAEMON_CODES.SOURCE_TIMEOUT, 'collector poll exceeded its time budget', {
          source_id: source.id,
          timeout_ms: sourceTimeoutMs,
        }));
      }, sourceTimeoutMs);
      timer.unref?.();
    });

    const promise = (async () => {
      try {
        const outcome = await Promise.race([
          Promise.resolve().then(() => source.poll({
            signal: controller.signal,
            cursor: state.cursor,
            nowMs: clock.nowMs(),
            source_id: source.id,
            poll_index: state.polls,
          })),
          timeout,
        ]);
        if (entry.settled || stopping) {
          // A poll that settles after `stop()` must not write: the pipeline and the
          // store may already be closing, and a late batch would be persisted out
          // of the shutdown order the daemon just committed to.
          return;
        }
        if (outcome === null || typeof outcome !== 'object' || !Array.isArray(outcome.events)) {
          throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'collector poll must return { events: [] }', {
            source_id: source.id,
          });
        }
        let events = outcome.events;
        if (events.length > maxBatchEvents) {
          state.dropped_events += events.length - maxBatchEvents;
          events = events.slice(0, maxBatchEvents);
          logger?.warn?.('collector batch truncated to the configured maximum', {
            source_id: source.id,
            dropped: state.dropped_events,
            max_batch_events: maxBatchEvents,
          });
        }
        const summary = events.length === 0 ? { accepted: 0, alerts: 0 } : pipeline.ingestBatch(events, {
          source_id: source.id,
        });
        if (Number(summary.store_errors ?? 0) > 0) {
          // The batch was not fully persisted, so advancing the cursor would skip
          // whatever failed. Treat it as a failed poll: the adapter replays from the
          // last committed position, and the store's own idempotency absorbs the
          // overlap.
          throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'batch was not fully persisted', {
            source_id: source.id,
            store_errors: Number(summary.store_errors),
          });
        }
        state.events += events.length;
        state.accepted += Number(summary.accepted ?? 0);
        if (events.length > 0) {
          state.last_event_at = clock.nowIso();
        }
        state.cursor = outcome.cursor ?? state.cursor;
        if (Number.isSafeInteger(outcome.generation)) {
          state.generation = outcome.generation;
        }
        if (Number.isSafeInteger(outcome.sequence)) {
          state.sequence = outcome.sequence;
        }
        state.last_success_at = clock.nowIso();
        state.consecutive_failures = 0;
        state.lifecycle = 'ok';
        state.last_error_code = null;
        if (onCursor !== null) {
          onCursor(source.id, {
            cursor: state.cursor,
            generation: state.generation,
            sequence: state.sequence,
            last_success_at: state.last_success_at,
            events: state.events,
          });
        }
      } catch (error) {
        if (entry.settled) {
          return;
        }
        const code = isDaemonError(error) ? error.code : DAEMON_CODES.SOURCE_FAILED;
        markDegraded(state, code);
        logger?.warn?.('collector source degraded', {
          source_id: source.id,
          code,
          consecutive_failures: state.consecutive_failures,
        });
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
        entry.settled = true;
        state.last_poll_mono = clock.monoMs();
        state.last_poll_at = clock.nowIso();
        if (state.lifecycle === 'polling') {
          state.lifecycle = 'idle';
        }
        inFlight.delete(source.id);
      }
    })();

    entry.promise = promise;
    inFlight.set(source.id, entry);
    await promise;
  }

  function startPoll(source, state) {
    if (inFlight.has(source.id)) {
      return false;
    }
    const controller = new AbortController();
    // The promise is stored by runPoll synchronously before its first await, so a
    // `stop()` issued in the same tick still sees it.
    const running = runPoll(source, state, controller);
    running.catch(() => {
      // runPoll already converts every failure into a degraded state.
    });
    return true;
  }

  function isDue(state, source) {
    const intervalMs = source.intervalMs ?? tickMs;
    return clock.monoMs() - state.last_poll_mono >= intervalMs;
  }

  const handle = {
    /** Run one scheduling pass synchronously (returns how many polls started). */
    tick() {
      if (stopping) {
        return 0;
      }
      let startedCount = 0;
      for (const source of sources) {
        const state = states.get(source.id);
        if (inFlight.has(source.id) || !isDue(state, source)) {
          continue;
        }
        if (startPoll(source, state)) {
          startedCount += 1;
        }
      }
      return startedCount;
    },

    /** Start the periodic loop. Idempotent. */
    start() {
      if (started) {
        return;
      }
      started = true;
      stopping = false;
      startedAtMono = clock.monoMs();
      interval = setInterval(() => {
        handle.tick();
      }, tickMs);
      interval.unref?.();
      // First pass runs immediately: waiting a full tick delays startup telemetry.
      handle.tick();
    },

    /**
     * Stop polling and drain in-flight polls.
     *
     * In-flight polls are aborted; their promises settle through the abort path. If
     * a source ignores the abort, `stop` returns `drained: false` after the
     * timeout instead of hanging the shutdown.
     *
     * @param {{timeoutMs?: number}} [opts] Drain budget.
     * @returns {Promise<{drained: boolean, aborted: number}>} Stop result.
     */
    async stop(opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 2000;
      stopping = true;
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      const pendingEntries = [...inFlight.values()];
      for (const entry of pendingEntries) {
        entry.controller.abort();
      }
      for (const state of states.values()) {
        if (state.lifecycle === 'polling') {
          state.lifecycle = 'stopped';
        }
      }
      if (pendingEntries.length === 0) {
        started = false;
        return { drained: true, aborted: 0 };
      }
      const drained = await Promise.race([
        Promise.allSettled(pendingEntries.map((entry) => entry.promise)).then(() => true),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
      started = false;
      return { drained, aborted: pendingEntries.length };
    },

    /**
     * Poll one source immediately.
     *
     * @param {string} sourceId Source id.
     * @returns {Promise<object>} Per-source status snapshot after the poll.
     * @throws {DaemonError} When the source is unknown, busy or the scheduler is stopped.
     */
    async pollNow(sourceId) {
      const source = sources.find((candidate) => candidate.id === sourceId);
      const state = states.get(sourceId);
      if (source === undefined || state === undefined) {
        throw new DaemonError(DAEMON_CODES.SOURCE_UNKNOWN, 'unknown collector source', { source_id: sourceId });
      }
      if (stopping) {
        throw new DaemonError(DAEMON_CODES.LIFECYCLE_NOT_RUNNING, 'scheduler is stopping');
      }
      if (inFlight.has(sourceId)) {
        throw new DaemonError(DAEMON_CODES.SOURCE_BUSY, 'source is already polling', { source_id: sourceId });
      }
      startPoll(source, state);
      const entry = inFlight.get(sourceId);
      if (entry !== undefined) {
        await entry.promise.catch(() => {});
      }
      return handle.sourceStatus(sourceId);
    },

    /** Full per-source status, with staleness computed on the monotonic clock. */
    status() {
      const monoNow = clock.monoMs();
      const list = [];
      for (const source of sources) {
        const state = states.get(source.id);
        const intervalMs = source.intervalMs ?? tickMs;
        const silence = monoNow - state.last_poll_mono;
        state.stale = silence > Math.max(staleAfterMs, intervalMs * 2);
        list.push({
          ...state,
          stale: state.stale,
          silence_ms: silence,
          polling: inFlight.has(source.id),
        });
      }
      return list;
    },

    /** Status of a single source. */
    sourceStatus(sourceId) {
      const found = handle.status().find((entry) => entry.id === sourceId);
      if (found === undefined) {
        throw new DaemonError(DAEMON_CODES.SOURCE_UNKNOWN, 'unknown collector source', { source_id: sourceId });
      }
      return found;
    },

    /** Cursor snapshot for the durable checkpoint. */
    cursors() {
      const output = {};
      for (const [id, state] of states.entries()) {
        output[id] = {
          cursor: state.cursor,
          generation: state.generation,
          sequence: state.sequence,
          last_success_at: state.last_success_at,
          events: state.events,
        };
      }
      return output;
    },

    /** Summary counters for `status`. */
    summary() {
      const list = handle.status();
      return {
        sources: list.length,
        polling: list.filter((entry) => entry.polling).length,
        stale: list.filter((entry) => entry.stale).length,
        degraded: list.filter((entry) => entry.lifecycle === 'degraded').length,
        ok: list.filter((entry) => entry.lifecycle === 'ok').length,
        uptime_mono_ms: clock.monoMs() - startedAtMono,
      };
    },

    /** Source ids, in declaration order. */
    sourceIds: () => sources.map((source) => source.id),
  };
  return handle;
}

export { SOURCE_LIFECYCLES };
