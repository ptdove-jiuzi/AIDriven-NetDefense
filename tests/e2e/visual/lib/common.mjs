/**
 * common.mjs — shared plumbing for the UI2 visual + a11y suite (author PT-dove).
 *
 * Zero dependencies: colours are parsed from `getComputedStyle` values, WCAG contrast is
 * computed here in plain JS, screenshots are written as PNG bytes from the CDP driver.
 *
 * Everything this module writes lives under
 * `docs/implementation/evidence/ui2/visual/` (this task's evidence write domain).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from '../../lib/cdp.mjs';

export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
export const EVIDENCE = join(REPO, 'docs', 'implementation', 'evidence', 'ui2', 'visual');
export const SHOTS = join(EVIDENCE, 'shots');
export const RESULTS = join(EVIDENCE, 'results');

/** The six console v2 views (contract §7.2). */
export const VIEWS = Object.freeze(['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']);

/** Canonical runtime (read-only for this task; only the integrator restarts it). */
export const STACKS = Object.freeze({
  data: { name: 'data', base: 'http://127.0.0.1:17512', port: 17512 },
  nodata: { name: 'nodata', base: 'http://127.0.0.1:17522', port: 17522 },
});

export const VIEWPORTS = Object.freeze([
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 },
]);

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Create a directory (idempotent). */
export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Write pretty JSON, creating parent directories. */
export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** sha256 of a buffer, short form. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Write PNG bytes to the shots directory and return the evidence-relative path. */
export function writeShot(name, buffer) {
  ensureDir(SHOTS);
  const target = join(SHOTS, name);
  writeFileSync(target, buffer);
  return {
    path: target,
    rel: `shots/${name}`,
    bytes: buffer.length,
    sha256: sha256(buffer).slice(0, 16),
  };
}

/** True when a TCP port accepts connections (used to skip a stack that is down). */
export async function isUp(port, timeoutMs = 800) {
  const net = await import('node:net');
  return new Promise((done) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      done(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Wait until `port` is listening; returns false if it never comes up. */
export async function waitForPort(port, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}

/** Launch a headless Chromium-family browser at the given viewport. */
export async function openBrowser({ width = 1440, height = 900 } = {}) {
  return launch({ headless: true, width, height });
}

/** Close a page target without killing the browser. */
export async function closePage(page) {
  try {
    await page.connection.send('Target.closeTarget', { targetId: page.targetId });
  } catch {
    /* target already gone */
  }
}

/* ==========================================================================
 * Colour + WCAG contrast (computed from real getComputedStyle values)
 * ======================================================================== */

/**
 * Parse a CSS colour string as returned by `getComputedStyle` into
 * `{r, g, b, a}` (0-255, alpha 0-1). Supports `rgb()`, `rgba()`, `transparent`
 * and the `color(srgb ...)` form Chromium emits for wide-gamut values.
 *
 * @param {string} value Computed colour.
 * @returns {{r: number, g: number, b: number, a: number}}
 */
export function parseColor(value) {
  const text = String(value ?? '').trim();
  if (text === '' || text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/iu.exec(text);
  if (hex !== null) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      const expand = (character) => Number.parseInt(`${character}${character}`, 16);
      return {
        r: expand(digits[0]),
        g: expand(digits[1]),
        b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/iu.exec(text);
  if (rgb !== null) {
    const alphaRaw = rgb[4];
    let alpha = 1;
    if (alphaRaw !== undefined) alpha = alphaRaw.endsWith('%') ? Number.parseFloat(alphaRaw) / 100 : Number.parseFloat(alphaRaw);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: Number.isFinite(alpha) ? alpha : 1 };
  }
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)$/iu.exec(text);
  if (srgb !== null) {
    return {
      r: Math.round(Number(srgb[1]) * 255),
      g: Math.round(Number(srgb[2]) * 255),
      b: Math.round(Number(srgb[3]) * 255),
      a: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

/** Composite `top` over `bottom` (both `{r,g,b,a}`), returning an opaque-ish result. */
export function over(top, bottom) {
  const alpha = top.a + bottom.a * (1 - top.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (topChannel, bottomChannel) => (
    (topChannel * top.a + bottomChannel * bottom.a * (1 - top.a)) / alpha
  );
  return {
    r: mix(top.r, bottom.r),
    g: mix(top.g, bottom.g),
    b: mix(top.b, bottom.b),
    a: alpha,
  };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance({ r, g, b }) {
  const channel = (value) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two opaque colours. */
export function contrastRatio(foreground, background) {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

/** `rgb(r, g, b)` text for reports. */
export function rgbText({ r, g, b }) {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * Resolve one in-page sample into an effective foreground/background pair.
 *
 * The sampler returns `bgLayers` ordered from the document root down to the element
 * (i.e. paint order), `color`, and `opacityChain` (product of computed opacity on the
 * element and its ancestors — WCAG treats a translucent element as its blended colour).
 *
 * @param {{color: string, bgLayers: string[], opacityChain?: number}} sample In-page sample.
 * @returns {{fg: object, bg: object, fgRatio: number}}
 */
export function resolveSample(sample) {
  const layers = (sample.bgLayers ?? []).map(parseColor);
  let base = layers.length === 0 ? { r: 255, g: 255, b: 255, a: 1 } : layers[0];
  if (base.a < 1) base = over(base, { r: 255, g: 255, b: 255, a: 1 });
  for (let index = 1; index < layers.length; index += 1) base = over(layers[index], base);
  const color = parseColor(sample.color);
  const opacity = typeof sample.opacityChain === 'number' && Number.isFinite(sample.opacityChain)
    ? Math.max(0, Math.min(1, sample.opacityChain))
    : 1;
  const fg = over({ ...color, a: color.a * opacity }, base);
  return { fg, bg: base, fgRatio: contrastRatio(fg, base) };
}

/** WCAG 1.4.3 threshold: large text (>=24px, or >=18.66px bold) needs 3:1. */
export function requiredRatio(fontSizePx, fontWeight) {
  const size = Number(fontSizePx) || 16;
  const weight = Number(fontWeight) || 400;
  const large = size >= 24 || (size >= 18.66 && weight >= 700);
  return large ? 3 : 4.5;
}

/* ==========================================================================
 * In-page helpers (strings evaluated through CDP)
 * ======================================================================== */

/** Component-level fixture mount point used by the 5000-row harness. */
export const FIXTURE_ROOT_ID = 'visual-fixture-root';

/**
 * The in-page sampler. `__SPECS__` is replaced with a JSON array of
 * `{kind, selector, index, note, nonText}` entries.
 */
export const SAMPLE_SOURCE = `(() => {
  const specs = __SPECS__;
  const bgLayersOf = (node) => {
    const layers = [];
    let current = node;
    while (current && current.nodeType === 1) {
      const style = getComputedStyle(current);
      const color = style.backgroundColor;
      if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') layers.push(color);
      current = current.parentElement;
    }
    if (layers.length === 0) layers.push(getComputedStyle(document.body).backgroundColor || 'rgb(255, 255, 255)');
    return layers.reverse();
  };
  const opacityOf = (node) => {
    let chain = 1;
    let current = node;
    while (current && current.nodeType === 1) {
      const value = Number(getComputedStyle(current).opacity);
      if (Number.isFinite(value)) chain *= value;
      current = current.parentElement;
    }
    return chain;
  };
  const label = (node) => (node.innerText ?? node.textContent ?? '').replace(/\\s+/gu, ' ').trim();
  const out = [];
  for (const spec of specs) {
    let nodes;
    try { nodes = [...document.querySelectorAll(spec.selector)]; } catch (error) { nodes = []; }
    if (spec.nonText === true) {
      // For non-text targets the selector points at the element whose border/ring is measured.
      const node = nodes[spec.index ?? 0];
      if (!node) { out.push({ kind: spec.kind, selector: spec.selector, found: false, note: spec.note ?? null }); continue; }
      const style = getComputedStyle(node);
      out.push({
        kind: spec.kind,
        selector: spec.selector,
        found: true,
        note: spec.note ?? null,
        text: label(node).slice(0, 80),
        color: style.borderTopColor,
        borderWidth: style.borderTopWidth,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        bgLayers: bgLayersOf(node),
        opacityChain: opacityOf(node),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        tag: node.tagName.toLowerCase(),
      });
      continue;
    }
    const node = nodes[spec.index ?? 0];
    if (!node) { out.push({ kind: spec.kind, selector: spec.selector, found: false, note: spec.note ?? null }); continue; }
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    out.push({
      kind: spec.kind,
      selector: spec.selector,
      found: true,
      note: spec.note ?? null,
      text: label(node).slice(0, 80),
      color: style.color,
      bgLayers: bgLayersOf(node),
      opacityChain: opacityOf(node),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      tag: node.tagName.toLowerCase(),
      disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  return out;
})()`;

/** Snapshot of the currently focused element, including its visible focus treatment. */
export const FOCUS_SOURCE = `(() => {
  const TABBABLE = 'a[href],area[href],button,input,select,textarea,iframe,object,embed,[tabindex],[contenteditable="true"]';
  const all = [...document.querySelectorAll(TABBABLE)].filter((node) => {
    if (node.getAttribute('tabindex') === '-1') return false;
    if (node.disabled === true) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const active = document.activeElement;
  const index = all.indexOf(active);
  const style = active ? getComputedStyle(active) : null;
  const rect = active ? active.getBoundingClientRect() : null;
  const hiddenAncestor = active && active.closest ? active.closest('[aria-hidden="true"]') : null;
  const visible = (() => {
    let current = active;
    while (current && current.nodeType === 1) {
      const computed = getComputedStyle(current);
      if (computed.display === 'none' || computed.visibility === 'hidden') return false;
      current = current.parentElement;
    }
    return true;
  })();
  const bgLayers = [];
  let current = active;
  while (current && current.nodeType === 1) {
    const color = getComputedStyle(current).backgroundColor;
    if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') bgLayers.push(color);
    current = current.parentElement;
  }
  bgLayers.reverse();
  const role = active && (active.getAttribute('role') || (function () {
    const tag = active.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'tr') return 'row';
    return null;
  })());
  return {
    tag: active ? active.tagName : null,
    id: active ? (active.id || null) : null,
    cls: active ? String(active.className ?? '').slice(0, 120) : null,
    role,
    text: active ? (active.innerText ?? active.value ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 90) : null,
    ariaLabel: active ? active.getAttribute('aria-label') : null,
    outlineStyle: style ? style.outlineStyle : null,
    outlineWidth: style ? style.outlineWidth : null,
    outlineColor: style ? style.outlineColor : null,
    outlineOffset: style ? style.outlineOffset : null,
    boxShadow: style ? style.boxShadow : null,
    bgLayers,
    rect: rect ? { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top) } : null,
    domOrderIndex: index,
    tabbableCount: all.length,
    insideAriaHidden: hiddenAncestor !== null,
    visible,
    insideDrawer: active ? active.closest('.ui-drawer__panel') !== null : false,
    insideModal: active ? active.closest('.ui-modal__panel') !== null : false,
    overlayCount: document.querySelectorAll('[data-overlay]').length,
    scrollLock: document.documentElement.classList.contains('ui-scroll-lock'),
    display: style ? style.display : null,
  };
})()`;

/**
 * Install a long-task observer in the page (PerformanceObserver 'longtask').
 * Returns the number of entries currently recorded.
 */
export const LONG_TASK_INSTALL_SOURCE = `(() => {
  window.__visualLongTasks = [];
  window.__visualLongTaskError = null;
  try {
    window.__visualLongTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__visualLongTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
      }
    });
    window.__visualLongTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch (error) {
    window.__visualLongTaskError = String(error && error.message ? error.message : error);
  }
  return window.__visualLongTasks.length;
})()`;

/** Read the recorded long tasks and their maximum duration. */
export const LONG_TASK_READ_SOURCE = `(() => {
  const tasks = window.__visualLongTasks ?? [];
  let max = 0;
  let total = 0;
  for (const task of tasks) { max = Math.max(max, task.duration); total += task.duration; }
  return { count: tasks.length, maxDurationMs: max, totalDurationMs: Math.round(total), error: window.__visualLongTaskError ?? null, tasks: tasks.slice(-20) };
})()`;

/** Click at absolute viewport coordinates (needed for backdrop clicks). */
export async function clickAt(page, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.connection.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
    }, page.sessionId);
  }
  return { x, y };
}

/** One line summary of the DevTools report (errors / exceptions / failed requests). */
export function devtoolsSummary(page) {
  const report = page.report();
  return {
    consoleErrors: report.consoleErrors.map((entry) => entry.text.slice(0, 200)),
    exceptions: report.exceptions.map((entry) => String(entry.text).slice(0, 200)),
    consoleWarnings: report.consoleWarnings.length,
    logErrors: report.logErrors.map((entry) => String(entry.text).slice(0, 200)),
    failedRequests: report.failedRequests.length,
    badResponses: report.badResponses.map((entry) => `${entry.status} ${String(entry.url).slice(0, 120)}`),
    total: report.total,
  };
}

/** Assertion collector: records checks without throwing, so one run reports everything. */
export function createChecker() {
  const checks = [];
  const add = (id, ok, detail) => {
    checks.push({ id, ok: ok === true, detail: detail ?? null });
    return ok === true;
  };
  const summary = () => ({
    total: checks.length,
    passed: checks.filter((entry) => entry.ok).length,
    failed: checks.filter((entry) => !entry.ok).length,
    checks,
  });
  return { add, checks, summary };
}

/** Resolve `--key value` CLI flags. */
export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

/** True when this module was executed directly (`node <file>`). */
export function invokedDirectly(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === fileURLToPath(moduleUrl);
}

/** Existence probe (used to decide whether a stack can be captured at all). */
export function exists(path) {
  return existsSync(path);
}

/* ==========================================================================
 * Build fingerprint (the console is a moving target: js/** is being rewritten by
 * parallel sessions while this suite runs, so every number must be bound to a build)
 * ======================================================================== */

const CONSOLE_ROOT = join(REPO, 'apps', 'console-next');
const FINGERPRINT_EXTENSIONS = ['.js', '.mjs', '.css', '.html', '.svg', '.json'];

/**
 * Hash every shipped console asset (js/css/html/svg under apps/console-next).
 *
 * @returns {{aggregate: string, fileCount: number, sampledAt: string, maxMtimeIso: string,
 *   files: Array<{path: string, sha256: string, bytes: number, mtimeIso: string}>}}
 */
export function buildFingerprint() {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!FINGERPRINT_EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf('.')))) continue;
      const stats = statSync(full);
      const bytes = readFileSync(full);
      files.push({
        path: relative(REPO, full).replaceAll('\\', '/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        mtimeIso: new Date(stats.mtimeMs).toISOString(),
      });
    }
  };
  walk(CONSOLE_ROOT);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const aggregate = createHash('sha256')
    .update(files.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'))
    .digest('hex');
  const maxMtime = files.reduce((latest, entry) => (entry.mtimeIso > latest ? entry.mtimeIso : latest), '');
  return {
    aggregate,
    aggregate16: aggregate.slice(0, 16),
    fileCount: files.length,
    sampledAt: new Date().toISOString(),
    maxMtimeIso: maxMtime,
    files,
  };
}

/** Persist a build fingerprint under `results/builds/` so runs can be compared. */
export function recordBuild(build, label) {
  const directory = ensureDir(join(RESULTS, 'builds'));
  const safeLabel = String(label ?? 'run').replace(/[^a-z0-9._-]+/giu, '-');
  const path = join(directory, `${safeLabel}-${build.sampledAt.replace(/[:.]/gu, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(build, null, 2)}\n`);
  return { path, rel: relative(EVIDENCE, path).replaceAll('\\', '/') };
}

/** Compare two fingerprints; returns the files that changed between them. */
export function fingerprintDelta(before, after) {
  const lookup = new Map(before.files.map((entry) => [entry.path, entry.sha256]));
  const changed = [];
  for (const entry of after.files) {
    if (lookup.get(entry.path) !== entry.sha256) changed.push(entry.path);
    lookup.delete(entry.path);
  }
  for (const removed of lookup.keys()) changed.push(`${removed} (removed)`);
  return {
    same: changed.length === 0 && before.aggregate === after.aggregate,
    changedFiles: changed,
    beforeAggregate16: before.aggregate16,
    afterAggregate16: after.aggregate16,
  };
}
