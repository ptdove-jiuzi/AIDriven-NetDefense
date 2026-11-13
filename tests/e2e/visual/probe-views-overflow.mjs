/**
 * probe-views-overflow.mjs — quick page-level overflow sweep across all six views at the
 * narrow/tight widths (author PT-dove). Used to tell the fixer whether the D13 fix holds
 * on every view, not just alerts. Authoritative screenshots still come from 01-shots.mjs.
 */

import { isUp, openBrowser, sleep } from './lib/common.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:17512';
const VIEWS = ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'];
const browser = await openBrowser({ width: 1440, height: 900 });
try {
  if (!(await isUp(Number(new URL(BASE).port || 80)))) {
    process.stdout.write(`${JSON.stringify({ error: `stack down: ${BASE}` })}\n`);
    process.exitCode = 1;
  } else {
    const rows = [];
    for (const width of [390, 1024]) {
      const page = await browser.newPage({ width, height: width === 390 ? 844 : 900 });
      await page.setColorScheme('dark');
      try {
        for (const view of VIEWS) {
          if (view === VIEWS[0]) {
            await page.goto(`${BASE}/?theme=dark&static=1#/${view}`);
          } else {
            await page.evaluate(`(() => { location.hash = '#/${view}'; })()`);
            await page.waitFor(`location.hash.includes(${JSON.stringify(`#/${view}`)})`, { timeoutMs: 8000 });
          }
          await page.waitFor(`(() => { const r = document.querySelector('#view-root'); return r !== null && (r.innerText ?? '').trim().length > 100; })()`, { timeoutMs: 20000 }).catch(() => {});
          await sleep(1400);
          rows.push(await page.evaluate(`(() => {
            const clientWidth = document.documentElement.clientWidth;
            const offenders = [];
            const walk = (node) => {
              for (const child of node.children) {
                const cs = getComputedStyle(child);
                if (cs.position === 'fixed' || cs.position === 'absolute') continue;
                if (child.closest('.ui-table__scroll') !== null) continue;
                const rect = child.getBoundingClientRect();
                if (rect.right > clientWidth + 1) offenders.push({ tag: child.tagName, cls: String(child.className ?? '').slice(0, 36), right: Math.round(rect.right) });
                walk(child);
              }
            };
            walk(document.body);
            return {
              width: ${width},
              view: ${JSON.stringify(view)},
              pageOverflowPx: Math.max(0, document.documentElement.scrollWidth - clientWidth),
              offenders: offenders.slice(0, 3),
              textLength: (document.querySelector('#view-root')?.innerText ?? '').replace(/\\s+/gu, ' ').trim().length,
            };
          })()`));
        }
      } finally {
        await page.connection.send('Target.closeTarget', { targetId: page.targetId });
      }
    }
    process.stdout.write(`${JSON.stringify({ base: BASE, rows }, null, 2)}\n`);
    process.exitCode = rows.some((row) => row.pageOverflowPx > 0) ? 2 : 0;
  }
} finally {
  await browser.close();
}
