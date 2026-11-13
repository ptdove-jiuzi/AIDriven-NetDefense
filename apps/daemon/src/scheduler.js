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
 * 6. **Batches are bounded, but never silently discarded.** A source returning more than
 *    `maxBatchEvents` has the surplus *deferred*, not buffered: the cursor stays where it was so
 *    the same batch is re-read, each round persists the next window, and the store's stable key
 *    absorbs whatever overlaps. The outstanding count is visible in `/status` and `/health`
 *    until the tail is drained (RC4-N02: a 20,000-record snapshot used to lose 19,500 of them).
 * 7. **A failing source backs off exponentially; a success resets it.** A source that keeps
 *    failing used to be retried at its normal cadence forever — `windows.network-table` failed
 *    every 10 s for the whole measured window and never recovered (PERF-CPU N-034). Retrying a
 *    dead channel at full rate costs a PowerShell cold start each time and produces nothing.
 *    The delay is derived from **that source's own `intervalMs`** (not from the global tick) and
 *    doubles per consecutive failure up to `maxFailureBackoffMs` (60 s by default).
 *    This never loses data: every collector source is cursor/probe based, so the next successful
 *    poll re-reads from the frozen cursor and the store's stable key absorbs the overlap.
 * 8. **The periodic pass sleeps longer while the collection is quiet.** `tickMs` stays the base
 *    cadence; on top of it the timer doubles its delay (up to `idleTick.maxFactor`) once no source
 *    has produced new data for `idleTick.quietAfterMs`, and snaps back to the base cadence the
 *    moment any source produces events (or `pollNow()` is called). This is a cadence amplifier
 *    over the configured tick, never a change to a source's own `intervalMs`.
 */

import { DaemonError, DAEMON_CODES, isDaemonError } from './errors.js';
import { assertSources } from './adapters/collector.js';

const SOURCE_LIFECYCLES = Object.freeze(['idle', 'polling', 'ok', 'degraded', 'stopped']);

/**
 * Upper bound for the per-source failure backoff (invariant 7). A permanently dead channel
 * settles at one retry per minute instead of one per cadence.
 */
export const MAX_FAILURE_BACKOFF_MS = 60_000;

/** Defaults for the quiet-period cadence amplifier (invariant 8). */
export const IDLE_TICK_DEFAULTS = Object.freeze({
  enabled: true,
  /** Quiet period (no new data from any source) before the first widening. */
  minQuietAfterMs: 10_000,
  /** Quiet period expressed as a multiple of `tickMs`, whichever is larger. */
  quietAfterTicks: 2,
  /** Maximum multiplier applied to `tickMs` (1s → 2s → 4s at the default tick). */
  maxFactor: 4,
  /** Hard ceiling for the widened delay, independent of `tickMs`. */
  maxMs: 60_000,
});

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
    // Invariant 7: the current retry delay after a failure streak, how many scheduling passes
    // were skipped because of it, and the monotonic instant the source becomes eligible again.
    // `retry_in_ms` is derived from `next_attempt_mono` in `status()` so it is honest on a
    // monotonic clock (invariant 5) and never negative.
    backoff_ms: 0,
    backoff_skips: 0,
    next_attempt_mono: null,
    // Resume offset inside a batch whose tail has not been persisted yet. In-memory only: after a
    // restart the frozen cursor replays the batch from the top and the stable key drops the overlap.
    truncation: null,
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
 *   maxFailureBackoffMs?: number,
 *   idleTick?: {enabled?: boolean, quietAfterMs?: number, maxFactor?: number, maxMs?: number},
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
  const maxFailureBackoffMs = Number.isInteger(options.maxFailureBackoffMs) && options.maxFailureBackoffMs > 0
    ? options.maxFailureBackoffMs
    : MAX_FAILURE_BACKOFF_MS;

  // Invariant 8: the quiet-period amplifier is expressed *relative to* the configured tick, so
  // `tickMs` keeps its meaning (base cadence, and the fallback interval for a source that does not
  // declare one). Nothing here overrides a source's own `intervalMs`.
  const idleOptions = options.idleTick ?? {};
  const idleEnabled = idleOptions.enabled ?? IDLE_TICK_DEFAULTS.enabled;
  const idleMaxFactor = Number.isInteger(idleOptions.maxFactor) && idleOptions.maxFactor >= 1
    ? idleOptions.maxFactor
    : IDLE_TICK_DEFAULTS.maxFactor;
  const idleMaxMs = Number.isInteger(idleOptions.maxMs) && idleOptions.maxMs > 0
    ? idleOptions.maxMs
    : IDLE_TICK_DEFAULTS.maxMs;
  const idleQuietAfterMs = Number.isInteger(idleOptions.quietAfterMs) && idleOptions.quietAfterMs >= 0
    ? idleOptions.quietAfterMs
    : Math.max(IDLE_TICK_DEFAULTS.minQuietAfterMs, tickMs * IDLE_TICK_DEFAULTS.quietAfterTicks);

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

  // --- periodic-pass bookkeeping (invariant 8) --------------------------------------------
  // `lastActivityMono` is the last time *any* source produced new data. It is the only signal
  // the amplifier reacts to: an API read does not reset it, because `/status` is computed on
  // demand from live state and is therefore never stale — the cadence only controls how fast new
  // data is *discovered*, and there is nothing to discover while nothing is being produced.
  let lastActivityMono = clock.monoMs();
  let idleLevel = 0;
  let lastDelayMs = tickMs;
  let ticks = 0;
  let tickPolls = 0;
  let idleTicks = 0;

  /** Mark collection activity: the next pass returns to the base cadence immediately. */
  function noteActivity() {
    lastActivityMono = clock.monoMs();
    if (idleLevel > 0) {
      idleLevel = 0;
      rearm(tickMs);
    }
  }

  /** Delay for the next periodic pass: base `tickMs` widened while nothing is being produced. */
  function nextDelayMs() {
    if (!idleEnabled) {
      idleLevel = 0;
      return tickMs;
    }
    const quietForMs = clock.monoMs() - lastActivityMono;
    if (quietForMs < idleQuietAfterMs) {
      idleLevel = 0;
    } else if (idleLevel < idleMaxFactor) {
      idleLevel += 1;
    }
    lastDelayMs = Math.min(idleMaxMs, tickMs * Math.min(2 ** idleLevel, idleMaxFactor));
    return lastDelayMs;
  }

  function rearm(delayMs) {
    if (!started || stopping) {
      return;
    }
    if (interval !== null) {
      clearTimeout(interval);
    }
    interval = setTimeout(onTimer, delayMs);
    interval.unref?.();
    lastDelayMs = delayMs;
  }

  function onTimer() {
    interval = null;
    if (stopping) {
      return;
    }
    const startedCount = handle.tick();
    if (startedCount === 0) {
      idleTicks += 1;
    }
    rearm(nextDelayMs());
  }

  function markDegraded(source, state, code) {
    state.lifecycle = 'degraded';
    state.failures += 1;
    state.consecutive_failures += 1;
    state.last_error_code = code;
    state.last_error_at = clock.nowIso();
    // Invariant 7: exponential backoff derived from this source's own cadence, capped at
    // `maxFailureBackoffMs`. Doubling starts at the *second* consecutive failure, so the first
    // retry of a transient error still happens at the normal cadence.
    const baseWaitMs = source.intervalMs ?? tickMs;
    const grown = baseWaitMs * (2 ** Math.min(state.consecutive_failures - 1, 16));
    state.backoff_ms = Math.min(maxFailureBackoffMs, Math.max(baseWaitMs, grown));
    state.next_attempt_mono = clock.monoMs() + state.backoff_ms;
  }

  /** A committed poll is a success: the failure streak and its backoff are over. */
  function markRecovered(state) {
    state.consecutive_failures = 0;
    state.backoff_ms = 0;
    state.backoff_skips = 0;
    state.next_attempt_mono = null;
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
        const batch = outcome.events;
        const batchKey = String(batch[0]?.event_id ?? '');
        // A truncated batch must not advance the cursor: its tail exists only inside the source, so
        // committing `outcome.cursor` here would make that tail permanently unreadable. Instead the
        // cursor stays put, the next poll re-reads the same batch, and `truncation.offset` records how
        // much of it is already persisted so each round ingests the *next* window. The stable key
        // `(stable_source_id, source_generation, dedupe_key)` absorbs the overlap if the source shifts.
        let resumeOffset = 0;
        const carried = state.truncation;
        if (carried !== null && carried !== undefined) {
          const headUnchanged = carried.first_key === batchKey && batchKey.length > 0;
          if (headUnchanged && batch.length > carried.offset) {
            resumeOffset = carried.offset;
          } else {
            // The source is no longer the snapshot we started draining (rotation, a replaced snapshot,
            // or a shorter batch). Replay from the oldest available record; duplicates are absorbed.
            state.truncation = null;
            logger?.warn?.('collector snapshot changed while a truncated batch was still being drained', {
              source_id: source.id,
              resume_offset: carried.offset,
              batch_events: batch.length,
            });
          }
        }
        let events = batch;
        let truncated = false;
        let pending = 0;
        if (batch.length > maxBatchEvents) {
          truncated = true;
          events = batch.slice(resumeOffset, resumeOffset + maxBatchEvents);
          pending = batch.length - (resumeOffset + events.length);
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
          // New data is exactly what the quiet-period amplifier must react to (invariant 8).
          noteActivity();
        }
        if (truncated && pending > 0) {
          // Keep the persisted position where it is: no `outcome.cursor/generation/sequence`, no
          // `onCursor` checkpoint. The tail is re-read from the source next round (bounded memory),
          // and `dropped_events` is the honest count of what is still unread — not what is lost.
          // Silence here is what made RC4-N02 a 97.5% data loss with `health=ok`.
          state.truncation = { offset: resumeOffset + events.length, first_key: batchKey };
          state.dropped_events = pending;
          state.last_success_at = clock.nowIso();
          markRecovered(state);
          state.lifecycle = 'ok';
          state.last_error_code = null;
          logger?.error?.('collector batch exceeds maxBatchEvents; cursor frozen and remainder re-read next round', {
            source_id: source.id,
            dropped: pending,
            pending_events: pending,
            dropped_this_round: batch.length - events.length,
            batch_events: batch.length,
            ingested_this_round: events.length,
            max_batch_events: maxBatchEvents,
          });
          return;
        }
        state.truncation = null;
        state.dropped_events = 0;
        state.cursor = outcome.cursor ?? state.cursor;
        if (Number.isSafeInteger(outcome.generation)) {
          state.generation = outcome.generation;
        }
        if (Number.isSafeInteger(outcome.sequence)) {
          state.sequence = outcome.sequence;
        }
        state.last_success_at = clock.nowIso();
        markRecovered(state);
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
        markDegraded(source, state, code);
        // One warn per failure *streak*, not one per attempt: a dead channel used to emit two
        // warning lines per cadence forever (`network-table` alone produced 32 lines in four
        // minutes, evidence/perf/lead-smoke/daemon-warn.log). The retry delay is the actionable
        // part, and it is stated on the first line and visible in `/status` anyway.
        const fields = {
          source_id: source.id,
          code,
          consecutive_failures: state.consecutive_failures,
          retry_in_ms: state.backoff_ms,
          max_retry_ms: maxFailureBackoffMs,
        };
        if (state.consecutive_failures === 1) {
          logger?.warn?.('collector source degraded', fields);
        } else {
          logger?.debug?.('collector source still degraded', fields);
        }
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


  const handle = {
    /** Run one scheduling pass synchronously (returns how many polls started). */
    tick() {
      if (stopping) {
        return 0;
      }
      ticks += 1;
      let startedCount = 0;
      const monoNow = clock.monoMs();
      for (const source of sources) {
        const state = states.get(source.id);
        if (inFlight.has(source.id)) {
          continue;
        }
        const elapsed = monoNow - state.last_poll_mono;
        // Invariant 7: a failing source waits out its backoff before it is retried. The skip is
        // counted per source so `/status` can prove the saving instead of the log being the only
        // trace (previously the retry looked exactly like a normal poll).
        if (state.backoff_ms > 0 && elapsed < state.backoff_ms) {
          state.backoff_skips += 1;
          continue;
        }
        if (elapsed < (source.intervalMs ?? tickMs)) {
          continue;
        }
        if (startPoll(source, state)) {
          startedCount += 1;
        }
      }
      tickPolls += startedCount;
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
      lastActivityMono = clock.monoMs();
      idleLevel = 0;
      // Invariant 8: a self-arming timer instead of `setInterval(tickMs)`. The delay comes from
      // `nextDelayMs()` so a quiet collection widens it and `noteActivity()` snaps it back.
      interval = setTimeout(onTimer, tickMs);
      interval.unref?.();
      lastDelayMs = tickMs;
      // First pass runs immediately: waiting a full tick delays startup telemetry.
      handle.tick();
    },

    /**
     * Report the current periodic cadence without advancing it (for tests and `/status`).
     *
     * @returns {{enabled: boolean, tick_ms: number, delay_ms: number, idle_level: number,
     *   quiet_after_ms: number, max_factor: number, quiet_for_ms: number}} Cadence view.
     */
    cadence() {
      return {
        enabled: idleEnabled,
        tick_ms: tickMs,
        delay_ms: lastDelayMs,
        idle_level: idleLevel,
        quiet_after_ms: idleQuietAfterMs,
        max_factor: idleMaxFactor,
        quiet_for_ms: clock.monoMs() - lastActivityMono,
      };
    },

    /**
     * Record collection activity (new data observed or an operator-triggered poll).
     *
     * @returns {void}
     */
    noteActivity,

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
        // The periodic pass is a self-arming `setTimeout` now (invariant 8), not a `setInterval`.
        clearTimeout(interval);
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
      // An operator-triggered poll is activity: it also bypasses a failure backoff (this is the
      // manual "try it now" path) and returns the periodic cadence to the base tick.
      noteActivity();
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
          // Invariant 7, made observable: how long until this source is retried. `0` means it is
          // eligible now (no failure streak).
          retry_in_ms: state.backoff_ms > 0 ? Math.max(0, state.next_attempt_mono - monoNow) : 0,
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
        // RC4-N02: a truncated batch is unread data, so the aggregate has to be visible next to the
        // per-source counter instead of only in a log line. `dropped_events` is the sum still waiting
        // to be re-read; `degraded_by_drop` counts the sources behind it.
        dropped_events: list.reduce((sum, entry) => sum + entry.dropped_events, 0),
        degraded_by_drop: list.filter((entry) => entry.dropped_events > 0).length,
        // PERF-CPU N-034: the two savings have to be countable, otherwise "the CPU went down" is
        // an opinion. `backoff_skips` is the number of retries the failure backoff suppressed;
        // `ticks`/`tick_polls`/`idle_ticks` describe the periodic pass (a tick that started no
        // poll is the only kind the quiet-period amplifier can remove).
        backoff_skips: list.reduce((sum, entry) => sum + entry.backoff_skips, 0),
        backoff_sources: list.filter((entry) => entry.backoff_ms > 0).length,
        ticks,
        tick_polls: tickPolls,
        idle_ticks: idleTicks,
        idle_level: idleLevel,
        tick_delay_ms: lastDelayMs,
        uptime_mono_ms: clock.monoMs() - startedAtMono,
      };
    },

    /** Source ids, in declaration order. */
    sourceIds: () => sources.map((source) => source.id),
  };
  return handle;
}

export { SOURCE_LIFECYCLES };
