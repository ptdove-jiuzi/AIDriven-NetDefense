/**
 * AIDriven NetDefense · WebUI v2 · 首启动引导（T4，三步）
 * 作者：PT-dove
 *
 * 合同：docs/implementation/CONSOLE-V2-CONTRACT.md §7.2/§7.5/§7.6/§7.7/§7.9
 * 任务：UI-POLISH 战役 T4 —— 首次启动的三步引导（在线 → 配模型 → 第一条告警）
 *
 * ---------------------------------------------------------------------------
 * 两条硬约束（本文件的存在理由，改代码前先读）
 * ---------------------------------------------------------------------------
 * 1. **不自动播放**：首次出现是普通文档流里的页内 banner（`<section role="region">`），
 *    没有入场动画、不自动展开、不自动聚焦、不自动滚动、不写 `<dialog>`。
 * 2. **不遮挡主界面**：容器是 `#onboarding-root`，位于 `</header>` 与 `<main id="view-root">`
 *    之间，只占普通布局高度；不 fixed/absolute、无 backdrop、无 `aria-modal`、
 *    不锁定滚动、不阻断点击；用户任何时候都能直接点导航去干别的。
 *
 * ---------------------------------------------------------------------------
 * 完成态来自真实数据（禁止假数据/假成功）
 * ---------------------------------------------------------------------------
 * - 步骤 1 在线：真探测 `/healthz`（`api.getHealth()` → 同源 `/healthz`），状态/版本原样展示；
 *   端口取自浏览器当前 origin（`location.port`），读不到就写"读不到"。
 * - 步骤 2 模型：`api.getModels()`；只有"已保存 API Key 的 provider"且"已登记模型"才算可用。
 * - 步骤 3 告警：`api.listAlerts({limit:1})`；有数据才展示第一条（标题/级别/总数），
 *   0 条就写"还没有告警"，接口失败就写"查不到"，**绝不编造数字**。
 * - 探测失败一律降级为"查不到/未连接"，不把 failure 渲染成 success。
 *
 * ---------------------------------------------------------------------------
 * 两个重看入口
 * ---------------------------------------------------------------------------
 * ① URL `?onboarding=1`：强制显示，且**不写 localStorage**（跳过/关闭只隐藏本次）；
 * ② 顶栏 i-info 图标按钮 `#onboarding-help`：原生 `<button>`，Enter/Space 可触发。
 *    该按钮只在 banner 不可见时出现（引导在场时不重复放"重看引导"入口，
 *    也因此不改变冻结的 topbar 三按钮结构 —— 见 evidence/ui-polish/onboarding/REPORT.md）。
 *
 * 样式走本模块 scoped `<style id="onboarding-styles">`（CSP 已允许 inline style），
 * 不写 `styles/**`。文案 key 先落 `i18n/_pending/onboarding.json`，代码里
 * `t('key','English fallback')` 双参兜底（不产生 `[missing:]` 标记）。
 */

import { el, icon } from './components/ui/dom.js';
import { readUi, writeUi } from './store.js';

/** 页内 banner 的容器 id（index.html 里 `</header>` 与 `<main>` 之间的空 div）。 */
export const ONBOARDING_ROOT_ID = 'onboarding-root';
/** banner 本体 id（role="region"）。 */
export const ONBOARDING_BANNER_ID = 'onboarding-banner';
/** 步骤区 id（折叠按钮 aria-controls 指向它）。 */
export const ONBOARDING_BODY_ID = 'onboarding-body';
/** 顶栏"重看引导"按钮 id。 */
export const ONBOARDING_HELP_ID = 'onboarding-help';
/** 注入样式表 id。 */
export const ONBOARDING_STYLES_ID = 'onboarding-styles';
/** 持久化键（aidn.ui 内的布尔项）。 */
export const ONBOARDING_DONE_KEY = 'onboardingDone';
/** 强制显示参数名（`?onboarding=1`）。 */
export const ONBOARDING_FORCE_PARAM = 'onboarding';
/** 步骤 2 去配模型的目标 hash（settings 的 models 组）。 */
export const ONBOARDING_MODELS_HASH = '#/settings?group=models';
/** 步骤 3 看告警的目标 hash。 */
export const ONBOARDING_ALERTS_HASH = '#/alerts';

/** 本模块 scoped 样式：**不含任何 position 声明**（禁止 fixed/absolute 覆盖）。 */
const STYLES = `
#onboarding-root {
  width: 100%;
  max-width: var(--layout-max);
  margin: 0 auto;
  padding: var(--sp-3) var(--layout-gutter) 0;
}
#onboarding-root[hidden] { display: none !important; }
.onboarding-banner {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--c-border-strong);
  border-left: 3px solid var(--c-accent);
  border-radius: var(--r-lg);
  background: var(--c-surface);
  color: var(--c-text);
  animation: none;
  transition: none;
}
.onboarding-banner__head { display: flex; align-items: flex-start; gap: var(--sp-3); flex-wrap: wrap; }
.onboarding-banner__mark { display: inline-flex; color: var(--c-info); margin-top: 2px; }
.onboarding-banner__headings { min-width: 0; flex: 1 1 320px; }
.onboarding-banner__title { margin: 0; font-size: var(--fs-lg); line-height: var(--lh-tight); }
.onboarding-banner__sub { margin: var(--sp-1) 0 0; color: var(--c-text-muted); font-size: var(--fs-sm); }
.onboarding-banner__actions { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; flex-wrap: wrap; }
.onboarding-banner__body { display: flex; flex-direction: column; gap: var(--sp-3); }
.onboarding-banner__body[hidden] { display: none !important; }
.onboarding-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-3);
  margin: 0;
  padding: 0;
  list-style: none;
}
.onboarding-step {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
  padding: var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-bg-elev);
}
.onboarding-step[data-state="done"] { border-color: var(--c-ok); }
.onboarding-step[data-state="warn"] { border-color: var(--c-warn); }
.onboarding-step__row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.onboarding-step__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--c-border-strong);
  color: var(--c-text-muted);
  font-size: var(--fs-xs);
  flex: 0 0 auto;
}
.onboarding-step__title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); min-width: 0; }
.onboarding-step__badge {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
  border-radius: var(--r-sm);
  padding: 0 var(--sp-1);
  white-space: nowrap;
}
.onboarding-step__badge[data-state="done"] { color: var(--c-ok); border-color: var(--c-ok); }
.onboarding-step__badge[data-state="warn"] { color: var(--c-warn); border-color: var(--c-warn); }
.onboarding-step__badge[data-state="unknown"],
.onboarding-step__badge[data-state="checking"] { color: var(--c-text-muted); }
.onboarding-step__detail { margin: 0; font-size: var(--fs-sm); color: var(--c-text); overflow-wrap: anywhere; }
.onboarding-step__hint { margin: 0; font-size: var(--fs-xs); color: var(--c-text-muted); }
.onboarding-step__actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: auto; }
.onboarding-banner__foot { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.onboarding-banner__foot-note { margin: 0; margin-left: auto; font-size: var(--fs-xs); color: var(--c-text-faint); }
@media (max-width: 900px) {
  .onboarding-steps { grid-template-columns: 1fr; }
  .onboarding-banner__actions { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .onboarding-banner, .onboarding-banner * { animation-duration: 0s !important; transition-duration: 0s !important; }
}
`;

/**
 * 双参兜底翻译：i18n 有 key 就用它，否则用英文兜底（新 key 在 i18n/_pending/onboarding.json）。
 * 绝不返回 `[missing:key]`（合同 §8.5 的标记留给真正的漏配，不在这里制造噪音）。
 *
 * @param {object|null} i18n
 * @returns {(key: string, fallback: string, vars?: object) => string}
 */
export function makeTranslator(i18n) {
  const has = i18n && typeof i18n.has === 'function' ? (key) => {
    try {
      return i18n.has(key) === true;
    } catch {
      return false;
    }
  } : () => false;
  const lookup = (key) => {
    if (!has(key) || !i18n || typeof i18n.t !== 'function') return null;
    try {
      const value = i18n.t(key);
      return typeof value === 'string' && value !== '' && !value.startsWith('[missing:') ? value : null;
    } catch {
      return null;
    }
  };
  return function t(key, fallback, vars) {
    let text = lookup(key);
    if (text === null) text = typeof fallback === 'string' ? fallback : String(key ?? '');
    if (vars && typeof vars === 'object') {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(value === null || value === undefined ? '' : String(value));
      }
    }
    return text;
  };
}

/**
 * 本地已记录"引导已完成/已跳过"？读 aidn.ui.onboardingDone（布尔）。
 * @returns {boolean}
 */
export function isOnboardingDone() {
  try {
    return readUi()[ONBOARDING_DONE_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * 记录"引导已关闭"（只写 aidn.ui.onboardingDone=true，不含任何个人数据）。
 * @returns {boolean}
 */
export function persistOnboardingDone() {
  try {
    return writeUi({ [ONBOARDING_DONE_KEY]: true });
  } catch {
    return false;
  }
}

/**
 * URL 是否强制显示引导（`?onboarding=1`）。强制模式不读写持久化标记。
 * @param {string} [search]
 * @returns {boolean}
 */
export function isOnboardingForced(search) {
  const raw = typeof search === 'string' ? search : '';
  const pattern = new RegExp(`[?&]${ONBOARDING_FORCE_PARAM}=1(?:&|$)`, 'u');
  return pattern.test(raw);
}

/** 浏览器当前 origin 的端口（读不到返回 null，绝不猜）。 */
function currentPort(win) {
  try {
    const location = win && win.location ? win.location : null;
    if (!location) return null;
    if (typeof location.port === 'string' && location.port !== '') return location.port;
    const protocol = typeof location.protocol === 'string' ? location.protocol : '';
    if (protocol === 'https:') return '443';
    if (protocol === 'http:') return '80';
    return null;
  } catch {
    return null;
  }
}

/**
 * `/healthz` 响应 → 三态（online/degraded/offline）。真 daemon 返回 ok|degraded|failed。
 * @param {*} value
 */
function normalizeHealth(value) {
  const health = value && typeof value === 'object' ? value : {};
  const status = typeof health.status === 'string' ? health.status : null;
  const version = typeof health.version === 'string' && health.version !== '' ? health.version : null;
  if (status === 'ok' || status === 'healthy' || status === 'up' || status === 'pass') {
    return { state: 'online', status, version, answered: true };
  }
  if (status === 'degraded' || status === 'warn') {
    return { state: 'degraded', status, version, answered: true };
  }
  return { state: 'offline', status, version, answered: status !== null };
}

/**
 * `/api/v1/models` 响应 → 可用性。只有"已存 API Key 的 provider + 已登记模型"才算可用。
 * @param {*} value
 */
function normalizeModels(value) {
  const body = value && typeof value === 'object' ? value : {};
  const providers = Array.isArray(body.providers) ? body.providers : [];
  const models = Array.isArray(body.models) ? body.models : [];
  const readyProviders = providers.filter(
    (provider) => provider && typeof provider === 'object' && provider.hasCredential === true && provider.enabled !== false,
  ).length;
  return {
    state: 'ready',
    models: models.length,
    providers: providers.length,
    readyProviders,
    available: models.length > 0 && readyProviders > 0,
  };
}

/**
 * `/api/v1/alerts` 响应 → 三态（has/empty/unreadable）。绝不把解析失败当 0 条。
 * @param {*} value
 */
function normalizeAlerts(value) {
  const body = value && typeof value === 'object' ? value : {};
  let rows = null;
  if (Array.isArray(body.alerts)) rows = body.alerts;
  else if (Array.isArray(body.items)) rows = body.items;
  else if (Array.isArray(body.rows)) rows = body.rows;
  if (rows === null) return { state: 'unreadable', total: null, first: null };
  const page = body.page && typeof body.page === 'object' ? body.page : body;
  const declared = Number(page.total);
  const total = Number.isFinite(declared) ? Math.max(declared, rows.length) : rows.length;
  return { state: total > 0 ? 'has' : 'empty', total, first: rows[0] ?? null };
}

/** 从一条真实告警里取出可展示的"第一条"信息；取不到就返回 null（不编造）。 */
function describeAlert(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [row.title, row.summary, row.ruleName, row.rule, row.name, row.message, row.id];
  const label = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
  if (label === undefined) return null;
  const severity = [row.severity, row.level, row.priority].find((value) => typeof value === 'string' && value.trim() !== '');
  return {
    label: String(label).trim().slice(0, 120),
    severity: severity === undefined ? null : String(severity).trim().slice(0, 24),
  };
}

/**
 * 创建引导控制器（不自动显示；由 `mount()` 按持久化标记/URL 决定）。
 *
 * @param {{
 *   document?: object, window?: object, api?: object, i18n?: object, store?: object,
 *   mount?: object|null, search?: string,
 * }} [options]
 * @returns {{mount: Function, show: Function, hide: Function, toggle: Function, probe: Function,
 *   destroy: Function, isVisible: Function, getState: Function}}
 */
export function createOnboarding(options = {}) {
  const opts = options == null ? {} : options;
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : null);
  const win = opts.window ?? (typeof window !== 'undefined' ? window : null);
  const api = opts.api ?? null;
  const i18n = opts.i18n ?? null;
  const store = opts.store ?? null;
  const t = makeTranslator(i18n);
  const search = typeof opts.search === 'string'
    ? opts.search
    : win && win.location && typeof win.location.search === 'string'
      ? win.location.search
      : '';

  const state = {
    visible: false,
    collapsed: false,
    forced: false,
    phase: 'idle',
    health: { state: 'unknown', status: null, version: null, answered: false },
    models: { state: 'unknown', models: 0, providers: 0, readyProviders: 0, available: false },
    alerts: { state: 'unknown', total: null, first: null },
  };

  let section = null;
  let container = null;
  let helpButton = null;
  let unsubscribe = null;
  let probeToken = 0;
  let destroyed = false;

  // ── 样式（幂等注入；与 settings 视图同一套 ensureStyles 做法） ────────────
  function ensureStyles() {
    try {
      if (!doc || typeof doc.createElement !== 'function') return;
      if (typeof doc.getElementById === 'function' && doc.getElementById(ONBOARDING_STYLES_ID)) return;
      const style = doc.createElement('style');
      style.setAttribute('id', ONBOARDING_STYLES_ID);
      style.textContent = STYLES;
      const head = doc.head ?? doc.documentElement;
      if (head && typeof head.appendChild === 'function') head.appendChild(style);
    } catch {
      /* 样式注入失败不阻断引导 */
    }
  }

  function removeStyles() {
    try {
      const node = doc && typeof doc.getElementById === 'function' ? doc.getElementById(ONBOARDING_STYLES_ID) : null;
      if (node && typeof node.remove === 'function') node.remove();
    } catch {
      /* ignore */
    }
  }

  /** 找到（或补上）banner 容器：普通文档流，位于 topbar 之后、`<main>` 之前。 */
  function ensureContainer() {
    if (container && container.parentNode) return container;
    if (!doc) return null;
    let node = typeof doc.getElementById === 'function' ? doc.getElementById(ONBOARDING_ROOT_ID) : null;
    if (!node) {
      node = doc.createElement('div');
      node.setAttribute('id', ONBOARDING_ROOT_ID);
      node.setAttribute('hidden', '');
      const main = typeof doc.getElementById === 'function' ? doc.getElementById('view-root') : null;
      const app = typeof doc.getElementById === 'function' ? doc.getElementById('app') : null;
      if (main && main.parentNode && typeof main.parentNode.insertBefore === 'function') {
        main.parentNode.insertBefore(node, main);
      } else if (app && typeof app.appendChild === 'function') {
        app.appendChild(node);
      } else if (doc.body && typeof doc.body.appendChild === 'function') {
        doc.body.appendChild(node);
      }
    }
    container = node;
    return container;
  }

  // ── 顶栏"重看引导"入口（只在 banner 不可见时存在） ──────────────────────
  function removeHelpButton() {
    try {
      if (helpButton && typeof helpButton.remove === 'function') helpButton.remove();
    } catch {
      /* ignore */
    }
    helpButton = null;
  }

  function syncHelpButton() {
    if (destroyed || !doc) return;
    if (state.visible) {
      removeHelpButton();
      return;
    }
    if (helpButton && helpButton.parentNode) return;
    const tools = typeof doc.getElementById === 'function'
      ? (doc.querySelector ? doc.querySelector('.topbar-tools') : null)
      : null;
    if (!tools || typeof tools.appendChild !== 'function') return;
    const label = t('onboarding.help.open', 'Show the first-run guide');
    const button = el('button', {
      id: ONBOARDING_HELP_ID,
      type: 'button',
      class: 'ui-btn ui-btn--icon',
      aria: { label },
      title: label,
      data: { onboardingHelp: '1' },
      on: {
        click: () => {
          show({ reason: 'manual' });
        },
      },
    }, [icon('info')]);
    tools.appendChild(button);
    helpButton = button;
  }

  // ── 真实数据探测 ──────────────────────────────────────────────────────
  function callApi(name, args) {
    return new Promise((resolve, reject) => {
      const fn = api && typeof api[name] === 'function' ? api[name] : null;
      if (!fn) {
        reject(new Error(`api.${name} is not available`));
        return;
      }
      try {
        Promise.resolve(fn(args)).then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 探测三步的真实状态。永不 reject；任何失败都落到"查不到/未连接"。
   * @returns {Promise<object>} state
   */
  async function probe() {
    if (destroyed) return state;
    const token = (probeToken += 1);
    state.phase = 'probing';
    state.health = { state: 'unknown', status: null, version: null, answered: false };
    state.models = { state: 'unknown', models: 0, providers: 0, readyProviders: 0, available: false };
    state.alerts = { state: 'unknown', total: null, first: null };
    render();
    const [healthResult, modelsResult, alertsResult] = await Promise.allSettled([
      callApi('getHealth'),
      callApi('getModels'),
      callApi('listAlerts', { limit: 1 }),
    ]);
    if (destroyed || token !== probeToken) return state;
    state.health = healthResult.status === 'fulfilled'
      ? normalizeHealth(healthResult.value)
      : { state: 'offline', status: null, version: null, answered: false };
    state.models = modelsResult.status === 'fulfilled'
      ? normalizeModels(modelsResult.value)
      : { state: 'unknown', models: 0, providers: 0, readyProviders: 0, available: false };
    state.alerts = alertsResult.status === 'fulfilled'
      ? normalizeAlerts(alertsResult.value)
      : { state: 'unknown', total: null, first: null };
    state.phase = 'ready';
    render();
    syncHelpButton();
    return state;
  }

  // ── 文案（全部双参兜底） ──────────────────────────────────────────────
  const unknownText = () => t('onboarding.common.unknown', 'unknown');

  function healthDetail() {
    const health = state.health;
    const port = currentPort(win);
    const portText = port === null ? unknownText() : port;
    const versionText = health.version === null ? unknownText() : health.version;
    if (state.phase === 'probing') return t('onboarding.step.health.checking', 'Checking /healthz…');
    if (health.state === 'online') {
      return t(
        'onboarding.step.health.online',
        'Connected · /healthz {status} · version {version} · port {port}',
        { status: health.status ?? 'ok', version: versionText, port: portText },
      );
    }
    if (health.state === 'degraded') {
      return t(
        'onboarding.step.health.degraded',
        'Connected but degraded · /healthz {status} · version {version} · port {port}',
        { status: health.status ?? 'degraded', version: versionText, port: portText },
      );
    }
    if (health.answered) {
      return t(
        'onboarding.step.health.unhealthy',
        'The daemon answered with status “{status}” — not healthy. Version {version} · port {port}',
        { status: health.status ?? unknownText(), version: versionText, port: portText },
      );
    }
    return t(
      'onboarding.step.health.offline',
      'Not connected — /healthz did not answer, so version and port cannot be reported.',
    );
  }

  function modelsDetail() {
    const models = state.models;
    if (state.phase === 'probing') return t('onboarding.step.models.checking', 'Checking the model list…');
    if (models.state === 'unknown') {
      return t('onboarding.step.models.unknown', 'Cannot read the model list right now — no counts are shown.');
    }
    if (models.available) {
      return t(
        'onboarding.step.models.ready',
        '{models} model(s) registered · {readyProviders} provider(s) with a saved API key',
        { models: models.models, readyProviders: models.readyProviders },
      );
    }
    if (models.readyProviders === 0) {
      return t(
        'onboarding.step.models.no-key',
        'No usable model yet: no provider has a saved API key. Save the key, then press “Test connection”.',
      );
    }
    return t(
      'onboarding.step.models.no-model',
      'A provider has a key but no model is registered yet. Add a model in model settings.',
    );
  }

  function alertsDetail() {
    const alerts = state.alerts;
    if (state.phase === 'probing') return t('onboarding.step.alerts.checking', 'Checking the alert feed…');
    if (alerts.state === 'unreadable' || alerts.state === 'unknown') {
      return t(
        'onboarding.step.alerts.unavailable',
        'Alert data is unavailable right now — the alerts API did not answer. No count is shown.',
      );
    }
    if (alerts.state === 'has') {
      const first = describeAlert(alerts.first);
      const total = alerts.total === null ? unknownText() : alerts.total;
      if (first === null) {
        return t('onboarding.step.alerts.has', '{total} alert(s) stored — open the alert list to read them.', { total });
      }
      const head = first.severity === null ? first.label : `${first.severity} · ${first.label}`;
      return t('onboarding.step.alerts.has-one', 'First alert ({total} stored): {alert}', { total, alert: head });
    }
    return t(
      'onboarding.step.alerts.empty',
      'No alerts yet. Let collection run for a while, then come back — nothing is invented here.',
    );
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────
  const STATE_LABEL = {
    done: ['onboarding.step.state.done', 'Done'],
    todo: ['onboarding.step.state.todo', 'To do'],
    warn: ['onboarding.step.state.warn', 'Needs attention'],
    unknown: ['onboarding.step.state.unknown', 'Unknown'],
    checking: ['onboarding.step.state.checking', 'Checking'],
  };

  function stepState(key) {
    if (state.phase === 'probing') return 'checking';
    if (key === 'health') {
      if (state.health.state === 'online') return 'done';
      if (state.health.state === 'degraded') return 'warn';
      return 'todo';
    }
    if (key === 'models') {
      if (state.models.state === 'unknown') return 'unknown';
      return state.models.available ? 'done' : 'todo';
    }
    if (state.alerts.state === 'unknown' || state.alerts.state === 'unreadable') return 'unknown';
    return state.alerts.state === 'has' ? 'done' : 'todo';
  }

  function stateIcon(stateName) {
    if (stateName === 'done') return icon('check');
    if (stateName === 'warn') return icon('warning');
    if (stateName === 'checking') return icon('spinner');
    if (stateName === 'unknown') return icon('info');
    return icon('clock');
  }

  function buildStep(spec) {
    const [labelKey, labelFallback] = STATE_LABEL[spec.state] ?? STATE_LABEL.todo;
    const stateText = t(labelKey, labelFallback);
    const item = el('li', {
      class: 'onboarding-step',
      data: { step: spec.key, state: spec.state },
    }, [
      el('div', { class: 'onboarding-step__row' }, [
        el('span', { class: 'onboarding-step__index', aria: { hidden: 'true' }, text: String(spec.index) }),
        el('h3', { class: 'onboarding-step__title', text: spec.title }),
        el('span', { class: 'onboarding-step__badge', data: { state: spec.state } }, [
          el('span', { class: 'onboarding-step__state-icon', aria: { hidden: 'true' } }, [stateIcon(spec.state)]),
          el('span', { text: stateText }),
        ]),
      ]),
      el('p', { class: 'onboarding-step__detail', text: spec.detail }),
      spec.hint === null ? null : el('p', { class: 'onboarding-step__hint', text: spec.hint }),
      el('div', { class: 'onboarding-step__actions' }, [
        el('button', {
          type: 'button',
          class: 'ui-btn',
          data: { action: spec.actionId },
          aria: { label: spec.actionLabel },
          title: spec.actionLabel,
          on: { click: spec.onAction },
        }, [spec.actionText]),
      ]),
    ]);
    return item;
  }

  function goTo(hash) {
    try {
      if (win && win.location) win.location.hash = hash;
    } catch {
      /* 导航失败不抛给用户 */
    }
  }

  /** 下一步该去哪：在线未确认 → 重新探测；模型未就绪 → 模型设置；无告警 → 告警页；全完成 → 关闭。 */
  function nextTarget() {
    if (state.health.state !== 'online') {
      return { kind: 'probe', labelKey: 'onboarding.action.recheck', label: 'Check again' };
    }
    if (!state.models.available) {
      return { kind: 'models', labelKey: 'onboarding.action.next-models', label: 'Next: configure a model' };
    }
    if (state.alerts.state !== 'has') {
      return { kind: 'alerts', labelKey: 'onboarding.action.next-alerts', label: 'Next: open the alerts' };
    }
    return { kind: 'finish', labelKey: 'onboarding.action.finish', label: 'Finish and hide this guide' };
  }

  function dismiss() {
    hide({ persist: state.forced !== true, reason: state.forced ? 'forced-dismiss' : 'skip' });
  }

  function render() {
    if (!state.visible || destroyed) return;
    const host = ensureContainer();
    if (!host) return;
    ensureStyles();
    const activeAction = section && typeof doc.contains === 'function' && doc.activeElement
      && typeof section.contains === 'function' && section.contains(doc.activeElement)
      ? doc.activeElement.getAttribute('data-action')
      : null;

    const regionLabel = t('onboarding.region.label', 'First-run guide');
    const skipLabel = t('onboarding.action.skip', 'Skip the first-run guide');
    const collapseLabel = state.collapsed
      ? t('onboarding.action.expand', 'Expand the first-run guide')
      : t('onboarding.action.collapse', 'Collapse the first-run guide');
    const next = nextTarget();
    const nextLabel = t(next.labelKey, next.label);

    const head = el('div', { class: 'onboarding-banner__head' }, [
      el('span', { class: 'onboarding-banner__mark', aria: { hidden: 'true' } }, [icon('info')]),
      el('div', { class: 'onboarding-banner__headings' }, [
        el('h2', { id: 'onboarding-title', class: 'onboarding-banner__title', text: t('onboarding.title', 'Getting started') }),
        el('p', {
          class: 'onboarding-banner__sub',
          text: t(
            'onboarding.subtitle',
            'Three checks to confirm this console can see real data. This card sits in the page flow — it never covers the console and you can skip it at any time.',
          ),
        }),
      ]),
      el('div', { class: 'onboarding-banner__actions' }, [
        el('button', {
          type: 'button',
          class: 'ui-btn',
          data: { action: 'skip' },
          aria: { label: skipLabel },
          title: skipLabel,
          on: { click: dismiss },
        }, [t('onboarding.action.skip.short', 'Skip')]),
        el('button', {
          type: 'button',
          class: 'ui-btn',
          data: { action: 'toggle' },
          aria: { label: collapseLabel, expanded: state.collapsed ? 'false' : 'true', controls: ONBOARDING_BODY_ID },
          title: collapseLabel,
          on: {
            click: () => {
              state.collapsed = !state.collapsed;
              render();
            },
          },
        }, [state.collapsed ? t('onboarding.action.expand.short', 'Expand') : t('onboarding.action.collapse.short', 'Collapse')]),
      ]),
    ]);

    const body = el('div', {
      id: ONBOARDING_BODY_ID,
      class: 'onboarding-banner__body',
      hidden: state.collapsed,
    }, [
      el('ol', {
        class: 'onboarding-steps',
        role: 'list',
        aria: { label: t('onboarding.steps.label', 'Three first-run checks') },
      }, [
        buildStep({
          index: 1,
          key: 'health',
          title: t('onboarding.step.health.title', 'Confirm the daemon is online'),
          detail: healthDetail(),
          hint: t(
            'onboarding.step.health.hint',
            'If this stays offline: make sure the local daemon service is running, then press “Check again”. Still failing? Open Settings → Diagnostics.',
          ),
          state: stepState('health'),
          actionId: 'recheck',
          actionText: t('onboarding.action.recheck', 'Check again'),
          actionLabel: t('onboarding.action.recheck.aria', 'Check the daemon connection again'),
          onAction: () => {
            probe();
          },
        }),
        buildStep({
          index: 2,
          key: 'models',
          title: t('onboarding.step.models.title', 'Configure a model'),
          detail: modelsDetail(),
          hint: t(
            'onboarding.step.models.hint',
            'Model settings is where providers, API keys and the “Test connection” button live.',
          ),
          state: stepState('models'),
          actionId: 'models',
          actionText: t('onboarding.action.open-models', 'Open model settings'),
          actionLabel: t('onboarding.action.open-models.aria', 'Open model settings to save an API key'),
          onAction: () => {
            goTo(ONBOARDING_MODELS_HASH);
          },
        }),
        buildStep({
          index: 3,
          key: 'alerts',
          title: t('onboarding.step.alerts.title', 'Look at the first alert'),
          detail: alertsDetail(),
          hint: t(
            'onboarding.step.alerts.hint',
            'Only real alerts from the local daemon are shown; an empty list stays empty.',
          ),
          state: stepState('alerts'),
          actionId: 'alerts',
          actionText: t('onboarding.action.open-alerts', 'Open alerts'),
          actionLabel: t('onboarding.action.open-alerts.aria', 'Open the alert list'),
          onAction: () => {
            goTo(ONBOARDING_ALERTS_HASH);
          },
        }),
      ]),
      el('div', { class: 'onboarding-banner__foot' }, [
        el('button', {
          type: 'button',
          class: 'ui-btn',
          data: { variant: 'primary', action: 'next' },
          aria: { label: nextLabel },
          title: nextLabel,
          on: {
            click: () => {
              if (next.kind === 'probe') {
                probe();
              } else if (next.kind === 'models') {
                goTo(ONBOARDING_MODELS_HASH);
              } else if (next.kind === 'alerts') {
                goTo(ONBOARDING_ALERTS_HASH);
              } else {
                dismiss();
              }
            },
          },
        }, [nextLabel]),
        el('p', {
          class: 'onboarding-banner__foot-note',
          text: t(
            'onboarding.foot.note',
            'Stays in the page flow — the console below is always clickable; the guide never blocks navigation.',
          ),
        }),
      ]),
    ]);

    const region = el('section', {
      id: ONBOARDING_BANNER_ID,
      class: 'onboarding-banner',
      role: 'region',
      aria: { label: regionLabel, labelledby: 'onboarding-title' },
      data: { onboarding: 'banner', phase: state.phase, collapsed: state.collapsed ? 'true' : 'false' },
    }, [head, body]);

    section = region;
    if (typeof host.replaceChildren === 'function') host.replaceChildren(region);
    else if (typeof host.appendChild === 'function') host.appendChild(region);
    host.hidden = false;

    if (activeAction) {
      const again = typeof host.querySelector === 'function' ? host.querySelector(`[data-action="${activeAction}"]`) : null;
      if (again && typeof again.focus === 'function') {
        try {
          again.focus();
        } catch {
          /* 焦点恢复失败不影响引导 */
        }
      }
    }
  }

  // ── 显示 / 隐藏 ───────────────────────────────────────────────────────
  function show(showOptions = {}) {
    if (destroyed) return null;
    const reason = typeof showOptions.reason === 'string' ? showOptions.reason : 'manual';
    state.visible = true;
    state.forced = reason === 'forced' || (reason !== 'manual' && isOnboardingForced(search));
    state.collapsed = false;
    removeHelpButton();
    render();
    probe();
    return section;
  }

  function hide(hideOptions = {}) {
    if (destroyed) return false;
    const persist = hideOptions.persist === true;
    state.visible = false;
    if (section && typeof section.remove === 'function') section.remove();
    section = null;
    const host = ensureContainer();
    if (host) {
      if (typeof host.replaceChildren === 'function') host.replaceChildren();
      host.hidden = true;
    }
    if (persist) persistOnboardingDone();
    syncHelpButton();
    return true;
  }

  function toggle() {
    if (state.visible) return hide({ persist: false, reason: 'toggle' });
    return show({ reason: 'manual' });
  }

  /** 挂载：只在"未完成"或 `?onboarding=1` 时显示（每次页面加载只判断一次）。 */
  function mount() {
    if (destroyed) return null;
    ensureStyles();
    if (store && typeof store.subscribe === 'function') {
      try {
        unsubscribe = store.subscribe((current, previous, changed) => {
          if (!Array.isArray(changed) || !changed.includes('i18n')) return;
          if (state.visible) render();
        });
      } catch {
        unsubscribe = null;
      }
    }
    const forced = isOnboardingForced(search);
    if (forced) {
      show({ reason: 'forced' });
      return section;
    }
    if (isOnboardingDone()) {
      state.visible = false;
      const host = ensureContainer();
      if (host) host.hidden = true;
      syncHelpButton();
      return null;
    }
    show({ reason: 'initial' });
    return section;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    probeToken += 1;
    if (typeof unsubscribe === 'function') {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
    }
    removeHelpButton();
    if (section && typeof section.remove === 'function') section.remove();
    section = null;
    if (container) {
      try {
        container.remove();
      } catch {
        /* ignore */
      }
      container = null;
    }
    removeStyles();
  }

  return {
    mount,
    show,
    hide,
    toggle,
    probe,
    destroy,
    isVisible: () => state.visible === true,
    getState: () => state,
    get element() {
      return section;
    },
  };
}
