/**
 * AIDriven NetDefense · WebUI v2 · 概览视图（`#/overview`）
 * B6 / PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md
 *  - §7.2 视图签名 `export async function mount(root, ctx) → { destroy() }`，
 *    `ctx = { store, api, i18n, params, navigate, toast }`。本文件**不 import** B2 的
 *    {api,store,i18n}.js，只按合同调用 ctx —— 这样 B2 交付前就能跑，也能被 stub ctx 单测。
 *  - §7.3 只调用 `api.getStatus() / api.getModels() / api.listAlerts({limit})`。
 *  - §7.6 只用 B1 的组件（dom/card/table/badge/empty/skeleton/button），不自建样式。
 *  - §7.9 `?static=1` 关自动刷新；§12.1-4 不谎称"全库"；§12.1-5 用量为空是事实。
 *
 * 数据纪律（本文件所有数字只有两个 HTTP 来源，缺失一律"未提供"，不推测、不补零）：
 *  - `GET /api/v1/status` → `apps/daemon/src/health.js:152 buildStatusPayload()`：
 *    `schema_version/version/lifecycle/mode/started_at/health{status,ready,reasons}/`
 *    `scheduler{...,sources[]}/pipeline/store/counters/uptime_ms`。
 *    **`scheduler.sources[]` 的白名单里没有 `cursor`**（`health.js:170-187`）；游标只存在
 *    检查点 `state.sources` 里、不经 HTTP 暴露 —— 所以"游标"列显示"未提供"，
 *    绝不拿 `polls/accepted` 凑一个假游标。
 *  - `GET /api/v1/models` → `apps/daemon/src/api/models.js:201 buildModelsProjection()`：
 *    `egressEnabled/providers[]/models[]/usage{available,reason}/engine{selected,harness}`。
 *    `usage.available=false` 时只显示"尚无用量记录（NO_LEDGER）"，不显示 0、不显示金额。
 *
 * 诚实口径沿用旧界面（`apps/console/app.js:1115`）：`counters.alerts_written` 是**累计写入**，
 * 不是当前告警总数 —— 统计卡必须带这行子文案，不许只给数字。
 */

import { el } from '../components/ui/dom.js';
import { card, stat } from '../components/ui/card.js';
import { table } from '../components/ui/table.js';
import { badge, severityBadge, statusBadge } from '../components/ui/badge.js';
import { empty } from '../components/ui/empty.js';
import { skeleton } from '../components/ui/skeleton.js';
import { button } from '../components/ui/button.js';

/** 最近告警条数（任务要求 5 条）。 */
const RECENT_ALERT_LIMIT = 5;

/** `ui.autoRefreshMs` 的合同默认值（§6：10000ms，0 = 关）。 */
const DEFAULT_AUTO_REFRESH_MS = 10_000;

/** 合同 §6 `models.models[].tier` 的三个枚举值（`watch/triage/respond`）。 */
const MODEL_TIERS = ['watch', 'triage', 'respond'];

/* ══════════════════════════════════════════════════════════════════════════
   1. i18n / 格式化小工具（视图内自足；不引 B2 模块，便于 stub ctx 单测）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 把 `ctx.i18n` 归一成 `t(key, vars) → string`。
 *
 * 合同 §8-5 要求缺 key 时渲染 `[missing:<key>]` 而不是静默空白，因此这里**不**吞掉
 * i18n 的返回值；只有 i18n 完全缺席时才自己拼 `[missing:…]`（可被自检断言）。
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
 * 数据值用的翻译：key 缺失时回落到**原始枚举值**，而不是让 `[missing:…]` 顶替数据。
 * 这样即使 B10 还没补 `severity.*`，界面显示的也是后端真实枚举，不是编造文案。
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
 * @returns {string} BCP-47 语言标签。
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
 * 数字格式化器（合同 §8-4：数值/日期必须用 Intl，不许手拼）。
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
 * 日期格式化器。固定 UTC，保证同一份数据在不同时区/机器上渲染一致
 * （`?static=1` 的确定性截图依赖它，§7.9）。
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
 * 时间戳 → 可显示文本。字符串不是合法时间时**保留原值**（它是后端给的，不是缺失）。
 *
 * @param {Intl.DateTimeFormat} formatter 格式化器。
 * @param {unknown} value ISO 字符串或 Date。
 * @returns {string|null} 显示文本；`null` 表示未提供。
 */
function formatTime(formatter, value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? formatter.format(value) : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value.trim();
  return formatter.format(new Date(ms));
}

/**
 * 毫秒 → `1d 02:03:04` / `02:03:04`。时长没有通用 Intl 形态，用中性 ASCII 单位，
 * 不把它伪装成自然语言文案。
 *
 * @param {unknown} ms 毫秒。
 * @returns {string|null} 显示文本；`null` 表示未提供。
 */
function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  const total = Math.floor(value / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (part) => String(part).padStart(2, '0');
  const clock = pad(hours) + ':' + pad(minutes) + ':' + pad(seconds);
  return days > 0 ? days + 'd ' + clock : clock;
}

/**
 * 是否是普通对象（排除 null / 数组 / 函数）。
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
   2. ctx 解析（宽进：B2 交付前 / stub ctx / 真实 ctx 都能跑）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 取出三个只读接口；缺的返回 `null`，调用点渲染 "api 未提供" 错误卡而不是抛。
 *
 * @param {object|null|undefined} api `ctx.api`。
 * @returns {{getStatus: Function|null, getModels: Function|null, listAlerts: Function|null}} 接口集合。
 */
function resolveApi(api) {
  const source = isRecord(api) ? api : {};
  const bind = (name) => (typeof source[name] === 'function' ? source[name].bind(source) : null);
  return { getStatus: bind('getStatus'), getModels: bind('getModels'), listAlerts: bind('listAlerts') };
}

/**
 * 取出 store 的状态快照（B2 的 store 实际导出 `getState()` / `select(fn)` / `state`）。
 * 一次取齐，`readAutoRefreshMs` 与 `isStaticMode` 共用，避免两处各猜一种形状。
 *
 * @param {object} ctx 视图上下文。
 * @returns {object[]} 状态快照候选（去重前）。
 */
function storeSnapshots(ctx) {
  const store = isRecord(ctx) && isRecord(ctx.store) ? ctx.store : null;
  if (store === null) return [];
  const list = [];
  const push = (read) => {
    try {
      const value = read();
      if (isRecord(value)) list.push(value);
    } catch {
      // 刷新间隔/静态模式都不是关键路径：store 形状不同不能让整页崩掉
    }
  };
  if (typeof store.getState === 'function') push(() => store.getState());
  if (typeof store.get === 'function') {
    push(() => store.get());
    push(() => store.get('settings.settings.ui.autoRefreshMs'));
    push(() => store.get('settings.ui.autoRefreshMs'));
  }
  if (typeof store.snapshot === 'function') push(() => store.snapshot());
  if (typeof store.select === 'function') push(() => store.select((snapshot) => snapshot));
  if (isRecord(store.state)) list.push(store.state);
  return list;
}

/**
 * 读取 `ui.autoRefreshMs`。
 *
 * B2 的 store 把 `GET /api/v1/settings` 的整包放在 `state.settings`
 * （即 `settings.settings.ui.autoRefreshMs`，见 store.js `applySettingsPutResult`），
 * 这里同时兼容"整包"与"内层 settings 文档"两种落点；都取不到就回落到合同 §6 默认值 10000。
 *
 * @param {object} ctx 视图上下文。
 * @returns {number} 刷新间隔毫秒；0 表示关闭。
 */
function readAutoRefreshMs(ctx) {
  const snapshots = storeSnapshots(ctx);
  for (const candidate of snapshots) {
    const paths = [
      candidate.settings && candidate.settings.settings && candidate.settings.settings.ui
        && candidate.settings.settings.ui.autoRefreshMs,
      candidate.settings && candidate.settings.ui && candidate.settings.ui.autoRefreshMs,
      candidate.ui && candidate.ui.autoRefreshMs,
      candidate.settings && candidate.settings.autoRefreshMs,
    ];
    for (const value of paths) {
      const ms = Number(value);
      if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
    }
  }
  return DEFAULT_AUTO_REFRESH_MS;
}

/**
 * 是否处于确定性模式（合同 §7.9 `?static=1`：关自动刷新）。
 * 三个来源都看：ctx.params / location.search 的 `static`，以及 B2 store 的
 * `staticMode`（app.js 解析后的派生字段）与 `overrides.static`。
 *
 * @param {object} ctx 视图上下文。
 * @returns {boolean} true = 静态模式。
 */
function isStaticMode(ctx) {
  const values = [];
  const params = isRecord(ctx) ? ctx.params : null;
  if (params && typeof params.get === 'function') values.push(params.get('static'));
  else if (isRecord(params) && 'static' in params) values.push(params.static);
  if (isRecord(ctx) && 'static' in ctx) values.push(ctx.static);
  for (const snapshot of storeSnapshots(ctx)) {
    if (snapshot.staticMode === true) return true;
    if (isRecord(snapshot.overrides) && snapshot.overrides.static === true) return true;
  }
  if (typeof location !== 'undefined' && typeof location.search === 'string') {
    try {
      values.push(new URLSearchParams(location.search).get('static'));
    } catch {
      // URLSearchParams 不可用：忽略，按非静态处理
    }
  }
  return values.some((value) => value === 1 || value === true || value === '1' || value === 'true');
}

/* ══════════════════════════════════════════════════════════════════════════
   3. 视图
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 挂载概览视图。
 *
 * @param {Element} root 视图根节点（`#view-root`）。
 * @param {object} ctx 视图上下文 `{store, api, i18n, params, navigate, toast}`。
 * @returns {Promise<{destroy: Function, ready: Promise<void>, refresh: Function}>} 句柄。
 *   `ready` / `refresh` 是对合同签名的**加法**（只给测试与"立即刷新"用，路由可忽略）。
 */
export async function mount(root, ctx) {
  if (!root || typeof root.replaceChildren !== 'function') {
    throw new TypeError('overview.mount(root, ctx)：root 必须是 DOM 元素');
  }
  const context = isRecord(ctx) ? ctx : {};
  const t = createTranslator(context.i18n);
  const locale = readLocale(context.i18n);
  const numberFormat = numberFormatter(locale);
  const timeFormat = timeFormatter(locale);
  const api = resolveApi(context.api);
  const go = (hash) => {
    if (typeof context.navigate === 'function') context.navigate(hash);
    else if (typeof location !== 'undefined') location.hash = hash;
  };

  /**
   * 页面状态。`data === null` 表示"从未取到过"，与"取到但为空"（`[]`）严格区分：
   * 前者是错误/加载中，后者才允许画 empty 态（否则"空列表"会被当成"没有告警"）。
   */
  const display = {
    status: { data: null, error: null },
    models: { data: null, error: null },
    alerts: { data: null, error: null },
    loading: true,
    refreshing: false,
    lastOkAt: null,
    failure: null,
  };

  let destroyed = false;
  let timerId = 0;

  const updatedLabel = el('span', { class: 'muted nowrap', text: '' });
  const refreshButton = button({
    label: t('common.action.refresh'),
    icon: 'refresh',
    variant: 'secondary',
    onClick: () => {
      void load({ silent: true });
    },
  });
  // 外壳只建一次：刷新时只重建 bodyHost，避免把焦点从"刷新"按钮上抢走。
  const head = el('div', { class: 'page-head' }, [
    el('div', { class: 'page-head__text' }, [
      el('h1', { class: 'page-head__title', text: t('overview.title') }),
      el('p', { class: 'page-head__sub', text: t('overview.subtitle') }),
    ]),
    el('div', { class: 'page-head__actions' }, [updatedLabel, refreshButton]),
  ]);
  const bodyHost = el('div', { class: 'stack' });
  root.replaceChildren(head, bodyHost);

  /* ---------------------------- 取值小工具 ---------------------------- */

  const missing = () => t('common.value.unavailable');

  /** 数字 → 本地化文本；非有限数 → 未提供。 */
  function displayNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return numberFormat.format(value);
    return missing();
  }

  /** 标量 → 文本；null/undefined → 未提供（`0`/`false` 是真实值，必须显示）。 */
  function displayScalar(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return numberFormat.format(value);
    if (typeof value === 'boolean') return value ? t('common.value.yes') : t('common.value.no');
    if (typeof value === 'string' && value !== '') return value;
    return missing();
  }

  /** 时间戳 → 文本；缺失 → 未提供。 */
  function displayTime(value) {
    const text = formatTime(timeFormat, value);
    return text === null ? missing() : text + ' ' + t('common.time.utc');
  }

  /** 计数对象：优先 `pipeline`（含 detection），回落到 `counters`。 */
  function countersOf(status) {
    if (isRecord(status.pipeline)) return status.pipeline;
    if (isRecord(status.counters)) return status.counters;
    return null;
  }

  /* ---------------------------- 通用区块 ---------------------------- */

  /** 顶部"数据可能过期"提醒：刷新失败但手里还有上一次数据时出现（不许装作最新）。 */
  function staleNotice() {
    const failure = display.failure;
    const lastOk = formatTime(timeFormat, display.lastOkAt);
    const parts = [badge({ tone: 'warn', text: t('overview.stale.badge') })];
    if (failure && failure.error && typeof failure.error.code === 'string' && failure.error.code !== '') {
      // 错误码是排障的第一手信息（daemon 的错误码是稳定枚举），不能只留在 console 里。
      parts.push(badge({ tone: 'neutral', text: failure.error.code }));
    }
    parts.push(el('span', {
      class: 'muted',
      text: t('overview.stale.body', {
        time: lastOk === null ? missing() : lastOk + ' ' + t('common.time.utc'),
        error: failure && failure.error && failure.error.message ? failure.error.message : missing(),
      }),
    }));
    return el('div', { class: 'cluster', role: 'status', 'aria-live': 'polite', data: { kind: 'stale' } }, parts);
  }

  /** 错误卡：错误码 + 人话 + 重试（错误信息一律 textContent，不拼 HTML）。 */
  function errorCard(title, error, onRetry) {
    const parts = [badge({ tone: 'danger', text: t('common.badge.error') })];
    if (error && typeof error.code === 'string' && error.code !== '') {
      parts.push(badge({ tone: 'neutral', text: error.code }));
    }
    parts.push(el('span', { text: error && error.message ? error.message : missing() }));
    return card({
      title,
      actions: [button({ label: t('common.action.retry'), icon: 'refresh', onClick: onRetry })],
      body: el('div', { class: 'cluster' }, parts),
    });
  }

  /** 骨架卡（加载中）。 */
  function loadingCard(titleKey) {
    return card({ title: t(titleKey), body: skeleton({ lines: 4, height: 14 }) });
  }

  /** 一个"标签 + 内容"行（模型小卡用；cluster 负责换行，不需要新样式）。 */
  function kvRow(label, content) {
    const nodes = [el('span', { class: 'muted nowrap', text: label })];
    if (Array.isArray(content)) nodes.push(...content.filter(Boolean));
    else if (content !== null && content !== undefined) nodes.push(content);
    return el('div', { class: 'cluster' }, nodes);
  }

  /* ---------------------------- 1) 服务状态 ---------------------------- */

  function lifecycleTone(lifecycle, healthStatus) {
    if (lifecycle === 'failed' || healthStatus === 'failed') return 'danger';
    if (healthStatus === 'degraded' || lifecycle === 'stopping') return 'warn';
    if (lifecycle === 'running' && healthStatus === 'ok') return 'ok';
    return '';
  }

  function statsSection() {
    const status = display.status.data;
    if (display.status.error !== null && status === null) {
      return errorCard(t('overview.stat.service'), display.status.error, () => {
        void load({ silent: true });
      });
    }
    if (!isRecord(status)) return loadingCard('overview.stat.service');

    const health = isRecord(status.health) ? status.health : null;
    const lifecycle = typeof status.lifecycle === 'string' && status.lifecycle !== '' ? status.lifecycle : null;
    const healthStatus = health !== null && typeof health.status === 'string' && health.status !== '' ? health.status : null;
    const counters = countersOf(status);
    const scheduler = isRecord(status.scheduler) ? status.scheduler : null;
    const sources = scheduler !== null && Array.isArray(scheduler.sources) ? scheduler.sources : null;

    const lifecycleText = lifecycle === null ? missing() : translationOr(t, 'status.' + lifecycle, lifecycle);
    const healthText = healthStatus === null ? missing() : translationOr(t, 'status.' + healthStatus, healthStatus);
    const readyText = health !== null && typeof health.ready === 'boolean'
      ? (health.ready ? t('overview.health.ready') : t('overview.health.not-ready'))
      : missing();
    const schemaText = typeof status.schema_version === 'string' && status.schema_version !== ''
      ? t('overview.stat.schema', { version: status.schema_version })
      : missing();
    const modeText = typeof status.mode === 'string' && status.mode !== ''
      ? t('overview.stat.mode', { mode: status.mode })
      : missing();

    const sourcesCount = sources !== null
      ? sources.length
      : (scheduler !== null && typeof scheduler.sources === 'number' ? scheduler.sources : null);

    const sourcesSubParts = [];
    const schedulerSummary = [
      ['ok', 'overview.stat.sources.ok'],
      ['degraded', 'overview.stat.sources.degraded'],
      ['stale', 'overview.stat.sources.stale'],
    ];
    for (const [key, labelKey] of schedulerSummary) {
      if (scheduler !== null && typeof scheduler[key] === 'number') {
        sourcesSubParts.push(t(labelKey, { count: displayNumber(scheduler[key]) }));
      }
    }

    const uptime = formatDuration(status.uptime_ms);

    return el('div', { class: 'grid-auto' }, [
      stat({
        label: t('overview.stat.service'),
        value: lifecycleText,
        sub: [healthText, readyText].join(' · '),
        tone: lifecycleTone(lifecycle, healthStatus),
      }),
      stat({
        label: t('overview.stat.version'),
        value: displayScalar(status.version),
        sub: [schemaText, modeText].join(' · '),
      }),
      stat({
        label: t('overview.stat.uptime'),
        value: uptime === null ? missing() : uptime,
        sub: t('overview.stat.started', { time: displayTime(status.started_at) }),
      }),
      stat({
        label: t('overview.stat.collected'),
        value: counters === null ? missing() : displayNumber(counters.events_accepted),
        sub: t('overview.counters.note.collected'),
      }),
      stat({
        label: t('overview.stat.alerts'),
        value: counters === null ? missing() : displayNumber(counters.alerts_written),
        sub: t('overview.counters.note.alerts'),
      }),
      stat({
        label: t('overview.stat.sources'),
        value: sourcesCount === null ? missing() : displayNumber(sourcesCount),
        sub: sourcesSubParts.length === 0 ? missing() : sourcesSubParts.join(' · '),
      }),
    ]);
  }

  function reasonsCard() {
    const status = display.status.data;
    if (!isRecord(status) || !isRecord(status.health)) return null;
    const reasons = Array.isArray(status.health.reasons)
      ? status.health.reasons.filter((reason) => typeof reason === 'string' && reason !== '')
      : null;
    return card({
      title: t('overview.health.reasons'),
      body: reasons === null || reasons.length === 0
        ? el('p', { class: 'muted', text: t('overview.health.none') })
        : el('ul', null, reasons.map((reason) => el('li', { text: reason }))),
    });
  }

  /* ---------------------------- 2) 计数（pipeline counters） ---------------------------- */

  function countersCard() {
    const status = display.status.data;
    if (!isRecord(status)) return null;
    const counters = countersOf(status);
    if (counters === null) {
      return card({
        title: t('overview.counters.title'),
        body: el('p', { class: 'muted', text: missing() }),
      });
    }
    // 键名原样显示：daemon 的计数器名是诊断标识符，翻译会与后端漂移。
    // `pipeline.detection` 是嵌套对象（单独按 detection.events / detection.fatal 展示），
    // 这里只取标量计数器，避免出现一行"detection = 未提供"的噪音。
    const rows = Object.keys(counters)
      .sort()
      .filter((key) => counters[key] === null || typeof counters[key] !== 'object')
      .map((key) => ({ key, value: counters[key] }));
    const detection = isRecord(status.pipeline) && isRecord(status.pipeline.detection) ? status.pipeline.detection : null;
    if (detection !== null) {
      rows.push({ key: 'detection.events', value: detection.events });
      rows.push({ key: 'detection.fatal', value: detection.fatal });
    }
    return card({
      title: t('overview.counters.title'),
      note: t('overview.counters.note'),
      body: rows.length === 0
        ? empty({ title: t('overview.counters.empty'), iconName: 'chart' })
        : table({
            ariaLabel: t('overview.counters.title'),
            columns: [
              { key: 'key', label: t('overview.counters.col.key'), mono: true },
              {
                key: 'value',
                label: t('overview.counters.col.value'),
                align: 'right',
                mono: true,
                render: (row) => displayScalar(row.value),
              },
            ],
            rows,
            rowKey: (row) => row.key,
          }),
    });
  }

  /* ---------------------------- 3) 采集源 ---------------------------- */

  function sourcesCard() {
    const status = display.status.data;
    if (!isRecord(status)) return null;
    const scheduler = isRecord(status.scheduler) ? status.scheduler : null;
    const sources = scheduler !== null && Array.isArray(scheduler.sources) ? scheduler.sources : null;
    const title = t('overview.sources.title');

    if (sources === null) {
      return card({ title, note: t('overview.sources.note'), body: el('p', { class: 'muted', text: missing() }) });
    }
    if (sources.length === 0) {
      return card({
        title,
        note: t('overview.sources.note'),
        body: empty({
          title: t('overview.sources.empty.title'),
          body: t('overview.sources.empty.body'),
          iconName: 'database',
        }),
      });
    }
    const rows = sources.map((source, index) => ({
      ...(isRecord(source) ? source : {}),
      __rowKey: String((isRecord(source) && source.id) || index),
    }));
    return card({
      title,
      note: t('overview.sources.note'),
      body: table({
        ariaLabel: title,
        columns: [
          { key: 'id', label: t('overview.sources.col.id'), mono: true },
          { key: 'kind', label: t('overview.sources.col.kind') },
          {
            key: 'lifecycle',
            label: t('overview.sources.col.lifecycle'),
            render: (row) => {
              const lifecycle = typeof row.lifecycle === 'string' && row.lifecycle !== '' ? row.lifecycle : null;
              if (lifecycle === null) return missing();
              return statusBadge(lifecycle, translationOr(t, 'status.' + lifecycle, lifecycle));
            },
          },
          {
            key: 'stale',
            label: t('overview.sources.col.stale'),
            render: (row) => {
              if (row.stale === true) return badge({ tone: 'warn', text: t('overview.sources.stale') });
              if (row.stale === false) return el('span', { class: 'muted', text: t('common.value.no') });
              return missing();
            },
          },
          {
            key: 'last_event_at',
            label: t('overview.sources.col.last-event'),
            render: (row) => {
              const raw = typeof row.last_event_at === 'string' && row.last_event_at !== '' ? row.last_event_at : null;
              if (raw === null) return missing();
              return el('span', { class: 'nowrap', text: displayTime(raw), title: raw });
            },
          },
          {
            // 白名单没有这个字段（health.js:170-187），恒为"未提供"；卡片 note 说明原因。
            key: 'cursor',
            label: t('overview.sources.col.cursor'),
            mono: true,
            render: () => el('span', { class: 'muted', text: missing() }),
          },
        ],
        rows,
        rowKey: (row) => row.__rowKey,
      }),
    });
  }

  /* ---------------------------- 4) 最近告警 ---------------------------- */

  function alertsOf(result) {
    if (isRecord(result) && Array.isArray(result.alerts)) {
      return { items: result.alerts, page: isRecord(result.page) ? result.page : null };
    }
    if (Array.isArray(result)) return { items: result, page: null };
    return { error: { code: 'SHAPE', message: t('common.error.shape', { field: 'alerts' }) } };
  }

  function recentCard() {
    const slot = display.alerts;
    const title = t('overview.recent.title');
    if (slot.error !== null && slot.data === null) {
      return errorCard(title, slot.error, () => {
        void load({ silent: true });
      });
    }
    if (slot.data === null) return loadingCard('overview.recent.title');
    const rows = slot.data.slice(0, RECENT_ALERT_LIMIT);
    return card({
      title,
      note: t('overview.recent.note', {
        limit: displayNumber(RECENT_ALERT_LIMIT),
        loaded: displayNumber(slot.data.length),
      }),
      actions: [
        button({
          label: t('overview.recent.more'),
          icon: 'chevron-right',
          variant: 'ghost',
          onClick: () => go('#/alerts'),
        }),
      ],
      body: rows.length === 0
        ? empty({
            title: t('overview.recent.empty.title'),
            body: t('overview.recent.empty.body'),
            iconName: 'alert',
            actionLabel: t('overview.recent.more'),
            onAction: () => go('#/alerts'),
          })
        : table({
            ariaLabel: title,
            columns: [
              {
                key: 'last_seen',
                label: t('overview.recent.col.time'),
                render: (row) => {
                  const raw = typeof row.last_seen === 'string' && row.last_seen !== '' ? row.last_seen : null;
                  if (raw === null) return missing();
                  return el('span', { class: 'nowrap', text: displayTime(raw), title: raw });
                },
              },
              {
                key: 'severity',
                label: t('overview.recent.col.severity'),
                render: (row) => {
                  const severity = typeof row.severity === 'string' && row.severity !== '' ? row.severity : null;
                  if (severity === null) return missing();
                  return severityBadge(severity, translationOr(t, 'severity.' + severity, severity));
                },
              },
              {
                key: 'status',
                label: t('overview.recent.col.status'),
                render: (row) => {
                  const state = typeof row.status === 'string' && row.status !== '' ? row.status : null;
                  if (state === null) return missing();
                  return statusBadge(state, translationOr(t, 'status.' + state, state));
                },
              },
              {
                key: 'rule_id',
                label: t('overview.recent.col.rule'),
                render: (row) => {
                  const rule = typeof row.rule_id === 'string' && row.rule_id !== '' ? row.rule_id : null;
                  if (rule === null) return missing();
                  return el('span', { class: 'mono nowrap', text: rule, title: rule });
                },
              },
            ],
            rows,
            rowKey: (row, index) => String((row && row.alert_id) || index),
            onRowClick: () => go('#/alerts'),
          }),
    });
  }

  /* ---------------------------- 5) 模型小卡 ---------------------------- */

  function modelsOf(result) {
    if (!isRecord(result)) {
      return { error: { code: 'SHAPE', message: t('common.error.shape', { field: 'models' }) } };
    }
    return { data: result };
  }

  /**
   * 单个 tier 的"可用 / 登记"行。
   * 可用 = `egressEnabled=true` + provider `enabled=true` + provider `hasCredential=true`。
   * 任一前置字段不是布尔（未提供）时，可用数显示"未提供"，不许当成 0。
   *
   * @param {object[]} modelList 已登记的模型。
   * @param {object[]} providers provider 列表。
   * @param {boolean|null} egressEnabled 出站开关。
   * @param {string} tier 档位。
   * @returns {Element} 行节点。
   */
  function tierRow(modelList, providers, egressEnabled, tier) {
    const registered = modelList.filter((model) => model.tier === tier);
    const providerById = new Map();
    for (const provider of providers) {
      if (typeof provider.id === 'string') providerById.set(provider.id, provider);
    }
    const known = egressEnabled !== null && providers.every((provider) => (
      typeof provider.enabled === 'boolean' && typeof provider.hasCredential === 'boolean'
    ));
    const available = known
      ? registered.filter((model) => {
          if (egressEnabled !== true) return false;
          const provider = providerById.get(model.providerId);
          return isRecord(provider) && provider.enabled === true && provider.hasCredential === true;
        }).length
      : null;
    return el('div', { class: 'cluster' }, [
      el('span', { class: 'mono nowrap', text: tier }),
      el('span', {
        text: t('overview.models.tier.line', {
          available: available === null ? missing() : displayNumber(available),
          total: displayNumber(registered.length),
        }),
      }),
    ]);
  }

  function modelsCard() {
    const title = t('overview.models.title');
    const slot = display.models;
    if (slot.error !== null && slot.data === null) {
      return errorCard(title, slot.error, () => {
        void load({ silent: true });
      });
    }
    if (slot.data === null) return loadingCard('overview.models.title');

    const models = slot.data;
    const egressEnabled = typeof models.egressEnabled === 'boolean' ? models.egressEnabled : null;
    const providers = Array.isArray(models.providers) ? models.providers.filter(isRecord) : null;
    const modelList = Array.isArray(models.models) ? models.models.filter(isRecord) : null;
    const credentialsKnown = providers !== null && providers.every((provider) => typeof provider.hasCredential === 'boolean');
    const withKey = providers === null || !credentialsKnown
      ? null
      : providers.filter((provider) => provider.hasCredential === true).length;
    const usage = isRecord(models.usage) ? models.usage : null;
    const engine = isRecord(models.engine) ? models.engine : null;
    const harness = engine !== null && isRecord(engine.harness) ? engine.harness : null;

    const rows = [];

    rows.push(kvRow(t('overview.models.egress'), [
      egressEnabled === null
        ? el('span', { class: 'muted', text: missing() })
        : badge({
            tone: egressEnabled ? 'warn' : 'ok',
            text: egressEnabled ? t('overview.models.egress.on') : t('overview.models.egress.off'),
          }),
    ]));

    rows.push(kvRow(t('overview.models.providers'), el('span', {
      class: 'mono nowrap',
      text: providers === null || withKey === null
        ? missing()
        : t('overview.models.providers.value', { withKey: displayNumber(withKey), total: displayNumber(providers.length) }),
    })));

    rows.push(kvRow(t('overview.models.tiers'), null));
    if (modelList === null || providers === null) {
      rows.push(el('p', { class: 'muted', text: missing() }));
    } else {
      for (const tier of MODEL_TIERS) rows.push(tierRow(modelList, providers, egressEnabled, tier));
      rows.push(el('p', { class: 'faint', text: t('overview.models.tiers.legend') }));
    }

    if (usage === null) {
      rows.push(kvRow(t('overview.models.usage'), el('span', { class: 'muted', text: missing() })));
    } else if (usage.available === true) {
      rows.push(kvRow(t('overview.models.usage'), el('span', {
        class: 'mono',
        text: Array.isArray(usage.byTier)
          ? t('overview.models.usage.rows', { count: displayNumber(usage.byTier.length) })
          : missing(),
      })));
    } else if (usage.available === false) {
      // 0.0.1 没有 ledger 写入方：显示"尚无用量记录"，不显示 0、不显示金额（合同 §12.1-5）。
      rows.push(kvRow(t('overview.models.usage'), [
        badge({ tone: 'warn', text: t('overview.models.usage.none') }),
        el('span', { class: 'muted mono', text: typeof usage.reason === 'string' ? usage.reason : missing() }),
      ]));
      rows.push(el('p', { class: 'faint', text: t('overview.models.usage.note') }));
    } else {
      rows.push(kvRow(t('overview.models.usage'), el('span', { class: 'muted', text: missing() })));
    }

    if (engine === null) {
      rows.push(kvRow(t('overview.models.engine'), el('span', { class: 'muted', text: missing() })));
    } else {
      const selected = typeof engine.selected === 'string' && engine.selected !== '' ? engine.selected : null;
      rows.push(kvRow(t('overview.models.engine'), el('span', {
        class: 'mono nowrap',
        text: selected === null ? missing() : t('overview.models.engine.selected', { engine: selected }),
      })));
      if (harness !== null && harness.available === false) {
        const reason = typeof harness.reason === 'string' && harness.reason !== '' ? harness.reason : missing();
        rows.push(el('div', { class: 'cluster' }, [
          badge({ tone: 'warn', text: t('overview.models.engine.harness.off.badge') }),
          el('span', { class: 'muted', text: t('overview.models.engine.harness.off', { reason }) }),
        ]));
      }
    }

    return card({ title, note: t('overview.models.note'), body: el('div', { class: 'stack' }, rows) });
  }

  /* ---------------------------- 组装与渲染 ---------------------------- */

  function renderBody() {
    const children = [];
    if (display.failure !== null && display.lastOkAt !== null) children.push(staleNotice());
    children.push(statsSection());
    const reasons = reasonsCard();
    if (reasons !== null) children.push(reasons);
    children.push(countersCard());
    children.push(sourcesCard());
    children.push(recentCard());
    children.push(modelsCard());
    return children.filter(Boolean);
  }

  function render() {
    if (destroyed) return;
    bodyHost.replaceChildren(...renderBody());
    refreshButton.disabled = display.refreshing;
    const stamp = formatTime(timeFormat, display.lastOkAt);
    if (stamp === null) updatedLabel.textContent = display.loading ? t('common.state.loading') : '';
    else updatedLabel.textContent = t('common.updated-at', { time: stamp + ' ' + t('common.time.utc') });
  }

  /* ---------------------------- 取数 ---------------------------- */

  /**
   * 调一个 api 方法并把结果/错误归一（永不 reject）。
   *
   * @param {Function|null} fn 方法。
   * @param {string} name 方法名（错误文案用）。
   * @returns {Promise<{ok: boolean, value?: *, error?: object}>} 归一结果。
   */
  async function callApi(fn, name) {
    if (typeof fn !== 'function') {
      return { ok: false, error: { code: 'API_MISSING', message: t('common.error.api-missing', { name }) } };
    }
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }

  function applyStatus(result) {
    if (result.ok && isRecord(result.value)) {
      display.status = { data: result.value, error: null };
      display.lastOkAt = new Date();
      display.failure = null;
      return;
    }
    const error = result.ok
      ? { code: 'SHAPE', message: t('common.error.shape', { field: 'status' }) }
      : result.error;
    display.status = { data: display.status.data, error };
    // 有旧数据时保留旧数据，并把失败顶到页面最上面（"数据可能过期"），不假装刷新成功。
    if (display.status.data !== null) display.failure = { error, at: new Date() };
  }

  function applyModels(result) {
    if (!result.ok) {
      display.models = { data: display.models.data, error: result.error };
      return;
    }
    const parsed = modelsOf(result.value);
    display.models = parsed.error
      ? { data: display.models.data, error: parsed.error }
      : { data: parsed.data, error: null };
  }

  function applyAlerts(result) {
    if (!result.ok) {
      display.alerts = { data: display.alerts.data, error: result.error };
      return;
    }
    const parsed = alertsOf(result.value);
    display.alerts = parsed.error
      ? { data: display.alerts.data, error: parsed.error }
      : { data: parsed.items, error: null };
  }

  /**
   * 拉一次数据。三个端点互不阻塞：任何一个失败只影响它自己的卡片（概览不整页白屏）。
   *
   * @param {{silent?: boolean}} [options] `silent=true` 保留旧数据、不回到骨架态。
   * @returns {Promise<void>} 完成。
   */
  async function load(options) {
    const opts = isRecord(options) ? options : {};
    if (destroyed) return;
    display.refreshing = true;
    refreshButton.disabled = true;
    if (opts.silent !== true) render();
    const [statusResult, modelsResult, alertsResult] = await Promise.all([
      callApi(api.getStatus, 'getStatus'),
      callApi(api.getModels, 'getModels'),
      callApi(api.listAlerts === null ? null : () => api.listAlerts({ limit: RECENT_ALERT_LIMIT }), 'listAlerts'),
    ]);
    if (destroyed) return;
    applyStatus(statusResult);
    applyModels(modelsResult);
    applyAlerts(alertsResult);
    display.loading = false;
    display.refreshing = false;
    render();
  }

  /* ---------------------------- 自动刷新（§7.9 / §6 ui.autoRefreshMs） ---------------------------- */

  const autoRefreshMs = readAutoRefreshMs(context);
  // 窗口隐藏（托盘驻留）时停掉自动刷新定时器：隐藏页的 setInterval 只会白唤醒
  // renderer，何况壳随后会把 WebView2 挂起（PERF-CPU / N-034）。重新可见时补刷一次。
  const pageHidden = () => typeof document !== 'undefined' && document !== null && document.hidden === true;
  const canListenVisibility = typeof document !== 'undefined' && document !== null
    && typeof document.addEventListener === 'function';
  let onVisibilityChange = null;

  function startAutoRefresh() {
    if (destroyed || timerId !== 0) return;
    timerId = setInterval(() => {
      if (destroyed) return;
      if (pageHidden()) return;
      // 用户正在本视图内操作（Tab 到行/按钮）时不重建 DOM，避免把焦点抽走；
      // 下一拍再刷，数据最多晚一个间隔，但不会打断键盘用户。
      const active = typeof document === 'undefined' ? null : document.activeElement;
      if (active !== null && active !== document.body && bodyHost.contains(active)) return;
      void load({ silent: true });
    }, autoRefreshMs);
  }

  function stopAutoRefresh() {
    if (timerId !== 0) {
      clearInterval(timerId);
      timerId = 0;
    }
  }

  if (!isStaticMode(context) && autoRefreshMs > 0) {
    if (!pageHidden()) startAutoRefresh();
    if (canListenVisibility) {
      onVisibilityChange = () => {
        if (destroyed) return;
        if (pageHidden()) {
          stopAutoRefresh();
          return;
        }
        const wasStopped = timerId === 0;
        if (!pageHidden()) startAutoRefresh();
        if (wasStopped) void load({ silent: true });
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  const ready = load({});
  return {
    ready,
    refresh: () => load({ silent: true }),
    destroy() {
      destroyed = true;
      if (timerId !== 0) {
        clearInterval(timerId);
        timerId = 0;
      }
      if (onVisibilityChange !== null && typeof document !== 'undefined' && document !== null
        && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        onVisibilityChange = null;
      }
      root.replaceChildren();
    },
  };
}


