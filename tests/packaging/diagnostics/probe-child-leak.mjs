/**
 * Diagnostic, NOT a gate test: proves one un-reaped child process is enough to keep
 * `node --test` from ever exiting, while every assertion still passes.
 *
 * This is the reproduction for the BUNDLE-V14 symptom "packaging suite printed 47
 * passes and then the runner never exited". Run it explicitly; it is named
 * `*.mjs` on purpose so `node --test tests/packaging/` never picks it up:
 *
 *   timeout 45 node --test tests/packaging/diagnostics/probe-child-leak.mjs
 *   → prints the summary and then hangs; timeout kills it with 124.
 *
 * Author PT-dove.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const BUNDLE = join(process.cwd(), 'dist', 'bundle', 'win32-x64-v14');
const NODE = join(BUNDLE, 'runtime', 'node', 'node.exe');
const SERVE = join(BUNDLE, 'console', 'serve.mjs');

test('unguarded: spawn a long-lived shipped server and never reap it', () => {
  const child = spawn(NODE, [SERVE, '--daemon', 'http://127.0.0.1:9', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  console.log(`PROBE_CHILD_PID=${child.pid}`);
});
