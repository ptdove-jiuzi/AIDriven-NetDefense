/**
 * B7 · 设置页入口
 * 作者：PT-dove
 *
 * 合同 §7.2 视图契约：`export async function mount(root, ctx) → { destroy() }`
 * ctx = { store, api, i18n, params, navigate, toast }
 *
 * 结构：
 * - 加载：`api.getSettingsSchema()` + `api.getSettings()` → 三态（loading / schema 失败可重试 / ready）
 * - 渲染：8 组各一文件，字段全部由 schema 生成；`#/settings?group=<id>` 与 `#/models`（group=models）同步
 * - 保存：客户端校验 → 危险变更二次确认 → `api.putSettings(draft, {dryRun, discardCredential})`
 *   → SETTINGS_INVALID 按 `details.path` 字段级高亮；SETTINGS_LOCKED → 二次确认后带 discardCredential 重试
 * - 生命周期：store 订阅（切语言即时重渲染）、destroy 时关弹层/退订/清 DOM
 *
 * 本文件只依赖 B1 的组件与 B2 的 ctx 契约；不 import B2 的运行时模块（缺实现用 stub 自测）。
 */
import { el } from '../../components/ui/dom.js';
import { button } from '../../components/ui/button.js';
import { badge } from '../../components/ui/badge.js';
import { tabs } from '../../components/ui/tabs.js';
import { skeleton } from '../../components/ui/skeleton.js';
import { empty } from '../../components/ui/empty.js';
import {
  apiErrorInfo,
  applyFieldError,
  applyLocalUiPrefs,
  asArray,
  banner,
  changedItems,
  cloneJson,
  confirmDestructive,
  createTranslator,
  currentLocale,
  daemonUnavailable,
  dangerConsequences,
  dangerousChanges,
  errorText,
  firstFocusable,
  groupUnavailable,
  humanize,
  mergeSchemaDefaults,
  notify,
  payloadForSave,
  ruleText,
  validateDraft,
} from './shared.js';
import { createModelState, render as renderModels } from './models.js';
import { render as renderCollection } from './collection.js';
import { render as renderDetection } from './detection.js';
import { render as renderResponse } from './response.js';
import { render as renderUi } from './ui.js';
import { render as renderUpdate } from './update.js';
import { render as renderDiagnostics } from './diagnostics.js';
import { render as renderAbout } from './about.js';

const GROUP_RENDERERS = Object.freeze({
  models: renderModels,
  collection: renderCollection,
  detection: renderDetection,
  response: renderResponse,
  ui: renderUi,
  update: renderUpdate,
  diagnostics: renderDiagnostics,
  about: renderAbout,
});

/** 这些 path 的变化会改变结构（数组增删 / 路由模式），需要重渲染组体。 */
const STRUCTURAL_PATHS = new Set(['models.providers', 'models.models', 'models.routing.mode']);

/**
 * schema 拿不到时仍然要渲染的组标签（**只是标签**，不是字段）。
 * 目的：daemon 不在时每组都有显式"不可用"占位，而不是整页只剩一句错误。
 * 字段永远不从这张表来——没有 schema 就不渲染任何可信字段。
 */
const FALLBACK_GROUPS = Object.freeze([
  'models',
  'collection',
  'detection',
  'response',
  'ui',
  'update',
  'diagnostics',
  'about',
]);

/**
 * 由外壳（app.js）消费、因此无 daemon 也能改的界面键。
 * 只有这四项进本地链路；trayBehavior/autostart 需要 daemon，不算在内。
 */
const LOCAL_UI_PATHS = Object.freeze(['ui.theme', 'ui.density', 'ui.locale', 'ui.startView']);

const STYLE_ID = 'settings-view-styles';
const VIEW_STYLES = `
.settings-view { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.settings-header { display: flex; align-items: flex-start; gap: var(--sp-3); flex-wrap: wrap; }
.settings-header__text { min-width: 0; }
.settings-header__title { margin: 0; font-size: var(--fs-2xl); line-height: var(--lh-tight); }
.settings-header__sub { margin: var(--sp-1) 0 0; color: var(--c-text-muted); font-size: var(--fs-base); }
.settings-header__meta { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; flex-wrap: wrap; }
.settings-tabs { min-width: 0; }
.settings-body { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
.settings-section { border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-surface); min-width: 0; }
.settings-section__head { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-4); border-bottom: 1px solid var(--c-border); }
.settings-section__headings { min-width: 0; }
.settings-section__title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--c-text); }
.settings-section__note { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--c-text-muted); max-width: 88ch; }
.settings-section__actions { display: flex; align-items: center; gap: var(--sp-2); margin-left: auto; flex-wrap: wrap; }
.settings-section__body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4); min-width: 0; }
.settings-item { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2) 0; border-bottom: 1px dashed var(--c-border); min-width: 0; }
.settings-item:last-child { border-bottom: 0; }
.settings-item[data-invalid="true"] { border-left: 3px solid var(--c-danger); padding-left: var(--sp-2); }
.settings-item__head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.settings-item__label { font-weight: var(--fw-medium); color: var(--c-text); }
.settings-item__path { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-faint); }
.settings-item__control { max-width: 640px; min-width: 0; }
.settings-item__hint { margin: 0; font-size: var(--fs-sm); color: var(--c-text-muted); }
.settings-item__meta { margin: 0; font-size: var(--fs-xs); color: var(--c-text-faint); }
.settings-item__error { margin: 0; font-size: var(--fs-sm); color: var(--c-danger); }
.settings-badges { display: inline-flex; align-items: center; gap: var(--sp-1); flex-wrap: wrap; }
.settings-readonly { font-size: var(--fs-sm); color: var(--c-text-muted); word-break: break-word; }
.settings-providers { display: flex; flex-direction: column; gap: var(--sp-3); }
.settings-provider { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg-elev); }
.settings-provider__head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.settings-provider__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--sp-2) var(--sp-3); }
.settings-subfield { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.settings-subfield__label { font-size: var(--fs-sm); color: var(--c-text-muted); }
.settings-creds { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3); border: 1px dashed var(--c-border-strong); border-radius: var(--r-md); }
.settings-creds__head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.settings-creds__facts { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.settings-test { display: flex; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-2); border-top: 1px dashed var(--c-border); }
.settings-test__head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.settings-test__error { margin: 0; font-size: var(--fs-sm); color: var(--c-danger); display: flex; gap: var(--sp-1); flex-wrap: wrap; }
.settings-array { display: flex; flex-direction: column; gap: var(--sp-2); }
.settings-array__row { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-2); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg-elev); }
.settings-array__head { display: flex; align-items: center; gap: var(--sp-2); }
.settings-array__title { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--c-text-faint); }
.settings-array__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--sp-2) var(--sp-3); }
.settings-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.settings-list__row { display: flex; align-items: center; gap: var(--sp-2); }
.settings-list__row .ui-input { flex: 1 1 auto; }
.settings-checklist { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
.settings-kv { display: grid; grid-template-columns: minmax(150px, max-content) 1fr; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); align-items: center; }
.settings-kv__key { color: var(--c-text-muted); font-family: var(--font-mono); font-size: var(--fs-xs); }
.settings-tier { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-2); }
.settings-tier__card { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-2); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg-elev); min-width: 0; }
.settings-tier__head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
.settings-tier__list { margin: 0; padding-left: var(--sp-4); font-size: var(--fs-sm); color: var(--c-text-muted); }
.settings-stack { display: flex; flex-direction: column; gap: var(--sp-2); }
.settings-banner { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-bg-elev); }
.settings-banner[data-tone="warn"] { border-color: var(--c-warn); background: var(--c-sev-high-bg); }
.settings-banner[data-tone="danger"] { border-color: var(--c-danger); background: var(--c-sev-critical-bg); }
.settings-banner__icon { color: var(--c-info); margin-top: 1px; }
.settings-banner[data-tone="warn"] .settings-banner__icon { color: var(--c-warn); }
.settings-banner[data-tone="danger"] .settings-banner__icon { color: var(--c-danger); }
.settings-banner__text { min-width: 0; }
.settings-banner__text strong { display: block; }
.settings-banner__text p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--c-text-muted); }
.settings-banner__actions { margin-left: auto; display: flex; gap: var(--sp-2); }
.settings-action { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2); border: 1px solid var(--c-border); border-radius: var(--r-md); }
.settings-action__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.settings-action__label { font-weight: var(--fw-medium); }
.settings-consequences, .settings-warnings, .settings-changelog { margin: 0; padding-left: var(--sp-5); color: var(--c-text-muted); font-size: var(--fs-sm); }
.settings-consequences li, .settings-warnings li, .settings-changelog li { margin-bottom: var(--sp-1); }
.settings-savebar { position: sticky; bottom: 0; z-index: var(--z-sticky); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: var(--sp-2) var(--sp-3); background: var(--c-bg-elev); border: 1px solid var(--c-border-strong); border-radius: var(--r-lg); box-shadow: var(--sh-2); }
.settings-savebar__status { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; min-width: 0; }
.settings-savebar__actions { display: flex; gap: var(--sp-2); margin-left: auto; flex-wrap: wrap; }
.settings-result { display: flex; flex-direction: column; gap: var(--sp-2); }
.settings-result__list { margin: 0; padding-left: var(--sp-5); font-size: var(--fs-sm); color: var(--c-text-muted); }
.settings-quick { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.settings-quick__label { min-width: 120px; color: var(--c-text-muted); font-size: var(--fs-sm); }
.settings-credential-facts { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); }
@media (max-width: 900px) { .settings-tier { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .settings-view * { animation-duration: 0s !important; transition-duration: 0s !important; } }
`;

function ensureStyles() {
  try {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.setAttribute('id', STYLE_ID);
    style.textContent = VIEW_STYLES;
    document.head.appendChild(style);
  } catch {
    /* 样式注入失败不应阻断视图 */
  }
}

function removeStyles() {
  try {
    if (typeof document === 'undefined') return;
    const node = document.getElementById(STYLE_ID);
    if (node) node.remove();
  } catch {
    /* ignore */
  }
}

function paramGroup(ctx) {
  const params = ctx && ctx.params;
  if (!params) return null;
  try {
    if (typeof params.get === 'function') {
      const value = params.get('group');
      if (typeof value === 'string') return value;
    }
  } catch {
    /* ignore */
  }
  if (typeof params === 'object' && typeof params.group === 'string') return params.group;
  return null;
}

function hashGroup() {
  try {
    const hash = String(location.hash || '');
    const match = /[?&]group=([^&]+)/.exec(hash);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * 视图入口。
 * @param {HTMLElement} root 挂载点（B2 的 #view-root 中的容器）
 * @param {object} ctx 视图上下文
 * @returns {Promise<{destroy: Function}>}
 */
export async function mount(root, ctx) {
  if (!root || typeof root.replaceChildren !== 'function') {
    throw new Error('settings.mount: root element is required');
  }
  ensureStyles();
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {};
  const api = safeCtx.api && typeof safeCtx.api === 'object' ? safeCtx.api : {};
  const t = createTranslator(safeCtx);

  const state = {
    phase: 'loading',
    schema: null,
    server: null,
    draft: null,
    activeGroup: 'models',
    locale: currentLocale(safeCtx),
    saving: false,
    dirty: false,
    clientErrors: { ok: true, errors: [] },
    saveError: null,
    lastResult: null,
    preview: false,
    loadError: null,
    /** daemon 是否处于"请求根本没到"的状态（决定顶部横幅与每组占位）。 */
    offline: false,
    offlineInfo: null,
    /** 会话中途 daemon 掉线（保存/测试失败时置位），与首屏 load 失败分开记。 */
    daemonDown: null,
    registry: new Map(),
    modelState: createModelState(),
    discardConfirmed: new Set(),
    destroyed: false,
    pendingBody: false,
    modals: new Set(),
  };

  const view = el('div', { class: 'settings-view' });
  root.replaceChildren(view);

  const hosts = {};
  let unsubscribe = null;

  const isGone = () => state.destroyed === true;

  function trackModal(overlay) {
    if (overlay && typeof overlay.close === 'function') state.modals.add(overlay);
    return overlay;
  }

  function closeModals() {
    for (const overlay of state.modals) {
      try {
        if (overlay && typeof overlay.close === 'function') overlay.close('api');
      } catch {
        /* ignore */
      }
    }
    state.modals.clear();
  }

  function confirmDialog(spec) {
    if (isGone()) return null;
    const overlay = confirmDestructive(safeCtx, Object.assign({ t }, spec));
    return trackModal(overlay);
  }

  /* ------------------------------------------------------------------ 状态渲染 */

  function render() {
    if (isGone()) return;
    state.registry.clear();
    if (state.phase === 'loading') {
      view.replaceChildren(loadingNode());
      return;
    }
    if (state.phase === 'error') {
      renderOffline();
      return;
    }
    const groupIds = groupIdsOf(state.schema);
    if (!groupIds.includes(state.activeGroup)) state.activeGroup = groupIds[0] || 'models';

    hosts.header = renderHeader();
    hosts.body = el('div', { class: 'settings-body', id: 'settings-body' });
    hosts.tabs = renderTabs();
    hosts.result = el('div', { class: 'settings-result', id: 'settings-result' });
    hosts.saveBar = el('div', { class: 'settings-savebar', id: 'settings-savebar' });

    view.replaceChildren(
      hosts.header,
      el('div', { class: 'settings-tabs', id: 'settings-tabs' }, [hosts.tabs]),
      hosts.result,
      hosts.body,
      hosts.saveBar,
    );
    renderBody();
    renderResult();
    renderSaveBar();
  }

  function loadingNode() {
    return el(
      'div',
      { class: 'settings-body', 'aria-busy': 'true', 'aria-label': t('settings.loading', 'Loading settings…') },
      [skeleton({ lines: 8, height: 16 })],
    );
  }

  /**
   * 首屏加载失败视图：**不是**一句"加载失败"了事。
   * - 顶部横幅：错误码 + 原因 + 重试（daemon 不在时写明是"连不上"而不是"配置错"）；
   * - 仍然渲染 8 个组标签：每组点进去都是显式"不可用：需要 daemon"占位；
   * - `ui` 组例外：主题/密度/语言/起始页由外壳消费，无 daemon 也能改并即时生效。
   */
  function renderOffline() {
    const info = state.offlineInfo || state.loadError || { code: 'UNREACHABLE', message: '' };
    const down = state.offline === true;
    const requested = paramGroup(safeCtx) || hashGroup();
    if (requested && FALLBACK_GROUPS.includes(String(requested))) {
      state.activeGroup = String(requested);
    } else if (!FALLBACK_GROUPS.includes(state.activeGroup)) {
      // 无 daemon 时只有界面组是真正可操作的：默认落在这里，同时每个标签都写明自己不可用。
      state.activeGroup = 'ui';
    }

    const offlineBanner = banner(
      'danger',
      down
        ? t('settings.offline.title', 'The local daemon is not running')
        : t('settings.error.schema-title', 'Could not load the settings schema'),
      errorText(t, info.code, info.message || 'GET /api/v1/settings/schema failed'),
      [
        button({
          label: t('settings.error.retry', 'Retry'),
          icon: 'refresh',
          size: 'sm',
          onClick: () => {
            load();
          },
        }),
        el('span', { class: 'faint mono', text: String(info.code || 'UNREACHABLE') }),
      ],
    );
    offlineBanner.setAttribute('data-role', 'offline-banner');
    offlineBanner.setAttribute('data-state', down ? 'daemon-down' : 'load-failed');
    offlineBanner.setAttribute('data-code', String(info.code || 'UNREACHABLE'));

    const head = el('div', { class: 'stack' }, [
      el('div', { class: 'settings-header' }, [
        el('div', { class: 'settings-header__text' }, [
          el('h1', { class: 'settings-header__title', text: t('settings.title', 'Settings') }),
          el('p', {
            class: 'settings-header__sub',
            text: down
              ? t('settings.offline.body', 'The local daemon is not reachable. Only interface preferences can be changed right now.')
              : t('settings.error.schema-title', 'Could not load the settings schema'),
          }),
        ]),
        el('div', { class: 'settings-header__meta' }, [
          badge({ tone: 'danger', text: t('app.conn.offline', 'Offline') }),
        ]),
      ]),
      offlineBanner,
    ]);

    hosts.header = head;
    hosts.tabs = tabs({
      items: FALLBACK_GROUPS.map((groupId) => ({
        id: groupId,
        label: t('settings.group.' + groupId, humanize(groupId)),
        badge: groupId === 'ui' ? 'i' : null,
      })),
      active: state.activeGroup,
      ariaLabel: t('settings.groups-aria', 'Settings groups'),
      onChange: (groupId) => {
        if (isGone()) return;
        state.activeGroup = String(groupId);
        renderOffline();
      },
    });
    hosts.body = el('div', { class: 'settings-body', id: 'settings-body' });
    hosts.result = el('div', { class: 'settings-result', id: 'settings-result' });
    hosts.saveBar = el('div', { class: 'settings-savebar', id: 'settings-savebar' });

    view.replaceChildren(
      hosts.header,
      el('div', { class: 'settings-tabs', id: 'settings-tabs' }, [hosts.tabs]),
      hosts.result,
      hosts.body,
    );

    state.registry.clear();
    if (state.activeGroup === 'ui') {
      // 界面组：控件来自共享层的本地描述（与 daemon schema 的 ui 组同构），不是假数据。
      hosts.body.replaceChildren(renderUi(makeEnv({ id: 'ui', appliesAt: 'immediate', items: [] })));
    } else {
      hosts.body.replaceChildren(groupUnavailable(makeEnv(currentGroupDescriptor()), state.activeGroup, info));
    }
  }

  function renderHeader() {
    const groupCount = groupIdsOf(state.schema).length;
    const updatedAt = state.server && state.server.updatedAt ? String(state.server.updatedAt) : null;
    const down = state.daemonDown;
    hosts.headerBanner = el('div', { class: 'stack' }, headerBanners());
    return el('div', { class: 'stack' }, [
      el('div', { class: 'settings-header' }, [
        el('div', { class: 'settings-header__text' }, [
          el('h1', { class: 'settings-header__title', text: t('settings.title', 'Settings') }),
          el('p', { class: 'settings-header__sub', text: t('settings.subtitle', 'Settings are stored locally on this machine. Nothing is sent anywhere.') }),
        ]),
        el('div', { class: 'settings-header__meta' }, [
          down
            ? badge({ tone: 'danger', text: t('app.conn.offline', 'Offline') })
            : badge({ tone: 'info', text: String(groupCount) + ' ' + t('settings.groups', 'groups') }),
          updatedAt
            ? el('span', { class: 'faint', text: t('settings.updated-at', 'Updated: {at}', { at: updatedAt }) })
            : null,
        ]),
      ]),
      hosts.headerBanner,
    ]);
  }

  /** 顶部横幅（daemon 掉线 / 设置文件警告）。可原地刷新，不必整页重渲染。 */
  function headerBanners() {
    const warnings = asArray(state.server && state.server.warnings);
    const down = state.daemonDown;
    const nodes = [];
    // 会话中途掉线：草稿与已渲染内容保留，但顶部必须说清"现在存不进去"。
    if (down) {
      nodes.push(
        banner(
          'danger',
          t('settings.offline.title', 'The local daemon is not running'),
          errorText(t, down.code, down.message || ''),
          [
            button({
              label: t('settings.error.retry', 'Retry'),
              icon: 'refresh',
              size: 'sm',
              onClick: () => {
                load();
              },
            }),
            el('span', { class: 'faint', text: t('settings.offline.draft-kept', 'Your unsaved edits are kept; nothing was written.') }),
          ],
        ),
      );
    }
    if (warnings.length) {
      nodes.push(
        banner(
          'warn',
          t('settings.warn.file-title', 'Settings file warning'),
          warnings
            .map((warning) =>
              String(warning).startsWith('SETTINGS_CORRUPT:')
                ? t('settings.warn.corrupt', FALLBACK_CORRUPT, { detail: String(warning).slice('SETTINGS_CORRUPT:'.length) })
                : String(warning),
            )
            .join(' · '),
        ),
      );
    }
    return nodes;
  }

  function refreshHeaderBanners() {
    if (isGone() || !hosts.headerBanner || typeof hosts.headerBanner.replaceChildren !== 'function') return;
    try {
      hosts.headerBanner.replaceChildren(...headerBanners());
    } catch {
      /* ignore */
    }
  }

  const FALLBACK_CORRUPT =
    'The settings file was unreadable and defaults were loaded. The file was not overwritten.';

  function renderTabs() {
    const groups = asArray(state.schema && state.schema.groups);
    return tabs({
      items: groups.map((group) => ({
        id: String(group.id),
        label: t('settings.group.' + group.id, humanize(group.id)),
        badge: group.dangerous === true ? '!' : null,
      })),
      active: state.activeGroup,
      ariaLabel: t('settings.groups-aria', 'Settings groups'),
      onChange: (groupId) => {
        if (isGone()) return;
        state.activeGroup = String(groupId);
        try {
          if (typeof safeCtx.navigate === 'function') safeCtx.navigate('#/settings?group=' + encodeURIComponent(groupId));
        } catch {
          /* navigate 不可用时只切本地状态（不阻断） */
        }
        renderBody();
      },
    });
  }

  function currentGroupDescriptor() {
    const groups = asArray(state.schema && state.schema.groups);
    return groups.find((group) => String(group.id) === state.activeGroup) || groups[0] || null;
  }

  function groupIdsOf(schema) {
    return asArray(schema && schema.groups).map((group) => String(group.id));
  }

  function makeEnv(group) {
    return {
      t,
      ctx: safeCtx,
      api,
      schema: state.schema,
      group,
      draft: state.draft,
      server: state.server,
      registry: state.registry,
      modelState: state.modelState,
      locale: state.locale,
      /** daemon 不可用（首屏失败）——组模块据此渲染显式占位或本地链路。 */
      offline: state.offline === true || state.daemonDown !== null,
      offlineInfo: state.offlineInfo || state.loadError || state.daemonDown || null,
      onRetryLoad: () => {
        load();
      },
      onChange: onDraftChange,
      rerender: () => {
        if (isGone()) return;
        renderBody();
        renderSaveBar();
      },
      notify: (kind, text, options) => notify(safeCtx, kind, text, options),
      noteCredentialDiscard: (providerId) => state.discardConfirmed.add(String(providerId)),
      confirm: confirmDialog,
    };
  }

  function renderBody() {
    if (isGone() || !hosts.body) return;
    const group = currentGroupDescriptor();
    if (!group) {
      hosts.body.replaceChildren(
        empty({
          title: t('settings.error.no-groups', 'The schema describes no groups'),
          body: t('settings.error.no-groups-body', 'Nothing can be rendered from an empty schema. Refusing to guess fields.'),
        }),
      );
      return;
    }
    state.registry.clear();
    const renderer = GROUP_RENDERERS[group.id];
    let bodyNode;
    try {
      if (typeof renderer !== 'function') {
        bodyNode = empty({
          title: t('settings.error.group-missing', 'This settings group has no renderer'),
          body: t('settings.error.group-missing-body', 'Group “{id}” is described by the schema but not implemented in this build.', {
            id: String(group.id),
          }),
        });
      } else {
        bodyNode = renderer(makeEnv(group));
      }
    } catch (caught) {
      const info = apiErrorInfo(caught);
      bodyNode = empty({
        title: t('settings.error.render', 'This settings group failed to render'),
        body: info.message || String(caught),
        actionLabel: t('settings.error.retry', 'Retry'),
        onAction: () => renderBody(),
      });
    }
    hosts.body.replaceChildren(bodyNode);
    updateClientErrors();
    renderSaveBar();
  }

  /* ------------------------------------------------------------------ 变更 */

  function onDraftChange(path) {
    if (isGone()) return;
    // 界面组：改一下就**立刻**落到外壳（不刷新、不等保存）。外壳消费 theme/density/locale；
    // startView 写了 aidn.ui 但 0.0.1 外壳不读，ui.js 会如实标注"未接线"。
    if (LOCAL_UI_PATHS.includes(String(path))) applyUiLive(path);
    const changes = changedItems(state.schema, state.server.settings, state.draft);
    state.dirty = changes.length > 0;
    updateClientErrors();
    renderSaveBar();
    const structural = STRUCTURAL_PATHS.has(String(path));
    if (structural) {
      if (state.pendingBody) return;
      state.pendingBody = true;
      Promise.resolve().then(() => {
        state.pendingBody = false;
        if (isGone()) return;
        renderBody();
        renderSaveBar();
      });
    }
  }

  /**
   * 把 draft 里的界面偏好立刻应用到外壳，并写 aidn.ui。
   * 保存失败/取消也不会让"已经看到的主题/密度/语言"回退——因为它们是本地偏好，
   * 与 settings.json 是两条链路（REPORT 里写明这条边界）。
   */
  function applyUiLive(path) {
    const key = String(path).slice('ui.'.length);
    const value = state.draft && state.draft.ui ? state.draft.ui[key] : undefined;
    if (typeof value !== 'string' || value === '') return;
    try {
      const result = applyLocalUiPrefs(safeCtx, { [key]: value });
      state.uiApply = result;
      if (result.skipped.length > 0) {
        // 不静默：明确告诉用户这一项本地没生效，以及为什么。
        notify(
          safeCtx,
          'warn',
          t('settings.ui.not-applied', 'Applied locally: {applied} · not applied: {skipped}', {
            applied: result.applied.join(', ') || '—',
            skipped: result.skipped.map((entry) => entry.key + ' (' + entry.reason + ')').join(', ') || '—',
          }),
        );
      }
    } catch {
      /* 外壳不可用时不影响设置页本身 */
    }
  }

  function updateClientErrors() {
    if (!state.schema || !state.draft) {
      state.clientErrors = { ok: true, errors: [] };
      return;
    }
    state.clientErrors = validateDraft(state.schema, state.draft);
  }

  /* ------------------------------------------------------------------ 保存栏 */

  function clearFieldErrors() {
    for (const entry of state.registry.values()) {
      if (entry && typeof entry.setError === 'function') entry.setError(null);
    }
  }

  function renderSaveBar() {
    if (isGone() || !hosts.saveBar) return;
    const errors = state.clientErrors && !state.clientErrors.ok ? state.clientErrors.errors : [];
    const dirtyCount = state.dirty ? changedItems(state.schema, state.server.settings, state.draft).length : 0;
    const status = [];

    if (state.saveError) {
      status.push(badge({ tone: 'danger', text: state.saveError.code || 'ERROR' }));
    }
    status.push(
      badge({
        tone: state.dirty ? 'warn' : 'neutral',
        text: state.dirty
          ? t('settings.unsaved', 'Unsaved changes: {count}', { count: String(dirtyCount) })
          : t('settings.no-changes', 'No unsaved changes'),
      }),
    );
    if (errors.length > 0) {
      status.push(badge({ tone: 'danger', text: String(errors.length) + ' ' + t('settings.invalid-fields', 'invalid field(s)') }));
      status.push(
        el('span', { class: 'faint mono', text: String(errors[0].path) + ' · ' + ruleText(t, errors[0].rule) }),
      );
    }

    const saveDisabled = state.saving || !state.dirty || errors.length > 0;
    const actions = [
      button({
        label: t('settings.reset', 'Reset changes'),
        variant: 'ghost',
        size: 'sm',
        disabled: state.saving || !state.dirty,
        onClick: resetDraft,
      }),
      button({
        label: t('settings.preview', 'Preview'),
        variant: 'secondary',
        size: 'sm',
        disabled: state.saving || errors.length > 0,
        onClick: () => save({ dryRun: true, skipDanger: true }),
      }),
      button({
        label: state.saving ? t('settings.saving', 'Saving…') : t('settings.save', 'Save'),
        variant: 'primary',
        size: 'sm',
        busy: state.saving,
        disabled: saveDisabled,
        onClick: () => save({ dryRun: false }),
      }),
    ];

    hosts.saveBar.replaceChildren(
      el('div', { class: 'settings-savebar__status' }, status),
      el('div', { class: 'settings-savebar__actions' }, actions),
    );
  }

  function resetDraft() {
    if (isGone()) return;
    const apply = () => {
      state.draft = cloneJson(state.server.settings);
      state.discardConfirmed.clear();
      state.saveError = null;
      state.lastResult = null;
      state.preview = false;
      state.dirty = false;
      clearFieldErrors();
      updateClientErrors();
      // 重置后把界面偏好**拉回已保存值**，否则"改了主题又点放弃"会留下看不见的漂移。
      if (state.draft && state.draft.ui) {
        applyLocalUiPrefs(safeCtx, {
          theme: String(state.draft.ui.theme || 'system'),
          density: String(state.draft.ui.density || 'comfortable'),
          locale: String(state.draft.ui.locale || state.locale || 'zh-CN'),
        });
      }
      renderBody();
      renderSaveBar();
      renderResult();
    };
    if (!state.dirty) {
      apply();
      return;
    }
    confirmDialog({
      title: t('settings.confirm.reset-title', 'Discard unsaved changes?'),
      body: t('settings.confirm.reset-body', 'Every edit you have not saved will be lost.'),
      consequences: [t('settings.confirm.reset-consequence', 'The form reloads from the saved settings file.')],
      confirmLabel: t('settings.confirm.discard', 'Discard and reload'),
      onConfirm: apply,
    });
  }

  /* ------------------------------------------------------------------ 保存 */

  async function save(options) {
    if (isGone() || state.saving) return;
    const opts = options || {};
    const dryRun = opts.dryRun === true;

    updateClientErrors();
    if (!state.clientErrors.ok) {
      const first = state.clientErrors.errors[0];
      notify(safeCtx, 'warn', t('settings.error.client-validation', 'Fix the highlighted fields first ({path}: {rule}).', {
        path: String(first.path),
        rule: ruleText(t, first.rule),
      }));
      renderSaveBar();
      return;
    }

    if (!dryRun && !opts.skipDanger) {
      const dangers = dangerousChanges(state.schema, state.server.settings, state.draft);
      if (dangers.length > 0) {
        // 确认后重入 save() 必须带 skipDanger，否则同一个确认框会再次弹出（死循环）。
        confirmDangerous(dangers, () =>
          save({
            dryRun: false,
            skipDanger: true,
            discardCredential: dangers.some((danger) => danger.kind === 'provider_removed'),
          }),
        );
        return;
      }
    }

    const payload = payloadForSave(state.schema, state.draft);
    const discardCredential = opts.discardCredential === true;
    state.saving = true;
    state.saveError = null;
    state.preview = dryRun;
    renderSaveBar();

    try {
      if (typeof api.putSettings !== 'function') throw new Error('api.putSettings is not available');
      // discardCredential 是合同 §2.8 的风险操作声明；§7.3 的签名未列出，B2 需透传（见状态文件 Blockers）。
      const result = await api.putSettings(payload, { dryRun, discardCredential });
      if (isGone()) return;
      state.saving = false;
      state.lastResult = result && typeof result === 'object' ? result : null;
      if (!dryRun) {
        const nextSettings = state.lastResult && state.lastResult.settings ? state.lastResult.settings : payload;
        state.server = Object.assign({}, state.server, {
          settings: cloneJson(nextSettings),
          updatedAt: (state.lastResult && state.lastResult.updatedAt) || state.server.updatedAt,
        });
        state.draft = cloneJson(nextSettings);
        state.dirty = false;
        state.saveError = null;
        state.daemonDown = null;
        clearFieldErrors();
        // 保存后运行态可能变化（egress/enabled/凭据），下次渲染重新取 /models
        state.modelState.projection = null;
        state.modelState.loading = false;
        state.discardConfirmed.clear();
        updateClientErrors();
        notify(safeCtx, 'ok', t('settings.saved', 'Settings saved'));
        renderBody();
      } else {
        notify(safeCtx, 'info', t('settings.saved-dry-run', 'Preview only — nothing was written'));
      }
      renderSaveBar();
      renderResult();
    } catch (caught) {
      if (isGone()) return;
      state.saving = false;
      handleSaveError(caught);
    }
  }

  function handleSaveError(caught) {
    const info = apiErrorInfo(caught);
    state.saveError = info;
    const verdict = daemonUnavailable(info);
    if (verdict.down) {
      // 保存时 daemon 掉线：草稿保留、顶部出横幅、重试可用；绝不当成"已保存"。
      state.daemonDown = Object.assign({}, info, { code: verdict.code });
      refreshHeaderBanners();
    }
    const details = info.details || {};
    if (info.code === 'SETTINGS_INVALID' && details.path) {
      clearFieldErrors();
      const message = ruleText(t, details.rule);
      const applied = applyFieldError(state.registry, String(details.path), message);
      if (applied) {
        const entry = state.registry.get(String(details.path));
        const target = entry ? firstFocusable(entry.wrapper) : null;
        if (target && typeof target.focus === 'function') target.focus();
      }
      notify(safeCtx, 'danger', t('settings.error.field-path', 'Field rejected: {path} ({rule})', {
        path: String(details.path),
        rule: message,
      }));
    } else if (info.code === 'SETTINGS_LOCKED') {
      const ids = asArray(details.providers).length
        ? asArray(details.providers).map((id) => String(id))
        : [String(details.providerId || '')].filter(Boolean);
      confirmDiscardCredential(ids);
    } else if (info.code === 'PROVIDER_LIMIT') {
      notify(safeCtx, 'danger', errorText(t, info.code, info.message));
    } else {
      notify(safeCtx, 'danger', errorText(t, info.code, info.message));
    }
    renderSaveBar();
    renderResult();
  }

  function confirmDangerous(dangers, onConfirm) {
    const consequences = dangerConsequences(t, dangers);
    confirmDialog({
      title: t('settings.confirm.danger-title', 'This change has consequences'),
      body: t(
        'settings.confirm.danger-body',
        'Review what will happen. The daemon applies safe defaults; nothing is executed in 0.0.1.',
      ),
      consequences,
      confirmLabel: t('settings.confirm.apply', 'Apply'),
      onConfirm,
    });
  }

  function confirmDiscardCredential(ids) {
    confirmDialog({
      title: t('settings.locked.title', 'A removed provider still holds an API key'),
      body: t(
        'settings.locked.body',
        'The settings were not saved. Removing a provider that still holds a key requires an explicit discardCredential declaration.',
      ),
      consequences: ids.map((id) =>
        t('settings.locked.provider', 'The stored key for “{id}” will be deleted and cannot be recovered.', { id }),
      ),
      confirmLabel: t('settings.locked.confirm', 'Delete key and save'),
      onConfirm: () => save({ dryRun: false, discardCredential: true, skipDanger: true }),
    });
  }

  /* ------------------------------------------------------------------ 结果 */

  function renderResult() {
    if (isGone() || !hosts.result) return;
    const children = [];
    if (state.saveError && !state.saveErrorFieldOnly) {
      const info = state.saveError;      children.push(
        banner(
          'danger',
          t('settings.error.save-title', 'Could not save settings') + (info.code ? ' (' + info.code + ')' : ''),
          errorText(t, info.code, info.message),
          info.retryAfter != null
            ? [el('span', { class: 'faint', text: t('settings.error.retry-after', 'Retry after {s}s', { s: String(info.retryAfter) }) })]
            : null,
        ),
      );
    }
    const result = state.lastResult;
    if (result && typeof result === 'object') {
      const applied = asArray(result.appliedNow);
      const restart = asArray(result.restartRequired);
      const warnings = asArray(result.warnings);
      children.push(
        el('div', { class: 'settings-result' }, [
          el('div', { class: 'settings-badges' }, [
            badge({
              tone: state.preview ? 'info' : 'ok',
              text: state.preview
                ? t('settings.result.preview', 'Preview (dry run) — nothing written')
                : t('settings.result.saved', 'Saved'),
            }),
            badge({ tone: 'info', text: t('settings.applied-now', 'Applied now') + ': ' + String(applied.length) }),
            restart.length
              ? badge({ tone: 'warn', text: t('settings.restart-required', 'Requires restart') + ': ' + String(restart.length) })
              : null,
            warnings.length ? badge({ tone: 'warn', text: t('settings.warnings', 'Warnings') + ': ' + String(warnings.length) }) : null,
          ]),
          applied.length
            ? el('ul', { class: 'settings-result__list' }, applied.map((path) => el('li', { class: 'mono', text: String(path) })))
            : null,
          restart.length
            ? el('div', { class: 'stack' }, [
                el('span', { class: 'faint', text: t('settings.restart-required', 'Requires restart') }),
                el('ul', { class: 'settings-result__list' }, restart.map((path) => el('li', { class: 'mono', text: String(path) }))),
              ])
            : null,
          warnings.length
            ? el('ul', { class: 'settings-result__list' }, warnings.map((warning) => el('li', { class: 'mono', text: String(warning) })))
            : null,
        ]),
      );
    }
    hosts.result.replaceChildren(...children);
  }

  /* ------------------------------------------------------------------ 加载 */

  async function load() {
    if (isGone()) return;
    state.phase = 'loading';
    state.loadError = null;
    render();
    try {
      if (typeof api.getSettingsSchema !== 'function' || typeof api.getSettings !== 'function') {
        throw Object.assign(new Error('api.getSettingsSchema / api.getSettings are not available'), { code: 'API_MISSING' });
      }
      const [schema, snapshot] = await Promise.all([api.getSettingsSchema(), api.getSettings()]);
      if (isGone()) return;
      if (!schema || !Array.isArray(schema.groups) || schema.groups.length === 0) {
        throw Object.assign(new Error('settings schema has no groups'), { code: 'SCHEMA_INVALID' });
      }
      if (!snapshot || typeof snapshot !== 'object' || snapshot.settings === null || typeof snapshot.settings !== 'object') {
        throw Object.assign(new Error('GET /api/v1/settings returned no settings object'), { code: 'SETTINGS_MISSING' });
      }
      state.schema = schema;
      // GET 可能只回部分文档（真栈实测缺 response.*/update.* 共 9 个叶子）；
      // 按 schema 默认值补齐，与服务端 PUT"部分文档合并到默认值"的语义一致。
      const merged = mergeSchemaDefaults(schema, snapshot.settings);
      state.server = Object.assign({}, snapshot, { settings: merged });
      state.draft = cloneJson(merged);
      state.activeGroup = resolveActiveGroup(schema);
      state.phase = 'ready';
      state.dirty = false;
      state.saveError = null;
      state.lastResult = null;
      state.preview = false;
      state.offline = false;
      state.offlineInfo = null;
      state.daemonDown = null;
      updateClientErrors();
      render();
    } catch (caught) {
      if (isGone()) return;
      const info = apiErrorInfo(caught);
      state.loadError = info;
      const verdict = daemonUnavailable(info);
      state.offline = verdict.down;
      state.offlineInfo = verdict.down ? Object.assign({}, info, { code: verdict.code }) : info;
      state.phase = 'error';
      render();
    }
  }

  function resolveActiveGroup(schema) {
    const ids = asArray(schema && schema.groups).map((group) => String(group.id));
    const requested = paramGroup(safeCtx) || hashGroup();
    if (requested && ids.includes(String(requested))) return String(requested);
    try {
      if (/^#\/models(?:[?/]|$)/.test(String(location.hash || ''))) return 'models';
    } catch {
      /* ignore */
    }
    return ids.includes('models') ? 'models' : ids[0] || 'models';
  }

  /* ------------------------------------------------------------------ 订阅 */

  function subscribeStore() {
    const store = safeCtx.store;
    if (!store || typeof store.subscribe !== 'function') return;
    try {
      const result = store.subscribe(() => {
        if (isGone()) return;
        const nextLocale = currentLocale(safeCtx);
        if (nextLocale !== state.locale) {
          state.locale = nextLocale;
          render();
        }
      });
      if (typeof result === 'function') unsubscribe = result;
    } catch {
      /* store 形状不一致时不影响视图 */
    }
  }

  /* ------------------------------------------------------------------ 生命周期 */

  subscribeStore();
  await load();

  return {
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      closeModals();
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch {
        /* ignore */
      }
      unsubscribe = null;
      try {
        root.replaceChildren();
      } catch {
        /* ignore */
      }
      removeStyles();
    },
  };
}

/** 供 stubs / B11 复用：从任意 schema 取组 id（不实例化视图）。 */
export function listGroups(schema) {
  return asArray(schema && schema.groups).map((group) => String(group.id));
}
