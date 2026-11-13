/**
 * AIDriven NetDefense · WebUI v2 · 告警页（B5 / PT-dove）
 *
 * 合同依据：docs/implementation/CONSOLE-V2-CONTRACT.md
 *   §2.1 错误码 / §2.2 模型运行态 / §2.6 讲解 SSE / §3 SSE 累积语义
 *   §7.2 路由与 hash 查询串 / §7.3 api 导出 / §7.6 组件签名
 *   §7.7 DOM 子集 / §7.8 无障碍 / §12.1-3 告警无 host、§12.1-4 已加载工作集
 *
 * 本文件只写：告警列表（B1 虚拟表格）+ 工作集内筛选/搜索/排序 + cursor「加载更多」
 *            + hash(replace) 同步 + 详情抽屉（B1 drawer 三关关闭）+ 流式 AI 讲解。
 * 不写其它 js / styles / locales；所有文案走 ctx.i18n.t()，不内置语言表。
 *
 * 事实纪律（都不许美化）：
 * - 告警接口无 host 键 → 「主机」列显示「未提供」并带 title，禁止编造。
 * - 筛选/搜索/排序只作用于**已加载工作集**（最多 5 页 / 500 条），UI 明示，不谎称全库。
 * - 读取失败不是「没有告警」：错误态单独渲染，空态只在服务端真的返回 0 行时出现。
 */
import { el, cls } from '../components/ui/dom.js';
import { table } from '../components/ui/table.js';
import { drawer } from '../components/ui/drawer.js';
import { button } from '../components/ui/button.js';
import { card } from '../components/ui/card.js';
import { badge, severityBadge, statusBadge } from '../components/ui/badge.js';
import { empty } from '../components/ui/empty.js';
import { select } from '../components/ui/select.js';
import { input, field } from '../components/ui/field.js';

/** 与 daemon config / event-store schema 的枚举一致（不新增枚举值）。 */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
export const ALERT_STATUSES = ['new', 'acknowledged', 'resolved', 'suppressed'];

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const SORT_KEYS = ['last_seen', 'severity', 'count'];
const SORT_DEFAULT_DIR = { last_seen: 'desc', severity: 'desc', count: 'desc' };
const PAGE_SIZES = [10, 25, 50, 100];
const DEFAULT_LIMIT = 50;
/** 前端工作集上限：最多 5 页、最多 500 条（合同 §12.1-4；不谎称全库）。 */
const MAX_PAGES = 5;
const MAX_ROWS = 500;
const SEARCH_DEBOUNCE_MS = 250;
const DEFAULT_LIST_TIMEOUT_MS = 15000;

/** projectAlert() 的白名单键（daemon query.js）；host 不在其中（§12.1-3）。 */
const DETAIL_FIELDS = [
  'alert_id',
  'rule_id',
  'rule_version',
  'severity',
  'status',
  'count',
  'first_seen',
  'last_seen',
  'window_start',
  'window_end',
  'evidence_count',
  'evidence_truncated',
];

const EXPLAIN_DISABLED_KEY = {
  noModel: 'alerts.explain.disabled.no-model',
  engine: 'alerts.explain.disabled.engine',
  egress: 'alerts.explain.disabled.egress',
};

const MODEL_ERROR_CODES = new Set([
  'ENGINE_UNAVAILABLE',
  'MODEL_UNKNOWN',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_INVALID',
  'CREDENTIAL_STORE_UNAVAILABLE',
  'EGRESS_DISABLED',
  'PROVIDER_DISABLED',
  'PROVIDER_UNKNOWN',
  'PROVIDER_INVALID',
  'PROVIDER_LIMIT',
]);

const LIST_ERROR_KEY = {
  STORE_UNAVAILABLE: 'alerts.error.code.store-unavailable',
  INTERNAL: 'alerts.error.code.internal',
  INTERNAL_ERROR: 'alerts.error.code.internal',
  TIMEOUT: 'alerts.error.code.timeout',
  PARSE: 'alerts.error.code.parse',
  NETWORK: 'alerts.error.code.network',
  QUERY_INVALID: 'alerts.error.code.query-invalid',
};

/* ==========================================================================
   纯函数（无 DOM、无 ctx）：可在 B11 的 DOM shim 下复用
   ========================================================================== */

/** `{name}` 单花括号占位符替换（合同 §8.4；缺变量留空，不抛错）。 */
export function interpolate(template, vars) {
  const source = template == null ? '' : String(template);
  if (!vars || typeof vars !== 'object') return source;
  return source.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    return value == null ? '' : String(value);
  });
}

/** ISO 字符串 / 毫秒数 → 毫秒；非法或缺失 → null（绝不把缺值当 0）。 */
export function parseInstant(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** 本地化绝对时间（合同 §8.4：日期用 Intl，禁止手拼）。 */
export function formatInstant(value, locale) {
  const ms = parseInstant(value);
  if (ms === null) return null;
  const date = new Date(ms);
  try {
    return new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
  } catch (error) {
    return date.toISOString();
  }
}

/** 本地化数字；非有限数 → null。 */
export function formatNumber(value, locale) {
  const num = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return null;
  try {
    return new Intl.NumberFormat(locale || undefined).format(num);
  } catch (error) {
    return String(num);
  }
}

/** 稳定告警主键：alert_id 缺失时用可复现的合成键（不编造展示值）。 */
export function getAlertId(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.alert_id !== null && row.alert_id !== undefined && String(row.alert_id) !== '') {
    return String(row.alert_id);
  }
  return 'row:' + String(row.rule_id == null ? '' : row.rule_id) + ':' + String(row.last_seen == null ? '' : row.last_seen);
}

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function walkDom(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.nodeType === 1) visit(node);
  const children = node.childNodes;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) walkDom(children[index], visit);
}

function findAll(root, predicate) {
  const out = [];
  walkDom(root, function (node) {
    if (predicate(node)) out.push(node);
  });
  return out;
}

function hasClassToken(node, token) {
  return Boolean(node && node.classList && node.classList.contains(token));
}

/** 只需要 DOM 属性，不依赖 innerHTML；失败返回 false（file:// 下 clipboard 可能不可用）。 */
async function copyText(value) {
  const textValue = value == null ? '' : String(value);
  if (textValue === '') return false;
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(textValue);
      return true;
    }
  } catch (error) {
    /* 继续走降级路径 */
  }
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    const scratch = el('textarea', {
      class: 'ui-visually-hidden',
      readOnly: true,
      value: textValue,
      tabIndex: -1,
    });
    document.body.appendChild(scratch);
    if (typeof scratch.select === 'function') scratch.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    scratch.remove();
    return ok === true;
  } catch (error) {
    return false;
  }
}

/* ==========================================================================
   mount(root, ctx) → { destroy() }
   ========================================================================== */

export async function mount(root, ctxArg) {
  if (!root || typeof root.replaceChildren !== 'function') {
    throw new Error('[alerts] mount 需要一个可写的容器元素');
  }
  const ctx = ctxArg && typeof ctxArg === 'object' ? ctxArg : {};
  const t = createTranslator(ctx);
  const locale = resolveLocale(ctx);
  const listTimeoutMs = resolveListTimeout(ctx);

  const state = {
    severity: '',
    status: '',
    q: '',
    sortKey: 'last_seen',
    sortDir: 'desc',
    limit: DEFAULT_LIMIT,
    requestedPages: 1,
    loadedPages: 0,
    alerts: [],
    cursor: null,
    hasMore: false,
    loading: true,
    loadingMore: false,
    loadMoreError: '',
    error: null,
  };
  Object.assign(state, normalizeParams(readParams(ctx)));

  let destroyed = false;
  let loadToken = 0;
  let searchTimer = null;
  let modelState = readModelStateSync(ctx);
  let drawerOverlay = null;
  let drawerAlert = null;
  let explainPanel = null;
  let lastTrigger = null;
  const rowNodes = new Map();

  /* ---------- i18n / 格式化 ---------- */

  function unavailable() {
    return t('alerts.value.unavailable');
  }

  function severityText(value) {
    const key = String(value == null ? '' : value).toLowerCase();
    if (SEVERITIES.indexOf(key) >= 0) return t('severity.' + key);
    return value == null || value === '' ? unavailable() : String(value);
  }

  function statusText(value) {
    const key = String(value == null ? '' : value).toLowerCase();
    if (ALERT_STATUSES.indexOf(key) >= 0) return t('status.' + key);
    return value == null || value === '' ? unavailable() : String(value);
  }

  function timeText(value) {
    return formatInstant(value, locale) || unavailable();
  }

  function countText(value) {
    const formatted = formatNumber(value, locale);
    return formatted === null ? unavailable() : formatted;
  }

  function yesNo(value) {
    if (value === true) return t('alerts.yes');
    if (value === false) return t('alerts.no');
    return unavailable();
  }

  function summaryText(alert) {
    const parts = [];
    const count = formatNumber(alert ? alert.count : null, locale);
    parts.push(count === null ? t('alerts.summary.no-count') : t('alerts.summary.hits', { count: count }));
    const evidence = formatNumber(alert ? alert.evidence_count : null, locale);
    parts.push(
      evidence === null ? t('alerts.summary.no-evidence') : t('alerts.summary.evidence', { count: evidence }),
    );
    if (alert && alert.evidence_truncated === true) parts.push(t('alerts.summary.truncated'));
    return parts.join(' · ');
  }

  function searchBlob(alert) {
    return [
      getAlertId(alert),
      alert.rule_id == null ? '' : String(alert.rule_id),
      alert.rule_version == null ? '' : String(alert.rule_version),
      summaryText(alert),
    ]
      .join(' ')
      .toLowerCase();
  }

  function hostCell(alert) {
    const host = alert ? alert.host : null;
    if (host !== null && host !== undefined && String(host) !== '') {
      return el('span', { class: 'mono', text: String(host) });
    }
    return el('span', {
      class: 'faint',
      text: t('alerts.host.unavailable'),
      title: t('alerts.host.unavailable.title'),
    });
  }

  function severityCell(alert) {
    return severityBadge(alert ? alert.severity : null, severityText(alert ? alert.severity : null));
  }

  function statusCell(alert) {
    return statusBadge(alert ? alert.status : null, statusText(alert ? alert.status : null));
  }

  function timeCell(alert, key) {
    const raw = alert ? alert[key] : null;
    const shown = timeText(raw);
    const title = parseInstant(raw) !== null ? String(raw) : t('alerts.value.unavailable');
    return el('span', { class: 'nowrap', text: shown, title: title });
  }

  function ruleCell(alert) {
    const ruleId = alert && alert.rule_id != null && String(alert.rule_id) !== '' ? String(alert.rule_id) : unavailable();
    const version =
      alert && alert.rule_version !== null && alert.rule_version !== undefined && String(alert.rule_version) !== ''
        ? t('alerts.rule.version', { version: String(alert.rule_version) })
        : '';
    return el('span', { class: 'mono' }, [
      el('span', { text: ruleId }),
      version ? el('span', { class: 'faint', text: ' ' + version }) : null,
    ]);
  }

  /* ---------- 参数 / URL ---------- */

  function hasActiveFilters() {
    return state.severity !== '' || state.status !== '' || state.q.trim() !== '';
  }

  function buildParams() {
    const params = {
      sort: state.sortKey + ':' + state.sortDir,
      limit: state.limit,
      loaded: Math.max(1, state.loadedPages || state.requestedPages),
    };
    if (state.severity) params.severity = state.severity;
    if (state.status) params.status = state.status;
    if (state.q.trim() !== '') params.q = state.q.trim();
    return params;
  }

  function serializeQuery(params) {
    const parts = [];
    Object.keys(params).forEach(function (key) {
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
    });
    return parts.join('&');
  }

  /**
   * 软写 hash：只 replaceState，不触发路由重挂载。
   * 用于「搜索防抖 / 加载更多 / 首屏参数规范化」——这些动作不该把当前视图销毁重来
   * （否则搜索框每 250ms 丢焦点、加载更多会重新拉取已加载的页）。
   * B2 的 router.navigate('alerts', params, {replace:true}) 会 remount 视图，
   * 所以只留给「筛选/排序」这类整表语义确实变化的动作。
   */
  function fallbackReplaceHash(params) {
    const query = serializeQuery(params);
    const hash = '#/alerts' + (query ? '?' + query : '');
    try {
      if (typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', hash);
        return;
      }
    } catch (error) {
      /* 落到 location.replace */
    }
    try {
      if (typeof location !== 'undefined') {
        location.replace(location.pathname + location.search + hash);
      }
    } catch (error) {
      /* 无法写 URL 时不阻塞渲染 */
    }
  }

  function sameParams(left, right) {
    const keys = new Set(Object.keys(left || {}).concat(Object.keys(right || {})));
    let same = true;
    keys.forEach(function (key) {
      if (!same) return;
      const a = left ? left[key] : undefined;
      const b = right ? right[key] : undefined;
      const aText = a === undefined || a === null ? '' : String(a);
      const bText = b === undefined || b === null ? '' : String(b);
      if (aText !== bText) same = false;
    });
    return same;
  }

  function hashNeedsSync(params) {
    const current = readHashParams();
    if (current === null) return true;
    return !sameParams(current, params);
  }

  /**
   * 同步 URL（合同 §7.2：筛选/排序/页/搜索必须同步到 hash，前进/后退可恢复）。
   * - 默认（首次调用即「整表语义变化」）走 ctx.navigate(..., {replace:true})：
   *   B2 router 实际签名是 navigate(routeId, params, {replace})；测试壳/其它宿主
   *   给的是 navigate(params, {replace})，两种都支持。
   * - options.soft=true 只 replaceState，避免 remount（搜索/加载更多/首屏规范化）。
   */
  function syncUrl(options) {
    if (destroyed) return;
    const opts = options || {};
    const params = buildParams();
    if (!hashNeedsSync(params)) return;
    if (!opts.soft && typeof ctx.navigate === 'function') {
      try {
        if (typeof ctx.route === 'string' && ctx.route !== '') {
          ctx.navigate('alerts', params, { replace: true });
        } else {
          ctx.navigate(params, { replace: true });
        }
        return;
      } catch (error) {
        /* navigate 失败时降级为直接 replaceState，保持 URL 与状态一致 */
      }
    }
    fallbackReplaceHash(params);
  }

  function readHashParams() {
    if (typeof location === 'undefined') return null;
    const hash = String(location.hash || '');
    if (!/^#\/alerts(?:[?]|$)/.test(hash)) return null;
    const queryIndex = hash.indexOf('?');
    if (queryIndex < 0) return {};
    const out = {};
    try {
      const params = new URLSearchParams(hash.slice(queryIndex + 1));
      params.forEach(function (value, key) {
        out[key] = value;
      });
    } catch (error) {
      return {};
    }
    return out;
  }

  function applyParams(rawParams, options) {
    const opts = options || {};
    const next = normalizeParams(rawParams);
    const pagesChanged = next.requestedPages !== state.requestedPages;
    const limitChanged = next.limit !== state.limit;
    state.severity = next.severity;
    state.status = next.status;
    state.q = next.q;
    state.sortKey = next.sortKey;
    state.sortDir = next.sortDir;
    state.limit = next.limit;
    state.requestedPages = next.requestedPages;
    syncControls();
    if (limitChanged || pagesChanged) {
      loadPages(state.requestedPages);
    } else {
      renderTable();
      if (opts.sync !== false) syncUrl();
    }
  }

  function onHashChange() {
    if (destroyed) return;
    const fromHash = readHashParams();
    if (!fromHash) return;
    const next = normalizeParams(fromHash);
    const current = normalizeParams(buildParams());
    const same =
      next.severity === current.severity &&
      next.status === current.status &&
      next.q === current.q &&
      next.sortKey === current.sortKey &&
      next.sortDir === current.sortDir &&
      next.limit === current.limit &&
      next.requestedPages === current.requestedPages;
    if (same) return;
    applyParams(fromHash, { sync: false });
  }

  /* ---------- 模型可用性（决定 AI 讲解按钮 disabled + title 原因） ---------- */

  function explainDisabledReason() {
    if (modelState.available) return null;
    return modelState.reason || 'noModel';
  }

  function explainDisabledText() {
    const reason = explainDisabledReason();
    if (!reason) return '';
    return t(EXPLAIN_DISABLED_KEY[reason] || EXPLAIN_DISABLED_KEY.noModel);
  }

  async function loadModelState() {
    if (modelState.known) {
      renderTable();
      return;
    }
    let doc = null;
    if (ctx.models && typeof ctx.models === 'object') doc = ctx.models;
    if (!doc && ctx.store && typeof ctx.store.select === 'function') {
      try {
        doc = ctx.store.select(function (snapshot) {
          return snapshot ? snapshot.models : null;
        });
      } catch (error) {
        doc = null;
      }
    }
    if (!doc && ctx.api && typeof ctx.api.getModels === 'function') {
      try {
        doc = await withTimeout(Promise.resolve(ctx.api.getModels()), listTimeoutMs);
      } catch (error) {
        doc = null;
      }
    }
    if (destroyed) return;
    modelState = classifyModels(doc);
    renderTable();
  }

  /* ---------- 列表数据 ---------- */

  function withTimeout(promise, ms) {
    const wait = Number(ms);
    if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve(promise);
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject({ code: 'TIMEOUT', message: 'list request exceeded ' + wait + 'ms' });
      }, wait);
      Promise.resolve(promise).then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function normalizeAlertsPage(body) {
    if (!body || typeof body !== 'object') throw { code: 'PARSE', message: 'empty response body' };
    let rows = null;
    if (Array.isArray(body.alerts)) rows = body.alerts;
    else if (Array.isArray(body.items)) rows = body.items;
    else if (Array.isArray(body.rows)) rows = body.rows;
    if (rows === null) throw { code: 'PARSE', message: 'response has no alerts array' };
    const page = body.page && typeof body.page === 'object' ? body.page : body;
    const hasMore = page.has_more === true || page.hasMore === true;
    let cursor = null;
    if (typeof page.next_cursor === 'string' && page.next_cursor !== '') cursor = page.next_cursor;
    else if (typeof page.nextCursor === 'string' && page.nextCursor !== '') cursor = page.nextCursor;
    const kept = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw { code: 'PARSE', message: 'alert row is not an object at index ' + index };
      }
      kept.push(row);
    }
    return { rows: kept, hasMore: hasMore, cursor: cursor };
  }

  async function fetchPage() {
    const api = ctx.api;
    if (!api || typeof api.listAlerts !== 'function') {
      throw { code: 'PARSE', message: 'ctx.api.listAlerts is missing' };
    }
    const body = await withTimeout(Promise.resolve(api.listAlerts({ limit: state.limit, cursor: state.cursor })), listTimeoutMs);
    return normalizeAlertsPage(body);
  }

  function appendPage(page) {
    const seen = new Set();
    state.alerts.forEach(function (row) {
      seen.add(getAlertId(row));
    });
    let fresh = 0;
    page.rows.forEach(function (row) {
      const id = getAlertId(row);
      if (seen.has(id)) return;
      seen.add(id);
      state.alerts.push(row);
      fresh += 1;
    });
    state.cursor = page.cursor;
    state.hasMore = page.hasMore && page.rows.length > 0;
    if (state.hasMore && state.cursor === null) state.hasMore = false;
    if (fresh === 0 && page.rows.length === 0) state.hasMore = false;
  }

  async function loadPages(count) {
    const token = (loadToken += 1);
    state.loading = true;
    state.error = null;
    state.loadMoreError = '';
    state.alerts = [];
    state.cursor = null;
    state.hasMore = false;
    state.loadedPages = 0;
    const target = Math.max(1, Math.min(MAX_PAGES, Number(count) || 1));
    renderTable();
    updateFooter(0);
    try {
      for (let index = 0; index < target; index += 1) {
        const page = await fetchPage();
        if (destroyed || token !== loadToken) return;
        appendPage(page);
        state.loadedPages += 1;
        if (state.alerts.length >= MAX_ROWS) break;
        if (!state.hasMore) break;
      }
      if (token !== loadToken) return;
      state.loading = false;
    } catch (error) {
      if (destroyed || token !== loadToken) return;
      state.loading = false;
      state.error = normalizeListError(error);
    }
    if (destroyed || token !== loadToken) return;
    renderTable();
    updateFooter(visibleRows().length);
    // 首屏只做软同步：把 URL 规范化到实际加载页数，不触发 B2 router 的重新挂载。
    syncUrl({ soft: true });
  }

  async function loadMore() {
    if (!canLoadMore()) return;
    state.loadingMore = true;
    updateFooter(visibleRows().length);
    try {
      const page = await fetchPage();
      if (destroyed) return;
      appendPage(page);
      state.loadedPages += 1;
      state.loadingMore = false;
      state.loadMoreError = '';
      renderTable();
      // 加载更多只扩展工作集，不换整表语义：软同步 loaded，避免 router 重挂载后重拉旧页。
      syncUrl({ soft: true });
    } catch (error) {
      if (destroyed) return;
      state.loadingMore = false;
      const info = normalizeListError(error);
      state.loadMoreError = listErrorText(info);
      updateFooter(visibleRows().length);
    }
  }

  function canLoadMore() {
    return (
      !state.loading &&
      !state.loadingMore &&
      !state.error &&
      state.hasMore &&
      state.loadedPages < MAX_PAGES &&
      state.alerts.length < MAX_ROWS
    );
  }

  function normalizeListError(error) {
    if (!error || typeof error !== 'object') {
      return { code: 'UNKNOWN', message: error == null ? '' : String(error) };
    }
    let code = String(error.code || (error.error && error.error.code) || '').toUpperCase();
    if (!code) {
      if (error.name === 'TypeError') code = 'NETWORK';
      else if (error.name === 'SyntaxError') code = 'PARSE';
      else code = 'UNKNOWN';
    }
    return {
      code: code,
      message: error.message == null ? '' : String(error.message),
      details: error.details && typeof error.details === 'object' ? error.details : null,
    };
  }

  function listErrorText(info) {
    const key = LIST_ERROR_KEY[info.code];
    if (key) return t(key);
    return t('alerts.error.code.unknown', { code: info.code });
  }

  /* ---------- 工作集内的筛选 / 排序 ---------- */

  function compareNullable(left, right, dir) {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    if (left === right) return 0;
    const base = left < right ? -1 : 1;
    return dir === 'asc' ? base : -base;
  }

  function sortValue(alert, key) {
    if (key === 'last_seen') {
      return parseInstant(alert ? alert.last_seen : null);
    }
    if (key === 'severity') {
      const keyValue = alert ? String(alert.severity || '').toLowerCase() : '';
      return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, keyValue) ? SEVERITY_RANK[keyValue] : null;
    }
    if (key === 'count') {
      const num = alert ? Number(alert.count) : NaN;
      return Number.isFinite(num) ? num : null;
    }
    return null;
  }

  function sortRows(rows) {
    const key = state.sortKey;
    const dir = state.sortDir;
    const ordered = rows.slice();
    ordered.sort(function (left, right) {
      const result = compareNullable(sortValue(left, key), sortValue(right, key), dir);
      if (result !== 0) return result;
      return compareText(getAlertId(left), getAlertId(right));
    });
    return ordered;
  }

  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    let rows = state.alerts;
    if (state.severity) {
      rows = rows.filter(function (alert) {
        return String(alert.severity || '').toLowerCase() === state.severity;
      });
    }
    if (state.status) {
      rows = rows.filter(function (alert) {
        return String(alert.status || '').toLowerCase() === state.status;
      });
    }
    if (q) {
      rows = rows.filter(function (alert) {
        return searchBlob(alert).indexOf(q) >= 0;
      });
    }
    return sortRows(rows);
  }

  /* ---------- 表格 / 空态 / 错误态 ---------- */

  function buildColumns() {
    return [
      {
        key: 'last_seen',
        label: t('alerts.column.time'),
        sortable: true,
        width: '168px',
        render: function (alert) {
          return timeCell(alert, 'last_seen');
        },
      },
      {
        key: 'rule_id',
        label: t('alerts.column.rule'),
        width: '200px',
        render: function (alert) {
          return ruleCell(alert);
        },
      },
      {
        key: 'severity',
        label: t('alerts.column.severity'),
        sortable: true,
        width: '110px',
        render: function (alert) {
          return severityCell(alert);
        },
      },
      {
        key: 'status',
        label: t('alerts.column.status'),
        width: '110px',
        render: function (alert) {
          return statusCell(alert);
        },
      },
      {
        key: 'host',
        label: t('alerts.column.host'),
        width: '130px',
        render: function (alert) {
          return hostCell(alert);
        },
      },
      {
        key: 'summary',
        label: t('alerts.column.summary'),
        render: function (alert) {
          return el('span', { class: 'muted', text: summaryText(alert) });
        },
      },
      {
        key: 'actions',
        label: t('alerts.column.actions'),
        align: 'right',
        width: '190px',
        render: function (alert) {
          return actionCell(alert);
        },
      },
    ];
  }

  function actionCell(alert) {
    const detailButton = button({
      icon: 'eye',
      size: 'sm',
      variant: 'ghost',
      ariaLabel: t('alerts.action.detail'),
      title: t('alerts.action.detail'),
      onClick: function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        openDrawer(alert, detailButton, { autoExplain: false });
      },
    });
    detailButton.setAttribute('data-action', 'detail');

    const disabledReason = explainDisabledReason();
    const disabledText = explainDisabledText();
    const explainButton = button({
      label: t('alerts.action.explain'),
      icon: 'agent',
      size: 'sm',
      variant: 'ghost',
      disabled: Boolean(disabledReason),
      title: disabledReason ? disabledText : t('alerts.explain.hint'),
      ariaLabel: disabledReason ? t('alerts.action.explain') + ' — ' + disabledText : t('alerts.action.explain'),
      onClick: function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        openDrawer(alert, explainButton, { autoExplain: true });
      },
    });
    explainButton.setAttribute('data-action', 'explain-row');
    explainButton.setAttribute('data-alert-id', getAlertId(alert));

    return el('span', { class: 'cluster' }, [detailButton, explainButton]);
  }

  function firstRunEmptyNode() {
    return el('div', { class: 'stack' }, [
      empty({ title: t('alerts.empty.title'), body: t('alerts.empty.body') }),
      el('div', { class: 'cluster' }, [
        button({
          label: t('alerts.empty.action-models'),
          variant: 'primary',
          onClick: function () {
            setHash('#/models');
          },
        }),
        button({
          label: t('alerts.empty.action-collect'),
          onClick: function () {
            setHash('#/settings?group=collection');
          },
        }),
      ]),
    ]);
  }

  function filteredEmptyNode() {
    return el('div', { class: 'stack' }, [
      empty({ title: t('alerts.empty-filtered.title'), body: t('alerts.empty-filtered.body') }),
      el('div', { class: 'cluster' }, [
        button({
          label: t('alerts.empty-filtered.action-reset'),
          variant: 'primary',
          onClick: resetFilters,
        }),
      ]),
    ]);
  }

  function setHash(hash) {
    try {
      if (typeof location !== 'undefined') location.hash = hash;
    } catch (error) {
      /* 无法导航时不阻塞渲染 */
    }
  }

  function errorNode(info) {
    const codeText = listErrorText(info);
    return el('div', { class: 'stack' }, [
      card({
        title: t('alerts.error.title'),
        note: codeText,
        body: el('div', { class: 'stack' }, [
          el('p', { class: 'muted', text: t('alerts.error.hint') }),
          el('div', { class: 'cluster' }, [
            button({
              label: t('common.action.retry'),
              variant: 'primary',
              icon: 'refresh',
              onClick: function () {
                loadPages(Math.max(1, state.requestedPages));
              },
            }),
          ]),
          el('p', {
            class: 'faint mono',
            text: t('alerts.error.code-line', { code: info.code }),
          }),
        ]),
      }),
    ]);
  }

  function renderTable() {
    const previousScroll = captureScroll();
    rowNodes.clear();
    if (state.error) {
      tableHost.replaceChildren(errorNode(state.error));
      updateFooter(0);
      return;
    }
    const rows = state.loading ? [] : visibleRows();
    let emptySpec = null;
    if (!state.loading && rows.length === 0) {
      emptySpec = hasActiveFilters() && state.alerts.length > 0 ? filteredEmptyNode() : firstRunEmptyNode();
    }
    const node = table({
      columns: buildColumns(),
      rows: rows,
      rowKey: function (row) {
        return getAlertId(row);
      },
      sort: { key: state.sortKey, dir: state.sortDir },
      onSort: handleHeaderSort,
      virtual: true,
      loading: state.loading,
      empty: emptySpec,
      ariaLabel: t('alerts.table.aria'),
      onRowClick: function (row) {
        const trigger = rowNodes.get(getAlertId(row)) || null;
        openDrawer(row, trigger, { autoExplain: false });
      },
    });
    tableHost.replaceChildren(node);
    indexRowNodes(node);
    restoreScroll(previousScroll);
    updateFooter(rows.length);
  }

  function indexRowNodes(container) {
    walkDom(container, function (node) {
      if (node.tagName !== 'TR') return;
      const key = node.getAttribute('data-key');
      if (key !== null) rowNodes.set(key, node);
    });
  }

  function captureScroll() {
    const scrollers = findAll(tableHost, function (node) {
      return hasClassToken(node, 'ui-table__scroll');
    });
    return scrollers.length ? scrollers[0].scrollTop : 0;
  }

  function restoreScroll(top) {
    if (!top) return;
    const scrollers = findAll(tableHost, function (node) {
      return hasClassToken(node, 'ui-table__scroll');
    });
    if (scrollers.length) scrollers[0].scrollTop = top;
  }

  function updateFooter(visibleCount) {
    if (state.loading) {
      statusLine.textContent = t('alerts.loading');
    } else if (state.error) {
      statusLine.textContent = t('alerts.loaded', { count: 0, pages: 0 });
    } else {
      const parts = [t('alerts.loaded', { count: state.alerts.length, pages: state.loadedPages })];
      if (visibleCount !== null && visibleCount !== undefined && visibleCount !== state.alerts.length) {
        parts.push(t('alerts.loaded-visible', { visible: visibleCount }));
      }
      statusLine.textContent = parts.join(' · ');
    }
    const canMore = canLoadMore();
    loadMoreBtn.disabled = state.loadingMore || !canMore;
    setButtonLabel(loadMoreBtn, state.loadingMore ? t('alerts.action.load-more-busy') : t('alerts.action.load-more'));
    moreBar.hidden = state.loading || Boolean(state.error);
    if (state.loadMoreError) {
      capNote.textContent = state.loadMoreError;
    } else if (state.error) {
      capNote.textContent = '';
    } else if (canMore) {
      capNote.textContent = '';
    } else if (state.loadedPages >= MAX_PAGES) {
      capNote.textContent = t('alerts.hint.cap-pages', { pages: MAX_PAGES });
    } else if (state.alerts.length >= MAX_ROWS) {
      capNote.textContent = t('alerts.hint.cap-rows', { rows: MAX_ROWS });
    } else if (state.loadedPages > 0 && !state.hasMore) {
      capNote.textContent = t('alerts.hint.end');
    } else {
      capNote.textContent = '';
    }
  }

  /* ---------- 交互 ---------- */

  function resetFilters() {
    state.severity = '';
    state.status = '';
    state.q = '';
    syncControls();
    renderTable();
    syncUrl();
  }

  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    const value = String(searchInput.value || '');
    searchTimer = setTimeout(function () {
      searchTimer = null;
      if (destroyed) return;
      state.q = value.slice(0, 100);
      renderTable();
      // 搜索只改工作集内过滤结果：软同步 q，避免防抖后 router 重挂载导致输入框丢焦点。
      syncUrl({ soft: true });
    }, SEARCH_DEBOUNCE_MS);
  }

  function onSeverityChange(value) {
    state.severity = String(value || '');
    renderTable();
    syncUrl();
  }

  function onStatusChange(value) {
    state.status = String(value || '');
    renderTable();
    syncUrl();
  }

  function onSortKeyChange(value) {
    const key = String(value || '');
    if (SORT_KEYS.indexOf(key) < 0) return;
    state.sortKey = key;
    state.sortDir = SORT_DEFAULT_DIR[key] || 'desc';
    syncControls();
    renderTable();
    syncUrl();
  }

  function onSortDirToggle() {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    syncControls();
    renderTable();
    syncUrl();
  }

  function handleHeaderSort(next) {
    if (!next || SORT_KEYS.indexOf(String(next.key)) < 0) return;
    const key = String(next.key);
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = SORT_DEFAULT_DIR[key] || 'desc';
    }
    syncControls();
    renderTable();
    syncUrl();
  }

  function syncControls() {
    if (searchInput.value !== state.q) searchInput.value = state.q;
    severitySelect.value = state.severity;
    statusSelect.value = state.status;
    sortSelect.value = state.sortKey;
    setButtonLabel(dirButton, state.sortDir === 'desc' ? t('alerts.sort.desc') : t('alerts.sort.asc'));
  }

  /* ---------- 详情抽屉 ---------- */

  function detailRow(label, content) {
    const valueNode =
      content && typeof content === 'object' && typeof content.nodeType === 'number'
        ? content
        : el('span', { class: 'mono', text: content == null ? unavailable() : String(content) });
    return el('div', { class: 'cluster' }, [
      el('span', { class: cls('muted', 'nowrap'), text: label + '：' }),
      el('span', { class: 'grow' }, [valueNode]),
    ]);
  }

  function buildDetailFields(alert) {
    const firstSeen = timeCell(alert, 'first_seen');
    const lastSeen = timeCell(alert, 'last_seen');
    const windowStart = timeCell(alert, 'window_start');
    const windowEnd = timeCell(alert, 'window_end');
    return el('div', { class: 'stack' }, [
      detailRow(t('alerts.detail.alert-id'), alert.alert_id == null ? unavailable() : String(alert.alert_id)),
      detailRow(t('alerts.detail.rule-id'), alert.rule_id == null ? unavailable() : String(alert.rule_id)),
      detailRow(
        t('alerts.detail.rule-version'),
        alert.rule_version == null ? unavailable() : String(alert.rule_version),
      ),
      detailRow(t('alerts.detail.severity'), severityCell(alert)),
      detailRow(t('alerts.detail.status'), statusCell(alert)),
      detailRow(t('alerts.detail.count'), countText(alert.count)),
      detailRow(t('alerts.detail.first-seen'), firstSeen),
      detailRow(t('alerts.detail.last-seen'), lastSeen),
      detailRow(t('alerts.detail.window-start'), windowStart),
      detailRow(t('alerts.detail.window-end'), windowEnd),
      detailRow(
        t('alerts.detail.window'),
        t('alerts.detail.window-span', {
          start: timeText(alert.window_start),
          end: timeText(alert.window_end),
        }),
      ),
      detailRow(t('alerts.detail.evidence-count'), countText(alert.evidence_count)),
      detailRow(t('alerts.detail.evidence-truncated'), yesNo(alert.evidence_truncated)),
      detailRow(t('alerts.detail.host'), hostCell(alert)),
    ]);
  }

  function buildDrawerBody(alert) {
    const summary = el('div', { class: 'cluster' }, [
      severityCell(alert),
      statusCell(alert),
      badge({ tone: 'neutral', text: t('alerts.summary.hits-short', { count: countText(alert.count) }) }),
      el('span', {
        class: 'faint',
        text: t('alerts.detail.window-span', {
          start: timeText(alert.window_start),
          end: timeText(alert.window_end),
        }),
      }),
    ]);
    const fieldsCard = card({
      title: t('alerts.drawer.fields'),
      note: t('alerts.drawer.fields-note'),
      body: buildDetailFields(alert),
    });
    const panel = createExplainPanel(alert);
    explainPanel = panel;
    return el('div', { class: 'stack' }, [card({ plain: true, body: summary }), fieldsCard, panel.node]);
  }

  function openDrawer(alert, trigger, options) {
    if (!alert || destroyed) return null;
    const opts = options || {};
    if (drawerOverlay && drawerOverlay.isOpen) drawerOverlay.close('api');
    drawerAlert = alert;
    lastTrigger = trigger && typeof trigger.focus === 'function' ? trigger : null;
    if (lastTrigger && lastTrigger.isConnected) lastTrigger.focus();
    const body = buildDrawerBody(alert);
    const panel = explainPanel;
    const alertId = getAlertId(alert);
    const overlay = drawer({
      title: t('alerts.drawer.title', { id: alertId || unavailable() }),
      body: body,
      closeLabel: t('common.action.close'),
      onClose: function (reason) {
        if (panel) panel.destroy();
        if (drawerOverlay === overlay) {
          drawerOverlay = null;
          drawerAlert = null;
          explainPanel = null;
          restoreFocus(alertId);
        }
      },
    });
    drawerOverlay = overlay;
    if (opts.autoExplain && panel) panel.start();
    return overlay;
  }

  function restoreFocus(alertId) {
    if (lastTrigger && lastTrigger.isConnected && typeof lastTrigger.focus === 'function') {
      lastTrigger.focus();
      return;
    }
    if (alertId) {
      const row = rowNodes.get(alertId);
      if (row && row.isConnected) row.focus();
    }
  }

  /* ---------- 流式 AI 讲解 ---------- */

  function explainErrorInfo(error) {
    let code = 'UNKNOWN';
    let retryAfter = null;
    if (typeof error === 'string') {
      code = error.toUpperCase();
    } else if (error && typeof error === 'object') {
      const raw = error.code || (error.error && error.error.code) || (error.type === 'error' ? 'UNKNOWN' : '');
      if (raw) code = String(raw).toUpperCase();
      if (error.retryAfter !== undefined && error.retryAfter !== null) retryAfter = error.retryAfter;
      else if (error.details && error.details.retryAfter !== undefined) retryAfter = error.details.retryAfter;
      if (code === 'UNKNOWN' && error.name === 'TypeError') code = 'NETWORK';
    }
    if (code === 'ALERT_NOT_FOUND') {
      return { text: t('alerts.explain.error.not-found'), settings: false, retryable: false };
    }
    if (MODEL_ERROR_CODES.has(code)) {
      return { text: t('alerts.explain.error.model'), settings: true, retryable: true };
    }
    if (code === 'CHAT_BUSY') {
      return {
        text: t('alerts.explain.error.busy', { retryAfter: retryAfter == null ? '—' : String(retryAfter) }),
        settings: false,
        retryable: true,
      };
    }
    if (code === 'UPSTREAM_FAILED' || code === 'UPSTREAM_TIMEOUT' || code === 'UPSTREAM_REDIRECT') {
      return { text: t('alerts.explain.error.upstream'), settings: false, retryable: true };
    }
    if (code === 'TIMEOUT' || code === 'SSE_IDLE_TIMEOUT' || code === 'SSE_TOTAL_TIMEOUT') {
      return { text: t('alerts.explain.error.timeout'), settings: false, retryable: true };
    }
    if (code === 'NETWORK' || code === 'INTERRUPTED' || code === 'NO_API') {
      return { text: t('alerts.explain.error.interrupted'), settings: false, retryable: true };
    }
    return { text: t('alerts.explain.error.unknown', { code: code }), settings: false, retryable: true };
  }

  function createExplainPanel(alert) {
    const panelState = {
      text: '',
      state: 'idle',
      terminal: false,
      aborted: false,
      destroyed: false,
      seqs: new Set(),
      usage: null,
      res: null,
      copyTimer: null,
    };
    const disabledReason = explainDisabledReason();
    const disabledText = explainDisabledText();

    const output = el('textarea', {
      class: 'ui-textarea mono',
      readOnly: true,
      rows: 10,
      value: '',
      'aria-label': t('alerts.explain.output'),
    });
    const live = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: t('alerts.explain.idle') });
    const copyStatus = el('span', { class: 'faint', role: 'status', 'aria-live': 'polite' });
    const errorBox = el('div', { class: 'stack', hidden: true });

    const actionButton = button({
      label: t('alerts.explain.generate'),
      icon: 'agent',
      variant: 'primary',
      disabled: Boolean(disabledReason),
      title: disabledReason || '',
      onClick: function () {
        if (panelState.state === 'streaming') stop();
        else start();
      },
    });
    actionButton.setAttribute('data-action', 'explain-drawer');

    const copyButton = button({
      label: t('common.action.copy'),
      icon: 'copy',
      variant: 'ghost',
      disabled: true,
      title: t('alerts.explain.copy-hint'),
      onClick: function () {
        onCopy();
      },
    });
    copyButton.setAttribute('data-action', 'explain-copy');

    const disabledNote = disabledReason
      ? el('div', { class: 'stack' }, [
          el('p', { class: 'muted', text: disabledText }),
          el(
            'a',
            {
              class: 'ui-btn',
              data: { variant: 'secondary', size: 'sm' },
              href: '#/models',
              title: t('alerts.explain.error.settings-action'),
            },
            [el('span', { text: t('alerts.explain.error.settings-action') })],
          ),
        ])
      : null;

    const node = card({
      title: t('alerts.explain.title'),
      note: t('alerts.explain.hint'),
      actions: [actionButton, copyButton],
      body: el('div', { class: 'stack' }, [live, output, copyStatus, errorBox, disabledNote]),
    });
    node.setAttribute('data-explain', getAlertId(alert));

    function setButtonLabelText(btn, label) {
      setButtonLabel(btn, label);
    }

    function setUiState(name) {
      panelState.state = name;
      const streaming = name === 'streaming';
      const label = streaming
        ? t('alerts.explain.stop')
        : panelState.text
          ? t('alerts.explain.regenerate')
          : t('alerts.explain.generate');
      setButtonLabelText(actionButton, label);
      actionButton.setAttribute('data-variant', streaming ? 'danger' : name === 'done' ? 'secondary' : 'primary');
      actionButton.disabled = Boolean(disabledReason) && !streaming;
      actionButton.setAttribute(
        'title',
        streaming ? t('alerts.explain.stop-title') : disabledReason ? disabledText : t('alerts.explain.hint'),
      );
      copyButton.disabled = panelState.text.length === 0;
      if (streaming) live.textContent = t('alerts.explain.generating');
      else if (name === 'done') live.textContent = t('alerts.explain.done');
      else if (name === 'stopped') live.textContent = t('alerts.explain.stopped');
      else if (name === 'error') live.textContent = '';
      else live.textContent = t('alerts.explain.idle');
    }

    function abortStream() {
      if (panelState.res && typeof panelState.res.abort === 'function') {
        try {
          panelState.res.abort();
        } catch (error) {
          /* abort 失败不影响 UI 状态 */
        }
      }
      panelState.aborted = true;
      panelState.res = null;
    }

    function buildBody() {
      const body = { locale: locale };
      if (modelState.modelId) body.modelId = modelState.modelId;
      return body;
    }

    function pushDelta(data) {
      if (panelState.destroyed) return;
      let textValue = null;
      let seq = null;
      if (typeof data === 'string') {
        textValue = data;
      } else if (typeof data === 'number') {
        textValue = String(data);
      } else if (data && typeof data === 'object') {
        if (typeof data.text === 'string') textValue = data.text;
        else if (typeof data.delta === 'string') textValue = data.delta;
        else if (typeof data.content === 'string') textValue = data.content;
        if (data.seq !== undefined && data.seq !== null) seq = String(data.seq);
      }
      if (textValue === null) return;
      if (seq !== null) {
        if (panelState.seqs.has(seq)) return;
        panelState.seqs.add(seq);
      }
      panelState.text += textValue;
      output.value = panelState.text;
      copyButton.disabled = false;
      if (panelState.state !== 'streaming') setUiState('streaming');
      else setButtonLabelText(actionButton, t('alerts.explain.stop'));
    }

    function finish(data) {
      if (panelState.terminal) return;
      // B2 的 api.explainAlert(...).done 解析出的结果带 terminal 字段（sse.js §3.3）：
      // error / interrupted / aborted 都不能画成「已完成」。
      if (data && typeof data === 'object') {
        if (data.terminal === 'error') {
          fail(data.error || { code: 'UPSTREAM_FAILED' });
          return;
        }
        if (data.terminal === 'interrupted') {
          fail({ code: 'INTERRUPTED' });
          return;
        }
        if (data.terminal === 'aborted') {
          if (!panelState.aborted) stop();
          return;
        }
        if (typeof data.text === 'string' && data.text !== '' && data.text !== panelState.text) {
          panelState.text = data.text;
          output.value = panelState.text;
          copyButton.disabled = false;
        }
        if (data.usage) panelState.usage = data.usage;
      }
      panelState.terminal = true;
      setUiState('done');
      let suffix = '';
      const totalTokens = panelState.usage ? Number(panelState.usage.totalTokens) : NaN;
      const shown = Number.isFinite(totalTokens) ? formatNumber(totalTokens, locale) : null;
      if (shown !== null) suffix = ' · ' + t('alerts.explain.usage', { total: shown });
      live.textContent = t('alerts.explain.done') + suffix;
    }

    function fail(error) {
      if (panelState.terminal) return;
      panelState.terminal = true;
      const info = explainErrorInfo(error);
      setUiState('error');
      errorBox.hidden = false;
      const children = [
        el('p', { class: 'ui-field__error', 'aria-live': 'polite', text: info.text }),
      ];
      if (info.settings) {
        children.push(
          el(
            'a',
            {
              class: 'ui-btn',
              data: { variant: 'secondary', size: 'sm' },
              href: '#/models',
              title: t('alerts.explain.error.settings-action'),
            },
            [el('span', { text: t('alerts.explain.error.settings-action') })],
          ),
        );
      }
      if (info.retryable) {
        children.push(
          el('div', { class: 'cluster' }, [
            button({
              label: t('common.action.retry'),
              size: 'sm',
              onClick: function () {
                start();
              },
            }),
          ]),
        );
      }
      errorBox.replaceChildren.apply(errorBox, children);
    }

    function dispatchEvent(typeValue, payload) {
      const type = String(typeValue || '');
      if (type === 'delta') pushDelta(payload);
      else if (type === 'done') finish(payload);
      else if (type === 'error') fail(payload);
      else if (type === 'usage') panelState.usage = payload;
    }

    function handleEvent(event, maybeData) {
      if (typeof event === 'string') {
        dispatchEvent(event, maybeData);
        return;
      }
      if (!event || typeof event !== 'object') return;
      const type = event.type || event.event || (event.data && typeof event.data === 'object' ? event.data.type : '');
      const payload = event.data && typeof event.data === 'object' ? event.data : event;
      if (!type) {
        if (event.text !== undefined || event.seq !== undefined) pushDelta(event);
        return;
      }
      dispatchEvent(type, payload);
    }

    function start() {
      if (panelState.destroyed || disabledReason) return;
      abortStream();
      panelState.text = '';
      panelState.seqs.clear();
      panelState.terminal = false;
      panelState.aborted = false;
      panelState.usage = null;
      panelState.res = null;
      output.value = '';
      errorBox.hidden = true;
      errorBox.replaceChildren();
      copyStatus.textContent = '';
      setUiState('streaming');
      const api = ctx.api;
      if (!api || typeof api.explainAlert !== 'function') {
        fail({ code: 'NO_API' });
        return;
      }
      let result = null;
      try {
        result = api.explainAlert(getAlertId(alert), buildBody(), {
          onEvent: function (event, data) {
            handleEvent(event, data);
          },
          onDelta: function (data) {
            pushDelta(data);
          },
          onDone: function (data) {
            finish(data);
          },
          onError: function (error) {
            fail(error);
          },
        });
      } catch (error) {
        fail(error);
        return;
      }
      panelState.res = result && typeof result === 'object' ? result : null;
      if (panelState.res && panelState.res.done && typeof panelState.res.done.then === 'function') {
        panelState.res.done.then(
          function (result) {
            if (panelState.terminal || panelState.aborted) return;
            // 成功/中断/error 都经 finish() 统一判定（terminal 字段见 sse.js §3.3）。
            finish(result);
          },
          function (error) {
            if (panelState.terminal || panelState.aborted) return;
            fail(error);
          },
        );
      }
    }

    function stop() {
      if (panelState.state !== 'streaming') return;
      abortStream();
      panelState.terminal = true;
      setUiState('stopped');
    }

    async function onCopy() {
      if (panelState.text === '') return;
      const ok = await copyText(panelState.text);
      if (panelState.destroyed) return;
      copyStatus.textContent = ok ? t('alerts.explain.copied') : t('alerts.explain.copy-failed');
      if (panelState.copyTimer) clearTimeout(panelState.copyTimer);
      panelState.copyTimer = setTimeout(function () {
        panelState.copyTimer = null;
        if (!panelState.destroyed) copyStatus.textContent = '';
      }, 2000);
    }

    function destroyPanel() {
      if (panelState.destroyed) return;
      panelState.destroyed = true;
      abortStream();
      if (panelState.copyTimer) {
        clearTimeout(panelState.copyTimer);
        panelState.copyTimer = null;
      }
    }

    return {
      node: node,
      start: start,
      stop: stop,
      destroy: destroyPanel,
      getState: function () {
        return panelState.state;
      },
      getText: function () {
        return panelState.text;
      },
    };
  }

  /* ---------- 外壳 ---------- */

  const pageHead = el('div', { class: 'page-head' }, [
    el('div', { class: 'page-head__text' }, [
      el('h1', { class: 'page-head__title', text: t('alerts.title') }),
      el('p', { class: 'page-head__sub', text: t('alerts.subtitle') }),
    ]),
    el('div', { class: 'page-head__actions' }, [
      button({
        label: t('common.action.refresh'),
        icon: 'refresh',
        onClick: function () {
          loadPages(Math.max(1, state.requestedPages));
        },
      }),
    ]),
  ]);

  const searchInput = input({
    type: 'search',
    value: state.q,
    placeholder: t('alerts.filter.search-placeholder'),
    ariaLabel: t('alerts.filter.search'),
    maxLength: 100,
    onInput: onSearchInput,
  });
  const searchField = field({ label: t('alerts.filter.search'), control: searchInput });
  searchField.classList.add('grow');

  const severitySelect = select({
    options: [{ value: '', label: t('alerts.filter.all') }].concat(
      SEVERITIES.map(function (severity) {
        return { value: severity, label: t('severity.' + severity) };
      }),
    ),
    value: state.severity,
    ariaLabel: t('alerts.filter.severity'),
    onChange: onSeverityChange,
  });
  const severityField = field({ label: t('alerts.filter.severity'), control: severitySelect });

  const statusSelect = select({
    options: [{ value: '', label: t('alerts.filter.all') }].concat(
      ALERT_STATUSES.map(function (status) {
        return { value: status, label: t('status.' + status) };
      }),
    ),
    value: state.status,
    ariaLabel: t('alerts.filter.status'),
    onChange: onStatusChange,
  });
  const statusField = field({ label: t('alerts.filter.status'), control: statusSelect });

  const sortSelect = select({
    options: [
      { value: 'last_seen', label: t('alerts.sort.last-seen') },
      { value: 'severity', label: t('alerts.sort.severity') },
      { value: 'count', label: t('alerts.sort.count') },
    ],
    value: state.sortKey,
    ariaLabel: t('alerts.sort.label'),
    onChange: onSortKeyChange,
  });
  const sortField = field({ label: t('alerts.sort.label'), control: sortSelect });

  const dirButton = button({
    label: state.sortDir === 'desc' ? t('alerts.sort.desc') : t('alerts.sort.asc'),
    icon: state.sortDir === 'desc' ? 'arrow-down' : 'arrow-up',
    ariaLabel: t('alerts.sort.direction'),
    onClick: onSortDirToggle,
  });

  const resetButton = button({
    label: t('alerts.filter.reset'),
    icon: 'filter',
    variant: 'ghost',
    onClick: resetFilters,
  });

  const filterBar = el('div', { class: 'cluster' }, [
    searchField,
    severityField,
    statusField,
    sortField,
    dirButton,
    resetButton,
  ]);

  const workSetNote = el('p', { class: 'faint', text: t('alerts.work-set.note') });

  const tableHost = el('div', { class: 'stack' });
  const statusLine = el('p', { class: 'muted', role: 'status', 'aria-live': 'polite', text: t('alerts.loading') });
  const loadMoreBtn = button({
    label: t('alerts.action.load-more'),
    icon: 'chevron-down',
    onClick: function () {
      loadMore();
    },
  });
  const capNote = el('span', { class: 'faint' });
  const moreBar = el('div', { class: 'cluster' }, [loadMoreBtn, capNote]);

  const page = el('div', { class: 'stack' }, [pageHead, filterBar, workSetNote, tableHost, statusLine, moreBar]);

  root.replaceChildren(page);

  // B2 的 router 自己在 hashchange 时 destroy + 重新 mount（ctx.params 就是新参数），
  // 这里只在没有 router（ctx.route 缺失，例如 B11 的 DOM stub / 其它宿主）时兜底监听，
  // 避免同一 hashchange 被处理两次。
  const hasRouterContext = typeof ctx.route === 'string' && ctx.route !== '';
  if (!hasRouterContext && typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('hashchange', onHashChange);
  }

  syncControls();
  renderTable();
  loadPages(state.requestedPages);
  loadModelState();

  return {
    destroy: function destroy() {
      if (destroyed) return;
      destroyed = true;
      loadToken += 1;
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
      }
      if (explainPanel) explainPanel.destroy();
      if (drawerOverlay && drawerOverlay.isOpen) drawerOverlay.close('api');
      if (!hasRouterContext && typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('hashchange', onHashChange);
      }
      if (root && typeof root.replaceChildren === 'function') root.replaceChildren();
    },
  };
}

/* ==========================================================================
   与 ctx 的适配（保持对 B2 实现的最小假设）
   ========================================================================== */

function createTranslator(ctx) {
  const i18n = ctx && ctx.i18n;
  let fn = null;
  if (typeof i18n === 'function') fn = i18n;
  else if (i18n && typeof i18n.t === 'function') fn = function (key, vars) {
    return i18n.t(key, vars);
  };
  const fallbackMap = ctx && ctx.text && typeof ctx.text === 'object' ? ctx.text : null;
  return function translate(key, vars) {
    if (fn) {
      try {
        const value = fn(key, vars);
        if (value !== null && value !== undefined) {
          const textValue = String(value);
          return vars ? interpolate(textValue, vars) : textValue;
        }
      } catch (error) {
        /* 落到 [missing:key]，让缺失可见（合同 §8.5 禁止静默空白） */
      }
    }
    if (fallbackMap && fallbackMap[key] !== undefined) {
      return interpolate(String(fallbackMap[key]), vars);
    }
    return '[missing:' + key + ']';
  };
}

function resolveLocale(ctx) {
  const i18n = ctx && ctx.i18n;
  if (i18n) {
    if (typeof i18n.locale === 'string' && i18n.locale) return i18n.locale;
    if (typeof i18n.getLocale === 'function') {
      try {
        const value = i18n.getLocale();
        if (typeof value === 'string' && value) return value;
      } catch (error) {
        /* ignore */
      }
    }
  }
  if (ctx && typeof ctx.locale === 'string' && ctx.locale) return ctx.locale;
  if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
    return document.documentElement.lang;
  }
  return 'zh-CN';
}

function resolveListTimeout(ctx) {
  const configured = ctx && ctx.timeouts && Number(ctx.timeouts.listMs);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LIST_TIMEOUT_MS;
}

/** ctx.params / location 查询串 → 归一化状态。 */
function readParams(ctx) {
  const raw = ctx && ctx.params;
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    const queryIndex = raw.indexOf('?');
    const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : raw.replace(/^#?\/?alerts\/?/, '');
    const out = {};
    try {
      const params = new URLSearchParams(query);
      params.forEach(function (value, key) {
        out[key] = value;
      });
    } catch (error) {
      return {};
    }
    return out;
  }
  if (typeof raw === 'object') {
    if (raw.query && typeof raw.query === 'object') return raw.query;
    if (raw.params && typeof raw.params === 'object') return raw.params;
    const out = {};
    Object.keys(raw).forEach(function (key) {
      const value = raw[key];
      if (value === undefined || value === null) return;
      if (typeof value === 'object') return;
      out[key] = String(value);
    });
    return out;
  }
  return {};
}

function normalizeParams(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const severityRaw = String(source.severity == null ? '' : source.severity).toLowerCase();
  const statusRaw = String(source.status == null ? '' : source.status).toLowerCase();
  const sortRaw = String(source.sort == null ? '' : source.sort);
  const sortParts = sortRaw.split(':');
  const sortKey = SORT_KEYS.indexOf(sortParts[0]) >= 0 ? sortParts[0] : 'last_seen';
  const sortDir = sortParts[1] === 'asc' ? 'asc' : 'desc';
  const limitNumber = Number(source.limit);
  const limit = PAGE_SIZES.indexOf(limitNumber) >= 0 ? limitNumber : DEFAULT_LIMIT;
  const loadedNumber = Number(source.loaded);
  const requestedPages =
    Number.isFinite(loadedNumber) && loadedNumber >= 1 ? Math.min(MAX_PAGES, Math.floor(loadedNumber)) : 1;
  const q = typeof source.q === 'string' ? source.q.slice(0, 100) : '';
  return {
    severity: SEVERITIES.indexOf(severityRaw) >= 0 ? severityRaw : '',
    status: ALERT_STATUSES.indexOf(statusRaw) >= 0 ? statusRaw : '',
    q: q,
    sortKey: sortKey,
    sortDir: sortDir,
    limit: limit,
    requestedPages: requestedPages,
  };
}

/** 同步可读的模型投影（ctx.models / store 里已有就不额外发请求）。 */
function readModelStateSync(ctx) {
  if (ctx && ctx.models && typeof ctx.models === 'object') return classifyModels(ctx.models);
  return { available: true, reason: null, unknown: true, known: false, modelId: null };
}

/**
 * §2.2 模型运行态 → 讲解可用性。
 * 三种禁用原因必须可区分（合同 §2.2 / §2.6）：
 *   egress  = 零外联默认关（models.egressEnabled=false）
 *   engine  = 没有任何可用 chat 引擎（engine.selected 空/none 且 harness 不可用）
 *   noModel = 引擎在，但没有「enabled + 有密钥」的 provider / 模型
 * 拿不到投影（null）时**不谎称**不可用：available=true 且 unknown，错误由流内联呈现。
 */
function classifyModels(doc) {
  if (!doc || typeof doc !== 'object') {
    return { available: true, reason: null, unknown: true, known: false, modelId: null };
  }
  if (doc.egressEnabled === false) {
    return { available: false, reason: 'egress', unknown: false, known: true, modelId: null };
  }
  const engineInfo = doc.engine && typeof doc.engine === 'object' ? doc.engine : null;
  if (engineInfo) {
    const selected = engineInfo.selected;
    const harnessOk = Boolean(engineInfo.harness && engineInfo.harness.available === true);
    const engineUsable =
      (typeof selected === 'string' && selected !== '' && selected !== 'none') || harnessOk;
    if (!engineUsable) {
      return { available: false, reason: 'engine', unknown: false, known: true, modelId: null };
    }
  }
  const providers = Array.isArray(doc.providers) ? doc.providers : [];
  const usableProviderIds = [];
  providers.forEach(function (provider) {
    if (!provider || typeof provider !== 'object') return;
    if (provider.enabled === true && provider.hasCredential === true && provider.id) {
      usableProviderIds.push(String(provider.id));
    }
  });
  const models = Array.isArray(doc.models) ? doc.models : [];
  const usable = models.filter(function (model) {
    return model && typeof model === 'object' && usableProviderIds.indexOf(String(model.providerId)) >= 0;
  });
  if (usable.length === 0) {
    return { available: false, reason: 'noModel', unknown: false, known: true, modelId: null };
  }
  const routing = doc.routing && typeof doc.routing === 'object' ? doc.routing : null;
  const uniform = routing && routing.mode === 'uniform' ? routing.uniformModelId : null;
  let chosen = usable[0].id == null ? null : String(usable[0].id);
  if (uniform) {
    const hit = usable.filter(function (model) {
      return String(model.id) === String(uniform);
    });
    if (hit.length) chosen = String(hit[0].id);
  }
  return { available: true, reason: null, unknown: false, known: true, modelId: chosen };
}

function setButtonLabel(buttonNode, label) {
  if (!buttonNode) return;
  let labelNode = null;
  walkDom(buttonNode, function (node) {
    if (labelNode) return;
    if (node.tagName === 'SPAN' && hasClassToken(node, 'ui-btn__label')) labelNode = node;
  });
  const textValue = label == null ? '' : String(label);
  if (labelNode) {
    labelNode.textContent = textValue;
    return;
  }
  if (buttonNode.textContent !== textValue) buttonNode.textContent = textValue;
}
