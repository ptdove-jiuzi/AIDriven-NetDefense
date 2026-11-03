/**
 * 一致性备份与恢复。
 *
 * **绝不直接复制活跃的 `-wal` 文件**：WAL 里可能有一半事务，复制出来的库
 * 在另一台机器上要么缺页要么报 malformed。这里只用 SQLite 的 online backup
 * 接口（`node:sqlite` 的 `backup`），它在读事务里取一致快照。
 *
 * 备份完成后立刻**自检**：完整 `integrity_check` + 关键 meta 读取 + 文件摘要。
 * 一个没验过的备份等于没有备份，只是多占了一份磁盘。
 *
 * 恢复是破坏性动作，必须显式指定 `overwrite`；恢复后强制轮换 epoch，
 * 让旧审批/旧授权/旧租约一次性失效（设计 §7.3）。
 *
 * ── 恢复的 WAL 语义（P0：`restoreBackup` 曾删掉目标的 WAL）─────────────
 *
 * 现场形态：灾难恢复时目标库**通常不是干净关闭的**——SIGKILL / 断电会留下
 * 一个非空 `-wal`，里面装着"已经提交、还没并回主库"的事务。旧实现先 `rename`
 * 主库、再 `unlink` 目标的 `-wal`/`-shm`：主库已经换成备份，WAL 却被删了，
 * 那批已提交事务既不在新库（新库是备份快照）也不在旧库副本里，静默消失。
 *
 * 这里采用的策略是 **三件套整体搬迁**（`db` / `-wal` / `-shm` 一起挪到
 * `<name>.pre-restore-<stamp>`，另加同名 `-wal`/`-shm`）：
 *
 * 1. **绝不 `unlink` 目标的任何一件**。旧库连同它的 WAL 一起留在
 *    `previous_copy` 里，`-wal` 与主库仍然配对，SQLite 打开它时会正常重放，
 *    也就是说"恢复点之后的已提交事务"完整保留、可回滚、可导出；
 * 2. **搬迁是可回滚的**：每一步 `rename` 都记账，任何一步失败就逆序搬回，
 *    不允许出现"主库变了而 WAL 被删"的中间态；
 * 3. **搬迁前先判定目标 WAL 是否可合并**：先校验 32 字节 WAL 头（头坏了 SQLite
 *    会**静默忽略整个 WAL**，主库看起来完好、事务却没人认领），再把三件套复制到
 *    临时目录、在副本上跑 `wal_checkpoint(TRUNCATE)` 并读出"含 WAL 的已提交行数"。
 *    - 副本能合并 → 说明现场 WAL 可重放，结果里如实报 `wal.bytes_before`
 *      与 `previous_events`（被换下去的那份数据有多少条）；
 *    - 副本合并失败 / WAL 头不可信 → 默认抛 `ERR_RESTORE_WAL_UNSAFE`；
 *      只有调用方显式 `discardWal: true` 才继续，并在**恢复后的库**里写一条
 *      `restore.wal_discarded` 审计（写不进去就整体回滚，绝不留"丢了数据
 *      还静默成功"的结果）。
 *
 * 语义后果（写进报告的那句话）：恢复是**时间点回退**，不会把恢复点之后的事务
 * 并回新库；但那些事务必须完整保留在 `previous_copy` 里并被计数报告。要使
 * "回退"可证伪，就不允许出现任何一个"删掉旧字节"的动作。
 *
 * 为什么要用副本判定而不是当场 `checkpoint` 目标：当场 checkpoint 会改写现场
 * 字节（WAL 被截断、甚至被 SQLite 删除），回滚就不再是"字节级回到恢复前"。
 * 副本判定不碰现场，回滚 = 纯 `rename`，可以断言行数与 `-wal` 大小都不变。
 * 代价是 WAL 非空时要多复制一份文件（灾难恢复路径上可接受）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

import { STORE_CODES, StoreError, mapSqliteError } from './errors.js';
import { openStore } from './db.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { rotateEpoch } from './budget.js';
import {
  AUDIT_ACTIONS,
  appendAudit,
  auditHead,
  auditKeyId,
  readAuditChainHead,
  verifyAuditChainInStore,
} from './audit.js';
import { sha256Hex } from './util.js';

/** 主库 + 两个 sidecar：恢复时必须作为一个整体搬迁。 */
const TRIO_SUFFIXES = Object.freeze(['', '-wal', '-shm']);


function stampOf(now) {
  return String(now).replace(/[:.]/gu, '-');
}

function fileSha256(filePath) {
  // 直接对字节做摘要：不能先 base64 再摘要，那样得到的是"base64 文本的摘要"。
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 校验一个备份文件是不是"能打开的、完整的、schema 不超前的"库。
 *
 * @param {string} filePath
 * @returns {{ ok: true, schemaVersion: number, epoch: string, pageCount: number, userTables: number }}
 */
export function verifyBackupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new StoreError(STORE_CODES.ERR_BACKUP_FAILED, `backup file does not exist: ${filePath}`);
  }
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch (error) {
    throw mapSqliteError(error, STORE_CODES.ERR_DB_CORRUPT);
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const verdict = integrity === undefined ? null : String(integrity.integrity_check);
    if (verdict !== 'ok') {
      throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, `backup failed integrity_check: ${String(verdict)}`, {
        verdict: String(verdict),
      });
    }
    const metaRows = db.prepare('SELECT key, value FROM meta').all();
    const meta = new Map(metaRows.map((row) => [String(row.key), String(row.value)]));
    const schemaVersion = Number(meta.get('schema_version') ?? 0);
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new StoreError(
        STORE_CODES.ERR_SCHEMA_TOO_NEW,
        `backup schema ${schemaVersion} is newer than this binary`,
      );
    }
    const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
    const userTables = Number(
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().c,
    );
    return Object.freeze({
      ok: true,
      schemaVersion,
      epoch: meta.get('epoch') ?? '',
      pageCount,
      userTables,
    });
  } catch (error) {
    throw error instanceof StoreError ? error : mapSqliteError(error, STORE_CODES.ERR_DB_CORRUPT);
  } finally {
    try {
      db.close();
    } catch {
      // 只读句柄关闭失败无需上抛。
    }
  }
}

/**
 * 给只读的原始连接套一层 `verifyAuditChainInStore` 需要的最小 store 形状。
 *
 * 为什么不直接用 `openStore({ readOnly: true })`：只读打开要求 schema 已经是
 * **当前版本**，而灾难恢复时最可能拿到的恰恰是旧 schema 的备份。验链是"恢复前
 * 的最后一道自证"，不能因为它顺带要求一次迁移而失效。
 */
function createAuditProbe(db, auditKey) {
  return {
    auditKey,
    assertOpen() {
      // 只读探针没有"已关闭"状态需要断言。
    },
    get(sql, params = []) {
      const row = db.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    getMeta(key) {
      const row = this.get('SELECT value FROM meta WHERE key = ?', [key]);
      return row === null ? null : String(row.value);
    },
  };
}

/**
 * 校验备份里的**审计链**（恢复前的必检项）。
 *
 * 只读打开、不改备份一个字节。四种"不能自证"都要显式拒绝，除非调用方
 * 传 `allowUnverifiedChain: true`：
 * - `no_chain_head`：没有链头表/记录（旧 schema 或锚点被抹除）；
 * - `placeholder_key`：链是公开占位密钥签的，任何人都能重算；
 * - `no_key`：本句柄没有密钥，无法复算 HMAC；
 * - `foreign_key`：链头是另一把密钥签的（换钥 / 他人备份）；
 * - `hmac_partial`：只有一段被当前密钥覆盖。
 *
 * 链**自洽性**被破坏（行被改写、尾部被截断、锚点被改）时不走"未验证"分支，
 * 直接抛 `ERR_DB_INTEGRITY`——那种备份不该被"允许未验证"这个开关洗白。
 *
 * @param {string} filePath 备份文件路径。
 * @param {{ auditKey?: string|null }} [options]
 * @returns {Readonly<{ verified: boolean, reason: string, length: number,
 *   hmac_mode: string|null, head_key_id: string|null }>}
 */
export function verifyBackupAuditChain(filePath, options = {}) {
  const auditKey = typeof options.auditKey === 'string' && options.auditKey.length > 0 ? options.auditKey : null;
  let db = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    db.exec('PRAGMA query_only = 1');
    const probe = createAuditProbe(db, auditKey);
    const head = readAuditChainHead(probe);
    if (head === null) {
      return Object.freeze({
        verified: false,
        reason: 'no_chain_head',
        length: 0,
        hmac_mode: null,
        head_key_id: null,
      });
    }
    if (head.hmac_mode === 'placeholder') {
      return Object.freeze({
        verified: false,
        reason: 'placeholder_key',
        length: head.sequence,
        hmac_mode: head.hmac_mode,
        head_key_id: head.key_id,
      });
    }
    if (auditKey === null) {
      return Object.freeze({
        verified: false,
        reason: 'no_key',
        length: head.sequence,
        hmac_mode: head.hmac_mode,
        head_key_id: head.key_id,
      });
    }
    if (head.key_id !== auditKeyId(auditKey)) {
      return Object.freeze({
        verified: false,
        reason: 'foreign_key',
        length: head.sequence,
        hmac_mode: head.hmac_mode,
        head_key_id: head.key_id,
      });
    }
    // 篡改（行被改写 / 截断 / 锚点被改）会在这里抛 ERR_DB_INTEGRITY。
    const verification = verifyAuditChainInStore(probe);
    if (verification.length === 0) {
      // 空链：没有任何行可被篡改，锚点本身的 HMAC 已由上面的校验通过。
      // 记为"自证通过但链为空"，而不是"未验证"——否则一个空库的备份
      // 就永远需要 `allowUnverifiedChain` 才能恢复。
      return Object.freeze({
        verified: true,
        reason: 'empty_chain',
        length: 0,
        hmac_mode: head.hmac_mode,
        head_key_id: head.key_id,
      });
    }
    return Object.freeze({
      verified: verification.ok === true && verification.hmacVerified === true,
      reason: verification.hmacVerified === true ? 'verified' : 'hmac_partial',
      length: verification.length,
      hmac_mode: head.hmac_mode,
      head_key_id: head.key_id,
    });
  } catch (error) {
    if (error instanceof StoreError) throw error;
    // 合同层的 `ERR_AUDIT_*`（例如 ERR_AUDIT_CHAIN_BROKEN）说的是"链被破坏"，
    // 不是"文件损坏"；映射成 ERR_DB_CORRUPT 会让运维去查磁盘而不是查篡改。
    if (error && typeof error.code === 'string' && error.code.startsWith('ERR_AUDIT')) {
      throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, `backup audit chain is broken: ${String(error.message)}`, {
        cause: error.code,
      });
    }
    throw mapSqliteError(error, STORE_CODES.ERR_DB_CORRUPT);
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // 只读句柄关闭失败无需上抛。
      }
    }
  }
}

/** sidecar 大小；不存在返回 `null`（区分"没有 WAL"与"WAL 是 0 字节"）。 */
function sidecarSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * 读 WAL 头 32 字节做结构判定。
 *
 * 为什么必须自己看：WAL 头坏了的时候 SQLite **不会报错**，它会认为"这个 WAL
 * 里没有可重放的帧"，直接忽略整个文件。于是主库看起来完好、`-wal` 还躺在
 * 旁边，但里面那批已提交事务已经没人认领了——正是这次 P0 的失效形态。
 * 头不可信就当作"不可合并"，交给 `discardWal` 显式决定。
 */
function walHeaderVerdict(walPath) {
  let fd = null;
  try {
    fd = fs.openSync(walPath, 'r');
    const header = Buffer.alloc(32);
    const read = fs.readSync(fd, header, 0, 32, 0);
    if (read < 32) return Object.freeze({ ok: false, reason: 'wal_header_truncated' });
    // 前 4 字节：0x377f0682 / 0x377f0683（大小端校验和的两种魔数）。
    const magic = header.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) {
      return Object.freeze({ ok: false, reason: 'wal_header_invalid' });
    }
    if (header.readUInt32BE(4) !== 3007000) {
      return Object.freeze({ ok: false, reason: 'wal_version_unsupported' });
    }
    const pageSize = header.readUInt32BE(8);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
      return Object.freeze({ ok: false, reason: 'wal_page_size_invalid' });
    }
    return Object.freeze({ ok: true, reason: 'ok' });
  } catch {
    return Object.freeze({ ok: false, reason: 'wal_unreadable' });
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关闭失败不影响判定。
      }
    }
  }
}

/** 只读数一遍已提交事件；读不出来就返回 `null`，绝不猜一个数字。 */
function countEventsAt(filePath) {
  let db = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS c FROM telemetry_event').get();
    return row === undefined || row === null ? null : Number(row.c);
  } catch {
    return null;
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // 忽略。
      }
    }
  }
}

/**
 * 恢复前对目标库做一次**不碰现场**的体检。
 *
 * 返回三件事：
 * - `exists`：目标库在不在（第一次恢复到新路径时为 false）；
 * - `wal_bytes`：`-wal` 大小（不存在为 0）；
 * - `mergeable` / `events`：把三件套复制到临时目录、在副本上
 *   `wal_checkpoint(TRUNCATE)` 之后再计数。副本能合并 = 现场 WAL 可重放，
 *   `events` 就是"含 WAL 里的已提交事务"的真实行数。
 *
 * 现场字节一个都不改：回滚必须是纯 `rename`，否则"回滚后与恢复前一致"
 * 只能靠肉眼判断。
 */
function inspectTarget(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return Object.freeze({ exists: false, wal_bytes: 0, mergeable: true, events: null });
  }
  const walBytes = sidecarSize(`${targetPath}-wal`) ?? 0;
  const shmBytes = sidecarSize(`${targetPath}-shm`) ?? 0;
  if (walBytes === 0) {
    // 干净关闭过的库（WAL 为空或不存在）：不需要复制，只读打开即可。
    return Object.freeze({
      exists: true,
      wal_bytes: 0,
      shm_bytes: shmBytes,
      mergeable: true,
      events: countEventsAt(targetPath),
    });
  }

  let scratchDir = null;
  try {
    // 先看 WAL 头：头坏了 SQLite 会静默忽略整个 WAL，这一步之后的所有计数
    // 都不再可信，必须直接把结论标成"不可合并"。
    const header = walHeaderVerdict(`${targetPath}-wal`);
    if (header.ok !== true) {
      return Object.freeze({
        exists: true,
        wal_bytes: walBytes,
        shm_bytes: shmBytes,
        mergeable: false,
        events: null,
        reason: header.reason,
      });
    }
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-restore-probe-'));
    const probePath = path.join(scratchDir, 'probe.db');
    // 先搬 WAL 再搬主库意义不大（没有写者时两者不变），但顺序固定便于排查。
    for (const suffix of TRIO_SUFFIXES) {
      const source = `${targetPath}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${probePath}${suffix}`);
    }
    let db = null;
    try {
      db = new DatabaseSync(probePath, { timeout: 2000 });
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } finally {
      if (db !== null) {
        try {
          db.close();
        } catch {
          // 忽略。
        }
      }
    }
    const remaining = sidecarSize(`${probePath}-wal`) ?? 0;
    if (remaining !== 0) {
      // checkpoint 没把副本的 WAL 清掉：现场 WAL 无法合并（例如库不在 WAL 模式）。
      return Object.freeze({
        exists: true,
        wal_bytes: walBytes,
        shm_bytes: shmBytes,
        mergeable: false,
        events: countEventsAt(probePath),
        reason: 'wal_not_checkpointable',
      });
    }
    return Object.freeze({
      exists: true,
      wal_bytes: walBytes,
      shm_bytes: shmBytes,
      mergeable: true,
      events: countEventsAt(probePath),
    });
  } catch (error) {
    // 副本连打开/重放都做不到：WAL 结构已经坏了。
    return Object.freeze({
      exists: true,
      wal_bytes: walBytes,
      shm_bytes: shmBytes,
      mergeable: false,
      events: null,
      reason: error && error.code ? String(error.code) : 'wal_unreadable',
    });
  } finally {
    if (scratchDir !== null) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // 临时目录残留不影响结论。
      }
    }
  }
}

/** 把三件套里存在的文件按记录搬走（顺序固定：主库 → -wal → -shm）。 */
function moveTrio(fromPath, toPath, moves) {
  for (const suffix of TRIO_SUFFIXES) {
    const source = `${fromPath}${suffix}`;
    if (!fs.existsSync(source)) continue;
    const destination = `${toPath}${suffix}`;
    fs.renameSync(source, destination);
    moves.push(Object.freeze({ from: source, to: destination }));
  }
}

/** 逆序撤销已经完成的搬迁。 */
function undoMoves(moves) {
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index];
    fs.renameSync(move.to, move.from);
  }
}

/** 把新库（恢复出来的那份）整个移除，再把旧三件套搬回去。 */
function rollbackSwap(targetPath, moves) {
  try {
    for (const suffix of TRIO_SUFFIXES) {
      const sidecar = `${targetPath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    undoMoves(moves);
    return Object.freeze({ ok: true, error: null });
  } catch (error) {
    return Object.freeze({ ok: false, error: error && error.code ? String(error.code) : String(error) });
  }
}

/**
 * 把"这次恢复做了哪些让步"写进**恢复后的库**（而不是被换走的旧库，
 * 那样等于把证据写进垃圾桶）。
 *
 * 写审计失败必须向上抛：调用方会在 `restoreBackup` 的 catch 里整体回滚，
 * 因此不存在"丢了 WAL 却没有留痕"的成功结果。
 */
function recordRestoreProvenance(store, input) {
  const now = typeof input.now === 'string' ? input.now : store.clock.nowIso();
  store.tx('restore-provenance', () => {
    if (input.wal.discarded) {
      appendAudit(store, {
        action: AUDIT_ACTIONS.RESTORE_WAL_DISCARD,
        actorType: 'system',
        actorId: 'aegis-restore',
        objectDigest: sha256Hex(`restore-wal-discard:${input.targetPath}:${input.wal.bytes_before}`),
        payload: {
          target: input.targetPath,
          backup: input.backupPath,
          wal_bytes_before: input.wal.bytes_before,
          wal_bytes_after: input.wal.bytes_after,
          mergeable: input.wal.mergeable,
          events_before: input.previousEvents,
          backup_events: input.backupEvents,
          previous_copy: input.previousCopy,
        },
        timestamp: now,
      });
    }
    if (input.chain.verified !== true) {
      appendAudit(store, {
        action: AUDIT_ACTIONS.RESTORE_CHAIN_UNVERIFIED,
        actorType: 'system',
        actorId: 'aegis-restore',
        objectDigest: sha256Hex(`restore-chain-unverified:${input.backupPath}:${input.chain.reason}`),
        payload: {
          backup: input.backupPath,
          reason: input.chain.reason,
          chain_length: input.chain.length,
          hmac_mode: input.chain.hmac_mode,
        },
        timestamp: now,
      });
    }
  });
}

/**
 * 创建一致性备份 + 摘要清单。
 *
 * @param {object} store 必须是可写打开的单写者句柄。
 * @param {{ directory?: string, prefix?: string, now?: string }} [options]
 */
export async function createBackup(store, options = {}) {
  store.assertWritable('createBackup');
  if (store.isInTx()) {
    throw new StoreError(STORE_CODES.ERR_NOT_SUPPORTED, 'backup cannot run inside a transaction');
  }
  const now = typeof options.now === 'string' ? options.now : store.clock.nowIso();
  const directory = typeof options.directory === 'string' && options.directory.length > 0
    ? path.resolve(options.directory)
    : path.join(path.dirname(store.path), 'backups');
  fs.mkdirSync(directory, { recursive: true });
  const fileName = `${options.prefix ?? 'aegis-harness'}-${stampOf(now)}.db`;
  const target = path.join(directory, fileName);
  if (fs.existsSync(target)) {
    throw new StoreError(STORE_CODES.ERR_BACKUP_TARGET_EXISTS, `backup target already exists: ${target}`);
  }

  // checkpoint 把 WAL 内容并回主库，备份体积更小、恢复更快；
  // 一致性本身由 backup 接口保证，不依赖这次 checkpoint。
  try {
    store.checkpoint('TRUNCATE');
  } catch {
    // checkpoint 失败不阻断备份：backup 接口从 WAL 读到的一致快照仍然是正确的。
  }

  try {
    await sqliteBackup(store.db, target);
  } catch (error) {
    throw new StoreError(STORE_CODES.ERR_BACKUP_FAILED, `online backup failed: ${error && error.message}`, {
      target,
    });
  }

  const verified = verifyBackupFile(target);
  const manifest = {
    file: fileName,
    path: target,
    bytes: fs.statSync(target).size,
    sha256: fileSha256(target),
    created_at: now,
    schema_version: verified.schemaVersion,
    epoch: verified.epoch,
    user_tables: verified.userTables,
    audit_head_sequence: auditHead(store).sequence,
    source_path: store.path,
    integrity: 'ok',
  };
  const manifestPath = `${target}.manifest.json`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return Object.freeze({ ...manifest, manifest_path: manifestPath, verified });
}

/**
 * 恢复备份。
 *
 * 恢复后强制轮换 epoch：恢复意味着"世界回到了某个过去的时间点"，
 * 在那之后签发的审批与授权全部不能再生效。
 *
 * 破坏性动作的顺序（每一步都在"改目标库字节"之前完成，失败即抛、目标不动）：
 * 1. 校验备份文件本身（存在 / 完整 / schema 不超前）；
 * 2. 校验备份里的审计链（`verifyBackupAuditChain`），没有自证就走
 *    `ERR_RESTORE_CHAIN_UNVERIFIED` / `allowUnverifiedChain: true` + 审计；
 * 3. `overwrite` 与存活写者检查（绝不在有活写者时动目标）；
 * 4. 目标库体检（含 WAL 的已提交行数、WAL 能否合并），不可合并时默认拒绝；
 * 5. 三件套整体搬迁 + 换入备份，任何一步失败都逆序搬回；
 * 6. 轮换 epoch；失败连**目标库**一起回滚，回滚失败抛
 *    `ERR_RESTORE_ROLLBACK_FAILED` 并交出恢复前后计数。
 *
 * @param {object} options
 * @param {string} options.backupPath 备份文件路径。
 * @param {string} options.targetPath 目标库路径。
 * @param {boolean} [options.overwrite] 目标已存在时必须显式传 true。
 * @param {boolean} [options.discardWal] 目标 WAL 不可合并时仍继续（会在恢复后的
 *   库里写 `restore.wal_discarded` 审计；旧库三件套仍完整留在 previous_copy）。
 * @param {boolean} [options.allowUnverifiedChain] 备份审计链无法自证时仍继续
 *   （会在恢复后的库里写 `restore.chain_unverified` 审计）。
 * @param {object} [options.clock] 注入时钟。
 * @param {string} [options.auditKey] 审计 HMAC 密钥。
 * @param {string} [options.epoch] 指定新 epoch（默认随机）。
 * @param {string} [options.now] 恢复时间戳。
 */
export function restoreBackup(options = {}) {
  if (typeof options.backupPath !== 'string' || typeof options.targetPath !== 'string') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'restoreBackup requires backupPath and targetPath');
  }
  const backupPath = path.resolve(options.backupPath);
  const targetPath = path.resolve(options.targetPath);
  const discardWal = options.discardWal === true;
  const allowUnverifiedChain = options.allowUnverifiedChain === true;

  // 1) 备份本身能不能打开。
  const verified = verifyBackupFile(backupPath);
  const backupEvents = countEventsAt(backupPath);

  // 2) 备份里的审计链能不能自证。这一步只读，不改任何文件。
  const chain = verifyBackupAuditChain(backupPath, { auditKey: options.auditKey });
  if (!chain.verified && !allowUnverifiedChain) {
    throw new StoreError(
      STORE_CODES.ERR_RESTORE_CHAIN_UNVERIFIED,
      'backup audit chain cannot be attested; refusing to overwrite the live database with it',
      {
        backup: backupPath,
        target: targetPath,
        reason: chain.reason,
        chain_length: chain.length,
        hmac_mode: chain.hmac_mode,
        head_key_id: chain.head_key_id,
        hint: 'pass allowUnverifiedChain:true to accept an unverifiable chain (recorded in the restored audit log)',
      },
    );
  }

  if (fs.existsSync(targetPath) && options.overwrite !== true) {
    throw new StoreError(STORE_CODES.ERR_BACKUP_TARGET_EXISTS, 'restore target exists; pass overwrite:true to replace it', {
      target: targetPath,
    });
  }

  // 3) 先确认没有存活的写者：绝不能"先动文件再发现锁被占"。
  const lockPath = `${targetPath}.writer-lock`;
  if (fs.existsSync(lockPath)) {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      holder = null;
    }
    if (holder !== null && Number.isInteger(holder.pid) && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new StoreError(STORE_CODES.ERR_STORE_LOCKED, 'refusing to restore over a database held by a live writer', {
        target: targetPath,
        holderPid: holder.pid,
      });
    }
  }

  // 4) 目标库体检：不碰现场字节（副本上做 checkpoint 与计数）。
  const inspected = inspectTarget(targetPath);
  const wal = Object.freeze({
    present: inspected.wal_bytes > 0,
    bytes_before: inspected.wal_bytes,
    // 换入的是备份的**自包含单文件**（备份从不带 sidecar），因此恢复后目标库
    // 没有 WAL；旧库的 WAL 连同旧库一起躺在 previous_copy 里。
    bytes_after: 0,
    mergeable: inspected.mergeable,
    // "discarded" 只表示"这次恢复放弃了目标 WAL 里可能存在的已提交事务"。
    discarded: inspected.wal_bytes > 0 && inspected.mergeable !== true,
    reason: inspected.reason ?? (inspected.wal_bytes > 0 ? 'checkpointable' : 'no_wal'),
  });
  if (wal.discarded && !discardWal) {
    throw new StoreError(
      STORE_CODES.ERR_RESTORE_WAL_UNSAFE,
      'target database has a non-empty WAL that cannot be checkpointed; refusing to restore over unmerged committed transactions',
      {
        target: targetPath,
        wal_bytes: wal.bytes_before,
        wal_reason: wal.reason,
        target_events: inspected.events,
        hint: 'pass discardWal:true to accept the loss (recorded in the restored audit log)',
      },
    );
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const stamp = String(options.now ?? isoNow()).replace(/[:.]/gu, '-');
  const staging = `${targetPath}.restore-${process.pid}.tmp`;
  const previousCopy = `${targetPath}.pre-restore-${stamp}`;
  const hadPrevious = fs.existsSync(targetPath);

  try {
    fs.copyFileSync(backupPath, staging);
  } catch (error) {
    throw mapSqliteError(error, STORE_CODES.ERR_BACKUP_FAILED);
  }

  // 5) 三件套整体搬迁：db / -wal / -shm 必须同进同退，任何一步失败都搬回。
  const moves = [];
  try {
    if (hadPrevious) moveTrio(targetPath, previousCopy, moves);
    fs.renameSync(staging, targetPath);
  } catch (error) {
    const rollback = rollbackSwap(targetPath, moves);
    if (!rollback.ok) {
      throw new StoreError(
        STORE_CODES.ERR_RESTORE_ROLLBACK_FAILED,
        'swap failed and the target could not be restored to its pre-restore state; manual recovery required',
        {
          target: targetPath,
          backup: backupPath,
          previous_copy: hadPrevious ? previousCopy : null,
          events_before: inspected.events,
          backup_events: backupEvents,
          wal,
          cause: error && error.code ? String(error.code) : null,
          rollback_error: rollback.error,
        },
      );
    }
    try {
      fs.unlinkSync(staging);
    } catch {
      // 临时文件残留无害。
    }
    throw error instanceof StoreError ? error : mapSqliteError(error, STORE_CODES.ERR_BACKUP_FAILED);
  }

  // 6) 轮换 epoch。失败则把旧三件套原样换回去——不允许留下
  //    "文件已换、旧 epoch 仍有效"的库，也不允许留下"WAL 被删"的库。
  let store = null;
  try {
    store = openStore({ path: targetPath, clock: options.clock, auditKey: options.auditKey });
    const rotated = rotateEpoch(store, {
      now: options.now,
      epoch: options.epoch,
      actorType: 'system',
      actorId: 'aegis-restore',
    });
    // 做过让步（丢 WAL / 未验证的链）就必须在恢复后的库里留痕；
    // 写不进去会抛，由下面的 catch 整体回滚。
    if (wal.discarded || chain.verified !== true) {
      recordRestoreProvenance(store, {
        now: options.now,
        targetPath,
        backupPath,
        wal,
        chain,
        previousEvents: inspected.events,
        backupEvents,
        previousCopy: hadPrevious ? previousCopy : null,
      });
    }
    return Object.freeze({
      path: targetPath,
      previous_epoch: rotated.previous,
      epoch: rotated.epoch,
      demoted_to_unknown: rotated.demoted_to_unknown,
      verified,
      previous_copy: hadPrevious ? previousCopy : null,
      // 被换下去的那份数据里有多少条事件（已把 WAL 的已提交事务算进去）。
      previous_events: inspected.events,
      // 恢复后应看到的行数（备份快照）。
      restored_events: backupEvents,
      backup_chain: chain,
      wal,
    });
  } catch (error) {
    try {
      if (store !== null) store.close();
    } catch {
      // 关闭失败不影响回滚。
    }
    const eventsAfterFailure = countEventsAt(targetPath);
    const rollback = rollbackSwap(targetPath, moves);
    if (!rollback.ok) {
      throw new StoreError(
        STORE_CODES.ERR_RESTORE_ROLLBACK_FAILED,
        'restore failed AND the target could not be rolled back; the target may be inconsistent — manual recovery required',
        {
          target: targetPath,
          backup: backupPath,
          previous_copy: hadPrevious ? previousCopy : null,
          events_before: inspected.events,
          events_after: eventsAfterFailure,
          backup_events: backupEvents,
          wal,
          cause: error && error.code ? String(error.code) : null,
          rollback_error: rollback.error,
        },
      );
    }
    const eventsAfterRollback = countEventsAt(targetPath);
    const walAfterRollback = sidecarSize(`${targetPath}-wal`);
    throw new StoreError(
      error && error.code ? error.code : STORE_CODES.ERR_BACKUP_FAILED,
      `${error && error.message ? error.message : String(error)}; restore rolled back to the pre-restore state`,
      {
        target: targetPath,
        backup: backupPath,
        previous_copy: hadPrevious ? previousCopy : null,
        rollback: 'ok',
        events_before: inspected.events,
        events_after: eventsAfterRollback,
        events_after_failed_restore: eventsAfterFailure,
        backup_events: backupEvents,
        wal_bytes_before: wal.bytes_before,
        wal_bytes_after: walAfterRollback,
        wal,
        cause: error && error.code ? String(error.code) : null,
      },
    );
  } finally {
    if (store !== null && !store.isClosed()) store.close();
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function isoNow() {
  return new Date().toISOString();
}
