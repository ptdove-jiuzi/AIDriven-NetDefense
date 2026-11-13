/**
 * tests/e2e/fixes/responsive-d13.test.js — D13 回归：390×844 无页面级横向溢出（作者 PT-dove）
 *
 * 缺陷（`docs/implementation/evidence/ui2/defects.md` D13，P1）：
 *   390×844 下 `document.scrollingElement.scrollWidth` 比 clientWidth 多 ~151–212px；
 *   `.topbar-tools` 的 right 远超 390，导航项被裁到屏幕外（visual-a11y 终轮 24/24 张 390 截图都溢出）。
 *
 * 断言（改前红 / 改后绿）：
 *   1. 6 个视图 × 暗/亮 × 两套栈（有数据 17512 / 空库 17522）：`scrollWidth <= clientWidth + 1`；
 *   2. 折算到视口：没有任何元素 `right > innerWidth + 1`（导航/按钮必须真的在屏幕里，不是靠裁切遮盖）；
 *   3. 六个主导航链接每个都完整可见（right ≤ innerWidth + 1）—— D13 的核心可用性；
 *   4. 不许用 `overflow-x: hidden/clip` 掩盖：html/body/#app/.topbar 的 computed overflow-x 不得是 hidden/clip；
 *   5. 页头不能因此压扁导航：`#nav` 的高度 > 0 且链接数 = 6。
 *
 * 运行：node --test tests/e2e/fixes/responsive-d13.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from '../lib/cdp.mjs';

const VIEWS = Object.freeze(['#/overview', '#/alerts', '#/analysis', '#/agent', '#/models', '#/settings']);
const BASES = Object.freeze([
  { name: 'data', base: process.env.FIXES_DATA_BASE || 'http://127.0.0.1:17512' },
  { name: 'mock', base: process.env.FIXES_MOCK_BASE || 'http://127.0.0.1:17522' },
]);
const WIDTH = 390;
const HEIGHT = 844;
const TOLERANCE = 1;

const PROBE = `(() => {
  const de = document.scrollingElement;
  const vw = window.innerWidth;
  const describe = (node) => {
    const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).slice(0, 2).join('.');
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (cls ? '.' + cls : '');
  };
  const offenders = [];
  // 只有"没有被任何可滚动/裁剪容器接住"的越界元素才算页面级泄漏：
  // 表格、tab 条等本来就在 overflow:auto 的容器里横向滚动，这是设计允许的（不是 D13 的页面级溢出）。
  const contained = (node) => {
    let current = node.parentElement;
    while (current !== null && current !== document.body) {
      const overflowX = getComputedStyle(current).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') return true;
      current = current.parentElement;
    }
    return false;
  };
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > vw + ${TOLERANCE} - 0.5 && !contained(node)) {
      offenders.push({ sel: describe(node), right: Math.round(rect.right), width: Math.round(rect.width) });
    }
  }
  const overflowX = (selector) => {
    const node = selector === 'html' ? document.documentElement : document.querySelector(selector);
    return node === null ? null : getComputedStyle(node).overflowX;
  };
  const nav = document.querySelector('#nav');
  const navLinks = nav ? [...nav.querySelectorAll('a')] : [];
  return {
    hash: location.hash,
    innerWidth: vw,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    overflow: de.scrollWidth - de.clientWidth,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, 12),
    navLinkCount: navLinks.length,
    navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : 0,
    navLinksOffscreen: navLinks
      .map((link) => ({ text: (link.textContent || '').trim(), right: Math.round(link.getBoundingClientRect().right) }))
      .filter((entry) => entry.right > vw + ${TOLERANCE} - 0.5),
    overflowX: { html: overflowX('html'), body: overflowX('body'), app: overflowX('#app'), topbar: overflowX('.topbar') },
    topbarHeight: document.querySelector('.topbar') ? Math.round(document.querySelector('.topbar').getBoundingClientRect().height) : 0,
  };
})()`;

describe('D13 · 390×844 页面级横向溢出', () => {
  /** @type {Awaited<ReturnType<typeof launch>>|null} */
  let browser = null;

  before(async () => {
    browser = await launch({ headless: true, width: WIDTH, height: HEIGHT });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  for (const { name, base } of BASES) {
    for (const view of VIEWS) {
      test(`${name} 栈 ${view} @390：无横向溢出、导航全部在屏内、无 overflow 遮盖`, async () => {
        const page = await browser.newPage({ width: WIDTH, height: HEIGHT });
        try {
          await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
          for (const theme of ['dark', 'light']) {
            await page.setColorScheme(theme);
            await page.goto(`${base}/?theme=${theme}&lang=en&static=1${view}`);
            await page.waitFor(`(document.querySelector('#view-root')?.innerText || '').trim().length > 20`, {
              timeoutMs: 30_000,
              label: `${name} ${view} ${theme}`,
            });
            await new Promise((resolve) => setTimeout(resolve, 600));
            const probe = await page.evaluate(PROBE);
            const label = `${name} ${view} ${theme} @${WIDTH}`;

            assert.equal(probe.innerWidth, WIDTH, `${label}: 视口应为 ${WIDTH}，实际 ${probe.innerWidth}`);
            assert.ok(
              probe.overflow <= TOLERANCE,
              `${label}: 页面级横向溢出 ${probe.overflow}px（scrollWidth ${probe.scrollWidth} > clientWidth ${probe.clientWidth}）→ offenders=${JSON.stringify(probe.offenders)}`,
            );
            assert.equal(
              probe.offenderCount,
              0,
              `${label}: 有 ${probe.offenderCount} 个元素超出视口 → ${JSON.stringify(probe.offenders)}`,
            );
            assert.equal(probe.navLinkCount, 6, `${label}: 主导航链接应为 6 个，实际 ${probe.navLinkCount}`);
            assert.deepEqual(probe.navLinksOffscreen, [], `${label}: 导航链接被裁到屏外 → ${JSON.stringify(probe.navLinksOffscreen)}`);
            assert.ok(probe.navHeight > 0, `${label}: #nav 高度被压成 0`);
            for (const [selector, value] of Object.entries(probe.overflowX)) {
              assert.ok(
                value !== 'hidden' && value !== 'clip',
                `${label}: ${selector} 用 overflow-x:${value} 遮盖溢出（掩盖而非修复）`,
              );
            }
          }
        } finally {
          await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
        }
      });
    }
  }
});
