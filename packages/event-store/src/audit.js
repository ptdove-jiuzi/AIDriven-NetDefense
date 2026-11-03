/**
 * 审计链：追加与验证。
 *
 * 关键设计：`appendAudit` **只能**在事务内调用（`requireTx`）。审计条目是
 * "这次事务发生了什么" 的证明，如果允许在事务外写，就会出现
 * "业务回滚了但审计留下了" 或反过来的不一致账。
 *
 * ## 链头必须自证（P0-1 / P0-2）
 *
 * 早期实现把锚点留在 `meta` 里（`audit_head_sequence` / `audit_head_digest`），
 * 并把"当前密钥从哪一条起生效"放在另一个普通键（`audit_hmac_from_sequence`）。
 * 这两处都是**可写、无签名**的行，于是：
 *
 * - 两条 SQL（删锚点 + 清空 `audit_event`）就能让整条链"看起来从没存在过"，
 *   而 `verifyAuditChainInStore` 还会返回 `ok: true, hmacVerified: true`；
 * - 把 `from_sequence` 改大就能让验签一行都不覆盖，却仍报 `partial`、`ok: true`。
 *
 * 现在锚点、HMAC 模式、密钥指纹与验签起点合并成 **`audit_chain_head` 表的单行
 * 记录**，并用 auditKey（未注入密钥时用公开占位密钥）对这条记录自身做 HMAC：
 *
 * 1. `verifyAuditChainInStore` 先验链头记录的存在性与 HMAC，再验事件链；
 * 2. 链头缺失 + 库已被初始化过（有 `epoch`/`boot_id` 等）→ 失败关闭，不放行成空库；
 * 3. 事件链与链头锚点不一致（删尾部、删整表）→ 失败关闭；
 * 4. `hmac_from_sequence` 只能从链头记录读，改 meta 不再有任何效果。
 *
 * **"通过"的判定**：`ok === true && hmacVerified === true`。
 * `hmacVerified` 为 `null`（没有密钥 / 空链）或 `'partial'`（窗口内有未被
 * 当前密钥覆盖的行，见返回值的 `unverified_from`/`unverified_to`）时，
 * 都**不构成**验签通过的证据，调用方不得当成通过。
 *
 * HMAC 说明（必须如实写清，不做过度承诺）：
 * - 传入 `auditKey` 时，`hmac` = HMAC-SHA256(key, 规范化的记录字段)，base64 输出；
 * - 未传入时，使用仓库内公开的占位密钥，并在 `meta.audit_hmac_mode` 记为
 *   `placeholder`。此时审计链只能证明"记录彼此接得上"，**不能**证明来源。
 * - 真实部署的密钥注入与轮换属于 daemon/installer 职责，本包只做算法与结构。
 * - `meta.audit_hmac_mode` / `meta.audit_key_id` / `meta.audit_hmac_from_sequence`
 *   现在只是**给控制台看的镜像**，安全判定一律读链头记录。
 */

import { validateAuditEvent, verifyAuditChain } from '../../contracts/src/index.js';

import { STORE_CODES, StoreError } from './errors.js';
import { GENESIS_DIGEST, canonicalDigest, canonicalize, hmacBase64, sha256Hex } from './util.js';

/** 未注入密钥时使用的公开占位密钥：能算 HMAC，但不构成任何信任。 */
export const PLACEHOLDER_AUDIT_KEY = 'aegis-audit-placeholder-key';

/** 链头记录的表名（单行，`id = 1`）。 */
export const AUDIT_CHAIN_HEAD_TABLE = 'audit_chain_head';
/** 链头记录的主键：表里永远只有这一行。 */
export const AUDIT_CHAIN_HEAD_ID = 1;
/** 链头记录的 `schemaVersion`（与事件链的版本解耦，便于将来单独演进）。 */
export const AUDIT_CHAIN_HEAD_SCHEMA_VERSION = '1.0';
/**
 * 链头记录随哪个 schema 迁移引入。
 *
 * 迁移时用它区分两种"链头缺失"：刚从旧 schema 升上来（合法，必须重建）
 * 与 已经在 v4 上跑过却被删掉（抹除证据，必须失败关闭）。
 */
export const AUDIT_CHAIN_HEAD_SCHEMA_MIGRATION = 4;

export const AUDIT_ACTIONS = Object.freeze({
  INGEST: 'telemetry.ingest',
  BUDGET_RESERVE: 'budget.reserve',
  BUDGET_TRANSITION: 'budget.transition',
  BUDGET_EPOCH_ROTATE: 'budget.epoch_rotate',
  ANALYSIS_CLAIM: 'analysis.claim',
  ANALYSIS_RUNNING: 'analysis.running',
  ANALYSIS_COMPLETE: 'analysis.complete',
  ANALYSIS_FAIL: 'analysis.fail',
  ANALYSIS_QUARANTINE: 'analysis.quarantine',
  PROPOSAL_CREATE: 'proposal.create',
  APPROVAL_PENDING: 'approval.pending',
  APPROVAL_APPROVE: 'approval.approve',
  APPROVAL_CONSUME: 'approval.consume',
  EXECUTION_CREATE: 'execution.create',
  EXECUTION_DISPATCH: 'execution.dispatch',
  EXECUTION_ACCEPT: 'execution.accept',
  EXECUTION_EXECUTING: 'execution.executing',
  EXECUTION_SETTLE: 'execution.settle',
  EXECUTION_UNKNOWN: 'execution.result_unknown',
  EXECUTION_RECONCILE: 'execution.reconcile',
  EXECUTION_MANUAL: 'execution.manual_required',
  RECOVERY_TRANSITION: 'recovery.transition',
  RETENTION_SWEEP: 'retention.sweep',
  CAPACITY_ACTION: 'capacity.action',
  DATA_GAP: 'data.gap',
  BACKUP_CREATE: 'backup.create',
  RESTORE_WAL_DISCARD: 'restore.wal_discarded',
  RESTORE_CHAIN_UNVERIFIED: 'restore.chain_unverified',
  EPOCH_ROTATE: 'epoch.rotate',
  AUDIT_RESEAL: 'audit.reseal',
  AUDIT_CHAIN_HEAD_REBUILD: 'audit.chain_head_rebuild',
});

/* ------------------------------------------------------------------ */
/* 链头记录：读写、自证、模式判定                                        */
/* ------------------------------------------------------------------ */

/** 与 db.js 使用同一算法，保证两处指纹一致。 */
export function auditKeyId(key) {
  return sha256Hex(`aegis-audit-key:${key}`).slice(0, 32);
}

/** 当前句柄的口令模式（只看"有没有注入密钥"，不看链上历史）。 */
function currentModeOf(store) {
  return store.auditKey === null ? 'placeholder' : 'hmac-sha256';
}

function currentKeyIdOf(store) {
  return store.auditKey === null ? 'none' : auditKeyId(store.auditKey);
}

/** 签链头记录用的密钥：占位模式用公开占位密钥，其它情况用注入的 auditKey。 */
function chainHeadSigningKey(store, mode) {
  if (mode === 'placeholder') return PLACEHOLDER_AUDIT_KEY;
  return store.auditKey ?? PLACEHOLDER_AUDIT_KEY;
}

function chainHeadValue(input) {
  return {
    schemaVersion: AUDIT_CHAIN_HEAD_SCHEMA_VERSION,
    sequence: input.sequence,
    digest: input.digest,
    hmac_mode: input.hmac_mode,
    key_id: input.key_id,
    hmac_from_sequence: input.hmac_from_sequence,
  };
}

function chainHeadMacInput(value) {
  return canonicalize(chainHeadValue(value));
}

function chainHeadTableExists(store) {
  return store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [AUDIT_CHAIN_HEAD_TABLE]) !== null;
}

/** 链头表是否已经建好（区分"旧 schema 未迁移"与"链头被删"）。 */
export function auditChainHeadTableExists(store) {
  return chainHeadTableExists(store);
}

/** 表尾（事件链的真实最后一条）；空表返回创世锚点。 */
function chainTail(store) {
  const row = store.get('SELECT sequence, record_digest FROM audit_event ORDER BY sequence DESC LIMIT 1');
  if (row === null) return { sequence: 0, digest: GENESIS_DIGEST };
  return { sequence: Number(row.sequence), digest: String(row.record_digest) };
}

/**
 * 读链头记录。
 *
 * @returns {null | { sequence: number, digest: string, hmac_mode: string, key_id: string,
 *   hmac_from_sequence: number, canonical: string, hmac: string }} 尚未建表或尚未写入时返回 `null`。
 */
export function readAuditChainHead(store) {
  if (!chainHeadTableExists(store)) return null;
  const row = store.get(`SELECT * FROM ${AUDIT_CHAIN_HEAD_TABLE} WHERE id = ?`, [AUDIT_CHAIN_HEAD_ID]);
  if (row === null) return null;
  return {
    sequence: Number(row.sequence),
    digest: String(row.digest),
    hmac_mode: String(row.hmac_mode),
    key_id: String(row.key_id),
    hmac_from_sequence: Number(row.hmac_from_sequence),
    canonical: String(row.canonical_json),
    hmac: String(row.hmac),
  };
}

/**
 * 写链头记录（整行覆盖），并把三个 meta 键同步成镜像。
 *
 * meta 镜像只是给人看的：任何安全判定都必须读这条被签名的记录。
 */
function writeAuditChainHead(store, next, now) {
  const value = chainHeadValue(next);
  const canonical = canonicalize(value);
  const hmac = hmacBase64(chainHeadSigningKey(store, next.hmac_mode), canonical);
  store.run(
    `INSERT INTO ${AUDIT_CHAIN_HEAD_TABLE}
       (id, sequence, digest, hmac_mode, key_id, hmac_from_sequence, updated_at, canonical_json, hmac)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       sequence = excluded.sequence,
       digest = excluded.digest,
       hmac_mode = excluded.hmac_mode,
       key_id = excluded.key_id,
       hmac_from_sequence = excluded.hmac_from_sequence,
       updated_at = excluded.updated_at,
       canonical_json = excluded.canonical_json,
       hmac = excluded.hmac`,
    [
      AUDIT_CHAIN_HEAD_ID,
      value.sequence,
      value.digest,
      value.hmac_mode,
      value.key_id,
      value.hmac_from_sequence,
      now,
      canonical,
      hmac,
    ],
  );
  store.setMeta('audit_hmac_mode', value.hmac_mode);
  store.setMeta('audit_key_id', value.key_id);
  store.setMeta('audit_hmac_from_sequence', String(value.hmac_from_sequence));
  return value;
}

/**
 * 验链头记录自己的 HMAC，返回判定而不是直接抛。
 *
 * 四种结果：
 * - `verified`：签名与内容自洽（占位模式用公开占位密钥验证，仍能抓"改过内容"）；
 * - `unverifiable_no_key`：链头是真实密钥签的，但本句柄没有密钥 → 无法归因；
 * - `foreign_key`：链头是**另一把**真实密钥签的（换钥、恢复他人备份）；
 * - `tampered`：用能拿到的密钥复算，HMAC 与内容对不上 → 锚点被改过。
 *
 * 为什么不在 `ensureAuditChainHead` 里对 `foreign_key` 抛错：换钥之后库仍然
 * 必须能被打开（只读核对、运维确认、`repairAuditMode` 都需要它），
 * "不能继续写"由 `resolveAuditMode() === 'mixed'` 表达。
 */
function auditChainHeadAuth(store, head) {
  if (head.hmac_mode === 'placeholder') {
    return hmacBase64(PLACEHOLDER_AUDIT_KEY, head.canonical) === head.hmac ? 'verified' : 'tampered';
  }
  if (store.auditKey === null) return 'unverifiable_no_key';
  if (head.key_id !== auditKeyId(store.auditKey)) return 'foreign_key';
  return hmacBase64(store.auditKey, head.canonical) === head.hmac ? 'verified' : 'tampered';
}

/**
 * 链头的**列**必须与它自己被签名的那段文本逐字节一致。
 *
 * 列是读路径的权威，而 HMAC 只覆盖 `canonical_json`。若两者不做比对，一条
 * `UPDATE audit_chain_head SET sequence = ...` 就能回拨/清空锚点而 HMAC 仍然自洽
 * —— 退化后的形态与"全新空库"不可区分，原始缺陷（抹除证据仍自证通过）随即复活。
 *
 * 这个检查与"用哪把密钥验"无关，因此 `verify` 与 `append` 两条路径都必须先过它。
 */
function assertChainHeadColumnsSigned(head) {
  const recomputed = chainHeadMacInput({
    sequence: head.sequence,
    digest: head.digest,
    hmac_mode: head.hmac_mode,
    key_id: head.key_id,
    hmac_from_sequence: head.hmac_from_sequence,
  });
  if (recomputed !== head.canonical) {
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit chain head columns do not match their signed content (the anchor was rewritten)',
      { sequence: head.sequence, hmac_mode: head.hmac_mode },
    );
  }
}

/** 断言链头记录自洽；不一致即视为锚点被篡改，失败关闭。 */
function assertAuditChainHeadAuthentic(store, head) {
  assertChainHeadColumnsSigned(head);
  const status = auditChainHeadAuth(store, head);
  if (status === 'tampered') {
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit chain head record HMAC mismatch (the anchor itself was tampered with)',
      { sequence: head.sequence, hmac_mode: head.hmac_mode },
    );
  }
  return status;
}

/**
 * 当前句柄下这条链的**有效模式**。
 *
 * 与链头记录里存的 `hmac_mode` 不同：如果库里的链是 A 密钥签的、而当前句柄
 * 拿的是 B 密钥（或根本没拿密钥），有效模式就是 `mixed`——追加一律失败关闭。
 * 这条规则只影响"能不能继续写"，不改变链头记录（改它需要真密钥）。
 */
export function resolveAuditMode(store, head) {
  if (head === null) return currentModeOf(store);
  if (head.hmac_mode === 'mixed') return 'mixed';
  if (head.hmac_mode === 'placeholder') return store.auditKey === null ? 'placeholder' : 'hmac-sha256';
  if (store.auditKey === null) return 'mixed';
  return head.key_id === auditKeyId(store.auditKey) ? 'hmac-sha256' : 'mixed';
}

/** 逐行复核遗留行的 HMAC；任何一行不匹配即视为"无法确认历史"。 */
function legacyRowsVerifiable(store, tailSeq) {
  if (tailSeq === 0) return true;
  if (store.auditKey === null) return false;
  for (const row of store.all('SELECT sequence, canonical_json, hmac FROM audit_event ORDER BY sequence')) {
    let value;
    try {
      value = JSON.parse(String(row.canonical_json));
    } catch {
      return false;
    }
    if (hmacBase64(store.auditKey, hmacInput(value)) !== String(row.hmac)) return false;
  }
  return true;
}

/**
 * 确保链头记录存在并与当前密钥状态一致（每次可写打开、每次迁移后调用）。
 *
 * 行为矩阵：
 *
 * | 链头 | 事件表 | 结论 |
 * |---|---|---|
 * | 有 | 任意 | 先自证，再按密钥状态对齐（占位 → 真实密钥时重封起点） |
 * | 无 | 有行 | 刚随迁移引入链头表（`chainHeadIntroduced`）→ 重建锚点并**写审计行**；否则视为抹除 → `null` |
 * | 无 | 空 | 迁移刚引入链头 → 静默建空链头；否则（库已初始化过）→ `null`，由 verify/append 失败关闭 |
 *
 * 关键取舍：这里**不**在"已被抹除"的情况下替调用方重建锚点。宁可让后续
 * `appendAudit`/`verifyAuditChainInStore` 硬失败，也不能把"证据没了"洗成"空库"。
 * 唯一的合法重建出口是 `migrate`（旧库升级）与运维显式调用的 `repairAuditMode`。
 *
 * @param {object} store 可写句柄。
 * @param {{ now?: string, chainHeadIntroduced?: boolean, rebuild?: boolean }} [options]
 *   `chainHeadIntroduced` 由 `migrate` 传入（本次是否刚创建链头表）；
 *   `rebuild: true` 是运维/测试的显式改写授权，等价于"我确认这是重建而不是抹除"。
 * @returns {null | object} 处理后的链头记录（无表或已抹除时为 `null`）。
 */
export function ensureAuditChainHead(store, options = {}) {
  store.assertWritable('ensureAuditChainHead');
  if (!chainHeadTableExists(store)) return null;
  const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
  const introduced = options.chainHeadIntroduced === true;
  const head = readAuditChainHead(store);
  const tail = chainTail(store);

  if (head === null) {
    if (tail.sequence === 0) {
      const initializedBefore = store.getMeta('epoch') !== null || store.getMeta('audit_hmac_mode') !== null;
      if (initializedBefore && !introduced) {
        // 库已经被用过（有 epoch/模式镜像），但链头没了、链也空了：
        // 这就是"两条 SQL 抹除证据"的形状，不建头，交给 verify/append 硬失败。
        return null;
      }
      return store.tx('audit-chain-head-init', () => {
        writeAuditChainHead(store, {
          sequence: 0,
          digest: GENESIS_DIGEST,
          hmac_mode: currentModeOf(store),
          key_id: currentKeyIdOf(store),
          hmac_from_sequence: 1,
        }, now);
        return readAuditChainHead(store);
      });
    }
    // 旧库（schema < 4）升上来：链有行但没有链头。按重封语义重建，并留审计行。
    //
    // **只有"刚刚引入链头表"这一次才算合法重建**：表已经在、迁移已记账、链头却没
    // 了，说明是"删掉锚点 + 删掉尾部"——那样重建会把截断洗成正常状态，
    // 只在库里留下一条"重建过"的痕迹，等于让抹除有了合法外衣。这种情况一律
    // 返回 null（随后 verify/append 硬失败），人工出口只有 repairAuditMode。
    if (!introduced && options.rebuild !== true) return null;
    return store.tx('audit-chain-head-rebuild', () => {
      const fromSequence = legacyRowsVerifiable(store, tail.sequence) ? 1 : tail.sequence + 1;
      writeAuditChainHead(store, {
        sequence: tail.sequence,
        digest: tail.digest,
        hmac_mode: currentModeOf(store),
        key_id: currentKeyIdOf(store),
        hmac_from_sequence: fromSequence,
      }, now);
      appendAudit(store, {
        action: AUDIT_ACTIONS.AUDIT_CHAIN_HEAD_REBUILD,
        actorType: 'system',
        actorId: 'aegis-store',
        objectDigest: sha256Hex(`audit-chain-head-rebuild:${tail.sequence}:${tail.digest}`),
        payload: {
          reason: 'chain_head_missing_on_legacy_schema',
          rebuilt_from_sequence: tail.sequence,
          hmac_from_sequence: fromSequence,
          legacy_rows_verifiable: fromSequence === 1,
        },
        timestamp: now,
      });
      return readAuditChainHead(store);
    });
  }

  const authentication = assertAuditChainHeadAuthentic(store, head);
  if (authentication !== 'verified') {
    // 没有密钥（或密钥指纹不匹配）：不改链头，只在有效模式上体现"不能继续写"。
    return head;
  }
  const upgradeFromPlaceholder = head.hmac_mode === 'placeholder' && store.auditKey !== null;
  if (!upgradeFromPlaceholder) return head;
  // 占位 → 真实密钥：重封。旧行用公开占位密钥签的，只能证明结构、不能归因，
  // 因此把"当前密钥从哪一条起生效"推到下一条，并如实报 partial。
  return store.tx('audit-chain-head-reseal', () => {
    writeAuditChainHead(store, {
      sequence: head.sequence,
      digest: head.digest,
      hmac_mode: currentModeOf(store),
      key_id: currentKeyIdOf(store),
      hmac_from_sequence: Math.max(tail.sequence + 1, head.hmac_from_sequence),
    }, now);
    return readAuditChainHead(store);
  });
}

/**
 * 显式修复审计链的 HMAC 模式（管理员动作，写审计）。
 *
 * 没有这个入口，一旦链被判为 `mixed`（换钥、恢复他人备份），**所有写事务**
 * 都会因为追加审计失败而失败，库变成只读——失败关闭是对的，
 * 但必须留一条"人工确认后重新起链"的合法出口，否则只能删库重建。
 *
 * 它同时是"链头被抹除"之后唯一的人工出口：`acknowledge: true` 明确表示
 * 运维接受"早先的 HMAC 无法验证"，随后用当前表尾重建锚点并写一条
 * `audit.reseal`——重建有账可查，抹除没有。
 */
export function repairAuditMode(store, input = {}) {
  store.assertWritable('repairAuditMode');
  if (input.acknowledge !== true) {
    throw new StoreError(
      STORE_CODES.ERR_STORE_INPUT,
      'repairAuditMode requires acknowledge: true (the operator accepts that earlier HMACs cannot be verified)',
    );
  }
  return store.tx('audit-reseal', () => {
    const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
    const previousHead = readAuditChainHead(store);
    const previous = previousHead === null ? null : previousHead.hmac_mode;
    const next = currentModeOf(store);
    const tail = chainTail(store);
    // 重封之后当前密钥只对**之后**的行负责。
    writeAuditChainHead(store, {
      sequence: tail.sequence,
      digest: tail.digest,
      hmac_mode: next,
      key_id: currentKeyIdOf(store),
      hmac_from_sequence: tail.sequence + 1,
    }, now);
    appendAudit(store, {
      action: AUDIT_ACTIONS.AUDIT_RESEAL,
      actorType: input.actorType ?? 'cli',
      actorId: input.actorId ?? 'aegis-cli',
      objectDigest: '0'.repeat(64),
      payload: {
        previous_mode: previous,
        next_mode: next,
        reason: input.reason ?? 'operator_reseal',
        chain_head_was_missing: previousHead === null,
      },
      timestamp: now,
    });
    return Object.freeze({ previous_mode: previous, mode: next });
  });
}

export function auditHead(store) {
  store.assertOpen('auditHead');
  const tail = chainTail(store);
  const head = readAuditChainHead(store);
  return {
    sequence: tail.sequence,
    digest: tail.digest,
    anchored_sequence: head === null ? null : head.sequence,
    anchored: head !== null && head.sequence === tail.sequence && head.digest === tail.digest,
  };
}

function hmacInput(value) {
  // 只覆盖"决定这条记录身份"的字段；hmac 自身不能进入被签名内容。
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
 * 追加一条审计记录。必须在调用方事务内执行。
 *
 * 追加前后各做一次"证据不能被静默抹除"的检查：
 * 1. 链头记录必须存在（被删 = 拒绝追加，绝不把新行挂到无名锚点上）；
 * 2. 表尾必须与链头锚点一致（尾部被删 = 拒绝追加，否则攻击者可以先删证据
 *    再让链"重新自洽"地往下长）；
 * 3. 追加成功后把链头推进到新行——行与锚点在**同一事务**里提交。
 *
 * @param {object} store
 * @param {object} entry
 * @param {string} entry.action 审计动作（见 AUDIT_ACTIONS）。
 * @param {string} entry.actorType daemon/broker/worker/console/cli/collector/helper/system。
 * @param {string} entry.actorId OS 账户标识。
 * @param {string} entry.objectDigest 被操作对象的规范化摘要。
 * @param {unknown} [entry.payload] 附加数据，只存摘要不存原文。
 * @param {string} [entry.timestamp]
 * @returns {{ sequence: number, digest: string }}
 */
export function appendAudit(store, entry) {
  store.requireTx('appendAudit');
  const chainHead = readAuditChainHead(store);
  if (chainHead === null) {
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit chain head record is missing; refusing to append (the chain anchor was erased)',
    );
  }
  // 锚点的列必须仍与它被签名的那段文本一致，否则"删证据 + 把锚点列归零"可以让
  // 链从 1 重新长起来，抹除就变成了正常状态。
  assertChainHeadColumnsSigned(chainHead);
  const mode = resolveAuditMode(store, chainHead);
  if (mode === 'mixed') {
    throw new StoreError(
      STORE_CODES.ERR_NOT_SUPPORTED,
      'audit HMAC mode is mixed (key changed between runs); refusing to append',
    );
  }
  if (entry === null || typeof entry !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'appendAudit requires an entry object');
  }
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : store.clock.nowIso();
  const previous = chainTail(store);
  if (previous.sequence !== chainHead.sequence
    || (previous.sequence > 0 && previous.digest !== chainHead.digest)) {
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit chain diverges from its anchored head (rows were deleted or rewritten); refusing to append',
      { anchored: chainHead.sequence, actual: previous.sequence },
    );
  }
  const sequence = previous.sequence + 1;

  const draft = {
    schemaVersion: '1.0',
    sequence,
    timestamp,
    actor: { type: entry.actorType ?? 'daemon', id: entry.actorId ?? 'daemon' },
    action: entry.action,
    object_digest: entry.objectDigest,
    previous_digest: previous.digest,
    payload_digest: canonicalDigest(entry.payload ?? {}),
    hmac: '',
  };
  draft.hmac = hmacBase64(store.auditKey ?? PLACEHOLDER_AUDIT_KEY, hmacInput(draft));

  const record = validateAuditEvent(draft);
  // timestamp_ms 不是链的一部分（它由 timestamp 派生），所以写入时就必须
  // 强制"列值 === 解析值"：否则单改这一列能让按时间的查询与审计内容对不上，
  // 而链校验完全看不见。
  const timestampMs = Date.parse(record.value.timestamp);
  if (!Number.isFinite(timestampMs)) {
    throw new StoreError(
      STORE_CODES.ERR_STORE_INPUT,
      `audit timestamp is not parseable: ${String(record.value.timestamp)}`,
    );
  }
  store.run(
    `INSERT INTO audit_event (
       sequence, timestamp, timestamp_ms, actor_type, actor_id, action,
       object_digest, previous_digest, payload_digest, hmac, record_digest, canonical_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.value.sequence,
      record.value.timestamp,
      timestampMs,
      record.value.actor.type,
      record.value.actor.id,
      record.value.action,
      record.value.object_digest,
      record.value.previous_digest,
      record.value.payload_digest,
      record.value.hmac,
      record.digest,
      canonicalize(record.value),
    ],
  );
  // 行与锚点同一事务提交：任何"只删行不删锚点 / 只删锚点不删行"的状态
  // 都会在下一次校验里暴露。
  writeAuditChainHead(store, {
    sequence: record.value.sequence,
    digest: record.digest,
    hmac_mode: chainHead.hmac_mode,
    key_id: chainHead.key_id,
    hmac_from_sequence: chainHead.hmac_from_sequence,
  }, timestamp);
  return Object.freeze({ sequence: record.value.sequence, digest: record.digest });
}

/**
 * 校验审计链。
 *
 * 顺序是刻意的——先证锚点，再证链：
 * 1. 链头记录必须存在，且它自己的 HMAC 必须与内容自洽；
 * 2. 链上最后一条必须与锚点（sequence + digest）逐字相同；
 * 3. 记录彼此接得上（摘要自洽、序号连续、前驱摘要相接）；
 * 4. 每行的 `timestamp_ms` 必须等于 `Date.parse(timestamp)`；
 * 5. 锚点 `hmac_from_sequence` 之后的行必须通过 HMAC。
 *
 * 任一条不成立都抛 `StoreError`：`ERR_DB_INTEGRITY`（锚点/内列/摘要问题）
 * 或 `ContractError(ERR_AUDIT_CHAIN_BROKEN)`（链结构被改过）。
 *
 * **“通过”的判定收窄为 `ok === true && hmacVerified === true`。**
 * - `hmacVerified === null`：没有注入密钥，或链是占位密钥签的 → 只证明结构；
 * - `hmacVerified === 'partial'`：窗口内存在当前密钥覆盖不到的行，
 *   见 `unverified_from` / `unverified_to`（闭区间）。
 *
 * 这两种情况都**不是**通过，调用方不得把它们当成验签成功。
 *
 * @param {object} store
 * @param {{ from?: number, to?: number }} [options]
 * @returns {{ ok: boolean, length: number, from: number, to: number,
 *   hmacVerified: boolean|'partial'|null, unverified_from: number|null,
 *   unverified_to: number|null, head: { sequence: number, digest: string } }}
 */
export function verifyAuditChainInStore(store, options = {}) {
  store.assertOpen('verifyAuditChainInStore');
  const from = Number.isInteger(options.from) ? options.from : 1;
  // 先证锚点：没有它，下面所有比较都可以被"删锚点"绕开。
  const anchored = readAuditChainHead(store);
  if (anchored === null) {
    const initialized = store.getMeta('epoch') !== null || store.getMeta('boot_id') !== null;
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit chain head record is missing; the chain anchor cannot be proven to exist',
      { reason: initialized ? 'chain_head_missing_after_initialization' : 'chain_head_missing', initialized },
    );
  }
  const authentication = assertAuditChainHeadAuthentic(store, anchored);
  if (authentication === 'foreign_key') {
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit chain head was signed by a different key than the one supplied; the chain cannot be attested',
      { head_key_id: anchored.key_id, current_key_id: auditKeyId(store.auditKey) },
    );
  }
  const anchoredHead = { sequence: anchored.sequence, digest: anchored.digest };

  const rows = store.all(
    'SELECT sequence, timestamp, timestamp_ms, canonical_json, record_digest, hmac FROM audit_event WHERE sequence >= ? ORDER BY sequence',
    [from],
  );
  const records = rows.map((row) => {
    let value;
    try {
      value = JSON.parse(String(row.canonical_json));
    } catch {
      throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, `audit row ${row.sequence} has unparseable JSON`);
    }
    if (String(row.timestamp) !== String(value.timestamp)) {
      throw new StoreError(
        STORE_CODES.ERR_DB_INTEGRITY,
        `audit row ${row.sequence} has a timestamp column that does not match its signed content`,
        { sequence: Number(row.sequence) },
      );
    }
    const timestampMs = Date.parse(String(value.timestamp));
    if (!Number.isFinite(timestampMs) || timestampMs !== Number(row.timestamp_ms)) {
      throw new StoreError(
        STORE_CODES.ERR_DB_INTEGRITY,
        `audit row ${row.sequence} has a timestamp_ms column that does not match its timestamp`,
        { sequence: Number(row.sequence), timestamp_ms: Number(row.timestamp_ms), expected_ms: timestampMs },
      );
    }
    return { digest: String(row.record_digest), value, hmac: String(row.hmac) };
  });

  if (records.length === 0) {
    // 空表只在"锚点也是空链"时才是正常的空库；否则就是整表被清空。
    if (anchored.sequence !== 0) {
      throw new StoreError(
        STORE_CODES.ERR_DB_INTEGRITY,
        'audit chain is empty but the signed chain head still anchors a head (full truncation)',
        { anchored: anchored.sequence },
      );
    }
    return Object.freeze({
      ok: true,
      length: 0,
      from,
      to: from - 1,
      // 空链没有任何可验证的签名：如实报 null，绝不报 true。
      hmacVerified: null,
      unverified_from: null,
      unverified_to: null,
      head: anchoredHead,
    });
  }

  const verification = verifyAuditChain(records);

  // 与链头锚点比对：能抓到"删除尾部若干条"这种对链接检查完全不可见的篡改。
  const last = records[records.length - 1];
  if (last.value.sequence !== anchored.sequence || last.digest !== anchored.digest) {
    throw new StoreError(
      STORE_CODES.ERR_DB_INTEGRITY,
      'audit head does not match the anchored chain head (tail truncation)',
      { anchored: anchored.sequence, actual: last.value.sequence },
    );
  }

  // 只校验"链头记录的 hmac_from_sequence 之后"的行。这个值来自被签名的链头，
  // 改 meta 里的同名字段不会让任何一行被跳过。
  const hmacFrom = anchored.hmac_from_sequence;
  let hmacVerified = null;
  let unverifiedFrom = null;
  let unverifiedTo = null;
  if (authentication === 'verified' && anchored.hmac_mode !== 'placeholder' && store.auditKey !== null) {
    for (const record of records) {
      if (record.value.sequence < hmacFrom) continue;
      const expected = hmacBase64(store.auditKey, hmacInput(record.value));
      if (expected !== record.value.hmac || expected !== record.hmac) {
        throw new StoreError(
          STORE_CODES.ERR_DB_INTEGRITY,
          `audit row ${record.value.sequence} HMAC mismatch`,
          { sequence: record.value.sequence },
        );
      }
    }
    if (records[0].value.sequence < hmacFrom) {
      // 窗口内有当前密钥覆盖不到的区间 → 如实报 partial 并交出未覆盖区间。
      hmacVerified = 'partial';
      unverifiedFrom = records[0].value.sequence;
      unverifiedTo = Math.min(hmacFrom - 1, records[records.length - 1].value.sequence);
    } else {
      hmacVerified = true;
    }
  }

  return Object.freeze({
    ok: verification.ok,
    length: verification.length,
    from: records[0].value.sequence,
    to: records[records.length - 1].value.sequence,
    hmacVerified,
    unverified_from: unverifiedFrom,
    unverified_to: unverifiedTo,
    head: anchoredHead,
  });
}
