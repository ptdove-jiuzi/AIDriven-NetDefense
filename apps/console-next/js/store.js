/**
 * AIDriven NetDefense · WebUI v2 · 应用状态与本地持久化
 * B2 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.5
 *
 * 1. 状态树：status / models / settings / schema / route / i18n / theme / density / toasts
 *    （另加 conn / staticMode / overrides 三个外壳派生字段，均为加法）。
 * 2. API：subscribe(fn) / patch(partial) / select(fn)；patch 只在真有变化时通知，
 *    避免 i18n 来回 patch 造成渲染环。
 * 3. localStorage 只允许三个键：
 *      aidn.ui（theme/density/locale/startView + onboardingDone，见 T4 引导）
 *      aidn.settings.cache（只读副本，供首屏）
 *      aidn.agent.sessions（会话与消息，≤50 会话 / 每会话 ≤200 条）
 *    其余键一律拒绝写入；含 apiKey/token/csrf/secret 一类敏感键的对象一律拒绝写入
 *    （合同 §4.4：明文零出现于 localStorage）。
 * 4. 缓存失效：settings PUT 成功后 invalidate schema + models，并清掉 settings 首屏缓存。
 *
 * 本文件不访问 DOM（localStorage 不可用时退化为内存实现），可在 Node 里直接自检。
 */

import { isPlainObject, safeJsonParse } from './util.js';

/** 允许落地的 localStorage 键（合同 §7.5，闭集）。 */
export const LOCAL_KEYS = Object.freeze({
  ui: 'aidn.ui',
  settingsCache: 'aidn.settings.cache',
  agentSessions: 'aidn.agent.sessions',
});

/** 会话持久化上限（合同 §7.5）。 */
export const AGENT_SESSION_LIMITS = Object.freeze({ sessions: 50, messages: 200 });

/** aidn.ui 里允许的字符串键（合同 §6 ui 组）。 */
const UI_STRING_KEYS = Object.freeze(['theme', 'density', 'locale', 'startView']);

/**
 * aidn.ui 里允许的布尔键。
 * T4 首启动引导：`onboardingDone` 只记"用户已关闭引导"，不含任何个人数据。
 */
const UI_BOOLEAN_KEYS = Object.freeze(['onboardingDone']);

const ALLOWED_KEYS = new Set(Object.values(LOCAL_KEYS));

/**
 * 敏感键名：命中即拒绝写入。
 * 覆盖 apiKey / api_key / token / accessToken / csrf 派生字段 / secret / password /
 * cookie / authorization / x-aegis-csrf 以及请求头一类命名。
 */
const SENSITIVE_KEY = /(?:^|[^a-z])(api[-_]?key|token|csrf|secret|password|passwd|cookie|authorization|auth[-_]?header|x-aegis-csrf)(?:[^a-z]|$)/iu;

const memory = new Map();
const writeLog = [];
const warned = new Set();
let storageMode = 'memory';

detectStorage();

function detectStorage() {
  try {
    const candidate = globalThis.localStorage;
    if (!candidate) return;
    candidate.setItem('aidn.probe', '1');
    candidate.removeItem('aidn.probe');
    storageMode = 'local';
  } catch {
    storageMode = 'memory';
  }
}

function rawGet(key) {
  if (storageMode === 'local') {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      storageMode = 'memory';
    }
  }
  return memory.has(key) ? memory.get(key) : null;
}

function rawSet(key, raw) {
  if (storageMode === 'local') {
    try {
      globalThis.localStorage.setItem(key, raw);
      return true;
    } catch {
      storageMode = 'memory';
    }
  }
  memory.set(key, raw);
  return true;
}

function rawRemove(key) {
  if (storageMode === 'local') {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      storageMode = 'memory';
    }
  }
  memory.delete(key);
}

function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== 'undefined' && console.warn) console.warn('[store] ' + message);
}

/**
 * 递归检查对象键名里是否出现敏感命名（只看键，不看值，避免误伤告警文本）。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {boolean}
 */
export function containsSensitiveKey(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveKey(item, depth + 1));
  }
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) return true;
    if (containsSensitiveKey(value[key], depth + 1)) return true;
  }
  return false;
}

/**
 * 读允许键；不在白名单 / JSON 损坏时返回 fallback。
 * @template T
 * @param {string} key LOCAL_KEYS 之一
 * @param {T} [fallback]
 * @returns {T|any}
 */
export function readLocal(key, fallback = null) {
  if (!ALLOWED_KEYS.has(key)) {
    warnOnce('拒绝读取非白名单键：' + key);
    return fallback;
  }
  return safeJsonParse(rawGet(key), fallback);
}

/**
 * 写允许键；敏感内容/非白名单键返回 false（不抛错，UI 不因持久化失败而崩）。
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
export function writeLocal(key, value) {
  if (!ALLOWED_KEYS.has(key)) {
    warnOnce('拒绝写入非白名单键：' + key);
    return false;
  }
  if (containsSensitiveKey(value)) {
    warnOnce('拒绝写入含敏感键的数据（合同 §4.4 禁止 apiKey/token/csrf 落 localStorage）');
    return false;
  }
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false;
  }
  if (typeof raw !== 'string') return false;
  rawSet(key, raw);
  writeLog.push({ key, at: Date.now() });
  if (writeLog.length > 200) writeLog.shift();
  return true;
}

/** @param {string} key @returns {boolean} */
export function removeLocal(key) {
  if (!ALLOWED_KEYS.has(key)) return false;
  rawRemove(key);
  writeLog.push({ key, removed: true, at: Date.now() });
  if (writeLog.length > 200) writeLog.shift();
  return true;
}

/**
 * 存储诊断（供自检/故障排查）：模式、写入轨迹、当前键数。
 * @returns {{mode:string, writes:Array<object>, size:number}}
 */
export function storageInfo() {
  let size = memory.size;
  if (storageMode === 'local') {
    try {
      size = globalThis.localStorage.length;
    } catch {
      size = memory.size;
    }
  }
  return { mode: storageMode, writes: writeLog.slice(), size };
}

/** 读取本地 UI 偏好（合同 §6 ui 组的字符串键 + T4 的 onboardingDone 布尔键）。 */
export function readUi() {
  const stored = readLocal(LOCAL_KEYS.ui, {});
  if (!isPlainObject(stored)) return {};
  const clean = {};
  for (const key of UI_STRING_KEYS) {
    const value = stored[key];
    if (typeof value === 'string' && value !== '') clean[key] = value;
  }
  for (const key of UI_BOOLEAN_KEYS) {
    if (typeof stored[key] === 'boolean') clean[key] = stored[key];
  }
  return clean;
}

/**
 * 写入本地 UI 偏好（合并；只写白名单键，且绝不包含敏感数据）。
 * @param {Record<string, string|boolean>} partial
 * @returns {boolean}
 */
export function writeUi(partial) {
  if (!isPlainObject(partial)) return false;
  const next = { ...readUi() };
  for (const key of UI_STRING_KEYS) {
    const value = partial[key];
    if (typeof value === 'string' && value !== '') next[key] = value;
  }
  for (const key of UI_BOOLEAN_KEYS) {
    if (typeof partial[key] === 'boolean') next[key] = partial[key];
  }
  return writeLocal(LOCAL_KEYS.ui, next);
}

/** 首屏 settings 只读副本。@returns {{settings:object, updatedAt?:string}|null} */
export function readCachedSettings() {
  const cached = readLocal(LOCAL_KEYS.settingsCache, null);
  if (!isPlainObject(cached) || !isPlainObject(cached.settings)) return null;
  return cached;
}

/**
 * 缓存 settings（只读副本，供下次首屏；不含任何凭据）。
 * @param {{settings:object, updatedAt?:string, schemaVersion?:string}} payload
 * @returns {boolean}
 */
export function cacheSettings(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.settings)) return false;
  return writeLocal(LOCAL_KEYS.settingsCache, {
    settings: payload.settings,
    updatedAt: payload.updatedAt ?? null,
    schemaVersion: payload.schemaVersion ?? null,
  });
}

/** 读取 Agent 会话（合同 §7.5 上限由 writeAgentSessions 保证）。 */
export function readAgentSessions() {
  const list = readLocal(LOCAL_KEYS.agentSessions, []);
  return Array.isArray(list) ? list : [];
}

/**
 * 写 Agent 会话：最多 50 个会话，每个会话最多保留最近 200 条消息，超出丢弃最旧。
 * @param {Array<{messages?: unknown[], [key:string]: unknown}>} sessions
 * @returns {boolean}
 */
export function writeAgentSessions(sessions) {
  if (!Array.isArray(sessions)) return false;
  const limited = sessions.slice(Math.max(0, sessions.length - AGENT_SESSION_LIMITS.sessions)).map((session) => {
    if (!isPlainObject(session) || !Array.isArray(session.messages)) return session;
    const messages = session.messages.slice(Math.max(0, session.messages.length - AGENT_SESSION_LIMITS.messages));
    return { ...session, messages };
  });
  return writeLocal(LOCAL_KEYS.agentSessions, limited);
}

/**
 * 初始状态（合同 §7.5 的 9 个键 + 外壳派生字段）。
 * @param {object} [extra]
 */
export function createInitialState(extra = {}) {
  return {
    status: null,
    models: null,
    settings: null,
    schema: null,
    route: null,
    i18n: { locale: 'zh-CN', ready: false, missing: 0 },
    theme: { preference: 'system', resolved: 'dark', source: 'system' },
    density: 'comfortable',
    toasts: [],
    conn: { state: 'idle', version: null, at: null },
    staticMode: false,
    overrides: { theme: null, lang: null, static: false },
    bootedAt: null,
    ...(isPlainObject(extra) ? extra : {}),
  };
}

/**
 * 创建 store。
 * @param {object} [initial]
 * @returns {{getState:Function, subscribe:Function, patch:Function, select:Function, state:object, listenerCount:Function}}
 */
export function createStore(initial) {
  let state = { ...createInitialState(), ...(isPlainObject(initial) ? initial : {}) };
  const listeners = new Set();

  function getState() {
    return state;
  }

  /**
   * 订阅状态变化；返回取消订阅函数。
   * 回调签名 (state, prev, changedKeys)。
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('[store] subscribe 需要函数');
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * 浅合并 patch；只在至少一个键真正变化时通知（对象按引用比较）。
   * `patch(partial, {silent:true})` 只写不通知（初始化用）。
   */
  function patch(partial, options = {}) {
    if (!isPlainObject(partial)) return state;
    const changed = [];
    const next = { ...state };
    for (const key of Object.keys(partial)) {
      const value = partial[key];
      if (Object.is(state[key], value)) continue;
      next[key] = value;
      changed.push(key);
    }
    if (changed.length === 0) return state;
    const prev = state;
    state = next;
    if (!options.silent) {
      for (const listener of [...listeners]) {
        try {
          listener(state, prev, changed);
        } catch (error) {
          if (typeof console !== 'undefined' && console.error) console.error('[store] subscriber failed', error);
        }
      }
    }
    return state;
  }

  /** @param {Function} fn @returns {*} fn(state) 的返回值 */
  function select(fn) {
    return typeof fn === 'function' ? fn(state) : state;
  }

  return {
    getState,
    subscribe,
    patch,
    select,
    listenerCount: () => listeners.size,
    get state() {
      return state;
    },
  };
}

/** 应用单例（index.html 的 app.js 使用；自检可自行 createStore）。 */
export const store = createStore();

/**
 * 缓存失效（合同 §7.5）：settings PUT 之后必须让 schema 与 models 重新拉取。
 * @param {string[]} [names]
 * @param {object} [target]
 * @returns {string[]} 实际失效的键
 */
export function invalidateCaches(names = ['schema', 'models'], target = store) {
  const list = Array.isArray(names) ? names : [];
  const patch = {};
  for (const name of list) {
    if (name === 'schema' || name === 'models' || name === 'settings' || name === 'status') {
      patch[name] = null;
    }
  }
  if (Object.keys(patch).length > 0) target.patch(patch);
  return Object.keys(patch);
}

/**
 * settings PUT 的落点：dryRun 不失效任何缓存；真实保存后失效 schema + models，
 * 并清掉首屏 settings 缓存（避免下一次启动读到旧值）。
 *
 * @param {{settings?:object, updatedAt?:string}} result PUT 响应
 * @param {{dryRun?:boolean, target?:object}} [options]
 * @returns {{invalidated:string[], cached:boolean}}
 */
export function applySettingsPutResult(result, options = {}) {
  const target = options.target ?? store;
  if (options.dryRun) return { invalidated: [], cached: false };
  const invalidated = invalidateCaches(['schema', 'models'], target);
  if (isPlainObject(result) && isPlainObject(result.settings)) {
    target.patch({ settings: result });
    cacheSettings({ settings: result.settings, updatedAt: result.updatedAt });
  }
  return { invalidated, cached: true };
}
