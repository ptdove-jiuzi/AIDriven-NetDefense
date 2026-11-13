/**
 * AIDriven NetDefense · WebUI v2 · 分析视图（`#/analysis`）
 * B6 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md
 *  - §7.2 视图签名 `export async function mount(root, ctx) → { destroy() }`；
 *    筛选/排序/搜索**必须**同步到 hash（`replaceState`），前进/后退能恢复。
 *  - §7.3 只调用 `api.listAnalyses({limit, cursor})`；没有第三条接口。
 *  - §7.6 只用 B1 组件；表格用 B1 的虚拟滚动（threshold=200），分页用 cursor「加载更多」。
 *  - §12.1-4 筛选/搜索/排序只在**已加载工作集**内做，UI 明示"已加载 N 条"，不谎称全库。
 *  - §12.1-5 用量为空源于"分析链路未接线"，与 `report_available=false` 是同一件事的两面。
 *
 * 数据纪律（字段白名单来自 `apps/daemon/src/api/query.js:214 projectAnalysis()`，
 * 服务端也只投影这 9 个字段）：
 *  `analysis_id / alert_id / state / budget_class / attempts / created_at / updated_at /
 *   completed_at / report_available`
 *  - **没有单条详情路由**（`GET /api/v1/analysis/:id` 不存在，合同 §2.9 也没打算加）：
 *    抽屉只渲染列表里已有的这 9 个字段，不额外发请求、不伪造字段。
 *  - `report_available=false` 只表示"没有报告行"，**不是失败**（`analysis_outbox` 只写不派发）。
 *  - `state` 枚举来自 `packages/event-store/src/schema.js:154`：
 *    `queued|dispatched|running|succeeded|degraded|failed|cancelled`（未知值原样显示，不猜）。
 *  - `budget_class` 是 `config.policy.budgetClass` 的自由字符串（默认 `standard`），不是枚举。
 */

import { el } from '../components/ui/dom.js';
import { card } from '../components/ui/card.js';
import { table } from '../components/ui/table.js';
import { badge } from '../components/ui/badge.js';
import { empty } from '../components/ui/empty.js';
import { skeleton } from '../components/ui/skeleton.js';
import { button } from '../components/ui/button.js';
import { drawer } from '../components/ui/drawer.js';
import { field, input } from '../components/ui/field.js';
import { select } from '../components/ui/select.js';

/** 服务端每页上限（合同 §7.6：每页 ≤100）。 */
const PAGE_SIZE = 100;

/** 已加载工作集上限：5 页 × 100 条（与合同 §12.1-4 "最多 5×100" 同一口径）。 */
const MAX_PAGES = 5;
const MAX_ROWS = PAGE_SIZE * MAX_PAGES;

/** 搜索防抖（毫秒）。回车/失焦走 change，立即生效。 */
const SEARCH_DEBOUNCE_MS = 180;

/** `state` 的权威枚举（`packages/event-store/src/schema.js:154`）。 */
const KNOWN_STATES = ['queued', 'dispatched', 'running', 'succeeded', 'degraded', 'failed', 'cancelled'];

/** 排序选项 → `sort` 参数值（合同 §7.2 例：`sort=last_seen:desc`）。 */
const SORT_OPTIONS = ['created_at:desc', 'created_at:asc', 'attempts:desc'];
const DEFAULT_SORT = SORT_OPTIONS[0];

/** 分析列表只有 whitelist 的这 9 个字段（`query.js:214`），抽屉不得越界。 */
const ANALYSIS_FIELDS = [
  'analysis_id',
  'alert_id',
  'state',
  'budget_class',
  'attempts',
  'created_at',
  'updated_at',
  'completed_at',
  'report_available',
];

/* ══════════════════════════════════════════════════════════════════════════
   1. i18n / 格式化小工具（视图内自足；不引 B2 模块）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 把 `ctx.i18n` 归一成 `t(key, vars) → string`；缺 key 保留 `[missing:key]`（§8-5 禁止静默空白）。
 *
 * @param {{t?: Function}|null|undefined} i18n i18n 实例。
 * @returns {(key: string, vars?: object) => string} 翻译函数。
 */
function createTranslator(i18n) {
  return function translate(key, vars) {
    if (i18n && typeof i18n.t === 'function') {
      const value = i18n.t(key, vars);
      if (typeof value === 'string' && value !== '') return value;
    }
    return '[missing:' + key + ']';
  };
}

/**
 * 数据值用的翻译：key 缺失时回落到原始枚举值（显示后端真实值，不编造文案）。
 *
 * @param {(key: string, vars?: object) => string} t 翻译函数。
 * @param {string} key i18n key。
 * @param {string} fallback 缺失时的原始值。
 * @returns {string} 文案。
 */
function translationOr(t, key, fallback) {
  const value = t(key);
  return /^\[missing:/.test(value) ? fallback : value;
}

/**
 * 解析当前语言（Intl 用）。
 *
 * @param {object|null|undefined} i18n i18n 实例。
 * @returns {string} BCP-47 标签。
 */
function readLocale(i18n) {
  const candidates = [
    i18n && i18n.locale,
    i18n && i18n.lang,
    typeof document === 'undefined' ? null : document.documentElement.getAttribute('lang'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return 'zh-CN';
}

/**
 * 数字格式化器（说法 §8-4：用 Intl，不手拼）。
 *
 * @param {string} locale 语言标签。
 * @returns {Intl.NumberFormat} 格式化器。
 */
function numberFormatter(locale) {
  try {
    return new Intl.NumberFormat(locale);
  } catch {
    return new Intl.NumberFormat('en');
  }
}

/**
 * 日期格式化器（固定 UTC，保证跨机器渲染一致）。
 *
 * @param {string} locale 语言标签。
 * @returns {Intl.DateTimeFormat} 格式化器。
 */
function timeFormatter(locale) {
  const options = { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

/**
 * 时间戳 → 可显示文本；非法时间保留原值（后端给的，不是缺失）。
 *
 * @param {Intl.DateTimeFormat} formatter 格式化器。
 * @param {unknown} value ISO 字符串。
 * @returns {string|null} 显示文本；`null` = 未提供。
 */
function formatTime(formatter, value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value.trim();
  return formatter.format(new Date(ms));
}

/**
 * 是否是普通对象。
 *
 * @param {unknown} value 候选值。
 * @returns {boolean} 是否普通对象。
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 从任意异常里取出 `{code, message}`（B2 的 ApiError 与此同形）。
 *
 * @param {unknown} error 抛出的错误。
 * @returns {{code: string|null, message: string}} 归一化错误。
 */
function normalizeError(error) {
  const code = isRecord(error) && typeof error.code === 'string' && error.code !== '' ? error.code : null;
  let message = '';
  if (isRecord(error) && typeof error.message === 'string') message = error.message;
  else if (typeof error === 'string') message = error;
  else if (error !== null && error !== undefined) message = String(error);
  return { code, message };
}

/* ══════════════════════════════════════════════════════════════════════════
   2. ctx 解析 + hash 同步（§7.2）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 从 ctx.params（URLSearchParams / 普通对象）或 location.hash 里读筛选初值。
 * 之所以两处都读：路由实现可能只给其中之一，F5 时必须能恢复。
 *
 * @param {object} ctx 视图上下文。
 * @returns {{state: string, report: string, q: string, sort: string}} 筛选初值。
 */
function readInitialFilters(ctx) {
  const filters = { state: '', report: '', q: '', sort: DEFAULT_SORT };
  const params = isRecord(ctx) ? ctx.params : null;
  const assign = (key, value) => {
    if (typeof value !== 'string' || value === '') return;
    if (key === 'state' || key === 'report' || key === 'q' || key === 'sort') filters[key] = value;
  };
  if (params && typeof params.get === 'function') {
    for (const key of ['state', 'report', 'q', 'sort']) assign(key, params.get(key));
  } else if (isRecord(params)) {
    for (const key of ['state', 'report', 'q', 'sort']) assign(key, params[key]);
  }
  if (typeof location !== 'undefined' && typeof location.hash === 'string') {
    const index = location.hash.indexOf('?');
    if (index >= 0) {
      try {
        const search = new URLSearchParams(location.hash.slice(index + 1));
        // ctx.params 已给出的优先；hash 只补空缺（避免两处不一致时互相覆盖）
        for (const key of ['state', 'report', 'q', 'sort']) {
          if (filters[key] !== '' && filters[key] !== DEFAULT_SORT) continue;
          assign(key, search.get(key));
        }
      } catch {
        // hash 不可解析：按无筛选处理
      }
    }
  }
  if (!SORT_OPTIONS.includes(filters.sort)) filters.sort = DEFAULT_SORT;
  return filters;
}

/**
 * 把筛选状态写回 hash（`replaceState`，不堆历史；§7.2）。
 *
 * @param {{state: string, report: string, q: string, sort: string}} filters 当前筛选。
 * @returns {void}
 */
function writeHash(filters) {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const parts = [];
  if (filters.state !== '') parts.push('state=' + encodeURIComponent(filters.state));
  if (filters.report !== '') parts.push('report=' + encodeURIComponent(filters.report));
  if (filters.q !== '') parts.push('q=' + encodeURIComponent(filters.q));
  if (filters.sort !== DEFAULT_SORT) parts.push('sort=' + encodeURIComponent(filters.sort));
  const next = '#/analysis' + (parts.length === 0 ? '' : '?' + parts.join('&'));
  if (location.hash === next) return;
  try {
    history.replaceState(null, '', next);
  } catch {
    // 某些沙箱禁止 replaceState：退回直接改 hash（会多一条历史，但状态不丢）
    location.hash = next;
  }
}

/**
 * 排序比较器：`created_at` 用字典序（ISO-8601 可直接比较），`attempts` 用数值。
 * 缺失值一律排到末尾，不参与"看起来更大/更小"的猜测。
 *
 * @param {object} left 左行。
 * @param {object} right 右行。
 * @param {string} key 排序键。
 * @returns {number} 比较结果。
 */
function compareRows(left, right, key) {
  if (key === 'attempts') {
    const a = typeof left.attempts === 'number' && Number.isFinite(left.attempts) ? left.attempts : null;
    const b = typeof right.attempts === 'number' && Number.isFinite(right.attempts) ? right.attempts : null;
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  }
  const a = typeof left.created_at === 'string' && left.created_at !== '' ? left.created_at : null;
  const b = typeof right.created_at === 'string' && right.created_at !== '' ? right.created_at : null;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/* ══════════════════════════════════════════════════════════════════════════
   3. 视图
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 挂载分析视图。
 *
 * @param {Element} root 视图根节点（`#view-root`）。
 * @param {object} ctx 视图上下文 `{store, api, i18n, params, navigate, toast}`。
 * @returns {Promise<{destroy: Function, ready: Promise<void>}>} 句柄（`ready` 为加法，供测试等待首载）。
 */
export async function mount(root, ctx) {
  if (!root || typeof root.replaceChildren !== 'function') {
    throw new TypeError('analysis.mount(root, ctx)：root 必须是 DOM 元素');
  }
  const context = isRecord(ctx) ? ctx : {};
  const t = createTranslator(context.i18n);
  const locale = readLocale(context.i18n);
  const numberFormat = numberFormatter(locale);
  const timeFormat = timeFormatter(locale);
  const api = isRecord(context.api) && typeof context.api.listAnalyses === 'function'
    ? context.api.listAnalyses.bind(context.api)
    : null;

  const filters = readInitialFilters(context);

  /** 列表状态。`items` 是已加载工作集；`loading` 只用于首载/整页刷新。 */
  const state = {
    items: [],
    page: { limit: PAGE_SIZE, returned: 0, has_more: false, next_cursor: null },
    pages: 0,
    loading: true,
    loadingMore: false,
    error: null,
    moreError: null,
    lastOkAt: null,
    drawerHandle: null,
  };

  let destroyed = false;
  let debounceId = 0;

  const missing = () => t('common.value.unavailable');

  /** 数字 → 本地化文本；非数字 → 未提供（`attempts=0` 是真实值，必须显示 0）。 */
  function displayNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return numberFormat.format(value);
    return missing();
  }

  /** 时间戳 → 文本。 */
  function displayTime(value) {
    const text = formatTime(timeFormat, value);
    return text === null ? missing() : text + ' ' + t('common.time.utc');
  }

  /** 状态枚举 → 徽章文案（缺失 key 时显示原始枚举）。 */
  function stateLabel(value) {
    return translationOr(t, 'analysis.state.' + value, value);
  }

  /** 分析状态色调（枚举来自 event-store schema；未知值走 neutral，不猜）。 */
  const STATE_TONES = {
    queued: 'accent',
    dispatched: 'info',
    running: 'info',
    succeeded: 'ok',
    degraded: 'warn',
    failed: 'danger',
    cancelled: 'neutral',
  };

  /** 分析状态徽章（B1 的 statusBadge 只覆盖告警状态，分析状态另有语义）。 */
  function stateBadge(value) {
    return badge({ tone: STATE_TONES[value] || 'neutral', text: stateLabel(value) });
  }

  /* ---------------------------- 外壳（只建一次） ---------------------------- */

  const updatedLabel = el('span', { class: 'muted nowrap', text: '' });
  const refreshButton = button({
    label: t('common.action.refresh'),
    icon: 'refresh',
    variant: 'secondary',
    onClick: () => {
      void reload();
    },
  });

  const stateSelect = select({
    ariaLabel: t('analysis.filter.state'),
    value: filters.state,
    options: buildStateOptions(filters.state),
    onChange: (value) => {
      filters.state = value;
      commit();
    },
  });
  const reportSelect = select({
    ariaLabel: t('analysis.filter.report'),
    value: filters.report,
    options: [
      { value: '', label: t('analysis.filter.report.any') },
      { value: 'true', label: t('analysis.filter.report.yes') },
      { value: 'false', label: t('analysis.filter.report.no') },
    ],
    onChange: (value) => {
      filters.report = value;
      commit();
    },
  });
  const sortSelect = select({
    ariaLabel: t('analysis.sort.label'),
    value: filters.sort,
    options: [
      { value: 'created_at:desc', label: t('analysis.sort.created-desc') },
      { value: 'created_at:asc', label: t('analysis.sort.created-asc') },
      { value: 'attempts:desc', label: t('analysis.sort.attempts-desc') },
    ],
    onChange: (value) => {
      filters.sort = SORT_OPTIONS.includes(value) ? value : DEFAULT_SORT;
      commit();
    },
  });
  const searchInput = input({
    type: 'search',
    value: filters.q,
    placeholder: t('analysis.search.placeholder'),
    ariaLabel: t('analysis.search.placeholder'),
    maxLength: 128,
    onInput: (event) => {
      filters.q = typeof event.target.value === 'string' ? event.target.value : '';
      if (debounceId !== 0) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        debounceId = 0;
        commit();
      }, SEARCH_DEBOUNCE_MS);
    },
    onChange: (event) => {
      filters.q = typeof event.target.value === 'string' ? event.target.value : '';
      if (debounceId !== 0) {
        clearTimeout(debounceId);
        debounceId = 0;
      }
      commit();
    },
  });
  const clearButton = button({
    label: t('common.action.clear'),
    icon: 'filter',
    variant: 'ghost',
    onClick: () => {
      filters.state = '';
      filters.report = '';
      filters.q = '';
      filters.sort = DEFAULT_SORT;
      stateSelect.value = '';
      reportSelect.value = '';
      sortSelect.value = DEFAULT_SORT;
      searchInput.value = '';
      commit();
    },
  });

  const loadedNote = el('p', { class: 'muted', text: '' });
  const toolbar = el('div', { class: 'stack' }, [
    el('div', { class: 'cluster' }, [
      field({ label: t('analysis.filter.state'), control: stateSelect }),
      field({ label: t('analysis.filter.report'), control: reportSelect }),
      field({ label: t('analysis.sort.label'), control: sortSelect }),
      el('div', { class: 'grow' }, [
        field({ label: t('analysis.search.label'), control: searchInput }),
      ]),
      clearButton,
    ]),
    loadedNote,
  ]);
  const tableHost = el('div', { class: 'stack' });
  const footerHost = el('div', { class: 'cluster' });
  const noticeCard = card({
    title: t('analysis.notice.title'),
    body: el('ul', null, [
      el('li', { text: t('analysis.notice.outbox') }),
      el('li', { text: t('analysis.notice.report') }),
    ]),
  });
  const head = el('div', { class: 'page-head' }, [
    el('div', { class: 'page-head__text' }, [
      el('h1', { class: 'page-head__title', text: t('analysis.title') }),
      el('p', { class: 'page-head__sub', text: t('analysis.subtitle') }),
    ]),
    el('div', { class: 'page-head__actions' }, [updatedLabel, refreshButton]),
  ]);
  root.replaceChildren(head, noticeCard, toolbar, tableHost, footerHost);

  /** 状态筛选项：全部 + 权威枚举 ∪ 已加载数据里出现过的值（新值不丢，排序稳态）。 */
  function buildStateOptions(current) {
    const observed = new Set(KNOWN_STATES);
    for (const item of state.items) {
      if (isRecord(item) && typeof item.state === 'string' && item.state !== '') observed.add(item.state);
    }
    if (current !== '') observed.add(current);
    return [
      { value: '', label: t('analysis.filter.state.any') },
      ...[...observed].sort().map((value) => ({ value, label: stateLabel(value) })),
    ];
  }

  /* ---------------------------- 过滤 / 排序 ---------------------------- */

  /** 排序键是否有值（缺失的行排序时固定落到末尾，不参与升降序翻转）。 */
  function hasSortValue(row, key) {
    if (key === 'attempts') return typeof row.attempts === 'number' && Number.isFinite(row.attempts);
    return typeof row.created_at === 'string' && row.created_at !== '';
  }

  /** 已加载工作集内的筛选（不请求服务端，§12.1-4）。 */
  function filteredItems() {
    const query = filters.q.trim().toLowerCase();
    const filtered = state.items.filter((item) => {
      if (!isRecord(item)) return false;
      if (filters.state !== '' && item.state !== filters.state) return false;
      if (filters.report === 'true' && item.report_available !== true) return false;
      if (filters.report === 'false' && item.report_available !== false) return false;
      if (query === '') return true;
      const analysisId = typeof item.analysis_id === 'string' ? item.analysis_id.toLowerCase() : '';
      const alertId = typeof item.alert_id === 'string' ? item.alert_id.toLowerCase() : '';
      return analysisId.includes(query) || alertId.includes(query);
    });
    const [key, dir] = filters.sort.split(':');
    const direction = dir === 'asc' ? 1 : -1;
    const present = filtered.filter((row) => hasSortValue(row, key));
    const absent = filtered.filter((row) => !hasSortValue(row, key));
    present.sort((left, right) => compareRows(left, right, key) * direction);
    return present.concat(absent);
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function renderLoadedNote(visibleCount) {
    if (state.loading) {
      loadedNote.textContent = t('common.state.loading');
      return;
    }
    const parts = [t('analysis.loaded', {
      count: displayNumber(state.items.length),
      pages: displayNumber(state.pages),
      visible: displayNumber(visibleCount),
    })];
    if (state.items.length >= MAX_ROWS) parts.push(t('common.limit-reached', { max: displayNumber(MAX_ROWS) }));
    loadedNote.textContent = parts.join(' ');
  }

  /** 空态：区分"确实没有记录"与"当前筛选下没有"——两者含义完全不同。 */
  function emptyStateNode() {
    if (state.items.length === 0) {
      return empty({
        title: t('analysis.empty.title'),
        body: t('analysis.empty.body'),
        iconName: 'chart',
        actionLabel: t('common.action.refresh'),
        onAction: () => {
          void reload();
        },
      });
    }
    return empty({
      title: t('analysis.empty.filtered.title'),
      body: t('analysis.empty.filtered.body', { count: displayNumber(state.items.length) }),
      iconName: 'filter',
      actionLabel: t('common.action.clear'),
      onAction: () => clearButton.click(),
    });
  }

  /** 错误卡（首载失败 / 加载更多失败共用）。 */
  function errorNode(error, onRetry) {
    const parts = [badge({ tone: 'danger', text: t('common.badge.error') })];
    if (error && typeof error.code === 'string' && error.code !== '') {
      parts.push(badge({ tone: 'neutral', text: error.code }));
    }
    parts.push(el('span', { text: error && error.message ? error.message : missing() }));
    return card({
      title: t('common.error.title'),
      actions: [button({ label: t('common.action.retry'), icon: 'refresh', onClick: onRetry })],
      body: el('div', { class: 'cluster' }, parts),
    });
  }

  /**
   * 打开详情抽屉。只展示列表白名单字段，不发任何请求 —— 没有单条详情路由，
   * 伪造一个"详情接口"或补字段都属于编造（合同 §2.9 / §12.1）。
   *
   * @param {object} row 列表行（白名单字段）。
   * @returns {void}
   */
  function openDrawer(row) {
    if (!isRecord(row)) return;
    const displayValue = (name) => {
      const value = row[name];
      if (name === 'state') {
        const stateValue = typeof value === 'string' && value !== '' ? value : null;
        return stateValue === null ? missing() : stateBadge(stateValue);
      }
      if (name === 'report_available') {
        if (value === true) return badge({ tone: 'ok', text: t('analysis.report.yes') });
        if (value === false) return badge({ tone: 'neutral', text: t('analysis.report.no'), title: t('analysis.report.no-hint') });
        return missing();
      }
      if (name === 'created_at' || name === 'updated_at' || name === 'completed_at') {
        return displayTime(value);
      }
      if (name === 'attempts') return displayNumber(value);
      if (typeof value === 'string' && value !== '') {
        return el('span', { class: 'mono', text: value, title: value });
      }
      return missing();
    };
    const rows = ANALYSIS_FIELDS.map((name) => ({ name, value: displayValue(name) }));
    const body = el('div', { class: 'stack' }, [
      table({
        ariaLabel: t('analysis.drawer.title'),
        columns: [
          { key: 'name', label: t('analysis.drawer.col.field'), mono: true },
          { key: 'value', label: t('analysis.drawer.col.value'), render: (entry) => entry.value },
        ],
        rows,
        rowKey: (entry) => entry.name,
      }),
      el('p', { class: 'muted', text: t('analysis.drawer.note') }),
      el('p', { class: 'muted', text: t('analysis.notice.report') }),
    ]);
    state.drawerHandle = drawer({
      title: t('analysis.drawer.title'),
      closeLabel: t('common.action.close'),
      body,
      onClose: () => {
        state.drawerHandle = null;
      },
    });
  }

  function renderTable() {
    if (state.loading) {
      tableHost.replaceChildren(
        table({ columns: columns(), rows: [], loading: true, empty: t('common.state.loading') }),
      );
      footerHost.replaceChildren();
      renderLoadedNote(0);
      return;
    }
    if (state.error !== null && state.items.length === 0) {
      tableHost.replaceChildren(errorNode(state.error, () => {
        void reload();
      }));
      footerHost.replaceChildren();
      renderLoadedNote(0);
      return;
    }
    const rows = filteredItems();
    renderLoadedNote(rows.length);
    const nodes = [];
    if (state.error !== null && state.items.length > 0) {
      // 刷新失败但工作集还在：保留数据 + 顶部明说"下面是上次加载的数据"，不假装最新。
      nodes.push(el('div', { class: 'cluster', role: 'status', 'aria-live': 'polite' }, [
        badge({ tone: 'warn', text: t('analysis.refresh.failed.badge') }),
        el('span', {
          class: 'muted',
          text: t('analysis.refresh.failed.body', {
            message: state.error && state.error.message ? state.error.message : missing(),
          }),
        }),
      ]));
    }
    nodes.push(
      table({
        ariaLabel: t('analysis.title'),
        columns: columns(),
        rows,
        rowKey: (row, index) => String((isRecord(row) && row.analysis_id) || index),
        sort: sortSpec(),
        onSort: ({ key, dir }) => {
          // 只允许 SORT_OPTIONS 里的组合，否则下拉框会与状态不同步：
          // created_at 支持升降序；attempts 只有降序（下拉框也只给这一个）。
          let next;
          if (key === 'attempts') next = 'attempts:desc';
          else next = dir === 'asc' ? 'created_at:asc' : 'created_at:desc';
          filters.sort = SORT_OPTIONS.includes(next) ? next : DEFAULT_SORT;
          sortSelect.value = filters.sort;
          commit();
        },
        empty: emptyStateNode(),
        onRowClick: (row) => openDrawer(row),
      }),
    );
    tableHost.replaceChildren(...nodes);
    renderFooter();
  }

  function columns() {
    return [
      {
        key: 'created_at',
        label: t('analysis.col.created-at'),
        sortable: true,
        render: (row) => {
          const raw = typeof row.created_at === 'string' && row.created_at !== '' ? row.created_at : null;
          if (raw === null) return missing();
          return el('span', { class: 'nowrap', text: displayTime(raw), title: raw });
        },
      },
      {
        key: 'state',
        label: t('analysis.col.state'),
        render: (row) => {
          const value = typeof row.state === 'string' && row.state !== '' ? row.state : null;
          if (value === null) return missing();
          return stateBadge(value);
        },
      },
      {
        key: 'budget_class',
        label: t('analysis.col.budget-class'),
        render: (row) => (typeof row.budget_class === 'string' && row.budget_class !== ''
          ? el('span', { class: 'mono', text: row.budget_class })
          : missing()),
      },
      {
        key: 'attempts',
        label: t('analysis.col.attempts'),
        align: 'right',
        sortable: true,
        render: (row) => displayNumber(row.attempts),
      },
      {
        key: 'report_available',
        label: t('analysis.col.report'),
        render: (row) => {
          if (row.report_available === true) return badge({ tone: 'ok', text: t('analysis.report.yes') });
          if (row.report_available === false) {
            return badge({ tone: 'neutral', text: t('analysis.report.no'), title: t('analysis.report.no-hint') });
          }
          return missing();
        },
      },
      {
        key: 'analysis_id',
        label: t('analysis.col.analysis-id'),
        mono: true,
        render: (row) => {
          const raw = typeof row.analysis_id === 'string' && row.analysis_id !== '' ? row.analysis_id : null;
          if (raw === null) return missing();
          return el('span', { class: 'mono nowrap', text: shortId(raw), title: raw });
        },
      },
      {
        key: 'actions',
        label: t('common.col.actions'),
        render: (row) => button({
          label: t('analysis.drawer.open'),
          variant: 'ghost',
          size: 'sm',
          onClick: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            openDrawer(row);
          },
        }),
      },
    ];
  }

  /** 长 id 只做显示截断，完整值放 title；不做任何改写。 */
  function shortId(raw) {
    return raw.length <= 16 ? raw : raw.slice(0, 12) + '…' + raw.slice(-3);
  }

  function sortSpec() {
    const [key, dir] = filters.sort.split(':');
    return { key, dir: dir === 'asc' ? 'asc' : 'desc' };
  }

  function renderFooter() {
    const nodes = [];
    if (state.loadingMore) {
      nodes.push(el('div', { class: 'cluster' }, [skeleton({ lines: 2, height: 12 })]));
    } else if (state.moreError !== null) {
      nodes.push(errorNode(state.moreError, () => {
        void loadMore();
      }));
    } else if (state.page.has_more === true && state.pages < MAX_PAGES) {
      nodes.push(button({
        label: t('common.action.load-more'),
        icon: 'chevron-down',
        onClick: () => {
          void loadMore();
        },
      }));
    } else if (state.items.length > 0) {
      nodes.push(el('span', { class: 'muted', text: t('common.no-more') }));
    }
    footerHost.replaceChildren(...nodes);
  }

  /* ---------------------------- 取数 ---------------------------- */

  /**
   * 解析一页 `{analyses:[…], page:{…}}`；形状不符时报错而不是当成空列表
   * （"空列表"与"接口形状坏了"必须能区分）。
   *
   * @param {unknown} result 接口返回值。
   * @returns {{items?: object[], page?: object, error?: object}} 解析结果。
   */
  function parsePage(result) {
    if (isRecord(result) && Array.isArray(result.analyses)) {
      return { items: result.analyses.filter(isRecord), page: isRecord(result.page) ? result.page : {} };
    }
    if (Array.isArray(result)) return { items: result.filter(isRecord), page: {} };
    return { error: { code: 'SHAPE', message: t('common.error.shape', { field: 'analyses' }) } };
  }

  /**
   * 取一页。
   *
   * @param {string|null} cursor keyset 游标（首页为 null）。
   * @returns {Promise<{ok: boolean, items?: object[], page?: object, error?: object}>} 归一结果。
   */
  async function fetchPage(cursor) {
    if (api === null) {
      return { ok: false, error: { code: 'API_MISSING', message: t('common.error.api-missing', { name: 'listAnalyses' }) } };
    }
    try {
      const result = await api({ limit: PAGE_SIZE, cursor: cursor === null ? undefined : cursor });
      const parsed = parsePage(result);
      if (parsed.error) return { ok: false, error: parsed.error };
      return { ok: true, items: parsed.items, page: parsed.page };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }

  /**
   * 首载/整页刷新：清空工作集再取第一页。
   *
   * @returns {Promise<void>} 完成。
   */
  async function reload() {
    if (destroyed) return;
    state.loading = true;
    state.error = null;
    state.moreError = null;
    refreshButton.disabled = true;
    renderTable();
    const result = await fetchPage(null);
    if (destroyed) return;
    state.loading = false;
    refreshButton.disabled = false;
    if (!result.ok) {
      // 保留已加载工作集（如果有），错误顶到表格区；绝不把失败画成空列表。
      state.error = result.error;
      renderTable();
      const lastOk = formatTime(timeFormat, state.lastOkAt);
      updatedLabel.textContent = lastOk === null ? '' : t('common.updated-at', { time: lastOk + ' ' + t('common.time.utc') });
      return;
    }
    state.items = result.items;
    state.page = normalizedPage(result.page);
    state.pages = 1;
    state.error = null;
    state.lastOkAt = new Date().toISOString();
    const stamp = formatTime(timeFormat, state.lastOkAt);
    updatedLabel.textContent = stamp === null ? '' : t('common.updated-at', { time: stamp + ' ' + t('common.time.utc') });
    renderTable();
  }

  /**
   * 加载更多：cursor 追页，追加到工作集。
   *
   * @returns {Promise<void>} 完成。
   */
  async function loadMore() {
    if (destroyed || state.loadingMore || state.pages >= MAX_PAGES) return;
    const cursor = typeof state.page.next_cursor === 'string' && state.page.next_cursor !== ''
      ? state.page.next_cursor
      : null;
    if (cursor === null) {
      state.page = { ...state.page, has_more: false };
      renderTable();
      return;
    }
    state.loadingMore = true;
    state.moreError = null;
    renderFooter();
    const result = await fetchPage(cursor);
    if (destroyed) return;
    state.loadingMore = false;
    if (!result.ok) {
      state.moreError = result.error;
      renderTable();
      return;
    }
    state.items = state.items.concat(result.items);
    state.page = normalizedPage(result.page);
    state.pages += 1;
    renderTable();
  }

  /**
   * 归一 `page` 块（缺失字段按"没有更多"处理，不猜）。
   *
   * @param {object} page 服务端 page 对象。
   * @returns {{limit: number, returned: number, has_more: boolean, next_cursor: string|null}} 归一页信息。
   */
  function normalizedPage(page) {
    return {
      limit: typeof page.limit === 'number' ? page.limit : PAGE_SIZE,
      returned: typeof page.returned === 'number' ? page.returned : state.items.length,
      has_more: page.has_more === true,
      next_cursor: typeof page.next_cursor === 'string' && page.next_cursor !== '' ? page.next_cursor : null,
    };
  }

  /**
   * 筛选/排序变化后统一收口：写 hash → 重渲染表格（toolbar 不重建，输入焦点不丢）。
   *
   * @returns {void}
   */
  function commit() {
    writeHash(filters);
    if (state.loading) return;
    renderTable();
  }

  /* ---------------------------- 启动 / 销毁 ---------------------------- */

  const ready = reload();
  return {
    ready,
    destroy() {
      destroyed = true;
      if (debounceId !== 0) {
        clearTimeout(debounceId);
        debounceId = 0;
      }
      if (state.drawerHandle && typeof state.drawerHandle.close === 'function') {
        state.drawerHandle.close('api');
        state.drawerHandle = null;
      }
      root.replaceChildren();
    },
  };
}
