/**
 * 准入与预扣（AT-TOKEN-001 / AT-STORE-001 的 broker 侧）。
 *
 * 这一组用例只想证明一件事：**准入结论唯一来自 reserve 那一次原子事务**。
 * - 余额不够不发请求；
 * - 并发争抢最后额度不超额；
 * - preview 读数被伪造也不影响结论（它只用来定 output_limit 尺寸）；
 * - 队列满就明确拒绝，不无限堆。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BROKER_CODES } from '../../apps/model-broker/src/errors.js';
import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { uuid } from '../../apps/model-broker/src/util.js';
import {
  createHarness,
  destroyHandler,
  expectBrokerErrorAsync,
  inputUpperOf,
  ledgerRows,
  makeIntent,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
} from './helpers.js';

test('成功路径：先预扣、再发送、按提供方 usage 结算', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler({ usage: { input_tokens: 12, output_tokens: 5 } }));
  const { analysis_id: analysisId, attempt_id: attemptId } = seedAnalysis(store);
  const intent = makeIntent(analysisId, { attempt_id: attemptId });
  const harness = createHarness(t, { store, provider });

  const result = await harness.broker.request(intent);

  assert.equal(result.state, 'settled');
  assert.equal(result.usage_source, 'provider');
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 5 });
  assert.equal(result.request_seq, 1);
  assert.equal(result.serialized_digest.length, 64);

  const rows = ledgerRows(store, analysisId);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].state), 'settled');
  assert.equal(Number(rows[0].settled_input), 12);
  assert.equal(Number(rows[0].settled_output), 5);
  assert.equal(Number(rows[0].attempt_id === null ? 0 : 1), 1, 'attempt_id must be persisted');

  assert.equal(provider.requests.length, 1);
  const body = provider.requests[0].body;
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.max_tokens, 2000);
  // 只发出 allowlist 内的字段，且是 DTO 结构而不是自由文本。
  assert.deepEqual(Object.keys(body.messages[1].content.fields).sort(), ['count', 'process_name', 'rule_id']);
});

test('预算不足：不预扣、不发请求、不落账本行', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const upper = inputUpperOf(intent);
  // 日预算只够别人的一半：这次一定进不去。
  const harness = createHarness(t, {
    store,
    provider,
    policy: {
      perAnalysisInputTokens: upper * 10,
      perAnalysisOutputTokens: 2000,
      perAnalysisRequests: 3,
      dailyInputTokens: Math.max(1, upper - 1),
      dailyOutputTokens: 6000,
    },
  });

  const error = await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_BUDGET);
  assert.equal(error.details.reason, 'daily_input');

  assert.equal(provider.requests.length, 0, 'no network call may happen without a reservation');
  assert.equal(ledgerRows(store, analysisId).length, 0, 'a rejected admission must not write a ledger row');
});

test('preview 不是准入：伪造余额读数也绕不过 reserve', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);

  // 真实适配器 + 一个"永久说余额充足"的 preview 包装。
  const realPort = (await import('../../apps/model-broker/src/adapters/event-store-budget.js'))
    .createEventStoreBudgetPort(store, { policy: { dailyInputTokens: 1, dailyOutputTokens: 1 } });
  const lyingPort = Object.freeze({
    ...realPort,
    preview: () => Object.freeze({
      analysis_input_remaining: 1_000_000,
      analysis_output_remaining: 2000,
      daily_input_remaining: 1_000_000,
      daily_output_remaining: 2000,
      requests_used: 0,
      requests_remaining: 3,
    }),
  });

  const harness = createHarness(t, { store, provider, port: lyingPort });
  const error = await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_BUDGET);
  assert.equal(error.details.store_code, 'ERR_BUDGET_EXCEEDED');

  assert.equal(provider.requests.length, 0, 'store rejection must stop the request before the wire');
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('并发预扣：额度只够两次，第三个分析被拒绝且无超额准入', async (t) => {
  const { store } = openTestStore(t);
  // usage=null 会让每个请求按上界结清，从而把"额度被真实占用"固定下来。
  const provider = await startMockProvider(okHandler({ usage: null }));
  const analyses = [seedAnalysis(store), seedAnalysis(store), seedAnalysis(store)];
  const intents = analyses.map((item) => makeIntent(item.analysis_id));
  const upper = inputUpperOf(intents[0]);

  const harness = createHarness(t, {
    store,
    provider,
    policy: {
      perAnalysisInputTokens: upper * 5,
      perAnalysisOutputTokens: 2000,
      perAnalysisRequests: 3,
      dailyInputTokens: upper * 2 + 1,
      dailyOutputTokens: 6000,
    },
  });

  const settled = await Promise.allSettled(intents.map((intent) => harness.broker.request(intent)));
  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');

  assert.equal(fulfilled.length, 2, 'exactly two requests fit the daily budget');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.name, 'BrokerError');
  assert.equal(rejected[0].reason.code, BROKER_CODES.ERR_BROKER_BUDGET);
  assert.equal(rejected[0].reason.details.reason, 'daily_input');

  assert.equal(provider.requests.length, 2, 'the rejected request must never reach the provider');
  const allRows = ledgerRows(store);
  assert.equal(allRows.length, 2, 'no extra reservation row for the rejected request');
  // 两个成功的请求都按上界结清（提供方没给 usage）。
  for (const row of allRows) {
    assert.equal(String(row.state), 'settled');
    assert.equal(Number(row.settled_input), Number(row.input_upper));
  }
});

test('适配器层：同一 preview 快照下的第三次 reserve 由存储层拒绝（不存在 TOCTOU 窗口）', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const upper = inputUpperOf(intent);
  const port = createEventStoreBudgetPort(store, {
    policy: {
      perAnalysisInputTokens: upper * 5,
      perAnalysisOutputTokens: 2000,
      perAnalysisRequests: 5,
      dailyInputTokens: upper * 2 + 1,
      dailyOutputTokens: 6000,
    },
  });

  // 三次调用共享同一个"看起来够用"的读数：如果实现信任 preview，三次都会放行。
  const preview = port.preview({ analysis_id: analysisId });
  assert.ok(preview.daily_input_remaining >= upper);

  const requestId = () => uuid();
  port.reserve({
    analysis_id: analysisId,
    request_id: requestId(),
    serialized_digest: 'a'.repeat(64),
    input_upper: upper,
    output_limit: 100,
  });
  port.reserve({
    analysis_id: analysisId,
    request_id: requestId(),
    serialized_digest: 'b'.repeat(64),
    input_upper: upper,
    output_limit: 100,
  });

  assert.throws(
    () => port.reserve({
      analysis_id: analysisId,
      request_id: requestId(),
      serialized_digest: 'c'.repeat(64),
      input_upper: upper,
      output_limit: 100,
    }),
    (error) => {
      assert.equal(error.name, 'BrokerError');
      assert.equal(error.code, BROKER_CODES.ERR_BROKER_BUDGET);
      assert.equal(error.details.store_code, 'ERR_BUDGET_EXCEEDED');
      return true;
    },
  );
});

test('单分析请求次数上限：第四次在预扣前被拒绝', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const harness = createHarness(t, { store, provider });

  for (let index = 0; index < 3; index += 1) {
    const result = await harness.broker.request(intent);
    assert.equal(result.request_seq, index + 1);
  }

  const error = await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_BUDGET);
  assert.equal(error.details.reason, 'requests');
  assert.equal(provider.requests.length, 3);
  assert.equal(ledgerRows(store, analysisId).length, 3);
});

test('队列有界：满了就拒绝，不排队硬等', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(({ res }) => {
    // 保持连接占住两个并发槽，让第三个进入等待队列。
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { input_tokens: 1, output_tokens: 1 } }));
      }
    }, 120);
  });
  const analyses = [seedAnalysis(store), seedAnalysis(store), seedAnalysis(store), seedAnalysis(store)];
  const harness = createHarness(t, {
    store,
    provider,
    limits: { maxQueueDepth: 1 },
  });

  const first = harness.broker.request(makeIntent(analyses[0].analysis_id));
  const second = harness.broker.request(makeIntent(analyses[1].analysis_id));
  const third = harness.broker.request(makeIntent(analyses[2].analysis_id));
  const fourth = harness.broker.request(makeIntent(analyses[3].analysis_id));

  const rejected = await expectBrokerErrorAsync(fourth, BROKER_CODES.ERR_BROKER_QUEUE_FULL);
  assert.equal(rejected.details.max_depth, 1);

  await Promise.all([first, second, third]);
  assert.equal(provider.requests.length, 3, 'the rejected request never reached the provider');
});

test('output_limit 取 min(分析剩余, 日剩余, 2000) 并写入 provider max_tokens', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const upper = inputUpperOf(intent);
  const harness = createHarness(t, {
    store,
    provider,
    policy: {
      perAnalysisInputTokens: upper * 5,
      perAnalysisOutputTokens: 137,
      perAnalysisRequests: 3,
      dailyInputTokens: upper * 5,
      dailyOutputTokens: 6000,
    },
  });

  const result = await harness.broker.request(intent);
  assert.equal(provider.requests[0].body.max_tokens, 137);
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(Number(row.output_limit), 137);
  assert.equal(result.request_seq, 1);
});

test('已发送但无 usage：按上界保守结清并如实标记来源', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler({ usage: null }));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const harness = createHarness(t, { store, provider });

  const result = await harness.broker.request(intent);
  assert.equal(result.usage_source, 'upper_bound');
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(String(row.state), 'settled');
  assert.equal(Number(row.settled_input), Number(row.input_upper));
  assert.equal(Number(row.settled_output), Number(row.output_limit));
});

test('socket 直接失败：按 unknown 保留债务并上界结清，不 void、不重试', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(destroyHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  await expectBrokerErrorAsync(harness.broker.request(makeIntent(analysisId)), BROKER_CODES.ERR_BROKER_UNKNOWN);
  const rows = ledgerRows(store, analysisId);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].state), 'settled', 'unknown debt is settled at the upper bound');
  assert.equal(Number(rows[0].settled_input), Number(rows[0].input_upper));
});
