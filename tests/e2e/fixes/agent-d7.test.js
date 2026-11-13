/**
 * tests/e2e/fixes/agent-d7.test.js — D7 回归：Agent 页不得把内部诊断串 (`engine.harness.available=`)
 * 当正文渲染；信息必须保留在「诊断」折叠区（作者 PT-dove）
 *
 * 缺陷：`docs/implementation/evidence/ui2/defects.md` D7（P3）——
 *   `js/views/agent.js:488` 把 `engine.harness.available=<bool>` 直接作为 `<p class="faint mono">` 渲染进
 *   引导卡片正文，与面向用户的原因/操作按钮混在一起。
 *
 * 断言（改前红 / 改后绿）：
 *   1. 主区可见文本（`#view-root` 的 innerText，排除折叠内容）**不得**出现 `engine.harness.available=`；
 *   2. 该诊断信息**必须仍存在**于某个 `details` 诊断折叠区（`textContent` 含原串），即"移走不丢失"；
 *   3. 折叠区 summary 有可读的「诊断 / Diagnostics」标签，且默认收起（`open=false`）；
 *   4. 引导信息未被破坏：`[data-action="open-model-settings"]` 按钮仍在，卡片仍有 data-code。
 *
 * 运行：node --test tests/e2e/fixes/agent-d7.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { launch } from '../lib/cdp.mjs';

const DATA_BASE = process.env.FIXES_DATA_BASE || 'http://127.0.0.1:17512';
/** 确定性开关（合同 §7.9）：固定英文 + 关自动刷新。 */
const AGENT_URL = `${DATA_BASE}/?theme=dark&lang=en&static=1#/agent`;

const PROBE = `(() => {
  const text = (node) => (node ? (node.innerText || '').trim() : '');
  const root = document.querySelector('#view-root');
  const details = [...(root ? root.querySelectorAll('details') : [])].map((node) => ({
    open: node.hasAttribute('open'),
    summary: (node.querySelector('summary')?.innerText || '').trim(),
    textContent: (node.textContent || '').trim(),
  }));
  return {
    viewTextLength: text(root).length,
    viewText: text(root),
    hasRawInVisibleText: text(root).includes('engine.harness.available='),
    hasRawInTextContent: (root?.textContent || '').includes('engine.harness.available='),
    harnessRaw: (root?.textContent || '').match(/engine\\.harness\\.available=(?:true|false|unknown)/g) || [],
    details,
    detailsCount: details.length,
    guideCodes: [...document.querySelectorAll('.agent-guide')].map((node) => node.getAttribute('data-code')),
    openSettingsButtons: document.querySelectorAll('[data-action="open-model-settings"]').length,
  };
})()`;

describe('D7 · Agent 页内部诊断串不得出现在主文案', () => {
  /** @type {Awaited<ReturnType<typeof launch>>|null} */
  let browser = null;
  /** @type {any} */
  let probe = null;

  before(async () => {
    browser = await launch({ headless: true, width: 1440, height: 900 });
    const page = await browser.newPage();
    await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
    await page.setColorScheme('dark');
    await page.goto(AGENT_URL);
    await page.waitFor(`(document.querySelector('#view-root')?.innerText || '').trim().length > 100`, {
      timeoutMs: 30_000,
      label: 'agent view',
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    probe = await page.evaluate(PROBE);
    probe.report = page.report();
    await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  });

  after(async () => {
    if (browser) await browser.close();
  });

  test('主区可见文本不含裸 `engine.harness.available=`（收进折叠区，不当正文）', () => {
    assert.ok(probe.viewTextLength > 200, `Agent 页正文太短（${probe.viewTextLength} 字符），可能没渲染出来`);
    assert.equal(
      probe.hasRawInVisibleText,
      false,
      `主区可见文本仍出现内部诊断串 → ${JSON.stringify(probe.viewText.slice(0, 400))}`,
    );
  });

  test('诊断信息必须保留：存在于 details 折叠区（textContent 含原串）', () => {
    // 只有真的存在引擎不可用状态时才要求折叠区；若未来引擎可用，主区也不该出现该串（已由上一用例断言）。
    if (probe.harnessRaw.length === 0) return;
    assert.equal(probe.hasRawInTextContent, true, '整个 DOM 里都找不到 engine.harness.available= —— 信息被删掉了，不是"移走"');
    const holders = probe.details.filter((entry) => entry.textContent.includes('engine.harness.available='));
    assert.equal(holders.length, 1, `应恰有 1 个 details 承载该诊断，实际 ${holders.length}（details 总数 ${probe.detailsCount}）`);
  });

  test('折叠区有「诊断 / Diagnostics」可读标签且默认收起', () => {
    if (probe.harnessRaw.length === 0) return;
    const holder = probe.details.find((entry) => entry.textContent.includes('engine.harness.available='));
    assert.ok(holder !== undefined, '找不到承载诊断的 details');
    assert.match(holder.summary, /diagnostic|诊断/iu, `summary 应有「诊断 / Diagnostics」标签，实际 "${holder.summary}"`);
    assert.equal(holder.open, false, '诊断折叠区默认应收起（open=false），不能一进来就铺在正文里');
  });

  test('引导信息未被破坏：data-code + 「打开模型设置」按钮仍在', () => {
    assert.ok(probe.guideCodes.length >= 1, `Agent 页应有引导卡片（data-code），实际 ${JSON.stringify(probe.guideCodes)}`);
    assert.equal(probe.openSettingsButtons, 1, '引导卡片里的「打开模型设置」按钮必须保留且唯一');
    assert.deepEqual(probe.report.exceptions.map((entry) => entry.text), [], 'Agent 页不应有未捕获异常');
  });
});
