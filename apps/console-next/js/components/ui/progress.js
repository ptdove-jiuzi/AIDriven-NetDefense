/**
 * B1 · progress 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：progress({value, max, label})
 * value 为 null/undefined → 不确定态（indeterminate），此时不写 aria-valuenow。
 */
import { el } from './dom.js';

export function progress(options) {
  const opts = options == null ? {} : options;
  const label = opts.label == null ? '' : String(opts.label);
  const rawMax = Number(opts.max);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 100;
  const rawValue = opts.value;
  const indeterminate = rawValue == null || !Number.isFinite(Number(rawValue));
  const value = indeterminate ? 0 : Number(rawValue);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const rounded = Math.round(pct * 10) / 10;

  const node = el(
    'div',
    {
      class: 'ui-progress',
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': max,
      'aria-valuenow': indeterminate ? null : value,
      'aria-label': label || null,
      data: {
        indeterminate: indeterminate ? 'true' : null,
        tone: opts.tone || null,
      },
      style: { '--progress-value': String(rounded) },
    },
    [
      label
        ? el('div', { class: 'ui-progress__head' }, [
            el('span', { text: label }),
            el('span', {
              class: 'ui-progress__value',
              text: indeterminate ? '—' : Math.round(pct) + '%',
            }),
          ])
        : null,
      el('div', { class: 'ui-progress__track' }, [
        el('div', { class: 'ui-progress__bar' }),
      ]),
    ],
  );
  return node;
}
