/**
 * apps/console/i18n/index.js — 控制台国际化加载器。
 *
 * 规范来源：docs/design/I18N.md（七语言、key 命名、占位符、复数、长度、术语表、CI 五项）。
 *
 * 形态：经典脚本（无 import / export、无构建、无依赖）。
 *   - 浏览器：`<script src="i18n/index.js" defer></script>` 后使用 `globalThis.NDI18N`；
 *   - Node 测试：文件没有 ESM 语法，`await import(fileURL)` 执行副作用后从 globalThis 取同一个对象。
 *
 * 回落链：locale[key] → en[key] → `[missing:key]`（禁止静默空白）。
 *
 * 作者：PT-dove
 */
(function (global) {
  'use strict';

  /** 支持的语言。顺序即语言选择器的展示顺序。 */
  var SUPPORTED = ['en', 'zh-CN', 'ja', 'ko', 'es', 'ru', 'th'];

  /** 语言自称：选择器只显示自称，不显示英文名（I18N.md §8）。 */
  var NATIVE_NAME = {
    en: 'English',
    'zh-CN': '简体中文',
    ja: '日本語',
    ko: '한국어',
    es: 'Español',
    ru: 'Русский',
    th: 'ไทย',
  };

  var STORAGE_KEY = 'ui.locale';
  var FALLBACK_LOCALE = 'en';
  var DEFAULT_BASE_PATH = 'i18n/locales/';
  var MISSING_PREFIX = '[missing:';
  var PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /**
   * 把任意 BCP 47 标签收敛到受支持列表里的一项；不受支持返回 null。
   * 本期只有简体中文，因此所有 `zh-*`（含 Hant / TW / HK）都收敛到 zh-CN。
   *
   * @param {unknown} raw 原始语言标签。
   * @returns {string|null} 受支持的 locale 或 null。
   */
  function normalizeLocale(raw) {
    if (typeof raw !== 'string') return null;
    var tag = raw.trim();
    if (tag === '') return null;
    var lower = tag.toLowerCase().replace(/_/g, '-');
    if (lower === 'zh' || lower.indexOf('zh-') === 0) return 'zh-CN';
    for (var index = 0; index < SUPPORTED.length; index += 1) {
      if (SUPPORTED[index].toLowerCase() === lower) return SUPPORTED[index];
    }
    var base = lower.split('-')[0];
    for (var baseIndex = 0; baseIndex < SUPPORTED.length; baseIndex += 1) {
      if (SUPPORTED[baseIndex].toLowerCase() === base) return SUPPORTED[baseIndex];
    }
    return null;
  }

  function safeStorage(explicit) {
    if (explicit !== undefined) return explicit;
    try {
      if (typeof global.localStorage !== 'undefined' && global.localStorage !== null) {
        return global.localStorage;
      }
    } catch (error) {
      // 隐私模式或沙箱里访问 localStorage 会抛异常：当作没有存储。
    }
    return null;
  }

  function readStoredLocale(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      return storage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  /**
   * 语言探测：localStorage['ui.locale'] → navigator.languages → 'en'。
   *
   * @param {{storage?: object|null, languages?: string[]}} [options] 可注入的探测源。
   * @returns {string} 受支持的 locale。
   */
  function detectLocale(options) {
    var input = options || {};
    var stored = normalizeLocale(readStoredLocale(input.storage));
    if (stored !== null) return stored;

    var list = Array.isArray(input.languages) ? input.languages : [];
    for (var index = 0; index < list.length; index += 1) {
      var matched = normalizeLocale(list[index]);
      if (matched !== null) return matched;
    }
    return FALLBACK_LOCALE;
  }

  /**
   * 取浏览器声明的语言列表，探测失败时返回空数组。
   *
   * @returns {string[]} navigator.languages 的副本。
   */
  function browserLanguages() {
    if (typeof global.navigator === 'undefined' || global.navigator === null) return [];
    var nav = global.navigator;
    if (Array.isArray(nav.languages) && nav.languages.length > 0) return nav.languages.slice();
    if (typeof nav.language === 'string' && nav.language !== '') return [nav.language];
    return [];
  }

  /**
   * Intl.PluralRules 复数类别；运行环境缺失 Intl 时退化为 one/other。
   *
   * @param {string} locale 语言。
   * @param {number|string} count 计数。
   * @returns {string} CLDR 复数类别。
   */
  function pluralCategory(locale, count) {
    var value = typeof count === 'number' ? count : Number(count);
    if (!Number.isFinite(value)) return 'other';
    try {
      return new Intl.PluralRules(locale).select(value);
    } catch (error) {
      return value === 1 ? 'one' : 'other';
    }
  }

  /**
   * `{name}` 插值。未知占位符原样保留，不静默清空。
   *
   * @param {string} template 词条原文。
   * @param {object} [params] 插值参数。
   * @returns {string} 结果。
   */
  function interpolate(template, params) {
    if (typeof template !== 'string') return '';
    if (template.indexOf('{') === -1 || !isPlainObject(params)) return template;
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, function (whole, name) {
      if (!hasOwn(params, name)) return whole;
      var value = params[name];
      if (value === undefined || value === null) return whole;
      return String(value);
    });
  }

  function joinPath(basePath, file) {
    var base = typeof basePath === 'string' ? basePath : DEFAULT_BASE_PATH;
    if (base === '') return file;
    return base.charAt(base.length - 1) === '/' ? base + file : base + '/' + file;
  }

  function fetchJson(url) {
    if (typeof global.fetch !== 'function') {
      return Promise.reject(new Error('fetch 不可用'));
    }
    return global.fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response || !response.ok) {
        throw new Error('HTTP ' + (response ? response.status : 'n/a') + ' ' + url);
      }
      return response.json();
    });
  }

  function readDebugFlag(search) {
    var query = typeof search === 'string' ? search : '';
    if (query === '') return false;
    var text = query.charAt(0) === '?' ? query.slice(1) : query;
    var pairs = text.split('&');
    for (var index = 0; index < pairs.length; index += 1) {
      var pair = pairs[index].split('=');
      var key = decodeURIComponent(pair[0] || '');
      var value = decodeURIComponent(pair[1] || '');
      if (key !== 'i18n') continue;
      return value === 'debug' || value === '1' || value === 'true';
    }
    return false;
  }

  /**
   * 词条表查询：先查精确 key，再按 `key.<plural>` 展开。
   *
   * @param {object|null} map 词条表。
   * @param {string} key 词条 key。
   * @param {object} params 插值/复数参数。
   * @param {string} mapLocale 词条表所属语言（决定复数规则）。
   * @returns {string|null} 未命中返回 null。
   */
  function lookup(map, key, params, mapLocale) {
    if (!isPlainObject(map)) return null;
    if (hasOwn(map, key) && typeof map[key] === 'string') return map[key];
    if (isPlainObject(params) && typeof params.count === 'number' && Number.isFinite(params.count)) {
      var category = pluralCategory(mapLocale, params.count);
      var candidates = [key + '.' + category, key + '.other'];
      for (var index = 0; index < candidates.length; index += 1) {
        var candidate = candidates[index];
        if (hasOwn(map, candidate) && typeof map[candidate] === 'string') return map[candidate];
      }
    }
    return null;
  }

  /**
   * 创建 i18n 实例。
   *
   * @param {{basePath?: string, storage?: object|null, loadJson?: Function, document?: object|null,
   *   debug?: boolean, locale?: string, languages?: string[]}} [options] 运行参数。
   * @returns {object} 实例。
   */
  function createI18n(options) {
    var config = options || {};
    var doc = config.document !== undefined
      ? config.document
      : (typeof document !== 'undefined' ? document : null);
    var storage = safeStorage(config.storage);
    var basePath = typeof config.basePath === 'string' ? config.basePath : DEFAULT_BASE_PATH;
    var loadJson = typeof config.loadJson === 'function'
      ? config.loadJson
      : function (locale) { return fetchJson(joinPath(basePath, locale + '.json')); };
    var debug = config.debug === true;

    var messages = {};
    var baseMessages = null;
    var current = FALLBACK_LOCALE;
    var bindings = [];
    var seenNodes = [];
    var listeners = [];
    var missingKeys = [];
    var pending = null;

    function recordMissing(key) {
      if (missingKeys.indexOf(key) === -1) missingKeys.push(key);
    }

    function resolveIn(map, key, params, mapLocale) {
      var raw = lookup(map, key, params, mapLocale);
      if (raw === null) return null;
      return interpolate(raw, params);
    }

    /**
     * 解析一个 key：locale → en → `[missing:key]`。
     *
     * @param {string} key 词条 key。
     * @param {object} [params] 插值与复数参数。
     * @returns {{text: string, source: string}} source 取值 locale / fallback / missing。
     */
    function resolve(key, params) {
      if (typeof key !== 'string' || key === '') {
        recordMissing(String(key));
        return { text: MISSING_PREFIX + String(key) + ']', source: 'missing' };
      }
      var local = resolveIn(messages[current], key, params, current);
      if (local !== null) return { text: local, source: 'locale' };

      var fromBase = resolveIn(baseMessages, key, params, FALLBACK_LOCALE);
      if (fromBase !== null) {
        return { text: fromBase, source: current === FALLBACK_LOCALE ? 'locale' : 'fallback' };
      }

      recordMissing(key);
      return { text: MISSING_PREFIX + key + ']', source: 'missing' };
    }

    function t(key, params) {
      return resolve(key, params).text;
    }

    function has(key) {
      if (!isPlainObject(messages[current])) return false;
      if (hasOwn(messages[current], key)) return true;
      if (!isPlainObject(baseMessages)) return false;
      return hasOwn(baseMessages, key);
    }

    function applyBinding(binding) {
      var node = binding.node;
      if (!node) return;
      var result = resolve(binding.key, binding.params);
      if (binding.kind === 'attr') {
        if (typeof node.setAttribute === 'function') node.setAttribute(binding.attr, result.text);
      } else if ('textContent' in node) {
        node.textContent = result.text;
      }

      if (doc && node.classList && typeof node.setAttribute === 'function') {
        node.setAttribute('data-i18n-key', binding.key);
        if (debug) {
          node.classList.remove('i18n-fallback');
          node.classList.remove('i18n-missing');
          if (result.source === 'missing') node.classList.add('i18n-missing');
          else if (result.source === 'fallback') node.classList.add('i18n-fallback');
        }
      }
    }

    function render() {
      for (var index = 0; index < bindings.length; index += 1) applyBinding(bindings[index]);
      return bindings.length;
    }

    function register(node, kind, key, params, attr) {
      if (!node || typeof key !== 'string' || key === '') return false;
      for (var index = 0; index < bindings.length; index += 1) {
        var existing = bindings[index];
        if (existing.node === node && existing.kind === kind && existing.attr === (attr || null)) {
          existing.key = key;
          existing.params = params || null;
          applyBinding(existing);
          return true;
        }
      }
      var binding = { node: node, kind: kind, key: key, params: params || null, attr: attr || null };
      bindings.push(binding);
      applyBinding(binding);
      return true;
    }

    /**
     * 解析 `data-i18n-attr` 的值：`placeholder:key` 或 `placeholder:key,title:other`。
     *
     * @param {string} spec 属性声明。
     * @returns {Array<{attr: string, key: string}>} 解析结果。
     */
    function parseAttrSpec(spec) {
      if (typeof spec !== 'string' || spec === '') return [];
      var out = [];
      var chunks = spec.split(/[,;]/);
      for (var index = 0; index < chunks.length; index += 1) {
        var chunk = chunks[index].trim();
        if (chunk === '') continue;
        var split = chunk.indexOf(':');
        if (split <= 0) continue;
        var attr = chunk.slice(0, split).trim();
        var key = chunk.slice(split + 1).trim();
        if (attr === '' || key === '') continue;
        out.push({ attr: attr, key: key });
      }
      return out;
    }

    function paramsFromNode(node) {
      if (!node || typeof node.getAttribute !== 'function') return null;
      var raw = node.getAttribute('data-i18n-count');
      if (raw === null) return null;
      var value = Number(raw);
      return Number.isFinite(value) ? { count: value } : null;
    }

    /**
     * 扫描并绑定 DOM：`data-i18n`（文本）、`data-i18n-attr`（属性）、`data-i18n-title`（title）。
     *
     * @param {object} [root] 扫描根，默认 document。
     * @returns {number} 绑定的节点数。
     */
    function bind(root) {
      if (!doc) return 0;
      var scope = root || doc;
      if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
      var nodes = scope.querySelectorAll('[data-i18n], [data-i18n-attr], [data-i18n-title]');
      var count = 0;
      for (var index = 0; index < nodes.length; index += 1) {
        var node = nodes[index];
        var params = paramsFromNode(node);
        var textKey = node.getAttribute ? node.getAttribute('data-i18n') : null;
        if (textKey) {
          if (register(node, 'text', textKey, params, null)) count += 1;
        }
        var attrSpec = node.getAttribute ? node.getAttribute('data-i18n-attr') : null;
        var pairs = parseAttrSpec(attrSpec);
        for (var pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
          if (register(node, 'attr', pairs[pairIndex].key, params, pairs[pairIndex].attr)) count += 1;
        }
        var titleKey = node.getAttribute ? node.getAttribute('data-i18n-title') : null;
        if (titleKey && register(node, 'attr', titleKey, params, 'title')) count += 1;
        if (seenNodes.indexOf(node) === -1) seenNodes.push(node);
      }
      return count;
    }

    function persist(locale) {
      if (!storage || typeof storage.setItem !== 'function') return false;
      try {
        storage.setItem(STORAGE_KEY, locale);
        return true;
      } catch (error) {
        return false;
      }
    }

    function emit(locale) {
      for (var index = 0; index < listeners.length; index += 1) {
        try {
          listeners[index](locale);
        } catch (error) {
          // 监听器失败不影响主流程。
        }
      }
      if (doc && typeof doc.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        doc.dispatchEvent(new global.CustomEvent('i18n:change', { detail: { locale: locale } }));
      }
    }

    function loadInto(locale) {
      return Promise.resolve()
        .then(function () { return loadJson(locale); })
        .then(function (table) {
          if (!isPlainObject(table)) throw new Error('词条表不是对象：' + locale);
          messages[locale] = table;
          if (locale === FALLBACK_LOCALE) baseMessages = table;
          return table;
        });
    }

    /**
     * 载入 en 与目标语言。目标语言失败时只记录，不阻断——t() 会回落到 en。
     *
     * @param {string} locale 目标语言。
     * @returns {Promise<{locale: string, fallback: boolean}>} 结果。
     */
    function load(locale) {
      var target = normalizeLocale(locale) || FALLBACK_LOCALE;
      var tasks = [];
      if (baseMessages === null) {
        tasks.push(loadInto(FALLBACK_LOCALE));
      }
      var fallback = false;
      if (target !== FALLBACK_LOCALE && !hasOwn(messages, target)) {
        tasks.push(loadInto(target).catch(function () {
          fallback = true;
          return null;
        }));
      }
      return Promise.all(tasks).then(function () {
        if (!hasOwn(messages, target)) {
          messages[target] = {};
          fallback = true;
        }
        return { locale: target, fallback: fallback };
      });
    }

    /**
     * 切换语言：加载 → 记住 → 重渲染所有绑定节点，不刷新页面。
     *
     * @param {string} next 目标语言。
     * @param {{persist?: boolean}} [opts] 是否写入 localStorage。
     * @returns {Promise<string>} 生效的 locale。
     */
    function setLocale(next, opts) {
      var optionsLocal = opts || {};
      var target = normalizeLocale(next) || FALLBACK_LOCALE;
      return load(target).then(function () {
        current = target;
        if (optionsLocal.persist !== false) persist(target);
        render();
        emit(target);
        return target;
      });
    }

    function init(initOptions) {
      var input = initOptions || {};
      var explicit = normalizeLocale(input.locale);
      var detected = explicit || detectLocale({
        storage: storage,
        languages: Array.isArray(input.languages) ? input.languages : browserLanguages(),
      });
      pending = load(detected).then(function () {
        current = detected;
        render();
        emit(detected);
        return detected;
      });
      return pending;
    }

    function on(listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.push(listener);
      return function () {
        var index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }

    /**
     * 挂载语言选择器：选项只显示自称，切换即时生效。
     *
     * @param {object} host 宿主元素。
     * @param {{ariaLabel?: string, className?: string, labelKey?: string}} [selectorOptions] 配置。
     * @returns {object|null} select 元素。
     */
    function mountLanguageSelector(host, selectorOptions) {
      if (!doc || !host || typeof doc.createElement !== 'function') return null;
      var selectorConfig = selectorOptions || {};
      var select = doc.createElement('select');
      select.className = selectorConfig.className || 'i18n-select';
      select.setAttribute('data-i18n-select', 'locale');
      var aria = selectorConfig.ariaLabel
        || (selectorConfig.labelKey ? t(selectorConfig.labelKey) : 'Language');
      select.setAttribute('aria-label', aria);
      for (var index = 0; index < SUPPORTED.length; index += 1) {
        var code = SUPPORTED[index];
        var option = doc.createElement('option');
        option.value = code;
        option.textContent = NATIVE_NAME[code];
        select.appendChild(option);
      }
      select.value = current;
      select.addEventListener('change', function () { setLocale(select.value); });
      host.appendChild(select);
      on(function (locale) {
        if (select.value !== locale) select.value = locale;
      });
      return select;
    }

    function formatNumber(value, formatOptions) {
      try {
        return new Intl.NumberFormat(current, formatOptions).format(value);
      } catch (error) {
        return String(value);
      }
    }

    function formatDate(value, formatOptions) {
      var date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      try {
        return new Intl.DateTimeFormat(current, formatOptions).format(date);
      } catch (error) {
        return date.toISOString();
      }
    }

    var api = {
      t: t,
      resolve: resolve,
      has: has,
      bind: bind,
      render: render,
      init: init,
      load: load,
      setLocale: setLocale,
      mountLanguageSelector: mountLanguageSelector,
      on: on,
      formatNumber: formatNumber,
      formatDate: formatDate,
      getLocale: function () { return current; },
      getMessages: function (locale) { return messages[locale || current] || {}; },
      getBaseMessages: function () { return baseMessages || {}; },
      missingKeys: function () { return missingKeys.slice(); },
      isDebug: function () { return debug; },
      setDebug: function (value) { debug = value === true; render(); return debug; },
      ready: function () { return pending || Promise.resolve(current); },
      storageKey: STORAGE_KEY,
      supported: SUPPORTED.slice(),
      nativeNames: NATIVE_NAME,
    };

    if (config.locale) current = normalizeLocale(config.locale) || FALLBACK_LOCALE;
    return api;
  }

  /**
   * 浏览器自动启动：DOM ready 后探测语言、绑定节点、按需注入调试样式。
   * 需要自定义 basePath 或选项时，调用方改用 createI18n()。
   *
   * @returns {object} i18n 实例。
   */
  function autoStart() {
    var search = typeof global.location !== 'undefined' && global.location ? global.location.search : '';
    var instance = createI18n({ debug: readDebugFlag(search) });
    function start() {
      instance.init().then(function () {
        instance.bind();
        if (instance.isDebug()) injectDebugStyle();
      });
    }
    if (typeof document !== 'undefined' && document !== null) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
    }
    return instance;
  }

  /** 调试样式：回落黄下划线、缺词红底。生产模式不注入。 */
  function injectDebugStyle() {
    if (typeof document === 'undefined' || document === null) return null;
    if (document.querySelector('style[data-i18n-debug]')) return null;
    var style = document.createElement('style');
    style.setAttribute('data-i18n-debug', '');
    style.textContent = '.i18n-missing{background:#b3261e;color:#fff;outline:1px solid #ff8a80}'
      + '.i18n-fallback{text-decoration:underline;text-decoration-color:#f2c744;'
      + 'text-decoration-thickness:2px;text-underline-offset:3px}';
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  var NDI18N = {
    version: '1.0.0',
    SUPPORTED: SUPPORTED,
    NATIVE_NAME: NATIVE_NAME,
    STORAGE_KEY: STORAGE_KEY,
    FALLBACK_LOCALE: FALLBACK_LOCALE,
    PLURAL_FORMS: PLURAL_FORMS,
    MISSING_PREFIX: MISSING_PREFIX,
    normalizeLocale: normalizeLocale,
    detectLocale: detectLocale,
    pluralCategory: pluralCategory,
    interpolate: interpolate,
    readDebugFlag: readDebugFlag,
    createI18n: createI18n,
    autoStart: autoStart,
  };

  global.NDI18N = NDI18N;

  if (typeof module !== 'undefined' && module !== null && module.exports) {
    module.exports = NDI18N;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
