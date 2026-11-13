/**
 * B1 · drawer 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：drawer({title, body, onClose})（X/遮罩/Esc 三关 + focus trap）
 *
 * 行为契约：
 * 1. 三关关闭：标题栏 X、点击遮罩（overlay 自身）、Esc。
 * 2. focus trap：Tab/Shift+Tab 在面板内循环，不会落到背景页。
 * 3. 打开时焦点进入面板（首个可聚焦元素 = X）；关闭后焦点回到触发元素。
 * 4. 关闭只调用一次 onClose(reason)，reason ∈ 'close' | 'escape' | 'backdrop' | 'api'。
 * 5. [hidden] 由 CSS 兜底（base.css 的 [hidden]{display:none!important}），
 *    本组件关闭时直接移除节点，不存在"隐藏但仍占位"的状态。
 *
 * 返回 overlay 元素；额外挂载 .close(reason) 与 .isOpen（getter），供命令式关闭。
 */
import { el, icon } from './dom.js';
import { button } from './button.js';

let overlayOpenCount = 0;
let seq = 0;

const FOCUS_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A', 'AREA', 'SUMMARY']);

/** 节点是否在容器内（只用 parentNode 遍历，不依赖 querySelector/contains） */
function isInside(container, node) {
  let current = node;
  while (current) {
    if (current === container) return true;
    current = current.parentNode;
  }
  return false;
}

/** 遍历 childNodes 收集可聚焦元素（不依赖 querySelector，便于 B11 的 DOM shim） */
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

export function drawer(options) {
  const opts = options == null ? {} : options;
  const title = opts.title == null ? '' : String(opts.title);
  const closeLabel = opts.closeLabel == null ? 'Close' : String(opts.closeLabel);
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
  const body = opts.body == null ? null : opts.body;

  const id = 'ui-drawer-' + (seq += 1);
  const titleId = id + '-title';
  const previousActive = document.activeElement;
  const overlay = el('div', { class: 'ui-drawer', data: { overlay: 'drawer' } });
  let closed = false;

  const closeButton = button({
    icon: 'close',
    variant: 'ghost',
    ariaLabel: closeLabel,
    title: closeLabel,
    onClick: () => close('close'),
  });
  closeButton.classList.add('ui-drawer__close');

  const panel = el(
    'div',
    {
      class: 'ui-drawer__panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': title ? titleId : null,
      'aria-label': title ? null : closeLabel,
      tabIndex: -1,
    },
    [
      el('div', { class: 'ui-drawer__head' }, [
        title ? el('h2', { class: 'ui-drawer__title', id: titleId, text: title }) : null,
        closeButton,
      ]),
      el('div', { class: 'ui-drawer__body' }, body),
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

  const root = document.getElementById('drawer-root') || document.body;
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
