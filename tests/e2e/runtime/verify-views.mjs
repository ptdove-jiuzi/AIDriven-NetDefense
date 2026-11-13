#!/usr/bin/env node
/**
 * verify-views.mjs — the two-state acceptance run for the six console v2 views
 * (author PT-dove).
 *
 * Matrix: 6 views × {data, mock} × {dark, light} = 24 combinations. For each one this
 * script drives a real Chromium engine over CDP and records four things:
 *
 *   A. rendering — `#view-root` has children and > 40 characters of text (no white screen);
 *   B. DevTools would be red or not — console errors, uncaught exceptions, failed requests,
 *      and 4xx/5xx responses, each captured with its URL/status and classified;
 *   C. not a fallback — no `[data-view="placeholder"]` and no `[missing:` prefix anywhere
 *      in the view text (the contract's "never silently blank" fallback is still a defect
 *      for a *shipped* view, so it fails here instead of passing quietly);
 *   D. two themes really are two themes — the dark and light screenshots for a view must
 *      differ byte-wise, otherwise the pair proves nothing.
 *
 * Evidence: one PNG per combination plus a JSON run report under
 * `docs/implementation/evidence/ui2/runtime/`. Exit 0 only when every combination passes.
 *
 * Usage:
 *   node tests/e2e/runtime/verify-views.mjs [--data <url>] [--mock <url>]
 *        [--stacks data,mock] [--themes dark,light] [--views overview,alerts,...]
 *        [--out <dir>] [--settle-ms 1200] [--timeout-ms 15000] [--no-shots] [--browser <exe>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from '../lib/cdp.mjs';
import { PROBE, VIEWS } from '../smoke-views.mjs';
import {
  EVIDENCE_ROOT,
  REPO_ROOT,
  computeBuildFingerprint,
  describePort,
  formatTable,
  fromRepo,
  httpGet,
  keysOf,
  nowIso,
  parseArgs,
  sha256,
  sleep,
  splitList,
  writeJsonFile,
} from './lib/runtime.mjs';

/** Data-state bases. The mock one must be an empty store; the data one must not be. */
export const DEFAULT_BASES = Object.freeze({
  data: 'http://127.0.0.1:17512',
  mock: 'http://127.0.0.1:17522',
});

/** The in-page probe: PROBE from smoke-views.mjs plus the fields this acceptance needs. */
export function extendedProbe() {
  return `(() => {
    const base = ${PROBE};
    const root = document.querySelector('#view-root');
    const rootText = root === null ? '' : (root.innerText ?? '');
    const bodyText = document.body === null ? '' : (document.body.innerText ?? '');
    const missing = rootText.match(/\\[missing:[^\\]]*\\]/g) ?? [];
    const notImplemented = rootText.match(/[^\\n]{0,60}(?:未实现|not implemented|NOT_IMPLEMENTED)[^\\n]{0,60}/i);
    base.missingPrefixCount = missing.length;
    base.missingPrefixCountBody = (bodyText.match(/\\[missing:/g) ?? []).length;
    base.missingKeys = Array.from(new Set(missing)).slice(0, 12);
    base.bodyTheme = document.body === null ? null : document.body.getAttribute('data-theme');
    base.themeSource = document.body === null ? null : document.body.getAttribute('data-theme-source');
    base.density = document.body === null ? null : document.body.getAttribute('data-density');
    base.viewUnavailable = document.querySelector('[data-view="placeholder"]') !== null;
    base.skeletonElements = document.querySelectorAll('.ui-skeleton').length;
    base.ariaBusy = root === null ? 0 : root.querySelectorAll('[aria-busy="true"]').length;
    base.notImplementedText = notImplemented === null ? null : notImplemented[0].trim();
    base.rootTextSample = rootText.replace(/\\s+/g, ' ').trim().slice(0, 400);
    base.errorLikeText = rootText.match(/ReferenceError|TypeError|is not defined|failed to render/i) === null
      ? null : rootText.replace(/\\s+/g, ' ').slice(0, 400);
    return base;
  })()`;
}

/** Classify one red DevTools entry so the report says *why* it was red. */
function classify(entry) {
  const url = entry.url ?? '';
  const text = entry.text ?? entry.errorText ?? '';
  if (/\/i18n\/locales\//u.test(url) || /\[missing:/u.test(text)) return 'i18n-locale-missing';
  if (/favicon\.ico/u.test(url)) return 'favicon-404';
  if (/\/api\/v1\//u.test(url)) return 'api-request-failed';
  if (/is not defined|ReferenceError|TypeError|failed to render/u.test(text)) return 'view-render-exception';
  if (typeof entry.status === 'number' && entry.status >= 500) return 'http-5xx';
  if (typeof entry.status === 'number' && entry.status >= 400) return 'http-4xx';
  return 'other';
}

/** Build the devtools summary, capped so a pathological page cannot explode the evidence. */
function summarizeDevtools(report) {
  const badResponses = report.badResponses.map((entry) => ({
    url: String(entry.url ?? '').slice(0, 240),
    status: entry.status ?? null,
    kind: classify(entry),
  }));
  const failedRequests = report.failedRequests.map((entry) => ({
    errorText: String(entry.errorText ?? '').slice(0, 200),
    kind: classify(entry),
  }));
  const consoleErrors = report.consoleErrors.map((entry) => ({
    text: String(entry.text ?? '').slice(0, 400),
    kind: classify(entry),
  }));
  const exceptions = report.exceptions.map((entry) => ({
    text: String(entry.text ?? '').slice(0, 400),
    url: entry.url === null ? null : String(entry.url).slice(0, 240),
    line: entry.line ?? null,
    kind: classify(entry),
  }));
  const logErrors = report.logErrors.map((entry) => ({
    text: String(entry.text ?? '').slice(0, 400),
    url: entry.url === null ? null : String(entry.url).slice(0, 240),
    kind: classify(entry),
  }));
  const total = consoleErrors.length + exceptions.length + logErrors.length
    + failedRequests.length + badResponses.length;
  return {
    consoleErrors,
    exceptions,
    logErrors,
    failedRequests,
    badResponses,
    total,
    kinds: [...new Set([...consoleErrors, ...exceptions, ...logErrors, ...failedRequests, ...badResponses]
      .map((entry) => entry.kind))].sort(),
  };
}

/** Preflight one base: prove *which* data state it is serving before we judge pixels. */
async function preflightBase(stackId, base) {
  const healthz = await httpGet(`${base}/healthz`, { timeoutMs: 6000 });
  const status = await httpGet(`${base}/api/v1/status`, { timeoutMs: 8000 });
  const alerts = await httpGet(`${base}/api/v1/alerts?limit=5`, { timeoutMs: 8000 });
  const alertItems = Array.isArray(alerts.json?.alerts) ? alerts.json.alerts
    : Array.isArray(alerts.json?.items) ? alerts.json.items : null;
  const problems = [];
  if (!healthz.ok) problems.push(`/healthz ${healthz.status ?? healthz.error}`);
  if (!status.ok) problems.push(`/api/v1/status ${status.status ?? status.error}`);
  if (!alerts.ok) problems.push(`/api/v1/alerts ${alerts.status ?? alerts.error}`);
  if (status.ok && status.json !== null) {
    if (stackId === 'mock' && Number(status.json.counters?.events_accepted) !== 0) {
      problems.push(`expected an empty store, got events_accepted=${status.json.counters?.events_accepted}`);
    }
    if (stackId === 'data' && Number(status.json.counters?.events_accepted) <= 0) {
      problems.push('expected real telemetry, got events_accepted=0');
    }
  }
  // Who is actually answering on this port? Evidence must name the process, not just the URL.
  let listener = null;
  try {
    const port = Number(new URL(base).port);
    const found = describePort(port);
    listener = found.pid === null ? null : { pid: found.pid, commandLine: found.commandLine };
  } catch {
    listener = null;
  }
  return {
    stack: stackId,
    base,
    ok: problems.length === 0,
    problems,
    listener,
    healthz: { status: healthz.status, body: healthz.json ?? null },
    mode: status.json?.mode ?? null,
    version: status.json?.version ?? null,
    counters: status.json === null ? null : {
      events_received: status.json.counters?.events_received ?? null,
      events_accepted: status.json.counters?.events_accepted ?? null,
      alerts_written: status.json.counters?.alerts_written ?? null,
      polls: status.json.counters?.polls ?? null,
    },
    alerts: { status: alerts.status, count: alertItems === null ? null : alertItems.length },
  };
}

/** Is the view still showing a loading placeholder rather than its content? */
function isLoading(probe) {
  if (probe === null) return false;
  if ((probe.skeletonElements ?? 0) > 0) return true;
  if ((probe.ariaBusy ?? 0) > 0) return true;
  // A loading-only page is short and says so; real content that merely mentions
  // "loading model…" in passing must not be mistaken for a placeholder.
  return (probe.textLength ?? 0) < 120 && /加载中|loading/iu.test(probe.rootTextSample ?? '');
}

/** Run one combination. Never throws: a broken page is a finding, not a crash. */
async function runCombo(browser, base, view, theme, options) {
  const url = `${base}/?theme=${theme}&static=1${view.hash}`;
  const combo = {
    stack: options.stackId,
    view: view.id,
    theme,
    url,
    settled: false,
    probe: null,
    probeError: null,
    screenshot: null,
    screenshotSha256: null,
    screenshotBytes: null,
    devtools: null,
    pass: false,
    reasons: [],
  };
  let page = null;
  try {
    page = await browser.newPage({ width: options.width, height: options.height });
    await page.setColorScheme(theme);
    await page.goto(url);
    try {
      await page.waitFor(`(() => {
        const root = document.querySelector('#view-root');
        if (root === null) return false;
        if (root.childElementCount === 0) return false;
        return (root.innerText ?? '').trim().length > 0;
      })()`, { timeoutMs: options.timeoutMs, label: `${view.id} content` });
      combo.settled = true;
    } catch {
      combo.settled = false;
    }
    await sleep(options.settleMs);
    try {
      combo.probe = await page.evaluate(extendedProbe());
    } catch (error) {
      combo.probeError = String(error?.message ?? error);
    }
    // A skeleton or "loading…" page is not a rendered view. Wait for the real content
    // (bounded), then judge what is on screen — otherwise a hang would be scored as a pass.
    if (isLoading(combo.probe)) {
      combo.loadingAtFirstProbe = true;
      const started = Date.now();
      while (Date.now() - started < options.loadWaitMs) {
        await sleep(400);
        try {
          combo.probe = await page.evaluate(extendedProbe());
        } catch {
          break;
        }
        if (!isLoading(combo.probe)) break;
      }
      combo.loadWaitMs = Date.now() - started;
      combo.stillLoading = isLoading(combo.probe);
    }
    if (options.shots) {
      const png = await page.screenshot();
      const dir = join(options.outDir, 'shots');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${options.stackId}-${view.id}-${theme}.png`);
      writeFileSync(path, png);
      combo.screenshot = fromRepo(path);
      combo.screenshotSha256 = sha256(png);
      combo.screenshotBytes = png.length;
    }
    combo.devtools = summarizeDevtools(page.report());
  } catch (error) {
    combo.fatal = String(error?.message ?? error);
  } finally {
    if (page !== null) {
      try {
        await page.connection.send('Target.closeTarget', { targetId: page.targetId });
      } catch {
        /* page already gone */
      }
    }
  }

  const probe = combo.probe;
  if (combo.fatal !== undefined) combo.reasons.push(`BROWSER_ERROR: ${combo.fatal}`);
  if (combo.stillLoading === true) {
    combo.reasons.push(`STILL_LOADING: view was still a loading placeholder after ${combo.loadWaitMs}ms`);
  }
  if (combo.settled !== true) combo.reasons.push(`WHITE_SCREEN: #view-root produced no text within ${options.timeoutMs}ms`);
  if (probe !== null) {
    if ((probe.rootChildren ?? 0) <= 0) combo.reasons.push('EMPTY_ROOT: #view-root has no element children');
    if ((probe.textLength ?? 0) <= 40) combo.reasons.push(`THIN_TEXT: only ${probe.textLength ?? 0} chars`);
    if (probe.viewUnavailable === true || probe.placeholder === true) {
      combo.reasons.push('PLACEHOLDER: view fell back to the unavailable placeholder');
    }
    if ((probe.missingPrefixCount ?? 0) > 0) {
      combo.reasons.push(`MISSING_KEYS: ${probe.missingPrefixCount} [missing:...] tokens (e.g. ${(probe.missingKeys ?? []).slice(0, 3).join(', ')})`);
    }
    if (probe.secretLike === true) combo.reasons.push('SECRET_LIKE_TEXT: page text looks like a credential');
    if (probe.errorLikeText !== null) combo.reasons.push(`ERROR_TEXT: ${probe.errorLikeText.slice(0, 200)}`);
  } else if (combo.probeError !== null) {
    combo.reasons.push(`PROBE_FAILED: ${combo.probeError}`);
  }
  const devtools = combo.devtools ?? { total: 1 };
  if (devtools.total > 0) {
    combo.reasons.push(`DEVTOOLS_RED: ${devtools.total} entries [${(devtools.kinds ?? []).join(', ')}]`);
  }
  combo.pass = combo.reasons.length === 0;
  return combo;
}

/** Dark and light screenshots for the same view must not be byte-identical. */
function flagIndistinctThemes(combos) {
  const byKey = new Map();
  for (const combo of combos) {
    if (combo.screenshotSha256 === null) continue;
    const key = `${combo.stack}:${combo.view}`;
    const entry = byKey.get(key) ?? {};
    entry[combo.theme] = combo;
    byKey.set(key, entry);
  }
  const findings = [];
  for (const [key, entry] of byKey) {
    if (entry.dark === undefined || entry.light === undefined) continue;
    if (entry.dark.screenshotSha256 === entry.light.screenshotSha256) {
      for (const combo of [entry.dark, entry.light]) {
        combo.reasons.push('THEME_INDISTINCT: dark and light screenshots are byte-identical');
        combo.pass = false;
      }
      findings.push(`${key}: dark/light screenshots identical (${entry.dark.screenshotSha256.slice(0, 12)})`);
    }
  }
  return findings;
}

function summarize(combos) {
  const failuresByView = {};
  const failuresByKind = {};
  for (const combo of combos) {
    if (combo.pass) continue;
    failuresByView[combo.view] = (failuresByView[combo.view] ?? 0) + 1;
    for (const reason of combo.reasons) {
      const kind = reason.split(':')[0];
      failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1;
    }
  }
  const by = (field) => {
    const out = {};
    for (const combo of combos) {
      const value = combo[field];
      const bucket = out[value] ?? { pass: 0, fail: 0 };
      bucket[combo.pass ? 'pass' : 'fail'] += 1;
      out[value] = bucket;
    }
    return out;
  };
  return {
    total: combos.length,
    pass: combos.filter((combo) => combo.pass).length,
    fail: combos.filter((combo) => !combo.pass).length,
    byStack: by('stack'),
    byView: by('view'),
    byTheme: by('theme'),
    failuresByView,
    failuresByKind,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    data: DEFAULT_BASES.data,
    mock: DEFAULT_BASES.mock,
    stacks: 'data,mock',
    themes: 'dark,light',
    views: null,
    out: EVIDENCE_ROOT,
    'settle-ms': 1200,
    'load-wait-ms': 8000,
    'timeout-ms': 15000,
    width: 1440,
    height: 900,
    browser: null,
    lang: null,
  }, new Set(['no-shots', 'help']));
  if (args.help === true) {
    process.stdout.write('usage: node tests/e2e/runtime/verify-views.mjs [--data <url>] [--mock <url>]'
      + ' [--stacks data,mock] [--themes dark,light] [--views a,b] [--out <dir>] [--settle-ms 1200]'
      + ' [--timeout-ms 15000] [--no-shots] [--browser <exe>]\n');
    return 0;
  }
  const stackIds = splitList(String(args.stacks));
  const themes = splitList(String(args.themes));
  const wantedViews = args.views === null || args.views === true ? null : splitList(String(args.views));
  const views = wantedViews === null ? VIEWS : VIEWS.filter((view) => wantedViews.includes(view.id));
  const outDir = fromRepo(String(args.out));
  mkdirSync(outDir, { recursive: true });
  const options = {
    width: Number(args.width),
    height: Number(args.height),
    settleMs: Number(args['settle-ms']),
    loadWaitMs: Number(args['load-wait-ms']),
    timeoutMs: Number(args['timeout-ms']),
    shots: args['no-shots'] !== true,
    outDir,
    lang: args.lang === true ? null : args.lang,
  };

  const receipt = {
    schemaVersion: '1.0',
    generatedAt: nowIso(),
    tool: 'tests/e2e/runtime/verify-views.mjs',
    node: process.version,
    build: computeBuildFingerprint(join(REPO_ROOT, 'apps', 'console-next')),
    bases: {},
    themes,
    views: views.map((view) => view.id),
    preflight: {},
    combos: [],
    summary: null,
    pass: false,
  };
  process.stdout.write(`build: ${receipt.build.fileCount} files, sha256=${receipt.build.sha256.slice(0, 16)}…\n`);
  for (const stackId of stackIds) {
    receipt.bases[stackId] = String(args[stackId]);
  }

  // Preflight: fail loudly and early when a stack is down or serving the wrong data state.
  const preflightFailures = [];
  for (const stackId of stackIds) {
    // eslint-disable-next-line no-await-in-loop
    const result = await preflightBase(stackId, receipt.bases[stackId]);
    receipt.preflight[stackId] = result;
    process.stdout.write(`preflight ${stackId} ${result.base}: ${result.ok ? 'ok' : 'FAIL'}`
      + ` mode=${result.mode} events=${result.counters?.events_accepted ?? '?'} alerts=${result.alerts.count ?? '?'}`
      + `${result.ok ? '' : ` problems=${result.problems.join('; ')}`}\n`);
    if (!result.ok) preflightFailures.push(`${stackId}: ${result.problems.join('; ')}`);
  }
  if (preflightFailures.length > 0) {
    receipt.preflightFailures = preflightFailures;
    receipt.summary = { total: 0, pass: 0, fail: 0, failuresByView: {}, failuresByKind: {} };
    writeJsonFile(join(outDir, 'verify-views.json'), receipt);
    process.stderr.write(`verify-views: refusing to judge pixels — ${preflightFailures.join(' | ')}\n`
      + 'hint: start the stacks first with tests/e2e/runtime/run-stack.mjs\n');
    return 2;
  }

  let browser;
  try {
    browser = await launch({
      executable: args.browser === true ? undefined : args.browser ?? undefined,
      width: options.width,
      height: options.height,
    });
  } catch (error) {
    receipt.fatal = String(error?.message ?? error);
    writeJsonFile(join(outDir, 'verify-views.json'), receipt);
    process.stderr.write(`verify-views: cannot launch a browser: ${receipt.fatal}\n`);
    return 2;
  }

  try {
    for (const stackId of stackIds) {
      for (const theme of themes) {
        for (const view of views) {
          // eslint-disable-next-line no-await-in-loop
          const combo = await runCombo(browser, receipt.bases[stackId], view, theme, { ...options, stackId });
          receipt.combos.push(combo);
          const status = combo.pass ? 'PASS' : 'FAIL';
          process.stdout.write(`${status} ${stackId}/${view.id}/${theme}`
            + ` text=${combo.probe?.textLength ?? '?'} root=${combo.probe?.rootChildren ?? '?'}`
            + ` devtools=${combo.devtools?.total ?? '?'}`
            + `${combo.pass ? '' : ` :: ${combo.reasons.join(' | ')}`}\n`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  receipt.themeFindings = flagIndistinctThemes(receipt.combos);
  receipt.summary = summarize(receipt.combos);
  receipt.pass = receipt.summary.fail === 0 && receipt.summary.total > 0;
  const jsonPath = join(outDir, 'verify-views.json');
  writeJsonFile(jsonPath, receipt);
  const stamp = receipt.generatedAt.replace(/[:.]/gu, '-');
  writeJsonFile(join(outDir, `verify-views-${stamp}.json`), receipt);

  process.stdout.write(`\n${formatTable(receipt.combos.map((combo) => ({
    stack: combo.stack,
    view: combo.view,
    theme: combo.theme,
    text: combo.probe?.textLength ?? '-',
    devtools: combo.devtools?.total ?? '-',
    result: combo.pass ? 'PASS' : 'FAIL',
  })), [
    { key: 'stack', header: 'stack' },
    { key: 'view', header: 'view' },
    { key: 'theme', header: 'theme' },
    { key: 'text', header: 'text' },
    { key: 'devtools', header: 'red' },
    { key: 'result', header: 'result' },
  ])}\n`);
  for (const finding of receipt.themeFindings) process.stdout.write(`theme: ${finding}\n`);
  process.stdout.write(`\nsummary: ${receipt.summary.pass}/${receipt.summary.total} pass, ${receipt.summary.fail} fail\n`);
  process.stdout.write(`failures by view: ${JSON.stringify(receipt.summary.failuresByView)}\n`);
  process.stdout.write(`failures by kind: ${JSON.stringify(receipt.summary.failuresByKind)}\n`);
  process.stdout.write(`evidence: ${jsonPath}\n`);
  if (options.shots) process.stdout.write(`shots:    ${join(outDir, 'shots')}\n`);
  return receipt.pass ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`verify-views: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
