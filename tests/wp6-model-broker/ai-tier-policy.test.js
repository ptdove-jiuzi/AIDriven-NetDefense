/**
 * AI-ENABLE / tier — 交付 A①：**纯判据级**三档分级证明。
 *
 * 本文件不起网络、不开端口、不用任何 key：它只证明 `selectRoute` 这一个纯函数
 * 在真实配置形状下确实按 severity 切换 watch / triage / respond，
 * 并把三次判定的核心字段（tier / modelId / providerId / escalate / reason /
 * fingerprint / escalatedFrom）与**期望值**逐条对照。
 *
 * 配置来源是仓库里真实的 `deploy/config/model-routing.example.json`
 * （只读；本文件不改 deploy/**），经 `packages/policy/src/routing-config.js::
 * normalizeRoutingInput` 归一后喂给判据 —— 因此这条用例同时证明
 * 「示例配置 → 判据入参」的映射（含 `maxEscalationsPerHour` → `maxPerHour` 别名）。
 *
 * 一个必须写下来的判据事实（不是缺陷结论，是调用方契约）：
 * 当 severity **低于** `escalation.minSeverity` 时，`selectRoute` 返回
 * `E_SEVERITY_BELOW`（拒绝），**不是** `{ok:true, tier:'watch'}`。
 * 也就是说"低危走 watch"这件事在策略层是"不升级"的两种编码之一：
 * - 门槛内但不该升级（例如 minSeverity 下调到 low 后的 low/medium）→ ok + defaultTier；
 * - 门槛外 → 拒绝，由调用方决定"照常走默认 tier"。
 * 交付 B 的链路级复核要在假 provider 日志里证明调用方真的按后者回落，而不是把拒绝当断线。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ROUTE_CODES,
  ROUTE_REASONS,
  selectRoute,
  SEVERITY_RANK,
  TIERS,
} from '../../packages/policy/src/model-routing.js';
import { normalizeRoutingInput } from '../../packages/policy/src/routing-config.js';

/** 固定时钟值：判据不读时钟，`at` 由调用方给，因此用例可完全复盘。 */
const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);

/** 判据要求的 fingerprint 形态（本文件只做策略判定，不经过 broker 的字符集校验）。 */
const FINGERPRINT = 'tier-fp-0001';

/** 期望的三档模型 id（与 `deploy/config/model-routing.example.json` 一致）。 */
const TIER_MODEL = Object.freeze({
  watch: 'qwen2.5-3b-local',
  triage: 'deepseek-chat',
  respond: 'deepseek-reasoner',
});

const TIER_PROVIDER = Object.freeze({
  watch: 'ollama-local',
  triage: 'deepseek',
  respond: 'deepseek',
});

function readExampleConfig() {
  const path = new URL('../../deploy/config/model-routing.example.json', import.meta.url);
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

/** 一组"已产出结构化结论 + 带证据引用"的信号（升级的前置条件，ADR-0010 §2.5 第 2 条）。 */
function makeSignal(severity, overrides = {}) {
  return {
    severity,
    hasStructuredConclusion: true,
    evidenceRef: 'evidence://alert/tier-0001',
    fingerprint: FINGERPRINT,
    at: NOW,
    ...overrides,
  };
}

/** 一行对照表：期望 vs 实际。测试输出直接当证据用。 */
function row(label, expected, actual) {
  return {
    label,
    'expected tier': expected.tier,
    'actual tier': actual.ok === true ? actual.tier : `DENY:${actual.code}`,
    'expected model': expected.modelId,
    'actual model': actual.ok === true ? actual.modelId : null,
    escalate: actual.ok === true ? actual.escalate : null,
    reason: actual.ok === true ? actual.reason : actual.code,
  };
}

test('真实示例配置可归一成判据入参（别名 maxEscalationsPerHour → maxPerHour）', () => {
  const document = readExampleConfig();
  const normalized = normalizeRoutingInput(document);

  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  assert.equal(normalized.input.mode, 'tiered');
  assert.equal(normalized.input.defaultTier, 'watch');
  assert.equal(normalized.input.escalation.enabled, true);
  assert.equal(normalized.input.escalation.minSeverity, 'high');
  assert.equal(normalized.input.escalation.cooldownSeconds, 300);
  // 配置文件里写的是 maxEscalationsPerHour；判据只认 maxPerHour，必须在装载期归一。
  assert.equal(normalized.input.escalation.maxPerHour, 20);
  assert.deepEqual(normalized.input.models.map((model) => model.id), [
    TIER_MODEL.watch,
    TIER_MODEL.triage,
    TIER_MODEL.respond,
  ]);
});

test('同一份配置下调门槛到 low：三次不同输入 → 三个不同 tier 与三个不同模型', () => {
  const normalized = normalizeRoutingInput(readExampleConfig());
  assert.equal(normalized.ok, true, JSON.stringify(normalized));

  // 管理员把升级门槛从 high 下调到 low（settings-schema 允许 low..critical）之后，
  // "常态/升级"两条路径都能在一次配置里被走到：low 不升级 → watch。
  const input = {
    ...normalized.input,
    escalation: { ...normalized.input.escalation, minSeverity: 'low' },
  };

  const cases = [
    { severity: 'low', expectedTier: 'watch', expectedReason: ROUTE_REASONS.BELOW_ESCALATION_TIER, expectedEscalate: false },
    { severity: 'high', expectedTier: 'triage', expectedReason: ROUTE_REASONS.ESCALATED, expectedEscalate: true },
    { severity: 'critical', expectedTier: 'respond', expectedReason: ROUTE_REASONS.ESCALATED, expectedEscalate: true },
  ];

  const actuals = cases.map((item) => selectRoute({ ...input, signal: makeSignal(item.severity), recent: [] }));
  const table = cases.map((item, index) => row(item.severity, {
    tier: item.expectedTier,
    modelId: TIER_MODEL[item.expectedTier],
  }, actuals[index]));
  console.log('tier-table (minSeverity=low):\n%s', JSON.stringify(table, null, 2));

  cases.forEach((item, index) => {
    const actual = actuals[index];
    const where = `severity=${item.severity}: ${JSON.stringify(actual)}`;
    assert.equal(actual.ok, true, where);
    assert.equal(actual.mode, 'tiered', where);
    assert.equal(actual.tier, item.expectedTier, where);
    assert.equal(actual.modelId, TIER_MODEL[item.expectedTier], where);
    assert.equal(actual.providerId, TIER_PROVIDER[item.expectedTier], where);
    assert.equal(actual.escalate, item.expectedEscalate, where);
    assert.equal(actual.reason, item.expectedReason, where);
    assert.equal(actual.fingerprint, FINGERPRINT, where);
    // 不升级时 escalatedFrom 是显式 null；升级时是"从哪个 tier 升上来"。
    assert.equal(actual.escalatedFrom, item.expectedEscalate ? 'watch' : null, where);
  });

  // 三次判定的 tier 与 modelId 两两不同：这才是"真切换"，不是恒定输出。
  assert.equal(new Set(actuals.map((item) => item.tier)).size, 3);
  assert.equal(new Set(actuals.map((item) => item.modelId)).size, 3);
  assert.deepEqual(actuals.map((item) => item.tier), ['watch', 'triage', 'respond']);
});

test('默认门槛 high 下：low 是拒绝（E_SEVERITY_BELOW），不是 watch 路由 —— 调用方契约', () => {
  const normalized = normalizeRoutingInput(readExampleConfig());
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  const input = normalized.input;

  // 三次输入的期望 vs 实际：high/critical 与上面一致；low 在默认门槛下是**拒绝**。
  // 这就是交付 B 要复核的"链路必须把拒绝落回默认 tier 而不是当断线"的来源。
  const lowActual = selectRoute({ ...input, signal: makeSignal('low'), recent: [] });
  const highActual = selectRoute({ ...input, signal: makeSignal('high'), recent: [] });
  const criticalActual = selectRoute({ ...input, signal: makeSignal('critical'), recent: [] });
  console.log('tier-table (minSeverity=high, shipped defaults):\n%s', JSON.stringify([
    row('low', { tier: 'watch', modelId: TIER_MODEL.watch }, lowActual),
    row('high', { tier: 'triage', modelId: TIER_MODEL.triage }, highActual),
    row('critical', { tier: 'respond', modelId: TIER_MODEL.respond }, criticalActual),
  ], null, 2));

  assert.equal(lowActual.ok, false, JSON.stringify(lowActual));
  assert.equal(lowActual.code, ROUTE_CODES.SEVERITY_BELOW);
  assert.deepEqual(lowActual.detail, { severity: 'low', minSeverity: 'high' });
  assert.equal(lowActual.tier, undefined, 'a refusal must not carry a tier');

  assert.equal(highActual.ok, true, JSON.stringify(highActual));
  assert.equal(highActual.tier, 'triage');
  assert.equal(highActual.modelId, TIER_MODEL.triage);
  assert.equal(highActual.escalate, true);

  assert.equal(criticalActual.ok, true, JSON.stringify(criticalActual));
  assert.equal(criticalActual.tier, 'respond');
  assert.equal(criticalActual.modelId, TIER_MODEL.respond);
  assert.equal(criticalActual.escalate, true);

  // severity 偏序与 tier 顺序是公开契约的一部分：用例对它们做一次钉死。
  assert.deepEqual(TIERS, ['watch', 'triage', 'respond']);
  assert.deepEqual(
    Object.keys(SEVERITY_RANK),
    ['low', 'medium', 'high', 'critical'],
  );
});

test('判据是纯函数：同一输入两次结果相同、输入不被修改、结果冻结', () => {
  const normalized = normalizeRoutingInput(readExampleConfig());
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  const input = {
    ...normalized.input,
    escalation: { ...normalized.input.escalation, minSeverity: 'low' },
    signal: makeSignal('critical'),
    recent: [],
  };
  const before = JSON.stringify(input);

  const first = selectRoute(input);
  const second = selectRoute(input);

  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first, second, 'same input must produce the same decision');
  assert.equal(JSON.stringify(input), before, 'the judge must not mutate its input');
  assert.equal(Object.isFrozen(first), true);
  // 拒绝结果同样冻结：调用方改不动判据结论，只能如实搬运。
  const denied = selectRoute({
    ...input,
    escalation: { ...input.escalation, minSeverity: 'high' },
    signal: makeSignal('low'),
  });
  assert.equal(denied.ok, false);
  assert.equal(Object.isFrozen(denied), true);
  assert.equal(Object.isFrozen(denied.detail), true);
});

test('uniform 模式：三次不同 severity 走同一个模型（分级可被显式关闭，但不是关预算）', () => {
  const normalized = normalizeRoutingInput(readExampleConfig());
  assert.equal(normalized.ok, true, JSON.stringify(normalized));
  const input = {
    ...normalized.input,
    mode: 'uniform',
    uniformModelId: TIER_MODEL.triage,
  };

  const actuals = ['low', 'high', 'critical'].map((severity) => selectRoute({
    ...input,
    signal: makeSignal(severity),
    recent: [],
  }));
  console.log('uniform-table:\n%s', JSON.stringify(actuals.map((item) => ({
    tier: item.tier,
    modelId: item.modelId,
    escalate: item.escalate,
    reason: item.reason,
    hasEscalatedFrom: Object.hasOwn(item, 'escalatedFrom'),
  })), null, 2));

  for (const actual of actuals) {
    assert.equal(actual.ok, true, JSON.stringify(actual));
    assert.equal(actual.tier, 'triage');
    assert.equal(actual.modelId, TIER_MODEL.triage);
    assert.equal(actual.escalate, false);
    assert.equal(actual.reason, ROUTE_REASONS.UNIFORM);
    // §2.4.1 第 6 条：uniform 不产生 escalatedFrom —— 键不出现，不是出现 null。
    assert.equal(Object.hasOwn(actual, 'escalatedFrom'), false);
  }
});
