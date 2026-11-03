/**
 * 请求生命周期：超时 / 取消 / 提供方错误 / 未知结果 / 结算幂等 / 熔断。
 *
 * 这一组用例的核心主张只有一句：**预扣之后不存在"退款"**。
 * 取消、超时、500、socket 断开、响应超限——全都只能转 unknown 并按上界结清。
 * 只要有一个用例能证明额度被退回，"取消即免费重发"就成了真正的预算绕过。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BROKER_CODES } from '../../apps/model-broker/src/errors.js';
import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import {
  budgetSummary,
  createHarness,
  destroyHandler,
  expectBrokerErrorAsync,
  hangHandler,
  inputUpperOf,
  ledgerRows,
  makeIntent,
  okHandler,
  openTestStore,
  seedAnalysis,
  sleep,
  startMockProvider,
  statusHandler,
  tick,
} from './helpers.js';

test('超时：按上界结清债务，且不自动重试', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(hangHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const upper = inputUpperOf(intent);
  const harness = createHarness(t, { store, provider, timeoutMs: 120 });

  const before = budgetSummary(store).daily.remaining_input;
  await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_TIMEOUT);

  assert.equal(provider.requests.length, 1, 'a timeout must not be retried');
  const rows = ledgerRows(store, analysisId);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].state), 'settled');
  assert.equal(Number(rows[0].settled_input), upper);
  assert.equal(Number(rows[0].settled_output), Number(rows[0].output_limit));

  const after = budgetSummary(store).daily.remaining_input;
  assert.equal(after, before - upper, 'the reservation must stay spent, never refunded');
  assert.equal(harness.broker.stats().timed_out, 1);

  // 再等一会儿：确认没有任何延迟重试在后台发生。
  await sleep(120);
  assert.equal(provider.requests.length, 1);
});

test('客户端取消（已发送）：债务保留，额度不退', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(hangHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);
  const upper = inputUpperOf(intent);
  const harness = createHarness(t, { store, provider, timeoutMs: 5000 });

  const controller = new AbortController();
  const pending = harness.broker.request(intent, { signal: controller.signal });
  // 等请求真正发出（provider 侧看到请求）后再取消，模拟"发送之后才撤"。
  while (provider.requests.length === 0) await tick();
  const before = budgetSummary(store).daily.remaining_input;
  controller.abort();

  await expectBrokerErrorAsync(pending, BROKER_CODES.ERR_BROKER_CANCELLED);
  const rows = ledgerRows(store, analysisId);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].state), 'settled', 'cancel after send must not void the reservation');
  assert.equal(Number(rows[0].settled_input), upper);
  assert.equal(budgetSummary(store).daily.remaining_input, before);
  assert.equal(harness.broker.stats().cancelled, 1);
});

test('客户端取消（排队中）：零预扣、零网络、零账本行', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(hangHandler());
  const first = seedAnalysis(store);
  const second = seedAnalysis(store);
  const harness = createHarness(t, { store, provider, timeoutMs: 150, limits: { maxConcurrentRequests: 1 } });

  const occupying = harness.broker.request(makeIntent(first.analysis_id));
  await tick(3);

  const controller = new AbortController();
  const queued = harness.broker.request(makeIntent(second.analysis_id), { signal: controller.signal });
  await tick(2);
  controller.abort();

  await expectBrokerErrorAsync(queued, BROKER_CODES.ERR_BROKER_CANCELLED);
  assert.equal(ledgerRows(store, second.analysis_id).length, 0, 'a queued cancel must not reserve budget');
  assert.equal(ledgerRows(store, first.analysis_id).length, 1);
  assert.equal(provider.requests.length, 1, 'the cancelled request never reached the provider');

  await expectBrokerErrorAsync(occupying, BROKER_CODES.ERR_BROKER_TIMEOUT);
});

test('提供方 500：按上界结清并计入熔断连续失败', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(500));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(error.details.reason, 'provider_server');
  assert.equal(provider.requests.length, 1);
  assert.equal(String(ledgerRows(store, analysisId)[0].state), 'settled');
  assert.equal(harness.broker.circuit().consecutive_retryable, 1);
  assert.equal(harness.broker.circuit().state, 'closed');
  assert.equal(harness.broker.stats().provider_errors, 1);
});

test('提供方 401：熔断立即打开，后续请求在预扣前被拒', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(401));
  const first = seedAnalysis(store);
  const second = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(first.analysis_id)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(harness.broker.circuit().state, 'open');

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(second.analysis_id)),
    BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN,
  );
  assert.equal(provider.requests.length, 1, 'an open circuit must not touch the provider again');
  assert.equal(ledgerRows(store, second.analysis_id).length, 0, 'a circuit rejection must not reserve budget');
});

test('连续 5 次可重试失败后熔断打开', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(500));
  const analyses = Array.from({ length: 6 }, () => seedAnalysis(store));
  // 每次按上界结清会吃掉日输出预算，这里把单次输出上限压小，
  // 让用例聚焦在熔断计数上而不是预算耗尽上。
  const harness = createHarness(t, { store, provider, limits: { maxOutputTokens: 100 } });

  for (let index = 0; index < 5; index += 1) {
    await expectBrokerErrorAsync(
      harness.broker.request(makeIntent(analyses[index].analysis_id)),
      BROKER_CODES.ERR_BROKER_PROVIDER,
    );
  }
  assert.equal(harness.broker.circuit().state, 'open');
  assert.equal(harness.broker.circuit().consecutive_retryable, 5);

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analyses[5].analysis_id)),
    BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN,
  );
  assert.equal(provider.requests.length, 5);
  assert.equal(ledgerRows(store, analyses[5].analysis_id).length, 0);
});

test('结果未知（socket 断开）：只有一次网络请求，账本按上界结清', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(destroyHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_UNKNOWN,
  );
  await sleep(80);
  assert.equal(provider.requests.length, 1, 'unknown outcome must never be retried automatically');
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(String(row.state), 'settled');
  assert.equal(Number(row.settled_input), Number(row.input_upper));
  assert.equal(harness.broker.stats().unknown_outcome, 1);
});

test('响应体超限：按提供方错误失败关闭，债务不释放', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(4096) } }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider, limits: { maxResponseBytes: 512 } });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(error.details.reason, 'response_oversize');
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(String(row.state), 'settled');
  assert.equal(Number(row.settled_input), Number(row.input_upper));
});

test('提供方 usage 超过预留上界：按实际结清、差异可见、熔断立即打开', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler({ usage: { input_tokens: 500000, output_tokens: 9000 } }));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const result = await harness.broker.request(makeIntent(analysisId));
  assert.ok(result.discrepancy !== null);
  assert.ok(result.discrepancy.input_tokens_over > 0);
  assert.ok(result.discrepancy.output_tokens_over > 0);
  assert.equal(harness.broker.stats().settlement_discrepancies, 1);
  assert.equal(harness.broker.circuit().state, 'open');

  const row = ledgerRows(store, analysisId)[0];
  assert.equal(Number(row.settled_input), 500000, 'actual usage is recorded, not the reservation');
});

test('结算幂等：重复结算返回 duplicate 且不改变账本', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const port = createEventStoreBudgetPort(store);

  const reserved = port.reserve({
    analysis_id: analysisId,
    request_id: '22222222-2222-4222-8222-222222222222',
    serialized_digest: 'd'.repeat(64),
    input_upper: 100,
    output_limit: 50,
  });
  port.markSent({ request_id: reserved.request_id });

  const first = port.settle({
    request_id: reserved.request_id,
    usage: { input_tokens: 70, output_tokens: 30 },
  });
  assert.equal(first.duplicate, false);
  assert.deepEqual({ ...first.usage }, { input_tokens: 70, output_tokens: 30 });

  const before = ledgerRows(store, analysisId)[0];
  const second = port.settle({
    request_id: reserved.request_id,
    usage: { input_tokens: 999, output_tokens: 999 },
  });
  assert.equal(second.duplicate, true, 'a repeat settlement is an idempotent confirmation');
  const after = ledgerRows(store, analysisId)[0];
  assert.equal(Number(after.settled_input), Number(before.settled_input));
  assert.equal(Number(after.settled_output), Number(before.settled_output));
  assert.equal(Number(after.settled_input), 70);
});

test('reserved 状态不能被直接结算（否则等于凭空释放额度）', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const port = createEventStoreBudgetPort(store);

  const reserved = port.reserve({
    analysis_id: analysisId,
    request_id: '33333333-3333-4333-8333-333333333333',
    serialized_digest: 'e'.repeat(64),
    input_upper: 100,
    output_limit: 50,
  });

  assert.throws(
    () => port.settle({ request_id: reserved.request_id, usage: { input_tokens: 1, output_tokens: 1 } }),
    (error) => {
      assert.equal(error.name, 'BrokerError');
      assert.equal(error.details.store_code, 'ERR_REQUEST_STATE');
      return true;
    },
  );
  // 未发送的预留只能带"已证明未发送"作废。
  assert.throws(
    () => port.voidReservation({ request_id: reserved.request_id }),
    (error) => error.details.store_code === 'ERR_RETRY_NOT_PROVEN',
  );
  const voided = port.voidReservation({ request_id: reserved.request_id, provedNotSent: true });
  assert.equal(voided.state, 'void');
});
