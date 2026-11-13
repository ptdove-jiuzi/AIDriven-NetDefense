/**
 * B1 · select 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6：select({options, value, onChange, placeholder})
 *
 * 刻意使用原生 <select>：零 JS 维护、键盘/读屏行为由浏览器保证，
 * 选项浮层由系统绘制（配色随 color-scheme token 走）。
 */
import { el } from './dom.js';

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((item, index) => {
    if (typeof item === 'string') return { value: item, label: item };
    const source = item == null ? {} : item;
    return {
      value: source.value == null ? 'option-' + index : String(source.value),
      label: source.label == null ? String(source.value ?? '') : source.label,
      disabled: Boolean(source.disabled),
    };
  });
}

export function select(options) {
  const opts = options == null ? {} : options;
  const items = normalizeOptions(opts.options);
  const { onChange = null, placeholder = '', id = '', name = '', disabled = false, ariaLabel = '' } = opts;

  const children = [];
  if (placeholder) {
    children.push(
      el('option', {
        value: '',
        disabled: true,
        text: String(placeholder),
      }),
    );
  }
  for (const item of items) {
    children.push(el('option', { value: item.value, disabled: item.disabled, text: String(item.label) }));
  }

  const node = el(
    'select',
    {
      class: 'ui-select',
      id: id || null,
      name: name || null,
      'aria-label': ariaLabel || null,
      disabled: Boolean(disabled),
      on:
        typeof onChange === 'function'
          ? {
              change: () => onChange(node.value),
            }
          : null,
    },
    children,
  );

  const initial = opts.value == null ? '' : String(opts.value);
  if (initial !== '') {
    const exists = items.some((item) => item.value === initial);
    node.value = exists ? initial : '';
  } else if (placeholder) {
    node.value = '';
  } else if (items.length) {
    node.value = items[0].value;
  }
  return node;
}
