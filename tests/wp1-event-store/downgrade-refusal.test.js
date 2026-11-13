/**
 * 降级安全：**旧二进制打开"未来 schema"库必须明确拒绝，且不改库字节**。
 *
 * 这是 UPGRADE-PATH 战役里"降级不允许静默损坏"的可重复判据。
 * 真实场景：用户装了 rc.5，data 目录里是 v5 库；回退到 rc.4 后，旧进程必须
 * - 若 schema 相同 → 正常打开（本文件最后一条用已冻结载荷证明它不是静默损坏）；
 * - 若 schema 更新 → 失败关闭（`ERR_SCHEMA_TOO_NEW`），不"尽力读"、不写、不迁移。
 *
 * 本文件是**新增**的用例文件，不改动任何既有断言。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  CURRENT_SCHEMA_VERSION,
  ingestTelemetry,
  openStore,
  verifyBackupFile,
} from '../../packages/event-store/src/index.js';

import {
  countEvents,
  expectStoreError,
  makeEvent,
  makeTempDir,
} from './helpers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** 建一张"未来版本跑过一次 v6 迁移"的库：meta 版本号 + schema_migration 行 + v6 表。 */
function makeFutureSchema(filePath, expectedEvents) {
  const raw = new DatabaseSync(filePath);
  try {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('BEGIN');
    raw.exec('CREATE TABLE v6_future_feature (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT');
    raw.prepare('INSERT INTO v6_future_feature (note) VALUES (?)').run('created by a newer release');
    raw.prepare(
      'INSERT OR REPLACE INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(6, 'simulated-v6', 'f'.repeat(64), '2026-11-05T00:00:00.000Z');
    raw.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run();
    raw.exec('COMMIT');
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    raw.close();
  }
  const check = rawFacts(filePath);
  assert.equal(check.schemaVersion, 6);
  assert.equal(check.events, expectedEvents);
  assert.equal(check.v6Rows, 1);
  return check;
}

/** 用裸 node:sqlite 只读看数据面（不经任何 event-store 版本，避免"被守卫挡在外面"看不到真相）。 */
function rawFacts(filePath) {
  const raw = new DatabaseSync(filePath, { readOnly: true });
  try {
    const count = (table) => {
      try {
        return Number(raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
      } catch {
        // 表不存在不是 0：返回 null，让调用方区分"空表"与"没有这张表"。
        return null;
      }
    };
    const meta = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return {
      schemaVersion: meta === undefined ? null : Number(meta.value),
      events: count('telemetry_event'),
      alerts: count('alert'),
      auditRows: count('audit_event'),
      v6Rows: count('v6_future_feature'),
      migrations: raw.prepare('SELECT version FROM schema_migration ORDER BY version').all()
        .map((row) => Number(row.version)),
      quickCheck: raw.prepare('PRAGMA quick_check').get().quick_check,
    };
  } finally {
    raw.close();
  }
}

/** 建一个"上一个版本写出来的"v5 库，返回路径与真实行数。 */
function seedCurrentSchema(dir, name = 'downgrade.db') {
  const filePath = path.join(dir, name);
  const store = openStore({ path: filePath, auditKey: 'downgrade-test-audit-key-0123456789abcdef' });
  try {
    for (let i = 0; i < 3; i += 1) {
      const event = makeEvent({ source_seq: 100 + i });
      ingestTelemetry(store, { event, now: '2026-11-01T00:00:02.000Z' });
    }
    assert.equal(countEvents(store), 3);
  } finally {
    store.close();
  }
  return filePath;
}

/** 已冻结载荷里的 event-store（v15/v16/v17）。没有 dist/bundle 的机器上返回 []。 */
function frozenPayloads() {
  const bundleRoot = path.join(REPO_ROOT, 'dist', 'bundle');
  if (!fs.existsSync(bundleRoot)) return [];
  const found = [];
  for (const entry of fs.readdirSync(bundleRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^win32-x64-v\d+$/u.test(entry.name)) continue;
    const index = path.join(
      bundleRoot, entry.name, 'app', 'node_modules', '@aegisharness', 'event-store', 'src', 'index.js',
    );
    if (fs.existsSync(index)) found.push({ name: entry.name, index });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

test('未来 schema 库（可写打开）被明确拒绝：错误码 + 可读文案 + database/binary', (t) => {
  const dir = makeTempDir(t);
  const filePath = seedCurrentSchema(dir);
  makeFutureSchema(filePath, 3);
  const before = fileSha256(filePath);

  const error = expectStoreError(() => openStore({ path: filePath }), 'ERR_SCHEMA_TOO_NEW');

  // 降级用户至少要能看懂"发生了什么"：文案里要有两个版本号，details 里要有可判定的字段。
  assert.match(error.message, /database schema 6 is newer than this binary/u);
  assert.match(error.message, new RegExp(`\\(${CURRENT_SCHEMA_VERSION}\\)`, 'u'));
  assert.equal(error.details.database, 6);
  assert.equal(error.details.binary, CURRENT_SCHEMA_VERSION);

  // **拒绝不能靠"打开后回滚"实现**：主库字节必须一个 bit 都没变。
  assert.equal(fileSha256(filePath), before, 'refusing to open must not rewrite the database file');

  // 拒绝不是"把它删了重建成空库"，也不是"降级写入"。
  const after = rawFacts(filePath);
  assert.equal(after.schemaVersion, 6);
  assert.equal(after.events, 3);
  assert.deepEqual(after.migrations, [1, 2, 3, 4, 5, 6]);
  assert.equal(after.quickCheck, 'ok');
});

test('未来 schema 库（只读打开）同样拒绝，且主库字节不变', (t) => {
  const dir = makeTempDir(t);
  const filePath = seedCurrentSchema(dir, 'future-readonly.db');
  makeFutureSchema(filePath, 3);
  const before = fileSha256(filePath);

  const error = expectStoreError(
    () => openStore({ path: filePath, readOnly: true }),
    'ERR_SCHEMA_TOO_NEW',
  );
  assert.equal(error.details.database, 6);
  assert.equal(fileSha256(filePath), before);
});

test('未来 schema 的备份文件也不许被"恢复/校验"放过（backup 守卫）', (t) => {
  const dir = makeTempDir(t);
  const filePath = seedCurrentSchema(dir, 'future-backup.db');
  makeFutureSchema(filePath, 3);
  const before = fileSha256(filePath);

  const error = expectStoreError(() => verifyBackupFile(filePath), 'ERR_SCHEMA_TOO_NEW');
  assert.match(error.message, /newer than this binary/u);
  assert.equal(fileSha256(filePath), before, 'verifying a newer-schema backup must not touch its bytes');
});

test('拒绝发生在任何迁移/写入之前：没有 v6 表被降级、没有新行', (t) => {
  const dir = makeTempDir(t);
  const filePath = seedCurrentSchema(dir, 'future-no-writes.db');
  const seeded = makeFutureSchema(filePath, 3);

  expectStoreError(() => openStore({ path: filePath }), 'ERR_SCHEMA_TOO_NEW');

  const after = rawFacts(filePath);
  assert.deepEqual(after, seeded, 'a refused open must leave the database semantically identical');
});

test('同 schema 的"新版本库"在旧版载荷下能打开，且不是静默损坏（行数/审计/写入逐项核对）', async (t) => {
  const payloads = frozenPayloads();
  if (payloads.length === 0) {
    t.skip('dist/bundle 下没有 win32-x64-v* 载荷（本机未构建发布物），跳过出厂字节交叉验证');
    return;
  }
  const dir = makeTempDir(t);
  const filePath = seedCurrentSchema(dir, 'same-schema.db');
  const auditKey = 'downgrade-test-audit-key-0123456789abcdef';
  const baseline = rawFacts(filePath);

  for (const [index, payload] of payloads.entries()) {
    const api = await import(pathToFileURL(payload.index).href);
    const expectedOnOpen = baseline.events + index;

    let store;
    try {
      store = api.openStore({ path: filePath, auditKey });
    } catch (error) {
      assert.fail(`${payload.name}: rc.3/rc.4/rc.5 是同一 schema，打开同版本库不应失败：${error.message}`);
    }
    try {
      assert.equal(api.CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION, `${payload.name} 的 schema 版本必须与仓库一致`);
      // 不是静默损坏：**打开本身**既不少行、也不多行。
      const onOpen = rawFacts(filePath);
      assert.equal(onOpen.events, expectedOnOpen, `${payload.name}: 打开后事件数必须与打开前一致`);
      assert.equal(onOpen.migrations.length, CURRENT_SCHEMA_VERSION, `${payload.name}: 旧版不得增删迁移记录`);
      const verify = api.verifyAuditChainInStore(store, { auditKey });
      assert.equal(verify.ok, true, `${payload.name}: audit chain must stay readable`);
      assert.equal(verify.hmacVerified, true, `${payload.name}: audit hmac must stay verifiable`);

      const event = makeEvent({ source_seq: 900 + index });
      const result = api.ingestTelemetry(store, { event, now: '2026-11-01T00:00:05.000Z' });
      assert.equal(result.duplicate, false);
    } finally {
      store.close();
    }

    const after = rawFacts(filePath);
    assert.equal(after.schemaVersion, CURRENT_SCHEMA_VERSION, `${payload.name}: 旧版不得改 schema_version`);
    assert.equal(after.quickCheck, 'ok');
    // 写入确实落地了（不是"打开了但写不进去"的假成功）
    assert.equal(after.events, expectedOnOpen + 1, `${payload.name}: 写入必须恰好新增 1 条事件`);
    assert.ok(after.auditRows > baseline.auditRows, `${payload.name}: 写入必须留下审计行`);
  }

  // 最后一个载荷写过之后：事件数是 3 + 载荷个数，审计链仍然可验。
  const final = rawFacts(filePath);
  assert.equal(final.events, 3 + payloads.length);
  assert.ok(final.auditRows >= 3 + payloads.length);
});

test('未来 schema 库在每一个已冻结载荷下都被拒绝（不是"旧版特例"）', async (t) => {
  const payloads = frozenPayloads();
  if (payloads.length === 0) {
    t.skip('dist/bundle 下没有 win32-x64-v* 载荷（本机未构建发布物），跳过出厂字节交叉验证');
    return;
  }
  const dir = makeTempDir(t);
  const template = seedCurrentSchema(dir, 'future-template.db');
  makeFutureSchema(template, 3);

  for (const payload of payloads) {
    const copy = path.join(dir, `future-${payload.name}.db`);
    fs.copyFileSync(template, copy);
    const before = fileSha256(copy);
    const api = await import(pathToFileURL(payload.index).href);
    let caught = null;
    try {
      api.openStore({ path: copy, auditKey: 'downgrade-test-audit-key-0123456789abcdef' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught !== null, `${payload.name}: 打开未来 schema 库必须抛错，而不是"尽力读"`);
    assert.equal(caught.code, 'ERR_SCHEMA_TOO_NEW', `${payload.name}: ${caught.message}`);
    assert.equal(caught.details.database, 6);
    assert.equal(fileSha256(copy), before, `${payload.name}: 拒绝时不得改库字节`);
    assert.equal(rawFacts(copy).schemaVersion, 6, `${payload.name}: 拒绝后版本号必须还是 6`);
  }
});
