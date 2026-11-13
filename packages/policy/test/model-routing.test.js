/**
 * ADR-0010 §2.4 / §2.4.1 / §2.5 判据的回归测试。
 *
 * 这些用例刻意做成**能红**：每一条都断言一个具体的结果字段或错误码，去掉对应判据就会失败。
 * 断言"容器里有东西"或"结果是对象"这类永真写法在这里一律不用 —— 那只是给绿灯拍照。
 *
 * 时间全部由 `signal.at` 给出，不读时钟：`new Date(...)` 在这里出现就等于判据不纯。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ESCALATION_TIER_BY_SEVERITY,
  HOUR_MS,
  ROUTE_CODES,
  ROUTE_REASONS,
  ROUTING_MODES,
  SEVERITY_RANK,
  TIERS,
  selectRoute,
} from '../src/model-routing.js';

/** 固定的"现在"，避免任何用例依赖真实时间。 */
const NOW = Date.UTC(2026, 10, 4, 2, 0, 0);

const MODELS = [
  { id: 'local-7b', providerId: 'ollama-local', tier: 'watch', maxInputTokens: 4096, maxOutputTokens: 512 },
  { id: 'mid-32b', providerId: 'ollama-local', tier: 'triage', maxInputTokens: 8192, maxOutputTokens: 1024 },
  { id: 'deepseek-chat', providerId: 'deepseek', tier: 'respond', maxInputTokens: 12288, maxOutputTokens: 2000 },
];

function baseInput(overrides = {}) {
  return {
    mode: 'tiered',
    uniformModelId: null,
    defaultTier: 'watch',
    models: MODELS.map((model) => ({ ...model })),
    signal: {
      severity: 'high',
      hasStructuredConclusion: true,
      // ADR-0010 §2.5 第 2 条：结构化结论**并附带 evidenceRef**。没有它不许升级。
      evidenceRef: 'ev-fp-a',
      fingerprint: 'fp-a',
      at: NOW,
    },
    escalation: {
      enabled: true,
      minSeverity: 'high',
      cooldownSeconds: 300,
      maxPerHour: 20,
    },
    recent: [],
    ...overrides,
  };
}

function inputWithoutModelTier(tier) {
  return baseInput({ models: MODELS.filter((model) => model.tier !== tier).map((model) => ({ ...model })) });
}

describe('code table is closed', () => {
  it('declares exactly the contract error codes', () => {
    assert.deepEqual(
      Object.values(ROUTE_CODES).sort(),
      [
        'E_COOLDOWN',
        'E_HOURLY_CAP',
        'E_MODEL_NOT_FOUND',
        'E_MODE_INVALID',
        'E_NO_STRUCTURED_CONCLUSION',
        'E_NO_UNIFORM_MODEL',
        'E_SEVERITY_BELOW',
        'E_TIER_UNAVAILABLE',
      ],
    );
  });

  it('declares the three tiers and a strict severity order', () => {
    assert.deepEqual([...TIERS], ['watch', 'triage', 'respond']);
    assert.deepEqual([...ROUTING_MODES], ['tiered', 'uniform']);
    assert.ok(SEVERITY_RANK.low < SEVERITY_RANK.medium);
    assert.ok(SEVERITY_RANK.medium < SEVERITY_RANK.high);
    assert.ok(SEVERITY_RANK.high < SEVERITY_RANK.critical);
    assert.equal(ESCALATION_TIER_BY_SEVERITY.high, 'triage');
    assert.equal(ESCALATION_TIER_BY_SEVERITY.critical, 'respond');
  });
});

describe('uniform mode (ADR-0010 §2.4.1)', () => {
  it('routes every severity to the uniform model with escalate=false', () => {
    for (const severity of ['low', 'medium', 'high', 'critical']) {
      const result = selectRoute(baseInput({
        mode: 'uniform',
        uniformModelId: 'mid-32b',
        signal: { severity, hasStructuredConclusion: false, fingerprint: 'fp-a', at: NOW },
      }));
      assert.equal(result.ok, true, `${severity}: ${JSON.stringify(result)}`);
      assert.equal(result.mode, 'uniform');
      assert.equal(result.tier, 'triage', 'tier is the model declared tier, not an escalation target');
      assert.equal(result.modelId, 'mid-32b');
      assert.equal(result.providerId, 'ollama-local');
      assert.equal(result.escalate, false);
      assert.equal(result.reason, 'uniform-mode');
    }
  });

  it('ignores cooldown and hourly cap even with a full recent window', () => {
    const recent = Array.from({ length: 50 }, (_, index) => ({
      fingerprint: 'fp-a',
      at: NOW - index * 1000,
    }));
    const result = selectRoute(baseInput({
      mode: 'uniform',
      uniformModelId: 'deepseek-chat',
      signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW },
      escalation: { enabled: true, minSeverity: 'critical', cooldownSeconds: 3600, maxPerHour: 1 },
      recent,
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.modelId, 'deepseek-chat');
    assert.equal(result.escalate, false);
  });

  it('rejects a missing uniformModelId with E_NO_UNIFORM_MODEL', () => {
    for (const value of [null, undefined, '']) {
      const result = selectRoute(baseInput({ mode: 'uniform', uniformModelId: value }));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'E_NO_UNIFORM_MODEL', `value=${String(value)}`);
    }
  });

  it('rejects a uniformModelId absent from models[] with E_NO_UNIFORM_MODEL', () => {
    const result = selectRoute(baseInput({ mode: 'uniform', uniformModelId: 'gpt-not-configured' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_NO_UNIFORM_MODEL');
    assert.equal(result.detail.uniformModelId, 'gpt-not-configured');
  });

  it('never silently falls back to tiered when uniform is misconfigured', () => {
    const result = selectRoute(baseInput({ mode: 'uniform', uniformModelId: null }));
    assert.equal(result.ok, false);
    assert.equal(Object.hasOwn(result, 'tier'), false, 'a failed route must not carry a tier');
    assert.equal(Object.hasOwn(result, 'modelId'), false);
  });
});

describe('low severity does not escalate (ADR-0010 §2.5 第 1 条)', () => {
  it('rejects severity below the default threshold', () => {
    for (const severity of ['low', 'medium']) {
      const result = selectRoute(baseInput({ signal: { severity, hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW } }));
      assert.equal(result.ok, false, severity);
      assert.equal(result.code, 'E_SEVERITY_BELOW');
      assert.equal(result.detail.severity, severity);
      assert.equal(result.detail.minSeverity, 'high');
    }
  });

  it('stays at the default tier when the threshold is lowered to medium', () => {
    const result = selectRoute(baseInput({
      signal: { severity: 'medium', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW },
      escalation: { enabled: true, minSeverity: 'medium', cooldownSeconds: 300, maxPerHour: 20 },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tier, 'watch');
    assert.equal(result.modelId, 'local-7b');
    assert.equal(result.escalate, false);
    assert.equal(result.reason, ROUTE_REASONS.BELOW_ESCALATION_TIER);
  });

  it('stays at watch when escalation is explicitly disabled, whatever the severity', () => {
    const result = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW },
      escalation: { enabled: false, minSeverity: 'critical', cooldownSeconds: 300, maxPerHour: 20 },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tier, 'watch');
    assert.equal(result.escalate, false);
    assert.equal(result.reason, ROUTE_REASONS.ESCALATION_DISABLED);
  });
});

describe('escalation by severity (ADR-0010 §2.5)', () => {
  it('escalates high to triage', () => {
    const result = selectRoute(baseInput({ signal: { severity: 'high', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.mode, 'tiered');
    assert.equal(result.tier, 'triage');
    assert.equal(result.modelId, 'mid-32b');
    assert.equal(result.providerId, 'ollama-local');
    assert.equal(result.escalate, true);
    assert.equal(result.reason, 'severity-escalation');
  });

  it('escalates critical to respond', () => {
    const result = selectRoute(baseInput({ signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-b', at: NOW } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tier, 'respond');
    assert.equal(result.modelId, 'deepseek-chat');
    assert.equal(result.providerId, 'deepseek');
    assert.equal(result.escalate, true);
  });

  it('rejects a structured-conclusion-less signal with E_NO_STRUCTURED_CONCLUSION', () => {
    const result = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: false, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_NO_STRUCTURED_CONCLUSION');
    assert.equal(result.detail.fingerprint, 'fp-a');
  });

  it('checks the severity gate before the structured-conclusion gate', () => {
    const result = selectRoute(baseInput({
      signal: { severity: 'low', hasStructuredConclusion: false, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(result.code, 'E_SEVERITY_BELOW', 'first failing check wins');
  });
});

describe('evidenceRef belongs to the escalation contract (ADR-0010 §2.5 第 2 条)', () => {
  it('refuses a critical escalation that carries no evidenceRef', () => {
    const input = baseInput({ signal: { severity: 'critical', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW } });
    assert.equal(Object.hasOwn(input.signal, 'evidenceRef'), false, 'fixture must really omit the field');
    const result = selectRoute(input);
    assert.equal(result.ok, false, 'no evidence means no escalation, whatever the severity');
    assert.equal(result.code, 'E_NO_STRUCTURED_CONCLUSION');
    assert.equal(result.detail.reason, 'evidence_ref_missing');
    assert.equal(result.detail.severity, 'critical');
    assert.equal(Object.hasOwn(result, 'tier'), false, 'a denied escalation must not name a tier');
  });

  it('refuses the triage escalation too, not only respond', () => {
    const result = selectRoute(baseInput({
      signal: { severity: 'high', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_NO_STRUCTURED_CONCLUSION');
    assert.equal(result.detail.reason, 'evidence_ref_missing');
  });

  it('treats null, empty and blank refs as missing', () => {
    // 空串/纯空格 = "没有证据"，与"没给"同码；而带控制字符的值（下一组）是形态错误。
    for (const evidenceRef of [null, '', '   ']) {
      const result = selectRoute(baseInput({
        signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef, fingerprint: 'fp-a', at: NOW },
      }));
      assert.equal(result.ok, false, JSON.stringify(evidenceRef));
      assert.equal(result.code, 'E_NO_STRUCTURED_CONCLUSION', JSON.stringify(evidenceRef));
      assert.equal(result.detail.reason, 'evidence_ref_missing');
    }
  });

  it('rejects a malformed evidenceRef instead of coercing it', () => {
    const notString = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 42, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(notString.ok, false);
    assert.equal(notString.code, 'E_MODE_INVALID');
    assert.equal(notString.detail.field, 'signal.evidenceRef');

    const tooLong = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'e'.repeat(513), fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(tooLong.code, 'E_MODE_INVALID');
    assert.equal(tooLong.detail.field, 'signal.evidenceRef');

    // 换行/制表符是日志注入的入口，不允许原样进审计。
    const controlChar = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-a\nforged', fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(controlChar.code, 'E_MODE_INVALID');
    assert.equal(controlChar.detail.field, 'signal.evidenceRef');
  });

  it('accepts a bounded non-empty ref', () => {
    const exact = selectRoute(baseInput({
      signal: {
        severity: 'critical',
        hasStructuredConclusion: true,
        evidenceRef: 'e'.repeat(512),
        fingerprint: 'fp-a',
        at: NOW,
      },
    }));
    assert.equal(exact.ok, true, JSON.stringify(exact));
    assert.equal(exact.tier, 'respond');
  });

  it('checks severity first and the structured-conclusion flag second', () => {
    const lowFirst = selectRoute(baseInput({
      signal: { severity: 'low', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(lowFirst.code, 'E_SEVERITY_BELOW', 'severity gate stays ahead of the evidence gate');

    const unstructuredFirst = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: false, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(unstructuredFirst.code, 'E_NO_STRUCTURED_CONCLUSION');
    assert.equal(unstructuredFirst.detail.reason, 'not_structured');
  });

  it('does not require evidenceRef on paths that never escalate', () => {
    const disabled = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW },
      escalation: { enabled: false, minSeverity: 'critical', cooldownSeconds: 300, maxPerHour: 20 },
    }));
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    assert.equal(disabled.tier, 'watch');

    const belowThreshold = selectRoute(baseInput({
      signal: { severity: 'low', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(belowThreshold.code, 'E_SEVERITY_BELOW');

    const uniform = selectRoute(baseInput({
      mode: 'uniform',
      uniformModelId: 'deepseek-chat',
      signal: { severity: 'critical', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(uniform.ok, true, 'uniform never escalates, so it never needs evidence');
    assert.equal(uniform.escalate, false);
  });

  it('keeps the ADR §2.5 order: evidence is checked before cooldown', () => {
    // 冷却属于"第 3 条"，证据属于"第 2 条"：两条都不满足时先报第 2 条。
    // 这不是细节——错误码的顺序决定了运维先修哪一个。
    const result = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, fingerprint: 'fp-a', at: NOW },
      recent: [{ fingerprint: 'fp-a', at: NOW }],
    }));
    assert.equal(result.code, 'E_NO_STRUCTURED_CONCLUSION');
    assert.equal(result.detail.reason, 'evidence_ref_missing');
  });
});

describe('request record fields carried by the decision (ADR-0010 §2.7)', () => {
  it('reports fingerprint and escalatedFrom when it escalates', () => {
    const result = selectRoute(baseInput({
      signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-1', fingerprint: 'fp-b', at: NOW },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.fingerprint, 'fp-b');
    assert.equal(result.escalatedFrom, 'watch');
    assert.equal(result.escalate, true);
  });

  it('reports escalatedFrom null when it stays at the default tier', () => {
    const result = selectRoute(baseInput({
      escalation: { enabled: false, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.escalate, false);
    assert.equal(result.escalatedFrom, null, 'a non-escalation must be explicit, not an absent key');
    assert.equal(result.fingerprint, 'fp-a');
  });

  it('omits escalatedFrom entirely in uniform mode (ADR-0010 §2.4.1 第 6 条)', () => {
    const result = selectRoute(baseInput({ mode: 'uniform', uniformModelId: 'deepseek-chat' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(Object.hasOwn(result, 'escalatedFrom'), false, 'uniform must not emit a two-source field');
    assert.equal(result.fingerprint, 'fp-a', 'the fingerprint is still the join key for the usage page');
  });
});

describe('cooldown (ADR-0010 §2.5 第 3 条)', () => {
  it('rejects a fingerprint escalated inside the cooldown window', () => {
    const result = selectRoute(baseInput({
      recent: [{ fingerprint: 'fp-a', at: NOW - 100 * 1000 }],
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_COOLDOWN');
    assert.equal(result.detail.lastEscalatedAt, NOW - 100 * 1000);
    assert.equal(result.detail.cooldownSeconds, 300);
  });

  it('treats the exact boundary as expired', () => {
    const result = selectRoute(baseInput({
      recent: [{ fingerprint: 'fp-a', at: NOW - 300 * 1000 }],
    }));
    assert.equal(result.ok, true, 'exactly cooldownSeconds ago is no longer cooling');
    assert.equal(result.tier, 'triage');
  });

  it('only cools down the same fingerprint', () => {
    const result = selectRoute(baseInput({
      recent: [{ fingerprint: 'fp-other', at: NOW - 1000 }],
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.escalate, true);
  });

  it('treats a future timestamp as still cooling rather than trusting clock skew', () => {
    const result = selectRoute(baseInput({
      recent: [{ fingerprint: 'fp-a', at: NOW + 60 * 1000 }],
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_COOLDOWN');
  });

  it('disables the cooldown when cooldownSeconds is 0', () => {
    const result = selectRoute(baseInput({
      escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 0, maxPerHour: 20 },
      recent: [{ fingerprint: 'fp-a', at: NOW - 1000 }],
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.escalate, true);
  });
});

describe('hourly cap (ADR-0010 §2.5 第 4 条)', () => {
  it('rejects at the configured cap', () => {
    const recent = Array.from({ length: 20 }, (_, index) => ({
      fingerprint: `fp-${index}`,
      at: NOW - index * 60 * 1000,
    }));
    const result = selectRoute(baseInput({ recent }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_HOURLY_CAP');
    assert.equal(result.detail.recentEscalations, 20);
    assert.equal(result.detail.maxPerHour, 20);
  });

  it('allows one below the cap', () => {
    const recent = Array.from({ length: 19 }, (_, index) => ({
      fingerprint: `fp-${index}`,
      at: NOW - index * 60 * 1000,
    }));
    const result = selectRoute(baseInput({ recent }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.escalate, true);
  });

  it('excludes escalations older than one hour from the count', () => {
    const recent = Array.from({ length: 30 }, (_, index) => ({
      fingerprint: `fp-old-${index}`,
      at: NOW - HOUR_MS - (index + 1) * 1000,
    }));
    const result = selectRoute(baseInput({ recent }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.escalate, true);
  });

  it('honours a maxPerHour of zero as "never escalate"', () => {
    const result = selectRoute(baseInput({
      escalation: { enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 0 },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_HOURLY_CAP');
    assert.equal(result.detail.recentEscalations, 0);
  });
});

describe('tier availability (ADR-0010 §2.5, no silent fallback)', () => {
  it('rejects a missing respond model instead of falling back to watch', () => {
    const result = selectRoute({
      ...baseInput({ signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW } }),
      models: inputWithoutModelTier('respond').models,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_TIER_UNAVAILABLE');
    assert.equal(result.detail.tier, 'respond');
    assert.equal(result.detail.severity, 'critical');
  });

  it('rejects a missing triage model instead of jumping to respond', () => {
    const models = MODELS.filter((model) => model.tier !== 'triage').map((model) => ({ ...model }));
    const result = selectRoute(baseInput({
      models,
      signal: { severity: 'high', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_TIER_UNAVAILABLE');
    assert.equal(result.detail.tier, 'triage');
  });

  it('rejects a missing default-tier model when no escalation happens', () => {
    const models = MODELS.filter((model) => model.tier !== 'watch').map((model) => ({ ...model }));
    const result = selectRoute(baseInput({
      models,
      escalation: { enabled: false, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_TIER_UNAVAILABLE');
    assert.equal(result.detail.tier, 'watch');
  });

  it('picks the first declared model at the target tier deterministically', () => {
    const models = [
      { id: 'watch-a', providerId: 'local', tier: 'watch' },
      { id: 'watch-b', providerId: 'local', tier: 'watch' },
      { id: 'triage-a', providerId: 'local', tier: 'triage' },
      { id: 'triage-b', providerId: 'local', tier: 'triage' },
    ];
    const result = selectRoute(baseInput({ models }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.modelId, 'triage-a');
  });
});

describe('invalid input fails closed without throwing (ADR-0010 §2.4.1, 契约规则 4)', () => {
  it('rejects an unknown mode', () => {
    for (const mode of ['auto', 'UNIFORM', '', null, 42]) {
      const result = selectRoute(baseInput({ mode }));
      assert.equal(result.ok, false, String(mode));
      assert.equal(result.code, 'E_MODE_INVALID');
      assert.equal(result.detail.field, 'mode');
    }
  });

  it('rejects a non-array models field', () => {
    const result = selectRoute(baseInput({ models: 'deepseek-chat' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_MODE_INVALID');
    assert.equal(result.detail.field, 'models');
  });

  it('rejects malformed model entries instead of skipping them', () => {
    const cases = [
      [{ providerId: 'p', tier: 'watch' }, 'models[0].id'],
      [{ id: 'm', tier: 'watch' }, 'models[0].providerId'],
      [{ id: 'm', providerId: 'p', tier: 'strongest' }, 'models[0].tier'],
      [{ id: 'm', providerId: 'p', tier: 'watch', maxInputTokens: 0 }, 'models[0].maxInputTokens'],
    ];
    for (const [entry, field] of cases) {
      const result = selectRoute(baseInput({ models: [entry] }));
      assert.equal(result.ok, false, field);
      assert.equal(result.code, 'E_MODE_INVALID', field);
      assert.equal(result.detail.field, field);
    }
  });

  it('rejects an empty fingerprint in both modes', () => {
    for (const mode of ['tiered', 'uniform']) {
      const result = selectRoute(baseInput({
        mode,
        uniformModelId: 'local-7b',
        signal: { severity: 'high', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: '', at: NOW },
      }));
      assert.equal(result.ok, false, mode);
      assert.equal(result.code, 'E_MODE_INVALID');
      assert.equal(result.detail.field, 'signal.fingerprint');
    }
  });

  it('rejects an unknown severity and a non-numeric clock', () => {
    const bad = selectRoute(baseInput({
      signal: { severity: 'urgent', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW },
    }));
    assert.equal(bad.code, 'E_MODE_INVALID');
    assert.equal(bad.detail.field, 'signal.severity');

    const noClock = selectRoute(baseInput({
      signal: { severity: 'high', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: undefined },
    }));
    assert.equal(noClock.code, 'E_MODE_INVALID');
    assert.equal(noClock.detail.field, 'signal.at');
  });

  it('rejects malformed escalation parameters', () => {
    const cases = [
      [{ enabled: 'yes', minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 20 }, 'escalation.enabled'],
      [{ enabled: true, minSeverity: 'severe', cooldownSeconds: 300, maxPerHour: 20 }, 'escalation.minSeverity'],
      [{ enabled: true, minSeverity: 'high', cooldownSeconds: -1, maxPerHour: 20 }, 'escalation.cooldownSeconds'],
      [{ enabled: true, minSeverity: 'high', cooldownSeconds: 300, maxPerHour: 1.5 }, 'escalation.maxPerHour'],
    ];
    for (const [escalation, field] of cases) {
      const result = selectRoute(baseInput({ escalation }));
      assert.equal(result.ok, false, field);
      assert.equal(result.code, 'E_MODE_INVALID', field);
      assert.equal(result.detail.field, field);
    }
  });

  it('rejects a malformed recent history', () => {
    const badEntry = selectRoute(baseInput({ recent: [{ fingerprint: 'fp-a', at: 'yesterday' }] }));
    assert.equal(badEntry.code, 'E_MODE_INVALID');
    assert.equal(badEntry.detail.field, 'recent[0].at');

    const notArray = selectRoute(baseInput({ recent: null }));
    assert.equal(notArray.code, 'E_MODE_INVALID');
    assert.equal(notArray.detail.field, 'recent');
  });

  it('returns a failure result instead of throwing on an unreadable input', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'mode', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const result = selectRoute(hostile);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_MODE_INVALID');
  });

  it('returns a failure result for non-object inputs', () => {
    for (const value of [null, undefined, 'tiered', 7, []]) {
      const result = selectRoute(value);
      assert.equal(result.ok, false, String(value));
      assert.equal(result.code, 'E_MODE_INVALID');
    }
  });
});

describe('purity', () => {
  it('is deterministic for identical input', () => {
    const input = baseInput({ signal: { severity: 'critical', hasStructuredConclusion: true, evidenceRef: 'ev-fp-a', fingerprint: 'fp-a', at: NOW } });
    assert.deepEqual(selectRoute(input), selectRoute(input));
  });

  it('does not mutate its input', () => {
    const input = baseInput({ recent: [{ fingerprint: 'fp-a', at: NOW - 1000 }] });
    const snapshot = structuredClone(input);
    selectRoute(input);
    assert.deepEqual(input, snapshot);
  });

  it('freezes its result', () => {
    const ok = selectRoute(baseInput());
    assert.equal(Object.isFrozen(ok), true);

    const failed = selectRoute(baseInput({ mode: 'auto' }));
    assert.equal(Object.isFrozen(failed), true);
    assert.equal(Object.isFrozen(failed.detail), true);
  });
});
