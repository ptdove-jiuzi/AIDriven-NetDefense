/**
 * probe-d13.mjs — 30-second targeted re-check of the D13 page-level overflow (author PT-dove).
 *
 * Used while the fixer is iterating on `styles/**`: reports, per width, the table-container
 * overflow and the *page-level* overflow plus the elements that stick out, without
 * re-running the whole keyboard suite. The authoritative numbers still come from
 * 02-keyboard.mjs.
 */

import { isUp, openBrowser, sleep } from './lib/common.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:17512';
const browser = await openBrowser({ width: 1440, height: 900 });
try {
  if (!(await isUp(Number(new URL(BASE).port || 80)))) {
    process.stdout.write(`${JSON.stringify({ error: `stack down: ${BASE}` })}\n`);
    process.exitCode = 1;
  } else {
    const page = await browser.newPage({ width: 1440, height: 900 });
    await page.setColorScheme('dark');
    await page.goto(`${BASE}/?theme=dark&static=1#/alerts`);
    await page.waitFor(`(() => { const t = document.querySelector('.ui-table'); return t !== null && t.querySelectorAll('tr[data-row="true"]').length > 0; })()`, { timeoutMs: 20000 });
    await sleep(700);
    const rows = [];
    for (const width of [1440, 1280, 1024, 390]) {
      await page.setViewport(width, width === 390 ? 844 : 900);
      await sleep(400);
      rows.push(await page.evaluate(`(() => {
        const scroll = document.querySelector('.ui-table__scroll');
        const clientWidth = document.documentElement.clientWidth;
        const offenders = [];
        const walk = (node) => {
          for (const child of node.children) {
            const cs = getComputedStyle(child);
            if (cs.position === 'fixed' || cs.position === 'absolute') continue;
            if (child.closest('.ui-table__scroll') !== null) continue;
            const rect = child.getBoundingClientRect();
            if (rect.right > clientWidth + 1) {
              offenders.push({ tag: child.tagName, cls: String(child.className ?? '').slice(0, 40), right: Math.round(rect.right) });
            }
            walk(child);
          }
        };
        walk(document.body);
        return {
          width: ${width},
          containerOverflowPx: scroll === null ? null : Math.round(scroll.scrollWidth - scroll.clientWidth),
          pageOverflowPx: Math.max(0, document.documentElement.scrollWidth - clientWidth),
          offenders: offenders.slice(0, 4),
        };
      })()`));
    }
    process.stdout.write(`${JSON.stringify({ base: BASE, rows }, null, 2)}\n`);
    // Visual confirmation that the narrow layout still shows the top bar controls (a fix
    // that only clips them would also remove the overflow).
    await page.setViewport(390, 844);
    await sleep(500);
    const shot = await page.screenshot();
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { RESULTS } = await import('./lib/common.mjs');
    writeFileSync(join(RESULTS, 'probe-d13-390.png'), shot);
    process.stdout.write(`${JSON.stringify({ screenshot: join(RESULTS, 'probe-d13-390.png'), bytes: shot.length })}\n`);
    process.exitCode = rows.every((row) => row.width === 390 ? row.pageOverflowPx === 0 : true) ? 0 : 2;
  }
} finally {
  await browser.close();
}
