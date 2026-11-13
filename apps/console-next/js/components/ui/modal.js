/**
 * B1 · modal 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：modal({title, body, actions, onClose, destructive})（Esc/遮罩 + focus trap）
 *
 * 三关关闭：标题栏 X、点击遮罩、Esc（与 drawer 同一套语义）。
 * 初始焦点刻意落在 X 而不是主操作按钮：destructive 弹窗不应让回车键直接执行破坏性动作。
 * 返回 overlay 元素；额外挂载 .close(reason) 与 .isOpen（getter）。
 */
import { el } from './dom.js';
import { button } from './button.js';

let overlayOpenCount = 0;
let seq = 0;

const FOCUS_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'AREA', 'SUMMARY']);

function collectFocusable(root) {
  const out = [];
  const walk = (parent) => {
    if (!parent || !parent.childNodes) return;
    for (let i = 0; i < parent.childNodes.length; i += 1) {
      const child = parent.childNodes[i];
      if (!child || child.nodeType !== 1) continue;
      if (child.hasAttribute && (child.hasAttribute('hidden') || child.getAttribute('aria-hidden') === 'true')) {
        continue;
      }
      const tabindex = child.getAttribute ? child.getAttribute('tabindex') : null;
      const disabled =
        child.disabled === true ||
        (child.getAttribute ? child.getAttribute('disabled') != null || child.getAttribute('aria-disabled') === 'true' : false);
      let focusable = false;
      if (!disabled && tabindex !== '-1') {
        if (FOCUS_TAGS.has(child.tagName)) {
          focusable = child.tagName !== 'A' || Boolean(child.getAttribute('href'));
          focusable = child.tagName !== 'AREA' || Boolean(child.getAttribute('href'));
        } else if (tabindex != null) {
          focusable = true;
        }
      }
      if (focusable) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** 节点是否在容器内（只用 parentNode 遍历，不依赖 querySelector/contains） */
function isInside(container, node) {
  let current = node;
  while (current) {
    if (current === container) return true;
    current = current.parentNode;
  }
  return false;
}

export function modal(options) {
  const opts = options == null ? {} : options;
  const title = opts.title == null ? '' : String(opts.title);
  const closeLabel = opts.closeLabel == null ? 'Close' : String(opts.closeLabel);
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  const destructive = Boolean(opts.destructive);
  const actionItems = Array.isArray(opts.actions) ? opts.actions.filter(Boolean) : [];
  const body = opts.body == null ? null : opts.body;

  const id = 'ui-modal-' + (seq += 1);
  const titleId = id + '-title';
  const previousActive = document.activeElement;
  const overlay = el('div', { class: 'ui-modal', data: { overlay: 'modal' } });
  let closed = false;

  const closeButton = button({
    icon: 'close',
    variant: 'ghost',
    ariaLabel: closeLabel,
    title: closeLabel,
    onClick: () => close('close'),
  });
  closeButton.classList.add('ui-modal__close');

  const footChildren = [];
  for (const item of actionItems) {
    if (item && typeof item.nodeType === 'number') {
      footChildren.push(item);
      continue;
    }
    const action = item == null ? {} : item;
    footChildren.push(
      button({
        label: action.label == null ? '' : String(action.label),
        variant: action.variant || 'secondary',
        disabled: Boolean(action.disabled),
        busy: Boolean(action.busy),
        onClick: () => {
          if (typeof action.onClick === 'function') action.onClick();
          if (action.closeOnClick !== false) close('action');
        },
      }),
    );
  }

  const panel = el(
    'div',
    {
      class: 'ui-modal__panel',
      role: destructive ? 'alertdialog' : 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': title ? titleId : null,
      'aria-label': title ? null : closeLabel,
      'aria-describedby': opts.bodyId ? String(opts.bodyId) : null,
      data: { destructive: destructive ? 'true' : null },
      tabIndex: -1,
    },
    [
      el('div', { class: 'ui-modal__head' }, [
        title ? el('h2', { class: 'ui-modal__title', id: titleId, text: title }) : null,
        closeButton,
      ]),
      el('div', { class: 'ui-modal__body' }, body),
      footChildren.length ? el('div', { class: 'ui-modal__foot' }, footChildren) : null,
    ],
  );
  overlay.appendChild(panel);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close('backdrop');
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close('escape');
      return;
    }
    if (event.key !== 'Tab') return;
    const items = collectFocusable(panel);
    if (!items.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!isInside(panel, active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const root = document.getElementById('modal-root') || document.body;
  root.appendChild(overlay);
  overlayOpenCount += 1;
  document.documentElement.classList.add('ui-scroll-lock');
  const initial = collectFocusable(panel);
  if (initial.length) initial[0].focus();
  else panel.focus();

  function close(reason) {
    if (closed) return;
    closed = true;
    overlay.remove();
    overlayOpenCount = Math.max(0, overlayOpenCount - 1);
    if (overlayOpenCount === 0) document.documentElement.classList.remove('ui-scroll-lock');
    if (previousActive && previousActive.isConnected && typeof previousActive.focus === 'function') {
      previousActive.focus();
    }
    if (onClose) onClose(reason || 'close');
  }

  overlay.close = close;
  Object.defineProperty(overlay, 'isOpen', {
    get: () => !closed,
    configurable: true,
  });
  return overlay;
}
