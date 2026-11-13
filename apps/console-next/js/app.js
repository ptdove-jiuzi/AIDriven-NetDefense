/**
 * AIDriven NetDefense · WebUI v2 · 应用外壳
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.1–§7.5 / §7.9 / §8.6
 *
 * 启动顺序（合同 §7.9 + 任务书）：
 *   解析 URL 覆盖（?theme=&lang=&static=1） → i18n 加载/回落 → store 初始化
 *   → theme 解析落 DOM → 路由 start（导航 + 首次渲染） → 首次状态轮询 → 自动刷新定时器
 *
 * 外壳职责：
 * - `#conn-pill` 按 /healthz（退化时看 /api/v1/status）显示 online / degraded / offline；
 * - `#lang-toggle` 弹语言列表（native name），切换即时生效、不刷新页面；
 * - `#theme-toggle` dark ↔ light ↔ system 三态循环（system 跟随 prefers-color-scheme）；
 * - `#refresh` 重新挂载当前视图 + 重新读健康态；
 * - 全局错误边界（window error / unhandledrejection）→ toast，绝不白屏；
 * - `?theme=&lang=&static=1` 覆盖且**不写 localStorage**；static=1 关闭自动刷新。
 *
 * 所有可注入项（window/document/api/i18n/store/matchMedia/timers/viewLoader）
 * 只为自检服务；生产路径全部走默认值。
 */

import { ApiError, api as defaultApi } from './api.js';
import { DEFAULT_LOCALE, LOCALES, NATIVE_NAMES, i18n as defaultI18n, normalizeLocale } from './i18n.js';
import { createRouter } from './router.js';
import {
  applySettingsPutResult as defaultApplySettingsPutResult,
  readCachedSettings,
  readUi,
  store as defaultStore,
  writeUi,
} from './store.js';
import {
  DEFAULT_AUTO_REFRESH_MS,
  THEME_VALUES,
  computePollMs,
  isPlainObject,
  parseOverrides,
  resolveTheme,
} from './util.js';
import { drawer } from './components/ui/drawer.js';
import { icon } from './components/ui/dom.js';
import { toastHost } from './components/ui/toast.js';
import { createOnboarding } from './onboarding.js';

/** theme 三态循环顺序：system → dark → light → system。 */
const THEME_CYCLE = Object.freeze(['system', 'dark', 'light']);

/** theme 偏好 → 图标名（图标集由 B1 在 index.html 的 sprite 里定义）。 */
const THEME_ICON = Object.freeze({ system: 'sliders', dark: 'moon', light: 'sun' });

/**
 * 启动外壳。
 *
 * @param {{
 *   window?: object,
 *   document?: object,
 *   api?: object,
 *   i18n?: object,
 *   store?: object,
 *   matchMedia?: Function|null,
 *   setInterval?: Function,
 *   clearInterval?: Function,
 *   viewLoader?: Function,
 *   applySettingsPutResult?: Function,
 * }} [options]
 * @returns {Promise<object>} 外壳句柄（含 destroy / setLocale / setTheme / refresh）
 */
export async function bootstrap(options = {}) {
  const opts = options == null ? {} : options;
  const win = opts.window ?? globalThis;
  const doc = opts.document ?? (win && win.document ? win.document : typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.body) throw new Error('[app] bootstrap 需要 document');

  const api = opts.api ?? defaultApi;
  const i18n = opts.i18n ?? defaultI18n;
  const store = opts.store ?? defaultStore;
  const applySettingsPutResult = typeof opts.applySettingsPutResult === 'function'
    ? opts.applySettingsPutResult
    : defaultApplySettingsPutResult;
  const matchMedia =
    typeof opts.matchMedia === 'function'
      ? opts.matchMedia
      : win && typeof win.matchMedia === 'function'
        ? win.matchMedia.bind(win)
        : null;
  const setIntervalImpl =
    typeof opts.setInterval === 'function' ? opts.setInterval : (fn, ms) => win.setInterval(fn, ms);
  const clearIntervalImpl =
    typeof opts.clearInterval === 'function' ? opts.clearInterval : (id) => win.clearInterval(id);

  // ── 1. URL 覆盖（只读，不落 localStorage） ──────────────────────────────
  const search = typeof opts.search === 'string' ? opts.search : win && win.location ? win.location.search : '';
  const overrides = parseOverrides(search);
  const storedUi = readUi();
  const lockedByOverride = { theme: overrides.theme !== null, lang: overrides.lang !== null };

  // ── 2. i18n：加载 + 回落（B10 未交付时回落内置 en，不阻塞首屏） ──────────
  const initialLocale = normalizeLocale(overrides.lang ?? storedUi.locale ?? DEFAULT_LOCALE);
  await i18n.setLocale(initialLocale);
  i18n.apply(doc);

  // ── 3. store 初始化 ────────────────────────────────────────────────────
  const initialThemePreference = THEME_VALUES.includes(overrides.theme)
    ? overrides.theme
    : THEME_VALUES.includes(storedUi.theme)
      ? storedUi.theme
      : 'system';
  const initialDensity = storedUi.density === 'compact' ? 'compact' : 'comfortable';
  store.patch({
    i18n: { locale: i18n.locale, ready: true, missing: i18n.missingCount() },
    density: initialDensity,
    staticMode: overrides.static === true,
    overrides: { theme: overrides.theme, lang: overrides.lang, static: overrides.static === true },
    bootedAt: Date.now(),
  });
  doc.body.setAttribute('data-density', initialDensity);

  // ── 4. toast 宿主 + 全局错误边界 ───────────────────────────────────────
  let toast = () => null;
  try {
    const hosts = toastHost(doc.getElementById('toast-root'));
    toast = (toastOptions) => {
      try {
        return hosts.show(toastOptions);
      } catch (error) {
        console.error('[app] toast failed', error);
        return null;
      }
    };
  } catch (error) {
    console.error('[app] toast host unavailable', error);
  }

  function reportError(error) {
    if (typeof console !== 'undefined' && console.error) console.error('[app]', error);
    const text = error instanceof ApiError ? error.message : i18n.t('app.error.unexpected');
    toast({ kind: 'danger', text });
  }

  function onWindowError(event) {
    reportError(event && (event.error ?? event.message));
  }

  function onUnhandledRejection(event) {
    reportError(event && event.reason);
  }

  win.addEventListener('error', onWindowError);
  win.addEventListener('unhandledrejection', onUnhandledRejection);
  // ── 5. theme：解析 + 落 DOM（system 跟随 prefers-color-scheme） ─────────
  function updateThemeButton() {
    const button = doc.getElementById('theme-toggle');
    if (!button) return;
    const preference = store.getState().theme.preference;
    const label = i18n.t(`app.theme.${preference}`);
    button.setAttribute('title', i18n.t('app.theme.current', { theme: label }));
    button.setAttribute('aria-label', i18n.t('app.theme.current', { theme: label }));
    const holder = button.querySelector('[data-theme-icon]');
    if (holder) {
      holder.replaceChildren(icon(THEME_ICON[preference] ?? 'sliders'));
    }
  }

  function setTheme(preference, themeOptions = {}) {
    const desired = THEME_VALUES.includes(preference) ? preference : 'system';
    const result = resolveTheme(desired, { matchMedia });
    doc.body.setAttribute('data-theme', result.resolved);
    if (result.source === 'system') doc.body.setAttribute('data-theme-source', 'system');
    else doc.body.removeAttribute('data-theme-source');
    store.patch({
      theme: { preference: result.preference, resolved: result.resolved, source: result.source },
    });
    updateThemeButton();
    if (themeOptions.persist !== false && !lockedByOverride.theme) {
      writeUi({ theme: result.preference });
    }
    return result;
  }

  function cycleTheme() {
    const currentPreference = store.getState().theme.preference;
    const index = THEME_CYCLE.indexOf(currentPreference);
    const next = THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
    return setTheme(next);
  }

  function applyDensity(density) {
    const next = density === 'compact' ? 'compact' : 'comfortable';
    doc.body.setAttribute('data-density', next);
    store.patch({ density: next });
    return next;
  }

  setTheme(initialThemePreference, { persist: false });

  // system 主题跟随系统变化（仅 preference=system 时生效，合同 §7.8）
  let mediaQuery = null;
  let mediaListener = null;
  if (matchMedia) {
    try {
      mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    } catch {
      mediaQuery = null;
    }
    if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
      mediaListener = () => {
        if (store.getState().theme.preference === 'system') setTheme('system', { persist: false });
      };
      mediaQuery.addEventListener('change', mediaListener);
    } else if (mediaQuery && typeof mediaQuery.addListener === 'function') {
      mediaListener = () => {
        if (store.getState().theme.preference === 'system') setTheme('system', { persist: false });
      };
      mediaQuery.addListener(mediaListener);
    }
  }

  // ── 6. 工具栏按钮外观（B1 的 toolbar 按钮只给兜底样式，B2 补图标/类） ───
  function decorateToolbar() {
    const langButton = doc.getElementById('lang-toggle');
    if (langButton) {
      langButton.classList.add('ui-btn', 'ui-btn--icon');
      langButton.setAttribute('aria-expanded', 'false');
      const holder = doc.createElement('span');
      holder.setAttribute('data-lang-icon', '');
      holder.appendChild(icon('globe'));
      langButton.replaceChildren(holder);
    }
    const themeButton = doc.getElementById('theme-toggle');
    if (themeButton) {
      themeButton.classList.add('ui-btn', 'ui-btn--icon');
      const holder = doc.createElement('span');
      holder.setAttribute('data-theme-icon', '');
      themeButton.replaceChildren(holder);
    }
    const refreshButton = doc.getElementById('refresh');
    if (refreshButton) {
      refreshButton.classList.add('ui-btn');
    }
  }

  // ── 7. 状态轮询 + conn-pill ────────────────────────────────────────────
  function settingsDocument(state) {
    const settings = state.settings;
    if (!isPlainObject(settings)) return null;
    return isPlainObject(settings.settings) ? settings.settings : settings;
  }

  function renderConn() {
    const pill = doc.getElementById('conn-pill');
    if (!pill) return;
    const conn = store.getState().conn;
    const state = ['online', 'degraded', 'offline', 'idle'].includes(conn.state) ? conn.state : 'offline';
    pill.setAttribute('data-tone', state);
    pill.textContent = i18n.t(`app.conn.${state}`);
    if (conn.version) pill.setAttribute('title', i18n.t('app.conn.version', { version: conn.version }));
    else pill.removeAttribute('title');
  }

  function healthState(status) {
    // 真实 daemon（apps/daemon/src/api/server.js → handlers.health()）返回
    // 'ok' | 'degraded' | 'failed'；'healthy' 兼容旧写法。'ok' 必须算 online，
    // 否则真实栈的 conn-pill 会永远显示 Offline。
    if (status === 'ok' || status === 'healthy' || status === 'up' || status === 'pass') return 'online';
    if (status === 'degraded' || status === 'warn') return 'degraded';
    return 'offline';
  }

  async function refreshConnection() {
    const at = Date.now();
    const [statusResult, healthResult] = await Promise.allSettled([api.getStatus(), api.getHealth()]);
    const patch = {};
    let conn = { state: 'offline', version: null, at };
    if (statusResult.status === 'fulfilled') {
      patch.status = statusResult.value;
    }
    if (healthResult.status === 'fulfilled') {
      const health = isPlainObject(healthResult.value) ? healthResult.value : {};
      conn = {
        state: healthState(health.status),
        version: typeof health.version === 'string' ? health.version : null,
        at,
      };
    } else if (statusResult.status === 'fulfilled') {
      const status = isPlainObject(statusResult.value) ? statusResult.value : {};
      conn = {
        state: 'online',
        version: typeof status.version === 'string' ? status.version : null,
        at,
      };
    } else if (statusResult.status === 'rejected' && statusResult.reason instanceof ApiError) {
      conn = { state: 'offline', version: null, at };
    }
    patch.conn = conn;
    store.patch(patch);
    renderConn();
    return conn;
  }

  let pollTimer = null;
  function stopPolling() {
    if (pollTimer !== null) {
      clearIntervalImpl(pollTimer);
      pollTimer = null;
    }
  }
  function schedulePolling() {
    stopPolling();
    // 窗口隐藏（托盘驻留）时不装定时器：隐藏页的 setInterval 只会白唤醒 renderer，
    // 何况壳随后会把 WebView2 挂起（PERF-CPU / N-034 实测：hide() 不触发 visibilitychange，
    // 页面自己可能永远收不到事件，所以壳侧挂起 + 这里两道都要有）。
    if (typeof doc !== 'undefined' && doc !== null && doc.hidden === true) return 0;
    const state = store.getState();
    const settings = settingsDocument(state);
    const autoRefreshMs = settings && isPlainObject(settings.ui) && settings.ui.autoRefreshMs !== undefined
      ? settings.ui.autoRefreshMs
      : DEFAULT_AUTO_REFRESH_MS;
    // static=1（合同 §7.9）关闭自动刷新，优先级高于配置。
    const intervalMs = computePollMs({ autoRefreshMs, staticMode: overrides.static === true });
    if (intervalMs <= 0) return 0;
    pollTimer = setIntervalImpl(() => {
      refreshConnection().catch((error) => {
        if (typeof console !== 'undefined' && console.error) console.error('[app] poll failed', error);
      });
    }, intervalMs);
    return intervalMs;
  }

  // 隐藏 → 停表 + 暂停常驻动画；可见 → 立刻补刷一次再起表。
  // `forceVisible` 由壳调用（`window.__aidnShellResume`）：WebView2 的 hide()/show() 不触发
  // visibilitychange，页面会一直认为自己是 hidden，需要壳明确告知"窗口真的可见了"。
  function applyShellVisibility(forceVisible = false) {
    const hidden = forceVisible === true
      ? false
      : (typeof doc !== 'undefined' && doc !== null && doc.hidden === true);
    if (typeof doc !== 'undefined' && doc !== null && doc.documentElement) {
      doc.documentElement.toggleAttribute('data-aidn-hidden', hidden);
    }
    if (hidden) {
      stopPolling();
      return;
    }
    schedulePolling();
    refreshConnection().catch(() => {});
  }
  if (typeof doc !== 'undefined' && doc !== null && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', applyShellVisibility);
  }
  const shellHost = typeof window !== 'undefined' ? window : null;
  if (shellHost) shellHost.__aidnShellResume = () => applyShellVisibility(true);

  // ── 8. 语言切换（不刷新页面，同步 <html lang>，重渲染当前视图） ─────────
  async function setLocale(next, localeOptions = {}) {
    const desired = normalizeLocale(next);
    if (desired === i18n.locale && localeOptions.force !== true) {
      i18n.apply(doc);
      return i18n.locale;
    }
    await i18n.setLocale(desired);
    i18n.apply(doc);
    store.patch({
      i18n: { locale: i18n.locale, ready: true, missing: i18n.missingCount() },
    });
    updateThemeButton();
    renderConn();
    await router.refresh();
    if (localeOptions.persist !== false && !lockedByOverride.lang) writeUi({ locale: i18n.locale });
    return i18n.locale;
  }

  let langOverlay = null;

  function openLangDrawer() {
    if (langOverlay && langOverlay.isOpen) {
      langOverlay.close('api');
      return;
    }
    const currentLocale = store.getState().i18n.locale ?? i18n.locale;
    const trigger = doc.getElementById('lang-toggle');
    const options = LOCALES.map((locale) => {
      const selected = locale === currentLocale;
      return {
        locale,
        selected,
        node: (() => {
          const button = doc.createElement('button');
          button.type = 'button';
          button.className = 'ui-btn';
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
          button.setAttribute('data-variant', selected ? 'primary' : 'ghost');
          button.setAttribute('data-locale', locale);
          const nativeName = doc.createElement('span');
          nativeName.textContent = NATIVE_NAMES[locale] ?? locale;
          const code = doc.createElement('span');
          code.className = 'faint mono';
          code.textContent = locale;
          button.appendChild(nativeName);
          button.appendChild(code);
          button.addEventListener('click', () => {
            if (langOverlay) langOverlay.close('api');
            setLocale(locale).catch(reportError);
          });
          return button;
        })(),
      };
    });
    const list = doc.createElement('div');
    list.className = 'stack';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', i18n.t('app.lang.menu'));
    for (const option of options) list.appendChild(option.node);
    langOverlay = drawer({
      title: i18n.t('app.lang.menu'),
      body: list,
      closeLabel: i18n.t('common.action.close'),
      onClose: () => {
        langOverlay = null;
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      },
    });
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    return langOverlay;
  }

  // ── 9. 路由（导航 + 首次渲染） ─────────────────────────────────────────
  const router = createRouter({
    root: doc.getElementById('view-root'),
    store,
    api,
    i18n,
    toast,
    window: win,
    viewLoader: opts.viewLoader,
  });
  decorateToolbar();
  i18n.apply(doc);
  updateThemeButton();
  renderConn();
  await router.start();

  // ── 9.5 首启动引导（T4）：页内 banner，不遮罩、不抢焦点、可跳过、可重看 ──
  const onboarding = createOnboarding({ document: doc, window: win, api, i18n, store });
  onboarding.mount();

  // ── 10. 按钮接线 ──────────────────────────────────────────────────────
  const langButton = doc.getElementById('lang-toggle');
  if (langButton) langButton.addEventListener('click', () => openLangDrawer());
  const themeButton = doc.getElementById('theme-toggle');
  if (themeButton) themeButton.addEventListener('click', () => cycleTheme());
  const refreshButton = doc.getElementById('refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      refreshButton.setAttribute('aria-busy', 'true');
      Promise.allSettled([router.refresh(), refreshConnection()]).finally(() => {
        refreshButton.removeAttribute('aria-busy');
      });
    });
  }

  // ── 11. settings 变更联动（ui 组 immediate：theme/density/locale/autoRefreshMs） ──
  const unsubscribe = store.subscribe((state, prev, changed) => {
    if (!changed.includes('settings')) return;
    const settings = settingsDocument(state);
    if (settings) {
      const ui = isPlainObject(settings.ui) ? settings.ui : {};
      if (typeof ui.theme === 'string' && !lockedByOverride.theme) setTheme(ui.theme, { persist: false });
      if (typeof ui.density === 'string') applyDensity(ui.density);
      const nextLocale = typeof ui.locale === 'string' ? normalizeLocale(ui.locale) : null;
      if (nextLocale && nextLocale !== i18n.locale && !lockedByOverride.lang) {
        setLocale(nextLocale, { persist: false }).catch(reportError);
      }
    }
    const intervalMs = schedulePolling();
    store.patch({ pollIntervalMs: intervalMs });
  });

  // 首屏可用只读缓存（合同 §7.5：aidn.settings.cache 供首屏），不覆盖 URL 覆盖值。
  const cachedSettings = readCachedSettings();
  if (cachedSettings) store.patch({ settings: cachedSettings });

  // ── 12. 首次状态轮询 + 自动刷新 ───────────────────────────────────────
  refreshConnection().catch(reportError);
  schedulePolling();
  // 注意：**不要**在启动时按 document.hidden 停表。后台启动/测试环境里文档可能一直是
  // hidden，启动即停表会让首屏停在骨架态（实测会让 a11y 窄屏用例出现 4px 横向溢出）。
  // 停表只由真实的 visibilitychange 与壳的 __aidnShellResume() 驱动。
  if (typeof doc !== 'undefined' && doc !== null && doc.documentElement) {
    doc.documentElement.toggleAttribute('data-aidn-hidden', doc.hidden === true);
  }

  // ── 13. 调试入口（window.__I18N__ 合同要求；__AIDN__ 供 B11 端到端驱动） ──
  i18n.debug(win);
  win.__AIDN__ = {
    store,
    router,
    api,
    i18n,
    onboarding,
    setLocale: (locale) => setLocale(locale),
    setTheme: (preference) => setTheme(preference),
    refresh: () => Promise.allSettled([router.refresh(), refreshConnection()]),
    overrides,
    destroy,
  };

  async function destroy() {
    if (pollTimer !== null) {
      clearIntervalImpl(pollTimer);
      pollTimer = null;
    }
    try {
      unsubscribe();
    } catch {
      /* 已取消 */
    }
    if (mediaQuery && mediaListener) {
      if (typeof mediaQuery.removeEventListener === 'function') mediaQuery.removeEventListener('change', mediaListener);
      else if (typeof mediaQuery.removeListener === 'function') mediaQuery.removeListener(mediaListener);
    }
    win.removeEventListener('error', onWindowError);
    win.removeEventListener('unhandledrejection', onUnhandledRejection);
    if (langOverlay) {
      try {
        langOverlay.close('api');
      } catch {
        /* 已关闭 */
      }
    }
    await router.stop();
    try {
      onboarding.destroy();
    } catch {
      /* 引导卸载失败不应影响外壳关闭 */
    }
    if (win.__I18N__) delete win.__I18N__;
    if (win.__AIDN__) delete win.__AIDN__;
  }

  return {
    api,
    i18n,
    store,
    router,
    overrides,
    onboarding,
    setLocale,
    setTheme,
    cycleTheme,
    refresh: () => Promise.allSettled([router.refresh(), refreshConnection()]),
    refreshConnection,
    schedulePolling,
    applySettingsPutResult,
    destroy,
  };
}

/**
 * 自动启动：index.html 通过 `<script type="module" src="js/app.js">` 加载本文件。
 * 自检页会先设置 `window.__AIDN_NO_AUTOBOOT__ = true`，避免与测试引导冲突。
 */
function autoBoot() {
  if (typeof document === 'undefined') return;
  const global = typeof window !== 'undefined' ? window : globalThis;
  if (global.__AIDN_NO_AUTOBOOT__) return;
  if (global.__AIDN_BOOTED__) return;
  if (!document.getElementById('view-root')) return;
  global.__AIDN_BOOTED__ = true;
  bootstrap().catch((error) => {
    if (typeof console !== 'undefined' && console.error) console.error('[app] bootstrap failed', error);
    // 最后的兜底：即使外壳起不来，也不留空白页。
    try {
      const root = document.getElementById('view-root');
      if (root) {
        const failure = document.createElement('p');
        failure.className = 'muted';
        failure.textContent = error && error.message ? error.message : 'AIDriven NetDefense failed to start.';
        root.replaceChildren(failure);
      }
    } catch {
      /* 极早期失败时 DOM 可能还不可用 */
    }
  });
}

autoBoot();



