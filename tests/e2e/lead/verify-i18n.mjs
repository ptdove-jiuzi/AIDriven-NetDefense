/**
 * verify-i18n.mjs — hard criterion: switching to English must leave zero Chinese in the
 * interface (user data excepted), and neither language may leave raw `[missing:key]` text.
 *
 * The check is deliberately mechanical: it walks the rendered DOM, counts CJK code points
 * in visible text, and reports each place they occur with a selector path so an exemption
 * has to be argued against a concrete node rather than hand-waved.
 *
 * usage: node tests/e2e/lead/verify-i18n.mjs [--base http://127.0.0.1:17512] [--out <dir>]
 */

import { launch } from '../lib/cdp.mjs';
import { Checker, parseArgs, viewUrl, writeEvidence, VIEWS } from './common.mjs';

/** CJK code points (Han + kana + hangul), the languages we claim to have translated. */
const CJK_PATTERN = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af';

/** In-page probe: visible text with CJK locations and i18n misses. */
const PROBE = (cjkClass) => `(() => {
  const root = document.querySelector('#view-root') ?? document.body;
  const text = (root.innerText ?? '');
  const cjk = new RegExp('[${cjkClass}]', 'u');
  const hits = [];
  if (cjk.test(text)) {
    for (const node of root.querySelectorAll('*')) {
      if (node.children.length !== 0) continue;      // leaf nodes only: no double counting
      const own = (node.textContent ?? '').trim();
      if (own.length === 0 || !cjk.test(own)) continue;
      const attrs = ['aria-label', 'title', 'placeholder'].map((name) => node.getAttribute(name) ?? '')
        .filter((value) => cjk.test(value));
      hits.push({
        tag: node.tagName,
        class: String(node.className).slice(0, 80),
        text: own.slice(0, 120),
        attrs,
      });
      if (hits.length >= 40) break;
    }
  }
  const missing = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    const match = /\\[missing:([^\\]]+)\\]/u.exec(value);
    if (match !== null) missing.push(match[1]);
  }
  const html = document.documentElement;
  return {
    lang: html.getAttribute('lang'),
    theme: html.getAttribute('data-theme'),
    textLength: text.trim().length,
    cjkCount: (text.match(new RegExp('[${cjkClass}]', 'gu')) ?? []).length,
    cjkHits: hits,
    missingKeys: [...new Set(missing)],
    missingCount: missing.length,
    title: document.title,
  };
})()`;

async function openView(browser, base, view, lang) {
  const page = await browser.newPage({ width: 1440, height: 900 });
  const url = viewUrl(base, view, { theme: 'dark', lang });
  await page.goto(url);
  // Wait for the view to settle instead of sleeping a fixed amount: settings/models fetch
  // two endpoints and render eight groups, and a snapshot taken mid-load would report a
  // short page as if it were the final one. A view is "settled" when its text has stopped
  // changing *and* it is longer than a loading skeleton.
  let previous = -1;
  let stable = 0;
  for (let tick = 0; tick < 60; tick += 1) {
    const length = await page.evaluate(`(document.querySelector('#view-root')?.innerText ?? '').trim().length`);
    const loaded = length === previous && length > 250;
    stable = loaded ? stable + 1 : 0;
    if (stable >= 3) break;
    previous = length;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const probe = await page.evaluate(PROBE(CJK_PATTERN));
  const shot = await page.screenshot();
  await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  return { view, lang, url, probe, screenshotBytes: shot.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checker = new Checker('i18n: no raw [missing:] keys, and English mode has no Chinese');
  const runs = { en: [], zh: [] };
  const browser = await launch({ width: 1440, height: 900 });
  try {
    for (const view of VIEWS) {
      runs.en.push(await openView(browser, args.base, view, 'en'));
      runs.zh.push(await openView(browser, args.base, view, 'zh-CN'));
    }
  } finally {
    await browser.close();
  }

  for (const entry of runs.en) {
    checker.equal(entry.probe.lang, 'en', `${entry.view}: <html lang> is en`);
    checker.equal(entry.probe.missingCount, 0, `${entry.view} (en): zero [missing:] keys`,
      entry.probe.missingKeys);
    checker.equal(entry.probe.cjkCount, 0, `${entry.view} (en): zero CJK characters`,
      entry.probe.cjkHits);
    checker.ok(entry.probe.textLength > 40, `${entry.view} (en): renders actual text`, entry.probe.textLength);
  }
  for (const entry of runs.zh) {
    checker.equal(entry.probe.lang, 'zh-CN', `${entry.view}: <html lang> is zh-CN`);
    checker.equal(entry.probe.missingCount, 0, `${entry.view} (zh-CN): zero [missing:] keys`,
      entry.probe.missingKeys);
    checker.ok(entry.probe.cjkCount > 0, `${entry.view} (zh-CN): UI text is actually Chinese`, entry.probe.cjkCount);
  }

  const summary = checker.summary();
  const evidence = writeEvidence(args.out, 'i18n.json', {
    at: new Date().toISOString(),
    base: args.base,
    perView: {
      en: runs.en.map((entry) => ({
        view: entry.view,
        lang: entry.probe.lang,
        cjkCount: entry.probe.cjkCount,
        cjkHits: entry.probe.cjkHits.slice(0, 10),
        missingKeys: entry.probe.missingKeys.slice(0, 30),
        missingCount: entry.probe.missingCount,
        textLength: entry.probe.textLength,
      })),
      zh: runs.zh.map((entry) => ({
        view: entry.view,
        cjkCount: entry.probe.cjkCount,
        missingKeys: entry.probe.missingKeys.slice(0, 30),
        missingCount: entry.probe.missingCount,
        textLength: entry.probe.textLength,
      })),
    },
    summary,
  });
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`verify-i18n: ${error?.stack ?? error}\n`);
  process.exit(1);
});
