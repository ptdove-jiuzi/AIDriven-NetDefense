/**
 * B1 · tabs 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：tabs({items:[{id,label,badge}], active, onChange})（roving tabindex）
 *
 * 键盘：←/↑ 上一项，→/↓ 下一项，Home/End 首尾；点击/键盘都触发 onChange(id)。
 * 面板由调用方渲染，本组件只负责 tablist 本体（aria-controls 由调用方补）。
 */
import { el, cls } from './dom.js';

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const source = item == null ? {} : item;
    const id = source.id == null ? 'tab-' + index : String(source.id);
    return {
      id,
      label: source.label == null ? id : source.label,
      badge: source.badge == null ? null : source.badge,
      disabled: Boolean(source.disabled),
    };
  });
}

export function tabs(options) {
  const opts = options == null ? {} : options;
  const items = normalizeItems(opts.items);
  const { onChange = null, ariaLabel = '' } = opts;
  let active = opts.active == null ? '' : String(opts.active);
  if (!items.some((item) => item.id === active) && items.length) {
    active = items.find((item) => !item.disabled)?.id || items[0].id;
  }

  const buttons = items.map((item) =>
    el('button', {
      type: 'button',
      class: 'ui-tab',
      role: 'tab',
      id: 'ui-tab-' + item.id,
      'aria-selected': 'false',
      tabIndex: -1,
      disabled: item.disabled,
      data: { tab: item.id },
      on: {
        click: () => choose(item.id, true),
      },
    }, [
      el('span', { text: String(item.label) }),
      item.badge == null
        ? null
        : typeof item.badge === 'object' && typeof item.badge.nodeType === 'number'
          ? item.badge
          : el('span', {
              class: cls('ui-badge', 'ui-badge--dotless'),
              data: { tone: 'accent' },
              text: String(item.badge),
            }),
    ]),
  );

  const node = el(
    'div',
    {
      class: 'ui-tabs',
      role: 'tablist',
      'aria-label': ariaLabel || null,
      on: { keydown: onKeydown },
    },
    buttons,
  );

  function sync() {
    buttons.forEach((btn) => {
      const on = btn.getAttribute('data-tab') === active;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
  }

  function choose(id, notify) {
    active = String(id);
    sync();
    if (notify && typeof onChange === 'function') onChange(active);
  }

  function usableIndexes() {
    return buttons.map((btn, index) => index).filter((index) => !buttons[index].disabled);
  }

  function onKeydown(event) {
    const usable = usableIndexes();
    if (!usable.length) return;
    const pos = usable.indexOf(buttons.indexOf(document.activeElement));
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
    choose(target.getAttribute('data-tab'), true);
  }

  sync();
  return node;
}
