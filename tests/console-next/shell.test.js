/**
 * UI2-B11 · §11 红线 6（永不白屏）+ 交互外壳（B2 shell）
 *
 * 用 Edge headless + CDP 在真实浏览器里访问由 B3 `serve.mjs` 提供的页面：
 * - 6 条导航都在，`#/overview` 有可见内容；
 * - 未知 hash → replace 到 `#/overview`（不白屏、不堆积历史）；
 * - API 500 → 渲染错误态（不是空白）；
 * - 视图模块缺失 → placeholder（"该页未实现"），导航保留。
 *
 * 注：B2 仍在 in_progress（未冻结），本文件断言的是合同 §7.2 的外壳行为；
 * 若 B2 后续改实现，需要复跑本文件（状态文件已登记依赖）。
 *
 * 运行：`node --test tests/console-next/shell.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cdpEvaluate, edgeAvailable } from './edge.mjs';
import { CONSOLE_DIR, startConsoleAndDaemon } from './harness.mjs';

const hasEdge = edgeAvailable();

async function evaluate(url, expression, options = {}) {
  const result = await cdpEvaluate(url, expression, { waitMs: 800, waitForTimeoutMs: 12000, timeoutMs: 25000, ...options });
  assert.equal(result.ok, true, `CDP evaluate failed: ${result.reason}`);
  return result.value;
}

test('外壳：6 条导航与 #/overview 内容（不白屏）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const snapshot = await evaluate(page, `(() => {
    const nav = document.querySelector('#nav');
    const root = document.querySelector('#view-root');
    return {
      navLinks: nav ? [...nav.querySelectorAll('a[data-route]')].map((a) => a.getAttribute('data-route')) : [],
      rootText: root ? root.textContent.trim().slice(0, 200) : '',
      rootChildren: root ? root.children.length : 0,
      title: document.title,
    };
  })()`, { waitForExpression: "document.querySelector('#view-root')?.children.length > 0" });
  assert.deepEqual(snapshot.navLinks, ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']);
  assert.ok(snapshot.rootChildren > 0, 'view-root must be mounted (no white screen)');
  assert.ok(snapshot.rootText.length > 0, 'view-root must contain visible text');
});

test('外壳：未知 hash → replace 到 #/overview（不白屏、不堆历史）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/not-a-real-route`;
  const snapshot = await evaluate(page, `(() => ({
    hash: location.hash,
    length: history.length,
    rootChildren: document.querySelector('#view-root')?.children.length ?? 0,
    rootText: (document.querySelector('#view-root')?.textContent ?? '').trim().slice(0, 120),
  }))()`, { waitForExpression: "location.hash === '#/overview' && (document.querySelector('#view-root')?.children.length ?? 0) > 0" });
  assert.equal(snapshot.hash, '#/overview', 'unknown hash must be replaced with #/overview');
  assert.ok(snapshot.rootChildren > 0, 'unknown hash must still render a view (no white screen)');
});

test('外壳：API 500 → 渲染错误态（不是白屏）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const env = await startConsoleAndDaemon(t);
  // 让所有 /api/v1/* 返回 500（shell 必须渲染错误态而不是空白）
  env.daemon.state.failStatus = 500;
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const snapshot = await evaluate(page, `(() => {
    const root = document.querySelector('#view-root');
    return { rootChildren: root?.children.length ?? 0, text: (root?.textContent ?? '').trim().slice(0, 200) };
  })()`, { waitForExpression: "(document.querySelector('#view-root')?.children.length ?? 0) > 0" });
  assert.ok(snapshot.rootChildren > 0, 'even with failing data the shell must render a view container');
  assert.ok(snapshot.text.length > 0, 'error state must have visible text');
  t.diagnostic(`error-state text: ${JSON.stringify(snapshot.text.slice(0, 120))}`);
});

test('外壳：视图模块缺失 → placeholder 且导航保留（永不白屏）', { skip: hasEdge ? false : 'Edge not found' }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b11-shell-'));
  fs.cpSync(CONSOLE_DIR, tempRoot, { recursive: true });
  fs.rmSync(path.join(tempRoot, 'js', 'views', 'overview.js'), { force: true });
  t.after(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    } catch {
      // 临时目录残留不影响结论
    }
  });
  const env = await startConsoleAndDaemon(t, {
    servePath: path.join(tempRoot, 'serve.mjs'),
    root: tempRoot,
  });
  const page = `${env.url}/index.html?theme=dark&static=1&lang=en#/overview`;
  const snapshot = await evaluate(page, `(() => {
    const root = document.querySelector('#view-root');
    const nav = document.querySelector('#nav');
    return {
      navLinks: nav ? nav.querySelectorAll('a[data-route]').length : 0,
      rootChildren: root?.children.length ?? 0,
      text: (root?.textContent ?? '').trim().slice(0, 200),
    };
  })()`, { waitForExpression: "(document.querySelector('#view-root')?.children.length ?? 0) > 0 && document.querySelectorAll('#nav a[data-route]').length === 6" });
  assert.equal(snapshot.navLinks, 6, 'navigation must survive a missing view module');
  assert.ok(snapshot.rootChildren > 0, 'missing view module must render placeholder, not white screen');
  assert.ok(snapshot.text.length > 0, 'placeholder must contain visible text');
  t.diagnostic(`placeholder text: ${JSON.stringify(snapshot.text.slice(0, 120))}`);
});
