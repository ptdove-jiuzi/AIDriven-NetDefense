/**
 * 打开 / 关闭存储，单写者与事务的强制执行点。
 *
 * 三条硬约束都在这里落地，而不是靠调用方自觉：
 * 1. **单写者**：同一进程同一**规范化路径**只允许一个可写句柄（登记键用 realpath
 *    再统一小写，`Case.db` / `case.db` / `sub/../x.db` 视为同一个文件）；跨进程用
 *    `<db>.writer-lock` 加 pid 存活探测 + 随机 `token` 归属校验。读到存活的 pid
 *    就拒绝，读到死 pid 才允许接管——否则"上一个进程刚崩"与"另一个进程正在写"
 *    无法区分。锁的释放只删 token 匹配的锁，避免"关掉第二个句柄顺手删掉第一个
 *    句柄的锁"。
 * 2. **WAL + 外键 + busy_timeout + synchronous=FULL**：`FULL` 是为了让
 *    "commit 返回" 真的等于 "已落盘"，崩溃点测试才有意义；WAL 下 `NORMAL`
 *    会允许最近若干事务在断电时丢失。
 * 3. **事务不可嵌套**：`BEGIN IMMEDIATE` 已经拿了写锁，嵌套 BEGIN 会静默
 *    变成子事务语义（SQLite 会报错，但错误更难解释），这里直接报 `ERR_TX_NESTED`。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

import { STORE_CODES, StoreError, mapSqliteError } from './errors.js';
import {
  AUDIT_CHAIN_HEAD_SCHEMA_MIGRATION,
  ensureAuditChainHead,
  auditChainHeadTableExists,
  resolveAuditMode,
} from './audit.js';
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  MIN_READABLE_SCHEMA_VERSION,
  schemaChecksum,
} from './schema.js';
import { createClock, fileSizeOrNull, isoFromMs, randomHex, sha256Hex, utcDayOf, uuid } from './util.js';

/** 本进程当前持有的可写句柄：规范化路径键 -> 句柄信息。 */
const WRITER_REGISTRY = new Map();
/** 本进程创建过的锁文件：lockPath -> 锁定令牌，进程退出时兜底清理。 */
const HELD_LOCKS = new Map();

let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [lockPath, token] of HELD_LOCKS) {
      try {
        const holder = readLockHolder(lockPath);
        // 只清自己仍然持有的锁：已被别的进程接管就交给它。
        if (holder !== null && holder.token !== token) continue;
        fs.unlinkSync(lockPath);
      } catch {
        // 退出阶段不抛错：锁文件残留会被下一次打开按"死 pid"接管。
      }
    }
    HELD_LOCKS.clear();
  });
}

/**
 * 存储文件路径的**规范化形态**（保留真实大小写）。
 *
 * 用 `realpath` 而不是字符串比较：`a/../b.db`、符号链接、Windows 的 8.3 短名
 * 都会指向同一个文件，按字符串判等就会让同一个库被两个写句柄同时打开。
 * 文件还不存在（首次创建）时，对父目录取 realpath 再拼文件名。
 */
export function canonicalStorePath(filePath) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/**
 * 句柄登记键：规范化路径再统一小写。
 *
 * Windows 与 macOS 的默认文件系统不区分大小写，`Case.db` 与 `case.db` 是同一个
 * 文件——只按字符串比较就能用别名绕开"同一进程只允许一个写句柄"。
 * 在区分大小写的文件系统上，这会把"仅大小写不同的两个文件"保守地当成同一个
 * 并拒绝第二个句柄：宁可多拒一次，也不能让两条写路径指向同一张表。
 */
export function storeFileKey(filePath) {
  return canonicalStorePath(filePath).toLowerCase();
}

export function writerLockPath(filePath) {
  return `${canonicalStorePath(filePath)}.writer-lock`;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权限发信号，仍然算活着。
    return error && error.code === 'EPERM';
  }
}

function readLockHolder(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function acquireWriterLock(filePath, options) {
  installExitHook();
  const lockPath = writerLockPath(filePath);
  // token 是"这个锁是我这一份句柄拿的"的唯一凭据。只靠 pid 判归属有两个
  // 致命问题：同进程的第二个句柄（别名路径）会被当成残留接管，随后它的
  // close() 会把第一个句柄的锁删掉；pid 复用也会误判。
  const token = randomHex(16);
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    file: filePath,
    started_at: isoFromMs(Date.now()),
    platform: process.platform,
  });
  try {
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    HELD_LOCKS.set(lockPath, token);
    return { lockPath, token, takenOver: false, previousHolder: null };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw new StoreError(STORE_CODES.ERR_STORE_LOCKED, `cannot create writer lock: ${error && error.message}`);
    }
  }

  const holder = readLockHolder(lockPath);
  const holderPid = holder && Number.isInteger(holder.pid) ? holder.pid : null;
  const holderToken = holder && typeof holder.token === 'string' ? holder.token : null;
  // 本进程仍然登记着这个 token = 同一进程里的另一个活句柄正持锁，绝不能接管。
  const heldByThisProcess = holderToken !== null && HELD_LOCKS.get(lockPath) === holderToken;
  const holderAlive = holderPid !== null && holderPid !== process.pid && isPidAlive(holderPid);
  if (holderAlive || heldByThisProcess) {
    throw new StoreError(
      STORE_CODES.ERR_STORE_LOCKED,
      `database is already opened for writing by live pid ${holderPid ?? process.pid}`,
      { lockPath, holderPid },
    );
  }
  if (options.allowStaleLock === false) {
    throw new StoreError(STORE_CODES.ERR_STORE_LOCKED, 'stale writer lock present and takeover is disabled', {
      lockPath,
      holderPid,
    });
  }
  // 用"写临时文件 + rename"减少两个进程同时判定死锁后互相覆盖的窗口；
  // rename 之后回读确认锁是自己的（比对 token，而不是 pid），
  // 输掉竞争的一方直接失败。
  const takeoverPath = `${lockPath}.takeover-${process.pid}-${token}`;
  fs.writeFileSync(takeoverPath, payload);
  fs.renameSync(takeoverPath, lockPath);
  const written = readLockHolder(lockPath);
  if (written === null || written.token !== token) {
    throw new StoreError(STORE_CODES.ERR_STORE_LOCKED, 'lost the race while taking over a stale writer lock', {
      lockPath,
    });
  }
  HELD_LOCKS.set(lockPath, token);
  return { lockPath, token, takenOver: true, previousHolder: holder };
}

function releaseWriterLock(lock) {
  if (lock === null || lock === undefined) return;
  const registered = HELD_LOCKS.get(lock.lockPath);
  // 锁文件已经归另一个句柄所有：连登记都不能动，否则会把对方的锁"托管"过来。
  if (registered !== undefined && registered !== lock.token) return;
  HELD_LOCKS.delete(lock.lockPath);
  const holder = readLockHolder(lock.lockPath);
  // 只删 token 匹配的锁：被别的进程接管后不能替对方解锁；
  // 文件存在但读不出来时同样不删——无法证明那是自己的锁。
  if (holder !== null && holder.token !== lock.token) return;
  if (holder === null && fs.existsSync(lock.lockPath)) return;
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {
    // 已不存在即视为已释放。
  }
}

function assertIntegrity(db, filePath) {
  let result;
  try {
    result = db.prepare('PRAGMA quick_check').get();
  } catch (error) {
    throw mapSqliteError(error, STORE_CODES.ERR_DB_CORRUPT);
  }
  const verdict = result && (result.quick_check ?? result['quick_check']);
  if (typeof verdict !== 'string' || verdict.toLowerCase() !== 'ok') {
    throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, `integrity check failed for ${filePath}: ${String(verdict)}`, {
      verdict: String(verdict),
    });
  }
}

function configureWritable(db, options) {
  const busyTimeoutMs = Number.isInteger(options.busyTimeoutMs) ? options.busyTimeoutMs : 5000;
  // journal_mode 必须写在最前面：后面任何写事务都会固定当前的日志模式。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
}

function configureReadOnly(db, options) {
  const busyTimeoutMs = Number.isInteger(options.busyTimeoutMs) ? options.busyTimeoutMs : 5000;
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  db.exec('PRAGMA foreign_keys = ON');
  // 双保险：即使句柄被误用，SQLite 也会在写入时直接拒绝。
  db.exec('PRAGMA query_only = 1');
}

/** SQLite 里能结束/开启事务的关键字（含 `END`，它是 COMMIT 的同义词）。 */
const TRANSACTION_CONTROL_KEYWORDS = Object.freeze([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'RELEASE',
  'SAVEPOINT',
]);

const WORD_START = /[A-Za-z_]/u;
const WORD_PART = /[A-Za-z0-9_$]/u;

/**
 * 逐条扫描 SQL 的**首个关键字**，返回其中的事务控制语句。
 *
 * 为什么必须自己扫而不是正则：注释（`--`、`/* *\/`）、字符串字面量、带引号的
 * 标识符（`"commit"`、`[commit]`、`` `commit` ``）以及多语句（`;`）都会让
 * `/^\s*(begin|commit)/i` 这类判断失效，而绕过它只需要一句
 * `INSERT INTO meta ...; COMMIT`。
 *
 * 只看"每条语句的第一个词"而不是全文搜索：`INSERT INTO t (begin) VALUES (...)`、
 * `SELECT CASE ... END` 这类正常语句不会被误判。
 *
 * @param {string} sql
 * @returns {string[]} 命中关键字（大写、按出现顺序）。
 */
export function findTransactionControl(sql) {
  const text = String(sql);
  const hits = [];
  let index = 0;
  let atStatementStart = true;
  while (index < text.length) {
    const char = text[index];
    // 行注释
    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index);
      if (end < 0) break;
      index = end + 1;
      continue;
    }
    // 块注释（SQLite 允许不嵌套）
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) break;
      index = end + 2;
      continue;
    }
    // 字符串 / 带引号标识符：内部的双写引号是转义
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < text.length) {
        if (text[index] === char) {
          if (text[index + 1] === char) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      if (atStatementStart) atStatementStart = false;
      continue;
    }
    if (char === '[') {
      const end = text.indexOf(']', index + 1);
      index = end < 0 ? text.length : end + 1;
      if (atStatementStart) atStatementStart = false;
      continue;
    }
    if (char === ';') {
      atStatementStart = true;
      index += 1;
      continue;
    }
    if (WORD_START.test(char)) {
      let end = index;
      while (end < text.length && WORD_PART.test(text[end])) end += 1;
      if (atStatementStart) {
        const word = text.slice(index, end).toUpperCase();
        if (TRANSACTION_CONTROL_KEYWORDS.includes(word)) hits.push(word);
        atStatementStart = false;
      }
      index = end;
      continue;
    }
    if (!/\s/u.test(char)) atStatementStart = false;
    index += 1;
  }
  return hits;
}

/**
 * 断言 SQL 里没有事务控制语句。
 *
 * `store.exec()` 在 `tx()` 内部制造隐式提交，等于把"要么全成要么全不成"的
 * 原子性交给调用方自觉——这正是审计与状态机最不能接受的那种"看起来回滚了"。
 *
 * @param {string} sql
 * @param {string} [context] 报错时的上下文（通常是调用方名字）。
 */
export function assertNoTransactionControl(sql, context = 'exec') {
  const hits = findTransactionControl(sql);
  if (hits.length > 0) {
    throw new StoreError(
      STORE_CODES.ERR_TX_CONTROL,
      `${context} refuses transaction control statements (${hits.join(', ')}); use store.tx() instead`,
      { statements: hits },
    );
  }
}

function tableExists(store, name) {
  return store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) !== null;
}

function readAppliedMigrations(store) {
  const applied = new Map();
  if (!tableExists(store, 'schema_migration')) return applied;
  for (const row of store.all('SELECT version, name, checksum FROM schema_migration ORDER BY version')) {
    applied.set(Number(row.version), { name: String(row.name), checksum: String(row.checksum) });
  }
  return applied;
}

/**
 * 执行迁移。
 *
 * 每个版本一个事务：任何一条语句失败 → 该版本整体回滚，`schema_version`
 * 保持不变。这样"迁移失败"留下的是**可读的旧库**，不是半成品 schema。
 *
 * 迁移结束时还会确保**审计链头记录**存在：旧库（schema < 4）没有这条记录，
 * 必须在这里按 `repairAuditMode` 的语义重建（并写一条 `audit.chain_head_rebuild`
 * 审计行），否则所有写事务都会因为"链头缺失"而失败关闭。
 *
 * @param {object} store openStore 返回的句柄。
 * @param {{ migrations?: readonly object[], upTo?: number }} [options]
 * @returns {{ applied: number[], current: number, target: number, chainHeadIntroduced: boolean }}
 */
export function migrate(store, options = {}) {
  store.assertWritable('migrate');
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((left, right) => left.version - right.version);
  if (migrations.length === 0) return { applied: [], current: 0, target: 0, chainHeadIntroduced: false };
  const target = Number.isInteger(options.upTo) ? options.upTo : migrations[migrations.length - 1].version;

  const applied = readAppliedMigrations(store);
  for (const [version, row] of applied) {
    const definition = migrations.find((entry) => entry.version === version);
    if (definition === undefined) continue;
    const expected = schemaChecksum(definition);
    if (row.checksum !== expected) {
      throw new StoreError(
        STORE_CODES.ERR_MIGRATION_CHECKSUM_MISMATCH,
        `migration ${version} was modified after being applied`,
        { version, expected, actual: row.checksum },
      );
    }
  }

  const current = applied.size === 0 ? 0 : Math.max(...applied.keys());
  if (current > target) {
    // 已经是最新 schema：链头表已经存在，这里只做模式对齐（不会重建锚点）。
    ensureAuditChainHead(store, { chainHeadIntroduced: false });
    return { applied: [], current, target, chainHeadIntroduced: false };
  }

  const pending = migrations.filter((entry) => entry.version > current && entry.version <= target);
  // 设计 §7.2：迁移前备份。迁移不可逆（没有 down 路径），所以升级前必须留下
  // 一份一致快照。`VACUUM INTO` 是同步的、事务外的，正好适合在 BEGIN 之前跑。
  if (pending.length > 0 && current > 0 && options.preMigrationBackup !== false) {
    const backupDirectory = options.preMigrationBackupDirectory
      ?? path.join(path.dirname(store.path), 'backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = store.clock.nowIso().replace(/[:.]/gu, '-');
    const target = path.join(backupDirectory, `pre-migration-v${pending[0].version}-${stamp}.db`);
    try {
      // 路径里的单引号在 SQL 字面量里必须双写；反斜杠在 SQLite 字符串中不转义。
      store.db.exec(`VACUUM INTO '${target.replace(/'/gu, "''")}'`);
    } catch (error) {
      throw new StoreError(
        STORE_CODES.ERR_BACKUP_FAILED,
        `pre-migration backup failed; refusing to migrate: ${error && error.message}`,
        { target },
      );
    }
    store.setMeta('last_pre_migration_backup', target);
  }

  const appliedNow = [];
  for (const definition of pending) {
    try {
      store.tx(`migration:${definition.version}`, () => {
        for (const statement of definition.statements) store.exec(statement);
        store.run(
          'INSERT INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          [definition.version, definition.name, schemaChecksum(definition), store.clock.nowIso()],
        );
        store.setMeta('schema_version', String(definition.version));
        store.setMeta('reader_version_min', String(MIN_READABLE_SCHEMA_VERSION));
      });
    } catch (error) {
      throw new StoreError(
        STORE_CODES.ERR_MIGRATION_FAILED,
        `migration ${definition.version} (${definition.name}) failed and was rolled back: ${error && error.message}`,
        { version: definition.version, name: definition.name, cause: error && error.code ? error.code : null },
      );
    }
    appliedNow.push(definition.version);
  }

  const finalVersion = appliedNow.length > 0 ? appliedNow[appliedNow.length - 1] : current;
  const chainHeadIntroduced = pending.some((entry) => entry.version >= AUDIT_CHAIN_HEAD_SCHEMA_MIGRATION);
  // 刚引入链头表 → 缺链头是合法的（旧库升级）；之后缺链头就是抹除证据。
  ensureAuditChainHead(store, { chainHeadIntroduced });
  return { applied: appliedNow, current: finalVersion, target, chainHeadIntroduced };
}

/** 旧二进制拒绝新 schema：版本高于本二进制即失败关闭，不做"尽力读"。 */
export function assertSchemaReadable(store) {
  const raw = store.getMeta('schema_version');
  const version = raw === null ? 0 : Number(raw);
  if (!Number.isInteger(version)) {
    throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, 'meta.schema_version is not an integer', { raw });
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new StoreError(
      STORE_CODES.ERR_SCHEMA_TOO_NEW,
      `database schema ${version} is newer than this binary (${CURRENT_SCHEMA_VERSION})`,
      { database: version, binary: CURRENT_SCHEMA_VERSION },
    );
  }
  return version;
}

function bootstrapMeta(store, options) {
  const now = store.clock.nowIso();
  // 审计的模式 / 密钥指纹 / 验签起点现在只有一处权威：被签名的链头记录。
  // 这里先把它对齐（旧库升级时重建、占位→真实密钥时重封），再写 meta 镜像。
  const chainHead = ensureAuditChainHead(store, {
    now,
    chainHeadIntroduced: options.chainHeadIntroduced === true,
  });
  // 链头表在、记录不在 = 锚点被抹除；库若已初始化过，就把它标成 mixed（不能继续写）。
  const headErased = chainHead === null && auditChainHeadTableExists(store);
  const auditMode = headErased ? 'mixed' : resolveAuditMode(store, chainHead);
  const auditKeyId = chainHead === null
    ? (store.auditKey === null ? 'none' : sha256Hex(`aegis-audit-key:${store.auditKey}`).slice(0, 32))
    : chainHead.key_id;
  const auditFromSequence = chainHead === null
    ? Number(store.getMeta('audit_hmac_from_sequence') ?? '1')
    : chainHead.hmac_from_sequence;

  const defaults = {
    created_at: now,
    epoch: uuid(),
    reader_version_min: String(MIN_READABLE_SCHEMA_VERSION),
    policy_version: typeof options.policyVersion === 'string' ? options.policyVersion : '1.0',
    audit_hmac_mode: auditMode,
    audit_key_id: auditKeyId,
    boot_id: randomHex(16),
    writer_pid: String(process.pid),
    storage_version: '1',
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (store.getMeta(key) === null) store.setMeta(key, value);
  }
  // 每次打开都把镜像对齐到链头（含 mixed）：meta 说一套、链头说另一套，
  // 比镜像缺失更难查。
  store.setMeta('audit_hmac_mode', auditMode);
  store.setMeta('audit_key_id', auditKeyId);
  store.setMeta('audit_hmac_from_sequence', String(auditFromSequence));
  if (store.getMeta('time_uncertain') === null) store.setMeta('time_uncertain', '0');
  // 每次（可写）打开都刷新 wall/mono 基线：重启后旧的单调基线不再可比。
  if (store.monoMs !== null) {
    store.setMeta('open_wall_ms', String(store.clock.nowMs()));
    store.setMeta('open_mono_ms', String(store.monoMs()));
  } else {
    store.run('DELETE FROM meta WHERE key IN (?, ?)', ['open_wall_ms', 'open_mono_ms']);
  }
  if (store.getMeta('last_utc_day') === null) store.setMeta('last_utc_day', utcDayOf(now));
  if (store.getMeta('last_trusted_utc') === null) store.setMeta('last_trusted_utc', now);
}

function createStoreHandle(context) {
  const { filePath, fileKey, db, readOnly, clock, options, lock } = context;
  const state = { inTx: false, closed: false, txDepth: 0 };
  let statementCache = new Map();

  /**
   * 绕过事务控制扫描的原始 exec。
   *
   * 只有 `tx()` 自己可以用它——其它任何地方用都等于把内建的事务边界重新打开。
   */
  function execRaw(sql) {
    try {
      db.exec(sql);
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  const store = {
    path: filePath,
    readOnly,
    clock,
    auditKey: typeof options.auditKey === 'string' && options.auditKey.length > 0 ? options.auditKey : null,
    /** 单调时钟读数；注入时钟未提供时为 `null`（表示"无法判断单调性"）。 */
    monoMs: typeof clock.monoMs === 'function' ? () => clock.monoMs() : null,
    db,

    /** 供上层判断是否需要"在事务里调用"的断言使用。 */
    isInTx() {
      return state.inTx;
    },

    isClosed() {
      return state.closed;
    },

    assertOpen(what = 'operation') {
      if (state.closed) throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `store is closed (${what})`);
    },

    assertWritable(what = 'operation') {
      if (state.closed) throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `store is closed (${what})`);
      if (readOnly) throw new StoreError(STORE_CODES.ERR_STORE_READ_ONLY, `${what} requires a writable store`);
    },

    requireTx(what = 'operation') {
      if (!state.inTx) {
        throw new StoreError(STORE_CODES.ERR_NOT_SUPPORTED, `${what} must run inside a transaction`);
      }
    },

    prepare(sql) {
      store.assertOpen();
      const cached = statementCache.get(sql);
      if (cached !== undefined) return cached;
      let statement;
      try {
        statement = db.prepare(sql);
      } catch (error) {
        throw mapSqliteError(error);
      }
      statementCache.set(sql, statement);
      return statement;
    },

    run(sql, params = []) {
      // 只读句柄上直接拒绝：不要等 SQLite 抛 "attempt to write a readonly database"，
      // 那个错误在包装后与"库被外部设成只读"无法区分。
      if (readOnly) {
        throw new StoreError(STORE_CODES.ERR_STORE_READ_ONLY, 'write attempted on a read-only store');
      }
      try {
        return store.prepare(sql).run(...params);
      } catch (error) {
        throw mapSqliteError(error);
      }
    },

    get(sql, params = []) {
      try {
        // node:sqlite 在无结果行时返回 `undefined`，这里统一成 `null`：
        // 调用方用 `=== null` 判断"没有"，两套空值语义混用迟早漏判。
        const row = store.prepare(sql).get(...params);
        return row === undefined ? null : row;
      } catch (error) {
        throw mapSqliteError(error);
      }
    },

    all(sql, params = []) {
      try {
        return store.prepare(sql).all(...params);
      } catch (error) {
        throw mapSqliteError(error);
      }
    },

    /**
     * 执行多语句 SQL（DDL、PRAGMA 等）。
     *
     * **拒绝事务控制语句**（BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/END）：
     * 一次 `exec('COMMIT')` 就能在 `tx()` 内部制造隐式提交，让"业务已回滚"
     * 与"数据其实留下来了"同时成立。事务边界只能由 `tx()` 自己掌握。
     *
     * 迁移用的 DDL 不受影响（它们不是事务控制语句）。
     */
    exec(sql) {
      if (readOnly) {
        throw new StoreError(STORE_CODES.ERR_STORE_READ_ONLY, 'write attempted on a read-only store');
      }
      assertNoTransactionControl(sql, 'store.exec');
      execRaw(sql);
    },

    /**
     * 单事务执行。
     *
     * 用 `BEGIN IMMEDIATE` 而不是 `BEGIN`：`BEGIN` 直到第一次写才升级锁，
     * 两个连接可能都先读到旧值再一起写，正是"双消费 / 双预留"的经典窗口。
     *
     * 事务边界只能由这里掌握：`store.exec()` 已经拒绝事务控制语句，这里再
     * 用一对 savepoint 做**事后断言**——提交前 `RELEASE` 必须成功，否则说明
     * 事务在 `fn` 内部被别的途径（`store.db.exec`、原生句柄）提交或回滚过，
     * 此时绝不能再去 COMMIT 一次，直接报 `ERR_TX_ESCAPED`。
     */
    tx(label, fn) {
      store.assertWritable(label);
      if (state.inTx) {
        throw new StoreError(STORE_CODES.ERR_TX_NESTED, `nested transaction is not allowed (${label})`);
      }
      const beginAt = clock.nowMs();
      const depth = state.txDepth + 1;
      const guardName = `aegis_tx_guard_${process.pid}_${depth}_${randomHex(4)}`;
      execRaw('BEGIN IMMEDIATE');
      state.inTx = true;
      state.txDepth = depth;
      try {
        execRaw(`SAVEPOINT "${guardName}"`);
        const result = fn(store);
        try {
          execRaw(`RELEASE "${guardName}"`);
        } catch (error) {
          throw new StoreError(
            STORE_CODES.ERR_TX_ESCAPED,
            `transaction ${label} was committed or rolled back outside tx(); refusing to commit a partial unit of work`,
            { label, cause: error && error.code ? error.code : null },
          );
        }
        execRaw('COMMIT');
        return result;
      } catch (error) {
        try {
          execRaw('ROLLBACK');
        } catch {
          // ROLLBACK 失败说明连接已经不可用（或事务已被外部提交），
          // 原始错误才是要向上报的那个。
        }
        throw error;
      } finally {
        state.inTx = false;
        state.txDepth -= 1;
        // 只用于观测：不做任何基于耗时的行为决策。
        void beginAt;
      }
    },

    getMeta(key) {
      const row = store.get('SELECT value FROM meta WHERE key = ?', [key]);
      return row === null ? null : String(row.value);
    },

    setMeta(key, value) {
      store.run(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, String(value), clock.nowIso()],
      );
    },

    epoch() {
      const value = store.getMeta('epoch');
      if (value === null) {
        throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, 'meta.epoch is missing');
      }
      return value;
    },

    policyVersion() {
      return store.getMeta('policy_version') ?? '1.0';
    },

    /** 单调序列，供"来源接收序列"使用；必须在事务内调用，否则并发下会重复。 */
    nextSequence(name) {
      store.requireTx(`nextSequence(${name})`);
      const row = store.get('SELECT value FROM sequence_counter WHERE name = ?', [name]);
      const next = (row === null ? 0 : Number(row.value)) + 1;
      store.run(
        `INSERT INTO sequence_counter (name, value) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
        [name, next],
      );
      return next;
    },

    currentSequence(name) {
      const row = store.get('SELECT value FROM sequence_counter WHERE name = ?', [name]);
      return row === null ? 0 : Number(row.value);
    },

    stats() {
      const pageCount = Number(store.get('PRAGMA page_count').page_count);
      const pageSize = Number(store.get('PRAGMA page_size').page_size);
      const freePages = Number(store.get('PRAGMA freelist_count').freelist_count);
      const journalMode = String(store.get('PRAGMA journal_mode').journal_mode);
      return Object.freeze({
        path: filePath,
        journalMode,
        pageSize,
        pageCount,
        freePages,
        databaseBytes: pageCount * pageSize,
        freeBytes: freePages * pageSize,
        walBytes: fileSizeOrNull(`${filePath}-wal`) ?? 0,
        shmBytes: fileSizeOrNull(`${filePath}-shm`) ?? 0,
      });
    },

    checkpoint(mode = 'TRUNCATE') {
      store.assertWritable('checkpoint');
      if (state.inTx) {
        throw new StoreError(STORE_CODES.ERR_NOT_SUPPORTED, 'checkpoint cannot run inside a transaction');
      }
      return store.get(`PRAGMA wal_checkpoint(${mode})`);
    },

    /** `full: false` 走 quick_check（快），`true` 走 integrity_check（完整）。 */
    integrityCheck({ full = false } = {}) {
      const row = store.get(full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check');
      const verdict = row === null ? null : String(row[full ? 'integrity_check' : 'quick_check']);
      return Object.freeze({ ok: verdict === 'ok', verdict });
    },

    close() {
      if (state.closed) return;
      state.closed = true;
      if (!readOnly) {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          // 关库清理失败不影响数据；下次打开时 SQLite 会自行重放 WAL。
        }
      }
      statementCache = new Map();
      try {
        db.close();
      } catch {
        // 已经关闭或连接损坏：无需二次抛错。
      }
      if (!readOnly) {
        // 用规范化键注销：大小写/别名路径必须命中同一条登记。
        WRITER_REGISTRY.delete(fileKey);
        releaseWriterLock(lock);
      }
    },
  };

  return store;
}

/**
 * 打开存储。
 *
 * @param {object} options
 * @param {string} options.path 数据库文件路径（不允许空串或 `:memory:` 之外的临时名）。
 * @param {boolean} [options.readOnly]
 * @param {object} [options.clock] 注入时钟 `{ nowIso, nowMs }`。
 * @param {string} [options.auditKey] 审计 HMAC 密钥；缺省时审计链只做结构校验。
 * @param {string} [options.policyVersion]
 * @param {number} [options.busyTimeoutMs]
 * @param {boolean} [options.allowStaleLock] 是否允许接管死进程留下的写锁，默认允许。
 * @param {boolean} [options.migrate] 写连接是否自动迁移，默认 true。
 * @param {readonly object[]} [options.migrations] 仅供迁移失败注入测试使用。
 * @param {number} [options.upTo] 仅迁移到指定版本（测试/回滚演练）。
 * @returns {object} store 句柄。
 */
export function openStore(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'openStore requires an options object');
  }
  if (typeof options.path !== 'string' || options.path.length === 0) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'openStore requires a non-empty path');
  }
  const filePath = path.resolve(options.path);
  // 登记与锁一律用规范化后的键：`Case.db` / `case.db` / `sub/../x.db` 指向同一个
  // 文件时，按原始字符串比较会让同一进程开出两个写句柄。
  const fileKey = storeFileKey(filePath);
  const readOnly = options.readOnly === true;
  const clock = createClock(options.clock);

  // 只读句柄不受写锁约束：console/核对进程必须能在 daemon 运行时读库。
  if (!readOnly && WRITER_REGISTRY.has(fileKey)) {
    throw new StoreError(
      STORE_CODES.ERR_STORE_ALREADY_OPEN,
      `a writable store is already open in this process for ${canonicalStorePath(filePath)}`,
      { path: canonicalStorePath(filePath) },
    );
  }

  if (readOnly) {
    if (!fs.existsSync(filePath)) {
      throw new StoreError(STORE_CODES.ERR_STORE_NOT_INITIALIZED, `database file does not exist: ${filePath}`);
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  let lock = null;
  if (!readOnly) {
    lock = acquireWriterLock(filePath, {
      allowStaleLock: options.allowStaleLock !== false,
    });
  }

  let db;
  try {
    db = new DatabaseSync(filePath, {
      readOnly,
      enableForeignKeyConstraints: true,
      timeout: Number.isInteger(options.busyTimeoutMs) ? options.busyTimeoutMs : 5000,
    });
  } catch (error) {
    releaseWriterLock(lock);
    throw mapSqliteError(error, STORE_CODES.ERR_DB_CORRUPT);
  }

  try {
    assertIntegrity(db, filePath);
    if (readOnly) configureReadOnly(db, options);
    else configureWritable(db, options);
  } catch (error) {
    try {
      db.close();
    } catch {
      // 打不开的连接不再需要关闭语义。
    }
    releaseWriterLock(lock);
    throw error;
  }

  const store = createStoreHandle({ filePath, fileKey, db, readOnly, clock, options, lock });

  try {
    if (readOnly) {
      if (!tableExists(store, 'meta')) {
        throw new StoreError(STORE_CODES.ERR_STORE_NOT_INITIALIZED, `database is not initialized: ${filePath}`);
      }
      const version = assertSchemaReadable(store);
      if (version < CURRENT_SCHEMA_VERSION) {
        throw new StoreError(
          STORE_CODES.ERR_STORE_NOT_INITIALIZED,
          `database schema ${version} is older than ${CURRENT_SCHEMA_VERSION}; a writable migration run is required`,
          { database: version, binary: CURRENT_SCHEMA_VERSION },
        );
      }
    } else {
      let chainHeadIntroduced = false;
      if (options.migrate !== false) {
        const result = migrate(store, { migrations: options.migrations, upTo: options.upTo });
        chainHeadIntroduced = result.chainHeadIntroduced === true;
      }
      assertSchemaReadable(store);
      bootstrapMeta(store, { ...options, chainHeadIntroduced });
    }
  } catch (error) {
    store.close();
    throw error instanceof StoreError ? error : mapSqliteError(error);
  }

  if (!readOnly) {
    WRITER_REGISTRY.set(fileKey, { openedAt: clock.nowIso(), pid: process.pid, path: canonicalStorePath(filePath) });
  }
  return store;
}

/**
 * 损坏库隔离：把损坏文件改名留证，绝不删除、绝不自动重建。
 *
 * 这是**显式调用**的运维动作，`openStore` 不会自己改名——自动搬走用户数据
 * 会让"我的库去哪了"变成无法回答的问题。
 *
 * @param {string} filePath 损坏的库文件。
 * @param {{ now?: string }} [options]
 * @returns {{ quarantined: string, moved: string[] }}
 */
export function quarantineCorruptDatabase(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `nothing to quarantine: ${resolved}`);
  }
  const stamp = (options.now ?? isoFromMs(Date.now())).replace(/[:.]/gu, '-');
  const target = `${resolved}.corrupt-${stamp}`;
  fs.renameSync(resolved, target);
  const moved = [target];
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${resolved}${suffix}`;
    if (fs.existsSync(sidecar)) {
      const sideTarget = `${target}${suffix}`;
      fs.renameSync(sidecar, sideTarget);
      moved.push(sideTarget);
    }
  }
  fs.chmodSync(target, 0o444);
  return { quarantined: target, moved };
}
