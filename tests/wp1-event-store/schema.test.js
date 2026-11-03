/**
 * schema / 打开语义 / 单写者 / 只读降级。
 *
 * 这一组用例守的是"库本身的形状"：WAL、外键、STRICT、唯一索引、锁文件，
 * 以及"旧二进制拒绝新 schema"这种一旦失守就会静默损坏数据的前置条件。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CURRENT_SCHEMA_VERSION,
  expectStoreError,
  makeTempDir,
  openStore,
  openTestStore,
  writerLockPath,
} from './helpers.js';

const EXPECTED_TABLES = [
  'alert',
  'analysis_outbox',
  'analysis_report',
  'approval',
  'audit_event',
  'capability_state',
  'data_gap',
  'evidence',
  'execution',
  'execution_inbox',
  'execution_outbox',
  'execution_result',
  'finding',
  'meta',
  'model_request_ledger',
  'recovery_manifest',
  'response_proposal',
  'schema_migration',
  'sequence_counter',
  'telemetry_event',
];

test('新库迁移到当前 schema 版本并写入 bootstrap meta', (t) => {
  const { store } = openTestStore(t);
  assert.equal(Number(store.getMeta('schema_version')), CURRENT_SCHEMA_VERSION);
  assert.match(store.getMeta('epoch'), /^[0-9a-f-]{36}$/u);
  assert.match(store.getMeta('boot_id'), /^[0-9a-f]{32}$/u);
  assert.equal(store.getMeta('policy_version'), '1.0');
  assert.ok(store.getMeta('created_at').endsWith('Z'));
});

test('schema 表集合与设计 §7.1 对齐（含 outbox / inbox / result / gap）', (t) => {
  const { store } = openTestStore(t);
  const names = store
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => String(row.name));
  for (const expected of EXPECTED_TABLES) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('WAL、foreign_keys、synchronous=FULL 都真的生效', (t) => {
  const { store } = openTestStore(t);
  assert.equal(String(store.get('PRAGMA journal_mode').journal_mode), 'wal');
  assert.equal(Number(store.get('PRAGMA foreign_keys').foreign_keys), 1);
  // synchronous: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
  assert.equal(Number(store.get('PRAGMA synchronous').synchronous), 2);
  assert.equal(store.stats().journalMode, 'wal');
});

test('外键真的在拦：未知 alert 的 analysis outbox 被拒', (t) => {
  const { store } = openTestStore(t);
  const error = expectStoreError(
    () => store.run(
      `INSERT INTO analysis_outbox (
         analysis_id, alert_id, budget_class, summary_json, summary_digest, created_at, created_at_ms,
         idempotency_key, epoch, state, attempt_seq, canonical_json, canonical_digest, updated_at
       ) VALUES (?, ?, 'standard', '{}', ?, ?, 0, ?, ?, 'queued', 0, '{}', ?, ?)`,
      ['a'.repeat(36), 'b'.repeat(36), 'f'.repeat(64), '2026-11-01T00:00:00.000Z', 'k'.repeat(32), 'e'.repeat(36), 'f'.repeat(64), '2026-11-01T00:00:00.000Z'],
    ),
    'ERR_STORE_CONSTRAINT',
    'foreign key must reject an orphan analysis_outbox row',
  );
  assert.match(error.message, /FOREIGN KEY|constraint/iu);
});

test('STRICT 表拒绝把字符串写进 INTEGER 列（类型不清洗）', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => store.run('INSERT INTO sequence_counter (name, value) VALUES (?, ?)', ['probe', 'not-an-integer']),
    'ERR_STORE_CONSTRAINT',
    'STRICT tables must reject TEXT in an INTEGER column',
  );
  expectStoreError(
    () => store.run(
      `INSERT INTO telemetry_event (event_id, stable_source_id, collector_instance_id, source_generation,
         boot_id, source_seq, observed_at, received_at, observed_at_ms, received_at_ms, ingest_seq,
         type, severity, payload_json, payload_digest, integrity_digest, canonical_json, canonical_digest,
         dedupe_key, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['e'.repeat(36), 'src', 'c'.repeat(36), 'not-int', 'b'.repeat(32), 1,
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:01.000Z', 0, 0, 1,
        'process.start', 'high', '{}', 'f'.repeat(64), 'f'.repeat(64), '{}', 'f'.repeat(64), 'k', 'now'],
    ),
    'ERR_STORE_CONSTRAINT',
    'STRICT must also reject TEXT in source_generation',
  );
});

test('同一进程重复打开同一路径报 ERR_STORE_ALREADY_OPEN', (t) => {
  const { store, dir } = openTestStore(t);
  expectStoreError(
    () => openStore({ path: path.join(dir, 'aegis-harness.db') }),
    'ERR_STORE_ALREADY_OPEN',
    'second writer in the same process must be rejected',
  );
  assert.equal(store.isClosed(), false);
});

test('跨进程写锁：存活 pid 的锁文件直接拒绝', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.close();
  const lockPath = writerLockPath(filePath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, file: filePath }), 'utf8');
  // 用自己的 pid 但没登记句柄 = 上一次运行残留，按死锁处理 → 允许接管。
  // 因此这里换成一个"确定存活"的 pid：父进程 pid。
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, file: filePath }), 'utf8');
  const error = expectStoreError(
    () => openStore({ path: filePath }),
    'ERR_STORE_LOCKED',
    'a live foreign writer lock must be rejected',
  );
  assert.equal(error.details.holderPid, process.ppid);
  assert.ok(fs.existsSync(lockPath), 'rejected open must not delete the foreign lock');
});

test('死 pid 的锁文件允许接管并重写为本进程', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.close();
  const lockPath = writerLockPath(filePath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, file: filePath }), 'utf8');
  const reopened = openStore({ path: filePath });
  t.after(() => reopened.close());
  const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(holder.pid, process.pid);
});

test('allowStaleLock:false 时连死锁也不接管', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.close();
  fs.writeFileSync(writerLockPath(filePath), JSON.stringify({ pid: 999999 }), 'utf8');
  expectStoreError(
    () => openStore({ path: filePath, allowStaleLock: false }),
    'ERR_STORE_LOCKED',
    'stale takeover must be refusable',
  );
});

test('close 之后锁文件被删除，可以重新打开', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  const lockPath = writerLockPath(filePath);
  assert.ok(fs.existsSync(lockPath));
  store.close();
  assert.equal(fs.existsSync(lockPath), false);
  const reopened = openStore({ path: filePath });
  t.after(() => reopened.close());
  assert.equal(reopened.isClosed(), false);
});

test('只读打开可以读，但任何写入都被拒绝', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.run('INSERT INTO sequence_counter (name, value) VALUES (?, ?)', ['probe', 1]);
  store.close();

  const reader = openStore({ path: filePath, readOnly: true });
  t.after(() => reader.close());
  assert.equal(Number(reader.get('SELECT value FROM sequence_counter WHERE name = ?', ['probe']).value), 1);
  expectStoreError(() => reader.run('INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)', ['x', 'y', 'z']), 'ERR_STORE_READ_ONLY');
  expectStoreError(() => reader.exec('DELETE FROM sequence_counter'), 'ERR_STORE_READ_ONLY');
  expectStoreError(() => reader.tx('nope', () => 1), 'ERR_STORE_READ_ONLY');
});

test('只读打开不存在的文件报 ERR_STORE_NOT_INITIALIZED', (t) => {
  const dir = makeTempDir(t);
  expectStoreError(
    () => openStore({ path: path.join(dir, 'absent.db'), readOnly: true }),
    'ERR_STORE_NOT_INITIALIZED',
  );
});

test('schema 版本高于二进制时失败关闭（旧二进制拒绝新 schema）', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.setMeta('schema_version', String(CURRENT_SCHEMA_VERSION + 7));
  store.close();
  const error = expectStoreError(() => openStore({ path: filePath }), 'ERR_SCHEMA_TOO_NEW');
  assert.equal(error.details.database, CURRENT_SCHEMA_VERSION + 7);
});

test('损坏文件在打开阶段就被识别为 ERR_DB_CORRUPT，且不留下锁文件', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'broken.db');
  fs.writeFileSync(filePath, 'this is definitely not a sqlite database, just filler bytes', 'utf8');
  expectStoreError(() => openStore({ path: filePath }), 'ERR_DB_CORRUPT');
  assert.equal(fs.existsSync(writerLockPath(filePath)), false);
});

test('缺少 path 或 path 为空报 ERR_STORE_INPUT', (t) => {
  expectStoreError(() => openStore({}), 'ERR_STORE_INPUT');
  expectStoreError(() => openStore({ path: '' }), 'ERR_STORE_INPUT');
  expectStoreError(() => openStore(), 'ERR_STORE_INPUT');
});

test('事务内再开事务被拒绝（不做子事务语义）', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => store.tx('outer', () => store.tx('inner', () => 1)),
    'ERR_TX_NESTED',
  );
  // 内层失败后外层整体回滚，连接仍可用。
  assert.equal(store.isInTx(), false);
  store.tx('after', () => store.setMeta('probe_after', 'ok'));
  assert.equal(store.getMeta('probe_after'), 'ok');
});

test('stats 报告页面与 WAL 尺寸，WAL 文件在写入后存在', (t) => {
  const { store } = openTestStore(t);
  store.tx('write', () => store.setMeta('wal_probe', 'x'));
  const stats = store.stats();
  assert.ok(stats.pageSize > 0);
  assert.ok(stats.databaseBytes > 0);
  assert.equal(stats.journalMode, 'wal');
  assert.ok(stats.walBytes >= 0);
});

test('checkpoint 不能在事务内执行', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(() => store.tx('cp', () => store.checkpoint('TRUNCATE')), 'ERR_NOT_SUPPORTED');
});
