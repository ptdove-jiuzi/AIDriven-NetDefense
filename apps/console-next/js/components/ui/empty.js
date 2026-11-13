/**
 * B1 · empty 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：empty({title, body, actionLabel, onAction})
 * 文案由调用方用 i18n key 解析后传入；组件不写死语言。
 */
import { el, icon } from './dom.js';
import { button } from './button.js';

export function empty(options) {
  const opts = options == null ? {} : options;
  const { title = '', body = '', actionLabel = '', onAction = null, iconName = 'info' } = opts;
  const hasAction = Boolean(actionLabel) && typeof onAction === 'function';
  return el('div', { class: 'ui-empty', role: 'status' }, [
    el('div', { class: 'ui-empty__icon' }, [icon(iconName)]),
    title ? el('p', { class: 'ui-empty__title', text: String(title) }) : null,
    body ? el('p', { class: 'ui-empty__body', text: String(body) }) : null,
    hasAction
      ? el('div', { class: 'ui-empty__action' }, [
          button({ label: String(actionLabel), variant: 'secondary', onClick: onAction }),
        ])
      : null,
  ]);
}
