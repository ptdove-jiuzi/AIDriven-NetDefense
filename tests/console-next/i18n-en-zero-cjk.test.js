/**
 * UI-POLISH T3 · 切到 en 后界面零中文（6 页真实页面断言）
 *
 * 判据（用户硬要求「切 en 后界面不得漏中文」）：
 *  对 overview / alerts / analysis / agent / models / settings 六个页面，在
 *  `?theme=dark&static=1&lang=en` 下渲染后：
 *   1. `#view-root` 的 innerText 内**汉字数 = 0**（界面正文不能出现中文）；
 *   2. body 可见文本（剔除产品专名「网域智防」）汉字数 = 0（专名按合同 §7.1 保留，单独计数）；
 *   3. 不出现 `[missing:<key>]` 标记；
 *   4. `<html lang="en">`。
 *
 * 实现：fake daemon + console-next serve.mjs（harness.mjs）+ 一个复用的 headless Edge 会话
 *      （edge.mjs 的 withCdpPage）。Edge 不可用时如实 skip（不假装通过）。
 * 证据：`node evidence/ui-polish/i18n/tools/verify-en-zero-cjk.mjs`（同口径，落 JSON/MD + HTML 摘要）。
 *
 * 运行：`node --test tests/console-next/i18n-en-zero-cjk.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { edgeAvailable, withCdpPage } from './edge.mjs';
import { startConsoleAndDaemon } from './harness.mjs';

const ROUTES = ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings'];
const READY = "(document.querySelector('#view-root')?.children.length ?? 0) > 0";

const PROBE = `(() => {
  const han = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]/g;
  const count = (text) => (String(text).match(han) || []).length;
  const root = document.querySelector('#view-root');
  const rootText = root ? (root.innerText || root.textContent || '') : '';
  const clone = document.body.cloneNode(true);
  for (const node of clone.querySelectorAll('script,style,noscript,template')) node.remove();
  const bodyText = clone.innerText || clone.textContent || '';
  const withoutBrand = bodyText.split('网域智防').join('');
  return {
    lang: document.documentElement.getAttribute('lang'),
    viewRootHan: count(rootText),
    bodyHan: count(bodyText),
    bodyHanWithoutBrand: count(withoutBrand),
    brandOccurrences: (bodyText.match(/网域智防/g) || []).length,
    missingMarkers: (bodyText.match(/\\[missing:/g) || []).length,
    missingKeys: [...new Set(bodyText.match(/\\[missing:[^\\]]+\\]/g) || [])],
    viewRootLength: rootText.length,
    excerpt: rootText.replace(/\\s+/g, ' ').slice(0, 160),
  };
})()`;

async function collectPages(t, locale) {
  const env = await startConsoleAndDaemon(t);
  const rows = [];
  const result = await withCdpPage({ width: 1440, height: 1000 }, async (page) => {
    for (const route of ROUTES) {
      const url = `${env.url}/index.html?theme=dark&static=1&lang=${locale}#/${route}`;
      const ready = await page.navigate(url, { waitMs: 900, waitExpression: READY, waitForTimeoutMs: 20000 });
      const probe = await page.evaluate(PROBE);
      rows.push({ route, ready, ...probe });
    }
    return { ok: true };
  });
  assert.equal(result?.ok, true, `Edge CDP session failed: ${result?.reason ?? 'unknown'}`);
  return rows;
}

test('6 页在 ?lang=en 下 #view-root 零汉字、无 [missing:]、零中文（品牌专名除外）', { skip: edgeAvailable() ? false : 'Edge not found' }, async (t) => {
  const rows = await collectPages(t, 'en');
  for (const row of rows) {
    t.diagnostic(`${row.route}: lang=${row.lang} rootHan=${row.viewRootHan} bodyHan(noBrand)=${row.bodyHanWithoutBrand} brand=${row.brandOccurrences} missing=${row.missingMarkers} len=${row.viewRootLength}`);
    assert.equal(row.ready, true, `${row.route} did not render #view-root`);
    assert.equal(row.lang, 'en', `${row.route}: <html lang> must be en`);
    assert.ok(row.viewRootLength > 0, `${row.route}: view-root is empty`);
    assert.equal(row.viewRootHan, 0, `${row.route}: #view-root contains Han characters → ${row.excerpt}`);
    assert.equal(row.bodyHanWithoutBrand, 0, `${row.route}: body contains Han characters outside the product name`);
    assert.equal(row.missingMarkers, 0, `${row.route}: rendered [missing:] markers ${JSON.stringify(row.missingKeys)}`);
  }
});

test('6 页在 ?lang=zh-CN 下不出现 [missing:]（合并新 IA 后中文补齐的验收项）', { skip: edgeAvailable() ? false : 'Edge not found' }, async (t) => {
  const rows = await collectPages(t, 'zh-CN');
  for (const row of rows) {
    t.diagnostic(`${row.route}: lang=${row.lang} rootHan=${row.viewRootHan} missing=${row.missingMarkers} len=${row.viewRootLength}`);
    assert.equal(row.ready, true, `${row.route} did not render #view-root`);
    assert.equal(row.lang, 'zh-CN', `${row.route}: <html lang> must be zh-CN`);
    assert.equal(row.missingMarkers, 0, `${row.route}: zh-CN rendered [missing:] markers ${JSON.stringify(row.missingKeys)}`);
  }
});
