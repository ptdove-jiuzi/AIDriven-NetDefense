/**
 * UI-POLISH · T2 settings · "daemon 不在" 与本地界面偏好回归
 * 作者：PT-dove
 *
 * 判据（shared task task-2 第 5/6/7 条）：
 * 1. daemon 不在 → 顶部必须有**带错误码 + 原因 + 重试**的横幅，8 个分组标签仍然在；
 * 2. 除「界面」组之外，每一组都要有**显式错误占位**（不是空白、不是永久转圈），
 *    占位里必须写清"没有任何值被改写、也没有编造默认值"，并带重试入口；
 * 3. 「界面」组在无 daemon 时**仍然可改且立即生效**：主题/密度/语言，
 *    走外壳 __AIDN__ 的 setTheme/setLocale，并写 aidn.ui（零网络请求）；
 * 4. 语言切换立即生效（调用外壳 setLocale，不需要重新加载页面）；
 * 5. 重试成功后恢复真实表单，横幅消失，不残留骨架屏。
 *
 * 全部用真实 DOM 事件驱动，断言的是 DOM 与 localStorage 的可观测结果，
 * 不是"函数被调用了"这种自证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installDom, makeEvent } from './dom-shim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

const EN = JSON.parse(readFileSync(path.join(REPO, 'apps/console-next/i18n/locales/en.json'), 'utf8'));
const DICT = EN;
const t = (key, fallback) => {
  const value = DICT[key];
  return typeof value === 'string' && value !== '' ? value : fallback == null ? key : fallback;
};
const SETTINGS_MODULE = pathToFileURL(
  path.join(REPO, 'apps/console-next/js/views/settings/index.js'),
).href;

function flush(times = 8) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chain;
}

/** 传输层错误（与 apps/console-next/js/api.js 的 NETWORK 码同形）。 */
function networkError() {
  const error = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:8788');
  error.code = 'NETWORK';
  error.details = null;
  return error;
}

/**
 * daemon 栈：真 settings 处理器 + 一个可以"掉线/恢复"的 api 适配层。
 * 掉线时抛 NETWORK（这是传输层失败，不是 daemon 拒绝），恢复后返回真数据。
 */
async function createRig(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aidn-t2-offline-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const { createSettingsStore, createSettingsHandlers } = await import(
    '../../apps/daemon/src/api/settings.js'
  );
  const filePath = path.join(dir, 'settings.json');
  const store = createSettingsStore({ filePath });
  const handlers = createSettingsHandlers({
    store,
    broker: {
      describeCredentials: async () => new Map(),
      deleteCredential: async () => {},
    },
    readOnly: () => ({}),
  });

  const state = { down: options.down !== false, calls: 0 };
  const guard = async (fn) => {
    state.calls += 1;
    if (state.down) throw networkError();
    return fn();
  };

  const api = {
    getSettingsSchema: () => guard(() => handlers.getSettingsSchema()),
    getSettings: () => guard(() => handlers.getSettings()),
    getModels: () =>
      guard(() => ({
        providers: [],
        models: [],
        usage: { available: false, reason: 'NO_LEDGER', byProvider: [], byTier: [], escalations: 0 },
        engine: { selected: 'none', harness: { available: false, reason: 'PROFILE_NOT_STAGED' } },
      })),
    putSettings: (settings, opts) => guard(() => handlers.putSettings({ body: { settings } })),
    putCredential: async () => null,
    deleteCredential: async () => null,
    testProvider: async () => {
      throw networkError();
    },
  };

  return { dir, filePath, store, handlers, api, state, onDisk: () => existsSync(filePath) };
}

async function mountSettings(t, rig, extraCtx = {}) {
  const dom = installDom();
  const root = dom.document.createElement('div');
  root.id = 'view-root';
  dom.document.body.appendChild(root);
  const { mount } = await import(SETTINGS_MODULE);
  const ctx = {
    api: rig.api,
    i18n: { t: (key) => DICT[key] },
    store: null,
    params: {},
    navigate() {},
    toast() {},
    ...extraCtx,
  };
  const handle = await mount(root, ctx);
  await flush();
  return { dom, root, ctx, handle };
}

function tabsOf(root) {
  return root.querySelectorAll('.ui-tab');
}

async function openGroup(root, groupId) {
  const tab = tabsOf(root).find((node) => node.getAttribute('data-tab') === groupId);
  assert.ok(tab, `tab for "${groupId}" must exist`);
  tab.dispatchEvent(makeEvent('click'));
  await flush(4);
}

function body(root) {
  return root.querySelector('#settings-body');
}

/* =========================================================================
 * O1 · 顶部横幅 + 8 个标签 + 每组显式错误占位
 * ====================================================================== */

test('T2-O1 · daemon 不在：顶部横幅带错误码与重试，8 个分组标签都在', async (t) => {
  const rig = await createRig(t, { down: true });
  const { root, handle } = await mountSettings(t, rig);

  const banner = root.querySelectorAll('[data-role="offline-banner"]');
  assert.equal(banner.length, 1, 'a daemon-down banner must be rendered');
  assert.equal(banner[0].getAttribute('data-state'), 'daemon-down');
  assert.equal(banner[0].getAttribute('data-code'), 'NETWORK');
  assert.ok(/NETWORK/.test(banner[0].textContent || ''), 'the banner must name the transport error code');
  const retry = banner[0].querySelectorAll('button').find((node) => /retry/i.test(node.textContent || ''));
  assert.ok(retry, 'the banner must offer a retry action');
  assert.equal(retry.hasAttribute('disabled'), false, 'retry must be clickable while offline');

  assert.equal(tabsOf(root).length, 8, 'all 8 group tabs must stay visible when the daemon is down');

  handle.destroy();
});

test('T2-O2 · 除「界面」外每组都有显式错误占位（不是空白、不是永久加载）', async (t) => {
  const rig = await createRig(t, { down: true });
  const { root, handle } = await mountSettings(t, rig);

  const groups = ['models', 'collection', 'detection', 'response', 'update', 'diagnostics', 'about'];
  for (const groupId of groups) {
    await openGroup(root, groupId);
    const placeholders = body(root).querySelectorAll('[data-role="group-unavailable"]');
    assert.equal(placeholders.length, 1, `${groupId} must render exactly one explicit unavailable placeholder`);
    const node = placeholders[0];
    assert.equal(node.getAttribute('data-group'), groupId, `${groupId} placeholder must identify its group`);
    assert.equal(node.getAttribute('data-code'), 'NETWORK', `${groupId} placeholder must carry the error code`);
    const text = node.textContent || '';
    assert.ok(/NETWORK/.test(text), `${groupId} placeholder must show the code, got "${text}"`);
    assert.ok(
      /nothing|no value|not (been )?changed|unavailable/i.test(text),
      `${groupId} placeholder must state that nothing was written, got "${text}"`,
    );
    const retry = node.querySelectorAll('button').find((entry) => /retry/i.test(entry.textContent || ''));
    assert.ok(retry, `${groupId} placeholder must offer retry`);

    // 不能是"空白"或"一直转圈"：既没有骨架屏，也没有残留 loading 文案
    assert.equal(
      body(root).querySelectorAll('.ui-skeleton').length,
      0,
      `${groupId} must not keep a skeleton on screen while offline`,
    );
  }

  handle.destroy();
});

/* =========================================================================
 * O3 · 「界面」组无 daemon 仍可改、立即生效、零请求
 * ====================================================================== */

test('T2-O3 · 无 daemon 时界面组可改：密度/主题一键生效并写 aidn.ui（零网络请求）', async (t) => {
  const rig = await createRig(t, { down: true });
  const shellCalls = { setTheme: [], setLocale: [], setDensity: [] };
  const { root, handle, dom, ctx } = await mountSettings(t, rig);
  const win = globalThis.window;
  win.__AIDN__ = {
    setTheme: (value) => {
      shellCalls.setTheme.push(value);
      dom.document.body.setAttribute('data-theme', value === 'system' ? 'dark' : value);
    },
    setLocale: (value) => shellCalls.setLocale.push(value),
    store: { getState: () => ({}) },
  };

  await openGroup(root, 'ui');
  const quick = root.querySelectorAll('[data-role="ui-quick"]');
  assert.ok(quick.length >= 2, 'the ui group must expose one-click theme and density controls');

  const densityRow = quick[1];
  const compactLabel = String(DICT['settings.enum.ui.density.compact'] || 'Compact');
  const compact = densityRow
    .querySelectorAll('button')
    .find((node) => (node.textContent || '').trim() === compactLabel);
  assert.ok(compact, `the density control must offer "${compactLabel}"`);

  const callsBefore = rig.state.calls;
  compact.dispatchEvent(makeEvent('click'));
  await flush(4);

  assert.equal(
    dom.document.body.getAttribute('data-density'),
    'compact',
    'clicking Compact must change the applied density immediately',
  );
  const stored = JSON.parse(globalThis.localStorage.getItem('aidn.ui') || '{}');
  assert.equal(stored.density, 'compact', 'the density must be persisted to aidn.ui');
  assert.equal(rig.state.calls, callsBefore, 'changing a local UI preference must not require the daemon');

  // 主题切换走外壳 setTheme（有外壳时不自己伪造）
  const darkLabel = String(DICT['settings.enum.ui.theme.dark'] || 'Dark');
  const dark = quick[0]
    .querySelectorAll('button')
    .find((node) => (node.textContent || '').trim() === darkLabel);
  assert.ok(dark, 'the theme control must offer Dark');
  dark.dispatchEvent(makeEvent('click'));
  await flush(4);
  assert.deepEqual(shellCalls.setTheme, ['dark'], 'theme change must go through the shell (setTheme)');
  assert.equal(JSON.parse(globalThis.localStorage.getItem('aidn.ui') || '{}').theme, 'dark');

  void ctx;
  handle.destroy();
});

/* =========================================================================
 * O4 · 语言切换立即生效（不需要刷新页面）
 * ====================================================================== */

test('T2-O4 · 无 daemon 时切换语言：立即调用外壳 setLocale 并写入 aidn.ui', async (t) => {
  const rig = await createRig(t, { down: true });
  const shellCalls = [];
  const { root, handle } = await mountSettings(t, rig);
  globalThis.window.__AIDN__ = {
    setTheme: () => {},
    setLocale: (value) => shellCalls.push(value),
    store: { getState: () => ({}) },
  };

  await openGroup(root, 'ui');
  const localeHost = body(root).querySelectorAll('[data-path="ui.locale"]');
  assert.equal(localeHost.length, 1, 'the offline ui group must render a real language control');
  const options = localeHost[0].querySelectorAll('button');
  assert.ok(options.length >= 7, 'all 7 locales must be offered');
  const japanese = options.find((node) => (node.textContent || '').trim() === String(DICT['settings.enum.ui.locale.ja'] || 'Japanese'));
  assert.ok(japanese, 'the language control must offer 日本語');
  japanese.dispatchEvent(makeEvent('click'));
  await flush(4);

  assert.deepEqual(shellCalls, ['ja'], 'switching language must call the shell immediately, without a page reload');
  assert.equal(JSON.parse(globalThis.localStorage.getItem('aidn.ui') || '{}').locale, 'ja');

  handle.destroy();
});

/* =========================================================================
 * O5 · 重试成功后恢复真实表单，横幅消失，不残留骨架
 * ====================================================================== */

test('T2-O5 · 点重试：daemon 回来后渲染真实表单，横幅消失、无残留 loading', async (t) => {
  const rig = await createRig(t, { down: true });
  const { root, handle } = await mountSettings(t, rig);

  assert.equal(root.querySelectorAll('[data-role="offline-banner"]').length, 1);

  rig.state.down = false;
  const retry = root
    .querySelectorAll('[data-role="offline-banner"]')[0]
    .querySelectorAll('button')
    .find((node) => /retry/i.test(node.textContent || ''));
  retry.dispatchEvent(makeEvent('click'));
  await flush(24);

  assert.equal(
    root.querySelectorAll('[data-role="offline-banner"]').length,
    0,
    'the banner must disappear once the daemon answers',
  );
  assert.equal(
    root.querySelectorAll('[data-role="group-unavailable"]').length,
    0,
    'the unavailable placeholders must be replaced by the real form',
  );
  assert.equal(tabsOf(root).length, 8, 'the 8 group tabs must still be there');
  assert.ok(
    root.querySelectorAll('.settings-item').length > 0,
    'the models group must render real settings items after recovery',
  );
  assert.equal(
    root.querySelectorAll('.ui-skeleton').length,
    0,
    'no skeleton may be left behind after a successful load',
  );

  handle.destroy();
});
