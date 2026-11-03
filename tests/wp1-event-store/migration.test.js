/**
 * 迁移：前向、事务化、可校验和、失败整体回滚。
 *
 * 这里最重要的是"迁移失败之后库还能用"：半成品 schema 比不迁移更危险，
 * 因为它会让后续代码以为字段存在。用例直接检查失败版本创建的表**不存在**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { migrate } from '../../packages/event-store/src/db.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../packages/event-store/src/schema.js';

import {
  expectStoreError,
  makeTempDir,
  openStore,
  openTestStore,
} from './helpers.js';
import path from 'node:path';

function tableNames(store) {
  return store
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => String(row.name));
}

test('全新库记录全部迁移版本', (t) => {
  const { store } = openTestStore(t);
  const versions = store.all('SELECT version FROM schema_migration ORDER BY version').map((row) => Number(row.version));
  assert.deepEqual(versions, MIGRATIONS.map((entry) => entry.version));
  assert.equal(Number(store.getMeta('schema_version')), CURRENT_SCHEMA_VERSION);
  assert.equal(Number(store.getMeta('reader_version_min')), 1);
});

test('只迁到旧版本的库在下次可写打开时自动补齐', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'partial.db');
  const first = openStore({ path: filePath, upTo: 1 });
  assert.equal(Number(first.getMeta('schema_version')), 1);
  assert.equal(tableNames(first).includes('data_gap'), false);
  first.close();

  const upgraded = openStore({ path: filePath });
  t.after(() => upgraded.close());
  assert.equal(Number(upgraded.getMeta('schema_version')), CURRENT_SCHEMA_VERSION);
  assert.ok(tableNames(upgraded).includes('data_gap'));
  assert.ok(tableNames(upgraded).includes('capability_state'));
});

test('迁移失败整体回滚：半成品表不存在、版本号不变', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'broken-migration.db');
  const broken = [
    MIGRATIONS[0],
    {
      version: 2,
      name: 'intentionally-broken',
      statements: [
        'CREATE TABLE half_done (a TEXT) STRICT',
        'THIS IS NOT VALID SQL AT ALL',
      ],
    },
  ];

  const error = expectStoreError(
    () => openStore({ path: filePath, migrations: broken }),
    'ERR_MIGRATION_FAILED',
  );
  assert.equal(error.details.version, 2);

  // 用"只认识版本 1"的迁移清单重新打开：证明确实停在 1，且半成品表被回滚掉。
  const recovered = openStore({ path: filePath, migrations: [MIGRATIONS[0]], upTo: 1 });
  t.after(() => recovered.close());
  assert.equal(Number(recovered.getMeta('schema_version')), 1);
  assert.equal(tableNames(recovered).includes('half_done'), false);
  const applied = recovered.all('SELECT version FROM schema_migration ORDER BY version').map((row) => Number(row.version));
  assert.deepEqual(applied, [1]);
});

test('已应用迁移被篡改时报 checksum mismatch', (t) => {
  const { store, dir } = openTestStore(t);
  store.run('UPDATE schema_migration SET checksum = ? WHERE version = 1', ['0'.repeat(64)]);
  store.close();
  const error = expectStoreError(
    () => openStore({ path: path.join(dir, 'aegis-harness.db') }),
    'ERR_MIGRATION_CHECKSUM_MISMATCH',
  );
  assert.equal(error.details.version, 1);
});

test('只读打开 schema 落后的库时要求先迁移', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'old-schema.db');
  const first = openStore({ path: filePath, upTo: 1 });
  first.close();
  const error = expectStoreError(
    () => openStore({ path: filePath, readOnly: true }),
    'ERR_STORE_NOT_INITIALIZED',
  );
  assert.equal(error.details.database, 1);
});

test('只读句柄上不能执行迁移', (t) => {
  const { store, dir } = openTestStore(t);
  store.close();
  const reader = openStore({ path: path.join(dir, 'aegis-harness.db'), readOnly: true });
  t.after(() => reader.close());
  expectStoreError(() => migrate(reader), 'ERR_STORE_READ_ONLY');
});

test('目标版本低于已应用版本时不降级、不报错', (t) => {
  const { store } = openTestStore(t);
  const result = migrate(store, { upTo: 1 });
  assert.deepEqual(result.applied, []);
  assert.equal(result.current, CURRENT_SCHEMA_VERSION);
  assert.equal(Number(store.getMeta('schema_version')), CURRENT_SCHEMA_VERSION);
});

test('迁移在事务中运行：失败后连接仍可继续使用', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'after-failure.db');
  try {
    openStore({
      path: filePath,
      migrations: [
        MIGRATIONS[0],
        { version: 2, name: 'boom', statements: ['SELECT definitely_not_a_function(1)'] },
      ],
    });
  } catch (error) {
    assert.equal(error.code, 'ERR_MIGRATION_FAILED');
  }
  const recovered = openStore({ path: filePath, migrations: [MIGRATIONS[0]], upTo: 1 });
  t.after(() => recovered.close());
  recovered.tx('still-usable', () => recovered.setMeta('after_failure', 'ok'));
  assert.equal(recovered.getMeta('after_failure'), 'ok');
});
