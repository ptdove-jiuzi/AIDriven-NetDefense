/**
 * 事件存储的 schema 与迁移清单。
 *
 * 设计约束（对应 SOFTWARE_DESIGN §7.1）：
 * - 表：telemetry_event / finding / alert / evidence / analysis_outbox /
 *   analysis_report / model_request_ledger / response_proposal / approval /
 *   execution(+outbox/inbox/result) / recovery_manifest / audit_event /
 *   data_gap / capability_state / meta；
 * - 单写者：只有 daemon 打开可写连接（由 db.js 强制）；
 * - 唯一约束是幂等的第一道防线：去重键、告警窗口键、预算序号、nonce、
 *   execution_id+result_seq、审计前驱摘要，全部在库里而不是在内存里保证。
 *
 * 所有表都用 `STRICT`：SQLite 默认动态类型会让 '1' 与 1 同时进同一个 INTEGER 列，
 * 去重键与预算算术一旦被字符串污染就是静默错误。STRICT 让类型错误在写入时立刻炸。
 */

import { sha256Hex } from './util.js';

/** 严重度枚举（与 contracts 的 SEVERITY_LEVELS 一致，顺序也是升级顺序）。 */
const SEVERITY_ENUM = "IN ('info','low','medium','high','critical')";

/**
 * 迁移是**只增不改**的：已发布版本的内容一旦进入生产就不能再编辑，
 * 任何修改都必须以新版本追加。`checksum` 就是用来抓"偷偷改老版本"的。
 */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'core-event-finding-alert-analysis-ledger-approval-execution-audit',
    statements: Object.freeze([
      `CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,

      `CREATE TABLE schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT`,

      `CREATE TABLE sequence_counter (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT`,

      `CREATE TABLE telemetry_event (
        event_id TEXT PRIMARY KEY,
        stable_source_id TEXT NOT NULL,
        collector_instance_id TEXT NOT NULL,
        source_generation INTEGER NOT NULL,
        boot_id TEXT NOT NULL,
        native_record_id TEXT,
        source_seq INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        ingest_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity ${SEVERITY_ENUM}),
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        integrity_digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (stable_source_id, source_generation, dedupe_key),
        UNIQUE (ingest_seq)
      ) STRICT`,

      `CREATE INDEX telemetry_event_received_idx ON telemetry_event (received_at_ms)`,
      `CREATE INDEX telemetry_event_severity_idx ON telemetry_event (severity, received_at_ms)`,

      `CREATE TABLE finding (
        finding_id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity ${SEVERITY_ENUM}),
        status TEXT NOT NULL CHECK (status IN ('new','acknowledged','resolved','suppressed')),
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        first_seen_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        count INTEGER NOT NULL,
        event_ids_json TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,

      `CREATE INDEX finding_fingerprint_idx ON finding (fingerprint)`,

      `CREATE TABLE alert (
        alert_id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity ${SEVERITY_ENUM}),
        status TEXT NOT NULL CHECK (status IN ('new','acknowledged','resolved','suppressed')),
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        first_seen_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        window_start_ms INTEGER NOT NULL,
        window_end_ms INTEGER NOT NULL,
        count INTEGER NOT NULL,
        event_ids_json TEXT NOT NULL,
        event_ids_truncated INTEGER NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (fingerprint, window_start)
      ) STRICT`,

      `CREATE INDEX alert_last_seen_idx ON alert (last_seen_ms)`,
      `CREATE INDEX alert_severity_idx ON alert (severity, last_seen_ms)`,

      `CREATE TABLE evidence (
        evidence_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        alert_id TEXT NOT NULL,
        allowed_fields_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        max_bytes INTEGER NOT NULL,
        digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT`,

      `CREATE INDEX evidence_analysis_idx ON evidence (analysis_id)`,

      `CREATE TABLE analysis_outbox (
        analysis_id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL,
        budget_class TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        summary_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','dispatched','running','succeeded','degraded','failed','cancelled')),
        attempt_id TEXT,
        attempt_seq INTEGER NOT NULL DEFAULT 0,
        owner TEXT,
        lease_expires_at_ms INTEGER,
        claimed_at TEXT,
        completed_at TEXT,
        report_digest TEXT,
        failure_reason TEXT,
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (alert_id) REFERENCES alert (alert_id)
      ) STRICT`,

      `CREATE INDEX analysis_outbox_state_idx ON analysis_outbox (state, created_at_ms)`,

      `CREATE TABLE analysis_report (
        analysis_id TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        report_digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analysis_outbox (analysis_id)
      ) STRICT`,

      `CREATE TABLE model_request_ledger (
        request_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        attempt_id TEXT,
        request_seq INTEGER NOT NULL,
        serialized_digest TEXT NOT NULL,
        input_upper INTEGER NOT NULL CHECK (input_upper > 0),
        output_limit INTEGER NOT NULL CHECK (output_limit > 0),
        reserved_at TEXT NOT NULL,
        reserved_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved','sent','settled','unknown','void')),
        settled_input INTEGER,
        settled_output INTEGER,
        unknown_reason TEXT,
        epoch TEXT NOT NULL,
        utc_day TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (analysis_id, request_seq)
      ) STRICT`,

      `CREATE INDEX model_request_state_idx ON model_request_ledger (state, utc_day)`,
      `CREATE INDEX model_request_analysis_idx ON model_request_ledger (analysis_id)`,

      `CREATE TABLE response_proposal (
        proposal_id TEXT PRIMARY KEY,
        analysis_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        normalized_target_json TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        justification_json TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
        expires_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (analysis_id) REFERENCES analysis_outbox (analysis_id)
      ) STRICT`,

      `CREATE TABLE approval (
        approval_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposal_digest TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        approver_json TEXT NOT NULL,
        approver_account TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        epoch TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('proposed','pending','approved','rejected','expired','consumed','invalidated')),
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_digest TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES response_proposal (proposal_id)
      ) STRICT`,

      // 同一 proposal 同时只能有一条"活的"审批：pending/approved 互斥。
      `CREATE UNIQUE INDEX approval_live_proposal_idx ON approval (proposal_id)
         WHERE state IN ('proposed','pending','approved')`,

      `CREATE TABLE execution (
        execution_id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        proposal_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        attempt_seq INTEGER NOT NULL,
        action_id TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        parameters_digest TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        proposal_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('approved','dispatch_pending','dispatched','accepted','executing','succeeded','failed','result_unknown','reconciling','manual_required','cancelled')),
        epoch TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        grant_json TEXT,
        grant_digest TEXT,
        not_before TEXT,
        expires_at TEXT,
        expires_at_ms INTEGER,
        owner TEXT,
        lease_expires_at_ms INTEGER,
        accepted_at TEXT,
        executing_at TEXT,
        settled_at TEXT,
        last_result_seq INTEGER NOT NULL DEFAULT 0,
        need_reconcile INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (approval_id) REFERENCES approval (approval_id)
      ) STRICT`,

      `CREATE UNIQUE INDEX execution_attempt_idx ON execution (execution_id, attempt_id)`,
      `CREATE INDEX execution_state_idx ON execution (state)`,

      `CREATE TABLE execution_outbox (
        outbox_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        grant_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','dispatched','acked')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        dispatched_at TEXT,
        UNIQUE (execution_id, attempt_id),
        FOREIGN KEY (execution_id) REFERENCES execution (execution_id)
      ) STRICT`,

      `CREATE TABLE execution_inbox (
        execution_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('accepted','result','reconcile')),
        payload_digest TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, attempt_id, seq, kind)
      ) STRICT`,

      `CREATE TABLE execution_result (
        execution_id TEXT NOT NULL,
        result_seq INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','result_unknown')),
        result_json TEXT NOT NULL,
        result_digest TEXT NOT NULL,
        settled_at TEXT NOT NULL,
        PRIMARY KEY (execution_id, result_seq)
      ) STRICT`,

      `CREATE TABLE recovery_manifest (
        recovery_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        operation_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        target_digest TEXT NOT NULL,
        object_identity_json TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('not_required','pending','prepared','executing','applied','restoring','restored','succeeded','failed','manual_required')),
        prepared_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (execution_id) REFERENCES execution (execution_id)
      ) STRICT`,

      `CREATE INDEX recovery_manifest_state_idx ON recovery_manifest (state)`,

      `CREATE TABLE audit_event (
        sequence INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        object_digest TEXT NOT NULL,
        previous_digest TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        hmac TEXT NOT NULL,
        record_digest TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        UNIQUE (previous_digest),
        UNIQUE (record_digest)
      ) STRICT`,
    ]),
  }),

  Object.freeze({
    version: 2,
    name: 'data-gap-and-capability-state',
    statements: Object.freeze([
      `CREATE TABLE data_gap (
        gap_id TEXT PRIMARY KEY,
        stable_source_id TEXT NOT NULL,
        collector_instance_id TEXT,
        reason TEXT NOT NULL,
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        range_start_ms INTEGER NOT NULL,
        range_end_ms INTEGER NOT NULL,
        dropped_count INTEGER NOT NULL CHECK (dropped_count >= 0),
        detail_json TEXT,
        created_at TEXT NOT NULL
      ) STRICT`,

      `CREATE INDEX data_gap_source_idx ON data_gap (stable_source_id, range_start_ms)`,

      `CREATE TABLE capability_state (
        capability TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        detail_json TEXT
      ) STRICT`,
    ]),
  }),

  Object.freeze({
    version: 3,
    name: 'analysis-lease-expired-tracking',
    statements: Object.freeze([
      // 租约过期只做标记与核对，不改状态：把"过期"当成"可以重排"是自动重试的伪装。
      `ALTER TABLE analysis_outbox ADD COLUMN lease_expired INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX analysis_outbox_lease_idx ON analysis_outbox (state, lease_expires_at_ms)`,
    ]),
  }),

  Object.freeze({
    version: 4,
    name: 'audit-chain-head-record',
    statements: Object.freeze([
      // 链头必须**自证**：单行记录，用 auditKey 对自身内容做 HMAC。
      //
      // 为什么不是 meta 里的几行：`meta` 是普通的可写键值表，删掉
      // `audit_head_sequence`/`audit_head_digest` 就能让整条审计链"看起来是从没
      // 存在过"，把 `audit_hmac_from_sequence` 改大就能整体跳过验签。
      // 把锚点、模式、密钥指纹、验签起点合并进一条**被签名**的记录之后，
      // 删掉它 = 链头缺失（失败关闭），改它 = HMAC 不匹配（失败关闭）。
      `CREATE TABLE audit_chain_head (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        digest TEXT NOT NULL,
        hmac_mode TEXT NOT NULL CHECK (hmac_mode IN ('placeholder','hmac-sha256','mixed')),
        key_id TEXT NOT NULL,
        hmac_from_sequence INTEGER NOT NULL CHECK (hmac_from_sequence >= 1),
        updated_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        hmac TEXT NOT NULL
      ) STRICT`,

      // 重投要能算"距上次重投多久"，又不能让最早的投递时间被覆盖掉
      // （那是"这条 Grant 什么时候第一次出门"的唯一记录）。
      `ALTER TABLE execution_outbox ADD COLUMN last_redeliver_at TEXT`,
    ]),
  }),

  Object.freeze({
    version: 5,
    name: 'daemon-contribution-spool',
    statements: Object.freeze([
      // ADR-0007：daemon 写不出去的告警贡献先落盘，重启后继续补记。
      //
      // 为什么在库里而不是 daemon 的 checkpoint：checkpoint 有 512KB 上限且超限整份隔离，
      // 一次降级批次就能把它撑爆，连游标一起丢。这张表只装"待办清单"（daemon 自己生成的
      // 告警/分析请求 DTO），不参与告警合并，也不构成第二份真相——真正的告警行仍由 T1 写。
      //
      // `spool_id` 由内容派生（来源 + 窗口键 + 证据 id），所以同一份证据重试多少次都只占一行；
      // 队列规模由"未解决的写失败 × 不同窗口数"决定，而不是由重试次数决定。
      `CREATE TABLE daemon_contribution_spool (
        spool_id TEXT PRIMARY KEY,
        source_id TEXT,
        windows_json TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT`,

      `CREATE INDEX daemon_contribution_spool_source_idx ON daemon_contribution_spool (source_id, updated_at)`,
    ]),
  }),
]);

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, entry) => (entry.version > max ? entry.version : max),
  0,
);

/** 本二进制能读的最低 schema 版本。低于它的库必须先迁移，不能直接读。 */
export const MIN_READABLE_SCHEMA_VERSION = 1;

export function schemaChecksum(migration) {
  return sha256Hex(JSON.stringify({ version: migration.version, name: migration.name, statements: migration.statements }));
}
