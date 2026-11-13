/**
 * AIDriven NetDefense · WebUI v2 · hash 路由
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.2
 *
 * - 6 个视图：overview / alerts / analysis / agent / models / settings；
 * - `#/models` 以 `group=models` 挂载 `views/settings/index.js`（避免第二套模型 UI）；
 * - hash 内的查询串原样进视图的 `ctx.params`；筛选/排序/页/搜索由视图用
 *   `ctx.navigate(..., {replace:true})` 回写 hash，浏览器前进/后退天然恢复；
 * - 未知 hash → `location.replace('#/overview')`（不堆历史）+ toast `app.route.unknown`；
 * - 视图模块缺失 / mount 抛错 / 返回值非法 → `views/placeholder.js`，永不白屏；
 * - 页面锚点（如 skip-link 的 `#view-root`）不参与路由，避免破坏 `#/…` 路由。
 *
 * 可注入项（自检用，生产全部走默认值）：
 *   viewLoader(route) → Promise<{mount}>、setHash/replaceHash、getHash、window、toast。
 */

import { buildHash, isPlainObject, parseHash } from './util.js';
import * as placeholder from './views/placeholder.js';

/**
 * 路由表（顺序 = 导航顺序；module 相对本文件）。
 * @type {ReadonlyArray<{id:string, titleKey:string, module:string, fixedParams?:object}>}
 */
export const ROUTES = Object.freeze([
  Object.freeze({ id: 'overview', titleKey: 'nav.overview', module: './views/overview.js' }),
  Object.freeze({ id: 'alerts', titleKey: 'nav.alerts', module: './views/alerts.js' }),
  Object.freeze({ id: 'analysis', titleKey: 'nav.analysis', module: './views/analysis.js' }),
  Object.freeze({ id: 'agent', titleKey: 'nav.agent', module: './views/agent.js' }),
  Object.freeze({
    id: 'models',
    titleKey: 'nav.models',
    module: './views/settings/index.js',
    fixedParams: Object.freeze({ group: 'models' }),
  }),
  Object.freeze({ id: 'settings', titleKey: 'nav.settings', module: './views/settings/index.js' }),
]);

/** 视图 id 列表。 */
export const ROUTE_IDS = Object.freeze(ROUTES.map((route) => route.id));

/**
 * 按 id 找路由。
 * @param {string} id
 * @returns {object|null}
 */
export function routeFor(id) {
  const target = String(id ?? '').toLowerCase();
  return ROUTES.find((route) => route.id === target) ?? null;
}

/**
 * 解析 location.hash → 路由判定。
 * @param {string} hash
 * @returns {{kind:'empty'|'anchor'|'route'|'unknown', id:string, route:object|null, params:Record<string,string>, raw:string}}
 */
export function parseRouteHash(hash) {
  const parsed = parseHash(hash);
  if (parsed.kind === 'empty') {
    return { kind: 'empty', id: '', route: null, params: {}, raw: parsed.raw };
  }
  if (parsed.kind === 'anchor') {
    return { kind: 'anchor', id: parsed.name, route: null, params: {}, raw: parsed.raw };
  }
  const route = routeFor(parsed.name);
  if (!route) {
    return { kind: 'unknown', id: parsed.name, route: null, params: {}, raw: parsed.raw };
  }
  return { kind: 'route', id: route.id, route, params: { ...parsed.params }, raw: parsed.raw };
}

/** 默认视图加载器：动态 import 视图模块。 */
function defaultViewLoader(route) {
  const url = new URL(route.module, import.meta.url).href;
  return import(url);
}

/**
 * 创建路由。
 *
 * @param {{
 *   root?: HTMLElement|null,
 *   store?: object,
 *   api?: object,
 *   i18n?: object,
 *   toast?: Function|null,
 *   viewLoader?: Function,
 *   setHash?: Function,
 *   replaceHash?: Function,
 *   getHash?: Function,
 *   window?: object,
 *   onRoute?: Function|null,
 * }} [options]
 */
export function createRouter(options = {}) {
  const opts = options == null ? {} : options;
  const win = opts.window ?? (typeof window !== 'undefined' ? window : null);
  const doc = win && win.document ? win.document : typeof document !== 'undefined' ? document : null;
  const root = opts.root ?? (doc ? doc.getElementById('view-root') : null);
  const store = opts.store ?? null;
  const api = opts.api ?? null;
  const i18n = opts.i18n ?? null;
  const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
  const viewLoader = typeof opts.viewLoader === 'function' ? opts.viewLoader : defaultViewLoader;
  const onRoute = typeof opts.onRoute === 'function' ? opts.onRoute : null;

  const getHash =
    typeof opts.getHash === 'function'
      ? opts.getHash
      : () => (win && win.location ? win.location.hash : '');
  const setHash =
    typeof opts.setHash === 'function'
      ? opts.setHash
      : (hash) => {
          if (win && win.location) win.location.hash = hash;
        };
  const replaceHash =
    typeof opts.replaceHash === 'function'
      ? opts.replaceHash
      : (hash) => {
          if (win && win.location) win.location.replace(hash);
        };

  /** @type {{id:string, params:object, handle:object|null, placeholder:boolean}|null} */
  let current = null;
  let renderToken = 0;
  let started = false;
  let suppressNextHash = null;

  function t(key, vars) {
    if (i18n && typeof i18n.t === 'function') return i18n.t(key, vars);
    return key;
  }

  function makeContext(route, params) {
    return {
      store,
      api,
      i18n,
      params,
      navigate,
      toast,
      // 加法：当前视图 id，便于视图做“本页高亮”一类事（合同 ctx 的 6 个键不变）。
      route: route ? route.id : null,
    };
  }

  function updateNav(routeId) {
    if (!doc || typeof doc.getElementById !== 'function') return;
    const nav = doc.getElementById('nav');
    if (!nav || typeof nav.querySelectorAll !== 'function') return;
    for (const link of nav.querySelectorAll('[data-route]')) {
      if (link.getAttribute('data-route') === routeId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function updateTitle(route) {
    if (!doc || !route) return;
    doc.title = `${t(route.titleKey)} · ${t('app.title')}`;
  }

  async function destroyCurrent(entry) {
    if (!entry || !entry.handle) return;
    const handle = entry.handle;
    if (handle && typeof handle.destroy === 'function') {
      try {
        await handle.destroy();
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[router] view destroy failed', error);
      }
    }
  }

  async function mountPlaceholder(route, params, token) {
    if (!root) return null;
    try {
      root.replaceChildren();
      const handle = await placeholder.mount(root, makeContext(route, params));
      if (token !== renderToken) {
        if (handle && typeof handle.destroy === 'function') {
          try {
            handle.destroy();
          } catch {
            /* 过期视图清理失败不阻塞新渲染 */
          }
        }
        return null;
      }
      current = {
        id: route ? route.id : 'unknown',
        params,
        handle: handle && typeof handle.destroy === 'function' ? handle : { destroy() {} },
        placeholder: true,
      };
      updateNav(route ? route.id : null);
      if (route) updateTitle(route);
      return current;
    } catch (error) {
      // placeholder 自身失败也必须留字：绝不白屏。
      if (typeof console !== 'undefined' && console.error) console.error('[router] placeholder failed', error);
      if (root) {
        const fallback = doc.createElement('p');
        fallback.className = 'muted';
        fallback.textContent = t('errors.view-unavailable');
        root.replaceChildren(fallback);
      }
      current = { id: route ? route.id : 'unknown', params, handle: { destroy() {} }, placeholder: true };
      return current;
    }
  }

  async function renderView(route, params, token) {
    if (!root) return null;
    const previous = current;
    current = null;
    await destroyCurrent(previous);
    if (token !== renderToken) return null;
    root.replaceChildren();
    if (token !== renderToken) return null;
    // 导航高亮/标题/路由态在**等待 mount 之前**就位：视图 mount 可能 await 网络（如 Agent
    // 拉模型列表），若等 mount 完成再更新，导航会在这段时间保持旧高亮（真实栈冒烟抓到过）。
    updateNav(route.id);
    updateTitle(route);
    if (store && typeof store.patch === 'function') {
      store.patch({ route: { id: route.id, params, hash: parseRouteHash(getHash()).raw } });
    }
    if (onRoute) {
      try {
        onRoute({ id: route.id });
      } catch (error) {
        if (typeof console !== 'undefined' && console.error) console.error('[router] onRoute failed', error);
      }
    }
    let handle = null;
    try {
      const module = await viewLoader(route);
      if (token !== renderToken) return null;
      if (!module || typeof module.mount !== 'function') {
        throw new Error(`view module "${route.id}" has no mount() export`);
      }
      handle = await module.mount(root, makeContext(route, params));
      if (token !== renderToken) {
        if (handle && typeof handle.destroy === 'function') {
          try {
            handle.destroy();
          } catch {
            /* 过期视图清理失败不阻塞新渲染 */
          }
        }
        return null;
      }
      current = {
        id: route.id,
        params,
        handle: handle && typeof handle.destroy === 'function' ? handle : { destroy() {} },
        placeholder: false,
      };
    } catch (error) {
      if (token !== renderToken) return null;
      if (typeof console !== 'undefined' && console.error) console.error(`[router] view "${route.id}" unavailable`, error);
      return mountPlaceholder(route, params, token);
    }
    return current;
  }

  /**
   * 处理一个 hash（不传 = 当前 location.hash）。
   * @param {string} [hash]
   * @param {{initial?:boolean}} [handleOptions]
   */
  async function handleHash(hash, handleOptions = {}) {
    const info = hash === undefined ? parseRouteHash(getHash()) : parseRouteHash(hash);
    const initial = handleOptions.initial === true;
    if (info.kind === 'anchor') {
      // skip-link 等页面锚点：运行期忽略；首次加载（F5 带锚点）则回到 overview。
      if (!initial) return null;
      return go('#/overview', { replace: true, force: true });
    }
    if (info.kind === 'empty') {
      return go('#/overview', { replace: true, force: true });
    }
    if (info.kind === 'unknown') {
      toast({ kind: 'warn', text: t('app.route.unknown', { route: info.raw || '#' }) });
      return go('#/overview', { replace: true, force: true });
    }
    const route = info.route;
    // fixedParams（如 models 的 group=models）优先级最高：合同 §7.2 规定 #/models 必须以
    // group=models 挂载，hash 里的 group= 不得把它改掉。
    const params = { ...info.params, ...(route.fixedParams ?? {}) };
    const token = (renderToken += 1);
    return renderView(route, params, token);
  }

  /**
   * 导航到目标 hash。
   *   navigate('#/alerts?severity=high')
   *   navigate('alerts', { severity: 'high' }, { replace: true })
   */
  function navigate(target, params, navOptions = {}) {
    const optionsObject = isPlainObject(navOptions) ? navOptions : {};
    let hash;
    if (typeof target === 'string' && target.startsWith('#')) {
      hash = target;
    } else {
      hash = buildHash(String(target ?? 'overview'), isPlainObject(params) ? params : {});
    }
    return go(hash, { replace: optionsObject.replace === true });
  }

  function go(hash, goOptions = {}) {
    const raw = parseRouteHash(getHash()).raw;
    if (raw === hash && goOptions.force !== true) return handleHash(hash);
    suppressNextHash = hash;
    try {
      if (goOptions.replace) replaceHash(hash);
      else setHash(hash);
    } catch (error) {
      if (typeof console !== 'undefined' && console.error) console.error('[router] location change failed', error);
    }
    return handleHash(hash);
  }

  function onHashChange() {
    const info = parseRouteHash(getHash());
    if (suppressNextHash !== null) {
      if (info.raw === suppressNextHash) {
        suppressNextHash = null;
        return;
      }
      suppressNextHash = null;
    }
    const task = handleHash();
    if (task && typeof task.catch === 'function') {
      task.catch((error) => {
        if (typeof console !== 'undefined' && console.error) console.error('[router] hashchange failed', error);
      });
    }
  }

  async function start() {
    if (started) return current;
    started = true;
    if (win && typeof win.addEventListener === 'function') win.addEventListener('hashchange', onHashChange);
    return handleHash(undefined, { initial: true });
  }

  async function stop() {
    if (!started) return;
    started = false;
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('hashchange', onHashChange);
    const entry = current;
    current = null;
    await destroyCurrent(entry);
  }

  /** 重新挂载当前视图（#refresh / 切换语言 / settings 变更后用）。 */
  function refresh() {
    return handleHash(getHash());
  }

  return {
    start,
    stop,
    refresh,
    navigate,
    handleHash,
    routes: ROUTES,
    get current() {
      return current;
    },
    get root() {
      return root;
    },
    get context() {
      return current ? makeContext(routeFor(current.id) ?? null, current.params) : null;
    },
  };
}
