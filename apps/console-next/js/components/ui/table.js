/**
 * B1 · table 组件（纯函数返回 DOM，零依赖）
 * 合同 §7.6 / §7.6 表格决策：虚拟滚动（不是分页）
 *
 * table({columns, rows, rowKey, sort, onSort, virtual, loading, empty, onRowClick})
 *   columns: [{key, label, width, align, sortable, render(row, value), mono}]
 *   sort:    {key, dir:'asc'|'desc'} | null
 *   onSort:  ({key, dir}) => void
 *   rowKey:  (row, index) => string|number（缺省 row.id ?? index）
 *   virtual: false 强制全渲染；缺省按 threshold 决策
 *   loading: true → 骨架行 + aria-busy
 *   empty:   DOM 节点 | 字符串（作为 empty 标题）| empty() 的参数对象
 *
 * 虚拟滚动契约（可被 demo/B11 断言）：
 * - threshold = 200：rows.length < 200 → 全渲染；≥ 200 → 只渲染可视窗 + overscan。
 * - 保留真实 <table> 语义；上下用 aria-hidden 的垫片 <tr> 占位，行高固定。
 * - 每行写 data-row / aria-rowindex，表格有 aria-rowcount（含表头行）。
 * - 5000 行时实际 DOM 行数 = 可视行 + 2*overscan + 2 垫片，远小于 300。
 */
import { el, frag, icon } from './dom.js';
import { skeleton } from './skeleton.js';
import { empty as emptyState } from './empty.js';

const VIRTUAL_THRESHOLD = 200;
const OVERSCAN = 6;
const DEFAULT_ROW_H = 40;
const FALLBACK_VISIBLE_ROWS = 16;

function normalizeColumns(columns) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map((column) => {
      if (typeof column === 'string') return { key: column, label: column };
      if (!column || column.key == null) return null;
      return {
        key: String(column.key),
        label: column.label == null ? String(column.key) : column.label,
        width: column.width == null ? null : column.width,
        align: column.align === 'right' || column.align === 'center' ? column.align : '',
        sortable: Boolean(column.sortable),
        mono: Boolean(column.mono),
        render: typeof column.render === 'function' ? column.render : null,
      };
    })
    .filter(Boolean);
}

function resolveEmpty(spec) {
  if (spec && typeof spec.nodeType === 'number') return spec;
  if (typeof spec === 'string') return emptyState({ title: spec });
  if (spec && typeof spec === 'object') return emptyState(spec);
  return emptyState({ title: '' });
}

function defaultRowKey(row, index) {
  if (row && row.id != null) return String(row.id);
  return String(index);
}

function cellContent(column, row) {
  const value = row == null ? undefined : row[column.key];
  if (column.render) return column.render(row, value);
  if (value == null || value === '') return '—';
  return String(value);
}

export function table(options) {
  const opts = options == null ? {} : options;
  const columns = normalizeColumns(opts.columns);
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  const loading = Boolean(opts.loading);
  const rowKey = typeof opts.rowKey === 'function' ? opts.rowKey : defaultRowKey;
  const onRowClick = typeof opts.onRowClick === 'function' ? opts.onRowClick : null;
  const onSort = typeof opts.onSort === 'function' ? opts.onSort : null;
  const sort =
    opts.sort && opts.sort.key != null && opts.sort.key !== ''
      ? { key: String(opts.sort.key), dir: opts.sort.dir === 'desc' ? 'desc' : 'asc' }
      : null;
  const useVirtual = opts.virtual !== false && !loading && rows.length >= VIRTUAL_THRESHOLD;
  const rowHeight =
    Number.isFinite(Number(opts.rowHeight)) && Number(opts.rowHeight) > 0
      ? Number(opts.rowHeight)
      : DEFAULT_ROW_H;
  const ariaLabel = opts.ariaLabel == null ? '' : String(opts.ariaLabel);
  const colCount = Math.max(1, columns.length);

  const tableEl = el('table', {
    class: 'ui-table__el',
    'aria-label': ariaLabel || null,
    'aria-rowcount': useVirtual ? rows.length + 1 : null,
  });
  if (opts.caption) tableEl.appendChild(el('caption', { text: String(opts.caption) }));
  if (columns.some((column) => column.width != null)) {
    tableEl.appendChild(
      el(
        'colgroup',
        null,
        columns.map((column) =>
          el('col', {
            style: column.width == null ? null : { '--col-w': String(column.width) },
          }),
        ),
      ),
    );
  }

  const thead = el('thead');
  const headRow = el('tr');
  for (const column of columns) {
    const sorted = Boolean(sort) && sort.key === column.key;
    let ariaSort = null;
    if (column.sortable && onSort) {
      ariaSort = sorted ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none';
    }
    const th = el('th', {
      scope: 'col',
      'aria-sort': ariaSort,
      data: { align: column.align || null },
    });
    if (column.sortable && onSort) {
      const sortIcon = sorted ? (sort.dir === 'desc' ? 'arrow-down' : 'arrow-up') : 'sort';
      th.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'ui-table__sort',
            data: { sort: column.key },
            on: {
              click: () => {
                const nextDir = sorted && sort.dir === 'asc' ? 'desc' : 'asc';
                onSort({ key: column.key, dir: nextDir });
              },
            },
          },
          [el('span', { text: String(column.label) }), icon(sortIcon)],
        ),
      );
    } else {
      th.appendChild(el('span', { text: String(column.label) }));
    }
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = el('tbody');
  tableEl.appendChild(tbody);

  const scroll = el('div', {
    class: 'ui-table__scroll',
    tabIndex: useVirtual ? 0 : null,
    role: useVirtual ? 'region' : null,
    'aria-label': useVirtual ? ariaLabel || null : null,
    'aria-busy': loading ? 'true' : null,
  });
  scroll.appendChild(tableEl);

  const node = el(
    'div',
    {
      class: 'ui-table',
      data: { virtual: useVirtual ? 'true' : 'false', rows: String(rows.length) },
    },
    [scroll],
  );

  let measuredRowH = 0;
  let windowStart = -1;
  let windowEnd = -1;

  function buildRow(row, index) {
    const cells = columns.map((column) => {
      const content = cellContent(column, row);
      return el('td', {
        data: {
          align: column.align || null,
          mono: column.mono ? 'true' : null,
        },
      }, content);
    });
    const key = rowKey(row, index);
    const rowNode = el(
      'tr',
      {
        data: { row: 'true', key: String(key), index: String(index) },
        'aria-rowindex': useVirtual ? index + 2 : null,
        tabIndex: onRowClick ? 0 : null,
        on: onRowClick
          ? {
              click: () => onRowClick(row, index),
              keydown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onRowClick(row, index);
                }
              },
            }
          : null,
      },
      cells,
    );
    if (onRowClick) rowNode.setAttribute('data-clickable', 'true');
    return rowNode;
  }

  function padRow(pixels) {
    return el('tr', { class: 'ui-table__pad', 'aria-hidden': 'true' }, [
      el('td', {
        colSpan: colCount,
        style: { '--pad-h': Math.max(0, Math.round(pixels)) + 'px' },
      }),
    ]);
  }

  function renderWindow(start, end) {
    const chunk = frag();
    for (let index = start; index < end; index += 1) {
      chunk.appendChild(buildRow(rows[index], index));
    }
    const padTop = start > 0 ? padRow(start * getRowHeight()) : null;
    const padBottom = end < rows.length ? padRow((rows.length - end) * getRowHeight()) : null;
    const children = [padTop, chunk, padBottom].filter(Boolean);
    tbody.replaceChildren(...children);
    windowStart = start;
    windowEnd = end;
  }

  function getRowHeight() {
    if (measuredRowH > 0) return measuredRowH;
    for (let i = 0; i < tbody.childNodes.length; i += 1) {
      const child = tbody.childNodes[i];
      if (child.nodeType === 1 && child.getAttribute('data-row') === 'true') {
        const rect = typeof child.getBoundingClientRect === 'function' ? child.getBoundingClientRect() : null;
        const height = (rect && rect.height) || child.offsetHeight || 0;
        if (height > 0) {
          measuredRowH = height;
          return height;
        }
      }
    }
    return rowHeight;
  }

  function visibleCount() {
    const height = scroll.clientHeight || 0;
    if (height <= 0) return FALLBACK_VISIBLE_ROWS;
    return Math.max(3, Math.ceil(height / getRowHeight()));
  }

  function updateVirtualWindow() {
    const rh = getRowHeight();
    const first = Math.max(0, Math.floor(scroll.scrollTop / rh) - OVERSCAN);
    const last = Math.min(rows.length, first + visibleCount() + OVERSCAN * 2);
    if (first === windowStart && last === windowEnd) return;
    renderWindow(first, last);
  }

  // ---------- 状态：loading / empty / 数据 ----------
  if (loading) {
    const holder = el('div', { class: 'ui-table__state' }, [skeleton({ lines: 6, height: 14 })]);
    tbody.replaceChildren(
      el('tr', null, [el('td', { colSpan: colCount }, [holder])]),
    );
  } else if (rows.length === 0) {
    const holder = el('div', { class: 'ui-table__state' }, [resolveEmpty(opts.empty)]);
    tbody.replaceChildren(
      el('tr', null, [el('td', { colSpan: colCount }, [holder])]),
    );
  } else if (useVirtual) {
    renderWindow(0, Math.min(rows.length, visibleCount() + OVERSCAN * 2));
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
    let scheduled = 0;
    scroll.addEventListener(
      'scroll',
      () => {
        if (scheduled) return;
        scheduled = raf(() => {
          scheduled = 0;
          updateVirtualWindow();
        });
      },
      { passive: true },
    );
    // 首帧后量一次真实行高：density 变化会改 CSS 行高，这里以真实布局为准
    raf(() => {
      measuredRowH = 0;
      getRowHeight();
      updateVirtualWindow();
    });
  } else {
    renderWindow(0, rows.length);
  }

  return node;
}
