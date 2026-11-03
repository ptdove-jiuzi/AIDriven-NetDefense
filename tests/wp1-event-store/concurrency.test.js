/**
 * 并发与单写者。
 *
 * "并发"在这里有两种形态，分别测：
 * 1. **同进程交错**：单写者是同步 API，真正的竞态表现为"两个入口抢同一个状态"，
 *    所以用例交错调用而不是包一层 Promise.all（那只是测调度器）。
 * 2. **跨进程**：写锁文件 + pid 存活探测，第二个进程必须被拒绝。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  claimAnalysis,
  ingestTelemetry,
  markExecutionDispatched,
  markModelRequestSent,
  prepareDispatch,
  reserveModelRequest,
  settleModelRequest,
} from '../../packages/event-store/src/index.js';

import {
  buildApprovedExecution,
  expectStoreError,
  makeAlert,
  makeAnalysisRequest,
  makeEvent,
  openStore,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const WINDOW = {
  window_start: '2026-11-01T00:00:00.000Z',
  window_end: '2026-11-01T00:15:00.000Z',
};

function seedAnalysis(store, clock) {
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`cc-${uuid()}`) });
  const analysis = makeAnalysisRequest({ alert_id: alert.alert_id, epoch: store.epoch(), created_at: now });
  ingestTelemetry(store, {
    event: makeEvent({ observed_at: now, received_at: now, native_record_id: `n-${analysis.analysis_id}` }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  return analysis.analysis_id;
}

test('两个消费者抢同一条分析：只有一个成功', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);

  const first = claimAnalysis(store, { analysis_id: analysisId, owner: 'broker-a', now: clock.nowIso() });
  const second = (() => {
    try {
      claimAnalysis(store, { analysis_id: analysisId, owner: 'broker-b', now: clock.nowIso() });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(first.attempt_id);
  assert.equal(second.code, 'ERR_ANALYSIS_STATE');
  const row = store.get('SELECT owner FROM analysis_outbox WHERE analysis_id = ?', [analysisId]);
  assert.equal(String(row.owner), 'broker-a');
});

test('同一 request_id 重复预占被唯一约束拦住（不会双计账）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const requestId = uuid();
  const first = reserveModelRequest(store, {
    analysis_id: analysisId,
    request_id: requestId,
    serialized_digest: sha256Hex('dup'),
    input_upper: 100,
    output_limit: 10,
    now: clock.nowIso(),
  });
  assert.equal(first.request_seq, 1);
  expectStoreError(
    () => reserveModelRequest(store, {
      analysis_id: analysisId,
      request_id: requestId,
      serialized_digest: sha256Hex('dup'),
      input_upper: 100,
      output_limit: 10,
      now: clock.nowIso(),
    }),
    'ERR_STORE_CONSTRAINT',
  );
  assert.equal(Number(store.get('SELECT COUNT(*) AS c FROM model_request_ledger').c), 1);
});

test('同一分析连续预占拿到的 request_seq 严格递增且不重复', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const seqs = [];
  for (let index = 0; index < 3; index += 1) {
    seqs.push(reserveModelRequest(store, {
      analysis_id: analysisId,
      serialized_digest: sha256Hex(`s-${index}`),
      input_upper: 100,
      output_limit: 10,
      now: clock.nowIso(),
    }).request_seq);
  }
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(new Set(seqs).size, 3);
});

test('结算与预占交错：结算后的实际用量立即影响下一次准入', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const policy = { perAnalysisInputTokens: 1000, perAnalysisOutputTokens: 100, perAnalysisRequests: 3, dailyInputTokens: 5000, dailyOutputTokens: 1000 };
  const first = reserveModelRequest(store, {
    analysis_id: analysisId,
    serialized_digest: sha256Hex('interleave-1'),
    input_upper: 800,
    output_limit: 50,
    now: clock.nowIso(),
    policy,
  });
  markModelRequestSent(store, { request_id: first.request_id, now: clock.nowIso() });
  settleModelRequest(store, {
    request_id: first.request_id,
    usage: { input_tokens: 100, output_tokens: 10 },
    now: clock.nowIso(),
  });
  const second = reserveModelRequest(store, {
    analysis_id: analysisId,
    serialized_digest: sha256Hex('interleave-2'),
    input_upper: 800,
    output_limit: 50,
    now: clock.nowIso(),
    policy,
  });
  assert.equal(second.request_seq, 2);
  // 100(已结算) + 800(在途) + 800(新) = 1700 > 1000
  expectStoreError(
    () => reserveModelRequest(store, {
      analysis_id: analysisId,
      serialized_digest: sha256Hex('interleave-3'),
      input_upper: 800,
      output_limit: 50,
      now: clock.nowIso(),
      policy,
    }),
    'ERR_BUDGET_EXCEEDED',
  );
});

test('outbox 双标记只有第一次真正推进', (t) => {
  const { store } = openTestStore(t);
  const context = buildApprovedExecution(store);
  prepareDispatch(store, { approval_id: context.approvalValue.approval_id, now: store.clock.nowIso() });
  const first = markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  const second = markExecutionDispatched(store, {
    execution_id: context.approved.execution_id,
    attempt_id: context.approved.attempt_id,
    now: store.clock.nowIso(),
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const outbox = store.get('SELECT attempts FROM execution_outbox WHERE execution_id = ?', [context.approved.execution_id]);
  assert.equal(Number(outbox.attempts), 1);
});

test('同一进程内第二个写句柄被拒绝', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  expectStoreError(() => openStore({ path: filePath }), 'ERR_STORE_ALREADY_OPEN');
  assert.equal(store.isClosed(), false);
});

test('跨进程：写锁被存活进程持有时第二个进程拿到 ERR_STORE_LOCKED', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  const result = spawnSync(process.execPath, [path.join(FIXTURES, 'lock-contender.mjs'), filePath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `contender failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'ERR_STORE_LOCKED');
  assert.ok(store.isClosed() === false);
});

test('跨进程：写连接关闭后另一个进程可以接管', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.close();
  const result = spawnSync(process.execPath, [path.join(FIXTURES, 'lock-contender.mjs'), filePath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `contender failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true);
});

test('只读连接可以与写连接共存（读不参与写锁）', (t) => {
  const { store, dir } = openTestStore(t);
  const filePath = path.join(dir, 'aegis-harness.db');
  store.run('INSERT INTO sequence_counter (name, value) VALUES (?, ?)', ['peek', 5]);
  const reader = openStore({ path: filePath, readOnly: true });
  t.after(() => reader.close());
  assert.equal(Number(reader.get('SELECT value FROM sequence_counter WHERE name = ?', ['peek']).value), 5);
  assert.equal(store.isClosed(), false);
});

test('事务不可嵌套，且失败后外层连接仍可用', (t) => {
  const { store } = openTestStore(t);
  expectStoreError(() => store.tx('outer', () => store.tx('inner', () => 0)), 'ERR_TX_NESTED');
  store.tx('still-ok', () => store.setMeta('after_nested', 'yes'));
  assert.equal(store.getMeta('after_nested'), 'yes');
});
