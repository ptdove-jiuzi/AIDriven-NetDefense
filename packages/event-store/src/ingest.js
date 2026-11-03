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
  if (input === null || typeof input !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'ingestTelemetry requires an input object');
  }
  if (input.event === undefined) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'ingestTelemetry requires input.event');
  }

  // 校验在事务外完成：坏数据不该占用写锁，也不该产生任何 WAL 页。
  const eventRecord = validateTelemetryEvent(input.event);
  const eventValue = eventRecord.value;
  const findingRecords = (input.findings ?? []).map((value) => validateFinding(value));
  const alertRecords = (input.alerts ?? []).map((value) => validateAlert(value));
  const analysisRecord = input.analysisRequest === undefined || input.analysisRequest === null
    ? null
    // 出域字段白名单属于策略层（daemon 持有），存储层不内置任何默认放行：
    // 调用方必须显式传 allowedSummaryFields，否则空 allowlist 会让所有字段被拒。
    : validateAnalysisRequest(input.analysisRequest, {
      allowedSummaryFields: Array.isArray(input.allowedSummaryFields) ? input.allowedSummaryFields : [],
      allowClassification: Array.isArray(input.allowClassification) ? input.allowClassification : undefined,
    });

  return store.tx('T1', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
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
    insertEvent(store, eventRecord, ingestSeq, now);

    const findings = findingRecords.map((record) => upsertFinding(store, record.value, now));
    const alerts = alertRecords.map((record) => upsertAlert(store, record.value, now));

    let analysisId = null;
    if (analysisRecord !== null) {
      analysisId = enqueueAnalysis(store, analysisRecord.value, now).analysis_id;
    }

    const audit = appendAudit(store, {
      action: AUDIT_ACTIONS.INGEST,
      actorType: input.actorType ?? 'collector',
      actorId: input.actorId ?? eventValue.stable_source_id,
      objectDigest: eventRecord.digest,
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
