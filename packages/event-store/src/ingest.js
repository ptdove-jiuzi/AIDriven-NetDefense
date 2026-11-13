/**
 * T1 摄入事务：事件 + Finding/Alert + Analysis outbox + AuditEvent。
 *
 * 幂等的两道防线：
 * 1. **稳定来源键** `(stable_source_id, source_generation, dedupe_key)` 唯一索引。
 *    `dedupe_key` 优先用原生记录 ID；没有原生 ID 时用 `source_seq`。代次变化
 *    （日志被清空、record id 重用）必须由采集器递增 `source_generation`，
 *    否则重放会被错误地合并——这是设计 §5.2 的约定，存储层只负责执行。
 * 2. **`event_id` 主键**。同一 event_id 重复提交直接返回既有行。
 *
 * 命中重复时不写审计、不追加聚合计数、不产生新的 outbox：
 * 幂等意味着"完全相同的副作用集合"，不是"副作用再做一遍但结果看起来一样"。
 */

import { LIMITS, canonicalize, validateAlert, validateAnalysisRequest, validateFinding, validateTelemetryEvent } from '../../contracts/src/index.js';
import { SEVERITY_LEVELS } from '../../contracts/src/objects/telemetry-event.js';

import { AUDIT_ACTIONS, appendAudit } from './audit.js';
import { dedupeKeyOf } from './dedupe.js';
import { STORE_CODES, StoreError } from './errors.js';
import { canonicalDigest, msFromIso } from './util.js';

const SEVERITY_RANK = new Map(SEVERITY_LEVELS.map((level, index) => [level, index]));

function higherSeverity(left, right) {
  return (SEVERITY_RANK.get(right) ?? 0) > (SEVERITY_RANK.get(left) ?? 0) ? right : left;
}

function minIso(left, right) {
  return msFromIso(left) <= msFromIso(right) ? left : right;
}

function maxIso(left, right) {
  return msFromIso(left) >= msFromIso(right) ? left : right;
}

/** 有序并集 + 上限截断。顺序保留是为了让"先到的证据"稳定排在前面的读起来合理。 */
function mergeUniqueWithCap(previous, incoming) {
  const seen = new Set(previous);
  const merged = [...previous];
  for (const item of incoming) {
    if (!seen.has(item)) {
      seen.add(item);
      merged.push(item);
    }
  }
  if (merged.length > LIMITS.maxArrayItems) {
    return { items: merged.slice(0, LIMITS.maxArrayItems), truncated: true };
  }
  return { items: merged, truncated: false };
}

function insertEvent(store, record, ingestSeq, now) {
  const event = record.value;
  store.run(
    `INSERT INTO telemetry_event (
       event_id, stable_source_id, collector_instance_id, source_generation, boot_id,
       native_record_id, source_seq, observed_at, received_at, observed_at_ms, received_at_ms,
       ingest_seq, type, severity, payload_json, payload_digest, integrity_digest,
       canonical_json, canonical_digest, dedupe_key, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.event_id,
      event.stable_source_id,
      event.collector_instance_id,
      event.source_generation,
      event.boot_id,
      event.native_record_id ?? null,
      event.source_seq,
      event.observed_at,
      event.received_at,
      msFromIso(event.observed_at),
      msFromIso(event.received_at),
      ingestSeq,
      event.type,
      event.severity,
      canonicalize(event.payload),
      event.integrity.digest,
      event.integrity.digest,
      canonicalize(event),
      record.digest,
      dedupeKeyOf(event),
      now,
    ],
  );
}

function updateAggregateRow(store, table, idColumn, idValue, value, digest, now) {
  store.run(
    `UPDATE ${table} SET ${AGGREGATE_COLUMNS(table)} , canonical_json = ?, canonical_digest = ?, updated_at = ?
     WHERE ${idColumn} = ?`,
    [...AGGREGATE_BINDINGS(table, value), canonicalize(value), digest, now, idValue],
  );
}

/**
 * UPDATE 的列清单与绑定值必须一一对应。写成两个函数而不是拼字符串，
 * 是为了让"少绑一个参数"在测试里立刻炸，而不是静默写到错列。
 */
function AGGREGATE_COLUMNS(table) {
  const common = `severity = ?, status = ?, first_seen = ?, last_seen = ?,
     first_seen_ms = ?, last_seen_ms = ?, count = ?, event_ids_json = ?, evidence_refs_json = ?`;
  if (table === 'alert') {
    return `${common}, event_ids_truncated = ?, window_end = ?, window_end_ms = ?`;
  }
  return common;
}

function AGGREGATE_BINDINGS(table, value) {
  const common = [
    value.severity,
    value.status,
    value.first_seen,
    value.last_seen,
    msFromIso(value.first_seen),
    msFromIso(value.last_seen),
    value.count,
    JSON.stringify(value.event_ids),
    JSON.stringify(value.evidence_refs),
  ];
  if (table === 'alert') {
    return [...common, value.event_ids_truncated ? 1 : 0, value.window_end, msFromIso(value.window_end)];
  }
  return common;
}

function upsertFinding(store, incoming, now) {
  const existing = store.get('SELECT * FROM finding WHERE finding_id = ?', [incoming.finding_id]);
  if (existing === null) {
    store.run(
      `INSERT INTO finding (
         finding_id, rule_id, rule_version, fingerprint, severity, status,
         first_seen, last_seen, first_seen_ms, last_seen_ms, count,
         event_ids_json, evidence_refs_json, canonical_json, canonical_digest, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incoming.finding_id,
        incoming.rule_id,
        incoming.rule_version,
        incoming.fingerprint,
        incoming.severity,
        incoming.status,
        incoming.first_seen,
        incoming.last_seen,
        msFromIso(incoming.first_seen),
        msFromIso(incoming.last_seen),
        incoming.count,
        JSON.stringify(incoming.event_ids),
        JSON.stringify(incoming.evidence_refs),
        canonicalize(incoming),
        canonicalDigest(incoming),
        now,
        now,
      ],
    );
    return Object.freeze({ finding_id: incoming.finding_id, created: true });
  }

  const previousEventIds = JSON.parse(String(existing.event_ids_json));
  const previousEvidence = JSON.parse(String(existing.evidence_refs_json));
  const eventIds = mergeUniqueWithCap(previousEventIds, incoming.event_ids);
  const evidence = mergeUniqueWithCap(previousEvidence, incoming.evidence_refs);
  const merged = validateFinding({
    schemaVersion: '1.0',
    finding_id: incoming.finding_id,
    rule_id: String(existing.rule_id),
    rule_version: String(existing.rule_version),
    event_ids: eventIds.items,
    fingerprint: String(existing.fingerprint),
    severity: higherSeverity(String(existing.severity), incoming.severity),
    // 状态不因新事件自动回退：已 acknowledged/resolved 的判定不应被静默翻回 new。
    status: String(existing.status),
    first_seen: minIso(String(existing.first_seen), incoming.first_seen),
    last_seen: maxIso(String(existing.last_seen), incoming.last_seen),
    count: Math.min(Number(existing.count) + incoming.count, LIMITS.maxSafeInteger),
    evidence_refs: evidence.items,
  });
  updateAggregateRow(store, 'finding', 'finding_id', incoming.finding_id, merged.value, merged.digest, now);
  return Object.freeze({ finding_id: incoming.finding_id, created: false });
}

function upsertAlert(store, incoming, now) {
  const existing = store.get(
    'SELECT * FROM alert WHERE fingerprint = ? AND window_start = ?',
    [incoming.fingerprint, incoming.window_start],
  );
  if (existing === null) {
    store.run(
      `INSERT INTO alert (
         alert_id, rule_id, rule_version, fingerprint, severity, status, first_seen, last_seen,
         window_start, window_end, first_seen_ms, last_seen_ms, window_start_ms, window_end_ms,
         count, event_ids_json, event_ids_truncated, evidence_refs_json,
         canonical_json, canonical_digest, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incoming.alert_id,
        incoming.rule_id,
        incoming.rule_version,
        incoming.fingerprint,
        incoming.severity,
        incoming.status,
        incoming.first_seen,
        incoming.last_seen,
        incoming.window_start,
        incoming.window_end,
        msFromIso(incoming.first_seen),
        msFromIso(incoming.last_seen),
        msFromIso(incoming.window_start),
        msFromIso(incoming.window_end),
        incoming.count,
        JSON.stringify(incoming.event_ids),
        incoming.event_ids_truncated ? 1 : 0,
        JSON.stringify(incoming.evidence_refs),
        canonicalize(incoming),
        canonicalDigest(incoming),
        now,
        now,
      ],
    );
    return Object.freeze({ alert_id: incoming.alert_id, created: true, count: incoming.count });
  }

  const previousEventIds = JSON.parse(String(existing.event_ids_json));
  const previousEvidence = JSON.parse(String(existing.evidence_refs_json));
  const eventIds = mergeUniqueWithCap(previousEventIds, incoming.event_ids);
  const evidence = mergeUniqueWithCap(previousEvidence, incoming.evidence_refs);
  const windowStart = String(existing.window_start);
  const windowEnd = maxIso(String(existing.window_end), incoming.window_end);
  const count = Math.min(Number(existing.count) + incoming.count, LIMITS.maxSafeInteger);
  // 窗口边界必须夹住观测区间，否则合并出来的 DTO 自相矛盾（validateAlert 会拒绝）。
  const firstSeen = maxIso(windowStart, minIso(String(existing.first_seen), incoming.first_seen));
  const lastSeen = minIso(windowEnd, maxIso(String(existing.last_seen), incoming.last_seen));
  const truncatedWanted = eventIds.truncated
    || Number(existing.event_ids_truncated) === 1
    || incoming.event_ids_truncated === true;

  const merged = validateAlert({
    schemaVersion: '1.0',
    alert_id: String(existing.alert_id),
    rule_id: String(existing.rule_id),
    rule_version: String(existing.rule_version),
    fingerprint: String(existing.fingerprint),
    severity: higherSeverity(String(existing.severity), incoming.severity),
    status: String(existing.status),
    first_seen: firstSeen,
    last_seen: lastSeen,
    window_start: windowStart,
    window_end: windowEnd,
    count,
    event_ids: eventIds.items,
    // 只有真的丢了 ID 才标截断：count 恰好等于条数时标截断是自相矛盾的。
    event_ids_truncated: truncatedWanted && count > eventIds.items.length,
    evidence_refs: evidence.items,
  });
  updateAggregateRow(store, 'alert', 'alert_id', String(existing.alert_id), merged.value, merged.digest, now);
  return Object.freeze({ alert_id: String(existing.alert_id), created: false, count: merged.value.count });
}

function enqueueAnalysis(store, request, now) {
  const existing = store.get(
    'SELECT analysis_id, state FROM analysis_outbox WHERE idempotency_key = ?',
    [request.idempotency_key],
  );
  if (existing !== null) {
    return Object.freeze({ analysis_id: String(existing.analysis_id), created: false });
  }
  const alert = store.get('SELECT alert_id FROM alert WHERE alert_id = ?', [request.alert_id]);
  if (alert === null) {
    throw new StoreError(
      STORE_CODES.ERR_STORE_INPUT,
      `analysis request references unknown alert ${request.alert_id}`,
      { alert_id: request.alert_id },
    );
  }
  store.run(
    `INSERT INTO analysis_outbox (
       analysis_id, alert_id, budget_class, summary_json, summary_digest, created_at, created_at_ms,
       idempotency_key, epoch, state, attempt_id, attempt_seq, owner, lease_expires_at_ms,
       claimed_at, completed_at, report_digest, failure_reason, canonical_json, canonical_digest, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [
      request.analysis_id,
      request.alert_id,
      request.budget_class,
      canonicalize(request.summary_dto),
      canonicalDigest(request.summary_dto),
      request.created_at,
      msFromIso(request.created_at),
      request.idempotency_key,
      request.epoch,
      canonicalize(request),
      canonicalDigest(request),
      now,
    ],
  );
  return Object.freeze({ analysis_id: request.analysis_id, created: true });
}

/**
 * 校验并冻结一次 T1 写入的输入（**事务外**）。
 *
 * 拆出来的原因只有一个：批量写和单条写必须共用同一份校验，否则"批量路径少校验一项"
 * 就会变成一条只有批量才会踩到的绕过路径。
 */
function prepareIngestInput(input, options, context) {
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `${context} requires an input object`);
  }
  if (input.event === undefined) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `${context} requires input.event`);
  }

  const eventRecord = validateTelemetryEvent(input.event);
  const findingRecords = (input.findings ?? []).map((value) => validateFinding(value));
  const alertRecords = (input.alerts ?? []).map((value) => validateAlert(value));
  const analysisRecord = input.analysisRequest === undefined || input.analysisRequest === null
    ? null
    // 出域字段白名单属于策略层（daemon 持有），存储层不内置任何默认放行：
    // 调用方必须显式传 allowedSummaryFields，否则空 allowlist 会让所有字段被拒。
    : validateAnalysisRequest(input.analysisRequest, {
      allowedSummaryFields: Array.isArray(options.allowedSummaryFields) ? options.allowedSummaryFields : [],
      allowClassification: Array.isArray(options.allowClassification) ? options.allowClassification : undefined,
    });

  return { eventRecord, eventValue: eventRecord.value, findingRecords, alertRecords, analysisRecord };
}

/**
 * T1 的**事务内**主体：一条事件 + 它的派生对象 + 一条审计行。
 *
 * 调用方必须已经开好事务；单条写与批量写都用这一个函数，保证两条路径的可观测语义
 * （record_id / ingest_seq / 时间戳 / 去重键 / 审计序列）逐字段相同。
 *
 * @returns {object} 与 `ingestTelemetry` 的返回值同形。
 */
function ingestOneInTx(store, prepared, now, actorType, actorId) {
  const { eventValue, findingRecords, alertRecords, analysisRecord } = prepared;
  const dedupeKey = dedupeKeyOf(eventValue);

  const duplicateByDedupe = store.get(
    `SELECT event_id, ingest_seq FROM telemetry_event
     WHERE stable_source_id = ? AND source_generation = ? AND dedupe_key = ?`,
    [eventValue.stable_source_id, eventValue.source_generation, dedupeKey],
  );
  const duplicateById = duplicateByDedupe === null
    ? store.get('SELECT event_id, ingest_seq FROM telemetry_event WHERE event_id = ?', [eventValue.event_id])
    : null;
  const duplicate = duplicateByDedupe ?? duplicateById;
  if (duplicate !== null) {
    return Object.freeze({
      duplicate: true,
      event_id: String(duplicate.event_id),
      ingest_seq: Number(duplicate.ingest_seq),
      findings: Object.freeze([]),
      alerts: Object.freeze([]),
      analysis_id: null,
      audit_sequence: null,
    });
  }

  const ingestSeq = store.nextSequence('telemetry_ingest_seq');
  insertEvent(store, prepared.eventRecord, ingestSeq, now);

  const findings = findingRecords.map((record) => upsertFinding(store, record.value, now));
  const alerts = alertRecords.map((record) => upsertAlert(store, record.value, now));

  let analysisId = null;
  if (analysisRecord !== null) {
    analysisId = enqueueAnalysis(store, analysisRecord.value, now).analysis_id;
  }

  const audit = appendAudit(store, {
    action: AUDIT_ACTIONS.INGEST,
    actorType: actorType ?? 'collector',
    actorId: actorId ?? eventValue.stable_source_id,
    objectDigest: prepared.eventRecord.digest,
    payload: {
      ingest_seq: ingestSeq,
      stable_source_id: eventValue.stable_source_id,
      source_generation: eventValue.source_generation,
      finding_count: findings.length,
      alert_count: alerts.length,
      analysis_id: analysisId,
    },
    timestamp: now,
  });

  return Object.freeze({
    duplicate: false,
    event_id: eventValue.event_id,
    ingest_seq: ingestSeq,
    findings: Object.freeze(findings),
    alerts: Object.freeze(alerts),
    analysis_id: analysisId,
    audit_sequence: audit.sequence,
  });
}

/**
 * T1：把一批采集结果原子写入。
 *
 * @param {object} store
 * @param {{
 *   event: object,
 *   findings?: object[],
 *   alerts?: object[],
 *   analysisRequest?: object|null,
 *   now?: string,
 *   actorId?: string,
 * }} input
 * @returns {{
 *   duplicate: boolean, event_id: string, ingest_seq: number|null,
 *   findings: {finding_id: string, created: boolean}[],
 *   alerts: {alert_id: string, created: boolean}[],
 *   analysis_id: string|null, audit_sequence: number|null,
 * }}
 */
export function ingestTelemetry(store, input) {
  store.assertWritable('ingestTelemetry');
  const prepared = prepareIngestInput(input, input ?? {}, 'ingestTelemetry');

  return store.tx('T1', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    return ingestOneInTx(store, prepared, now, input.actorType, input.actorId);
  });
}

/**
 * 批量元素既可以是**裸事件**，也可以是与 `ingestTelemetry(store, input)` 同形的
 * `{event, findings?, alerts?, analysisRequest?}` 写入请求。
 *
 * 后者才是 daemon 真正需要的形态（一条事件可能带多个 finding/alert 和一个分析请求）；
 * 前者只是让"只想快速灌 N 条事件"的调用方不必自己套一层。判别只看有没有 `event` 字段。
 */
function batchItemToInput(item) {
  if (item !== null && typeof item === 'object' && item.event !== undefined) return item;
  return { event: item };
}

/** 批量写里每个工作项的回滚点名字（固定即可：同一连接上同时只有一个）。 */
const ITEM_SAVEPOINT = 'aegis_ingest_item';

/**
 * 批量写的**急停开关**（也是变异验证的入口）。
 *
 * `AEGIS_EVENT_STORE_BATCH=off` 时 `ingestTelemetryBatch` 退回"每条事件一个事务"：
 * 返回结构与语义完全不变，只有事务数回到 1/条。用途有两个：
 * 1. 线上出问题时的止血开关（不需要改代码、不需要重新打包）；
 * 2. 证明"省下来的 CPU 确实是批量提交换来的"——关掉它事务数必须回升。
 */
function batchingEnabled() {
  return typeof process !== 'undefined' && process.env?.AEGIS_EVENT_STORE_BATCH !== 'off';
}

/**
 * 在**已开启的事务内**给单个工作项一个回滚点。
 *
 * 批量写必须同时满足两个看起来冲突的要求：
 * 1. 整批只提交一次（省掉 N-1 次 WAL 落盘）；
 * 2. 一条坏事件不能连累整批（调用方原来的"每条独立失败"语义不能变）。
 * 两层 savepoint 正好同时满足：外层是 `tx()` 的守卫 savepoint，内层是这个回滚点。
 * `ROLLBACK TO` 只把连接退回到回滚点，事务仍然是开着的。
 */
function runIsolated(store, fn) {
  store.prepare(`SAVEPOINT ${ITEM_SAVEPOINT}`).run();
  try {
    const value = fn();
    store.prepare(`RELEASE ${ITEM_SAVEPOINT}`).run();
    return Object.freeze({ ok: true, value });
  } catch (error) {
    try {
      store.prepare(`ROLLBACK TO ${ITEM_SAVEPOINT}`).run();
      store.prepare(`RELEASE ${ITEM_SAVEPOINT}`).run();
    } catch (rollbackError) {
      // 回滚点已经不在（事务被外部结束）时不能假装"这条事件只是失败"：
      // 上层事务状态已经不可信，原始错误上抛，整批按失败处理。
      throw error;
    }
    return Object.freeze({ ok: false, error });
  }
}

/**
 * T1 批量：**一个事务**写下 N 条事件，每条事件的可观测语义与逐条调用完全一致。
 *
 * 为什么需要它：`ingestTelemetry` 每条事件一次 `BEGIN IMMEDIATE … COMMIT`，
 * 而 `synchronous=FULL` 下每次 COMMIT 都要把 WAL 落盘，且同一批事件反复改写
 * 同一批 B-tree 页。批量写把这些开销摊到一次提交上，且**不改变耐久性语义**：
 * 提交返回 == 整批已落盘，与单条路径同一条判据（不是"攒够才写"）。
 *
 * 失败语义：
 * - 单条事件失败（校验失败 / 约束冲突）→ 只有这条回滚，其余照常提交；
 * - 提交本身失败（I/O、磁盘满）→ 整批抛错，调用方必须按"这 N 条全部没落地"处理。
 *
 * @param {object} store
 * @param {{events: readonly object[], now?: string, actorType?: string, actorId?: string}} input
 * @returns {{received: number, accepted: number, duplicates: number, failed: number,
 *   results: readonly ({ok: true, result: object}|{ok: false, error: object})[]}}
 */
export function ingestTelemetryBatch(store, input) {
  store.assertWritable('ingestTelemetryBatch');
  if (input === null || typeof input !== 'object' || !Array.isArray(input.events)) {
    throw new StoreError(
      STORE_CODES.ERR_STORE_INPUT,
      'ingestTelemetryBatch requires an input object with an events array',
    );
  }
  const batch = input.events;
  if (batch.length === 0) {
    return Object.freeze({
      received: 0, accepted: 0, duplicates: 0, failed: 0, results: Object.freeze([]),
    });
  }

  if (!batchingEnabled()) {
    // 急停路径：逐条提交。结果与批量路径逐字段一致，只是事务数回到 1/条。
    const results = [];
    let accepted = 0;
    let duplicates = 0;
    let failed = 0;
    for (let index = 0; index < batch.length; index += 1) {
      try {
        const value = ingestTelemetry(store, batchItemToInput(batch[index]));
        results.push(Object.freeze({ ok: true, value }));
        if (value.duplicate === true) duplicates += 1;
        else accepted += 1;
      } catch (error) {
        failed += 1;
        results.push(Object.freeze({ ok: false, error }));
      }
    }
    return Object.freeze({
      received: batch.length, accepted, duplicates, failed, results: Object.freeze(results),
    });
  }

  // 校验在事务外完成（与单条路径同一条理由：坏数据不该占用写锁，也不该产生 WAL 页），
  // 但失败按**条**记录：一条坏事件不能连累同批的好事件。
  //
  // 每条自带的策略白名单（`allowedSummaryFields` / `allowClassification`）必须**逐条**生效：
  // daemon 的 `ingest()` 是把这两个字段挂在**每条请求**上的（它才是持有策略的一方），
  // 如果批量路径只读批级字段，任何带 analysisRequest 的事件都会被空 allowlist 拒掉。
  const preparedItems = new Array(batch.length);
  for (let index = 0; index < batch.length; index += 1) {
    const item = batchItemToInput(batch[index]);
    const options = {
      allowedSummaryFields: Array.isArray(item.allowedSummaryFields)
        ? item.allowedSummaryFields
        : input.allowedSummaryFields,
      allowClassification: Array.isArray(item.allowClassification)
        ? item.allowClassification
        : input.allowClassification,
    };
    try {
      preparedItems[index] = Object.freeze({ ok: true, prepared: prepareIngestInput(item, options, 'ingestTelemetryBatch') });
    } catch (error) {
      preparedItems[index] = Object.freeze({ ok: false, error });
    }
  }

  return store.tx('T1-batch', () => {
    const results = new Array(batch.length);
    let accepted = 0;
    let duplicates = 0;
    let failed = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const item = preparedItems[index];
      if (item.ok !== true) {
        failed += 1;
        results[index] = Object.freeze({ ok: false, error: item.error });
        continue;
      }
      // `now` 逐条取：与逐条调用 `ingestTelemetry` 时每条事件各自取时钟的行为一致。
      const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
      const outcome = runIsolated(store, () => ingestOneInTx(store, item.prepared, now, input.actorType, input.actorId));
      if (outcome.ok !== true) {
        failed += 1;
        results[index] = outcome;
        continue;
      }
      if (outcome.value.duplicate === true) duplicates += 1;
      else accepted += 1;
      results[index] = outcome;
    }
    return Object.freeze({
      received: batch.length,
      accepted,
      duplicates,
      failed,
      results: Object.freeze(results),
    });
  });
}

/** 只读检索：给测试与上层核对用，不做任何"顺手写入"。 */
export function getEvent(store, eventId) {
  return store.get('SELECT * FROM telemetry_event WHERE event_id = ?', [eventId]);
}

export function countEvents(store) {
  return Number(store.get('SELECT COUNT(*) AS c FROM telemetry_event').c);
}

export function getAlertById(store, alertId) {
  return store.get('SELECT * FROM alert WHERE alert_id = ?', [alertId]);
}
