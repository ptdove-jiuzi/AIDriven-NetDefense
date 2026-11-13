/**
 * tests/e2e/fixes/settings-p0-2.test.js — P0-2 回归：`#/settings` / `#/models` 必须渲染 8 组，
 * 且"渲染崩溃"这条断言必须能被证明会红（变异转红）（作者 PT-dove）
 *
 * 背景（真实历史缺陷，见 docs/implementation/evidence/ui2/fixes/VERIFY-P0-2.md）：
 *   `#/settings` 与 `#/models` 只剩 327 字符外壳 +
 *   `This settings group failed to render  checkbox is not defined`
 * 根因类：视图模块里调用了 `checkbox()` 但 `checkbox` 未从 field.js 导入 → ESM 运行时
 *   ReferenceError（不是 import 解析错误），被 settings 的 renderBody try/catch 兜成空态。
 * 两页同症状：`#/models` 与 `#/settings` 默认都挂 `group=models`（合同 §7.2 第 472/476 行）。
 *
 * 本文件做什么：
 *   1) 真实浏览器（Edge headless + tests/e2e/lib/cdp.mjs）打开两页，断言：
 *      8 个分组 tab 齐全；逐个点开每组都渲染出正文（不是兜底空态）；en 页面文本 > 3000 字符
 *      （旧缺陷只有 327）；无未捕获异常、无 ReferenceError；zh-CN 下 8 组正文合计 > 3000；
 *   2) 反证（变异转红）：用 CDP Fetch 在传输层把 `checkbox` 从 import 里删掉（**磁盘零改动**），
 *      断言页面重新出现旧症状 —— 证明第 1 条的断言不是空转。
 *
 * 运行（需要已起好的真栈；本测试不重启任何栈）：
 *   node --test tests/e2e/fixes/settings-p0-2.test.js
 *   FIXES_DATA_BASE=http://127.0.0.1:17512 FIXES_MOCK_BASE=http://127.0.0.1:17522 \
 *     node --test tests/e2e/fixes/settings-p0-2.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { launch } from '../lib/cdp.mjs';
import { installImportMutation, REPO_ROOT } from './lib/mutate-module.mjs';

/** 受测文件（每次运行把 sha256 打进诊断，证明断言绑定的是哪一版代码 —— 该目录由 UI2-LEAD 在建）。 */
const WATCHED = Object.freeze([
  'apps/console-next/js/views/settings/models.js',
  'apps/console-next/js/views/settings/shared.js',
  'apps/console-next/js/views/settings/index.js',
  'apps/console-next/js/components/ui/field.js',
]);

function sha256Short(relative) {
  return createHash('sha256').update(readFileSync(join(REPO_ROOT, relative))).digest('hex').slice(0, 16);
}

/** 一行指纹：`models.js=xxxxxxxxxxxxxxxx shared.js=…`。 */
function watchedFingerprint() {
  return WATCHED.map((relative) => `${relative.split('/').pop()}=${sha256Short(relative)}`).join(' ');
}

/** 合同 §6 的 8 个设置分组（顺序即 UI tab 顺序）。 */
const GROUPS = Object.freeze([
  'models',
  'collection',
  'detection',
  'response',
  'ui',
  'update',
  'diagnostics',
  'about',
]);

const DATA_BASE = process.env.FIXES_DATA_BASE || 'http://127.0.0.1:17512';
const MOCK_BASE = process.env.FIXES_MOCK_BASE || 'http://127.0.0.1:17522';
const BASES = Object.freeze([
  { name: 'data', base: DATA_BASE },
  { name: 'mock', base: MOCK_BASE },
]);

/** 合同 §7.9 确定性开关：固定英文 + 关自动刷新，让文本长度断言不受语言/轮询抖动影响。 */
const DETERMINISTIC = '?theme=dark&lang=en&static=1';

/** 兜底空态的特征串（合同 §7.2：模块抛错 → 壳渲染空态，永不白屏）。 */
const FALLBACK_TITLE = 'This settings group failed to render';
/** en 页面文本下限：交付验收线 > 3000 字符（旧缺陷只有 327）。 */
const MIN_PAGE_TEXT = 3000;
/** 每组正文下限：最小的 about 组在真实栈约 330 字符（en），取 150 作保守下限。 */
const MIN_GROUP_TEXT = 150;
/** 8 组正文合计下限（zh-CN 更紧凑，仍应远超旧缺陷的 327）。 */
const MIN_GROUPS_TOTAL = 3000;

const PROBE = `(() => {
  const text = (node) => (node ? (node.innerText || '').trim() : '');
  const body = document.querySelector('#settings-body');
  const tabs = [...document.querySelectorAll('#settings-tabs [role="tab"]')];
  return {
    route: location.hash,
    lang: document.documentElement.lang,
    pageTextLength: text(document.querySelector('#view-root')).length,
    tabCount: tabs.length,
    tabIds: tabs.map((tab) => tab.id),
    activeTab: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((tab) => tab.id),
    bodyTextLength: text(body).length,
    bodyHead: text(body).slice(0, 200),
    fallback: text(body).includes(${JSON.stringify(FALLBACK_TITLE)}),
    undefinedIdentifier: /is not defined/.test(text(body)),
    bodyText: text(body),
  };
})()`;

/** 打开一个干净页面（禁用缓存，避免模块从浏览器缓存命中而绕过拦截）。 */
async function openCleanPage(browser) {
  const page = await browser.newPage();
  await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
  await page.setColorScheme('dark');
  return page;
}

/** 页面诊断：设置视图没渲染时，用来区分"栈/壳问题"和"设置模块崩溃"。 */
const DIAG = `(() => {
  const text = (node) => (node ? (node.innerText || '').trim() : '');
  const body = document.querySelector('#settings-body');
  const root = document.querySelector('#view-root');
  return {
    url: location.href,
    hash: location.hash,
    rootChildren: root ? root.childElementCount : -1,
    rootTextHead: text(root).slice(0, 300),
    rootTextLength: text(root).length,
    bodyPresent: body !== null,
    bodyHead: text(body).slice(0, 200),
    tabs: document.querySelectorAll('#settings-tabs [role="tab"]').length,
    shellFailure: text(document.body).includes('failed to start'),
  };
})()`;

/** 等待设置正文出现（body 里的骨架屏在 loading 阶段文本为空，必须等真内容）。 */
const SETTINGS_READY = `(() => {
  const body = document.querySelector('#settings-body');
  if (body === null) return false;
  return (body.innerText || '').trim().length > 50;
})()`;

/**
 * 加载设置视图：一次失败重试一次（并行会话在写 apps/console-next/js/**，页面可能撞到半写状态），
 * 两次都失败就带页面诊断抛出 —— 不静默吞错、不无限重试。
 *
 * @returns {Promise<number>} 实际成功的尝试次数（1 = 无重试）
 */
async function loadSettings(page, url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(url);
    try {
      await page.waitFor(SETTINGS_READY, { timeoutMs: 30_000, label: `${label} attempt ${attempt}` });
      return attempt;
    } catch (error) {
      lastError = error;
      const { report } = collectPageErrors(page);
      const referenceErrors = report.exceptions.map((entry) => entry.text);
      if (referenceErrors.some((text) => /is not defined/iu.test(text))) {
        throw new Error(`${label}: 页面出现 ReferenceError → ${JSON.stringify(referenceErrors)}`);
      }
    }
  }
  const diag = await page.evaluate(DIAG).catch(() => null);
  throw new Error(`${label}: 设置视图两次都未渲染（30s/次）→ 诊断=${JSON.stringify(diag)}；last=${lastError?.message}`);
}

/** 等到设置视图挂载出可读正文（或兜底空态）。 */
async function waitForSettings(page, label) {
  await page.waitFor(
    `(() => {
      const body = document.querySelector('#settings-body');
      if (body === null) return false;
      return (body.innerText || '').trim().length > 50;
    })()`,
    { timeoutMs: 40_000, label: `${label} settings body` },
  );
}

/** 等到兜底空态出现（反证用）。 */
async function waitForFallback(page, label) {
  await page.waitFor(
    `(() => {
      const body = document.querySelector('#settings-body');
      return body !== null && (body.innerText || '').includes(${JSON.stringify(FALLBACK_TITLE)});
    })()`,
    { timeoutMs: 25_000, label: `${label} fallback` },
  );
}

/** 页面级红字：未捕获异常、ReferenceError、以及日志里的 ReferenceError。 */
function collectPageErrors(page) {
  const report = page.report();
  const referenceErrors = [
    ...report.exceptions.map((entry) => entry.text),
    ...report.consoleErrors.map((entry) => entry.text),
    ...report.logErrors.map((entry) => entry.text),
  ].filter((text) => /referenceerror|is not defined/iu.test(text));
  return { report, referenceErrors };
}

function assertNoReferenceError(page, label) {
  const { report, referenceErrors } = collectPageErrors(page);
  assert.deepEqual(referenceErrors, [], `${label}: 出现 ReferenceError → ${JSON.stringify(referenceErrors)}`);
  assert.deepEqual(
    report.exceptions.map((entry) => entry.text),
    [],
    `${label}: 有未捕获异常 → ${JSON.stringify(report.exceptions)}`,
  );
}

/** 断言页面上 8 个 tab 齐全且顺序正确。 */
function assertEightTabs(probe, label) {
  assert.equal(probe.tabCount, 8, `${label}: 设置分组 tab 数量应为 8，实际 ${probe.tabCount}（${JSON.stringify(probe.tabIds)}）`);
  assert.deepEqual(
    probe.tabIds,
    GROUPS.map((group) => `ui-tab-${group}`),
    `${label}: tab id 与合同 §6 的 8 组不一致`,
  );
}

/** 断言当前分组正文已渲染（非兜底、非空、无未定义标识符）。 */
function assertGroupRendered(probe, group, label) {
  assert.equal(probe.fallback, false, `${label}/${group}: 渲染成兜底空态 → ${probe.bodyText.slice(0, 300)}`);
  assert.equal(probe.undefinedIdentifier, false, `${label}/${group}: 正文含 "is not defined" → ${probe.bodyText.slice(0, 300)}`);
  assert.ok(
    probe.bodyTextLength >= MIN_GROUP_TEXT,
    `${label}/${group}: 正文只有 ${probe.bodyTextLength} 字符（下限 ${MIN_GROUP_TEXT}）→ ${probe.bodyHead}`,
  );
}

/** 点开某个分组并等正文渲染出来。 */
async function openGroup(page, group, label) {
  await page.click(`#ui-tab-${group}`);
  await page.waitFor(
    `(() => {
      const body = document.querySelector('#settings-body');
      if (body === null) return false;
      return (body.innerText || '').trim().length > 100;
    })()`,
    { timeoutMs: 10_000, label: `${label} group ${group}` },
  );
  return page.evaluate(PROBE);
}

describe('P0-2 · 设置页渲染（真实浏览器）', () => {
  /** @type {Awaited<ReturnType<typeof launch>>|null} */
  let browser = null;

  before(async () => {
    browser = await launch({ headless: true, width: 1440, height: 900 });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  for (const { name, base } of BASES) {
    for (const route of ['#/settings', '#/models']) {
      test(`${name} 栈 ${route}（en）：8 组全部渲染、页面 >3000 字符、无 ReferenceError`, async (t) => {
        const page = await openCleanPage(browser);
        try {
          const attempts = await loadSettings(page, `${base}/${DETERMINISTIC}${route}`, `${name} ${route}`);
          t.diagnostic(`受测文件 ${watchedFingerprint()}；本次加载尝试 ${attempts} 次`);

          // 默认组（models）先要能渲染 —— 历史缺陷正是默认组直接崩。
          let probe = await page.evaluate(PROBE);
          assertEightTabs(probe, `${name} ${route}`);
          assert.equal(probe.lang, 'en', `${name} ${route}: 确定性开关 ?lang=en 未生效（html lang=${probe.lang}）`);
          assertGroupRendered(probe, 'models', `${name} ${route}`);
          assert.ok(
            probe.pageTextLength > MIN_PAGE_TEXT,
            `${name} ${route}: 页面文本 ${probe.pageTextLength} 字符 ≤ ${MIN_PAGE_TEXT}（旧缺陷是 327）`,
          );

          for (const group of GROUPS) {
            if (group === 'models') continue;
            probe = await openGroup(page, group, `${name} ${route}`);
            assert.deepEqual(probe.activeTab, [`ui-tab-${group}`], `${name} ${route}: 点击后 ${group} tab 未激活`);
            assertGroupRendered(probe, group, `${name} ${route}`);
          }

          assertNoReferenceError(page, `${name} ${route}`);
        } finally {
          await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
        }
      });
    }
  }

  test('zh-CN（默认语言）下 8 组正文合计 > 3000 字符，且没有任何兜底空态', async (t) => {
    const page = await openCleanPage(browser);
    try {
      const attempts = await loadSettings(page, `${DATA_BASE}/#/settings`, 'zh-CN #/settings');
      t.diagnostic(`受测文件 ${watchedFingerprint()}；本次加载尝试 ${attempts} 次`);
      let probe = await page.evaluate(PROBE);
      assertEightTabs(probe, 'zh-CN #/settings');
      assert.equal(probe.lang, 'zh-CN', `默认语言应为 zh-CN（合同 §8），实际 ${probe.lang}`);
      assertGroupRendered(probe, 'models', 'zh-CN #/settings');

      let total = probe.bodyTextLength;
      const lengths = { models: probe.bodyTextLength };
      for (const group of GROUPS) {
        if (group === 'models') continue;
        probe = await openGroup(page, group, 'zh-CN #/settings');
        assertGroupRendered(probe, group, 'zh-CN #/settings');
        total += probe.bodyTextLength;
        lengths[group] = probe.bodyTextLength;
      }
      assert.ok(
        total > MIN_GROUPS_TOTAL,
        `zh-CN 8 组正文合计 ${total} 字符 ≤ ${MIN_GROUPS_TOTAL}（旧缺陷整页只有 327）→ ${JSON.stringify(lengths)}`,
      );
      assertNoReferenceError(page, 'zh-CN #/settings');
    } finally {
      await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  });

  test('反证+复绿：删掉 models.js 的 checkbox 导入 → 两页复现旧症状；撤销后同一页面复绿（磁盘零改动）', async () => {
    assert.equal(
      existsSync(join(REPO_ROOT, 'apps/console-next/js/views/settings/models.js')),
      true,
      '变异目标文件不存在',
    );

    for (const route of ['#/settings', '#/models']) {
      const page = await openCleanPage(browser);
      const mutation = await installImportMutation(page, {
        urlSuffix: '/js/views/settings/models.js',
        dropBinding: 'checkbox',
      });
      try {
        // 红：变异后必须复现历史症状。
        await page.goto(`${DATA_BASE}/${DETERMINISTIC}${route}`);
        await waitForFallback(page, `mutation ${route}`);
        const probe = await page.evaluate(PROBE);
        assert.ok(mutation.mutations >= 1, `${route}: 变异拦截没有命中 models.js 请求`);
        assert.equal(probe.fallback, true, `${route}: 变异后应出现兜底空态，实际正文 → ${probe.bodyHead}`);
        assert.match(probe.bodyText, /checkbox is not defined/u, `${route}: 兜底文案应含真实 ReferenceError 原因`);
        assert.ok(probe.bodyTextLength < 400, `${route}: 变异后正文应只剩空态，实际 ${probe.bodyTextLength} 字符`);

        // 绿：撤销拦截后，用**全新浏览器实例**（新 profile、无缓存）加载同一 URL 必须恢复绿，
        // 以排除"页面内存缓存仍然命中变异体"的干扰 —— 红就是那次拦截造成的。
        await mutation.remove();
      } finally {
        await mutation.remove();
        await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
      }
    }

    const fresh = await launch({ headless: true, width: 1440, height: 900 });
    try {
      const page = await fresh.newPage();
      await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
      await loadSettings(page, `${DATA_BASE}/${DETERMINISTIC}#/settings`, 'restore #/settings（全新浏览器）');
      const restored = await page.evaluate(PROBE);
      assertEightTabs(restored, 'restore #/settings');
      assertGroupRendered(restored, 'models', 'restore #/settings');
      assert.ok(
        restored.pageTextLength > MIN_PAGE_TEXT,
        `restore #/settings: 撤销变异后页面文本 ${restored.pageTextLength} 字符 ≤ ${MIN_PAGE_TEXT}`,
      );
      assertNoReferenceError(page, 'restore #/settings');
    } finally {
      await fresh.close();
    }
  });

  test('反证 · 变异转红：删掉 shared.js 的 checkbox 导入 → 含枚举 string[] 的分组复现（磁盘零改动）', async () => {
    const page = await openCleanPage(browser);
    const mutation = await installImportMutation(page, {
      urlSuffix: '/js/views/settings/shared.js',
      dropBinding: 'checkbox',
    });
    try {
      await loadSettings(page, `${DATA_BASE}/${DETERMINISTIC}#/settings`, 'mutation shared.js');
      let probe = await page.evaluate(PROBE);
      // models 组不经过 shared.js 的 string[] 枚举分支，因此这里仍应正常。
      assertGroupRendered(probe, 'models', 'mutation shared.js');

      // collection.channels 是 string[] + 枚举值 → 走 shared.js renderControl 的 checkbox 分支。
      await page.click('#ui-tab-collection');
      await waitForFallback(page, 'mutation shared.js / collection');
      probe = await page.evaluate(PROBE);
      assert.ok(mutation.mutations >= 1, '变异拦截没有命中 shared.js 请求');
      assert.match(probe.bodyText, /checkbox is not defined/u, 'collection 组兜底文案应含真实 ReferenceError 原因');
    } finally {
      await mutation.remove();
      await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  });
});
