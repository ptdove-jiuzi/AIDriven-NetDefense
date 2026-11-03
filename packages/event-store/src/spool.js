/**
 * spool.js —— daemon 的"待补记告警贡献"落盘表（ADR-0007）。
 *
 * 为什么这个东西在存储层而不是 daemon 的 checkpoint 里：留存证据的生命周期必须覆盖
 * 进程生命周期（ADR-0007 §1.2），而 checkpoint 有 512KB 上限、超限即**整份隔离**，
 * 一次降级批次就会连游标一起丢掉——那是新造一条静默丢失路径。
 *
 * 这张表只存 daemon 自己写不出去的**派生物**（告警/分析请求 DTO），不存遥测、不参与告警合并，
 * 也不是第二份真相：真正的告警行仍由 T1 写进 `alert`。它只是"待办清单"，写成功后立即删除。
 *
 * 主键由**内容**派生：同一来源、同一组窗口、同一组证据 id 的条目重复保留时命中 UPSERT，
 * 队列不会随重试次数线性增长（第 10–12 轮的容量上限之所以失败，正是因为它们按条数而不是
 * 按证据记账）。
 */

import { sha256Hex } from './util.js';
import { STORE_CODES, StoreError } from './errors.js';

/** 表名（迁移 v5 创建）。 */
export const CONTRIBUTION_SPOOL_TABLE = 'daemon_contribution_spool';

/**
 * 单行载荷上限。一条告警 DTO 约 1KB，一批最多 500 个事件，1MiB 足够；
 * 超过上限说明调用方给的载荷本身反常，拒绝并让上层按"落盘失败"降级，而不是写进库。
 */
export const MAX_SPOOL_PAYLOAD_BYTES = 1024 * 1024;

const MAX_ID_LENGTH = 512;

function invalid(field) {
  return new StoreError(STORE_CODES.ERR_STORE_INPUT, 'contribution spool payload is invalid', { field });
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw invalid(field);
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_ID_LENGTH) {
      throw invalid(field);
    }
  }
  return value;
}

/**
 * 校验并规整一个待落盘条目。
 *
 * 只校验 `attachRetained` 真正会读的字段：它必须在**载入时**就失败（fail-closed），
 * 而不是在 attach 里对着一堆 `undefined` 抛 TypeError 把整批写挂掉（第 9 轮 P2-8 的形态）。
 *
 * @param {unknown} entry 待落盘条目。
 * @returns {{source_id: string|null, attempts: number, alerts: object[], requests: object[]}} 规整结果。
 */
export function normalizeSpoolEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalid('entry');
  }
  const sourceId = entry.source_id === undefined || entry.source_id === null ? null : entry.source_id;
  if (sourceId !== null && (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > MAX_ID_LENGTH)) {
    throw invalid('source_id');
  }
  const attempts = entry.attempts === undefined ? 0 : entry.attempts;
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw invalid('attempts');
  }
  if (!Array.isArray(entry.alerts) || !Array.isArray(entry.requests)) {
    throw invalid('alerts');
  }
  const alerts = entry.alerts.map((alert) => {
    if (alert === null || typeof alert !== 'object' || Array.isArray(alert)) {
      throw invalid('alerts[]');
    }
    if (typeof alert.fingerprint !== 'string' || alert.fingerprint.length === 0) {
      throw invalid('alerts[].fingerprint');
    }
    if (typeof alert.window_start !== 'string' || alert.window_start.length === 0) {
      throw invalid('alerts[].window_start');
    }
    if (typeof alert.alert_id !== 'string' || alert.alert_id.length === 0) {
      throw invalid('alerts[].alert_id');
    }
    if (!Number.isSafeInteger(alert.count) || alert.count < 0) {
      throw invalid('alerts[].count');
    }
    assertStringArray(alert.event_ids, 'alerts[].event_ids');
    return alert;
  });
  const requests = entry.requests.map((request) => {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw invalid('requests[]');
    }
    if (typeof request.alert_id !== 'string' || request.alert_id.length === 0) {
      throw invalid('requests[].alert_id');
    }
    return request;
  });
  return { source_id: sourceId, attempts, alerts, requests };
}

/**
 * 内容派生的主键：`source_id` + 窗口键集合 + 证据 id 集合。
 *
 * 刻意**不含** `attempts` 与 DTO 的时间/严重度：同一份证据重试多少次都只占一行。
 *
 * @param {{source_id: string|null, alerts: object[], requests: object[]}} entry 规整后的条目。
 * @returns {string} 64 位十六进制摘要。
 */
export function contributionSpoolId(entry) {
  const windows = [...new Set(entry.alerts.map((alert) => `${alert.fingerprint}\u0000${alert.window_start}`))].sort();
  const ids = [...new Set(entry.alerts.flatMap((alert) => alert.event_ids))].sort();
  const seed = `${entry.source_id ?? ''}\u0000${windows.join('\u0001')}\u0000${ids.join('\u0001')}`;
  return sha256Hex(seed);
}

/**
 * 写入/更新一个待补记条目（同一内容 UPSERT）。
 *
 * @param {object} store 可写 store 句柄。
 * @param {{source_id?: string|null, attempts?: number, alerts: object[], requests: object[]}} entry 条目。
 * @param {string} now 当前时间（RFC3339）。
 * @returns {{spool_id: string, created: boolean}} 结果。
 */
export function putContributionSpool(store, entry, now) {
  store.assertWritable('putContributionSpool');
  const normalized = normalizeSpoolEntry(entry);
  const payloadJson = JSON.stringify({ alerts: normalized.alerts, requests: normalized.requests });
  // 按**字节**算，不按字符算：多字节载荷按字符数会通过上限，落库时才发现已经远超预算（第 13 轮 P3-25）。
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_SPOOL_PAYLOAD_BYTES) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'contribution spool entry is too large', {
      field: 'payload',
    });
  }
  const spoolId = contributionSpoolId(normalized);
  const windows = [...new Set(normalized.alerts.map((alert) => `${alert.fingerprint}\u0000${alert.window_start}`))].sort();
  const existing = store.get(`SELECT spool_id FROM ${CONTRIBUTION_SPOOL_TABLE} WHERE spool_id = ?`, [spoolId]);
  store.run(
    `INSERT INTO ${CONTRIBUTION_SPOOL_TABLE}
       (spool_id, source_id, windows_json, attempts, created_at, updated_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (spool_id) DO UPDATE SET
       attempts = excluded.attempts,
       updated_at = excluded.updated_at,
       payload_json = excluded.payload_json`,
    [spoolId, normalized.source_id, JSON.stringify(windows), normalized.attempts, now, now, payloadJson],
  );
  return Object.freeze({ spool_id: spoolId, created: existing === null });
}

/**
 * 列出全部待补记条目（按写入顺序）。
 *
 * 单行解析失败**不**让整个载入失败：跳过并计数，上层据此降级（一行坏数据不该让 daemon 起不来）。
 *
 * @param {object} store store 句柄（可读即可）。
 * @returns {{entries: object[], skipped: number}} 条目与跳过数。
 */
export function listContributionSpool(store) {
  const rows = store.all(
    `SELECT spool_id, source_id, attempts, payload_json FROM ${CONTRIBUTION_SPOOL_TABLE} ORDER BY created_at, spool_id`,
  );
  const entries = [];
  let skipped = 0;
  for (const row of rows) {
    let decoded;
    try {
      decoded = JSON.parse(String(row.payload_json));
      entries.push({
        spool_id: String(row.spool_id),
        source_id: row.source_id === null ? null : String(row.source_id),
        attempts: Number(row.attempts),
        ...normalizeSpoolEntry({
          source_id: row.source_id,
          attempts: Number(row.attempts),
          alerts: decoded?.alerts,
          requests: decoded?.requests,
        }),
      });
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/**
 * 删除一个条目。幂等：不存在也返回成功。
 *
 * @param {object} store 可写 store 句柄。
 * @param {string} spoolId 主键。
 * @returns {boolean} 是否真的删掉了一行。
 */
export function deleteContributionSpool(store, spoolId) {
  store.assertWritable('deleteContributionSpool');
  if (typeof spoolId !== 'string' || spoolId.length === 0 || spoolId.length > 128) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'spool id is invalid', { field: 'spool_id' });
  }
  const before = store.get(`SELECT spool_id FROM ${CONTRIBUTION_SPOOL_TABLE} WHERE spool_id = ?`, [spoolId]);
  if (before === null) {
    return false;
  }
  store.run(`DELETE FROM ${CONTRIBUTION_SPOOL_TABLE} WHERE spool_id = ?`, [spoolId]);
  return true;
}

/**
 * 当前条目数（诊断用）。
 *
 * @param {object} store store 句柄。
 * @returns {number} 行数。
 */
export function countContributionSpool(store) {
  const row = store.get(`SELECT COUNT(*) AS c FROM ${CONTRIBUTION_SPOOL_TABLE}`);
  return Number(row.c);
}
