/**
 * B1 · skeleton 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：skeleton({lines, height})
 * 加载占位是纯装饰：aria-hidden，语义状态由容器 aria-busy 表达。
 */
import { el } from './dom.js';

export function skeleton(options) {
  const opts = options == null ? {} : options;
  const rawLines = Number(opts.lines);
  const lines = Number.isFinite(rawLines) && rawLines > 0 ? Math.min(Math.floor(rawLines), 40) : 3;
  const rawHeight = Number(opts.height);
  const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 12;

  const children = [];
  for (let i = 0; i < lines; i += 1) {
    children.push(el('div', { class: 'ui-skeleton__line', 'aria-hidden': 'true' }));
  }
  return el(
    'div',
    {
      class: 'ui-skeleton',
      'aria-hidden': 'true',
      style: { '--skeleton-h': height + 'px' },
    },
    children,
  );
}
