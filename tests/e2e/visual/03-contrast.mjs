/**
 * 03-contrast.mjs — WCAG contrast measured from *live computed styles* (author PT-dove).
 *
 * Two independent sources per theme:
 *   1. Live element samples: read `getComputedStyle` on real DOM nodes in the running app
 *      (alerts + settings views), including the actual background layers under the text
 *      and the product of ancestor `opacity` values — so a badge on a 12%-alpha tint or a
 *      0.5-opacity disabled button is measured as it really renders.
 *   2. Token pairs: read the CSS custom properties the stylesheet computed
 *      (`getComputedStyle(document.documentElement).getPropertyValue('--c-…')`) and compute
 *      the contract §9 pairs. This is the token table, not the comments in tokens.css.
 *
 * Thresholds (contract §7.8): text ≥ 4.5:1; large text / non-text (borders, focus ring) ≥ 3:1.
 * Disabled controls are reported but marked WCAG-1.4.3-exempt (inactive components).
 *
 * Usage: node tests/e2e/visual/03-contrast.mjs [--base http://127.0.0.1:17512]
 */

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import {
  EVIDENCE,
  FOCUS_SOURCE,
  RESULTS,
  SAMPLE_SOURCE,
  STACKS,
  buildFingerprint,
  closePage,
  createChecker,
  fingerprintDelta,
  isUp,
  openBrowser,
  over,
  parseArgs,
  parseColor,
  recordBuild,
  requiredRatio,
  resolveSample,
  rgbText,
  contrastRatio,
  ensureDir,
  sleep,
  writeJson,
} from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2), { base: STACKS.data.base, settle: '1200' });
const BASE = String(args.base);
const settleMs = Number(args.settle) || 1200;
const THEMES = ['dark', 'light'];

const ALERTS_SPECS = [
  { kind: 'body-text', selector: '#view-root p:not(.muted):not(.faint), #view-root .ui-card__body p', note: 'primary body copy' },
  { kind: 'text-muted', selector: '.muted', note: 'secondary text (--c-text-muted)' },
  { kind: 'text-faint', selector: '.faint', note: 'weak text (--c-text-faint)' },
  { kind: 'table-header', selector: '.ui-table thead th', note: 'table header cell' },
  { kind: 'table-cell', selector: '.ui-table tbody td', note: 'table body cell' },
  { kind: 'nav-link', selector: '#nav a', index: 1, note: 'top navigation link' },
  { kind: 'nav-link-active', selector: '#nav a[aria-current="page"], #nav a[data-active="true"]', note: 'active navigation link' },
  { kind: 'link-inline', selector: '#view-root a[href^="#/"]', note: 'in-view link' },
  { kind: 'table-head-border', selector: '.ui-table thead th', nonText: true, note: 'table header hairline border (non-text 3:1)' },
  { kind: 'badge-medium', selector: '.ui-badge[data-tone="medium"]', note: 'severity badge medium' },
  { kind: 'badge-high', selector: '.ui-badge[data-tone="high"]', note: 'severity badge high' },
  { kind: 'badge-low', selector: '.ui-badge[data-tone="low"]', note: 'severity badge low' },
  { kind: 'badge-critical', selector: '.ui-badge[data-tone="critical"]', note: 'severity badge critical' },
  { kind: 'badge-accent', selector: '.ui-badge[data-tone="accent"]', note: 'status badge accent' },
  { kind: 'badge-neutral', selector: '.ui-badge[data-tone="neutral"]', note: 'neutral badge' },
  { kind: 'button-secondary', selector: 'button[data-variant="secondary"]', note: 'secondary button label' },
  { kind: 'button-ghost', selector: 'button[data-variant="ghost"]', note: 'ghost/icon button' },
  { kind: 'button-primary', selector: 'button[data-variant="primary"]', note: 'primary button label' },
  { kind: 'disabled-button', selector: '.ui-btn[disabled], .ui-btn:disabled', note: 'disabled button (WCAG 1.4.3 exempt)', exempt: true },
  { kind: 'heading', selector: '#view-root h1, #view-root h2', note: 'view heading' },
];

const SETTINGS_SPECS = [
  { kind: 'field-label', selector: '.ui-field__label, .settings-item__label, label', note: 'form label' },
  { kind: 'field-hint', selector: '.ui-field__hint, .settings-item__hint', note: 'field hint' },
  { kind: 'input-text', selector: '.ui-input, input.ui-input', note: 'text input value' },
  { kind: 'input-border', selector: '.ui-input, input.ui-input', nonText: true, note: 'input border (--c-input-border, non-text 3:1)' },
  { kind: 'tab-active', selector: '.ui-tab[aria-selected="true"], [role="tab"][aria-selected="true"]', note: 'active tab label' },
  { kind: 'tab-idle', selector: '.ui-tab[aria-selected="false"], [role="tab"][aria-selected="false"]', note: 'inactive tab label' },
  { kind: 'tab-indicator', selector: '.ui-tab[aria-selected="true"]', nonText: true, note: 'active tab indicator border (non-text 3:1)' },
  { kind: 'select-text', selector: '.ui-select', note: 'select control' },
  { kind: 'danger-button', selector: 'button[data-variant="danger"]', note: 'danger button label' },
  { kind: 'primary-button', selector: 'button[data-variant="primary"]', note: 'primary button label (settings)' },
  { kind: 'badge-danger', selector: '.ui-badge[data-tone="danger"]', note: 'danger badge' },
  { kind: 'badge-warn', selector: '.ui-badge[data-tone="warn"]', note: 'warning badge' },
  { kind: 'switch-label', selector: '.ui-switch__label', note: 'switch label' },
  { kind: 'switch-track', selector: '.ui-switch__track', nonText: true, note: 'switch track boundary (non-text 3:1)' },
  { kind: 'code-mono', selector: 'code.mono, .settings-item__path', note: 'monospace path/rule id' },
];

const TOKEN_PAIRS = [
  { kind: 'token.text-on-bg', fg: '--c-text', layers: ['--c-bg'], note: 'main text on page background', category: 'text' },
  { kind: 'token.text-on-surface', fg: '--c-text', layers: ['--c-surface'], note: 'main text on card surface', category: 'text' },
  { kind: 'token.muted-on-surface', fg: '--c-text-muted', layers: ['--c-surface'], note: 'secondary text on card', category: 'text' },
  { kind: 'token.faint-on-surface', fg: '--c-text-faint', layers: ['--c-surface'], note: 'weak text on card', category: 'text' },
  { kind: 'token.faint-on-bg', fg: '--c-text-faint', layers: ['--c-bg'], note: 'weak text on page background', category: 'text' },
  { kind: 'token.accent-contrast-on-accent', fg: '--c-accent-contrast', layers: ['--c-accent'], note: 'label on primary button', category: 'text' },
  { kind: 'token.danger-on-surface', fg: '--c-danger', layers: ['--c-surface'], note: 'danger text on card', category: 'text' },
  { kind: 'token.warn-on-surface', fg: '--c-warn', layers: ['--c-surface'], note: 'warning text on card', category: 'text' },
  { kind: 'token.ok-on-surface', fg: '--c-ok', layers: ['--c-surface'], note: 'success text on card', category: 'text' },
  { kind: 'token.info-on-surface', fg: '--c-info', layers: ['--c-surface'], note: 'info text on card', category: 'text' },
  { kind: 'token.sev-critical-on-tint', fg: '--c-sev-critical', layers: ['--c-surface', '--c-sev-critical-bg'], note: 'critical badge text on its 12%/10% tint', category: 'text' },
  { kind: 'token.sev-high-on-tint', fg: '--c-sev-high', layers: ['--c-surface', '--c-sev-high-bg'], note: 'high badge text on its tint', category: 'text' },
  { kind: 'token.sev-medium-on-tint', fg: '--c-sev-medium', layers: ['--c-surface', '--c-sev-medium-bg'], note: 'medium badge text on its tint', category: 'text' },
  { kind: 'token.sev-low-on-tint', fg: '--c-sev-low', layers: ['--c-surface', '--c-sev-low-bg'], note: 'low badge text on its tint', category: 'text' },
  { kind: 'token.sev-info-on-tint', fg: '--c-sev-info', layers: ['--c-surface', '--c-sev-info-bg'], note: 'info badge text on its tint', category: 'text' },
  { kind: 'token.focus-on-surface', fg: '--c-focus', layers: ['--c-surface'], note: 'focus ring against card (non-text 3:1)', category: 'nonText' },
  { kind: 'token.focus-on-bg', fg: '--c-focus', layers: ['--c-bg'], note: 'focus ring against page (non-text 3:1)', category: 'nonText' },
  { kind: 'token.border-on-surface', fg: '--c-border', layers: ['--c-surface'], note: 'decorative hairline divider (WCAG 1.4.11 exempt: not a control boundary)', category: 'nonText', exempt: true },
  { kind: 'token.border-strong-on-surface', fg: '--c-border-strong', layers: ['--c-surface'], note: 'decorative strong divider (WCAG 1.4.11 exempt: control boundaries use --c-input-border)', category: 'nonText', exempt: true },
  { kind: 'token.input-border-on-surface', fg: '--c-input-border', layers: ['--c-surface'], note: 'control boundary (non-text 3:1)', category: 'nonText' },
  { kind: 'token.input-border-on-bg', fg: '--c-input-border', layers: ['--c-bg'], note: 'control boundary on page (non-text 3:1)', category: 'nonText' },
];

const THEME_TOKEN_NAMES = [
  '--c-bg', '--c-bg-elev', '--c-surface', '--c-border', '--c-border-strong',
  '--c-text', '--c-text-muted', '--c-text-faint', '--c-accent', '--c-accent-hover',
  '--c-accent-contrast', '--c-danger', '--c-warn', '--c-ok', '--c-info', '--c-focus',
  '--c-input-border',
  '--c-sev-critical', '--c-sev-critical-bg', '--c-sev-high', '--c-sev-high-bg',
  '--c-sev-medium', '--c-sev-medium-bg', '--c-sev-low', '--c-sev-low-bg',
  '--c-sev-info', '--c-sev-info-bg',
];

const checker = createChecker();
const buildAtStart = buildFingerprint();
recordBuild(buildAtStart, '03-contrast-start');
const startedAt = new Date().toISOString();

/** Read this theme's computed token values from the live document.
 *
 * tokens.css defines the dark palette on `:root` and the light palette on
 * `[data-theme="light"]`, and the app puts `data-theme` on `<body>` — so the computed
 * values must be read from `document.body`, not `document.documentElement`.
 */
async function readTokens(page) {
  return page.evaluate(`(() => {
    const names = ${JSON.stringify(THEME_TOKEN_NAMES)};
    const host = document.body;
    const style = getComputedStyle(host);
    const rootStyle = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of names) {
      const fromBody = style.getPropertyValue(name).trim();
      out[name] = fromBody !== '' ? fromBody : rootStyle.getPropertyValue(name).trim();
    }
    return {
      tokens: out,
      resolvedTheme: document.body.getAttribute('data-theme'),
      bodyBackground: getComputedStyle(host).backgroundColor,
    };
  })()`);
}

/** Run one spec list against the live page. */
async function sampleSpecs(page, specs) {
  const source = SAMPLE_SOURCE.replace('__SPECS__', JSON.stringify(specs));
  return page.evaluate(source);
}

/** Evaluate a list of computed samples into report rows. */
function evaluateSamples(samples, route) {
  return samples.map((sample) => {
    if (sample.found !== true) {
      return {
        route,
        kind: sample.kind,
        selector: sample.selector,
        found: false,
        note: sample.note ?? null,
        status: 'not-present',
      };
    }
    const nonText = sample.borderWidth !== undefined;
    const target = nonText
      ? { color: sample.color, bgLayers: sample.bgLayers, opacityChain: sample.opacityChain }
      : { color: sample.color, bgLayers: sample.bgLayers, opacityChain: sample.opacityChain };
    const resolved = resolveSample(target);
    const ratio = Number(resolved.fgRatio.toFixed(2));
    const required = nonText ? 3 : requiredRatio(sample.fontSize, sample.fontWeight);
    return {
      route,
      kind: sample.kind,
      selector: sample.selector,
      found: true,
      note: sample.note ?? null,
      text: sample.text,
      tag: sample.tag,
      fontSize: sample.fontSize,
      fontWeight: sample.fontWeight,
      colorRaw: sample.color,
      foreground: rgbText(resolved.fg),
      background: rgbText(resolved.bg),
      bgLayerCount: sample.bgLayers.length,
      opacityChain: sample.opacityChain,
      ratio,
      required,
      category: nonText ? 'nonText' : 'text',
      borderWidth: sample.borderWidth ?? null,
      pass: ratio >= required,
    };
  });
}

/** Compute token pairs from the live computed custom properties. */
function evaluateTokens(tokenValues) {
  const get = (name) => tokenValues[name] ?? '';
  return TOKEN_PAIRS.map((pair) => {
    const layers = pair.layers.map(get).filter((value) => value !== '');
    if (layers.length !== pair.layers.length || get(pair.fg) === '') {
      return { kind: pair.kind, found: false, note: pair.note, category: pair.category };
    }
    let base = parseColor(layers[0]);
    if (base.a < 1) base = over(base, { r: 255, g: 255, b: 255, a: 1 });
    for (let index = 1; index < layers.length; index += 1) base = over(parseColor(layers[index]), base);
    const fgRaw = parseColor(get(pair.fg));
    const fg = over(fgRaw, base);
    const ratio = Number(contrastRatio(fg, base).toFixed(2));
    const required = pair.category === 'text' ? 4.5 : 3;
    return {
      kind: pair.kind,
      found: true,
      note: pair.note,
      category: pair.category,
      exempt: pair.exempt === true,
      foregroundToken: pair.fg,
      backgroundTokens: pair.layers,
      foregroundValue: get(pair.fg),
      backgroundRaw: pair.layers.map(get),
      foreground: rgbText(fg),
      background: rgbText(base),
      ratio,
      required,
      pass: ratio >= required,
    };
  });
}

/** Focus ring contrast measured with a real keyboard focus (non-text, needs 3:1).
 *
 * `outline-offset >= 0` paints the ring outside the border box, so the adjacent colour is
 * the parent's background, not the element's own fill (an accent-filled skip link would
 * otherwise look like a 1.5:1 failure that no user ever sees). Inset rings use the
 * element's own background.
 */
async function measureFocusRing(page) {
  await page.evaluate(`(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
  const rings = [];
  for (let step = 0; step < 14 && rings.length < 3; step += 1) {
    await page.tab();
    await sleep(40);
    const snapshot = await page.evaluate(FOCUS_SOURCE);
    if (snapshot.outlineStyle === 'none' || snapshot.outlineWidth === '0px') continue;
    const layers = Array.isArray(snapshot.bgLayers) ? [...snapshot.bgLayers] : [];
    const offset = Number.parseFloat(String(snapshot.outlineOffset ?? '0'));
    const inset = Number.isFinite(offset) && offset < 0;
    if (!inset && layers.length > 1) layers.pop();
    const resolved = resolveSample({ color: snapshot.outlineColor, bgLayers: layers.length === 0 ? snapshot.bgLayers : layers, opacityChain: 1 });
    const ratio = Number(resolved.fgRatio.toFixed(2));
    rings.push({
      step,
      tag: snapshot.tag,
      text: snapshot.text,
      outline: `${snapshot.outlineStyle} ${snapshot.outlineWidth} ${snapshot.outlineColor}`,
      outlineOffset: snapshot.outlineOffset,
      inset,
      foreground: rgbText(resolved.fg),
      background: rgbText(resolved.bg),
      ratio,
      required: 3,
      pass: ratio >= 3,
    });
  }
  return rings;
}

const browser = await openBrowser({ width: 1440, height: 900 });
const perTheme = {};
try {
  checker.add('stack-up', await isUp(Number(new URL(BASE).port || 80)), BASE);
  for (const theme of THEMES) {
    const page = await browser.newPage({ width: 1440, height: 900 });
    await page.setColorScheme(theme);
    try {
      // --- alerts route: text, table, severity badges, buttons ---
      await page.goto(`${BASE}/?theme=${theme}&static=1#/alerts`);
      await page.waitFor(`(() => {
        const table = document.querySelector('.ui-table');
        return table !== null && table.querySelectorAll('tr[data-row="true"]').length > 0;
      })()`, { timeoutMs: 20_000, label: `${theme} alerts table` });
      await sleep(settleMs);
      const tokens = await readTokens(page);
      const alertsSamples = evaluateSamples(await sampleSpecs(page, ALERTS_SPECS), 'alerts');
      const alertsRings = await measureFocusRing(page);

      // --- settings route: form controls, tabs, disabled, danger ---
      await page.evaluate(`(() => { location.hash = '#/settings'; })()`);
      await page.waitFor(`(() => document.querySelector('#view-root .settings-view, #view-root .settings-body') !== null)`, {
        timeoutMs: 25_000,
        label: `${theme} settings view`,
      });
      await sleep(settleMs + 500);
      const settingsSamples = evaluateSamples(await sampleSpecs(page, SETTINGS_SPECS), 'settings');
      const settingsRings = await measureFocusRing(page);

      const all = [...alertsSamples, ...settingsSamples];
      const tokenRows = evaluateTokens(tokens.tokens);
      const rings = [...alertsRings, ...settingsRings];
      const textRows = all.filter((row) => row.found === true && row.category === 'text' && row.note !== null && !row.kind.startsWith('disabled'));
      const disabledRows = all.filter((row) => row.found === true && row.kind === 'disabled-button');
      const nonTextRows = all.filter((row) => row.found === true && row.category === 'nonText');
      const tokenTextRows = tokenRows.filter((row) => row.found === true && row.category === 'text');
      // Decorative hairlines are exempt from WCAG 1.4.11 (not a control boundary); the
      // contract's token set deliberately adds --c-input-border for real control edges.
      const tokenNonTextRequired = tokenRows.filter((row) => row.found === true && row.category === 'nonText' && row.exempt !== true);
      const tokenNonTextExempt = tokenRows.filter((row) => row.found === true && row.category === 'nonText' && row.exempt === true);
      const min = (rows) => rows.reduce((low, row) => (row.ratio < low.ratio ? row : low), rows[0] ?? null);
      const requiredNonText = [...nonTextRows, ...tokenNonTextRequired];
      perTheme[theme] = {
        resolvedTheme: tokens.resolvedTheme,
        tokens: tokens.tokens,
        liveSamples: all,
        tokenPairs: tokenRows,
        focusRings: rings,
        minima: {
          text: min([...textRows, ...tokenTextRows]),
          nonText: min(requiredNonText),
          focusRing: min(rings),
          disabledInformational: min(disabledRows),
          decorativeNonTextInformational: min(tokenNonTextExempt),
        },
        counts: {
          liveSamples: all.length,
          liveMissing: all.filter((row) => row.found !== true).length,
          failedText: [...textRows, ...tokenTextRows].filter((row) => row.pass !== true).length,
          failedNonText: requiredNonText.filter((row) => row.pass !== true).length,
          failedFocusRing: rings.filter((row) => row.pass !== true).length,
          decorativeTokensBelowThree: tokenNonTextExempt.filter((row) => row.pass !== true).length,
        },
      };

      checker.add(`contrast-${theme}-theme-resolved`, tokens.resolvedTheme === theme, `resolved ${tokens.resolvedTheme}`);
      checker.add(`contrast-${theme}-text-min-4.5`, perTheme[theme].counts.failedText === 0,
        `${perTheme[theme].counts.failedText} failures, min ${perTheme[theme].minima.text?.ratio ?? 'n/a'}`);
      checker.add(`contrast-${theme}-nontext-min-3`, perTheme[theme].counts.failedNonText === 0,
        `${perTheme[theme].counts.failedNonText} failures, min ${perTheme[theme].minima.nonText?.ratio ?? 'n/a'}`);
      checker.add(`contrast-${theme}-focus-ring-min-3`, rings.length > 0 && perTheme[theme].counts.failedFocusRing === 0,
        `${rings.length} rings, min ${perTheme[theme].minima.focusRing?.ratio ?? 'n/a'}`);
      checker.add(`contrast-${theme}-samples-found`, all.filter((row) => row.found === true).length >= 12,
        `${all.filter((row) => row.found === true).length}/${all.length} live samples found`);
    } finally {
      await closePage(page);
    }
  }
} finally {
  await browser.close();
}

const buildAtEnd = buildFingerprint();
const buildDelta = fingerprintDelta(buildAtStart, buildAtEnd);
const summary = checker.summary();

/** Markdown table helper. */
const mdTable = (header, rows) => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
].join('\n');

const mdSections = [];
for (const theme of THEMES) {
  const entry = perTheme[theme];
  if (entry === undefined) continue;
  mdSections.push(`### ${theme} · live element samples`);
  mdSections.push(mdTable(
    ['kind', 'text', 'foreground', 'background', 'px/weight', 'ratio', 'required', 'verdict'],
    entry.liveSamples.filter((row) => row.found === true).map((row) => [
      row.kind,
      String(row.text ?? '').replaceAll('|', '\\|').slice(0, 40),
      row.foreground,
      row.background,
      `${row.fontSize}/${row.fontWeight}`,
      row.ratio.toFixed(2),
      row.required.toFixed(1),
      row.pass ? 'PASS' : (row.kind === 'disabled-button' ? 'exempt (1.4.3)' : 'FAIL'),
    ]),
  ));
  mdSections.push('');
  mdSections.push(`### ${theme} · token pairs (computed custom properties)`);
  mdSections.push(mdTable(
    ['kind', 'foreground token', 'background tokens', 'ratio', 'required', 'verdict'],
    entry.tokenPairs.filter((row) => row.found === true).map((row) => [
      row.kind,
      `${row.foregroundToken} (${row.foregroundValue})`,
      row.backgroundTokens.join(' + '),
      row.ratio.toFixed(2),
      row.required.toFixed(1),
      row.exempt === true ? (row.pass ? 'PASS (decorative)' : 'exempt (decorative)') : (row.pass ? 'PASS' : 'FAIL'),
    ]),
  ));
  mdSections.push('');
  mdSections.push(`### ${theme} · focus rings (real keyboard focus)`);
  mdSections.push(mdTable(
    ['step', 'element', 'outline', 'ring', 'background', 'ratio', 'verdict'],
    entry.focusRings.map((row) => [
      row.step,
      `${row.tag} "${String(row.text ?? '').slice(0, 24)}"`,
      row.outline,
      row.foreground,
      row.background,
      row.ratio.toFixed(2),
      row.pass ? 'PASS' : 'FAIL',
    ]),
  ));
  mdSections.push('');
  mdSections.push(`**${theme} minima**: text ${entry.minima.text?.ratio ?? 'n/a'}:1 (${entry.minima.text?.kind ?? 'n/a'}), `
    + `non-text ${entry.minima.nonText?.ratio ?? 'n/a'}:1 (${entry.minima.nonText?.kind ?? 'n/a'}), `
    + `focus ring ${entry.minima.focusRing?.ratio ?? 'n/a'}:1, `
    + `disabled (WCAG 1.4.3 exempt) ${entry.minima.disabledInformational?.ratio ?? 'n/a'}:1, `
    + `decorative divider (1.4.11 exempt) ${entry.minima.decorativeNonTextInformational?.ratio ?? 'n/a'}:1.`);
  mdSections.push('');
}

const report = {
  task: 'INT-4 WCAG contrast (live computed styles)',
  author: 'PT-dove',
  base: BASE,
  startedAt,
  finishedAt: new Date().toISOString(),
  build: {
    aggregate16: buildAtStart.aggregate16,
    fileCount: buildAtStart.fileCount,
    maxMtimeIso: buildAtStart.maxMtimeIso,
    movedDuringRun: !buildDelta.same,
    changedDuringRun: buildDelta.changedFiles,
  },
  thresholds: { text: 4.5, largeText: 3, nonText: 3, disabled: 'WCAG 1.4.3 exempt (informational)' },
  perTheme,
  checker: summary,
};
ensureDir(RESULTS);
writeJson(join(RESULTS, 'contrast.json'), report);
writeFileSync(join(EVIDENCE, 'CONTRAST.md'), [
  '# INT-4 · WCAG 对比度实测（真实计算值）',
  '',
  `- 生成时间：${report.finishedAt}`,
  `- build 指纹（apps/console-next 资产汇总 sha256 前 16 位）：\`${report.build.aggregate16}\`（${report.build.fileCount} 文件，最新 mtime ${report.build.maxMtimeIso}）`,
  `- build 在本次测量期间是否移动：${report.build.movedDuringRun ? '是（见 changedDuringRun）' : '否'}`,
  `- 数据源：${BASE}（真实 daemon，alerts + settings 视图），暗/亮两主题，全部读 \`getComputedStyle\``,
  `- 阈值：正文 4.5:1；大字（≥24px 或 ≥18.66px 且 ≥700 字重）/ 非文本 3:1`,
  '',
  ...mdSections,
  '## 判定摘要',
  '',
  ...THEMES.map((theme) => {
    const entry = perTheme[theme];
    if (entry === undefined) return `- ${theme}: 未测到（栈不可用）`;
    return `- ${theme}: 正文最低 ${entry.minima.text?.ratio ?? 'n/a'}:1；非文本最低 ${entry.minima.nonText?.ratio ?? 'n/a'}:1；`
      + `焦点环最低 ${entry.minima.focusRing?.ratio ?? 'n/a'}:1；失败项 正文 ${entry.counts.failedText} / 非文本 ${entry.counts.failedNonText} / 焦点环 ${entry.counts.failedFocusRing}`;
  }),
  '',
].join('\n'));
process.stdout.write(`${JSON.stringify({
  build16: report.build.aggregate16,
  buildMovedDuringRun: report.build.movedDuringRun,
  themes: Object.fromEntries(THEMES.map((theme) => [theme, {
    minima: perTheme[theme]?.minima ?? null,
    counts: perTheme[theme]?.counts ?? null,
  }])),
  checks: summary.total,
  passed: summary.passed,
  failed: summary.failed,
  failures: summary.checks.filter((entry) => !entry.ok),
  out: join(RESULTS, 'contrast.json'),
  markdown: join(EVIDENCE, 'CONTRAST.md'),
}, null, 2)}\n`);
process.exitCode = summary.failed === 0 ? 0 : 1;
