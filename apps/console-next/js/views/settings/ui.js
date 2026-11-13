/**
 * B7 · 设置组 `ui`（界面）——字段来自 GET /settings/schema，**无 daemon 也可用**
 * 作者：PT-dove
 *
 * 两条链路，故意分开：
 * 1. **本地链路（外壳）**：theme / density / locale / startView 由 app.js 消费，
 *    改一下立刻生效并写 `aidn.ui`（store.js 白名单键），不需要 daemon、不需要保存。
 *    无 daemon 时这是唯一还能真正工作的设置组 → 本模块必须自给自足地渲染它。
 * 2. **daemon 链路**：trayBehavior / autostart 需要 daemon（0.0.1 未接线，如实标注）；
 *    上面四项写进 settings.json 也走常规保存流程。
 *
 * 无 schema 时用 `localUiItems()` 的描述（与 daemon schema 的 ui 组同构），不是编出来的
 * 假字段：能改的只有外壳真正消费的四个键，其余（托盘/自启）明确写"需要 daemon"。
 */
import { el } from '../../components/ui/dom.js';
import { badge } from '../../components/ui/badge.js';
import { segmented } from '../../components/ui/segmented.js';
import {
  applyLocalUiPrefs,
  banner,
  getPath,
  groupItems,
  localUiItems,
  readLocalUiPrefs,
  renderItems,
  section,
  setPath,
} from './shared.js';

export const id = 'ui';

/** 外壳真正消费的四个键（与 index.js 的 LOCAL_UI_PATHS 一致）。 */
const LOCAL_KEYS = Object.freeze(['theme', 'density', 'locale', 'startView']);

const DENSITY_OPTIONS = Object.freeze([
  { value: 'compact', labelKey: 'settings.enum.ui.density.compact', fallback: 'Compact' },
  { value: 'comfortable', labelKey: 'settings.enum.ui.density.comfortable', fallback: 'Comfortable' },
]);

const THEME_OPTIONS = Object.freeze([
  { value: 'system', labelKey: 'settings.enum.ui.theme.system', fallback: 'System' },
  { value: 'dark', labelKey: 'settings.enum.ui.theme.dark', fallback: 'Dark' },
  { value: 'light', labelKey: 'settings.enum.ui.theme.light', fallback: 'Light' },
]);

const START_VIEW_OPTIONS = Object.freeze(['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']);

export function render(env) {
  const { t } = env;
  const offline = env.offline === true || !env.schema;
  const items = offline ? localUiItems() : groupItems(env.schema, id);
  // 无 daemon 时展示本地已生效值；有 daemon 时以 draft 为准（保存后回读一致）。
  const current = offline ? readLocalUiPrefs(env.ctx) : readDraftUi(env);

  return el('div', { class: 'stack' }, [
    offline
      ? banner(
          'warn',
          t('settings.offline.local-ok', 'Applies locally without the daemon (stored in aidn.ui).'),
          t(
            'settings.offline.local-only-note',
            'The daemon is not running, so these values are applied locally and stored in aidn.ui only. They will not reach settings.json until the daemon is reachable — this page does not pretend otherwise.',
          ),
        )
      : null,

    // ── 一键切换：主题 / 密度（最常改的两项，不藏在表单最底下） ───────────────
    section({
      id: 'settings-group-ui-quick',
      title: t('settings.ui.density.label', 'Display density'),
      note: t(
        'settings.ui.density.hint',
        'Compact or comfortable spacing. Applies immediately — no save and no daemon needed; also stored in aidn.ui.',
      ),
      body: [
        quickRow(env, t('settings.ui.theme.label', 'Theme'), segmented({
          options: THEME_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey, option.fallback) })),
          value: current.theme,
          ariaLabel: t('settings.ui.theme.label', 'Theme'),
          onChange: (value) => applyLive(env, 'theme', value),
        })),
        quickRow(env, t('settings.ui.density.label', 'Display density'), segmented({
          options: DENSITY_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey, option.fallback) })),
          value: current.density,
          ariaLabel: t('settings.ui.density.label', 'Display density'),
          onChange: (value) => applyLive(env, 'density', value),
        })),
        el('p', { class: 'faint', text: t('settings.applies-at.immediate', 'Applied immediately') + ' · aidn.ui' }),
      ],
    }),

    // ── 表单：语言 / 起始页（+ 有 daemon 时的托盘/自启） ─────────────────────
    section({
      id: 'settings-group-ui',
      title: t('settings.group.ui', 'Interface'),
      note: offline
        ? t('settings.offline.local-only-note', 'Local only: stored in aidn.ui until the daemon is reachable.')
        : t(
            'settings.ui.note',
            'Theme, density and language apply immediately. Start page and tray behaviour are stored but may only take effect after the shell restarts.',
          ),
      body: offline ? offlineForm(env, items, current) : renderItems(env, items),
    }),

    // ── 需要 daemon 的项：无 daemon 时明确说明（不渲染假控件） ────────────────
    offline
      ? section({
          title: t('settings.ui.daemon-only', 'Needs the daemon'),
          note: t(
            'settings.ui.daemon-only-note',
            'Tray behaviour and autostart live in settings.json and are not wired in 0.0.1. They stay untouched while the daemon is down.',
          ),
          body: [badge({ tone: 'neutral', text: t('settings.group.unavailable-short', 'Unavailable: needs the daemon') })],
        })
      : null,
  ]);
}

function readDraftUi(env) {
  const out = { theme: 'system', density: 'comfortable', locale: 'zh-CN', startView: 'overview' };
  for (const key of LOCAL_KEYS) {
    const value = getPath(env.draft, 'ui.' + key);
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

function quickRow(env, label, control) {
  return el('div', { class: 'settings-quick', data: { role: 'ui-quick' } }, [
    el('span', { class: 'settings-quick__label', text: label }),
    control,
  ]);
}

/** 一键切换：先落外壳（立即生效），有 daemon 时同时进 draft 等保存。 */
function applyLive(env, key, value) {
  const { t } = env;
  const result = applyLocalUiPrefs(env.ctx, { [key]: value });
  if (!env.offline && env.draft) {
    setPath(env.draft, 'ui.' + key, value);
    if (typeof env.onChange === 'function') env.onChange('ui.' + key);
  }
  if (result.skipped.length > 0) {
    env.notify(
      'warn',
      t('settings.ui.not-applied', 'Applied locally: {applied} · not applied: {skipped}', {
        applied: result.applied.join(', ') || '—',
        skipped: result.skipped.map((entry) => entry.key + ' (' + entry.reason + ')').join(', ') || '—',
      }),
    );
    return;
  }
  env.notify('ok', t('settings.ui.applied', 'Applied: {key} = {value}', { key, value }) + ' · aidn.ui');
}

/** 无 daemon 时的表单：只渲染本地链路消费的语言 / 起始页（真控件，不是假控件）。 */
function offlineForm(env, items, current) {
  const { t } = env;
  const nodes = [];
  const localeItem = items.find((item) => item.path === 'ui.locale');
  const startViewItem = items.find((item) => item.path === 'ui.startView');
  if (localeItem) {
    nodes.push(
      el('div', { class: 'stack', data: { path: 'ui.locale' } }, [
        el('span', { class: 'settings-quick__label', text: t('settings.ui.locale.label', 'Language') }),
        segmented({
          options: (localeItem.values || []).map((value) => ({
            value: String(value),
            // 复用既有 enum 文案（zh-cn 键是小写，见 contract §8.3）。
            label: t('settings.enum.ui.locale.' + String(value).toLowerCase(), String(value)),
          })),
          value: current.locale,
          ariaLabel: t('settings.ui.locale.label', 'Language'),
          onChange: (value) => applyLive(env, 'locale', value),
        }),
      ]),
    );
  }
  if (startViewItem) {
    nodes.push(
      el('div', { class: 'stack', data: { path: 'ui.startView' } }, [
        el('span', { class: 'settings-quick__label', text: t('settings.ui.start.view.label', 'Start page') }),
        segmented({
          options: START_VIEW_OPTIONS.map((value) => ({
            value,
            label: t('settings.enum.ui.start-view.' + value, t('nav.' + value, value)),
          })),
          value: current.startView,
          ariaLabel: t('settings.ui.start.view.label', 'Start page'),
          onChange: (value) => applyLive(env, 'startView', value),
        }),
        // 如实：外壳 0.0.1 不读 startView，选了会保存但不改变启动页。
        el('p', {
          class: 'faint',
          text: t('settings.ui.start-view-unwired', 'Stored in aidn.ui, but the 0.0.1 shell ignores it: the console still opens on Overview.'),
        }),
      ]),
    );
  }
  return nodes.length
    ? nodes
    : [el('p', { class: 'faint', text: t('settings.ui.daemon-only-note', 'Nothing here can run without the daemon.') })];
}
