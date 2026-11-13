/**
 * B1 · segmented 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：segmented({options, value, onChange})（role="radiogroup"）
 *
 * 键盘：←/↑ 上一项，→/↓ 下一项，Home/End 首尾；roving tabindex（只有选中项可 Tab 到）。
 */
import { el } from './dom.js';

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((item) => {
    if (typeof item === 'string') return { value: item, label: item };
    const value = item && item.value != null ? String(item.value) : '';
    return {
      value,
      label: item && item.label != null ? item.label : value,
      disabled: Boolean(item && item.disabled),
    };
  });
}

export function segmented(options) {
  const opts = options == null ? {} : options;
  const items = normalizeOptions(opts.options);
  const { onChange = null, ariaLabel = '' } = opts;
  let current = opts.value == null ? '' : String(opts.value);
  if (!items.some((item) => item.value === current) && items.length) {
    current = items[0].value;
  }

  const buttons = items.map((item) =>
    el('button', {
      type: 'button',
      class: 'ui-segmented__item',
      role: 'radio',
      'aria-checked': 'false',
      tabIndex: -1,
      disabled: item.disabled,
      data: { value: item.value },
      on: {
        click: () => choose(item.value, true),
      },
    }, [item.label == null ? '' : String(item.label)]),
  );

  const node = el(
    'div',
    {
      class: 'ui-segmented',
      role: 'radiogroup',
      'aria-label': ariaLabel || null,
      on: { keydown: onKeydown },
    },
    buttons,
  );

  function sync() {
    buttons.forEach((btn) => {
      const on = btn.getAttribute('data-value') === current;
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
  }

  function choose(value, notify) {
    current = String(value);
    sync();
    if (notify && typeof onChange === 'function') onChange(current);
  }

  function enabledIndexes() {
    return buttons
      .map((btn, index) => ({ btn, index }))
      .filter((entry) => !entry.btn.disabled)
      .map((entry) => entry.index);
  }

  function onKeydown(event) {
    const usable = enabledIndexes();
    if (!usable.length) return;
    const active = buttons.indexOf(document.activeElement);
    const pos = usable.indexOf(active);
    let nextPos = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextPos = pos < 0 ? 0 : (pos + 1) % usable.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextPos = pos <= 0 ? usable.length - 1 : pos - 1;
    } else if (event.key === 'Home') {
      nextPos = 0;
    } else if (event.key === 'End') {
      nextPos = usable.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const target = buttons[usable[nextPos]];
    target.focus();
    choose(target.getAttribute('data-value'), true);
  }

  sync();
  return node;
}
