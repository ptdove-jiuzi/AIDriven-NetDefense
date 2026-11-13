/**
 * tests/e2e/fixes/inputs-not-readonly-d15.test.js — D15 回归：所有输入框不得被错误置为只读（作者 PT-dove）
 *
 * 缺陷（defects.md D15，P0）：`js/components/ui/dom.js:178-182` 的布尔属性分支里
 *   `node[prop] = Boolean(value); if (key === 'readOnly') node.setAttribute('readonly', '');`
 *   —— **不管 value 真假都设 readonly 属性**；而 `field.js` 的 `input()` **永远**会传
 *   `readOnly: Boolean(opts.readOnly)`（默认 false）。于是每个文本框都变成只读：
 *   设置页「基础地址 / 每日令牌 / 温度」、告警页与解析页的搜索框全都打不进字（全站只能看不能输入）。
 *
 * 断言（改前红 / 改后绿）：
 *   1. 纯 DOM 级（dom-shim）：`input({type:'text'})` 等默认 `readOnly === false` 且**没有** readonly 属性；
 *      `input({readOnly:true})` 才是 true 且有属性；`textarea` / `secretInput` 同理；
 *   2. 真实浏览器：`#/alerts` 搜索框 `readOnly === false`、`Input.insertText('svchost')` 后 value 真的变了，
 *      且列表文本随过滤变化；`#/models` 的「Base URL / 每日令牌」等文本框也不再只读。
 *
 * 运行：node --test tests/e2e/fixes/inputs-not-readonly-d15.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../console-next/dom-shim.mjs';
import { launch } from '../lib/cdp.mjs';

const DATA_BASE = process.env.FIXES_DATA_BASE || 'http://127.0.0.1:17512';

/* ------------------------------------------------------------------ 纯 DOM 级 */

describe('D15 · 纯 DOM 级：布尔属性 readOnly 传播', () => {
  /** @type {any} */
  let field = null;
  /** @type {ReturnType<typeof installDom>|null} */
  let dom = null;

  before(async () => {
    dom = installDom();
    // 组件模块在 installDom 之后再加载，保证它看到的 globalThis.document 是 shim。
    field = await import('../../../apps/console-next/js/components/ui/field.js');
  });

  after(() => {
    if (dom) dom.cleanup();
  });

  const cases = [
    ['text 输入', () => field.input({ type: 'text', value: 'a' })],
    ['search 输入', () => field.input({ type: 'search', placeholder: 'Search' })],
    ['number 输入', () => field.input({ type: 'number', value: '3' })],
    ['textarea', () => field.textarea({ value: 'x' })],
  ];

  for (const [name, make] of cases) {
    test(`${name}：默认 readOnly=false 且无 readonly 属性`, () => {
      const node = make();
      const target = node.tagName === 'TEXTAREA' ? node : node;
      assert.equal(target.readOnly, false, `${name}: readOnly 属性应为 false，实际 ${target.readOnly}`);
      assert.equal(target.hasAttribute('readonly'), false, `${name}: 不应有 readonly 属性（会被浏览器当真）`);
    });
  }

  test('input({readOnly:true}) 才应只读（且带 readonly 属性）', () => {
    const node = field.input({ type: 'text', value: 'ro', readOnly: true });
    assert.equal(node.readOnly, true);
    assert.equal(node.hasAttribute('readonly'), true);
  });

  test('textarea({readOnly:true}) 同样生效', () => {
    const node = field.textarea({ value: 'x', readOnly: true });
    assert.equal(node.readOnly, true);
    assert.equal(node.hasAttribute('readonly'), true);
  });

  test('secretInput 内部 password 输入不得只读', () => {
    const wrapper = field.secretInput({});
    const input = wrapper.querySelector('input');
    assert.ok(input !== null, 'secretInput 应含 input');
    assert.equal(input.readOnly, false, 'secretInput 的输入框不应只读');
    assert.equal(input.hasAttribute('readonly'), false);
  });

  test('不回归：disabled=false 不应带 disabled 属性', () => {
    const node = field.input({ type: 'text', disabled: false });
    assert.equal(node.disabled, false);
    assert.equal(node.hasAttribute('disabled'), false);
  });
});

/* ------------------------------------------------------------------ 真实浏览器 */

describe('D15 · 真实浏览器：搜索框与设置文本框可输入', () => {
  /** @type {Awaited<ReturnType<typeof launch>>|null} */
  let browser = null;

  before(async () => {
    browser = await launch({ headless: true, width: 1440, height: 900 });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  async function openView(view) {
    const page = await browser.newPage();
    await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
    await page.setColorScheme('dark');
    await page.goto(`${DATA_BASE}/?theme=dark&lang=en&static=1#/${view}`);
    await page.waitFor(`(document.querySelector('#view-root')?.innerText || '').trim().length > 100`, {
      timeoutMs: 40_000,
      label: `${view} view`,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    return page;
  }

  test('#/alerts 搜索框可聚焦、可输入，列表随过滤变化', async () => {
    const page = await openView('alerts');
    try {
      const before = await page.evaluate(`(() => {
        const input = document.querySelector('#view-root input[type="search"]');
        return {
          found: input !== null,
          readOnly: input ? input.readOnly : null,
          hasAttr: input ? input.hasAttribute('readonly') : null,
          listText: (document.querySelector('#view-root tbody, #view-root [role="rowgroup"]')?.innerText || '').trim().slice(0, 400),
        };
      })()`);
      assert.equal(before.found, true, '#/alerts 应有搜索框（input[type=search]）');
      assert.equal(before.readOnly, false, `搜索框不应只读（readOnly=${before.readOnly}）`);
      assert.equal(before.hasAttr, false, '搜索框不应有 readonly 属性');

      // 真实键盘输入：聚焦后 CDP Input.insertText（等价用户打字）。
      await page.evaluate(`document.querySelector('#view-root input[type="search"]').focus()`);
      await page.connection.send('Input.insertText', { text: 'svchost' }, page.sessionId);
      await page.waitFor(`document.querySelector('#view-root input[type="search"]').value === 'svchost'`, {
        timeoutMs: 10_000,
        label: 'alerts search value',
      });
      // 搜索有 250ms 防抖（alerts.js SEARCH_DEBOUNCE_MS）：等列表真的随过滤变化，而不是立即取样。
      await page.waitFor(
        `(() => {
          const listText = (document.querySelector('#view-root tbody, #view-root [role="rowgroup"]')?.innerText || '').trim().slice(0, 400);
          return listText !== ${JSON.stringify(before.listText)};
        })()`,
        { timeoutMs: 8_000, label: 'alerts list filtered' },
      );
      const after = await page.evaluate(`(() => ({
        value: document.querySelector('#view-root input[type="search"]').value,
        listText: (document.querySelector('#view-root tbody, #view-root [role="rowgroup"]')?.innerText || '').trim().slice(0, 400),
      }))()`);
      assert.equal(after.value, 'svchost', `打字后搜索框 value 应为 svchost，实际 "${after.value}"（输入被吞=只读）`);
      assert.notEqual(after.listText, before.listText, '搜索后列表文本应随过滤变化（说明过滤真的生效）');
    } finally {
      await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  });

  test('#/models 设置文本框（Base URL / 每日令牌）不得只读', async () => {
    const page = await openView('models');
    try {
      const info = await page.evaluate(`(() => {
        const texts = [...document.querySelectorAll('#view-root input')].filter((node) =>
          node.type === 'text' || node.type === 'number' || node.type === 'search');
        return {
          total: texts.length,
          readOnlyOnes: texts.filter((node) => node.readOnly || node.hasAttribute('readonly'))
            .map((node) => (node.getAttribute('aria-label') || node.className || '') + ''),
        };
      })()`);
      assert.ok(info.total >= 5, `#/models 应有多个文本/数字输入，实际 ${info.total}`);
      assert.deepEqual(info.readOnlyOnes, [], `#/models 仍有只读输入框 → ${JSON.stringify(info.readOnlyOnes)}`);
    } finally {
      await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  });
});
