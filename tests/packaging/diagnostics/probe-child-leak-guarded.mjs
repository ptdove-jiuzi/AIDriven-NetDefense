/**
 * Diagnostic, NOT a gate test: the same deliberate leak as `probe-child-leak.mjs`,
 * but routed through the shared reaper. Expected result — the file finishes in a
 * fraction of a second because `after(reapAll)` stops the orphan, instead of the
 * runner waiting on it forever.
 *
 *   node --test tests/packaging/diagnostics/probe-child-leak-guarded.mjs
 *   → exit 0, ~0.2 s, PROBE_CHILD_PID printed
 *
 * Author PT-dove.
 */
import { join } from 'node:path';
import test, { after } from 'node:test';

import { reapAll, trackedSpawn } from '../child-reaper.mjs';

const BUNDLE = join(process.cwd(), 'dist', 'bundle', 'win32-x64-v14');
const NODE = join(BUNDLE, 'runtime', 'node', 'node.exe');
const SERVE = join(BUNDLE, 'console', 'serve.mjs');

after(async () => {
  await reapAll();
});

test('guarded: spawn a long-lived shipped server and never reap it', () => {
  const child = trackedSpawn(NODE, [SERVE, '--daemon', 'http://127.0.0.1:9', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  console.log(`PROBE_CHILD_PID=${child.pid}`);
});
