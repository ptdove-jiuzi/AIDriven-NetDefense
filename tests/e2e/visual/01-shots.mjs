/**
 * 01-shots.mjs — the screenshot archive: 6 views × {dark, light} × {data, no-data} ×
 * {1440x900, 390x844} = 48 real renders, each with byte count and rendered text length.
 *
 * Why text length per shot: a 1-pixel-tall PNG and a real page can both be "not blank"
 * to a thumbnail check. Text length is what catches "looks fine but is empty".
 *
 * Usage:
 *   node tests/e2e/visual/01-shots.mjs [--base-data http://127.0.0.1:17512]
 *        [--base-nodata http://127.0.0.1:17522] [--settle 1600]
 *
 * Author PT-dove.
 */

import { join } from 'node:path';

import {
  RESULTS,
  STACKS,
  VIEWS,
  VIEWPORTS,
  buildFingerprint,
  closePage,
  createChecker,
  devtoolsSummary,
  ensureDir,
  fingerprintDelta,
  isUp,
  openBrowser,
  parseArgs,
  recordBuild,
  sleep,
  writeJson,
  writeShot,
} from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { settle: '1600' });
const settleMs = Number(args.settle) || 1600;
const stacks = [
  { ...STACKS.data, base: typeof args['base-data'] === 'string' ? args['base-data'] : STACKS.data.base },
  { ...STACKS.nodata, base: typeof args['base-nodata'] === 'string' ? args['base-nodata'] : STACKS.nodata.base },
];
const themes = ['dark', 'light'];

const PROBE = `(() => {
  const text = (node) => (node ? (node.innerText ?? node.textContent ?? '') : '').replace(/\\s+/gu, ' ').trim();
  const root = document.querySelector('#view-root');
  return {
    hash: location.hash,
    themeResolved: document.body.getAttribute('data-theme'),
    themeSource: document.body.getAttribute('data-theme-source'),
    htmlLang: document.documentElement.getAttribute('lang'),
    viewTextLength: text(root).length,
    bodyTextLength: text(document.body).length,
    viewElements: root ? root.querySelectorAll('*').length : -1,
    viewChildren: root ? root.childElementCount : -1,
    missingKeyCount: (text(document.body).match(/\\[missing:/gu) ?? []).length,
    missingKeySamples: [...new Set(text(document.body).match(/\\[missing:[^\\]]+\\]/gu) ?? [])].slice(0, 6),
    errorBanner: text(document.querySelector('[role="alert"], .ui-empty, .settings-banner')).slice(0, 160) || null,
    tables: [...document.querySelectorAll('.ui-table')].map((table) => ({
      virtual: table.getAttribute('data-virtual'),
      rows: Number(table.getAttribute('data-rows')),
      domRows: table.querySelectorAll('tr[data-row="true"]').length,
    })),
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  };
})()`;

const checker = createChecker();
const shots = [];
const startedAt = new Date().toISOString();
const buildAtStart = buildFingerprint();
recordBuild(buildAtStart, '01-shots-start');

const browser = await openBrowser({ width: 1440, height: 900 });
try {
  for (const stack of stacks) {
    if (!(await isUp(stack.port))) {
      checker.add(`stack-${stack.name}-up`, false, `port ${stack.port} is not listening`);
      continue;
    }
    checker.add(`stack-${stack.name}-up`, true, `port ${stack.port} listening`);
    for (const theme of themes) {
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ width: viewport.width, height: viewport.height });
        await page.setColorScheme(theme);
        await page.setViewport(viewport.width, viewport.height);
        try {
          let firstView = true;
          for (const view of VIEWS) {
            page.resetReport();
            if (firstView) {
              await page.goto(`${stack.base}/?theme=${theme}&static=1#/${view}`);
              firstView = false;
              await sleep(400);
            } else {
              await page.evaluate(`(() => { location.hash = '#/${view}'; })()`);
              await page.waitFor(`location.hash.includes(${JSON.stringify(`#/${view}`)})`, { timeoutMs: 8000 });
            }
            try {
              await page.waitFor(`(() => {
                const root = document.querySelector('#view-root');
                return root !== null && root.childElementCount > 0 && (root.innerText ?? '').trim().length > 0;
              })()`, { timeoutMs: 12_000, label: `${stack.name}/${theme}/${viewport.name}/${view}` });
            } catch {
              /* recorded below as viewTextLength = 0 */
            }
            // Data-backed views can still be mid-fetch after first paint. Poll until the
            // rendered text stops looking empty, so a slow API never produces a shot that
            // silently archives an empty shell (a 54-char overview at 390px was observed
            // once under machine load and is exactly what this loop prevents).
            const minChars = stack.name === 'nodata' ? 150 : 200;
            let textLength = 0;
            let readyMs = 0;
            const readyDeadline = Date.now() + 15_000;
            while (Date.now() < readyDeadline) {
              textLength = await page.evaluate(`(() => {
                const root = document.querySelector('#view-root');
                return root === null ? 0 : (root.innerText ?? '').replace(/\\s+/gu, ' ').trim().length;
              })()`);
              if (textLength >= minChars) break;
              await sleep(300);
              readyMs += 300;
            }
            await sleep(settleMs);
            const probe = await page.evaluate(PROBE);
            const png = await page.screenshot();
            const name = `${view}-${theme}-${stack.name}-${viewport.name}.png`;
            const shot = writeShot(name, png);
            const devtools = devtoolsSummary(page);
            const record = {
              view,
              theme,
              requestedTheme: theme,
              stack: stack.name,
              base: stack.base,
              viewport: viewport.name,
              width: viewport.width,
              height: viewport.height,
              file: shot.rel,
              path: shot.path,
              bytes: shot.bytes,
              sha256_16: shot.sha256,
              minCharsExpected: minChars,
              contentReadyMs: readyMs,
              ...probe,
              devtools,
            };
            shots.push(record);
            checker.add(`shot-${view}-${theme}-${stack.name}-${viewport.name}-text`, probe.viewTextLength >= minChars,
              `${probe.viewTextLength} chars (min ${minChars}, waited ${readyMs}ms)`);
            checker.add(`shot-${view}-${theme}-${stack.name}-${viewport.name}-theme`, probe.themeResolved === theme, `resolved ${probe.themeResolved}`);
          }
        } finally {
          await closePage(page);
        }
      }
    }
  }
} finally {
  await browser.close();
}

const buildAtEnd = buildFingerprint();
const buildDelta = fingerprintDelta(buildAtStart, buildAtEnd);

const byKey = (view, theme, stack) => shots.filter((entry) => entry.view === view && entry.theme === theme && entry.stack === stack);
const matrixComplete = VIEWS.length * themes.length * stacks.length * VIEWPORTS.length === shots.length;
checker.add('matrix-48-shots', matrixComplete, `${shots.length} screenshots`);
checker.add('unique-images', new Set(shots.map((entry) => `${entry.sha256_16}:${entry.bytes}`)).size === shots.length,
  `${new Set(shots.map((entry) => entry.sha256_16)).size} unique hashes of ${shots.length}`);
const emptyShots = shots.filter((entry) => entry.viewTextLength < 150);
checker.add('no-looks-empty-view', emptyShots.length === 0, `${emptyShots.length} shots under 150 chars`);

// Light/dark must actually differ in pixels for every view.
const themePairs = [];
for (const view of VIEWS) {
  for (const stack of stacks) {
    for (const viewport of VIEWPORTS) {
      const dark = byKey(view, 'dark', stack.name).find((entry) => entry.viewport === viewport.name);
      const light = byKey(view, 'light', stack.name).find((entry) => entry.viewport === viewport.name);
      if (dark === undefined || light === undefined) continue;
      themePairs.push({ view, stack: stack.name, viewport: viewport.name, differ: dark.sha256_16 !== light.sha256_16 });
    }
  }
}
checker.add('theme-actually-applied', themePairs.every((entry) => entry.differ),
  `${themePairs.filter((entry) => !entry.differ).length} identical dark/light pairs`);

const report = {
  task: 'INT-4 visual screenshot matrix',
  author: 'PT-dove',
  startedAt,
  finishedAt: new Date().toISOString(),
  settleMs,
  build: {
    aggregate16: buildAtStart.aggregate16,
    aggregate: buildAtStart.aggregate,
    fileCount: buildAtStart.fileCount,
    sampledAt: buildAtStart.sampledAt,
    maxMtimeIso: buildAtStart.maxMtimeIso,
    movedDuringRun: !buildDelta.same,
    changedDuringRun: buildDelta.changedFiles,
  },
  stacks: stacks.map((stack) => ({ name: stack.name, base: stack.base })),
  shotCount: shots.length,
  checker: checker.summary(),
  shots,
  themePairs,
};

ensureDir(RESULTS);
writeJson(join(RESULTS, 'shots.json'), report);
process.stdout.write(`${JSON.stringify({
  shots: shots.length,
  build16: report.build.aggregate16,
  buildMovedDuringRun: report.build.movedDuringRun,
  checks: report.checker.total,
  passed: report.checker.passed,
  failed: report.checker.failed,
  failures: report.checker.checks.filter((entry) => !entry.ok),
  emptyShots: emptyShots.map((entry) => ({ file: entry.file, text: entry.viewTextLength })),
  bytes: { min: Math.min(...shots.map((entry) => entry.bytes)), max: Math.max(...shots.map((entry) => entry.bytes)) },
  out: join(RESULTS, 'shots.json'),
}, null, 2)}\n`);
process.exitCode = report.checker.failed === 0 ? 0 : 1;
