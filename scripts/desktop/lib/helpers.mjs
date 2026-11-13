/**
 * helpers.mjs —— 验收脚本共用的小工具（作者 PT-dove）。
 *
 * 只做三件事：跑进程、等 HTTP、收进程树。刻意不引第三方依赖，
 * 因为验收必须能在裸环境里重复执行。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

// 本文件在 scripts/desktop/lib/，仓库根在上三级。
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const NODE = 'C:/Program Files/nodejs/node.exe';
export const TEMP = process.env.TEMP || '/tmp';

export function exePath() {
  const candidates = [
    join(REPO, 'dist', 'desktop', 'payload', 'AIDrivenNetDefense.exe'),
    join(REPO, 'dist', 'installer-desktop', 'payload', 'AIDrivenNetDefense.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function noProxy() {
  // 本机设了 http_proxy 但没有 no_proxy；回环请求必须绕开代理，否则偶发 502。
  process.env.no_proxy = '127.0.0.1,localhost,::1';
  process.env.NO_PROXY = process.env.no_proxy;
}

export async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeout ?? 8000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function waitFor(fn, { timeout = 30000, interval = 400, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      // 继续等
    }
    await delay(interval);
  }
  throw new Error(`${label}在 ${timeout}ms 内没有满足`);
}

export async function waitHttp(url, timeout = 40000) {
  return waitFor(async () => {
    try {
      const { status } = await httpJson(url, { timeout: 2000 });
      return status === 200 ? true : false;
    } catch {
      return false;
    }
  }, { timeout, label: url });
}

export function spawnShell(exe, args, env) {
  const child = spawn(exe, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

export function shellPost(port, path, payload = {}) {
  return httpJson(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aidn-shell': '1' },
    body: JSON.stringify(payload),
  });
}

export function pidAlive(pid) {
  if (!pid) return false;
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
  return (result.stdout || '').includes(String(pid));
}

export function cleanupTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function banner(title) {
  process.stdout.write(`\n===== ${title} =====\n`);
}

export function check(name, ok, detail) {
  process.stdout.write(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail === undefined ? '' : `  ${detail}`}\n`);
  return ok ? 1 : 0;
}

export function finish(passed, failed) {
  process.stdout.write(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
