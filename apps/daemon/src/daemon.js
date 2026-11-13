/**
 * daemon.js — the control plane object: wiring, lifecycle and shutdown order.
 *
 * Everything the daemon is composed of is injected:
 *
 * | part        | production                     | tests / mock mode          |
 * |-------------|--------------------------------|----------------------------|
 * | event store | `createEventStoreAdapter` (T1) | `createMemoryEventStoreAdapter` |
 * | collectors  | operator-provided sources      | `createScriptedSource`     |
 * | detection   | `createDetectionEngine`        | same (pure, no I/O)        |
 * | API         | `createControlApi`             | same, on port 0            |
 *
 * The daemon never imports the Harness, a model client, a sandbox, a plugin
 * runtime or the response path. That is not a convention to be maintained by
 * vigilance: `tests/wp5-daemon` asserts it over the source tree, and the module
 * graph here simply has no edge to them.
 *
 * ## Shutdown order (and why it is exactly this)
 *
 * 1. **Stop the scheduler first.** No new batch may start once shutdown began.
 * 2. **Drain or abandon in-flight polls.** A source that misses `drainMs` is
 *    abandoned; a hung adapter must not turn a clean stop into a hang.
 * 3. **Close the API.** Readiness starts failing before the store disappears, so a
 *    service manager sees "not ready" rather than "connection refused".
 * 4. **Persist the checkpoint.** Cursors must reflect only committed batches; if
 *    persistence fails we still continue shutting the store down, because a stale
 *    cursor replays (safe) while a corrupt one does not.
 * 5. **Close the store last.** It is the single writer; nothing may still be
 *    writing when it closes.
 *
 * A second `stop()` call is a no-op that returns the first call's promise. Signals
 * arrive twice in practice (Ctrl-C twice, SIGTERM during SIGINT handling), and a
 * double close must not throw out of the signal handler.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createDetectionEngine, DEFAULT_LIMITS, loadRulePack, validateRulePack } from '@aegisharness/detection';

import { createEventStoreAdapter, createMemoryEventStoreAdapter } from './adapters/event-store.js';
import { assertSources } from './adapters/collector.js';
import { createBrokerClient } from './api/broker-client.js';
import { createAuthGuard, provisionApiToken } from './api/auth.js';
import { createChatEngine } from './api/chat-engine.js';
import { createApprovalRegistry, createChatHandlers, createChatQuota } from './api/chat.js';
import { createCredentialHandlers } from './api/credentials.js';
import { CONSOLE_CODES, ConsoleError } from './api/console-errors.js';
import { createDiagnosticsHandlers } from './api/diagnostics.js';
import { createAlertLookup, createExplainHandlers, createExplainLimiter } from './api/explain.js';
import { createHealthCache, createModelsHandlers } from './api/models.js';
import { createReadEndpoints } from './api/read-endpoints.js';
import { createReadModel } from './api/read-model.js';
import { createTokenRotation } from './api/rotator.js';
import { createControlApi } from './api/server.js';
import { createSettingsHandlers, createSettingsStore } from './api/settings.js';
import { assertClock, createSystemClock } from './clock.js';
import { loadConfig } from './config.js';
import { enforceLogRetention } from './log-rotate.js';
import { createPipeline } from './pipeline.js';
import { createScheduler } from './scheduler.js';
import { createStateFile, createEmptyState } from './state-store.js';
import { buildStatusPayload, computeHealth, isStoreOpen } from './health.js';
import { createLifecycle } from './lifecycle.js';
import { createLogger, nullLogger } from './log.js';
import { randomUUID } from 'node:crypto';
import { DaemonError, DAEMON_CODES, toDaemonError } from './errors.js';

/** Daemon version reported by the API. */
export const DAEMON_VERSION = '0.1.0-m5';

/**
 * Per-source outcome the daemon keeps so `/status` can be honest (A2-SHAPE §6).
 *
 * The scheduler only knows "the poll returned N events", which is why a source that
 * silently read nothing used to report `ok`. The poll contract carries an explicit
 * `empty: {code, reason}` for that case, and a failure carries the collector's own code;
 * both are recorded here and projected onto the status payload.
 */
const EMPTY_UNSPECIFIED = 'UNSPECIFIED_EMPTY';

/** Collector-side failure code kept for the status view (`last_error_code`). */
function collectorCodeOf(error) {
  if (typeof error?.collectorCode === 'string' && error.collectorCode.length > 0) {
    return error.collectorCode;
  }
  if (typeof error?.details?.collector_code === 'string' && error.details.collector_code.length > 0) {
    return error.details.collector_code;
  }
  if (typeof error?.code === 'string' && error.code.length > 0) {
    return error.code;
  }
  return 'SOURCE_FAILED';
}

/**
 * Wrap one collector source so every poll outcome becomes a recorded, explainable state.
 *
 * This is deliberately an observation wrapper: it never changes what the scheduler sees
 * (same events, same cursor, same thrown error), it only remembers *why* a poll produced
 * no events so the status payload and the counters can say so.
 *
 * @param {object} source Source descriptor as injected by the host.
 * @param {Map<string, object>} outcomes Sink keyed by source id.
 * @param {{nowMs: () => number}} clock Clock.
 * @returns {object} Source with an observed `poll`.
 */
function observeSourcePoll(source, outcomes, clock) {
  if (source === null || typeof source !== 'object' || typeof source.poll !== 'function') {
    // Let `assertSources` produce the accurate SOURCE_INVALID error.
    return source;
  }
  const sourceId = source.id;
  const poll = source.poll;

  const recordFailure = (error) => {
    outcomes.set(sourceId, Object.freeze({
      state: 'unavailable',
      code: collectorCodeOf(error),
      reason: typeof error?.details?.reason === 'string'
        ? error.details.reason
        : (typeof error?.message === 'string' ? error.message : null),
      at_ms: clock.nowMs(),
    }));
  };

  /** Record what one poll produced — without adding a microtask to the caller. */
  const recordOutcome = (outcome) => {
    const events = Array.isArray(outcome?.events) ? outcome.events : null;
    if (events === null) {
      // The scheduler raises BATCH_INVALID for this; keep the record honest anyway.
      outcomes.set(sourceId, Object.freeze({
        state: 'unavailable',
        code: 'BATCH_INVALID',
        reason: 'the source did not return { events: [] }',
        at_ms: clock.nowMs(),
      }));
      return;
    }
    if (events.length > 0) {
      outcomes.set(sourceId, Object.freeze({
        state: 'ok',
        code: null,
        reason: null,
        events: events.length,
        at_ms: clock.nowMs(),
      }));
      return;
    }
    const empty = outcome?.empty;
    const code = typeof empty?.code === 'string' && empty.code.length > 0 ? empty.code : EMPTY_UNSPECIFIED;
    outcomes.set(sourceId, Object.freeze({
      state: 'empty',
      code,
      reason: typeof empty?.reason === 'string' && empty.reason.length > 0
        ? empty.reason
        : 'the source returned zero events without an `empty` reason, which violates A2-SHAPE §6',
      at_ms: clock.nowMs(),
    }));
  };

  return {
    ...source,
    // Deliberately **not** declared `async`: a synchronous poll has to stay synchronous.
    // Wrapping it in `async`/`await` pushed its result one microtask later, which made
    // `scheduler.js`'s "a poll that lands after stop must not advance the cursor" rule
    // fire for synchronous sources and silently dropped their cursor
    // (tests/wp5-daemon/restart-recovery.test.js "resumes from the persisted cursor").
    poll(ctx) {
      let result;
      try {
        result = poll.call(source, ctx);
      } catch (error) {
        recordFailure(error);
        throw error;
      }
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        return result.then(
          (outcome) => { recordOutcome(outcome); return outcome; },
          (error) => { recordFailure(error); throw error; },
        );
      }
      recordOutcome(result);
      return result;
    },
  };
}

/**
 * Wrap the event store so a rejected write is observable instead of only being a
 * `STORE_WRITE_FAILED` log line (CL-8).
 *
 * The pipeline calls `store.ingest()` once per event, so a rejected call is exactly one
 * rejected event. The real reason (`ERR_NULL_NOT_ALLOWED`, `ERR_INTEGRITY_DIGEST_MISMATCH`,
 * `ERR_FIELD_PATTERN`, …) lives in `error.details.reason` and was previously dropped by
 * the pipeline's log line; it is logged here and counted in `counters.rejected_by_store`.
 *
 * @param {object} store Event store adapter.
 * @param {{logger: object|null, rejection: object, clock: object}} deps Dependencies.
 * @returns {object} Store facade.
 */
function observeStoreWrites(store, { logger, rejection, clock }) {
  if (store === null || typeof store !== 'object' || typeof store.ingest !== 'function') {
    return store;
  }
  const facade = Object.create(store);
  Object.defineProperty(facade, 'ingest', {
    value(request) {
      try {
        return store.ingest(request);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'STORE_WRITE_FAILED';
        const reason = typeof error?.details?.reason === 'string' ? error.details.reason : null;
        const bucket = reason ?? code;
        rejection.count += 1;
        rejection.by_reason[bucket] = (rejection.by_reason[bucket] ?? 0) + 1;
        rejection.last = Object.freeze({ code, reason, at_ms: clock.nowMs() });
        logger?.error?.('event store rejected a write', {
          code,
          reason,
          event_id: typeof request?.event?.event_id === 'string' ? request.event.event_id : null,
          stable_source_id: typeof request?.event?.stable_source_id === 'string'
            ? request.event.stable_source_id
            : null,
          rejected_by_store: rejection.count,
        });
        throw error;
      }
    },
    enumerable: false,
    configurable: true,
  });
  return facade;
}

function buildDetection(config, clock) {
  if (config.detection.rulePackPath !== null) {
    return createDetectionEngine({
      // `loadRulePack` is the detection package's only file reader; using it keeps
      // rule-pack validation in one place.
      rulePack: loadRulePack(config.detection.rulePackPath),
      clock: { now: () => clock.nowMs() },
      limits: config.detection.limits ?? undefined,
    });
  }
  const pack = config.detection.rulePack;
  if (pack === null) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'no rule pack is configured');
  }
  return createDetectionEngine({
    rulePack: validateRulePack(pack),
    clock: { now: () => clock.nowMs() },
    limits: config.detection.limits ?? undefined,
  });
}

/**
 * Create a daemon.
 *
 * Construction is side-effect free: no directory is created, no file is read and
 * no port is bound until `start()`.
 *
 * @param {{
 *   config: object,
 *   sources?: readonly object[],
 *   store?: object,
 *   clock?: object,
 *   logger?: object
 * }} options Options.
 * @returns {object} Daemon handle.
 */
export function createDaemon(options) {
  if (options === null || typeof options !== 'object') {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'createDaemon requires an options object');
  }
  const config = loadConfig(options.config);
  const clock = assertClock(options.clock ?? createSystemClock());
  const logger = options.logger ?? (config.logging.level === 'silent' ? nullLogger : createLogger({
    level: config.logging.level,
    clock,
  }));

  const lifecycle = createLifecycle({
    clock,
    onChange: (event) => logger.info?.('lifecycle', { from: event.from, to: event.to }),
  });

  /**
   * Last poll outcome per source (A2-SHAPE §6). Written by the observation wrapper
   * installed below and projected onto the status payload; it is not a second counter.
   *
   * @type {Map<string, {state: string, code: string|null, reason: string|null, at_ms: number}>}
   */
  const sourceOutcomes = new Map();
  const sources = assertSources(
    (options.sources ?? []).map((source) => observeSourcePoll(source, sourceOutcomes, clock)),
    config.scheduler.maxSources,
  );

  /**
   * Store rejections seen by the facade below: `count` is the observable counter
   * (`counters.rejected_by_store`), `by_reason` is the distribution an operator needs to
   * tell "the contract rejected my field" from "the disk is full".
   */
  const storeRejection = { count: 0, by_reason: {}, last: null };
  const injectedStore = options.store ?? null;

  let store = null;
  let detection = null;
  let pipeline = null;
  let scheduler = null;
  let api = null;
  let auth = null;
  let readModel = null;
  let stateFile = null;
  /**
   * Console v2 wiring (contract §2): settings/health stores, the broker gateway and
   * the in-memory quotas. Kept in one object so shutdown can close exactly what was
   * created, and so `diagnostics()` can report their state without leaking paths.
   *
   * @type {{broker: object, approvals: object, quota: object, explain: object, settings: object}|null}
   */
  let consoleRouting = null;
  let epoch = null;
  let startedAtMs = null;
  let startPromise = null;
  let stopPromise = null;
  let baseCounters = null;
  let lastStateCorrupt = false;
  let bootCounters = null;
  /** ISO timestamp of the last successful diagnostics export (contract §6 read-only field). */
  let lastExportAt = null;
  /** Debounce timer for cursor persistence; cleared on shutdown so no late write fires. */
  let cursorSaveTimer = null;

  function zeroCounters() {
    return {
      polls: 0,
      events_received: 0,
      events_accepted: 0,
      events_duplicate: 0,
      alerts_written: 0,
      findings_written: 0,
      analysis_requests: 0,
      source_failures: 0,
    };
  }

  /**
   * Cumulative counters: the checkpoint's baseline plus what this process did.
   *
   * The pipeline and the scheduler are the authority for their own counters — the
   * daemon keeps no parallel tally that could drift from them.
   */
  function mergedCounters() {
    const base = baseCounters ?? zeroCounters();
    const pipelineStats = pipeline === null ? null : pipeline.stats();
    const boot = bootCounters ?? zeroCounters();
    const sourceList = scheduler === null ? [] : scheduler.status();
    const current = {
      // Both paths poll: the scheduler's own timer and the API's on-demand poll.
      polls: boot.polls + sourceList.reduce((sum, source) => sum + source.polls, 0),
      events_received: pipelineStats?.events_received ?? boot.events_received,
      events_accepted: pipelineStats?.events_accepted ?? boot.events_accepted,
      events_duplicate: pipelineStats?.events_duplicate ?? boot.events_duplicate,
      alerts_written: pipelineStats?.alerts_written ?? boot.alerts_written,
      findings_written: pipelineStats?.findings_written ?? boot.findings_written,
      analysis_requests: pipelineStats?.analysis_requests ?? boot.analysis_requests,
      // Deferred contributions the pipeline had to give up (queue quota, or a source that
      // never returned). It is a data-loss counter, so it must be readable at runtime
      // instead of only existing inside the pipeline's own stats(): `count` is already
      // below the number of stored events when it moves, and `truncated` does not say so.
      contributions_dropped: pipelineStats?.contributions_dropped ?? boot.contributions_dropped,
      source_failures: sourceList.filter((entry) => entry.consecutive_failures > 0).length,
      // A2-SHAPE §6/§7: the two states that used to be invisible. `rejected_by_store` is
      // cumulative per process (like the pipeline's own counters) and `store_reject_reason`
      // names the dominant cause so an operator does not have to grep the log first.
      rejected_by_store: storeRejection.count,
      sources_empty: sourceStatusView().filter((entry) => entry.lifecycle === 'empty').length,
      sources_unavailable: sourceStatusView().filter((entry) => entry.lifecycle === 'unavailable').length,
    };
    const output = {};
    for (const key of Object.keys(current)) {
      output[key] = (base[key] ?? 0) + (current[key] ?? 0);
    }
    return output;
  }

  /**
   * Honest per-source status: the scheduler's own rows with the lifecycle corrected by the
   * recorded poll outcome (A2-SHAPE §6).
   *
   * The scheduler can only say `ok` or `degraded`, because it judges a poll by the number
   * of events it returned. A source that returned zero events for a *stated* reason is
   * `empty` here (visible, but not a degradation), and a collector failure keeps its own
   * code (`ACCESS_DENIED`, `TIMEOUT`, …) instead of the generic `SOURCE_FAILED`.
   *
   * @returns {object[]} Rows for `/status` and health.
   */
  function sourceStatusView() {
    if (scheduler === null) {
      return [];
    }
    return scheduler.status().map((entry) => {
      const outcome = sourceOutcomes.get(entry.id) ?? null;
      const row = {
        ...entry,
        last_empty_code: outcome !== null && outcome.state === 'empty' ? outcome.code : null,
        last_empty_reason: outcome !== null && outcome.state === 'empty' ? outcome.reason : null,
      };
      // A daemon-side degradation (store write failure, stop) outranks the poll outcome:
      // reporting `ok` because the poll returned rows while the rows could not be stored
      // is exactly the kind of lie this view exists to prevent. A collector failure, on the
      // other hand, is *more* specific than the scheduler's generic `degraded`, so it is
      // projected first and keeps its own code.
      if (entry.lifecycle === 'stopped') {
        return row;
      }
      if (outcome === null) {
        return row;
      }
      if (outcome.state === 'unavailable') {
        return {
          ...row,
          lifecycle: entry.lifecycle === 'polling' ? 'polling' : 'unavailable',
          last_error_code: outcome.code ?? entry.last_error_code,
          last_error_at: entry.last_error_at ?? clock.nowIso(),
        };
      }
      if (entry.lifecycle === 'degraded' || entry.lifecycle === 'polling') {
        return row;
      }
      return { ...row, lifecycle: outcome.state };
    });
  }

  /** Summary of the honest view; keeps the scheduler's uptime/polling fields. */
  function sourceStatusSummary() {
    const list = sourceStatusView();
    const base = scheduler === null ? {} : scheduler.summary();
    return {
      ...base,
      ok: list.filter((entry) => entry.lifecycle === 'ok').length,
      empty: list.filter((entry) => entry.lifecycle === 'empty').length,
      unavailable: list.filter((entry) => entry.lifecycle === 'unavailable').length,
      degraded: list.filter((entry) => entry.lifecycle === 'degraded').length,
    };
  }

  /**
   * Scheduler facade for `buildStatusPayload`: same interface, honest rows.
   *
   * @returns {{status: Function, summary: Function, sourceIds: Function}} Facade.
   */
  function statusView() {
    return {
      status: sourceStatusView,
      summary: sourceStatusSummary,
      sourceIds: () => (scheduler === null ? [] : scheduler.sourceIds()),
    };
  }

  function health() {
    // `unavailable` is a genuine degradation (design §5.1: a denied channel degrades) while
    // `empty` is not — a quiet source is reported as `empty`, not as `ok`, in /status.
    const sourcesStatus = sourceStatusView().map((entry) => (
      entry.lifecycle === 'unavailable' ? { ...entry, lifecycle: 'degraded' } : entry
    ));
    const pipelineStats = pipeline === null ? null : pipeline.stats();
    return computeHealth({
      lifecycle: lifecycle.state(),
      store: store === null ? { open: false, errors: 0 } : {
        open: isStoreOpen(store),
        // Consecutive, not cumulative: one transient rollback must not leave the
        // daemon permanently "degraded" for the rest of the process's life.
        errors: pipelineStats?.store_errors_consecutive ?? 0,
      },
      pipeline: pipelineStats === null ? null : {
        pendingContributions: pipelineStats.contributions_pending,
        // ADR-0007 §3.4: a discard or a spool failure must reach `/health`, not only `/status`.
        contributionsDropped: pipelineStats.contributions_dropped,
        spoolErrors: pipelineStats.contributions_spool_errors,
      },
      detection: pipelineStats === null ? null : {
        faults: pipelineStats.detection_faults,
        frozen: pipelineStats.detection === null ? false : pipelineStats.detection.fatal !== null,
      },
      sources: sourcesStatus,
    });
  }

  /**
   * The `/status` payload, built once so the API route, the diagnostics bundle and
   * the daemon handle cannot describe the same process differently.
   *
   * @returns {object} Status payload.
   */
  function buildStatus() {
    return buildStatusPayload({
      version: DAEMON_VERSION,
      lifecycle: lifecycle.state(),
      startedAt: lifecycle.startedAt(),
      startedAtMs,
      clock,
      epoch,
      mode: config.mode,
      // The facade, not the raw handle: `/status` must report `empty` and
      // `unavailable` instead of a generic `ok` (A2-SHAPE §6).
      scheduler: statusView(),
      pipeline,
      store,
      health: health(),
      counters: mergedCounters(),
    });
  }

  /**
   * Diagnostics data (counters, API stats, checkpoint health, console counters).
   *
   * Read by the support bundle (OPS-DIAG). It deliberately carries no settings
   * values and no credentials: identifiers and counters only.
   *
   * @returns {object} Diagnostics payload.
   */
  function buildDiagnostics() {
    return {
      lifecycle_history: lifecycle.history(),
      api: api === null ? null : api.stats(),
      auth: auth === null ? null : auth.stats(),
      checkpoint: {
        path: config.state.path,
        corrupt_on_load: lastStateCorrupt,
        ...(stateFile === null ? {} : stateFile.counters()),
      },
      // Console v2 state: counters only (never a settings value, never a credential).
      console: consoleRouting === null ? null : {
        broker: consoleRouting.broker.stats(),
        chat: consoleRouting.quota.stats(),
        explain: consoleRouting.explain.stats(),
        approvals: consoleRouting.approvals.size(),
        settings: consoleRouting.settings.stats(),
      },
      detection_limits: DEFAULT_LIMITS,
    };
  }

  async function openStore() {
    if (injectedStore !== null) {
      await injectedStore.open?.();
      return injectedStore;
    }
    if (config.mode === 'mock') {
      const memory = createMemoryEventStoreAdapter({ clock });
      memory.open();
      return memory;
    }
    const adapter = createEventStoreAdapter({
      path: config.store.path,
      clock,
      busyTimeoutMs: config.store.busyTimeoutMs,
      allowedSummaryFields: config.policy.allowedSummaryFields,
      logger,
    });
    await adapter.open();
    return adapter;
  }

  async function start() {
    if (startPromise !== null) {
      return startPromise;
    }
    startPromise = (async () => {
      lifecycle.transition('starting');
      try {
        mkdirSync(config.dataDir, { recursive: true });
        // OPS-DIAG log retention: the shell hands the daemon its own stderr file, and
        // the data directory also holds rotated logs. Enforce the shared policy (8 MiB
        // per file / 64 MiB per directory / 7 days, active files protected) before the
        // first log line is written. A failure here must never stop the daemon: a
        // missing log directory is not a reason to refuse to collect.
        try {
          enforceLogRetention({ directories: [join(config.dataDir, 'shell'), join(config.dataDir, 'logs')] });
        } catch (error) {
          logger.warn?.('log retention failed', { reason: error?.code ?? 'LOG_RETENTION_FAILED' });
        }

        // --- checkpoint -----------------------------------------------------
        stateFile = createStateFile({ path: config.state.path, clock, logger });
        const loaded = stateFile.load();
        lastStateCorrupt = loaded.corrupt;
        const restored = loaded.state;
        epoch = config.policy.epoch ?? restored?.epoch ?? randomUUID();
        baseCounters = restored?.counters ?? null;
        bootCounters = zeroCounters();
        if (loaded.corrupt) {
          logger.warn?.('checkpoint was corrupt; starting from empty state', {
            quarantined: loaded.restored_from !== null,
          });
        }

        if (config.mode === 'full' && sources.length === 0) {
          throw new DaemonError(
            DAEMON_CODES.CONFIG_INVALID,
            'full mode requires at least one collector source',
          );
        }

        // --- storage --------------------------------------------------------
        try {
          store = observeStoreWrites(await openStore(), { logger, rejection: storeRejection, clock });
        } catch (error) {
          throw error instanceof DaemonError
            ? error
            : new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store could not be opened');
        }

        // --- detection ------------------------------------------------------
        detection = buildDetection(config, clock);

        pipeline = createPipeline({
          store,
          detection,
          createDetection: () => buildDetection(config, clock),
          epoch,
          allowedSummaryFields: config.policy.allowedSummaryFields,
          budgetClass: config.policy.budgetClass,
          alertStatus: config.policy.alertStatus,
          clock,
          logger,
        });

        // --- collection -----------------------------------------------------
        scheduler = createScheduler({
          sources,
          pipeline,
          clock,
          tickMs: config.scheduler.tickMs,
          sourceTimeoutMs: config.scheduler.sourceTimeoutMs,
          maxBatchEvents: config.scheduler.maxBatchEvents,
          staleAfterMs: config.scheduler.staleAfterMs,
          maxSources: config.scheduler.maxSources,
          cursors: restored?.sources ?? {},
          logger,
          onCursor: (sourceId, record) => {
            // Cursors are persisted on a short debounce: a poll every 5 seconds must
            // not turn into a rename-per-event storm, but a crash may lose at most
            // one debounce interval of cursor progress, which replays safely.
            if (cursorSaveTimer !== null) {
              return;
            }
            cursorSaveTimer = setTimeout(() => {
              cursorSaveTimer = null;
              try {
                persistState();
              } catch (error) {
                logger.warn?.('checkpoint write failed during collection', {
                  code: error?.code ?? 'STATE_WRITE_FAILED',
                  source_id: sourceId,
                });
              }
            }, 250);
            cursorSaveTimer.unref?.();
          },
        });

        // --- control API ----------------------------------------------------
        if (config.api.enabled) {
          const provisioned = provisionApiToken({
            token: config.api.token,
            tokenFile: config.api.tokenFile,
          });
          auth = createAuthGuard({
            token: provisioned.token,
            clock,
            failureLimit: config.api.authFailureLimit,
            failureWindowMs: config.api.authFailureWindowMs,
          });
          logger.info?.('control API token provisioned', { source: provisioned.source });
          // The read model wraps the store that is already open: mock mode reads the
          // in-memory adapter, full mode opens a separate read-only handle on first
          // query. It is constructed here so the API can never be listening with a
          // query handler that has nothing to read.
          readModel = createReadModel({
            store,
            storePath: config.store.path,
            clock,
            logger,
          });
          const readEndpoints = createReadEndpoints({ readModel, cursorKey: auth.cursorKey });

          // --- console v2 (contract §2) -------------------------------------
          // Paths are derived from `config.dataDir` here rather than added to
          // `config.js` (that file is frozen for this task): `<dataDir>/console/`
          // holds the settings document and the model-health cache.
          const consoleDir = join(config.dataDir, 'console');
          const settingsStore = createSettingsStore({
            filePath: join(consoleDir, 'settings.json'),
            clock,
            logger,
          });
          const healthCache = createHealthCache({
            filePath: join(consoleDir, 'model-health.json'),
            logger,
          });
          // Constructing the gateway touches nothing: the host script's existence is
          // resolved lazily and a missing host becomes a 503 at request time, never a
          // failed daemon start.
          const broker = createBrokerClient({ dataDir: config.dataDir, logger });
          const chatEngine = createChatEngine({ broker, logger });
          const approvals = createApprovalRegistry({ clock, logger });
          const chatQuota = createChatQuota();
          const explainLimiter = createExplainLimiter({ clock });
          const modelsHandlers = createModelsHandlers({
            settingsStore,
            broker,
            engine: chatEngine,
            healthCache,
            clock,
            logger,
          });
          const consoleHandlers = {
            getModels: modelsHandlers.getModels,
            testProvider: modelsHandlers.testProvider,
            ...createCredentialHandlers({ settingsStore, broker, logger }),
            ...createChatHandlers({
              settingsStore,
              engine: chatEngine,
              quota: chatQuota,
              approvals,
              clock,
              logger,
            }),
            ...createExplainHandlers({
              settingsStore,
              engine: chatEngine,
              alertLookup: createAlertLookup({
                store,
                storePath: config.store.path,
                clock,
                logger,
              }),
              limiter: explainLimiter,
              clock,
              logger,
            }),
            ...createSettingsHandlers({
              store: settingsStore,
              broker,
              logger,
              // Server-owned fields: the console renders them but a PUT may only echo
              // them back unchanged (contract §6).
              readOnly: () => ({
                response: { executionEnabled: false },
                update: { lastCheckedAt: null, currentVersion: DAEMON_VERSION },
                diagnostics: {
                  apiPort: api === null ? null : (api.address()?.port ?? null),
                  exportBundleLastAt: lastExportAt,
                },
              }),
            }),
          };
          // OPS-DIAG actions (contract §2.1 diagnostics). Both handlers are built
          // here rather than inside `consoleHandlers` because they need the live daemon
          // handle (status/diagnostics) and the token guard, not the settings store.
          const tokenRotation = createTokenRotation({
            auth,
            tokenFile: config.api.tokenFile,
            dataDir: config.dataDir,
            clock,
            logger,
          });
          const diagnosticsHandlers = createDiagnosticsHandlers({
            config,
            status: buildStatus,
            diagnostics: buildDiagnostics,
            dataDir: config.dataDir,
            // In mock mode there is no database file; the bundle reports that
            // honestly instead of opening a path that does not exist.
            storePath: config.mode === 'mock' ? null : config.store.path,
            clock,
            logger,
            onExported: (iso) => {
              lastExportAt = typeof iso === 'string' ? iso : clock.nowIso();
            },
          });
          consoleRouting = {
            broker,
            approvals,
            quota: chatQuota,
            explain: explainLimiter,
            settings: settingsStore,
          };
          api = createControlApi({
            config: {
              host: config.api.host,
              port: config.api.port,
              requestTimeoutMs: config.api.requestTimeoutMs,
              headersTimeoutMs: config.api.headersTimeoutMs,
              keepAliveTimeoutMs: config.api.keepAliveTimeoutMs,
              maxBodyBytes: config.api.maxBodyBytes,
              authFailureWindowMs: config.api.authFailureWindowMs,
            },
            auth,
            logger,
            handlers: {
              health: () => ({ status: health().status, version: DAEMON_VERSION }),
              ready: () => {
                const current = health();
                return {
                  ready: current.ready,
                  body: {
                    ready: current.ready,
                    lifecycle: lifecycle.state(),
                    reasons: current.reasons,
                  },
                };
              },
              status: () => buildStatus(),
              pollSource: async (sourceId) => {
                // The scheduler is the single authority for poll and event counters; the
                // handler must not add to them again or every on-demand poll counts twice.
                const after = await scheduler.pollNow(sourceId);
                if (after.lifecycle === 'degraded') {
                  bootCounters.source_failures += 1;
                }
                return after;
              },
              listAlerts: readEndpoints.listAlerts,
              listAnalyses: readEndpoints.listAnalyses,
              ...consoleHandlers,
              // OPS-DIAG: the two actions that used to answer 501
              // (`settings-schema.js`). The bundle handler is passed through unchanged
              // so the server writes the attachment; rotation is a promise because a
              // failed token write must surface as an error, never a partial success.
              exportDiagnosticsBundle: diagnosticsHandlers.exportDiagnosticsBundle,
              rotateApiToken: () => {
                // A token supplied by the configuration wins on every boot
                // (`provisionApiToken` prefers `api.token` over the file). Rotating in
                // that state would answer 200 and then be silently undone by the next
                // restart, so it is refused with a code the console can explain.
                if (provisioned.source === 'config') {
                  throw new ConsoleError(
                    CONSOLE_CODES.SETTINGS_LOCKED,
                    'the API token is pinned by configuration (api.token); rotation would be reverted on restart',
                    { reason: 'TOKEN_PINNED_BY_CONFIG' },
                  );
                }
                return tokenRotation.rotate();
              },
            },
          });
          const address = await api.start();
          logger.info?.('control API listening', { host: address.host, port: address.port });
        }

        // --- run ------------------------------------------------------------
        startedAtMs = clock.nowMs();
        scheduler.start();
        lifecycle.transition('running');
        persistState();
        return { epoch, address: api === null ? null : api.address() };
      } catch (error) {
        const failure = toDaemonError(error);
        logger.error?.('daemon start failed', { code: failure.code, message: failure.message });
        await releaseResources();
        try {
          lifecycle.transition('failed');
        } catch {
          // Already terminal; the failure below is the authoritative signal.
        }
        startPromise = null;
        throw failure;
      }
    })();
    return startPromise;
  }

  async function releaseResources() {
    const errors = [];
    // A pending cursor write must not fire after the state file is closed.
    if (cursorSaveTimer !== null) {
      clearTimeout(cursorSaveTimer);
      cursorSaveTimer = null;
    }
    if (scheduler !== null) {
      try {
        await scheduler.stop({ timeoutMs: config.shutdown.drainMs });
      } catch (error) {
        errors.push(toDaemonError(error));
      }
    }
    if (api !== null) {
      try {
        await api.close();
      } catch (error) {
        errors.push(toDaemonError(error));
      }
      api = null;
    }
    // After the API: a request that raced the shutdown can no longer reach the broker
    // gate, so every child this process spawned is now unreachable from outside and
    // can be reaped without racing a live stream.
    if (consoleRouting !== null) {
      try {
        await consoleRouting.broker.close();
      } catch (error) {
        errors.push(toDaemonError(error));
      }
      try {
        consoleRouting.approvals.close();
      } catch (error) {
        errors.push(toDaemonError(error));
      }
      consoleRouting = null;
    }
    // After the API, because `api.close()` destroys in-flight connections as it
    // goes (`closeAllConnections()`), so a request still being served ends with
    // `ECONNRESET` on the client — it never reaches the read model again and never
    // gets a 503. By the time the read-only handle closes there is no reader left
    // to interrupt. The order is still API-then-handle, but for the other half of
    // the reason: it guarantees no *new* reader can appear between the two steps.
    if (readModel !== null) {
      try {
        readModel.close();
      } catch (error) {
        errors.push(toDaemonError(error));
      }
      readModel = null;
    }
    if (stateFile !== null && lifecycle.is('running', 'stopping')) {
      try {
        persistState();
      } catch (error) {
        errors.push(toDaemonError(error));
      }
    }
    if (store !== null) {
      try {
        store.close();
      } catch (error) {
        errors.push(toDaemonError(error));
      }
    }
    if (stateFile !== null) {
      stateFile.close();
    }
    return errors;
  }

  function persistState() {
    if (stateFile === null || store === null) {
      return null;
    }
    const state = createEmptyState(epoch);
    state.sources = scheduler === null ? {} : scheduler.cursors();
    state.counters = mergedCounters();
    return stateFile.save(state);
  }

  async function stop(reason = 'requested') {
    if (stopPromise !== null) {
      return stopPromise;
    }
    stopPromise = (async () => {
      if (lifecycle.is('created')) {
        lifecycle.transition('stopped');
        return { stopped: true, reason, errors: [] };
      }
      if (lifecycle.is('stopped')) {
        return { stopped: true, reason, errors: [] };
      }
      try {
        lifecycle.transition('stopping');
      } catch (error) {
        return { stopped: false, reason, errors: [toDaemonError(error)] };
      }
      logger.info?.('daemon stopping', { reason });
      const errors = await releaseResources();
      try {
        lifecycle.transition('stopped');
      } catch (error) {
        errors.push(toDaemonError(error));
      }
      if (errors.length > 0) {
        logger.warn?.('daemon stopped with resource errors', { errors: errors.map((error) => error.code) });
      }
      return { stopped: true, reason, errors };
    })();
    return stopPromise;
  }

  return {
    start,
    stop,
    /**
     * Stop and swallow shutdown errors — the signal path must not throw.
     *
     * @param {string} [reason] Shutdown reason.
     * @returns {Promise<object>} Stop result.
     */
    async shutdown(reason = 'signal') {
      try {
        return await stop(reason);
      } catch (error) {
        logger.error?.('shutdown failed', { code: toDaemonError(error).code });
        return { stopped: false, reason, errors: [toDaemonError(error)] };
      }
    },
    status() {
      if (pipeline === null || scheduler === null || store === null) {
        return {
          version: DAEMON_VERSION,
          lifecycle: lifecycle.state(),
          mode: config.mode,
          started_at: lifecycle.startedAt(),
          started_at_ms: startedAtMs,
          epoch,
          health: { status: 'degraded', ready: false, reasons: ['not-started'] },
          scheduler: { sources: [], summary: {} },
          pipeline: null,
          store: null,
          counters: mergedCounters(),
          clock,
        };
      }
      return {
        version: DAEMON_VERSION,
        lifecycle: lifecycle.state(),
        mode: config.mode,
        started_at: lifecycle.startedAt(),
        started_at_ms: startedAtMs,
        epoch,
        health: health(),
        scheduler: statusView(),
        pipeline,
        store,
        counters: mergedCounters(),
        clock,
      };
    },
    /** Health aggregate as plain data. */
    health: () => health(),
    /** Readiness as plain data. */
    ready: () => {
      const current = health();
      return { ready: current.ready, reasons: current.reasons, lifecycle: lifecycle.state() };
    },
    /** Immediate poll of one source (control API path). */
    async pollSource(sourceId) {
      if (scheduler === null) {
        throw new DaemonError(DAEMON_CODES.LIFECYCLE_NOT_RUNNING, 'daemon is not running');
      }
      return scheduler.pollNow(sourceId);
    },
    /** Epoch this process is bound to. */
    epoch: () => epoch,
    /** Lifecycle state name. */
    state: () => lifecycle.state(),
    /** Bound API address, or `null` when the API is disabled. */
    address: () => (api === null ? null : api.address()),
    /** CSRF token for the authenticated client (derived, not the bearer token). */
    csrfToken: () => (auth === null ? null : auth.csrfToken),
    /** Diagnostics: counters, API stats and checkpoint health. */
    diagnostics() {
      return buildDiagnostics();
    },
    /** Configuration actually in force (paths included, secrets excluded). */
    config: () => ({
      dataDir: config.dataDir,
      mode: config.mode,
      store_path: config.store.path,
      state_path: config.state.path,
      api_host: config.api.host,
      api_port: config.api.port,
      epoch,
    }),
  };
}
