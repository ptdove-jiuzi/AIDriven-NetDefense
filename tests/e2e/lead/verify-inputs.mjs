/**
 * verify-inputs.mjs — hard criterion: an input the UI presents must actually accept typing.
 *
 * Regression for D15: `dom.js setProp()` set the `readonly` *attribute* for every input
 * (because `field.js` always passes `readOnly: Boolean(...)`, and `false` is not null), so the
 * whole console looked fine in screenshots while every text field was silently read-only.
 * Screenshots and DOM snapshots cannot see that; only real keystrokes can.
 *
 * usage: node tests/e2e/lead/verify-inputs.mjs [--base http://127.0.0.1:17512] [--out <dir>]
 */

import { launch } from '../lib/cdp.mjs';
import { Checker, parseArgs, viewUrl, writeEvidence } from './common.mjs';

/** Type into a selector by focusing it and inserting real text through CDP. */
async function typeInto(page, selector, text) {
  const box = await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return null;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (box === null) return null;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.connection.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
    }, page.sessionId);
  }
  await page.connection.send('Input.insertText', { text }, page.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 600));
  return page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    return el === null ? null : {
      value: el.value,
      readOnly: el.readOnly,
      readOnlyAttribute: el.hasAttribute('readonly'),
      focused: document.activeElement === el,
    };
  })()`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checker = new Checker('presented inputs accept typing (no silent read-only fields)');
  const runs = {};
  const browser = await launch({ width: 1440, height: 900 });
  try {
    const page = await browser.newPage();

    // ---- 1) alert search must accept typing and drive the filter ------------
    await page.goto(viewUrl(args.base, 'alerts', { theme: 'dark', lang: 'zh-CN' }));
    await page.waitFor(`document.querySelectorAll('[data-action="detail"]').length > 0`, {
      timeoutMs: 25_000, label: 'alert rows',
    });
    const beforeLength = await page.evaluate(`(document.querySelector('#view-root')?.innerText ?? '').length`);
    const search = await typeInto(page, 'input[type="search"]', 'svchost');
    runs.search = search;
    checker.ok(search !== null, 'the alerts view has a search input', search);
    checker.ok(search !== null && search.readOnly === false && search.readOnlyAttribute === false,
      'the search input is not read-only', search);
    checker.ok(search !== null && search.value === 'svchost', 'typing lands in the search box',
      { expected: 'svchost', actual: search?.value });
    const afterLength = await page.evaluate(`(document.querySelector('#view-root')?.innerText ?? '').length`);
    runs.searchEffect = { beforeLength, afterLength };
    checker.ok(afterLength !== beforeLength, 'typing in the search box changes what the view shows',
      runs.searchEffect);

    // ---- 2) the analysis search must accept typing too ----------------------
    await page.goto(viewUrl(args.base, 'analysis', { theme: 'dark', lang: 'zh-CN' }));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const analysisSearch = await typeInto(page, 'input[type="search"]', 'queued');
    runs.analysisSearch = analysisSearch;
    checker.ok(analysisSearch !== null && analysisSearch.value === 'queued',
      'the analysis search accepts typing', analysisSearch);

    // ---- 3) provider fields must be editable (a settings UI you cannot edit) --
    await page.goto(viewUrl(args.base, 'models', { theme: 'dark', lang: 'zh-CN' }));
    await page.waitFor(`document.querySelectorAll('input[type="number"]').length > 0`, {
      timeoutMs: 25_000, label: 'provider number inputs',
    });
    const numberInput = await typeInto(page, 'input[type="number"]', '7');
    runs.providerNumber = numberInput;
    checker.ok(numberInput !== null && numberInput.readOnly === false
      && numberInput.readOnlyAttribute === false, 'provider numeric fields are editable', numberInput);

    // A password field must be writable and must not echo anything back.
    await page.goto(viewUrl(args.base, 'settings', { theme: 'dark', lang: 'zh-CN' }));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const password = await page.evaluate(`(() => {
      const el = document.querySelector('input[type="password"]');
      if (el === null) return null;
      return { exists: true, readOnly: el.readOnly, readOnlyAttribute: el.hasAttribute('readonly'),
        value: el.value, visibleInText: (document.body.innerText ?? '').includes('canary-not-typed') };
    })()`);
    runs.password = password;
    checker.ok(password !== null && password.readOnly === false, 'the API key field is editable', password);

    // ---- 4) sweep: no presented text field may be read-only ----------------
    const sweep = await page.evaluate(`(() => {
      const fields = [...document.querySelectorAll('input[type="text"], input[type="search"], input[type="number"], textarea')];
      const readOnly = fields.filter((node) => node.readOnly || node.hasAttribute('readonly'))
        .map((node) => ({ type: node.type, aria: node.getAttribute('aria-label'), value: String(node.value).slice(0, 20) }));
      return { total: fields.length, readOnly };
    })()`);
    runs.sweep = sweep;
    checker.ok(sweep.readOnly.length === 0, 'no editable-looking field in settings is read-only', sweep);
  } finally {
    await browser.close();
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'inputs.json', { at: new Date().toISOString(), base: args.base, runs, summary });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-inputs: ${error?.stack ?? error}\n`);
  process.exit(1);
});
