/**
 * investigate.mjs — targeted follow-up probes for the anomalies seen in 02-keyboard
 * (throwaway; keeps the finding evidence under results/investigate.json). Author PT-dove.
 */
import { join } from 'node:path';
import { launch } from '../lib/cdp.mjs';
import { RESULTS, writeJson, sleep } from './lib/common.mjs';

const BASE = 'http://127.0.0.1:17512';
const out = {};
const browser = await launch({ headless: true, width: 1440, height: 900 });
try {
  /* ---------- 1. alerts: focusable order around the step-20 anomaly ---------- */
  {
    const page = await browser.newPage({ width: 1440, height: 900 });
    await page.setColorScheme('dark');
    await page.goto(`${BASE}/?theme=dark&static=1#/alerts`);
    await page.waitFor(`(() => { const t = document.querySelector('.ui-table'); return t !== null && t.querySelectorAll('tr[data-row="true"]').length > 0; })()`, { timeoutMs: 20000 });
    await sleep(900);
    await page.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    const steps = [];
    for (let step = 1; step <= 23; step += 1) {
      await page.tab();
      await sleep(60);
      steps.push(await page.evaluate(`(() => {
        const ae = document.activeElement;
        const rect = ae ? ae.getBoundingClientRect() : null;
        const cs = ae ? getComputedStyle(ae) : null;
        return { step: ${step}, tag: ae ? ae.tagName : null, id: ae ? (ae.id || null) : null,
          cls: ae ? String(ae.className ?? '').slice(0, 60) : null,
          text: ae ? (ae.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 40) : null,
          rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
          display: cs ? cs.display : null, visibility: cs ? cs.visibility : null,
          outline: cs ? cs.outlineStyle + ' ' + cs.outlineWidth : null,
          tabIndex: ae ? ae.getAttribute('tabindex') : null };
      })()`));
    }
    const order = await page.evaluate(`(() => {
      const TABBABLE = 'a[href],area[href],button,input,select,textarea,iframe,object,embed,[tabindex],[contenteditable="true"]';
      return [...document.querySelectorAll(TABBABLE)].map((node, index) => {
        const rect = node.getBoundingClientRect();
        const cs = getComputedStyle(node);
        return { index, tag: node.tagName, cls: String(node.className ?? '').slice(0, 40),
          text: (node.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 30),
          tabindex: node.getAttribute('tabindex'), disabled: node.disabled === true,
          w: Math.round(rect.width), h: Math.round(rect.height),
          display: cs.display, visibility: cs.visibility,
          ariaHidden: node.getAttribute('aria-hidden'),
          hiddenAncestor: node.closest('[aria-hidden="true"]') !== null };
      });
    })()`);
    out.alertsFocus = { steps, tabbable: order };
    await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  }

  /* ---------- 2. what overflows the document at 390 / 1024 ---------- */
  {
    const page = await browser.newPage({ width: 390, height: 844 });
    await page.setColorScheme('dark');
    await page.goto(`${BASE}/?theme=dark&static=1#/alerts`);
    await page.waitFor(`(() => { const t = document.querySelector('.ui-table'); return t !== null && t.querySelectorAll('tr[data-row="true"]').length > 0; })()`, { timeoutMs: 20000 });
    await sleep(900);
    out.overflow390 = await page.evaluate(`(() => {
      const clientWidth = document.documentElement.clientWidth;
      const offenders = [];
      const walk = (node) => {
        for (const child of node.children) {
          const rect = child.getBoundingClientRect();
          const cs = getComputedStyle(child);
          if (rect.right > clientWidth + 1 && cs.position !== 'fixed') {
            offenders.push({ tag: child.tagName, cls: String(child.className ?? '').slice(0, 80),
              right: Math.round(rect.right), width: Math.round(rect.width),
              text: (child.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 40) });
          }
          walk(child);
        }
      };
      walk(document.body);
      return { clientWidth, scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        offenders: offenders.slice(0, 25), offenderCount: offenders.length };
    })()`);
    await page.setViewport(1024, 900);
    await sleep(400);
    out.overflow1024 = await page.evaluate(`(() => {
      const scroll = document.querySelector('.ui-table__scroll');
      return { clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, overflowX: scroll.scrollWidth - scroll.clientWidth };
    })()`);
    const shot = await page.screenshot();
    await (await import('node:fs')).promises.writeFile(join(RESULTS, 'investigate-390.png'), shot);
    await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  }

  /* ---------- 3. settings: provider cards + what opens a modal ---------- */
  {
    const page = await browser.newPage({ width: 1440, height: 900 });
    await page.setColorScheme('dark');
    await page.goto(`${BASE}/?theme=dark&static=1#/settings`);
    await page.waitFor(`(() => document.querySelector('.settings-view') !== null)()`, { timeoutMs: 25000 });
    await sleep(1500);
    const before = await page.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.settings-provider')];
      return {
        cardCount: cards.length,
        cards: cards.map((card) => ({
          providerId: card.getAttribute('data-provider-id'),
          index: card.getAttribute('data-index'),
          textHead: (card.innerText ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 80),
          buttons: [...card.querySelectorAll('button')].map((button) => ({
            text: (button.innerText ?? '').trim().slice(0, 40),
            aria: button.getAttribute('aria-label'),
            disabled: button.disabled === true,
            cls: String(button.className ?? '').slice(0, 60),
          })),
        })),
        tabIds: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({ id: tab.id, selected: tab.getAttribute('aria-selected'), text: (tab.innerText ?? '').trim() })),
        activeGroup: document.querySelector('#view-root [role="tab"][aria-selected="true"]')?.id ?? null,
        dangerButtons: [...document.querySelectorAll('.ui-btn--danger')].map((button) => ({ text: (button.innerText ?? '').trim().slice(0, 40), disabled: button.disabled === true })),
      };
    })()`);
    // Try each provider remove button and report whether a modal appears.
    const attempts = [];
    const buttonCount = await page.evaluate(`(() => document.querySelectorAll('.settings-provider__head button').length)()`);
    for (let index = 0; index < Math.min(buttonCount, 4); index += 1) {
      const clicked = await page.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.settings-provider__head button')];
        const button = buttons[${index}];
        if (button === undefined) return null;
        const text = (button.innerText ?? '').trim();
        button.click();
        return text;
      })()`);
      await sleep(700);
      const state = await page.evaluate(`(() => ({
        modalCount: document.querySelectorAll('[data-overlay="modal"]').length,
        modalRole: document.querySelector('.ui-modal__panel')?.getAttribute('role') ?? null,
        providerCards: document.querySelectorAll('.settings-provider').length,
      }))()`);
      attempts.push({ index, clicked, state });
      if (state.modalCount > 0) {
        await page.escape();
        await sleep(300);
      }
    }
    out.settings = { before, attempts };
    await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  }
} finally {
  await browser.close();
}
writeJson(join(RESULTS, 'investigate.json'), out);
process.stdout.write(`${JSON.stringify(out, null, 2).slice(0, 12000)}\n`);
