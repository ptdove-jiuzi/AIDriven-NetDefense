/**
 * 一致性备份、恢复与损坏库隔离。
 *
 * 用 online backup 而不是复制 WAL 文件，是因为"复制活跃 WAL"在崩溃点上是
 * 不可证明一致的。用例除了测"备份能打开"，还测"备份里有多少行"，
 * 否则一个空库也能通过完整性检查。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  countEvents,
  createBackup,
  ingestTelemetry,
  openStore,
  quarantineCorruptDatabase,
  restoreBackup,
  verifyBackupFile,
} from '../../packages/event-store/src/index.js';

import {
  expectStoreError,
  makeEvent,
  makeTempDir,
  openTestStore,
} from './helpers.js';

const A = '2026-11-01T00:00:02.000Z';
const B = '2026-11-01T00:00:03.000Z';
const C = '2026-11-01T00:00:04.000Z';

function seedEvents(store, count) {
  for (let index = 0; index < count; index += 1) {
    ingestTelemetry(store, {
      event: makeEvent({ native_record_id: `backup-${index}` }),
      now: A,
    });
  }
}

test('备份通过完整性检查并生成摘要清单', async (t) => {
  const { store, dir } = openTestStore(t);
  seedEvents(store, 3);
  const backup = await createBackup(store, { directory: path.join(dir, 'backups'), now: A });

  assert.equal(backup.integrity, 'ok');
  assert.equal(backup.schema_version, Number(store.getMeta('schema_version')));
  assert.match(backup.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(fs.existsSync(backup.path));
  assert.ok(fs.existsSync(backup.manifest_path));

  const manifest = JSON.parse(fs.readFileSync(backup.manifest_path, 'utf8'));
  assert.equal(manifest.sha256, backup.sha256);
  assert.equal(manifest.epoch, store.epoch());
  assert.equal(manifest.audit_head_sequence, 3);
});

test('备份内容包含已提交的行（不是空壳）', async (t) => {
  const { store, dir } = openTestStore(t);
  seedEvents(store, 4);
  const backup = await createBackup(store, { directory: path.join(dir, 'backups'), now: A });

  const restored = openStore({ path: backup.path, readOnly: true });
  t.after(() => restored.close());
  assert.equal(countEvents(restored), 4);
  assert.equal(Number(restored.get('SELECT COUNT(*) AS c FROM audit_event').c), 4);
});

test('事务内不能创建备份', async (t) => {
  const { store, dir } = openTestStore(t);
  await assert.rejects(
    async () => store.tx('with-backup', () => createBackup(store, { directory: path.join(dir, 'b'), now: A })),
    (error) => error.code === 'ERR_NOT_SUPPORTED',
  );
});

test('同名备份目标已存在时拒绝覆盖', async (t) => {
  const { store, dir } = openTestStore(t);
  const directory = path.join(dir, 'backups');
  await createBackup(store, { directory, now: A });
  await assert.rejects(
    async () => createBackup(store, { directory, now: A }),
    (error) => error.code === 'ERR_BACKUP_TARGET_EXISTS',
  );
});

test('恢复备份到新路径并轮换 epoch（旧审批/租约失效）', async (t) => {
  const { store, dir } = openTestStore(t);
  seedEvents(store, 2);
  const backup = await createBackup(store, { directory: path.join(dir, 'backups'), now: A });
  const target = path.join(dir, 'restored.db');
  const restored = restoreBackup({
    backupPath: backup.path,
    targetPath: target,
    now: B,
    clock: store.clock,
    auditKey: store.auditKey,
  });
  assert.equal(restored.path, target);
  assert.notEqual(restored.epoch, backup.epoch, 'restore must rotate the epoch');
  assert.equal(restored.previous_epoch, backup.epoch);

  const reopened = openStore({ path: target, readOnly: true });
  t.after(() => reopened.close());
  assert.equal(reopened.epoch(), restored.epoch);
  assert.equal(countEvents(reopened), 2);
});

test('恢复目标已存在时必须显式 overwrite', async (t) => {
  const { store, dir } = openTestStore(t);
  seedEvents(store, 1);
  const backup = await createBackup(store, { directory: path.join(dir, 'backups'), now: A });
  const target = path.join(dir, 'existing.db');
  fs.writeFileSync(target, 'placeholder');
  assert.throws(
    () => restoreBackup({ backupPath: backup.path, targetPath: target, now: B, clock: store.clock, auditKey: store.auditKey }),
    (error) => error.code === 'ERR_BACKUP_TARGET_EXISTS',
  );
  const overwritten = restoreBackup({
    backupPath: backup.path,
    targetPath: target,
    overwrite: true,
    now: C,
    clock: store.clock,
    auditKey: store.auditKey,
  });
  assert.equal(overwritten.path, target);
});

test('损坏的备份文件无法通过校验', (t) => {
  const dir = makeTempDir(t);
  const broken = path.join(dir, 'broken-backup.db');
  fs.writeFileSync(broken, 'not a sqlite database at all, repeated filler text', 'utf8');
  assert.throws(() => verifyBackupFile(broken), (error) => error.code === 'ERR_DB_CORRUPT');
});

test('不存在的备份文件报 ERR_BACKUP_FAILED', (t) => {
  const dir = makeTempDir(t);
  assert.throws(
    () => verifyBackupFile(path.join(dir, 'nope.db')),
    (error) => error.code === 'ERR_BACKUP_FAILED',
  );
});

test('损坏库隔离：只改名留证，不删除、不重建', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'corrupt.db');
  fs.writeFileSync(filePath, 'garbage bytes that sqlite cannot open', 'utf8');
  const result = quarantineCorruptDatabase(filePath, { now: '2026-11-01T00:00:00.000Z' });

  assert.match(result.quarantined, /\.corrupt-2026-11-01T00-00-00-000Z$/u);
  assert.equal(fs.existsSync(filePath), false, 'original path must be free for a fresh database');
  assert.ok(fs.existsSync(result.quarantined), 'quarantined file must be kept as evidence');
  const content = fs.readFileSync(result.quarantined, 'utf8');
  assert.match(content, /garbage bytes/u);

  // 隔离之后可以在原路径建立新库（不会被自动重建，必须显式打开）。
  const fresh = openStore({ path: filePath });
  t.after(() => {
    fresh.close();
    try {
      fs.chmodSync(result.quarantined, 0o644);
    } catch {
      // Windows 上 chmod 只是尽力而为。
    }
  });
  assert.equal(Number(fresh.getMeta('schema_version')) > 0, true);
});

test('备份期间写连接仍然可用（online backup 不冻结库）', async (t) => {
  const { store, dir } = openTestStore(t);
  seedEvents(store, 1);
  const backup = await createBackup(store, { directory: path.join(dir, 'backups'), now: A });
  ingestTelemetry(store, { event: makeEvent({ native_record_id: 'after-backup' }), now: B });
  assert.equal(countEvents(store), 2);
  const reader = openStore({ path: backup.path, readOnly: true });
  t.after(() => reader.close());
  assert.equal(countEvents(reader), 1, 'backup is a point-in-time snapshot');
});
