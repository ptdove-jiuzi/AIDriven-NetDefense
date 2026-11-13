/**
 * REV-CMD-D 第 2 轮独立复核（round2）—— 全部由复核员自写，不采信 R5 侦察与
 * `status/MODEL-ROUTING-FIX2.md` 的"6 条 P1 已闭合"声称。
 *
 * 覆盖：
 *  - P1-1..P1-6 逐条独立复验（每组注释里写明"原始声称"与"我的判据"）；
 *  - 必查攻击面：客户端指定模型 / 升级账本伪造重放 / 预算配额数值攻击 /
 *    回退链与重试 / 凭据存储 / redaction / 并发竞态。
 *
 * 纪律：所有出网流量只打 `127.0.0.1` 动态端口 mock provider 或注入的假 transport；
 * 不连外网、不使用真实 API key（凭据一律 `TEST_FIXTURE_KEY` 一次性串）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { resolveLimits } from '../../apps/model-broker/src/policy.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import {
  createCredentialStore,
  CREDENTIAL_STORE_CODES,
  fingerprintOf,
  maskOf,
} from '../../apps/model-broker/src/credential-store.js';
import { createEndpointRegistry } from '../../apps/model-broker/src/endpoint.js';
import { createProviderBudgetLedger } from '../../apps/model-broker/src/endpoint-budget.js';
import { createEscalationLedger } from '../../apps/model-broker/src/escalation-ledger.js';
import { scanSecrets } from '../../apps/model-broker/src/redaction.js';
import { ProviderTransportError, TRANSPORT_FAILURES } from '../../apps/model-broker/src/transport.js';
import { ESCALATION_TIER_BY_SEVERITY, HOUR_MS, ROUTE_CODES, selectRoute } from '../../packages/policy/src/model-routing.js';
import { ROUTING_CONFIG_CODES, normalizeRoutingInput } from '../../packages/policy/src/routing-config.js';
import {
  createLogSink,
  expectBrokerErrorAsync,
  identityFromIntent,
  ledgerRows,
  makeIntent,
  makeTempDir,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
  statusHandler,
  TEST_FIXTURE_KEY,
} from './helpers.js';

const MODEL_ID = 'deepseek-chat';
const NOW = Date.UTC(2026, 10, 4, 2, 0, 0);

/** 一个无条件成功的判定输入（tiered，critical + evidenceRef）。 */
function routeInput(overrides = {}) {
  return {
    mode: 'tiered',
    uniformModelId: null,
    defaultTier: 'watch',
    models: [
      { id: 'watch-model', providerId: 'local', tier: 'watch' },
      { id: 'triage-model', providerId: 'local', tier: 'triage' },
      { id: 'respond-model', providerId: 'remote', tier: 'respond' },
    ],
    signal: {
      severity: 'critical',
      hasStructuredConclusion: true,
      evidenceRef: 'evidence://alert/1',
      fingerprint: 'fp-a',
      at: NOW,
    },
    escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 },
    recent: [],
    ...overrides,
  };
}

function baseUrlOf(provider) {
  return `http://127.0.0.1:${provider.port}/v1`;
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

function escalationDecision(overrides = {}) {
  return { tier: 'triage', fingerprint: 'fp-a', decision: 'severity-escalation', escalatedFrom: 'watch', ...overrides };
}

function eventsOf(logs, name) {
  return logs.events.filter((event) => event.event === name);
}

function brokerHarness(t, options = {}) {
  const store = options.store ?? openTestStore(t).store;
  const logs = options.logs ?? createLogSink();
  const broker = createModelBroker({
    budgetPort: options.port ?? createEventStoreBudgetPort(store),
    resolveIdentity: identityFromIntent,
    registry: options.registry ?? registryWith(options.provider ?? { port: 9 }, options.registryOverrides),
    providerId: 'local',
    modelId: MODEL_ID,
    credential: new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' }),
    transport: options.transport,
    logger: logs,
    now: options.now ?? (() => NOW),
    timeoutMs: options.timeoutMs,
    limits: options.limits,
    providerBudgetPort: options.providerBudgetPort,
    escalationLedger: options.escalationLedger,
  });
  return { store, broker, logs };
}

// ===========================================================================
// P1-1 原始声称：每端点预算被 register() 静默丢弃 → 声称"已修"
//      我的判据：预算字段必须冻结进 brand 并在准入时真的拦；拼错/负数必须报错；
//      声明了预算却没有预算端口必须拒绝启动。
// ===========================================================================

test('P1-1R：端点预算冻结进 brand，拼错键与负数额度在注册期报错', () => {
  const registry = createEndpointRegistry();
  const brand = registry.register({
    id: 'local',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9/v1',
    allowLoopback: true,
    models: [MODEL_ID],
    dailyInputTokens: 30000,
    dailyOutputTokens: null,
  });
  assert.equal(brand.dailyInputTokens, 30000, 'declared budget must be frozen into the brand, not dropped');

  const token = (fn) => {
    try {
      fn();
      return null;
    } catch (error) {
      return error;
    }
  };
  const typo = token(() => registry.register({
    id: 'x2', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', allowLoopback: true,
    models: [MODEL_ID], dailyInTokens: 5,
  }));
  assert.equal(typo?.code, 'ERR_BROKER_ENDPOINT');
  assert.equal(typo?.details?.reason, 'unknown_field', 'a misspelled budget key must not be silently ignored');

  const negative = token(() => registry.register({
    id: 'x3', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', allowLoopback: true,
    models: [MODEL_ID], dailyInputTokens: -1,
  }));
  assert.equal(negative?.code, 'ERR_BROKER_ENDPOINT', 'a negative cap must be rejected at registration');
});

test('P1-1R：端点日预算超限时在预扣前拒绝（零网络、零全局账本行）', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const store = openTestStore(t).store;
  const providerBudgetPort = createProviderBudgetLedger();
  providerBudgetPort.register('local', { dailyInputTokens: 10, dailyOutputTokens: null });

  const { broker } = brokerHarness(t, {
    store,
    provider,
    registryOverrides: { dailyInputTokens: 10 },
    providerBudgetPort,
  });
  const analysis = seedAnalysis(store);
  const error = await expectBrokerErrorAsync(
    broker.request(makeIntent(analysis.analysis_id)),
    'ERR_BROKER_BUDGET',
  );
  assert.equal(error.details.reason, 'provider_daily_input', 'the rejection must be attributable to the endpoint cap');
  assert.equal(provider.requests.length, 0, 'an endpoint-budget rejection must happen before the network');
  assert.equal(ledgerRows(store, analysis.analysis_id).length, 0, 'it must also happen before the global reservation');
});

test('P1-1R：声明了端点预算却不给预算端口 → broker 拒绝启动', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const store = openTestStore(t).store;
  let thrown = null;
  try {
    brokerHarness(t, { store, provider, registryOverrides: { dailyInputTokens: 30000 } });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'a broker that cannot enforce a declared cap must not start');
  assert.equal(thrown.code, 'ERR_BROKER_ADAPTER');
});

// ===========================================================================
// P1-2 原始声称：evidenceRef 无落点 → 声称"已修"
// ===========================================================================

test('P1-2R：critical/high 无 evidenceRef 拒绝升级；带 ref 才升级', () => {
  const missing = selectRoute(routeInput({ signal: { ...routeInput().signal, evidenceRef: undefined } }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, ROUTE_CODES.NO_STRUCTURED_CONCLUSION);
  assert.equal(missing.detail.reason, 'evidence_ref_missing');

  for (const blank of [null, '', '   ']) {
    const result = selectRoute(routeInput({ signal: { ...routeInput().signal, evidenceRef: blank } }));
    assert.equal(result.ok, false, JSON.stringify(blank));
    assert.equal(result.detail.reason, 'evidence_ref_missing');
  }

  const accepted = selectRoute(routeInput());
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.tier, ESCALATION_TIER_BY_SEVERITY.critical);
  assert.equal(accepted.escalate, true);
  assert.equal(accepted.escalatedFrom, 'watch');
});

test('P1-2R：畸形 evidenceRef 报 E_MODE_INVALID；证据判定先于冷却判定', () => {
  for (const bad of [42, 'a\nb', 'x'.repeat(513), {}]) {
    const result = selectRoute(routeInput({ signal: { ...routeInput().signal, evidenceRef: bad } }));
    assert.equal(result.ok, false, String(bad).slice(0, 8));
    assert.equal(result.code, ROUTE_CODES.MODE_INVALID);
  }
  // 同时存在"冷却命中"与"缺证据"时必须先报证据（ADR §2.5 判据顺序）。
  const both = selectRoute(routeInput({
    signal: { ...routeInput().signal, evidenceRef: undefined },
    recent: [{ fingerprint: 'fp-a', at: NOW - 1000 }],
  }));
  assert.equal(both.code, ROUTE_CODES.NO_STRUCTURED_CONCLUSION, 'evidence must be judged before cooldown');
});

// ===========================================================================
// P1-3 原始声称：按请求字段缺一半 + §4-10 假绿 → 声称"已修（含失败路径结算）"
// ===========================================================================

test('P1-3R：成功路径 request.sent 字段齐全，request.settled 与账本逐条求和 ±0', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const store = openTestStore(t).store;
  const { broker, logs } = brokerHarness(t, { store, provider });
  const analysis = seedAnalysis(store);

  const result = await broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision() });
  assert.equal(result.state, 'settled');

  const [sent] = eventsOf(logs, 'request.sent');
  for (const key of ['tier', 'fingerprint', 'decision', 'escalated_from', 'provider_id', 'model_id']) {
    assert.equal(Object.hasOwn(sent, key), true, `${key} must exist on request.sent`);
  }
  assert.equal(sent.tier, 'triage');
  assert.equal(sent.escalated_from, 'watch');

  const [settled] = eventsOf(logs, 'request.settled');
  assert.equal(settled.usage_source, 'provider');
  // 成功路径报的是**提供方真实用量**，不是上界（上界只在失败/缺失 usage 路径报）。
  assert.equal(settled.input_tokens, result.usage.input_tokens);
  assert.equal(settled.output_tokens, result.usage.output_tokens);
  assert.notEqual(settled.input_tokens, sent.input_upper, 'a real usage value must not be replaced by the upper bound');

  const rows = ledgerRows(store, analysis.analysis_id).filter((row) => String(row.state) === 'settled');
  const ledgerInput = rows.reduce((sum, row) => sum + Number(row.settled_input ?? 0), 0);
  assert.ok(ledgerInput > 0, 'the ledger must have booked a real amount, otherwise equality is vacuous');
  assert.equal(settled.input_tokens, ledgerInput, 'log sum must equal ledger sum (±0) on the success path');
});

test('P1-3R：已发送后断连，失败路径也发 request.settled，日志=账本（非空）', async (t) => {
  const store = openTestStore(t).store;
  const logs = createLogSink();
  let calls = 0;
  const { broker } = brokerHarness(t, {
    store,
    logs,
    transport: {
      send: async () => {
        calls += 1;
        throw new ProviderTransportError(TRANSPORT_FAILURES.NETWORK, 'socket reset after send');
      },
    },
  });
  const analysis = seedAnalysis(store);
  await expectBrokerErrorAsync(
    broker.request(makeIntent(analysis.analysis_id), { routing: escalationDecision() }),
    'ERR_BROKER_UNKNOWN',
  );
  assert.equal(calls, 1, 'exactly one send attempt: no automatic retry');
  const [sent] = eventsOf(logs, 'request.sent');
  const [settled] = eventsOf(logs, 'request.settled');
  assert.ok(settled, 'the failure path must still emit a settlement record (ADR §4-10)');
  assert.equal(settled.usage_source, 'upper_bound');
  assert.equal(settled.input_tokens, sent.input_upper);
  assert.equal(settled.tier, 'triage');
  assert.equal(settled.escalated_from, 'watch');

  const rows = ledgerRows(store, analysis.analysis_id).filter((row) => String(row.state) === 'settled');
  const ledgerInput = rows.reduce((sum, row) => sum + Number(row.settled_input ?? 0), 0);
  assert.ok(ledgerInput > 0);
  assert.equal(settled.input_tokens, ledgerInput, 'log sum must equal ledger sum (±0) on the failure path too');
});

// ===========================================================================
// P1-5 原始声称：配置面字段名不一致 → 声称"已修"
// ===========================================================================

test('P1-5R：出厂示例配置原样可归一，且能喂进判据得到升级', () => {
  const document = JSON.parse(fs.readFileSync('deploy/config/model-routing.example.json', 'utf8'));
  const normalized = normalizeRoutingInput(document);
  assert.equal(normalized.ok, true, JSON.stringify(normalized).slice(0, 300));
  assert.equal(normalized.input.escalation.maxPerHour, 20, 'maxEscalationsPerHour must alias to maxPerHour=20');
  assert.equal(normalized.input.mode, document.routing.mode);
  // 归一结果必须真的能被判据接受（否则"示例配置可装载"是空话）。
  const routed = selectRoute({
    ...normalized.input,
    signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'evidence://x', fingerprint: 'fp-a', at: NOW },
    recent: [],
  });
  assert.equal(routed.ok, true, JSON.stringify(routed).slice(0, 300));
  assert.equal(routed.escalate, true);
});

test('P1-5R：两种拼法并存报 E_CONFIG_INVALID；未知键报字段路径；空 models[] 装载期被拒（R5-004 修复）', () => {
  const base = {
    routing: {
      mode: 'tiered',
      escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxEscalationsPerHour: 20 },
    },
    models: [{ id: 'watch-model', providerId: 'local', tier: 'watch' }],
  };
  const both = normalizeRoutingInput({
    ...base,
    routing: { ...base.routing, escalation: { ...base.routing.escalation, maxPerHour: 5 } },
  });
  assert.equal(both.ok, false, 'declaring both spellings must be rejected, never resolved by precedence');
  assert.match(String(both.code), /CONFIG_INVALID|INVALID/, `${both.code}`);
  assert.ok(ROUTING_CONFIG_CODES !== undefined);

  const unknown = normalizeRoutingInput({
    ...base,
    routing: { ...base.routing, escalation: { ...base.routing.escalation, unknownKnob: true } },
  });
  assert.equal(unknown.ok, false);
  assert.ok(String(unknown.detail?.field ?? '').includes('escalation'), JSON.stringify(unknown.detail));

  // R5-004 修复后反向：旧断言确认"装载期仍接受 models: []"（缺陷），现在必须拒绝。
  const empty = normalizeRoutingInput({ ...base, models: [] });
  assert.equal(empty.ok, false, 'empty models[] must be rejected at load time (R5-004 fixed)');
  assert.equal(empty.detail.field, 'models');
});

// ===========================================================================
// P1-6 原始声称：recent 无生产者 → 声称"已修"
// ===========================================================================

test('P1-6R：只有真的升级过才写账本；账本喂回判据后冷却真的拦', async (t) => {
  const provider = await startMockProvider(okHandler());
  t.after(() => provider.close());
  const store = openTestStore(t).store;
  const escalationLedger = createEscalationLedger({ now: () => NOW });
  const { broker } = brokerHarness(t, { store, provider, escalationLedger });

  // 非升级（escalated_from=null / 无决策）不写账本。
  await broker.request(makeIntent(seedAnalysis(store).analysis_id));
  await broker.request(makeIntent(seedAnalysis(store).analysis_id), {
    routing: { tier: 'watch', fingerprint: 'fp-n', decision: 'below-escalation-tier' },
  });
  assert.equal(escalationLedger.size, 0, 'only a real escalation may be recorded');

  await broker.request(makeIntent(seedAnalysis(store).analysis_id), { routing: escalationDecision() });
  assert.equal(escalationLedger.size, 1);

  const recent = escalationLedger.recent(NOW);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].fingerprint, 'fp-a');
  const blocked = selectRoute(routeInput({ recent }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, ROUTE_CODES.COOLDOWN, 'the ledger必须真的能拦住第二次升级');

  // 冷却之外（+6 分钟）且 maxPerHour=1 → 小时上限拦住。
  const capped = selectRoute(routeInput({
    recent,
    signal: { ...routeInput().signal, at: NOW + 6 * 60 * 1000 },
    escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 1 },
  }));
  assert.equal(capped.ok, false);
  assert.equal(capped.code, ROUTE_CODES.HOURLY_CAP);
});

test('P1-6R：账本拒绝畸形指纹，且有界淘汰只影响最早记录（伪造/截断面）', () => {
  const ledger = createEscalationLedger({ now: () => NOW, maxEntries: 2 });
  let thrown = null;
  try {
    ledger.record('fp\ninjected');
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'a fingerprint with a newline must not be recorded (log injection surface)');
  assert.equal(ledger.size, 0);

  ledger.record('fp-a', NOW);
  ledger.record('fp-b', NOW);
  ledger.record('fp-c', NOW);
  assert.equal(ledger.size, 2, 'bounded ledger drops the oldest entry');
  const recent = ledger.recent(NOW);
  assert.deepEqual(recent.map((entry) => entry.fingerprint), ['fp-b', 'fp-c']);
  // 未来时间戳同样计入窗口（时钟回拨不能成为绕过限流的口子）。
  assert.equal(ledger.recent(NOW - HOUR_MS).length, 2);
});

// ===========================================================================
// 攻击面 1：客户端/请求头能否指定或影响模型选择
// ===========================================================================

test('ATK-1：请求体自报的 model 与已锁定模型不一致 → 出网前拒绝；一致则实际发送的是锁定模型', async (t) => {
  const store = openTestStore(t).store;
  const sentBodies = [];
  const { broker } = brokerHarness(t, {
    store,
    transport: {
      send: async ({ body }) => {
        sentBodies.push(JSON.parse(body));
        return { status: 200, content: 'ok', usage: { input_tokens: 11, output_tokens: 3 }, model: MODEL_ID };
      },
    },
  });
  const mismatch = await expectBrokerErrorAsync(
    broker.request(makeIntent(seedAnalysis(store).analysis_id, { model: 'attacker/expensive' })),
    'ERR_BROKER_ROUTE',
  );
  assert.equal(sentBodies.length, 0, 'a model override must never reach the network');
  assert.ok(mismatch);

  // 请求期任何 URL / 模型覆盖选项都必须被忽略（RT-1）。
  await broker.request(makeIntent(seedAnalysis(store).analysis_id), {
    endpointUrl: 'http://127.0.0.1:1/v1',
    endpoint: 'http://127.0.0.1:1/v1',
    model: 'attacker/expensive',
    providerId: 'evil',
  });
  assert.equal(sentBodies.length, 1, 'the locked route must still be the one used');
  assert.equal(sentBodies[0].model, MODEL_ID, 'the outbound model is the construction-time model, never the request value');
});

test('ATK-1：路由决策字段的注入面（大小写/分隔符/换行/伪造 escalatedFrom）在出网前拒绝', async (t) => {
  const store = openTestStore(t).store;
  const { broker } = brokerHarness(t, {
    store,
    transport: { send: async () => ({ status: 200, content: 'ok', usage: { input_tokens: 5, output_tokens: 2 }, model: MODEL_ID }) },
  });
  const bad = [
    escalationDecision({ escalatedFrom: 'triage' }),
    escalationDecision({ escalatedFrom: 'respond' }),
    escalationDecision({ fingerprint: 'fp-a,fp-b' }),
    escalationDecision({ fingerprint: 'FP-A\nX-Injected: 1' }),
    escalationDecision({ decision: 'severity-escalation x-model: evil' }),
    escalationDecision({ tier: 'TRIAGE' }),
  ];
  for (const routing of bad) {
    const analysis = seedAnalysis(store);
    await expectBrokerErrorAsync(
      broker.request(makeIntent(analysis.analysis_id), { routing }),
      'ERR_BROKER_INPUT',
    );
    assert.equal(ledgerRows(store, analysis.analysis_id).length, 0, 'no reservation may happen for a malformed decision');
  }
});

// ===========================================================================
// 攻击面 3：预算/配额数值攻击 + 跨日结清
// ===========================================================================

test('ATK-3：NaN / Infinity / 负数 / 小数 / 超大值都不能绕过端点预算', () => {
  const ledger = createProviderBudgetLedger({ now: () => NOW });
  ledger.register('local', { dailyInputTokens: 100, dailyOutputTokens: 100 });
  const reserve = (id, inputUpper) => {
    try {
      ledger.reserve({ provider_id: 'local', request_id: id, input_upper: inputUpper, output_limit: 1 });
      return null;
    } catch (error) {
      return error;
    }
  };
  for (const value of [NaN, Infinity, -1, 1.5, '10', null, undefined]) {
    const error = reserve(`r-${String(value)}`, value);
    assert.ok(error, `input_upper=${String(value)} must be rejected`);
    assert.equal(error.code, 'ERR_BROKER_ADAPTER', `input_upper=${String(value)}`);
  }
  const overflow = reserve('r-over', Number.MAX_SAFE_INTEGER);
  assert.equal(overflow?.code, 'ERR_BROKER_BUDGET', 'a huge ceiling must be rejected by the cap, not overflow past it');
  // request_id 复用（重放预留）必须拒绝，避免同一笔额度被记两次。
  assert.equal(reserve('r-ok', 10), null);
  assert.equal(reserve('r-ok', 10)?.code, 'ERR_BROKER_ADAPTER');
});

test('ATK-3：跨日 prune 后结清旧预留不再重建负 reserved 桶，且**不**放大当日可用额度（R5-011 修复）', () => {
  let clock = NOW;
  const ledger = createProviderBudgetLedger({ now: () => clock, keepDays: 1 });
  ledger.register('local', { dailyInputTokens: 1000, dailyOutputTokens: null });
  const day = 24 * 60 * 60 * 1000;
  ledger.reserve({ provider_id: 'local', request_id: 'old', input_upper: 400, output_limit: 1 });

  // 5 天后，制造足够多的新桶把旧日桶挤出 prune 窗口。
  clock = NOW + 5 * day;
  for (let index = 0; index < 12; index += 1) {
    ledger.register(`p${index}`, { dailyInputTokens: 1000, dailyOutputTokens: null });
    ledger.read(`p${index}`);
  }
  ledger.reserve({ provider_id: 'local', request_id: 'new', input_upper: 1, output_limit: 1 });
  // 旧日桶已经被 prune；结清旧预留会落在一个被重建的空桶上。
  ledger.settleUnknownAtUpperBound({ request_id: 'old' });

  const today = ledger.read('local');
  assert.equal(today.day.slice(0, 10), new Date(clock).toISOString().slice(0, 10));
  assert.equal(today.input_reserved, 1, 'today’s bucket is untouched by the stale settlement');
  assert.equal(today.input_remaining, 999, 'the daily quota is NOT inflated → R5-08 ③ 的配额放大不成立（仅剩记账残留）');

  // R5-011 修复后反向：旧断言确认"重建桶带负 reserved"（缺陷），现在必须钳到 0。
  clock = NOW;
  const stale = ledger.read('local');
  assert.equal(stale.input_reserved, 0, 'a re-created stale bucket must not carry a negative reservation (R5-011 fixed)');
  assert.equal(stale.input_spent, 400);
  // R5-011 修复后：reserved 被钳到 0，remaining 如实反映"已花 400"（不再是"净额为零"的假象）。
  assert.equal(stale.input_remaining, 600, 'remaining must reflect the settled spend, not a negative-reserved offset');
});

// ===========================================================================
// 攻击面 4：回退链 / 无限重试 / 失败后降级 / 超时后仍计费
// ===========================================================================

test('ATK-4：失败不重试、不降级到更弱端点，且已发送失败按上界保留债务', async (t) => {
  const store = openTestStore(t).store;
  const logs = createLogSink();
  let hits = 0;
  const { broker } = brokerHarness(t, {
    store,
    logs,
    transport: {
      send: async () => {
        hits += 1;
        throw new ProviderTransportError(TRANSPORT_FAILURES.NETWORK, 'reset');
      },
    },
  });
  const analysis = seedAnalysis(store);
  await expectBrokerErrorAsync(broker.request(makeIntent(analysis.analysis_id)), 'ERR_BROKER_UNKNOWN');
  assert.equal(hits, 1, 'maxRetries is 0: exactly one attempt, no fallback endpoint');
  const rows = ledgerRows(store, analysis.analysis_id).filter((row) => String(row.state) === 'settled');
  assert.equal(rows.length, 1, 'the debt must be settled at the upper bound, not voided');
  assert.ok(Number(rows[0].settled_input) > 0);
  assert.equal(broker.route.providerId, 'local', 'the route is still the construction-time provider');
});

test('ATK-4：超时是真 abort，且超时同样按上界计费（不是免费）', async (t) => {
  const store = openTestStore(t).store;
  const logs = createLogSink();
  const { broker } = brokerHarness(t, {
    store,
    logs,
    timeoutMs: 60,
    transport: {
      send: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new ProviderTransportError(TRANSPORT_FAILURES.ABORTED, 'aborted'));
        });
      }),
    },
  });
  const analysis = seedAnalysis(store);
  const error = await expectBrokerErrorAsync(broker.request(makeIntent(analysis.analysis_id)), 'ERR_BROKER_TIMEOUT');
  assert.equal(error.code, 'ERR_BROKER_TIMEOUT');
  const [settled] = eventsOf(logs, 'request.settled');
  assert.ok(settled, 'a timed-out request must still be settled in the log');
  assert.equal(settled.usage_source, 'upper_bound');
  const rows = ledgerRows(store, analysis.analysis_id).filter((row) => String(row.state) === 'settled');
  assert.equal(rows.length, 1, 'timeout must not void the reservation');
});

test('ATK-4：连续可重试失败熔断后，后续请求在预扣前被拒（零账本行）', async (t) => {
  const store = openTestStore(t).store;
  let hits = 0;
  const { broker } = brokerHarness(t, {
    store,
    // 每次已发送失败都会按上界结清（output_limit 记满），把 output_limit 收窄到 5，
    // 否则 5 次失败本身就会先吃光当日 output 预算，导致熔断阈值永远到不了（见报告「观察」）。
    limits: resolveLimits({ maxOutputTokens: 5 }),
    transport: {
      send: async () => {
        hits += 1;
        throw new ProviderTransportError(TRANSPORT_FAILURES.NETWORK, 'reset');
      },
    },
  });
  for (let index = 0; index < 5; index += 1) {
    await expectBrokerErrorAsync(broker.request(makeIntent(seedAnalysis(store).analysis_id)), 'ERR_BROKER_UNKNOWN');
  }
  assert.equal(broker.circuit().state, 'open', 'five consecutive retryable failures must open the circuit');
  const analysis = seedAnalysis(store);
  const before = hits;
  await expectBrokerErrorAsync(broker.request(makeIntent(analysis.analysis_id)), 'ERR_BROKER_CIRCUIT_OPEN');
  assert.equal(hits, before, 'an open circuit must fail before any network action');
  assert.equal(ledgerRows(store, analysis.analysis_id).length, 0, 'and before any reservation');
});

// ===========================================================================
// 攻击面 5：凭据存储（路径穿越 / 符号链接 / 明文落盘 / 掩码）
// ===========================================================================

test('ATK-5：providerId 路径穿越被拒；明文落盘（R5-04 独立确认）；掩码不含完整密钥', (t) => {
  const dataDir = makeTempDir(t, 'round2-cred');
  const store = createCredentialStore({ dataDir });
  for (const evil of ['../evil', '..\\evil', '../../etc/passwd', 'a/b', 'LOCAL', 'x']) {
    let thrown = null;
    try {
      store.putCredential(evil, 'canary-secret-CANARY-123456');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `providerId=${JSON.stringify(evil)} must be rejected`);
    assert.equal(thrown.code, CREDENTIAL_STORE_CODES.PROVIDER_INVALID);
  }
  store.putCredential('local', 'canary-secret-CANARY-123456');
  const slot = store.slotPath('local');
  assert.ok(fs.existsSync(slot), 'the slot file must exist inside the data dir');
  const onDisk = fs.readFileSync(slot, 'utf8');
  assert.ok(
    onDisk.includes('canary-secret-CANARY-123456'),
    'R5-04 confirmed: the provider secret is stored in plaintext (no DPAPI/keyring) — reported as residual, not silently accepted',
  );
  const info = store.maskedInfo('local');
  assert.equal(info.masked, maskOf('canary-secret-CANARY-123456'));
  assert.equal(info.fingerprint, fingerprintOf('canary-secret-CANARY-123456'));
  assert.equal(info.masked.includes('canary-secret'), false, 'the mask must not carry the whole secret');
  assert.equal(JSON.stringify(info).includes('canary-secret'), false);
});

test('ATK-5：凭据槽是符号链接时拒绝读取/写入（本机无权限则如实 SKIP）', (t) => {
  const dataDir = makeTempDir(t, 'round2-symlink');
  const store = createCredentialStore({ dataDir });
  store.putCredential('local', 'canary-secret-CANARY-123456');
  const slot = store.slotPath('local');
  const link = path.join(dataDir, 'link.json');
  let linked = false;
  let symlinkCode = null;
  try {
    fs.symlinkSync(slot, link, 'file');
    linked = true;
  } catch (error) {
    symlinkCode = error.code;
    assert.ok(
      error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN',
      `unexpected symlink failure: ${error.code}`,
    );
  }
  if (!linked) {
    t.diagnostic(`SKIP 符号链接攻击面：本机普通账户无法创建符号链接（${symlinkCode}），与 SKIP-02 同因`);
    return;
  }
  fs.rmSync(slot);
  fs.symlinkSync(path.join(dataDir, 'target.json'), slot, 'file');
  assert.equal(store.hasCredential('local'), false, 'a symlinked slot must read as "no credential"');
  let thrown = null;
  try {
    store.putCredential('local', 'another-canary-123456');
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.code, CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE);
});

// ===========================================================================
// 攻击面 6：redaction —— 错误/日志是否泄漏 apiKey，扫描器覆盖缺口
// ===========================================================================

test('ATK-6：scanSecrets 覆盖 Authorization/apiKey/Bearer，且裸 key= / token= / URL 凭据 / hf_ 也已覆盖（R5-009 修复）', () => {
  for (const hit of [
    'Authorization: Bearer sk-abc123456789',
    'apiKey=sk-abc123456789',
    'x-api-key: sk-abc123456789',
    'password=hunter2',
    'cookie: session=abc',
  ]) {
    assert.ok(scanSecrets(hit).length > 0, `expected a hit for ${hit}`);
  }
  // R5-009 修复后反向：旧断言确认这些形态"漏检"（缺陷），现在必须命中。
  for (const hit of ['key=abc123', 'token=abc123', 'https://user:pass@host/v1', 'https://h/v1?key=zzz', 'hf_abcdefghijklmnop']) {
    assert.ok(
      scanSecrets(hit).length > 0,
      `R5-009 fixed: scanSecrets must now catch ${hit}`,
    );
  }
});

test('ATK-6：broker 的错误对象不回显凭据、不泄漏带 query 的完整 URL', async (t) => {
  const store = openTestStore(t).store;
  const { broker } = brokerHarness(t, {
    store,
    transport: {
      send: async () => {
        throw new ProviderTransportError(TRANSPORT_FAILURES.STATUS, 'upstream rejected', { status: 401 });
      },
    },
  });
  const error = await expectBrokerErrorAsync(
    broker.request(makeIntent(seedAnalysis(store).analysis_id)),
    'ERR_BROKER_PROVIDER',
  );
  const serialized = `${error.message} ${JSON.stringify(error.details ?? {})}`;
  assert.equal(serialized.includes(TEST_FIXTURE_KEY), false, 'the error must never echo the api key');
  assert.equal(/%2F|\?key=|Authorization/i.test(serialized), false, 'no request URL/header may be echoed');
  // 凭据对象自身也不能被序列化出明文。
  const credential = new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test-fixture' });
  assert.equal(JSON.stringify(credential).includes(TEST_FIXTURE_KEY), false);
  assert.equal(String(credential).includes(TEST_FIXTURE_KEY), false);
});

// ===========================================================================
// 攻击面 7：并发 —— 同一 fingerprint 并发升级是否绕过冷却
// ===========================================================================

test('ATK-7：并发同 fingerprint 升级被准入串行化，冷却不再被并发放大（R5-005 修复）', async (t) => {
  const store = openTestStore(t).store;
  const logs = createLogSink();
  const escalationLedger = createEscalationLedger({ now: () => NOW });
  const { broker } = brokerHarness(t, {
    store,
    logs,
    escalationLedger,
    transport: {
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: 200, content: 'ok', usage: { input_tokens: 9, output_tokens: 2 }, model: MODEL_ID };
      },
    },
  });

  // T0：两个请求在账本还是空的时候同时判据通过（这就是冷却的读-写窗口）。
  const decisions = [0, 1].map(() => selectRoute(routeInput({ recent: escalationLedger.recent(NOW) })));
  for (const decision of decisions) assert.equal(decision.ok, true, JSON.stringify(decision));

  const outcomes = await Promise.allSettled([
    broker.request(makeIntent(seedAnalysis(store).analysis_id), { routing: escalationDecision() }),
    broker.request(makeIntent(seedAnalysis(store).analysis_id), { routing: escalationDecision() }),
  ]);
  // R5-005 修复后反向：旧断言确认"两个并发升级都被记账"（缺陷），现在只允许一个。
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.details?.reason, 'escalation_in_flight');
  assert.equal(escalationLedger.size, 1, 'only one concurrent escalation may be recorded (R5-005 fixed)');
  assert.equal(eventsOf(logs, 'request.sent').length, 1);

  // 顺序重放：同样的第二次判据在账本有记录后被冷却拦住。
  const replay = selectRoute(routeInput({ recent: escalationLedger.recent(NOW) }));
  assert.equal(replay.ok, false);
  assert.equal(replay.code, ROUTE_CODES.COOLDOWN, 'sequential replay is blocked, concurrent arrival is not');
});
