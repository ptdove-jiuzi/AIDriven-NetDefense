/**
 * 子进程：在指定崩溃点自杀，用来验证"崩溃后库里到底还剩什么"。
 *
 * 崩溃点是**真实调用**存储层入口，而不是手工拼 SQL 模拟：
 * - `precommit`：开着事务写了一半就死，验证未提交事务不留痕；
 * - `postcommit-t1`：T1 提交后立刻死，验证 WAL 重放；
 * - `postcommit-t3b`：T3b 提交后立刻死，验证"审批已消费 / outbox 未投递"的一致性。
 *
 * 自杀用 `process.kill(pid, 'SIGKILL')`：不给任何清理机会，
 * 包括不执行 `store.close()`（因此锁文件会残留，交给父进程验证接管）。
 */

import { ingestTelemetry, openStore, prepareDispatch } from '../../../packages/event-store/src/index.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const storePath = arg('store');
const phase = arg('phase');
const now = arg('now');
const eventJson = arg('event');
const approvalId = arg('approval');
const auditKey = arg('key') ?? 'test-audit-key-0123456789abcdef';

if (storePath === null || phase === null) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'missing arguments' }));
  process.exit(2);
}

const clock = { nowIso: () => now, nowMs: () => Date.parse(now) };
const store = openStore({ path: storePath, clock, auditKey });

function die(marker) {
  process.stdout.write(`${JSON.stringify({ marker })}\n`);
  process.kill(process.pid, 'SIGKILL');
}

if (phase === 'precommit') {
  // `store.exec()` 现在拒绝事务控制语句（P1-2），这里刻意用原生句柄手工开一个
  // **未提交**事务：崩溃点要验证的正是"未提交事务一个字节都不留"。
  store.db.exec('BEGIN IMMEDIATE');
  store.run('INSERT INTO sequence_counter (name, value) VALUES (?, ?)', ['half-written', 1]);
  die('precommit');
} else if (phase === 'postcommit-t1') {
  ingestTelemetry(store, { event: JSON.parse(eventJson), now });
  die('postcommit-t1');
} else if (phase === 'postcommit-t3b') {
  prepareDispatch(store, { approval_id: approvalId, now });
  die('postcommit-t3b');
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: `unknown phase ${phase}` }));
  process.exit(2);
}
