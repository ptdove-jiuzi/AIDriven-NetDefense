/**
 * tests/console/dom-harness.mjs — 一个刚够用的假 DOM，用来在 node 里跑一次真实的 boot()。
 *
 * 为什么需要它：`console-ui.test.js` 只测纯函数与渲染函数，boot() 里的拼装错误
 * （写错 id、漏绑事件、paint 顺序不对）在那层是看不见的。真正的浏览器又不在门禁里，
 * 所以这里实现最小面：按 id 取元素、记录 innerHTML / textContent、支持 addEventListener
 * 与 dataset / classList。断言因此落在「页面最终写出了什么字符串」上，而不是排版。
 *
 * 刻意不支持的能力（用到就说明代码在依赖真实浏览器）：
 *   - 真实选择器（只认 `section.view[data-view="x"]` 与 `.dot`）
 *   - 真实节点树（appendChild 只记到 children 数组，不做查询）
 *   - 布局、CSS、事件冒泡
 *
 * 作者：PT-dove
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.resolve(HERE, '..', '..', 'apps', 'console');
const JS = fs.readFileSync(path.join(CONSOLE_DIR, 'app.js'), 'utf8');

function createElement(id, tagName = 'div') {
  const classes = new Set();
  return {
    id,
    tagName: tagName.toUpperCase(),
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    disabled: false,
    dataset: {},
    attributes: {},
    children: [],
    handlers: {},
    focused: false,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name); else classes.add(name);
          return;
        }
        if (force) classes.add(name); else classes.delete(name);
      },
    },
    addEventListener(type, handler) {
      (this.handlers[type] ??= []).push(handler);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    focus() { this.focused = true; },
    querySelector(selector) {
      return selector === '.dot' ? (this.dot ?? null) : null;
    },
    closest() { return null; },
    /** 测试用：触发已登记的事件。 */
    emit(type, event) {
      for (const handler of this.handlers[type] ?? []) {
        handler(event);
      }
    },
  };
}

function createStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

/**
 * @param {{status?: object, alerts?: object, analyses?: object, failNetwork?: boolean,
 *   failStatus?: number, hash?: string, protocol?: string}} options 场景。
 * @returns {{sandbox: object, get: (id: string) => object, flush: () => Promise<void>,
 *   requests: object[]}}
 */
export function createHarness(options = {}) {
  const settings = { hash: '', protocol: 'http:', ...options };
  const elements = new Map();
  const views = new Map();
  const requests = [];

  function get(id) {
    if (!elements.has(id)) {
      elements.set(id, createElement(id));
    }
    return elements.get(id);
  }

  for (const name of ['overview', 'alerts', 'analysis', 'settings']) {
    views.set(name, createElement(`view-${name}`, 'section'));
  }
  // pill 里的状态点：paintChrome 会通过 querySelector('.dot') 去改它的 tone。
  get('conn-pill').dot = createElement('conn-pill-dot', 'span');

  function responseOf(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
      json: async () => body,
    };
  }

  async function fetchStub(url) {
    requests.push(url);
    if (settings.failNetwork === true) {
      throw new TypeError('Failed to fetch');
    }
    if (settings.failHtml === true) {
      // 静态服务器对 /api/v1/* 的 404：不是 JSON，也不是 daemon 的错误体。
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'text/html; charset=utf-8' },
        json: async () => { throw new SyntaxError('not json'); },
      };
    }
    if (typeof settings.failStatus === 'number') {
      return responseOf({ error: { code: 'AUTH_REQUIRED', message: 'authentication required' } }, settings.failStatus);
    }
    if (url.includes('/api/v1/status')) {
      return responseOf(settings.status ?? {});
    }
    if (url.includes('/api/v1/alerts')) {
      return responseOf(settings.alerts ?? { alerts: [], page: { limit: 50, returned: 0, has_more: false, next_cursor: null, order: 'last_seen_desc', byte_limited: false } });
    }
    if (url.includes('/api/v1/analysis')) {
      return responseOf(settings.analyses ?? { analyses: [], page: { limit: 50, returned: 0, has_more: false, next_cursor: null, order: 'created_at_desc', byte_limited: false } });
    }
    return responseOf({ error: { code: 'NOT_FOUND', message: 'no such endpoint' } }, 404);
  }

  const document = {
    readyState: 'complete',
    hidden: false,
    handlers: {},
    getElementById(id) { return get(id); },
    querySelector(selector) {
      const view = /^section\.view\[data-view="([a-z]+)"\]$/u.exec(selector);
      return view === null ? null : (views.get(view[1]) ?? null);
    },
    querySelectorAll(selector) {
      if (selector === 'tr.is-open') {
        return [];
      }
      return [];
    },
    createElement(tagName) { return createElement('', tagName); },
    createDocumentFragment() { return createElement('', 'fragment'); },
    addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); },
    emit(type, event) {
      for (const handler of this.handlers[type] ?? []) {
        handler(event);
      }
    },
  };

  const windowHandlers = {};
  const sandbox = {
    document,
    location: { protocol: settings.protocol, host: '127.0.0.1:8788', hash: settings.hash, search: '' },
    fetch: fetchStub,
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    performance: { now: () => Date.now() },
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener(type, handler) { (windowHandlers[type] ??= []).push(handler); },
    console,
    URLSearchParams,
  };

  vm.createContext(sandbox);
  vm.runInContext(JS, sandbox, { filename: 'apps/console/app.js' });

  /** 让 boot() 里 fire-and-forget 的 fetch 链走完。 */
  async function flush() {
    for (let index = 0; index < 6; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /** 模拟 hash 变化：改 location.hash 再派发 window 的 hashchange。 */
  async function go(hash) {
    sandbox.location.hash = hash;
    for (const handler of windowHandlers.hashchange ?? []) {
      handler({ type: 'hashchange' });
    }
    await flush();
  }

  return { sandbox, get, flush, go, requests, document, views };
}

export { CONSOLE_DIR };
