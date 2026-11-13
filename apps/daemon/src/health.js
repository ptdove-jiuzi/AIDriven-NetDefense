/**
 * health.js — liveness, readiness and the status payload.
 *
 * Three different questions, deliberately answered by three different things so
 * that no single "is it healthy?" boolean ends up driving both restarts and
 * alerting:
 *
 * - **Liveness** — the event loop is still serving. Always true while the process
 *   answers at all.
 * - **Readiness** — the daemon can do its core job: it is running and its single
 *   writer is open. A degraded collector does *not* make the daemon unready; the
 *   design says the core continues while a source is downgraded.
 * - **Health** — the honest aggregate shown to an operator, with reasons. A
 *   degraded source, a stale source, a frozen detection engine or store errors all
 *   appear here, and none of them are hidden behind "ok".
 */

/** Health levels, ordered by severity. */
export const HEALTH_LEVELS = Object.freeze(['ok', 'degraded', 'failed']);

/**
 * Report whether a store adapter currently holds an open handle.
 *
 * Adapters expose `isOpen` as a method so the state cannot be read stale after a
 * close; a plain boolean is accepted for simple test doubles.
 *
 * @param {unknown} store Store adapter.
 * @returns {boolean} `true` when the adapter is open.
 */
export function isStoreOpen(store) {
  if (store === null || typeof store !== 'object') {
    return false;
  }
  if (typeof store.isOpen === 'function') {
    return store.isOpen() === true;
  }
  return store.isOpen === true;
}

const RANK = new Map(HEALTH_LEVELS.map((level, index) => [level, index]));

function worst(levels) {
  let result = 'ok';
  for (const level of levels) {
    if ((RANK.get(level) ?? 0) > (RANK.get(result) ?? 0)) {
      result = level;
    }
  }
  return result;
}

/**
 * Compute the health aggregate.
 *
 * @param {{
 *   lifecycle: string,
 *   store: {open: boolean, errors: number},
 *   detection: {faults: number, frozen: boolean},
 *   pipeline?: {pendingContributions: number, contributionsDropped?: number, spoolErrors?: number},
 *   sources: readonly {id: string, lifecycle: string, stale: boolean, consecutive_failures: number,
 *     dropped_events?: number}[]
 * }} input Signals.
 * @returns {{status: 'ok'|'degraded'|'failed', reasons: string[], ready: boolean}} Health.
 */
export function computeHealth(input) {
  const reasons = [];
  const levels = [];

  if (input.lifecycle !== 'running') {
    reasons.push(`lifecycle:${input.lifecycle}`);
    levels.push(input.lifecycle === 'failed' ? 'failed' : 'degraded');
  }
  if (input.store === null || input.store === undefined || input.store.open !== true) {    reasons.push('store:unavailable');
    levels.push('failed');
  } else if (input.store.errors > 0) {
    reasons.push('store:write-errors');
    levels.push('degraded');
  }
  if (input.detection !== null && input.detection !== undefined) {
    if (input.detection.frozen === true) {
      reasons.push('detection:frozen');
      levels.push('degraded');
    } else if (input.detection.faults > 0) {
      reasons.push('detection:faults');
      levels.push('degraded');
    }
  }

  // An alert contribution that could not be written and has not been retried yet is a
  // real, if narrow, data-loss risk: it must be visible, not averaged away.
  if ((input.pipeline?.pendingContributions ?? 0) > 0) {
    reasons.push(`pipeline:pending-contributions:${input.pipeline.pendingContributions}`);
    levels.push('degraded');
  }
  // A contribution the pipeline *gave up* is a permanent undercount until the same evidence is
  // re-observed; keeping it only in `/status` let three review rounds find it by reading JSON
  // (ADR-0007 I4). The counter is observation-level and cumulative for this process.
  if ((input.pipeline?.contributionsDropped ?? 0) > 0) {
    reasons.push(`pipeline:contributions-dropped:${input.pipeline.contributionsDropped}`);
    levels.push('degraded');
  }
  // The durable spool is what survives a restart (ADR-0007). If it cannot be written, the queue is
  // memory-only again — the exact pre-ADR state — so the daemon must not look healthy.
  if ((input.pipeline?.spoolErrors ?? 0) > 0) {
    reasons.push(`pipeline:contributions-spool-degraded:${input.pipeline.spoolErrors}`);
    levels.push('degraded');
  }

  const sources = input.sources ?? [];
  // A truncated batch is data the scheduler *knows it has not read yet* (the cursor is frozen so the
  // tail is re-read). Reporting that as healthy is how RC4-N02 lost 19,500 of 20,000 records with
  // `health=ok`: the only trace was a per-source `/status` field nobody gates on. It is a degradation
  // while it lasts, and it clears itself on the first poll that no longer truncates, so the reason is
  // honest in both directions instead of pinning the daemon degraded forever.
  const droppedEvents = sources.reduce((sum, source) => sum + (Number(source.dropped_events) || 0), 0);
  if (droppedEvents > 0) {
    reasons.push(`sources:dropped-events:${droppedEvents}`);
    levels.push('degraded');
  }
  const degradedSources = sources.filter((source) => source.lifecycle === 'degraded');  const staleSources = sources.filter((source) => source.stale === true);
  if (degradedSources.length > 0) {
    reasons.push(`sources:degraded:${degradedSources.length}`);
    levels.push('degraded');
  }
  if (staleSources.length > 0) {
    reasons.push(`sources:stale:${staleSources.length}`);
    levels.push('degraded');
  }
  if (sources.length === 0) {
    reasons.push('sources:none');
    levels.push('degraded');
  }

  const status = worst(levels);
  const ready = input.lifecycle === 'running'
    && input.store !== null
    && input.store !== undefined
    && input.store.open === true;
  return { status, reasons, ready };
}

/**
 * Build the authenticated status payload.
 *
 * Contains identifiers and counters only: no token, no CSRF value, no file paths
 * of user data, no event content.
 *
 * @param {{
 *   version: string,
 *   lifecycle: string,
 *   startedAt: string|null,
 *   clock: {nowMs: () => number, nowIso: () => string},
 *   epoch: string|null,
 *   mode: string,
 *   scheduler: object,
 *   pipeline: object,
 *   store: object,
 *   health: object,
 *   counters: object
 * }} input State.
 * @returns {object} Status payload.
 */
export function buildStatusPayload(input) {
  const nowMs = input.clock.nowMs();
  const sources = input.scheduler.status();
  return {
    schema_version: '1.0',
    version: input.version,
    lifecycle: input.lifecycle,
    mode: input.mode,
    started_at: input.startedAt,
    now: input.clock.nowIso(),
    epoch: input.epoch,
    health: {
      status: input.health.status,
      ready: input.health.ready,
      reasons: [...input.health.reasons],
    },
    scheduler: {
      ...input.scheduler.summary(),
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        lifecycle: source.lifecycle,
        stale: source.stale,
        polling: source.polling,
        polls: source.polls,
        events: source.events,
        accepted: source.accepted,
        failures: source.failures,
        consecutive_failures: source.consecutive_failures,
        last_poll_at: source.last_poll_at,
        last_success_at: source.last_success_at,
        last_event_at: source.last_event_at,
        last_error_code: source.last_error_code,
        last_error_at: source.last_error_at,
        dropped_events: source.dropped_events,
      })),
    },
    pipeline: input.pipeline.stats(),
    store: {
      kind: input.store.kind,
      open: isStoreOpen(input.store),
      ...input.store.stats(),
    },
    counters: { ...input.counters },
    uptime_ms: input.startedAtMs === null ? null : Math.max(0, nowMs - input.startedAtMs),
  };
}
