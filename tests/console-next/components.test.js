/**
 * UI2-B11 · B1 组件独立测试（DOM shim 内真实构造）
 *
 * 目的：不重复 B1 自检，而是以**外部消费者**视角验证合同 §7.6/§7.7 的组件契约：
 * 三关关闭 / focus trap / 焦点回归 / 虚拟滚动 / 空态与 loading / aria / 禁用 API。
 *
 * 运行：`node --test tests/console-next/components.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installDom, makeEvent, serialize, visibleText, countElements } from './dom-shim.mjs';
import { el as domEl, icon, cls } from '../../apps/console-next/js/components/ui/dom.js';
import { button } from '../../apps/console-next/js/components/ui/button.js';
import { card, stat } from '../../apps/console-next/js/components/ui/card.js';
import { table } from '../../apps/console-next/js/components/ui/table.js';
import { drawer } from '../../apps/console-next/js/components/ui/drawer.js';
import { modal } from '../../apps/console-next/js/components/ui/modal.js';
import { toast, toastHost } from '../../apps/console-next/js/components/ui/toast.js';
import { tabs } from '../../apps/console-next/js/components/ui/tabs.js';
import { segmented } from '../../apps/console-next/js/components/ui/segmented.js';
import { toggle } from '../../apps/console-next/js/components/ui/toggle.js';
import { select } from '../../apps/console-next/js/components/ui/select.js';
import { field, input, secretInput } from '../../apps/console-next/js/components/ui/field.js';
import { badge, severityBadge, statusBadge } from '../../apps/console-next/js/components/ui/badge.js';
import { skeleton } from '../../apps/console-next/js/components/ui/skeleton.js';
import { empty } from '../../apps/console-next/js/components/ui/empty.js';
import { progress } from '../../apps/console-next/js/components/ui/progress.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(HERE, '../../apps/console-next/js/components/ui');

function withDom(t) {
  const dom = installDom();
  t.after(() => dom.cleanup());
  return dom;
}

function click(node) {
  node.dispatchEvent(makeEvent('click', { bubbles: true }));
}

function keydown(node, key, init = {}) {
  node.dispatchEvent(makeEvent('keydown', { key, bubbles: true, ...init }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// dom.js 纪律：禁用 prop / href 白名单
// ---------------------------------------------------------------------------

test('dom.el 拒绝 innerHTML 一类 prop（合同 §7.7）', (t) => {
  withDom(t);
  for (const prop of ['html', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'dangerouslySetInnerHTML']) {
    assert.throws(
      () => domEl('div', { [prop]: '<img onerror=alert(1)>' }),
      /禁止的 prop/u,
      `el() must reject ${prop}`,
    );
  }
});

test('dom.el href 白名单：http(s)/#/mailto 放行，javascript:/data: 降级为 #', (t) => {
  withDom(t);
  for (const ok of ['https://example.com/x', 'http://example.com/', '#/alerts', 'mailto:a@b.c']) {
    assert.equal(domEl('a', { href: ok }).getAttribute('href'), ok);
  }
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:x', 'java\nscript:alert(1)', 'relative/path']) {
    assert.equal(domEl('a', { href: bad }).getAttribute('href'), '#', `href ${bad} must be downgraded`);
  }
});

test('dom.el 只用 textContent 渲染文本：标签字符不被解释为节点', (t) => {
  withDom(t);
  const node = domEl('div', null, ['<b>not bold</b>', ' & <script>']);
  assert.equal(node.children.length, 0);
  assert.equal(visibleText(node), '<b>not bold</b> & <script>');
  assert.equal(serialize(node), '<div>&lt;b&gt;not bold&lt;/b&gt; &amp; &lt;script&gt;</div>');
  assert.ok(icon('bell').getAttribute('aria-hidden') === 'true');
  assert.equal(cls('a', { b: true, c: false }, ['d']), 'a b d');
});

test('组件源码不含禁用 API 调用（.innerHTML= / insertAdjacentHTML / document.write / eval / new Function）', () => {
  const files = fs.readdirSync(UI_DIR).filter((name) => name.endsWith('.js'));
  const pattern = /\.(?:innerHTML|outerHTML|innerText|outerText)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\(/u;
  const offenders = [];
  for (const name of files) {
    const source = fs.readFileSync(path.join(UI_DIR, name), 'utf8');
    if (pattern.test(source)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `forbidden DOM API used in: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// button / card / badge / skeleton / empty / progress
// ---------------------------------------------------------------------------

test('button：variant/size/disabled/busy/图标按钮可访问名/点击回调', (t) => {
  withDom(t);
  let clicks = 0;
  const primary = button({ label: '保存', variant: 'primary', size: 'lg', onClick: () => { clicks += 1; } });
  assert.equal(primary.tagName, 'BUTTON');
  assert.equal(primary.getAttribute('type'), 'button');
  assert.equal(primary.getAttribute('data-variant'), 'primary');
  assert.equal(primary.getAttribute('data-size'), 'lg');
  assert.match(primary.getAttribute('class'), /ui-btn/u);
  assert.equal(visibleText(primary), '保存');
  click(primary);
  assert.equal(clicks, 1);

  const disabled = button({ label: '删除', disabled: true, onClick: () => { clicks += 1; } });
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.getAttribute('aria-disabled'), null);

  const busy = button({ label: '运行中', busy: true });
  assert.equal(busy.disabled, true);
  assert.equal(busy.getAttribute('aria-busy'), 'true');
  assert.ok(busy.children[0].classList.contains('ui-icon--spin'));

  const iconOnly = button({ icon: 'close', ariaLabel: '关闭' });
  assert.equal(iconOnly.getAttribute('aria-label'), '关闭');
  assert.equal(iconOnly.getAttribute('data-icon-only'), 'true');
  assert.equal(iconOnly.getAttribute('title'), null);
});

test('card/stat：标题/说明/操作区/正文与 tone 属性', (t) => {
  withDom(t);
  const actions = [button({ label: '刷新' })];
  const body = domEl('p', { text: 'body text' });
  const node = card({ title: '模型与用量', note: '最近 24h', actions, body });
  assert.equal(visibleText(node), '模型与用量最近 24h刷新body text');
  assert.ok(node.getAttribute('class').includes('ui-card'));
  assert.equal(node.querySelector('.ui-card__title').getAttribute('class'), 'ui-card__title');

  const item = stat({ label: '告警', value: '12', sub: '较昨日 +3', tone: 'warn' });
  assert.equal(visibleText(item).includes('告警'), true);
  assert.equal(visibleText(item).includes('12'), true);
  assert.equal(item.getAttribute('data-tone'), 'warn');
});

test('skeleton/empty/progress：空态与 aria 语义', (t) => {
  withDom(t);
  const loading = skeleton({ lines: 3, height: 12 });
  assert.equal(loading.getAttribute('aria-hidden'), 'true');
  assert.equal(loading.children.length, 3);

  const blank = empty({ title: '暂无告警', body: '等待采集', actionLabel: '刷新', onAction: () => {} });
  assert.equal(visibleText(blank).includes('暂无告警'), true);
  assert.equal(visibleText(blank).includes('等待采集'), true);

  const bar = progress({ value: 30, max: 100, label: '采集中' });
  assert.equal(bar.getAttribute('role'), 'progressbar');
  assert.equal(bar.getAttribute('aria-valuenow'), '30');
  assert.equal(bar.getAttribute('aria-valuemax'), '100');
  assert.ok(bar.style.getPropertyValue('--progress-value').includes('30'));
});

test('badge/severityBadge/statusBadge：tone 与文本', (t) => {
  withDom(t);
  assert.equal(badge({ tone: 'danger', text: 'critical' }).getAttribute('data-tone'), 'danger');
  const sev = severityBadge('high');
  assert.equal(visibleText(sev), 'high', 'severity without a localized label falls back to the enum');
  assert.equal(sev.getAttribute('data-tone'), 'high');
  assert.equal(statusBadge('new').getAttribute('data-tone'), 'accent');
  assert.equal(severityBadge('unknown').getAttribute('data-tone'), 'neutral');
});

// ---------------------------------------------------------------------------
// table：loading / empty / data / 虚拟滚动
// ---------------------------------------------------------------------------

test('table 三态：loading 骨架、empty 空态文案、有数据渲染单元格', (t) => {
  withDom(t);
  const columns = [{ key: 'rule', label: '规则' }, { key: 'count', label: '次数' }];

  const loading = table({ columns, rows: [], loading: true });
  assert.equal(loading.querySelector('.ui-table__scroll').getAttribute('aria-busy'), 'true');
  assert.ok(loading.querySelector('.ui-skeleton'));

  const blank = table({ columns, rows: [], empty: { title: '暂无告警', body: '调整筛选试试' } });
  assert.equal(visibleText(blank).includes('暂无告警'), true);
  assert.equal(visibleText(blank).includes('—'), false, 'empty state must not render placeholder dashes');

  let clicked = null;
  const rows = [{ rule: 'proc_persist', count: 3 }, { rule: 'net_scan', count: 7 }];
  const filled = table({
    columns,
    rows,
    rowKey: (row) => row.rule,
    onRowClick: (row) => { clicked = row; },
    ariaLabel: '告警列表',
  });
  assert.equal(filled.querySelector('table').getAttribute('aria-label'), '告警列表');
  assert.equal(filled.querySelectorAll('tbody tr').length, 2);
  assert.equal(visibleText(filled).includes('proc_persist'), true);
  const firstRow = filled.querySelectorAll('tbody tr')[0];
  click(firstRow);
  assert.equal(clicked.rule, 'proc_persist');
  keydown(firstRow, 'Enter');
  assert.equal(clicked.rule, 'proc_persist', 'Enter must activate a clickable row');
});

test('table 虚拟滚动：5000 行 DOM 行数 < 300，threshold=200 以下全渲染', async (t) => {
  withDom(t);
  const columns = [{ key: 'id', label: 'ID' }];
  const rows = Array.from({ length: 5000 }, (_, index) => ({ id: `row-${index}` }));

  const virtual = table({ columns, rows });
  assert.equal(virtual.getAttribute('data-virtual'), 'true');
  // 无布局高度时回落到 FALLBACK_VISIBLE_ROWS=16 → 16 + overscan*2(12) + 2 垫片 = 30
  assert.ok(virtual.querySelectorAll('tbody tr').length < 300);
  assert.ok(countElements(virtual) < 300, 'virtual table must keep DOM node count bounded');
  assert.equal(virtual.querySelector('table').getAttribute('aria-rowcount'), '5001');

  // 注入可视高度后滚动，窗口按行高移动（40px/行）
  const scroll = virtual.querySelector('.ui-table__scroll');
  scroll.clientHeight = 400;
  scroll.scrollTop = 4000;
  scroll.dispatchEvent(makeEvent('scroll', { bubbles: false }));
  await sleep(30);
  const windowRows = virtual.querySelectorAll('tbody tr');
  assert.ok(windowRows.length < 300);
  const firstDataRow = windowRows.find((row) => row.getAttribute('data-row') === 'true');
  assert.ok(firstDataRow, 'a data row must be rendered after scrolling');
  const ariaIndex = Number(firstDataRow.getAttribute('aria-rowindex'));
  assert.ok(ariaIndex > 1, `scroll must move the window (aria-rowindex=${ariaIndex})`);

  const small = table({ columns, rows: rows.slice(0, 150) });
  assert.equal(small.getAttribute('data-virtual'), 'false');
  assert.equal(small.querySelectorAll('tbody tr').length, 150, 'below threshold all rows render');
});

// ---------------------------------------------------------------------------
// drawer / modal：三关关闭 + focus trap + 焦点回归
// ---------------------------------------------------------------------------

function setupTrigger(dom) {
  const trigger = dom.document.createElement('button');
  trigger.textContent = '打开';
  dom.document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

test('drawer 三关：X / 遮罩 / Esc 各关闭一次且 reason 正确，焦点回触发元素', (t) => {
  const dom = withDom(t);
  for (const [route, reason] of [['x', 'close'], ['backdrop', 'backdrop'], ['escape', 'escape']]) {
    const trigger = setupTrigger(dom);
    const reasons = [];
    const overlay = drawer({ title: '详情', body: domEl('p', { text: '内容' }), onClose: (r) => reasons.push(r) });
    assert.equal(overlay.isOpen, true);
    assert.equal(document.activeElement.tagName, 'BUTTON');
    assert.ok(document.activeElement.getAttribute('aria-label'), 'initial focus must land on a named control');

    if (route === 'x') click(overlay.querySelector('.ui-drawer__close'));
    if (route === 'backdrop') click(overlay);
    if (route === 'escape') keydown(overlay, 'Escape');

    assert.equal(overlay.isOpen, false, `${route} must close the drawer`);
    assert.deepEqual(reasons, [reason]);
    assert.equal(document.getElementById('drawer-root').children.length, 0, 'closed overlay is removed');
    assert.equal(dom.document.activeElement, trigger, 'focus must return to the trigger');
  }
});

test('drawer focus trap：Tab 在面板首尾循环，Shift+Tab 反向', (t) => {
  const dom = withDom(t);
  setupTrigger(dom);
  const overlay = drawer({ title: 'Trap', body: domEl('p', { text: 'x' }) });
  const panel = overlay.querySelector('.ui-drawer__panel');
  const closeButton = overlay.querySelector('.ui-drawer__close');

  closeButton.focus();
  keydown(overlay, 'Tab', { shiftKey: true });
  assert.equal(dom.document.activeElement, closeButton, 'panel has a single focusable: Shift+Tab wraps to itself');

  keydown(overlay, 'Tab', { shiftKey: false });
  assert.equal(dom.document.activeElement, closeButton);
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
});

test('modal：destructive 用 alertdialog，Esc/遮罩关闭，动作按钮触发后 reason=action', (t) => {
  const dom = withDom(t);
  const trigger = setupTrigger(dom);
  const reasons = [];
  let acted = 0;
  const overlay = modal({
    title: '删除 provider？',
    body: domEl('p', { text: '此操作不可撤销' }),
    destructive: true,
    actions: [{ label: '删除', variant: 'danger', onClick: () => { acted += 1; } }],
    onClose: (reason) => reasons.push(reason),
  });
  assert.equal(overlay.querySelector('.ui-modal__panel').getAttribute('role'), 'alertdialog');
  click(overlay.querySelectorAll('.ui-modal__foot .ui-btn').at(-1));
  assert.equal(acted, 1);
  assert.deepEqual(reasons, ['action']);
  assert.equal(dom.document.activeElement, trigger);

  const second = modal({ title: '再次确认', body: null });
  keydown(second, 'Escape');
  assert.equal(second.isOpen, false);
});

// ---------------------------------------------------------------------------
// toast / tabs / segmented / toggle / select / field
// ---------------------------------------------------------------------------

test('toast：Esc 关闭、动作回调；toastHost 提供 aria-live=polite 容器', async (t) => {
  const dom = withDom(t);
  const host = toastHost('toast-root');
  assert.equal(host.root.getAttribute('aria-live'), 'polite');
  assert.equal(host.root.getAttribute('role'), 'status');

  let acted = 0;
  const one = host.show({ kind: 'warn', text: '保存后不生效', actionLabel: '查看', onAction: () => { acted += 1; } });
  assert.ok(host.root.contains(one));
  keydown(one, 'Escape');
  assert.equal(host.root.children.length, 0, 'Esc dismisses the toast');

  const two = host.show({ kind: 'info', text: '常驻', ttl: 50 });
  await sleep(80);
  assert.equal(host.root.children.includes(two), false, 'ttl expiry removes the toast');

  const three = host.show({ kind: 'ok', text: '可操作', actionLabel: '撤销', onAction: () => { acted += 1; } });
  click(three.querySelector('.ui-toast__action'));
  assert.equal(acted, 1);
  assert.equal(host.root.children.length, 0);
  host.clear();
  assert.equal(dom.roots.toast.children.length, 0);
});

test('tabs：roving tabindex + 方向键切换 + aria-selected', (t) => {
  const dom = withDom(t);
  let active = 'a';
  const node = tabs({
    items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    active,
    onChange: (id) => { active = id; },
  });
  assert.equal(node.getAttribute('role'), 'tablist');
  const buttons = node.querySelectorAll('[role="tab"]');
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].getAttribute('aria-selected'), 'true');
  assert.equal(buttons[0].getAttribute('tabindex'), '0');
  assert.equal(buttons[1].getAttribute('tabindex'), '-1');
  buttons[0].focus();
  keydown(buttons[0], 'ArrowRight');
  assert.equal(active, 'b');
  assert.equal(dom.document.activeElement, buttons[1]);
  assert.equal(buttons[1].getAttribute('aria-selected'), 'true');
});

test('segmented：radiogroup + 方向键切换 + aria-checked', (t) => {
  const dom = withDom(t);
  let value = 'a';
  const node = segmented({
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    value,
    onChange: (next) => { value = next; },
  });
  assert.equal(node.getAttribute('role'), 'radiogroup');
  const radios = node.querySelectorAll('[role="radio"]');
  assert.equal(radios[0].getAttribute('aria-checked'), 'true');
  radios[0].focus();
  keydown(radios[0], 'ArrowRight');
  assert.equal(value, 'b');
  assert.equal(dom.document.activeElement, radios[1]);
});

test('toggle：role=switch 与 aria-checked 切换', (t) => {
  const dom = withDom(t);
  let checked = false;
  const node = toggle({ checked, label: '零外联', onChange: (next) => { checked = next; } });
  assert.equal(node.getAttribute('role'), 'switch');
  assert.equal(node.getAttribute('aria-checked'), 'false');
  click(node);
  assert.equal(checked, true);
  assert.equal(node.getAttribute('aria-checked'), 'true');
});

test('select：options/value/placeholder 与 change 事件', (t) => {
  const dom = withDom(t);
  let value = null;
  const node = select({
    options: [{ value: 'a', label: '一级' }, { value: 'b', label: '二级' }],
    value: 'a',
    placeholder: '请选择',
    onChange: (next) => { value = next; },
  });
  assert.equal(node.tagName, 'SELECT');
  assert.equal(node.querySelectorAll('option').length, 3, 'placeholder option + 2 options');
  assert.equal(node.value, 'a');
  node.value = 'b';
  node.dispatchEvent(makeEvent('change', { bubbles: true }));
  assert.equal(value, 'b');
});

test('field/input/secretInput：label for、aria-describedby、密码显隐不丢明文控制', (t) => {
  const dom = withDom(t);
  const control = input({ type: 'text', ariaLabel: '名称' });
  const wrapper = field({ label: '名称', hint: '必填', error: '不能为空', control, required: true });
  assert.equal(wrapper.getAttribute('data-invalid'), 'true');
  const label = wrapper.querySelector('.ui-field__label');
  assert.equal(label.getAttribute('for'), control.id);
  assert.equal(control.getAttribute('aria-invalid'), 'true');
  assert.equal(control.getAttribute('aria-required'), 'true');
  assert.ok(control.getAttribute('aria-describedby').includes(control.id));
  assert.equal(visibleText(wrapper).includes('不能为空'), true);

  const secret = secretInput({ ariaLabel: 'API Key' });
  const inner = secret.querySelector('input');
  assert.equal(inner.getAttribute('type'), 'password');
  inner.value = 'sk-canary-value';
  assert.equal(inner.value, 'sk-canary-value');
  const toggleButton = secret.querySelector('.ui-secret__toggle');
  click(toggleButton);
  assert.equal(inner.getAttribute('type'), 'text');
  assert.equal(toggleButton.getAttribute('aria-pressed'), 'true');
  click(toggleButton);
  assert.equal(inner.getAttribute('type'), 'password');
  // 明文只在 input.value，不写进属性/DOM 结构
  assert.ok(!serialize(secret).includes('sk-canary-value'));
});
