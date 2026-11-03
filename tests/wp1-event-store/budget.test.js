/**
 * T2 预算预扣与账本。
 *
 * 这一组用例围绕一句话：**余额公式必须把"在途上界"算进去，且跨 epoch 不清零**。
 * 只要有一条用例能接受"reserved 不占额度"或"轮换 epoch 就把未知债务抹掉"，
 * 预算就是可绕过的。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ingestTelemetry,
  listRequests,
  markModelRequestSent,
  markModelRequestUnknown,
  reserveModelRequest,
  rotateEpoch,
  settleModelRequest,
  settleUnknownAtUpperBound,
  summarizeBudget,
  voidModelRequest,
} from '../../packages/event-store/src/index.js';

import {
  expectStoreError,
  makeAlert,
  makeAnalysisRequest,
  makeEvent,
  openTestStore,
  sha256Hex,
  uuid,
} from './helpers.js';

const SMALL_POLICY = Object.freeze({
  perAnalysisInputTokens: 4000,
  perAnalysisOutputTokens: 1000,
  perAnalysisRequests: 3,
  dailyInputTokens: 5000,
  dailyOutputTokens: 2000,
});

const WINDOW = {
  window_start: '2026-11-01T00:00:00.000Z',
  window_end: '2026-11-01T00:15:00.000Z',
};

function seedAnalysis(store, clock, overrides = {}) {
  const now = clock.nowIso();
  const alert = makeAlert({ ...WINDOW, fingerprint: sha256Hex(`fp-${uuid()}`) });
  const analysis = makeAnalysisRequest({
    alert_id: alert.alert_id,
    epoch: store.epoch(),
    created_at: now,
    ...overrides,
  });
  ingestTelemetry(store, {
    event: makeEvent({ native_record_id: `n-${analysis.analysis_id}`, observed_at: now, received_at: now }),
    alerts: [alert],
    analysisRequest: analysis,
    allowedSummaryFields: ['process_name'],
    now,
  });
  return analysis.analysis_id;
}

function reserve(store, clock, analysisId, overrides = {}) {
  return reserveModelRequest(store, {
    analysis_id: analysisId,
    serialized_digest: sha256Hex(`req-${uuid()}`),
    input_upper: 1000,
    output_limit: 100,
    now: clock.nowIso(),
    policy: SMALL_POLICY,
    ...overrides,
  });
}

test('首次预占写入 reserved 行，request_seq 从 1 开始', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId);

  assert.equal(reserved.state, 'reserved');
  assert.equal(reserved.request_seq, 1);
  assert.equal(reserved.epoch, store.epoch());
  assert.equal(reserved.utc_day, '2026-11-01');
  const row = store.get('SELECT * FROM model_request_ledger WHERE request_id = ?', [reserved.request_id]);
  assert.equal(String(row.state), 'reserved');
  assert.equal(Number(row.input_upper), 1000);
  assert.equal(row.settled_input, null);
});

test('同一分析的 request_seq 递增，超过 3 次被拒', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const seqs = [
    reserve(store, clock, analysisId).request_seq,
    reserve(store, clock, analysisId).request_seq,
    reserve(store, clock, analysisId).request_seq,
  ];
  assert.deepEqual(seqs, [1, 2, 3]);
  const error = expectStoreError(() => reserve(store, clock, analysisId), 'ERR_BUDGET_EXCEEDED');
  assert.equal(error.details.limit, 3);
});

test('单分析输入上限：默认 12000，超出即拒绝（任何请求发出之前）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const error = expectStoreError(
    () => reserveModelRequest(store, {
      analysis_id: analysisId,
      serialized_digest: sha256Hex('too-big'),
      input_upper: 12001,
      output_limit: 100,
      now: clock.nowIso(),
    }),
    'ERR_BUDGET_EXCEEDED',
  );
  assert.equal(error.details.limit, 12000);
  assert.equal(listRequests(store, { analysis_id: analysisId }).length, 0);
});

test('在途预留占用每日额度：第二个分析不能超额准入', (t) => {
  const { store, clock } = openTestStore(t);
  const first = seedAnalysis(store, clock);
  const second = seedAnalysis(store, clock);
  reserve(store, clock, first, { input_upper: 3000, output_limit: 500 });
  const error = expectStoreError(
    () => reserve(store, clock, second, { input_upper: 3000, output_limit: 500 }),
    'ERR_BUDGET_EXCEEDED',
  );
  assert.equal(error.details.limit, 5000);
  assert.equal(error.details.inflight, 3000);
});

test('结算后按实际 usage 释放余额（不是按上界永久占用）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId, { input_upper: 3000, output_limit: 500 });
  markModelRequestSent(store, { request_id: reserved.request_id, now: clock.nowIso() });
  settleModelRequest(store, {
    request_id: reserved.request_id,
    usage: { input_tokens: 100, output_tokens: 20 },
    now: clock.nowIso(),
  });
  const budget = summarizeBudget(store, { now: clock.nowIso(), policy: SMALL_POLICY });
  assert.equal(budget.daily.settled_input, 100);
  assert.equal(budget.daily.inflight_input, 0);
  assert.equal(budget.daily.remaining_input, 4900);
});

test('输出上限同样在准入时校验', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const error = expectStoreError(
    () => reserve(store, clock, analysisId, { input_upper: 100, output_limit: 1001 }),
    'ERR_BUDGET_EXCEEDED',
  );
  assert.equal(error.details.limit, 1000);
});

test('sent 是幂等的，重复发送不会重复计账', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId);
  const first = markModelRequestSent(store, { request_id: reserved.request_id, now: clock.nowIso() });
  const second = markModelRequestSent(store, { request_id: reserved.request_id, now: clock.nowIso() });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.state, 'sent');
});

test('unknown 的请求禁止再次发送（未证明未执行 → 不自动重试）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId);
  markModelRequestSent(store, { request_id: reserved.request_id, now: clock.nowIso() });
  markModelRequestUnknown(store, { request_id: reserved.request_id, reason: 'provider_timeout', now: clock.nowIso() });
  expectStoreError(
    () => markModelRequestSent(store, { request_id: reserved.request_id, now: clock.nowIso() }),
    'ERR_RETRY_NOT_PROVEN',
  );
  const row = store.get('SELECT state FROM model_request_ledger WHERE request_id = ?', [reserved.request_id]);
  assert.equal(String(row.state), 'unknown');
});

test('作废需要显式证明未发送，且只能作废 reserved', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId);

  expectStoreError(
    () => voidModelRequest(store, { request_id: reserved.request_id, now: clock.nowIso() }),
    'ERR_RETRY_NOT_PROVEN',
  );
  const voided = voidModelRequest(store, {
    request_id: reserved.request_id,
    provedNotSent: true,
    now: clock.nowIso(),
  });
  assert.equal(voided.state, 'void');

  // 已 void 的行不能再结算；也不能把已发出的请求作废。
  expectStoreError(
    () => settleModelRequest(store, {
      request_id: reserved.request_id,
      usage: { input_tokens: 1, output_tokens: 1 },
      now: clock.nowIso(),
    }),
    'ERR_REQUEST_STATE',
  );
  const second = reserve(store, clock, analysisId);
  markModelRequestSent(store, { request_id: second.request_id, now: clock.nowIso() });
  expectStoreError(
    () => voidModelRequest(store, { request_id: second.request_id, provedNotSent: true, now: clock.nowIso() }),
    'ERR_RETRY_NOT_PROVEN',
  );
});

test('未知请求按上界结算，而不是释放额度', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId, { input_upper: 2000, output_limit: 300 });
  markModelRequestUnknown(store, { request_id: reserved.request_id, now: clock.nowIso() });
  const settled = settleUnknownAtUpperBound(store, { request_id: reserved.request_id, now: clock.nowIso() });
  assert.deepEqual({ ...settled.usage }, { input_tokens: 2000, output_tokens: 300 });
  const budget = summarizeBudget(store, { now: clock.nowIso(), policy: SMALL_POLICY });
  assert.equal(budget.daily.settled_input, 2000);
});

test('从未发送的预占不允许直接结算（等于无证明释放额度）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId);
  const error = expectStoreError(
    () => settleModelRequest(store, {
      request_id: reserved.request_id,
      usage: { input_tokens: 0, output_tokens: 0 },
      now: clock.nowIso(),
    }),
    'ERR_REQUEST_STATE',
  );
  assert.equal(error.details.state, 'reserved');
  // 额度没有被释放：仍在途。
  const budget = summarizeBudget(store, { now: clock.nowIso(), policy: SMALL_POLICY });
  assert.equal(budget.daily.inflight_input, 1000);
});

test('已发送的请求结算必须带 usage', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId);
  markModelRequestSent(store, { request_id: reserved.request_id, now: clock.nowIso() });
  expectStoreError(
    () => settleModelRequest(store, { request_id: reserved.request_id, now: clock.nowIso() }),
    'ERR_STORE_INPUT',
  );
});

test('unknown 请求低于上界结算必须提供提供方证据', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId, { input_upper: 1000, output_limit: 200 });
  markModelRequestUnknown(store, { request_id: reserved.request_id, now: clock.nowIso() });
  expectStoreError(
    () => settleModelRequest(store, {
      request_id: reserved.request_id,
      usage: { input_tokens: 10, output_tokens: 1 },
      now: clock.nowIso(),
    }),
    'ERR_REQUEST_STATE',
  );
  // 提供方证据存在时才允许按实际值结清。
  const settled = settleModelRequest(store, {
    request_id: reserved.request_id,
    usage: { input_tokens: 10, output_tokens: 1 },
    providerEvidence: 'provider-usage-export:2026-11-01:req-1',
    now: clock.nowIso(),
  });
  assert.deepEqual({ ...settled.usage }, { input_tokens: 10, output_tokens: 1 });
});

test('时间回拨：当前 UTC 早于持久高水位时禁止新请求', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  // 让 wall 与 mono 一起走到 00:10（正常的时间流逝），再回拨 1 分钟。
  clock.advance(10 * 60 * 1000);
  reserve(store, clock, analysisId, { now: clock.nowIso() });
  const error = expectStoreError(
    () => reserve(store, clock, analysisId, { now: '2026-11-01T00:09:00.000Z' }),
    'ERR_BUDGET_TIME_UNTRUSTED',
  );
  assert.equal(error.details.last_trusted_utc, clock.nowIso());
});

test('UTC 日桶回退时禁止新请求', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  store.setMeta('last_utc_day', '2026-11-03');
  expectStoreError(
    () => reserve(store, clock, analysisId, { now: '2026-11-02T00:00:00.000Z' }),
    'ERR_BUDGET_TIME_UNTRUSTED',
  );
});

test('time_uncertain 标记后禁止新请求', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  store.setMeta('time_uncertain', '1');
  expectStoreError(() => reserve(store, clock, analysisId), 'ERR_BUDGET_TIME_UNTRUSTED');
});

test('正常的跨日推进允许，并切换到新日桶', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  // 单分析预算是跨日的总额（4000），跨日只重置"每日"那一桶，不重置分析额度。
  reserve(store, clock, analysisId, { input_upper: 2000, output_limit: 400 });
  clock.advance(24 * 60 * 60 * 1000);
  const next = reserve(store, clock, analysisId, {
    input_upper: 1000,
    output_limit: 100,
    now: clock.nowIso(),
  });
  assert.equal(next.utc_day, '2026-11-02');
  const budget = summarizeBudget(store, { now: '2026-11-02T00:00:02.000Z', policy: SMALL_POLICY });
  assert.equal(budget.daily.inflight_input, 1000, 'new UTC day starts from zero');
});

test('epoch 轮换把 reserved/sent 原子转 unknown，债务仍计入当日', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  const reserved = reserve(store, clock, analysisId, { input_upper: 2000, output_limit: 400 });
  const sent = reserve(store, clock, analysisId, { input_upper: 1000, output_limit: 200 });
  markModelRequestSent(store, { request_id: sent.request_id, now: clock.nowIso() });

  const rotated = rotateEpoch(store, { now: clock.nowIso() });
  assert.equal(rotated.demoted_to_unknown, 2);
  assert.notEqual(rotated.epoch, rotated.previous);

  const states = listRequests(store, { analysis_id: analysisId }).map((row) => String(row.state));
  assert.deepEqual(states.sort(), ['unknown', 'unknown']);

  const budget = summarizeBudget(store, { now: clock.nowIso(), policy: SMALL_POLICY });
  assert.equal(budget.daily.inflight_input, 3000, 'unknown debt must survive the epoch switch');
  assert.ok(budget.by_epoch.every((entry) => entry.state === 'unknown'));
  // 旧的 reserved 行仍然存在，没有被删除或清零。
  assert.ok(store.get('SELECT request_id FROM model_request_ledger WHERE request_id = ?', [reserved.request_id]));
});

test('轮换后旧分析被 epoch 隔离，新分析仍受旧 unknown 债务约束', (t) => {
  const { store, clock } = openTestStore(t);
  const staleAnalysis = seedAnalysis(store, clock);
  // 每日额度压到 2500：轮换后旧的上界债务仍然把新请求挤出去。
  const policy = { ...SMALL_POLICY, dailyInputTokens: 2500 };
  reserve(store, clock, staleAnalysis, { input_upper: 2000, output_limit: 100, policy });
  rotateEpoch(store, { now: clock.nowIso() });

  // 旧 epoch 的分析不能再消耗预算（恢复后旧队列失效）。
  expectStoreError(
    () => reserve(store, clock, staleAnalysis, { input_upper: 100, output_limit: 100, policy }),
    'ERR_EPOCH_MISMATCH',
  );

  const freshAnalysis = seedAnalysis(store, clock);
  const after = reserve(store, clock, freshAnalysis, { input_upper: 100, output_limit: 100, policy });
  assert.equal(after.epoch, store.epoch());
  assert.notEqual(after.epoch, '');
  const error = expectStoreError(
    () => reserve(store, clock, freshAnalysis, { input_upper: 1000, output_limit: 100, policy }),
    'ERR_BUDGET_EXCEEDED',
  );
  assert.equal(error.details.inflight, 2100);
});

test('未知分析无法预占预算', (t) => {
  const { store, clock } = openTestStore(t);
  expectStoreError(
    () => reserve(store, clock, uuid()),
    'ERR_ANALYSIS_NOT_FOUND',
  );
});

test('非法的输入上界在入口被拒（不做四舍五入）', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  expectStoreError(() => reserve(store, clock, analysisId, { input_upper: 0 }), 'ERR_STORE_INPUT');
  expectStoreError(() => reserve(store, clock, analysisId, { input_upper: 1.5 }), 'ERR_STORE_INPUT');
  expectStoreError(() => reserve(store, clock, analysisId, { output_limit: -1 }), 'ERR_STORE_INPUT');
});

test('账本视图按 epoch 分组统计在途债务', (t) => {
  const { store, clock } = openTestStore(t);
  const first = reserve(store, clock, seedAnalysis(store, clock), { input_upper: 1000, output_limit: 100 });
  rotateEpoch(store, { now: clock.nowIso() });
  const second = reserve(store, clock, seedAnalysis(store, clock), { input_upper: 500, output_limit: 50 });
  const budget = summarizeBudget(store, { now: clock.nowIso(), policy: SMALL_POLICY });
  const epochs = budget.by_epoch.map((entry) => entry.epoch);
  assert.equal(new Set(epochs).size, 2, 'both epochs must remain visible');
  assert.ok(budget.by_epoch.some((entry) => entry.input_upper === 1000));
  assert.ok(budget.by_epoch.some((entry) => entry.input_upper === 500));
  assert.notEqual(first.epoch, second.epoch);
});

test('休眠唤醒（wall 前进、mono 未动）时拒绝新请求', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  // 不传 now → 走 store 自己的时钟，才会比对 wall/mono 一致性。
  reserveModelRequest(store, {
    analysis_id: analysisId,
    serialized_digest: sha256Hex('mono-1'),
    input_upper: 100,
    output_limit: 10,
    policy: SMALL_POLICY,
  });
  clock.advanceWallOnly(10 * 60 * 1000);
  const error = expectStoreError(
    () => reserveModelRequest(store, {
      analysis_id: analysisId,
      serialized_digest: sha256Hex('mono-2'),
      input_upper: 100,
      output_limit: 10,
      policy: SMALL_POLICY,
    }),
    'ERR_BUDGET_TIME_UNTRUSTED',
  );
  assert.match(error.message, /monotonic/iu);
});

test('单调时钟正常前进时不误报', (t) => {
  const { store, clock } = openTestStore(t);
  const analysisId = seedAnalysis(store, clock);
  for (let index = 0; index < 3; index += 1) {
    reserveModelRequest(store, {
      analysis_id: analysisId,
      serialized_digest: sha256Hex(`mono-ok-${index}`),
      input_upper: 100,
      output_limit: 10,
      policy: SMALL_POLICY,
    });
    clock.advance(30000);
  }
  const budget = summarizeBudget(store, { now: clock.nowIso(), policy: SMALL_POLICY });
  assert.equal(budget.daily.inflight_input, 300);
});
