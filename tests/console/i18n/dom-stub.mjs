/**
 * tests/console/i18n/dom-stub.mjs — 只够 i18n 加载器用的假 DOM。
 *
 * 支持面：createElement / getAttribute / setAttribute / hasAttribute / classList /
 * textContent / appendChild / addEventListener / querySelectorAll（只认 data-i18n 三兄弟）。
 * 不支持：布局、CSS、事件冒泡、真实选择器。用到就说明加载器越界了。
 *
 * 作者：PT-dove
 */

const I18N_ATTRS = ['data-i18n', 'data-i18n-attr', 'data-i18n-title'];

function createClassList(store) {
  return {
    add(name) { store.add(name); },
    remove(name) { store.delete(name); },
    contains(name) { return store.has(name); },
    toggle(name, force) {
      if (force === undefined) {
        if (store.has(name)) store.delete(name); else store.add(name);
        return;
      }
      if (force) store.add(name); else store.delete(name);
    },
    values() { return [...store]; },
  };
}

export function createElement(tagName = 'div') {
  const attributes = new Map();
  const classes = new Set();
  const handlers = new Map();
  const node = {
    tagName: String(tagName).toUpperCase(),
    textContent: '',
    value: '',
    children: [],
    classList: createClassList(classes),
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name === 'value') node.value = String(value);
    },
    hasAttribute(name) { return attributes.has(name); },
    appendChild(child) { node.children.push(child); return child; },
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
    },
    dispatch(type, event) {
      for (const handler of handlers.get(type) ?? []) handler(event ?? { type });
    },
    attributes,
  };
  return node;
}

/**
 * 造一个假 document。
 *
 * @param {object[]} [nodes] 预先放进文档的节点（会被 querySelectorAll 扫到）。
 * @returns {object} 假 document。
 */
export function createDocument(nodes = []) {
  const all = [...nodes];
  const doc = {
    readyState: 'complete',
    head: createElement('head'),
    documentElement: createElement('html'),
    createElement(tag) { return createElement(tag); },
    querySelectorAll(selector) {
      const wanted = String(selector)
        .split(',')
        .map((part) => part.trim().replace(/^\[/u, '').replace(/\]$/u, ''))
        .filter((part) => I18N_ATTRS.includes(part));
      if (wanted.length === 0) return [];
      return all.filter((node) => wanted.some((attr) => node.hasAttribute(attr)));
    },
    querySelector(selector) {
      if (String(selector).startsWith('style[')) {
        return doc.head.children.find((child) => child.getAttribute('data-i18n-debug') !== null) ?? null;
      }
      return null;
    },
    addEventListener() {},
    dispatchEvent() { return true; },
    append(node) { all.push(node); return node; },
  };
  return doc;
}

/** 内存 storage，用来断言「切换语言会持久化」。 */
export function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    dump() { return Object.fromEntries(map); },
  };
}
