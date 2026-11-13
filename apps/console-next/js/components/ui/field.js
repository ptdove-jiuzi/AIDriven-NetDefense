/**
 * B1 · field / input / textarea / checkbox / secretInput（纯函数返回 DOM，零依赖）
 * 合同 §7.6：field({label, hint, error, control})、input()、textarea()、checkbox()、secretInput()
 *
 * 约定：
 * - 所有文案（label/hint/error/placeholder/ariaLabel）由调用方用 i18n 解析后传入。
 * - field 会自动把 label 的 for、control 的 aria-describedby/aria-invalid 接好；
 *   control 是 secretInput 这类包装元素时，自动定位内部第一个 INPUT/TEXTAREA/SELECT。
 * - 组件不写死任何语言文案；图标按钮的可访问名缺省用英文兜底（B7 会传本地化 label）。
 */
import { el, icon, cls } from './dom.js';

let uid = 0;
function nextId(prefix) {
  uid += 1;
  return 'ui-' + (prefix || 'field') + '-' + uid;
}

const FORM_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 找到 field 里真正接收焦点的表单控件（包装层也支持） */
function resolveControl(node) {
  if (!node || typeof node.nodeType !== 'number') return null;
  if (node.nodeType === 1 && FORM_TAGS.has(node.tagName)) return node;
  const stack = [node];
  while (stack.length) {
    const current = stack.shift();
    if (!current || !current.childNodes) continue;
    for (let i = 0; i < current.childNodes.length; i += 1) {
      const child = current.childNodes[i];
      if (child.nodeType !== 1) continue;
      if (FORM_TAGS.has(child.tagName)) return child;
      stack.push(child);
    }
  }
  return null;
}

/**
 * field({label, hint, error, control, required})
 * 返回 .ui-field 容器（label + control + hint + error）。
 */
export function field(options) {
  const opts = options == null ? {} : options;
  const { label = '', hint = '', error = '', required = false } = opts;
  const control = opts.control;
  const controlEl = control && typeof control.nodeType === 'number' ? control : null;
  const target = resolveControl(controlEl);

  let hintId = '';
  let errorId = '';
  if (target) {
    if (!target.id) target.id = nextId('control');
    const describedBy = [];
    if (hint && target.setAttribute) {
      hintId = target.id + '-hint';
      describedBy.push(hintId);
    }
    if (error && target.setAttribute) {
      errorId = target.id + '-error';
      describedBy.push(errorId);
    }
    if (describedBy.length) target.setAttribute('aria-describedby', describedBy.join(' '));
    if (error) target.setAttribute('aria-invalid', 'true');
    if (required) target.setAttribute('aria-required', 'true');
  }

  return el(
    'div',
    {
      class: 'ui-field',
      data: { invalid: error ? 'true' : null },
    },
    [
      label
        ? el(
            'label',
            {
              class: 'ui-field__label',
              for: target ? target.id : null,
            },
            [
              el('span', { text: String(label) }),
              required ? el('span', { class: 'ui-field__req', 'aria-hidden': 'true', text: '*' }) : null,
            ],
          )
        : null,
      controlEl,
      hint ? el('p', { class: 'ui-field__hint', id: hintId || null, text: String(hint) }) : null,
      error
        ? el('p', { class: 'ui-field__error', id: errorId || null, 'aria-live': 'polite', text: String(error) })
        : null,
    ],
  );
}

/** input({id,name,type,value,placeholder,disabled,readOnly,required,maxLength,autoComplete,onInput,onChange,ariaLabel,mono}) */
export function input(options) {
  const opts = options == null ? {} : options;
  const type = opts.type ? String(opts.type) : 'text';
  const listeners = {};
  if (typeof opts.onInput === 'function') listeners.input = opts.onInput;
  if (typeof opts.onChange === 'function') listeners.change = opts.onChange;
  if (typeof opts.onKeydown === 'function') listeners.keydown = opts.onKeydown;

  return el('input', {
    class: cls('ui-input', opts.mono ? 'ui-input--mono' : ''),
    id: opts.id || null,
    name: opts.name || null,
    type,
    value: opts.value == null ? '' : String(opts.value),
    placeholder: opts.placeholder || null,
    'aria-label': opts.ariaLabel || null,
    disabled: Boolean(opts.disabled),
    readOnly: Boolean(opts.readOnly),
    required: Boolean(opts.required),
    maxLength: opts.maxLength == null ? null : Number(opts.maxLength),
    min: opts.min == null ? null : opts.min,
    max: opts.max == null ? null : opts.max,
    step: opts.step == null ? null : opts.step,
    pattern: opts.pattern || null,
    autocomplete: opts.autoComplete || null,
    inputMode: opts.inputMode || null,
    spellcheck: opts.spellcheck === undefined ? null : Boolean(opts.spellcheck),
    on: Object.keys(listeners).length ? listeners : null,
  });
}

/** textarea({id,name,value,rows,placeholder,disabled,readOnly,onInput,onChange,ariaLabel}) */
export function textarea(options) {
  const opts = options == null ? {} : options;
  const listeners = {};
  if (typeof opts.onInput === 'function') listeners.input = opts.onInput;
  if (typeof opts.onChange === 'function') listeners.change = opts.onChange;
  const node = el('textarea', {
    class: cls('ui-textarea', opts.mono ? 'ui-input--mono' : ''),
    id: opts.id || null,
    name: opts.name || null,
    rows: opts.rows == null ? 4 : Number(opts.rows),
    placeholder: opts.placeholder || null,
    'aria-label': opts.ariaLabel || null,
    disabled: Boolean(opts.disabled),
    readOnly: Boolean(opts.readOnly),
    required: Boolean(opts.required),
    maxLength: opts.maxLength == null ? null : Number(opts.maxLength),
    on: Object.keys(listeners).length ? listeners : null,
  });
  if (opts.value != null) node.value = String(opts.value);
  return node;
}

/** checkbox({label, checked, onChange, disabled, name, value, id}) */
export function checkbox(options) {
  const opts = options == null ? {} : options;
  const { label = '', onChange = null } = opts;
  const box = el('input', {
    type: 'checkbox',
    id: opts.id || null,
    name: opts.name || null,
    value: opts.value == null ? null : String(opts.value),
    checked: Boolean(opts.checked),
    disabled: Boolean(opts.disabled),
    on:
      typeof onChange === 'function'
        ? {
            change: () => onChange(box.checked),
          }
        : null,
  });
  return el('label', { class: 'ui-checkbox', data: { disabled: opts.disabled ? 'true' : null } }, [
    box,
    el('span', { text: String(label) }),
  ]);
}

/**
 * secretInput({id,name,placeholder,onInput,onChange,disabled,autoComplete,showLabel,hideLabel,ariaLabel})
 * 返回包装层 .ui-secret（含 input[type=password] + 显示/隐藏切换按钮）。
 * 明文只存在于 input.value；不落 localStorage/日志，符合合同 §4。
 */
export function secretInput(options) {
  const opts = options == null ? {} : options;
  const showLabel = opts.showLabel || 'Show password';
  const hideLabel = opts.hideLabel || 'Hide password';
  const listeners = {};
  if (typeof opts.onInput === 'function') listeners.input = opts.onInput;
  if (typeof opts.onChange === 'function') listeners.change = opts.onChange;

  const inputEl = el('input', {
    class: 'ui-input ui-input--mono',
    id: opts.id || null,
    name: opts.name || null,
    type: 'password',
    placeholder: opts.placeholder || null,
    'aria-label': opts.ariaLabel || null,
    disabled: Boolean(opts.disabled),
    autocomplete: opts.autoComplete || 'off',
    spellcheck: false,
    on: Object.keys(listeners).length ? listeners : null,
  });

  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn--icon ui-secret__toggle',
      data: { variant: 'ghost', size: 'md', 'icon-only': 'true' },
      'aria-pressed': 'false',
      'aria-label': showLabel,
      title: showLabel,
      on: {
        click: () => {
          const reveal = inputEl.type === 'password';
          inputEl.type = reveal ? 'text' : 'password';
          toggle.setAttribute('aria-pressed', reveal ? 'true' : 'false');
          toggle.setAttribute('aria-label', reveal ? hideLabel : showLabel);
          toggle.setAttribute('title', reveal ? hideLabel : showLabel);
          toggle.replaceChildren(icon(reveal ? 'eye-off' : 'eye'));
          inputEl.focus();
        },
      },
    },
    [icon('eye')],
  );

  return el('div', { class: 'ui-secret' }, [inputEl, toggle]);
}
