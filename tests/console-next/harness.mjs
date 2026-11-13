/**
 * UI2-B11 · 组合夹具：假 daemon + B3 console host（供 shell/视觉/a11y 用例复用）
 *
 * @author PT-dove
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeDaemon } from './fake-daemon.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
export const SERVE = path.join(REPO_ROOT, 'apps', 'console-next', 'serve.mjs');
export const CONSOLE_DIR = path.join(REPO_ROOT, 'apps', 'console-next');
export const TOKEN = 'b11-console-token-0123456789abcdef';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 启动假 daemon + console host（--port 0），返回可访问 URL。
 *
 * @param {import('node:test').TestContext} t
 * @param {{daemon?: object, servePath?: string, token?: string, root?: string}} [options]
 */
export async function startConsoleAndDaemon(t, options = {}) {
  const daemon = await startFakeDaemon(t, options.daemon ?? {});
  const servePath = options.servePath ?? SERVE;
  const child = spawn(process.execPath, [
    servePath,
    '--daemon', daemon.url,
    '--token', options.token ?? TOKEN,
    '--port', '0',
    '--host', '127.0.0.1',
  ], { cwd: options.root ?? REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let exited = null;
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });
  t.after(async () => {
    if (exited === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
  const deadline = Date.now() + 8000;
  let announce = null;
  while (announce === null) {
    const line = stdout.join('').split(/\r?\n/u).find((entry) => entry.trim().startsWith('{'));
    if (line) {
      try {
        announce = JSON.parse(line);
      } catch {
        announce = null;
      }
    }
    if (announce === null) {
      if (Date.now() > deadline) throw new Error(`console host did not announce; stderr=${stderr.join('')}`);
      await sleep(20);
    }
  }
  return {
    daemon,
    child,
    announce,
    url: announce.listening.replace(/\/$/u, ''),
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
  };
}
