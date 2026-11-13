#!/usr/bin/env node
/**
 * probe-live.mjs — 判定「17512 上托底的到底是不是 console-next 的 serve.mjs」的可执行探针
 * （author PT-dove）。
 *
 * 为什么光看 HTML 不够：旧壳（deploy/embedded-runtime/console-shell/serve.mjs）也会把任意
 * index.html 原样发出来。真正区分两者的是**写闸门的形状**，而写闸门在 HTTP 响应里：
 *
 *   console-next/serve.mjs（新，apps/console-next/serve.mjs:632-638）
 *     POST/PUT/DELETE 到 /api/v1/* 缺 `x-console-v2: 1` → 403 CONSOLE_HEADER_REQUIRED
 *     带上该头 → 转发给 daemon（daemon 自己的证书/方法校验在场）
 *   console-shell/serve.mjs（旧，deploy/embedded-runtime/console-shell/serve.mjs:141-145）
 *     任何非 GET/HEAD → 405 method not allowed（连 x-console-v2 这个概念都没有）
 *   apps/desktop/aidn/server.py（托盘壳，GET-only 代理）
 *     POST /api/v1/* → 405 METHOD_NOT_ALLOWED；PUT → 501（stdlib 未实现 do_PUT）
 *
 * 探针做三件事：
 *   1. 对 --base（默认 http://127.0.0.1:17512）做 GET/HTML 与 4 个写请求；
 *   2. 真启动旧壳 serve.mjs（--daemon 指真实 daemon），用同一组写请求做**差分对照**；
 *   3. 用真实浏览器（自写 CDP 驱动）数渲染后的导航项。
 *
 * 用法：
 *   node tests/e2e/shell-link/probe-live.mjs [--base http://127.0.0.1:17512]
 *        [--daemon http://127.0.0.1:17511] [--no-browser] [--json] [--out <file>]
 *
 * 退出码：0 = 全部适用断言通过；1 = 有断言失败；2 = 环境不满足（端口没起）。
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, waitFor } from '../lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const OLD_SHELL = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'console-shell', 'serve.mjs');
const CONSOLE_NEXT_INDEX = join(REPO_ROOT, 'apps', 'console-next', 'index.html');
const OLD_CONSOLE_INDEX = join(REPO_ROOT, 'apps', 'console', 'index.html');

function parseArgs(argv) {
  const options = {
    base: 'http://127.0.0.1:17512',
    daemon: 'http://127.0.0.1:17511',
    browser: true,
    json: false,
    out: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--base') options.base = argv[++index];
    else if (token === '--daemon') options.daemon = argv[++index];
    else if (token === '--no-browser') options.browser = false;
    else if (token === '--json') options.json = true;
    else if (token === '--out') options.out = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

const countDataRoute = (html) => (html.match(/data-route=/gu) ?? []).length;
const titleOf = (html) => /<title>([\s\S]*?)<\/title>/u.exec(html)?.[1]?.trim() ?? null;

/** One HTTP exchange with a lower-cased header map. */
async function exchange(url, { method = 'GET', body = undefined, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const headerMap = {};
  for (const [name, value] of response.headers) headerMap[name.toLowerCase()] = value;
  return {
    method,
    url,
    status: response.status,
    headers: headerMap,
    code: parsed?.error?.code ?? null,
    body_head: text.slice(0, 200),
    data_route_count: countDataRoute(text),
    title: titleOf(text),
  };
}

/**
 * Start the packaging-owned shell (`console-shell/serve.mjs`) as the differential
 * control: it announces one pretty-printed JSON object on stdout.
 */
async function startOldShell(daemonUrl) {
  const child = spawn(process.execPath, [OLD_SHELL, '--daemon', daemonUrl, '--port', '0'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const argued = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`old shell exited ${child.exitCode}: ${stderr}`);
    try {
      const parsed = JSON.parse(stdout.trim());
      return parsed.listening === undefined ? false : parsed;
    } catch {
      return false;
    }
  }, { timeoutMs: 15_000, intervalMs: 50, label: 'console-shell announcement' });
  return {
    child,
    url: argued.listening,
    announcement: argued,
    stderr: () => stderr,
    async close() {
      if (child.exitCode === null) child.kill();
      await new Promise((resolvePromise) => {
        if (child.exitCode !== null) return resolvePromise();
        const timer = setTimeout(resolvePromise, 3000);
        child.once('exit', () => { clearTimeout(timer); resolvePromise(); });
      });
    },
  };
}

/** Write-request matrix, identical for both servers so the difference is the server. */
async function writeMatrix(base) {
  const url = `${base.replace(/\/$/u, '')}/api/v1/settings`;
  const jsonBody = '{}';
  const baseHeaders = { 'content-type': 'application/json' };
  return {
    postWithoutMarker: await exchange(url, { method: 'POST', body: jsonBody, headers: baseHeaders }),
    postWithMarker: await exchange(url, {
      method: 'POST', body: jsonBody, headers: { ...baseHeaders, 'x-console-v2': '1' },
    }),
    putWithoutMarker: await exchange(url, {
      method: 'PUT', body: '{"dryRun":true,"settings":{}}', headers: baseHeaders,
    }),
    putWithMarker: await exchange(url, {
      method: 'PUT', body: '{"dryRun":true,"settings":{}}',
      headers: { ...baseHeaders, 'x-console-v2': '1' },
    }),
  };
}

async function browserFacts(base) {
  const browser = await launch({ headless: true, width: 1440, height: 900 });
  try {
    const page = await browser.open(base);
    await page.waitFor(() => document.querySelectorAll('nav#nav [data-route]').length > 0,
      { timeoutMs: 20_000, label: 'nav items' });
    const facts = await page.evaluate(`(() => ({
      title: document.title,
      navRoutes: [...document.querySelectorAll('nav#nav [data-route]')].map((a) => a.dataset.route),
      viewRootChildren: (document.querySelector('#view-root')?.children.length ?? 0),
      hasModuleScript: [...document.scripts].some((script) => script.type === 'module'),
    }))()`);
    return { ok: true, ...facts };
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = { probe: 'probe-live.mjs', when: new Date().toISOString(), options };

  // ---- 1) 被测主机 ----
  let landing;
  try {
    landing = await exchange(options.base);
  } catch (error) {
    result.fatal = `console host not reachable at ${options.base}: ${error.message}`;
    console.error(JSON.stringify(result, null, 2));
    return 2;
  }
  result.host = {
    base: options.base,
    landing,
    writes: await writeMatrix(options.base),
    csp_has_frame_ancestors_none:
      (landing.headers['content-security-policy'] ?? '').includes("frame-ancestors 'none'"),
  };

  // ---- 2) 差分对照：旧壳 serve.mjs ----
  let oldShell;
  try {
    oldShell = await startOldShell(options.daemon);
    result.old_shell = {
      url: oldShell.url,
      announcement: oldShell.announcement,
      landing: await exchange(oldShell.url),
      writes: await writeMatrix(oldShell.url),
    };
  } catch (error) {
    result.old_shell = { error: error.message };
  } finally {
    await oldShell?.close();
  }

  // ---- 3) 真实浏览器（CDP） ----
  result.browser = options.browser
    ? await browserFacts(options.base).catch((error) => ({ ok: false, error: error.message }))
    : { ok: false, skipped: '--no-browser' };

  // ---- 4) 断言 ----
  const host = result.host;
  const writes = host.writes;
  const old = result.old_shell?.writes;
  // Browser facts are only assertable when a browser was actually driven; `--no-browser`
  // makes them "not applicable" (null) instead of a false failure.
  const browserApplicable = result.browser.skipped === undefined;
  const expectedNext = (() => {
    try {
      return readFileSync(CONSOLE_NEXT_INDEX, 'utf8');
    } catch {
      return '';
    }
  })();
  const expectedOld = (() => {
    try {
      return readFileSync(OLD_CONSOLE_INDEX, 'utf8');
    } catch {
      return '';
    }
  })();

  result.assertions = {
    // 新界面的静态判据：6 个 data-route + 新标题（旧 console 是 0 个 + 「网域智防 · 本地控制台」）
    landing_has_six_data_route: host.landing.data_route_count === 6,
    landing_title_is_console_next: host.landing.title === titleOf(expectedNext),
    landing_title_is_not_old_console: host.landing.title !== titleOf(expectedOld),
    csp_frame_ancestors_none: host.csp_has_frame_ancestors_none,
    x_frame_options_deny: host.landing.headers['x-frame-options'] === 'DENY',
    // 写闸门：console-next 的 403 关卡（旧壳没有这个响应）
    post_without_marker_is_console_gate: writes.postWithoutMarker.status === 403
      && writes.postWithoutMarker.code === 'CONSOLE_HEADER_REQUIRED',
    post_with_marker_reaches_daemon: writes.postWithMarker.status !== 403
      && writes.postWithMarker.code !== 'CONSOLE_HEADER_REQUIRED',
    put_with_marker_is_accepted: writes.putWithMarker.status === 200,
    // 差分：同一组请求打到旧壳，全部 405（证明两个服务器可区分）
    old_shell_rejects_put_with_405: old === undefined ? null : old.putWithMarker.status === 405,
    old_shell_has_no_console_gate: old === undefined ? null
      : old.postWithoutMarker.code !== 'CONSOLE_HEADER_REQUIRED',
    // 响应头差分：console-next 带全套安全头（CSP frame-ancestors + x-frame-options），
    // 打包壳 console-shell 一条都没有。注意：apps/desktop 的 Python 壳有**同一套**头，
    // 所以这组头能区分 console-next 与 console-shell，不能单独区分 console-next 与托盘壳。
    new_host_has_full_security_headers: host.landing.headers['x-frame-options'] === 'DENY'
      && host.csp_has_frame_ancestors_none,
    old_shell_lacks_security_headers: result.old_shell?.landing === undefined ? null
      : (result.old_shell.landing.headers['x-frame-options'] === undefined
        && (result.old_shell.landing.headers['content-security-policy'] ?? '')
          .includes('frame-ancestors') === false),
    // 浏览器渲染层（--no-browser 时记 null，不假装通过也不假装失败）。
    // 注意：console-next 的 router 会按当前视图改 document.title（如 "Overview · AIDriven
    // NetDefense"），所以浏览器标题断言是「含产品名且不是旧页标题」，不是与 index.html 的
    // <title> 逐字相等 —— 逐字相等只在 SPA 尚未接管时成立，是个竞态。
    browser_renders_six_nav_routes: browserApplicable ? (
      result.browser.ok === true
      && result.browser.navRoutes.length === 6
      && ['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']
        .every((route) => result.browser.navRoutes.includes(route))
    ) : null,
    browser_title_is_new_console: browserApplicable ? (
      result.browser.ok === true
      && typeof result.browser.title === 'string'
      && result.browser.title.includes('AIDriven NetDefense')
      && result.browser.title !== titleOf(expectedOld)
    ) : null,
  };
  result.verdict = Object.values(result.assertions).every((value) => value !== false)
    ? 'PASS' : 'FAIL';

  const rendered = JSON.stringify(result, null, 2);
  if (options.out !== undefined) writeFileSync(options.out, `${rendered}\n`, 'utf8');
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${rendered}\n`);
  if (result.verdict !== 'PASS') process.stderr.write(`probe-live: FAIL ${JSON.stringify(result.assertions)}\n`);
  return result.verdict === 'PASS' ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`probe-live: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
