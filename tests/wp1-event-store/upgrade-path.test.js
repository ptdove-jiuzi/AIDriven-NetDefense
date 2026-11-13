/**
 * 升级路径：旧库（v1..v4 与 rc.4 载荷建的库）→ 当前 schema。
 *
 * 判据优先级（本文件按此顺序组织）：**数据不丢 > 可回滚 > 速度**。
 *
 * 必须先说清一个事实，否则会误判本文件的价值：
 * `dist/bundle/win32-x64-v15|v16|v17` 里的 `@aegisharness/event-store/src/**`（15 个文件）
 * 与仓库**逐字节相同**，rc.3/rc.4/rc.5 之间没有任何 schema 差异。所以"rc.4 装的库升级到
 * rc.5"在真实世界里**不会触发迁移**；本文件证明的是**迁移机制本身**（v1..v5 的逐级映射、
 * 行保持、审计链重建/重封、失败整版本回滚），以及"rc.4 载荷写出的库能被当前二进制读/升"。
 *
 * 这里**只新增文件**：不改既有用例、不改断言、不放宽 `npm run test:wp1-event-store` 的 floor。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ingestTelemetry } from '../../packages/event-store/src/ingest.js';
import * as HELPERS from './helpers.js';
import * as H from './upgrade-path-helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEMP_DIRS = new Set();

after(() => {
  for (const directory of TEMP_DIRS) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch {
      // 临时目录残留不该让断言失败；真实断言另有报错。
    }
  }
  TEMP_DIRS.clear();
});

function tempDir(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `wp1-upgrade-${label}-`));
  TEMP_DIRS.add(directory);
  return directory;
}

/** 建一个真正的旧版本库（upTo，不是事后改 meta 伪造）。 */
function buildLegacyDb({ label, version, auditKey = null, clock = null, seed }) {
  const directory = tempDir(`${label}-v${version}`);
  const filePath = path.join(directory, `legacy-v${version}.db`);
  const store = H.openLegacyDb(filePath, { version, auditKey, clock });
  seed(store);
  const snapshot = H.snapshotTables(store);
  const audit = H.auditSnapshot(store);
  store.close();
  return { directory, filePath, snapshot, audit };
}

/** 审记链前缀必须逐字不变（迁移只能**追加**，不能改写历史行）。 */
function assertAuditPrefixUnchanged(beforeSnapshot, storeAfter) {
  const afterRows = H.dumpProjectedRows(storeAfter, 'audit_event', beforeSnapshot.columns.audit);
  const prefix = afterRows.slice(0, beforeSnapshot.rows.audit.length);
  assert.deepEqual(prefix, beforeSnapshot.rows.audit, '迁移不得改写迁移前已存在的审计行');
}

/* ------------------------------------------------------------------ */
/* 1. 迁移链本身                                                        */
/* ------------------------------------------------------------------ */

test('迁移链清单：5 个版本，名称/checksum/建表清单与冻结期望一致', () => {
  const chain = H.migrationChainMap();
  assert.equal(chain.length, 5, `迁移链应有 5 个版本，实际 ${chain.length}`);
  assert.deepEqual(chain.map((entry) => entry.version), [1, 2, 3, 4, 5]);
  assert.equal(H.CURRENT_SCHEMA_VERSION, 5);
  assert.equal(H.MIN_READABLE_SCHEMA_VERSION, 1);
  for (const [index, expected] of H.EXPECTED_CHAIN.entries()) {
    const actual = chain[index];
    assert.equal(actual.version, expected.version);
    assert.equal(actual.name, expected.name, `版本 ${expected.version} 的名称变了`);
    // 「迁移只增不改」：已发布版本的 statements 一旦被编辑，checksum 就变。
    assert.equal(actual.checksum, expected.checksum, `版本 ${expected.version} 的 checksum 变了（已发布迁移被改写）`);
    assert.deepEqual(actual.creates, expected.creates ?? [], `版本 ${expected.version} 建的表变了`);
    if (expected.alters !== undefined) {
      assert.deepEqual(actual.alters, expected.alters, `版本 ${expected.version} 的 ALTER 变了`);
    }
  }
  // 逐版本"引入了哪些表"的决定性事实。
  assert.deepEqual(chain[1].creates, ['data_gap', 'capability_state']);
  assert.deepEqual(chain[2].creates, []);
  assert.deepEqual(chain[3].creates, ['audit_chain_head']);
  assert.deepEqual(chain[4].creates, ['daemon_contribution_spool']);
  // 迁移链里唯一的版本号常量一致性。
  assert.equal(Math.max(...H.MIGRATIONS.map((entry) => entry.version)), H.CURRENT_SCHEMA_VERSION);
});

test('逐级映射：v1→v2→v3→v4→v5 每一步只应用下一个版本，业务表行数始终不变', () => {
  const { filePath, snapshot } = buildLegacyDb({
    label: 'stepwise',
    version: 1,
    seed: (store) => {
      H.seedLegacyTables(store, 1);
      H.appendLegacyAuditRows(store, { count: 2, key: null });
    },
  });

  const store = H.openLegacyDb(filePath, { version: 1 });
  try {
    for (const target of [2, 3, 4, 5]) {
      const applied = H.migrate(store, { upTo: target });
      assert.deepEqual(applied.applied, [target], `upTo:${target} 必须恰好只应用版本 ${target}`);
      assert.equal(Number(store.getMeta('schema_version')), target);
      const versions = store.all('SELECT version FROM schema_migration ORDER BY version').map((row) => Number(row.version));
      assert.deepEqual(versions, Array.from({ length: target }, (_, index) => index + 1));

      const report = H.compareSnapshots(snapshot, store);
      for (const label of ['events', 'findings', 'alerts', 'analysis', 'ledger', 'approval', 'execution']) {
        assert.equal(report[label].rowDiff, 0, `升到 v${target} 后 ${label} 行数发生变化`);
        assert.equal(report[label].projectionEqual, true, `升到 v${target} 后 ${label} 的旧列取值被改写`);
      }
    }
  } finally {
    store.close();
  }

  // 收尾校验：v4 引入链头表时补写的审计行**只可能**是那一条重建记录，不多不少。
  const reopened = H.openCurrentDb(filePath);
  try {
    const actions = reopened.all('SELECT sequence, action FROM audit_event ORDER BY sequence')
      .map((row) => `${Number(row.sequence)}:${String(row.action)}`);
    assert.deepEqual(actions, ['1:telemetry.ingest', '2:telemetry.ingest', '3:audit.chain_head_rebuild']);
  } finally {
    reopened.close();
  }
});

/* ------------------------------------------------------------------ */
/* 2. 旧库来源 (a)：upTo 构造的 v1..v4                                   */
/* ------------------------------------------------------------------ */

test('旧库来源(a) v1/v2/v3/v4 整跳 v5：8 张判据表行数 0 差、旧列逐值不变', () => {
  for (const version of [1, 2, 3, 4]) {
    const { filePath, snapshot, audit } = buildLegacyDb({
      label: `whole-hop-${version}`,
      version,
      auditKey: version >= 4 ? H.REAL_AUDIT_KEY : null,
      seed: (store) => {
        // 只写该版本真实存在的列：v1/v2 没有 lease_expired，v3 之前没有链头表。
        H.seedLegacyTables(store, version);
        if (version >= 4) H.appendChainedAuditRows(store, { count: 3 });
        else H.appendLegacyAuditRows(store, { count: 3, key: null });
      },
    });

    const upgraded = H.openCurrentDb(filePath);
    try {
      assert.equal(Number(upgraded.getMeta('schema_version')), H.CURRENT_SCHEMA_VERSION, `v${version} 未升到当前版本`);
      const report = H.compareSnapshots(snapshot, upgraded);
      for (const label of ['events', 'findings', 'alerts', 'analysis', 'ledger', 'approval', 'execution']) {
        assert.equal(report[label].rowsBefore > 0, true, `用例无效：v${version} 的 ${label} 表原本就是空的`);
        assert.equal(report[label].rowDiff, 0, `v${version}→v5：${label} 行数变化 ${report[label].rowDiff}`);
        assert.equal(report[label].projectionEqual, true, `v${version}→v5：${label} 的旧列取值被改写`);
        assert.deepEqual(report[label].removedColumns, [], `v${version}→v5：${label} 丢了列`);
      }
      // 审计表：v4 已有链头 → 迁移只建 spool 表，审计行 0 差；v1..v3 没有链头表 →
      // 迁移会补写一条 `audit.chain_head_rebuild`，这是**唯一**允许的行数增量。
      if (version >= 4) {
        assert.equal(report.audit.rowDiff, 0, 'v4→v5 不应新增审计行');
        assert.equal(report.audit.projectionEqual, true);
        assert.equal(audit.verdict.hmacVerified, true);
      } else {
        assert.equal(report.audit.rowDiff, 1, 'v1..v3→v5 只允许补写一条链头重建审计行');
        const appended = upgraded.all('SELECT action FROM audit_event ORDER BY sequence').at(-1);
        assert.equal(String(appended.action), 'audit.chain_head_rebuild');
        assertAuditPrefixUnchanged(snapshot, upgraded);
        assert.equal(snapshot.rows.audit.length, 3);
      }
    } finally {
      upgraded.close();
    }
  }
});

test('旧库来源(a) v1→v5：ADD COLUMN 只加默认值，不改旧行', () => {
  const { filePath } = buildLegacyDb({
    label: 'added-columns',
    version: 1,
    seed: (store) => {
      H.seedLegacyTables(store, 1);
      H.appendLegacyAuditRows(store, { count: 1, key: null });
    },
  });
  const upgraded = H.openCurrentDb(filePath);
  try {
    const analysisColumns = H.tableColumns(upgraded, 'analysis_outbox');
    assert.ok(analysisColumns.includes('lease_expired'), 'v3 的 ADD COLUMN 必须真的落在库上');
    const analysisRow = upgraded.get('SELECT lease_expired FROM analysis_outbox');
    assert.equal(Number(analysisRow.lease_expired), 0, '旧行在新列上必须取 DEFAULT 0，而不是 NULL/随机值');

    const outboxColumns = H.tableColumns(upgraded, 'execution_outbox');
    assert.ok(outboxColumns.includes('last_redeliver_at'), 'v4 的 ADD COLUMN 必须真的落在库上');
    const outboxRows = upgraded.all('SELECT last_redeliver_at FROM execution_outbox');
    for (const row of outboxRows) assert.equal(row.last_redeliver_at, null);
  } finally {
    upgraded.close();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 旧库来源 (b)：当前 API 写出的 v4 真库                              */
/* ------------------------------------------------------------------ */

test('旧库来源(a+) v4 真实 API 数据整跳 v5：逐表逐行逐值一致、审计链仍可验', () => {
  const directory = tempDir('realistic');
  const filePath = path.join(directory, 'realistic-v4.db');
  const clock = HELPERS.createTestClock();
  const store = H.openLegacyDb(filePath, { version: 4, auditKey: H.REAL_AUDIT_KEY, clock });
  H.seedRealisticDataset(store, HELPERS, { clock });
  const snapshot = H.snapshotTables(store);
  const audit = H.auditSnapshot(store);
  store.close();

  assert.equal(audit.verdict.ok, true, '升级前这个库的审计链必须先是 ok 的（否则本用例没有意义）');
  assert.equal(audit.verdict.hmacVerified, true);
  assert.ok(snapshot.rows.audit.length > 5, '真实链路应产生多条审计行');

  const upgraded = H.openCurrentDb(filePath);
  try {
    const report = H.compareSnapshots(snapshot, upgraded);
    for (const [label, entry] of Object.entries(report)) {
      assert.equal(entry.rowDiff, 0, `${label} 行数变化 ${entry.rowDiff}`);
      assert.equal(entry.projectionEqual, true, `${label} 的旧列取值被改写`);
    }
    const after = H.auditSnapshot(upgraded);
    assert.equal(after.verdict.ok, true);
    assert.equal(after.verdict.hmacVerified, true, '同一密钥下升级后必须整链验签通过');
    assert.deepEqual(after.head, audit.head, '升级不改链头');
    assert.equal(after.verdict.length, audit.verdict.length, '升级不改链长');
  } finally {
    upgraded.close();
  }
});

/* ------------------------------------------------------------------ */
/* 4. 审计链：链头引入 / 占位密钥 → 真实密钥                             */
/* ------------------------------------------------------------------ */

test('审计链：v3 旧库（旧行由同一真实密钥签）升级后 ok=true 且 hmacVerified=true', () => {
  const { filePath, snapshot, audit } = buildLegacyDb({
    label: 'audit-same-key',
    version: 3,
    auditKey: H.REAL_AUDIT_KEY,
    seed: (store) => {
      H.seedLegacyTables(store, 3);
      H.appendLegacyAuditRows(store, { count: 3, key: H.REAL_AUDIT_KEY });
    },
  });
  // v3 还没有链头表：此时 verify 必须失败关闭（缺锚点），不是"空链通过"。
  assert.equal(audit.verdict, null);
  assert.equal(audit.error.code, 'ERR_DB_INTEGRITY');
  assert.equal(audit.head, null);

  const upgraded = H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY });
  try {
    const after = H.auditSnapshot(upgraded);
    assert.equal(after.verdict.ok, true);
    // 旧行能用当前密钥验出来 → hmac_from_sequence 应为 1 → 整链可归因。
    assert.equal(after.head.hmac_from_sequence, 1, '可验证的旧链应从 1 起算，而不是只认新行');
    assert.equal(after.verdict.hmacVerified, true, '同密钥旧库升级后必须整链验签通过');
    assert.equal(after.verdict.length, snapshot.rows.audit.length + 1, '链长 = 旧链 + 1 条重建审计行');
    assert.equal(after.head.sequence, after.verdict.length);
    assert.equal(after.head.digest, after.tail.digest, '链头必须与新表尾一致');
    assertAuditPrefixUnchanged(snapshot, upgraded);
  } finally {
    upgraded.close();
  }
});

test('审计链：v3 旧库（旧行是占位密钥签的）升级后 ok=true 但 hmacVerified=partial（不冒充通过）', () => {
  const { filePath, snapshot, audit } = buildLegacyDb({
    label: 'audit-placeholder-rows',
    version: 3,
    auditKey: null,
    seed: (store) => {
      H.seedLegacyTables(store, 3);
      H.appendLegacyAuditRows(store, { count: 3, key: null });
    },
  });
  assert.equal(audit.verdict, null);
  assert.equal(audit.error.code, 'ERR_DB_INTEGRITY');

  const upgraded = H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY });
  try {
    const after = H.auditSnapshot(upgraded);
    assert.equal(after.verdict.ok, true, '结构必须自洽');
    assert.equal(after.verdict.hmacVerified, 'partial', '占位密钥签的旧行不能被真实密钥"追认"');
    assert.equal(after.head.hmac_from_sequence, snapshot.rows.audit.length + 1, '当前密钥只对链头之后的行负责');
    assert.equal(after.verdict.unverified_from, 1);
    assert.equal(after.verdict.unverified_to, snapshot.rows.audit.length);
    assertAuditPrefixUnchanged(snapshot, upgraded);
  } finally {
    upgraded.close();
  }
});

test('审计链：v4 占位链头 → 真实密钥是"重封"不是"重签"：链长/链头不变，验签如实报 partial', () => {
  const { filePath, audit } = buildLegacyDb({
    label: 'audit-reseal',
    version: 4,
    auditKey: null,
    seed: (store) => {
      H.seedLegacyTables(store, 4);
      H.appendChainedAuditRows(store, { count: 4 });
    },
  });
  assert.equal(audit.head.hmac_mode, 'placeholder');
  assert.equal(audit.verdict.ok, true);
  assert.equal(audit.verdict.hmacVerified, null, '占位模式本来就不能证明来源');

  const upgraded = H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY });
  try {
    const after = H.auditSnapshot(upgraded);
    assert.equal(after.head.sequence, audit.head.sequence, '重封不得推进链头');
    assert.equal(after.head.digest, audit.head.digest, '重封不得改写链头摘要');
    assert.equal(after.verdict.length, audit.verdict.length, '重封不得增删审计行');
    assert.equal(after.head.hmac_mode, 'hmac-sha256');
    assert.equal(after.head.hmac_from_sequence, audit.head.sequence + 1);
    assert.equal(after.verdict.ok, true);
    assert.equal(after.verdict.hmacVerified, 'partial');
    assert.equal(after.verdict.unverified_to, audit.head.sequence, '旧行区间必须如实交出来');
  } finally {
    upgraded.close();
  }
});

/* ------------------------------------------------------------------ */
/* 5. 失败整事务回滚                                                     */
/* ------------------------------------------------------------------ */

function brokenV5Migration() {
  // 真实 v5 statements 全部保留，最后追加一条**会在建表之后**失败的非法 SQL：
  // 这样"半成品表"只有在事务真的回滚时才会消失。
  return {
    version: 5,
    name: H.MIGRATIONS[4].name,
    statements: [...H.MIGRATIONS[4].statements, 'THIS IS NOT VALID SQL AT ALL'],
  };
}

test('失败注入：v5 中途失败 → 整版本回滚、schema_migration 无半截行、版本停在 4', () => {
  const { filePath, snapshot } = buildLegacyDb({
    label: 'rollback',
    version: 4,
    auditKey: H.REAL_AUDIT_KEY,
    seed: (store) => {
      H.seedLegacyTables(store, 4);
      H.appendChainedAuditRows(store, { count: 2 });
    },
  });

  let caught = null;
  try {
    H.openCurrentDb(filePath, { migrations: [...H.MIGRATIONS.slice(0, 4), brokenV5Migration()] });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, '注入非法 SQL 后迁移必须失败，而不是"尽力成功"');
  assert.equal(caught.code, 'ERR_MIGRATION_FAILED');
  assert.equal(caught.details.version, 5);
  assert.equal(caught.details.name, H.MIGRATIONS[4].name);

  const reopened = H.openLegacyDb(filePath, { version: 4, auditKey: H.REAL_AUDIT_KEY });
  let legacyCode = null;
  try {
    assert.equal(Number(reopened.getMeta('schema_version')), 4, '失败后 schema_version 必须停在旧值');
    const versions = reopened.all('SELECT version FROM schema_migration ORDER BY version')
      .map((row) => Number(row.version));
    assert.deepEqual(versions, [1, 2, 3, 4], 'schema_migration 不得落下半截的版本 5 行');
    assert.equal(
      reopened.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daemon_contribution_spool'"),
      null,
      'v5 的建表语句必须随整个版本一起回滚',
    );
    // 库仍然可读、可写、行不丢。
    const report = H.compareSnapshots(snapshot, reopened);
    for (const [label, entry] of Object.entries(report)) {
      assert.equal(entry.rowDiff, 0, `${label} 行数在失败迁移后变化 ${entry.rowDiff}`);
      assert.equal(entry.projectionEqual, true, `${label} 的行被失败迁移改写`);
    }
    assert.equal(H.auditSnapshot(reopened).verdict.ok, true, '失败迁移不得破坏审计链');
    // 单写者：同一路径同进程只能有一个可写句柄，先关再以"旧代码"开。
    reopened.close();
    // "旧代码仍能打开"：迁移清单截断到 v4 时不得报错（版本 4 低于二进制上限 5，这是合法的旧库）。
    legacyCode = H.openCurrentDb(filePath, { migrations: H.MIGRATIONS.slice(0, 4), upTo: 4, auditKey: H.REAL_AUDIT_KEY });
    assert.equal(Number(legacyCode.getMeta('schema_version')), 4);
    assert.deepEqual(H.countDiff(snapshot.counts, H.tableCounts(legacyCode)), {
      events: 0, findings: 0, alerts: 0, analysis: 0, ledger: 0, approval: 0, execution: 0, audit: 0,
    });
  } finally {
    if (legacyCode !== null) legacyCode.close();
    else {
      try {
        reopened.close();
      } catch {
        // 已经关过了：单写者路径下重复 close 会抛，这里只保证不泄漏句柄。
      }
    }
  }
});

test('失败注入：预迁移备份存在、就是迁移前快照、且可还原成零差的当前库', () => {
  const { directory, filePath, snapshot } = buildLegacyDb({
    label: 'backup',
    version: 4,
    auditKey: H.REAL_AUDIT_KEY,
    seed: (store) => {
      H.seedLegacyTables(store, 4);
      H.appendChainedAuditRows(store, { count: 2 });
    },
  });

  assert.throws(
    () => H.openCurrentDb(filePath, { migrations: [...H.MIGRATIONS.slice(0, 4), brokenV5Migration()] }),
    (error) => error.code === 'ERR_MIGRATION_FAILED',
  );

  const probe = H.openLegacyDb(filePath, { version: 4, auditKey: H.REAL_AUDIT_KEY });
  const recordedPath = probe.getMeta('last_pre_migration_backup');
  const latest = H.latestPreMigrationBackup(filePath);
  probe.close();

  assert.ok(latest !== null, '迁移前必须留下 VACUUM INTO 备份');
  assert.equal(recordedPath, latest, 'meta.last_pre_migration_backup 必须指向那份备份');
  assert.ok(fs.statSync(latest).size > 0, '备份不能是空文件');

  // 备份本身必须是"迁移前的库"：以 v4 打开它，逐表行数与迁移前一致。
  const backupHandle = H.openCurrentDb(latest, { migrations: H.MIGRATIONS.slice(0, 4), upTo: 4, auditKey: H.REAL_AUDIT_KEY });
  try {
    assert.equal(Number(backupHandle.getMeta('schema_version')), 4);
    const report = H.compareSnapshots(snapshot, backupHandle);
    for (const [label, entry] of Object.entries(report)) {
      assert.equal(entry.rowDiff, 0, `备份里的 ${label} 与迁移前不一致`);
      assert.equal(entry.projectionEqual, true);
    }
  } finally {
    backupHandle.close();
  }

  // 可还原：拷一份备份再升级（不碰备份原件），结果必须与"迁移成功的库"等价。
  const restorePath = path.join(directory, 'restore.db');
  fs.copyFileSync(latest, restorePath);
  const restored = H.openCurrentDb(restorePath, { auditKey: H.REAL_AUDIT_KEY });
  try {
    assert.equal(Number(restored.getMeta('schema_version')), H.CURRENT_SCHEMA_VERSION);
    const report = H.compareSnapshots(snapshot, restored);
    for (const [label, entry] of Object.entries(report)) {
      assert.equal(entry.rowDiff, 0, `还原后 ${label} 行数变化 ${entry.rowDiff}`);
      assert.equal(entry.projectionEqual, true, `还原后 ${label} 的旧列被改写`);
    }
    assert.equal(H.auditSnapshot(restored).verdict.ok, true);
  } finally {
    restored.close();
  }
});

/* ------------------------------------------------------------------ */
/* 6. 前向兼容与升级后可用性                                             */
/* ------------------------------------------------------------------ */

test('旧二进制拒读新库：schema_version > CURRENT 抛 ERR_SCHEMA_TOO_NEW（失败关闭）', () => {
  const directory = tempDir('too-new');
  const filePath = path.join(directory, 'too-new.db');
  const store = H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY });
  store.setMeta('schema_version', String(H.CURRENT_SCHEMA_VERSION + 1));
  store.close();

  assert.throws(
    () => H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY }),
    (error) => {
      assert.equal(error.code, 'ERR_SCHEMA_TOO_NEW');
      assert.equal(error.details.database, H.CURRENT_SCHEMA_VERSION + 1);
      return true;
    },
  );
});

test('升级后可继续写入：v4 旧库升到 v5 后 ingest 成功，审计链继续接得上', () => {
  const directory = tempDir('post-upgrade-write');
  const filePath = path.join(directory, 'post.db');
  const clock = HELPERS.createTestClock();
  const legacy = H.openLegacyDb(filePath, { version: 4, auditKey: H.REAL_AUDIT_KEY, clock });
  H.seedLegacyTables(legacy, 4);
  H.appendChainedAuditRows(legacy, { count: 2 });
  const beforeAudit = H.auditSnapshot(legacy);
  legacy.close();

  const upgraded = H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY, clock: HELPERS.createTestClock() });
  try {
    const at = upgraded.clock.nowIso();
    const event = HELPERS.makeEvent({ observed_at: at, received_at: at, payload: { process_name: 'post-upgrade.exe', pid: 7777 } });
    const alert = HELPERS.makeAlert({ fingerprint: H.sha256Hex('post-upgrade-alert'), first_seen: at, last_seen: at, window_start: at, window_end: at });
    const result = ingestTelemetry(upgraded, { event, alerts: [alert], allowedSummaryFields: ['process_name'], now: at });
    assert.equal(result.duplicate, false);
    assert.ok(Number(upgraded.get('SELECT COUNT(*) AS c FROM telemetry_event').c) >= 6);
    const after = H.auditSnapshot(upgraded);
    assert.equal(after.verdict.ok, true, '升级后继续写不得把审计链写坏');
    assert.equal(after.verdict.hmacVerified, true);
    assert.ok(after.verdict.length > beforeAudit.verdict.length, '新写事务必须继续追加审计行');
    assert.equal(after.head.sequence, after.verdict.length);
  } finally {
    upgraded.close();
  }
});

/* ------------------------------------------------------------------ */
/* 7. 出厂载荷（只读引用；dist 不在时自动不注册）                        */
/* ------------------------------------------------------------------ */

const PAYLOAD_ROOTS = ['win32-x64-v17', 'win32-x64-v16'].map((name) => path.join(
  REPO_ROOT, 'dist', 'bundle', name, 'app', 'node_modules', '@aegisharness', 'event-store',
));
const payloadRoot = PAYLOAD_ROOTS.find((root) => fs.existsSync(path.join(root, 'src', 'schema.js')));

if (payloadRoot !== undefined) {
  test('出厂载荷一致性：载荷里的 schema.js 与仓库逐字节相同，且载荷建的 v4 库能被当前二进制升级', async () => {
    const repoBytes = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'event-store', 'src', 'schema.js'));
    const payloadBytes = fs.readFileSync(path.join(payloadRoot, 'src', 'schema.js'));
    assert.equal(
      HELPERS.sha256Hex(payloadBytes),
      HELPERS.sha256Hex(repoBytes),
      '出厂载荷的 schema.js 与仓库不一致 → 本用例对"旧库"的假设失效，必须先重新核实版本差异',
    );

    const payload = await import(pathToFileURL(path.join(payloadRoot, 'src', 'index.js')).href);
    assert.equal(payload.CURRENT_SCHEMA_VERSION, H.CURRENT_SCHEMA_VERSION);

    const directory = tempDir('payload');
    const filePath = path.join(directory, 'payload-v4.db');
    // 用**载荷自己的代码**建库（upTo 4：构造"rc.4 时代旧库"），再用仓库代码升级。
    const payloadStore = payload.openStore({ path: filePath, upTo: 4, auditKey: H.REAL_AUDIT_KEY });
    H.seedLegacyTables(payloadStore, 4);
    payloadStore.tx('payload-audit-seed', () => {
      for (let index = 1; index <= 2; index += 1) {
        payload.appendAudit(payloadStore, {
          action: 'telemetry.ingest',
          actorType: 'system',
          actorId: 'aegis-store',
          objectDigest: H.sha256Hex(`payload-object:${index}`),
          payload: { seed: index },
          timestamp: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 1000).toISOString(),
        });
      }
    });
    const snapshot = H.snapshotTables(payloadStore);
    const audit = H.auditSnapshot(payloadStore);
    assert.equal(Number(payloadStore.getMeta('schema_version')), 4);
    payloadStore.close();

    const upgraded = H.openCurrentDb(filePath, { auditKey: H.REAL_AUDIT_KEY });
    try {
      assert.equal(Number(upgraded.getMeta('schema_version')), H.CURRENT_SCHEMA_VERSION);
      const report = H.compareSnapshots(snapshot, upgraded);
      for (const [label, entry] of Object.entries(report)) {
        assert.equal(entry.rowDiff, 0, `载荷库升级后 ${label} 行数变化 ${entry.rowDiff}`);
        assert.equal(entry.projectionEqual, true, `载荷库升级后 ${label} 的旧列被改写`);
      }
      const after = H.auditSnapshot(upgraded);
      assert.equal(after.verdict.ok, true);
      assert.equal(after.verdict.hmacVerified, true);
      assert.deepEqual(after.head, audit.head, '载荷写出的链头必须被原样保留');
    } finally {
      upgraded.close();
    }
  });
}
