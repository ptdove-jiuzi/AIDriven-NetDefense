/**
 * UI2-B11 · 最小 DOM shim（零依赖）
 *
 * 目的：让 B1 的 16 个组件能在 `node --test` 里**真实构造/操作 DOM**，
 * 从而对"三关关闭 / focus trap / 焦点回归 / 虚拟滚动 / aria 属性 / 空态"做断言，
 * 而不是只做字符串匹配。
 *
 * 只实现被测代码实际用到的子集（见 B1 组件源码）：
 *   createElement / createElementNS / createTextNode / createDocumentFragment /
 *   getElementById / documentElement / body / activeElement /
 *   appendChild / append / replaceChildren / remove / childNodes / children /
 *   setAttribute / getAttribute / hasAttribute / removeAttribute / classList / style /
 *   textContent / focus / isConnected / addEventListener / dispatchEvent /
 *   clientHeight / scrollTop / getBoundingClientRect（可注入）
 *
 * 明确**不**实现：innerHTML / outerHTML / insertAdjacentHTML / layout CSS。
 * 这些在合同 §7.7 里本来就是禁用 API；shim 不提供它们，才能让"误用即崩溃"暴露出来。
 *
 * 用法：
 *   import { installDom, serialize, visibleText } from './dom-shim.mjs';
 *   const dom = installDom();          // 返回 {document, window, cleanup, roots}
 *   ... const node = button({...}); dom.body.appendChild(node); ...
 *
 * @author PT-dove
 */

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** HTML 布尔属性：property 与 attribute 双向同步。 */
const BOOLEAN_ATTRS = new Set(['disabled', 'required', 'readonly', 'multiple', 'hidden', 'open', 'autofocus']);

/** HTML 表单属性：直接存在实例字段上（serialize 时读 attribute）。 */
const VALUE_ATTRS = new Set(['value', 'checked', 'selected', 'indeterminate', 'tabindex']);

function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

class ShimEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = init.bubbles !== false;
    this.cancelable = init.cancelable !== false;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediatePropagationStopped = false;
    this.target = init.target ?? null;
    this.currentTarget = null;
    this.shiftKey = Boolean(init.shiftKey);
    this.key = init.key ?? '';
    this.code = init.code ?? '';
    this.detail = init.detail ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    Object.assign(this, init);
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
    this.propagationStopped = true;
  }
}

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

class ShimNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
    this._document = null;
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  get lastChild() {
    return this.childNodes.length > 0 ? this.childNodes[this.childNodes.length - 1] : null;
  }

  appendChild(node) {
    return this._insert(node, this.childNodes.length);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      this.appendChild(node);
    }
    return this;
  }

  prepend(...nodes) {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node === null || node === undefined) continue;
      this._insert(node, 0);
    }
    return this;
  }

  _insert(node, index) {
    if (node === null || typeof node !== 'object' || typeof node.nodeType !== 'number') {
      throw new TypeError('appendChild expects a Node');
    }
    if (node.nodeType === 11) {
      const kids = [...node.childNodes];
      for (const child of kids) this._insert(child, this.childNodes.length);
      return node;
    }
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error('removeChild: node is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const incoming = node.nodeType === 11 ? [...node.childNodes] : [node];
      for (const child of incoming) this._insert(child, this.childNodes.length);
    }
    return this;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current.nodeType === 9) return true;
      current = current.parentNode;
    }
    return false;
  }

  addEventListener(type, handler, options) {
    if (typeof handler !== 'function') return;
    const list = this._listeners.get(String(type)) ?? [];
    list.push({ handler, once: Boolean(options && typeof options === 'object' && options.once) });
    this._listeners.set(String(type), list);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(String(type));
    if (!list) return;
    const index = list.findIndex((entry) => entry.handler === handler);
    if (index !== -1) list.splice(index, 1);
  }

  dispatchEvent(event) {
    if (!(event instanceof ShimEvent)) event = new ShimEvent(String(event && event.type), event ?? {});
    if (event.target === null) event.target = this;
    let current = this;
    while (current) {
      event.currentTarget = current;
      const list = current._listeners.get(event.type);
      if (list) {
        for (const entry of [...list]) {
          if (entry.once) current.removeEventListener(event.type, entry.handler);
          entry.handler.call(current, event);
          if (event.immediatePropagationStopped) break;
        }
      }
      if (!event.bubbles || event.propagationStopped) break;
      current = current.parentNode;
    }
    return !event.defaultPrevented;
  }

  /** 不隐藏节点；visibleText 负责按 [hidden]/aria-hidden 过滤。 */
  get textContent() {
    let out = '';
    for (const child of this.childNodes) {
      if (child.nodeType === 3) out += child.data;
      else if (child.nodeType === 1 || child.nodeType === 11) out += child.textContent;
    }
    return out;
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    const text = toText(value);
    if (text !== '') {
      const node = new ShimText(text);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  get ownerDocument() {
    return this._document;
  }
}

class ShimText extends ShimNode {
  constructor(text) {
    super(3, '#text');
    this.data = toText(text);
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = toText(value);
  }

  get nodeValue() {
    return this.data;
  }
}

class ShimDocumentFragment extends ShimNode {
  constructor() {
    super(11, '#document-fragment');
  }
}

class ShimClassList {
  constructor(element) {
    this._element = element;
  }

  _tokens() {
    const raw = this._element.getAttribute('class') ?? '';
    return raw.split(/\s+/u).filter(Boolean);
  }

  _write(tokens) {
    this._element.setAttribute('class', tokens.join(' '));
  }

  add(...names) {
    const tokens = new Set(this._tokens());
    for (const name of names) if (name) tokens.add(String(name));
    this._write([...tokens]);
  }

  remove(...names) {
    const drop = new Set(names.map(String));
    this._write(this._tokens().filter((token) => !drop.has(token)));
  }

  toggle(name, force) {
    const token = String(name);
    const has = this.contains(token);
    const shouldAdd = force === undefined ? !has : Boolean(force);
    if (shouldAdd && !has) this.add(token);
    if (!shouldAdd && has) this.remove(token);
    return shouldAdd;
  }

  contains(name) {
    return this._tokens().includes(String(name));
  }

  get value() {
    return this._tokens().join(' ');
  }

  get length() {
    return this._tokens().length;
  }

  item(index) {
    return this._tokens()[index] ?? null;
  }

  [Symbol.iterator]() {
    return this._tokens()[Symbol.iterator]();
  }
}

class ShimStyle {
  constructor() {
    this._props = new Map();
  }

  setProperty(name, value) {
    this._props.set(String(name), toText(value));
  }

  getPropertyValue(name) {
    return this._props.get(String(name)) ?? '';
  }

  removeProperty(name) {
    const key = String(name);
    const previous = this.getPropertyValue(key);
    this._props.delete(key);
    return previous;
  }

  get cssText() {
    return [...this._props.entries()].map(([key, value]) => `${key}: ${value};`).join(' ');
  }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

class ShimElement extends ShimNode {
  constructor(tagName, namespaceURI = HTML_NS) {
    const upper = String(tagName || 'div').toUpperCase();
    super(1, upper);
    this.tagName = upper;
    this.localName = String(tagName || 'div').toLowerCase();
    this.namespaceURI = namespaceURI;
    this._attributes = new Map();
    this.classList = new ShimClassList(this);
    this.style = new ShimStyle();
    this._rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    this._clientHeight = 0;
    this._clientWidth = 0;
    this._scrollTop = 0;
    this._scrollHeight = 0;
    this._value = '';
    this._checked = false;
    this._selected = false;
    this._indeterminate = false;
    this._tabIndex = -1;
    this._disabled = false;
    this.dataset = this._makeDatasetProxy();
  }

  _makeDatasetProxy() {
    return new Proxy({}, {
      get: (_, key) => {
        if (typeof key !== 'string') return undefined;
        return this.getAttribute('data-' + camelToKebab(key));
      },
      set: (_, key, value) => {
        if (typeof key !== 'string') return false;
        this.setAttribute('data-' + camelToKebab(key), value);
        return true;
      },
      deleteProperty: (_, key) => {
        if (typeof key === 'string') this.removeAttribute('data-' + camelToKebab(key));
        return true;
      },
      ownKeys: () => [...this._attributes.keys()]
        .filter((name) => name.startsWith('data-'))
        .map((name) => kebabToCamel(name.slice(5))),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }

  // ---- attributes ----

  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this._attributes.set(key, toText(value));
    this._syncPropertyFromAttribute(key);
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this._attributes.has(key) ? this._attributes.get(key) : null;
  }

  hasAttribute(name) {
    return this._attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    const key = String(name).toLowerCase();
    this._attributes.delete(key);
    this._syncPropertyFromAttribute(key);
  }

  getAttributeNames() {
    return [...this._attributes.keys()];
  }

  _syncPropertyFromAttribute(key) {
    if (key === 'class') return;
    if (key === 'value') this._value = this._attributes.get('value') ?? '';
    if (key === 'disabled') this._disabled = this.hasAttribute('disabled');
    if (key === 'tabindex') {
      const raw = Number(this._attributes.get('tabindex'));
      this._tabIndex = Number.isFinite(raw) ? raw : -1;
    }
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  // ---- DOM tree helpers ----

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index === -1 ? null : this.parentNode.childNodes[index + 1] ?? null;
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  matches(selector) {
    // 支持空格分隔的后代选择器（如 "tbody tr"、".ui-modal__foot .ui-btn"）。
    const parts = String(selector ?? '').trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) return false;
    if (!this._matchesCompound(parts[parts.length - 1])) return false;
    let index = parts.length - 2;
    let current = this.parentNode;
    while (index >= 0 && current) {
      if (current.nodeType === 1 && current._matchesCompound(parts[index])) index -= 1;
      current = current.parentNode;
    }
    return index < 0;
  }

  _matchesCompound(selector) {
    const parsed = parseSelector(selector);
    if (parsed.tag && parsed.tag !== this.localName) return false;
    if (parsed.id && parsed.id !== this.id) return false;
    if (parsed.classes.some((name) => !this.classList.contains(name))) return false;
    for (const [name, value] of parsed.attrs) {
      if (!this.hasAttribute(name)) return false;
      if (value !== null && this.getAttribute(name) !== value) return false;
    }
    return true;
  }

  closest(selector) {
    let current = this;
    while (current && current.nodeType === 1) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  // ---- focus ----

  focus() {
    if (this._document) this._document.activeElement = this;
    dispatchFocusEvent(this, 'focus');
  }

  blur() {
    if (this._document && this._document.activeElement === this) this._document.activeElement = this._document.body;
    dispatchFocusEvent(this, 'blur');
  }

  // ---- layout stubs（测试可写：el.clientHeight = 240; el.scrollTop = 400; el.__rect = {...}） ----

  get clientHeight() {
    return this._clientHeight;
  }

  set clientHeight(value) {
    this._clientHeight = Number(value) || 0;
  }

  get clientWidth() {
    return this._clientWidth;
  }

  set clientWidth(value) {
    this._clientWidth = Number(value) || 0;
  }

  get offsetHeight() {
    return this._rect.height;
  }

  get offsetWidth() {
    return this._rect.width;
  }

  get scrollTop() {
    return this._scrollTop;
  }

  set scrollTop(value) {
    this._scrollTop = Number(value) || 0;
  }

  get scrollHeight() {
    return this._scrollHeight;
  }

  set scrollHeight(value) {
    this._scrollHeight = Number(value) || 0;
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  // ---- form/boolean properties ----

  get value() {
    return this._value;
  }

  set value(next) {
    // 与真实 DOM 一致：input.value 是**属性（property）**，不反映到 value attribute。
    // 这条差异很重要：凭据 canary 断言"DOM/序列化里零明文"依赖它。
    this._value = toText(next);
  }

  get checked() {
    return this._checked;
  }

  set checked(next) {
    this._checked = Boolean(next);
    if (this._checked) this.setAttribute('checked', '');
    else this.removeAttribute('checked');
  }

  get selected() {
    return this._selected;
  }

  set selected(next) {
    this._selected = Boolean(next);
    if (this._selected) this.setAttribute('selected', '');
    else this.removeAttribute('selected');
  }

  get indeterminate() {
    return this._indeterminate;
  }

  set indeterminate(next) {
    this._indeterminate = Boolean(next);
  }

  get disabled() {
    return this._disabled;
  }

  set disabled(next) {
    this._disabled = Boolean(next);
    if (this._disabled) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }

  get required() {
    return this.hasAttribute('required');
  }

  set required(next) {
    if (next) this.setAttribute('required', '');
    else this.removeAttribute('required');
  }

  get readOnly() {
    return this.hasAttribute('readonly');
  }

  set readOnly(next) {
    if (next) this.setAttribute('readonly', '');
    else this.removeAttribute('readonly');
  }

  get multiple() {
    return this.hasAttribute('multiple');
  }

  set multiple(next) {
    if (next) this.setAttribute('multiple', '');
    else this.removeAttribute('multiple');
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(next) {
    if (next) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  get open() {
    return this.hasAttribute('open');
  }

  set open(next) {
    if (next) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  get tabIndex() {
    return this._tabIndex;
  }

  set tabIndex(next) {
    const value = Number(next);
    this._tabIndex = Number.isFinite(value) ? value : -1;
    this.setAttribute('tabindex', String(this._tabIndex));
  }

  get title() {
    return this.getAttribute('title') ?? '';
  }

  set title(value) {
    this.setAttribute('title', toText(value));
  }

  get type() {
    return this.getAttribute('type') ?? '';
  }

  set type(value) {
    this.setAttribute('type', value);
  }

  setAttributeNode() {
    throw new Error('shim: setAttributeNode is not implemented');
  }
}

function camelToKebab(name) {
  return String(name).replace(/[A-Z]/gu, (match) => '-' + match.toLowerCase());
}

function kebabToCamel(name) {
  return String(name).replace(/-([a-z0-9])/gu, (_, char) => char.toUpperCase());
}

function parseSelector(selector) {
  const raw = String(selector ?? '').trim();
  const out = { tag: null, id: null, classes: [], attrs: [] };
  if (raw === '') return out;
  const attrPattern = /\[([^\]=]+)(?:="([^"]*)")?\]/gu;
  let rest = raw.replace(attrPattern, (_, name, value) => {
    out.attrs.push([name, value === undefined ? null : value]);
    return '';
  });
  const idMatch = rest.match(/#([A-Za-z0-9_-]+)/u);
  if (idMatch) {
    out.id = idMatch[1];
    rest = rest.replace(idMatch[0], '');
  }
  const classMatches = [...rest.matchAll(/\.([A-Za-z0-9_-]+)/gu)];
  for (const match of classMatches) out.classes.push(match[1]);
  rest = rest.replace(/\.[A-Za-z0-9_-]+/gu, '').trim();
  if (rest !== '' && !rest.includes(' ')) out.tag = rest.toLowerCase();
  return out;
}

function dispatchFocusEvent(element, type) {
  const event = new ShimEvent(type, { bubbles: false });
  event.target = element;
  element.dispatchEvent(event);
}

class ShimDocument extends ShimNode {
  constructor() {
    super(9, '#document');
    this._document = this;
    this.documentElement = new ShimElement('html');
    this.documentElement._document = this;
    this.head = new ShimElement('head');
    this.head._document = this;
    this.body = new ShimElement('body');
    this.body._document = this;
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
    this.readyState = 'complete';
  }

  createElement(tagName) {
    const element = new ShimElement(tagName, HTML_NS);
    element._document = this;
    return element;
  }

  createElementNS(namespaceURI, tagName) {
    const element = new ShimElement(tagName, namespaceURI);
    element._document = this;
    return element;
  }

  createTextNode(text) {
    const node = new ShimText(text);
    node._document = this;
    return node;
  }

  createDocumentFragment() {
    const fragment = new ShimDocumentFragment();
    fragment._document = this;
    return fragment;
  }

  getElementById(id) {
    const needle = String(id);
    let found = null;
    const walk = (node) => {
      if (found) return;
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (child.id === needle) {
          found = child;
          return;
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  addEventListener(type, handler, options) {
    return super.addEventListener(type, handler, options);
  }
}

// ---------------------------------------------------------------------------
// 公开工具
// ---------------------------------------------------------------------------

/**
 * 安装一套全新的 DOM 到 globalThis，并返回句柄。
 *
 * @param {{ createRoots?: boolean }} [options]
 * @returns {{
 *   document: ShimDocument,
 *   window: object,
 *   localStorage: object,
 *   roots: {drawer: ShimElement, modal: ShimElement, toast: ShimElement},
 *   cleanup: () => void,
 * }}
 */
export function installDom(options = {}) {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    localStorage: globalThis.localStorage,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    KeyboardEvent: globalThis.KeyboardEvent,
    MouseEvent: globalThis.MouseEvent,
  };
  const document = new ShimDocument();
  const localStorage = createLocalStorage();
  const window = {
    document,
    location: {
      hash: '',
      search: '',
      href: 'http://127.0.0.1/',
      pathname: '/',
      origin: 'http://127.0.0.1',
      replace() {},
      assign() {},
    },
    history: { pushState() {}, replaceState() {}, back() {}, forward() {} },
    localStorage,
    matchMedia: () => ({ matches: false, media: '(prefers-color-scheme: dark)', addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    navigator: { language: 'en', languages: ['en'] },
  };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.localStorage = localStorage;
  globalThis.HTMLElement = ShimElement;
  globalThis.Node = ShimNode;
  globalThis.Event = ShimEvent;
  globalThis.KeyboardEvent = class KeyboardEvent extends ShimEvent {
    constructor(type, init = {}) {
      super(type, init);
    }
  };
  globalThis.MouseEvent = class MouseEvent extends ShimEvent {
    constructor(type, init = {}) {
      super(type, init);
    }
  };

  const roots = { drawer: null, modal: null, toast: null };
  if (options.createRoots !== false) {
    for (const name of ['drawer', 'modal', 'toast']) {
      const root = document.createElement('div');
      root.id = `${name}-root`;
      document.body.appendChild(root);
      roots[name] = root;
    }
  }

  return {
    document,
    window,
    localStorage,
    roots,
    cleanup() {
      restore('document');
      restore('window');
      restore('localStorage');
      restore('HTMLElement');
      restore('Node');
      restore('Event');
      restore('KeyboardEvent');
      restore('MouseEvent');
    },
  };

  /** 还原一个全局；原本不存在就删掉（不要留 ShimEvent 污染 Node 的 EventTarget）。 */
  function restore(key) {
    if (previous[key] === undefined) delete globalThis[key];
    else globalThis[key] = previous[key];
  }
}

export function createLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(String(key)) ? map.get(String(key)) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(String(key));
    },
    clear() {
      map.clear();
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    get length() {
      return map.size;
    },
    dump() {
      return Object.fromEntries(map.entries());
    },
  };
}

export function makeEvent(type, init = {}) {
  return new ShimEvent(type, init);
}

/** 元素是否在渲染树上可见（[hidden] / aria-hidden=true 视为不可见）。 */
export function isVisible(node) {
  let current = node;
  while (current && current.nodeType !== 9) {
    if (current.nodeType === 1) {
      if (current.hasAttribute('hidden')) return false;
      if (current.getAttribute('aria-hidden') === 'true') return false;
    }
    current = current.parentNode;
  }
  return true;
}

/** 渲染后的可见文本（递归、可见节点、去多余空白）。 */
export function visibleText(node) {
  let out = '';
  const walk = (current) => {
    if (!current) return;
    if (current.nodeType === 3) {
      out += current.data;
      return;
    }
    if (current.nodeType === 1) {
      if (!isVisible(current)) return;
      for (const child of current.childNodes) walk(child);
      return;
    }
    for (const child of current.childNodes) walk(child);
  };
  walk(node);
  return out.replace(/\s+/gu, ' ').trim();
}

/** 序列化成 HTML 字符串（仅供断言/诊断，不是生产 API）。 */
export function serialize(node) {
  if (node === null || node === undefined) return '';
  if (node.nodeType === 3) return escapeHtml(node.data);
  if (node.nodeType === 11) return node.childNodes.map(serialize).join('');
  const attributes = node.getAttributeNames()
    .sort()
    .map((name) => {
      const value = node.getAttribute(name);
      return value === '' ? name : `${name}="${escapeHtml(value)}"`;
    })
    .join(' ');
  const open = `<${node.localName}${attributes ? ' ' + attributes : ''}>`;
  if (VOID_TAGS.has(node.localName)) return open;
  return `${open}${node.childNodes.map(serialize).join('')}</${node.localName}>`;
}

function escapeHtml(value) {
  return toText(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/** 统计元素节点数（不递归文本节点），用于虚拟滚动断言。 */
export function countElements(node) {
  let count = node.nodeType === 1 ? 1 : 0;
  for (const child of node.childNodes) count += countElements(child);
  return count;
}
