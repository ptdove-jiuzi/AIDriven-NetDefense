/**
 * smoke-views.mjs — open every console v2 view in a real browser engine and report
 * whether it renders, and whether DevTools would be red (author PT-dove).
 *
 * Usage:
 *   node tests/e2e/smoke-views.mjs --base http://127.0.0.1:17512 [--out <dir>]
 *
 * Exit code 0 only when every view rendered with zero console errors, zero uncaught
 * exceptions, zero failed requests and zero 4xx/5xx responses.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from './lib/cdp.mjs';

/** The six contract views (§7.2). */
export const VIEWS = Object.freeze([
  { id: 'overview', hash: '#/overview' },
  { id: 'alerts', hash: '#/alerts' },
  { id: 'analysis', hash: '#/analysis' },
  { id: 'agent', hash: '#/agent' },
  { id: 'models', hash: '#/models' },
  { id: 'settings', hash: '#/settings' },
]);

/** Parse `--key value` arguments. */
export function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:17512', out: null, theme: 'dark', lang: null, width: 1440, height: 900 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--base') { args.base = next; index += 1; }
    else if (flag === '--out') { args.out = next; index += 1; }
    else if (flag === '--theme') { args.theme = next; index += 1; }
    else if (flag === '--lang') { args.lang = next; index += 1; }
    else if (flag === '--width') { args.width = Number(next); index += 1; }
    else if (flag === '--height') { args.height = Number(next); index += 1; }
  }
  return args;
}

/** Read what the app put on screen, without trusting it. */
export const PROBE = `(() => {
  const root = document.querySelector('#view-root');
  const main = document.querySelector('main');
  const nav = document.querySelector('nav');
  const html = document.documentElement;
  const text = (root?.innerText ?? '').replace(/\\s+/g, ' ').trim();
  const placeholder = document.querySelector('[data-placeholder], .placeholder, [data-view="placeholder"]');
  return {
    route: location.hash,
    rootChildren: root?.childElementCount ?? -1,
    rootElements: root?.querySelectorAll('*').length ?? -1,
    textLength: text.length,
    textHead: text.slice(0, 400),
    placeholder: placeholder !== null,
    placeholderText: placeholder?.innerText?.slice(0, 200) ?? null,
    bodyTextLength: (document.body?.innerText ?? '').trim().length,
    navVisible: nav !== null && nav.getBoundingClientRect().height > 0,
    mainVisible: main !== null && main.getBoundingClientRect().height > 0,
    theme: html.getAttribute('data-theme'),
    lang: html.getAttribute('lang'),
    title: document.title,
    htmlLang: html.getAttribute('lang'),
    // Anything that would look like a raw credential on screen.
    secretLike: /(?:sk-[A-Za-z0-9]{8,}|Bearer\\s+[A-Za-z0-9._-]{16,})/u.test(document.body?.innerText ?? ''),
  };
})()`;

/** Open one view and return its evidence. */
export async function checkView(browser, base, view, args) {
  const page = await browser.newPage({ width: args.width, height: args.height });
  await page.setColorScheme(args.theme);
  const url = `${base}/${view.hash}`;
  await page.goto(url);
  // The app is a hash router with async view modules: wait for either content or the
  // explicit placeholder. A timeout here is itself the finding (white screen).
  let settled = true;
  try {
    await page.waitFor(`(() => {
      const root = document.querySelector('#view-root');
      if (root === null) return false;
      if (root.childElementCount === 0) return false;
      return (root.innerText ?? '').trim().length > 0;
    })()`, { timeoutMs: 15_000, label: `${view.id} content` });
  } catch {
    settled = false;
  }
  // Give async data fetches a beat to land and any late error to be reported.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  let probe = null;
  let probeError = null;
  try {
    probe = await page.evaluate(PROBE);
  } catch (error) {
    probeError = error.message;
  }
  const shotName = `${view.id}-${args.theme}${args.lang === null ? '' : `-${args.lang}`}.png`;
  const screenshot = await page.screenshot();
  let shotPath = null;
  if (args.out !== null) {
    mkdirSync(args.out, { recursive: true });
    shotPath = join(args.out, shotName);
    writeFileSync(shotPath, screenshot);
  }
  const report = page.report();
  await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  return {
    view: view.id,
    url,
    settled,
    probe,
    probeError,
    screenshot: shotPath,
    screenshotBytes: screenshot.length,
    devtools: {
      consoleErrors: report.consoleErrors,
      exceptions: report.exceptions,
      logErrors: report.logErrors,
      failedRequests: report.failedRequests,
      badResponses: report.badResponses,
      total: report.total,
    },
    pass: settled && probe !== null && report.total === 0
      && probe.placeholder !== true && probe.secretLike !== true
      && probe.textLength > 40 && probe.rootChildren > 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = await launch({ width: args.width, height: args.height });
  const results = [];
  try {
    if (args.lang !== null) {
      const page = await browser.newPage();
      await page.goto(`${args.base}/`);
      await page.evaluate(`(() => { try { localStorage.setItem('aegis.lang', ${JSON.stringify(args.lang)}); } catch {} })()`);
      await page.connection.send('Target.closeTarget', { targetId: page.targetId });
    }
    for (const view of VIEWS) {
      results.push(await checkView(browser, args.base, view, args));
    }
  } finally {
    await browser.close();
  }
  const summary = {
    base: args.base,
    theme: args.theme,
    lang: args.lang,
    pass: results.filter((entry) => entry.pass).length,
    fail: results.filter((entry) => !entry.pass).length,
    views: results.map((entry) => ({
      view: entry.view,
      pass: entry.pass,
      settled: entry.settled,
      textLength: entry.probe?.textLength ?? null,
      rootChildren: entry.probe?.rootChildren ?? null,
      placeholder: entry.probe?.placeholder ?? null,
      devtoolsTotal: entry.devtools.total,
      screenshot: entry.screenshot,
    })),
  };
  process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  process.exitCode = summary.fail === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined
  && (process.argv[1].endsWith('smoke-views.mjs') || process.argv[1].endsWith('smoke-views.mjs'.replaceAll('/', '\\')));
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`smoke-views: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
