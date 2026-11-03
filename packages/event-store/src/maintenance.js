/**
 * 保留、容量水位、数据缺口与降级状态。
 *
 * 三条来自设计 §7.1 / §12 的硬规则，代码里都做了显式约束：
 *
 * 1. **容量冲突的清理顺序固定**：低价值遥测 → 过期分析索引 → 已聚合低级别事件。
 *    顺序不是随便排的：先清"最没有取证价值"的东西，把告警留到最后；
 *    而高严重度告警**任何情况下都不删**（`ERR_RETENTION_GUARD`）。
 * 2. **水位只有两级**：80% 高水位 → 开始清理；90% 临界 → 停止新分析/新响应，
 *    并写 `capability_state`，让上层看到的是"明确降级"而不是"悄悄变慢"。
 * 3. **审计链不删**：删审计中间行会直接打断哈希链。审计只按天数报告
 *    "最老保留序号"，归档迁移属于发布流程，不属于保留扫描。
 */

import { AUDIT_ACTIONS, appendAudit } from './audit.js';
import { STORE_CODES, StoreError } from './errors.js';
import { msFromIso, sha256Hex, uuid } from './util.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const DEFAULT_CAPACITY_LIMITS = Object.freeze({
  databaseBytes: 2 * GIB,
  walBytes: 1 * GIB,
  walCheckpointBytes: 512 * MIB,
  backupBytes: 2 * GIB,
  sessionBytes: 256 * MIB,
  tempBytes: 256 * MIB,
  emergencyBytes: 16 * MIB,
  /** 安装指南要求数据卷至少 8GiB 可用；低于它直接按临界处理。 */
  minimumDiskFreeBytes: 8 * GIB,
  highWatermark: 0.8,
  criticalWatermark: 0.9,
});

export const DEFAULT_RETENTION_POLICY = Object.freeze({
  telemetryDays: 30,
  alertDays: 180,
  auditDays: 180,
  analysisIndexDays: 7,
  /** 容量清理阶段额外用到的更短保留期。 */
  lowValueTelemetryDays: 7,
  lowSeverityDays: 3,
});

export const CAPABILITIES = Object.freeze({
  ANALYSIS: 'analysis',
  RESPONSE: 'response',
  STORAGE: 'storage',
});

const DAY_MS = 24 * 60 * 60 * 1000;

function resolvePolicy(override) {
  const policy = { ...DEFAULT_RETENTION_POLICY, ...(override ?? {}) };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `retention policy ${key} must be a non-negative integer`);
    }
  }
  return policy;
}

function resolveLimits(override) {
  const limits = { ...DEFAULT_CAPACITY_LIMITS, ...(override ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `capacity limit ${key} must be a non-negative number`);
    }
  }
  if (!(limits.highWatermark > 0 && limits.highWatermark < limits.criticalWatermark && limits.criticalWatermark <= 1)) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'watermarks must satisfy 0 < high < critical <= 1');
  }
  return limits;
}

export function setCapabilityState(store, input) {
  store.assertWritable('setCapabilityState');
  return store.tx('capability', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    appendAudit(store, {
      action: AUDIT_ACTIONS.CAPACITY_ACTION,
      actorType: input.actorType ?? 'daemon',
      actorId: input.actorId ?? 'aegis-core',
      objectDigest: sha256Hex(`capability:${input.capability}`),
      payload: { capability: input.capability, state: input.state },
      timestamp: now,
    });
    store.run(
      `INSERT INTO capability_state (capability, state, updated_at, detail_json) VALUES (?, ?, ?, ?)
       ON CONFLICT (capability) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, detail_json = excluded.detail_json`,
      [input.capability, input.state, now, input.detail === undefined ? null : JSON.stringify(input.detail)],
    );
    return Object.freeze({ capability: input.capability, state: input.state });
  });
}

/** 与 `assertAnalysisCapabilityOpen` 对称：临界水位必须真的挡住新响应。 */
export function assertResponseCapabilityOpen(store) {
  const row = store.get('SELECT state FROM capability_state WHERE capability = ?', ['response']);
  if (row !== null && String(row.state) === 'blocked') {
    throw new StoreError(
      STORE_CODES.ERR_CAPACITY_CRITICAL,
      'response capability is blocked by the capacity policy',
      { capability: 'response' },
    );
  }
}

export function getCapabilityState(store, capability) {
  const row = store.get('SELECT * FROM capability_state WHERE capability = ?', [capability]);
  if (row === null) return Object.freeze({ capability, state: 'ok', detail: null });
  return Object.freeze({
    capability,
    state: String(row.state),
    detail: row.detail_json === null ? null : JSON.parse(String(row.detail_json)),
  });
}

/**
 * 记录一个数据缺口。
 *
 * 缺口是"我们知道少了什么"的账：来源、区间、原因、条数四要素缺一不可。
 * 只写一句 "队列溢出" 而不写区间与条数的缺口，事后无法对账。
 */
export function recordDataGap(store, input) {
  store.assertWritable('recordDataGap');
  if (input === null || typeof input !== 'object' || typeof input.stable_source_id !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'recordDataGap requires stable_source_id');
  }
  if (typeof input.range_start !== 'string' || typeof input.range_end !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'recordDataGap requires range_start and range_end');
  }
  if (!Number.isInteger(input.dropped_count) || input.dropped_count < 0) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'recordDataGap requires a non-negative dropped_count');
  }
  const startMs = msFromIso(input.range_start);
  const endMs = msFromIso(input.range_end);
  if (endMs < startMs) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'range_end must not be before range_start');
  }
  return store.tx('gap', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const gapId = typeof input.gap_id === 'string' && input.gap_id.length > 0 ? input.gap_id : uuid();
    store.run(
      `INSERT INTO data_gap (
         gap_id, stable_source_id, collector_instance_id, reason, range_start, range_end,
         range_start_ms, range_end_ms, dropped_count, detail_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        gapId,
        input.stable_source_id,
        input.collector_instance_id ?? null,
        String(input.reason ?? 'unspecified'),
        input.range_start,
        input.range_end,
        startMs,
        endMs,
        input.dropped_count,
        input.detail === undefined ? null : JSON.stringify(input.detail),
        now,
      ],
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.DATA_GAP,
      actorType: input.actorType ?? 'collector',
      actorId: input.actorId ?? input.stable_source_id,
      objectDigest: sha256Hex(gapId),
      payload: {
        gap_id: gapId,
        stable_source_id: input.stable_source_id,
        reason: String(input.reason ?? 'unspecified'),
        dropped_count: input.dropped_count,
        range_start: input.range_start,
        range_end: input.range_end,
      },
      timestamp: now,
    });
    return Object.freeze({ gap_id: gapId, dropped_count: input.dropped_count });
  });
}

export function listDataGaps(store, options = {}) {
  const where = [];
  const params = [];
  if (typeof options.stable_source_id === 'string') {
    where.push('stable_source_id = ?');
    params.push(options.stable_source_id);
  }
  if (typeof options.since === 'string') {
    where.push('range_end_ms >= ?');
    params.push(msFromIso(options.since));
  }
  const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
  return store.all(`SELECT * FROM data_gap${clause} ORDER BY range_start_ms`, params);
}

export function summarizeDataGaps(store, options = {}) {
  const gaps = listDataGaps(store, options);
  const bySource = new Map();
  let total = 0;
  for (const gap of gaps) {
    const source = String(gap.stable_source_id);
    const entry = bySource.get(source) ?? { stable_source_id: source, gaps: 0, dropped: 0 };
    entry.gaps += 1;
    entry.dropped += Number(gap.dropped_count);
    total += Number(gap.dropped_count);
    bySource.set(source, entry);
  }
  return Object.freeze({
    gaps: gaps.length,
    dropped: total,
    by_source: Object.freeze([...bySource.values()].map((entry) => Object.freeze(entry))),
  });
}

/**
 * 容量评估。
 *
 * `external` 允许调用方注入 WAL/备份/临时目录/磁盘剩余这些
 * "不在 SQLite 头里"的数字；测试正是靠它来构造 80%/90% 水位，
 * 而不是真的去写 2GiB 文件。
 */
export function assessCapacity(store, options = {}) {
  const limits = resolveLimits(options.limits);
  const stats = store.stats();
  const external = options.external ?? {};
  const measure = (actual, limit) => Object.freeze({
    bytes: actual,
    limit,
    ratio: limit === 0 ? 1 : actual / limit,
  });

  const database = measure(
    Number.isFinite(external.databaseBytes) ? external.databaseBytes : stats.databaseBytes,
    limits.databaseBytes,
  );
  const wal = measure(Number.isFinite(external.walBytes) ? external.walBytes : stats.walBytes, limits.walBytes);
  const backup = measure(Number.isFinite(external.backupBytes) ? external.backupBytes : 0, limits.backupBytes);
  const session = measure(Number.isFinite(external.sessionBytes) ? external.sessionBytes : 0, limits.sessionBytes);
  const temp = measure(Number.isFinite(external.tempBytes) ? external.tempBytes : 0, limits.tempBytes);

  const ratios = [database.ratio, wal.ratio, backup.ratio, session.ratio, temp.ratio];
  let level = 'ok';
  if (ratios.some((ratio) => ratio >= limits.criticalWatermark)) level = 'critical';
  else if (ratios.some((ratio) => ratio >= limits.highWatermark)) level = 'high';

  const diskFree = Number.isFinite(external.diskFreeBytes) ? external.diskFreeBytes : null;
  if (diskFree !== null && diskFree < limits.minimumDiskFreeBytes) {
    level = 'critical';
  }

  // 清理顺序：低价值遥测 → 过期分析索引 → 已聚合低级别事件。高严重度告警永不在此列。
  const plan = [];
  if (level !== 'ok') {
    if (wal.ratio >= limits.highWatermark) plan.push('checkpoint_wal');
    plan.push('purge_low_value_telemetry', 'drop_expired_analysis_index', 'purge_aggregated_low_severity');
  }
  if (level === 'critical') plan.push('block_new_analysis', 'block_new_response', 'emergency_notify');

  return Object.freeze({
    level,
    limits: Object.freeze(limits),
    database,
    wal,
    backup,
    session,
    temp,
    disk_free: diskFree,
    plan: Object.freeze(plan),
  });
}

/**
 * 保留扫描（按天数）。
 *
 * 不删审计、不删 high/critical 告警。返回真实的删除条数，供上层对账。
 */
export function runRetention(store, options = {}) {
  store.assertWritable('runRetention');
  const policy = resolvePolicy(options.policy);
  return store.tx('retention', () => {
    const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const telemetryCutoff = nowMs - policy.telemetryDays * DAY_MS;
    const alertCutoff = nowMs - policy.alertDays * DAY_MS;
    const indexCutoff = nowMs - policy.analysisIndexDays * DAY_MS;

    // 被高严重度告警引用的事件不删：告警还在，证据就不能先没。
    const telemetry = store.run(
      `DELETE FROM telemetry_event
        WHERE received_at_ms < ?
          AND event_id NOT IN (
            SELECT value FROM alert, json_each(alert.event_ids_json)
             WHERE alert.severity IN ('high','critical')
          )`,
      [telemetryCutoff],
    );
    const findings = store.run('DELETE FROM finding WHERE last_seen_ms < ?', [alertCutoff]);
    // 被 analysis_outbox 引用的告警不能删：外键会让整个保留事务回滚，
    // 连同一事务里的遥测清理一起作废，之后每次扫描都会再次失败。
    const alerts = store.run(
      `DELETE FROM alert
        WHERE last_seen_ms < ? AND severity IN ('info','low','medium')
          AND alert_id NOT IN (SELECT alert_id FROM analysis_outbox)`,
      [alertCutoff],
    );
    // 只删终态分析的报告索引，保留 outbox 行（审计与对账仍需要"曾经分析过"这个事实）。
    const analysisIndex = store.run(
      `DELETE FROM analysis_report
        WHERE analysis_id IN (
          SELECT analysis_id FROM analysis_outbox
           WHERE state IN ('succeeded','degraded','failed','cancelled') AND completed_at IS NOT NULL
        )
        AND analysis_id NOT IN (
          SELECT analysis_id FROM response_proposal
        )
        AND created_at < ?`,
      [indexCutoff],
    );

    const auditOldest = store.get('SELECT MIN(sequence) AS seq FROM audit_event');
    appendAudit(store, {
      action: AUDIT_ACTIONS.RETENTION_SWEEP,
      actorType: options.actorType ?? 'daemon',
      actorId: options.actorId ?? 'aegis-core',
      objectDigest: sha256Hex('retention'),
      payload: {
        telemetry_deleted: Number(telemetry.changes),
        findings_deleted: Number(findings.changes),
        alerts_deleted: Number(alerts.changes),
        analysis_index_deleted: Number(analysisIndex.changes),
        telemetry_days: policy.telemetryDays,
        alert_days: policy.alertDays,
      },
      timestamp: now,
    });

    return Object.freeze({
      telemetry_deleted: Number(telemetry.changes),
      findings_deleted: Number(findings.changes),
      alerts_deleted: Number(alerts.changes),
      analysis_index_deleted: Number(analysisIndex.changes),
      audit_oldest_sequence: auditOldest === null ? null : Number(auditOldest.seq),
      audit_deleted: 0,
    });
  });
}

/**
 * 按容量水位执行清理。
 *
 * `critical` 时额外把 analysis/response 置为 blocked，并写审计。
 * 高严重度告警在这条路径上同样不可删——任何"为了腾地方删掉 critical 告警"
 * 的念头都必须先撞到 `ERR_RETENTION_GUARD`。
 */
export function enforceCapacity(store, options = {}) {
  store.assertWritable('enforceCapacity');
  const assessment = assessCapacity(store, options);
  if (assessment.level === 'ok') {
    // 水位回落后必须解除阻塞，否则一次磁盘尖峰就会让队列永久停摆。
    const blocked = store.all("SELECT capability FROM capability_state WHERE state = 'blocked'");
    if (blocked.length === 0) {
      return Object.freeze({ level: 'ok', assessment, actions: Object.freeze([]), deleted: Object.freeze({}) });
    }
    return store.tx('capacity-release', () => {
      const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
      for (const row of blocked) {
        store.run("UPDATE capability_state SET state = 'ok', updated_at = ? WHERE capability = ?", [now, String(row.capability)]);
      }
      appendAudit(store, {
        action: AUDIT_ACTIONS.CAPACITY_ACTION,
        actorType: options.actorType ?? 'daemon',
        actorId: options.actorId ?? 'aegis-core',
        objectDigest: sha256Hex('capacity:released'),
        payload: { released: blocked.map((row) => String(row.capability)) },
        timestamp: now,
      });
      return Object.freeze({
        level: 'ok',
        assessment,
        actions: Object.freeze(['release_capability_blocks']),
        deleted: Object.freeze({}),
      });
    });
  }
  const policy = resolvePolicy(options.policy);
  const actions = [];
  // checkpoint 不能在事务里做（SQLite 不允许），所以先做再开清理事务。
  if (assessment.plan.includes('checkpoint_wal')) {
    store.checkpoint('TRUNCATE');
    actions.push('checkpoint_wal');
  }
  return store.tx('capacity-enforce', () => {
    const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
    const nowMs = msFromIso(now);
    const deleted = { telemetry: 0, analysis_index: 0, low_severity: 0 };

    if (assessment.plan.includes('purge_low_value_telemetry')) {
      const cutoff = nowMs - policy.lowValueTelemetryDays * DAY_MS;
      const result = store.run(
        `DELETE FROM telemetry_event
          WHERE received_at_ms < ?
            AND event_id NOT IN (
              SELECT value FROM alert, json_each(alert.event_ids_json)
               WHERE alert.severity IN ('high','critical')
            )`,
        [cutoff],
      );
      deleted.telemetry = Number(result.changes);
      actions.push('purge_low_value_telemetry');
    }

    if (assessment.plan.includes('drop_expired_analysis_index')) {
      const cutoff = nowMs - policy.analysisIndexDays * DAY_MS;
      const result = store.run(
        `DELETE FROM analysis_report
          WHERE created_at < ?
            AND analysis_id NOT IN (SELECT analysis_id FROM response_proposal)`,
        [cutoff],
      );
      deleted.analysis_index = Number(result.changes);
      actions.push('drop_expired_analysis_index');
    }

    if (assessment.plan.includes('purge_aggregated_low_severity')) {
      const cutoff = nowMs - policy.lowSeverityDays * DAY_MS;
      const result = store.run(
        `DELETE FROM telemetry_event
          WHERE severity IN ('info','low') AND received_at_ms < ?
            AND event_id NOT IN (
              SELECT value FROM alert, json_each(alert.event_ids_json)
               WHERE alert.severity IN ('high','critical')
            )`,
        [cutoff],
      );
      deleted.low_severity = Number(result.changes);
      actions.push('purge_aggregated_low_severity');
    }

    if (assessment.level === 'critical') {
      store.run(
        `INSERT INTO capability_state (capability, state, updated_at, detail_json) VALUES ('analysis', 'blocked', ?, ?)
         ON CONFLICT (capability) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, detail_json = excluded.detail_json`,
        [now, JSON.stringify({ reason: 'capacity_critical', at: now })],
      );
      store.run(
        `INSERT INTO capability_state (capability, state, updated_at, detail_json) VALUES ('response', 'blocked', ?, ?)
         ON CONFLICT (capability) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, detail_json = excluded.detail_json`,
        [now, JSON.stringify({ reason: 'capacity_critical', at: now })],
      );
      actions.push('block_new_analysis', 'block_new_response');
      actions.push('emergency_notify');
    }

    appendAudit(store, {
      action: AUDIT_ACTIONS.CAPACITY_ACTION,
      actorType: options.actorType ?? 'daemon',
      actorId: options.actorId ?? 'aegis-core',
      objectDigest: sha256Hex(`capacity:${assessment.level}`),
      payload: { level: assessment.level, actions, deleted },
      timestamp: now,
    });

    return Object.freeze({
      level: assessment.level,
      assessment,
      actions: Object.freeze(actions),
      deleted: Object.freeze(deleted),
    });
  });
}

/**
 * 显式删除告警：唯一入口，且对 high/critical 一律拒绝。
 *
 * 保留扫描没有暴露这个能力，就是为了让"删告警"必须由人显式调用、
 * 并且只能删低严重度的那部分。
 */
export function purgeAlerts(store, options = {}) {
  store.assertWritable('purgeAlerts');
  const allow = options.severityAllowlist ?? ['info', 'low'];
  if (allow.some((severity) => severity === 'high' || severity === 'critical')) {
    throw new StoreError(
      STORE_CODES.ERR_RETENTION_GUARD,
      'high and critical alerts must never be deleted by retention',
      { allowlist: allow },
    );
  }
  return store.tx('purge-alerts', () => {
    const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
    const placeholders = allow.map(() => '?').join(',');
    const result = store.run(
      `DELETE FROM alert WHERE severity IN (${placeholders})
         AND alert_id NOT IN (SELECT alert_id FROM analysis_outbox)`,
      allow,
    );
    appendAudit(store, {
      action: AUDIT_ACTIONS.RETENTION_SWEEP,
      actorType: options.actorType ?? 'cli',
      actorId: options.actorId ?? 'aegis-cli',
      objectDigest: sha256Hex('purge-alerts'),
      payload: { allowlist: allow, deleted: Number(result.changes) },
      timestamp: now,
    });
    return Object.freeze({ deleted: Number(result.changes) });
  });
}
