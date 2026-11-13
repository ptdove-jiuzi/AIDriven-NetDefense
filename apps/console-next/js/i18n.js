/**
 * AIDriven NetDefense · WebUI v2 · i18n（零依赖）
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §8
 *
 * 1. 7 语言：en / zh-CN / ja / ko / es / ru / th，文件由 B10 产出
 *    （`apps/console-next/i18n/locales/<locale>.json`，扁平点键）。
 * 2. **B10 尚未交付时也必须能跑**：任何语言文件加载失败 → 记 loadFailures，
 *    并以内置 en 最小字典兜底（覆盖外壳自身文案与全部错误码）；
 *    绝不因缺文件而抛错、白屏或阻塞首屏。
 * 3. 回落链：当前语言 → en；两级全缺 → 渲染 `[missing:<key>]` 并累加
 *    `missingCount()`（合同 §8.5：禁止静默空白）。
 *    **2026-11-05 变更（用户硬要求，偏离合同 §8.5 字面）**：不再回落 zh-CN。
 *    原「→ zh-CN」第二回落会让 **locale=en 时缺 key 渲染中文**（英文界面漏中文）；
 *    ja/ko/es/ru/th 缺 key 出中文同样是缺陷。故 chain 只有 [当前语言, en]，
 *    `SECOND_FALLBACK_LOCALE` 仅为兼容导出保留，不参与回落。
 * 4. 切换语言不刷新页面（setLocale → apply → 由 app 重新渲染当前视图），
 *    同步 `<html lang>`；`window.__I18N__` 暴露调试入口。
 * 5. apply() 处理 `data-i18n`（textContent）、`data-i18n-aria`（aria-label）、
 *    `data-i18n-title`（title），可选 `data-i18n-vars`（JSON 占位符）。
 */

import { isPlainObject } from './util.js';

/** 支持的语言（顺序即语言选择器顺序）。 */
export const LOCALES = Object.freeze(['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th']);

/** 源语言 / 第一回落。 */
export const FALLBACK_LOCALE = 'en';

/**
 * 历史第二回落：**已退出回落链**（2026-11-05，用户硬要求：缺 key 只回落 en，绝不回落中文）。
 * 保留导出只为兼容既有 import；不要把它加回 `chain()`——那会让英文界面出现中文。
 */
export const SECOND_FALLBACK_LOCALE = 'zh-CN';

/** 默认语言（合同 §6 ui.locale 默认 zh-CN）。 */
export const DEFAULT_LOCALE = 'zh-CN';

/** 语言原生名（语言切换列表按 native name 显示）。 */
export const NATIVE_NAMES = Object.freeze({
  en: 'English',
  'zh-CN': '简体中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  ru: 'Русский',
  th: 'ไทย',
});

/**
 * 内置 en 最小字典：外壳（app/router/store）自身用到的 key + 全部错误码。
 * B10 的 `i18n/locales/en.json` 一旦存在，会**合并覆盖**这里的同名 key
 * （内置只是安全网，不是文案来源）。
 */
export const BUILTIN_EN = Object.freeze({
  'a11y.skip-to-content': 'Skip to main content',
  'app.product-zh': '网域智防',
  'app.title': 'AIDriven NetDefense',
  'nav.aria': 'Main navigation',
  'nav.overview': 'Overview',
  'nav.alerts': 'Alerts',
  'nav.analysis': 'Analysis',
  'nav.agent': 'Agent',
  'nav.models': 'Models & usage',
  'nav.settings': 'Settings',
  'app.theme.toggle': 'Toggle theme',
  'app.theme.dark': 'Dark',
  'app.theme.light': 'Light',
  'app.theme.system': 'System',
  'app.theme.current': 'Theme: {theme}',
  'app.lang.toggle': 'Change language',
  'app.lang.menu': 'Choose language',
  'app.lang.current': 'Language: {language}',
  'app.route.unknown': 'Unknown page "{route}" — opened Overview instead.',
  'app.conn.idle': 'Checking…',
  'app.conn.online': 'Online',
  'app.conn.degraded': 'Degraded',
  'app.conn.offline': 'Offline',
  'app.conn.version': 'Daemon {version}',
  'app.error.unexpected': 'Something went wrong. Please try again.',
  'app.view-unavailable-hint': 'This page is not available in this build. The rest of the console keeps working.',
  'common.action.refresh': 'Refresh',
  'common.action.retry': 'Retry',
  'common.action.close': 'Close',
  'common.action.loading': 'Loading…',
  'common.state.empty': 'No data',
  'errors.unknown': 'Something went wrong.',
  'errors.UNKNOWN': 'Something went wrong.',
  'errors.view-unavailable': 'This page is not implemented yet.',
  'errors.NETWORK': 'Cannot reach the local console host.',
  'errors.ABORTED': 'The request was cancelled.',
  'errors.BAD_RESPONSE': 'The console host returned an unexpected response.',
  'errors.HTTP_ERROR': 'The request failed.',
  'errors.SSE_MALFORMED': 'The event stream contained a malformed frame.',
  'errors.AUTH_REQUIRED': 'Authentication is required.',
  'errors.AUTH_FAILED': 'Authentication failed.',
  'errors.AUTH_RATE_LIMITED': 'Too many authentication attempts; wait a moment.',
  'errors.FORBIDDEN': 'You are not allowed to do that.',
  'errors.NOT_FOUND': 'The requested resource was not found.',
  'errors.METHOD_NOT_ALLOWED': 'That action is not supported.',
  'errors.CONFLICT': 'The request conflicts with the current state.',
  'errors.RATE_LIMITED': 'Too many requests; try again shortly.',
  'errors.BODY_TOO_LARGE': 'The request body is too large.',
  'errors.CONTENT_TYPE_REJECTED': 'The request body must be JSON.',
  'errors.ORIGIN_REJECTED': 'The request origin was rejected.',
  'errors.CSRF_REQUIRED': 'The request was missing a security header.',
  'errors.REQUEST_TIMEOUT': 'The request timed out.',
  'errors.INTERNAL': 'The local service hit an internal error.',
  'errors.QUERY_INVALID': 'The query parameters are invalid.',
  'errors.CURSOR_INVALID': 'The page cursor is invalid or expired.',
  'errors.PROVIDER_UNKNOWN': 'That model provider is not configured.',
  'errors.PROVIDER_INVALID': 'The provider configuration is invalid.',
  'errors.PROVIDER_LIMIT': 'You reached the provider limit (8).',
  'errors.PROVIDER_DUPLICATE': 'A provider with that id already exists.',
  'errors.PROVIDER_DISABLED': 'That provider is disabled.',
  'errors.EGRESS_DISABLED': 'Outbound model access is turned off.',
  'errors.CREDENTIAL_MISSING': 'No API key is stored for that provider.',
  'errors.CREDENTIAL_INVALID': 'That API key is not in a valid format.',
  'errors.CREDENTIAL_STORE_UNAVAILABLE': 'The credential store is unavailable.',
  'errors.MODEL_UNKNOWN': 'That model is not registered.',
  'errors.SETTINGS_INVALID': 'The settings document is invalid.',
  'errors.SETTINGS_LOCKED': 'That provider still holds a key; confirm discarding it first.',
  'errors.ENGINE_UNAVAILABLE': 'No chat engine is available yet.',
  'errors.CHAT_INVALID': 'The chat request is invalid.',
  'errors.CHAT_BUSY': 'A chat is already running; try again in a moment.',
  'errors.ALERT_NOT_FOUND': 'That alert does not exist (any more).',
  'errors.CALL_UNKNOWN': 'That approval request expired or is unknown.',
  'errors.EXECUTION_DISABLED': 'Response actions are not executed in this version.',
  'errors.UPSTREAM_FAILED': 'The model provider failed.',
  'errors.UPSTREAM_TIMEOUT': 'The model provider did not answer in time.',
  'errors.UPSTREAM_REDIRECT': 'The model provider redirected the request; redirects are refused.',
  'errors.NOT_IMPLEMENTED': 'This action is not implemented in this version.',
});

/** 占位符形状：{name}（合同 §8.4）。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/gu;

/** 键语法（合同 §8.3 v1.2：全小写 + kebab；唯一例外是 errors.<UPPER_SNAKE>）。 */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/u;

/**
 * 过渡别名：`apps/console-next/index.html`（主控写域）里仍有 2 个 v1.0 时代的
 * camelCase key。主控改成 kebab 后应删除此表；locale 文件一律只写 kebab key，
 * 本表不支持写入、也不参与 B10 的校验。
 */
const LEGACY_KEY_ALIASES = Object.freeze({
  'a11y.skipToContent': 'a11y.skip-to-content',
  'app.productZh': 'app.product-zh',
});

function canonicalKey(key) {
  return Object.prototype.hasOwnProperty.call(LEGACY_KEY_ALIASES, key) ? LEGACY_KEY_ALIASES[key] : key;
}

/**
 * 语言代码归一化：`zh` → `zh-CN`，`en-US` → `en`，未知 → 默认语言。
 * @param {unknown} candidate
 * @returns {string}
 */
export function normalizeLocale(candidate) {
  const raw = String(candidate ?? '').trim();
  if (raw === '') return DEFAULT_LOCALE;
  const direct = LOCALES.find((locale) => locale.toLowerCase() === raw.toLowerCase());
  if (direct) return direct;
  const base = raw.split(/[-_]/u)[0].toLowerCase();
  if (base === 'zh') return 'zh-CN';
  const byBase = LOCALES.find((locale) => locale.split('-')[0].toLowerCase() === base);
  return byBase ?? DEFAULT_LOCALE;
}

/**
 * 创建 i18n 实例。
 *
 * @param {{
 *   basePath?: string,
 *   fetchImpl?: Function|null,
 *   locale?: string,
 *   warnMissing?: boolean,
 *   onMissing?: Function|null,
 * }} [options]
 */
export function createI18n(options = {}) {
  const opts = options == null ? {} : options;
  const basePath = String(opts.basePath ?? new URL('../i18n/locales/', import.meta.url).href);
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : null;
  const warnMissing = opts.warnMissing !== false;
  const onMissing = typeof opts.onMissing === 'function' ? opts.onMissing : null;

  let locale = normalizeLocale(opts.locale ?? DEFAULT_LOCALE);
  /** @type {Map<string, Record<string,string>>} */
  const dicts = new Map();
  /** @type {Map<string, string>} */
  const failures = new Map();
  /** @type {Map<string, Promise<Record<string,string>>>} */
  const inflight = new Map();
  const loaded = new Set();
  const missing = new Set();
  const warnedMissing = new Set();
  let loadFailures = 0;

  function resolveFetch() {
    if (fetchImpl) return fetchImpl;
    return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  }

  /**
   * 加载一个语言文件；失败不抛错，记 loadFailures 并缓存空字典（避免反复重试）。
   * @param {string} target
   * @returns {Promise<Record<string,string>>}
   */
  function load(target) {
    const loc = normalizeLocale(target);
    if (dicts.has(loc)) return Promise.resolve(dicts.get(loc));
    if (inflight.has(loc)) return inflight.get(loc);
    const task = (async () => {
      const fetchFn = resolveFetch();
      if (!fetchFn) {
        loadFailures += 1;
        failures.set(loc, 'fetch unavailable');
        return {};
      }
      try {
        const url = new URL(`${loc}.json`, basePath).href;
        const response = await fetchFn(url, { headers: { accept: 'application/json' } });
        if (!response || response.ok === false) {
          throw new Error(`HTTP ${response && response.status !== undefined ? response.status : 'error'}`);
        }
        if (typeof response.status === 'number' && response.status >= 400) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = typeof response.json === 'function' ? await response.json() : null;
        if (!isPlainObject(data)) throw new Error('locale file is not a JSON object');
        loaded.add(loc);
        const dictionary = {};
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'string') dictionary[key] = value;
        }
        return loc === FALLBACK_LOCALE ? { ...BUILTIN_EN, ...dictionary } : dictionary;
      } catch (error) {
        loadFailures += 1;
        failures.set(loc, String((error && error.message) || error));
        return loc === FALLBACK_LOCALE ? { ...BUILTIN_EN } : {};
      }
    })();
    inflight.set(loc, task);
    return task.then((dictionary) => {
      dicts.set(loc, dictionary);
      inflight.delete(loc);
      return dictionary;
    });
  }

  /** 确保当前语言与 en 回落都已尝试加载（zh-CN 不再作为第二回落被预加载）。 */
  async function ready() {
    await Promise.all([load(locale), load(FALLBACK_LOCALE)]);
    return locale;
  }

  /** 当前生效的回落链（去重，顺序固定）：[当前语言, en]。 */
  function chain() {
    const list = [locale, FALLBACK_LOCALE];
    const seen = new Set();
    const out = [];
    for (const loc of list) {
      if (seen.has(loc)) continue;
      seen.add(loc);
      out.push(loc);
    }
    return out;
  }

  function dictionaryFor(loc) {
    const dictionary = dicts.get(loc);
    if (loc === FALLBACK_LOCALE) {
      if (!dictionary) return BUILTIN_EN;
      return dictionary;
    }
    return dictionary ?? null;
  }

  /**
   * 查 key（不记缺失；供 api.js 判断是否需要 UNKNOWN 兜底）。
   * @param {string} key
   * @returns {boolean}
   */
  function has(rawKey) {
    const key = canonicalKey(rawKey);
    if (typeof key !== 'string' || key === '') return false;
    for (const loc of chain()) {
      const dictionary = dictionaryFor(loc);
      if (dictionary && typeof dictionary[key] === 'string') return true;
    }
    return false;
  }

  /**
   * 翻译（同步；调用前应 await ready，否则只命中内置 en）。
   * @param {string} key
   * @param {Record<string, unknown>} [vars]
   * @returns {string}
   */
  function t(rawKey, vars) {
    const key = canonicalKey(rawKey);
    if (typeof key !== 'string' || key === '') return '';
    for (const loc of chain()) {
      const dictionary = dictionaryFor(loc);
      const value = dictionary ? dictionary[key] : undefined;
      if (typeof value === 'string') return interpolate(value, vars);
    }
    missing.add(key);
    if (warnMissing && !warnedMissing.has(key)) {
      warnedMissing.add(key);
      if (typeof console !== 'undefined' && console.warn) console.warn('[i18n] missing key: ' + key);
    }
    if (onMissing) onMissing(key);
    return `[missing:${key}]`;
  }

  function interpolate(template, vars) {
    if (!vars || typeof vars !== 'object') return template;
    return template.replace(PLACEHOLDER_PATTERN, (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
      const value = vars[name];
      return value === null || value === undefined ? '' : String(value);
    });
  }

  /**
   * 把翻译写进 DOM（合同 §8.6）。
   * @param {Document|Element} [root]
   * @returns {number} 处理的节点数
   */
  function apply(root) {
    const scope = root ?? (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    let count = 0;
    for (const node of scope.querySelectorAll('[data-i18n]')) {
      const key = node.getAttribute('data-i18n');
      if (!key) continue;
      const value = t(key, readVars(node));
      if (node.textContent !== value) node.textContent = value;
      count += 1;
    }
    for (const node of scope.querySelectorAll('[data-i18n-aria]')) {
      const key = node.getAttribute('data-i18n-aria');
      if (!key) continue;
      node.setAttribute('aria-label', t(key));
      count += 1;
    }
    for (const node of scope.querySelectorAll('[data-i18n-title]')) {
      const key = node.getAttribute('data-i18n-title');
      if (!key) continue;
      node.setAttribute('title', t(key));
      count += 1;
    }
    const doc = scope.ownerDocument ?? (scope.documentElement ? scope : null);
    if (doc && doc.documentElement) doc.documentElement.setAttribute('lang', locale);
    return count;
  }

  function readVars(node) {
    const raw = typeof node.getAttribute === 'function' ? node.getAttribute('data-i18n-vars') : null;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 切换语言（只切换/加载，不碰 DOM；调用方随后 apply + 重渲染当前视图）。
   * @param {string} next
   * @returns {Promise<string>} 实际生效的语言
   */
  async function setLocale(next) {
    locale = normalizeLocale(next);
    await ready();
    return locale;
  }

  /** 缺失 key 数量（合同 §8.5）。 */
  function missingCount() {
    return missing.size;
  }

  /** 缺失 key 列表（诊断用，保持插入顺序）。 */
  function missingKeys() {
    return [...missing];
  }

  /** 语言列表（语言切换器用）。 */
  function list() {
    return LOCALES.map((loc) => ({ locale: loc, native: NATIVE_NAMES[loc] ?? loc }));
  }

  /** 原生语言名。 */
  function nativeName(loc) {
    const key = normalizeLocale(loc);
    return NATIVE_NAMES[key] ?? key;
  }

  /** 诊断快照。 */
  function status() {
    return {
      locale,
      locales: [...LOCALES],
      loaded: [...loaded],
      failed: [...failures.entries()].map(([loc, reason]) => ({ locale: loc, reason })),
      loadFailures,
      missingCount: missing.size,
      missingKeys: [...missing],
      builtinFallback: true,
    };
  }

  /**
   * 把调试入口挂到 window（合同 §7.5 / §8：window.__I18N__）。
   * @param {object} [target]
   */
  function debug(target) {
    const win = target ?? (typeof window !== 'undefined' ? window : null);
    const api = {
      get locale() {
        return locale;
      },
      t,
      has,
      apply,
      setLocale,
      missingCount,
      missingKeys,
      status,
      list,
      nativeName,
      normalizeLocale,
    };
    if (win) win.__I18N__ = api;
    return api;
  }

  return {
    get locale() {
      return locale;
    },
    load,
    ready,
    setLocale,
    t,
    has,
    apply,
    missingCount,
    missingKeys,
    list,
    nativeName,
    status,
    debug,
  };
}

/** 应用单例（app.js 使用；自检可自行 createI18n 注入 fetch stub）。 */
export const i18n = createI18n();
