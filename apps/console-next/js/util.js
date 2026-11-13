/**
 * AIDriven NetDefense · WebUI v2 · 通用工具（零依赖）
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.2 / §7.5 / §7.9 / §8.4
 * - hash 路由的解析/构造（查询串在 hash 内，前进/后退天然恢复）；
 * - URL 覆盖参数 ?theme=&lang=&static=1 的解析（只读，不落 localStorage）；
 * - theme=system 的 prefers-color-scheme 解析（可注入 matchMedia，便于自检）；
 * - 自动刷新间隔计算（static=1 → 0，即关闭轮询）；
 * - 数值/日期格式化统一走 Intl（禁止手拼，合同 §8.4）。
 *
 * 本文件不访问 DOM（除 format 使用的 Intl），可在 Node 里直接做纯函数自检。
 */

/** 允许的 theme 偏好值（解析后落 DOM 的只能是 dark/light）。 */
export const THEME_VALUES = Object.freeze(['dark', 'light', 'system']);

/** 允许的密度值。 */
export const DENSITY_VALUES = Object.freeze(['comfortable', 'compact']);

/** 自动刷新默认间隔（合同 §6 ui.autoRefreshMs 默认 10000，0=关）。 */
export const DEFAULT_AUTO_REFRESH_MS = 10000;

/** 轮询下限，避免配置把主线程打满。 */
export const MIN_AUTO_REFRESH_MS = 1000;

/** ?lang= 允许的形状；具体是否 7 语言之一由 i18n.js 判定。 */
const LANG_PARAM_PATTERN = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u;

/** @param {unknown} value @returns {boolean} 普通对象（非 null / 非数组） */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 安全 JSON 解析：失败返回 fallback，不抛错（首屏读缓存用）。
 * @template T
 * @param {string|null|undefined} text
 * @param {T} fallback
 * @returns {T|any}
 */
export function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** @param {number} value @param {number} min @param {number} max @returns {number} */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

let idSeq = 0;

/**
 * 确定性 id（不用随机数，便于截图/自检稳定复现）。
 * @param {string} [prefix]
 * @returns {string}
 */
export function uniqueId(prefix = 'id') {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/**
 * 防抖。返回的函数附带 cancel()。
 * @param {Function} fn
 * @param {number} [wait]
 */
export function debounce(fn, wait = 150) {
  if (typeof fn !== 'function') throw new TypeError('[util] debounce 需要函数');
  let timer = null;
  function debounced(...args) {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, Math.max(0, Number(wait) || 0));
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/**
 * 解析查询串为普通对象（同名参数取第一个，值做 decode；非法编码保留原文）。
 * @param {string} input 允许带前导 "?"
 * @returns {Record<string,string>}
 */
export function parseQueryString(input) {
  const out = {};
  const raw = typeof input === 'string' ? input.replace(/^\?/u, '') : '';
  if (raw === '') return out;
  for (const part of raw.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    const key = decodePart(rawKey);
    if (key === '') continue;
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = decodePart(rawValue);
  }
  return out;
}

function decodePart(value) {
  try {
    return decodeURIComponent(value.replace(/\+/gu, ' '));
  } catch {
    return value;
  }
}

/**
 * 参数对象 → 查询串（键排序，保证同一状态生成同一 hash；空值跳过）。
 * @param {Record<string, unknown>|null|undefined} params
 * @returns {string} 不含 "?"；无参数时为空串
 */
export function toQueryString(params) {
  if (!isPlainObject(params)) return '';
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const key of keys) {
    const value = params[key];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || item === undefined || item === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * 解析 location.hash。
 *
 * 返回 kind：
 * - `empty`：空 hash / `#` / `#/`（首屏应 replace 成 `#/overview`）；
 * - `anchor`：非 `#/…` 形状的页面锚点（如 skip-link 的 `#view-root`）——路由必须忽略，
 *   合同 §7.1 明确要求页面锚点不得破坏 hash 路由；
 * - `route`：`#/<name>[?query]`。
 *
 * @param {string} hash
 * @returns {{kind:'empty'|'anchor'|'route', name:string, params:Record<string,string>, query:string, raw:string}}
 */
export function parseHash(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  const body = raw.startsWith('#') ? raw.slice(1) : raw;
  if (body === '' || body === '/') {
    return { kind: 'empty', name: '', params: {}, query: '', raw };
  }
  if (!body.startsWith('/')) {
    return { kind: 'anchor', name: body, params: {}, query: '', raw };
  }
  const routePart = body.slice(1);
  const qIndex = routePart.indexOf('?');
  const pathPart = qIndex === -1 ? routePart : routePart.slice(0, qIndex);
  const query = qIndex === -1 ? '' : routePart.slice(qIndex + 1);
  const name = pathPart.replace(/\/+$/u, '').toLowerCase();
  if (name === '') {
    return { kind: 'empty', name: '', params: {}, query: '', raw };
  }
  return { kind: 'route', name, params: parseQueryString(query), query, raw };
}

/**
 * 构造 hash（键排序；空值跳过）。
 * @param {string} name 视图 id（不带 `#/`）
 * @param {Record<string, unknown>} [params]
 * @returns {string} 形如 `#/alerts?page=2&severity=high`
 */
export function buildHash(name, params) {
  const cleanName = String(name == null ? '' : name).replace(/^#?\/?/u, '').replace(/\/+$/u, '');
  const query = toQueryString(params);
  if (cleanName === '') return '#/overview';
  return query === '' ? `#/${cleanName}` : `#/${cleanName}?${query}`;
}

/**
 * 解析确定性截图/覆盖参数：?theme=&lang=&static=1（合同 §7.9）。
 * 非法值一律忽略（回落本地偏好），不抛错。
 *
 * @param {string} search location.search（可带 "?"）
 * @returns {{theme:string|null, lang:string|null, static:boolean, raw:Record<string,string>}}
 */
export function parseOverrides(search) {
  const params = parseQueryString(search);
  const theme = THEME_VALUES.includes(String(params.theme)) ? String(params.theme) : null;
  const lang = LANG_PARAM_PATTERN.test(String(params.lang ?? '')) ? String(params.lang) : null;
  const staticFlag = String(params.static ?? '').toLowerCase();
  const staticMode = staticFlag === '1' || staticFlag === 'true' || staticFlag === 'yes';
  return { theme, lang, static: staticMode, raw: params };
}

/**
 * theme=system 时解析 prefers-color-scheme；其余偏好原样返回。
 * matchMedia 缺失/抛错时按暗色（产品默认）处理，绝不抛错。
 *
 * @param {string} preference dark|light|system
 * @param {{matchMedia?: Function}} [options]
 * @returns {{preference:string, resolved:'dark'|'light', source:'preference'|'system'}}
 */
export function resolveTheme(preference, options = {}) {
  const pref = THEME_VALUES.includes(preference) ? preference : 'dark';
  if (pref !== 'system') {
    return { preference: pref, resolved: pref, source: 'preference' };
  }
  const matchMedia =
    typeof options.matchMedia === 'function'
      ? options.matchMedia
      : typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia.bind(globalThis)
        : null;
  let prefersDark = true;
  if (matchMedia) {
    try {
      const query = matchMedia('(prefers-color-scheme: dark)');
      if (query && typeof query.matches === 'boolean') {
        prefersDark = query.matches;
      } else if (query && typeof query.media === 'string' && query.media !== '') {
        // 少数实现只给 media 字符串
        prefersDark = query.media.includes('dark');
      }
    } catch {
      prefersDark = true;
    }
  }
  return { preference: 'system', resolved: prefersDark ? 'dark' : 'light', source: 'system' };
}

/**
 * 自动刷新间隔（毫秒）；0 表示关闭。
 * static=1（合同 §7.9）必须关闭自动刷新，优先级高于配置。
 *
 * @param {{autoRefreshMs?:number, staticMode?:boolean, minMs?:number}} [options]
 * @returns {number}
 */
export function computePollMs(options = {}) {
  if (options.staticMode) return 0;
  const raw = Number(options.autoRefreshMs);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const min = Number.isFinite(Number(options.minMs)) ? Math.max(0, Number(options.minMs)) : MIN_AUTO_REFRESH_MS;
  return Math.max(min, Math.round(raw));
}

/** @param {unknown} value @param {string} [locale] @returns {string} */
export function formatNumber(value, locale = 'en') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}

/** @param {string|number|Date|null|undefined} value @param {string} [locale] @returns {string} */
export function formatDateTime(value, locale = 'en') {
  const date = toDate(value);
  if (date === null) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * 相对时间；static=1 时（合同 §7.9「固定相对时间显示」）退回绝对时间，保证截图基线稳定。
 * @param {string|number|Date|null|undefined} value
 * @param {{locale?:string, now?:number, staticMode?:boolean}} [options]
 * @returns {string}
 */
export function formatRelativeTime(value, options = {}) {
  const locale = options.locale ?? 'en';
  const date = toDate(value);
  if (date === null) return '—';
  if (options.staticMode) return formatDateTime(date, locale);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const deltaSeconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(deltaSeconds);
  const table = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [86400 * 30, 'day'],
    [86400 * 365, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  const divisors = { second: 1, minute: 60, hour: 3600, day: 86400, month: 86400 * 30, year: 86400 * 365 };
  let unit = 'second';
  let amount = deltaSeconds;
  for (const [limit, name] of table) {
    if (abs < limit) {
      unit = name;
      amount = Math.round(deltaSeconds / divisors[name]);
      break;
    }
  }
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit);
  } catch {
    return formatDateTime(date, locale);
  }
}

/**
 * 列表/详情统一的“时间戳”渲染入口：static=1 用绝对时间，否则相对时间。
 * @param {*} value
 * @param {{locale?:string, now?:number, staticMode?:boolean}} [options]
 */
export function formatTimestamp(value, options = {}) {
  return options.staticMode ? formatDateTime(value, options.locale ?? 'en') : formatRelativeTime(value, options);
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return Number.isFinite(fromNumber.getTime()) ? fromNumber : null;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}
