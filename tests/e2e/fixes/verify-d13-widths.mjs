/**
 * tests/e2e/fixes/verify-d13-widths.mjs — D13 四档视口实测 + 390 截图矩阵（作者 PT-dove）
 *
 * 输出：docs/implementation/evidence/ui2/fixes/
 *   - d13-widths.json   390/1024/1280/1440 × 6 视图 × 两栈的页面级溢出数字
 *   - d13-390-*.png     390×844 截图矩阵（6 视图 × 暗/亮，data 栈）
 *
 * 运行：node tests/e2e/fixes/verify-d13-widths.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from '../lib/cdp.mjs';
import { REPO_ROOT } from './lib/mutate-module.mjs';

const OUT = join(REPO_ROOT, 'docs/implementation/evidence/ui2/fixes');
const VIEWS = ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'];
const WIDTHS = [390, 1024, 1280, 1440];
const BASES = [
  { name: 'data', base: process.env.FIXES_DATA_BASE || 'http://127.0.0.1:17512' },
  { name: 'mock', base: process.env.FIXES_MOCK_BASE || 'http://127.0.0.1:17522' },
];
const HEIGHT_FOR = (width) => (width === 390 ? 844 : width === 1024 ? 768 : 900);

const PROBE = `(() => {
  const de = document.scrollingElement;
  const vw = window.innerWidth;
  const contained = (node) => {
    let current = node.parentElement;
    while (current !== null && current !== document.body) {
      const overflowX = getComputedStyle(current).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') return true;
      current = current.parentElement;
    }
    return false;
  };
  let leaks = 0;
  for (const node of document.querySelectorAll('body *')) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > vw + 1 && !contained(node)) leaks += 1;
  }
  const nav = document.querySelector('#nav');
  const navLinks = nav ? [...nav.querySelectorAll('a')] : [];
  return {
    innerWidth: vw,
    pageOverflow: de.scrollWidth - de.clientWidth,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    leakedElements: leaks,
    navLinkCount: navLinks.length,
    navOffscreen: navLinks.filter((link) => link.getBoundingClientRect().right > vw + 1).length,
    topbarHeight: document.querySelector('.topbar') ? Math.round(document.querySelector('.topbar').getBoundingClientRect().height) : 0,
    overflowXHtml: getComputedStyle(document.documentElement).overflowX,
    overflowXBody: getComputedStyle(document.body).overflowX,
  };
})()`;

mkdirSync(OUT, { recursive: true });
const result = {
  schemaVersion: 1,
  tool: 'tests/e2e/fixes/verify-d13-widths.mjs',
  generatedAt: new Date().toISOString(),
  rows: [],
  shots: [],
};
const browser = await launch({ headless: true, width: 390, height: 844 });
try {
  for (const { name, base } of BASES) {
    for (const width of WIDTHS) {
      const height = HEIGHT_FOR(width);
      const page = await browser.newPage({ width, height });
      await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
      try {
        for (const view of VIEWS) {
          await page.setColorScheme('dark');
          await page.goto(`${base}/?theme=dark&lang=en&static=1#/${view}`);
          await page.waitFor(`(document.querySelector('#view-root')?.innerText || '').trim().length > 20`, {
            timeoutMs: 30_000,
            label: `${name} ${view} @${width}`,
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
          const probe = await page.evaluate(PROBE);
          result.rows.push({ stack: name, view, width, height, theme: 'dark', ...probe });
          // 390 档留截图矩阵（6 视图 × 暗/亮，data 栈）。
          if (width === 390 && name === 'data') {
            for (const theme of ['dark', 'light']) {
              if (theme === 'light') {
                await page.setColorScheme('light');
                await page.goto(`${base}/?theme=light&lang=en&static=1#/${view}`);
                await page.waitFor(`(document.querySelector('#view-root')?.innerText || '').trim().length > 20`, { timeoutMs: 30_000 });
                await new Promise((resolve) => setTimeout(resolve, 400));
              }
              const shot = `d13-390-${view}-${theme}.png`;
              writeFileSync(join(OUT, shot), await page.screenshot({ fullPage: true }));
              result.shots.push(shot);
            }
            await page.setColorScheme('dark');
          }
        }
      } finally {
        await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
      }
    }
  }
} finally {
  await browser.close();
}

writeFileSync(join(OUT, 'd13-widths.json'), `${JSON.stringify(result, null, 2)}\n`);
const byWidth = {};
for (const row of result.rows) {
  byWidth[row.width] = byWidth[row.width] || { maxOverflow: 0, rows: 0, leaks: 0 };
  byWidth[row.width].maxOverflow = Math.max(byWidth[row.width].maxOverflow, row.pageOverflow);
  byWidth[row.width].leaks += row.leakedElements;
  byWidth[row.width].rows += 1;
}
process.stdout.write(`${JSON.stringify({ shots: result.shots.length, rows: result.rows.length, byWidth }, null, 2)}\n`);
