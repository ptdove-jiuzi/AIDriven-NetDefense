/**
 * tests/e2e/fixes/settings-enum-d9.test.js — D9 回归：枚举标签的兜底链不得被 `[missing:…]` 打死
 * （作者 PT-dove）
 *
 * 缺陷（`docs/implementation/evidence/ui2/defects.md` D9 / 待编号）：
 *   `js/views/settings/shared.js` 的 `enumLabel()` 把 i18n key 拼成
 *   `settings.enum.<path 含数组行索引>.<value>`，查不到时 `t()` 返回 `[missing:…] <human>`（**非空**），
 *   于是 severity / decision / humanize 三条可读兜底虽然算出来了，却只能跟在 `[missing:…]` 标记后面，
 *   任何未预生成的枚举值在 UI 上都显示成 `[missing:…]` —— "有兜底"形同虚设。
 *
 * 修复口径（最小改动，只在 shared.js）：
 *   1. 先按**去行索引**的 key 查（`settings.enum.models.providers.kind.deepseek`），
 *      再按**行级** key 查（`settings.enum.models.providers.0.kind.deepseek`，兼容 i18n 已预生成的 index 键）；
 *   2. 都查不到 → 返回人类可读兜底（severity / decision / humanize），**不带** `[missing:` 标记。
 *
 * 这些用例是**纯函数级**（`node --test` 直接 import shared.js，零浏览器、零 DOM），
 * 改前红、改后绿：
 *   node --test tests/e2e/fixes/settings-enum-d9.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createTranslator, enumLabel, toKebab, keyPath } from '../../../apps/console-next/js/views/settings/shared.js';

/** 用一个受控的 i18n 字典造真实 translator（走 shared.js 的真实 createTranslator，不是自写桩）。 */
function translator(dictionary) {
  return createTranslator({ i18n: dictionary });
}

/** 标记检测：`[missing:` 是 shared.js 里的缺 key 标记（§8.5）。 */
function hasMissingMarker(text) {
  return typeof text === 'string' && text.includes('[missing:');
}

describe('D9 · enumLabel 兜底链', () => {
  test('未知枚举值（locale 里没有）：不得渲染 [missing:]，必须用人类可读兜底', () => {
    const t = translator({});
    const label = enumLabel(t, 'models.routing.mode', 'ghost-mode');
    assert.equal(hasMissingMarker(label), false, `未知枚举值仍渲染缺 key 标记 → ${JSON.stringify(label)}`);
    assert.equal(label, 'Ghost mode', `应回落到 humanize 文案，实际 ${JSON.stringify(label)}`);
  });

  test('完全未知的 camelCase 值同样走 humanize（不出现标记）', () => {
    const t = translator({});
    const label = enumLabel(t, 'models.routing.escalation.minSeverity', 'veryHigh');
    assert.equal(hasMissingMarker(label), false, `仍渲染缺 key 标记 → ${JSON.stringify(label)}`);
    assert.equal(label, 'Very High', `应回落到 humanize 文案，实际 ${JSON.stringify(label)}`);
  });

  test('按值查优先：去行索引的 key 命中时应使用它（行索引不参与枚举身份）', () => {
    const t = translator({
      'settings.enum.models.providers.kind.deepseek': 'DEEPSEEK-VALUE-KEY',
      'settings.enum.models.providers.0.kind.deepseek': 'ROW-INDEX-KEY',
    });
    const label = enumLabel(t, 'models.providers[0].kind', 'deepseek');
    assert.equal(label, 'DEEPSEEK-VALUE-KEY', `去索引 key 应优先，实际 ${JSON.stringify(label)}`);
  });

  test('兼容：只有行级 key（i18n 已按 index 预生成）时仍能命中', () => {
    const t = translator({ 'settings.enum.models.providers.0.kind.deepseek': 'ROW-INDEX-KEY' });
    const label = enumLabel(t, 'models.providers[0].kind', 'deepseek');
    assert.equal(label, 'ROW-INDEX-KEY', `行级 key 兼容查找失效，实际 ${JSON.stringify(label)}`);
  });

  test('severity 兜底生效：未预生成枚举 key 时用 severity.<value>', () => {
    const t = translator({ 'severity.critical': 'CRITICAL-SEVERITY-KEY' });
    const label = enumLabel(t, 'detection.severityMapping.critical', 'critical');
    assert.equal(hasMissingMarker(label), false, `仍渲染缺 key 标记 → ${JSON.stringify(label)}`);
    assert.equal(label, 'CRITICAL-SEVERITY-KEY', `severity 兜底未生效，实际 ${JSON.stringify(label)}`);
  });

  test('decision 兜底生效：未预生成枚举 key 时用 settings.decision.<value>', () => {
    const t = translator({ 'settings.decision.needs-approval': 'DECISION-KEY' });
    const label = enumLabel(t, 'response.actionMatrix.runAction', 'needs_approval');
    assert.equal(hasMissingMarker(label), false, `仍渲染缺 key 标记 → ${JSON.stringify(label)}`);
    assert.equal(label, 'DECISION-KEY', `decision 兜底未生效，实际 ${JSON.stringify(label)}`);
  });

  test('已知值仍正常命中（不放宽既有行为）', () => {
    const t = translator({ 'settings.enum.ui.theme.dark': 'DARK-THEME' });
    assert.equal(enumLabel(t, 'ui.theme', 'dark'), 'DARK-THEME');
  });

  test('辅助函数仍是合同语义（keyPath 保留索引 / toKebab 规则未变）', () => {
    assert.equal(keyPath('models.providers[0].kind'), 'models.providers.0.kind');
    assert.equal(toKebab('needs_approval'), 'needs-approval');
    assert.equal(toKebab('veryHigh'), 'very-high');
  });
});
