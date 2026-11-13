/**
 * AIDriven NetDefense · WebUI v2 · DOM 构造唯一入口
 * B1 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.6 / §7.7
 * - 禁止 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function；
 *   本文件遇到这些 prop 名会直接 throw，防止后人绕过。
 * - 用户数据一律 textContent / createTextNode。
 * - 行内样式只允许 CSS 自定义属性（style.setProperty('--x', v)）。
 * - 链接 href 白名单：http(s): / #/ (# 锚点) / mailto:；其它一律降级为 '#'。
 *
 * 导出（稳定）：el(tag, props, children) · text(value) · frag(...children)
 *              · icon(name, {size}) · cls(...parts)
 */

const PROPS_FORBIDDEN = new Set([
  'html',
  'innerhtml',
  'outerhtml',
  'outertext',
  'innertext',
  'insertadjacenthtml',
  'dangerouslysetinnerhtml',
  'srcdoc',
  'is',
]);

const PROP_KEYS = new Set([
  'id',
  'type',
  'name',
  'value',
  'href',
  'src',
  'srcset',
  'alt',
  'title',
  'role',
  'for',
  'htmlFor',
  'tabIndex',
  'disabled',
  'checked',
  'selected',
  'indeterminate',
  'hidden',
  'open',
  'placeholder',
  'maxLength',
  'minLength',
  'rows',
  'cols',
  'min',
  'max',
  'step',
  'pattern',
  'accept',
  'autocomplete',
  'autoComplete',
  'autofocus',
  'required',
  'readOnly',
  'multiple',
  'spellcheck',
  'draggable',
  'dir',
  'lang',
  'scope',
  'colSpan',
  'rowSpan',
  'ariaLabel',
  'ariaHidden',
]);

const EVENT_SHORTCUT = /^on([A-Z][A-Za-z]+)$/;
const warned = new Set();

function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== 'undefined' && console.warn) console.warn('[dom] ' + message);
}

/**
 * 链接白名单：http(s): / # / mailto:。
 * 其余（javascript:、data:、vbscript:、相对路径）一律降级为 '#' 并警告一次。
 */
function safeHref(raw) {
  let value = raw == null ? '' : String(raw).trim();
  if (value === '') return '#';
  // 先剥掉控制字符/空白，防止 "java\nscript:" 绕过
  const probe = value.replace(/[\u0000-\u0020\u007f]+/g, '');
  if (probe.startsWith('#') || /^https?:\/\//i.test(probe) || /^mailto:/i.test(probe)) {
    return value;
  }
  warnOnce('href 不在白名单（http(s):/#/mailto:），已降级为 "#"：' + value.slice(0, 80));
  return '#';
}

function normalizeClass(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(normalizeClass).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return Object.keys(value)
      .filter((key) => value[key])
      .join(' ');
  }
  return String(value);
}

/** 把任意 children 描述追加到 parent（只走 text node / 元素） */
function appendChildren(parent, children) {
  if (children == null || children === false || children === true) return;
  if (Array.isArray(children)) {
    for (const child of children) appendChildren(parent, child);
    return;
  }
  if (typeof children === 'string' || typeof children === 'number') {
    parent.appendChild(document.createTextNode(String(children)));
    return;
  }
  if (typeof children === 'object' && typeof children.nodeType === 'number') {
    parent.appendChild(children);
    return;
  }
  throw new TypeError('[dom] 不支持的 child 类型：' + Object.prototype.toString.call(children));
}

function setStyles(node, style) {
  if (!style) return;
  for (const [key, value] of Object.entries(style)) {
    if (value == null) continue;
    if (!key.startsWith('--')) {
      // 合同 §7.7：行内样式只允许 CSS 变量
      warnOnce('style 只接受 CSS 自定义属性（--x），忽略：' + key);
      continue;
    }
    node.style.setProperty(key, String(value));
  }
}

function setProp(node, key, value) {
  if (value == null) return;
  const tag = node.tagName;
  const isForm = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION';

  if (key === 'ariaLabel') {
    if (value === '') node.removeAttribute('aria-label');
    else node.setAttribute('aria-label', String(value));
    return;
  }
  if (key === 'ariaHidden') {
    node.setAttribute('aria-hidden', value ? 'true' : 'false');
    return;
  }
  if (key === 'htmlFor' || key === 'for') {
    if (value === '' || value == null) return;
    node.setAttribute('for', String(value));
    return;
  }
  if (key === 'autocomplete' || key === 'autoComplete') {
    node.setAttribute('autocomplete', String(value));
    return;
  }
  if (key === 'href') {
    node.setAttribute('href', safeHref(value));
    return;
  }
  if (key === 'value' && isForm) {
    node.value = value == null ? '' : String(value);
    return;
  }
  if (key === 'checked' || key === 'selected' || key === 'indeterminate') {
    node[key] = Boolean(value);
    return;
  }
  if (key === 'disabled' || key === 'required' || key === 'readOnly' || key === 'multiple' || key === 'hidden' || key === 'open') {
    if (key === 'readOnly') {
      // D15：必须按 value 真假**成对**写 property + 属性。
      // field.js 的 input()/textarea() 永远传 readOnly（默认 false），旧代码对 false 也
      // setAttribute('readonly','') → 浏览器按属性把元素变成只读（全站文本框只能看不能打）。
      node.readOnly = Boolean(value);
      if (value) node.setAttribute('readonly', '');
      else node.removeAttribute('readonly');
      return;
    }
    node[key] = Boolean(value);
    return;
  }
  if (key === 'tabIndex') {
    node.tabIndex = Number(value);
    return;
  }
  if (key === 'colSpan' || key === 'rowSpan') {
    node.setAttribute(key.toLowerCase(), String(value));
    return;
  }
  if (key === 'className') {
    node.setAttribute('class', normalizeClass(value));
    return;
  }
  if (!PROP_KEYS.has(key)) {
    // 未识别：按 HTML 属性写入（布尔 true 写成空串）
    if (value === false) return;
    node.setAttribute(key, value === true ? '' : String(value));
    return;
  }
  if (value === false) {
    node.removeAttribute(key);
    return;
  }
  node.setAttribute(key, value === true ? '' : String(value));
}

/**
 * el(tag, props, children) → HTMLElement
 * props:
 *   class / className   string | array | {name:bool}
 *   text                文本内容（走 textContent）
 *   aria / data         {k: v} → aria-* / data-*
 *   attrs               {k: v} → setAttribute 兜底
 *   style               {"--x": v} → CSS 变量
 *   on                  {click: fn, ...}
 *   onXxx               onClick / onInput / ... 等捷径
 *   properties          {value, checked, ...} 直接写 DOM 属性
 *   ref                 fn(node) 构造后回调
 *   其它                PROP_KEYS 内走属性，其余走 setAttribute
 */
export function el(tag, props, children) {
  if (typeof tag !== 'string' || tag === '') {
    throw new TypeError('[dom] el(tag) 需要非空字符串');
  }
  const node = document.createElement(tag);
  const p = props == null ? {} : props;
  if (typeof p !== 'object') throw new TypeError('[dom] props 必须是对象');

  for (const key of Object.keys(p)) {
    if (PROPS_FORBIDDEN.has(key.toLowerCase())) {
      throw new Error('[dom] 禁止的 prop：' + key + '（合同 §7.7 禁用 innerHTML 一类 API）');
    }
  }

  if (p.class != null || p.className != null) {
    const value = normalizeClass(p.class ?? p.className);
    if (value) node.setAttribute('class', value);
  }
  if (p.attrs && typeof p.attrs === 'object') {
    for (const [key, value] of Object.entries(p.attrs)) {
      if (value == null || value === false) continue;
      if (key === 'href') node.setAttribute('href', safeHref(value));
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  if (p.aria && typeof p.aria === 'object') {
    for (const [key, value] of Object.entries(p.aria)) {
      if (value == null || value === false) continue;
      node.setAttribute('aria-' + key, value === true ? 'true' : String(value));
    }
  }
  if (p.data && typeof p.data === 'object') {
    for (const [key, value] of Object.entries(p.data)) {
      if (value == null || value === false) continue;
      node.setAttribute('data-' + key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), String(value));
    }
  }
  setStyles(node, p.style);

  const listeners = p.on && typeof p.on === 'object' ? p.on : {};
  for (const [event, handler] of Object.entries(listeners)) {
    if (typeof handler !== 'function') continue;
    node.addEventListener(event, handler);
  }
  for (const [key, value] of Object.entries(p)) {
    const match = EVENT_SHORTCUT.exec(key);
    if (match && typeof value === 'function') {
      node.addEventListener(match[1].toLowerCase(), value);
    }
  }

  if (p.properties && typeof p.properties === 'object') {
    for (const [key, value] of Object.entries(p.properties)) setProp(node, key, value);
  }
  for (const [key, value] of Object.entries(p)) {
    if (
      key === 'class' ||
      key === 'className' ||
      key === 'attrs' ||
      key === 'aria' ||
      key === 'data' ||
      key === 'style' ||
      key === 'on' ||
      key === 'text' ||
      key === 'properties' ||
      key === 'ref' ||
      EVENT_SHORTCUT.test(key)
    ) {
      continue;
    }
    setProp(node, key, value);
  }

  if (p.text != null) node.textContent = String(p.text);
  if (children != null) appendChildren(node, children);
  if (typeof p.ref === 'function') p.ref(node);
  return node;
}

/** text(value) → Text node（null/undefined → 空文本节点） */
export function text(value) {
  return document.createTextNode(value == null ? '' : String(value));
}

/** frag(...children) → DocumentFragment */
export function frag(...children) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

/**
 * icon(name, {size}) → <svg class="ui-icon" aria-hidden="true"><use href="#i-name"/></svg>
 * 图标集定义在 index.html / demo.html 的内联 sprite 里（<symbol id="i-*">）。
 */
export function icon(name, options) {
  const opts = options == null ? {} : options;
  const raw = String(name == null ? '' : name)
    .trim()
    .replace(/^#?i-/, '');
  const safe = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ui-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (opts.size != null) {
    const size = String(opts.size);
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
  }
  if (safe) {
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + safe);
    svg.appendChild(use);
  }
  return svg;
}

/**
 * cls(...parts) → 'a b c'
 * 接受字符串、字符串数组、{name: boolean} 映射；忽略 falsy。
 */
export function cls(...parts) {
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === 'string') {
      if (part.trim()) out.push(part.trim());
      continue;
    }
    if (Array.isArray(part)) {
      const nested = cls(...part);
      if (nested) out.push(nested);
      continue;
    }
    if (typeof part === 'object') {
      for (const key of Object.keys(part)) if (part[key]) out.push(key);
    }
  }
  return out.join(' ');
}
