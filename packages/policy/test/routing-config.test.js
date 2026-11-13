/**
 * 配置面 ↔ 判据面 的映射（P1-5）。
 *
 * 审查事实：`deploy/config/model-routing.example.json` 写的是 `maxEscalationsPerHour` /
 * `requireStructuredConclusion` / `sendRawEvents`，而 `selectRoute` 要的是 `maxPerHour` /
 * `signal.hasStructuredConclusion`。直传即 `E_MODE_INVALID`；"猜一个默认值补上"则让管理员
 * 配的数字静默失效。
 *
 * 因此本文件固定三件事：
 * 1. 示例配置能**原样**经 `normalizeRoutingInput` 变成合法的 `selectRoute` 入参（并真的跑通）；
 * 2. 无法生效的开关（关掉证据要求、一次分析多次升级、发原始事件）**在装载期报错**，
 *    而不是接受后当没看见；
 * 3. 未知字段一律拒绝——这正是 P1-1 在配置面上的同一条规则。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectRoute } from '../src/model-routing.js';
import { normalizeRoutingInput } from '../src/routing-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_CONFIG = path.resolve(HERE, '../../../deploy/config/model-routing.example.json');

const NOW = Date.UTC(2026, 10, 4, 2, 0, 0);

function loadExample() {
  return JSON.parse(readFileSync(EXAMPLE_CONFIG, 'utf8'));
}

/** 最小合法配置（用于逐字段注入故障）。 */
function minimalConfig(overrides = {}) {
  return {
    routing: {
      mode: 'tiered',
      uniformModelId: null,
      defaultTier: 'watch',
      escalation: {
        enabled: true,
        minSeverity: 'high',
        requireStructuredConclusion: true,
        cooldownSeconds: 300,
        maxEscalationsPerHour: 20,
      },
      ...overrides.routing,
    },
    models: overrides.models ?? [
      { id: 'local-7b', providerId: 'ollama-local', tier: 'watch' },
      { id: 'deepseek-chat', providerId: 'deepseek', tier: 'respond' },
    ],
  };
}

describe('the shipped example config is accepted as written', () => {
  it('normalizes deploy/config/model-routing.example.json without edits', () => {
    const document = loadExample();
    const result = normalizeRoutingInput(document);
    assert.equal(result.ok, true, JSON.stringify(result));
    const { input } = result;
    assert.equal(input.mode, 'tiered');
    assert.equal(input.uniformModelId, null);
    assert.equal(input.defaultTier, 'watch');
    assert.equal(input.escalation.enabled, true);
    assert.equal(input.escalation.minSeverity, 'high');
    assert.equal(input.escalation.cooldownSeconds, 300);
    // 配置面写的 maxEscalationsPerHour 必须真的变成判据面的 maxPerHour，且是同一个数。
    assert.equal(input.escalation.maxPerHour, 20);
    assert.equal(Object.hasOwn(input.escalation, 'maxEscalationsPerHour'), false);
    assert.equal(Object.hasOwn(input.escalation, 'requireStructuredConclusion'), false);
    assert.equal(input.models.length, document.models.length);
    assert.deepEqual(
      Object.keys(input).sort(),
      ['defaultTier', 'escalation', 'mode', 'models', 'uniformModelId'],
      'the output must be exactly a selectRoute input (signal/recent belong to the runtime)',
    );
  });

  it('produces an input the predicate actually accepts', () => {
    const normalized = normalizeRoutingInput(loadExample());
    assert.equal(normalized.ok, true, JSON.stringify(normalized));
    const routed = selectRoute({
      ...normalized.input,
      signal: {
        severity: 'critical',
        hasStructuredConclusion: true,
        evidenceRef: 'ev-1',
        fingerprint: 'fp-a',
        at: NOW,
      },
      recent: [],
    });
    assert.equal(routed.ok, true, JSON.stringify(routed));
    assert.equal(routed.tier, 'respond');
    assert.equal(routed.modelId, 'deepseek-reasoner');
    assert.equal(routed.escalatedFrom, 'watch');
  });

  it('keeps only contract fields on each model entry', () => {
    const normalized = normalizeRoutingInput(loadExample());
    assert.equal(normalized.ok, true);
    for (const model of normalized.input.models) {
      assert.deepEqual(
        Object.keys(model).sort(),
        ['id', 'maxInputTokens', 'maxOutputTokens', 'providerId', 'tier'].filter((key) => Object.hasOwn(model, key)).sort(),
      );
    }
    // costClass 是展示字段，不进契约：它出现过，但不该出现在判据入参里。
    assert.equal(JSON.stringify(normalized.input).includes('costClass'), false);
  });
});

describe('switches that cannot take effect are rejected at load time', () => {
  it('refuses to disable the structured-conclusion requirement', () => {
    for (const value of [false, 'true', 0]) {
      const config = minimalConfig();
      config.routing.escalation.requireStructuredConclusion = value;
      const result = normalizeRoutingInput(config);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.code, 'E_CONFIG_UNSUPPORTED', JSON.stringify(value));
      assert.equal(result.detail.field, 'routing.escalation.requireStructuredConclusion');
    }
  });

  it('refuses raw events on the escalation path', () => {
    const config = minimalConfig();
    config.routing.escalation.sendRawEvents = true;
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_CONFIG_UNSUPPORTED');
    assert.equal(result.detail.field, 'routing.escalation.sendRawEvents');
  });

  it('refuses more than one escalation per analysis', () => {
    for (const value of [2, 3, 0]) {
      const config = minimalConfig();
      config.routing.escalation.maxEscalationsPerAnalysis = value;
      const result = normalizeRoutingInput(config);
      assert.equal(result.ok, false, String(value));
      assert.equal(result.code, 'E_CONFIG_UNSUPPORTED', String(value));
    }
  });

  it('accepts maxEscalationsPerAnalysis of exactly one', () => {
    const config = minimalConfig();
    config.routing.escalation.maxEscalationsPerAnalysis = 1;
    assert.equal(normalizeRoutingInput(config).ok, true);
  });
});

describe('no silent aliasing and no unknown fields', () => {
  it('rejects both spellings at once instead of picking one', () => {
    const config = minimalConfig();
    config.routing.escalation.maxPerHour = 5;
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_CONFIG_INVALID');
    assert.equal(result.detail.field, 'routing.escalation.maxPerHour');
  });

  it('rejects an unknown escalation key', () => {
    const config = minimalConfig();
    config.routing.escalation.maxEscalationsPerDay = 200;
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_CONFIG_INVALID');
    assert.equal(result.detail.field, 'routing.escalation.maxEscalationsPerDay');
  });

  it('rejects an unknown routing key', () => {
    const config = minimalConfig();
    config.routing.fallbackTier = 'watch';
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_CONFIG_INVALID');
    assert.equal(result.detail.field, 'routing.fallbackTier');
  });

  it('rejects an unknown model key', () => {
    const config = minimalConfig({
      models: [{ id: 'm', providerId: 'p', tier: 'watch', maxInputToken: 4096 }],
    });
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_CONFIG_INVALID');
    assert.equal(result.detail.field, 'models[0].maxInputToken');
  });

  it('rejects a missing escalation block or a non-boolean enabled flag', () => {
    const missing = normalizeRoutingInput({ routing: { mode: 'tiered' }, models: [] });
    assert.equal(missing.ok, false);
    assert.equal(missing.detail.field, 'routing.escalation');

    const config = minimalConfig();
    config.routing.escalation.enabled = 'yes';
    const notBoolean = normalizeRoutingInput(config);
    assert.equal(notBoolean.ok, false);
    assert.equal(notBoolean.detail.field, 'routing.escalation.enabled');
  });

  it('rejects a malformed cooldown or hourly cap', () => {
    const cases = [
      ['cooldownSeconds', -1],
      ['cooldownSeconds', '300'],
      ['maxEscalationsPerHour', 1.5],
      ['maxEscalationsPerHour', -1],
    ];
    for (const [key, value] of cases) {
      const config = minimalConfig();
      config.routing.escalation[key] = value;
      const result = normalizeRoutingInput(config);
      assert.equal(result.ok, false, `${key}=${String(value)}`);
      assert.equal(result.code, 'E_CONFIG_INVALID', `${key}=${String(value)}`);
      assert.equal(result.detail.field, `routing.escalation.${key}`);
    }
  });
});

describe('uniform mode is validated at load time (ADR-0010 §4-12)', () => {
  it('rejects a uniform mode with no uniformModelId', () => {
    for (const value of [undefined, null, '']) {
      const config = minimalConfig();
      config.routing.mode = 'uniform';
      config.routing.uniformModelId = value;
      const result = normalizeRoutingInput(config);
      assert.equal(result.ok, false, String(value));
      assert.equal(result.code, 'E_NO_UNIFORM_MODEL');
      assert.equal(result.detail.field, 'routing.uniformModelId');
    }
  });

  it('rejects a uniformModelId that is not declared in models[]', () => {
    const config = minimalConfig();
    config.routing.mode = 'uniform';
    config.routing.uniformModelId = 'gpt-not-configured';
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'E_NO_UNIFORM_MODEL');
  });

  it('preserves a dormant uniformModelId while tiered (ADR-0010 §2.4.1 第 2 条)', () => {
    const config = minimalConfig();
    config.routing.uniformModelId = 'deepseek-chat';
    const result = normalizeRoutingInput(config);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.input.mode, 'tiered');
    assert.equal(result.input.uniformModelId, 'deepseek-chat', 'switching back must not need a refill');
  });
});

describe('normalization is total and never throws', () => {
  it('returns a failure result for non-object documents', () => {
    for (const value of [null, undefined, 'cfg', 7, []]) {
      const result = normalizeRoutingInput(value);
      assert.equal(result.ok, false, String(value));
      assert.equal(result.code, 'E_CONFIG_INVALID');
    }
  });

  it('returns a failure result for a missing routing block', () => {
    const result = normalizeRoutingInput({ models: [] });
    assert.equal(result.ok, false);
    assert.equal(result.detail.field, 'routing');
  });

  it('freezes what it returns', () => {
    const result = normalizeRoutingInput(loadExample());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.input), true);
    assert.equal(Object.isFrozen(result.input.escalation), true);
    assert.equal(Object.isFrozen(result.input.models), true);
    assert.equal(Object.isFrozen(result.input.models[0]), true);
  });
});
