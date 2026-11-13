/**
 * B1 · badge / severityBadge / statusBadge（纯函数返回 DOM，零依赖）
 * 合同 §7.6：badge({tone, text})；严重度/状态专用 severityBadge()、statusBadge()
 *
 * tone ∈ neutral | accent | ok | warn | danger | info
 *        | critical | high | medium | low（严重度沿用同一套 token）
 * 文本由调用方传入（i18n 由 B10/B2 负责），组件不写死任何语言文案。
 */
import { el, cls } from './dom.js';

const TONES = new Set([
  'neutral',
  'accent',
  'ok',
  'warn',
  'danger',
  'info',
  'critical',
  'high',
  'medium',
  'low',
]);

/** badge({tone, text, dot}) → <span class="ui-badge"> */
export function badge(options) {
  const opts = options == null ? {} : options;
  const tone = TONES.has(opts.tone) ? opts.tone : 'neutral';
  const content = opts.text == null ? '' : String(opts.text);
  return el(
    'span',
    {
      class: cls('ui-badge', tone === 'neutral' ? 'ui-badge--dotless' : ''),
      data: { tone },
      title: opts.title || null,
    },
    [
      tone === 'neutral' ? null : el('span', { class: 'ui-badge__dot', 'aria-hidden': 'true' }),
      el('span', { text: content }),
    ],
  );
}

const SEVERITY_TONE = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'info-sev',
};

/**
 * severityBadge(severity, label)
 * severity 为后端枚举；label 为本地化文案（缺省回落到枚举原值，不编造中文）。
 */
export function severityBadge(severity, label) {
  const key = String(severity == null ? '' : severity).toLowerCase();
  const tone = SEVERITY_TONE[key] || 'neutral';
  return badge({ tone, text: label == null ? key || '—' : label });
}

const STATUS_TONE = {
  new: 'accent',
  open: 'warn',
  acknowledged: 'info',
  investigating: 'info',
  resolved: 'ok',
  closed: 'neutral',
  suppressed: 'neutral',
  ignored: 'neutral',
  pending: 'warn',
  active: 'ok',
  disabled: 'neutral',
};

/** statusBadge(status, label) */
export function statusBadge(status, label) {
  const key = String(status == null ? '' : status).toLowerCase();
  const tone = STATUS_TONE[key] || 'neutral';
  return badge({ tone, text: label == null ? key || '—' : label });
}
