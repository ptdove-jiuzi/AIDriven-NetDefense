/**
 * UI2-B11 · i18n 降级行为（波次 3 口径）
 *
 * 现状：`apps/console-next/i18n/locales/**` 由 B10 负责，尚未落盘。因此本文件只断言
 * **locales 缺失时的降级行为**（合同 §8.5：不静默空白、`[missing:<key>]`、计数），
 * 以及 i18n 模块本身的回落链 / normalizeLocale 纯函数。等 B10 落盘后由同一文件追加：
 * - en locale 100% 完整、7 语言 key 一致；
 * - en 界面 CJK 残留 = 0（固定夹具）；
 * - `node scripts/i18n-check.mjs` 退出码 0。
 * 这些"后补断言"在状态文件记「未验证（等 B10）」。
 *
 * 运行：`node --test tests/console-next/i18n.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createI18n, normalizeLocale } from '../../apps/console-next/js/i18n.js';
import { installDom } from './dom-shim.mjs';
import { cdpEvaluate, edgeAvailable } from './edge.mjs';
import { startConsoleAndDaemon } from './harness.mjs';

const hasEdge = edgeAvailable();

function missingFetch() {
  return async (url) => ({ ok: false, status: 404, json: async () => { throw new Error(`404 ${url}`); } });
}

function dictionaryFetch(tables) {
  return async (url) => {
    const name = String(url).split('/').pop().replace(/\.json$/u, '');
    const table = tables[name];
    if (table === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => table };
  };
}

test('locales 全缺失：不抛错，t() 返回 [missing:key]，missingCount 累加且不重复计数', async () => {
  const i18n = createI18n({ locale: 'ja', fetchImpl: missingFetch(), warnMissing: true });
  await i18n.ready();
  assert.equal(i18n.locale, 'ja');
  assert.equal(i18n.t('overview.title'), '[missing:overview.title]');
  assert.equal(i18n.t('overview.title'), '[missing:overview.title]', 'repeated lookup must stay stable');
  assert.equal(i18n.missingCount(), 1, 'the same missing key counts once');
  i18n.t('overview.subtitle');
  assert.equal(i18n.missingCount(), 2);
  const status = i18n.status();
  assert.ok(status.loadFailures > 0, 'failed locale loads must be recorded');
  assert.equal(status.builtinFallback, true);
  assert.ok(status.failed.length > 0);
});

/**
 * 回落链（2026-11-05 合同语义变更，用户硬要求 / lead 批准）：
 *  旧合同 §8.5「当前语言 → en → zh-CN」会让 **locale=en 时缺 key 渲染中文**（英文界面漏中文），
 *  ja/ko/es/ru/th 缺 key 出中文同样不可接受。新语义：chain = [当前语言, en]，绝不回落 zh-CN。
 *  `SECOND_FALLBACK_LOCALE` 仍导出（兼容），但不参与 chain —— 本用例是该不变量的守门人。
 *  这不是"为变绿改断言"：旧断言断言的正是被用户否掉的行为，此处改为更强断言。
 */
test('回落链：非 en 缺 key → en（绝不回落中文）；locale=en 缺 key → [missing:] 且零 CJK；zh-CN 缺 key → en', async () => {
  const tables = {
    en: { 'common.action.refresh': 'Refresh from en', 'nav.overview': 'Overview' },
    'zh-CN': { 'only.in.zh': '只有中文', 'common.action.refresh': '从 en 刷新', 'nav.overview': '总览' },
    ja: { 'nav.overview': '概要' },
  };
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

  // ja：只有 zh-CN 有的 key 必须渲染 [missing:]，不得出中文
  const ja = createI18n({ locale: 'ja', fetchImpl: dictionaryFetch(tables), warnMissing: false });
  await ja.ready();
  assert.equal(ja.t('common.action.refresh'), 'Refresh from en', 'ja missing → en fallback');
  assert.equal(ja.t('nav.overview'), '概要', 'ja own translation must win over en');
  assert.equal(ja.t('only.in.zh'), '[missing:only.in.zh]', 'ja must NEVER fall back to zh-CN');
  assert.doesNotMatch(ja.t('only.in.zh'), CJK, 'ja fallback must not leak CJK');

  // en：zh-CN 独有的 key 绝不能渲染中文（英文界面零中文的第一判据）
  const en = createI18n({ locale: 'en', fetchImpl: dictionaryFetch(tables), warnMissing: false });
  await en.ready();
  assert.equal(en.t('only.in.zh'), '[missing:only.in.zh]', 'locale=en must NEVER fall back to zh-CN');
  assert.doesNotMatch(en.t('only.in.zh'), CJK, 'locale=en missing key must not render CJK');
  assert.equal(en.t('common.action.refresh'), 'Refresh from en');
  assert.ok(en.has('common.action.refresh'), 'has() must resolve through [locale, en]');
  assert.equal(en.has('nope.nope'), false);

  // zh-CN 本体不受影响：zh-CN 缺 key 仍回落 en
  const zh = createI18n({ locale: 'zh-CN', fetchImpl: dictionaryFetch(tables), warnMissing: false });
  await zh.ready();
  assert.equal(zh.t('common.action.refresh'), '从 en 刷新');
  assert.equal(zh.t('overview.title'), '[missing:overview.title]', 'zh-CN also falls back to en only');

  // 内置 en 兜底仍可用（所有 locale 文件 404 时）
  const offline = createI18n({ locale: 'en', fetchImpl: missingFetch(), warnMissing: false });
  await offline.ready();
  assert.equal(offline.t('nav.overview'), 'Overview', 'builtin en must still answer on total load failure');
  assert.doesNotMatch(offline.t('nav.overview'), CJK);
});

test('normalizeLocale：zh→zh-CN、en-US→en、未知→默认 zh-CN', () => {
  assert.equal(normalizeLocale('zh'), 'zh-CN');
  assert.equal(normalizeLocale('zh-hans'), 'zh-CN');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('ja'), 'ja');
  assert.equal(normalizeLocale('xx-YY'), 'zh-CN');
  assert.equal(normalizeLocale(''), 'zh-CN');
});

test('apply()：data-i18n / data-i18n-aria / data-i18n-title 落 DOM；缺失 key 渲染标记而非空白；html lang 同步', async (t) => {
  const dom = installDom();
  t.after(() => dom.cleanup());
  const i18n = createI18n({
    locale: 'en',
    fetchImpl: dictionaryFetch({ en: { 'nav.overview': 'Overview' } }),
    warnMissing: false,
  });
  await i18n.ready();
  const textNode = dom.document.createElement('a');
  textNode.setAttribute('data-i18n', 'nav.overview');
  const missingNode = dom.document.createElement('span');
  missingNode.setAttribute('data-i18n', 'overview.title');
  const ariaNode = dom.document.createElement('button');
  ariaNode.setAttribute('data-i18n-aria', 'nav.overview');
  dom.document.body.append(textNode, missingNode, ariaNode);

  const applied = i18n.apply(dom.document);
  assert.ok(applied >= 3);
  assert.equal(textNode.textContent, 'Overview');
  assert.equal(missingNode.textContent, '[missing:overview.title]');
  assert.equal(ariaNode.getAttribute('aria-label'), 'Overview');
  assert.equal(dom.document.documentElement.getAttribute('lang'), 'en');
});

test('真实页面：B10 locales 落盘后 en 界面无 [missing:]、视图有内容、导航完整', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const result = await cdpEvaluate(page, `(() => {
    const body = document.body.textContent || '';
    const root = document.querySelector('#view-root');
    return {
      missingMarkers: (body.match(/\\[missing:/g) || []).length,
      rootChildren: root ? root.children.length : 0,
      navLinks: document.querySelectorAll('#nav a[data-route]').length,
      htmlLang: document.documentElement.getAttribute('lang'),
      title: (root?.textContent ?? '').trim().slice(0, 80),
    };
  })()`, {
    waitMs: 800,
    waitForTimeoutMs: 15000,
    // 等视图挂载且 i18n 完成（locales 已落盘：不应再出现 [missing:]）
    waitForExpression: "(document.querySelector('#view-root')?.children.length ?? 0) > 0 && !document.body.textContent.includes('[missing:')",
    timeoutMs: 25000,
  });
  assert.equal(result.ok, true, `CDP evaluate failed: ${result.reason}`);
  const snapshot = result.value;
  assert.equal(snapshot.missingMarkers, 0, 'with B10 locales on disk the page must not render [missing:key]');
  assert.ok(snapshot.rootChildren > 0, 'page must render a view');
  assert.equal(snapshot.navLinks, 6);
  assert.ok(snapshot.title.length > 0, 'view must contain translated text');
  t.diagnostic(`missing markers=${snapshot.missingMarkers}, html lang=${snapshot.htmlLang}, title=${JSON.stringify(snapshot.title)}`);
});
