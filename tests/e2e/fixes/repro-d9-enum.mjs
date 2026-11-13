/**
 * tests/e2e/fixes/repro-d9-enum.mjs — D9 的浏览器级复现/取证（作者 PT-dove）
 *
 * 做法：CDP Fetch **响应层**拦截 `/api/v1/settings/schema`，在内存里给
 * `models.routing.mode.values` 追加一个 locale 里不存在的枚举值 `ghost-mode`，
 * 然后打开 `#/settings` 的 models 组，读「路由模式 / Routing mode」下拉的真实标签文本。
 *
 * 修前：选项标签形如 `[missing:settings.enum.models.routing.mode.ghost-mode] Ghost mode`
 * 修后：`Ghost mode`（无缺 key 标记）
 *
 * 磁盘零改动：schema 响应只在传输层被替换。
 *
 * 运行：node tests/e2e/fixes/repro-d9-enum.mjs [--label before|after]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch } from '../lib/cdp.mjs';
import { REPO_ROOT } from './lib/mutate-module.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(REPO_ROOT, 'docs/implementation/evidence/ui2/fixes');
const DATA_BASE = process.env.FIXES_DATA_BASE || 'http://127.0.0.1:17512';

function parseArgs(argv) {
  const args = { label: 'run', out: OUT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--label') { args.label = argv[index + 1]; index += 1; }
    else if (argv[index] === '--out') { args.out = resolve(argv[index + 1]); index += 1; }
  }
  return args;
}

/** 在 schema JSON 里注入一个 locale 没有的枚举值（模拟"未预生成的枚举值"）。 */
export function injectGhostEnum(schemaText) {
  const schema = JSON.parse(schemaText);
  const group = (schema.groups || []).find((entry) => entry.id === 'models');
  if (!group) throw new Error('schema 里没有 models 组');
  const item = (group.items || []).find((entry) => entry.path === 'models.routing.mode');
  if (!item) throw new Error('schema 里没有 models.routing.mode');
  item.values = [...(item.values || []), 'ghost-mode'];
  return JSON.stringify(schema);
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });

const browser = await launch({ headless: true, width: 1440, height: 900 });
const result = {
  schemaVersion: 1,
  tool: 'tests/e2e/fixes/repro-d9-enum.mjs',
  generatedAt: new Date().toISOString(),
  label: args.label,
  base: DATA_BASE,
  injectedEnumValue: 'ghost-mode',
  observed: null,
  shot: null,
};

try {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, page.sessionId);
  await page.setColorScheme('dark');

  const urlPattern = '*/api/v1/settings/schema*';
  await page.connection.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Response' }] }, page.sessionId);
  const errors = [];
  page.connection.on((message) => {
    if (message.sessionId !== page.sessionId) return;
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, responseStatusCode, responseHeaders } = message.params;
    (async () => {
      try {
        const bodyResult = await page.connection.send('Fetch.getResponseBody', { requestId }, page.sessionId);
        const original = bodyResult.base64Encoded
          ? Buffer.from(bodyResult.body, 'base64').toString('utf8')
          : String(bodyResult.body);
        const patched = injectGhostEnum(original);
        await page.connection.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: responseStatusCode ?? 200,
          responseHeaders: (responseHeaders || []).filter((header) => !/^content-length$/iu.test(header.name)),
          body: Buffer.from(patched, 'utf8').toString('base64'),
        }, page.sessionId);
      } catch (error) {
        errors.push(String(error && error.message));
        await page.connection.send('Fetch.continueRequest', { requestId }, page.sessionId).catch(() => {});
      }
    })();
  });

  await page.goto(`${DATA_BASE}/?theme=dark&lang=en&static=1#/settings?group=models`);
  await page.waitFor(
    `(() => {
      const body = document.querySelector('#settings-body');
      return body !== null && (body.innerText || '').trim().length > 200;
    })()`,
    { timeoutMs: 30_000, label: 'settings models group' },
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  const observed = await page.evaluate(`(() => {
    const selects = [...document.querySelectorAll('#settings-body select')];
    const hit = selects.find((node) => [...node.options].some((option) => (option.textContent || '').includes('Ghost mode')));
    const missingLabels = [...document.querySelectorAll('#settings-body option, #settings-body label, #settings-body span')]
      .map((node) => (node.textContent || '').trim())
      .filter((text) => text.includes('[missing:'));
    return {
      foundSelect: hit !== undefined,
      selectPath: hit ? (hit.closest('.settings-item')?.querySelector('.settings-item__path')?.textContent || '').trim() : null,
      options: hit ? [...hit.options].map((option) => ({ value: option.value, label: (option.textContent || '').trim() })) : [],
      ghostOption: hit ? [...hit.options].filter((option) => option.value === 'ghost-mode').map((option) => (option.textContent || '').trim()) : [],
      missingCount: missingLabels.length,
      missingSamples: [...new Set(missingLabels)].slice(0, 5),
    };
  })()`);

  const shotName = `d9-enum-${args.label}.png`;
  writeFileSync(join(args.out, shotName), await page.screenshot({ fullPage: true }));
  result.observed = observed;
  result.shot = shotName;
  result.interceptErrors = errors;
  result.report = page.report();
  await page.connection.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
} finally {
  await browser.close();
}

const target = join(args.out, `repro-d9-${args.label}.json`);
writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  out: target,
  shot: result.shot,
  foundSelect: result.observed?.foundSelect,
  ghostOption: result.observed?.ghostOption,
  missingCount: result.observed?.missingCount,
}, null, 2)}\n`);
