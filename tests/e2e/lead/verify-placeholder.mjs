/**
 * verify-placeholder.mjs — hard criterion: an unimplemented or broken view must show the
 * explicit "this page is not implemented" state, never a white screen and never fake data.
 *
 * Method: block a view module at the network layer (`Network.setBlockedURLs`), navigate to
 * that route, and require the router's placeholder to render — with navigation and shell
 * still visible. Also probe an unknown route.
 *
 * usage: node tests/e2e/lead/verify-placeholder.mjs [--base http://127.0.0.1:17512] [--out <dir>]
 */

import { launch } from '../lib/cdp.mjs';
import { Checker, parseArgs, viewUrl, writeEvidence } from './common.mjs';

const PROBE = `(() => {
  const root = document.querySelector('#view-root');
  const placeholder = document.querySelector('[data-view="placeholder"]');
  const nav = document.querySelector('nav');
  const text = (root?.innerText ?? '').replace(/\\s+/g, ' ').trim();
  const bodyText = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim();
  return {
    rootChildren: root?.childElementCount ?? -1,
    textLength: text.length,
    text: text.slice(0, 300),
    bodyTextLength: bodyText.length,
    placeholder: placeholder !== null,
    placeholderText: (placeholder?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    navVisible: nav !== null && nav.getBoundingClientRect().height > 0,
    // A white screen is "no visible text anywhere in main".
    mainVisibleText: (document.querySelector('main')?.innerText ?? '').trim().length,
    viewUnavailableAttr: document.querySelector('[data-view-unavailable="true"]') !== null,
    route: location.hash,
  };
})()`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checker = new Checker('unimplemented or failed view shows an explicit placeholder, never a white screen');
  const runs = {};
  const browser = await launch({ width: 1440, height: 900 });
  try {
    // ---- 1) block a real view module and require the placeholder -----------------
    const page = await browser.newPage();
    await page.goto(`${args.base}/?theme=dark&lang=zh-CN#/overview`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await page.connection.send('Network.setBlockedURLs', { urls: ['*/js/views/agent.js*'] }, page.sessionId);
    await page.goto(viewUrl(args.base, 'agent', { theme: 'dark', lang: 'zh-CN' }));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const blocked = await page.evaluate(PROBE);
    runs.blockedView = { probe: blocked, devtools: page.report().consoleErrors.map((entry) => entry.text) };
    checker.ok(blocked.placeholder === true, 'blocked view module renders the placeholder element', blocked);
    checker.ok(blocked.viewUnavailableAttr === true, 'placeholder carries data-view-unavailable="true"', blocked);
    checker.ok(blocked.rootChildren > 0, 'view root is not empty (no white screen)', blocked);
    checker.ok(blocked.textLength > 10, 'placeholder has readable text', blocked.text);
    checker.ok(blocked.navVisible === true, 'navigation survives a failed view', blocked);
    // The wording must be a usable sentence, not a raw key or an i18n miss.
    const text = blocked.placeholderText;
    const readable = /未实现|不可用|not implemented|not available|unavailable/iu.test(text);
    checker.ok(readable, 'placeholder text says the page is unavailable/unimplemented', text);
    checker.ok(!/^\[missing:/u.test(text), 'placeholder text is not a raw i18n miss', text);

    // ---- 2) an unknown route must not white-screen either ------------------------
    await page.connection.send('Network.setBlockedURLs', { urls: [] }, page.sessionId);
    await page.goto(`${args.base}/?theme=dark&lang=zh-CN#/does-not-exist`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const unknown = await page.evaluate(PROBE);
    runs.unknownRoute = { probe: unknown };
    checker.ok(unknown.mainVisibleText > 0, 'unknown route still shows shell text (no white screen)', unknown.mainVisibleText);
    checker.ok(unknown.navVisible === true, 'unknown route keeps the navigation', unknown);

    // ---- 3) control: the same view loads fine when the module is reachable -------
    await page.goto(viewUrl(args.base, 'agent', { theme: 'dark', lang: 'zh-CN' }));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const control = await page.evaluate(PROBE);
    runs.control = { probe: control };
    checker.ok(control.placeholder === false, 'unblocked view does not show the placeholder', control);
    checker.ok(control.rootChildren > 0 && control.textLength > 40, 'unblocked view renders content', control.textLength);
  } finally {
    await browser.close();
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'placeholder.json', { at: new Date().toISOString(), base: args.base, runs, summary });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-placeholder: ${error?.stack ?? error}\n`);
  process.exit(1);
});
