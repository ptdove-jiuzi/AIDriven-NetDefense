/**
 * P0 回归：恢复备份不得丢掉目标库里"已提交但还在 WAL"的事务。
 *
 * 复核者给出的两个可复现现场：
 * 1. SIGKILL 后 `-wal` 非空（含 1 条已提交的 T1），restore 成功，但换出来的
 *    旧库里事件数为 0——已提交事务静默消失；
 * 2. restore 因为缺 `auditKey` 失败，回滚后主库 `telemetry_event` = 0、
 *    `-wal` 被清空，全程无报错。
 *
 * 修法（策略写在 `src/backup.js` 的头注释里）：**三件套整体搬迁**
 * （`db`/`-wal`/`-shm` 同进同退，旧库整套挪到 `<name>.pre-restore-<stamp>`），
 * 加上"搬迁前在副本上判定 WAL 能否合并"的前置闸，以及"失败必须响"的
 * 错误码 + 恢复前后计数。
 *
 * 用例刻意全部用**真实 SIGKILL 子进程**造现场（复用 `fixtures/crash-writer.mjs`），
 * 不用手工拼 SQL 假装崩溃——WAL 里到底有什么，只有真杀进程才算数。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  GRANT_MAX_TTL_MS,
  MIGRATIONS,
  countEvents,
  createBackup,
  getExecution,
  ingestTelemetry,
  openStore,
  prepareDispatch,
  redeliverExecution,
  restoreBackup,
  verifyAuditChainInStore,
  verifyBackupAuditChain,
} from '../../packages/event-store/src/index.js';

import {
  BASE_ISO,
  CURRENT_SCHEMA_VERSION,
  buildApprovedExecution,
  createTestClock,
  expectStoreError,
  makeEvent,
  makeTempDir,
} from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'crash-writer.mjs');
const AUDIT_KEY = 'test-audit-key-0123456789abcdef';
const NOW = '2026-11-01T00:00:02.000Z';

/* ------------------------------------------------------------------ */
/* 现场构造                                                            */
/* ------------------------------------------------------------------ */

function runCrash(args) {
  return spawnSync(process.execPath, [FIXTURE, ...args], { encoding: 'utf8' });
}

/**
 * 用 SIGKILL 造一个"崩在 T1 提交之后"的库：主库 + 非空 WAL。
 *
 * @returns {{ filePath: string, walBytes: number, nativeRecordId: string }}
 */
function makeCrashedStore(t, dir) {
  const filePath = path.join(dir, 'aegis-harness.db');
  const seed = openStore({ path: filePath, auditKey: AUDIT_KEY, clock: createTestClock() });
  seed.close();

  const nativeRecordId = 'crashed-committed-1';
  const result = runCrash([
    '--store', filePath,
    '--phase', 'postcommit-t1',
    '--event', JSON.stringify(makeEvent({ native_record_id: nativeRecordId })),
    '--key', AUDIT_KEY,
    '--now', BASE_ISO,
  ]);
  assert.equal(result.stderr, '', `crash writer failed: ${result.stderr}`);
  assert.match(result.stdout, /postcommit-t1/u);
  assert.notEqual(result.status, 0, '子进程必须是被强杀的');

  const walPath = `${filePath}-wal`;
  assert.ok(fs.existsSync(walPath), '崩溃后必须留下非空 WAL');
  const walBytes = fs.statSync(walPath).size;
  assert.ok(walBytes > 0, `WAL 必须非空，实际 ${walBytes}`);
  // 崩溃态库本身是能被重放的：直接打开就能看到那条已提交事务。
  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY, clock: createTestClock() });
  assert.equal(countEvents(reopened), 1, '前提：WAL 里确实有一条已提交事务');
  reopened.close();
  // 重开一次让 WAL 重新变成"非空"（上面那次干净关闭会 checkpoint 掉）。
  const again = runCrash([
    '--store', filePath,
    '--phase', 'postcommit-t1',
    '--event', JSON.stringify(makeEvent({ native_record_id: `${nativeRecordId}-b` })),
    '--key', AUDIT_KEY,
    '--now', BASE_ISO,
  ]);
  assert.notEqual(again.status, 0);
  const finalWalBytes = fs.statSync(walPath).size;
  assert.ok(finalWalBytes > 0, `WAL 必须非空，实际 ${finalWalBytes}`);
  return { filePath, walBytes: finalWalBytes, nativeRecordId: `${nativeRecordId}-b`, committed: 2 };
}

/** 在独立目录里造一份"内容不同"的备份（事件数可控）。 */
async function makeBackup(t, events) {
  const dir = makeTempDir(t, 'wp1-restore-backup');
  const store = openStore({ path: path.join(dir, 'src.db'), auditKey: AUDIT_KEY, clock: createTestClock() });
  for (let index = 0; index < events; index += 1) {
    ingestTelemetry(store, { event: makeEvent({ native_record_id: `backup-${index}` }), now: NOW });
  }
  const backup = await createBackup(store, { directory: path.join(dir, 'backups'), now: NOW });
  store.close();
  return backup;
}

/** 目标库里有多少条事件（可写打开：WAL 会被正常重放）。 */
function countEventsAtFile(filePath) {
  const store = openStore({ path: filePath, auditKey: AUDIT_KEY, clock: createTestClock(), allowStaleLock: true });
  try {
    return countEvents(store);
  } finally {
    store.close();
  }
}

function leftBehind(dir) {
  return fs.readdirSync(dir).filter((name) => name.includes('.pre-restore-') || name.includes('.restore-'));
}

/* ================================================================== */
/* ① 崩溃态库恢复成功：已提交事务必须"仍在且被报告"                       */
/* ================================================================== */

test('① 崩溃态库（非空 WAL + 已提交事务）恢复成功后：旧库三件套完整保留，已提交数据可读、有计数', async (t) => {
  const dir = makeTempDir(t);
  const crashed = makeCrashedStore(t, dir);
  const backup = await makeBackup(t, 3);

  const restored = restoreBackup({
    backupPath: backup.path,
    targetPath: crashed.filePath,
    overwrite: true,
    now: NOW,
    clock: createTestClock(),
    auditKey: AUDIT_KEY,
  });

  // 结果必须自证"恢复前那份数据有多少条"，而不是只回一个 path。
  assert.equal(restored.previous_events, crashed.committed, 'previous_events 必须等于被换下去的已提交行数');
  assert.equal(restored.restored_events, 3);
  assert.equal(restored.wal.present, true);
  assert.equal(restored.wal.bytes_before, crashed.walBytes, '必须如实报告现场 WAL 字节数');
  assert.equal(restored.wal.bytes_after, 0, '恢复后目标库是备份的单文件快照，不应带着旧 WAL');
  assert.equal(restored.wal.mergeable, true, '崩溃留下的 WAL 应当是可合并的');
  assert.equal(restored.wal.discarded, false, '可合并的 WAL 不允许被标记成丢弃');
  assert.equal(restored.backup_chain.verified, true);

  // 恢复后的库 = 备份快照，且自身可用。
  const target = openStore({ path: crashed.filePath, auditKey: AUDIT_KEY, clock: createTestClock(), readOnly: true });
  t.after(() => target.close());
  assert.equal(countEvents(target), 3);
  assert.equal(verifyAuditChainInStore(target).ok, true);

  // 关键断言：旧库**三件套**都在 previous_copy 里，包括 -wal。
  const previousCopy = restored.previous_copy;
  assert.ok(previousCopy !== null && fs.existsSync(previousCopy));
  assert.ok(fs.existsSync(`${previousCopy}-wal`), '旧库的 WAL 必须随库一起搬走，而不是被删除');

  // 打开 previous_copy 就能看到那 2 条已提交事务 → 一条都没丢。
  assert.equal(countEventsAtFile(previousCopy), crashed.committed, 'previous_copy 里的已提交事务必须仍在');
  const recovered = openStore({ path: previousCopy, auditKey: AUDIT_KEY, clock: createTestClock(), readOnly: true });
  t.after(() => recovered.close());
  assert.equal(
    Number(recovered.get('SELECT COUNT(*) AS c FROM telemetry_event WHERE native_record_id = ?', [crashed.nativeRecordId]).c),
    1,
    '崩溃点之后提交的那一条必须能在 previous_copy 里按 id 找到',
  );
  assert.equal(verifyAuditChainInStore(recovered).ok, true, 'previous_copy 的审计链也必须仍然自洽');
});

test('① 恢复成功后不残留 staging 文件，previous_copy 之外没有第二份半成品', async (t) => {
  const dir = makeTempDir(t);
  const crashed = makeCrashedStore(t, dir);
  const backup = await makeBackup(t, 1);
  const restored = restoreBackup({
    backupPath: backup.path,
    targetPath: crashed.filePath,
    overwrite: true,
    now: NOW,
    clock: createTestClock(),
    auditKey: AUDIT_KEY,
  });
  const leftovers = leftBehind(dir);
  assert.deepEqual(
    leftovers.filter((name) => name.includes('.restore-')),
    [],
    `不允许残留 staging 文件：${leftovers.join(',')}`,
  );
  assert.ok(restored.previous_copy !== null);
});

/* ================================================================== */
/* ② 恢复失败：行数与 -wal 都要回到恢复前                                */
/* ================================================================== */

test('② 恢复失败（epoch 轮换被拒）后：主库行数、-wal 大小、审计链全部回到恢复前', async (t) => {
  const dir = makeTempDir(t);
  const crashed = makeCrashedStore(t, dir);
  const backup = await makeBackup(t, 2);
  const walBefore = fs.statSync(`${crashed.filePath}-wal`).size;

  // 让换库之后的 rotateEpoch 必然失败：新 epoch 与库里的旧 epoch 相同。
  // 这样"文件已经换过、旧 epoch 仍有效"的中间态真的出现过，才能测回滚。
  const error = expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath: crashed.filePath,
      overwrite: true,
      epoch: backup.epoch,
      now: NOW,
      clock: createTestClock(),
      auditKey: AUDIT_KEY,
    }),
    'ERR_STORE_INPUT',
  );

  // 失败必须响：错误码 + 恢复前后计数（不是静默回滚）。
  assert.equal(error.details.rollback, 'ok', '回滚成功的结论必须写在 details 里');
  assert.equal(error.details.events_before, crashed.committed);
  assert.equal(error.details.events_after, crashed.committed, '回滚后行数必须与恢复前一致');
  assert.equal(error.details.backup_events, 2);
  assert.equal(error.details.wal_bytes_before, walBefore);
  assert.equal(error.details.wal_bytes_after, walBefore, '回滚后 WAL 必须还在，且大小不变');

  // 文件层面：-wal 仍然存在，字节数一个不差。
  const walPath = `${crashed.filePath}-wal`;
  assert.ok(fs.existsSync(walPath), '回滚后 -wal 必须存在（旧实现会把它删掉）');
  assert.equal(fs.statSync(walPath).size, walBefore, '回滚必须是字节级的"回到恢复前"');
  assert.equal(leftBehind(dir).filter((name) => name.includes('.restore-')).length, 0);

  // 数据层面：那条崩溃点提交的事务仍然可读，链自洽。
  const reopened = openStore({ path: crashed.filePath, auditKey: AUDIT_KEY, clock: createTestClock() });
  t.after(() => reopened.close());
  assert.equal(countEvents(reopened), crashed.committed);
  assert.equal(
    Number(reopened.get('SELECT COUNT(*) AS c FROM telemetry_event WHERE native_record_id = ?', [crashed.nativeRecordId]).c),
    1,
  );
  assert.equal(verifyAuditChainInStore(reopened).hmacVerified, true);
});

test('② 缺 auditKey：在动目标库之前就拒绝，且把原因与目标路径写进 details', async (t) => {
  const dir = makeTempDir(t);
  const crashed = makeCrashedStore(t, dir);
  const backup = await makeBackup(t, 2);
  const before = fs.readFileSync(crashed.filePath);
  const walBefore = fs.statSync(`${crashed.filePath}-wal`).size;

  const error = expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath: crashed.filePath,
      overwrite: true,
      now: NOW,
      clock: createTestClock(),
    }),
    'ERR_RESTORE_CHAIN_UNVERIFIED',
  );
  assert.equal(error.details.reason, 'no_key', '没有密钥就复算不了链头 HMAC');
  assert.deepEqual(fs.readFileSync(crashed.filePath), before, '拒绝发生在任何搬迁之前');
  assert.equal(fs.statSync(`${crashed.filePath}-wal`).size, walBefore);
});

test('② 恢复失败（备份链被篡改）时目标库一个字节都不动', async (t) => {
  const dir = makeTempDir(t);
  const crashed = makeCrashedStore(t, dir);
  const backup = await makeBackup(t, 2);
  const before = fs.readFileSync(crashed.filePath);
  const walBefore = fs.statSync(`${crashed.filePath}-wal`).size;

  // 直接改坏备份里的一条审计行（改的是被签名的 canonical_json）：
  // 链自洽性被破坏，任何"允许未验证"的开关都不该放行。
  const tamper = new DatabaseSync(backup.path);
  tamper.exec(
    `UPDATE audit_event
        SET canonical_json = replace(canonical_json, '"telemetry.ingest"', '"telemetry.wiped"')
      WHERE sequence = 2`,
  );
  tamper.close();

  expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath: crashed.filePath,
      overwrite: true,
      allowUnverifiedChain: true,
      now: NOW,
      clock: createTestClock(),
      auditKey: AUDIT_KEY,
    }),
    'ERR_DB_INTEGRITY',
  );

  assert.deepEqual(fs.readFileSync(crashed.filePath), before, '拒绝恢复时主库不能有任何一个字节变化');
  assert.equal(fs.statSync(`${crashed.filePath}-wal`).size, walBefore);
  assert.deepEqual(leftBehind(dir).filter((name) => name.includes('.pre-restore-')), []);
});

/* ================================================================== */
/* ③ WAL 不可合并：默认拒绝；discardWal 才放行且必须留审计                 */
/* ================================================================== */

/**
 * 造一个"带非空、不可合并 WAL"的目标库。
 *
 * 手段：把库切到 rollback journal 模式，再塞一个游离的 `-wal`。SQLite 在这种
 * 形态下会完全忽略 `-wal`，`wal_checkpoint(TRUNCATE)` 也就清不掉它——
 * 正是"WAL 里的已提交事务无法并回主库"的可复现形态（且不依赖平台的文件锁）。
 */
function makeUnmergeableWalStore(t, dir) {
  const filePath = path.join(dir, 'aegis-harness.db');
  const store = openStore({ path: filePath, auditKey: AUDIT_KEY, clock: createTestClock() });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'keep-me' }), now: NOW });
  store.close();

  const raw = new DatabaseSync(filePath, { timeout: 2000 });
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.exec('PRAGMA journal_mode = DELETE');
  raw.close();

  const walPath = `${filePath}-wal`;
  const bytes = 8192;
  fs.writeFileSync(walPath, Buffer.alloc(bytes, 0x5a));
  return { filePath, walPath, bytes };
}

test('③ WAL 不可合并时默认拒绝恢复，并交出明确错误码与现场计数', async (t) => {
  const dir = makeTempDir(t);
  const target = makeUnmergeableWalStore(t, dir);
  const backup = await makeBackup(t, 2);

  const error = expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath: target.filePath,
      overwrite: true,
      now: NOW,
      clock: createTestClock(),
      auditKey: AUDIT_KEY,
    }),
    'ERR_RESTORE_WAL_UNSAFE',
  );
  assert.equal(error.details.wal_bytes, target.bytes);
  assert.equal(error.details.wal_reason, 'wal_header_invalid');
  assert.equal(error.details.target_events, null);

  // 拒绝就是拒绝：目标库、WAL、目录内容都原样。
  assert.equal(fs.statSync(target.walPath).size, target.bytes);
  assert.equal(countEventsAtFile(target.filePath), 1);
  assert.deepEqual(leftBehind(dir), [], '拒绝恢复时不允许留下任何搬迁/暂存文件');
});

test('③ discardWal:true 允许丢弃不可合并的 WAL，但恢复后的库里必须留审计，结果可自证', async (t) => {
  const dir = makeTempDir(t);
  const target = makeUnmergeableWalStore(t, dir);
  const backup = await makeBackup(t, 2);

  const restored = restoreBackup({
    backupPath: backup.path,
    targetPath: target.filePath,
    overwrite: true,
    discardWal: true,
    now: NOW,
    clock: createTestClock(),
    auditKey: AUDIT_KEY,
  });

  assert.equal(restored.wal.discarded, true);
  assert.equal(restored.wal.bytes_before, target.bytes);
  assert.equal(restored.wal.mergeable, false);
  // 证据仍然保留在 previous_copy 里（连那个不可合并的 WAL 一起）。
  assert.ok(fs.existsSync(restored.previous_copy));
  assert.equal(fs.statSync(`${restored.previous_copy}-wal`).size, target.bytes);

  const recovered = openStore({ path: target.filePath, auditKey: AUDIT_KEY, clock: createTestClock() });
  t.after(() => recovered.close());
  assert.equal(countEvents(recovered), 2, '恢复后的库必须是备份快照');
  const actions = recovered.all('SELECT action, canonical_json FROM audit_event ORDER BY sequence').map((row) => String(row.action));
  assert.ok(actions.includes('restore.wal_discarded'), `丢弃 WAL 必须留审计，实际：${actions.join(',')}`);
  const auditRow = recovered.get(
    "SELECT canonical_json FROM audit_event WHERE action = 'restore.wal_discarded'",
  );
  assert.ok(auditRow !== null, '审计行必须落库');
  assert.equal(verifyAuditChainInStore(recovered).hmacVerified, true);
});

/* ================================================================== */
/* 恢复前的审计链自证                                                    */
/* ================================================================== */

test('备份审计链无法自证（placeholder 链）时默认拒绝恢复', async (t) => {
  const dir = makeTempDir(t);
  // 用"没有密钥"的库做备份：链是公开占位密钥签的，谁都能重算，不能自证。
  const sourceDir = makeTempDir(t, 'wp1-restore-nokey');
  const source = openStore({ path: path.join(sourceDir, 'src.db'), auditKey: null, clock: createTestClock() });
  ingestTelemetry(source, { event: makeEvent({ native_record_id: 'nokey-1' }), now: NOW });
  const backup = await createBackup(source, { directory: path.join(sourceDir, 'backups'), now: NOW });
  source.close();

  const chain = verifyBackupAuditChain(backup.path, { auditKey: AUDIT_KEY });
  assert.equal(chain.verified, false);
  assert.equal(chain.reason, 'placeholder_key');

  const targetPath = path.join(dir, 'target.db');
  const error = expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath,
      now: NOW,
      clock: createTestClock(),
      auditKey: AUDIT_KEY,
    }),
    'ERR_RESTORE_CHAIN_UNVERIFIED',
  );
  assert.equal(error.details.reason, 'placeholder_key');
  assert.equal(fs.existsSync(targetPath), false, '拒绝时不能在目标路径留下半个库');
});

test('allowUnverifiedChain:true 才放行，并把"未验证"写进恢复后的审计', async (t) => {
  const dir = makeTempDir(t);
  const sourceDir = makeTempDir(t, 'wp1-restore-nokey2');
  const source = openStore({ path: path.join(sourceDir, 'src.db'), auditKey: null, clock: createTestClock() });
  ingestTelemetry(source, { event: makeEvent({ native_record_id: 'nokey-2' }), now: NOW });
  const backup = await createBackup(source, { directory: path.join(sourceDir, 'backups'), now: NOW });
  source.close();

  const targetPath = path.join(dir, 'target.db');
  const restored = restoreBackup({
    backupPath: backup.path,
    targetPath,
    allowUnverifiedChain: true,
    now: NOW,
    clock: createTestClock(),
    auditKey: AUDIT_KEY,
  });
  assert.equal(restored.backup_chain.verified, false);
  assert.equal(restored.backup_chain.reason, 'placeholder_key');

  const reopened = openStore({ path: targetPath, auditKey: AUDIT_KEY, clock: createTestClock() });
  t.after(() => reopened.close());
  const actions = reopened.all('SELECT action FROM audit_event ORDER BY sequence').map((row) => String(row.action));
  assert.ok(actions.includes('restore.chain_unverified'), `必须留标"未验证"，实际：${actions.join(',')}`);
  assert.ok(actions.includes('epoch.rotate'), '恢复仍然要轮换 epoch');
});

test('备份链与当前密钥不匹配（换钥/他人备份）时给出 foreign_key 并拒绝', async (t) => {
  const dir = makeTempDir(t);
  const sourceDir = makeTempDir(t, 'wp1-restore-otherkey');
  const source = openStore({ path: path.join(sourceDir, 'src.db'), auditKey: 'another-key-0123456789abcdef', clock: createTestClock() });
  ingestTelemetry(source, { event: makeEvent({ native_record_id: 'other-1' }), now: NOW });
  const backup = await createBackup(source, { directory: path.join(sourceDir, 'backups'), now: NOW });
  source.close();

  const chain = verifyBackupAuditChain(backup.path, { auditKey: AUDIT_KEY });
  assert.equal(chain.verified, false);
  assert.equal(chain.reason, 'foreign_key');

  const error = expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath: path.join(dir, 'target.db'),
      now: NOW,
      clock: createTestClock(),
      auditKey: AUDIT_KEY,
    }),
    'ERR_RESTORE_CHAIN_UNVERIFIED',
  );
  assert.equal(error.details.reason, 'foreign_key');
});

test('备份没有链头（旧 schema）时同样要显式 allowUnverifiedChain 才放行', async (t) => {
  const dir = makeTempDir(t);
  const sourceDir = makeTempDir(t, 'wp1-restore-legacy');
  // 只迁移到 v3：那时还没有 audit_chain_head 表（也就无从"自证"审计链）。
  const legacy = openStore({
    path: path.join(sourceDir, 'src.db'),
    auditKey: AUDIT_KEY,
    clock: createTestClock(),
    migrations: MIGRATIONS.slice(0, 3),
  });
  const backup = await createBackup(legacy, { directory: path.join(sourceDir, 'backups'), now: NOW });
  legacy.close();

  const chain = verifyBackupAuditChain(backup.path, { auditKey: AUDIT_KEY });
  assert.equal(chain.verified, false);
  assert.equal(chain.reason, 'no_chain_head');

  const targetPath = path.join(dir, 'legacy-restored.db');
  const error = expectStoreError(
    () => restoreBackup({
      backupPath: backup.path,
      targetPath,
      now: NOW,
      clock: createTestClock(),
      auditKey: AUDIT_KEY,
    }),
    'ERR_RESTORE_CHAIN_UNVERIFIED',
  );
  assert.equal(error.details.reason, 'no_chain_head');
  assert.equal(fs.existsSync(targetPath), false);

  const restored = restoreBackup({
    backupPath: backup.path,
    targetPath,
    allowUnverifiedChain: true,
    now: NOW,
    clock: createTestClock(),
    auditKey: AUDIT_KEY,
  });
  assert.equal(restored.path, targetPath);
  const reopened = openStore({ path: targetPath, auditKey: AUDIT_KEY, clock: createTestClock() });
  t.after(() => reopened.close());
  assert.equal(Number(reopened.getMeta('schema_version')), CURRENT_SCHEMA_VERSION, '恢复后的库必须被迁移到当前 schema');
  const actions = reopened.all('SELECT action FROM audit_event ORDER BY sequence').map((row) => String(row.action));
  assert.ok(actions.includes('restore.chain_unverified'), `必须留标"未验证"，实际：${actions.join(',')}`);
  assert.equal(verifyAuditChainInStore(reopened).ok, true);
});

/* ================================================================== */
/* 一并修：redeliverExecution 必须校验 Grant TTL                        */
/* ================================================================== */

test('redeliver 校验 Grant TTL：过期后拒绝重投，且不推进 attempts', (t) => {
  const { store, clock } = openTestStoreLocal(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });

  // Grant 的 TTL 上限是 5 分钟：先证明"没过期时能重投"。
  clock.advance(6000);
  const first = redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() });
  assert.equal(first.attempts, 1);

  const outboxBefore = Number(
    store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]).attempts,
  );

  // 推过 GRANT_MAX_TTL_MS：凭据已经作废，不能再原样重投出去。
  clock.advance(GRANT_MAX_TTL_MS + 60000);
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }),
    'ERR_APPROVAL_EXPIRED',
  );
  const outboxAfter = Number(
    store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]).attempts,
  );
  assert.equal(outboxAfter, outboxBefore, '被拒的重投不能把 attempts 推上去');

  const execution = getExecution(store, context.approved.execution_id);
  assert.equal(String(execution.state), 'dispatch_pending', '拒绝重投不能顺手改状态');
});

test('redeliver 同时校验 execution 上回写的到期时间（防只改一处）', (t) => {
  const { store, clock } = openTestStoreLocal(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });

  // 把 execution 的到期时间拨到过去，Grant JSON 不动：两个来源都要看。
  store.run('UPDATE execution SET expires_at_ms = ? WHERE execution_id = ?', [
    clock.nowMs() - 1000,
    context.approved.execution_id,
  ]);
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }),
    'ERR_APPROVAL_EXPIRED',
  );
});

/* ------------------------------------------------------------------ */

/** 本地包装：避免与 helpers 的名字冲突，同时保证句柄在用例结束时关闭。 */
function openTestStoreLocal(t) {
  const dir = makeTempDir(t);
  const clock = createTestClock();
  const store = openStore({ path: path.join(dir, 'aegis-harness.db'), clock, auditKey: AUDIT_KEY });
  t.after(() => {
    try {
      store.close();
    } catch {
      // 已关闭。
    }
  });
  return { store, dir, clock };
}
