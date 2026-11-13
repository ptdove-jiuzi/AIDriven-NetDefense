/**
 * B1 · toast 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：toast({kind, text, actionLabel, onAction, ttl}) + toastHost(root)
 *
 * - 播报走宿主的 aria-live="polite"（不打断读屏）；单条不再是 live region。
 * - ttl 毫秒后自动消失（ttl<=0 表示常驻）；指针悬停/聚焦时暂停计时。
 * - Esc 可关闭（键盘用户不必等计时）。
 */
import { el, icon } from './dom.js';

const KINDS = new Set(['info', 'ok', 'warn', 'danger']);
const KIND_ICON = { info: 'info', ok: 'check', warn: 'warning', danger: 'error' };

export function toast(options) {
  const opts = options == null ? {} : options;
  const kind = KINDS.has(opts.kind) ? opts.kind : 'info';
  const rawTtl = Number(opts.ttl);
  const ttl = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 6000;
  const textValue = opts.text == null ? '' : String(opts.text);
  const actionLabel = opts.actionLabel == null ? '' : String(opts.actionLabel);
  const onAction = typeof opts.onAction === 'function' ? opts.onAction : null;

  let timer = null;
  let closed = false;

  function dismiss() {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    node.remove();
  }

  function arm() {
    if (ttl <= 0 || closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(dismiss, ttl);
  }

  function pause() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  const actionButton = actionLabel
    ? el('button', {
        type: 'button',
        class: 'ui-toast__action',
        on: {
          click: () => {
            if (onAction) onAction();
            dismiss();
          },
        },
      }, [el('span', { text: actionLabel })])
    : null;

  const node = el(
    'div',
    {
      class: 'ui-toast',
      data: { kind },
      on: {
        pointerenter: pause,
        pointerleave: arm,
        focusin: pause,
        focusout: arm,
        keydown: (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            dismiss();
          }
        },
      },
    },
    [
      el('span', { class: 'ui-toast__icon' }, [icon(KIND_ICON[kind])]),
      el('span', { class: 'ui-toast__text', text: textValue }),
      actionButton,
    ],
  );

  arm();
  return node;
}

/**
 * toastHost(root) → { root, show(options), clear() }
 * root 可以是 #toast-root 元素或 id 字符串；缺省兜底 document.body。
 */
export function toastHost(root) {
  const resolved = typeof root === 'string' ? document.getElementById(root) : root;
  const target = resolved && typeof resolved.nodeType === 'number' ? resolved : document.body;
  target.classList.add('ui-toast-host');
  if (!target.getAttribute('aria-live')) target.setAttribute('aria-live', 'polite');
  if (!target.getAttribute('role')) target.setAttribute('role', 'status');
  return {
    root: target,
    show(options) {
      const node = toast(options);
      target.appendChild(node);
      return node;
    },
    clear() {
      target.replaceChildren();
    },
  };
}
