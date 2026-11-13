/**
 * 按请求的可观测字段（P1-3）与升级账本的生产者（P1-6）。
 *
 * 审查事实：
 * - ADR §2.7 要求每次请求记录 `providerId/modelId/tier/inputTokens/outputTokens/escalatedFrom/
 *   fingerprint/decision`，而 `request.sent` 只有 provider/model/input_upper，`request.settled`
 *   **没有任何 token 数**；§4-10 的"用量页与 broker 日志逐条求和一致"因此无法按原文成立
 *   （旧用例拿**返回值**求和冒充日志求和，属假绿）。
 * - `escalatedFrom` 全仓只出现在一句注释里；`recent`（冷却/小时上限的输入）没有任何生产者，
 *   接上 daemon 后 ADR §2.5 第 3、4 条会以"已实现"的名义恒不生效。
 *
 * 本文件因此固定：
 * 1. 日志里真的有 tier/fingerprint/decision/escalatedFrom 与真实 token 数，且**求和等于账本**；
 * 2. 畸形路由决策在出网前拒绝（零网络、零账本行）；
 * 3. 升级请求会写进账本，且账本喂回 `selectRoute` 后冷却与小时上限**真的生效**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import { createEndpointRegistry } from '../../apps/model-broker/src/endpoint.js';
import { createEscalationLedger } from '../../apps/model-broker/src/escalation-ledger.js';
import { ProviderTransportError, TRANSPORT_FAILURES } from '../../apps/model-broker/src/transport.js';
import { HOUR_MS, selectRoute } from '../../packages/policy/src/model-routing.js';
import {
  createLogSink,
  expectBrokerErrorAsync,
  identityFromIntent,
  ledgerRows,
  makeIntent,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
  statusHandler,
  TEST_FIXTURE_KEY,
} from './helpers.js';

const MODEL_ID = 'deepseek-chat';
const NOW = Date.UTC(2026, 10, 4, 2, 0, 0);

function baseUrlOf(provider) {
  return `http://127.0.0.1:${provider.port}/v1`;
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw, but it returned normally');
  return null;
}

function registryWith(provider, overrides = {}) {
  const registry = createEndpointRegistry();
  registry.register({
    id: 'local',
    kind: 'openai-compatible',
    baseUrl: baseUrlOf(provider),
    allowLoopback: true,
    models: [MODEL_ID],
    credentialRef: 'cred://test/local',
    ...overrides,
  });
  return registry;
}

function harness(t, provider, options = {}) {
  const store = options.store ?? openTestStore(t).store;
  const logs = options.logs ?? createLogSink();
  const broker = createModelBroker({
    budgetPort: options.port ?? createEventStoreBudgetPort(
      store,
      options.policy === undefined ? {} : { policy: options.policy },
    ),
    resolveIdentity: identityFromIntent,
    registry: options.registry ?? registryWith(provider),
    providerId: options.providerId ?? 'local',
    modelId: options.modelId ?? MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
    logger: logs,
    now: options.now ?? (() => NOW),
    escalationLedger: options.escalationLedger,
  });
  return { store, broker, logs };
}

/** 一条与 selectRoute 输出同形的决策（broker 只读这几个字段，不重新选路）。 */
function escalationDecision(overrides = {}) {
  return {
    tier: 'triage',
    fingerprint: 'fp-a',
    decision: 'severity-escalation',
    escalatedFrom: 'watch',
    ...overrides,
  };
}

function eventsOf(logs, name) {
  return logs.events.filter((event) => event.event === name);
}

// ---------------------------------------------------------------------------
// P1-3：日志字段
// ---------------------------------------------------------------------------

test('P1-3a：request.sent 带 tier / fingerprint / decision / escalated_from', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);
  const analysis = seedAnalysis(store);

  await broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision() });

  const [sent] = eventsOf(logs, 'request.sent');
  assert.ok(sent, 'request.sent must be emitted');
  assert.equal(sent.tier, 'triage');
  assert.equal(sent.fingerprint, 'fp-a');
  assert.equal(sent.decision, 'severity-escalation');
  assert.equal(sent.escalated_from, 'watch');
  assert.equal(sent.provider_id, 'local');
  assert.equal(sent.model_id, MODEL_ID);
});

test('P1-3b：request.settled 带真实 token 数（不是上界、不是返回值）', async (t) => {
  const usage = { input_tokens: 21, output_tokens: 7 };
  const provider = await startMockProvider(okHandler({ usage }));
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);
  const analysis = seedAnalysis(store);

  await broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision() });

  const [settled] = eventsOf(logs, 'request.settled');
  assert.ok(settled, 'request.settled must be emitted');
  assert.equal(settled.input_tokens, 21);
  assert.equal(settled.output_tokens, 7);
  assert.equal(settled.usage_source, 'provider');
  assert.equal(settled.tier, 'triage', 'the usage page aggregates by tier, so the settle event needs it too');
  assert.equal(settled.escalated_from, 'watch');
});

test('P1-3c：usage 不可用时按上界结清，日志报的也是上界（口径一致）', async (t) => {
  const provider = await startMockProvider(okHandler({ usage: null }));
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);
  const analysis = seedAnalysis(store);

  const result = await broker.request(makeIntent(analysis.analysis_id));
  const [settled] = eventsOf(logs, 'request.settled');
  assert.equal(settled.usage_source, 'upper_bound');
  assert.equal(settled.input_tokens, result.usage.input_tokens);
  assert.equal(settled.output_tokens, result.usage.output_tokens);
  const row = ledgerRows(store, analysis.analysis_id)[0];
  assert.equal(Number(row.settled_input), settled.input_tokens, 'the log number must equal the ledger number');
});

test('ADR §4-10：用量页的数字与 broker 日志逐条求和一致（±0，真·求和日志）', async (t) => {
  const usage = { input_tokens: 21, output_tokens: 7 };
  const provider = await startMockProvider(okHandler({ usage }));
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);

  const analyses = [seedAnalysis(store), seedAnalysis(store), seedAnalysis(store)];
  for (const analysis of analyses) {
    await broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision() });
  }

  // 这里刻意**不读返回值**：只用日志 + 账本两处独立来源对账。
  const settled = eventsOf(logs, 'request.settled').filter((event) => event.provider_id === 'local');
  assert.equal(settled.length, 3, 'one settle record per request');
  const logInput = settled.reduce((sum, event) => sum + event.input_tokens, 0);
  const logOutput = settled.reduce((sum, event) => sum + event.output_tokens, 0);

  const rows = ledgerRows(store).filter((row) => String(row.state) === 'settled');
  const ledgerInput = rows.reduce((sum, row) => sum + Number(row.settled_input ?? 0), 0);
  const ledgerOutput = rows.reduce((sum, row) => sum + Number(row.settled_output ?? 0), 0);

  assert.equal(logInput, ledgerInput);
  assert.equal(logOutput, ledgerOutput);
  assert.equal(logInput, usage.input_tokens * 3);
  assert.equal(logOutput, usage.output_tokens * 3);
});

test('P1-3g：已发送后断连，日志与账本逐条求和仍然一致（±0）', async (t) => {
  // 审查第 2 轮（P1-3 残留）：上面几条只覆盖了成功路径。一旦请求已经发出、连接随后被断开，
  // 账本会按上界保留债务（settleUnknownAtUpperBound），而旧代码只发 request.failed，
  // 一条 token 都不写 —— 用量页按日志求和就永远对不上账本。这里用真实 event-store 账本钉住它。
  const store = openTestStore(t).store;
  const logs = createLogSink();
  const broker = createModelBroker({
    budgetPort: createEventStoreBudgetPort(store),
    resolveIdentity: identityFromIntent,
    registry: registryWith({ port: 9 }),
    providerId: 'local',
    modelId: MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
    transport: {
      send: async () => {
        throw new ProviderTransportError(TRANSPORT_FAILURES.NETWORK, 'socket reset after send');
      },
    },
    logger: logs,
    now: () => NOW,
  });

  const analysis = seedAnalysis(store);
  await expectBrokerErrorAsync(
    broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision() }),
    'ERR_BROKER_UNKNOWN',
  );

  const [sent] = eventsOf(logs, 'request.sent');
  const [settled] = eventsOf(logs, 'request.settled');
  assert.ok(sent, 'the request must have been sent before the socket died');
  assert.ok(settled, 'a settlement record must exist even when the request failed after send');
  assert.equal(settled.usage_source, 'upper_bound');
  assert.equal(settled.input_tokens, sent.input_upper, 'the log must report exactly what the ledger booked');
  assert.equal(settled.output_tokens, sent.output_limit);
  assert.equal(settled.tier, 'triage', 'the failure path must still be attributable by tier');
  assert.equal(settled.escalated_from, 'watch');

  const rows = ledgerRows(store, analysis.analysis_id).filter((row) => String(row.state) === 'settled');
  const ledgerInput = rows.reduce((sum, row) => sum + Number(row.settled_input ?? 0), 0);
  const ledgerOutput = rows.reduce((sum, row) => sum + Number(row.settled_output ?? 0), 0);
  assert.ok(ledgerInput > 0, 'the ledger must have booked a real upper bound, otherwise the assertion below is vacuous');
  assert.equal(settled.input_tokens, ledgerInput);
  assert.equal(settled.output_tokens, ledgerOutput);
});

test('P1-3d：没有路由决策时字段仍然存在（shape 稳定，值为 null）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);
  await broker.request(makeIntent(seedAnalysis(store).analysis_id));

  const [sent] = eventsOf(logs, 'request.sent');
  for (const key of ['tier', 'fingerprint', 'decision', 'escalated_from']) {
    assert.equal(Object.hasOwn(sent, key), true, `${key} must always be present`);
    assert.equal(sent[key], null, `${key} must be null when unknown, never silently absent`);
  }
});

test('P1-3e：畸形路由决策在出网前拒绝（零网络、零账本行）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store, broker } = harness(t, provider);

  const bad = [
    [{ tier: 'strongest', fingerprint: 'fp-a', decision: 'severity-escalation' }, 'routing.tier'],
    [{ fingerprint: 'fp-a', decision: 'severity-escalation' }, 'routing.tier'],
    [{ tier: 'triage', fingerprint: '', decision: 'severity-escalation' }, 'routing.fingerprint'],
    [{ tier: 'triage', fingerprint: 'fp a', decision: 'severity-escalation' }, 'routing.fingerprint'],
    [{ tier: 'triage', fingerprint: 'fp-a', decision: '' }, 'routing.decision'],
    [{ tier: 'triage', fingerprint: 'fp-a' }, 'routing.decision'],
    [{ tier: 'triage', fingerprint: 'fp-a', decision: 'x', escalatedFrom: 'triage' }, 'routing.escalatedFrom'],
    [{ tier: 'triage', fingerprint: 'fp-a', decision: 'x', escalatedFrom: 'respond' }, 'routing.escalatedFrom'],
    ['triage', 'routing'],
  ];
  for (const [routing, field] of bad) {
    const analysis = seedAnalysis(store);
    const error = await expectBrokerErrorAsync(
      broker.request(makeIntent(analysis.analysis_id), { routing }),
      'ERR_BROKER_INPUT',
    );
    assert.equal(error.details.reason, 'routing_decision_invalid', JSON.stringify(routing));
    assert.equal(error.details.field, field, JSON.stringify(routing));
    assert.equal(ledgerRows(store, analysis.analysis_id).length, 0);
  }
  assert.equal(provider.requests.length, 0, 'no malformed decision may reach the network');
});

test('P1-3f：失败请求同样带路由字段（日志能按 tier 归因失败）', async (t) => {
  const provider = await startMockProvider(statusHandler(401));
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);
  const analysis = seedAnalysis(store);

  await expectBrokerErrorAsync(
    broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision({ tier: 'respond', escalatedFrom: 'watch' }) }),
    'ERR_BROKER_PROVIDER',
  );
  const [failed] = eventsOf(logs, 'request.failed');
  assert.ok(failed, 'request.failed must be emitted');
  assert.equal(failed.tier, 'respond');
  assert.equal(failed.fingerprint, 'fp-a');
  assert.equal(failed.escalated_from, 'watch');
});

test('ADR §4-11：uniform 模式下记录里没有 escalated_from（单一 tier 口径）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store, broker, logs } = harness(t, provider);
  const analysis = seedAnalysis(store);

  const decision = selectRoute({
    mode: 'uniform',
    uniformModelId: MODEL_ID,
    models: [{ id: MODEL_ID, providerId: 'local', tier: 'respond' }],
    signal: { severity: 'low', hasStructuredConclusion: false, evidenceRef: undefined, fingerprint: 'fp-u', at: NOW },
    escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 },
    recent: [],
  });
  assert.equal(decision.ok, true, JSON.stringify(decision));
  assert.equal(decision.escalate, false);

  await broker.request(makeIntent(analysis.analysis_id), {
    routing: {
      tier: decision.tier,
      fingerprint: decision.fingerprint,
      decision: decision.reason,
      escalatedFrom: decision.escalatedFrom,
    },
  });

  const [sent] = eventsOf(logs, 'request.sent');
  assert.equal(sent.tier, 'respond');
  assert.equal(sent.escalated_from, null);
  assert.equal(sent.fingerprint, 'fp-u');
  assert.equal(sent.model_id, MODEL_ID);
});

test('ADR §4-14：uniform 决策仍然受日预算约束（关分级 ≠ 关预算）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store, broker } = harness(t, provider, { policy: { dailyInputTokens: 0, dailyOutputTokens: 0 } });
  const analysis = seedAnalysis(store);

  const decision = selectRoute({
    mode: 'uniform',
    uniformModelId: MODEL_ID,
    models: [{ id: MODEL_ID, providerId: 'local', tier: 'respond' }],
    signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-1', fingerprint: 'fp-u', at: NOW },
    escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 },
    recent: [],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.tier, 'respond');

  const error = await expectBrokerErrorAsync(
    broker.request(makeIntent(analysis.analysis_id), {
      routing: { tier: decision.tier, fingerprint: decision.fingerprint, decision: decision.reason },
    }),
    'ERR_BROKER_BUDGET',
  );
  assert.equal(error.details.reason, 'output');
  assert.equal(provider.requests.length, 0);
});

// ---------------------------------------------------------------------------
// P1-6：升级账本的生产者
// ---------------------------------------------------------------------------

test('P1-6a：只有真的升级过才写账本（uniform / 未升级不写）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const ledger = createEscalationLedger();
  const { store, broker } = harness(t, provider, { escalationLedger: ledger });

  await broker.request(makeIntent(seedAnalysis(store).analysis_id), { routing: escalationDecision() });
  assert.equal(ledger.size, 1);
  assert.deepEqual(ledger.recent(NOW + 1000).map((entry) => entry.fingerprint), ['fp-a']);

  await broker.request(makeIntent(seedAnalysis(store).analysis_id), {
    routing: { tier: 'respond', fingerprint: 'fp-u', decision: 'uniform-mode', escalatedFrom: null },
  });
  assert.equal(ledger.size, 1, 'a non-escalated request must not enter the escalation ledger');

  await broker.request(makeIntent(seedAnalysis(store).analysis_id));
  assert.equal(ledger.size, 1, 'a request without a decision must not be guessed into the ledger');
});

test('P1-6b：账本喂回判据后，冷却真的生效（ADR §2.5 第 3 条 / §4-7）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const ledger = createEscalationLedger();
  const { store, broker } = harness(t, provider, { escalationLedger: ledger });

  const config = {
    mode: 'tiered',
    uniformModelId: null,
    defaultTier: 'watch',
    models: [
      { id: 'local-7b', providerId: 'local', tier: 'watch' },
      { id: MODEL_ID, providerId: 'local', tier: 'triage' },
    ],
    escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 },
  };
  const signalAt = (at) => ({ severity: 'high', hasStructuredConclusion: true, evidenceRef: 'ev-1', fingerprint: 'fp-a', at });

  // 第一次：没有任何 recent → 允许升级到 triage。
  const first = selectRoute({ ...config, signal: signalAt(NOW), recent: ledger.recent(NOW) });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.tier, 'triage');
  await broker.request(makeIntent(seedAnalysis(store).analysis_id), {
    routing: {
      tier: first.tier,
      fingerprint: first.fingerprint,
      decision: first.reason,
      escalatedFrom: first.escalatedFrom,
    },
  });
  assert.equal(ledger.size, 1, 'the escalation must be recorded when the request is sent');

  // 第二次：同一 fingerprint，10 秒后 → 冷却必须拦住（这正是"recent 有生产者"的证明）。
  const second = selectRoute({ ...config, signal: signalAt(NOW + 10 * 1000), recent: ledger.recent(NOW + 10 * 1000) });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_COOLDOWN');
  assert.equal(second.detail.lastEscalatedAt, NOW);

  // 冷却窗口过去（6 分钟）后允许，但小时上限（1）紧接着拦住。
  const third = selectRoute({
    ...config,
    escalation: { ...config.escalation, maxPerHour: 1 },
    signal: signalAt(NOW + 6 * 60 * 1000),
    recent: ledger.recent(NOW + 6 * 60 * 1000),
  });
  assert.equal(third.ok, false);
  assert.equal(third.code, 'E_HOURLY_CAP');
  assert.equal(third.detail.recentEscalations, 1);
});

test('P1-6c：账本窗口覆盖冷却上限（超过 1 小时的冷却也能拿到历史）', () => {
  const ledger = createEscalationLedger({ now: () => NOW });
  ledger.record('fp-a', NOW);
  // 90 分钟前的记录：1 小时窗口内查不到，但 2 小时冷却需要它。
  ledger.record('fp-b', NOW - 90 * 60 * 1000);
  assert.deepEqual(ledger.recent(NOW).map((entry) => entry.fingerprint), ['fp-a']);
  assert.deepEqual(
    ledger.recent(NOW, { windowMs: 2 * HOUR_MS }).map((entry) => entry.fingerprint),
    ['fp-b', 'fp-a'],
    'a cooldown longer than the hourly window must still see older escalations',
  );
});

test('P1-6d：账本拒绝畸形指纹，且不会因写入而无限增长', () => {
  const ledger = createEscalationLedger({ now: () => NOW, maxEntries: 5 });
  for (const bad of ['', '   ', 'fp a', 42, null]) {
    assert.throws(() => ledger.record(bad, NOW), (error) => error.code === 'ERR_BROKER_INPUT', String(bad));
  }
  for (let index = 0; index < 20; index += 1) ledger.record(`fp-${index}`, NOW + index);
  assert.equal(ledger.size, 5, 'the ledger is bounded');
  assert.deepEqual(
    ledger.recent(NOW + 30).map((entry) => entry.fingerprint),
    ['fp-15', 'fp-16', 'fp-17', 'fp-18', 'fp-19'],
    'the oldest entries are dropped first',
  );
});

test('P1-6e：外部账本形状不合格 → broker 拒绝启动', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store } = openTestStore(t);
  const error = thrownBy(() => createModelBroker({
    budgetPort: createEventStoreBudgetPort(store),
    resolveIdentity: identityFromIntent,
    registry: registryWith(provider),
    providerId: 'local',
    modelId: MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
    escalationLedger: { record() {} },
  }));
  assert.equal(error.code, 'ERR_BROKER_ADAPTER');
  assert.equal(error.details.reason, 'escalation_ledger_invalid');
});
