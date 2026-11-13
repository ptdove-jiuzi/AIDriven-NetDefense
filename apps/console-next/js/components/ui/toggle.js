/**
 * B1 · toggle 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：toggle({checked, onChange, label, disabled})
 * 语义：<button type="button" role="switch" aria-checked="true|false">，
 * 原生按钮保证 Space/Enter 可切换，Tab 顺序=视觉顺序。
 */
import { el } from './dom.js';

export function toggle(options) {
  const opts = options == null ? {} : options;
  const { onChange = null, label = '', disabled = false, id = '' } = opts;
  const checked = Boolean(opts.checked);

  const node = el(
    'button',
    {
      type: 'button',
      id: id || null,
      class: 'ui-switch',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      disabled: Boolean(disabled),
      on: {
        click: () => {
          if (node.disabled) return;
          const next = node.getAttribute('aria-checked') !== 'true';
          node.setAttribute('aria-checked', next ? 'true' : 'false');
          if (typeof onChange === 'function') onChange(next);
        },
      },
    },
    [
      el('span', { class: 'ui-switch__track', 'aria-hidden': 'true' }),
      label ? el('span', { class: 'ui-switch__label', text: String(label) }) : null,
    ],
  );
  return node;
}
