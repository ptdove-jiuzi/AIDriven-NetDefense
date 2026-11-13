/**
 * UI2-B11 · §11 红线 6（a11y 可及性）独立抽查
 *
 * 不依赖 B1 自检：这里自己解析 CSS token 计算对比度、直接读 index.html 语义结构，
 * 再用 Edge headless + CDP 在真实页面里断言可聚焦顺序/可访问名/图标隐藏。
 *
 * 键盘交互（Tab 走完告警页、Esc 关弹层、焦点回归）在 `components.test.js` 的
 * drawer/modal 用例里用 DOM shim 可复现地断言；真实浏览器 CDP 键盘事件未实现，
 * 已在状态文件「未验证」中登记。
 *
 * 运行：`node --test tests/console-next/a11y.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cdpEvaluate, edgeAvailable } from './edge.mjs';
import { startConsoleAndDaemon } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, '../../apps/console-next');
const TOKENS = fs.readFileSync(path.join(CONSOLE_DIR, 'styles', 'tokens.css'), 'utf8');
const INDEX = fs.readFileSync(path.join(CONSOLE_DIR, 'index.html'), 'utf8');

const hasEdge = edgeAvailable();

/**
 * 从 tokens.css 里抽出暗/亮两套颜色 token。
 *
 * tokens.css 的结构是：`:root {尺度}`、`:root, :root[data-theme="dark"], [data-theme="dark"] {颜色}`、
 * `:root[data-theme="light"], [data-theme="light"] {颜色}`。这里按"块里是否有 --c-bg"识别颜色块。
 */
function parseThemeTokens(source) {
  const themes = {};
  const blockPattern = /([^{}]+)\{([^{}]*)\}/gu;
  let match;
  while ((match = blockPattern.exec(source)) !== null) {
    const selector = match[1];
    const body = match[2];
    if (!body.includes('--c-bg')) continue;
    const tokens = {};
    for (const line of body.split(/\r?\n/u)) {
      const tokenMatch = line.match(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/u);
      if (tokenMatch) tokens[tokenMatch[1]] = tokenMatch[2];
    }
    if (selector.includes('light')) themes.light = tokens;
    else if (themes.dark === undefined) themes.dark = tokens;
  }
  return themes;
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((char) => char + char).join('') : value.slice(0, 6);
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---------------------------------------------------------------------------
// 静态断言：index.html 语义结构
// ---------------------------------------------------------------------------

test('index.html：skip-link 最先、语义地标/导航/6 路由/aria-live/主内容可聚焦', () => {
  const bodyStart = INDEX.indexOf('<body');
  assert.ok(bodyStart > -1);
  const skipIndex = INDEX.indexOf('class="skip-link"');
  const navIndex = INDEX.indexOf('<nav');
  assert.ok(skipIndex > -1 && navIndex > -1 && skipIndex < navIndex, 'skip link must come before the nav');

  assert.match(INDEX, /<main id="view-root" tabindex="-1"/u);
  assert.match(INDEX, /<nav id="nav" aria-label="[^"]+"/u);
  for (const route of ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']) {
    assert.match(INDEX, new RegExp(`data-route="${route}"`, 'u'));
  }
  assert.match(INDEX, /id="toast-root" aria-live="polite"/u);
  assert.match(INDEX, /id="lang-toggle"[^>]*data-i18n-aria=/u);
  assert.match(INDEX, /id="theme-toggle"[^>]*data-i18n-aria=/u);
  assert.match(INDEX, /<html lang="zh-CN"/u);
  // 图标按钮不能只有字形：每个 toolbar button 都需要可访问名来源
  const toolbar = INDEX.slice(INDEX.indexOf('class="topbar-tools"'), INDEX.indexOf('</header>'));
  const buttons = toolbar.match(/<button[\s\S]*?>/gu) ?? [];
  assert.equal(buttons.length, 3);
  for (const button of buttons) {
    assert.match(button, /aria-label|data-i18n-aria|data-i18n=/u, `toolbar button lacks accessible name source: ${button}`);
  }
});

test('对比度：暗/亮两套 token 的文本 ≥4.5:1、控件/焦点环 ≥3:1', () => {
  const themes = parseThemeTokens(TOKENS);
  assert.ok(themes.dark && themes.light, 'tokens.css must define both dark and light color blocks');
  for (const name of ['dark', 'light']) {
    const tokens = themes[name];
    const bg = tokens['--c-bg'];
    assert.ok(bg, `${name}: --c-bg missing`);
    for (const token of ['--c-text', '--c-text-muted', '--c-text-faint', '--c-accent', '--c-danger', '--c-warn', '--c-ok', '--c-info']) {
      assert.ok(tokens[token], `${name}: ${token} missing`);
      const ratio = contrastRatio(tokens[token], bg);
      assert.ok(ratio >= 4.5, `${name}: ${token} contrast ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
    for (const token of ['--c-focus', '--c-input-border']) {
      assert.ok(tokens[token], `${name}: ${token} missing`);
      const ratio = contrastRatio(tokens[token], bg);
      assert.ok(ratio >= 3, `${name}: ${token} contrast ${ratio.toFixed(2)}:1 < 3:1 (non-text UI)`);
    }
    // 主按钮：accent 底 + accent-contrast 文字
    const onAccent = contrastRatio(tokens['--c-accent-contrast'], tokens['--c-accent']);
    assert.ok(onAccent >= 4.5, `${name}: accent-contrast on accent ${onAccent.toFixed(2)}:1 < 4.5:1`);
  }
});

test('视觉顺序 = DOM 顺序（桌面 + 窄屏）：样式表不使用 order / row-reverse / direction:rtl 重排焦点', (t) => {
  const files = ['styles/tokens.css', 'styles/base.css', 'styles/components.css'];
  const pattern = /(?:^|[\s;{])(order\s*:\s*-?\d|flex-direction\s*:\s*row-reverse|direction\s*:\s*rtl)/gmu;
  const hits = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(CONSOLE_DIR, file), 'utf8');
    for (const match of source.matchAll(pattern)) {
      hits.push(`${file}:${source.slice(0, match.index).split('\n').length} ${match[1]}`);
    }
  }
  // 2026-11-04T23:xx B11 曾把窄屏 order 记为"已知 a11y 观察"；主控已删除该修复（合同 §7.8：
  // Tab 顺序=视觉顺序）。现在升级为硬断言：任何宽度下都不允许用 order/reverse/rtl 重排可聚焦元素。
  assert.deepEqual(hits, [], `CSS must not reorder focusable elements (order/row-reverse/rtl): ${hits.join(', ')}`);

  const baseCss = fs.readFileSync(path.join(CONSOLE_DIR, 'styles', 'base.css'), 'utf8');
  const narrow = baseCss.match(/@media \(max-width: 720px\) \{[\s\S]*?\n\}/u);
  assert.ok(narrow, 'narrow-viewport (≤720px) topbar rules must still exist');
  assert.deepEqual(
    [...narrow[0].matchAll(pattern)].map((match) => match[1]),
    [],
    'the ≤720px topbar block must not reorder focusable elements either',
  );
  // 折三行的实现手段只允许 flex-wrap/width，不应再靠 order。
  assert.match(narrow[0], /flex-wrap:\s*wrap/u);
  t.diagnostic('no order/row-reverse/rtl reordering in any stylesheet (desktop and ≤720px)');
});

// ---------------------------------------------------------------------------
// 真实浏览器：可聚焦顺序 / 可访问名 / 图标隐藏
// ---------------------------------------------------------------------------

test('浏览器 a11y：可聚焦顺序 = DOM 顺序（skip-link 第一），导航 6 项、图标 aria-hidden', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const result = await cdpEvaluate(page, `(() => {
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = [...document.querySelectorAll(selector)];
    const describe = (node) => (node.getAttribute('aria-label') || node.textContent || node.getAttribute('href') || '').trim().slice(0, 40);
    return {
      order: focusable.map((node) => ({
        tag: node.tagName,
        text: describe(node),
        inNav: Boolean(node.closest('#nav')),
      })),
      first: focusable.length ? describe(focusable[0]) : null,
      icons: [...document.querySelectorAll('svg.ui-icon')].map((svg) => svg.getAttribute('aria-hidden')),
      navLabels: [...document.querySelectorAll('#nav a[data-route]')].map((a) => a.getAttribute('aria-label') || a.textContent.trim()),
      unnamed: focusable.filter((node) => {
        const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent || '').trim();
        return label.length === 0 && !node.hasAttribute('aria-hidden');
      }).length,
    };
  })()`, { waitMs: 800, waitForTimeoutMs: 12000, waitForExpression: "document.querySelectorAll('#nav a[data-route]').length === 6 && (document.querySelector('#view-root')?.children.length ?? 0) > 0", timeoutMs: 25000 });
  assert.equal(result.ok, true, `CDP evaluate failed: ${result.reason}`);
  const snapshot = result.value;
  assert.equal(snapshot.order[0].tag, 'A');
  assert.match(snapshot.first, /skip|跳到主内容|Skip/u, 'first tab stop must be the skip link');
  assert.equal(snapshot.navLabels.length, 6);
  assert.equal(snapshot.unnamed, 0, 'every focusable control must have an accessible name');
  assert.ok(snapshot.icons.every((value) => value === 'true'), 'decorative icons must be aria-hidden');
  const navEntries = snapshot.order.filter((entry) => entry.inNav);
  assert.equal(navEntries.length, 6, 'all six nav links are focusable in DOM order');
  t.diagnostic(`focus order head: ${JSON.stringify(snapshot.order.slice(0, 8))}`);
});

test('浏览器 a11y：视觉顺序与 Tab 顺序一致（topbar → nav → main 无反向跳变）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const result = await cdpEvaluate(page, `(() => {
    const selector = 'a[href], button:not([disabled]), input:not([disabled])';
    const nodes = [...document.querySelectorAll(selector)];
    const rows = nodes.map((node) => ({ top: Math.round(node.getBoundingClientRect().top), left: Math.round(node.getBoundingClientRect().left) }));
    let inversions = 0;
    for (let index = 1; index < rows.length; index += 1) {
      // topbar 内多行/换行允许 ±120px 的行内抖动；跨行回退才算逆序。
      if (rows[index].top < rows[index - 1].top - 120) inversions += 1;
    }
    return { count: rows.length, inversions };
  })()`, { waitMs: 800, waitForTimeoutMs: 12000, waitForExpression: "(document.querySelector('#view-root')?.children.length ?? 0) > 0", timeoutMs: 25000 });
  assert.equal(result.ok, true, `CDP evaluate failed: ${result.reason}`);
  assert.ok(result.value.count > 8, 'expected a meaningful number of focusable elements');
  assert.equal(result.value.inversions, 0, 'Tab order must follow visual top-to-bottom order');
  t.diagnostic(`focusable=${result.value.count}`);
});

test('浏览器 a11y：≤720px 窄屏 Tab 顺序 = DOM 顺序 = 视觉顺序，且无横向溢出', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const result = await cdpEvaluate(page, `(() => {
    const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusable = [...document.querySelectorAll(selector)];
    const describe = (node) => (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 30);
    const rows = focusable.map((node, index) => {
      const rect = node.getBoundingClientRect();
      return {
        index,
        tag: node.tagName,
        text: describe(node),
        inNav: Boolean(node.closest('#nav')),
        inTools: Boolean(node.closest('.topbar-tools')),
        isBrand: Boolean(node.closest('.brand')),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
      };
    });
    const topbar = rows.filter((row) => row.isBrand || row.inNav || row.inTools);
    const visual = [...topbar].sort((a, b) => (a.top - b.top) || (a.left - b.left));
    return {
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      visualMatchesDom: JSON.stringify(visual.map((row) => row.index)) === JSON.stringify(topbar.map((row) => row.index)),
      sequence: topbar.map((row) => ({ text: row.text, isBrand: row.isBrand, inNav: row.inNav, inTools: row.inTools, top: row.top })),
      computedOrders: [...document.querySelectorAll('.brand, .topbar-tools, .topbar nav')].map((node) => getComputedStyle(node).order),
      breakpointActive: window.matchMedia('(max-width: 720px)').matches,
    };
  })()`, {
    width: 390,
    height: 844,
    waitMs: 1000,
    waitForTimeoutMs: 15000,
    waitForExpression: "(document.querySelector('#view-root')?.children.length ?? 0) > 0 && !document.body.textContent.includes('[missing:')",
    timeoutMs: 25000,
  });
  assert.equal(result.ok, true, `CDP evaluate failed: ${result.reason}`);
  const snapshot = result.value;

  // 1) 390×844 下媒体块生效，且没有任何元素被 order 重排（computed order 全为 0）
  assert.equal(snapshot.breakpointActive, true, '≤720px media query must be active at 390px');
  for (const order of snapshot.computedOrders) assert.equal(order, '0', 'no element may be reordered via CSS order');
  t.diagnostic(`computed orders: ${JSON.stringify(snapshot.computedOrders)}`);

  // 2) 视觉顺序 = DOM 顺序（品牌 → 导航六项 → 工具栏三个按钮）
  assert.equal(snapshot.visualMatchesDom, true, 'visual order must equal DOM/Tab order at narrow width');
  const names = snapshot.sequence.map((entry) => (entry.isBrand ? 'brand' : entry.inNav ? 'nav' : 'tools'));
  assert.deepEqual(
    names,
    ['brand', ...Array(6).fill('nav'), ...Array(3).fill('tools')],
    `unexpected topbar sequence at 390px: ${JSON.stringify(snapshot.sequence)}`,
  );
  assert.equal(snapshot.sequence[0].top < snapshot.sequence[1].top, true, 'brand row must be above the nav row');

  // 3) 折三行但不横向溢出（≤1px 取整误差）
  assert.ok(
    snapshot.docScrollWidth <= snapshot.docClientWidth + 1,
    `horizontal overflow at 390px: scrollWidth=${snapshot.docScrollWidth} clientWidth=${snapshot.docClientWidth}`,
  );
  t.diagnostic(`390×844: scrollWidth=${snapshot.docScrollWidth} clientWidth=${snapshot.docClientWidth}; order=brand→nav→tools`);
});
