/**
 * ADR-0010 Provider Registry 验收用例。
 *
 * 这里固定的是**判据**，不是实现细节：
 * - ADR §4 第 1–4、8–10 条（属于 broker 的部分）；
 * - ADR §3.1 的三条阴性用例（注销失效 / 改一字符失效 / 形状伪造被拒）；
 * - ADR §3 的兼容性要求（单 provider 等价于注册表只有一项）。
 *
 * 第 5–7、11–14 条（tier 选择、升级冷却、uniform 模式）属于 `packages/policy`，
 * 不在本文件的断言范围；broker 只负责"已选定的 modelId + providerId 存在且端点有效"。
 *
 * 纪律：所有出网流量都打到 `127.0.0.1` 的动态端口 mock provider，
 * 不请求任何真实模型服务，也不写真实数据库路径。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import {
  MAX_REGISTERED_ENDPOINTS,
  assertEndpointActive,
  assertEndpointUnchanged,
  createEndpointRegistry,
  isEndpointActive,
  isResolvedEndpoint,
  listRegisteredEndpoints,
  registerEndpoint,
  resetEndpointRegistry,
  unregisterEndpoint,
} from '../../apps/model-broker/src/endpoint.js';
import {
  createHarness,
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

/** mock provider 的 ADR 形态 baseUrl（前缀），不是完整请求路径。 */
function baseUrlOf(provider) {
  return `http://127.0.0.1:${provider.port}/v1`;
}

/**
 * 取回被抛出的错误（`assert.throws` 只断言、不返回对象，而这里要检查 details）。
 * 顺带把"该抛没抛"变成一条明确的失败信息。
 */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw, but it returned normally');
  return null;
}

function registryWith(overrides = {}) {
  const registry = createEndpointRegistry();
  registry.register({
    id: overrides.id ?? 'local',
    baseUrl: overrides.baseUrl,
    kind: overrides.kind ?? 'openai-compatible',
    allowLoopback: overrides.allowLoopback ?? true,
    models: overrides.models ?? [MODEL_ID],
    credentialRef: overrides.credentialRef ?? 'cred://test/local',
  });
  return registry;
}

/**
 * 组装一个"走注册表入口"的 broker：除端点来源外，其余全是生产路径
 * （真实 event-store 适配器 + 真实 HTTP 传输 + mock provider）。
 */
function createRegistryBroker(t, options = {}) {
  const store = options.store ?? openTestStore(t).store;
  const port = options.port ?? createEventStoreBudgetPort(
    store,
    options.policy === undefined ? {} : { policy: options.policy },
  );
  const credential = options.credential === undefined
    ? new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' })
    : options.credential;
  const logs = options.logs ?? createLogSink();
  const broker = createModelBroker({
    budgetPort: port,
    resolveIdentity: identityFromIntent,
    registry: options.registry,
    providerId: options.providerId ?? 'local',
    modelId: options.modelId ?? MODEL_ID,
    credential,
    limits: options.limits,
    timeoutMs: options.timeoutMs,
    logger: logs,
    now: options.now,
  });
  return {
    store,
    broker,
    port,
    credential,
    logs,
  };
}

// ---------------------------------------------------------------------------
// 注册表机制
// ---------------------------------------------------------------------------

test('REG-1：保存期冻结 {scheme, host, port, pathPrefix}，brand 运行期不可改', async () => {
  const registry = createEndpointRegistry();
  const brand = registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    credentialRef: 'cred://deepseek/default',
  });

  assert.equal(brand.scheme, 'https');
  assert.equal(brand.host, 'api.deepseek.com');
  assert.equal(brand.port, '443');
  assert.equal(brand.pathPrefix, '/v1');
  // baseUrl 是前缀，真正要打的是"前缀 + 常量后缀"，两者都在保存期算好。
  assert.equal(brand.requestPath, '/v1/chat/completions');
  assert.equal(brand.requestUrl, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(isResolvedEndpoint(brand), true);
  assert.equal(Object.isFrozen(brand), true);
  assert.throws(() => {
    brand.host = 'evil.example';
  }, TypeError, 'a frozen brand must not be mutable');
  assert.equal(brand.host, 'api.deepseek.com');

  // 同 id + 同冻结目标 = 幂等（配置重载不该炸）；同 id + 不同目标必须显式 replace。
  const again = registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1/',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    credentialRef: 'cred://deepseek/default',
  });
  assert.equal(again, brand, 'the same frozen target must be idempotent');
  const duplicate = thrownBy(() => registry.register({
    id: 'deepseek',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.co/v1',
  }));
  assert.equal(duplicate.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(duplicate.details.reason, 'duplicate_id');

  // 审计视图只给指针，不含任何秘密。
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].credentialRef, 'cred://deepseek/default');
  assert.equal(JSON.stringify(listed).includes('Bearer'), false);
});

test('REG-2：最多 8 个 provider，第 9 个被拒；注销后可再注册', async () => {
  assert.equal(MAX_REGISTERED_ENDPOINTS, 8);
  const registry = createEndpointRegistry();
  for (let index = 0; index < 8; index += 1) {
    registry.register({ id: `p${index}`, baseUrl: `https://h${index}.example/v1`, models: [MODEL_ID] });
  }
  assert.equal(registry.size, 8);
  const full = thrownBy(() => registry.register({ id: 'p8', baseUrl: 'https://h8.example/v1', models: [MODEL_ID] }));
  assert.equal(full.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(full.details.reason, 'capacity');
  assert.equal(full.details.capacity, 8);

  assert.equal(registry.unregister('p0'), true);
  assert.equal(registry.size, 7);
  assert.ok(registry.register({ id: 'p8', baseUrl: 'https://h8.example/v1', models: [MODEL_ID] }));
  assert.equal(registry.unregister('p0'), false, 'unregistering an unknown id reports nothing was removed');
});

test('REG-3：id 必须匹配 [a-z0-9-]{2,32}，且不可改名', async () => {
  const registry = createEndpointRegistry();
  for (const id of ['a', 'A1', 'ab_c', 'a b', 'x'.repeat(33), '', 42, null]) {
    assert.throws(
      () => registry.register({ id, baseUrl: 'https://host.example/v1', models: [MODEL_ID] }),
      (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
      `provider id ${JSON.stringify(id)} must be rejected`,
    );
  }
  registry.register({ id: 'ollama-local', baseUrl: 'http://127.0.0.1:11434/v1', allowLoopback: true, models: [MODEL_ID] });
  // 合法改动（换端口）走 replace，并且旧 brand 必须失效。
  const oldBrand = registry.get('ollama-local');
  const newBrand = registry.replace('ollama-local', {
    baseUrl: 'http://127.0.0.1:11435/v1',
    allowLoopback: true,
    models: [MODEL_ID],
  });
  assert.equal(newBrand.port, '11435');
  assert.equal(isEndpointActive(oldBrand), false);
  // 改名视为新增：replace 带着不同的 id 必须被拒，不能"顺便把 id 换掉"。
  const rename = thrownBy(() => registry.replace('ollama-local', {
    id: 'ollama-2',
    baseUrl: 'http://127.0.0.1:11434/v1',
    allowLoopback: true,
  }));
  assert.equal(rename.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(rename.details.reason, 'rename_forbidden');
});

test('ADR §4-1：保存 https://api.deepseek.com/v1 成功；非回环 http 一律失败', async () => {
  const registry = createEndpointRegistry();
  assert.ok(registry.register({ id: 'deepseek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }));
  for (const [baseUrl, allowLoopback] of [
    ['http://api.deepseek.com/v1', false],
    ['http://api.deepseek.com/v1', true],
    ['http://10.0.0.5:8080/v1', true],
    ['http://192.168.1.52:8188/v1', true],
  ]) {
    assert.throws(
      () => registry.register({ id: 'bad', baseUrl, allowLoopback }),
      (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
      `${baseUrl} (allowLoopback=${allowLoopback}) must be rejected: https is mandatory off-loopback`,
    );
  }
});

test('ADR §4-2：回环 http 需要 allowLoopback=true，且只接受字面量回环地址', async () => {
  const registry = createEndpointRegistry();
  const loopback = registry.register({
    id: 'ollama-local',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    allowLoopback: true,
    models: ['qwen2.5-3b-local'],
  });
  assert.equal(loopback.scheme, 'http');
  assert.equal(loopback.host, '127.0.0.1');
  assert.equal(loopback.port, '11434');
  assert.equal(loopback.loopback, true);
  assert.equal(loopback.requestPath, '/v1/chat/completions');

  assert.throws(
    () => registry.register({ id: 'ollama-2', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', allowLoopback: false }),
    (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
    'allowLoopback=false must reject plain http even on loopback',
  );
  // `localhost` 的解析结果取决于 hosts/DNS：明文场景仍只认字面量地址（从严，见状态文件）。
  assert.throws(
    () => registry.register({ id: 'ollama-3', kind: 'ollama', baseUrl: 'http://localhost:11434/v1', allowLoopback: true }),
    (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
  );
  // 官方适配器指向回环没有合法用途。
  assert.throws(
    () => registry.register({ id: 'deepseek', kind: 'deepseek', baseUrl: 'http://127.0.0.1:11434/v1', allowLoopback: true }),
    (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
  );
  // https + localhost 是允许的（那是加密链路，不存在明文外带问题）。
  assert.ok(registry.register({ id: 'local-tls', baseUrl: 'https://localhost:8443/v1' }));
});

test('ADR §4-3：userinfo / query / hash 一律拒绝', async () => {
  const registry = createEndpointRegistry();
  const cases = [
    ['https://user:pass@host.example/v1', false],
    ['https://user@host.example/v1', false],
    ['https://host.example/v1?x=1', false],
    ['https://host.example/v1#a', false],
    ['http://127.0.0.1:11434/v1?x=1', true],
    ['http://user@127.0.0.1:11434/v1', true],
    ['http://127.0.0.1:11434/v1#frag', true],
  ];
  for (const [baseUrl, allowLoopback] of cases) {
    assert.throws(
      () => registry.register({ id: 'candidate', baseUrl, allowLoopback }),
      (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
      `${baseUrl} must be rejected`,
    );
  }
  assert.equal(registry.size, 0, 'a rejected registration must not leave an entry behind');
});

// ---------------------------------------------------------------------------
// ADR §3.1 三条阴性用例
// ---------------------------------------------------------------------------

test('§3.1-3：形状与 brand 完全相同的普通对象被拒（brand 不是形状校验）', async (t) => {
  const registry = createEndpointRegistry();
  const brand = registry.register({ id: 'local', baseUrl: 'https://host.example/v1', models: [MODEL_ID] });

  const shaped = { ...brand };
  const cloned = structuredClone(brand);
  for (const forged of [shaped, cloned, Object.create(brand), new Proxy(brand, {})]) {
    assert.equal(isResolvedEndpoint(forged), false, 'only brands issued by the resolver may pass');
    assert.throws(
      () => assertEndpointActive(forged),
      (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
    );
    assert.throws(() => registry.assertActive(forged), (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT');
  }

  // 一个"看起来像注册表"的假注册表交回伪造 brand：broker 构造必须失败。
  const store = openTestStore(t).store;
  const fakeRegistry = {
    resolve: () => shaped,
    assertActive: () => true,
  };
  assert.throws(
    () => createModelBroker({
      budgetPort: createEventStoreBudgetPort(store),
      resolveIdentity: identityFromIntent,
      registry: fakeRegistry,
      providerId: 'local',
      modelId: MODEL_ID,
      credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test' }),
    }),
    (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
  );
});

test('§3.1-2：把注册表里的 host 改一个字符，旧 brand 立刻失效', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const before = registry.get('local');
  const { store } = openTestStore(t);
  const harness = createRegistryBroker(t, { store, registry });
  const first = seedAnalysis(store);
  await harness.broker.request(makeIntent(first.analysis_id));
  assert.equal(provider.requests.length, 1);

  // 只改一个字符（端口不同 = 不同 host:port 组合），旧 brand 必须失效。
  const changedPort = provider.port === 65535 ? provider.port - 1 : provider.port + 1;
  const after = registry.replace('local', {
    baseUrl: `http://127.0.0.1:${changedPort}/v1`,
    allowLoopback: true,
    models: [MODEL_ID],
  });
  assert.notEqual(after, before);
  assert.equal(before.port, String(provider.port));
  assert.equal(after.port, String(changedPort));

  assert.equal(isEndpointActive(before), false);
  const error = thrownBy(() => assertEndpointActive(before));
  assert.equal(error.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(error.details.reason, 'endpoint_revoked');
  assert.throws(
    () => assertEndpointUnchanged(before, before.requestUrl),
    (thrown) => thrown.code === 'ERR_BROKER_ENDPOINT',
  );

  // 旧 brand 的 broker 不能再发出任何请求：这是"绑定冻结结果，不是绑定形状"的证明。
  const second = seedAnalysis(store);
  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(second.analysis_id)),
    'ERR_BROKER_ENDPOINT',
  );
  assert.equal(provider.requests.length, 1, 'a revoked brand must not reach the provider');
  assert.equal(ledgerRows(store, second.analysis_id).length, 0, 'a revoked brand must not reserve budget');
});

test('§3.1-1：注销 provider 后，同一 brand 的请求立即失败（不靠缓存续用）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const { store } = openTestStore(t);
  const harness = createRegistryBroker(t, { store, registry });

  const first = seedAnalysis(store);
  const ok = await harness.broker.request(makeIntent(first.analysis_id));
  assert.equal(ok.state, 'settled');
  assert.equal(provider.requests.length, 1);
  assert.equal(ledgerRows(store, first.analysis_id).length, 1);

  assert.equal(registry.unregister('local'), true);
  assert.equal(registry.get('local'), null);

  const second = seedAnalysis(store);
  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(second.analysis_id)),
    'ERR_BROKER_ENDPOINT',
  );
  assert.equal(error.details.reason, 'endpoint_revoked');
  assert.equal(provider.requests.length, 1, 'no request may leave after the provider was unregistered');
  assert.equal(ledgerRows(store, second.analysis_id).length, 0);

  // 重新注册一个新 id 也不能让旧 brand 复活：brand 绑定的是记录身份，不是 host。
  const again = registry.register({ id: 'local2', baseUrl: baseUrlOf(provider), allowLoopback: true, models: [MODEL_ID] });
  assert.notEqual(again, undefined);
  assert.equal(isEndpointActive(harness.broker.endpoint), false);
});

// ---------------------------------------------------------------------------
// ADR §4 第 4、8、9、10 条（broker 侧切片）
// ---------------------------------------------------------------------------

test('ADR §4-4：端点返回 302 时不跟随，跳转目标收到 0 个请求', async (t) => {
  const target = await startMockProvider(okHandler());
  t.after(() => target.close());
  const redirector = await startMockProvider(({ res }) => {
    res.writeHead(302, { location: target.url });
    res.end();
  });
  t.after(() => redirector.close());

  const registry = registryWith({ baseUrl: baseUrlOf(redirector), models: [MODEL_ID] });
  const { store } = openTestStore(t);
  const harness = createRegistryBroker(t, { store, registry });
  const { analysis_id: analysisId } = seedAnalysis(store);

  const error = await expectBrokerErrorAsync(harness.broker.request(makeIntent(analysisId)), 'ERR_BROKER_UNKNOWN');
  assert.equal(error.details.reason, 'redirect_refused');
  assert.equal(redirector.requests.length, 1, 'exactly one request to the frozen endpoint');
  assert.equal(target.requests.length, 0, 'the redirect target must never be contacted');
  // 债务保留（按上界结清），不是"没成功就退款"。
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(Number(row.settled_input), Number(row.input_upper));
});

test('ADR §4-8：respond provider 不可达时该路由失败关闭，watch 路由继续服务', async (t) => {
  const watchProvider = await startMockProvider(okHandler());
  t.after(() => watchProvider.close());
  const watchRegistry = registryWith({ id: 'ollama-local', baseUrl: baseUrlOf(watchProvider), models: [MODEL_ID] });
  const respondRegistry = createEndpointRegistry();
  // 端口 1 上没有监听：连接立即失败（不是超时，所以用例不需要等待）。
  respondRegistry.register({
    id: 'deepseek',
    baseUrl: 'http://127.0.0.1:1/v1',
    allowLoopback: true,
    models: ['deepseek-reasoner'],
  });

  const { store } = openTestStore(t);
  const watch = createRegistryBroker(t, { store, registry: watchRegistry, providerId: 'ollama-local' });
  const respond = createRegistryBroker(t, {
    store,
    registry: respondRegistry,
    providerId: 'deepseek',
    modelId: 'deepseek-reasoner',
  });

  const responded = seedAnalysis(store);
  await expectBrokerErrorAsync(
    respond.broker.request(makeIntent(responded.analysis_id)),
    'ERR_BROKER_UNKNOWN',
  );

  // watch 仍在跑：broker 侧的 degraded 切片就是"一个路由坏了不拖垮另一个"。
  const watched = seedAnalysis(store);
  const result = await watch.broker.request(makeIntent(watched.analysis_id));
  assert.equal(result.state, 'settled');
  assert.equal(watchProvider.requests.length, 1);
  assert.equal(watch.broker.circuit().state, 'closed');
});

test('ADR §4-9：日预算耗尽 / 网络失败 / 鉴权失败三种错误码可区分', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const unauthorized = await startMockProvider(statusHandler(401));
  t.after(() => unauthorized.close());

  const budgetStore = openTestStore(t).store;
  const budgetHarness = createRegistryBroker(t, {
    store: budgetStore,
    registry: registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] }),
    // 日预算为 0：这不是"额度紧张"，是"今天一分钱都不许花"。
    policy: { dailyInputTokens: 0, dailyOutputTokens: 0 },
  });
  const budgetAnalysis = seedAnalysis(budgetStore);
  const budgetError = await expectBrokerErrorAsync(
    budgetHarness.broker.request(makeIntent(budgetAnalysis.analysis_id)),
    'ERR_BROKER_BUDGET',
  );
  assert.equal(provider.requests.length, 0, 'a budget rejection must not reach the network');

  const networkStore = openTestStore(t).store;
  const unreachable = createEndpointRegistry();
  unreachable.register({
    id: 'local',
    baseUrl: 'http://127.0.0.1:1/v1',
    allowLoopback: true,
    models: [MODEL_ID],
  });
  const networkHarness = createRegistryBroker(t, { store: networkStore, registry: unreachable });
  const networkAnalysis = seedAnalysis(networkStore);
  const networkError = await expectBrokerErrorAsync(
    networkHarness.broker.request(makeIntent(networkAnalysis.analysis_id)),
    'ERR_BROKER_UNKNOWN',
  );

  const authStore = openTestStore(t).store;
  const authHarness = createRegistryBroker(t, {
    store: authStore,
    registry: registryWith({ baseUrl: baseUrlOf(unauthorized), models: [MODEL_ID] }),
  });
  const authAnalysis = seedAnalysis(authStore);
  const authError = await expectBrokerErrorAsync(
    authHarness.broker.request(makeIntent(authAnalysis.analysis_id)),
    'ERR_BROKER_PROVIDER',
  );
  assert.equal(authError.details.reason, 'provider_auth');
  assert.equal(authHarness.broker.circuit().state, 'open', 'an auth failure must open the circuit immediately');

  const codes = new Set([budgetError.code, networkError.code, authError.code]);
  assert.equal(codes.size, 3, `budget/network/auth must be distinguishable, got ${[...codes].join(', ')}`);
});

test('ADR §4-10：同一 provider 的用量逐条求和与账本一致（±0）', async (t) => {
  const usage = { input_tokens: 21, output_tokens: 7 };
  const provider = await startMockProvider(okHandler({ usage }));
  t.after(() => provider.close());
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const { store } = openTestStore(t);
  const harness = createRegistryBroker(t, { store, registry });

  const analyses = [seedAnalysis(store), seedAnalysis(store), seedAnalysis(store)];
  const results = [];
  for (const analysis of analyses) {
    results.push(await harness.broker.request(makeIntent(analysis.analysis_id)));
  }

  assert.equal(provider.requests.length, 3);
  const reportedInput = results.reduce((sum, item) => sum + item.usage.input_tokens, 0);
  const reportedOutput = results.reduce((sum, item) => sum + item.usage.output_tokens, 0);
  const rows = ledgerRows(store);
  const ledgerInput = rows.reduce((sum, row) => sum + Number(row.settled_input ?? 0), 0);
  const ledgerOutput = rows.reduce((sum, row) => sum + Number(row.settled_output ?? 0), 0);
  assert.equal(reportedInput, ledgerInput);
  assert.equal(reportedOutput, ledgerOutput);
  assert.equal(reportedInput, usage.input_tokens * 3);
  // 日志里能按 provider/model 归集（ADR §2.7 可观测），且不含正文。
  const sent = harness.logs.events.filter((event) => event.event === 'request.sent');
  assert.equal(sent.length, 3);
  assert.ok(sent.every((event) => event.provider_id === 'local' && event.model_id === MODEL_ID));
});

// ---------------------------------------------------------------------------
// 选择校验、兼容性与运行时约束
// ---------------------------------------------------------------------------

test('SEL-1：只接受已选定的 providerId+modelId，未注册即拒绝（不做 tier 选择）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const { store } = openTestStore(t);
  const budgetPort = createEventStoreBudgetPort(store);
  const base = {
    budgetPort,
    resolveIdentity: identityFromIntent,
    registry,
    modelId: MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test' }),
  };

  const unknownProvider = thrownBy(() => createModelBroker({ ...base, providerId: 'nope' }));
  assert.equal(unknownProvider.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(unknownProvider.details.reason, 'provider_unknown');

  const unknownModel = thrownBy(() => createModelBroker({ ...base, providerId: 'local', modelId: 'gpt-5-other' }));
  assert.equal(unknownModel.code, 'ERR_BROKER_ROUTE');
  assert.equal(unknownModel.details.reason, 'model_not_registered');

  assert.throws(
    () => createModelBroker({ ...base, providerId: 'local', modelId: '' }),
    (thrown) => thrown.code === 'ERR_BROKER_ROUTE',
  );

  // provider 未声明任何模型：broker 不能"猜一个"。
  const bare = createEndpointRegistry();
  bare.register({ id: 'local', baseUrl: baseUrlOf(provider), allowLoopback: true });
  const noModels = thrownBy(() => createModelBroker({ ...base, registry: bare, providerId: 'local' }));
  assert.equal(noModels.code, 'ERR_BROKER_ROUTE');
  assert.equal(noModels.details.reason, 'provider_declares_no_models');

  // 合法选择：路由定死，运行期只能读。
  const broker = createModelBroker({ ...base, providerId: 'local' });
  assert.deepEqual(broker.route, {
    providerId: 'local',
    modelId: MODEL_ID,
    scheme: 'http',
    host: '127.0.0.1',
    port: String(provider.port),
    pathPrefix: '/v1',
  });
  assert.equal(Object.isFrozen(broker.route), true);
});

test('RT-1：请求期不接受任何 URL 覆盖', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const { store } = openTestStore(t);
  const harness = createRegistryBroker(t, { store, registry });
  const { analysis_id: analysisId } = seedAnalysis(store);

  // 调用方把"看起来像端点"的参数塞进两层：请求体与调用选项。
  const intent = {
    ...makeIntent(analysisId),
    baseUrl: 'http://attacker.example/v1',
    endpoint: 'http://attacker.example/v1/chat/completions',
    url: 'http://attacker.example/v1/chat/completions',
  };
  const result = await harness.broker.request(intent, {
    endpointUrl: 'http://attacker.example/v1/chat/completions',
    url: 'http://attacker.example/v1/chat/completions',
    host: 'attacker.example',
  });

  assert.equal(result.state, 'settled');
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].url, '/v1/chat/completions', 'the frozen request path is the only target');
  assert.equal(provider.requests[0].headers.host, `127.0.0.1:${provider.port}`);
  assert.equal(harness.broker.route.host, '127.0.0.1');
  assert.equal(harness.broker.endpoint.host, '127.0.0.1');
});

test('RT-2：代理环境变量被忽略，请求直连注册端点', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const { store } = openTestStore(t);
  const harness = createRegistryBroker(t, { store, registry });

  const saved = {};
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const key of keys) saved[key] = process.env[key];
  try {
    // 指向一个必然连不上的"代理"：真被用上就不可能成功。
    for (const key of keys) process.env[key] = 'http://127.0.0.1:1';
    const { analysis_id: analysisId } = seedAnalysis(store);
    const result = await harness.broker.request(makeIntent(analysisId));
    assert.equal(result.state, 'settled');
    assert.equal(provider.requests.length, 1, 'the request must go straight to the registered endpoint');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('COMPAT-1：单 provider 配置等价于「注册表只有一项」，旧接口行为不变', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const { store } = openTestStore(t);

  // 旧路径：没有注册表，只有一个固定端点（等价于注册表一项）。
  const legacy = createHarness(t, { store, provider });
  const legacyAnalysis = seedAnalysis(store);
  const legacyResult = await legacy.broker.request(makeIntent(legacyAnalysis.analysis_id));
  assert.equal(legacyResult.state, 'settled');
  assert.equal(legacy.broker.route.providerId, 'legacy');
  assert.equal(legacy.broker.route.pathPrefix, '/v1/messages');
  assert.equal(legacy.broker.endpoint.requestUrl, provider.url);

  // 注册表只有一项：同一 provider、同一凭据、同一条预算/传输路径。
  const registry = registryWith({ baseUrl: baseUrlOf(provider), models: [MODEL_ID] });
  const single = createRegistryBroker(t, { store, registry });
  const singleAnalysis = seedAnalysis(store);
  const singleResult = await single.broker.request(makeIntent(singleAnalysis.analysis_id));
  assert.equal(singleResult.state, 'settled');
  assert.equal(single.broker.route.host, legacy.broker.route.host);
  assert.equal(single.broker.route.port, legacy.broker.route.port);
  assert.equal(single.broker.route.modelId, legacy.broker.route.modelId);

  assert.equal(provider.requests.length, 2);
  assert.deepEqual(
    provider.requests.map((request) => request.url),
    ['/v1/messages', '/v1/chat/completions'],
    'legacy posts the exact URL; registry posts prefix + frozen suffix',
  );
  // 两条路径都必须过 brand 检查（不是一个"旧的形状校验"分支）。
  assert.equal(isResolvedEndpoint(legacy.broker.endpoint), true);
  assert.equal(isResolvedEndpoint(single.broker.endpoint), true);
});

test('COMPAT-2：默认注册表的模块级入口可用，注销立即生效', async () => {
  try {
    const brand = registerEndpoint({
      id: 'default-table',
      baseUrl: 'http://127.0.0.1:11434/v1',
      kind: 'ollama',
      allowLoopback: true,
      models: ['qwen2.5-3b-local'],
    });
    assert.equal(isResolvedEndpoint(brand), true);
    assert.equal(isEndpointActive(brand), true);
    assert.equal(listRegisteredEndpoints().some((entry) => entry.id === 'default-table'), true);

    assert.equal(unregisterEndpoint('default-table'), true);
    assert.equal(isEndpointActive(brand), false);
    assert.equal(listRegisteredEndpoints().some((entry) => entry.id === 'default-table'), false);
  } finally {
    resetEndpointRegistry();
  }
});
