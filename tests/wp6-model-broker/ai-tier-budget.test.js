/**
 * AI-ENABLE / tier — 交付 A②：**超预算拒绝升级（且留记录）** + broker 侧预算准入。
 *
 * 三段证明，全部在本机完成、零外联、无真实 key：
 *
 * 1. 纯判据：`recent` 里已有 N 次升级 → `selectRoute` 返回 `E_HOURLY_CAP`；
 *    **变异**：maxPerHour 调大 → 同一输入变成升档（转绿），证明是规则在起作用。
 * 2. 生产者 ↔ 判据闭环：broker 成功发出一次升级请求后，`escalationLedger` 里真的多了一条；
 *    把它的 `recent()` 原样喂回 `selectRoute` → 下一次升级被拒；随后"停在默认 tier"的
 *    请求走的是 watch 模型，且**不会**再写一条升级记录。
 * 3. broker 侧预算（全局日预算 + 每端点日预算）触发时：**provider 收到 0 个请求**，
 *    返回结构化 `BrokerError`，并且不写升级记录、不落账本行；变异（放宽预算）后同一
 *    输入真的发出去 —— 两次对照证明拦下来的是预算规则本身。
 *
 * 记录字段名（证据里要能查到的）：
 * - 判据拒绝：`result.code === 'E_HOURLY_CAP'`，`result.detail.recentEscalations` / `.maxPerHour`
 * - 升级记录：`broker.escalationLedger.size`、`broker.escalationLedger.recent(at)` → `[{fingerprint, at}]`
 * - broker 拒绝：`error.code === 'ERR_BROKER_BUDGET'`、`error.details.reason`、
 *   `broker.stats().rejected` / `.provider_budget_rejections`
 * - 线路证明：`provider.requests.length`、`provider.requests[i].body.model`
 * - 账本行：`ledgerRows(store, analysis_id).length`
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { selectRoute, ROUTE_CODES } from '../../packages/policy/src/model-routing.js';
import { normalizeRoutingInput } from '../../packages/policy/src/routing-config.js';
import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import { createEndpointRegistry } from '../../apps/model-broker/src/endpoint.js';
import { createProviderBudgetLedger } from '../../apps/model-broker/src/endpoint-budget.js';
import { createEscalationLedger } from '../../apps/model-broker/src/escalation-ledger.js';
import { BROKER_CODES } from '../../apps/model-broker/src/errors.js';
import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import {
  TEST_FIXTURE_KEY,
  createHarness,
  expectBrokerErrorAsync,
  identityFromIntent,
  inputUpperOf,
  ledgerRows,
  makeIntent,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
} from './helpers.js';

const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);

const TIER_MODEL = Object.freeze({
  watch: 'qwen2.5-3b-local',
  triage: 'deepseek-chat',
  respond: 'deepseek-reasoner',
});

/** 已升级过的指纹（写进 recent / 账本）。 */
const ESCALATED_FINGERPRINT = 'tier-fp-cap-0001';
/** 本次要判定的指纹：与上面不同，避免先命中冷却（冷却按 fingerprint 判，小时上限按条数判）。 */
const CANDIDATE_FINGERPRINT = 'tier-fp-cap-0002';

function readExampleConfig() {
  const path = new URL('../../deploy/config/model-routing.example.json', import.meta.url);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

/** 与 settings-schema 默认形状一致的判据入参（示例配置经装载层归一）。 */
function judgeInput() {
  const normalized = normalizeRoutingInput(readExampleConfig());
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  return normalized.input;
}

function makeSignal(severity, overrides = {}) {
  return {
    severity,
    hasStructuredConclusion: true,
    evidenceRef: 'evidence://alert/tier-cap-0001',
    fingerprint: CANDIDATE_FINGERPRINT,
    at: NOW,
    ...overrides,
  };
}

/** 模拟"调用方在判据拒绝时怎么办"：照常走 defaultTier，且不记升级（交付 B 在真链路上复核）。 */
function callerDecision(result, defaultTier) {
  if (result.ok !== true) {
    return {
      tier: defaultTier,
      modelId: TIER_MODEL[defaultTier],
      escalate: false,
      decision: result.code,
      recordedEscalation: false,
    };
  }
  return {
    tier: result.tier,
    modelId: result.modelId,
    escalate: result.escalate,
    decision: result.reason,
    recordedEscalation: result.escalate === true,
  };
}

test('① 小时上限：recent 已满 N 次 → E_HOURLY_CAP；maxPerHour 调大后同一输入升档（变异）', () => {
  const base = judgeInput();
  const escalation = {
    ...base.escalation,
    minSeverity: 'low',
    cooldownSeconds: 300,
    maxPerHour: 2,
  };
  const recent = [
    { fingerprint: 'tier-fp-other-0001', at: NOW - 60_000 },
    { fingerprint: 'tier-fp-other-0002', at: NOW - 2 * 60_000 },
  ];
  const signal = makeSignal('critical');

  const capped = selectRoute({ ...base, escalation, signal, recent });
  const boundary = selectRoute({ ...base, escalation, signal, recent: recent.slice(0, 1) });
  const mutated = selectRoute({ ...base, escalation: { ...escalation, maxPerHour: 3 }, signal, recent });

  const table = [
    { case: 'recent=2, maxPerHour=2 (期望拒绝)', 'expected code': 'E_HOURLY_CAP', 'actual code': capped.code ?? 'OK' },
    { case: 'recent=1, maxPerHour=2 (期望升档)', 'expected tier': 'respond', 'actual tier': boundary.ok ? boundary.tier : boundary.code },
    { case: 'recent=2, maxPerHour=3 变异 (期望升档)', 'expected tier': 'respond', 'actual tier': mutated.ok ? mutated.tier : mutated.code },
  ];
  console.log('hourly-cap-table:\n%s', JSON.stringify(table, null, 2));

  // 1) 满额 → 拒绝，且 detail 里能查到"几条 / 上限几条"。
  assert.equal(capped.ok, false, JSON.stringify(capped));
  assert.equal(capped.code, ROUTE_CODES.HOURLY_CAP);
  assert.deepEqual(capped.detail, { recentEscalations: 2, maxPerHour: 2 });
  // 拒绝结果里没有 tier/modelId：调用方拿不到"升级到哪"的结论。
  assert.equal(capped.tier, undefined);
  assert.equal(capped.modelId, undefined);

  // 2) 边界：少一条就放行 —— 说明不是"恒定拒绝"。
  assert.equal(boundary.ok, true, JSON.stringify(boundary));
  assert.equal(boundary.tier, 'respond');
  assert.equal(boundary.escalate, true);

  // 3) 变异：只把 maxPerHour 2 → 3，同一输入就从拒绝变成升档。
  assert.equal(mutated.ok, true, JSON.stringify(mutated));
  assert.equal(mutated.tier, 'respond');
  assert.equal(mutated.modelId, TIER_MODEL.respond);
  assert.equal(mutated.reason, 'severity-escalation');
  assert.equal(mutated.escalatedFrom, 'watch');

  // 4) 调用方契约（策略层版）：拒绝 → 停在 watch，且不产生升级记录。
  const decision = callerDecision(capped, 'watch');
  assert.deepEqual(decision, {
    tier: 'watch',
    modelId: TIER_MODEL.watch,
    escalate: false,
    decision: 'E_HOURLY_CAP',
    recordedEscalation: false,
  });
});

test('② 生产者 ↔ 判据闭环：broker 记的那条升级，正好把下一次升级按小时上限挡掉', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const analysis = seedAnalysis(store);
  const intent = makeIntent(analysis.analysis_id, { attempt_id: analysis.attempt_id });

  const registry = createEndpointRegistry();
  registry.register({
    id: 'fake-tier',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [TIER_MODEL.watch, TIER_MODEL.triage, TIER_MODEL.respond],
  });
  const budgetPort = createEventStoreBudgetPort(store);
  const ledger = createEscalationLedger({ now: () => NOW });

  const makeBroker = (modelId) => createModelBroker({
    budgetPort,
    resolveIdentity: identityFromIntent,
    registry,
    providerId: 'fake-tier',
    modelId,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
    escalationLedger: ledger,
    now: () => NOW,
  });

  try {
    const triageBroker = makeBroker(TIER_MODEL.triage);
    const watchBroker = makeBroker(TIER_MODEL.watch);

    // 2.1 一次真实升级请求：模型名进假 provider 日志，升级进账本。
    const escalated = await triageBroker.request(intent, {
      routing: {
        tier: 'triage',
        fingerprint: ESCALATED_FINGERPRINT,
        decision: 'severity-escalation',
        escalatedFrom: 'watch',
      },
    });
    assert.equal(escalated.state, 'settled');
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].body.model, TIER_MODEL.triage);
    assert.equal(ledger.size, 1, 'a sent escalation must be recorded by the broker');
    const recent = ledger.recent(NOW);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].fingerprint, ESCALATED_FINGERPRINT);
    assert.equal(recent[0].at, NOW);

    // 2.2 判据读这条真实记录：maxPerHour=1 → 下一次必须被拒。
    const base = judgeInput();
    const escalation = {
      ...base.escalation,
      minSeverity: 'low',
      cooldownSeconds: 300,
      maxPerHour: 1,
    };
    const capped = selectRoute({ ...base, escalation, signal: makeSignal('critical'), recent });
    assert.equal(capped.ok, false, JSON.stringify(capped));
    assert.equal(capped.code, ROUTE_CODES.HOURLY_CAP);
    assert.deepEqual(capped.detail, { recentEscalations: 1, maxPerHour: 1 });

    // 2.3 变异：上限 1 → 2，同一条记录、同一输入 → 升档。
    const mutated = selectRoute({
      ...base,
      escalation: { ...escalation, maxPerHour: 2 },
      signal: makeSignal('critical'),
      recent,
    });
    assert.equal(mutated.ok, true, JSON.stringify(mutated));
    assert.equal(mutated.tier, 'respond');

    // 2.4 拒绝之后"停在默认 tier"：链路（此处以 watch broker 代表）真的请求 watch 模型，
    //     且不会再写第二条升级记录 —— 这就是"拒绝升级并被记录"的可查半边。
    const stay = await watchBroker.request(intent, {
      routing: {
        tier: 'watch',
        fingerprint: CANDIDATE_FINGERPRINT,
        decision: 'below-escalation-tier',
        escalatedFrom: null,
      },
    });
    assert.equal(stay.state, 'settled');
    console.log('producer-judge-loop:\n%s', JSON.stringify({
      'provider.requests.length': provider.requests.length,
      'models seen': provider.requests.map((entry) => entry.body.model),
      'isolation ledger size after escalated send': 1,
      'broker.escalationLedger.size': ledger.size,
      'capped.code': capped.code,
      'capped.detail': capped.detail,
      'mutated.tier': mutated.tier,
      'stay.tier_model': provider.requests[1].body.model,
    }, null, 2));

    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[1].body.model, TIER_MODEL.watch);
    assert.equal(ledger.size, 1, 'a non-escalation request must not add an escalation record');
    assert.equal(ledger.recent(NOW).length, 1);
  } finally {
    await provider.close();
  }
});

test('③ 全局日预算触发：升级请求被拒、provider 收到 0 个请求、结构化错误、无升级记录（变异后放行）', async (t) => {
  const { store } = openTestStore(t);
  const analysis = seedAnalysis(store);
  const intent = makeIntent(analysis.analysis_id, { attempt_id: analysis.attempt_id });
  const upper = inputUpperOf(intent);

  const providerA = await startMockProvider(okHandler());
  // 日预算只够一半：这次升级请求一定进不去。
  const harnessA = createHarness(t, {
    store,
    provider: providerA,
    policy: {
      perAnalysisInputTokens: upper * 10,
      perAnalysisOutputTokens: 2000,
      perAnalysisRequests: 3,
      dailyInputTokens: Math.max(1, upper - 1),
      dailyOutputTokens: 6000,
    },
  });

  const routing = {
    tier: 'respond',
    fingerprint: CANDIDATE_FINGERPRINT,
    decision: 'severity-escalation',
    escalatedFrom: 'triage',
  };

  const error = await expectBrokerErrorAsync(
    harnessA.broker.request(intent, { routing }),
    BROKER_CODES.ERR_BROKER_BUDGET,
  );
  assert.equal(error.details.reason, 'daily_input');
  // 这条路径在 preview 的"快速失败"上就被拦下（还没走到 reserve），所以这是
  // broker 自己的结构化 detail，而不是存储层回传的 store_code。
  assert.equal(Number.isInteger(error.details.remaining), true);
  assert.equal(Number.isInteger(error.details.requested), true);
  assert.equal(error.details.remaining < error.details.requested, true);

  // 拒绝之后、变异之前：把"拒绝侧"的读数先钉住（变异请求会写账本，不能事后读）。
  const afterReject = {
    'provider.requests.length': providerA.requests.length,
    'ledger rows (analysis)': ledgerRows(store, analysis.analysis_id).length,
    'escalation records': harnessA.broker.escalationLedger.size,
    'brokerA.stats().rejected': harnessA.broker.stats().rejected,
  };

  // 变异：同一 analysis、同一 intent、同一 routing，只放宽日预算 → 真的发出去。
  const providerB = await startMockProvider(okHandler());
  const harnessB = createHarness(t, {
    store,
    provider: providerB,
    policy: {
      perAnalysisInputTokens: upper * 10,
      perAnalysisOutputTokens: 2000,
      perAnalysisRequests: 3,
      dailyInputTokens: upper * 10,
      dailyOutputTokens: 6000,
    },
  });
  const sent = await harnessB.broker.request(intent, { routing });

  console.log('global-budget-table:\n%s', JSON.stringify({
    'expected': 'ERR_BROKER_BUDGET / daily_input / 0 provider requests / 0 ledger rows',
    'actual error.code': error.code,
    'actual error.details.reason': error.details.reason,
    'actual error.details.remaining': error.details.remaining,
    'actual error.details.requested': error.details.requested,
    'after reject': afterReject,
    'mutation providerB.requests.length': providerB.requests.length,
    'mutation body.model': providerB.requests[0]?.body.model ?? null,
    'mutation state': sent.state,
  }, null, 2));

  assert.equal(afterReject['provider.requests.length'], 0, 'a budget rejection must never reach the provider');
  assert.equal(afterReject['ledger rows (analysis)'], 0, 'no ledger row for a rejected admission');
  assert.equal(afterReject['escalation records'], 0, 'a rejected escalation must not be recorded as sent');
  assert.equal(afterReject['brokerA.stats().rejected'], 1);

  // 变异证明：同一输入在预算够的时候确实发了一次，模型名出现在假 provider 日志里。
  assert.equal(providerB.requests.length, 1);
  assert.equal(providerB.requests[0].body.model, 'deepseek-chat');
  assert.equal(sent.state, 'settled');
  assert.equal(harnessB.broker.escalationLedger.size, 1, 'the sent escalation is recorded');
});

test('④ 每端点日预算触发：升级请求在预扣前被拒、provider 收到 0 个请求、无升级记录（变异后放行）', async (t) => {
  const { store } = openTestStore(t);
  const analysis = seedAnalysis(store);
  const intent = makeIntent(analysis.analysis_id, { attempt_id: analysis.attempt_id });
  const provider = await startMockProvider(okHandler());
  // 假 server 必须由用例自己关掉：未关闭的监听句柄会让 `node --test` 跑完不退出。
  t.after(() => provider.close());

  const routing = {
    tier: 'respond',
    fingerprint: CANDIDATE_FINGERPRINT,
    decision: 'severity-escalation',
    escalatedFrom: 'triage',
  };
  const credential = new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' });
  const budgetPort = createEventStoreBudgetPort(store);
  const ledger = createEscalationLedger({ now: () => NOW });

  // 4.1 端点日预算 = 1 token：input 上界必然 > 1 → reserve 拒绝。
  const strictRegistry = createEndpointRegistry();
  strictRegistry.register({
    id: 'fake-endpoint-budget',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [TIER_MODEL.respond],
    dailyInputTokens: 1,
    dailyOutputTokens: 2000,
  });
  const providerBudget = createProviderBudgetLedger({ now: () => NOW });
  const strictBroker = createModelBroker({
    budgetPort,
    resolveIdentity: identityFromIntent,
    registry: strictRegistry,
    providerId: 'fake-endpoint-budget',
    modelId: TIER_MODEL.respond,
    credential,
    providerBudgetPort: providerBudget,
    escalationLedger: ledger,
    now: () => NOW,
  });

  const error = await expectBrokerErrorAsync(
    strictBroker.request(intent, { routing }),
    BROKER_CODES.ERR_BROKER_BUDGET,
  );
  assert.equal(error.details.reason, 'provider_daily_input');
  assert.equal(error.details.provider_id, 'fake-endpoint-budget');
  assert.equal(error.details.requested > 0, true);

  // 4.2 变异：同一 provider 形状，只把端点日预算放宽到 10 万 → 同一输入真的发出去。
  const openRegistry = createEndpointRegistry();
  openRegistry.register({
    id: 'fake-endpoint-open',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [TIER_MODEL.respond],
    dailyInputTokens: 100_000,
    dailyOutputTokens: 6000,
  });
  const openBroker = createModelBroker({
    budgetPort,
    resolveIdentity: identityFromIntent,
    registry: openRegistry,
    providerId: 'fake-endpoint-open',
    modelId: TIER_MODEL.respond,
    credential,
    providerBudgetPort: createProviderBudgetLedger({ now: () => NOW }),
    escalationLedger: ledger,
    now: () => NOW,
  });
  const sent = await openBroker.request(intent, { routing });

  console.log('endpoint-budget-table:\n%s', JSON.stringify({
    'expected': 'ERR_BROKER_BUDGET / provider_daily_input / 0 provider requests',
    'actual error.code': error.code,
    'actual error.details.reason': error.details.reason,
    'actual error.details.provider_id': error.details.provider_id,
    'actual error.details.requested': error.details.requested,
    'actual error.details.remaining': error.details.remaining,
    'strictBroker.stats().provider_budget_rejections': strictBroker.stats().provider_budget_rejections,
    'strictBroker.stats().rejected': strictBroker.stats().rejected,
    'provider.requests.length after reject': 0,
    'providerBudget.read(daily_input_reserved)': providerBudget.read('fake-endpoint-budget').input_reserved,
    'escalation ledger size after reject': 0,
    'mutation provider.requests.length': provider.requests.length,
    'mutation body.model': provider.requests[0]?.body.model ?? null,
    'mutation state': sent.state,
  }, null, 2));

  // 拒绝时：0 网络、0 端点预留残留、0 账本行、0 升级记录。
  assert.equal(provider.requests.length, 1, 'only the mutation request may reach the provider');
  assert.equal(strictBroker.stats().provider_budget_rejections, 1);
  assert.equal(strictBroker.stats().rejected, 1);
  assert.equal(providerBudget.read('fake-endpoint-budget').input_reserved, 0);
  assert.equal(ledger.size, 1, 'only the mutation request records an escalation');

  // 变异侧：模型名出现在假 provider 日志，结算完成。
  assert.equal(provider.requests[0].body.model, TIER_MODEL.respond);
  assert.equal(sent.state, 'settled');
});

test('⑤ 判据拒绝本身不产生记录：拒绝次数与升级账本无关（记录只由"真发出去"产生）', async (t) => {
  const { store } = openTestStore(t);
  const analysis = seedAnalysis(store);
  const intent = makeIntent(analysis.analysis_id, { attempt_id: analysis.attempt_id });
  const provider = await startMockProvider(okHandler());
  const harness = createHarness(t, { store, provider });

  const base = judgeInput();
  const escalation = { ...base.escalation, minSeverity: 'low', maxPerHour: 1 };
  const recent = [{ fingerprint: ESCALATED_FINGERPRINT, at: NOW - 1000 }];
  const capped = selectRoute({ ...base, escalation, signal: makeSignal('critical'), recent });
  assert.equal(capped.code, ROUTE_CODES.HOURLY_CAP);
  assert.equal(harness.broker.escalationLedger.size, 0);
  assert.equal(provider.requests.length, 0);

  // 判据拒绝之后再发一次"停留在默认 tier"的请求：ledger 仍然只有 0 条升级记录。
  await harness.broker.request(intent, {
    routing: {
      tier: 'watch',
      fingerprint: CANDIDATE_FINGERPRINT,
      decision: 'below-escalation-tier',
      escalatedFrom: null,
    },
  });
  console.log('refusal-does-not-record:\n%s', JSON.stringify({
    'policy deny code': capped.code,
    'policy deny detail': capped.detail,
    'broker.escalationLedger.size after refusal': harness.broker.escalationLedger.size,
    'provider.requests.length (default tier request sent)': provider.requests.length,
    'provider model': provider.requests[0]?.body.model ?? null,
  }, null, 2));

  assert.equal(harness.broker.escalationLedger.size, 0);
  assert.equal(provider.requests.length, 1, 'the default-tier request itself is a normal, allowed request');
});
