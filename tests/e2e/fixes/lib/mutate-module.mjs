/**
 * tests/e2e/fixes/lib/mutate-module.mjs — CDP 层"只读变异"工具（作者 PT-dove）
 *
 * 目的：证明一条浏览器级断言**真的能变红**，而不改磁盘上的任何生产文件。
 *
 * 做法：用 CDP `Fetch` 域在请求阶段拦截指定前端模块（默认 `apps/console-next/js/**`），
 * 在内存里把 import 语句中的某个绑定删掉（例如 `import { secretInput, checkbox }` →
 * `import { secretInput }`），再把改过的 body `Fetch.fulfillRequest` 回给页面。
 * 页面随后触发 `ReferenceError: xxx is not defined` —— 与真实历史缺陷同症状。
 *
 * 磁盘零改动：文件只读；响应在传输层替换。
 *
 * 用法：
 *   const mutation = await installImportMutation(page, {
 *     urlSuffix: '/js/views/settings/models.js',
 *     dropBinding: 'checkbox',
 *   });
 *   await page.goto(url);          // 页面拿到被变异的模块
 *   // ... 断言 ...
 *   await mutation.remove();       // 断掉拦截（页面刷新即恢复原样）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（tests/e2e/fixes/lib → ../../../../） */
export const REPO_ROOT = join(HERE, '..', '..', '..', '..');
/** console-next 静态根（serve.mjs 的 HERE） */
export const CONSOLE_ROOT = join(REPO_ROOT, 'apps', 'console-next');

/**
 * 从一段 ESM 源码的 import 语句里删掉一个绑定；找不到时抛错（不许静默跳过）。
 * 只改第一条包含该绑定的 `import { ... } from ...` 语句。
 *
 * @param {string} source 原模块源码
 * @param {string} binding 要删掉的导入名（如 'checkbox'）
 * @returns {{code: string, changed: boolean, before: string, after: string}}
 */
export function dropImportBinding(source, binding) {
  if (typeof source !== 'string' || source === '') throw new Error('dropImportBinding: source 必须是非空字符串');
  if (typeof binding !== 'string' || binding === '') throw new Error('dropImportBinding: binding 必须是非空字符串');

  const statement = /^import\s*\{([^}]*)\}\s*from\s*(['"][^'"]+['"]);?/mu;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = statement.exec(line);
    if (match === null) continue;
    const names = match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
    const kept = names.filter((name) => name.split(/\s+as\s+/u).pop().trim() !== binding);
    if (kept.length === names.length) continue;
    const before = line;
    const after = line.replace(
      match[1],
      kept.length > 0 ? ` ${kept.join(', ')} ` : ' ',
    );
    lines[index] = after;
    return { code: lines.join('\n'), changed: true, before, after };
  }
  throw new Error(`dropImportBinding: 没找到导入 ${binding} 的 import 语句（拒绝静默跳过）`);
}

/**
 * 在页面上安装一个"删掉某模块某个导入绑定"的请求拦截。
 *
 * @param {import('../../lib/cdp.mjs').Page} page
 * @param {{urlSuffix: string, dropBinding: string, sourcePath?: string, timeoutMs?: number}} options
 * @returns {Promise<{remove: () => Promise<void>, mutations: number, lastPatch: object|null}>}
 */
export async function installImportMutation(page, options) {
  const { urlSuffix, dropBinding } = options;
  if (!urlSuffix || !urlSuffix.startsWith('/')) throw new Error('installImportMutation: urlSuffix 必须以 / 开头');
  if (!dropBinding) throw new Error('installImportMutation: dropBinding 必填');

  const sourcePath = options.sourcePath || join(CONSOLE_ROOT, urlSuffix.replace(/^\//u, ''));
  const original = readFileSync(sourcePath, 'utf8');
  const patched = dropImportBinding(original, dropBinding);

  const state = { mutations: 0, lastPatch: null, error: null };
  const urlPattern = `*${urlSuffix}*`;
  await page.connection.send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Request' }] }, page.sessionId);

  const off = page.connection.on((message) => {
    if (message.sessionId !== page.sessionId) return;
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    if (!String(request?.url || '').includes(urlSuffix)) {
      page.connection.send('Fetch.continueRequest', { requestId }, page.sessionId).catch((error) => {
        state.error = error;
      });
      return;
    }
    state.mutations += 1;
    state.lastPatch = { url: request.url, before: patched.before, after: patched.after, changed: patched.changed };
    page.connection.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'content-type', value: 'text/javascript; charset=utf-8' },
        { name: 'cache-control', value: 'no-store' },
      ],
      body: Buffer.from(patched.code, 'utf8').toString('base64'),
    }, page.sessionId).catch((error) => {
      state.error = error;
    });
  });

  return {
    get mutations() {
      return state.mutations;
    },
    get lastPatch() {
      return state.lastPatch;
    },
    get error() {
      return state.error;
    },
    async remove() {
      off();
      await page.connection.send('Fetch.disable', {}, page.sessionId).catch(() => {});
    },
  };
}
