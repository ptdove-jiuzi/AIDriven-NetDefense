/**
 * 崩溃点测试（AT-STORE-002 / AT-RESP-003 的可执行子集）。
 *
 * 真的用子进程 + SIGKILL，而不是"抛个异常假装崩溃"：
 * 只有真的杀进程，才能验证 WAL 重放、未提交事务不留痕、写锁残留可接管。
 *
 * 三个崩溃点分别对应：
 * - 事务提交前 → 应该**什么都没留下**；
 * - T1 提交后立刻死 → 数据在，审计链自洽，库完整；
 * - T3b 提交后立刻死 → 审批已消费 / execution=dispatch_pending / outbox=pending 三者一致。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  countEvents,
  getApproval,
  getExecution,
  getExecutionOutbox,
  openStore,
  verifyAuditChainInStore,
} from '../../packages/event-store/src/index.js';

import {
  BASE_ISO,
  buildApprovedExecution,
  makeEvent,
  makeTempDir,
  openTestStore,
  writerLockPath,
} from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const AUDIT_KEY = 'test-audit-key-0123456789abcdef';

function runCrash(args) {
  return spawnSync(process.execPath, [path.join(FIXTURES, 'crash-writer.mjs'), ...args], {
    encoding: 'utf8',
  });
}

/**
 * 判定"子进程在指定崩溃点被强杀"。
 *
 * 只断言"退出码非 0"是不够的：子进程自己抛异常也是非 0。Windows 上
 * `process.kill(pid,'SIGKILL')` 被 libuv 映射成 TerminateProcess，
 * spawnSync 报 `status=1 / signal=null`，拿不到真实信号名（实测过）。
 * 因此用三个条件共同判定：
 * 1. 崩溃点标记已打印（说明确实走到了那一步，不是启动就挂了）；
 * 2. stderr 为空（没有未捕获异常）；
 * 3. 没有干净退出（status !== 0）。
 */
function assertKilled(result, marker) {
  assert.equal(result.stderr, '', `child crashed with an exception: ${result.stderr}`);
  assert.match(result.stdout, new RegExp(marker, 'u'), `child never reached ${marker}`);
  assert.notEqual(result.status, 0, 'child must not exit cleanly');
  assert.ok(result.signal === null || result.signal === 'SIGKILL', `unexpected signal ${result.signal}`);
}

test('提交前强杀：未提交事务一个字节都不留', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'precommit.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  const result = runCrash(['--store', filePath, '--phase', 'precommit', '--now', BASE_ISO]);
  assertKilled(result, 'precommit');

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  t.after(() => reopened.close());
  assert.equal(reopened.get('SELECT name FROM sequence_counter WHERE name = ?', ['half-written']), null);
  assert.equal(reopened.integrityCheck({ full: true }).ok, true);
});

test('T1 提交后强杀：WAL 重放后数据完整可读', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'postcommit-t1.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  const event = makeEvent({ native_record_id: 'crash-1' });
  const result = runCrash([
    '--store', filePath,
    '--phase', 'postcommit-t1',
    '--event', JSON.stringify(event),
    '--key', AUDIT_KEY,
    '--now', BASE_ISO,
  ]);
  assertKilled(result, 'postcommit-t1');

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  t.after(() => reopened.close());
  assert.equal(countEvents(reopened), 1);
  assert.equal(Number(reopened.get('SELECT COUNT(*) AS c FROM audit_event').c), 1);
  const chain = verifyAuditChainInStore(reopened);
  assert.equal(chain.ok, true);
  assert.equal(chain.hmacVerified, true);
  assert.equal(reopened.integrityCheck({ full: true }).ok, true);
});

test('T3b 提交后强杀：审批/执行/outbox 三者状态一致，不会出现"半投递"', (t) => {
  const { store, dir } = openTestStore(t);
  const context = buildApprovedExecution(store);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.close();

  const result = runCrash([
    '--store', filePath,
    '--phase', 'postcommit-t3b',
    '--approval', context.approvalValue.approval_id,
    '--key', AUDIT_KEY,
    '--now', context.now,
  ]);
  assertKilled(result, 'postcommit-t3b');

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  t.after(() => reopened.close());

  const approval = getApproval(reopened, context.approvalValue.approval_id);
  assert.equal(String(approval.state), 'consumed');
  const execution = getExecution(reopened, context.approved.execution_id);
  assert.equal(String(execution.state), 'dispatch_pending');
  assert.ok(String(execution.grant_digest).length === 64);
  const outbox = getExecutionOutbox(reopened, context.approved.execution_id);
  assert.equal(outbox.length, 1);
  assert.equal(String(outbox[0].state), 'pending');
  assert.equal(Number(outbox[0].attempts), 0);

  // execution 与 grant 必须匹配：否则重投会送出与状态不一致的授权。
  assert.equal(String(execution.grant_digest), String(outbox[0].grant_digest));
  const chain = verifyAuditChainInStore(reopened);
  assert.equal(chain.ok, true);
  assert.equal(chain.hmacVerified, true);
});

test('强杀留下的写锁可以在重启时被接管', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'stale-lock.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  const result = runCrash(['--store', filePath, '--phase', 'precommit', '--now', BASE_ISO]);
  assertKilled(result, 'precommit');

  const lockPath = writerLockPath(filePath);
  assert.ok(fs.existsSync(lockPath), 'crashed process leaves its lock behind');
  const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.notEqual(holder.pid, process.pid);

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  t.after(() => reopened.close());
  const newHolder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(newHolder.pid, process.pid);
});

test('崩溃后 WAL 文件存在，正常关闭时被截断', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'wal.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  const event = makeEvent({ native_record_id: 'wal-1' });
  const result = runCrash([
    '--store', filePath,
    '--phase', 'postcommit-t1',
    '--event', JSON.stringify(event),
    '--key', AUDIT_KEY,
    '--now', BASE_ISO,
  ]);
  assertKilled(result, 'postcommit-t1');
  assert.ok(fs.existsSync(`${filePath}-wal`), 'WAL must exist after an unclean exit');

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  assert.equal(countEvents(reopened), 1);
  reopened.close();
  const walSize = fs.existsSync(`${filePath}-wal`) ? fs.statSync(`${filePath}-wal`).size : 0;
  assert.ok(walSize <= 4096, `checkpoint on close should truncate WAL, got ${walSize}`);
});

test('重复崩溃点不会产生重复审计（每次崩溃只留下已提交的那一条）', (t) => {
  const dir = makeTempDir(t);
  const filePath = path.join(dir, 'repeat.db');
  const initial = openStore({ path: filePath, auditKey: AUDIT_KEY });
  initial.close();

  for (let index = 0; index < 3; index += 1) {
    const event = makeEvent({ native_record_id: `repeat-${index}` });
    const result = runCrash([
      '--store', filePath,
      '--phase', 'postcommit-t1',
      '--event', JSON.stringify(event),
      '--key', AUDIT_KEY,
      '--now', BASE_ISO,
    ]);
    assertKilled(result, 'postcommit-t1');
  }

  const reopened = openStore({ path: filePath, auditKey: AUDIT_KEY });
  t.after(() => reopened.close());
  assert.equal(countEvents(reopened), 3);
  assert.equal(Number(reopened.get('SELECT COUNT(*) AS c FROM audit_event').c), 3);
  const chain = verifyAuditChainInStore(reopened);
  assert.equal(chain.ok, true);
  assert.equal(chain.hmacVerified, true);
});
