/**
 * UI2-B11 · Edge headless 工具（零依赖）
 *
 * 能力：
 * - `edgePath()`：探测 msedge.exe（env `B11_EDGE` → 常见安装路径 → PATH）；
 * - `dumpDom(url, opts)`：`--headless=new --dump-dom`，返回 HTML 文本 + 耗时；
 * - `screenshot(url, outPath, opts)`：`--screenshot` 出 PNG（固定窗口/缩放/隐藏滚动条）；
 * - `cdpEvaluate(url, expression)`：**尽力**通过 DevTools 协议求值（Node 24 自带全局
 *   `WebSocket` + `DevToolsActivePort`）；不可用时不抛错，返回 `{ok:false, reason}`，
 *   由调用方如实降级并记"未验证"。
 *
 * 所有失败都是**显式**的 `{ok:false, reason}`，不吞错也不假装成功。
 *
 * @author PT-dove
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export function edgePath() {
  const env = process.env.B11_EDGE;
  if (env && fs.existsSync(env)) return env;
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function edgeAvailable() {
  return edgePath() !== null;
}

function makeUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'b11-edge-'));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  } catch {
    // Edge 自己的临时 profile 残留不应让测试变红。
  }
}

function runEdge(args, timeoutMs) {
  const exe = edgePath();
  if (exe === null) return Promise.resolve({ ok: false, reason: 'EDGE_NOT_FOUND' });
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
      resolve({ ok: false, reason: 'EDGE_TIMEOUT', stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `EDGE_SPAWN_FAILED:${error?.code ?? 'ERROR'}`, stdout: '', stderr: '' });
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        reason: code === 0 ? null : `EDGE_EXIT_${code}`,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const BASE_ARGS = Object.freeze([
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--disable-lcd-text',
]);

/**
 * `--dump-dom`。
 *
 * @param {string} url
 * @param {{timeoutMs?:number, virtualTimeBudgetMs?:number, extraArgs?:string[]}} [options]
 * @returns {Promise<{ok:boolean, dom?:string, durationMs:number, reason?:string, stderr?:string}>}
 */
export async function dumpDom(url, options = {}) {
  const started = Date.now();
  const userDataDir = makeUserDataDir();
  const args = [
    ...BASE_ARGS,
    `--user-data-dir=${userDataDir}`,
    `--virtual-time-budget=${options.virtualTimeBudgetMs ?? 4000}`,
    '--dump-dom',
    ...(options.extraArgs ?? []),
    url,
  ];
  const result = await runEdge(args, options.timeoutMs ?? 20000);
  cleanupDir(userDataDir);
  return {
    ok: result.ok,
    ...(result.ok
      ? { dom: result.stdout }
      : { reason: result.reason, stderr: result.stderr }),
    durationMs: Date.now() - started,
  };
}

/**
 * `--screenshot`。返回 PNG Buffer（调用方决定落盘/比较）。
 *
 * @param {string} url
 * @param {{timeoutMs?:number, virtualTimeBudgetMs?:number, width?:number, height?:number, extraArgs?:string[]}} [options]
 * @returns {Promise<{ok:boolean, png?:Buffer, durationMs:number, reason?:string, stderr?:string}>}
 */
export async function screenshot(url, options = {}) {
  const started = Date.now();
  const userDataDir = makeUserDataDir();
  const outPath = path.join(userDataDir, 'shot.png');
  const width = options.width ?? 1440;
  const height = options.height ?? 1000;
  const args = [
    ...BASE_ARGS,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${options.virtualTimeBudgetMs ?? 5000}`,
    `--screenshot=${outPath}`,
    ...(options.extraArgs ?? []),
    url,
  ];
  const result = await runEdge(args, options.timeoutMs ?? 30000);
  let png = null;
  if (result.ok && fs.existsSync(outPath)) png = fs.readFileSync(outPath);
  cleanupDir(userDataDir);
  if (!result.ok) return { ok: false, reason: result.reason, durationMs: Date.now() - started, stderr: result.stderr };
  if (png === null) return { ok: false, reason: 'SCREENSHOT_NOT_WRITTEN', durationMs: Date.now() - started };
  return { ok: true, png, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// CDP（尽力而为；失败返回 {ok:false, reason}，不抛错）
// ---------------------------------------------------------------------------

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 打开一个带 remote-debugging 的 headless Edge 会话（唯一临时 profile；调用方负责 cleanup）。
 *
 * @returns {Promise<{ok:true, send:Function, cleanup:Function, closeSocket:Function} | {ok:false, reason:string}>}
 */
async function openCdpSession(options = {}) {
  if (typeof WebSocket !== 'function') return { ok: false, reason: 'NO_GLOBAL_WEBSOCKET' };
  const exe = edgePath();
  if (exe === null) return { ok: false, reason: 'EDGE_NOT_FOUND' };
  const userDataDir = makeUserDataDir();
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const child = spawn(exe, [
    ...BASE_ARGS,
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

  const cleanup = async () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    cleanupDir(userDataDir);
  };

  try {
    const deadline = Date.now() + (options.timeoutMs ?? 25000);
    let port = null;
    while (port === null) {
      try {
        const lines = fs.readFileSync(portFile, 'utf8').split(/\r?\n/u);
        const value = Number(lines[0]);
        if (Number.isInteger(value) && value > 0) port = value;
      } catch {
        port = null;
      }
      if (port === null) {
        if (Date.now() > deadline) {
          await cleanup();
          return { ok: false, reason: 'CDP_PORT_FILE_TIMEOUT' };
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) : null;
    if (!page) {
      await cleanup();
      return { ok: false, reason: 'CDP_NO_PAGE_TARGET' };
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 1;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`cdp ${method} timeout`));
        }
      }, 8000);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
      setTimeout(() => reject(new Error('cdp websocket open timeout')), 5000);
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    });
    return {
      ok: true,
      send,
      child,
      cleanup,
      closeSocket() {
        try {
          socket.close();
        } catch {
          // 已关闭
        }
      },
    };
  } catch (error) {
    await cleanup();
    return { ok: false, reason: `CDP_FAILED:${error?.message ?? 'ERROR'}` };
  }
}

/** 导航 + 可选就绪条件轮询。返回是否在超时前满足条件（不抛错）。 */
async function preparePage(session, url, options = {}) {
  await session.send('Page.enable');
  if (options.width && options.height) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  await session.send('Page.navigate', { url });
  await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? 800));
  const waitExpression = typeof options.waitForExpression === 'string' ? options.waitForExpression : '';
  if (waitExpression === '') return true;
  const deadline = Date.now() + (options.waitForTimeoutMs ?? 20000);
  for (;;) {
    const probe = await session.send('Runtime.evaluate', { expression: waitExpression, returnByValue: true });
    if (probe?.result?.value) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 启动一个带 remote-debugging 的 headless Edge，并在页面里求值。
 *
 * @param {string} url
 * @param {string} expression
 * @param {{timeoutMs?:number, waitMs?:number, waitForExpression?:string, waitForTimeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, value?:any, ready?:boolean, reason?:string}>}
 */
export async function cdpEvaluate(url, expression, options = {}) {
  const session = await openCdpSession(options);
  if (session.ok !== true) return session;
  try {
    const ready = await preparePage(session, url, options);
    const evaluation = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return { ok: true, value: evaluation?.result?.value, ready };
  } catch (error) {
    return { ok: false, reason: `CDP_FAILED:${error?.message ?? 'ERROR'}` };
  } finally {
    session.closeSocket();
    await session.cleanup();
  }
}

/**
 * 复用**一个** headless Edge 会话完成多页采集（矩阵/审计用；比一页一进程快一个量级）。
 *
 * 契约与 `cdpEvaluate`/`cdpScreenshot` 一致：失败返回 `{ok:false, reason}`，不抛错。
 * `fn` 收到 `{send, navigate, evaluate, screenshot, setViewport, addInitScript}`；
 * 会话在 `fn` 结束（含抛错）后必定关闭并清理临时 profile。
 *
 * @param {{width?:number, height?:number, timeoutMs?:number}} options
 * @param {(api: object) => Promise<any>} fn
 * @returns {Promise<any>} `fn` 的返回值，或 `{ok:false, reason}`
 */
export async function withCdpPage(options, fn) {
  const session = await openCdpSession(options);
  if (session.ok !== true) return { ok: false, reason: session.reason };
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  try {
    const api = {
      send: session.send,
      async setViewport(nextWidth, nextHeight) {
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: nextWidth,
          height: nextHeight,
          deviceScaleFactor: 1,
          mobile: false,
        });
      },
      async addInitScript(source) {
        await session.send('Page.addScriptToEvaluateOnNewDocument', { source: String(source) });
      },
      async navigate(url, navigation = {}) {
        await session.send('Page.enable');
        await session.send('Page.navigate', { url });
        await new Promise((resolve) => setTimeout(resolve, navigation.waitMs ?? 800));
        const expression = typeof navigation.waitExpression === 'string' ? navigation.waitExpression : '';
        if (expression === '') return true;
        const deadline = Date.now() + (navigation.waitForTimeoutMs ?? 20000);
        for (;;) {
          const probe = await session.send('Runtime.evaluate', { expression, returnByValue: true });
          if (probe?.result?.value) return true;
          if (Date.now() > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      },
      async evaluate(expression) {
        const evaluation = await session.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (evaluation?.exceptionDetails) {
          throw new Error(`evaluate threw: ${evaluation.exceptionDetails.text ?? 'exception'}`);
        }
        return evaluation?.result?.value;
      },
      async screenshot() {
        const shot = await session.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        });
        return Buffer.from(shot.data, 'base64');
      },
    };
    await api.setViewport(width, height);
    return await fn(api);
  } catch (error) {
    return { ok: false, reason: `CDP_PAGE_FAILED:${error?.message ?? 'ERROR'}` };
  } finally {
    session.closeSocket();
    await session.cleanup();
  }
}

/**
 * 启动 headless Edge，导航到 url，等待就绪条件后截 PNG（一个页面一次进程，25s 上限由调用方传）。
 *
 * @param {string} url
 * @param {{
 *   width?:number, height?:number, waitMs?:number, settleMs?:number,
 *   waitForExpression?:string, waitForTimeoutMs?:number, timeoutMs?:number,
 * }} [options]
 * @returns {Promise<{ok:boolean, png?:Buffer, ready?:boolean, width?:number, height?:number, durationMs:number, reason?:string}>}
 */
export async function cdpScreenshot(url, options = {}) {
  const started = Date.now();
  const session = await openCdpSession(options);
  if (session.ok !== true) return { ...session, durationMs: Date.now() - started };
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  try {
    const ready = await preparePage(session, url, {
      waitMs: options.waitMs ?? 800,
      waitForExpression: options.waitForExpression,
      waitForTimeoutMs: options.waitForTimeoutMs ?? 20000,
      width,
      height,
    });
    // 让字体/布局/焦点环稳定（不改变页面内容，只延时采样）。
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 400));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const png = Buffer.from(shot.data, 'base64');
    return { ok: true, png, ready, width, height, durationMs: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: `CDP_SCREENSHOT_FAILED:${error?.message ?? 'ERROR'}`, durationMs: Date.now() - started };
  } finally {
    session.closeSocket();
    await session.cleanup();
  }
}
