/**
 * 安全加固回归：审计锚点自证、验签起点不可篡改、单写者锁的路径别名与归属、
 * 事务控制语句、重投上限、以及三条零覆盖的负例。
 *
 * 这个文件刻意只写"攻击者会怎么打"的用例：
 * - 每条用例都能在**修复前**复现（要么返回 ok，要么静默成功）；
 * - 断言不看错误文案，只看稳定的 `code`；
 * - 每条都用公开 API 或最少的原始 SQL 构造现场，不 mock 任何存储层逻辑。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  MIGRATIONS,
  MAX_ACCEPT_SEQ,
  MAX_REDELIVER_ATTEMPTS,
  acceptExecution,
  beginExecuting,
  ensureAuditChainHead,
  findTransactionControl,
  getExecution,
  ingestTelemetry,
  openStore,
  prepareDispatch,
  redeliverExecution,
  repairAuditMode,
  verifyAuditChainInStore,
  writeRecoveryManifest,
  writerLockPath,
} from '../../packages/event-store/src/index.js';
import { canonicalize, hmacBase64 } from '../../packages/event-store/src/util.js';

import {
  BASE_ISO,
  buildApprovedExecution,
  buildDispatchedExecution,
  canonicalDigest,
  createTestClock,
  expectStoreError,
  makeEvent,
  makeTempDir,
  openTestStore,
  sha256Hex,
} from './helpers.js';

const AUDIT_KEY = 'test-audit-key-0123456789abcdef';
const NOW = '2026-11-01T00:00:02.000Z';

function ingestOne(store, index) {
  return ingestTelemetry(store, {
    event: makeEvent({ native_record_id: `sec-${index}` }),
    now: NOW,
  });
}

function auditActions(store) {
  return store.all('SELECT action FROM audit_event ORDER BY sequence').map((row) => String(row.action));
}

/** 读出「通过」判定：只有 ok === true 且 hmacVerified === true 才算通过。 */
function passed(verification) {
  return verification.ok === true && verification.hmacVerified === true;
}

/* ================================================================== */
/* P0-1：整条链不能被两条 SQL 静默抹除                                   */
/* ================================================================== */

test('P0-1 复核者探针：删 meta 锚点 + 清空 audit_event 后校验必须失败关闭', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  assert.equal(passed(verifyAuditChainInStore(store)), true);

  // 复核者的原始两条 SQL：把"锚点"与"事件"一起删掉。
  store.run("DELETE FROM meta WHERE key IN ('audit_head_sequence','audit_head_digest')");
  store.run('DELETE FROM audit_event');

  const error = expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
  assert.ok(String(error.message).length > 0);
});

test('P0-1 链头记录被删：即使用户已经把 meta 也清干净，校验仍然失败', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  store.run('DELETE FROM audit_chain_head');
  store.run('DELETE FROM audit_event');
  store.run('DELETE FROM meta');

  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('P0-1 链头记录被改写（把锚点往回拨）会被它自己的 HMAC 抓住', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  store.run('UPDATE audit_chain_head SET sequence = 1');

  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('P0-1 链头缺失时拒绝追加：不能把新行挂到无名锚点上', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  store.run('DELETE FROM audit_chain_head');

  expectStoreError(() => ingestOne(store, 2), 'ERR_DB_INTEGRITY');
  // 拒绝之后库里仍然只有那一条，没有"追加了一半"的行。
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM audit_event').c), 1);
});

test('P0-1 删掉尾部证据后不能继续追加（否则链会重新自洽地往下长）', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  ingestOne(store, 3);
  store.run('DELETE FROM audit_event WHERE sequence >= 2');

  expectStoreError(() => ingestOne(store, 4), 'ERR_DB_INTEGRITY');
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('P0-1 空链的 hmacVerified 必须是 null，不能报 true', (t) => {
  const { store } = openTestStore(t);
  const verification = verifyAuditChainInStore(store);
  assert.equal(verification.ok, true);
  assert.equal(verification.length, 0);
  assert.equal(verification.hmacVerified, null);
  assert.notEqual(passed(verification), true);
});

test('P0-1 旧库升级：缺链头时按重封语义重建锚点，并留下审计行', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'legacy.db');
  // 只迁移到 v3 = 旧二进制写下的库：没有 audit_chain_head 表。
  const legacy = openStore({
    path: filePath,
    clock: createTestClock(),
    auditKey: AUDIT_KEY,
    migrations: MIGRATIONS.slice(0, 3),
  });
  let previousDigest = '0'.repeat(64);
  for (let sequence = 1; sequence <= 2; sequence += 1) {
    previousDigest = insertLegacyAuditRow(legacy, AUDIT_KEY, { sequence, previousDigest });
  }
  assert.equal(Number(legacy.getMeta('schema_version')), 3);
  legacy.close();

  const upgraded = openStore({ path: filePath, auditKey: AUDIT_KEY, clock: createTestClock() });
  t.after(() => upgraded.close());

  const head = upgraded.get('SELECT sequence, digest FROM audit_chain_head WHERE id = 1');
  assert.notEqual(head, null, '升级必须重建链头记录');
  assert.equal(Number(head.sequence), 3, '重建后锚点推进到"遗留行 + 重建审计行"');
  const actions = auditActions(upgraded);
  assert.ok(actions.includes('audit.chain_head_rebuild'), `重建必须留审计行，实际：${actions.join(',')}`);
  const verification = verifyAuditChainInStore(upgraded);
  assert.equal(passed(verification), true, '遗留行能被当前密钥验证时，重建后应整体通过');
  assert.equal(verification.length, 3);
});

test('P0-1 已在 v4 上被删掉链头的库不会"自动重建"（抹除不会被洗白）', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  store.run('DELETE FROM audit_chain_head');

  // introduced=false：这不是"刚迁移上来"，而是"锚点被删了"。
  assert.equal(ensureAuditChainHead(store, { chainHeadIntroduced: false }), null);
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');

  // 人工出口：显式确认后可以重建，但重建本身会写审计行。
  const repaired = repairAuditMode(store, { acknowledge: true, now: NOW });
  assert.equal(repaired.mode, 'hmac-sha256');
  const actions = auditActions(store);
  assert.ok(actions.includes('audit.reseal'));
});

/* ================================================================== */
/* P0-2：验签起点不能被单独一行改写                                     */
/* ================================================================== */

test('P0-2 复核者探针：改大 audit_hmac_from_sequence 不再能停用验签', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);

  // 复核者的原始探针：把验签起点改到 999，让"一行都不验"看起来像 partial。
  store.setMeta('audit_hmac_from_sequence', '999');
  const verification = verifyAuditChainInStore(store);
  assert.equal(verification.hmacVerified, true, '验签起点只能来自被签名的链头');

  // 再把第 2 行的 HMAC 改坏：旧实现因为"起点 999"而一行都不验，仍然报 ok。
  store.run("UPDATE audit_event SET hmac = 'AAAA' WHERE sequence = 2");
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('P0-2 partial 必须交出未覆盖区间，且不得被当成通过', (t) => {
  const { store, dir } = openTestStore(t, { auditKey: null });
  ingestOne(store, 1);
  store.close();

  const reopened = openStore({ path: path.join(dir, 'aegis-harness.db'), auditKey: AUDIT_KEY, clock: createTestClock() });
  t.after(() => reopened.close());
  const verification = verifyAuditChainInStore(reopened);
  assert.equal(verification.ok, true);
  assert.equal(verification.hmacVerified, 'partial');
  assert.equal(verification.unverified_from, 1);
  assert.equal(verification.unverified_to, 1);
  assert.equal(passed(verification), false, 'partial 不是通过');
});

/* ================================================================== */
/* P1-1：单写者锁的路径别名与归属                                        */
/* ================================================================== */

test('P1-1 大小写别名不能开出第二个写句柄', (t) => {
  const dir = makeTempDir(t);
  const lower = path.join(dir, 'case.db');
  const first = openStore({ path: lower, clock: createTestClock(), auditKey: AUDIT_KEY });
  t.after(() => first.close());

  // 大小写不敏感的文件系统上这是同一个文件的另一种写法；
  // 登记键在这里统一折叠大小写，因此无论在哪种文件系统上都必须被拒。
  for (const alias of [path.join(dir, 'CASE.db'), path.join(dir, 'Case.DB')]) {
    expectStoreError(() => openStore({ path: alias, clock: createTestClock(), auditKey: AUDIT_KEY }), 'ERR_STORE_ALREADY_OPEN');
  }
});

test('P1-1 目录别名（sub/../x.db）不能开出第二个写句柄', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'alias.db');
  const first = openStore({ path: filePath, clock: createTestClock(), auditKey: AUDIT_KEY });
  t.after(() => first.close());

  const alias = path.join(dir, 'nested', '..', 'alias.db');
  expectStoreError(() => openStore({ path: alias, clock: createTestClock(), auditKey: AUDIT_KEY }), 'ERR_STORE_ALREADY_OPEN');
  // 别名没有把第一个句柄挤掉。
  assert.equal(first.isClosed(), false);
});

test('P1-1 关闭句柄不会删除别人的锁（token 不匹配就不动）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'token.db');
  const first = openStore({ path: filePath, clock: createTestClock(), auditKey: AUDIT_KEY });
  const lockPath = writerLockPath(filePath);

  // 模拟"另一个活句柄接管了这把锁"：pid 相同、token 不同（同进程多句柄时正是这样）。
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, token: 'someone-else-token', file: filePath }),
    'utf8',
  );
  first.close();
  assert.equal(fs.existsSync(lockPath), true, 'token 不匹配时绝不能替对方解锁');
  fs.unlinkSync(lockPath);
});

test('P1-1 死 pid 的锁仍然可以被接管，并且锁被重写成本进程的新 token', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'stale.db');
  const seed = openStore({ path: filePath, clock: createTestClock(), auditKey: AUDIT_KEY });
  seed.close();
  const lockPath = writerLockPath(filePath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'dead-token', file: filePath }), 'utf8');

  const reopened = openStore({ path: filePath, clock: createTestClock(), auditKey: AUDIT_KEY });
  t.after(() => reopened.close());
  const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.equal(holder.token === 'dead-token', false, '接管后必须是新 token，而不是沿用死进程的');
});

/* ================================================================== */
/* P1-2：exec() 不能击穿事务原子性                                       */
/* ================================================================== */

test('P1-2 复核者探针：tx() 内 exec("COMMIT") 被拒，半条记录不会留下来', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => store.tx('half-commit', () => {
      store.setMeta('half', 'yes');
      store.exec('COMMIT');
    }),
    'ERR_TX_CONTROL',
  );
  assert.equal(store.getMeta('half'), null, '业务认为回滚了，库里就不该有痕迹');
  // 连接仍然可用。
  store.tx('after-reject', () => store.setMeta('after_reject', 'ok'));
  assert.equal(store.getMeta('after_reject'), 'ok');
});

test('P1-2 事务控制语句的各种写法都要挡（大小写 / 注释 / 多语句 / SAVEPOINT）', (t) => {
  const { store } = openTestStore(t);
  const probes = [
    'COMMIT',
    '  commit  ',
    '/* x */ COMMIT',
    '-- c\nROLLBACK',
    'BEGIN IMMEDIATE',
    'end transaction',
    'SAVEPOINT s1',
    'RELEASE s1',
    "INSERT INTO meta (key, value, updated_at) VALUES ('a','b','c'); COMMIT",
    'PRAGMA user_version = 1; COMMIT; PRAGMA user_version = 2',
  ];
  for (const sql of probes) {
    expectStoreError(() => store.exec(sql), 'ERR_TX_CONTROL');
  }
  // 正常语句与"事务关键字只出现在字符串/列名里"的语句不受影响。
  assert.deepEqual(findTransactionControl("INSERT INTO t (begin, commit) VALUES ('begin','commit')"), []);
  assert.deepEqual(findTransactionControl('SELECT 1'), []);
  store.exec("INSERT INTO sequence_counter (name, value) VALUES ('exec-ok', 1)");
  assert.equal(Number(store.get('SELECT value FROM sequence_counter WHERE name = ?', ['exec-ok']).value), 1);
});

test('P1-2 绕过 exec 用原生句柄提交时，tx() 报 ERR_TX_ESCAPED 而不是假装回滚', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(
    () => store.tx('escaped', () => {
      store.setMeta('escaped', 'yes');
      store.db.exec('COMMIT');
    }),
    'ERR_TX_ESCAPED',
  );
  // 事后连接仍然可用：不能因为一次逃逸让整个句柄报废。
  store.tx('after-escape', () => store.setMeta('after_escape', 'ok'));
  assert.equal(store.getMeta('after_escape'), 'ok');
});

/* ================================================================== */
/* P1-3：重投上限与 inbox 序号上限                                       */
/* ================================================================== */

test('P1-3 重投达到上限后转 manual_required、写审计、并拒绝继续重投', (t) => {
  const { store, clock } = openTestStore(t);
  // 上限必须是**有限且很小**的常量：如果它被调成 Infinity/500，
  // 下面"按常量循环"的断言会跟着一起放大，反而测不出"没有上限"。
  assert.ok(
    Number.isInteger(MAX_REDELIVER_ATTEMPTS) && MAX_REDELIVER_ATTEMPTS >= 2 && MAX_REDELIVER_ATTEMPTS <= 10,
    `重投上限必须是有限的小常量，实际 ${MAX_REDELIVER_ATTEMPTS}`,
  );
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });

  let last = null;
  for (let index = 0; index < MAX_REDELIVER_ATTEMPTS; index += 1) {
    clock.advance(6000);
    last = redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() });
  }
  assert.equal(last.attempts, MAX_REDELIVER_ATTEMPTS);

  clock.advance(6000);
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }),
    'ERR_REDELIVER_LIMIT',
  );

  const execution = getExecution(store, context.approved.execution_id);
  assert.equal(String(execution.state), 'manual_required');
  const actions = auditActions(store);
  assert.ok(actions.includes('execution.manual_required'), `超限必须留痕，实际：${actions.join(',')}`);
  // 转人工之后再调一次仍然是拒绝（不会又往下走一步）。
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }),
    'ERR_EXECUTION_STATE',
  );
});

test('P1-3 同一时刻连续重投被最小间隔拦住，attempts 不会暴涨', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });

  assert.equal(redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }).attempts, 1);
  assert.equal(redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }).attempts, 2);
  expectStoreError(
    () => redeliverExecution(store, { execution_id: context.approved.execution_id, now: clock.nowIso() }),
    'ERR_REDELIVER_TOO_SOON',
  );
  const outbox = store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(Number(outbox.attempts), 2);
});

test('P1-3 复核者探针：acceptExecution 传 seq=2..20 不再无限撑大 inbox', (t) => {
  const { store, clock } = openTestStore(t);
  assert.ok(
    Number.isInteger(MAX_ACCEPT_SEQ) && MAX_ACCEPT_SEQ >= 1 && MAX_ACCEPT_SEQ <= 32,
    `inbox seq 上限必须是有限的小常量，实际 ${MAX_ACCEPT_SEQ}`,
  );
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() });
  const base = {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: clock.nowIso(),
  };
  acceptExecution(store, { ...base, seq: 1 });

  for (let seq = 2; seq <= 20; seq += 1) {
    if (seq > MAX_ACCEPT_SEQ) {
      expectStoreError(() => acceptExecution(store, { ...base, seq }), 'ERR_INBOX_SEQ_OUT_OF_RANGE');
    } else {
      acceptExecution(store, { ...base, seq });
    }
  }
  const rows = Number(store.get('SELECT COUNT(*) AS c FROM execution_inbox').c);
  assert.equal(rows, MAX_ACCEPT_SEQ, `inbox 行数必须被 seq 上限夹住，实际 ${rows}`);
});

/* ================================================================== */
/* P2：三条零覆盖的负例                                                 */
/* ================================================================== */

test('P2 beginExecuting 拒绝错误 owner（旧 owner 不能接手别人的执行）', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: 60000,
    now: clock.nowIso(),
  });
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 4242, started_at: BASE_ISO },
    before_state: { running: true },
    after_state: { running: false },
    now: clock.nowIso(),
  });
  expectStoreError(
    () => beginExecuting(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-2',
      now: clock.nowIso(),
    }),
    'ERR_STALE_OWNER',
  );
  // 正确的 owner 仍然可以推进：拒绝的是"人不对"，不是"状态不允许"。
  const started = beginExecuting(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    now: clock.nowIso(),
  });
  assert.equal(started.state, 'executing');
});

test('P2 beginExecuting 拒绝已过期租约（租约到期只能核对，不能动手）', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildDispatchedExecution(store);
  acceptExecution(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    owner: 'helper-1',
    lease_ms: 1000,
    now: clock.nowIso(),
  });
  writeRecoveryManifest(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    object_identity: { pid: 4242, started_at: BASE_ISO },
    before_state: { running: true },
    after_state: { running: false },
    now: clock.nowIso(),
  });
  clock.advance(5000);
  expectStoreError(
    () => beginExecuting(store, {
      execution_id: context.approved.execution_id,
      attempt_id: context.approved.attempt_id,
      owner: 'helper-1',
      now: clock.nowIso(),
    }),
    'ERR_LEASE_EXPIRED',
  );
});

test('P2 审批 TTL 过期后 prepareDispatch 被拒', (t) => {
  const { store, clock } = openTestStore(t);
  const context = buildApprovedExecution(store);
  // buildApprovedExecution 给的审批 TTL 是 30 分钟，直接推过去。
  clock.advance(30 * 60 * 1000 + 1000);
  expectStoreError(
    () => prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: clock.nowIso() }),
    'ERR_APPROVAL_EXPIRED',
  );
});

test('P2 timestamp_ms 与 timestamp 不一致时校验必须失败', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  // 写入侧：列值必须等于解析值。
  for (const row of store.all('SELECT timestamp, timestamp_ms FROM audit_event')) {
    assert.equal(Number(row.timestamp_ms), Date.parse(String(row.timestamp)));
  }
  // 只改这一列（canonical_json / record_digest 都不动）：链自洽但事实被改。
  store.run('UPDATE audit_event SET timestamp_ms = timestamp_ms + 1 WHERE sequence = 2');
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

/* ------------------------------------------------------------------ */

/**
 * 手工写一条"旧二进制留下"的审计行（v3 库没有链头表，不能走 appendAudit）。
 *
 * @returns {string} 该行的 record_digest（作为下一行的 previous_digest）。
 */
function insertLegacyAuditRow(store, key, { sequence, previousDigest }) {
  const value = {
    schemaVersion: '1.0',
    sequence,
    timestamp: NOW,
    actor: { type: 'daemon', id: 'aegis-core' },
    action: 'telemetry.ingest',
    object_digest: sha256Hex(`legacy-${sequence}`),
    previous_digest: previousDigest,
    payload_digest: canonicalDigest({}),
    hmac: '',
  };
  value.hmac = hmacBase64(key, canonicalize({
    schemaVersion: value.schemaVersion,
    sequence: value.sequence,
    timestamp: value.timestamp,
    actor: value.actor,
    action: value.action,
    object_digest: value.object_digest,
    previous_digest: value.previous_digest,
    payload_digest: value.payload_digest,
  }));
  const digest = canonicalDigest(value);
  store.run(
    `INSERT INTO audit_event (
       sequence, timestamp, timestamp_ms, actor_type, actor_id, action,
       object_digest, previous_digest, payload_digest, hmac, record_digest, canonical_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      value.sequence,
      value.timestamp,
      Date.parse(value.timestamp),
      value.actor.type,
      value.actor.id,
      value.action,
      value.object_digest,
      value.previous_digest,
      value.payload_digest,
      value.hmac,
      digest,
      canonicalize(value),
    ],
  );
  return digest;
}

/*
 * 复核发现（V2-N1）：链头的**列**没有被它自己的签名覆盖。
 * HMAC 只覆盖 canonical_json，而读路径信任列；于是 `UPDATE audit_chain_head SET ...`
 * 可以回拨或清零锚点而 HMAC 仍然自洽，抹除会被洗成"全新空库"。
 * 下面三条锁住"列必须与签名文本一致"。
 */

test('P0-1 复核 N1：改 hmac_from_sequence 列不能缩小验签范围（曾返回 partial）', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  store.run('UPDATE audit_chain_head SET hmac_from_sequence = 999');

  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
});

test('P0-1 复核 N1：清空证据再把锚点列归零，不能洗成"全新空库"', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);
  ingestOne(store, 2);
  // 攻击者：删掉全部证据行，然后把锚点列"归零"，canonical_json 保持原样（伪造者通常不去碰它）。
  store.run('DELETE FROM audit_event');
  store.run("UPDATE audit_chain_head SET sequence = 0, digest = '0000000000000000000000000000000000000000000000000000000000000000'");

  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');
  // 也不能就此继续追加，把链从 1 重新长起来。
  expectStoreError(() => ingestOne(store, 3), 'ERR_DB_INTEGRITY');
});

test('P0-1 复核 N1：只改 digest 或 key_id 列同样失败关闭', (t) => {
  const { store } = openTestStore(t);
  ingestOne(store, 1);

  store.run(`UPDATE audit_chain_head SET digest = '${'a'.repeat(64)}'`);
  expectStoreError(() => verifyAuditChainInStore(store), 'ERR_DB_INTEGRITY');

  const { store: second } = openTestStore(t);
  ingestOne(second, 1);
  second.run('UPDATE audit_chain_head SET key_id = ?', ['deadbeefdeadbeefdeadbeefdeadbeef']);
  expectStoreError(() => verifyAuditChainInStore(second), 'ERR_DB_INTEGRITY');
});
