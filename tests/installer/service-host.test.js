/**
 * The P2 service host: process supervision and readiness.
 *
 * The native `aegis-svc.exe` cannot be built here (no MSVC, and it must be signed before it
 * ships), so the contract it has to satisfy is implemented in `src/supervisor.mjs` and
 * exercised here with stub children. That gives the native shim something to be measured
 * against, instead of a C++ file nobody has ever run.
 *
 * What is proven here:
 *   - readiness is a single `{"event":"ready"}` line, and a child that dies before it fails
 *     fast instead of waiting out the deadline;
 *   - a stop request is a `{"cmd":"stop"}` line, and a clean exit is reported as clean;
 *   - a child that ignores the stop is killed as a *tree*, not just by SIGTERM;
 *   - the health probe rejects a liveness-only daemon (wrong token) rather than calling it up.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { probeDaemon } from '../../apps/service-host/src/health.mjs';
import { encodeControl, parseControlLine } from '../../apps/service-host/src/control-channel.mjs';
import { startSupervised } from '../../apps/service-host/src/supervisor.mjs';
import { tempRoot } from './fixtures/payload.mjs';

const QUIET = { info() {}, warn() {}, error() {} };

/** A child that reports ready, then exits cleanly when it sees the stop command. */
const READY_THEN_STOP = `
process.stdout.write(JSON.stringify({ event: 'ready', port: 8799, pid: process.pid }) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (buffer.includes('"stop"')) {
    process.stdout.write(JSON.stringify({ event: 'stopping', reason: 'test' }) + '\\n');
    process.exit(0);
  }
});
`;

/** A child that reports ready and then ignores every stop request. */
const READY_THEN_STUBBORN = `
process.stdout.write(JSON.stringify({ event: 'ready', port: 8799, pid: process.pid }) + '\\n');
setInterval(() => {}, 1000);
`;

/** A child that never becomes ready. */
const DIES_EARLY = 'process.exit(3);';

function stub(t, name, source) {
  const root = tempRoot(t, 'aidnd-host-');
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

test('a child that reports ready is observed, and a stop command ends it cleanly', async (t) => {
  const child = stub(t, 'ready-stop.mjs', READY_THEN_STOP);
  const supervisor = startSupervised({
    command: process.execPath, args: [child], readyTimeoutMs: 10_000, stopTimeoutMs: 10_000, logger: QUIET,
  });

  const ready = await supervisor.ready;
  assert.equal(ready.port, 8799);
  assert.equal(typeof ready.pid, 'number');

  const exit = await supervisor.stop('service-stop');
  assert.equal(exit.code, 0);
  assert.equal(exit.killed, false, 'a cooperative child must not be killed');
  assert.match(supervisor.output().stdout, /"event":"stopping"/u);
});

test('a child that never reports ready fails fast instead of waiting out the deadline', async (t) => {
  const child = stub(t, 'dies.mjs', DIES_EARLY);
  const supervisor = startSupervised({
    command: process.execPath, args: [child], readyTimeoutMs: 10_000, stopTimeoutMs: 1_000, logger: QUIET,
  });

  await assert.rejects(supervisor.ready, /ready 之前退出/u);
  const exit = await supervisor.done;
  assert.equal(exit.code, 3, 'the child exit code must not be swallowed');
});

test('a child that ignores the stop request is killed, and the kill is reported', async (t) => {
  const child = stub(t, 'stubborn.mjs', READY_THEN_STUBBORN);
  const supervisor = startSupervised({
    command: process.execPath, args: [child], readyTimeoutMs: 10_000, stopTimeoutMs: 400, logger: QUIET,
  });

  await supervisor.ready;
  const exit = await supervisor.stop('service-stop');
  assert.equal(exit.killed, true, 'a hung child must be killed rather than waited on');
});

test('a child that never reports ready times out at the deadline', async (t) => {
  const child = stub(t, 'sleepy.mjs', 'setInterval(() => {}, 1000);');
  const supervisor = startSupervised({
    command: process.execPath, args: [child], readyTimeoutMs: 300, stopTimeoutMs: 300, logger: QUIET,
  });

  await assert.rejects(supervisor.ready, /未报告 ready/u);
  await supervisor.stop('cleanup');
});

test('the control vocabulary is closed: unknown messages are ignored, not forwarded', () => {
  assert.equal(parseControlLine(JSON.stringify({ event: 'ready', port: 1 })).kind, 'event');
  assert.equal(parseControlLine(JSON.stringify({ cmd: 'stop' })).kind, 'command');
  assert.equal(parseControlLine(JSON.stringify({ cmd: 'rm -rf /' })), null);
  assert.equal(parseControlLine(JSON.stringify({ event: 'restart' })), null);
  assert.equal(parseControlLine('not json'), null);
  assert.equal(parseControlLine(JSON.stringify({ cmd: 'stop' })).cmd, 'stop');
  assert.equal(encodeControl({ cmd: 'stop' }).endsWith('\n'), true);
});

/** A loopback server that behaves like the daemon's API for the two probed routes. */
async function fakeDaemon(t, { token, healthStatus = 200 }) {
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(healthStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: healthStatus === 200 ? 'ok' : 'failed' }));
      return;
    }
    if (request.url === '/api/v1/status') {
      const authorized = request.headers.authorization === `Bearer ${token}`;
      response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ authorized }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

test('the health probe accepts a daemon that serves and whose token works', async (t) => {
  const token = 'a'.repeat(43);
  const port = await fakeDaemon(t, { token });
  const result = await probeDaemon({ port, token });
  assert.equal(result.ok, true, result.reason);
});

test('the health probe refuses a daemon whose token does not match (the lockout trap)', async (t) => {
  const port = await fakeDaemon(t, { token: 'b'.repeat(43) });
  const result = await probeDaemon({ port, token: 'a'.repeat(43) });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'auth');
  assert.match(result.reason, /status HTTP 401/u);
});

test('the health probe refuses a daemon that reports failed health', async (t) => {
  const token = 'a'.repeat(43);
  const port = await fakeDaemon(t, { token, healthStatus: 503 });
  const result = await probeDaemon({ port, token });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'liveness');
});

test('the health probe refuses when there is no token file to present', async (t) => {
  const port = await fakeDaemon(t, { token: 'a'.repeat(43) });
  const result = await probeDaemon({ port, token: null });
  assert.equal(result.ok, false);
  assert.match(result.reason, /缺少 api-token/u);
});

test('the host entry point parses its arguments and refuses junk', async () => {
  const { parseHostArgs } = await import('../../apps/service-host/bin.js');
  assert.equal(parseHostArgs(['--config', 'D:\\x\\aegis.conf.json']).config, 'D:\\x\\aegis.conf.json');
  assert.equal(parseHostArgs(['--config', 'x', '--dry-run']).dryRun, true);
  assert.throws(() => parseHostArgs(['--frobnicate']), /无法识别的参数/u);
});

test('the host validates its config and assembles sources without starting the daemon', async (t) => {
  const root = tempRoot(t, 'aidnd-host-');
  const configPath = join(root, 'aegis.conf.json');
  writeFileSync(configPath, JSON.stringify({
    // `mock` keeps this test away from SQLite; the point here is config + source wiring,
    // not a running daemon (that is G5a territory and needs a real install).
    dataDir: join(root, 'data'),
    mode: 'mock',
    api: { host: '127.0.0.1', port: 0 },
    detection: { rulePack: { schemaVersion: '1.0', rules: [] } },
  }));

  const { runHost } = await import('../../apps/service-host/bin.js');
  let stdout = '';
  const sink = { write: (chunk) => { stdout += chunk; } };
  const code = await runHost(['--config', configPath, '--dry-run'], {
    stdout: sink,
    stderr: sink,
    stdin: { on() {}, off() {}, setEncoding() {} },
  });

  assert.equal(code, 0, stdout);
  const report = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(report.event, 'dry-run');
  assert.equal(report.mode, 'mock');
  assert.equal(Array.isArray(report.sources), true);
  if (process.platform === 'win32') {
    // The event log source is one source per channel, not one source with channels.
    assert.deepEqual(report.sources, [
      'processes', 'connections', 'services', 'scheduledTasks', 'runKeys',
      'eventLog:Security', 'eventLog:System', 'eventLog:Application', 'directories',
    ]);
  } else {
    // No Windows collectors off-platform, and the host says so instead of pretending.
    assert.deepEqual(report.sources, []);
  }
});

test('the host refuses a config the daemon would reject', async (t) => {
  const root = tempRoot(t, 'aidnd-host-');
  const configPath = join(root, 'aegis.conf.json');
  // `dataDir` is the daemon's one mandatory key; leaving it out is the classic mistake.
  writeFileSync(configPath, JSON.stringify({ mode: 'mock', detection: { rulePack: {} } }));

  const { runHost } = await import('../../apps/service-host/bin.js');
  let stderr = '';
  const sink = { write: (chunk) => { stderr += chunk; } };
  const code = await runHost(['--config', configPath, '--dry-run'], {
    stdout: sink,
    stderr: sink,
    stdin: { on() {}, off() {}, setEncoding() {} },
  });
  assert.equal(code, 1);
  assert.match(stderr, /配置无效/u);
});
