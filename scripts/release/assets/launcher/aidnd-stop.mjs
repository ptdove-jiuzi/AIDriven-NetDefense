#!/usr/bin/env node
// AIDriven NetDefense — portable pre-release stopper (author PT-dove).
//
// Asks the launcher to shut down over its loopback endpoint, waits for both the
// launcher and the worker to be gone, removes the disposable attempt tree, and
// reports what it observed. It never kills a process it did not start: the pids
// come from `run/state.json`, which only this package writes.
//
// Exit codes: 0 stopped (or was already stopped), 1 could not stop cleanly,
//             2 bad usage, 3 stale state could not be cleared.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'));
const RUN_DIR = join(ROOT, 'run');
const STATE_FILE = join(RUN_DIR, 'state.json');

function parseArgs(argv) {
  const options = { timeoutMs: 20000, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--timeout') options.timeoutMs = Number(argv[++index]) * 1000;
    else if (argv[index] === '--force') options.force = true;
    else if (argv[index] === '--help' || argv[index] === '-h') {
      process.stdout.write('usage: stop.cmd [--timeout <seconds>] [--force]\n');
      process.exit(0);
    } else {
      process.stderr.write(`stop: unknown argument: ${argv[index]}\n`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(150);
  }
  return !alive(pid);
}

function post(port, pathname, timeoutMs = 5000) {
  return new Promise((resolvePost) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolvePost({ statusCode: response.statusCode, body }));
    });
    request.on('timeout', () => { request.destroy(new Error('timeout')); });
    request.on('error', (error) => resolvePost({ error: error.message }));
    request.end();
  });
}

function taskkill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The attempt tree is ours and disposable; never delete anything else. */
function removeAttemptTree(path) {
  if (typeof path !== 'string' || path.length === 0) return 'no path recorded';
  const tempRoot = resolve(tmpdir()).toLowerCase();
  const target = resolve(path).toLowerCase();
  const insideTemp = target.startsWith(tempRoot.endsWith(sep) ? tempRoot : `${tempRoot}${sep}`);
  if (!insideTemp || !target.includes('aidriven-netdefense')) {
    return `refused to delete unexpected path: ${path}`;
  }
  if (!existsSync(path)) return 'already absent';
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return 'removed';
  } catch (error) {
    return `removal failed: ${error.message}`;
  }
}

async function main() {
  if (!existsSync(STATE_FILE)) {
    process.stdout.write('stop: 未发现运行中的实例（run/state.json 不存在）。\n');
    process.exit(0);
  }
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch (error) {
    process.stderr.write(`stop: run/state.json 无法解析: ${error.message}\n`);
    process.exit(3);
  }

  const launcherPid = state.launcherPid;
  const workerPid = state.workerPid;
  process.stdout.write(`stop: launcher pid ${launcherPid} / worker pid ${workerPid} / port ${state.port}\n`);

  let graceful = 'not-attempted';
  if (!options.force && alive(launcherPid)) {
    const answer = await post(state.port, '/shutdown');
    graceful = answer.error === undefined ? `POST /shutdown → ${answer.statusCode}` : `POST /shutdown failed: ${answer.error}`;
    process.stdout.write(`stop: ${graceful}\n`);
  }

  let launcherGone = await waitGone(launcherPid, options.timeoutMs);
  if (!launcherGone) {
    process.stdout.write('stop: 优雅退出超时，改为强制终止 launcher 进程树\n');
    taskkill(launcherPid);
    launcherGone = await waitGone(launcherPid, 10000);
  }
  let workerGone = await waitGone(workerPid, 10000);
  if (!workerGone) {
    process.stdout.write('stop: worker 仍在运行，强制终止\n');
    taskkill(workerPid);
    workerGone = await waitGone(workerPid, 10000);
  }

  const attemptResult = state.keepAttempt === true
    ? 'kept (launcher was started with --keep-attempt)'
    : removeAttemptTree(state.attemptRoot);
  try {
    rmSync(STATE_FILE, { force: true });
    rmSync(join(RUN_DIR, 'port.txt'), { force: true });
  } catch {
    /* ignore */
  }

  const summary = {
    graceful,
    launcherPid,
    launcherGone,
    workerPid,
    workerGone,
    attemptTree: attemptResult,
    residual: launcherGone && workerGone ? 'none' : 'present',
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.stdout.write(launcherGone && workerGone
    ? 'stop: 已停止，无残留进程。\n'
    : 'stop: 未能完全停止，仍有进程存活。\n');
  process.exit(launcherGone && workerGone ? 0 : 1);
}

main();
