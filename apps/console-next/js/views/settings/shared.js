/**
 * B7 · 设置页共享层（schema 驱动，零依赖）
 * 作者：PT-dove · 合同：CONSOLE-V2-CONTRACT.md §6 / §7.2 / §7.3 / §7.6 / §8
 *
 * 这一层只做四件事，8 个组模块与 index.js 都复用它：
 * 1. i18n 适配：ctx.i18n 的形状由 B2 决定，这里做完全防御式适配（函数 / .t / .translate /
 *    映射对象），缺失 key 一律回落到英文兜底并保持 en 界面无 CJK（B10 后续补 locales）。
 * 2. 路径读写：同时支持 `models.providers[0].baseUrl` 与 `ui.theme` 两种写法
 *    （服务端 SETTINGS_INVALID 的 details.path 就是前者）。
 * 3. 控件工厂：**所有字段都从 schema item 描述生成**，不存在手写死字段表；
 *    object[] 用 item.fields 生成子字段编辑器（providers 的密钥/连通性由 models.js 叠加）。
 * 4. 校验与危险判定：客户端镜像服务端 §6 规则（含 ADR-0010 §2.2 URL 规则），
 *    让"未选 uniform 主模型不许保存"这类错误在点保存前就可见。
 *
 * DOM 纪律：只用 el()/组件构造，零 innerHTML；行内样式只用 CSS 变量（组件层限制）。
 */
import { el, icon, cls } from '../../components/ui/dom.js';
import { button } from '../../components/ui/button.js';
import { badge } from '../../components/ui/badge.js';
import { input, checkbox } from '../../components/ui/field.js';
import { select } from '../../components/ui/select.js';
import { toggle } from '../../components/ui/toggle.js';
import { modal } from '../../components/ui/modal.js';
import { toastHost } from '../../components/ui/toast.js';
// 只读复用外壳能力（本模块不改 store.js / i18n.js / util.js，只调用它们的公开导出）。
import { LOCALES } from '../../i18n.js';
import { readUi, writeUi } from '../../store.js';
import { resolveTheme } from '../../util.js';

/* ==========================================================================
 * 1. i18n
 * ========================================================================== */

/**
 * 英文兜底文案（B10 补 locales 前的可用文本）。
 * 只放"页面骨架/行为"文案；**字段名不在这里**——字段标签一律来自 schema 的 labelKey。
 */
export const FALLBACK = Object.freeze({
  'settings.title': 'Settings',
  'settings.subtitle': 'Settings are stored locally on this machine. Nothing is sent anywhere.',
  'settings.loading': 'Loading settings…',
  'settings.error.schema-title': 'Could not load the settings schema',
  'settings.error.retry': 'Retry',
  'settings.error.save-title': 'Could not save settings',
  'settings.error.field-invalid': 'Invalid value',
  'settings.error.unknown-rule': 'violates a schema rule',
  'settings.saved': 'Settings saved',
  'settings.saved-dry-run': 'Preview only — nothing was written',
  'settings.saving': 'Saving…',
  'settings.save': 'Save',
  'settings.preview': 'Preview',
  'settings.reset': 'Reset changes',
  'settings.unsaved': 'Unsaved changes: {count}',
  'settings.no-changes': 'No unsaved changes',
  'settings.default': 'Default: {value}',
  'settings.read-only': 'Read-only',
  'settings.dangerous': 'Dangerous',
  'settings.not-wired': 'Saved, not in effect (0.0.1 not wired)',
  'settings.applies-at.immediate': 'Applies immediately',
  'settings.applies-at.next-collection': 'Applies on next collection',
  'settings.applies-at.restart': 'Requires restart',
  'settings.applies-at.external': 'Not wired / external in 0.0.1',
  'settings.applies-at.unknown': 'Applies: {value}',
  'settings.group.models': 'Models & usage',
  'settings.group.collection': 'Collection',
  'settings.group.detection': 'Detection',
  'settings.group.response': 'Response',
  'settings.group.ui': 'Interface',
  'settings.group.update': 'Update',
  'settings.group.diagnostics': 'Diagnostics',
  'settings.group.about': 'About',
  'settings.confirm.title': 'Confirm this change',
  'settings.confirm.cancel': 'Cancel',
  'settings.confirm.apply': 'Apply',
  'settings.confirm.reset-title': 'Discard unsaved changes?',
  'settings.confirm.reset-body': 'Every edit you have not saved will be lost.',
  'settings.confirm.discard': 'Discard and reload',
  'settings.danger.egress': 'Turning egress {state} changes whether this console may reach any provider.',
  'settings.danger.egress-on': 'on',
  'settings.danger.egress-off': 'off',
  'settings.danger.provider-removed': 'Provider “{id}” will be removed.',
  'settings.danger.provider-credential-lost': 'Its stored API key is deleted too — this cannot be undone.',
  'settings.danger.uniform': 'Routing switches to a single model: every tier will use “{id}”.',
  'settings.danger.enabled-on': 'Provider “{id}” will be allowed to make outbound requests.',
  'settings.danger.wired': 'Some of these fields are not wired in 0.0.1; they will be saved but not take effect.',
  'settings.warn.corrupt': 'The settings file was unreadable and defaults were loaded ({detail}). The file was not overwritten.',
  'settings.warn.not-wired': 'Saved but not in effect: {detail}',
  'settings.applied-now': 'Applied now',
  'settings.restart-required': 'Requires restart',
  'settings.warnings': 'Warnings',
  'settings.none': 'None',
  'settings.provider.limit': 'Provider limit reached ({limit})',
  'settings.provider.add': 'Add provider',
  'settings.provider.remove': 'Remove provider',
  'settings.provider.id-locked': 'Provider id cannot change after it is saved; remove and re-add it instead.',
  'settings.provider.credential': 'API key',
  'settings.provider.credential-set': 'Key stored',
  'settings.provider.credential-missing': 'No key stored',
  'settings.provider.credential-saved': 'Key saved. Only the mask is shown from now on.',
  'settings.provider.credential-deleted': 'Key deleted.',
  'settings.provider.credential-unavailable': 'Save the provider before storing a key.',
  'settings.provider.key-hint': 'The plaintext key is sent once, then cleared; it is never written to localStorage, the DOM or logs.',
  'settings.provider.key-invalid': 'A key must be 8–512 characters on a single line.',
  'settings.provider.delete-key': 'Delete key',
  'settings.provider.save-key': 'Save key',
  'settings.provider.masked': 'Masked',
  'settings.provider.updated-at': 'Updated',
  'settings.provider.length-bucket': 'Length',
  'settings.provider.test': 'Test connection',
  'settings.provider.testing': 'Testing…',
  'settings.provider.untested': 'Never tested',
  'settings.provider.healthy': 'Reachable',
  'settings.provider.failed': 'Test failed',
  'settings.provider.test-latency': '{latency} ms · {count} models',
  'settings.provider.test-at': 'Last tested {at}',
  'settings.provider.test-hint': 'Sends one GET {path} request. Requires egress, the provider and a key.',
  'settings.provider.test-suggest': 'Suggested action: {action}',
  'settings.provider.egress-off': 'Egress is off — testing and chat are refused before any outbound request.',
  'settings.provider.egress-on': 'Egress is on (providers still need to be enabled individually).',
  'settings.usage.title': 'Usage',
  'settings.usage.unavailable': 'No usage records (reason: {reason}). A missing ledger is not “zero spend”.',
  'settings.usage.ledger': 'The ledger has no writer in 0.0.1, so no cost numbers are shown.',
  'settings.usage.by-provider': 'By provider',
  'settings.usage.by-tier': 'By tier',
  'settings.usage.cost-unknown': '— no price configured',
  'settings.tier.watch': 'watch',
  'settings.tier.triage': 'triage',
  'settings.tier.respond': 'respond',
  'settings.tier.heading': 'Tier mapping',
  'settings.tier.empty': 'No model assigned to this tier',
  'settings.tier.uniform-required': 'Choose the main model before saving in uniform mode.',
  'settings.model.add': 'Add model',
  'settings.model.remove': 'Remove model',
  'settings.model.none': 'No models registered',
  'settings.provider.none': 'No providers registered',
  'settings.action.unavailable': 'Not implemented in 0.0.1 (reason: {reason})',
  'settings.action.title': 'Action unavailable',
  'settings.action.hint': 'This button is visible on purpose, but it will not pretend to succeed.',
  'settings.action.terminal': 'This action is executed by the daemon and answers 501 in 0.0.1.',
  'settings.read-only-group': 'Read-only group (not stored in the settings file)',
  'settings.field.default': 'default',
  'settings.field.required': 'required',
  'settings.about.version': 'Version',
  'settings.about.license': 'License',
  'settings.about.privacy': 'Privacy',
  'settings.about.changelog': 'Changelog',
  'settings.about.product': 'Product',
  'settings.about.note': 'This group is injected from /status and /settings/schema; it is never written to settings.json.',
  'settings.about.privacy-value': 'Local only, no telemetry, no cloud dependency.',
  'settings.enum.yes': 'Enabled',
  'settings.enum.no': 'Disabled',
  // ── 以下为 0.0.1 UI-POLISH 新增文案（同时写入 i18n/_pending/settings.json）──
  'settings.danger.collection-off':
    'Every collection channel is being switched off: there will be no new events and no new alerts. An empty console then means “nothing is being collected”, not “nothing is happening”.',
  'settings.offline.title': 'The local daemon is not running',
  'settings.offline.body':
    'Settings live in the daemon (settings.json). Nothing in the online groups can be read or written while it is unreachable. Interface preferences (theme, density, language) still work locally.',
  'settings.offline.group-title': 'Unavailable: the local daemon is not running',
  'settings.offline.group-body':
    'Nothing in this group can be read or written until the daemon answers ({code}). No value was changed and no default was invented.',
  'settings.offline.retry': 'Retry',
  'settings.offline.local-ok': 'Applies locally without the daemon (stored in aidn.ui).',
  'settings.offline.local-only-note':
    'The daemon is not running, so these values are applied locally and stored in aidn.ui only. They will not reach settings.json until the daemon is reachable — this page does not pretend otherwise.',
  'settings.provider.fingerprint': 'Fingerprint',
  'settings.provider.strict-note':
    'The host exposes the key in strict mode: only the mask, the length bucket and the timestamp are available. The console can prove that a key of this length was stored at that time — it cannot prove which key it is.',
  'settings.provider.test-retry': 'Test again',
  'settings.provider.test-code': 'Error code',
  'settings.action.reason.not-implemented-0-0-1': 'Not implemented in 0.0.1',
  'settings.ui.density-quick': 'Display density',
  'settings.ui.density-quick-note':
    'Switch between compact and comfortable immediately — no save and no daemon needed. Also stored in aidn.ui.',
  'settings.ui.theme-quick': 'Theme',
  'settings.ui.applied-now': 'Applied immediately',
  'settings.ui.start-view-unwired':
    'Stored in aidn.ui, but the 0.0.1 shell ignores it: the console still opens on Overview.',
  'settings.group.unavailable-short': 'Unavailable: needs the daemon',
});

const MISSING_MARKER = '[missing:';

/**
 * 合同 v1.2 的 i18n key 语法：全小写 + kebab（`settings.models.egress-enabled`）。
 * camelCase / snake_case / 带索引路径统一转成合法 key 片段。
 * @param {string} value
 * @returns {string}
 */
export function toKebab(value) {
  return String(value == null ? '' : value)
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^|\.)-+/g, '$1')
    .replace(/-+(?=\.|$)/g, '');
}

/** 把 settings 文档 path（驼峰/带索引）转成 i18n key 片段。 */
export function keyPath(path) {
  return String(path == null ? '' : path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => toKebab(segment))
    .filter(Boolean)
    .join('.');
}

/**
 * 适配 ctx.i18n（形状由 B2 决定）。
 *
 * 合同 §8.5 的硬要求：回落链走完仍缺 key 时**必须渲染 `[missing:<key>]`**，
 * 禁止静默空白/静默 humanize。本适配器保留标记，并在标记后附人类可读兜底
 * （`[missing:settings.group.models] Models & usage`），方便缺语言包时仍可操作；
 * 语言包落盘后标记自然消失。
 *
 * @param {object} ctx 视图上下文 `{store, api, i18n, params, navigate, toast}`
 * @returns {(key: string, fallback?: string, params?: object) => string}
 */
export function createTranslator(ctx) {
  const source = ctx == null ? null : ctx.i18n;
  const lookup = (key) => {
    try {
      if (typeof source === 'function') return source(key);
      if (source && typeof source.t === 'function') return source.t(key);
      if (source && typeof source.translate === 'function') return source.translate(key);
      if (source && typeof source === 'object') return source[key];
    } catch {
      /* i18n 不可用不应让设置页崩掉 */
    }
    return undefined;
  };
  return function t(key, fallback, params) {
    const raw = lookup(key);
    const missing =
      typeof raw !== 'string' || raw === '' || raw.startsWith(MISSING_MARKER);
    let text;
    if (missing) {
      const human = fallback == null ? (FALLBACK[key] == null ? '' : FALLBACK[key]) : String(fallback);
      // 标记本身必须可见（§8.5）；人类可读兜底跟在后面，不抵消标记。
      text = MISSING_MARKER + key + ']' + (human === '' ? '' : ' ' + human);
    } else {
      text = raw;
    }
    if (params) {
      for (const [name, replacement] of Object.entries(params)) {
        text = text.split('{' + name + '}').join(String(replacement));
      }
    }
    return text;
  };
}

/** 取当前语言（只用于 Intl 日期/数字；形状不可用时回落 zh-CN）。 */
export function currentLocale(ctx) {
  try {
    const store = ctx == null ? null : ctx.store;
    const state = store && typeof store.getState === 'function' ? store.getState() : null;
    const candidate = (state && (state.locale || (state.i18n && state.i18n.locale))) || (ctx && ctx.i18n && ctx.i18n.locale);
    if (typeof candidate === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(candidate)) return candidate;
  } catch {
    /* ignore */
  }
  return 'zh-CN';
}

/** 时间格式化：ISO → 本地可读；非法返回 '—'。 */
export function formatTimestamp(iso, locale) {
  if (typeof iso !== 'string' || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(locale || 'zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/* ==========================================================================
 * 2. 路径读写（支持 a[0].b 与 a.b）
 * ========================================================================== */

function parsePath(path) {
  const parts = [];
  for (const segment of String(path == null ? '' : path).split('.')) {
    const match = /^([^[\]]+)((?:\[\d+\])*)$/.exec(segment);
    if (!match) {
      parts.push({ key: segment });
      continue;
    }
    parts.push({ key: match[1] });
    const indexes = match[2].match(/\d+/g);
    if (indexes) for (const raw of indexes) parts.push({ index: Number(raw) });
  }
  return parts;
}

/** 读任意路径；不存在返回 undefined。 */
export function getPath(document_, path) {
  let current = document_;
  for (const part of parsePath(path)) {
    if (current == null) return undefined;
    current = part.index === undefined ? current[part.key] : current[part.index];
  }
  return current;
}

/** 写任意路径（缺失的中间层自动建对象/数组）。 */
export function setPath(document_, path, value) {
  const parts = parsePath(path);
  if (parts.length === 0) return;
  let current = document_;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    const container = next.index === undefined ? {} : [];
    if (part.index === undefined) {
      if (current[part.key] == null || typeof current[part.key] !== 'object') current[part.key] = container;
      current = current[part.key];
    } else {
      if (current[part.index] == null || typeof current[part.index] !== 'object') current[part.index] = container;
      current = current[part.index];
    }
  }
  const last = parts[parts.length - 1];
  if (last.index === undefined) current[last.key] = value;
  else current[last.index] = value;
}

export function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

export function deepEqual(a, b) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ==========================================================================
 * 3. schema 描述工具
 * ========================================================================== */

export const ACTION_DECISIONS = Object.freeze(['allow', 'needs_approval', 'deny']);

/** 严重度顺序（合同 §6 severityMapping 的键集合；用于 keyed enum 渲染）。 */
export const SEVERITY_ORDER = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

/** `type` 归一：兼容合同 §2.8 的 `enum` 与 B8 的 `values` 描述。 */
export function itemType(item) {
  return item && typeof item.type === 'string' ? item.type : 'string';
}

/** 枚举候选：优先 schema.values，兼容合同里的 `enum` 字段名。 */
export function enumValues(item) {
  if (!item) return [];
  if (Array.isArray(item.values)) return item.values;
  if (Array.isArray(item.enum)) return item.enum;
  return [];
}

export function humanize(text) {
  return String(text == null ? '' : text)
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

/** 字段标签：只来自 schema 的 labelKey（缺失时用路径尾段，不编造业务名）。 */
export function itemLabel(t, item) {
  if (!item) return '';
  const fallback = humanize(String(item.path || '').split('.').slice(-1)[0]);
  return t(item.labelKey || '', fallback);
}

export function itemHint(t, item) {
  if (!item || !item.hintKey) return '';
  const value = t(item.hintKey, '');
  return value === item.hintKey ? '' : value;
}

const APPLIES_AT_KEY = {
  immediate: 'settings.applies-at.immediate',
  'next-collection': 'settings.applies-at.next-collection',
  restart: 'settings.applies-at.restart',
  external: 'settings.applies-at.external',
};

export function appliesAtText(t, value) {
  const key = APPLIES_AT_KEY[value];
  if (key) return t(key, FALLBACK[key]);
  return t('settings.applies-at.unknown', FALLBACK['settings.applies-at.unknown'], { value: String(value) });
}

export function defaultText(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (Array.isArray(value)) return value.length === 0 ? '[]' : JSON.stringify(value).slice(0, 80);
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80);
  return String(value);
}

/* ==========================================================================
 * 4. 控件工厂（所有控件的唯一来源；不写死任何具体业务字段）
 * ========================================================================== */

/**
 * 渲染一个底层控件。
 * @param {{
 *   type: string, value: unknown, values?: string[], min?: number, max?: number,
 *   path: string, label: string, onInput: (value: unknown) => void,
 *   readOnly?: boolean, mono?: boolean, placeholder?: string, t: Function
 * }} spec
 * @returns {HTMLElement}
 */
export function renderControl(spec) {
  const {
    type,
    value,
    values = [],
    min,
    max,
    path,
    label,
    onInput,
    readOnly = false,
    mono = false,
    placeholder = '',
    t,
  } = spec;
  const tr = typeof t === 'function' ? t : (key, fallback) => fallback || key;

  if (readOnly) {
    const shown = value === null || value === undefined ? '—' : Array.isArray(value) ? (value.join(', ') || '—') : String(value);
    return el('div', { class: 'settings-readonly' }, [
      value === null || value === undefined
        ? el('span', { class: 'faint', text: '—' })
        : el('code', { class: 'mono', text: shown }),
    ]);
  }

  switch (type) {
    case 'boolean': {
      const node = toggle({
        checked: value === true,
        onChange: (next) => onInput(next),
      });
      node.setAttribute('aria-label', label);
      return node;
    }
    case 'enum':
    case 'string-enum': {
      const options = values.map((entry) => ({ value: String(entry), label: enumLabel(tr, path, String(entry)) }));
      return select({
        options,
        value: value == null ? '' : String(value),
        placeholder: value == null ? tr('common.action.choose', 'Choose…') : '',
        ariaLabel: label,
        onChange: (next) => onInput(next),
      });
    }
    case 'integer': {
      return input({
        type: 'number',
        value: value == null ? '' : String(value),
        min: min == null ? null : String(min),
        max: max == null ? null : String(max),
        step: '1',
        inputMode: 'numeric',
        mono,
        ariaLabel: label,
        placeholder,
        onInput: (event) => onInput(readNumber(event.target.value, true)),
      });
    }
    case 'number': {
      return input({
        type: 'number',
        value: value == null ? '' : String(value),
        min: min == null ? null : String(min),
        max: max == null ? null : String(max),
        step: '0.01',
        inputMode: 'decimal',
        mono,
        ariaLabel: label,
        placeholder,
        onInput: (event) => onInput(readNumber(event.target.value, false)),
      });
    }
    case 'string': {
      return input({
        type: 'text',
        value: value == null ? '' : String(value),
        mono,
        ariaLabel: label,
        placeholder,
        onInput: (event) => onInput(event.target.value),
      });
    }
    case 'string[]': {
      if (values.length > 0) {
        const current = Array.isArray(value) ? value.slice() : [];
        return el(
          'div',
          { class: 'settings-checklist', role: 'group', 'aria-label': label },
          values.map((entry) =>
            checkbox({
              label: enumLabel(tr, path, String(entry)),
              checked: current.includes(String(entry)),
              onChange: (checked) => {
                const next = new Set(current.includes(String(entry)) ? current : current.concat(String(entry)));
                if (checked) next.add(String(entry));
                else next.delete(String(entry));
                onInput(values.filter((candidate) => next.has(String(candidate))));
              },
            }),
          ),
        );
      }
      return stringListEditor({ value: Array.isArray(value) ? value : [], label, onChange: onInput, t: tr, path });
    }
    default:
      return input({
        type: 'text',
        value: value == null ? '' : String(value),
        mono,
        ariaLabel: label,
        onInput: (event) => onInput(event.target.value),
      });
  }
}

/** 列表编辑器（string[]）：增删改；结构变化由调用方负责重渲染。 */
function stringListEditor(spec) {
  const { value, label, onChange, t, path } = spec;
  const entries = value.slice();
  const host = el('div', { class: 'settings-list' });
  let structural = null;
  const renderRows = () => {
    host.replaceChildren();
    if (entries.length === 0) {
      host.appendChild(el('p', { class: 'faint', text: t('settings.list.empty', 'No entries yet.') }));
    }
    entries.forEach((entry, index) => {
      const inputNode = input({
        type: 'text',
        value: entry,
        mono: true,
        ariaLabel: label + ' ' + (index + 1),
        onInput: (event) => {
          entries[index] = event.target.value;
          onChange(entries.slice());
        },
      });
      const remove = button({
        icon: 'trash',
        variant: 'ghost',
        size: 'sm',
        ariaLabel: t('settings.list.remove', 'Remove entry'),
        onClick: () => {
          entries.splice(index, 1);
          onChange(entries.slice());
          if (structural) structural();
        },
      });
      host.appendChild(el('div', { class: 'settings-list__row' }, [inputNode, remove]));
    });
    const add = button({
      label: t('settings.list.add', 'Add entry'),
      icon: 'plus',
      size: 'sm',
      onClick: () => {
        entries.push('');
        onChange(entries.slice());
        if (structural) structural();
      },
    });
    host.appendChild(el('div', { class: 'settings-actions' }, [add]));
  };
  renderRows();
  const wrapper = el('div', { class: 'settings-list__host', data: { path } }, [host]);
  structural = () => {
    renderRows();
  };
  return wrapper;
}

/** 数字输入：空串 → null（让客户端校验给出 type 错误，而不是偷偷写 0）。 */
function readNumber(raw, integer) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return integer ? Math.trunc(value) : value;
}

/**
 * 取**可读**文案：i18n 命中就用 i18n；缺 key 时**剥掉** `[missing:…]` 标记、只用人类可读兜底。
 *
 * 为什么剥标记：§8.5 的 `[missing:key]` 标记是为"页面文案/字段标签"暴露语言包缺口；
 * 枚举值本身有 severity / decision / humanize 三层可读兜底，标记会把兜底打死成
 * `[missing:settings.enum.…] Ghost mode`（D9）。枚举标签一律返回可读文本。
 */
function plainLabel(t, key, fallback) {
  const text = t(key, fallback);
  if (typeof text === 'string' && text !== '' && !text.startsWith(MISSING_MARKER)) return text;
  return fallback;
}

/**
 * 枚举候选 key：先按"值→key"（**去掉数组行索引**——索引只是数组位置，不是枚举值身份），
 * 再按行级 key（兼容 i18n 已按 index 预生成的旧键）。
 */
function enumKeys(path, valueSlug) {
  const slug = keyPath(path);
  if (!slug || !valueSlug) return [];
  const indexless = slug.split('.').filter((segment) => !/^\d+$/u.test(segment)).join('.');
  const keys = [];
  if (indexless) keys.push('settings.enum.' + indexless + '.' + valueSlug);
  if (slug !== indexless) keys.push('settings.enum.' + slug + '.' + valueSlug);
  return keys;
}

export function enumLabel(t, path, value) {
  const valueSlug = toKebab(value);
  const base = humanize(value);
  const human = ['info', 'low', 'medium', 'high', 'critical'].includes(value)
    ? plainLabel(t, 'severity.' + value, base)
    : value === 'allow' || value === 'needs_approval' || value === 'deny'
      ? plainLabel(t, 'settings.decision.' + toKebab(value), base)
      : base;
  for (const key of enumKeys(path, valueSlug)) {
    const label = plainLabel(t, key, '');
    if (label !== '') return label;
  }
  return human;
}

/* ==========================================================================
 * 5. 表单 item 渲染（wrapper + 徽标 + 默认值/生效时机/只读/未接线）
 * ========================================================================== */

/**
 * 渲染一个 schema item。
 * @param {object} item schema item 描述
 * @param {object} env 环境（见 index.js）
 * @returns {HTMLElement}
 */
export function renderItem(item, env) {
  const { t, draft, registry } = env;
  const type = itemType(item);
  const value = getPath(draft, item.path);
  const label = itemLabel(t, item);
  const hint = itemHint(t, item);

  const headBadges = el('span', { class: 'settings-badges' }, [
    badge({ tone: appliesAtTone(item.appliesAt), text: appliesAtText(t, item.appliesAt) }),
    item.readOnly ? badge({ tone: 'neutral', text: t('settings.read-only', 'Read-only') }) : null,
    item.dangerous ? badge({ tone: 'danger', text: t('settings.dangerous', 'Dangerous') }) : null,
    item.wired === false
      ? badge({ tone: 'warn', text: t('settings.not-wired', FALLBACK['settings.not-wired']) })
      : null,
  ]);

  const errorNode = el('p', { class: 'settings-item__error', hidden: true });
  const controlNode = buildControl(item, env, value, label);
  const wrapper = el(
    'div',
    {
      class: 'settings-item',
      data: {
        path: item.path,
        type,
        invalid: 'false',
        wired: item.wired === false ? 'false' : 'true',
      },
    },
    [
      el('div', { class: 'settings-item__head' }, [
        el('span', { class: 'settings-item__label', text: label }),
        el('code', { class: 'settings-item__path', text: item.path }),
        headBadges,
      ]),
      el('div', { class: 'settings-item__control' }, [controlNode]),
      hint ? el('p', { class: 'settings-item__hint', text: hint }) : null,
      el('p', { class: 'settings-item__meta', text: defaultLine(t, item) }),
      errorNode,
    ],
  );

  const entry = {
    path: item.path,
    type,
    wrapper,
    errorNode,
    control: controlNode,
    setError(message) {
      if (!message) {
        wrapper.setAttribute('data-invalid', 'false');
        errorNode.setAttribute('hidden', '');
        errorNode.textContent = '';
        return;
      }
      wrapper.setAttribute('data-invalid', 'true');
      errorNode.removeAttribute('hidden');
      errorNode.textContent = message;
      const focusable = firstFocusable(wrapper);
      if (focusable) focusable.setAttribute('aria-invalid', 'true');
    },
  };
  registry.set(item.path, entry);
  return wrapper;
}

/** 按 childNodes 深度优先找第一个可聚焦控件（不依赖 querySelector，便于 DOM shim）。 */
export function firstFocusable(root) {
  const tags = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A']);
  const walk = (parent) => {
    if (!parent || !parent.childNodes) return null;
    for (let index = 0; index < parent.childNodes.length; index += 1) {
      const child = parent.childNodes[index];
      if (!child || child.nodeType !== 1) continue;
      if (child.hasAttribute && (child.hasAttribute('hidden') || child.getAttribute('aria-hidden') === 'true')) continue;
      if (child.tagName && tags.has(child.tagName)) {
        if (!(child.getAttribute && child.getAttribute('disabled') != null)) return child;
      }
      const nested = walk(child);
      if (nested) return nested;
    }
    return null;
  };
  return walk(root);
}

function defaultLine(t, item) {
  return t('settings.default', FALLBACK['settings.default'], { value: defaultText(item.default) });
}

function appliesAtTone(appliesAt) {
  if (appliesAt === 'restart') return 'warn';
  if (appliesAt === 'external') return 'neutral';
  return 'info';
}

function buildControl(item, env, value, label) {
  const { t, draft, onChange } = env;
  const type = itemType(item);
  const write = (next) => {
    setPath(draft, item.path, next);
    onChange(item.path);
  };

  if (type === 'object[]') {
    if (Array.isArray(item.fields) && item.fields.length > 0) {
      return objectArrayEditor(item, env, value, label);
    }
    return keyedObjectEditor(item, env, value, label);
  }

  return renderControl({
    type,
    value,
    values: enumValues(item),
    min: item.min,
    max: item.max,
    path: item.path,
    label,
    readOnly: item.readOnly === true || item.injected === true,
    mono: type === 'integer' || type === 'number' ? false : false,
    t,
    onInput: write,
  });
}

/**
 * keyed object（severityMapping / actionMatrix）：
 * 键来自默认值或 schema.actionCatalog，值来自 schema/hardcoded contract enum。
 * 这里**不手写字段名**：键集合来自 (a) item.default 的对象键 或 (b) schema.actionCatalog。
 */
function keyedObjectEditor(item, env, value, label) {
  const { t, draft, onChange, schema } = env;
  const current = value != null && typeof value === 'object' ? value : {};
  const keys = Object.keys(item.default && typeof item.default === 'object' ? item.default : {});
  let options = [];
  if (item.path === 'response.actionMatrix') {
    const catalog = Array.isArray(schema.actionCatalog) ? schema.actionCatalog : [];
    options = catalog.map((entry) => entry.id);
  }
  const targetKeys = options.length > 0 ? options : keys;
  const host = el('div', { class: 'settings-kv' }, []);
  for (const key of targetKeys) {
    const path = item.path + '.' + key;
    const labelText = t('settings.keyed.' + keyPath(item.path) + '.' + toKebab(key), humanize(key));
    const candidates = options.length > 0 ? ACTION_DECISIONS : keys;
    host.appendChild(el('span', { class: 'settings-kv__key', text: labelText }));
    host.appendChild(
      select({
        options: candidates.map((candidate) => ({ value: candidate, label: enumLabel(t, path, candidate) })),
        value: current[key] == null ? candidates[0] : String(current[key]),
        ariaLabel: labelText,
        onChange: (next) => {
          const nextValue = Object.assign({}, current, { [key]: next });
          setPath(draft, item.path, nextValue);
          onChange(item.path);
        },
      }),
    );
  }
  return host;
}

/**
 * 通用 object[] 编辑器：子字段完全由 item.fields 生成。
 * providers / models 的额外交互（密钥、连通性、tier 视角）在 models.js 里叠加，
 * 但字段本身仍走这里（同一个 schema 来源）。
 */
export function objectArrayEditor(item, env, value, label) {
  const { t, draft, onChange, registry } = env;
  const rows = Array.isArray(value) ? value : [];
  const host = el('div', { class: 'settings-array' });

  const rerender = () => {
    host.replaceChildren();
    if (rows.length === 0) {
      host.appendChild(el('p', { class: 'faint', text: t('settings.array.empty', 'No entries.') }));
    }
    rows.forEach((row, index) => {
      host.appendChild(objectRow(item, env, index, row));
    });
    const maxItems = Number.isFinite(Number(item.maxItems)) ? Number(item.maxItems) : Infinity;
    host.appendChild(
      el('div', { class: 'settings-actions' }, [
        button({
          label: t('settings.array.add', 'Add entry'),
          icon: 'plus',
          size: 'sm',
          disabled: rows.length >= maxItems,
          onClick: () => {
            rows.push(defaultRow(item.fields || []));
            setPath(draft, item.path, rows);
            onChange(item.path);
            rerender();
          },
        }),
        maxItems !== Infinity
          ? el('span', { class: 'faint', text: String(rows.length) + ' / ' + String(maxItems) })
          : null,
      ]),
    );
  };

  const objectRow = (itemDef, envRef, index, row) => {
    const path = itemDef.path + '[' + index + ']';
    const fieldHosts = (itemDef.fields || []).map((fieldDef) => {
      const fieldPath = path + '.' + fieldDef.name;
      const labelText = t('settings.field.' + keyPath(itemDef.path) + '.' + toKebab(fieldDef.name), humanize(fieldDef.name));
      const control = renderControl({
        type: fieldType(fieldDef),
        value: getPath(row, fieldDef.name),
        values: Array.isArray(fieldDef.values) ? fieldDef.values : [],
        min: fieldDef.min,
        max: fieldDef.max,
        path: fieldPath,
        label: labelText,
        readOnly: itemDef.readOnly === true,
        mono: fieldType(fieldDef) === 'string' && /url|path|pattern|id/i.test(fieldDef.name),
        placeholder: fieldDef.pattern ? fieldDef.pattern : '',
        t,
        onInput: (next) => {
          setPath(row, fieldDef.name, next);
          onChange(fieldPath);
        },
      });
      registry.set(fieldPath, {
        path: fieldPath,
        wrapper: control,
        control,
        errorNode: null,
        setError: () => {},
      });
      return el('div', { class: 'settings-subfield' }, [
        el('span', { class: 'settings-subfield__label', text: labelText }),
        control,
        fieldDef.required ? el('span', { class: 'faint', text: t('settings.field.required', FALLBACK['settings.field.required']) }) : null,
      ]);
    });

    return el('div', { class: 'settings-array__row', data: { index: String(index) } }, [
      el('div', { class: 'settings-array__head' }, [
        el('span', { class: 'settings-array__title', text: (itemDef.path || '') + '[' + index + ']' }),
        itemDef.readOnly
          ? null
          : button({
              icon: 'trash',
              variant: 'ghost',
              size: 'sm',
              ariaLabel: t('settings.array.remove', 'Remove entry'),
              onClick: () => {
                rows.splice(index, 1);
                setPath(draft, itemDef.path, rows);
                onChange(itemDef.path);
                rerender();
              },
            }),
      ]),
      el('div', { class: 'settings-array__grid' }, fieldHosts),
    ]);
  };

  rerender();
  return host;
}

function fieldType(fieldDef) {
  if (fieldDef.type === 'boolean') return 'boolean';
  if (fieldDef.type === 'integer') return 'integer';
  if (fieldDef.type === 'number') return 'number';
  if (fieldDef.type === 'enum') return 'enum';
  if (fieldDef.type === 'string[]') return 'string[]';
  return fieldDef.type || 'string';
}

function defaultRow(fields) {
  const row = {};
  for (const fieldDef of fields) {
    if (fieldDef.default !== undefined) row[fieldDef.name] = cloneJson(fieldDef.default);
    else if (fieldDef.type === 'boolean') row[fieldDef.name] = false;
    else if (fieldDef.type === 'integer' || fieldDef.type === 'number') row[fieldDef.name] = 0;
    else if (fieldDef.type === 'string[]') row[fieldDef.name] = [];
    else if (fieldDef.type === 'enum') row[fieldDef.name] = (fieldDef.values || [])[0] || '';
    else row[fieldDef.name] = '';
  }
  return row;
}

/** 供 models.js 复用：按 schema 子字段生成一行默认值。 */
export function defaultObjectRow(fields) {
  return defaultRow(Array.isArray(fields) ? fields : []);
}

/** 删除任意路径（payloadForSave 用来剥掉 readOnly/injected 字段）。 */
export function deletePath(document_, path) {
  const parts = parsePath(path);
  if (parts.length === 0) return;
  let current = document_;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (current == null) return;
    current = part.index === undefined ? current[part.key] : current[part.index];
  }
  const last = parts[parts.length - 1];
  if (current == null) return;
  if (last.index === undefined) delete current[last.key];
  else current.splice(last.index, 1);
}

/**
 * 保存载荷：剥掉 readOnly / injected 字段与 `about` 组。
 *
 * 为什么不直接回传 GET 的 settings：GET 会把服务端只读值 overlay 进来
 * （apiPort/currentVersion/about.*），而 B8 的 PUT 用封闭 schema 校验，
 * 顶层多一个 `about` 键就会 400。这里按 schema 描述精确剥离，不写死键名。
 */
export function payloadForSave(schema, draft) {
  const payload = cloneJson(draft);
  const groups = Array.isArray(schema && schema.groups) ? schema.groups : [];
  for (const group of groups) {
    if (group.injected === true) {
      deletePath(payload, group.id);
      continue;
    }
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (item.readOnly === true || item.injected === true) deletePath(payload, item.path);
    }
  }
  return payload;
}

/**
 * 把服务端返回的**部分** settings 文档按 schema 默认值补齐。
 *
 * 真实栈证据（2026-11-04T21:40 实测 GET /api/v1/settings）：daemon 的 GET 会省略
 * 若干未被写过的子树（当时缺 response.* 与 update.* 共 9 个叶子），而 PUT 是把
 * 部分文档合并到 DEFAULT_SETTINGS 上。若客户端照原样渲染，这些字段会被判成非法，
 * 导致"9 invalid field(s)"并锁死保存按钮。这里按 schema 补齐，与服务端语义一致。
 *
 * @param {object} schema GET /settings/schema
 * @param {object} document_ 服务端返回的 settings
 * @returns {object} 补齐后的文档
 */
export function mergeSchemaDefaults(schema, document_) {
  const output = cloneJson(document_ == null ? {} : document_);
  const groups = Array.isArray(schema && schema.groups) ? schema.groups : [];
  for (const group of groups) {
    if (group.injected === true) continue;
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (item.readOnly === true) continue;
      const current = getPath(output, item.path);
      if (current === undefined) {
        setPath(output, item.path, cloneJson(item.default === undefined ? null : item.default));
        continue;
      }
      // 键控对象（severityMapping / actionMatrix）：补齐默认键
      if (isPlainObjectValue(current) && isPlainObjectValue(item.default)) {
        for (const key of Object.keys(item.default)) {
          if (current[key] === undefined) current[key] = cloneJson(item.default[key]);
        }
      }
    }
  }
  return output;
}

/**
 * 渲染一组 item（按 schema 顺序），返回节点数组。
 * @param {object} env
 * @param {object[]} items schema items
 */
export function renderItems(env, items) {
  return (Array.isArray(items) ? items : []).map((item) => renderItem(item, env));
}

/** 从 schema 里按 path 找 item（组合布局用；字段本身仍由 schema 生成）。 */
export function findItem(schema, path) {
  const groups = Array.isArray(schema && schema.groups) ? schema.groups : [];
  for (const group of groups) {
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (item.path === path) return item;
    }
  }
  return null;
}

/** 某组的 item 列表。 */
export function groupItems(schema, groupId) {
  const groups = Array.isArray(schema && schema.groups) ? schema.groups : [];
  const group = groups.find((entry) => entry && entry.id === groupId);
  return group && Array.isArray(group.items) ? group.items : [];
}

/* ==========================================================================
 * 6. provider URL 校验（镜像 §6 + ADR-0010 §2.2，规则与 B8 的 validateProviderUrl 一致）
 * ========================================================================== */

const LOOPBACK_V4 = /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/;

export function isLoopbackHostname(hostname) {
  const value = String(hostname == null ? '' : hostname).toLowerCase();
  if (value === 'localhost' || value === '::1' || value === '[::1]' || value === '127.0.0.1') return true;
  if (!LOOPBACK_V4.test(value)) return false;
  return value.split('.').every((part) => Number(part) <= 255);
}

export function isLiteralLoopbackHostname(hostname) {
  const value = String(hostname == null ? '' : hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return value === '::1' || LOOPBACK_V4.test(value);
}

/**
 * 校验 provider baseUrl。
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 * reason ∈ required|too_long|absolute|userinfo|query_or_hash|scheme|path_prefix|INSECURE_NOT_ALLOWED
 */
export function validateProviderUrl(raw, options) {
  const opts = options || {};
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'required' };
  const trimmed = raw.trim();
  if (trimmed.length > 2048) return { ok: false, reason: 'too_long' };
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'absolute' };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'userinfo' };
  if (url.search !== '' || url.hash !== '') return { ok: false, reason: 'query_or_hash' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.pathname.replace(/\/+$/g, '') === '') return { ok: false, reason: 'path_prefix' };
  if (url.protocol === 'http:') {
    const allowed =
      opts.allowLoopback === true && opts.kind !== 'deepseek' && isLiteralLoopbackHostname(url.hostname);
    if (!allowed) return { ok: false, reason: 'INSECURE_NOT_ALLOWED' };
  }
  return { ok: true, url };
}

/* ==========================================================================
 * 7. 客户端校验（镜像服务端封闭 schema 的关键规则）
 * ========================================================================== */

/**
 * @param {object} schema GET /settings/schema
 * @param {object} draft 待保存文档
 * @returns {{ok: boolean, errors: Array<{path: string, rule: string}>}}
 */
export function validateDraft(schema, draft) {
  const errors = [];
  const push = (path, rule) => errors.push({ path, rule });
  const groups = Array.isArray(schema && schema.groups) ? schema.groups : [];

  for (const group of groups) {
    if (group.injected === true) continue;
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (item.readOnly === true) continue;
      validateValue(item, getPath(draft, item.path), item.path, push);
    }
  }

  const providers = getPath(draft, 'models.providers');
  if (Array.isArray(providers)) {
    const seen = new Set();
    providers.forEach((provider, index) => {
      const base = 'models.providers[' + index + ']';
      if (!provider || typeof provider !== 'object') {
        push(base, 'object');
        return;
      }
      const id = provider.id;
      if (typeof id !== 'string' || !/^[a-z0-9-]{2,32}$/.test(id)) push(base + '.id', 'pattern');
      else if (seen.has(id)) push(base + '.id', 'duplicate');
      else seen.add(id);
      const kind = provider.kind;
      const url = validateProviderUrl(provider.baseUrl, { allowLoopback: provider.allowLoopback === true, kind });
      if (!url.ok) push(base + '.baseUrl', url.reason);
    });
  }

  const models = getPath(draft, 'models.models');
  const providerIds = new Set((Array.isArray(providers) ? providers : []).map((entry) => entry && entry.id));
  if (Array.isArray(models)) {
    const seenModels = new Set();
    models.forEach((model, index) => {
      const base = 'models.models[' + index + ']';
      if (!model || typeof model !== 'object') {
        push(base, 'object');
        return;
      }
      if (typeof model.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(model.id)) push(base + '.id', 'pattern');
      else if (seenModels.has(model.id)) push(base + '.id', 'duplicate');
      else seenModels.add(model.id);
      if (!providerIds.has(model.providerId)) push(base + '.providerId', 'provider_unknown');
    });
  }

  const mode = getPath(draft, 'models.routing.mode');
  const uniformModelId = getPath(draft, 'models.routing.uniformModelId');
  if (mode === 'uniform') {
    const modelIds = new Set((Array.isArray(models) ? models : []).map((entry) => entry && entry.id));
    if (uniformModelId == null || uniformModelId === '') push('models.routing.uniformModelId', 'uniform_model_required');
    else if (!modelIds.has(uniformModelId)) push('models.routing.uniformModelId', 'model_unknown');
  } else if (uniformModelId != null && uniformModelId !== '') {
    const modelIds = new Set((Array.isArray(models) ? models : []).map((entry) => entry && entry.id));
    if (!modelIds.has(uniformModelId)) push('models.routing.uniformModelId', 'model_unknown');
  }

  return { ok: errors.length === 0, errors };
}

function validateValue(item, value, path, push) {
  const type = itemType(item);
  // 服务端 PUT 会把部分文档合并到默认值上（B8 的 validateSettingsDocument）；
  // 客户端因此把"缺失"视为交由服务端默认值决定，不制造假报错。
  if (value === undefined) return;
  // 可空标量：schema 用 default:null 表达"允许 null"（如 models.routing.uniformModelId）。
  if (value === null && item.default === null && type !== 'object[]' && type !== 'string[]') return;
  if (type === 'boolean') {
    if (typeof value !== 'boolean') push(path, 'boolean');
    return;
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) push(path, 'integer');
    else if (item.min != null && value < item.min) push(path, 'min');
    else if (item.max != null && value > item.max) push(path, 'max');
    return;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) push(path, 'number');
    else if (item.min != null && value < item.min) push(path, 'min');
    else if (item.max != null && value > item.max) push(path, 'max');
    return;
  }
  if (type === 'enum') {
    const values = enumValues(item);
    if (values.length > 0 && !values.includes(value)) push(path, 'enum');
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') push(path, 'string');
    return;
  }
  if (type === 'string[]') {
    if (!Array.isArray(value)) {
      push(path, 'string[]');
      return;
    }
    if (valuesAllStrings(value) === false) push(path, 'string[]');
    if (item.maxItems != null && value.length > item.maxItems) push(path, 'max_items');
    return;
  }
  if (type === 'object[]') {
    // B8 的 schema 用 `object[]` 同时描述两类值：真正的对象数组（providers/models/allowlist）
    // 与键控对象（severityMapping/actionMatrix）。按 default 的实际形状区分，避免误报。
    if (isPlainObjectValue(value)) return;
    if (!Array.isArray(value)) {
      push(path, 'object[]');
      return;
    }
    if (item.maxItems != null && value.length > item.maxItems) push(path, 'max_items');
    const fields = Array.isArray(item.fields) ? item.fields : [];
    value.forEach((row, index) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        push(path + '[' + index + ']', 'object');
        return;
      }
      for (const fieldDef of fields) {
        const fieldPath = path + '[' + index + '].' + fieldDef.name;
        const fieldValue = row[fieldDef.name];
        if (fieldDef.type === 'boolean' && typeof fieldValue !== 'boolean') push(fieldPath, 'boolean');
        if (fieldDef.type === 'integer' && !Number.isInteger(fieldValue)) push(fieldPath, 'integer');
        if (fieldDef.type === 'enum' && Array.isArray(fieldDef.values) && !fieldDef.values.includes(fieldValue)) {
          push(fieldPath, 'enum');
        }
        if (fieldDef.required === true && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
          push(fieldPath, 'required');
        }
        if (fieldDef.pattern && typeof fieldValue === 'string') {
          try {
            if (!new RegExp(fieldDef.pattern, 'u').test(fieldValue)) push(fieldPath, 'pattern');
          } catch {
            /* 服务端 pattern 不合法时不在客户端放大错误 */
          }
        }
      }
    });
  }
}

function valuesAllStrings(value) {
  return value.every((entry) => typeof entry === 'string');
}

function isPlainObjectValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ==========================================================================
 * 8. 变更 / 危险操作判定
 * ========================================================================== */

/** schema 叶子级别的差异（与 B8 的 changedPaths 同构）。 */
export function changedItems(schema, before, after) {
  const out = [];
  const groups = Array.isArray(schema && schema.groups) ? schema.groups : [];
  for (const group of groups) {
    if (group.injected === true) continue;
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (item.readOnly === true) continue;
      const left = getPath(before, item.path);
      const right = getPath(after, item.path);
      if (!deepEqual(left, right)) out.push({ path: item.path, item, group });
    }
  }
  return out;
}

/**
 * 危险变更清单（用于二次确认）。
 * @returns {Array<{kind: string, path: string, item?: object, id?: string, value?: unknown}>}
 */
export function dangerousChanges(schema, before, after) {
  const out = [];
  for (const change of changedItems(schema, before, after)) {
    const { path, item } = change;
    if (path === 'models.egressEnabled') {
      out.push({ kind: 'egress', path, value: change.item ? getPath(after, path) : null });
      continue;
    }
    if (path === 'models.routing.mode' && getPath(after, path) === 'uniform') {
      out.push({ kind: 'uniform', path, uniformModelId: getPath(after, 'models.routing.uniformModelId') });
      continue;
    }
    // 关闭采集（清空所有通道）= 不再有新事件/告警，属于"会让界面看起来很安静"的危险操作，
    // 必须二次确认并写清后果（否则用户会把"没有告警"误读成"系统正常"）。
    if (path === 'collection.channels') {
      const next = getPath(after, path);
      const previous = getPath(before, path);
      if (Array.isArray(next) && next.length === 0 && Array.isArray(previous) && previous.length > 0) {
        out.push({ kind: 'collection_off', path });
        continue;
      }
    }
    if (item.dangerous === true) out.push({ kind: 'dangerous', path, item });
  }

  const beforeProviders = getPath(before, 'models.providers');
  const afterProviders = getPath(after, 'models.providers');
  if (Array.isArray(beforeProviders) && Array.isArray(afterProviders)) {
    const afterIds = new Set(afterProviders.map((entry) => entry && entry.id));
    for (const provider of beforeProviders) {
      if (provider && !afterIds.has(provider.id)) {
        out.push({ kind: 'provider_removed', path: 'models.providers', id: String(provider.id) });
      }
    }
    const beforeById = new Map(beforeProviders.map((entry) => [entry && entry.id, entry]));
    for (const provider of afterProviders) {
      const previous = beforeById.get(provider && provider.id);
      if (previous && previous.enabled !== true && provider.enabled === true) {
        out.push({ kind: 'provider_enabled', path: 'models.providers', id: String(provider.id) });
      }
    }
  }
  return out;
}

/** 危险变更 → 可读后果条目（i18n + 英文兜底）。 */
export function dangerConsequences(t, dangers) {
  const lines = [];
  let wiredWarning = false;
  for (const danger of dangers) {
    if (danger.kind === 'egress') {
      const state = danger.value === true ? t('settings.danger.egress-on', FALLBACK['settings.danger.egress-on']) : t('settings.danger.egress-off', FALLBACK['settings.danger.egress-off']);
      lines.push(t('settings.danger.egress', FALLBACK['settings.danger.egress'], { state }));
    } else if (danger.kind === 'uniform') {
      lines.push(
        t('settings.danger.uniform', FALLBACK['settings.danger.uniform'], {
          id: String(danger.uniformModelId == null ? '—' : danger.uniformModelId),
        }),
      );
    } else if (danger.kind === 'provider_removed') {
      lines.push(t('settings.danger.provider-removed', FALLBACK['settings.danger.provider-removed'], { id: danger.id }));
      lines.push(t('settings.danger.provider-credential-lost', FALLBACK['settings.danger.provider-credential-lost']));
    } else if (danger.kind === 'provider_enabled') {
      lines.push(t('settings.danger.enabled-on', FALLBACK['settings.danger.enabled-on'], { id: danger.id }));
    } else if (danger.kind === 'collection_off') {
      lines.push(t('settings.danger.collection-off', FALLBACK['settings.danger.collection-off']));
    } else if (danger.item && danger.item.wired === false) {
      wiredWarning = true;
    }
  }
  if (wiredWarning) lines.push(t('settings.danger.wired', FALLBACK['settings.danger.wired']));
  return lines;
}

/* ==========================================================================
 * 9. 交互工具（确认弹窗 / 通知 / 错误归一）
 * ========================================================================== */

/** 危险操作二次确认（用 B1 的 destructive modal）。返回 overlay（.close()）。 */
export function confirmDestructive(ctx, spec) {
  const { t } = spec;
  const body = el('div', { class: 'stack' }, [
    el('p', { text: spec.body || '' }),
    spec.consequences && spec.consequences.length
      ? el(
          'ul',
          { class: 'settings-consequences' },
          spec.consequences.map((line) => el('li', { text: line })),
        )
      : null,
    spec.note ? el('p', { class: 'faint', text: spec.note }) : null,
  ]);
  return modal({
    title: spec.title || t('settings.confirm.title', FALLBACK['settings.confirm.title']),
    body,
    destructive: true,
    closeLabel: t('common.action.close', 'Close'),
    actions: [
      {
        label: t('settings.confirm.cancel', FALLBACK['settings.confirm.cancel']),
        variant: 'secondary',
        onClick: () => {
          if (typeof spec.onCancel === 'function') spec.onCancel();
        },
      },
      {
        label: spec.confirmLabel || t('settings.confirm.apply', FALLBACK['settings.confirm.apply']),
        variant: 'danger',
        onClick: () => {
          if (typeof spec.onConfirm === 'function') spec.onConfirm();
        },
      },
    ],
    onClose: (reason) => {
      if (reason !== 'action' && typeof spec.onCancel === 'function') spec.onCancel();
    },
  });
}

/** 通知：优先走 ctx.toast（B2），否则用组件自带的 toast 宿主。 */
export function notify(ctx, kind, text, options) {
  const opts = options || {};
  const payload = { kind, text, ttl: opts.ttl, actionLabel: opts.actionLabel, onAction: opts.onAction };
  try {
    if (ctx && typeof ctx.toast === 'function') {
      // B2 的 ctx.toast 可能是 (opts) 或 (kind, text)；用 arity 判断，避免二选一猜错。
      if (ctx.toast.length >= 2) ctx.toast(kind, text);
      else ctx.toast(payload);
      return;
    }
  } catch {
    /* 形状不一致时回落组件 */
  }
  try {
    const root = (typeof document !== 'undefined' && document.getElementById('toast-root')) || null;
    const host = toastHost(root);
    host.show({ kind, text, ttl: opts.ttl || 5000, actionLabel: opts.actionLabel, onAction: opts.onAction });
  } catch {
    /* 最后兜底：什么也不做，但绝不假装成功 */
  }
}

/** 从任意抛出物里取 ApiError 字段（B2 的 ApiError / 普通 Error / 字符串）。 */
export function apiErrorInfo(error) {
  const info = { code: '', message: '', details: null, retryAfter: null };
  if (error == null) return info;
  if (typeof error === 'string') {
    info.message = error;
    return info;
  }
  if (typeof error === 'object') {
    if (typeof error.code === 'string') info.code = error.code;
    if (typeof error.message === 'string') info.message = error.message;
    if (error.details && typeof error.details === 'object') info.details = error.details;
    if (error.retryAfter != null) info.retryAfter = error.retryAfter;
    if (!info.message && typeof error.toString === 'function') info.message = String(error);
  }
  return info;
}

/** 错误码 → 人话（i18n errors.<CODE>，缺失回落到原始 message/code）。 */
export function errorText(t, code, fallbackMessage) {
  if (!code) return fallbackMessage || t('errors.UNKNOWN', 'Unexpected error');
  const translated = t('errors.' + code, '');
  if (translated !== '') return translated;
  return fallbackMessage || code;
}

/** SETTINGS_INVALID 的 details.rule → 可读原因。 */
export function ruleText(t, rule) {
  if (!rule) return '';
  const key = 'settings.error.rule.' + toKebab(rule);
  return t(key, humanize(rule));
}

/** 连通性测试失败 action → 可操作建议（合同 §2.4 / §3.2 枚举）。 */
export function testActionText(t, action) {
  if (!action) return '';
  const key = 'settings.test.action.' + toKebab(action);
  return t(key, humanize(action));
}

/**
 * actions[] 的 `reason` 码 → 人话。
 * `NOT_IMPLEMENTED_0_0_1` 必须显示成"0.0.1 未实现"，而不是把内部码当文案丢给用户。
 * 未知码原样返回（不猜意思）。
 */
export function reasonLabel(t, reason) {
  const raw = reason == null ? '' : String(reason);
  if (raw === '') return t('settings.action.reason.not-implemented-0-0-1', 'Not implemented in 0.0.1');
  const key = 'settings.action.reason.' + toKebab(raw);
  const value = t(key, '');
  if (typeof value === 'string' && value !== '' && !value.startsWith(MISSING_MARKER)) return value;
  if (raw === 'NOT_IMPLEMENTED_0_0_1') {
    return t('settings.action.reason.not-implemented-0-0-1', 'Not implemented in 0.0.1');
  }
  return raw;
}

/** 一次连通性测试结果的四态描述（状态词 + 可核对的细节）。 */
export function testStateText(t, state, locale) {
  if (state.phase === 'testing') return t('settings.provider.testing', FALLBACK['settings.provider.testing']);
  if (state.phase === 'ok') {
    const parts = [t('settings.provider.healthy', FALLBACK['settings.provider.healthy'])];
    if (state.latencyMs != null) parts.push(String(state.latencyMs) + ' ms');
    if (state.modelCount != null) parts.push(String(state.modelCount) + ' ' + t('settings.provider.models', 'models'));
    if (state.testedAt) parts.push(formatTimestamp(state.testedAt, locale));
    return parts.join(' · ');
  }
  if (state.phase === 'fail') {
    const parts = [t('settings.provider.failed', FALLBACK['settings.provider.failed'])];
    if (state.code) parts.push(state.code);
    if (state.testedAt) parts.push(formatTimestamp(state.testedAt, locale));
    return parts.join(' · ');
  }
  return t('settings.provider.untested', FALLBACK['settings.provider.untested']);
}

/** 把服务端错误投到具体字段（path 支持 `a.b[0].c`）。 */
export function applyFieldError(registry, path, message) {
  if (!registry || !path) return false;
  const direct = registry.get(path);
  if (direct) {
    direct.setError(message);
    return true;
  }
  // `models.providers[0].baseUrl` → 回落 `models.providers[0]` / `models.providers`
  const stripped = path.replace(/\.?\[\d+\][^.]*/g, '');
  if (stripped !== path && registry.get(stripped)) {
    registry.get(stripped).setError(message);
    return true;
  }
  const arrayPath = path.replace(/\[\d+\].*$/, '');
  if (arrayPath !== path && registry.get(arrayPath)) {
    registry.get(arrayPath).setError(message);
    return true;
  }
  const prefix = path.split('.')[0];
  if (registry.get(prefix)) {
    registry.get(prefix).setError(message);
    return true;
  }
  return false;
}

/** 读数帮助：从模型投影里取 provider 的凭据/健康信息（缺字段一律 null，不编造）。 */
export function providerFacts(projection, providerId) {
  const list = projection && Array.isArray(projection.providers) ? projection.providers : [];
  const found = list.find((entry) => entry && entry.id === providerId);
  if (!found) {
    return {
      found: false,
      hasCredential: false,
      masked: null,
      fingerprint: null,
      updatedAt: null,
      lengthBucket: null,
      healthy: null,
      lastError: null,
      lastCheckedAt: null,
    };
  }
  return {
    found: true,
    hasCredential: found.hasCredential === true,
    masked: found.credential && found.credential.masked ? String(found.credential.masked) : null,
    fingerprint:
      found.credential && typeof found.credential.fingerprint === 'string' && found.credential.fingerprint !== ''
        ? String(found.credential.fingerprint)
        : null,
    updatedAt: found.credential && found.credential.updatedAt ? String(found.credential.updatedAt) : null,
    lengthBucket: found.credential && found.credential.lengthBucket ? String(found.credential.lengthBucket) : null,
    healthy: found.healthy === true ? true : found.healthy === false ? false : null,
    lastError: found.lastError && typeof found.lastError === 'object' ? found.lastError : null,
    lastCheckedAt: found.lastCheckedAt ? String(found.lastCheckedAt) : null,
  };
}

/** 安全读取数组（避免 undefined 操作）。 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 只读值展示（about / readOnly 项）。 */
export function readOnlyValue(node) {
  return el('div', { class: 'settings-readonly' }, [
    node == null ? el('span', { class: 'faint', text: '—' }) : (
      typeof node === 'string' ? el('code', { class: 'mono', text: node }) : el('code', { class: 'mono', text: JSON.stringify(node) })
    ),
  ]);
}

/* ==========================================================================
 * 10. actions[]（后端明确未接线的动作：可见、可解释、绝不假成功）
 * ========================================================================== */

/**
 * 渲染某组对应的 actions[]（schema.actions 中 path 以 `<groupId>.` 开头者）。
 * 0.0.1 全部 available:false；点击只展示原因与端点，不调用、不报成功。
 * 若 future 版本 available:true，需要 B2 的 api.js 增加通用 invokeAction——
 * 本模块不擅自扩展 api 形状，缺实现时如实提示。
 */
export function renderActions(env, groupId) {
  const all = asArray(env.schema && env.schema.actions);
  const actions = all.filter(
    (action) => action && typeof action.path === 'string' && action.path.indexOf(String(groupId) + '.') === 0,
  );
  if (actions.length === 0) return null;

  const rows = actions.map((action) => {
    const available = action.available === true;
    const reason = action.reason == null ? 'NOT_IMPLEMENTED_0_0_1' : String(action.reason);
    return el(
      'div',
      { class: 'settings-action', data: { path: action.path, available: available ? 'true' : 'false' } },
      [
        el('div', { class: 'settings-action__text' }, [
          el('span', {
            class: 'settings-action__label',
            text: env.t('settings.action.' + keyPath(action.id), humanize(action.id)),
          }),
          el('code', { class: 'settings-item__path', text: String(action.method || 'POST') + ' ' + action.path }),
          available
            ? badge({ tone: 'info', text: env.t('settings.action.available', 'Available') })
            : badge({ tone: 'warn', text: reasonLabel(env.t, reason) }),
          !available && action.requiresConfirm === true
            ? badge({ tone: 'danger', text: env.t('settings.dangerous', 'Dangerous') })
            : null,
        ]),
        button({
          label: env.t('settings.action.details', 'Details'),
          size: 'sm',
          variant: 'secondary',
          onClick: () => showActionModal(env, action, available, reason),
        }),
      ],
    );
  });

  return section({
    title: env.t('settings.actions.title', 'Actions'),
    note: env.t('settings.action.hint', FALLBACK['settings.action.hint']),
    body: [el('div', { class: 'settings-list' }, rows)],
  });
}

function showActionModal(env, action, available, reason) {
  const t = env.t;
  const body = el('div', { class: 'stack' }, [
    el('p', { text: t('settings.action.unavailable', FALLBACK['settings.action.unavailable'], { reason: reasonLabel(t, reason) }) }),
    el('code', { class: 'mono', text: reason }),
    el('p', { class: 'faint', text: t('settings.action.terminal', FALLBACK['settings.action.terminal']) }),
    el('p', { class: 'faint', text: t('settings.action.hint', FALLBACK['settings.action.hint']) }),
    el('code', { class: 'mono', text: String(action.method || 'POST') + ' ' + String(action.path) }),
    available
      ? el('p', {
          text: t(
            'settings.action.missing-api',
            'No generic action call exists in api.js yet; the UI will not fake a success.',
          ),
        })
      : null,
  ]);
  return modal({
    title: t('settings.action.title', FALLBACK['settings.action.title']),
    body,
    closeLabel: t('common.action.close', 'Close'),
    actions: [
      {
        label: t('common.action.close', 'Close'),
        variant: 'secondary',
      },
    ],
  });
}

/** 小标题 + 说明的 section 容器（页面级布局，仅用既有 token）。 */
export function section(spec) {  const head = el('div', { class: 'settings-section__head' }, [
    el('div', { class: 'settings-section__headings' }, [
      el('h2', { class: 'settings-section__title', text: spec.title }),
      spec.note ? el('p', { class: 'settings-section__note', text: spec.note }) : null,
    ]),
    spec.actions && spec.actions.length ? el('div', { class: 'settings-section__actions' }, spec.actions) : null,
  ]);
  return el('section', { class: 'settings-section', id: spec.id || null }, [
    head,
    el('div', { class: 'settings-section__body' }, spec.body),
  ]);
}

/** 提示条（信息/警告/危险）。 */
export function banner(tone, title, text, actions) {
  return el('div', { class: 'settings-banner', data: { tone: tone || 'info' } }, [
    el('span', { class: 'settings-banner__icon' }, [icon(tone === 'danger' ? 'error' : tone === 'warn' ? 'warning' : 'info')]),
    el('div', { class: 'settings-banner__text' }, [
      title ? el('strong', { text: title }) : null,
      text ? el('p', { text }) : null,
    ]),
    actions && actions.length ? el('div', { class: 'settings-banner__actions' }, actions) : null,
  ]);
}

/* ==========================================================================
 * 11. daemon 可达性判定（"daemon 不在"必须与"请求被拒"区分开）
 * ========================================================================== */

/**
 * 判据：这些错误码意味着**请求没有到达 daemon**（或 daemon 整段不可用），
 * 而不是"daemon 收到请求后拒绝了这个值"。
 * - NETWORK / ABORTED / BAD_RESPONSE / HTTP_ERROR：api.js 的传输层错误码；
 * - 502/503/504：console host 连不上上游 daemon（B3 serve.mjs 的代理失败）；
 * - DAEMON_UNREACHABLE / DAEMON_TIMEOUT：serve.mjs:502-503 代理失败时**随 502/504 一起**
 *   返回的错误码。真实 Edge 里 `api.js` 会把 body 里的 code 透出来（status 不一定带），
 *   所以这里必须按码识别，否则设置页会假装"schema 加载失败"而不是"daemon 不在"。
 * 500 INTERNAL **不在此列**：daemon 在跑，是它自己出错，不能谎称"daemon 不在"。
 */
export const DAEMON_DOWN_CODES = Object.freeze([
  'NETWORK',
  'ABORTED',
  'BAD_RESPONSE',
  'HTTP_ERROR',
  'API_MISSING',
  'DAEMON_UNREACHABLE',
  'DAEMON_TIMEOUT',
]);

/**
 * @param {{code?:string, message?:string, status?:number|null, details?:object|null}} info apiErrorInfo() 结果
 * @returns {{down: boolean, code: string, reason: string}}
 */
export function daemonUnavailable(info) {
  const code = info && typeof info.code === 'string' ? info.code : '';
  const status = info && Number.isFinite(Number(info.status)) ? Number(info.status) : null;
  const byStatus = status !== null && status >= 502 && status <= 504;
  const down = byStatus || DAEMON_DOWN_CODES.includes(code);
  const reason = byStatus ? 'HTTP ' + String(status) : code === '' ? 'UNREACHABLE' : code;
  return { down, code: reason, reason: reason };
}

/**
 * "本组不可用：需要 daemon" 占位（不是空白，也不是一直转圈）。
 *
 * 合同纪律：daemon 不在时**每一项都要有明确错误**。占位里必须写清
 * ①哪一组不可用 ②为什么 ③没保存任何东西 ④重试入口。
 *
 * @param {object} env 视图环境（见 index.js makeEnv）
 * @param {string} groupId
 * @param {{code?:string, message?:string}} [info]
 * @returns {HTMLElement}
 */
export function groupUnavailable(env, groupId, info) {
  const t = env.t;
  const reason = info || env.offlineInfo || {};
  const code = reason.code ? String(reason.code) : 'UNREACHABLE';
  const node = banner(
    'danger',
    t('settings.offline.group-title', 'Unavailable: the local daemon is not running') +
      ' · ' +
      t('settings.group.' + String(groupId), humanize(groupId)),
    t('settings.offline.group-body', 'Nothing in this group can be read or written until the daemon answers ({code}). No value was changed and no default was invented.', {
      code: ' · '.concat(code, reason.message ? ': ' + String(reason.message) : ''),
    }),
    [
      button({
        label: t('settings.error.retry', 'Retry'),
        icon: 'refresh',
        size: 'sm',
        onClick: () => {
          if (typeof env.onRetryLoad === 'function') env.onRetryLoad();
        },
      }),
    ],
  );
  node.setAttribute('data-role', 'group-unavailable');
  node.setAttribute('data-group', String(groupId));
  node.setAttribute('data-code', code);
  return node;
}

/* ==========================================================================
 * 12. 界面偏好本地生效桥（无 daemon 也必须能改、能立刻看到效果）
 *
 * 为什么需要：主题/密度/语言/起始页由**外壳**（app.js）负责落 DOM，
 * 设置视图只是触发器。外壳把能力暴露在 `window.__AIDN__`
 * （setTheme / setLocale / store），不暴露 applyDensity / startView。
 * 因此：
 * - theme  → __AIDN__.setTheme（有则用），否则按 resolveTheme 直接落 data-theme；
 * - locale → __AIDN__.setLocale（会重渲染当前视图，不刷新页面）；
 * - density→ 直接落 body[data-density] + store.patch + 写 aidn.ui（等价 applyDensity）；
 * - startView → 只写 aidn.ui，并**如实回报外壳 0.0.1 不消费它**（不假装生效）。
 *
 * 所有键同时写 `aidn.ui`（store.js 的 writeUi，白名单键、不含敏感数据）。
 * ========================================================================== */

/** 取外壳句柄（app.js 的 window.__AIDN__）；取不到返回 null，绝不抛错。 */
export function shellHandle(ctx) {
  try {
    const win = (ctx && ctx.window) || (typeof window !== 'undefined' ? window : null);
    if (!win) return null;
    return win.__AIDN__ && typeof win.__AIDN__ === 'object' ? win.__AIDN__ : null;
  } catch {
    return null;
  }
}

function safeBody() {
  try {
    return typeof document !== 'undefined' ? document.body : null;
  } catch {
    return null;
  }
}

/**
 * 本地应用一组界面偏好（并写 aidn.ui）。同步返回实际效果，便于 UI 如实展示。
 *
 * @param {object} ctx 视图 ctx
 * @param {Record<string, string>} patch 例如 {theme:'dark', density:'compact'}
 * @param {{persist?: object|null}} [options] persist 缺省 = 同 patch
 * @returns {{applied: string[], skipped: Array<{key:string, reason:string}>, via: string, persisted: boolean}}
 */
export function applyLocalUiPrefs(ctx, patch, options) {
  const opts = options == null ? {} : options;
  const source = patch && typeof patch === 'object' ? patch : {};
  const applied = [];
  const skipped = [];
  const handle = shellHandle(ctx);
  const body = safeBody();

  if (typeof source.theme === 'string' && source.theme !== '') {
    try {
      if (handle && typeof handle.setTheme === 'function') {
        handle.setTheme(source.theme);
        applied.push('theme');
      } else if (body) {
        const result = resolveTheme(source.theme, { matchMedia: typeof window !== 'undefined' && window && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null });
        body.setAttribute('data-theme', result.resolved);
        applied.push('theme');
      } else {
        skipped.push({ key: 'theme', reason: 'NO_SHELL_AND_NO_DOM' });
      }
    } catch {
      skipped.push({ key: 'theme', reason: 'APPLY_FAILED' });
    }
  }

  if (typeof source.density === 'string' && source.density !== '') {
    const density = source.density === 'compact' ? 'compact' : 'comfortable';
    try {
      if (body) body.setAttribute('data-density', density);
      if (ctx && ctx.store && typeof ctx.store.patch === 'function') ctx.store.patch({ density });
      applied.push('density');
    } catch {
      skipped.push({ key: 'density', reason: 'APPLY_FAILED' });
    }
  }

  if (typeof source.locale === 'string' && source.locale !== '') {
    try {
      if (handle && typeof handle.setLocale === 'function') {
        // 不 await：调用方是同步的 change handler；外壳内部 await 后自行重渲染。
        Promise.resolve(handle.setLocale(source.locale)).catch(() => {});
        applied.push('locale');
      } else {
        skipped.push({ key: 'locale', reason: 'SHELL_LOCALE_UNAVAILABLE' });
      }
    } catch {
      skipped.push({ key: 'locale', reason: 'APPLY_FAILED' });
    }
  }

  if (typeof source.startView === 'string' && source.startView !== '') {
    // 外壳 0.0.1 不消费 startView（app.js 只读 theme/density/locale）→ 如实标注。
    skipped.push({ key: 'startView', reason: 'SHELL_IGNORES_START_VIEW_0_0_1' });
  }

  let persisted = false;
  try {
    const toPersist = opts.persist && typeof opts.persist === 'object' ? opts.persist : source;
    if (Object.keys(toPersist).length > 0) persisted = writeUi(toPersist) === true;
  } catch {
    persisted = false;
  }
  return { applied, skipped, via: handle ? 'shell' : 'fallback', persisted };
}

/**
 * 本地已生效的界面偏好（用于"无 daemon 时界面组初始值"）。
 * 顺序：aidn.ui → 外壳 store → 声明式默认值。
 */
export function readLocalUiPrefs(ctx) {
  const out = { theme: 'system', density: 'comfortable', locale: 'zh-CN', startView: 'overview' };
  try {
    const stored = readUi();
    for (const key of Object.keys(out)) {
      if (typeof stored[key] === 'string' && stored[key] !== '') out[key] = stored[key];
    }
  } catch {
    /* ignore */
  }
  try {
    const handle = shellHandle(ctx);
    const state = handle && handle.store && typeof handle.store.getState === 'function' ? handle.store.getState() : null;
    if (state) {
      if (state.theme && typeof state.theme.preference === 'string') out.theme = state.theme.preference;
      if (typeof state.density === 'string') out.density = state.density;
      if (state.i18n && typeof state.i18n.locale === 'string') out.locale = state.i18n.locale;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 界面组在**没有 schema**时使用的字段描述（与 daemon schema 的 ui 组同构）。
 * 只有这四个键由外壳消费；trayBehavior/autostart 不在其中（它们需要 daemon）。
 */
export function localUiItems() {
  return [
    { path: 'ui.theme', type: 'enum', values: ['system', 'dark', 'light'], default: 'system', appliesAt: 'immediate' },
    { path: 'ui.density', type: 'enum', values: ['comfortable', 'compact'], default: 'comfortable', appliesAt: 'immediate' },
    { path: 'ui.locale', type: 'enum', values: [...LOCALES], default: 'zh-CN', appliesAt: 'immediate' },
    {
      path: 'ui.startView',
      type: 'enum',
      values: ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'],
      default: 'overview',
      appliesAt: 'external',
    },
  ];
}

/* ==========================================================================
 * 13. 凭据事实（只回显掩码；strict 模式下**没有**可核对的指纹）
 * ========================================================================== */

/**
 * 凭据事实行：只渲染**真实存在**的字段，null 一律整行不渲染（禁止占位假值）。
 *
 * strict 曝光（FIX R5-003，apps/model-broker/bin/console-host.js:212）下
 * `credential = {masked:'••••', fingerprint:null, lengthBucket, updatedAt}`，
 * 即：产品能证明"存了一把长度落在 X 桶、更新时间 Y 的钥匙"，**不能**证明是哪一把。
 * 这里如实渲染，并在指纹缺失时给出说明，不编造 fingerprint。
 *
 * @param {Function} t
 * @param {object} facts providerFacts() 结果
 * @param {string} locale
 * @returns {{nodes: HTMLElement[], proof: 'fingerprint'|'masked-only'|'none'}}
 */
export function credentialFactNodes(t, facts, locale) {
  const nodes = [];
  const known = facts || {};
  if (!known.hasCredential) {
    return {
      nodes: [badge({ tone: 'neutral', text: t('settings.provider.credential-missing', 'No key stored') })],
      proof: 'none',
    };
  }
  nodes.push(badge({ tone: 'ok', text: t('settings.provider.credential-set', 'Key stored') }));
  if (known.masked) nodes.push(el('code', { class: 'mono', text: String(known.masked) }));
  if (known.lengthBucket) {
    nodes.push(
      el('span', {
        class: 'faint',
        text: t('settings.provider.length-bucket', 'Length: {value}', { value: String(known.lengthBucket) }),
      }),
    );
  }
  if (known.updatedAt) {
    nodes.push(
      el('span', {
        class: 'faint',
        text: t('settings.provider.updated-at', 'Updated: {at}', { at: formatTimestamp(known.updatedAt, locale) }),
      }),
    );
  }
  const fingerprint = typeof known.fingerprint === 'string' ? known.fingerprint.trim() : '';
  const proof = fingerprint === '' ? 'masked-only' : 'fingerprint';
  if (fingerprint !== '') {
    nodes.push(
      el('span', { class: 'faint' }, [
        el('span', { text: t('settings.provider.fingerprint', 'Fingerprint') + ': ' }),
        el('code', { class: 'mono', text: fingerprint.slice(0, 8) }),
      ]),
    );
  }
  return { nodes, proof };
}

/** provider 事实里的 fingerprint 是否可用（决定能否声称"同一把钥匙"）。 */
export function hasFingerprint(facts) {
  return Boolean(facts && typeof facts.fingerprint === 'string' && facts.fingerprint.trim() !== '');
}
