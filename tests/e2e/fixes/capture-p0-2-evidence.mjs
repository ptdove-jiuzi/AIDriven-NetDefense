/**
 * tests/e2e/fixes/capture-p0-2-evidence.mjs — 采集 P0-2 复验证据（截图 + 机器可读结果）（作者 PT-dove）
 *
 * 产物：docs/implementation/evidence/ui2/fixes/
 *   - VERIFY-P0-2.probe.json      逐页/逐组文本、异常、红字、文件 sha256/mtime
 *   - p0-2-*.png                  截图（含变异转红的兜底空态）
 *
 * 运行（只读消费已起好的栈，不重启）：
 *   node tests/e2e/fixes/capture-p0-2-evidence.mjs
 *   [--out <dir>] [--data <base>] [--mock <base>]
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from '../lib/cdp.mjs';
import { installImportMutation, REPO_ROOT } from './lib/mutate-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GROUPS = ['models', 'collection', 'detection', 'response', 'ui', 'update', 'diagnostics', 'about'];

function parseArgs(argv) {
  const args = {
    out: join(REPO_ROOT, 'docs/implementation/evidence/ui2/fixes'),
    data: 'http://127.0.0.1:17512',
    mock: 'http://127.0.0.1:17522',
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') { args.out = resolve(argv[index + 1]); index += 1; }
    else if (argv[index] === '--data') { args.data = argv[index + 1]; index += 1; }
    else if (argv[index] === '--mock') { args.mock = argv[index + 1]; index += 1; }
  }
  return args;
}

/** 待复验文件清单（只读；记录 sha256 + mtime，证明复验绑定了具体版本）。 */
const WATCHED = [
  'apps/console-next/js/views/settings/models.js',
  'apps/console-next/js/views/settings/shared.js',
  'apps/console-next/js/views/settings/index.js',
  'apps/console-next/js/components/ui/field.js',
];

function fileFacts(relative) {
  const absolute = join(REPO_ROOT, relative);
  const bytes = readFileSync(absolute);
  const stat = statSync(absolute);
  return {
    path: relative,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mtime: stat.mtime.toISOString(),
  };
}

const PROBE = `(() => {
  const text = (node) => (node ? (node.innerText || '').trim() : '');
  const body = document.querySelector('#settings-body');
  const tabs = [...document.querySelectorAll('#settings-tabs [role="tab"]')];
  return {
    hash: location.hash,
    lang: document.documentElement.lang,
    theme: document.documentElement.getAttribute('data-theme'),
    pageTextLength: text(document.querySelector('#view-root')).length,
    tabCount: tabs.length,
    tabIds: tabs.map((tab) => tab.id),
    bodyTextLength: text(body).length,
    bodyHead: text(body).slice(0, 160),
    bodyText: text(body).slice(0, 600),
    fallback: text(body).includes('This settings group failed to render'),
    undefinedIdentifier: /is not defined/.test(text(body)),
  };
})()`;

async function openPage(browser, { base, path, theme = 'dark' }) {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
  await page.setColorScheme(theme);
  await page.goto(`${base}/${path}`);
  await page.waitFor(
    `(() => {
      const body = document.querySelector('#settings-body');
      return body !== null && (body.innerText || '').trim().length > 50;
    })()`,
    { timeoutMs: 25_000, label: `${base}${path}` },
  );
  await new Promise((r) => setTimeout(r, 400));
  return page;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });

const browser = await launch({ headless: true, width: 1440, height: 900 });
const result = {
  schemaVersion: 1,
  tool: 'tests/e2e/fixes/capture-p0-2-evidence.mjs',
  generatedAt: new Date().toISOString(),
  node: process.version,
  bases: { data: args.data, mock: args.mock },
  watchedFiles: WATCHED.map(fileFacts),
  pages: [],
  mutations: [],
  shots: [],
};

try {
  // 1) 两栈 × 两页 × 暗/亮：8 组逐组点开，记录正文长度与页面文本；各出一张截图。
  for (const [stack, base] of [['data', args.data], ['mock', args.mock]]) {
    for (const route of ['#/settings', '#/models']) {
      for (const theme of ['dark', 'light']) {
        const page = await openPage(browser, { base, path: `?theme=${theme}&lang=en&static=1${route}`, theme });
        try {
          const initial = await page.evaluate(PROBE);
          const shotName = `p0-2-${stack}-${route.replace(/[#/]/gu, '') || 'root'}-${theme}.png`;
          writeFileSync(join(args.out, shotName), await page.screenshot({ fullPage: true }));
          result.shots.push({ file: shotName, stack, route, theme, activeGroup: 'models' });
          const groups = { models: initial.bodyTextLength };
          for (const group of GROUPS) {
            if (group === 'models') continue;
            await page.click(`#ui-tab-${group}`);
            await page.waitFor(
              `(() => {
                const body = document.querySelector('#settings-body');
                return body !== null && (body.innerText || '').trim().length > 100;
              })()`,
              { timeoutMs: 10_000, label: `${stack} ${route} ${group}` },
            );
            groups[group] = (await page.evaluate(PROBE)).bodyTextLength;
            if (stack === 'data' && route === '#/settings' && theme === 'dark' && group === 'collection') {
              const groupShot = 'p0-2-data-settings-dark-collection.png';
              writeFileSync(join(args.out, groupShot), await page.screenshot({ fullPage: true }));
              result.shots.push({ file: groupShot, stack, route, theme, activeGroup: 'collection' });
            }
          }
          const final = await page.evaluate(PROBE);
          const report = page.report();
          result.pages.push({
            stack,
            base,
            route,
            theme,
            lang: final.lang,
            initialPageTextLength: initial.pageTextLength,
            finalPageTextLength: final.pageTextLength,
            tabCount: final.tabCount,
            tabIds: final.tabIds,
            groups,
            groupsTotal: Object.values(groups).reduce((sum, value) => sum + value, 0),
            fallbackAnywhere: initial.fallback || final.fallback,
            undefinedIdentifier: initial.undefinedIdentifier || final.undefinedIdentifier,
            exceptions: report.exceptions,
            consoleErrors: report.consoleErrors,
            logErrors: report.logErrors,
            badResponses: report.badResponses,
          });
        } finally {
          await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
        }
      }
    }
  }

  // 2) zh-CN（默认语言）逐组：证明主语言下 8 组也全部渲染（合同 §8 默认 zh-CN）。
  {
    const page = await openPage(browser, { base: args.data, path: '?theme=dark&lang=zh-CN&static=1#/settings', theme: 'dark' });
    try {
      const initial = await page.evaluate(PROBE);
      const groups = { models: initial.bodyTextLength };
      for (const group of GROUPS) {
        if (group === 'models') continue;
        await page.click(`#ui-tab-${group}`);
        await page.waitFor(
          `(() => {
            const body = document.querySelector('#settings-body');
            return body !== null && (body.innerText || '').trim().length > 100;
          })()`,
          { timeoutMs: 10_000, label: `zh-CN ${group}` },
        );
        groups[group] = (await page.evaluate(PROBE)).bodyTextLength;
      }
      const final = await page.evaluate(PROBE);
      const report = page.report();
      const shotName = 'p0-2-data-settings-zh-CN.png';
      writeFileSync(join(args.out, shotName), await page.screenshot({ fullPage: true }));
      result.shots.push({ file: shotName, stack: 'data', route: '#/settings', theme: 'dark', lang: 'zh-CN', activeGroup: 'models' });
      result.pages.push({
        stack: 'data',
        base: args.data,
        route: '#/settings',
        theme: 'dark',
        lang: final.lang,
        initialPageTextLength: initial.pageTextLength,
        finalPageTextLength: final.pageTextLength,
        tabCount: final.tabCount,
        tabIds: final.tabIds,
        groups,
        groupsTotal: Object.values(groups).reduce((sum, value) => sum + value, 0),
        fallbackAnywhere: initial.fallback || final.fallback,
        undefinedIdentifier: initial.undefinedIdentifier || final.undefinedIdentifier,
        exceptions: report.exceptions,
        consoleErrors: report.consoleErrors,
        logErrors: report.logErrors,
        badResponses: report.badResponses,
      });
    } finally {
      await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  }

  // 3) 变异转红：models.js 去掉 checkbox 导入（磁盘零改动），记录旧的兜底症状 + 截图。
  for (const route of ['#/settings', '#/models']) {
    const page = await browser.newPage({ width: 1440, height: 900 });
    await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
    const mutation = await installImportMutation(page, {
      urlSuffix: '/js/views/settings/models.js',
      dropBinding: 'checkbox',
    });
    try {
      await page.goto(`${args.data}/?theme=dark&lang=en&static=1${route}`);
      await page.waitFor(
        `(() => {
          const body = document.querySelector('#settings-body');
          return body !== null && (body.innerText || '').includes('This settings group failed to render');
        })()`,
        { timeoutMs: 25_000, label: `mutation ${route}` },
      );
      const probe = await page.evaluate(PROBE);
      const shotName = `p0-2-mutation-models-js-${route.replace(/[#/]/gu, '')}.png`;
      writeFileSync(join(args.out, shotName), await page.screenshot({ fullPage: true }));
      result.shots.push({ file: shotName, stack: 'data', route, theme: 'dark', mutation: 'models.js: drop checkbox import' });
      result.mutations.push({
        target: 'apps/console-next/js/views/settings/models.js',
        droppedBinding: 'checkbox',
        route,
        interceptions: mutation.mutations,
        patch: mutation.lastPatch,
        probe,
      });
    } finally {
      await mutation.remove();
      await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    }
  }

  // 3) 变异转红（第二处潜在站点）：shared.js 去掉 checkbox 导入 → collection 组复现。
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
  const mutation = await installImportMutation(page, {
    urlSuffix: '/js/views/settings/shared.js',
    dropBinding: 'checkbox',
  });
  try {
    await page.goto(`${args.data}/?theme=dark&lang=en&static=1#/settings`);
    await page.waitFor(
      `(() => {
        const body = document.querySelector('#settings-body');
        return body !== null && (body.innerText || '').trim().length > 50;
      })()`,
      { timeoutMs: 25_000, label: 'mutation shared.js mount' },
    );
    const before = await page.evaluate(PROBE);
    await page.click('#ui-tab-collection');
    await page.waitFor(
      `(() => {
        const body = document.querySelector('#settings-body');
        return body !== null && (body.innerText || '').includes('This settings group failed to render');
      })()`,
      { timeoutMs: 10_000, label: 'mutation shared.js collection' },
    );
    const probe = await page.evaluate(PROBE);
    const shotName = 'p0-2-mutation-shared-js-collection.png';
    writeFileSync(join(args.out, shotName), await page.screenshot({ fullPage: true }));
    result.shots.push({ file: shotName, stack: 'data', route: '#/settings', theme: 'dark', mutation: 'shared.js: drop checkbox import' });
    result.mutations.push({
      target: 'apps/console-next/js/views/settings/shared.js',
      droppedBinding: 'checkbox',
      route: '#/settings?group=collection（点击 tab 后）',
      interceptions: mutation.mutations,
      patch: mutation.lastPatch,
      before,
      probe,
    });
  } finally {
    await mutation.remove();
    await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
  }
} finally {
  await browser.close();
}

result.watchedFilesAfter = WATCHED.map(fileFacts);
result.watchedFilesUnchanged = result.watchedFiles.every((before) => {
  const after = result.watchedFilesAfter.find((entry) => entry.path === before.path);
  return after !== undefined && after.sha256 === before.sha256;
});

writeFileSync(join(args.out, 'VERIFY-P0-2.probe.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  out: args.out,
  pages: result.pages.length,
  mutations: result.mutations.length,
  shots: result.shots.length,
  watchedFilesUnchanged: result.watchedFilesUnchanged,
  greenPages: result.pages.filter((page) => page.fallbackAnywhere === false && page.tabCount === 8).length,
}, null, 2)}\n`);
