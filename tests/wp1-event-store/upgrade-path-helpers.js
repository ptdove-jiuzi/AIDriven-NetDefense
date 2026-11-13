/**
 * 升级路径（旧库 → 当前 schema）测试夹具。
 *
 * 这个文件只被 `upgrade-path.test.js` 与 `evidence/upgrade/migration/scripts/**` 复用，
 * **不注册任何 node:test 用例**（证据脚本在测试运行器之外导入它）。
 *
 * 为什么需要"构造旧库"而不是直接拿现成库：
 * - `dist/bundle/win32-x64-v15|v16|v17` 的 `@aegisharness/event-store/src/*` 与仓库完全同源
 *   （15 个文件 sha256 全等），rc.3→rc.4→rc.5 之间**没有任何 schema 差异**；
 * - 所以"旧库"只能用两条路造出来：① `openStore({ upTo: N })` 得到真实的 v1..v4 库；
 *   ② 用 rc.4 载荷（v16）的 store 代码建库再交给仓库代码打开/升级。
 *
 * 播种数据时遵守一条纪律：**只写该版本真实存在的列**。v1/v2 的 `analysis_outbox` 没有
 * `lease_expired`，v3 的 `execution_outbox` 没有 `last_redeliver_at` —— 用当前 API 写会把
 * 未来列带进旧库，测的就不是"旧库升级"了。v1..v3 没有 `audit_chain_head` 表，审计行也只能
 * 用旧时代的方式（直接 INSERT + 当时的密钥算 HMAC）写出来。
 */

import fs from 'node:fs';
import path from 'node:path';

import { canonicalDigest, canonicalize } from '../../packages/contracts/src/index.js';
import {
  PLACEHOLDER_AUDIT_KEY,
  appendAudit,
  readAuditChainHead,
  verifyAuditChainInStore,
} from '../../packages/event-store/src/audit.js';
import { reserveModelRequest } from '../../packages/event-store/src/budget.js';
import { migrate, openStore } from '../../packages/event-store/src/db.js';
import { ingestTelemetry } from '../../packages/event-store/src/ingest.js';
import { MIGRATIONS, CURRENT_SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION, schemaChecksum } from '../../packages/event-store/src/schema.js';
import { GENESIS_DIGEST, hmacBase64, sha256Hex } from '../../packages/event-store/src/util.js';

/** 测试里注入的"真实"审计密钥（与 helpers.js 的默认值不同，便于区分占位/真实两种态）。 */
export const REAL_AUDIT_KEY = 'upgrade-path-real-key-0123456789abcdef';

/** 判据覆盖面要求的 8 张表：语义名 → 真实表名。 */
export const KEY_TABLES = Object.freeze({
  events: 'telemetry_event',
  findings: 'finding',
  alerts: 'alert',
  analysis: 'analysis_outbox',
  ledger: 'model_request_ledger',
  approval: 'approval',
  execution: 'execution',
  audit: 'audit_event',
});

/** 迁移链的逐版本事实（版本/名称/checksum/建了哪些表/加了哪些列）。 */
export function migrationChainMap() {
  return MIGRATIONS.map((entry) => ({
    version: entry.version,
    name: entry.name,
    checksum: schemaChecksum(entry),
    statements: entry.statements.length,
    creates: entry.statements
      .filter((statement) => /^\s*CREATE TABLE/iu.test(statement))
      .map((statement) => /CREATE TABLE (\w+)/u.exec(statement)[1]),
    alters: entry.statements
      .filter((statement) => /^\s*ALTER TABLE/iu.test(statement))
      .map((statement) => statement.trim()),
    createsIndex: entry.statements
      .filter((statement) => /^\s*CREATE (UNIQUE )?INDEX/iu.test(statement))
      .map((statement) => /CREATE (?:UNIQUE )?INDEX (\w+)/u.exec(statement)[1]),
  }));
}

export { CURRENT_SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION, MIGRATIONS, migrate, schemaChecksum, sha256Hex };

export function nowIso(offsetMs = 0) {
  return new Date(Date.parse('2026-11-01T00:00:00.000Z') + offsetMs).toISOString();
}

/**
 * 确定性推进时钟（与 helpers.js 的 `createTestClock()` 同形，但不依赖 node:test）。
 *
 * 证据脚本在测试运行器之外跑，不能导入 `helpers.js`（它一被导入就会向 node:test 注册
 * 文件级钩子），所以这里单独给一个只做 wall/mono 同步推进的时钟。
 * 预算（T2）会校验 wall 与 mono 的偏差 ≤5 分钟，用真实时钟配固定 `now` 会直接报
 * `ERR_BUDGET_TIME_UNTRUSTED`。
 */
export function createAdvancingClock(startIso = '2026-11-01T00:00:00.000Z') {
  let wall = Date.parse(startIso);
  let mono = wall;
  return {
    nowIso: () => new Date(wall).toISOString(),
    nowMs: () => wall,
    monoMs: () => mono,
    advance(deltaMs) {
      wall += deltaMs;
      mono += deltaMs;
      return new Date(wall).toISOString();
    },
  };
}

/** 与 audit.js 私有 `hmacInput` 逐字段一致的规范化输入（旧库审计行要靠它签名）。 */
export function auditHmacInput(value) {
  return canonicalize({
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    timestamp: value.timestamp,
    actor: value.actor,
    action: value.action,
    object_digest: value.object_digest,
    previous_digest: value.previous_digest,
    payload_digest: value.payload_digest,
  });
}

/**
 * 以**旧时代**（schema < 4，无 `audit_chain_head` 表）的方式写入一条审计行。
 *
 * 当前代码的 `appendAudit()` 在没有链头时会失败关闭（这是 v4 之后才有的保护），
 * 所以旧库的审计行只能按当时的写法定点构造：链式 previous_digest + 当时的密钥 HMAC。
 * 这样 `legacyRowsVerifiable()` 在升级时才能给出真实的"旧行可否归因"结论。
 */
export function insertLegacyAuditRow(store, { sequence, previousDigest, key, timestamp, action = 'telemetry.ingest' }) {
  const value = {
    schemaVersion: '1.0',
    sequence,
    timestamp,
    actor: { type: 'system', id: 'aegis-store' },
    action,
    object_digest: sha256Hex(`object:${sequence}`),
    previous_digest: previousDigest,
    payload_digest: sha256Hex(`payload:${sequence}`),
    hmac: '',
  };
  value.hmac = hmacBase64(key ?? PLACEHOLDER_AUDIT_KEY, auditHmacInput(value));
  const digest = canonicalDigest(value);
  store.run(
    `INSERT INTO audit_event (
       sequence, timestamp, timestamp_ms, actor_type, actor_id, action,
       object_digest, previous_digest, payload_digest, hmac, record_digest, canonical_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.sequence,
      value.timestamp,
      Date.parse(value.timestamp),
      value.actor.type,
      value.actor.id,
      value.action,
      value.object_digest,
      value.previous_digest,
      value.payload_digest,
      value.hmac,
      digest,
      canonicalize(value),
    ],
  );
  return digest;
}

/** 按旧时代写法追加 `count` 条审计行；返回最后一条的 record_digest。 */
export function appendLegacyAuditRows(store, { count, key, startSequence = 1, startAtMs = Date.parse('2026-10-01T00:00:00.000Z') }) {
  let previous = GENESIS_DIGEST;
  let sequence = startSequence - 1;
  for (let index = 0; index < count; index += 1) {
    sequence += 1;
    previous = insertLegacyAuditRow(store, {
      sequence,
      previousDigest: previous,
      key,
      timestamp: new Date(startAtMs + sequence * 1000).toISOString(),
    });
  }
  return previous;
}

/** 在 **v4+**（已有链头表）的库里用正规入口追加审计行：锚点与链一起推进。 */
export function appendChainedAuditRows(store, { count, startAtMs = Date.parse('2026-10-01T00:00:00.000Z') }) {
  store.tx('legacy-audit-seed', () => {
    for (let index = 1; index <= count; index += 1) {
      appendAudit(store, {
        action: 'telemetry.ingest',
        actorType: 'system',
        actorId: 'aegis-store',
        objectDigest: sha256Hex(`chained-object:${index}`),
        payload: { seed: index },
        timestamp: new Date(startAtMs + index * 1000).toISOString(),
      });
    }
  });
}

/**
 * 用**旧版本真实存在的列**写入 8 张判据表（外加 approval 的 FK 父表 response_proposal）。
 *
 * 行数刻意是"每表都非空"，这样才能证明"迁移不动业务行"，而不是"迁移不动空表"。
 */
export function seedLegacyTables(store, version) {
  const at = '2026-10-01T00:00:00.000Z';
  const ms = Date.parse(at);
  const epoch = store.getMeta('epoch');

  for (let index = 1; index <= 5; index += 1) {
    const payload = { process_name: `legacy-${index}.exe`, pid: 100 + index };
    const payloadJson = JSON.stringify(payload);
    const canonical = JSON.stringify({ index, source: 'legacy' });
    store.run(
      `INSERT INTO telemetry_event (
         event_id, stable_source_id, collector_instance_id, source_generation, boot_id, native_record_id,
         source_seq, observed_at, received_at, observed_at_ms, received_at_ms, ingest_seq, type, severity,
         payload_json, payload_digest, integrity_digest, canonical_json, canonical_digest, dedupe_key, recorded_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `evt-legacy-${index}`, 'windows.security.4688', 'collector-legacy', 1, 'a'.repeat(32), null,
        index, at, at, ms, ms, index, 'process.start', 'high', payloadJson, sha256Hex(payloadJson),
        sha256Hex(`integrity-${index}`), canonical, sha256Hex(canonical), sha256Hex(`dedupe-${index}`), at,
      ],
    );
  }
  // 旧二进制写完事件后会推进 ingest 序号；漏掉这一步，升级后的第一次 ingest 会撞
  // `UNIQUE(ingest_seq)`——那是**播种不真实**，会被误读成"迁移把序号搞坏了"。
  store.run(
    `INSERT INTO sequence_counter (name, value) VALUES ('telemetry_ingest_seq', 5)
       ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
  );

  for (let index = 1; index <= 2; index += 1) {
    store.run(
      `INSERT INTO finding (
         finding_id, rule_id, rule_version, fingerprint, severity, status, first_seen, last_seen,
         first_seen_ms, last_seen_ms, count, event_ids_json, evidence_refs_json,
         canonical_json, canonical_digest, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `finding-legacy-${index}`, 'proc_persist', '1.0.0', sha256Hex(`finding-fp-${index}`), 'high', 'new',
        at, at, ms, ms, index, JSON.stringify([`evt-legacy-${index}`]), '[]', '{}', sha256Hex('{}'), at, at,
      ],
    );
  }

  for (let index = 1; index <= 2; index += 1) {
    store.run(
      `INSERT INTO alert (
         alert_id, rule_id, rule_version, fingerprint, severity, status, first_seen, last_seen,
         window_start, window_end, first_seen_ms, last_seen_ms, window_start_ms, window_end_ms, count,
         event_ids_json, event_ids_truncated, evidence_refs_json, canonical_json, canonical_digest,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `alert-legacy-${index}`, 'proc_persist', '1.0.0', sha256Hex(`alert-fp-${index}`), 'high', 'new',
        at, at, at, at, ms, ms, ms, ms, 1, JSON.stringify([`evt-legacy-${index}`]), 0, '[]',
        '{}', sha256Hex('{}'), at, at,
      ],
    );
  }

  const analysisColumns = [
    'analysis_id', 'alert_id', 'budget_class', 'summary_json', 'summary_digest', 'created_at', 'created_at_ms',
    'idempotency_key', 'epoch', 'state', 'attempt_seq', 'canonical_json', 'canonical_digest', 'updated_at',
  ];
  const analysisValues = [
    'analysis-legacy-1', 'alert-legacy-1', 'standard', '{}', sha256Hex('{}'), at, ms,
    'idempotency-legacy-1', epoch, 'queued', 0, '{}', sha256Hex('{}'), at,
  ];
  if (version >= 3) {
    // 迁移 v3 才引入的列：只在真正有这个列的旧库里写它。
    analysisColumns.push('lease_expired');
    analysisValues.push(0);
  }
  store.run(
    `INSERT INTO analysis_outbox (${analysisColumns.join(', ')}) VALUES (${analysisColumns.map(() => '?').join(', ')})`,
    analysisValues,
  );

  store.run(
    `INSERT INTO response_proposal (
       proposal_id, analysis_id, action_id, normalized_target_json, target_digest, justification_json,
       risk, expires_at, expires_at_ms, canonical_json, canonical_digest, created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'proposal-legacy-1', 'analysis-legacy-1', 'process.terminate', '{}', sha256Hex('target:1'), '[]',
      'high', '2026-10-01T01:00:00.000Z', ms + 3_600_000, '{}', sha256Hex('{}'), at,
    ],
  );

  store.run(
    `INSERT INTO model_request_ledger (
       request_id, analysis_id, request_seq, serialized_digest, input_upper, output_limit,
       reserved_at, reserved_at_ms, state, epoch, utc_day, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'req-legacy-1', 'analysis-legacy-1', 1, sha256Hex('serialized:1'), 100, 50,
      at, ms, 'reserved', epoch, '2026-10-01', at,
    ],
  );

  store.run(
    `INSERT INTO approval (
       approval_id, proposal_id, proposal_digest, policy_version, target_digest, approver_json,
       approver_account, nonce, issued_at, issued_at_ms, expires_at, expires_at_ms, epoch, state,
       created_at, updated_at, canonical_json, canonical_digest
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'approval-legacy-1', 'proposal-legacy-1', sha256Hex('proposal-digest:1'), '1.0', sha256Hex('target:1'),
      '{}', 'AEGIS\\responder', 'nonce-legacy-1', at, ms, '2026-10-01T00:30:00.000Z', ms + 1_800_000,
      epoch, 'pending', at, at, '{}', sha256Hex('{}'),
    ],
  );

  store.run(
    `INSERT INTO execution (
       execution_id, approval_id, proposal_id, attempt_id, attempt_seq, action_id, action_digest,
       parameters_digest, target_digest, proposal_digest, state, epoch, nonce, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'exec-legacy-1', 'approval-legacy-1', 'proposal-legacy-1', 'attempt-legacy-1', 1, 'process.terminate',
      sha256Hex('action:1'), sha256Hex('parameters:1'), sha256Hex('target:1'), sha256Hex('proposal-digest:1'),
      'approved', epoch, 'nonce-exec-legacy-1', at, at,
    ],
  );
}

/**
 * 用**当前 API** 在 v4/v5 库里播种一批真实业务数据（事件/告警/分析/提案/审批/执行/预算台账）。
 *
 * 与 `seedLegacyTables()` 互补：那条路证明"旧形状的行"不丢，这条路证明"当前代码写的行"不丢。
 * 依赖 tests/wp1-event-store/helpers.js 的 DTO 夹具（只借用 DTO 构造，不用它开库）。
 */
export function seedRealisticDataset(store, helpers, { events = 6, findings = 2, clock = null } = {}) {
  const summaryFields = ['process_name'];
  const seeded = [];
  // 预算（T2）会校验 wall/mono 一致性：给了注入时钟就让它推进，没有就用开库那一刻。
  const tick = (deltaMs) => (clock === null ? store.clock.nowIso() : clock.advance(deltaMs));

  for (let index = 1; index <= events; index += 1) {
    const at = tick(60_000);
    // id 一律交给合同夹具生成：`event_id` / `alert_id` 有格式约束，手写的短串会被 validate 拒。
    const event = helpers.makeEvent({
      observed_at: at,
      received_at: at,
      payload: { process_name: `real-${index}.exe`, pid: 2000 + index },
    });
    const alert = helpers.makeAlert({
      fingerprint: sha256Hex(`real-alert-${index}`),
      first_seen: at,
      last_seen: at,
      window_start: at,
      window_end: at,
      event_ids: [event.event_id],
    });
    ingestTelemetry(store, {
      event,
      alerts: [alert],
      allowedSummaryFields: summaryFields,
      now: at,
    });
    seeded.push({ event_id: event.event_id, alert_id: alert.alert_id });
  }

  // 走一遍 T1→T5 的真实链路：分析认领 → 提案 → 审批 → 派发 → 受理 → 执行。
  const chain = helpers.buildExecutingExecution(store, { owner: 'broker-legacy-1' });

  // 预算台账（T2）：真实入口写入，带一条审计行。
  reserveModelRequest(store, {
    analysis_id: chain.analysis.analysis_id,
    input_upper: 1200,
    output_limit: 400,
    serialized_digest: sha256Hex('real-model-request-1'),
    now: tick(60_000),
  });

  // finding 由检测层写；这里用与 v1 相同的列形状补几行，保证判据表非空。
  for (let index = 1; index <= findings; index += 1) {
    const at = tick(60_000);
    store.run(
      `INSERT INTO finding (
         finding_id, rule_id, rule_version, fingerprint, severity, status, first_seen, last_seen,
         first_seen_ms, last_seen_ms, count, event_ids_json, evidence_refs_json,
         canonical_json, canonical_digest, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        `finding-real-${index}`, 'proc_persist', '1.0.0', sha256Hex(`real-finding-${index}`), 'medium', 'new',
        at, at, Date.parse(at), Date.parse(at), index, JSON.stringify([seeded[0].event_id]), '[]',
        '{}', sha256Hex('{}'), at, at,
      ],
    );
  }

  return chain;
}

/** 打开一个**指定版本**的旧库（真实 DDL，不是事后改 meta 伪造的）。 */
export function openLegacyDb(filePath, { version, auditKey = null, clock = undefined }) {
  return openStore({ path: filePath, upTo: version, auditKey, clock, policyVersion: '1.0' });
}

/** 以当前代码打开（自动补齐到 CURRENT_SCHEMA_VERSION）。 */
export function openCurrentDb(filePath, { auditKey = REAL_AUDIT_KEY, migrations = undefined, clock = undefined, upTo = undefined } = {}) {
  return openStore({ path: filePath, upTo, auditKey, migrations, clock, policyVersion: '1.0' });
}

export function tableColumns(store, table) {
  return store.all(`PRAGMA table_info(${table})`).map((row) => String(row.name));
}

export function tableCounts(store, tableObject = KEY_TABLES) {
  const counts = {};
  for (const [label, table] of Object.entries(tableObject)) {
    counts[label] = Number(store.get(`SELECT COUNT(*) AS c FROM ${table}`).c);
  }
  return counts;
}

export function countDiff(before, after) {
  const diff = {};
  for (const key of Object.keys(before)) diff[key] = after[key] - before[key];
  return diff;
}

/**
 * 按**迁移前就存在的列**导出全表行（JSON 字符串数组）。
 *
 * 迁移会 ADD COLUMN（v3 `analysis_outbox.lease_expired`、v4 `execution_outbox.last_redeliver_at`），
 * 直接 `SELECT *` 比对会把"新增列的默认值"误报成"数据变了"。这里只投影旧列，
 * 新增列由调用方单独断言默认值。
 */
export function dumpProjectedRows(store, table, columns) {
  const projection = columns.map((column) => `"${column}"`).join(', ');
  // node:sqlite 返回的是 null 原型对象，`canonicalize()` 只接受普通对象/数组，
  // 先浅拷贝成普通对象再规范化，否则会抛 ERR_INPUT_NOT_OBJECT。
  return store.all(`SELECT ${projection} FROM ${table} ORDER BY rowid`)
    .map((row) => canonicalize({ ...row }));
}

export function snapshotTables(store, tableObject = KEY_TABLES) {
  const snapshot = { columns: {}, rows: {}, counts: {} };
  for (const [label, table] of Object.entries(tableObject)) {
    const columns = tableColumns(store, table);
    snapshot.columns[label] = columns;
    snapshot.rows[label] = dumpProjectedRows(store, table, columns);
    snapshot.counts[label] = snapshot.rows[label].length;
  }
  return snapshot;
}

/**
 * 迁移前后逐表比对：**按迁移前的列集投影**，只回答两个问题
 * ① 行数是否一致；② 旧列的每个值是否逐字不变。新增/删除列单独列出（新增列由调用方断言默认值）。
 */
export function compareSnapshots(before, storeAfter, tableObject = KEY_TABLES) {
  const report = {};
  for (const [label, table] of Object.entries(tableObject)) {
    const columnsBefore = before.columns[label];
    const columnsAfter = tableColumns(storeAfter, table);
    const afterRows = dumpProjectedRows(storeAfter, table, columnsBefore);
    report[label] = {
      table,
      rowsBefore: before.rows[label].length,
      rowsAfter: afterRows.length,
      rowDiff: afterRows.length - before.rows[label].length,
      projectionEqual: JSON.stringify(before.rows[label]) === JSON.stringify(afterRows),
      addedColumns: columnsAfter.filter((column) => !columnsBefore.includes(column)),
      removedColumns: columnsBefore.filter((column) => !columnsAfter.includes(column)),
    };
  }
  return report;
}

/**
 * 审计链快照：链头记录、表尾、以及 `verifyAuditChainInStore()` 的判定。
 *
 * 故意**吞掉** verify 抛错并保留错误码：旧库（schema < 4）本来就没有链头，
 * "verify 抛 ERR_DB_INTEGRITY"是它的正确行为，不是测试要忽略的异常。
 */
export function auditSnapshot(store) {
  const head = readAuditChainHead(store);
  const tailRow = store.get('SELECT sequence, record_digest FROM audit_event ORDER BY sequence DESC LIMIT 1');
  let verdict = null;
  let error = null;
  try {
    const result = verifyAuditChainInStore(store);
    verdict = {
      ok: result.ok,
      length: result.length,
      hmacVerified: result.hmacVerified,
      unverified_from: result.unverified_from,
      unverified_to: result.unverified_to,
      head: { sequence: result.head.sequence, digest: result.head.digest },
    };
  } catch (caught) {
    error = { name: caught.name, code: caught.code ?? null, message: caught.message };
  }
  return {
    head: head === null ? null : {
      sequence: head.sequence,
      digest: head.digest,
      hmac_mode: head.hmac_mode,
      key_id: head.key_id,
      hmac_from_sequence: head.hmac_from_sequence,
    },
    tail: tailRow === null ? null : { sequence: Number(tailRow.sequence), digest: String(tailRow.record_digest) },
    verdict,
    error,
  };
}

/** 备份目录里最新的一个 `pre-migration-v*.db`（没有则 null）。 */
export function latestPreMigrationBackup(dbPath) {
  const directory = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(directory)) return null;
  const files = fs.readdirSync(directory).filter((name) => name.startsWith('pre-migration-v') && name.endsWith('.db'));
  if (files.length === 0) return null;
  files.sort();
  return path.join(directory, files[files.length - 1]);
}

/** 迁移链里"只增不改"的 checksum 快照（任何对已发布迁移的编辑都会让它变）。 */
export const EXPECTED_CHAIN = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'core-event-finding-alert-analysis-ledger-approval-execution-audit',
    checksum: 'e8f2dc1f101c2262cb7138b061b3d7dbc2e355663c48caebe5c0256125774139',
    creates: Object.freeze([
      'meta', 'schema_migration', 'sequence_counter', 'telemetry_event', 'finding', 'alert', 'evidence',
      'analysis_outbox', 'analysis_report', 'model_request_ledger', 'response_proposal', 'approval',
      'execution', 'execution_outbox', 'execution_inbox', 'execution_result', 'recovery_manifest', 'audit_event',
    ]),
  }),
  Object.freeze({
    version: 2,
    name: 'data-gap-and-capability-state',
    checksum: '38e5e22487cdb2d07ff352231de9e877271120aa05671d322c497cc6e82922d9',
    creates: Object.freeze(['data_gap', 'capability_state']),
  }),
  Object.freeze({
    version: 3,
    name: 'analysis-lease-expired-tracking',
    checksum: 'd55d2965563f44825bdefcb880126c954bec8cec53a60fbea7eda0834ae18a2c',
    creates: Object.freeze([]),
    alters: Object.freeze(['ALTER TABLE analysis_outbox ADD COLUMN lease_expired INTEGER NOT NULL DEFAULT 0']),
  }),
  Object.freeze({
    version: 4,
    name: 'audit-chain-head-record',
    checksum: '567391ccc58cc6c686bfffd275333cf27afa7599465c2227c28c7b02113790a4',
    creates: Object.freeze(['audit_chain_head']),
    alters: Object.freeze(['ALTER TABLE execution_outbox ADD COLUMN last_redeliver_at TEXT']),
  }),
  Object.freeze({
    version: 5,
    name: 'daemon-contribution-spool',
    checksum: 'f91b614e1d3513c3c6cc2d56c14862295989acb6e6c621fdfc0385ee6fad4897',
    creates: Object.freeze(['daemon_contribution_spool']),
  }),
]);

export const CHAIN_HEAD_MIGRATION_VERSION = 4;
