/**
 * B1 · button 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：button({label, variant, size, icon, onClick, disabled, busy, type})
 *
 * variant ∈ primary | secondary | ghost | danger
 * size    ∈ sm | md | lg
 * 无 label 时按图标按钮处理，可访问名取 ariaLabel → title → icon 名。
 */
import { el, icon as iconEl, cls } from './dom.js';

const VARIANTS = new Set(['primary', 'secondary', 'ghost', 'danger']);
const SIZES = new Set(['sm', 'md', 'lg']);

export function button(options) {
  const opts = options == null ? {} : options;
  const {
    label = '',
    ariaLabel = '',
    title = '',
    onClick = null,
    disabled = false,
    busy = false,
    type = 'button',
  } = opts;
  const variant = VARIANTS.has(opts.variant) ? opts.variant : 'secondary';
  const size = SIZES.has(opts.size) ? opts.size : 'md';
  const iconName = opts.icon || '';
  const iconOnly = !label && Boolean(iconName);
  const name = ariaLabel || title || (iconOnly ? String(iconName) : '');
  const isDisabled = Boolean(disabled) || Boolean(busy);
  const solidDanger = Boolean(opts.solid) && variant === 'danger';

  const node = el(
    'button',
    {
      type,
      class: cls('ui-btn', iconOnly ? 'ui-btn--icon' : ''),
      data: {
        variant,
        size,
        'icon-only': iconOnly ? 'true' : null,
      },
      attrs: solidDanger ? { 'data-solid': 'true' } : null,
      'aria-label': name || null,
      'aria-busy': busy ? 'true' : null,
      title: title || null,
      disabled: isDisabled,
      on: typeof onClick === 'function' ? { click: onClick } : null,
    },
    [
      busy ? iconEl('spinner') : iconName ? iconEl(iconName) : null,
      label ? el('span', { class: 'ui-btn__label', text: label }) : null,
    ],
  );
  if (busy) {
    const spinner = node.children[0];
    if (spinner) spinner.classList.add('ui-icon--spin');
  }
  return node;
}
