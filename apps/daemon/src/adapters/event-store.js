/**
 * adapters/event-store.js — the daemon's only door to persistence.
 *
 * The daemon is a **caller** of `@aegisharness/event-store`, never a second
 * transaction authority. Anything that decides what a transaction contains (T1's
 * event + findings + alerts + outbox + audit) lives in that package; this adapter
 * only translates a batch into the documented call and translates failures back
 * into daemon codes.
 *
 * Two implementations behind one interface:
 *
 * - {@link createMemoryEventStoreAdapter} — in-memory, faithful to the parts of T1
 *   that the pipeline relies on (event idempotency, alert count accumulation,
 *   "an analysis request needs its alert"). It exists so the daemon's own logic can
 *   be tested without SQLite and without touching a real database file.
 * - {@link createEventStoreAdapter} — the real thing, lazily imported so mock mode
 *   never loads `node:sqlite` at all.
 *
 * Interface (both implementations):
 *   kind                                      'memory' | 'sqlite'
 *   open()                                    -> void | Promise<void>
 *   hasEvent(eventId)                         -> boolean
 *   hasStableKeys(events)                     -> boolean[]   (ADR-0006)
 *   ingest({event, findings?, alerts?, analysisRequest?}) -> result
 *   findAlertId(fingerprint, windowStart)     -> string|null
 *   alertEvidence(fingerprint, windowStart)   -> {event_ids, truncated}|null (ADR-0007 §3.3)
 *   putContributionSpool(entry)               -> {spool_id}  (ADR-0007)
 *   listContributionSpool()                   -> {entries, skipped}
 *   deleteContributionSpool(spoolId)          -> boolean
 *   stats()                                   -> {events, alerts, findings, analyses}
 *   close()                                   -> void
 */

import { DaemonError, DAEMON_CODES, isDaemonError } from '../errors.js';

/** Severity ordering used only by the in-memory merge. */
const SEVERITY_RANK = Object.freeze({
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
});

/** How long a `stats()` snapshot may be reused without an intervening write. */
const STATS_CACHE_MS = 1000;

function dedupeKeyOf(event) {
  if (typeof event.native_record_id === 'string' && event.native_record_id.length > 0) {
    return `native:${event.native_record_id}`;
  }
  return `seq:${event.source_seq}`;
}

/**
 * 内存适配器侧的稳定键派生。
 *
 * 这是一份**刻意的重复**：mock 模式不能加载 `@aegisharness/event-store`（它会拉进
 * `node:sqlite`），所以没法直接复用那个包的 `stableKeyOf`。为免两份漂移，
 * `tests/wp5-daemon/adapters.test.js` 用真实包的 `stableKeyOf` 逐例对拍。
 *
 * @param {{stable_source_id: string, source_generation: number, native_record_id?: string, source_seq?: number}} event 事件。
 * @returns {string} 组合键。
 */
function stableKeyOf(event) {
  return `${event.stable_source_id}\u0000${event.source_generation}\u0000${dedupeKeyOf(event)}`;
}

/**
 * In-memory event store used by mock mode and by the daemon's own tests.
 *
 * It deliberately keeps the *contract* of T1 and nothing more: no SQL, no schema
 * migration, no audit chain. If the pipeline starts depending on a behaviour that
 * only this object has, the memory adapter is the thing that must change.
 *
 * @param {{clock?: {nowIso: () => string}, failWrites?: boolean}} [options] Options.
 * @returns {object} Event store adapter.
 */
export function createMemoryEventStoreAdapter(options = {}) {
  const clock = options.clock ?? { nowIso: () => new Date().toISOString() };
  const events = new Map();
  const byStableKey = new Map();
  const alerts = new Map();
  const findings = new Map();
  const analyses = new Map();
  /** 待补记条目的内存镜像（ADR-0007）。键是内容键，与 sqlite 适配器的 `spool_id` 语义相同、编码不同。 */
  const contributionSpool = new Map();
  let failWrites = options.failWrites === true;
  let failSpool = options.failSpool === true;
  let opened = false;
  let closed = false;

  /** 内容键：来源 + 窗口键集合 + 证据 id 集合（只是缓存键，不跨适配器比较）。 */
  function spoolKeyOf(entry) {
    const windows = [...new Set(entry.alerts.map((alert) => `${alert.fingerprint}\u0000${alert.window_start}`))].sort();
    const ids = [...new Set(entry.alerts.flatMap((alert) => alert.event_ids ?? []))].sort();
    return JSON.stringify([entry.source_id ?? null, windows, ids]);
  }

  /**
   * Report whether an alert row with this id will exist after this call commits.
   *
   * Mirrors T1 exactly: `upsertAlert` keeps the **existing** row's `alert_id` when
   * the `(fingerprint, window_start)` key is already present, and inserts the
   * incoming id only when it is not. A request naming the engine's fresh id for an
   * already-existing window therefore fails in the real store, and must fail here
   * too — a more permissive double would hide that whole class of defect.
   *
   * @param {string} alertId Id the request names.
   * @param {readonly object[]} incoming Alerts carried by this call.
   * @returns {boolean} `true` when the row will exist.
   */
  function willHoldAlert(alertId, incoming) {
    for (const alert of alerts.values()) {
      if (alert.alert_id === alertId) {
        return true;
      }
    }
    for (const alert of incoming) {
      const key = `${alert.fingerprint}\u0000${alert.window_start}`;
      if (alert.alert_id === alertId && !alerts.has(key)) {
        return true;
      }
    }
    return false;
  }

  function guardWrite() {
    if (closed) {
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is closed');
    }
    if (failWrites) {
      throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected store failure');
    }
  }

  return {
    kind: 'memory',
    open() {
      opened = true;
      closed = false;
    },
    hasEvent(eventId) {
      return events.has(eventId);
    },
    /**
     * 按稳定键（stable_source_id + source_generation + 原生 ID / source_seq）批量判定。
     *
     * 必须与真实 T1 的判重口径一致：同一 `source_seq` 换了 `event_id` 仍然算"已有"。
     * 只按 `event_id` 判断是本轮 P1 的根因（ADR-0006 §1）。
     *
     * @param {readonly object[]} list 待判定的事件。
     * @returns {boolean[]} 与 `list` 等长同序。
     */
    hasStableKeys(list) {
      if (!Array.isArray(list)) {
        throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'hasStableKeys expects an array of events');
      }
      return list.map((event) => byStableKey.has(stableKeyOf(event)));
    },
    /**
     * 暴露稳定键的编码，仅供调用方做**批内**相等比较（同一批里出现同键事件）。
     *
     * 编码是适配器内部约定，不跨适配器比较，也不写进任何 DTO；调用方只能拿它做 Set 键。
     *
     * @param {readonly object[]} list 事件数组。
     * @returns {string[]} 等长同序的不透明键。
     */
    stableKeysOf(list) {
      if (!Array.isArray(list)) {
        throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'stableKeysOf expects an array of events');
      }
      return list.map((event) => stableKeyOf(event));
    },
    /**
     * Look up the id of the alert row a `(fingerprint, window_start)` key resolves to.
     *
     * @param {string} fingerprint Alert fingerprint.
     * @param {string} windowStartIso Window start as RFC3339 UTC.
     * @returns {string|null} Stored alert id.
     */
    findAlertId(fingerprint, windowStartIso) {
      const key = `${fingerprint}\u0000${windowStartIso}`;
      const found = alerts.get(key);
      return found === undefined ? null : found.alert_id;
    },
    /**
     * 该告警行自己的证据 id（ADR-0007 §3.3）。
     *
     * 补记的幂等条件要用它：若某个 id 已经在行里，再"补"一次就会双计。
     *
     * @param {string} fingerprint 指纹。
     * @param {string} windowStartIso 窗口起点。
     * @returns {{event_ids: string[], truncated: boolean}|null} 行不存在时返回 `null`。
     */
    alertEvidence(fingerprint, windowStartIso) {
      const found = alerts.get(`${fingerprint}\u0000${windowStartIso}`);
      if (found === undefined) {
        return null;
      }
      return Object.freeze({
        event_ids: Object.freeze([...found.event_ids]),
        truncated: found.event_ids_truncated === true,
      });
    },
    // --- 待补记 spool（ADR-0007）------------------------------------------
    putContributionSpool(entry) {
      if (closed) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is closed');
      }
      if (failSpool) {
        throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool failure');
      }
      const key = spoolKeyOf(entry);
      contributionSpool.set(key, {
        spool_id: key,
        source_id: entry.source_id ?? null,
        attempts: entry.attempts ?? 0,
        alerts: [...entry.alerts],
        requests: [...entry.requests],
      });
      return Object.freeze({ spool_id: key });
    },
    listContributionSpool() {
      return { entries: [...contributionSpool.values()].map((entry) => ({ ...entry })), skipped: 0 };
    },
    deleteContributionSpool(spoolId) {
      if (closed) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is closed');
      }
      if (failSpool) {
        throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'injected spool failure');
      }
      return contributionSpool.delete(spoolId);
    },
    ingest(input) {
      guardWrite();
      if (input === null || typeof input !== 'object' || input.event === undefined) {
        throw new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, 'ingest requires an event');
      }
      const { event } = input;
      const key = stableKeyOf(event);
      const duplicate = events.has(event.event_id) || byStableKey.has(key);
      if (duplicate) {
        const existing = events.get(event.event_id) ?? events.get(byStableKey.get(key));
        return Object.freeze({
          duplicate: true,
          event_id: existing.event_id,
          findings: Object.freeze([]),
          alerts: Object.freeze([]),
          analysis_id: null,
        });
      }

      // Validation happens before any mutation, mirroring T1: the real store
      // validates the request outside the transaction, so a rejected request must
      // leave the database untouched. A double that stored the event first would
      // hide exactly the bug this assertion is meant to catch.
      const request = input.analysisRequest ?? null;
      if (request !== null && !willHoldAlert(request.alert_id, input.alerts ?? [])) {
        throw new DaemonError(
          DAEMON_CODES.STORE_WRITE_FAILED,
          'analysis request references an unknown alert',
          { alert_id: request.alert_id },
        );
      }

      events.set(event.event_id, event);
      byStableKey.set(key, event.event_id);

      const writtenFindings = [];
      for (const finding of input.findings ?? []) {
        const previous = findings.get(finding.finding_id);
        findings.set(finding.finding_id, {
          ...finding,
          count: previous === undefined ? finding.count : previous.count + finding.count,
        });
        writtenFindings.push(Object.freeze({ finding_id: finding.finding_id, created: previous === undefined }));
      }

      const writtenAlerts = [];
      for (const alert of input.alerts ?? []) {
        const key2 = `${alert.fingerprint}\u0000${alert.window_start}`;
        const previous = alerts.get(key2);
        if (previous === undefined) {
          alerts.set(key2, { ...alert });
          writtenAlerts.push(Object.freeze({ alert_id: alert.alert_id, created: true, count: alert.count }));
          continue;
        }
        const mergedCount = previous.count + alert.count;
        // Mirror the store's merge semantics: count adds, event ids union, the
        // window and seen bounds widen, and severity only ever rises.
        const mergedIds = [...new Set([...previous.event_ids, ...alert.event_ids])];
        alerts.set(key2, {
          ...previous,
          count: mergedCount,
          event_ids: mergedIds,
          first_seen: previous.first_seen <= alert.first_seen ? previous.first_seen : alert.first_seen,
          last_seen: previous.last_seen >= alert.last_seen ? previous.last_seen : alert.last_seen,
          severity: SEVERITY_RANK[alert.severity] > SEVERITY_RANK[previous.severity]
            ? alert.severity
            : previous.severity,
          event_ids_truncated: previous.event_ids_truncated || alert.event_ids_truncated,
        });
        writtenAlerts.push(Object.freeze({ alert_id: previous.alert_id, created: false, count: mergedCount }));
      }

      let analysisId = null;
      if (request !== null) {
        if (analyses.has(request.idempotency_key)) {
          analysisId = analyses.get(request.idempotency_key).analysis_id;
        } else {
          analyses.set(request.idempotency_key, { ...request, state: 'queued' });
          analysisId = request.analysis_id;
        }
      }

      return Object.freeze({
        duplicate: false,
        event_id: event.event_id,
        ingest_seq: events.size,
        findings: Object.freeze(writtenFindings),
        alerts: Object.freeze(writtenAlerts),
        analysis_id: analysisId,
        recorded_at: clock.nowIso(),
      });
    },
    stats() {
      return {
        events: events.size,
        alerts: alerts.size,
        findings: findings.size,
        analyses: analyses.size,
      };
    },
    /** Test hook: make every subsequent write fail (fault-closed coverage). */
    setFailWrites(value) {
      failWrites = value === true;
    },
    /** Test hook: make spool persistence fail while normal writes keep working (ADR-0007 I5). */
    setFailSpool(value) {
      failSpool = value === true;
    },
    /**
     * Introspection for tests and mock-mode diagnostics.
     *
     * Returns shallow copies: a caller must not be able to mutate the store by
     * editing an object it received here.
     */
    dump() {
      return {
        events: [...events.values()].map((event) => structuredClone(event)),
        alerts: [...alerts.values()].map((alert) => structuredClone(alert)),
        findings: [...findings.values()].map((finding) => structuredClone(finding)),
        analyses: [...analyses.values()].map((analysis) => structuredClone(analysis)),
        contribution_spool: [...contributionSpool.values()].map((entry) => structuredClone(entry)),
      };
    },
    isOpen: () => opened && !closed,
    close() {
      closed = true;
      opened = false;
    },
  };
}

/**
 * Real event-store adapter.
 *
 * `open()` imports the package lazily. In full mode a failed import or a failed
 * migration is fatal: the daemon must not run without its single writer.
 *
 * @param {{
 *   path: string,
 *   clock?: object,
 *   busyTimeoutMs?: number,
 *   allowedSummaryFields?: readonly string[],
 *   allowClassification?: readonly string[],
 *   logger?: object
 * }} options Options.
 * @returns {object} Event store adapter.
 */
export function createEventStoreAdapter(options) {
  const { path: storePath } = options;
  if (typeof storePath !== 'string' || storePath.length === 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'event store adapter requires a path');
  }
  const allowedSummaryFields = options.allowedSummaryFields ?? [];
  const allowClassification = options.allowClassification;
  const logger = options.logger ?? null;

  /** @type {null | {handle: object, api: object}} */
  let binding = null;
  /** @type {null | {at: number, value: object}} */
  let statsCache = null;

  function wrap(error, operation) {
    if (isDaemonError(error)) {
      return error;
    }
    return new DaemonError(DAEMON_CODES.STORE_WRITE_FAILED, `event store ${operation} failed`, {
      reason: error?.code ?? error?.name ?? 'UNKNOWN',
    });
  }

  /** 当前时间（RFC3339）。spool 行的时间列只用于诊断排序，不参与任何判定。 */
  function nowIso() {
    return options.clock?.nowIso?.() ?? new Date().toISOString();
  }

  /**
   * Does the store already hold this `event_id`? Fails closed on a closed handle.
   *
   * @param {string} eventId Event id.
   * @returns {boolean} `true` when a row exists.
   */
  function hasEventId(eventId) {
    if (binding === null) {
      // Fail closed: reporting "unknown event" for a closed store would make the
      // pipeline try to write, and would hide the real state from the operator.
      throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
    }
    try {
      return binding.api.getEvent(binding.handle, eventId) !== null;
    } catch (error) {
      throw wrap(error, 'read');
    }
  }

  return {
    kind: 'sqlite',
    async open() {
      let api;
      try {
        api = await import('@aegisharness/event-store');
      } catch (error) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store package is not available', {
          reason: error?.code ?? 'IMPORT_FAILED',
        });
      }
      let handle;
      try {
        handle = api.openStore({
          path: storePath,
          busyTimeoutMs: options.busyTimeoutMs,
          clock: options.clock,
        });
        api.migrate(handle, { preMigrationBackup: true });
      } catch (error) {
        try {
          handle?.close?.();
        } catch {
          // Nothing to salvage from a store that never opened.
        }
        logger?.error?.('event store could not be opened', { reason: error?.code ?? 'OPEN_FAILED' });
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store could not be opened', {
          reason: error?.code ?? 'OPEN_FAILED',
        });
      }
      binding = { handle, api };
    },
    hasEvent(eventId) {
      return hasEventId(eventId);
    },
    /**
     * 按稳定键批量判定是否已入库（ADR-0006）。
     *
     * 派生与查询都交给 `@aegisharness/event-store`：这里**不重写** `dedupe_key` 规则，
     * 否则判重语义又会出现第二份实现——正是 M5 P1 的成因。
     *
     * 返回的只有布尔：接口不允许带出事件内容（ADR-0006 §2.2）。
     *
     * @param {readonly object[]} list 待判定的事件。
     * @returns {boolean[]} 与 `list` 等长同序。
     */
    hasStableKeys(list) {
      if (binding === null) {
        // 与 hasEvent 同样 fail closed：报"都不存在"会让 pipeline 去写，掩盖真实状态。
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      if (!Array.isArray(list)) {
        throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'hasStableKeys expects an array of events');
      }
      if (list.length === 0) {
        return [];
      }
      try {
        const keys = list.map((event) => binding.api.stableKeyOf(event));
        const flags = binding.api.hasDedupeKeys(binding.handle, keys);
        return [...flags];
      } catch (error) {
        // `ERR_STORE_INPUT` here means at least one *event* is out of contract (missing or
        // mistyped identity fields), not that the store is broken. Probe key by key: the
        // good events keep their stable-key answer, and the bad one is reported as
        // "unknown" so T1 rejects exactly that one. Falling back to `event_id` for the
        // whole batch would silently disable stable-key de-duplication and let a
        // new-id replay through — the very defect this interface exists to close.
        if (error?.code === 'ERR_STORE_INPUT') {
          const perEvent = [];
          for (const event of list) {
            try {
              perEvent.push(binding.api.hasDedupeKeys(binding.handle, [binding.api.stableKeyOf(event)])[0] === true);
            } catch (inner) {
              if (inner?.code !== 'ERR_STORE_INPUT') {
                throw wrap(inner, 'read');
              }
              perEvent.push(false);
            }
          }
          return perEvent;
        }
        throw wrap(error, 'read');
      }
    },
    /**
     * 暴露稳定键的编码，仅供调用方做**批内**相等比较。
     *
     * 与 `hasStableKeys` 同源（都由 `api.stableKeyOf` 派生），不复制规则。
     *
     * @param {readonly object[]} list 事件数组。
     * @returns {string[]} 等长同序的不透明键。
     */
    stableKeysOf(list) {
      if (binding === null) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      if (!Array.isArray(list)) {
        throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'stableKeysOf expects an array of events');
      }
      return list.map((event) => {
        const key = binding.api.stableKeyOf(event);
        return `${key.stable_source_id}\u0000${key.source_generation}\u0000${key.dedupe_key}`;
      });
    },
    /**
     * Resolve the alert id stored for a `(fingerprint, window_start)` key.
     *
     * This is a read of the same key T1 uses for its insert-or-merge decision, not a
     * second copy of that decision: the daemon needs the id that already exists so an
     * analysis request after a restart does not name an id the store never stored.
     * The query lives in the adapter so a schema change stays contained here.
     *
     * @param {string} fingerprint Alert fingerprint.
     * @param {string} windowStartIso Window start as RFC3339 UTC.
     * @returns {string|null} Stored alert id, or `null` when no row exists yet.
     */
    findAlertId(fingerprint, windowStartIso) {
      if (binding === null) {
        return null;
      }
      try {
        const row = binding.handle.get(
          'SELECT alert_id FROM alert WHERE fingerprint = ? AND window_start = ?',
          [fingerprint, windowStartIso],
        );
        if (row === null || row === undefined) {
          return null;
        }
        return String(row.alert_id);
      } catch (error) {
        throw wrap(error, 'read');
      }
    },
    /**
     * 该告警行自己的证据 id（ADR-0007 §3.3）。
     *
     * 只返回 `alert` 行里 daemon 自己写进去的 `event_ids`，不返回遥测内容、不返回时间戳：
     * 它只用于"这条证据是不是已经被行认领"这一个判断。
     *
     * @param {string} fingerprint 指纹。
     * @param {string} windowStartIso 窗口起点（RFC3339 UTC）。
     * @returns {{event_ids: string[], truncated: boolean}|null} 行不存在时 `null`。
     */
    alertEvidence(fingerprint, windowStartIso) {
      if (binding === null) {
        return null;
      }
      try {
        const row = binding.handle.get(
          'SELECT event_ids_json, event_ids_truncated FROM alert WHERE fingerprint = ? AND window_start = ?',
          [fingerprint, windowStartIso],
        );
        if (row === null || row === undefined) {
          return null;
        }
        const parsed = JSON.parse(String(row.event_ids_json));
        return Object.freeze({
          event_ids: Object.freeze(Array.isArray(parsed) ? parsed.map((id) => String(id)) : []),
          truncated: Number(row.event_ids_truncated) === 1,
        });
      } catch (error) {
        throw wrap(error, 'read');
      }
    },
    // --- 待补记 spool（ADR-0007）------------------------------------------
    putContributionSpool(entry) {
      if (binding === null) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      try {
        return binding.api.putContributionSpool(binding.handle, entry, nowIso());
      } catch (error) {
        throw wrap(error, 'write');
      }
    },
    listContributionSpool() {
      if (binding === null) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      try {
        return binding.api.listContributionSpool(binding.handle);
      } catch (error) {
        throw wrap(error, 'read');
      }
    },
    deleteContributionSpool(spoolId) {
      if (binding === null) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      try {
        return binding.api.deleteContributionSpool(binding.handle, spoolId);
      } catch (error) {
        throw wrap(error, 'write');
      }
    },
    /**
     * Write several ingest requests inside **one** T1 transaction (PERF-CPU N-034).
     *
     * The daemon used to call `ingest()` once per event: with `synchronous=FULL` that is one
     * `fsync` per event — 2009 transactions in the 330 s measured window, and the first 385-event
     * snapshot held the event loop for ~45 s. This entry point forwards to the store's
     * `ingestTelemetryBatch()`, which keeps one transaction (`T1-batch`), validates outside it,
     * and isolates a single bad event with an inner savepoint.
     *
     * Contract carried over unchanged: `results[i]` corresponds to `inputs[i]`, a per-item failure
     * rolls back only that item, and a throw means the whole transaction rolled back (nothing
     * written), which is what lets the scheduler replay the batch from its frozen cursor.
     *
     * @param {readonly object[]} inputs Ingest requests, same shape as `ingest()`.
     * @returns {{received: number, accepted: number, duplicates: number, failed: number,
     *   results: readonly {ok: boolean, value?: object, error?: Error}[]}|null} Batch result,
     *   or `null` when this store build has no batch entry point.
     * @throws {DaemonError} When the store is closed or the whole batch rolled back.
     */
    ingestBatch(inputs) {
      if (binding === null) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      const list = Array.isArray(inputs) ? inputs : [];
      if (list.length === 0) {
        return { received: 0, accepted: 0, duplicates: 0, failed: 0, results: [] };
      }
      if (typeof binding.api.ingestTelemetryBatch !== 'function') {
        return null;
      }
      try {
        const result = binding.api.ingestTelemetryBatch(binding.handle, { events: list });
        statsCache = null;
        return result;
      } catch (error) {
        throw wrap(error, 'write');
      }
    },
    ingest(input) {
      if (binding === null) {
        throw new DaemonError(DAEMON_CODES.STORE_UNAVAILABLE, 'event store is not open');
      }
      const request = { event: input.event };
      if (input.findings !== undefined && input.findings.length > 0) {
        request.findings = [...input.findings];
      }
      if (input.alerts !== undefined && input.alerts.length > 0) {
        request.alerts = [...input.alerts];
      }
      if (input.analysisRequest !== undefined && input.analysisRequest !== null) {
        request.analysisRequest = input.analysisRequest;
        request.allowedSummaryFields = [...allowedSummaryFields];
        if (allowClassification !== undefined) {
          request.allowClassification = [...allowClassification];
        }
      }
      try {
        const result = binding.api.ingestTelemetry(binding.handle, request);
        statsCache = null;
        return result;
      } catch (error) {
        throw wrap(error, 'write');
      }
    },
    stats() {
      if (binding === null) {
        return { events: 0, alerts: 0, findings: 0, analyses: 0 };
      }
      // `COUNT(*)` on a million-row table is a scan on a synchronous driver: a client
      // polling `/status` would block the event loop and stall collection. The cache
      // is invalidated by every write, so it can never report a stale count after a
      // commit — only a repeated read of an unchanged table is served from memory.
      const now = options.clock?.monoMs?.() ?? 0;
      if (statsCache !== null && now - statsCache.at < STATS_CACHE_MS) {
        return statsCache.value;
      }
      const { handle } = binding;
      const count = (sql) => Number(handle.get(sql).c ?? 0);
      try {
        const value = {
          events: count('SELECT COUNT(*) AS c FROM telemetry_event'),
          alerts: count('SELECT COUNT(*) AS c FROM alert'),
          findings: count('SELECT COUNT(*) AS c FROM finding'),
          analyses: count('SELECT COUNT(*) AS c FROM analysis_outbox'),
        };
        statsCache = { at: now, value };
        return value;
      } catch (error) {
        throw wrap(error, 'status');
      }
    },
    isOpen: () => binding !== null,
    close() {
      if (binding === null) {
        return;
      }
      try {
        binding.handle.close();
      } finally {
        binding = null;
      }
    },
  };
}
