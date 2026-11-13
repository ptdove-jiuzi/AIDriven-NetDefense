/**
 * pipeline.js — collect → detect → persist, for one batch at a time.
 *
 * The pipeline owns *orchestration* only. It never re-implements a transaction:
 * every write goes through the injected event-store adapter, whose real
 * implementation is a thin call into `ingestTelemetry` (T1). If you find yourself
 * writing SQL here, the design has been broken.
 *
 * ## Order of operations, and why
 *
 * 1. **Drop events the store already has.** The filter asks the store about the
 *    *stable source key* — `(stable_source_id, source_generation, native id or
 *    source_seq)` — not the `event_id`, because that is the key T1 actually dedupes
 *    on (ADR-0006). Filtering on `event_id` alone let a replay through with a fresh
 *    id, which detection then counted as a new observation while T1 wrote nothing:
 *    `alert.count` inflated and `event_ids` gained an id that was never stored.
 *    Without any filter, a replay after restart would also emit a *second* alert for
 *    the same fingerprint — T1's idempotency dedupes the event, not the alert
 *    derived from it.
 * 2. **Detect on the surviving batch.** Detection is pure and in-memory, so a
 *    detection fault cannot have written anything yet.
 * 3. **Plan the T1 calls.** One anchor event per derived object, and alerts carry
 *    the batch's *contribution* rather than the window total (see
 *    `detection-bridge.js` for why that is the only correct choice with an additive
 *    upsert).
 * 4. **Write.** One `ingest` per event; the events that carry derived objects
 *    include them, so T1 stays the single atomic unit.
 *
 * ## Failure handling (design §12)
 *
 * - A store write failure degrades persistence but does not stop the loop: the
 *   failure is counted, the batch's remaining events are attempted, and the caller
 *   (the scheduler) refuses to advance the cursor so the batch replays.
 * - A detection fault freezes the engine (its documented behaviour). The events of
 *   that batch are still persisted — losing telemetry because a rule broke would be
 *   worse — the engine is rebuilt from the rule pack, and the freeze is counted.
 *   Rebuilding means the next batch starts with empty aggregate state; that is the
 *   detection package's documented recovery ("discard and rebuild").
 */

import { buildWritePlan, toDetectionBatch } from './detection-bridge.js';
import { DaemonError, DAEMON_CODES, isDaemonError } from './errors.js';

function emptyCounters() {
  return {
    batches: 0,
    events_received: 0,
    events_accepted: 0,
    events_duplicate: 0,
    events_rejected: 0,
    events_dropped: 0,
    alerts_written: 0,
    findings_written: 0,
    analysis_requests: 0,
    alerts_without_new_observation: 0,
    alerts_truncated: 0,
    alerts_dropped: 0,
    requests_dropped: 0,
    /** Contributions waiting for a successful T1 call to ride on. */
    contributions_pending: 0,
    /** Entries recovered from the durable spool at startup (ADR-0007). */
    contributions_recovered: 0,
    /** Recovered rows dropped at startup because the stored rows already claim all their evidence. */
    contributions_reconciled: 0,
    /** Spool read/write/delete failures: the queue is then memory-only, which must be visible. */
    contributions_spool_errors: 0,
    contributions_retried: 0,
    contributions_attach_attempts: 0,
    contributions_dropped: 0,
    /** Retained alerts whose window this batch already re-counted from fresh evidence. */
    contributions_superseded: 0,
    /** Cumulative, for diagnostics and the checkpoint. */
    store_errors: 0,
    /** Resets on a clean batch; this is what health uses. */
    store_errors_consecutive: 0,
    detection_faults: 0,
    detection_rebuilds: 0,
    // PERF-CPU N-034: the write-path shape has to be observable, otherwise "the transaction count
    // went down" cannot be checked from `/status`. `store_calls` is the number of store write
    // entry points invoked (one T1 transaction each, on the real store); `store_batch_calls` is how
    // many of those were batch calls. Before the change store_calls == events_accepted.
    store_calls: 0,
    store_batch_calls: 0,
    /** Batches that had at least one per-item write failure (the safety valve then disables batching). */
    batch_partial_failures: 0,
  };
}

/**
 * Create the detection → storage pipeline.
 *
 * @param {{
 *   store: object,
 *   detection: object,
 *   createDetection?: () => object,
 *   epoch: string,
 *   allowedSummaryFields?: readonly string[],
 *   budgetClass?: string,
 *   alertStatus?: string,
 *   clock?: object,
 *   logger?: object
 * }} options Pipeline options.
 * @returns {object} Pipeline handle.
 */
export function createPipeline(options) {
  if (options === null || typeof options !== 'object') {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'pipeline requires an options object');
  }
  const store = options.store;
  const epoch = options.epoch;
  if (typeof epoch !== 'string' || epoch.length === 0) {
    throw new DaemonError(DAEMON_CODES.CONFIG_INVALID, 'pipeline requires an epoch');
  }
  if (store === null || typeof store !== 'object' || typeof store.ingest !== 'function') {
    throw new DaemonError(DAEMON_CODES.STORE_REQUIRED, 'pipeline requires an event store adapter');
  }
  /** @type {object} */
  let engine = options.detection;
  if (engine === null || typeof engine !== 'object' || typeof engine.ingest !== 'function') {
    throw new DaemonError(DAEMON_CODES.DETECTION_UNAVAILABLE, 'pipeline requires a detection engine');
  }
  const createDetection = typeof options.createDetection === 'function' ? options.createDetection : null;
  const logger = options.logger ?? null;
  const counters = emptyCounters();
  /**
   * PERF-CPU N-034 — batched write path.
   *
   * `batchFlushMax` bounds one T1 transaction. It is a *count* bound, not a time bound, because
   * `ingestBatch()` is synchronous: the chunk is written before the call returns, so nothing can
   * be held back across a poll and event→alert latency is unchanged by batching.
   *
   * `batchWritesEnabled` is the safety valve: the first time a store cannot batch (no `ingestBatch`
   * entry point, or a run that was partially rejected) it turns `false` for the rest of the process
   * and the proven per-event path takes over.
   */
  const batchFlushMax = Number.isInteger(options.batchFlushMax) && options.batchFlushMax > 0
    ? options.batchFlushMax
    : 200;
  // Default **on**: batching is the measured fix for the fsync-per-event write amplification, and a
  // flag that defaults off is a fix that does not exist in production. `AEGIS_DAEMON_BATCH_WRITES=0`
  // is kept as the emergency/mutation switch (acceptor uses it as M1). An explicit
  // `options.batchWrites` wins over the environment, so a test can pin the path it is testing.
  let batchWritesEnabled = typeof options.batchWrites === 'boolean'
    ? options.batchWrites
    : process.env.AEGIS_DAEMON_BATCH_WRITES !== '0';
  /**
   * Alert contributions that could not be written because their anchor event's T1
   * call failed.
   *
   * They cannot simply be left to replay: the anchor event is retried, but the
   * detection engine has already seen it (`seenEventIds`), so the replay produces no
   * detection and the contribution would never be rebuilt. They also cannot be
   * written on their own — T1 is per event. So they are retained here and attached to
   * the next batch's last event, which is exactly the anchoring rule used normally.
   *
   * Bounded, and counted: `contributions_pending` is a health reason, so a stuck
   * contribution is visible instead of silent.
   */
  let pendingContributions = [];
  /**
   * There is deliberately **no capacity limit** on this queue (P1-6 / P1-7 / P1-8).
   *
   * Three attempts at a bound all failed the same way. A global "evict oldest" let one
   * source push out another's deferred evidence. A global "refuse the new entry once full"
   * moved the loss to whoever failed next. A per-source quota kept the loss local but still
   * discarded evidence that *was about to become recoverable*: the cursor does not advance
   * after a store error, so the batch replays, the event lands, and `count` never claims it
   * — a permanent undercount with `truncated=false`, which reads as "evidence complete".
   *
   * So the queue is bounded by **work**, not by a constant: an entry is created only when a
   * write fails, and the normal path removes it on the very next successful attach (the
   * replay carries the event). What stays behind is proportional to the writes that are
   * still failing — and that is already the degraded condition the operator sees as
   * `pendingContributions` on `/status` and in health. The only other exit is the attach
   * budget below, which is spent on real attach attempts of that entry's own source.
   */
  /**
   * A poison entry must not stall the source forever; after this many attaches it is dropped.
   *
   * This is the *only* way a contribution is discarded besides "its evidence provably cannot
   * exist", and it is driven by real attempts from the source that produced it. Every drop is
   * observation-counted, logged and surfaced in health (ADR-0007 §3.4 / I4).
   */
  const MAX_CONTRIBUTION_ATTACH_ATTEMPTS = 8;

  /**
   * The durable half of the queue (ADR-0007).
   *
   * `pendingContributions` stays the in-process index — it is what attach iterates — but it is no
   * longer the only copy: a contribution that only exists in memory dies with the process, and the
   * event it describes is already stored and already seen by the engine, so nothing will ever
   * re-claim that observation. That is the round 12/13 P1 (ADR-0007 §1.2).
   *
   * `null` means "this store cannot persist contributions" (legacy doubles): behaviour is exactly
   * the pre-ADR one, and `contributions_spool_errors` stays 0 because nothing was attempted.
   */
  const spool = typeof store.putContributionSpool === 'function'
    && typeof store.listContributionSpool === 'function'
    && typeof store.deleteContributionSpool === 'function'
    ? store
    : null;

  /**
   * Write one entry to the durable spool and return it with its `spool_id`.
   *
   * A failure is **not** fatal to the batch: the entry still lives in memory and can be attached by
   * a later batch of the same source in this process. What it loses is survival across a restart,
   * so it is counted and logged — silently falling back to memory-only is exactly the defect this
   * ADR removes (I5).
   *
   * @param {{alerts: object[], requests: object[], attempts: number, source_id: string|null}} entry Entry.
   * @returns {object} Entry (with `spool_id` when persistence succeeded).
   */
  function persistContribution(entry) {
    if (spool === null) {
      return entry;
    }
    try {
      const saved = spool.putContributionSpool({
        source_id: entry.source_id ?? null,
        attempts: entry.attempts ?? 0,
        alerts: entry.alerts,
        requests: entry.requests,
      });
      return typeof saved?.spool_id === 'string' ? { ...entry, spool_id: saved.spool_id } : entry;
    } catch (error) {
      counters.contributions_spool_errors += 1;
      logger?.error?.('contribution spool write failed; entry is memory-only until it attaches', {
        code: error?.code ?? 'SPOOL_WRITE_FAILED',
        source_id: entry.source_id ?? null,
      });
      return entry;
    }
  }

  /**
   * Drop an entry's durable copy.
   *
   * Idempotent by design: a stale row left behind by a crash between "T1 committed" and "row
   * deleted" is neutralised by the claim check in `attachRetained` (`alertEvidence`), not by a
   * second delete. So a failure here is counted but never repaired destructively.
   *
   * @param {{spool_id?: string}} entry Entry.
   * @returns {void}
   */
  function forgetContribution(entry) {
    if (spool === null || typeof entry.spool_id !== 'string') {
      return;
    }
    try {
      spool.deleteContributionSpool(entry.spool_id);
    } catch (error) {
      counters.contributions_spool_errors += 1;
      logger?.error?.('contribution spool delete failed; stale row is neutralised on load', {
        code: error?.code ?? 'SPOOL_DELETE_FAILED',
      });
    }
  }

  // Recover what the previous process could not write. A spool that cannot be read is a degraded
  // daemon, not a failed start: collection and detection are unaffected, and the missing evidence
  // is still reachable through the normal replay path for events that never landed.
  if (spool !== null) {
    try {
      const loaded = spool.listContributionSpool();
      for (const entry of loaded.entries ?? []) {
        const recovered = {
          alerts: entry.alerts ?? [],
          requests: entry.requests ?? [],
          attempts: Number.isSafeInteger(entry.attempts) ? entry.attempts : 0,
          source_id: entry.source_id ?? null,
          spool_id: entry.spool_id,
        };
        // **Reconcile against the store, once, at startup (第 13 轮 P2-15).** A row can outlive the
        // entry that wrote it: when a failed retry must keep the old row (P1-10) and a later batch
        // then commits the same evidence, the in-memory index no longer knows about it, so nothing
        // ever deletes it. Left alone it would sit in `/status.pendingContributions` forever and
        // keep health degraded for evidence that is already fully counted. If every id it names is
        // already claimed by its alert row, the entry's contribution is exactly 0 — dropping it
        // changes nothing except the noise.
        if (spoolEntryFullyClaimed(recovered)) {
          counters.contributions_reconciled += 1;
          forgetContribution(recovered);
          continue;
        }
        pendingContributions.push(recovered);
      }
      if ((loaded.skipped ?? 0) > 0) {
        counters.contributions_spool_errors += loaded.skipped;
        logger?.error?.('contribution spool holds unreadable rows; they were skipped', { skipped: loaded.skipped });
      }
      counters.contributions_recovered = pendingContributions.length;
      counters.contributions_pending = pendingContributions.length;
    } catch (error) {
      counters.contributions_spool_errors += 1;
      logger?.error?.('contribution spool could not be loaded', { code: error?.code ?? 'SPOOL_LOAD_FAILED' });
    }
  }

  /**
   * Is every piece of evidence this entry names already claimed by its stored alert row?
   *
   * A missing row, a capped (truncated) row, or a failed read all answer `false`: the entry is then
   * still potentially owed and must be kept. Only a provable "already counted" allows dropping it.
   *
   * @param {{alerts: object[]}} entry Recovered entry.
   * @returns {boolean} `true` when the entry has nothing left to contribute.
   */
  function spoolEntryFullyClaimed(entry) {
    if (typeof store.alertEvidence !== 'function') {
      return false;
    }
    for (const alert of entry.alerts ?? []) {
      let row;
      try {
        row = store.alertEvidence(alert.fingerprint, alert.window_start);
      } catch {
        return false;
      }
      if (row === null || row === undefined || row.truncated === true) {
        return false;
      }
      const claimed = new Set(row.event_ids ?? []);
      for (const id of alert.event_ids ?? []) {
        if (!claimed.has(id)) {
          return false;
        }
      }
    }
    return (entry.alerts ?? []).length > 0;
  }

  function rebuildEngine(reason) {
    counters.detection_faults += 1;
    if (createDetection === null) {
      return false;
    }
    try {
      engine = createDetection();
      counters.detection_rebuilds += 1;
      logger?.warn?.('detection engine rebuilt after fault', { reason });
      return true;
    } catch (error) {
      logger?.error?.('detection engine rebuild failed', { reason: error?.code ?? 'REBUILD_FAILED' });
      return false;
    }
  }

  /**
   * Ask the store which events it already holds, keyed the way **T1** keys them.
   *
   * Prefers the batched stable-key probe (`hasStableKeys`, ADR-0006). The per-event
   * `hasEvent` fallback exists only for legacy doubles that predate that interface;
   * it is weaker (it cannot see a replay that carries a fresh `event_id`) and is
   * therefore never used by the real adapters.
   *
   * **A batch can also duplicate itself.** The collector's dedupe window is bounded, and
   * the poll contract does not promise stable-key uniqueness inside one batch. T1 would
   * treat the second occurrence as a duplicate and write nothing, so counting it here
   * would inflate the alert and hand a duplicate evidence id to the alert merge. When the
   * adapter can expose its key encoding (`stableKeysOf`), the second occurrence is
   * marked as known and dropped before detection — the same outcome T1 would reach,
   * only earlier and without the side effects.
   *
   * Throws when the answer cannot be trusted — the caller turns that into a store
   * error and refuses the whole batch, so nothing is written on an unverified read.
   *
   * @param {readonly object[]} list Events of this batch.
   * @returns {boolean[]} Same length and order as `list`.
   */
  function readKnownFlags(list) {
    if (typeof store.hasStableKeys === 'function') {
      const flags = store.hasStableKeys(list);
      if (!Array.isArray(flags) || flags.length !== list.length) {
        throw new DaemonError(DAEMON_CODES.STORE_REQUIRED, 'event store returned a malformed duplicate report');
      }
      const known = flags.map((value) => value === true);
      if (typeof store.stableKeysOf === 'function') {
        const keys = store.stableKeysOf(list);
        if (!Array.isArray(keys) || keys.length !== list.length) {
          throw new DaemonError(DAEMON_CODES.STORE_REQUIRED, 'event store returned malformed stable keys');
        }
        const seen = new Set();
        for (let index = 0; index < list.length; index += 1) {
          if (known[index]) {
            seen.add(keys[index]);
            continue;
          }
          if (seen.has(keys[index])) {
            known[index] = true;
          } else {
            seen.add(keys[index]);
          }
        }
      }
      return known;
    }
    if (typeof store.hasEvent === 'function') {
      return list.map((event) => store.hasEvent(event.event_id) === true);
    }
    throw new DaemonError(DAEMON_CODES.STORE_REQUIRED, 'event store cannot answer duplicate queries');
  }

  function detect(events) {
    const { view, rejected } = toDetectionBatch(events);
    counters.events_rejected += rejected;
    if (view.length === 0) {
      return null;
    }
    try {
      return engine.ingest(view);
    } catch (error) {
      // The engine freezes itself on any escaping exception; rebuild so the next
      // batch is not permanently rejected, and persist this batch without alerts.
      const code = isDaemonError(error) ? error.code : (error?.code ?? 'DETECTION_FAULT');
      logger?.error?.('detection failed for a batch', { code, events: view.length });
      rebuildEngine(code);
      return null;
    }
  }

  /**
   * Retain the derived objects of a failed write so a later batch can persist them.
   *
   * **The entry remembers which collector source it belongs to (P1-5).** The pipeline is
   * shared by every source (`scheduler.js` hands each poll the same pipeline), and a
   * contribution can only be re-anchored on a batch that can still produce its evidence.
   * Without the source on the entry, an unrelated source's batch drains the queue: it
   * cannot verify the ids, so it drops the observation (undercount) or — once the queue
   * defers instead of dropping — burns the entry's retry budget, which ends in the same
   * permanent undercount a few batches later. See `attachRetained`.
   *
   * @param {{alerts?: object[], requests?: object[], contribution_attempts?: number}|undefined} group Failed group.
   * @param {string|null} [sourceId] Collector source this contribution belongs to (`null` = unknown).
   * @returns {void}
   */
  function retainContribution(group, sourceId = null) {
    if (group === undefined) {
      return null;
    }
    const alerts = group.alerts ?? [];
    const requests = group.requests ?? [];
    if (alerts.length === 0 && requests.length === 0) {
      return null;
    }
    const entry = {
      alerts: [...alerts],
      requests: [...requests],
      attempts: Number.isSafeInteger(group.contribution_attempts) ? group.contribution_attempts : 0,
      source_id: sourceId ?? null,
    };
    const persisted = persistContribution(entry);
    // Same evidence, same row: a replay that fails again must not grow the queue. The spool key is
    // content-derived, so an entry with the same `spool_id` is the *same* outstanding evidence —
    // replacing it keeps `attempts` and the DTO fresh without duplicating it.
    if (typeof persisted.spool_id === 'string') {
      const existing = pendingContributions.findIndex((item) => item.spool_id === persisted.spool_id);
      if (existing !== -1) {
        pendingContributions[existing] = persisted;
        counters.contributions_pending = pendingContributions.length;
        return persisted;
      }
    }
    pendingContributions.push(persisted);
    counters.contributions_pending = pendingContributions.length;
    return persisted;
  }

  /**
   * 判断一份贡献里的事件 id 是否都对应"确实会入库"的行；不能确认时返回 null。
   *
   * `duplicate` 意味着 T1 命中的是稳定键（stable_source_id + generation + seq/native
   * id）上的旧行，本次事件**没有**以自己的 event_id 落库，库里那一行用的是
   * `result.event_id`。所以先把这个 id 换成库里的 id，再逐条向 store 求证：证据列表
   * 里只要有一个 id 在 `telemetry_event` 里查不到，保留下来就是悬空证据。
   *
   * 断言不了（没有 `hasEvent`、读取抛错、或拿不到 `result.event_id`）时选择**不保留**：
   * 少计一条会在 `alerts_dropped` 里看得见，悬空 id 则不会。
   *
   * **改写后必须去重**：一批里若出现两条同稳定键事件，两条 id 会被改写成同一个库内 id，
   * 而 `alert.event_ids` 不允许重复元素（`ERR_DUPLICATE_ARRAY_ELEMENT`）。重复 id 若被
   * 保留下来，下一次 attach 会让整笔 T1 失败，并一直失败到重试次数用完——把一个一次性
   * 计数问题放大成连续多批写入停摆。
   *
   * @param {readonly string[]} ids Alert 的 `event_ids`。
   * @param {string} currentId 本次（被判定为重复的）事件 id。
   * @param {string|null} storedId T1 报告的实际入库 id。
   * @returns {string[]|null} 改写并去重后的 id 列表，或 `null` 表示无法确认。
   */
  function verifiableEventIds(ids, currentId, storedId) {
    if (ids.length === 0) {
      return null;
    }
    const rewritten = [];
    const seen = new Set();
    for (const id of ids) {
      let resolved = id;
      if (id === currentId) {
        if (storedId === null) {
          return null;
        }
        resolved = storedId;
      }
      try {
        if (typeof store.hasEvent !== 'function' || store.hasEvent(resolved) !== true) {
          return null;
        }
      } catch {
        return null;
      }
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      rewritten.push(resolved);
    }
    return rewritten;
  }

  /**
   * 处理 T1 返回 `duplicate: true` 时的贡献：只保留仍然成立的观测。
   *
   * `duplicate` 只可能意味着"该事件已提交过"（稳定键相同），因此本次调用什么都没写：
   * 事件没有新增行，派生物也没有落库。原来无条件调用 `retainContribution` 会把一份
   * 已经计在旧行里的观测再贴到下一批上，`alert.count` 于是大于真实入库事件数，而
   * 保留 DTO 的 `event_ids` 里还带着一个从未入库的 event_id。
   *
   * 因此逐个 alert 用 `findAlertId(fingerprint, window_start)` 判断库里是否已有该窗口
   * 的行：
   *
   * - **已有**：这份观测已经被那一行统计过，直接丢弃（不新增语义，计入既有的
   *   `alerts_dropped` / `requests_dropped`），否则下一批会把同一次观测再加一遍。
   * - **没有**（库里行被清理/迁移，或 `findAlertId` 不可用）：维持原来的失败关闭行为，
   *   保留贡献交给后续批次补齐——不能借这次修复变成"一律不保留"。
   *
   * 保留路径上的 `event_ids` 必须先通过 `verifiableEventIds`；确认不了的那条宁可丢弃
   * 并计入 `alerts_dropped`（取舍见该函数注释）。整组都被丢弃时不留空条目，
   * `pendingContributions` 不增长。
   *
   * @param {{alerts?: object[], requests?: object[]}|undefined} group 重复调用的分组。
   * @param {object} event 被判定为重复的事件。
   * @param {object} result T1 返回值（`event_id` 是实际入库行的 id）。
   * @param {string|null} [sourceId] 这份贡献所属的来源。
   * @returns {void}
   */
  function retainDuplicateContribution(group, event, result, sourceId = null) {
    if (group === undefined) {
      return;
    }
    const alerts = group.alerts ?? [];
    const requests = group.requests ?? [];
    if (alerts.length === 0 && requests.length === 0) {
      return;
    }
    const storedEventId = typeof result?.event_id === 'string' && result.event_id.length > 0
      ? result.event_id
      : null;

    const keptAlerts = [];
    const keptIds = new Set();
    for (const alert of alerts) {
      let existing = null;
      try {
        existing = typeof store.findAlertId === 'function'
          ? store.findAlertId(alert.fingerprint, alert.window_start)
          : null;
      } catch {
        // 查询失败按"库里没有该行"处理：保留并重试，方向仍是失败关闭。
        existing = null;
      }
      if (typeof existing === 'string' && existing.length > 0) {
        counters.alerts_dropped += 1;
        continue;
      }
      const eventIds = verifiableEventIds(alert.event_ids ?? [], event.event_id, storedEventId);
      if (eventIds === null) {
        counters.alerts_dropped += 1;
        continue;
      }
      // 去重会真的少掉观测：`count` 必须同步下调，否则 `count` 与证据条数脱节
      // （读者会以为证据被截断，而 `truncated` 是假的）。
      const removed = (alert.event_ids ?? []).length - eventIds.length;
      const count = Math.max(eventIds.length, alert.count - removed);
      keptAlerts.push({
        ...alert,
        event_ids: eventIds,
        count,
        event_ids_truncated: count > eventIds.length,
      });
      keptIds.add(alert.alert_id);
    }

    const keptRequests = [];
    for (const request of requests) {
      if (!keptIds.has(request.alert_id)) {
        counters.requests_dropped += 1;
        continue;
      }
      keptRequests.push(request);
    }
    if (keptAlerts.length === 0 && keptRequests.length === 0) {
      return;
    }
    retainContribution({ alerts: keptAlerts, requests: keptRequests }, sourceId);
  }

  /**
   * Attach retained contributions to the current batch.
   *
   * Two hazards are handled here, both found in review:
   *
   * 1. **The alert id in a retained DTO can be stale.** If the engine was rebuilt
   *    between the failure and this retry, the retained DTO carries the *old* engine's
   *    alert id. Writing it into a row that already exists would make T1 keep the
   *    existing id, and any request naming the retained id would then abort the whole
   *    transaction. So every retained alert is re-resolved against the store first and
   *    rewritten, and a request whose alert cannot be resolved is dropped instead of
   *    poisoning the batch.
   * 2. **A poison entry must not stall the source forever.** A contribution that keeps
   *    failing the attach is dropped after a bounded number of attempts (counted), so
   *    the cursor can move again. Losing one alert is bad; a permanently stuck
   *    collector is worse.
   * 3. **The evidence list of a retained alert may point at events that never landed.**
   *    A retained contribution comes from a batch whose write failed; neither its anchor
   *    event nor its siblings are guaranteed to be in the store. Attaching it verbatim
   *    writes a row whose `event_ids` nobody can look up and whose `count` includes an
   *    observation that has no event row — the same defect as the in-batch one, only
   *    across a batch boundary. So an id is kept only when it is already stored or is
   *    carried by *this* batch (whose T1 call is about to write it); `count` drops by the
   *    number removed, and an alert left with no verifiable evidence is dropped and
   *    counted.
   * 4. **A retained alert must not double-count a re-observed event.** If this batch
   *    already plans a contribution for the same `(fingerprint, window_start)`, the fresh
   *    contribution supersedes the retained one: the replay was re-detected, so its
   *    observation is about to be counted anyway. Attaching as well would add it twice.
   *
   * @param {Map<string, object>} plan Current write plan.
   * @param {readonly object[]} fresh Events of this batch.
   * @param {string|null} sourceId Source of this batch; only its own entries are drained.
   * @returns {void}
   */
  function attachRetained(plan, fresh, sourceId) {
    // **Only this source's entries may drain (P1-5).** Every other entry stays exactly
    // where it is: not attached, not dropped, not charged an attempt. Draining them here
    // is how one source's batch used to consume another source's evidence — first by
    // dropping the ids outright, then (after the deferral fix) by burning the entry's
    // retry budget, which ends in the same permanent undercount a few batches later.
    // An entry without a source keeps `null` as its own scope, so a batch that also has
    // no `meta.source_id` still re-anchors it (legacy callers only).
    const retained = [];
    const foreign = [];
    for (const entry of pendingContributions) {
      if ((entry.source_id ?? null) === sourceId) {
        retained.push(entry);
      } else {
        foreign.push(entry);
      }
    }
    pendingContributions = foreign;
    counters.contributions_pending = foreign.length;

    const position = new Map();
    fresh.forEach((event, index) => position.set(event.event_id, index));
    const lastIndex = fresh.length - 1;
    const groupFor = (eventId) => {
      let group = plan.groups.get(eventId);
      if (group === undefined) {
        group = { findings: [], alerts: [], requests: [] };
        plan.groups.set(eventId, group);
      }
      return group;
    };

    const batchIds = new Set(fresh.map((event) => event.event_id));
    /**
     * Which event ids this batch is *already* counting per `(fingerprint, window_start)`.
     *
     * Only the overlap has to give way: a retained alert may cover several observations of
     * one window, and this batch may have re-detected some of them (an engine rebuild
     * forgets `seenEventIds`) while others still need the retained copy. Dropping the
     * whole alert would lose those; keeping all of it would double count the overlap.
     */
    const freshIdsByWindow = new Map();
    for (const group of plan.groups.values()) {
      for (const alert of group.alerts) {
        const key = `${alert.fingerprint}\u0000${alert.window_start}`;
        let ids = freshIdsByWindow.get(key);
        if (ids === undefined) {
          ids = new Set();
          freshIdsByWindow.set(key, ids);
        }
        for (const id of alert.event_ids) {
          ids.add(id);
        }
      }
    }

    /**
     * Evidence ids the **stored row** already claims, per `(fingerprint, window_start)`.
     *
     * This is the idempotence condition of ADR-0007 §3.3. It exists because a crash can land
     * between "T1 committed" and "spool row deleted": the entry then survives the restart and is
     * attached a second time. Without this check that re-attach would add its `count` again —
     * `count` above the number of stored events, which is just as wrong as the undercount this
     * ADR set out to fix. Reading the row's own evidence says exactly which observations are
     * already counted, so the second attach contributes 0 and is dropped as superseded.
     *
     * A row whose evidence list was capped (256) cannot answer "is this id claimed", so the
     * filter is skipped there: the pre-existing over-count boundary (ADR §5) is preferable to
     * guessing.
     *
     * @param {object} alert Retained alert.
     * @returns {Set<string>|null} Claimed ids, or `null` when unknown.
     */
    const claimedByRowCache = new Map();
    const claimedByRow = (alert) => {
      const key = `${alert.fingerprint}\u0000${alert.window_start}`;
      if (claimedByRowCache.has(key)) {
        return claimedByRowCache.get(key);
      }
      let claimed = null;
      try {
        const row = typeof store.alertEvidence === 'function'
          ? store.alertEvidence(alert.fingerprint, alert.window_start)
          : null;
        if (row !== null && row !== undefined && row.truncated !== true) {
          claimed = new Set(row.event_ids ?? []);
        }
      } catch {
        // A failed read means "unknown", which is the fail-closed direction for the *filter*
        // (keep the id) but the fail-open direction for the count. Keep the id: a missing
        // observation is worse than a possible duplicate, and the spool delete is retried.
        claimed = null;
      }
      claimedByRowCache.set(key, claimed);
      return claimed;
    };

    for (const entry of retained) {
      // Attempts are per entry, not per process: a contribution that succeeded on its
      // third try must not count against the budget of an unrelated one, and eight
      // transient failures over a process lifetime must not switch retrying off.
      const attempts = Number.isSafeInteger(entry.attempts) ? entry.attempts : 0;
      if (attempts >= MAX_CONTRIBUTION_ATTACH_ATTEMPTS) {
        // Observation-level, not entry-level: one entry can carry several alerts (several
        // fingerprints matched the same anchor), and counting it as one loses N (round 11/12 P3-20).
        counters.contributions_dropped += Math.max(1, entry.alerts.length);
        logger?.error?.('retained alert contribution dropped after repeated attach failures', {
          attempts,
          alerts: entry.alerts.length,
          source_id: entry.source_id ?? null,
        });
        forgetContribution(entry);
        continue;
      }
      counters.contributions_attach_attempts += 1;
      // **The anchor must not be written before the events this alert cites.** A T1 call
      // writes its own event first and then the alerts, so an alert anchored on event #2
      // that cites event #5 commits a row referencing a row that does not exist yet — and
      // if #5's write then fails, that reference is dangling forever. So the anchor is the
      // latest batch event the entry references (last event when it references none),
      // which makes every cited id land at or before the same call.
      let anchorIndex = -1;
      for (const alert of entry.alerts) {
        for (const id of alert.event_ids ?? []) {
          const at = position.get(id);
          if (at !== undefined && at > anchorIndex) {
            anchorIndex = at;
          }
        }
      }
      const target = fresh[anchorIndex === -1 ? lastIndex : Math.min(anchorIndex, lastIndex)];
      const group = groupFor(target.event_id);
      // Remembered so a failure of THIS write re-retains the entry with its attempt count.
      group.contribution_attempts = Math.max(group.contribution_attempts ?? 0, attempts + 1);

      const idMap = new Map();
      const carriedAlerts = [];
      const carriedAlertIds = new Set();
      const carriedRequests = [];
      for (const alert of entry.alerts) {
        const key = `${alert.fingerprint}\u0000${alert.window_start}`;
        const alreadyCounted = freshIdsByWindow.get(key) ?? new Set();
        const claimed = claimedByRow(alert);
        const original = alert.event_ids ?? [];
        // Two ways an id is already counted: this batch re-detected it (engine rebuild), or the
        // stored row already claims it (a spool entry that outlived its own write). Both must give
        // way, or the same observation is added twice.
        const withoutOverlap = original.filter((id) => !alreadyCounted.has(id) && !(claimed?.has(id) ?? false));
        const superseded = original.length - withoutOverlap.length;
        const eventIds = retainedEventIds(withoutOverlap, batchIds);
        // **Evidence that cannot be checked yet is not evidence that is gone.** A retained
        // contribution is attached to whatever batch comes next, and with several collectors
        // that batch usually belongs to a *different* source: none of these ids are in it,
        // and none are stored yet. Dropping the whole observation there is wrong — the
        // source it belongs to may still replay the event, and once it does the engine has
        // already seen it (no re-detection), so the observation would never be counted
        // again. So the unverifiable remainder is carried to the next attach, with the
        // entry's attempt budget as the only bound; when the budget runs out it is dropped
        // and counted like any other unverifiable contribution.
        const keptSet = new Set(eventIds);
        const unverifiable = withoutOverlap.filter((id) => !keptSet.has(id));
        if (unverifiable.length > 0) {
          carriedAlerts.push({
            ...alert,
            event_ids: unverifiable,
            count: unverifiable.length,
            event_ids_truncated: false,
          });
          carriedAlertIds.add(alert.alert_id);
        }
        const removed = original.length - eventIds.length;
        const count = Math.max(0, alert.count - removed);
        if (eventIds.length === 0 || count === 0) {
          if (superseded > 0 && unverifiable.length === 0) {
            // 本批已经重新观测到这些事件：不是丢失，是被新鲜观测取代。
            counters.contributions_superseded += 1;
          } else if (unverifiable.length === 0) {
            counters.alerts_dropped += 1;
          }
          // 还有未核验的证据时**不**计 dropped：它只是延后，不是丢失（见上方注释）。
          continue;
        }
        if (superseded > 0) {
          counters.contributions_superseded += 1;
        }
        let id = alert.alert_id;
        try {
          const existing = typeof store.findAlertId === 'function'
            ? store.findAlertId(alert.fingerprint, alert.window_start)
            : null;
          if (typeof existing === 'string' && existing.length > 0) {
            id = existing;
          }
        } catch {
          // A failed lookup leaves the DTO as it was; the write below will either
          // succeed against the stored row or fail and be retained again.
        }
        idMap.set(alert.alert_id, id);
        group.alerts.push({
          ...alert,
          alert_id: id,
          event_ids: eventIds,
          count,
          event_ids_truncated: count > eventIds.length,
        });
      }
      for (const request of entry.requests) {
        const id = idMap.get(request.alert_id);
        if (id === undefined) {
          if (carriedAlertIds.has(request.alert_id)) {
            // 告警被延后，请求必须跟着走：outbox 行有指向告警行的外键。
            carriedRequests.push(request);
          } else {
            counters.requests_dropped += 1;
          }
          continue;
        }
        group.requests.push(id === request.alert_id ? request : { ...request, alert_id: id });
      }
      if (group.alerts.length > 0 || group.requests.length > 0) {
        counters.contributions_retried += 1;
      }
      // **Nothing durable happens here (第 13 轮 P1-9).** The spool row may only be deleted once the
      // T1 call that carries this contribution has actually committed. Deleting it during planning —
      // which is what this code used to do — opened a window where a crash lost the evidence *after*
      // the row was gone but *before* the anchor was written: exactly the undercount the spool exists
      // to prevent, now with a clean-looking health report.
      //
      // So the outcome is recorded against the anchor event and settled right after that event's
      // write, in `settleAttached`.
      recordAttachedOutcome(plan, target.event_id, entry, carriedAlerts, carriedRequests, attempts);
    }
  }

  /**
   * Remember what to do with an attached entry once its anchor's T1 call is known to have committed.
   *
   * @param {Map<string, object>} plan Current write plan.
   * @param {string} eventId Anchor event id.
   * @param {object} entry Retained entry that produced this outcome.
   * @param {object[]} carriedAlerts Alerts whose evidence could not be verified yet.
   * @param {object[]} carriedRequests Requests that must travel with those alerts.
   * @param {number} attempts Attach attempts already spent.
   * @returns {void}
   */
  function recordAttachedOutcome(plan, eventId, entry, carriedAlerts, carriedRequests, attempts) {
    if (plan.attachedOutcomes === undefined) {
      plan.attachedOutcomes = new Map();
    }
    let list = plan.attachedOutcomes.get(eventId);
    if (list === undefined) {
      list = [];
      plan.attachedOutcomes.set(eventId, list);
    }
    list.push({
      entry,
      remainder: carriedAlerts.length > 0 || carriedRequests.length > 0
        ? {
          alerts: carriedAlerts,
          requests: carriedRequests,
          contribution_attempts: attempts + 1,
          source_id: entry.source_id ?? null,
        }
        : null,
    });
  }

  /**
   * Settle the spool rows of the entries attached to one anchor, **after** its T1 call.
   *
   * The only thing this function may destroy is a durable copy that is **provably superseded**:
   * the call committed (so the evidence is in the store), or a *different* durable row now carries
   * the same evidence. Everything else keeps the row.
   *
   * That rule is written as an identity check, not as a boolean, because two ordinary paths make a
   * replacement land on the *same* primary key (round 13 P1-10):
   *
   * - a failed retry re-retains byte-identical content, so `retainContribution` UPSERTs the very row
   *   being settled — deleting it would delete the replacement;
   * - a spool write failure still returns the in-memory entry (by design, so this process can retry),
   *   so "was it re-retained?" is true even though nothing was persisted.
   *
   * @param {object[]} outcomes Entries recorded by `recordAttachedOutcome`.
   * @param {boolean} committed `true` when T1 really wrote this call's derived objects.
   * @param {{spool_id?: string}|null} replacement Entry the caller re-retained for the planned part.
   * @returns {void}
   */
  function settleAttached(outcomes, committed, replacement) {
    const replacementId = typeof replacement?.spool_id === 'string' ? replacement.spool_id : null;
    for (const outcome of outcomes) {
      const { entry, remainder } = outcome;
      if (committed) {
        if (remainder === null) {
          forgetContribution(entry);
          continue;
        }
        // Persist first, delete second: a crash between the two leaves both rows, and the claim
        // check (`alertEvidence`) keeps the already-counted ids out of `count`.
        const next = retainContribution(remainder, entry.source_id ?? null);
        if (typeof next?.spool_id === 'string' && next.spool_id !== entry.spool_id) {
          forgetContribution(entry);
        }
        continue;
      }
      // Not committed: T1 wrote nothing, so the old row is still the only copy of everything the
      // entry carried. It may go only when the planned part *and* the unverifiable remainder are
      // both durable under **different** primary keys — never when a replacement reused its key.
      if (remainder === null) {
        if (replacementId !== null && replacementId !== entry.spool_id) {
          forgetContribution(entry);
        }
        continue;
      }
      const next = retainContribution(remainder, entry.source_id ?? null);
      const nextId = typeof next?.spool_id === 'string' ? next.spool_id : null;
      if (replacementId !== null && nextId !== null
        && replacementId !== entry.spool_id && nextId !== entry.spool_id) {
        forgetContribution(entry);
      }
    }
  }

  /**
   * Keep only the evidence ids that will really be lookups: dropped duplicates, ids of
   * events this batch is about to write, and ids already in the store.
   *
   * Fails closed: a store read error means "cannot prove it is there", so the id goes.
   *
   * @param {readonly string[]} ids Evidence ids of a retained alert.
   * @param {ReadonlySet<string>} batchIds Event ids of the current batch.
   * @returns {string[]} Verifiable ids, de-duplicated, input order preserved.
   */
  function retainedEventIds(ids, batchIds) {
    const kept = [];
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || seen.has(id)) {
        continue;
      }
      if (!batchIds.has(id)) {
        let present = false;
        try {
          present = typeof store.hasEvent === 'function' && store.hasEvent(id) === true;
        } catch {
          present = false;
        }
        if (!present) {
          continue;
        }
      }
      seen.add(id);
      kept.push(id);
    }
    return kept;
  }

  /**
   * Move surplus analysis requests to anchors that carry none.
   *
   * T1 accepts one request per call, so a group with two would silently lose one. Every
   * event of the batch is an acceptable anchor for a request whose alert already
   * exists, so the surplus is spread instead of dropped.
   *
   * @param {Map<string, object>} plan Current write plan.
   * @param {readonly object[]} fresh Events of this batch.
   * @returns {void}
   */
  function spreadRequests(plan, fresh) {
    const order = new Map();
    fresh.forEach((event, index) => order.set(event.event_id, index));

    // Which event carries each alert, so a request is never placed on an event that is
    // written *before* the row it points at exists. T1 checks the foreign key inside the
    // transaction, so an earlier anchor would abort the whole batch instead of losing
    // one request.
    const alertOrder = new Map();
    for (const [eventId, group] of plan.groups) {
      const index = order.get(eventId) ?? Number.MAX_SAFE_INTEGER;
      for (const alert of group.alerts) {
        alertOrder.set(alert.alert_id, index);
      }
    }

    const extras = [];
    for (const group of plan.groups.values()) {
      while (group.requests.length > 1) {
        extras.push(group.requests.pop());
      }
    }
    for (const request of extras) {
      // An alert already in the store has no ordering constraint; one created by this
      // batch may only be referenced from its own event or a later one.
      const minimum = alertOrder.get(request.alert_id) ?? -1;
      let placed = false;
      for (const [eventId, index] of order) {
        if (index < minimum) {
          continue;
        }
        const group = plan.groups.get(eventId);
        if (group !== undefined && group.requests.length > 0) {
          continue;
        }
        let target = group;
        if (target === undefined) {
          target = { findings: [], alerts: [], requests: [] };
          plan.groups.set(eventId, target);
        }
        target.requests.push(request);
        placed = true;
        break;
      }
      if (!placed) {
        counters.requests_dropped += 1;
      }
    }
  }

  /**
   * Force one alert id per `(fingerprint, window_start)` across the whole plan.
   *
   * The store keys an alert row on `(fingerprint, window_start)` and keeps the existing
   * row's id. If a T1 call carries two contributions for the same window under two
   * different ids — the normal case when a retained contribution meets a rebuilt
   * engine — one of them wins and any request naming the other aborts the transaction.
   * So the id is chosen once per window (a stored row first, then the first planned id)
   * and every alert and request in the plan is rewritten to it.
   *
   * @param {Map<string, object>} plan Current write plan.
   * @returns {void}
   */
  function normalizeGroupIds(plan) {
    const chosen = new Map();
    const rewrite = new Map();
    const resolve = (alert) => {
      const key = `${alert.fingerprint}\u0000${alert.window_start}`;
      let id = chosen.get(key);
      if (id !== undefined) {
        return id;
      }
      id = alert.alert_id;
      try {
        const existing = typeof store.findAlertId === 'function'
          ? store.findAlertId(alert.fingerprint, alert.window_start)
          : null;
        if (typeof existing === 'string' && existing.length > 0) {
          id = existing;
        }
      } catch {
        // Leave the incoming id; the write either succeeds or is retained again.
      }
      chosen.set(key, id);
      return id;
    };

    // Contract DTOs are deep-frozen, so the arrays are rebuilt rather than mutated.
    for (const group of plan.groups.values()) {
      group.alerts = group.alerts.map((alert) => {
        const id = resolve(alert);
        if (id === alert.alert_id) {
          return alert;
        }
        rewrite.set(alert.alert_id, id);
        return { ...alert, alert_id: id };
      });
    }
    for (const group of plan.groups.values()) {
      group.requests = group.requests.map((request) => {
        const id = rewrite.get(request.alert_id);
        return id === undefined ? request : { ...request, alert_id: id };
      });
    }
  }

  /**
   * Drop observations whose event never landed, before an alert is written.
   *
   * Why this exists: `buildWritePlan` aggregates the whole window's observations into
   * ONE alert contribution and anchors it on the last contributing event of the batch
   * (a T1 call carries derived objects for its anchor only). If an *earlier* event of
   * that batch fails to write, the anchor still carries its observation — so the row
   * would count an event that has no row, and `event_ids` would list an id nobody can
   * look up. That is exactly the "half batch" state the evidence rules forbid, and it
   * is worse than losing the observation: `alerts_dropped` shows a loss, a dangling id
   * does not.
   *
   * **The stripped observation is not forgiven, it is deferred.** Removing the id from an
   * alert that is about to be written keeps that row honest, but the observation itself is
   * real: its event may still land on a later retry, and when it does the window's `count`
   * has to grow by one. So every removal also yields a *single-window, evidence-only*
   * alert carrying exactly the removed ids, which the caller retains. Without that, a
   * partial write followed by a successful replay would leave `count` below the number of
   * events that are actually in the store for that window — verifiable evidence that the
   * row denies.
   *
   * Known bound: when `count > event_ids.length` (the evidence list is capped at 256),
   * a failed id that sits beyond the cap cannot be identified, so that observation is
   * not subtracted. The direction stays fail-closed: we never invent ids, only possibly
   * over-count a capped row.
   *
   * @param {{findings?: object[], alerts?: object[], requests?: object[]}|undefined} group Planned group.
   * @param {ReadonlySet<string>} failedIds Event ids whose write already failed in this batch.
   * @param {object[]} recovered Receives one deferred contribution per stripped alert.
   * @returns {object|undefined} Group with the dead observations removed (the original when nothing changed).
   */
  function stripFailedObservations(group, failedIds, recovered) {
    if (group === undefined || failedIds.size === 0) {
      return group;
    }
    const alerts = [];
    const droppedAlertIds = new Set();
    let changed = false;
    for (const alert of group.alerts) {
      const keptIds = alert.event_ids.filter((id) => !failedIds.has(id));
      const removedIds = alert.event_ids.filter((id) => failedIds.has(id));
      const removed = removedIds.length;
      if (removed === 0) {
        alerts.push(alert);
        continue;
      }
      changed = true;
      // One deferred entry per stripped alert, not per id: `attachRetained` merges it back
      // into the same row and re-verifies every id anyway, so the batch stays O(alerts)
      // in the pending queue instead of O(events).
      recovered.push({
        ...alert,
        event_ids: removedIds,
        count: removedIds.length,
        event_ids_truncated: false,
      });
      const count = Math.max(0, alert.count - removed);
      if (keptIds.length === 0 || count === 0) {
        // Nothing verifiable is left: writing a row with count 0 and no evidence would
        // be a lie, and keeping the id would be a dangling reference.
        droppedAlertIds.add(alert.alert_id);
        counters.alerts_dropped += 1;
        continue;
      }
      alerts.push({
        ...alert,
        event_ids: keptIds,
        count,
        event_ids_truncated: count > keptIds.length,
      });
    }
    if (!changed) {
      return group;
    }
    const requests = group.requests.filter((request) => !droppedAlertIds.has(request.alert_id));
    counters.requests_dropped += group.requests.length - requests.length;
    return { ...group, alerts, requests };
  }

  /**
   * Build the store request for one event (PERF-CPU N-034: split out of `writeOne` so the batched
   * and the per-event write paths share exactly one request shape).
   *
   * @param {object} event Telemetry event.
   * @param {object|undefined} group Detection group or `undefined`.
   * @returns {object} Store ingest request.
   */
  function buildRequest(event, group) {
    const request = {
      event,
      findings: group?.findings ?? [],
      alerts: group?.alerts ?? [],
    };
    if (group !== undefined && group.requests.length > 0) {
      // T1 accepts a single analysis request per call. Two requests for the same
      // anchor would need two calls, which would double-write the alert; the rate
      // limiter makes this a detection-side defect, so the surplus is counted.
      request.analysisRequest = group.requests[0];
      if (group.requests.length > 1) {
        counters.requests_dropped += group.requests.length - 1;
      }
    }
    return request;
  }

  /**
   * Book-keeping for one committed store write (duplicate or accepted).
   *
   * @param {object} entry Prepared write entry.
   * @param {object} result Store result.
   * @returns {object} The store result.
   */
  function applyWritten(entry, result) {
    const { event, group, outcomes } = entry;
    const sourceId = entry.sourceId ?? null;
    if (result.duplicate === true) {
      counters.events_duplicate += 1;
      // 预过滤器本应拦下这个事件（同一 event_id）。走到这里说明是并发写入，或 store
      // 与 `hasEvent` 的判断不一致：T1 命中了稳定键上的旧行，本次的派生物一个都没写。
      // 不能无条件保留——旧行里已经计过这份观测；只保留仍然成立的贡献。
      retainDuplicateContribution(group, event, result, sourceId);
      // T1 wrote nothing for this call: the planned part is not in the store, so the entry's
      // row stays unless the remainder alone replaced it (identity-checked in `settleAttached`).
      settleAttached(outcomes, false, null);
      return result;
    }
    counters.events_accepted += 1;
    counters.alerts_written += group?.alerts.length ?? 0;
    counters.findings_written += group?.findings.length ?? 0;
    if (group !== undefined && group.requests.length > 0) {
      counters.analysis_requests += 1;
    }
    settleAttached(outcomes, true, null);
    return result;
  }

  function writeOne(event, group, sourceId = null, outcomes = []) {
    const entry = { event, group, outcomes, sourceId };
    counters.store_calls += 1;
    const result = store.ingest(buildRequest(event, group));
    return applyWritten(entry, result);
  }

  return {
    /**
     * Ingest one batch.
     *
     * @param {readonly object[]} events Contract telemetry events.
     * @param {{source_id?: string}} [meta] Batch origin. It is **not** only for logging:
     *   it scopes the deferred-contribution queue, so a batch can only re-anchor the
     *   evidence its own source produced (P1-5).
     * @returns {object} Batch summary.
     */
    ingestBatch(events, meta = {}) {
      if (!Array.isArray(events)) {
        throw new DaemonError(DAEMON_CODES.BATCH_INVALID, 'ingestBatch expects an array of events');
      }
      /** Scope key for retained contributions; `null` is its own scope (legacy callers). */
      const batchSourceId = typeof meta.source_id === 'string' ? meta.source_id : null;
      const summary = {
        received: events.length,
        duplicate: 0,
        accepted: 0,
        rejected: 0,
        dropped: 0,
        alerts: 0,
        findings: 0,
        analysis_requests: 0,
        store_errors: 0,
        detection_ok: true,
        source_id: meta.source_id ?? null,
      };
      counters.batches += 1;
      if (events.length === 0) {
        return Object.freeze(summary);
      }
      counters.events_received += events.length;

      const fresh = [];
      let known;
      try {
        known = readKnownFlags(events);
      } catch (error) {
        // One unreadable batch is one store error, not N: the probe is a single
        // logical read. Nothing is written, and the scheduler keeps the cursor put,
        // so the whole batch replays once the store answers again.
        summary.store_errors += 1;
        counters.store_errors += 1;
        counters.store_errors_consecutive += 1;
        summary.dropped += events.length;
        counters.events_dropped += events.length;
        logger?.error?.('event store read failed', {
          code: error?.code ?? 'READ_FAILED',
          events: events.length,
        });
        return Object.freeze(summary);
      }
      for (let index = 0; index < events.length; index += 1) {
        if (known[index]) {
          summary.duplicate += 1;
          counters.events_duplicate += 1;
          continue;
        }
        fresh.push(events[index]);
      }
      if (fresh.length === 0) {
        return Object.freeze(summary);
      }

      const detectionResult = detect(fresh);
      if (detectionResult === null) {
        summary.detection_ok = false;
      }
      let plan = { groups: new Map(), counters: { findings: 0, alerts: 0, requests: 0, rejected: 0 } };
      if (detectionResult !== null) {
        try {
          plan = buildWritePlan({
            result: detectionResult,
            events: fresh,
            epoch,
            allowedSummaryFields: options.allowedSummaryFields ?? [],
            budgetClass: options.budgetClass,
            alertStatus: options.alertStatus,
            // The store is the authority on which alert id a window already has.
            resolveAlertId: (fingerprint, windowStartIso) => (
              typeof store.findAlertId === 'function' ? store.findAlertId(fingerprint, windowStartIso) : null
            ),
          });
          counters.alerts_without_new_observation += plan.counters.skipped_no_new_observation;
          counters.alerts_truncated += plan.counters.truncated_alerts;
          counters.alerts_dropped += plan.counters.dropped_alerts;
          if (plan.counters.rejected > 0) {
            logger?.error?.('derived objects were rejected by the contract', {
              count: plan.counters.rejected,
              dropped_alerts: plan.counters.dropped_alerts,
            });
          }
        } catch (error) {
          logger?.error?.('write plan failed', { code: error?.code ?? 'PLAN_FAILED' });
          summary.detection_ok = false;
        }
      }

      // Attach contributions retained from an earlier failed write to this batch, so
      // they finally land in a T1 call that has an anchor.
      if (pendingContributions.length > 0 && fresh.length > 0) {
        attachRetained(plan, fresh, batchSourceId);
      }
      // One analysis request per T1 call, but a batch usually has several events: spread
      // the surplus over other anchors instead of dropping it.
      spreadRequests(plan, fresh);
      // Every alert/request in a group must agree on one alert id per window, or T1
      // keeps the stored row's id and the request naming another id aborts the whole
      // transaction. This is the invariant that makes retrying a retained contribution
      // safe even after the engine was rebuilt.
      normalizeGroupIds(plan);

      /** Event ids whose T1 call already failed: later alerts must not cite them. */
      const failedEventIds = new Set();

      /** One event's failed-write bookkeeping (shared by the write paths). */
      const applyFailure = (entry, error) => {
        summary.store_errors += 1;
        counters.store_errors += 1;
        counters.store_errors_consecutive += 1;
        summary.dropped += 1;
        counters.events_dropped += 1;
        failedEventIds.add(entry.event.event_id);
        const reRetained = retainContribution(entry.group, batchSourceId);
        // Identity-checked: the re-retained content may UPSERT the very row being settled.
        settleAttached(entry.outcomes, false, reRetained);
        logger?.error?.('event store write failed', {
          code: error?.code ?? 'WRITE_FAILED',
          source_id: meta.source_id ?? null,
        });
      };

      // PERF-CPU N-034 — batched writes, on the narrowest safe boundary.
      //
      // With `synchronous=FULL` every T1 transaction is one fsync, so one-event-per-transaction
      // meant 2009 fsyncs in the 330 s measured window and a 385-event first snapshot that held the
      // event loop for ~45 s. A *run* of consecutive events is written in one transaction here.
      //
      // **Which events are batch-safe.** Only events that write no alert row, no analysis request
      // and no retained contribution. That is exactly the boundary the per-event loop's ordering
      // refinement lives on — "a failed write removes that event's observation from every *later*
      // alert of the same batch" needs the writes to be sequential, so an event that produces an
      // alert is never batched. In the measured idle workload ~91 % of events are findings-only,
      // which is where the volume is. `batchFlushMax` is the flush bound: the run is written as soon
      // as it reaches that many entries and whatever is left is written before this call returns;
      // there is no timer and no cross-poll buffer, so batching cannot delay an event.
      const useBatch = batchWritesEnabled && typeof store.ingestBatch === 'function';

      /** Write one event through the store's single-event entry point (the proven path). */
      const writeSingle = (entry) => {
        try {
          const result = writeOne(entry.event, entry.group, batchSourceId, entry.outcomes);
          if (result.duplicate === true) {
            summary.duplicate += 1;
          } else {
            summary.accepted += 1;
            summary.alerts += entry.group?.alerts.length ?? 0;
            summary.findings += entry.group?.findings.length ?? 0;
            if (entry.group !== undefined && entry.group.requests.length > 0) {
              summary.analysis_requests += 1;
            }
          }
        } catch (error) {
          applyFailure(entry, error);
        }
      };

      /** Write a run of batch-safe events in one transaction. */
      const writeChunk = (chunk) => {
        let batchResult = null;
        let batchError = null;
        counters.store_calls += 1;
        counters.store_batch_calls += 1;
        try {
          batchResult = store.ingestBatch(chunk.map((entry) => entry.request));
        } catch (error) {
          batchError = error;
        }
        if (batchResult === null || batchResult === undefined) {
          // No batch entry point on this store build, or the transaction rolled back with nothing
          // written: replay the run through the proven path and stop batching this process.
          batchWritesEnabled = false;
          for (const entry of chunk) {
            writeSingle(entry);
          }
          return;
        }
        const results = Array.isArray(batchResult.results) ? batchResult.results : [];
        for (let index = 0; index < chunk.length; index += 1) {
          const entry = chunk[index];
          const item = results[index];
          if (item !== undefined && item.ok === true) {
            const value = item.value;
            if (value?.duplicate === true) {
              summary.duplicate += 1;
            } else {
              summary.accepted += 1;
              summary.findings += entry.group?.findings.length ?? 0;
            }
            applyWritten(entry, value);
          } else {
            applyFailure(entry, item?.error ?? batchError);
          }
        }
        if (Number(batchResult.failed ?? 0) > 0) {
          // A partially rejected run cannot be batched safely (the committed part is already in the
          // store). Count it, stop batching and say so — silently degrading back to the per-event
          // path is exactly what this daemon must not do.
          counters.batch_partial_failures += 1;
          batchWritesEnabled = false;
          logger?.error?.('event store batch was partially rejected; falling back to per-event writes', {
            failed: Number(batchResult.failed),
            chunk: chunk.length,
            source_id: meta.source_id ?? null,
          });
        }
      };

      let run = [];
      const flushRun = () => {
        if (run.length === 0) {
          return;
        }
        const chunk = run;
        run = [];
        writeChunk(chunk);
      };

      for (const event of fresh) {
        // A failed write removes that event's observation from every later alert of the
        // same batch, so a row can never reference an event that has no row. The stricken
        // observation is retained as its own deferred contribution: if the event lands on
        // a later retry, its observation rejoins the window's `count` instead of being
        // silently dropped.
        //
        // Order matters: a run of batched entries may still be in flight when this event is
        // prepared, and a failure inside that run changes what `stripFailedObservations` must
        // strip from *this* event's alert. So the run is flushed before the group is computed,
        // never after — otherwise the alert would cite an event whose write is about to fail.
        const rawGroup = plan.groups.get(event.event_id);
        const outcomes = plan.attachedOutcomes?.get(event.event_id) ?? [];
        const preSafe = useBatch
          && outcomes.length === 0
          && (rawGroup === undefined || (rawGroup.alerts.length === 0 && rawGroup.requests.length === 0));
        if (!preSafe) {
          flushRun();
        }
        const recovered = [];
        const group = stripFailedObservations(rawGroup, failedEventIds, recovered);
        for (const contribution of recovered) {
          retainContribution({ alerts: [contribution] }, batchSourceId);
        }
        // Retained entries anchored on *this* event: their spool rows are settled only after the
        // call above/below is known to have committed (第 13 轮 P1-9).
        const entry = {
          event,
          group,
          outcomes,
          request: buildRequest(event, group),
        };
        const batchSafe = preSafe
          && recovered.length === 0
          && (group === undefined || (group.alerts.length === 0 && group.requests.length === 0));
        if (!batchSafe) {
          flushRun();
          writeSingle(entry);
          continue;
        }
        run.push(entry);
        if (run.length >= batchFlushMax) {
          flushRun();
        }
      }
      flushRun();

      if (summary.store_errors === 0) {
        counters.store_errors_consecutive = 0;
      }
      return Object.freeze(summary);
    },

    /**
     * Advance detection without new events (window maintenance).
     *
     * Deliberately writes nothing. Window closure and time-based severity changes
     * are cumulative facts about a row that already exists, and T1's upsert adds
     * `count`; re-sending the view would inflate it. Until the store grows an
     * explicit alert-update entry point, "advance" only keeps the engine's windows
     * honest. This is recorded as an integration gap in `M5-DAEMON.md`.
     *
     * @param {number} [atMs] Wall clock instant to advance to.
     * @returns {object} Advance summary.
     */
    advance(atMs) {
      if (typeof engine.advanceTo !== 'function') {
        return Object.freeze({ ok: false, closed_alerts: 0 });
      }
      try {
        const result = atMs === undefined ? engine.flush() : engine.advanceTo(atMs);
        return Object.freeze({
          ok: true,
          closed_alerts: (result.closedAlerts ?? []).length,
          alerts: 0,
        });
      } catch (error) {
        logger?.error?.('detection advance failed', { code: error?.code ?? 'ADVANCE_FAILED' });
        rebuildEngine(error?.code ?? 'ADVANCE_FAILED');
        return Object.freeze({ ok: false, closed_alerts: 0 });
      }
    },

    stats() {
      return {
        ...counters,
        detection: typeof engine.stats === 'function' ? safeStats(engine) : null,
      };
    },

    /** Replace the engine (used after an operator fixes the rule pack). */
    replaceEngine(next) {
      if (next === null || typeof next !== 'object' || typeof next.ingest !== 'function') {
        throw new DaemonError(DAEMON_CODES.DETECTION_UNAVAILABLE, 'replacement engine is not usable');
      }
      engine = next;
    },
  };
}

function safeStats(engine) {
  try {
    const stats = engine.stats();
    return {
      fatal: stats.fatal ?? null,
      events: stats.events ?? 0,
    };
  } catch {
    return null;
  }
}
