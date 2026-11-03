/**
 * supervisor.mjs — the process-tree contract, implemented once in JavaScript.
 *
 * Why this exists in JS at all: ADR-0009 D3 puts the real host in a signed `aegis-svc.exe`
 * (C++/Win32) because only a native process can call `StartServiceCtrlDispatcher`. That
 * binary cannot be built or tested on this machine, so the *contract* it must satisfy is
 * implemented here and exercised by `tests/installer/service-host.test.js`:
 *
 * - readiness = one `{"event":"ready"}` line on stdout, within a deadline;
 * - stop = one `{"cmd":"stop"}` line on stdin, then wait for a clean exit;
 * - overdue stop = whole tree killed, not just the direct child (a leaked `node` child
 *   holding a SQLite write lock is exactly the orphan the Job Object prevents).
 *
 * The native shim must behave identically; when it differs, this file is the reference
 * the difference is measured against. That is a much better arrangement than writing
 * 300 lines of unbuildable C++ and calling it done.
 */

import { spawn } from 'node:child_process';

import { encodeControl, parseControlLine, readLines, stopCommand } from './control-channel.mjs';

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 60_000;

/**
 * Start a child and supervise it.
 *
 * @param {{
 *   command: string,
 *   args?: readonly string[],
 *   cwd?: string,
 *   env?: Record<string, string|undefined>,
 *   readyTimeoutMs?: number,
 *   stopTimeoutMs?: number,
 *   logger?: {info: Function, warn: Function, error: Function},
 *   spawnImpl?: typeof spawn
 * }} options
 * @returns {{
 *   pid: number|undefined,
 *   ready: Promise<{port: number|null, pid: number|undefined}>,
 *   stop: (reason?: string) => Promise<{code: number|null, signal: string|null, killed: boolean}>,
 *   done: Promise<{code: number|null, signal: string|null, killed: boolean, exitedEarly: boolean}>,
 *   output: () => {stdout: string, stderr: string}
 * }}
 */
export function startSupervised({
  command,
  args = [],
  cwd = undefined,
  env = process.env,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  logger = null,
  spawnImpl = spawn,
}) {
  const child = spawnImpl(command, [...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // On Windows a detached child gets its own console; the Job Object in the native
    // host is what actually guarantees the tree dies with us. `detached` alone does not,
    // so the kill below targets the whole tree explicitly.
    detached: false,
  });

  let stdout = '';
  let stderr = '';
  let settled = false;
  let killed = false;

  const exitPromise = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      settled = true;
      resolveExit({ code, signal, killed, exitedEarly: false });
    });
    child.on('error', (error) => {
      settled = true;
      resolveExit({ code: null, signal: null, killed, exitedEarly: true, error: error.message });
    });
  });

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A caller that only wants `done` must not turn a startup failure into an unhandled
  // rejection; the failure is still delivered to anyone who awaits `ready`.
  ready.catch(() => {});

  readLines(child.stdout, (line) => {
    stdout += `${line}\n`;
    const message = parseControlLine(line);
    if (message !== null && message.kind === 'event' && message.event === 'ready') {
      resolveReady({ port: Number(message.payload.port ?? 0) || null, pid: child.pid });
    } else {
      logger?.info?.('child stdout', { line });
    }
  });

  readLines(child.stderr, (line) => {
    stderr += `${line}\n`;
    const message = parseControlLine(line);
    if (message !== null && message.kind === 'event') {
      logger?.info?.('child event', { event: message.event });
      return;
    }
    logger?.info?.('child stderr', { line });
  });

  const readyTimer = setTimeout(() => {
    if (!settled) {
      rejectReady(new Error(`子进程在 ${readyTimeoutMs} ms 内未报告 ready`));
    }
  }, readyTimeoutMs);
  readyTimer.unref?.();

  // A child that dies before declaring readiness must reject the readiness promise, or
  // every caller waits out the full deadline for a process that is already gone.
  exitPromise.then((result) => {
    clearTimeout(readyTimer);
    rejectReady(new Error(`子进程在 ready 之前退出（code=${result.code}, signal=${result.signal}）`));
  });

  async function killTree() {
    killed = true;
    if (child.pid === undefined) return;
    if (process.platform === 'win32') {
      // /T kills the tree, /F is required for a console app with no window to close.
      await new Promise((resolveKill) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        killer.on('exit', () => resolveKill());
        killer.on('error', () => resolveKill());
      });
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }

  async function stop(reason = 'service-stop') {
    if (settled) return exitPromise;
    try {
      child.stdin.write(encodeControl(stopCommand(reason)));
    } catch (error) {
      logger?.warn?.('无法向子进程发送 stop', error.message);
    }
    const timeout = new Promise((resolveTimeout) => {
      const timer = setTimeout(() => resolveTimeout({ timedOut: true }), stopTimeoutMs);
      timer.unref?.();
    });
    const winner = await Promise.race([exitPromise.then((result) => ({ result })), timeout]);
    if (!('result' in winner)) {
      logger?.warn?.(`子进程在 ${stopTimeoutMs} ms 内未停止，强杀进程树`);
      await killTree();
      return exitPromise;
    }
    return winner.result;
  }

  return {
    pid: child.pid,
    ready,
    stop,
    done: exitPromise,
    output: () => ({ stdout, stderr }),
  };
}
