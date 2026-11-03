#!/usr/bin/env node
// AIDriven NetDefense — portable pre-release launcher (author PT-dove).
//
// One job: start the shipped worker from *this* directory, expose a loopback
// health endpoint, and stop the whole tree cleanly when asked.
//
// Rules this file obeys on purpose:
//   * every path is derived from this file's own location — the package can be
//     extracted anywhere (spaces, Chinese characters, another drive);
//   * the bundled node.exe is used; PATH is never searched for a runtime;
//   * no registry, no service, no ProgramData, no installer semantics;
//   * the payload is read-only: the attempt tree lives in the caller's temp
//     directory and is deleted on stop;
//   * outbound network is not attempted; the only listener is 127.0.0.1.
//
// Exit codes: 0 ok, 2 bad usage, 3 already running, 90 runtime missing,
//             91 worker entry missing, 92 cannot resolve package root,
//             93 integrity mismatch, 94 attempt preparation failed,
//             95 worker failed to become ready.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProfileApproved, materializeAttempt } from './lib/attempt.mjs';
import { AUTHOR, PACKAGE_KIND, PRODUCT_VERSION, RELEASE_LABEL, VERSION_FROZEN } from './lib/version.mjs';

const EXIT = {
  ok: 0,
  usage: 2,
  alreadyRunning: 3,
  runtimeMissing: 90,
  workerMissing: 91,
  rootUnresolved: 92,
  integrity: 93,
  attemptFailed: 94,
  notReady: 95,
};

/** The one and only way this package finds its own root. */
function packageRootFromSelf() {
  const here = dirname(fileURLToPath(import.meta.url));
  return realpathSync.native(join(here, '..'));
}

const STARTED_AT = new Date();
const PACKAGE_ROOT = packageRootFromSelf();
const RUN_DIR = join(PACKAGE_ROOT, 'run');
const STATE_FILE = join(RUN_DIR, 'state.json');
const PORT_FILE = join(RUN_DIR, 'port.txt');
const LAUNCHER_LOG = join(RUN_DIR, 'launcher.log');
const WORKER_OUT_LOG = join(RUN_DIR, 'worker.stdout.log');
const WORKER_ERR_LOG = join(RUN_DIR, 'worker.stderr.log');

function timestamp() {
  return new Date().toISOString();
}

function log(message) {
  const line = `[${timestamp()}] ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    appendFileSync(LAUNCHER_LOG, `${line}\n`);
  } catch {
    /* logging must never be the reason start fails */
  }
}

function fail(code, message) {
  const line = `[${timestamp()}] ERROR ${message}`;
  process.stderr.write(`${line}\n`);
  try {
    appendFileSync(LAUNCHER_LOG, `${line}\n`);
  } catch {
    /* ignore */
  }
  process.exit(code);
}

function parseArgs(argv) {
  const options = { port: 0, attemptRoot: undefined, keepAttempt: false, verify: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--attempt-root') options.attemptRoot = argv[++index];
    else if (arg === '--keep-attempt') options.keepAttempt = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'AIDriven NetDefense portable launcher (pre-release)',
        '',
        'usage: start.cmd [--port <n>] [--attempt-root <dir>] [--keep-attempt] [--verify] [--quiet]',
        '',
        '  --port <n>          loopback health port (default: pick a free one)',
        '  --attempt-root <d>  where the disposable worker tree is created',
        '                      (default: %TEMP%\\AIDriven-NetDefense\\attempt-<pid>-<ts>)',
        '  --keep-attempt      keep the attempt tree after stop (debugging only)',
        '  --verify            also verify every row of manifests/files.sha256 (~40 s)',
        '  --quiet             suppress the per-file log chatter',
        '',
      ].join('\n'));
      process.exit(EXIT.ok);
    } else {
      fail(EXIT.usage, `unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    fail(EXIT.usage, '--port must be 0-65535');
  }
  return options;
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(path, text) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

function insidePackage(path) {
  const root = PACKAGE_ROOT.toLowerCase();
  const target = resolve(path).toLowerCase();
  return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * The `launch-plan.json` is the payload's own manifest of what to run. Resolving
 * through it (instead of hard-coding entry paths) keeps this launcher honest when
 * the payload changes, and keeps the "no stored absolute paths" contract.
 */
function readPlan(root) {
  const planPath = join(root, 'launch', 'launch-plan.json');
  if (!existsSync(planPath)) fail(EXIT.rootUnresolved, `launch plan missing: ${planPath}`);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan.schemaVersion !== '1.1') {
    fail(EXIT.rootUnresolved, `unsupported launch-plan schemaVersion: ${plan.schemaVersion} (expected 1.1)`);
  }
  if (plan.bundleRoot !== '.') {
    fail(EXIT.rootUnresolved, `launch plan must declare bundleRoot "." — found ${JSON.stringify(plan.bundleRoot)}`);
  }
  for (const [label, stored] of [
    ['node.executable', plan.node.executable],
    ['worker.entry', plan.worker.entry],
    ['profile.preparer', plan.profile.preparer],
  ]) {
    if (isAbsolute(stored) || stored.includes('..')) {
      fail(EXIT.rootUnresolved, `${label} must stay bundle-relative, found ${stored}`);
    }
  }
  return plan;
}

/** 3-line style verification of the key files the archive ships an index for. */
function verifyKeyFiles(root) {
  const sumsPath = join(root, 'SHA256SUMS');
  if (!existsSync(sumsPath)) return { verified: false, reason: 'SHA256SUMS absent', checked: 0, mismatched: [] };
  const rows = readFileSync(sumsPath, 'utf8').split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
  const mismatched = [];
  for (const row of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(row);
    if (match === null) {
      mismatched.push(`malformed row: ${row.slice(0, 80)}`);
      continue;
    }
    const target = join(root, match[2]);
    if (!existsSync(target)) {
      mismatched.push(`${match[2]}: missing`);
      continue;
    }
    if (sha256OfFile(target) !== match[1]) mismatched.push(`${match[2]}: hash mismatch`);
  }
  return { verified: mismatched.length === 0, checked: rows.length, mismatched };
}

function verifyFullManifest(root) {
  const manifestPath = join(root, 'manifests', 'files.sha256');
  if (!existsSync(manifestPath)) return { verified: false, reason: 'manifests/files.sha256 absent', checked: 0, mismatched: [] };
  const rows = readFileSync(manifestPath, 'utf8').split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
  const mismatched = [];
  let checked = 0;
  for (const row of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(row);
    if (match === null) {
      mismatched.push(`malformed row: ${row.slice(0, 80)}`);
      continue;
    }
    const target = join(root, match[2]);
    if (!existsSync(target)) {
      mismatched.push(`${match[2]}: missing`);
      continue;
    }
    checked += 1;
    if (sha256OfFile(target) !== match[1]) mismatched.push(`${match[2]}: hash mismatch`);
  }
  return { verified: mismatched.length === 0, checked, mismatched };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(join(PACKAGE_ROOT, 'bundle.json'))) {
    fail(EXIT.rootUnresolved, `not a package root (bundle.json missing): ${PACKAGE_ROOT}`);
  }
  mkdirSync(RUN_DIR, { recursive: true });

  const plan = readPlan(PACKAGE_ROOT);
  const nodeExe = join(PACKAGE_ROOT, ...plan.node.executable.split('/'));
  const workerEntry = join(PACKAGE_ROOT, ...plan.worker.entry.split('/'));
  if (!existsSync(join(PACKAGE_ROOT, ...plan.node.executable.split('/')))) {
    fail(EXIT.runtimeMissing, `bundled runtime missing: ${nodeExe}`);
  }
  if (!existsSync(workerEntry)) fail(EXIT.workerMissing, `worker entry missing: ${workerEntry}`);

  const previous = readState();
  if (previous !== null && isProcessAlive(previous.launcherPid)) {
    fail(EXIT.alreadyRunning, `already running (launcher pid ${previous.launcherPid}, port ${previous.port}); run stop.cmd first`);
  }

  // ---- integrity -----------------------------------------------------------
  const integrity = { checkedAt: timestamp(), keyFiles: null, fullManifest: null };
  integrity.keyFiles = verifyKeyFiles(PACKAGE_ROOT);
  if (!integrity.keyFiles.verified) {
    fail(EXIT.integrity, `key-file hash mismatch: ${integrity.keyFiles.mismatched.slice(0, 3).join('; ')}`);
  }
  log(`integrity: ${integrity.keyFiles.checked} key files verified`);
  if (options.verify) {
    const started = Date.now();
    integrity.fullManifest = verifyFullManifest(PACKAGE_ROOT);
    if (!integrity.fullManifest.verified) {
      fail(EXIT.integrity, `payload manifest mismatch: ${integrity.fullManifest.mismatched.slice(0, 3).join('; ')}`);
    }
    log(`integrity: ${integrity.fullManifest.checked} manifest rows verified in ${Date.now() - started} ms`);
  }

  // ---- attempt tree --------------------------------------------------------
  let attemptRoot = options.attemptRoot;
  if (attemptRoot === undefined) {
    const base = join(tmpdir(), 'AIDriven-NetDefense');
    attemptRoot = join(base, `attempt-${process.pid}-${Date.now().toString(36)}`);
  } else if (!isAbsolute(attemptRoot)) {
    fail(EXIT.usage, '--attempt-root must be absolute');
  }
  if (insidePackage(attemptRoot)) {
    // The worker's loader writes `.cordis/*` into the profile copy. Keeping that
    // inside the package would mutate shipped bytes and invalidate manifests.
    fail(EXIT.usage, `--attempt-root must be outside the package (${PACKAGE_ROOT})`);
  }

  let profile;
  try {
    profile = assertProfileApproved(PACKAGE_ROOT);
  } catch (error) {
    fail(EXIT.integrity, error.message);
  }
  log(`profile approval: profile.json ${profile.sha256.slice(0, 12)}… matches approved-hashes.json`);

  let attempt;
  try {
    attempt = materializeAttempt({
      bundleRoot: PACKAGE_ROOT,
      attemptRoot,
      brokerBaseURL: 'http://127.0.0.1:9/anthropic',
      brokerToken: `portable-single-attempt-${process.pid}`,
    });
  } catch (error) {
    fail(EXIT.attemptFailed, `attempt preparation failed: ${error.message}`);
  }
  log(`attempt: ${attempt.root}`);

  // ---- worker --------------------------------------------------------------
  let workerOut = '';
  let workerErr = '';
  let workerState = 'starting';
  let initialized = null;
  let runtimeSnapshot = null;
  let frames = 0;

  const child = spawn(nodeExe, [workerEntry, ...plan.worker.argv], {
    cwd: attempt.cwd,
    env: attempt.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    workerOut += chunk;
    appendFileSync(WORKER_OUT_LOG, chunk);
    let index;
    while ((index = workerOut.indexOf('\n')) >= 0) {
      const line = workerOut.slice(0, index).replace(/\r$/, '');
      workerOut = workerOut.slice(index + 1);
      if (line.length === 0) continue;
      frames += 1;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log(`worker stdout (non-JSON): ${line.slice(0, 200)}`);
        continue;
      }
      if (frame.id === 1) {
        if (frame.error) {
          workerState = 'initialize-failed';
          log(`worker initialize failed: ${JSON.stringify(frame.error).slice(0, 300)}`);
        } else {
          initialized = frame.result;
          workerState = 'ready';
          log(`worker ready: ${frame.result?.serverInfo?.name} / protocol ${frame.result?.protocolVersion ?? '?'}`);
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    workerErr += chunk;
    appendFileSync(WORKER_ERR_LOG, chunk);
  });

  let workerExit = null;
  const workerExitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      workerExit = { code, signal };
      if (workerState !== 'stopped') workerState = 'exited';
      resolveExit(workerExit);
    });
    child.once('error', (error) => {
      workerExit = { code: null, signal: null, error: error.message };
      workerState = 'spawn-failed';
      resolveExit(workerExit);
    });
  });

  /**
   * Open the JSON-RPC session.
   *
   * `provider` / `model` here are the harness's own identifiers for the session it
   * is about to describe — not a routing decision. This package ships no broker and
   * the broker URL points at 127.0.0.1:9, so no model request can leave the process;
   * the values are the ones the reviewed M8 boot suite uses, kept identical on
   * purpose so this launcher exercises the same handshake as the audited tests.
   */
  const initializeFrame = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      cwd: attempt.cwd,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxTokens: 2000,
      approvalRequests: false,
      capabilities: { userQuestions: false },
    },
  };
  try {
    child.stdin.write(`${JSON.stringify(initializeFrame)}\n`);
  } catch (error) {
    log(`could not send initialize: ${error.message}`);
  }

  // ---- health endpoint -----------------------------------------------------
  const health = () => {
    const alive = child.exitCode === null && child.signalCode === null;
    const ok = alive && workerState === 'ready';
    return {
      status: ok ? 'ok' : 'degraded',
      httpStatus: ok ? 200 : 503,
      release: {
        label: RELEASE_LABEL,
        productVersion: PRODUCT_VERSION,
        kind: PACKAGE_KIND,
        frozen: VERSION_FROZEN,
        note: '预发布打包标签，仅用于产物命名；不代表版本已冻结',
      },
      author: AUTHOR,
      startedAt: STARTED_AT.toISOString(),
      uptimeMs: Date.now() - STARTED_AT.getTime(),
      launcherPid: process.pid,
      port: server.address()?.port ?? null,
      attempts: { root: attempt.root, kept: options.keepAttempt },
      integrity,
      worker: {
        state: workerState,
        pid: child.pid ?? null,
        argv: plan.worker.argv,
        serverInfo: initialized?.serverInfo ?? null,
        protocolVersion: initialized?.protocolVersion ?? null,
        tools: Array.isArray(runtimeSnapshot?.model?.tools) ? runtimeSnapshot.model.tools.map((tool) => tool.name) : null,
        plugins: Array.isArray(runtimeSnapshot?.plugins?.entries)
          ? {
            entries: runtimeSnapshot.plugins.entries.length,
            active: runtimeSnapshot.plugins.entries.filter((entry) => entry.state === 'active').length,
          }
          : null,
        captureError: runtimeSnapshot?.captureError ?? null,
        frames,
        exit: workerExit,
      },
    };
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (statusCode, body) => {
      const text = `${JSON.stringify(body, null, 2)}\n`;
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
      response.end(text);
    };
    if (request.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
      const body = health();
      send(body.httpStatus, body);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      send(200, health());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/shutdown') {
      send(202, { status: 'stopping', launcherPid: process.pid });
      setImmediate(() => {
        shutdown('http').finally(() => process.exit(EXIT.ok));
      });
      return;
    }
    send(404, { status: 'not-found', endpoints: ['GET /healthz', 'GET /status', 'POST /shutdown'] });
  });

  let shuttingDown = false;
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    workerState = child.exitCode === null ? 'stopping' : 'stopped';
    log(`stopping (${reason})`);
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'shutdown', params: {} })}\n`);
        const graceful = await Promise.race([
          workerExitPromise.then(() => 'exited'),
          new Promise((resolveWait) => setTimeout(() => resolveWait('timeout'), 10000)),
        ]);
        if (graceful === 'timeout') {
          log('worker did not exit within 10 s; terminating');
          child.kill('SIGKILL');
          await Promise.race([workerExitPromise, new Promise((resolveWait) => setTimeout(resolveWait, 5000))]);
        }
      }
    } catch {
      /* shutdown must not throw */
    }
    workerState = 'stopped';

    if (!options.keepAttempt) {
      try {
        rmSync(attempt.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        log('attempt tree removed');
      } catch (error) {
        log(`attempt tree removal failed: ${error.message}`);
      }
    }

    await new Promise((resolveClose) => {
      if (server.listening) server.close(() => resolveClose());
      else resolveClose();
    });
    try {
      rmSync(STATE_FILE, { force: true });
      rmSync(PORT_FILE, { force: true });
    } catch {
      /* ignore */
    }
    log(`stopped cleanly (worker exit ${JSON.stringify(workerExit)})`);
  }

  server.on('error', (error) => {
    fail(EXIT.notReady, `health endpoint failed to bind: ${error.message}`);
  });
  server.listen(options.port, '127.0.0.1', () => {
    const port = server.address().port;
    writeAtomic(PORT_FILE, `${port}\n`);
    writeAtomic(STATE_FILE, `${JSON.stringify({
      releaseLabel: RELEASE_LABEL,
      productVersion: PRODUCT_VERSION,
      launcherPid: process.pid,
      workerPid: child.pid ?? null,
      port,
      startedAt: STARTED_AT.toISOString(),
      attemptRoot: attempt.root,
      keepAttempt: options.keepAttempt,
      packageRoot: PACKAGE_ROOT,
    }, null, 2)}\n`);
    log(`health endpoint listening on http://127.0.0.1:${port}/healthz`);
    // Poll for the live runtime manifest: the worker writes it during initialize,
    // a few hundred ms after the response.
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (existsSync(attempt.runtimeManifest)) {
        try {
          runtimeSnapshot = JSON.parse(readFileSync(attempt.runtimeManifest, 'utf8'));
        } catch {
          /* still being written */
        }
        if (runtimeSnapshot !== null) clearInterval(timer);
      }
      if (workerState === 'ready' && (runtimeSnapshot !== null || Date.now() > deadline)) clearInterval(timer);
      if (Date.now() > deadline) clearInterval(timer);
    }, 100);
    timer.unref?.();
    process.stdout.write(`READY http://127.0.0.1:${port}/healthz\n`);
    process.stdout.write(`PID ${process.pid} (launcher) / ${child.pid ?? '?'} (worker)\n`);
    process.stdout.write(`日志: ${RUN_DIR}\n`);
    process.stdout.write('按 Ctrl+C 或运行 stop.cmd 停止。\n');
  });

  // A worker that dies before initialize must not look like a healthy service.
  workerExitPromise.then((exit) => {
    if (shuttingDown) return;
    log(`worker exited unexpectedly: ${JSON.stringify(exit)}; health endpoint will report degraded`);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
      shutdown(signal).finally(() => process.exit(EXIT.ok));
    });
  }
  process.on('exit', () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
}

main();
