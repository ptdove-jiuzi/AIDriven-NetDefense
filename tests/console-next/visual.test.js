/**
 * UI2-B11 · §11 红线 5（视觉回归，部分覆盖）
 *
 * 现状（2026-11-04，波次 3）：
 * - B1 的 `styles/demo.html` 已冻结 → 作为**稳定基线**做真实视觉回归（暗/亮 + 自检/组件两个面板）；
 * - B2/B4–B7 视图未冻结、B10 locales 未落盘 → index 的 6 页矩阵暂不做像素基线（会随文案抖动），
 *   只做"真实截图非空 + 尺寸正确 + 非纯色"的存在性断言，并在状态文件记「矩阵未验证」。
 *
 * 基线首次运行自动创建（`tests/console-next/baselines/*.png`）；后续比较阈值：
 * changedRatio ≤ 1%、单通道最大差 ≤ 64。`B11_UPDATE_BASELINE=1` 可显式重建。
 *
 * 运行：`node --test tests/console-next/visual.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { edgeAvailable, screenshot } from './edge.mjs';
import { decodePng, compareAgainstBaseline, diffPng } from './png.mjs';
import { startConsoleAndDaemon } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const DEMO = path.join(REPO_ROOT, 'apps', 'console-next', 'styles', 'demo.html');
const TOKENS = path.join(REPO_ROOT, 'apps', 'console-next', 'styles', 'tokens.css');
const COMPONENTS = path.join(REPO_ROOT, 'apps', 'console-next', 'styles', 'components.css');
const BASELINES = path.join(HERE, 'baselines');
const EVIDENCE = path.join(REPO_ROOT, 'evidence', 'console-v2', 'b11');
const hasEdge = edgeAvailable();

function fileUrl(target, query) {
  return `${new URL(`file:///${target.replace(/\\/gu, '/')}`).href}${query}`;
}

/** 纯色检测：只要有足够多的颜色变化，就说明不是空白/纯色页面。 */
function distinctColorCount(png) {
  const seen = new Set();
  for (let index = 0; index < png.pixels.length; index += png.channels * 7) {
    seen.add(`${png.pixels[index]},${png.pixels[index + 1]},${png.pixels[index + 2]}`);
    if (seen.size > 50) break;
  }
  return seen.size;
}

async function captureDemo(t, theme, panel) {
  const url = fileUrl(DEMO, `?panel=${panel}&theme=${theme}&static=1`);
  const result = await screenshot(url, {
    width: 1440,
    height: 1000,
    virtualTimeBudgetMs: 6000,
    timeoutMs: 40000,
    extraArgs: ['--allow-file-access-from-files'],
  });
  if (!result.ok) {
    t.diagnostic(`screenshot unavailable: ${result.reason}`);
    return null;
  }
  return result.png;
}

test('视觉基线：B1 demo 暗/亮双主题（panel=components）与自检面板', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  fs.mkdirSync(BASELINES, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });

  const cases = [
    { name: 'demo-dark-components', theme: 'dark', panel: 'components' },
    { name: 'demo-light-components', theme: 'light', panel: 'components' },
    { name: 'demo-dark-selftest', theme: 'dark', panel: 'selftest' },
  ];

  for (const item of cases) {
    const png = await captureDemo(t, item.theme, item.panel);
    assert.ok(png !== null, `Edge screenshot failed for ${item.name}`);
    const decoded = decodePng(png);
    assert.equal(decoded.width, 1440);
    assert.equal(decoded.height, 1000);
    assert.ok(distinctColorCount(decoded) > 10, `${item.name} looks like a blank/flat page`);

    const baselinePath = path.join(BASELINES, `${item.name}.png`);
    const comparison = compareAgainstBaseline(baselinePath, png, { maxChangedRatio: 0.01, pixelThreshold: 8 });
    fs.writeFileSync(path.join(EVIDENCE, `${item.name}.png`), png);
    if (comparison.baselineCreated) {
      t.diagnostic(`baseline created: ${item.name}`);
      continue;
    }
    assert.equal(comparison.ok, true, `${item.name} visual diff too large: ${JSON.stringify(comparison.diff)}`);
    t.diagnostic(`${item.name} changedRatio=${comparison.diff.changedRatio.toFixed(5)}`);
  }
});

test('视觉存在性：index 外壳两个主题截图非空（6 页矩阵待视图冻结后补）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const env = await startConsoleAndDaemon(t);
  const results = [];
  for (const theme of ['dark', 'light']) {
    const url = `${env.url}/index.html?theme=${theme}&static=1&lang=en#/overview`;
    const shot = await screenshot(url, { width: 1440, height: 1000, virtualTimeBudgetMs: 5000, timeoutMs: 30000 });
    assert.equal(shot.ok, true, `index screenshot failed: ${shot.reason}`);
    const decoded = decodePng(shot.png);
    assert.equal(decoded.width, 1440);
    assert.equal(decoded.height, 1000);
    assert.ok(distinctColorCount(decoded) > 10, `index ${theme} screenshot looks blank`);
    fs.writeFileSync(path.join(EVIDENCE, `index-${theme}-en.png`), shot.png);
    results.push(`${theme}:${decoded.pixels.length}B`);
  }
  // 6 页 × 暗/亮 × 中/英 = 24 张；当前视图未冻结、locales 未落盘 → 未验证（见状态文件）。
  if (process.env.B11_VISUAL_FULL === '1') {
    t.diagnostic('B11_VISUAL_FULL=1: 6-page matrix is not implemented until B2/B4-B7 freeze');
  } else {
    t.diagnostic(`6-page visual matrix deferred (views not frozen); captured ${results.join(',')}`);
  }
});

test('PNG 差异算法自检：同图 0 差异；改一个像素可被检出', () => {
  // 用两张真实截图做同图自检（无浏览器时用合成 RGBA）
  const makeImage = (mutate) => {
    const width = 8;
    const height = 8;
    const pixels = Buffer.alloc(width * height * 4, 0);
    for (let index = 0; index < width * height; index += 1) {
      pixels[index * 4 + 0] = (index * 17) % 255;
      pixels[index * 4 + 1] = (index * 31) % 255;
      pixels[index * 4 + 2] = (index * 47) % 255;
      pixels[index * 4 + 3] = 255;
    }
    if (mutate) pixels[4] = 255;
    return { width, height, channels: 4, pixels, colorType: 6, bitDepth: 8, interlace: 0 };
  };
  const same = diffPng(makeImage(false), makeImage(false));
  assert.equal(same.changedPixels, 0);
  assert.equal(same.changedRatio, 0);
  const changed = diffPng(makeImage(false), makeImage(true), { pixelThreshold: 8 });
  assert.equal(changed.changedPixels, 1);
  assert.ok(changed.maxChannelDiff > 8);
  assert.deepEqual(changed.box, { x0: 1, y0: 0, x1: 1, y1: 0 });
});

/* ==========================================================================
   T5 visual（UI-POLISH 战役）：token 对比度与密度 token 的静态判据
   —— 运行期实测见 evidence/ui-polish/visual/{audit,contrast,matrix,perf-5000}.mjs；
      这里把最容易回退的两条契约钉在门禁里：AA 对比度、密度必须真的来自 token。
   ========================================================================== */

/** 解析 tokens.css：返回 { comfortable, compact } 两套变量（注释已剔除）。 */
function readTokens() {
  const css = fs.readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
  const blocks = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  let match;
  while ((match = pattern.exec(css)) !== null) {
    const vars = {};
    for (const line of match[2].split(';')) {
      const declaration = line.trim();
      const index = declaration.indexOf(':');
      if (index <= 0) continue;
      const name = declaration.slice(0, index).trim();
      if (name.startsWith('--')) vars[name] = declaration.slice(index + 1).trim();
    }
    if (Object.keys(vars).length > 0) blocks.push({ selector: match[1].trim().replace(/\s+/gu, ' '), vars });
  }
  const pick = (predicate) => {
    const merged = {};
    for (const block of blocks) if (predicate(block.selector)) Object.assign(merged, block.vars);
    return merged;
  };
  return {
    dark: pick((selector) => selector.includes('[data-theme="dark"]')),
    light: pick((selector) => selector.includes('[data-theme="light"]')),
    comfortable: pick((selector) => selector === ':root'),
    compact: pick((selector) => selector.includes('[data-density="compact"]')),
  };
}

function parseColor(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const expand = (value) => (value.length === 3 ? value + value : value);
    return { r: parseInt(expand(hex).slice(0, 2), 16), g: parseInt(expand(hex).slice(2, 4), 16), b: parseInt(expand(hex).slice(4, 6), 16), a: 1 };
  }
  const match = text.match(/rgba?\(([^)]+)\)/u);
  if (!match) throw new Error(`unparsable color: ${text}`);
  const parts = match[1].replace(/\//gu, ' ').replace(/,/gu, ' ').split(/\s+/u).filter(Boolean).map(Number);
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function composite(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function relativeLuminance(color) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function ratioOf(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('token 对比度：两主题的文本 ≥4.5:1、控件边界 ≥3:1（含 T5 新增 --c-accent-text）', () => {
  const tokens = readTokens();
  const cases = [];
  for (const theme of ['dark', 'light']) {
    const vars = tokens[theme];
    assert.ok(Object.keys(vars).length > 20, `${theme}: token block not parsed`);
    const solid = (name) => {
      const color = parseColor(vars[name]);
      assert.equal(color.a, 1, `${theme} ${name} must be opaque for a text token`);
      return color;
    };
    for (const background of ['--c-bg', '--c-surface', '--c-bg-elev']) {
      for (const foreground of ['--c-text', '--c-text-muted', '--c-text-faint']) {
        cases.push({ theme, label: `${foreground} on ${background}`, ratio: ratioOf(solid(foreground), solid(background)), min: 4.5 });
      }
    }
    for (const foreground of ['--c-accent', '--c-danger', '--c-warn', '--c-ok', '--c-info']) {
      cases.push({ theme, label: `${foreground} on --c-surface`, ratio: ratioOf(solid(foreground), solid('--c-surface')), min: 4.5 });
    }
    cases.push({ theme, label: '--c-accent-contrast on --c-accent', ratio: ratioOf(solid('--c-accent-contrast'), solid('--c-accent')), min: 4.5 });
    // badge/选中态：accent 文本压在 accent 10%–14% 叠加层上（修复前 light 只有 4.42:1）
    for (const base of ['--c-surface', '--c-bg-elev']) {
      const layered = composite(parseColor(vars['--c-selected']), solid(base));
      cases.push({ theme, label: `--c-accent-text on selected/${base}`, ratio: ratioOf(solid('--c-accent-text'), layered), min: 4.5 });
    }
    for (const foreground of ['--c-input-border', '--c-focus']) {
      for (const background of ['--c-bg', '--c-surface']) {
        cases.push({ theme, label: `${foreground} on ${background}`, ratio: ratioOf(solid(foreground), solid(background)), min: 3 });
      }
    }
  }
  const failed = cases.filter((entry) => entry.ratio < entry.min - 0.005);
  assert.deepEqual(
    failed.map((entry) => `${entry.theme} ${entry.label} ${entry.ratio.toFixed(2)} < ${entry.min}`),
    [],
    'AA contrast failures',
  );
  const worst = cases.reduce((min, entry) => (entry.ratio < min.ratio ? entry : min));
  assert.ok(cases.length >= 40, `expected a full AA matrix, got ${cases.length}`);
  assert.ok(worst.ratio >= 3, `worst ratio ${worst.ratio.toFixed(2)} (${worst.label})`);
});

test('密度 token：compact 必须逐项覆盖 comfortable，且组件层只读 --density-* 落密度', () => {
  const tokens = readTokens();
  const comfortable = tokens.comfortable;
  const compact = tokens.compact;
  const densityNames = Object.keys(comfortable).filter((name) => name.startsWith('--density-'));
  assert.ok(densityNames.length >= 5, `expected >=5 --density-* tokens, got ${densityNames.length}`);

  for (const name of densityNames) {
    assert.ok(name in compact, `compact must override ${name}`);
    const resolve = (value, vars, depth = 0) => {
      const reference = String(value).match(/^var\((--[a-z0-9-]+)\)$/u);
      if (!reference || depth > 4) return value;
      return resolve(vars[reference[1]] ?? reference[1], vars, depth + 1);
    };
    const before = resolve(comfortable[name], comfortable);
    const after = resolve(compact[name], compact);
    assert.notEqual(before, after, `${name}: compact value equals comfortable (${before}) — 密度不会真实变化`);
  }
  // 控件高度与表格行高也必须变（判据：表格行高 / 卡片 padding / 列表间距）
  assert.notEqual(comfortable['--ctl-h'], compact['--ctl-h'], '--ctl-h must shrink in compact');
  assert.notEqual(comfortable['--table-row-h'], compact['--table-row-h'], '--table-row-h must shrink in compact');
  assert.notEqual(comfortable['--density-card-pad'], compact['--density-card-pad'], 'card padding must shrink in compact');

  const components = fs.readFileSync(COMPONENTS, 'utf8');
  for (const selector of ['.ui-card__body', '.ui-card__head', '.ui-empty', '.ui-table__state', '.ui-drawer__body', '.ui-btn']) {
    assert.ok(components.includes(selector), `components.css lost selector ${selector}`);
  }
  assert.ok(components.includes('padding: var(--density-card-pad)'), '.ui-card padding must read --density-card-pad');
  assert.ok(components.includes('padding: var(--density-empty-pad-y) var(--density-card-pad)'), '.ui-empty padding must read density tokens');
  // 非文本控件边界必须用 ≥3:1 的 --c-input-border，不回退到 --c-border-strong（1.6–1.9:1）
  assert.ok(/\.ui-btn \{[^}]*border: 1px solid var\(--c-input-border\);/u.test(components), '.ui-btn border must use --c-input-border');
  assert.ok(!/\.ui-btn \{[^}]*border: 1px solid var\(--c-border-strong\);/u.test(components), '.ui-btn must not use --c-border-strong');
});