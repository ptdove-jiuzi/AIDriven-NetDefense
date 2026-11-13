/**
 * UI-POLISH T4 · 首启动引导（三步）回归用例
 * 作者：PT-dove
 *
 * 分两层：
 * - **DOM shim 层**（零依赖、必跑）：语义结构、三步真实文案、持久化、`?onboarding=1`、
 *   顶栏重看入口、折叠、不抢焦点、样式里没有 position/animation；
 * - **真实浏览器层**（Edge headless + CDP，Edge 不存在时 skip）：banner 确实在文档流里、
 *   与 `#view-root` 无重叠、`elementFromPoint` 命中导航（= 没被遮挡、可点）、
 *   无 dialog/backdrop/aria-modal、跳过写 localStorage、**真刷新**后不再出现、
 *   帮助按钮可键盘到达、离线/无模型/无告警时文案如实。
 *
 * 运行：`node --test tests/console-next/onboarding.test.js`
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ONBOARDING_BANNER_ID,
  ONBOARDING_BODY_ID,
  ONBOARDING_DONE_KEY,
  ONBOARDING_HELP_ID,
  ONBOARDING_ROOT_ID,
  ONBOARDING_STYLES_ID,
  createOnboarding,
  isOnboardingDone,
  isOnboardingForced,
  makeTranslator,
  persistOnboardingDone,
} from '../../apps/console-next/js/onboarding.js';
import { readUi, storageInfo, writeUi } from '../../apps/console-next/js/store.js';
import { cdpScreenshot, edgeAvailable, screenshot, withCdpPage } from './edge.mjs';
import { startConsoleAndDaemon } from './harness.mjs';
import { installDom, makeEvent, visibleText } from './dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence', 'ui-polish', 'onboarding');
const hasEdge = edgeAvailable();

const ROUTES = ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'];

/** 重置 store 里的引导标记（store 在 Node 里退化为进程内实现，用例之间互相隔离）。 */
function resetOnboardingDone(value = false) {
  writeUi({ [ONBOARDING_DONE_KEY]: value });
}

/**
 * 造一个与 index.html 等价的外壳骨架（topbar + nav + tools + 引导容器 + main），
 * 让 DOM shim 用例能断言"banner 不覆盖主界面 / 导航仍在"。
 */
function buildShell(dom) {
  const { document } = dom;
  const app = document.createElement('div');
  app.setAttribute('id', 'app');
  const header = document.createElement('header');
  header.setAttribute('class', 'topbar');
  const nav = document.createElement('nav');
  nav.setAttribute('id', 'nav');
  for (const route of ROUTES) {
    const link = document.createElement('a');
    link.setAttribute('data-route', route);
    link.setAttribute('href', `#/${route}`);
    link.textContent = route;
    nav.appendChild(link);
  }
  const tools = document.createElement('div');
  tools.setAttribute('class', 'topbar-tools');
  header.appendChild(nav);
  header.appendChild(tools);
  // 与 index.html 一致：引导容器在 </header> 与 <main> 之间（普通文档流）
  const onboardingRoot = document.createElement('div');
  onboardingRoot.setAttribute('id', ONBOARDING_ROOT_ID);
  onboardingRoot.setAttribute('hidden', '');
  const main = document.createElement('main');
  main.setAttribute('id', 'view-root');
  main.setAttribute('tabindex', '-1');
  main.textContent = 'overview content';
  app.appendChild(header);
  app.appendChild(onboardingRoot);
  app.appendChild(main);
  document.body.appendChild(app);
  return { app, header, nav, tools, main, onboardingRoot };
}

/** 满足三步探测的假 api（数据全是显式夹具，不连任何真实服务）。 */
function makeApi(overrides = {}) {
  return {
    getHealth: async () => ({ status: 'ok', version: '0.0.0-test' }),
    getModels: async () => ({
      providers: [{ id: 'local', enabled: true, hasCredential: true }],
      models: [{ id: 'local-chat', providerId: 'local' }],
    }),
    listAlerts: async () => ({ alerts: [{ id: 'a1', title: 'Suspicious powershell encoded command', severity: 'high' }], total: 5 }),
    ...overrides,
  };
}

async function settle(onboarding) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (onboarding.getState().phase === 'ready') return onboarding.getState();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('onboarding probe did not settle');
}

/** 用 DOM shim 起一个"首次打开"的引导，返回句柄与 DOM。 */
async function mountShim(t, options = {}) {
  const dom = installDom();
  t.after(() => dom.cleanup());
  const shell = buildShell(dom);
  resetOnboardingDone(options.done === true);
  const onboarding = createOnboarding({
    document: dom.document,
    window: dom.window,
    api: options.api ?? makeApi(),
    i18n: options.i18n ?? null,
    store: null,
    search: options.search ?? '',
  });
  t.after(() => onboarding.destroy());
  onboarding.mount();
  await settle(onboarding);
  return { dom, shell, onboarding };
}

function bannerOf(dom) {
  return dom.document.getElementById(ONBOARDING_BANNER_ID);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 1. DOM shim：结构 / 文案 / 不遮挡 / 不自动播放
// ---------------------------------------------------------------------------

test('首启动：出现页内 banner，三步文案齐全，语义结构 role=region + 有序列表 + aria-label', async (t) => {
  const { dom } = await mountShim(t);
  const banner = bannerOf(dom);
  assert.ok(banner, 'first run must show the onboarding banner');
  assert.equal(banner.getAttribute('role'), 'region');
  assert.ok((banner.getAttribute('aria-label') ?? '').length > 0, 'region needs an accessible name');
  assert.equal(banner.getAttribute('aria-modal'), null, 'the banner must never be modal');
  assert.equal(banner.getAttribute('id'), ONBOARDING_BANNER_ID);

  const list = banner.querySelector('ol');
  assert.ok(list, 'steps must be an ordered list');
  const steps = banner.querySelectorAll('li.onboarding-step');
  assert.equal(steps.length, 3);
  assert.deepEqual(steps.map((li) => li.getAttribute('data-step')), ['health', 'models', 'alerts']);

  const text = visibleText(banner);
  for (const needle of [
    'Confirm the daemon is online',
    'Configure a model',
    'Look at the first alert',
    'Connected · /healthz ok · version 0.0.0-test',
  ]) {
    assert.ok(text.includes(needle), `banner text must include ${JSON.stringify(needle)}; got: ${text.slice(0, 400)}`);
  }
  // 两个导航入口（配模型 / 看告警）
  assert.ok(banner.querySelector('[data-action="models"]'));
  assert.ok(banner.querySelector('[data-action="alerts"]'));
  // 每个按钮都有明确的可访问名
  for (const button of banner.querySelectorAll('button')) {
    const label = (button.getAttribute('aria-label') ?? '').trim();
    assert.ok(label.length > 0, `button without aria-label: ${button.textContent}`);
  }
});

test('首启动：不遮挡、不自动播放（无 dialog/backdrop/aria-modal、样式无 position/animation/keyframes）', async (t) => {
  const { dom, shell } = await mountShim(t);
  const banner = bannerOf(dom);
  const doc = dom.document;

  assert.equal(doc.querySelectorAll('[role="dialog"]').length, 0, 'no role=dialog may exist');
  assert.equal(doc.querySelectorAll('[aria-modal="true"]').length, 0, 'no aria-modal may exist');
  assert.equal(doc.querySelectorAll('.modal-backdrop').length, 0, 'no backdrop may exist');
  assert.equal(doc.querySelectorAll('dialog').length, 0);

  const styleSource = doc.getElementById(ONBOARDING_STYLES_ID)?.textContent ?? '';
  assert.ok(styleSource.length > 0, 'scoped stylesheet must be injected');
  for (const forbidden of ['position:', 'position :', '@keyframes', 'animation-name:', 'backdrop', 'z-index:', 'inset:']) {
    assert.equal(styleSource.includes(forbidden), false, `onboarding CSS must not contain ${forbidden}`);
  }
  assert.ok(styleSource.includes('animation: none'), 'banner must explicitly disable entry animation');

  // banner 只占普通布局：容器在 header 之后、main 之前（文档流顺序）
  const container = doc.getElementById(ONBOARDING_ROOT_ID);
  assert.ok(container, 'container div must exist (index.html or auto-created)');
  assert.equal(container.hidden, false);
  const order = [...shell.app.childNodes].filter((node) => node.nodeType === 1);
  assert.deepEqual(
    order.map((node) => node.localName === 'header' ? 'header' : node.localName === 'main' ? 'main' : node.getAttribute('id')),
    ['header', ONBOARDING_ROOT_ID, 'main'],
    'banner container must sit in normal flow between topbar and <main>',
  );
  // 主界面仍然在（没有被 replaceChildren 掉）
  assert.equal(shell.main.children.length > 0 || shell.main.textContent.length > 0, true);
  // banner 自身不带 autofocus / 不设 tabindex
  assert.equal(banner.hasAttribute('autofocus'), false);
  assert.equal(banner.hasAttribute('tabindex'), false);
});

test('首启动：不抢焦点（activeElement 仍是 body），也不是 live region', async (t) => {
  const { dom, onboarding } = await mountShim(t);
  assert.equal(onboarding.isVisible(), true);
  assert.equal(dom.document.activeElement, dom.document.body, 'mounting the banner must not move focus');
  assert.equal(bannerOf(dom).getAttribute('aria-live'), null, 'the banner is not a live region');
});

test('完成态来自真实数据：在线/已配模型/首条告警 → 三步都是 done', async (t) => {
  const { dom } = await mountShim(t);
  const banner = bannerOf(dom);
  const steps = banner.querySelectorAll('li.onboarding-step');
  assert.deepEqual(steps.map((li) => li.getAttribute('data-state')), ['done', 'done', 'done']);
  const text = visibleText(banner);
  assert.ok(text.includes('5 stored') || text.includes('First alert'), `first alert must come from real data: ${text}`);
  assert.ok(text.includes('high'), 'severity from the real alert row must be shown');
  assert.ok(text.includes('Suspicious powershell encoded command'));
});

test('完成态来自真实数据：模型有 key 但没登记模型 → 步骤 2 是 todo，不是 done', async (t) => {
  const { dom } = await mountShim(t, {
    api: makeApi({
      getModels: async () => ({ providers: [{ id: 'local', enabled: true, hasCredential: true }], models: [] }),
    }),
  });
  const steps = bannerOf(dom).querySelectorAll('li.onboarding-step');
  assert.equal(steps[1].getAttribute('data-state'), 'todo');
  assert.ok(visibleText(bannerOf(dom)).includes('no model is registered yet'));
});

test('无 healthz / 无模型 / 无告警：三步如实（不出现假数字、不冒充成功）', async (t) => {
  const { dom } = await mountShim(t, {
    api: {
      getHealth: async () => {
        throw new Error('ECONNREFUSED');
      },
      getModels: async () => {
        throw new Error('503');
      },
      listAlerts: async () => {
        throw new Error('404');
      },
    },
  });
  const banner = bannerOf(dom);
  const steps = banner.querySelectorAll('li.onboarding-step');
  assert.deepEqual(steps.map((li) => li.getAttribute('data-state')), ['todo', 'unknown', 'unknown']);
  const text = visibleText(banner);
  assert.ok(text.includes('Not connected — /healthz did not answer'), text);
  assert.ok(text.includes('Cannot read the model list right now'), text);
  assert.ok(text.includes('Alert data is unavailable right now'), text);
  // 不出现假数字/假成功
  assert.equal(/\d+\s*model\(s\) registered/u.test(text), false, 'must not claim registered models');
  assert.equal(text.includes('First alert'), false, 'must not invent an alert');
  assert.equal(text.includes('Connected ·'), false, 'must not claim connected');
});

test('空告警：如实写"还没有告警"，不编造条数', async (t) => {
  const { dom } = await mountShim(t, {
    api: makeApi({ listAlerts: async () => ({ alerts: [], total: 0 }) }),
  });
  const banner = bannerOf(dom);
  assert.equal(banner.querySelectorAll('li.onboarding-step')[2].getAttribute('data-state'), 'todo');
  const text = visibleText(banner);
  assert.ok(text.includes('No alerts yet'), text);
  assert.equal(text.includes('First alert'), false);
  assert.equal(/alert\(s\) stored/u.test(text), false);
});

// ---------------------------------------------------------------------------
// 2. 持久化 / 强制显示 / 重看入口
// ---------------------------------------------------------------------------

test('跳过：写 onboardingDone=true 并立刻消失；新实例（等价刷新）不再自动出现', async (t) => {
  const { dom, onboarding } = await mountShim(t);
  const skip = bannerOf(dom).querySelector('[data-action="skip"]');
  assert.ok(skip, 'skip button must exist');
  skip.dispatchEvent(makeEvent('click'));
  assert.equal(isOnboardingDone(), true, 'skip must persist aidn.ui.onboardingDone=true');
  assert.equal(bannerOf(dom), null, 'skip must remove the banner immediately');
  assert.equal(dom.document.getElementById(ONBOARDING_ROOT_ID).hidden, true);
  assert.equal(onboarding.isVisible(), false);

  // 等价于刷新：重新 mount 一个新实例（同 store / 同持久化）
  const second = createOnboarding({
    document: dom.document,
    window: dom.window,
    api: makeApi(),
    store: null,
    search: '',
  });
  t.after(() => second.destroy());
  second.mount();
  if (second.isVisible()) await settle(second);
  assert.equal(second.isVisible(), false, 'persisted done must suppress the banner on the next load');
  assert.equal(bannerOf(dom), null);
  // 但重看入口应该在（顶栏 i-info 按钮）
  assert.ok(dom.document.getElementById(ONBOARDING_HELP_ID), 'help entry must be available once the guide is hidden');
  onboarding.destroy();
});

test('?onboarding=1：强制显示（即使已标记完成），且跳过不写持久化', async (t) => {
  resetOnboardingDone(true);
  const dom = installDom();
  t.after(() => dom.cleanup());
  buildShell(dom);
  const writesBefore = storageInfo().writes.length;
  const onboarding = createOnboarding({
    document: dom.document,
    window: dom.window,
    api: makeApi(),
    store: null,
    search: '?onboarding=1',
  });
  t.after(() => onboarding.destroy());
  onboarding.mount();
  await settle(onboarding);
  assert.equal(onboarding.isVisible(), true, '?onboarding=1 must force the banner even when done=true');
  assert.equal(isOnboardingForced('?onboarding=1'), true);
  assert.equal(isOnboardingForced('?theme=dark&onboarding=1'), true);
  assert.equal(isOnboardingForced('?onboarding=0'), false);
  assert.equal(isOnboardingForced(''), false);

  bannerOf(dom).querySelector('[data-action="skip"]').dispatchEvent(makeEvent('click'));
  assert.equal(bannerOf(dom), null);
  assert.equal(storageInfo().writes.length, writesBefore, 'forced mode must not write localStorage');
  assert.equal(isOnboardingDone(), true, 'the previous flag must stay untouched (no erase, no rewrite)');
});

test('顶栏帮助按钮：跳过之后出现，点击重开；是原生 button 且有 aria-label', async (t) => {
  const { dom, shell, onboarding } = await mountShim(t);
  // 引导在场时不重复放"重看引导"入口（避免改变冻结的 topbar 三按钮结构）
  assert.equal(dom.document.getElementById(ONBOARDING_HELP_ID), null);
  bannerOf(dom).querySelector('[data-action="skip"]').dispatchEvent(makeEvent('click'));
  const help = dom.document.getElementById(ONBOARDING_HELP_ID);
  assert.ok(help, 'help button must appear after the guide is hidden');
  assert.equal(help.localName, 'button');
  assert.ok((help.getAttribute('aria-label') ?? '').includes('first-run guide'));
  assert.equal(help.parentNode, shell.tools, 'help button lives in .topbar-tools');
  help.dispatchEvent(makeEvent('click'));
  await settle(onboarding);
  assert.equal(onboarding.isVisible(), true, 'help button must reopen the guide');
  assert.ok(bannerOf(dom));
});

test('折叠：只隐藏步骤区，banner 仍在，aria-expanded 同步；再展开恢复', async (t) => {
  const { dom } = await mountShim(t);
  let toggle = bannerOf(dom).querySelector('[data-action="toggle"]');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.dispatchEvent(makeEvent('click'));
  const body = dom.document.getElementById(ONBOARDING_BODY_ID);
  assert.equal(body.hidden, true, 'collapsed body must be hidden');
  assert.ok(bannerOf(dom), 'banner itself stays (nothing auto-closes)');
  toggle = bannerOf(dom).querySelector('[data-action="toggle"]');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.dispatchEvent(makeEvent('click'));
  assert.equal(dom.document.getElementById(ONBOARDING_BODY_ID).hidden, false);
  assert.equal(bannerOf(dom).querySelector('[data-action="toggle"]').getAttribute('aria-expanded'), 'true');
});

// ---------------------------------------------------------------------------
// 3. store 契约（只多一个布尔键，敏感键仍被拒）
// ---------------------------------------------------------------------------

test('store：aidn.ui 只多了 onboardingDone 布尔键，字符串键行为不变，布尔/字符串不会互相污染', () => {
  resetOnboardingDone(false);
  assert.equal(writeUi({ theme: 'dark', density: 'compact', locale: 'en', startView: 'alerts' }), true);
  assert.equal(writeUi({ [ONBOARDING_DONE_KEY]: true }), true);
  const ui = readUi();
  assert.deepEqual(ui, { theme: 'dark', density: 'compact', locale: 'en', startView: 'alerts', onboardingDone: true });
  // 非布尔值不得写入（不把字符串 "true" 当成真）
  writeUi({ [ONBOARDING_DONE_KEY]: 'true' });
  assert.equal(readUi()[ONBOARDING_DONE_KEY], true, 'string values must be ignored, previous boolean kept');
  writeUi({ [ONBOARDING_DONE_KEY]: false });
  assert.equal(readUi()[ONBOARDING_DONE_KEY], false);
  assert.equal(persistOnboardingDone(), true);
  assert.equal(isOnboardingDone(), true);
  resetOnboardingDone(false);
});

test('双参兜底翻译：i18n 缺 key 用英文兜底，不产生 [missing:]；有 key 时用译文并支持占位符', () => {
  const missing = makeTranslator(null);
  assert.equal(missing('onboarding.title', 'Getting started'), 'Getting started');
  const broken = makeTranslator({ has: () => true, t: () => '[missing:onboarding.title]' });
  assert.equal(broken('onboarding.title', 'Getting started'), 'Getting started');
  const real = makeTranslator({ has: (key) => key === 'onboarding.title', t: () => '先做三步确认' });
  assert.equal(real('onboarding.title', 'Getting started'), '先做三步确认');
  assert.equal(real('x.y', 'port {port}', { port: 17512 }), 'port 17512');
});

// ---------------------------------------------------------------------------
// 4. 真实浏览器（一个 CDP 会话里做"加载 → 交互 → 真刷新"）
// ---------------------------------------------------------------------------

const PAGE_PATH = '/index.html?theme=dark&static=1&lang=en#/overview';
const FORCED_PAGE_PATH = '/index.html?theme=dark&static=1&lang=en&onboarding=1#/overview';
const READY_EXPRESSION = "(() => { const b = document.querySelector('#onboarding-banner'); return Boolean(b) && b.dataset.phase === 'ready'; })()";
const BOOTED_EXPRESSION = "(() => { const root = document.querySelector('#view-root'); return Boolean(root) && root.children.length > 0; })()";

/**
 * 跑一个共享 CDP 会话：`fn(env, page)`。
 * `page` 提供 navigate / evaluate（均不超过单次 8s 的 CDP 超时）。
 */
async function runPage(t, fn) {
  const env = await startConsoleAndDaemon(t);
  const result = await withCdpPage({ width: 1440, height: 1000, timeoutMs: 60000 }, (page) => fn(env, page));
  if (result && result.ok === false && typeof result.reason === 'string') {
    throw new Error(`CDP session failed: ${result.reason}`);
  }
  return result;
}

const NOT_COVERING_SNAPSHOT = `(() => {
  const banner = document.querySelector('#onboarding-banner');
  const root = document.querySelector('#view-root');
  const nav = document.querySelector('#nav a[data-route="alerts"]');
  const rootRect = root ? root.getBoundingClientRect() : null;
  const bannerRect = banner ? banner.getBoundingClientRect() : null;
  const navRect = nav ? nav.getBoundingClientRect() : null;
  const hit = navRect && navRect.width > 0
    ? document.elementFromPoint(navRect.left + navRect.width / 2, navRect.top + navRect.height / 2)
    : null;
  const descendants = banner ? [...banner.querySelectorAll('*')].map((node) => getComputedStyle(node).position) : [];
  return {
    banner: Boolean(banner),
    role: banner ? banner.getAttribute('role') : null,
    ariaLabel: banner ? banner.getAttribute('aria-label') : null,
    steps: banner ? banner.querySelectorAll('li.onboarding-step').length : 0,
    orderList: banner ? (banner.querySelector('ol') ? banner.querySelector('ol').tagName : null) : null,
    modals: document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal-backdrop, dialog').length,
    modalRootChildren: document.querySelector('#modal-root') ? document.querySelector('#modal-root').children.length : 0,
    bannerPosition: banner ? getComputedStyle(banner).position : null,
    rootPosition: root ? getComputedStyle(root).position : null,
    bannerAnimation: banner ? getComputedStyle(banner).animationName : null,
    descendantsFixed: descendants.filter((value) => value === 'fixed' || value === 'absolute').length,
    overlap: bannerRect && rootRect ? bannerRect.bottom > rootRect.top + 1 : null,
    bannerHeight: bannerRect ? Math.round(bannerRect.height) : 0,
    viewRootTop: rootRect ? Math.round(rootRect.top) : -1,
    navRect: navRect ? { left: Math.round(navRect.left), top: Math.round(navRect.top), width: Math.round(navRect.width), height: Math.round(navRect.height) } : null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    viewRootHasContent: root ? root.children.length > 0 : false,
    navHit: hit ? (hit.closest('a[data-route]') ? hit.closest('a[data-route]').getAttribute('data-route') : hit.tagName) : null,
    activeInsideBanner: banner ? banner.contains(document.activeElement) : null,
    activeTag: document.activeElement ? document.activeElement.tagName : null,
    activeId: document.activeElement ? document.activeElement.id : '',
    bodyOverflow: getComputedStyle(document.body).overflow,
    scrollY: window.scrollY,
    navLinks: document.querySelectorAll('#nav a[data-route]').length,
    helpButton: Boolean(document.getElementById('onboarding-help')),
  };
})()`;

const STORAGE_UI_EXPRESSION = `(() => { try { return JSON.parse(localStorage.getItem('aidn.ui') || '{}'); } catch (error) { return null; } })()`;

test('真实浏览器：banner 在文档流里（position static / 与 #view-root 无重叠 / 无 dialog），焦点不被抢', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const result = await runPage(t, async (env, page) => {
    const ready = await page.navigate(`${env.url}${PAGE_PATH}`, { waitExpression: READY_EXPRESSION, waitForTimeoutMs: 15000 });
    const snapshot = await page.evaluate(NOT_COVERING_SNAPSHOT);
    return { ready, snapshot };
  });
  const { ready, snapshot } = result;
  assert.equal(ready, true, 'banner never reached the ready state');
  assert.equal(snapshot.banner, true);
  assert.equal(snapshot.role, 'region');
  assert.ok((snapshot.ariaLabel ?? '').length > 0);
  assert.equal(snapshot.steps, 3);
  assert.equal(snapshot.orderList, 'OL');
  assert.equal(snapshot.modals, 0, 'no dialog / backdrop / aria-modal on the page');
  assert.equal(snapshot.modalRootChildren, 0);
  assert.equal(snapshot.bannerPosition, 'static', 'banner must stay in normal document flow');
  assert.equal(snapshot.rootPosition, 'static');
  assert.equal(snapshot.bannerAnimation, 'none', 'no entry animation');
  assert.equal(snapshot.descendantsFixed, 0, 'no fixed/absolute descendants (nothing overlays the console)');
  assert.equal(snapshot.overlap, false, 'banner must not overlap #view-root');
  assert.equal(snapshot.viewRootHasContent, true, 'main view must still be rendered');
  assert.equal(snapshot.navHit, 'alerts', `the nav link must be topmost at its own center (not covered); navRect=${JSON.stringify(snapshot.navRect)} viewport=${JSON.stringify(snapshot.viewport)}`);
  assert.equal(snapshot.activeInsideBanner, false, 'focus must not be stolen by the banner');
  assert.ok(['BODY', 'MAIN'].includes(snapshot.activeTag), `activeElement should stay outside the banner, got ${snapshot.activeTag}#${snapshot.activeId}`);
  assert.equal(snapshot.bodyOverflow, 'visible', 'no scroll lock');
  assert.equal(snapshot.scrollY, 0, 'no auto-scroll');
  assert.equal(snapshot.navLinks, 6);
  assert.equal(snapshot.helpButton, false, 'no duplicate help entry while the guide is visible');
  t.diagnostic(`banner height=${snapshot.bannerHeight}px, view-root top=${snapshot.viewRootTop}px, active=${snapshot.activeTag}#${snapshot.activeId}`);
});

test('真实浏览器：引导在场时导航仍可直接点击（点「告警」真的会路由过去）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const result = await runPage(t, async (env, page) => {
    const ready = await page.navigate(`${env.url}${PAGE_PATH}`, { waitExpression: READY_EXPRESSION, waitForTimeoutMs: 15000 });
    const clicked = await page.evaluate(`(async () => {
      const nav = document.querySelector('#nav a[data-route="alerts"]');
      if (!nav) return { clicked: false };
      nav.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        clicked: true,
        hash: location.hash,
        bannerStillThere: Boolean(document.querySelector('#onboarding-banner')),
        viewRootChildren: document.querySelector('#view-root') ? document.querySelector('#view-root').children.length : 0,
      };
    })()`);
    return { ready, clicked };
  });
  assert.equal(result.ready, true);
  assert.equal(result.clicked.clicked, true);
  assert.ok(result.clicked.hash.startsWith('#/alerts'), `clicking the nav while the banner is visible must navigate; got ${result.clicked.hash}`);
  assert.equal(result.clicked.bannerStillThere, true, 'the banner is not a modal: it stays in flow after navigation');
  assert.ok(result.clicked.viewRootChildren > 0, 'the alerts view must be mounted');
  t.diagnostic(`after nav click: hash=${result.clicked.hash}`);
});

test('真实浏览器：跳过 → localStorage 落 onboardingDone=true；真刷新后不再出现；帮助按钮可重开', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const result = await runPage(t, async (env, page) => {
    const url = `${env.url}${PAGE_PATH}`;
    const ready = await page.navigate(url, { waitExpression: READY_EXPRESSION, waitForTimeoutMs: 15000 });
    const skipped = await page.evaluate(`(() => {
      const skip = document.querySelector('#onboarding-banner [data-action="skip"]');
      if (!skip) return false;
      skip.click();
      return true;
    })()`);
    await sleep(300);
    const afterSkip = await page.evaluate(`(() => {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('aidn.ui') || '{}'); } catch (error) { stored = null; }
      const help = document.getElementById('onboarding-help');
      return {
        banner: Boolean(document.querySelector('#onboarding-banner')),
        stored,
        help: help ? {
          tag: help.tagName,
          tabIndex: help.tabIndex,
          ariaLabel: help.getAttribute('aria-label'),
          inTools: Boolean(help.closest('.topbar-tools')),
        } : null,
      };
    })()`);
    // 真刷新：同一个 Edge profile（localStorage 保留）
    const reloaded = await page.navigate(url, { waitExpression: BOOTED_EXPRESSION, waitForTimeoutMs: 15000 });
    await sleep(400);
    const afterReload = await page.evaluate(`(() => {
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('aidn.ui') || '{}'); } catch (error) { stored = null; }
      return {
        banner: Boolean(document.querySelector('#onboarding-banner')),
        help: Boolean(document.getElementById('onboarding-help')),
        viewRootChildren: document.querySelector('#view-root') ? document.querySelector('#view-root').children.length : 0,
        stored,
      };
    })()`);
    // 顶栏帮助按钮重开（原生 button：Enter/Space 即可触发）
    const helpClicked = await page.evaluate(`(() => {
      const help = document.getElementById('onboarding-help');
      if (!help) return false;
      help.click();
      return true;
    })()`);
    await sleep(500);
    const reopened = await page.evaluate(`(() => {
      const banner = document.querySelector('#onboarding-banner');
      return { visible: Boolean(banner), phase: banner ? banner.dataset.phase : null };
    })()`);
    return { ready, skipped, afterSkip, reloaded, afterReload, helpClicked, reopened };
  });

  assert.equal(result.ready, true, 'banner never reached the ready state');
  assert.equal(result.skipped, true);
  assert.equal(result.afterSkip.banner, false, 'skip must remove the banner');
  assert.equal(result.afterSkip.stored?.[ONBOARDING_DONE_KEY], true, 'skip must persist aidn.ui.onboardingDone=true');
  assert.ok(result.afterSkip.help, 'help button must appear after the guide is hidden');
  assert.equal(result.afterSkip.help.tag, 'BUTTON');
  assert.equal(result.afterSkip.help.tabIndex, 0, 'help button must be keyboard reachable (native button, tabIndex 0)');
  assert.ok((result.afterSkip.help.ariaLabel ?? '').length > 0);
  assert.equal(result.afterSkip.help.inTools, true);
  assert.equal(result.reloaded, true, 'the reloaded document must boot');
  assert.equal(result.afterReload.banner, false, 'a real reload with done=true must not show the guide');
  assert.equal(result.afterReload.help, true, 'the reloaded page exposes the help entry instead');
  assert.ok(result.afterReload.viewRootChildren > 0, 'main view must be mounted after reload');
  assert.equal(result.helpClicked, true);
  assert.equal(result.reopened.visible, true, 'clicking the help button must reopen the guide');
});

test('真实浏览器：?onboarding=1 强制显示，且跳过不改写持久化', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const result = await runPage(t, async (env, page) => {
    const url = `${env.url}${PAGE_PATH}`;
    const firstReady = await page.navigate(url, { waitExpression: READY_EXPRESSION, waitForTimeoutMs: 15000 });
    await page.evaluate(`(() => {
      const skip = document.querySelector('#onboarding-banner [data-action="skip"]');
      if (skip) skip.click();
      return true;
    })()`);
    await sleep(300);
    // 真刷新：已完成 → 不出现
    await page.navigate(url, { waitExpression: BOOTED_EXPRESSION, waitForTimeoutMs: 15000 });
    await sleep(300);
    const plain = await page.evaluate(`(() => ({
      banner: Boolean(document.querySelector('#onboarding-banner')),
      help: Boolean(document.getElementById('onboarding-help')),
    }))()`);
    // 真刷新 + ?onboarding=1：即使已完成也强制出现
    const forcedReady = await page.navigate(`${env.url}${FORCED_PAGE_PATH}`, { waitExpression: READY_EXPRESSION, waitForTimeoutMs: 15000 });
    const before = await page.evaluate(`localStorage.getItem('aidn.ui')`);
    const forced = await page.evaluate(`(async () => {
      const banner = document.querySelector('#onboarding-banner');
      const skip = banner ? banner.querySelector('[data-action="skip"]') : null;
      if (skip) skip.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        bannerWasThere: Boolean(banner),
        bannerAfterSkip: Boolean(document.querySelector('#onboarding-banner')),
        after: localStorage.getItem('aidn.ui'),
      };
    })()`);
    return { firstReady, plain, forcedReady, before, forced };
  });

  assert.equal(result.firstReady, true);
  assert.equal(result.plain.banner, false, 'done=true must hide the guide on a normal load');
  assert.equal(result.plain.help, true);
  assert.equal(result.forcedReady, true, '?onboarding=1 must force the guide even when done=true');
  assert.equal(result.forced.bannerWasThere, true);
  assert.equal(result.forced.bannerAfterSkip, false, 'skip still closes it in forced mode');
  assert.equal(result.forced.after, result.before, 'forced mode must not write or erase the persistence flag');
});

test('真实浏览器：健康/模型/告警全不可用时三步文案如实（无假数字、无假成功）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t, {
    daemon: {
      models: { providers: [], models: [] },
      onRequest(record, res) {
        if (record.url === '/healthz') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'failed' }));
          return false;
        }
        return undefined;
      },
    },
  });
  const snapshot = await runPage(t, async (inner, page) => {
    void inner;
    const ready = await page.navigate(`${env.url}${PAGE_PATH}`, { waitExpression: READY_EXPRESSION, waitForTimeoutMs: 15000 });
    const data = await page.evaluate(`(() => {
      const banner = document.querySelector('#onboarding-banner');
      const steps = banner ? [...banner.querySelectorAll('li.onboarding-step')] : [];
      return {
        states: steps.map((li) => li.getAttribute('data-state')),
        text: banner ? banner.textContent.replace(/\\s+/g, ' ').trim() : '',
      };
    })()`);
    return { ready, data };
  });

  assert.equal(snapshot.ready, true);
  assert.deepEqual(snapshot.data.states, ['todo', 'todo', 'unknown'], `unexpected step states: ${JSON.stringify(snapshot.data.states)}`);
  assert.ok(snapshot.data.text.includes('/healthz did not answer'), snapshot.data.text.slice(0, 400));
  assert.ok(snapshot.data.text.includes('No usable model yet'), snapshot.data.text.slice(0, 400));
  assert.ok(snapshot.data.text.includes('Alert data is unavailable'), snapshot.data.text.slice(0, 400));
  assert.equal(/Connected ·/.test(snapshot.data.text), false, 'must not claim a healthy connection');
  assert.equal(/First alert/.test(snapshot.data.text), false, 'must not invent an alert');
  assert.equal(/\\d+ model\\(s\\) registered/.test(snapshot.data.text), false, 'must not invent model counts');
  t.diagnostic(`honest text: ${JSON.stringify(snapshot.data.text.slice(0, 200))}`);
});

// ---------------------------------------------------------------------------
// 5. 证据截图（引导出现 / 跳过后主界面完整可见）
// ---------------------------------------------------------------------------

test('截图证据：引导出现的页内 banner 与跳过后的完整主界面', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}${PAGE_PATH}`;

  const withBanner = await screenshot(page, { width: 1440, height: 1000, virtualTimeBudgetMs: 6000, timeoutMs: 40000 });
  assert.equal(withBanner.ok, true, `banner screenshot failed: ${withBanner.reason}`);
  const bannerPath = path.join(EVIDENCE_DIR, '01-banner-in-flow.png');
  fs.writeFileSync(bannerPath, withBanner.png);

  const afterSkip = await cdpScreenshot(page, {
    width: 1440,
    height: 1000,
    waitForExpression: `(() => {
      const banner = document.querySelector('#onboarding-banner');
      if (!banner || banner.dataset.phase !== 'ready') return false;
      const skip = banner.querySelector('[data-action="skip"]');
      if (skip) skip.click();
      return !document.querySelector('#onboarding-banner')
        && (document.querySelector('#view-root') ? document.querySelector('#view-root').children.length > 0 : false);
    })()`,
    waitForTimeoutMs: 20000,
    timeoutMs: 40000,
    settleMs: 500,
  });
  assert.equal(afterSkip.ok, true, `after-skip screenshot failed: ${afterSkip.reason}`);
  const afterPath = path.join(EVIDENCE_DIR, '02-after-skip-main-ui.png');
  fs.writeFileSync(afterPath, afterSkip.png);

  for (const file of [bannerPath, afterPath]) {
    assert.ok(fs.statSync(file).size > 20000, `${path.basename(file)} looks empty`);
  }
  t.diagnostic(`evidence: ${path.basename(bannerPath)} (${withBanner.png.length}B), ${path.basename(afterPath)} (${afterSkip.png.length}B)`);
});
