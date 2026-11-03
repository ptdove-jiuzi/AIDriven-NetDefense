// author: PT-dove
// M9 对抗语料 —— event-store 的事务、恢复与恶意输入。
//
// 存储层是"唯一会落盘"的组件，因此这里的负向断言集中在四件事：
// 1. 非规范 DTO 不能靠"摘要看起来对"混过去；
// 2. 恶意 `now` / 恶意字符串只能作为绑定参数，永远不进 SQL 文本；
// 3. 崩溃点前后数据库只有两种状态：全有或全无，锁残留可被接管；
// 4. 损坏库只被隔离留证，绝不被删除或自动重建。
//
// 收尾顺序是硬要求：先关句柄再删目录（Windows 上带打开句柄的目录删不掉）。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  STORE_CODES,
  StoreError,
  countEvents,
  getEvent,
  ingestTelemetry,
  openStore,
  quarantineCorruptDatabase,
  verifyAuditChainInStore,
  writerLockPath,
} from '../../packages/event-store/src/index.js';
import { ContractError, canonicalDigest } from '../../packages/contracts/src/index.js';
import { createSandbox, expectRejection } from './support/harness.js';
import { telemetryEvent, UUID_A } from './support/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRASH_FIXTURE = path.join(HERE, 'fixtures', 'crash-ingest.mjs');
const AUDIT_KEY = 'm9-corpus-audit-key';

/**
 * 注册**唯一**的收尾钩子：按顺序关掉所有句柄，再删目录。
 *
 * 顺序不能反：Windows 上只要还有打开的 SQLite 句柄，`rmSync` 就是 EPERM。
 * 一个用例只注册一个钩子，也就没有"谁先谁后"的歧义。
 *
 * @param {import('node:test').TestContext} t 测试上下文。
 * @param {ReturnType<typeof createSandbox>} sandbox 临时目录。
 * @param {...{close: Function}} handles 需要关闭的句柄。
 */
function trackCleanup(t, sandbox, ...handles) {
  t.after(() => {
    for (const handle of handles) {
      try {
        handle.close();
      } catch {
        // 句柄可能已经被用例自己关掉；收尾不因重复关闭而失败。
      }
    }
    sandbox.cleanup();
  });
}

/**
 * 开一个临时库并登记收尾。
 *
 * @param {import('node:test').TestContext} t 测试上下文。
 * @param {string} [name] 库文件名。
 * @returns {{ store: object, sandbox: ReturnType<typeof createSandbox> }}
 */
/**
 * 判定"子进程没有因为未捕获异常而失败"。
 *
 * 不写 `stderr === ''`：Node 的 ExperimentalWarning / deprecation 也会写 stderr，
 * 那样的断言在换 Node 版本后会无故变红，属于环境耦合而不是安全性。
 *
 * @param {{stderr: string}} result 子进程结果。
 * @param {string} label 断言说明。
 */
function assertNoUncaught(result, label) {
  assert.equal(
    /\b(?:Error|Exception|uncaught)\b/u.test(result.stderr),
    false,
    `${label}: the child must not fail with an uncaught exception, stderr=${result.stderr.slice(0, 200)}`,
  );
}

function storeSandbox(t, name = 'events.db') {
  const sandbox = createSandbox();
  const store = openStore({ path: sandbox.resolve(name), auditKey: AUDIT_KEY });
  trackCleanup(t, sandbox, store);
  return { store, sandbox };
}

test('非规范 DTO：摘要按另一种序列化算出来也不接受', (t) => {
  const { store } = storeSandbox(t);

  const payload = { zeta: 1, alpha: 2 };
  // canonicalize 与键序无关，因此这份"手写摘要"在语义上与 canonical 摘要相同。
  const sameDigest = canonicalDigest({ alpha: 2, zeta: 1 });
  assert.equal(canonicalDigest(payload), sameDigest);

  const accepted = ingestTelemetry(store, { event: telemetryEvent({ payload }) });
  assert.equal(accepted.duplicate, false, 'a canonically equivalent payload is accepted');

  expectRejection(
    () => ingestTelemetry(store, {
      event: telemetryEvent({
        event_id: '22222222-2222-4222-8222-222222222222',
        payload: { zeta: 1, alpha: 3 },
        integrity: { algorithm: 'sha256', digest: sameDigest },
      }),
    }),
    { code: 'ERR_INTEGRITY_DIGEST_MISMATCH', type: ContractError, label: 'digest of a different payload' },
  );
  assert.equal(countEvents(store), 1, 'the rejected event must not be stored');
});

test('超大字段 / 超多键在事务之外被拒绝，不占写锁也不留 WAL 页', (t) => {
  const { store } = storeSandbox(t);

  const cases = [
    { payload: { blob: 'x'.repeat(20000) }, code: 'ERR_MAX_STRING_BYTES' },
    { payload: { blob: 'x'.repeat(17 * 1024) }, code: 'ERR_MAX_STRING_BYTES' },
    {
      payload: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, 1])),
      code: 'ERR_MAX_OBJECT_KEYS',
    },
  ];
  for (const entry of cases) {
    expectRejection(() => ingestTelemetry(store, { event: telemetryEvent({ payload: entry.payload }) }), {
      code: entry.code,
      type: ContractError,
      label: entry.code,
    });
  }
  assert.equal(countEvents(store), 0);
  assert.equal(store.integrityCheck({ full: true }).ok, true);
});

test('恶意 now：格式非法 / 超长 / 注入式字符串都被拒绝，且事件不入库', (t) => {
  const { store } = storeSandbox(t);

  const cases = [
    { now: 'not-a-date', code: 'ERR_TIMESTAMP_FORMAT' },
    { now: '2026-11-01T00:00:00+08:00', code: 'ERR_TIMESTAMP_FORMAT' },
    { now: "2026-11-01T00:00:00Z'", code: 'ERR_TIMESTAMP_FORMAT' },
    { now: `2026-11-01T00:00:00Z'; DROP TABLE telemetry_event; --`, code: 'ERR_MAX_STRING_BYTES' },
    { now: `2026-11-01T00:00:00Z${' '.repeat(64)}`, code: 'ERR_MAX_STRING_BYTES' },
  ];
  for (const entry of cases) {
    expectRejection(() => ingestTelemetry(store, { event: telemetryEvent(), now: entry.now }), {
      code: entry.code,
      type: ContractError,
      label: `now=${entry.now.slice(0, 24)}`,
    });
  }
  assert.equal(countEvents(store), 0);
  // 表还在：注入没有变成 SQL。
  assert.notEqual(
    store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_event'"),
    null,
  );
});

test('SQL 注入只作为绑定参数：元数据键里的引号不会改变查询语义', (t) => {
  const { store } = storeSandbox(t);

  for (const injection of [
    "x' OR '1'='1",
    'x"; DROP TABLE meta; --',
    "x' UNION SELECT value FROM meta --",
    "%'_",
  ]) {
    assert.equal(store.getMeta(injection), null, injection);
  }
  assert.equal(typeof store.getMeta('epoch'), 'string');
  assert.ok(store.all('SELECT name FROM sqlite_master WHERE type = ?', ['table']).length > 5);
});

test('重复 event_id 与稳定来源键都幂等：第二次不写审计、不追加计数', (t) => {
  const { store } = storeSandbox(t);

  const first = ingestTelemetry(store, { event: telemetryEvent() });
  const auditRows = () => store.all('SELECT sequence FROM audit_event ORDER BY sequence').length;
  const auditAfterFirst = auditRows();
  const second = ingestTelemetry(store, { event: telemetryEvent() });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.audit_sequence, null, 'a duplicate writes no audit row');
  assert.equal(auditRows(), auditAfterFirst);
  assert.equal(countEvents(store), 1);
});

test('恶意派生对象（超量 event_ids / 超大 count / 非法状态）被拒绝并整体回滚', (t) => {
  const { store } = storeSandbox(t);

  const base = {
    schemaVersion: '1.0',
    finding_id: '33333333-3333-4333-8333-333333333333',
    rule_id: 'corpus.example-rule',
    rule_version: '1.0.0',
    event_ids: [UUID_A],
    fingerprint: 'a'.repeat(64),
    severity: 'high',
    status: 'new',
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-01-01T00:00:01Z',
    count: 1,
    evidence_refs: [],
  };

  expectRejection(
    () => ingestTelemetry(store, {
      event: telemetryEvent(),
      findings: [{ ...base, event_ids: Array.from({ length: 257 }, () => UUID_A) }],
    }),
    { code: 'ERR_MAX_ARRAY_ITEMS', type: ContractError },
  );
  expectRejection(
    () => ingestTelemetry(store, { event: telemetryEvent(), findings: [{ ...base, count: 9007199254740992 }] }),
    { code: 'ERR_INTEGER_RANGE', type: ContractError },
  );
  expectRejection(
    () => ingestTelemetry(store, { event: telemetryEvent(), findings: [{ ...base, status: 'suppressed-by-admin' }] }),
    { code: 'ERR_FIELD_ENUM', type: ContractError },
  );
  assert.equal(countEvents(store), 0, 'a bad derived object must roll back the whole T1 unit');
});

test('第二个可写句柄被拒绝，只读句柄可以与写句柄共存但写不动', (t) => {
  const sandbox = createSandbox();
  const store = openStore({ path: sandbox.resolve('events.db'), auditKey: AUDIT_KEY });

  expectRejection(() => openStore({ path: sandbox.resolve('events.db'), auditKey: AUDIT_KEY }), {
    code: STORE_CODES.ERR_STORE_ALREADY_OPEN,
    type: StoreError,
  });

  const reader = openStore({ path: sandbox.resolve('events.db'), readOnly: true });
  trackCleanup(t, sandbox, reader, store);
  assert.equal(countEvents(reader), 0);
  expectRejection(() => ingestTelemetry(reader, { event: telemetryEvent() }), {
    code: STORE_CODES.ERR_STORE_READ_ONLY,
    type: StoreError,
  });
});

test('事务边界不可被绕过：exec 拒绝事务控制语句，嵌套事务被拒', (t) => {
  const { store } = storeSandbox(t);

  for (const sql of ['COMMIT', 'begin immediate', '-- c\nCOMMIT', '/* c */ ROLLBACK', 'SAVEPOINT x', 'RELEASE x', 'END']) {
    expectRejection(() => store.exec(sql), {
      code: STORE_CODES.ERR_TX_CONTROL,
      type: StoreError,
      label: sql,
    });
  }
  expectRejection(() => store.tx('outer', () => store.tx('inner', () => 1)), {
    code: STORE_CODES.ERR_TX_NESTED,
    type: StoreError,
  });
});

test('绕过 exec 用原生句柄提交时，tx() 报 ERR_TX_ESCAPED 而不是假装回滚', (t) => {
  const { store } = storeSandbox(t);

  expectRejection(() => store.tx('escape', () => {
    store.run('INSERT INTO sequence_counter (name, value) VALUES (?, ?)', ['escaped', 1]);
    store.db.exec('COMMIT');
  }), { code: STORE_CODES.ERR_TX_ESCAPED, type: StoreError });

  // 事务已被外部提交，写进去的行留在库里——这正是"半落地"状态，必须被显式报告。
  assert.notEqual(store.get('SELECT value FROM sequence_counter WHERE name = ?', ['escaped']), null);
});

test('残留写锁：内容不是合法 JSON 时按死锁接管，并用本进程 token 重写', (t) => {
  const sandbox = createSandbox();
  const filePath = sandbox.resolve('stale.db');
  writeFileSync(writerLockPath(filePath), 'not json at all');

  const store = openStore({ path: filePath, auditKey: AUDIT_KEY });
  trackCleanup(t, sandbox, store);

  const holder = JSON.parse(readFileSync(writerLockPath(filePath), 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(typeof holder.token, 'string');
  assert.ok(holder.token.length > 0);
});

test('残留写锁：锁路径是硬链接时接管不会写穿到别名文件', (t) => {
  const sandbox = createSandbox();
  const filePath = sandbox.resolve('linked.db');
  const alias = sandbox.resolve('lock-alias.json');
  writeFileSync(alias, JSON.stringify({ pid: 999999, token: 'dead', file: filePath }));
  linkSync(alias, writerLockPath(filePath));

  const store = openStore({ path: filePath, auditKey: AUDIT_KEY });
  trackCleanup(t, sandbox, store);

  // 别名文件的内容必须原封不动：接管用 rename 替换链接，而不是向链接目标写入。
  assert.deepEqual(JSON.parse(readFileSync(alias, 'utf8')), { pid: 999999, token: 'dead', file: filePath });
  assert.equal(JSON.parse(readFileSync(writerLockPath(filePath), 'utf8')).pid, process.pid);
});

test('活跃进程持锁时拒绝打开（跨进程互斥），持锁者退出后可接管', async (t) => {
  const sandbox = createSandbox();
  const filePath = sandbox.resolve('contended.db');

  // 一个真实存在的进程占住锁文件：起一个空转进程，等它真的起来。
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve) => holder.once('spawn', resolve));

  writeFileSync(writerLockPath(filePath), JSON.stringify({ pid: holder.pid, token: 'live', file: filePath }));

  expectRejection(() => openStore({ path: filePath, auditKey: AUDIT_KEY }), {
    code: STORE_CODES.ERR_STORE_LOCKED,
    type: StoreError,
  });

  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.once('exit', resolve));

  const store = openStore({ path: filePath, auditKey: AUDIT_KEY });
  trackCleanup(t, sandbox, store);
  assert.equal(store.isClosed(), false, 'once the lock holder is gone the stale lock is taken over');
});

test('提交前崩溃：未提交事务一个字节都不留', (t) => {
  const sandbox = createSandbox();
  const filePath = sandbox.resolve('precommit.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  const result = spawnSync(process.execPath, [CRASH_FIXTURE, '--store', filePath, '--phase', 'precommit'], {
    encoding: 'utf8',
  });
  assertNoUncaught(result, 'precommit');
  assert.match(result.stdout, /precommit/u);
  assert.notEqual(result.status, 0, 'the child must not exit cleanly');

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  trackCleanup(t, sandbox, reopened);
  assert.equal(reopened.get('SELECT name FROM sequence_counter WHERE name = ?', ['half-written']), null);
  assert.equal(reopened.integrityCheck({ full: true }).ok, true);
  assert.equal(countEvents(reopened), 0);
});

test('提交后崩溃：大事件完整落盘，审计链自洽，锁可被接管', (t) => {
  const sandbox = createSandbox();
  const filePath = sandbox.resolve('postcommit.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  const result = spawnSync(
    process.execPath,
    [CRASH_FIXTURE, '--store', filePath, '--phase', 'postcommit', '--payload-bytes', '15000'],
    { encoding: 'utf8' },
  );
  assertNoUncaught(result, 'postcommit');
  assert.match(result.stdout, /postcommit/u);
  assert.notEqual(result.status, 0);

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  trackCleanup(t, sandbox, reopened);
  assert.equal(countEvents(reopened), 1, 'the committed event survives the crash');
  const row = getEvent(reopened, UUID_A);
  assert.notEqual(row, null);
  assert.equal(Number(row.source_seq), 1);
  assert.equal(reopened.integrityCheck({ full: true }).ok, true);
  const chain = verifyAuditChainInStore(reopened);
  assert.equal(chain.ok, true, `audit chain must verify after a crash: ${JSON.stringify(chain)}`);
});

test('损坏库：打开时报 ERR_DB_CORRUPT，隔离只改名不删除', (t) => {
  const sandbox = createSandbox();
  const filePath = sandbox.resolve('corrupt.db');
  trackCleanup(t, sandbox);
  writeFileSync(filePath, 'this is definitely not a sqlite database'.repeat(20));

  expectRejection(() => openStore({ path: filePath, auditKey: AUDIT_KEY }), {
    code: STORE_CODES.ERR_DB_CORRUPT,
    type: StoreError,
  });

  const quarantined = quarantineCorruptDatabase(filePath, { now: '2026-11-02T00:00:00.000Z' });
  assert.equal(existsSync(filePath), false, 'the corrupt file is moved, not left in place');
  assert.equal(existsSync(quarantined.quarantined), true, 'the corrupt file is preserved for evidence');
  assert.equal(
    readFileSync(quarantined.quarantined, 'utf8').startsWith('this is definitely not'),
    true,
    'the quarantined file keeps its original bytes',
  );
  // 不自动重建：隔离之后仍然是"没有库"的状态。
  expectRejection(() => openStore({ path: filePath, readOnly: true }), {
    code: STORE_CODES.ERR_STORE_NOT_INITIALIZED,
    type: StoreError,
  });
});

test('隔离不存在的库直接报错（不会悄悄创建空文件冒充证据）', (t) => {
  const sandbox = createSandbox();
  trackCleanup(t, sandbox);
  expectRejection(() => quarantineCorruptDatabase(sandbox.resolve('missing.db')), {
    code: STORE_CODES.ERR_STORE_INPUT,
    type: StoreError,
  });
  assert.equal(existsSync(sandbox.resolve('missing.db')), false);
});
