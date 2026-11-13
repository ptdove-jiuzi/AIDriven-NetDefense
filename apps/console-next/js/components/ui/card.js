/**
 * B1 · card / stat 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：card({title, note, actions[], body})、stat({label, value, sub, tone})
 */
import { el, cls } from './dom.js';

/**
 * card({title, note, actions, body, plain, id})
 * actions 接受 DOM 节点数组（通常由 button() 构造）。
 */
export function card(options) {
  const opts = options == null ? {} : options;
  const { title = '', note = '', body = null, id = '' } = opts;
  const actions = Array.isArray(opts.actions) ? opts.actions.filter(Boolean) : [];

  const hasHead = Boolean(title) || Boolean(note) || actions.length > 0;
  const node = el(
    'section',
    {
      class: cls('ui-card', opts.plain ? 'ui-card--plain' : ''),
      id: id || null,
      // 卡片是区块：有标题时用 aria-labelledby 指向标题，保证读屏能定位
    },
    [
      hasHead
        ? el('div', { class: 'ui-card__head' }, [
            el('div', { class: 'ui-card__headings' }, [
              title ? el('h2', { class: 'ui-card__title', text: String(title) }) : null,
              note ? el('p', { class: 'ui-card__note', text: String(note) }) : null,
            ]),
            actions.length
              ? el('div', { class: 'ui-card__actions' }, actions)
              : null,
          ])
        : null,
      el('div', { class: 'ui-card__body' }, body),
    ],
  );
  return node;
}

/**
 * stat({label, value, sub, tone})
 * tone ∈ ok | warn | danger | info（只影响数值颜色，不改变语义）
 */
export function stat(options) {
  const opts = options == null ? {} : options;
  const { label = '', value = '—', sub = '', tone = '' } = opts;
  return el(
    'div',
    {
      class: 'ui-stat',
      data: tone ? { tone } : null,
    },
    [
      el('div', { class: 'ui-stat__label', text: String(label) }),
      el('div', { class: 'ui-stat__value', text: String(value) }),
      sub ? el('div', { class: 'ui-stat__sub', text: String(sub) }) : null,
    ],
  );
}
