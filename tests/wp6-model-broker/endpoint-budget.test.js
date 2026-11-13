/**
 * 每端点日预算（P1-1）。
 *
 * 审查事实：`register()` 只读 `kind/allowLoopback/baseUrl/models/model/credentialRef/pathSuffix`，
 * `dailyInputTokens` / `dailyOutputTokens` 被**静默丢弃**——示例配置里写的 30000 不报错也不生效，
 * 这是成本控制上的 fail-open（ADR §2.1、§2.5 第 5 条、§6 第 2 项）。
 *
 * 本文件固定的判据：
 * 1. 预算字段要么被冻结进 brand 并在准入时判定，要么在注册时**报错**；不存在"接受但不生效"；
 * 2. 未知字段一律拒绝（拼错 `dailyInTokens` 必须炸，不能当成没写）；
 * 3. 声明了预算却没有预算端口 → broker 拒绝启动（"我设了上限"与"上限真的在拦"必须一致）。
 *
 * 纪律：全部出网流量打到 `127.0.0.1` 动态端口的 mock provider；不写真实数据库路径。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import {
  createEndpointRegistry,
  isEndpointActive,
} from '../../apps/model-broker/src/endpoint.js';
import {
  PROVIDER_BUDGET_OPERATIONS,
  assertProviderBudgetPort,
  createProviderBudgetLedger,
} from '../../apps/model-broker/src/endpoint-budget.js';
import {
  createLogSink,
  destroyHandler,
  expectBrokerErrorAsync,
  identityFromIntent,
  inputUpperOf,
  ledgerRows,
  makeIntent,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
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

/** 注册一个带预算的 provider（回环 → 默认不计费，除非显式要求）。 */
function loopbackRegistry(provider, overrides = {}) {
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

function registryBroker(t, options = {}) {
  const store = options.store ?? openTestStore(t).store;
  const logs = options.logs ?? createLogSink();
  const broker = createModelBroker({
    budgetPort: options.port ?? createEventStoreBudgetPort(store),
    resolveIdentity: identityFromIntent,
    registry: options.registry,
    providerId: options.providerId ?? 'local',
    modelId: options.modelId ?? MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
    logger: logs,
    now: options.now,
    providerBudgetPort: options.providerBudgetPort,
  });
  return { store, broker, logs };
}

// ---------------------------------------------------------------------------
// 注册期：字段要么生效，要么报错
// ---------------------------------------------------------------------------

test('P1-1a：register() 把日预算冻结进 brand，而不是丢掉', () => {
  const registry = createEndpointRegistry();
  const brand = registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    dailyInputTokens: 30000,
    dailyOutputTokens: 6000,
  });
  assert.equal(brand.dailyInputTokens, 30000);
  assert.equal(brand.dailyOutputTokens, 6000);
  assert.equal(Object.isFrozen(brand), true);
  assert.equal(registry.list()[0].dailyInputTokens, 30000);
  assert.equal(registry.list()[0].dailyOutputTokens, 6000);
});

test('P1-1b：未声明 = 继承全局（null），显式 null 同样表示继承', () => {
  const registry = createEndpointRegistry();
  const omitted = registry.register({ id: 'p1', baseUrl: 'https://h1.example/v1', models: [MODEL_ID] });
  assert.equal(omitted.dailyInputTokens, null);
  assert.equal(omitted.dailyOutputTokens, null);
  const explicit = registry.register({
    id: 'p2',
    baseUrl: 'https://h2.example/v1',
    models: [MODEL_ID],
    dailyInputTokens: null,
    dailyOutputTokens: null,
  });
  assert.equal(explicit.dailyInputTokens, null);
});

test('P1-1c：拼错的字段必须报错，不能当成"没写"', () => {
  const registry = createEndpointRegistry();
  for (const key of ['dailyInTokens', 'dailyInputToken', 'budget', 'daily_input_tokens']) {
    const error = thrownBy(() => registry.register({
      id: 'typo',
      baseUrl: 'https://host.example/v1',
      models: [MODEL_ID],
      [key]: 30000,
    }));
    assert.equal(error.code, 'ERR_BROKER_ENDPOINT', key);
    assert.equal(error.details.reason, 'unknown_field', key);
    assert.equal(error.details.field, key, key);
  }
  assert.equal(registry.size, 0, 'a rejected registration must not leave an entry behind');
});

test('P1-1d：预算值必须是 0 或非负整数，其它一律拒绝', () => {
  const registry = createEndpointRegistry();
  const bad = [-1, 1.5, '30000', true, Number.NaN, Number.POSITIVE_INFINITY, {}, []];
  for (const value of bad) {
    const error = thrownBy(() => registry.register({
      id: 'bad-budget',
      baseUrl: 'https://host.example/v1',
      models: [MODEL_ID],
      dailyInputTokens: value,
    }));
    assert.equal(error.code, 'ERR_BROKER_ENDPOINT', String(value));
    assert.equal(error.details.field, 'dailyInputTokens', String(value));
  }
  // 0 是合法值：它的语义是"这个 provider 今天一个 token 都不许花"。
  const zero = registry.register({
    id: 'zero',
    baseUrl: 'https://host.example/v1',
    models: [MODEL_ID],
    dailyInputTokens: 0,
    dailyOutputTokens: 0,
  });
  assert.equal(zero.dailyInputTokens, 0);
});

test('P1-1e：改预算必须走 replace，旧 brand 立即失效（不是"改了但没生效"）', () => {
  const registry = createEndpointRegistry();
  const before = registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    dailyInputTokens: 30000,
    dailyOutputTokens: 6000,
  });
  const duplicate = thrownBy(() => registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    dailyInputTokens: 1,
    dailyOutputTokens: 6000,
  }));
  assert.equal(duplicate.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(duplicate.details.reason, 'duplicate_id');

  const after = registry.replace('deepseek', {
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    dailyInputTokens: 1,
    dailyOutputTokens: 6000,
  });
  assert.equal(after.dailyInputTokens, 1);
  assert.equal(isEndpointActive(before), false);
  assert.equal(isEndpointActive(after), true);
  // 同一个 baseUrl、只改了预算：幂等判定必须把它当成一次真实变更。
  const idempotent = registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
    dailyInputTokens: 1,
    dailyOutputTokens: 6000,
  });
  assert.equal(idempotent, after, 'the same frozen target plus the same budget is idempotent');
});

test('P1-1f：0 与非零都是真实上限，回环 provider 不开后门', () => {
  const registry = createEndpointRegistry();
  // 0 = 今天一个 token 都不许花。示例配置给本地模型写的 0 就是这个含义（已知配置缺陷，见修复说明）。
  const zero = registry.register({
    id: 'ollama-local',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    allowLoopback: true,
    models: ['qwen2.5-3b-local'],
    dailyInputTokens: 0,
    dailyOutputTokens: 0,
  });
  assert.equal(zero.dailyInputTokens, 0, '0 must survive as a real ceiling, not be read as "unset"');
  assert.equal(zero.loopback, true);

  // 回环 provider 也可以有非零上限（本地模型不产生账单，但 token 仍可以被限制）。
  const metered = registry.register({
    id: 'ollama-local-2',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11435/v1',
    allowLoopback: true,
    models: ['qwen2.5-3b-local'],
    dailyInputTokens: 30000,
  });
  assert.equal(metered.dailyInputTokens, 30000);
  assert.equal(metered.dailyOutputTokens, null, 'an omitted output ceiling stays unset');
});

// ---------------------------------------------------------------------------
// 准入期：声明了预算就必须真的拦
// ---------------------------------------------------------------------------

test('P1-1g：声明了预算却没有预算端口 → broker 拒绝启动（不静默放过）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = createEndpointRegistry();
  registry.register({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
    dailyInputTokens: 30000,
  });
  const { store } = openTestStore(t);
  const error = thrownBy(() => createModelBroker({
    budgetPort: createEventStoreBudgetPort(store),
    resolveIdentity: identityFromIntent,
    registry,
    providerId: 'deepseek',
    modelId: MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
  }));
  assert.equal(error.code, 'ERR_BROKER_ADAPTER');
  assert.equal(error.details.reason, 'provider_budget_port_missing');
  assert.equal(error.details.provider_id, 'deepseek');
});

test('P1-1h：预算端口缺操作 → 启动失败（形状即契约）', () => {
  const full = {
    register() {},
    read() {},
    reserve() {},
    settle() {},
    settleUnknownAtUpperBound() {},
    voidReservation() {},
  };
  assert.equal(assertProviderBudgetPort(full), full);
  assert.deepEqual([...PROVIDER_BUDGET_OPERATIONS].sort(), Object.keys(full).sort());
  for (const missing of PROVIDER_BUDGET_OPERATIONS) {
    const partial = { ...full };
    delete partial[missing];
    const error = thrownBy(() => assertProviderBudgetPort(partial));
    assert.equal(error.code, 'ERR_BROKER_ADAPTER', missing);
    assert.equal(error.details.operation, missing);
  }
});

test('P1-1i：端点日预算耗尽 → 拒绝在预扣之前发生（零网络、零账本行）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = createEndpointRegistry();
  registry.register({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
    // 1 个输入 token 的日额度：任何真实请求都超过它。
    dailyInputTokens: 1,
  });
  const { store } = openTestStore(t);
  const ledger = createProviderBudgetLedger({ now: () => NOW });
  const harness = registryBroker(t, { store, registry, providerId: 'deepseek', providerBudgetPort: ledger });
  const analysis = seedAnalysis(store);

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysis.analysis_id)),
    'ERR_BROKER_BUDGET',
  );
  assert.equal(error.details.reason, 'provider_daily_input');
  assert.equal(error.details.provider_id, 'deepseek');
  assert.equal(provider.requests.length, 0, 'a provider-budget rejection must not reach the network');
  assert.equal(ledgerRows(store, analysis.analysis_id).length, 0, 'and must not reserve global budget');
  assert.equal(harness.broker.stats().provider_budget_rejections, 1);
});

test('P1-1j：输出预算不足单独归因，不被压成同一个 reason', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = createEndpointRegistry();
  registry.register({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
    // 输入给足、输出为 0：归因必须是 provider_daily_output。
    dailyInputTokens: 30000,
    dailyOutputTokens: 0,
  });
  const { store } = openTestStore(t);
  const ledger = createProviderBudgetLedger({ now: () => NOW });
  const harness = registryBroker(t, { store, registry, providerId: 'deepseek', providerBudgetPort: ledger });
  const analysis = seedAnalysis(store);
  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysis.analysis_id)),
    'ERR_BROKER_BUDGET',
  );
  assert.equal(error.details.reason, 'provider_daily_output');
  assert.equal(provider.requests.length, 0);
});

test('P1-1k：成功请求把真实用量记到端点账上（不是记在上界上）', async (t) => {
  const usage = { input_tokens: 21, output_tokens: 7 };
  const provider = await startMockProvider(okHandler({ usage }));
  t.after(() => provider.close());
  const registry = createEndpointRegistry();
  registry.register({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
    dailyInputTokens: 30000,
    dailyOutputTokens: 6000,
  });
  const { store } = openTestStore(t);
  const ledger = createProviderBudgetLedger({ now: () => NOW });
  const harness = registryBroker(t, { store, registry, providerId: 'deepseek', providerBudgetPort: ledger });
  const analysis = seedAnalysis(store);

  const before = ledger.read('deepseek');
  assert.equal(before.input_remaining, 30000);
  const result = await harness.broker.request(makeIntent(analysis.analysis_id));
  assert.equal(result.state, 'settled');

  const after = ledger.read('deepseek');
  assert.equal(after.input_spent, 21);
  assert.equal(after.output_spent, 7);
  assert.equal(after.input_remaining, 30000 - 21);
  assert.equal(after.output_remaining, 6000 - 7);
  assert.equal(after.day, '2026-11-04');
});

test('P1-1l：结果未知时端点账按上界结清（债务不外溢）', async (t) => {
  const provider = await startMockProvider(destroyHandler());
  t.after(() => provider.close());
  const registry = createEndpointRegistry();
  registry.register({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
    dailyInputTokens: 30000,
    dailyOutputTokens: 6000,
  });
  const { store } = openTestStore(t);
  const ledger = createProviderBudgetLedger({ now: () => NOW });
  const harness = registryBroker(t, { store, registry, providerId: 'deepseek', providerBudgetPort: ledger });
  const analysis = seedAnalysis(store);
  const intent = makeIntent(analysis.analysis_id);
  const upper = inputUpperOf(intent);

  await expectBrokerErrorAsync(harness.broker.request(intent), 'ERR_BROKER_UNKNOWN');
  const after = ledger.read('deepseek');
  assert.equal(after.input_spent, upper, 'an unknown outcome must be charged at the upper bound');
  assert.equal(after.input_reserved, 0, 'nothing may stay reserved after settlement');
});

test('P1-1m：预扣前取消 → 端点预留被释放，不占额度', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = createEndpointRegistry();
  registry.register({
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
    dailyInputTokens: 30000,
    dailyOutputTokens: 6000,
  });
  const { store } = openTestStore(t);
  const ledger = createProviderBudgetLedger({ now: () => NOW });
  const harness = registryBroker(t, { store, registry, providerId: 'deepseek', providerBudgetPort: ledger });
  const analysis = seedAnalysis(store);

  const controller = new AbortController();
  controller.abort();
  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysis.analysis_id), { signal: controller.signal }),
    'ERR_BROKER_CANCELLED',
  );
  const after = ledger.read('deepseek');
  assert.equal(after.input_spent, 0);
  assert.equal(after.input_reserved, 0);
  assert.equal(provider.requests.length, 0);
});

test('P1-1n：跨 UTC 日重置，昨天的账不会被带进今天', () => {
  let clock = NOW;
  const ledger = createProviderBudgetLedger({ now: () => clock });
  ledger.register('deepseek', { dailyInputTokens: 100, dailyOutputTokens: 100 });
  ledger.reserve({ provider_id: 'deepseek', request_id: 'r1', input_upper: 40, output_limit: 10 });
  ledger.settle({ request_id: 'r1', usage: { input_tokens: 40, output_tokens: 10 } });
  assert.equal(ledger.read('deepseek').input_remaining, 60);

  clock = NOW + 24 * 60 * 60 * 1000;
  const next = ledger.read('deepseek');
  assert.equal(next.day, '2026-11-05');
  assert.equal(next.input_remaining, 100);
  assert.equal(next.input_spent, 0);
});

test('P1-1o：未声明预算的 provider 不需要预算端口（由全局日预算约束）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = loopbackRegistry(provider);
  const { store } = openTestStore(t);
  const harness = registryBroker(t, { store, registry });
  const analysis = seedAnalysis(store);
  const result = await harness.broker.request(makeIntent(analysis.analysis_id));
  assert.equal(result.state, 'settled');
  assert.equal(provider.requests.length, 1);
});
