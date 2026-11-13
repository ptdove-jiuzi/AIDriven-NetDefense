/**
 * verify-drawer.mjs — hard criterion: the alert drawer must close three ways
 * (X button / backdrop click / Escape), and must return focus to its trigger.
 *
 * These are real mouse and keyboard events through CDP, not `element.click()`.
 *
 * usage: node tests/e2e/lead/verify-drawer.mjs [--base http://127.0.0.1:17512] [--out <dir>]
 */

import { launch } from '../lib/cdp.mjs';
import { Checker, parseArgs, viewUrl, writeEvidence } from './common.mjs';

/** Wait until `expression` is truthy, polling in-page. */
async function waitFor(page, expression, label, timeoutMs = 6000) {
  try {
    await page.waitFor(expression, { timeoutMs, label });
    return true;
  } catch {
    return false;
  }
}

/** Read drawer state plus where focus currently is. */
const STATE = `(() => {
  const overlay = document.querySelector('.ui-drawer');
  const active = document.activeElement;
  const panel = document.querySelector('.ui-drawer__panel');
  return {
    open: overlay !== null,
    panel: panel === null ? null : panel.getBoundingClientRect().toJSON(),
    activeTag: active?.tagName ?? null,
    activeAction: active?.getAttribute?.('data-action') ?? null,
    activeInDrawer: overlay !== null && active !== null && overlay.contains(active),
    focusVisible: (() => {
      if (active === null) return false;
      const style = getComputedStyle(active);
      return String(style.outlineStyle) !== 'none' || String(style.boxShadow) !== 'none';
    })(),
    scrollLocked: document.documentElement.classList.contains('ui-scroll-lock'),
    drawerRoots: document.querySelectorAll('.ui-drawer').length,
  };
})()`;

/** Wait for a drawer to appear after a click. */
async function openDrawer(page) {
  await page.goto(viewUrl(page.base, 'alerts', { theme: 'dark', lang: 'zh-CN' }));
  await page.waitFor(`document.querySelectorAll('[data-action="detail"]').length > 0`, {
    timeoutMs: 15_000, label: 'alert rows rendered',
  });
  await page.click('[data-action="detail"]');
  return waitFor(page, `document.querySelector('.ui-drawer') !== null`, 'drawer opened');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checker = new Checker('drawer closes three ways and restores focus');
  const runs = {};
  const browser = await launch({ width: 1440, height: 900 });
  try {
    const page = await browser.newPage();
    page.base = args.base;

    // ---- close 1: the X button -------------------------------------------------
    let opened = await openDrawer(page);
    checker.ok(opened, 'drawer opens from the first alert detail button');
    let state = await page.evaluate(STATE);
    checker.ok(state.activeInDrawer === true, 'focus moves into the drawer when it opens', state);
    await page.click('.ui-drawer__close');
    await waitFor(page, `document.querySelector('.ui-drawer') === null`, 'drawer closed by X');
    let after = await page.evaluate(STATE);
    runs.closeButton = { opened, state, after };
    checker.ok(after.open === false, 'X button closes the drawer', after);
    checker.ok(after.activeAction === 'detail', 'focus returns to the trigger after X', after);
    checker.ok(after.scrollLocked === false, 'scroll lock is released after X', after);
    checker.equal(after.drawerRoots, 0, 'no drawer node is left behind after X');

    // ---- close 2: backdrop click ----------------------------------------------
    opened = await openDrawer(page);
    state = await page.evaluate(STATE);
    const panel = state.panel;
    const backdropX = Math.max(2, Math.round(panel.x - 24));
    const backdropY = Math.round(panel.y + panel.height / 2);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.connection.send('Input.dispatchMouseEvent', {
        type, x: backdropX, y: backdropY, button: 'left', clickCount: 1,
      }, page.sessionId);
    }
    await waitFor(page, `document.querySelector('.ui-drawer') === null`, 'drawer closed by backdrop');
    after = await page.evaluate(STATE);
    runs.backdrop = { opened, panel, clickedAt: { x: backdropX, y: backdropY }, after };
    checker.ok(opened, 'drawer reopens for the backdrop test');
    checker.ok(after.open === false, 'backdrop click closes the drawer', after);
    checker.ok(after.activeAction === 'detail', 'focus returns to the trigger after backdrop close', after);

    // ---- close 3: Escape -------------------------------------------------------
    opened = await openDrawer(page);
    state = await page.evaluate(STATE);
    checker.ok(state.activeInDrawer === true, 'focus is inside the drawer before Escape', state);
    await page.escape();
    await waitFor(page, `document.querySelector('.ui-drawer') === null`, 'drawer closed by Escape');
    after = await page.evaluate(STATE);
    runs.escape = { opened, state, after };
    checker.ok(after.open === false, 'Escape closes the drawer', after);
    checker.ok(after.activeAction === 'detail', 'focus returns to the trigger after Escape', after);
    checker.equal(after.drawerRoots, 0, 'no drawer node is left behind after Escape');

    // ---- the drawer must not leak into the other views -------------------------
    await page.goto(viewUrl(args.base, 'overview', { theme: 'dark', lang: 'zh-CN' }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    const afterNav = await page.evaluate(STATE);
    runs.afterNavigation = afterNav;
    checker.equal(afterNav.drawerRoots, 0, 'navigating away leaves no drawer overlay behind');
    checker.equal(afterNav.scrollLocked, false, 'navigating away releases the scroll lock');
  } finally {
    await browser.close();
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'drawer.json', { at: new Date().toISOString(), base: args.base, runs, summary });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-drawer: ${error?.stack ?? error}\n`);
  process.exit(1);
});
