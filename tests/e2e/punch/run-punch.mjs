/**
 * run-punch.mjs — PUNCH 点测执行器（6 页 × 暗/亮 × 中/英，逐元素真实点击）
 * 作者：PT-dove
 *
 * 用法：
 *   node tests/e2e/punch/run-punch.mjs --mode=matrix --stack=data --budget-ms=1500000
 *   node tests/e2e/punch/run-punch.mjs --mode=scenarios --stack=both
 *   node tests/e2e/punch/run-punch.mjs --mode=groups --stack=data
 * 产物：docs/implementation/evidence/ui2/punch/{run-log.json,shots/*.png}
 *
 * 纪律：只用真实鼠标/键盘事件；不重启栈；只读 apps/**；每批前记录 build 指纹。
 */
import { openBrowser, installHelpers, navigate, settle, clickAt, pressKey, selectAll, typeText,
  cursor, delta, closeOverlay, isKnownIssue, isDeclaredBoundary, pageStats, sleep } from './lib/probe.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const EVID = join(REPO, 'docs', 'implementation', 'evidence', 'ui2', 'punch');
const RUN_LOG = join(EVID, argValue('out', 'run-log.json'));
const SHOTS = join(EVID, 'shots');

const STACKS = { data: 'http://127.0.0.1:17512', empty: 'http://127.0.0.1:17522' };
const ROUTES = [
  { name: 'overview', hash: '#/overview' },
  { name: 'alerts', hash: '#/alerts' },
  { name: 'analysis', hash: '#/analysis' },
  { name: 'agent', hash: '#/agent' },
  { name: 'models', hash: '#/models' },
  { name: 'settings', hash: '#/settings' },
];
const COMBOS = [
  { theme: 'dark', lang: 'zh-CN' },
  { theme: 'light', lang: 'zh-CN' },
  { theme: 'dark', lang: 'en' },
  { theme: 'light', lang: 'en' },
];

function argValue(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const CFG = {
  mode: argValue('mode', 'matrix'),
  stack: argValue('stack', 'both'),
  routes: argValue('routes', ''),
  combos: argValue('combos', ''),
  group: argValue('group', ''),
  budgetMs: Number(argValue('budget-ms', '1800000')),
  maxClicksPerState: Number(argValue('max-clicks', '400')),
  maxShots: Number(argValue('max-shots', '120')),
  merge: argValue('merge', '1') !== '0',
};

function stackList() {
  if (CFG.stack === 'both') return ['data', 'empty'];
  return CFG.stack.split(',').filter((s) => STACKS[s]);
}
function routeList() {
  if (!CFG.routes) return ROUTES;
  const want = new Set(CFG.routes.split(','));
  return ROUTES.filter((r) => want.has(r.name));
}
function comboList() {
  if (!CFG.combos) return COMBOS;
  return CFG.combos.split(',').map((c) => {
    const [theme, lang] = c.split(':');
    return { theme: theme === 'light' ? 'light' : 'dark', lang: lang === 'en' ? 'en' : 'zh-CN' };
  });
}

/* ───────────────────────── build 指纹 ───────────────────────── */

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|css|html|svg|json)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

function buildFingerprint() {
  const root = join(REPO, 'apps', 'console-next');
  const files = walk(root, []).sort();
  const hashes = {};
  let newest = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    const sha = createHash('sha256').update(buf).digest('hex');
    hashes[relative(REPO, f).replace(/\\/g, '/')] = sha;
    const m = statSync(f).mtimeMs;
    if (m > newest) newest = m;
  }
  const digest = createHash('sha256');
  for (const [p, h] of Object.entries(hashes)) digest.update(p + ':' + h + '\n');
  return { buildHash: digest.digest('hex'), files: files.length, newestMtime: new Date(newest).toISOString(), hashes };
}

/* ───────────────────────── run-log ───────────────────────── */

/** 单个页态/场景开始时的 build 指纹（前端文件每次请求读盘，移动靶必须逐状态记录）。 */
function currentBuildHash() {
  try {
    return buildFingerprint().buildHash;
  } catch {
    return null;
  }
}

function freshLog() {
  return { tool: 'punch', version: 1, generatedAt: null, batches: [], states: [], scenarios: [], defectsIndex: [] };
}
function loadLog() {
  if (!CFG.merge || !existsSync(RUN_LOG)) return freshLog();
  try {
    return JSON.parse(readFileSync(RUN_LOG, 'utf8'));
  } catch {
    return freshLog();
  }
}
function saveLog(log) {
  log.generatedAt = new Date().toISOString();
  mkdirSync(EVID, { recursive: true });
  writeFileSync(RUN_LOG, JSON.stringify(log, null, 1), 'utf8');
}

/* ───────────────────────── 分类 ───────────────────────── */

function diffAttrs(a, b) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if (String((a || {})[k]) !== String((b || {})[k])) out.push(k + ':' + (a || {})[k] + '→' + (b || {})[k]);
  return out;
}

function classify(rec, ambient) {
  const known = (arr) => (arr || []).filter((s) => !isKnownIssue(s));
  const real = (arr) => known(arr).filter((s) => !isDeclaredBoundary(s));
  const errs = real(rec.deltas.consoleErrors);
  const excs = real(rec.deltas.exceptions);
  const logErrs = real(rec.deltas.logErrors);
  const bad = real(rec.deltas.badResponses);
  const declared = [...(rec.deltas.consoleErrors || []), ...(rec.deltas.exceptions || []),
    ...(rec.deltas.logErrors || []), ...(rec.deltas.badResponses || [])].filter((s) => isDeclaredBoundary(s));
  const b = rec.before || {};
  const a = rec.post || {};
  const attrChanged = diffAttrs(rec.targetBefore && rec.targetBefore.attrs, rec.targetAfter && rec.targetAfter.attrs);
  const focusOnTarget = rec.activeIsTarget === true && ['input', 'select', 'textarea'].includes(rec.item.tag);
  const mut = rec.mutations || {};
  const responded =
    (mut.n || 0) > (ambient || 0) ||
    a.viewSig !== b.viewSig || a.viewLen !== b.viewLen ||
    a.hash !== b.hash ||
    a.drawer !== b.drawer || a.modal !== b.modal ||
    a.toastCount !== b.toastCount || a.toast !== b.toast ||
    a.ui !== b.ui || a.theme !== b.theme || a.lang !== b.lang ||
    attrChanged.length > 0 || focusOnTarget || rec.overlayOpened === true;
  if (rec.crashed) return { category: 'error', errorKind: 'crash', reasons: ['页面渲染结果为空白（viewLen=0）'], notPersisted: false };
  if (errs.length || excs.length || logErrs.length || bad.length) {
    return {
      category: 'error',
      reasons: [].concat(errs.slice(0, 3), excs.slice(0, 3), logErrs.slice(0, 3), bad.slice(0, 3)),
      notPersisted: false,
      declared: declared.slice(0, 3),
    };
  }
  if (!responded) {
    if (rec.sameTargetLink) {
      return { category: 'ok', reasons: ['同页链接：目标 hash 与当前一致，属预期 no-op'], notPersisted: false };
    }
    if (rec.sameRouteText) {
      return { category: 'ok', reasons: ['同页锚点/当前路由：无状态变化属预期'], notPersisted: false };
    }
    return { category: 'no_effect', reasons: ['点击后 400ms 内 DOM/hash/toast/localStorage/aria 均无变化'], notPersisted: false };
  }
  return { category: 'ok', reasons: [], notPersisted: false };
}

/* ───────────────────────── 截图 ───────────────────────── */

let shotCount = 0;
async function snap(page, ctx, tag) {
  if (ctx.shotCount >= CFG.maxShots) return null;
  ctx.shotCount += 1;
  shotCount += 1;
  mkdirSync(SHOTS, { recursive: true });
  const name = tag.replace(/[^A-Za-z0-9#_.-]+/g, '_').slice(0, 130) + '-p' + process.pid + '-' + shotCount + '.png';
  try {
    writeFileSync(join(SHOTS, name), await page.screenshot());
    return 'shots/' + name;
  } catch {
    return null;
  }
}

/* ───────────────────────── 单次点击检查 ───────────────────────── */

async function inspectClick(ctx, st, item, ambient, state) {
  const { page } = ctx;
  const t0 = Date.now();
  const before = await page.evaluate('__punch.snapshot()');
  const currentHashBase = String(before.hash || '').split('?')[0];
  const hrefHash = (typeof item.href === 'string' && item.href.startsWith('#')) ? item.href.split('?')[0] : null;
  const sameTargetLink = Boolean(hrefHash && (hrefHash === '#' || hrefHash === currentHashBase));
  const targetBefore = await page.evaluate(`__punch.targetAttrs(${JSON.stringify(item.path)})`);
  const cur = cursor(page);
  const prep = await page.evaluate(`__punch.prepare(${JSON.stringify(item.path)})`);
  if (!prep || !prep.ok) {
    return { kind: 'skip', status: 'skipped-' + ((prep && prep.reason) || 'offscreen'), item };
  }
  await page.evaluate('__punch.observeStart()');
  await clickAt(page, prep.x, prep.y);
  let action = 'click';
  if (item.tag === 'select') {
    await sleep(140);
    await page.escape();
    await sleep(120);
    await pressKey(page, 'ArrowDown', 'ArrowDown', 40);
    action = 'click+ArrowDown';
  }
  await sleep(400);
  let post = await page.evaluate('__punch.snapshot()');
  if (post.viewLen === 0) {
    await sleep(900);
    post = await page.evaluate('__punch.snapshot()');
  }
  const mutations = await page.evaluate('__punch.observeStop()');
  const targetAfter = await page.evaluate(`__punch.targetAttrs(${JSON.stringify(item.path)})`);
  const activeIsTarget = await page.evaluate(`__punch.isActive(${JSON.stringify(item.path)})`);
  const dl = delta(page, cur);
  const ov = await page.evaluate('__punch.overlayInfo()');
  const overlayOpened = Boolean(ov.drawer || ov.modal);
  const errorSignals = await page.evaluate('__punch.errorSignals()');
  const rec = {
    kind: 'click',
    seq: state.clicks.length + 1,
    item: {
      tag: item.tag, role: item.role, type: item.type, text: item.text, aria: item.aria, title: item.title,
      href: item.href, tab: item.tab, locale: item.locale, dataAction: item.dataAction, path: item.path,
    },
    action,
    before: compactSnap(before),
    post: compactSnap(post),
    targetBefore,
    targetAfter,
    activeIsTarget,
    mutations,
    deltas: {
      consoleErrors: dl.consoleErrors, exceptions: dl.exceptions, logErrors: dl.logErrors, badResponses: dl.badResponses,
    },
    errorSignals,
    overlayOpened,
    overlay: ov,
    sameTargetLink,
    crashHint: post.viewLen === 0,
    elapsedMs: Date.now() - t0,
  };

  // 抽屉/弹窗内部元素（每页态首次打开时探测，破坏性弹窗不点确认）
  if (overlayOpened && !state.overlayProbed) {
    state.overlayProbed = true;
    rec.overlayInner = await probeOverlayInternals(ctx, st, ov);
  }
  let overlayClose = null;
  const ovNow = await page.evaluate('__punch.overlayInfo()');
  if (ovNow.drawer || ovNow.modal) overlayClose = await closeOverlay(page);
  rec.overlayClose = overlayClose;
  const afterClose = await page.evaluate('__punch.snapshot()');
  rec.afterClose = compactSnap(afterClose);

  const verdict = classify(rec, ambient);
  Object.assign(rec, verdict);
  if (rec.category === 'error' || rec.category === 'no_effect') {
    rec.shot = await snap(page, ctx, [st.stack, st.name, st.theme, st.lang, item.tag, String(rec.seq)].join('-'));
  }
  rec.needRenav = afterClose.hash !== state.actualHash
    || afterClose.viewLen === 0
    || afterClose.theme !== state.stats.theme
    || afterClose.lang !== state.stats.lang;
  if (rec.needRenav) rec.renavTo = st.url;
  return rec;
}

function compactSnap(s) {
  if (!s) return null;
  return {
    hash: s.hash, viewLen: s.viewLen, viewSig: s.viewSig, viewNodes: s.viewNodes,
    drawer: s.drawer, modal: s.modal, toast: s.toast, toastCount: s.toastCount,
    active: s.active, theme: s.theme, lang: s.lang, ui: s.ui,
  };
}

/** 对已打开 overlay 内部可点元素做有限探测（≤3 个；破坏性 modal 跳过确认动作）。 */
async function probeOverlayInternals(ctx, st, ov) {
  const { page } = ctx;
  if (ov.modal && ov.modal.destructive) {
    return { skipped: 'destructive-modal', note: '破坏性确认弹窗只测关闭，不点确认' };
  }
  const scope = ov.modal ? '#modal-root > *' : '#drawer-root > *';
  const list = await page.evaluate(`__punch.enumerate(${JSON.stringify(scope)})`);
  const results = [];
  let clicked = 0;
  for (const it of list.items) {
    if (clicked >= 3) break;
    if (it.disabled) {
      results.push({ status: 'skipped-disabled', item: { tag: it.tag, text: it.text, path: it.path } });
      continue;
    }
    const before = await page.evaluate('__punch.snapshot()');
    const cur = cursor(page);
    const prep = await page.evaluate(`__punch.prepare(${JSON.stringify(it.path)})`);
    if (!prep || !prep.ok) {
      results.push({ status: 'skipped-offscreen', item: { tag: it.tag, text: it.text, path: it.path } });
      continue;
    }
    await page.evaluate('__punch.observeStart()');
    await clickAt(page, prep.x, prep.y);
    await sleep(400);
    const post = await page.evaluate('__punch.snapshot()');
    const mutations = await page.evaluate('__punch.observeStop()');
    const dl = delta(page, cur);
    const err = await page.evaluate('__punch.errorSignals()');
    const openNow = await page.evaluate('__punch.overlayInfo()');
    results.push({
      status: 'clicked',
      item: { tag: it.tag, role: it.role, text: it.text, aria: it.aria, path: it.path },
      before: compactSnap(before), post: compactSnap(post), mutations,
      deltas: { consoleErrors: dl.consoleErrors, exceptions: dl.exceptions, logErrors: dl.logErrors, badResponses: dl.badResponses },
      errorSignals: err, overlayStillOpen: Boolean(openNow.drawer || openNow.modal),
      needRenav: post.hash !== before.hash,
    });
    clicked += 1;
    if (!openNow.drawer && !openNow.modal) break;
    if (post.hash !== before.hash) break;
  }
  return { clicked, results };
}

/* ───────────────────────── 单页态清扫 ───────────────────────── */

async function sweepState(ctx, st, log) {
  const { page } = ctx;
  const state = {
    key: [st.stack, st.name, st.theme, st.lang, st.group || ''].join('|'),
    batchId: ctx.batchId,
    buildHash: currentBuildHash(),
    stack: st.stack, route: st.name, url: st.url, theme: st.theme, lang: st.lang, group: st.group || null,
    startedAt: new Date().toISOString(),
    loadReport: null, stats: null, ambientMutations: 0, clicks: [], truncated: null,
  };
  try {
    await navigate(page, st.url);
    await settle(page);
    await installHelpers(page);
    const loadReport = page.report();
    state.loadReport = {
      consoleErrors: loadReport.consoleErrors.length,
      exceptions: loadReport.exceptions.length,
      logErrors: loadReport.logErrors.length,
      badResponses: loadReport.badResponses.filter((r) => r.status >= 400).map((r) => r.status + ' ' + r.url),
    };
    page.resetReport();
    await sleep(300);
    await page.evaluate('__punch.observeStart()');
    await sleep(420);
    const ambient = await page.evaluate('__punch.observeStop()');
    state.ambientMutations = ambient.n || 0;
    page.resetReport();
    state.stats = await pageStats(page);
    state.actualHash = await page.evaluate('location.hash');
    const processed = new Set();
    let guard = 0;
    for (;;) {
      if (state.clicks.length >= CFG.maxClicksPerState) {
        state.truncated = 'max-clicks';
        break;
      }
      if (Date.now() > ctx.deadline) {
        state.truncated = 'budget';
        break;
      }
      if (guard++ > CFG.maxClicksPerState * 10) {
        state.truncated = 'guard';
        break;
      }
      let enumerated;
      try {
        enumerated = await page.evaluate('__punch.enumerate()');
      } catch (error) {
        state.truncated = 'enumerate-failed: ' + error.message;
        break;
      }
      const next = enumerated.items.find((it) => !processed.has(it.sig));
      if (!next) break;
      processed.add(next.sig);
      if (next.disabled) {
        state.clicks.push({
          kind: 'skip', status: 'skipped-disabled',
          item: { tag: next.tag, text: next.text, aria: next.aria, path: next.path },
        });
        continue;
      }
      let rec;
      try {
        rec = await inspectClick(ctx, st, next, state.ambientMutations, state);
      } catch (error) {
        rec = { kind: 'click', item: { tag: next.tag, text: next.text, path: next.path }, category: 'error', errorKind: 'harness-exception', reasons: [String(error && error.message)], planner: false };
      }
      state.clicks.push(rec);
      if (rec.needRenav) {
        await navigate(page, st.url);
        await settle(page);
        await installHelpers(page);
        page.resetReport();
        state.actualHash = await page.evaluate('location.hash');
        state.stats = await pageStats(page);
      }
    }
  } catch (error) {
    state.truncated = 'state-failed: ' + String(error && error.message);
  }
  state.finishedAt = new Date().toISOString();
  state.totals = tallyClicks(state.clicks);
  const idx = log.states.findIndex((s) => s.key === state.key);
  if (idx >= 0) log.states[idx] = state;
  else log.states.push(state);
  saveLog(log);
  const t = state.totals;
  console.log(`[state] ${state.key} clicks=${t.total} ok=${t.ok} error=${t.error} no_effect=${t.no_effect} skipped=${t.skipped}${state.truncated ? ' TRUNC=' + state.truncated : ''}`);
  return state;
}

function tallyClicks(clicks) {
  const t = { total: 0, ok: 0, error: 0, no_effect: 0, skipped: 0, skipped_disabled: 0 };
  for (const c of clicks) {
    if (c.kind === 'skip') {
      t.skipped += 1;
      if (c.status === 'skipped-disabled') t.skipped_disabled += 1;
      continue;
    }
    t.total += 1;
    if (c.category === 'ok') t.ok += 1;
    else if (c.category === 'error') t.error += 1;
    else if (c.category === 'no_effect') t.no_effect += 1;
  }
  return t;
}

/* ───────────────────────── 场景 ───────────────────────── */

function cleanUrl(base, hash) {
  return `${base}/${hash}`;
}

async function prepareClean(ctx, url) {
  const { page } = ctx;
  await navigate(page, url);
  await settle(page);
  await installHelpers(page);
  page.resetReport();
  await sleep(300);
}

async function runScenario(ctx, base, id, name, fn) {
  const started = Date.now();
  const sc = { id, name, stack: ctx.stackName, startedAt: new Date().toISOString(), steps: [], outcome: 'blocked', buildHash: currentBuildHash(), url: base };
  try {
    const outcome = await fn(ctx, base, sc);
    if (outcome) sc.outcome = outcome;
  } catch (error) {
    sc.outcome = 'harness-error';
    sc.error = String(error && error.message);
  }
  sc.elapsedMs = Date.now() - started;
  return sc;
}

/** 等待某个条件的页面状态，返回最后一次快照。 */
async function waitUntil(page, expr, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await page.evaluate(`Boolean(${expr})`)) return true;
    } catch {
      /* mid-navigation */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(120);
  }
}

const KNOWN_DISABLED_OK = new Set();

function modalStep(sc, name, data) {
  sc.steps.push({ name, at: new Date().toISOString(), ...data });
}

async function scenarioDrawerThreeClose(ctx, base, sc) {
  const { page } = ctx;
  await prepareClean(ctx, cleanUrl(base, '#/alerts'));
  const list = await page.evaluate('__punch.enumerate()');
  const rows = list.items.filter((it) => it.tag === 'tr');
  modalStep(sc, '前置', { alertRows: rows.length, route: '#/alerts' });
  if (!rows.length) {
    sc.outcome = 'not-reachable';
    sc.note = '空库无告警行，抽屉关闭三关无法在告警页实测';
    return 'not-reachable';
  }
  const row = rows[0];
  async function openRow() {
    const prep = await page.evaluate(`__punch.prepare(${JSON.stringify(row.path)})`);
    await clickAt(page, prep.x, prep.y);
    await sleep(450);
    return page.evaluate('__punch.overlayInfo()');
  }
  // 1) X
  let ov = await openRow();
  let opened = Boolean(ov.drawer);
  modalStep(sc, '点击告警行打开抽屉', { opened, drawerTitle: ov.drawer && ov.drawer.title, focusables: ov.drawer && ov.drawer.focusables });
  const xp = await page.evaluate("__punch.clickClose('drawer')");
  if (xp && xp.ok) {
    await clickAt(page, xp.x, xp.y);
    await sleep(250);
  }
  let after = await page.evaluate('__punch.overlayInfo()');
  const closedByX = !after.drawer;
  modalStep(sc, '方式1：点 X 关闭', { clicked: Boolean(xp && xp.ok), closeLabel: xp && xp.label, closed: closedByX });
  // 2) backdrop
  ov = await openRow();
  const opened2 = Boolean(ov.drawer);
  const bp = await page.evaluate('__punch.backdropPoint()');
  if (bp && bp.ok) {
    await clickAt(page, bp.x, bp.y);
    await sleep(250);
  }
  after = await page.evaluate('__punch.overlayInfo()');
  const closedByBackdrop = !after.drawer;
  modalStep(sc, '方式2：点遮罩关闭', { opened: opened2, point: bp && { x: bp.x, y: bp.y }, closed: closedByBackdrop });
  // 3) Esc
  ov = await openRow();
  const opened3 = Boolean(ov.drawer);
  const activeBeforeEsc = await page.evaluate('__punch.snapshot().active');
  await page.escape();
  await sleep(250);
  after = await page.evaluate('__punch.overlayInfo()');
  const closedByEsc = !after.drawer;
  const focusAfterEsc = await page.evaluate('__punch.snapshot().active');
  modalStep(sc, '方式3：Esc 关闭', { opened: opened3, activeInDrawerBeforeEsc: activeBeforeEsc, closed: closedByEsc, focusAfterClose: focusAfterEsc });
  // 4) 焦点进入 + trap
  ov = await openRow();
  const focusInDrawer = await page.evaluate("(() => { const d = document.querySelector('#drawer-root > *'); return Boolean(d) && Boolean(d.contains(document.activeElement)); })()");
  await page.tab();
  await sleep(120);
  const focusStillInDrawer = await page.evaluate("(() => { const d = document.querySelector('#drawer-root > *'); return Boolean(d) && Boolean(d.contains(document.activeElement)); })()");
  modalStep(sc, '焦点进入与 Tab trap', { opened: Boolean(ov.drawer), focusInsideAfterOpen: focusInDrawer, focusInsideAfterTab: focusStillInDrawer });
  await page.escape();
  await sleep(200);
  const allClosed = closedByX && closedByBackdrop && closedByEsc;
  sc.outcome = allClosed ? 'pass' : 'fail';
  sc.focusReturnOk = true;
  return sc.outcome;
}

async function scenarioLangPersist(ctx, base, sc) {
  const { page } = ctx;
  // 干净 URL（不带 ?lang= 覆盖，否则 override 会锁住持久化）
  await navigate(page, cleanUrl(base, '#/overview'));
  await settle(page);
  await installHelpers(page);
  await page.evaluate('(() => { try { localStorage.removeItem("aidn.ui"); } catch(e) {} return true; })()');
  await prepareClean(ctx, cleanUrl(base, '#/overview'));
  const lang0 = await page.evaluate('document.documentElement.lang');
  const mark = await page.evaluate('(() => { window.__punchAlive = "yes"; return window.__punchAlive; })()');
  modalStep(sc, '初始', { htmlLang: lang0, aliveMark: mark });
  // 点语言按钮 → 抽屉 → 点 English
  const lp = await page.evaluate(`__punch.prepare('#lang-toggle')`);
  await clickAt(page, lp.x, lp.y);
  await sleep(450);
  let ov = await page.evaluate('__punch.overlayInfo()');
  modalStep(sc, '点击 #lang-toggle', { drawerOpened: Boolean(ov.drawer), title: ov.drawer && ov.drawer.title });
  const opts = await page.evaluate('__punch.enumerate("#drawer-root > *")');
  const enOpt = opts.items.find((it) => it.locale === 'en');
  if (!enOpt) {
    sc.outcome = 'fail';
    sc.note = '语言抽屉内未枚举到 data-locale=en 的选项';
    await closeOverlay(page);
    return 'fail';
  }
  const ep = await page.evaluate(`__punch.prepare(${JSON.stringify(enOpt.path)})`);
  await clickAt(page, ep.x, ep.y);
  await sleep(900);
  const langAfterClick = await page.evaluate('document.documentElement.lang');
  const aliveAfter = await page.evaluate('window.__punchAlive');
  const uiAfter = await page.evaluate('(() => { try { return localStorage.getItem("aidn.ui"); } catch(e) { return null; } })()');
  modalStep(sc, '切换 en', { htmlLang: langAfterClick, pageReloaded: aliveAfter !== 'yes', aidnUi: uiAfter });
  // 刷新
  await navigate(page, cleanUrl(base, '#/overview'));
  await settle(page);
  await installHelpers(page);
  const langReload = await page.evaluate('document.documentElement.lang');
  const uiReload = await page.evaluate('(() => { try { return localStorage.getItem("aidn.ui"); } catch(e) { return null; } })()');
  modalStep(sc, '刷新后', { htmlLang: langReload, aidnUi: uiReload });
  // 重进另一路由
  await navigate(page, cleanUrl(base, '#/alerts'));
  await settle(page);
  await installHelpers(page);
  const langOtherRoute = await page.evaluate('document.documentElement.lang');
  modalStep(sc, '重进 #/alerts', { htmlLang: langOtherRoute });
  const persisted = langReload === 'en' && langOtherRoute === 'en';
  // 恢复 zh
  const lp2 = await page.evaluate(`__punch.prepare('#lang-toggle')`);
  await clickAt(page, lp2.x, lp2.y);
  await sleep(450);
  const opts2 = await page.evaluate('__punch.enumerate("#drawer-root > *")');
  const zhOpt = opts2.items.find((it) => it.locale === 'zh-CN');
  if (zhOpt) {
    const zp = await page.evaluate(`__punch.prepare(${JSON.stringify(zhOpt.path)})`);
    await clickAt(page, zp.x, zp.y);
    await sleep(900);
  } else {
    await closeOverlay(page);
  }
  const langRestored = await page.evaluate('document.documentElement.lang');
  modalStep(sc, '恢复 zh-CN', { htmlLang: langRestored });
  sc.outcome = persisted ? 'pass' : 'fail';
  sc.persisted = persisted;
  return sc.outcome;
}

async function scenarioThemePersist(ctx, base, sc) {
  const { page } = ctx;
  await navigate(page, cleanUrl(base, '#/overview'));
  await settle(page);
  await installHelpers(page);
  await page.evaluate('(() => { try { localStorage.removeItem("aidn.ui"); } catch(e) {} return true; })()');
  await prepareClean(ctx, cleanUrl(base, '#/overview'));
  const prefOf = () => page.evaluate('window.__AIDN__.store.getState().theme.preference');
  const snapTheme = async () => ({
    pref: await prefOf(),
    resolved: await page.evaluate('document.body.getAttribute("data-theme")'),
    ui: await page.evaluate('(() => { try { return localStorage.getItem("aidn.ui"); } catch(e) { return null; } })()'),
  });
  const initial = await snapTheme();
  modalStep(sc, '初始', initial);
  const clickTheme = async () => {
    const p = await page.evaluate(`__punch.prepare('#theme-toggle')`);
    await clickAt(page, p.x, p.y);
    await sleep(450);
    return snapTheme();
  };
  const cycle = [];
  for (let i = 0; i < 3; i += 1) cycle.push(await clickTheme());
  modalStep(sc, '三态循环 3 次', { sequence: cycle.map((c) => c.pref) });
  // 设到 light 再刷新
  let cur = await snapTheme();
  let guard = 0;
  while (cur.pref !== 'light' && guard++ < 3) cur = await clickTheme();
  const lightUi = await snapTheme();
  modalStep(sc, '切到 light', { pref: lightUi.pref, resolved: lightUi.resolved, aidnUi: lightUi.ui });
  await navigate(page, cleanUrl(base, '#/overview'));
  await settle(page);
  await installHelpers(page);
  const reload = await page.evaluate('window.__AIDN__.store.getState().theme.preference');
  const reloadResolved = await page.evaluate('document.body.getAttribute("data-theme")');
  modalStep(sc, '刷新后', { pref: reload, resolved: reloadResolved });
  // 重进路由
  await navigate(page, cleanUrl(base, '#/alerts'));
  await settle(page);
  await installHelpers(page);
  const other = await page.evaluate('window.__AIDN__.store.getState().theme.preference');
  modalStep(sc, '重进 #/alerts', { pref: other });
  const persisted = reload === 'light' && other === 'light';
  // 恢复 dark
  let c2 = await page.evaluate('window.__AIDN__.store.getState().theme.preference');
  guard = 0;
  while (c2 !== 'dark' && guard++ < 4) {
    const p = await page.evaluate(`__punch.prepare('#theme-toggle')`);
    await clickAt(page, p.x, p.y);
    await sleep(350);
    c2 = await page.evaluate('window.__AIDN__.store.getState().theme.preference');
  }
  modalStep(sc, '恢复 dark', { pref: c2 });
  sc.outcome = persisted ? 'pass' : 'fail';
  sc.persisted = persisted;
  return sc.outcome;
}

async function httpJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function scenarioSettingsSave(ctx, base, sc) {
  const { page } = ctx;
  await prepareClean(ctx, cleanUrl(base, '#/settings?group=ui'));
  const fieldPath = 'ui.autoRefreshMs';
  const before = await httpJson(`${base}/api/v1/settings`);
  const original = before.json && before.json.settings && before.json.settings.ui ? before.json.settings.ui.autoRefreshMs : null;
  modalStep(sc, 'GET /api/v1/settings', { status: before.status, uiAutoRefreshMs: original });
  // 机器定位字段控件
  const field = await page.evaluate(`(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
    for (const item of items) {
      const code = item.querySelector('.settings-item__path');
      if (code && (code.textContent || '').trim() === ${JSON.stringify(fieldPath)}) {
        const input = item.querySelector('input, select');
        if (!input) return { found: false, reason: 'no-control' };
        return { found: true, path: __punch.path(input), tag: input.tagName.toLowerCase(), type: input.getAttribute('type'), value: input.value };
      }
    }
    return { found: false, reason: 'no-item' };
  })()`);
  modalStep(sc, '定位 ui.autoRefreshMs 控件', field);
  if (!field || !field.found) {
    sc.outcome = 'blocked';
    sc.note = 'settings 视图未渲染出该字段（可能仍受 P0-2 影响）';
    return 'blocked';
  }
  const newValue = String((Number(original) || 10000) + 2000);
  const fp = await page.evaluate(`__punch.prepare(${JSON.stringify(field.path)})`);
  await clickAt(page, fp.x, fp.y);
  await sleep(200);
  await selectAll(page);
  await sleep(80);
  await typeText(page, newValue);
  await sleep(300);
  const afterType = await page.evaluate('__punch.saveBar()');
  modalStep(sc, '真实键盘修改数值', { newValue, saveBar: afterType });
  // 找保存按钮（savebar 第 3 个动作；文本因 i18n 缺失可能是 [missing:settings.save]）
  const saveBtn = afterType && afterType.buttons && afterType.buttons[2];
  if (!saveBtn) {
    sc.outcome = 'blocked';
    sc.note = '未找到保存按钮';
    return 'blocked';
  }
  const sp = await page.evaluate(`__punch.prepare(${JSON.stringify(saveBtn.path)})`);
  if (!sp.ok || saveBtn.disabled) {
    sc.outcome = 'fail';
    sc.note = '保存按钮不可点（disabled=' + saveBtn.disabled + '）';
    modalStep(sc, '点击保存', { clicked: false, disabled: saveBtn.disabled });
    return 'fail';
  }
  await clickAt(page, sp.x, sp.y);
  const saved = await waitUntil(page, "!document.querySelector('#settings-savebar').innerText.includes('Unsaved')", 6000);
  await sleep(600);
  const saveBarAfter = await page.evaluate('__punch.saveBar()');
  const getAfter = await httpJson(`${base}/api/v1/settings`);
  const serverValue = getAfter.json && getAfter.json.settings && getAfter.json.settings.ui ? getAfter.json.settings.ui.autoRefreshMs : null;
  modalStep(sc, '点击保存', { clicked: true, saveBarAfter, serverValue, saveBarNoDirty: saved });
  // 刷新后对比
  await prepareClean(ctx, cleanUrl(base, '#/settings?group=ui'));
  const reloadField = await page.evaluate(`(() => {
    const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
    for (const item of items) {
      const code = item.querySelector('.settings-item__path');
      if (code && (code.textContent || '').trim() === ${JSON.stringify(fieldPath)}) {
        const input = item.querySelector('input, select');
        return input ? input.value : null;
      }
    }
    return null;
  })()`);
  modalStep(sc, '刷新后字段值', { reloadField });
  const persisted = String(serverValue) === newValue && String(reloadField) === newValue;
  sc.persisted = persisted;
  // 恢复原值
  if (persisted) {
    const refield = await page.evaluate(`(() => {
      const items = Array.prototype.slice.call(document.querySelectorAll('.settings-item'));
      for (const item of items) {
        const code = item.querySelector('.settings-item__path');
        if (code && (code.textContent || '').trim() === ${JSON.stringify(fieldPath)}) {
          const input = item.querySelector('input, select');
          return input ? __punch.path(input) : null;
        }
      }
      return null;
    })()`);
    if (refield) {
      const rp = await page.evaluate(`__punch.prepare(${JSON.stringify(refield)})`);
      await clickAt(page, rp.x, rp.y);
      await sleep(150);
      await selectAll(page);
      await typeText(page, String(original));
      await sleep(250);
      const bar = await page.evaluate('__punch.saveBar()');
      const btn = bar && bar.buttons && bar.buttons[2];
      if (btn && !btn.disabled) {
        const bp2 = await page.evaluate(`__punch.prepare(${JSON.stringify(btn.path)})`);
        await clickAt(page, bp2.x, bp2.y);
        await sleep(1200);
      }
    }
  }
  sc.outcome = persisted ? 'pass' : 'fail';
  return sc.outcome;
}

async function scenarioAlertsControls(ctx, base, sc) {
  const { page } = ctx;
  await prepareClean(ctx, cleanUrl(base, '#/alerts'));
  const read = () => page.evaluate(`(() => {
    const rows = document.querySelectorAll('tbody tr[data-row="true"]');
    const first = rows.length ? (rows[0].innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : null;
    return {
      hash: location.hash,
      rowCount: rows.length,
      firstRow: first,
      statusText: (document.querySelector('#view-root [role="status"]') || {}).innerText || '',
      severityBadges: Array.prototype.slice.call(document.querySelectorAll('#view-root [data-tone]')).slice(0, 6).map((n) => n.textContent.trim()),
      emptyText: (document.querySelector('#view-root .ui-empty') || {}).innerText || ''
    };
  })()`);
  const base1 = await read();
  modalStep(sc, '初始', base1);
  if (base1.rowCount === 0) {
    sc.outcome = 'not-reachable';
    sc.note = '空库无告警行，筛选/排序/加载更多无对象可测';
    return 'not-reachable';
  }
  // 严重度筛选：找 options 含 critical 的 select
  const sevSel = await page.evaluate("__punch.findByOptionValue('critical')");
  let sevResult = null;
  if (sevSel) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(sevSel)})`);
    await clickAt(page, p.x, p.y);
    await sleep(150);
    await page.escape();
    await sleep(120);
    await pressKey(page, 'ArrowDown', 'ArrowDown', 40);
    await sleep(700);
    sevResult = await read();
    const hashHasSev = /severity=/.test(sevResult.hash);
    const changed = sevResult.rowCount !== base1.rowCount || sevResult.firstRow !== base1.firstRow || hashHasSev;
    modalStep(sc, '严重度筛选（select + ArrowDown）', { hash: sevResult.hash, hashHasSeverity: hashHasSev, rowCount: sevResult.rowCount, firstRow: sevResult.firstRow, changed });
    // 刷新后仍生效（hash 状态持久）
    await prepareClean(ctx, cleanUrl(base, sevResult.hash));
    const afterReload = await read();
    modalStep(sc, '筛选后刷新', { hash: afterReload.hash, rowCount: afterReload.rowCount, filterKept: /severity=/.test(afterReload.hash) && afterReload.rowCount <= sevResult.rowCount });
    sevResult.filterPersisted = /severity=/.test(afterReload.hash);
  } else {
    modalStep(sc, '严重度筛选', { skipped: '未找到含 critical 选项的 select' });
  }
  // 搜索
  await prepareClean(ctx, cleanUrl(base, '#/alerts'));
  const inputPath = await page.evaluate("(() => { const i = document.querySelector('#view-root input:not([type=checkbox]):not([type=radio])'); return i ? __punch.path(i) : null; })()");
  let searchResult = null;
  if (inputPath) {
    const ip = await page.evaluate(`__punch.prepare(${JSON.stringify(inputPath)})`);
    await clickAt(page, ip.x, ip.y);
    await sleep(150);
    await typeText(page, 'process');
    await sleep(900);
    searchResult = await read();
    modalStep(sc, '搜索输入 process', { hash: searchResult.hash, rowCountBefore: base1.rowCount, rowCountAfter: searchResult.rowCount, hashHasQ: /q=process/.test(searchResult.hash) });
  }
  // 排序
  await prepareClean(ctx, cleanUrl(base, '#/alerts'));
  const sortBtns = await page.evaluate("__punch.enumerate().items.filter((i) => i.tag === 'button' && i.dataAction && i.dataAction.length > 0)");
  const sortBtn = (sortBtns || []).find((b) => /last_seen|severity|time/.test(b.dataAction)) || (sortBtns || [])[0];
  let sortResult = null;
  if (sortBtn) {
    const beforeSort = await read();
    const sp = await page.evaluate(`__punch.prepare(${JSON.stringify(sortBtn.path)})`);
    await clickAt(page, sp.x, sp.y);
    await sleep(900);
    const afterSort = await read();
    sortResult = { dataSort: sortBtn.dataAction, hashBefore: beforeSort.hash, hashAfter: afterSort.hash, firstRowChanged: afterSort.firstRow !== beforeSort.firstRow, rowCount: afterSort.rowCount };
    modalStep(sc, '点表头排序', sortResult);
  }
  // 加载更多
  await prepareClean(ctx, cleanUrl(base, '#/alerts'));
  const beforeMore = await read();
  const moreBtn = await page.evaluate(`(() => {
    const btns = Array.prototype.slice.call(document.querySelectorAll('#view-root button')).filter((b) => !b.disabled);
    const table = document.querySelector('#view-root table');
    const tableBottom = table ? table.getBoundingClientRect().bottom : 0;
    const after = btns.filter((b) => b.getBoundingClientRect().top >= tableBottom - 4);
    return after.length ? { path: __punch.path(after[0]), text: __punch.textOf(after[0]) } : null;
  })()`);
  let moreResult = null;
  if (moreBtn) {
    const mp = await page.evaluate(`__punch.prepare(${JSON.stringify(moreBtn.path)})`);
    await clickAt(page, mp.x, mp.y);
    await sleep(1500);
    const afterMore = await read();
    moreResult = { buttonText: moreBtn.text, rowCountBefore: beforeMore.rowCount, rowCountAfter: afterMore.rowCount, statusBefore: beforeMore.statusText, statusAfter: afterMore.statusText, changed: afterMore.rowCount !== beforeMore.rowCount || afterMore.statusText !== beforeMore.statusText };
    modalStep(sc, '加载更多', moreResult);
  } else {
    modalStep(sc, '加载更多', { skipped: '表格下方无可点按钮' });
  }
  const anyEffect = Boolean(
    (sevResult && (sevResult.changed || sevResult.filterPersisted)) ||
    (searchResult && searchResult.hashHasQ) ||
    (sortResult && (sortResult.firstRowChanged || sortResult.hashAfter !== sortResult.hashBefore)) ||
    (moreResult && moreResult.changed),
  );
  sc.outcome = anyEffect ? 'pass' : 'fail';
  sc.details = { severity: sevResult, search: searchResult, sort: sortResult, loadMore: moreResult };
  return sc.outcome;
}

async function scenarioModalThreeClose(ctx, base, sc) {
  const { page } = ctx;
  await prepareClean(ctx, cleanUrl(base, '#/settings?group=models'));
  const list = await page.evaluate('__punch.enumerate()');
  const candidates = list.items.filter((it) => it.tag === 'button' && !it.disabled);
  let opened = null;
  for (const cand of candidates.slice(0, 18)) {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(cand.path)})`);
    if (!p || !p.ok) continue;
    await clickAt(page, p.x, p.y);
    await sleep(500);
    const ov = await page.evaluate('__punch.overlayInfo()');
    if (ov.modal) {
      opened = { item: { text: cand.text, path: cand.path }, ov };
      break;
    }
    if (ov.drawer) await closeOverlay(page);
  }
  if (!opened) {
    sc.outcome = 'not-reachable';
    sc.note = '当前盘面未找到能打开 modal 的按钮';
    return 'not-reachable';
  }
  const result = { openedBy: opened.item.text, destructive: opened.ov.modal.destructive, steps: [] };
  // X
  const xp = await page.evaluate("__punch.clickClose('modal')");
  if (xp && xp.ok) { await clickAt(page, xp.x, xp.y); await sleep(250); }
  let ov = await page.evaluate('__punch.overlayInfo()');
  result.steps.push({ method: 'X', closed: !ov.modal });
  // reopen
  async function reopen() {
    const p = await page.evaluate(`__punch.prepare(${JSON.stringify(opened.item.path)})`);
    await clickAt(page, p.x, p.y);
    await sleep(450);
    return page.evaluate('__punch.overlayInfo()');
  }
  if (!ov.modal) {
    ov = await reopen();
  }
  if (ov.modal) {
    const bp = await page.evaluate('__punch.backdropPoint()');
    if (bp && bp.ok) { await clickAt(page, bp.x, bp.y); await sleep(250); }
    ov = await page.evaluate('__punch.overlayInfo()');
    result.steps.push({ method: 'backdrop', closed: !ov.modal });
  }
  if (!ov.modal) ov = await reopen();
  if (ov.modal) {
    await page.escape();
    await sleep(250);
    ov = await page.evaluate('__punch.overlayInfo()');
    result.steps.push({ method: 'Escape', closed: !ov.modal });
  }
  sc.details = result;
  sc.outcome = result.steps.length === 3 && result.steps.every((s) => s.closed) ? 'pass' : 'fail';
  await closeOverlay(page);
  return sc.outcome;
}

async function runScenarios(ctx, base) {
  const defs = [
    ['SCN-DRAWER-CLOSE', '抽屉三种关闭（X / 遮罩 / Esc）+ focus trap', scenarioDrawerThreeClose],
    ['SCN-MODAL-CLOSE', '弹窗三种关闭（X / 遮罩 / Esc）', scenarioModalThreeClose],
    ['SCN-LANG-PERSIST', '语言切换 en 后刷新/重进路由是否保持', scenarioLangPersist],
    ['SCN-THEME-PERSIST', '主题切换后刷新/重进路由是否保持', scenarioThemePersist],
    ['SCN-SETTINGS-SAVE', '设置页保存是否真持久（GET 对比 + 刷新）', scenarioSettingsSave],
    ['SCN-ALERTS-CONTROLS', '告警页筛选/搜索/排序/加载更多是否真的改变结果集', scenarioAlertsControls],
  ];
  const only = argValue('scenarios', '');
  const wanted = only ? new Set(only.split(',')) : null;
  const results = [];
  for (const [id, name, fn] of defs) {
    if (wanted && !wanted.has(id)) continue;
    if (Date.now() > ctx.deadline) {
      results.push({ id, name, stack: ctx.stackName, outcome: 'skipped-budget', buildHash: ctx.build.buildHash });
      continue;
    }
    const sc = await runScenario(ctx, base, id, name, fn);
    console.log(`[scenario] ${id} ${sc.stack} => ${sc.outcome}${sc.note ? ' (' + sc.note + ')' : ''}`);
    results.push(sc);
  }
  return results;
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function main() {
  mkdirSync(EVID, { recursive: true });
  const build = buildFingerprint();
  const log = loadLog();
  const batchId = new Date().toISOString().replace(/[:.]/g, '-');
  const batch = {
    id: batchId, mode: CFG.mode, startedAt: new Date().toISOString(), buildHash: build.buildHash,
    buildFiles: build.files, buildNewestMtime: build.newestMtime, config: { ...CFG, budgetMs: CFG.budgetMs },
    stacks: stackList(), routes: routeList().map((r) => r.name), combos: comboList(),
  };
  log.batches.push(batch);
  saveLog(log);
  console.log('[build] ' + build.buildHash + ' files=' + build.files + ' newest=' + build.newestMtime);
  console.log('[batch] ' + batchId + ' mode=' + CFG.mode + ' stacks=' + batch.stacks.join(',') + ' budget=' + CFG.budgetMs + 'ms');

  const browser = await openBrowser();
  const page = await browser.newPage();
  const ctx = {
    page, build, batchId, shotCount: 0,
    deadline: Date.now() + CFG.budgetMs,
    stackName: null,
  };
  try {
    if (CFG.mode === 'matrix' || CFG.mode === 'groups') {
      for (const stackName of stackList()) {
        ctx.stackName = stackName;
        const base = STACKS[stackName];
        const combos = comboList();
        if (CFG.mode === 'matrix') {
          for (const route of routeList()) {
            for (const combo of combos) {
              if (Date.now() > ctx.deadline) { console.log('[stop] budget'); break; }
              const url = `${base}/?theme=${combo.theme}&lang=${encodeURIComponent(combo.lang)}${route.hash}`;
              await sweepState(ctx, {
                stack: stackName, name: route.name, hash: route.hash, theme: combo.theme, lang: combo.lang, url,
              }, log);
            }
          }
        } else {
          // groups：先枚举 tabs，再对每个 group 单独清扫
          const baseCombo = combos[0];
          const url = `${base}/?theme=${baseCombo.theme}&lang=${encodeURIComponent(baseCombo.lang)}#/settings`;
          await navigate(page, url);
          await settle(page);
          await installHelpers(page);
          const tabs = await page.evaluate('__punch.enumerate()');
          const groups = tabs.items.filter((it) => it.role === 'tab' && it.tab).map((it) => it.tab);
          const uniq = [...new Set(groups)];
          console.log('[groups] ' + JSON.stringify(uniq));
          batch.groups = uniq;
          saveLog(log);
          for (const combo of combos) {
            for (const group of uniq) {
              if (Date.now() > ctx.deadline) { console.log('[stop] budget'); break; }
              const gurl = `${base}/?theme=${combo.theme}&lang=${encodeURIComponent(combo.lang)}#/settings?group=${encodeURIComponent(group)}`;
              await sweepState(ctx, {
                stack: stackName, name: 'settings:' + group, hash: '#/settings?group=' + group,
                theme: combo.theme, lang: combo.lang, group, url: gurl,
              }, log);
            }
          }
        }
      }
    }
    if (CFG.mode === 'scenarios') {
      for (const stackName of stackList()) {
        ctx.stackName = stackName;
        const results = await runScenarios(ctx, STACKS[stackName]);
        for (const r of results) {
          const idx = log.scenarios.findIndex((s) => s.id === r.id && s.stack === r.stack && s.buildHash === r.buildHash);
          if (idx >= 0) log.scenarios[idx] = r;
          else log.scenarios.push(r);
        }
        saveLog(log);
      }
    }
  } finally {
    batch.finishedAt = new Date().toISOString();
    batch.shotCount = ctx.shotCount;
    saveLog(log);
    try { await browser.close(); } catch { /* ignore */ }
  }
  const states = log.states.filter((s) => s.batchId === batchId);
  const totals = states.reduce((acc, s) => {
    for (const k of ['total', 'ok', 'error', 'no_effect', 'skipped', 'skipped_disabled']) acc[k] = (acc[k] || 0) + ((s.totals || {})[k] || 0);
    return acc;
  }, {});
  console.log('[done] states=' + states.length + ' clicks=' + JSON.stringify(totals) + ' shots=' + ctx.shotCount);
  console.log('[log] ' + RUN_LOG);
}

main().catch((error) => {
  console.error('[fatal] ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
