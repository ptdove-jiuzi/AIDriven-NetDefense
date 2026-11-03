// author: PT-dove
// 子进程：在"恶意但合法"的输入上执行 T1，然后在指定点自杀。
//
// 崩溃点是**真实调用存储层入口**，不是手工拼 SQL：
// - `precommit`：事务里写完事件与派生对象、还没提交就死 → 库里应一个字节都不留；
// - `postcommit`：T1 提交后立刻死 → 事件、审计、链头必须自洽，库必须完整。
//
// 自杀用 SIGKILL：不给任何清理机会，包括不执行 store.close()，于是写锁会残留，
// 由父进程验证"死 pid 的锁可以被接管"。

import { canonicalDigest, ingestTelemetry, openStore } from '../../../packages/event-store/src/index.js';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const storePath = arg('store');
const phase = arg('phase');
const now = arg('now') ?? '2026-11-01T00:00:00.000Z';
const payloadBytes = Number(arg('payload-bytes') ?? '0');

if (storePath === null || phase === null) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'missing arguments' })}\n`);
  process.exit(2);
}

/** 一个"很大但完全合法"的 payload：单字符串不超过 16384 字节，payload 总量不超过 16384。 */
function bigPayload() {
  if (payloadBytes <= 0) {
    return { process_name: 'example.exe', pid: 4242 };
  }
  // payload 的总字节上限是 16384（与单字符串上限同值），所以"大"只能大到这个边界。
  const size = Math.min(payloadBytes, 15_000);
  return { chunk_0: 'A'.repeat(size), pid: 4242 };
}

const payload = bigPayload();
const event = {
  schemaVersion: '1.0',
  event_id: '11111111-1111-4111-8111-111111111111',
  stable_source_id: 'proc.win',
  collector_instance_id: '22222222-2222-4222-8222-222222222222',
  source_generation: 0,
  boot_id: '0123456789abcdef0123456789abcdef',
  source_seq: 1,
  observed_at: '2026-11-01T00:00:00Z',
  received_at: '2026-11-01T00:00:00.500Z',
  type: 'process.created',
  severity: 'medium',
  payload,
  integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
};

const clock = { nowIso: () => now, nowMs: () => Date.parse(now) };
const store = openStore({ path: storePath, clock, auditKey: 'm9-corpus-audit-key' });

function die(marker) {
  process.stdout.write(`${JSON.stringify({ marker })}\n`);
  process.kill(process.pid, 'SIGKILL');
}

if (phase === 'precommit') {
  // 用原生句柄开一个未提交事务：崩溃点要验证的正是"未提交事务一个字节都不留"。
  store.db.exec('BEGIN IMMEDIATE');
  store.run('INSERT INTO sequence_counter (name, value) VALUES (?, ?)', ['half-written', 1]);
  die('precommit');
} else if (phase === 'postcommit') {
  const result = ingestTelemetry(store, { event, now });
  process.stdout.write(`${JSON.stringify({ ok: true, ingest_seq: result.ingest_seq })}\n`);
  die('postcommit');
} else {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `unknown phase ${phase}` })}\n`);
  process.exit(2);
}
