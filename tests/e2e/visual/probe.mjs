/**
 * probe.mjs — exploratory probe (throwaway) to learn the live console DOM.
 * Writes evidence/ui2/visual/probe.json. Author PT-dove.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from '../lib/cdp.mjs';

const BASE = 'http://127.0.0.1:17512';
const OUT = join(process.cwd(), 'docs', 'implementation', 'evidence', 'ui2', 'visual');
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const txt = (el) => (el?.innerText ?? '').replace(/\\s+/g, ' ').trim();
  const root = document.querySelector('#view-root');
  const tables = [...document.querySelectorAll('.ui-table')].map((t) => ({
    virtual: t.getAttribute('data-virtual'),
    rows: t.getAttribute('data-rows'),
    domRows: t.querySelectorAll('tr[data-row="true"]').length,
    allDomNodes: t.querySelectorAll('*').length,
    ariaRowcount: t.querySelector('table')?.getAttribute('aria-rowcount'),
    scrollable: t.querySelector('.ui-table__scroll')?.scrollHeight ?? null,
  }));
  const badges = [...document.querySelectorAll('.ui-badge')].slice(0, 6).map((b) => ({
    tone: b.getAttribute('data-tone'),
    text: txt(b),
    cls: b.className,
  }));
  const rows = [...document.querySelectorAll('tr[data-row="true"]')].slice(0, 3).map((r) => ({
    idx: r.getAttribute('data-index'),
    clickable: r.getAttribute('data-clickable'),
    tabIndex: r.getAttribute('tabindex'),
    text: txt(r).slice(0, 120),
  }));
  return {
    hash: location.hash,
    theme: document.body.getAttribute('data-theme'),
    htmlLang: document.documentElement.getAttribute('lang'),
    bodyTextLen: txt(document.body).length,
    rootTextLen: txt(root).length,
    rootElements: root?.querySelectorAll('*').length ?? -1,
    missingKeys: [...new Set((txt(document.body).match(/\\[missing:[^\\]]+\\]/g) ?? []))].slice(0, 8),
    missingCount: (txt(document.body).match(/\\[missing:/g) ?? []).length,
    tables,
    badges,
    rows,
    errorText: (document.querySelector('.settings-view [role="alert"], [data-error], .ui-empty')?.innerText ?? '').slice(0, 300),
    buttons: [...document.querySelectorAll('button')].slice(0, 14).map((b) => ({ id: b.id, text: txt(b).slice(0, 40), aria: b.getAttribute('aria-label') })),
    focusables: [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].length,
  };
})()`;

const browser = await launch({ width: 1440, height: 900 });
const results = {};
try {
  for (const route of ['#/overview', '#/alerts', '#/settings', '#/models']) {
    const page = await browser.newPage({ width: 1440, height: 900 });
    await page.setColorScheme('dark');
    await page.goto(`${BASE}/?theme=dark&static=1${route}`);
    await sleep(2500);
    results[route] = await page.evaluate(PROBE);

    if (route === '#/alerts') {
      // open drawer by clicking the first clickable row
      const clicked = await page.evaluate(`(() => {
        const row = document.querySelector('tr[data-row="true"][data-clickable="true"]');
        if (!row) return null;
        row.click();
        return true;
      })()`);
      await sleep(600);
      results.drawer = await page.evaluate(`(() => {
        const ov = document.querySelector('[data-overlay="drawer"]');
        const panel = ov?.querySelector('.ui-drawer__panel');
        const ae = document.activeElement;
        const cs = getComputedStyle(ae);
        return {
          opened: Boolean(ov),
          ovClass: ov?.className ?? null,
          panelRole: panel?.getAttribute('role') ?? null,
          panelAriaModal: panel?.getAttribute('aria-modal') ?? null,
          panelAriaLabelledby: panel?.getAttribute('aria-labelledby') ?? null,
          activeTag: ae?.tagName, activeClass: ae?.className, activeAria: ae?.getAttribute('aria-label'),
          activeInsidePanel: panel ? panel.contains(ae) : false,
          outline: [cs.outlineStyle, cs.outlineWidth, cs.outlineColor].join(' '),
          bodyTextInPanel: (panel?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 200),
          focusableInPanel: panel ? [...panel.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].length : 0,
          bgAriaHidden: document.getElementById('app')?.getAttribute('aria-hidden') ?? null,
        };
      })()`);
      await page.evaluate(`(() => { document.querySelector('.ui-drawer__close')?.click(); })()`);
      await sleep(300);
      results.drawerClosed = await page.evaluate(`(() => {
        const ae = document.activeElement;
        return {
          overlayGone: document.querySelector('[data-overlay="drawer"]') === null,
          activeTag: ae?.tagName, activeRow: ae?.getAttribute?.('data-index') ?? null,
          activeClickable: ae?.getAttribute?.('data-clickable') ?? null,
        };
      })()`);
      // tab through 12 steps
      await page.evaluate(`(() => document.querySelector('#view-root')?.focus())()`);
      const tabs = [];
      for (let i = 0; i < 12; i += 1) {
        await page.tab();
        await sleep(60);
        tabs.push(await page.evaluate(`(() => {
          const ae = document.activeElement;
          const cs = getComputedStyle(ae);
          return { tag: ae?.tagName, id: ae?.id, cls: String(ae?.className ?? '').slice(0,40), aria: ae?.getAttribute?.('aria-label'), text: (ae?.innerText ?? '').replace(/\\s+/g,' ').trim().slice(0,40), outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow, inAriaHidden: Boolean(ae?.closest?.('[aria-hidden="true"]')), display: cs.display };
        })()`));
      }
      results.tabs = tabs;
    }
    await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, 'probe.json'), JSON.stringify(results, null, 2));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
