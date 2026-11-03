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

import { createDetectionEngine, DEFAULT_LIMITS, loadRulePack, validateRulePack } from '@aegisharness/detection';

import { createEventStoreAdapter, createMemoryEventStoreAdapter } from './adapters/event-store.js';
import { assertSources } from './adapters/collector.js';
import { createAuthGuard, provisionApiToken } from './api/auth.js';
import { createReadEndpoints } from './api/read-endpoints.js';
import { createReadModel } from './api/read-model.js';
import { createControlApi } from './api/server.js';
import { assertClock, createSystemClock } from './clock.js';
import { loadConfig } from './config.js';
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

  const sources = assertSources(options.sources ?? [], config.scheduler.maxSources);
  const injectedStore = options.store ?? null;

  let store = null;
  let detection = null;
  let pipeline = null;
  let scheduler = null;
  let api = null;
  let auth = null;
  let readModel = null;
  let stateFile = null;
  let epoch = null;
  let startedAtMs = null;
  let startPromise = null;
  let stopPromise = null;
  let baseCounters = null;
  let lastStateCorrupt = false;
  let bootCounters = null;
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
    };
    const output = {};
    for (const key of Object.keys(current)) {
      output[key] = (base[key] ?? 0) + (current[key] ?? 0);
    }
    return output;
  }

  function health() {
    const sourcesStatus = scheduler === null ? [] : scheduler.status();
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
          store = await openStore();
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
              status: () => buildStatusPayload({
                version: DAEMON_VERSION,
                lifecycle: lifecycle.state(),
                startedAt: lifecycle.startedAt(),
                startedAtMs,
                clock,
                epoch,
                mode: config.mode,
                scheduler,
                pipeline,
                store,
                health: health(),
                counters: mergedCounters(),
              }),
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
        scheduler,
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
      return {
        lifecycle_history: lifecycle.history(),
        api: api === null ? null : api.stats(),
        auth: auth === null ? null : auth.stats(),
        checkpoint: {
          path: config.state.path,
          corrupt_on_load: lastStateCorrupt,
          ...(stateFile === null ? {} : stateFile.counters()),
        },
        detection_limits: DEFAULT_LIMITS,
      };
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
