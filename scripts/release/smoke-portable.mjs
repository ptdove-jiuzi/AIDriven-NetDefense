#!/usr/bin/env node
/**
 * End-to-end smoke test for the portable archive (author PT-dove).
 *
 * The acceptance criterion for this package is behavioural, so it is executed,
 * not argued: extract the archive into a directory whose path contains a space
 * and non-ASCII characters, start it with `start.cmd`, require HTTP 200 from the
 * loopback health endpoint, stop it with `stop.cmd`, and then prove nothing was
 * left running and nothing in the payload changed.
 *
 * Phases
 *   1. extract       archive -> <temp>\AIDriven NetDefense 冒烟 <ts>\
 *   2. digest        hash the payload *before* it ever runs
 *   3. start         cmd /c start.cmd  (different cwd than the package root)
 *   4. health        GET /healthz until 200; /status must agree; 21 plugin entries
 *   5. sums          re-verify every SHA256SUMS row from the extracted tree
 *   6. stop          cmd /c stop.cmd; require exit 0 and residual none
 *   7. residue       launcher/worker pids gone, port closed, attempt tree removed,
 *                    package directory removable (a locked file would fail here)
 *   8. digest again  payload unchanged after the run
 *   9. crash         start again, SIGKILL the launcher, require the worker to die
 *                    with it, then require stop.cmd to clean the stale state
 *
 * usage: node scripts/release/smoke-portable.mjs [--zip <path>] [--extract-to <dir>]
 *        [--report <json>] [--skip-crash] [--keep]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZipArchive } from './lib/zip-read.mjs';
import { DEFAULT_LABEL, REPO_ROOT } from './pack-portable.mjs';

const COMSPEC = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';

function parseArgs(argv) {
  const options = {
    zip: resolve(REPO_ROOT, 'dist', 'portable', DEFAULT_LABEL, `AIDriven-NetDefense-${DEFAULT_LABEL}-win-x64-portable.zip`),
    extractTo: undefined,
    report: undefined,
    skipCrash: false,
    keep: false,
    startTimeoutMs: 240000,
    healthTimeoutMs: 90000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--zip') options.zip = resolve(argv[++index]);
    else if (arg === '--extract-to') options.extractTo = resolve(argv[++index]);
    else if (arg === '--report') options.report = resolve(argv[++index]);
    else if (arg === '--skip-crash') options.skipCrash = true;
    else if (arg === '--keep') options.keep = true;
    else {
      process.stderr.write(`smoke-portable: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const results = {
  schemaVersion: '1.0',
  author: 'PT-dove',
  startedAt: new Date().toISOString(),
  archive: options.zip,
  phases: [],
  checks: [],
};

function record(phase, detail) {
  results.phases.push({ phase, at: new Date().toISOString(), ...detail });
  process.stdout.write(`[smoke] ${phase}: ${JSON.stringify(detail)}\n`);
}

function assert(condition, message) {
  results.checks.push({ check: message, ok: Boolean(condition) });
  if (!condition) {
    process.stderr.write(`[smoke] FAIL ${message}\n`);
    finish(1);
  }
}

function finish(code) {
  results.finishedAt = new Date().toISOString();
  results.ok = code === 0 && results.checks.every((entry) => entry.ok);
  if (options.report !== undefined) {
    mkdirSync(dirname(options.report), { recursive: true });
    writeFileSync(options.report, `${JSON.stringify(results, null, 2)}\n`);
  }
  process.exit(code);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function httpGet(port, pathname, timeoutMs = 5000) {
  return new Promise((resolveGet) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveGet({ statusCode: response.statusCode, body }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (error) => resolveGet({ error: error.message }));
    request.end();
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function tasklistHas(pid) {
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null; // tasklist unavailable — treat as unknown
  return result.stdout.includes(`"${pid}"`);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    // Yield to the I/O loop: an await on an already-settled promise only drains
    // microtasks, so a tight loop would starve the very `data` events being waited
    // for (this cost one debugging round — the launcher looked silent when it was
    // only unheard).
    await sleep(100);
  }
  process.stderr.write(`[smoke] timeout waiting for ${label}\n`);
  return false;
}

function readState(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'run', 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function verifySums(root) {
  const rows = readFileSync(join(root, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
  const mismatched = [];
  for (const row of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(row);
    if (match === null) {
      mismatched.push(`malformed: ${row.slice(0, 60)}`);
      continue;
    }
    const target = join(root, ...match[2].split('/'));
    if (!existsSync(target)) {
      mismatched.push(`${match[2]}: missing`);
      continue;
    }
    if (sha256File(target) !== match[1]) mismatched.push(`${match[2]}: hash mismatch`);
  }
  return { rows: rows.length, mismatched };
}

/** Hashes that must survive a start/stop cycle untouched. */
function digestPayload(root) {
  const targets = ['bundle.json', 'manifests/files.sha256', 'launch/launch-plan.json', 'runtime/node/node.exe', 'start.cmd'];
  const digest = {};
  for (const name of targets) digest[name] = sha256File(join(root, ...name.split('/')));
  const manifest = readFileSync(join(root, 'manifests', 'files.sha256'), 'utf8').split('\n').filter((line) => line.length > 0);
  digest['manifest.rows'] = manifest.length;
  digest['manifest.sha256'] = createHash('sha256').update(manifest.join('\n')).digest('hex');
  return digest;
}

function startPackage(root, extraArgs = []) {
  const child = spawn(COMSPEC, ['/c', join(root, 'start.cmd'), ...extraArgs], {
    // Deliberately NOT the package root: `%~dp0` must do the work.
    cwd: tmpdir(),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, stdout: '', stderr: '', readyUrl: null, exit: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
    const match = /READY (http:\/\/127\.0\.0\.1:(\d+)\/healthz)/.exec(state.stdout);
    if (match !== null && state.readyUrl === null) state.readyUrl = { url: match[1], port: Number(match[2]) };
  });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  state.exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      state.exit = { code, signal };
      resolveExit(state.exit);
    });
  });
  return state;
}

async function waitReady(state, timeoutMs) {
  const ok = await waitUntil(() => state.readyUrl !== null || state.exit !== null || state.child.exitCode !== null, timeoutMs, 'READY line');
  if (!ok || state.readyUrl === null) {
    process.stderr.write(`[smoke] start.cmd stdout:\n${state.stdout}\n[smoke] stderr:\n${state.stderr}\n`);
    return null;
  }
  return state.readyUrl;
}

async function run() {
  const zipPath = options.zip;
  assert(existsSync(zipPath), `archive exists: ${zipPath}`);
  const zipBytes = statSync(zipPath).size;

  // ---- 1. extract --------------------------------------------------------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extractRoot = options.extractTo ?? join(tmpdir(), 'AIDriven NetDefense 冒烟 ' + stamp);
  rmSync(extractRoot, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });
  assert(/\s/.test(extractRoot), `extraction path contains a space: ${extractRoot}`);

  const extractStarted = Date.now();
  const archive = new ZipArchive(zipPath);
  const fileCount = archive.entries.filter((entry) => !entry.isDirectory).length;
  const written = archive.extractAll(extractRoot);
  archive.close();
  record('extract', { root: extractRoot, zipBytes, entries: fileCount, written, ms: Date.now() - extractStarted });
  assert(written === fileCount, `extracted ${written} files, archive lists ${fileCount}`);

  // ---- 2. digest before --------------------------------------------------
  const before = digestPayload(extractRoot);
  record('digest-before', { bundleJson: before['bundle.json'], manifestSha256: before['manifest.sha256'] });

  // ---- 3/4. start + health ----------------------------------------------
  const startStarted = Date.now();
  const first = startPackage(extractRoot);
  const ready = await waitReady(first, options.startTimeoutMs);
  assert(ready !== null, 'start.cmd printed a READY line');
  if (ready === null) return;

  let health = null;
  const healthOk = await waitUntil(async () => {
    const answer = await httpGet(ready.port, '/healthz');
    if (answer.statusCode !== 200 || answer.body === undefined) return false;
    const parsed = JSON.parse(answer.body);
    // 200 means "the worker answered initialize"; the plugin mount is described a
    // moment later when the worker writes its live runtime manifest. Waiting for
    // both keeps the assertion about what the service actually mounted.
    if (parsed.worker?.plugins?.active !== 21) return false;
    health = parsed;
    return true;
  }, options.healthTimeoutMs, 'HTTP 200 from /healthz with 21 active plugins');
  assert(healthOk, 'GET /healthz returned 200 with the worker ready');
  if (!healthOk) return;

  record('health', {
    url: ready.url,
    statusCode: 200,
    status: health.status,
    workerState: health.worker?.state,
    pluginEntries: health.worker?.plugins?.entries,
    pluginsActive: health.worker?.plugins?.active,
    tools: health.worker?.tools,
    captureError: health.worker?.captureError,
    integrityChecked: health.integrity?.keyFiles?.checked,
    ms: Date.now() - startStarted,
  });
  assert(health.status === 'ok', 'health status is ok');
  assert(health.worker?.state === 'ready', `worker state is ready (saw ${health.worker?.state})`);
  assert(health.worker?.plugins?.active === 21, `21 plugin entries active (saw ${health.worker?.plugins?.active})`);
  assert(health.worker?.captureError === null || health.worker?.captureError === undefined,
    `runtime capture has no error (saw ${JSON.stringify(health.worker?.captureError)})`);
  assert(health.release?.label === DEFAULT_LABEL, `release label is ${DEFAULT_LABEL}`);

  const state = readState(extractRoot);
  assert(state !== null, 'run/state.json written');
  const launcherPid = state?.launcherPid;
  const workerPid = state?.workerPid;
  assert(Number.isInteger(launcherPid) && Number.isInteger(workerPid), 'launcher and worker pids recorded');
  assert(pidAlive(launcherPid), 'launcher process is alive while serving');
  assert(pidAlive(workerPid), 'worker process is alive while serving');

  const statusAnswer = await httpGet(ready.port, '/status');
  assert(statusAnswer.statusCode === 200, 'GET /status returned 200');

  // ---- 5. sums from the extracted tree -----------------------------------
  const sums = verifySums(extractRoot);
  record('sha256sums', { rows: sums.rows, mismatched: sums.mismatched.length });
  assert(sums.mismatched.length === 0, `all ${sums.rows} SHA256SUMS rows verify after extraction`);

  // ---- 6. stop ------------------------------------------------------------
  const stopResult = spawnSync(COMSPEC, ['/c', join(extractRoot, 'stop.cmd')], { encoding: 'utf8', cwd: tmpdir(), windowsHide: true });
  record('stop', { status: stopResult.status, stdout: stopResult.stdout.trim().slice(0, 800), stderr: stopResult.stderr.trim().slice(0, 400) });
  assert(stopResult.status === 0, `stop.cmd exited 0 (saw ${stopResult.status})`);
  assert(/residual["']?\s*:\s*["']none["']/.test(stopResult.stdout), 'stop.cmd reported residual none');

  const startExit = await Promise.race([first.exitPromise, sleep(30000).then(() => 'timeout')]);
  assert(typeof startExit === 'object' && startExit !== null && startExit.code === 0,
    `start.cmd exited 0 after stop (saw ${JSON.stringify(startExit)})`);

  // ---- 7. residue ---------------------------------------------------------
  const launcherGone = await waitUntil(() => !pidAlive(launcherPid), 20000, 'launcher exit');
  const workerGone = await waitUntil(() => !pidAlive(workerPid), 20000, 'worker exit');
  assert(launcherGone, 'launcher process is gone after stop');
  assert(workerGone, 'worker process is gone after stop');
  const tasklistLauncher = tasklistHas(launcherPid);
  const tasklistWorker = tasklistHas(workerPid);
  assert(tasklistLauncher !== true, 'tasklist shows no launcher process');
  assert(tasklistWorker !== true, 'tasklist shows no worker process');

  const portClosed = await waitUntil(async () => {
    const answer = await httpGet(ready.port, '/healthz', 1500);
    return answer.error !== undefined;
  }, 15000, 'health port to close');
  assert(portClosed, 'health port no longer accepts connections');

  const attemptRoot = state?.attemptRoot;
  assert(typeof attemptRoot === 'string' && !existsSync(attemptRoot), `attempt tree removed (${attemptRoot})`);
  assert(!existsSync(join(extractRoot, 'run', 'state.json')), 'run/state.json removed');

  record('residue', { launcherPid, workerPid, launcherGone, workerGone, portClosed, attemptRoot, tasklistLauncher, tasklistWorker });

  // ---- 8. digest after ----------------------------------------------------
  const after = digestPayload(extractRoot);
  record('digest-after', { bundleJson: after['bundle.json'], manifestSha256: after['manifest.sha256'] });
  for (const key of Object.keys(before)) {
    assert(before[key] === after[key], `payload file unchanged after a run: ${key}`);
  }
  assert(readdirSync(extractRoot).filter((name) => name === 'run').length === 1, 'run/ exists (runtime state only)');
  const runFiles = readdirSync(join(extractRoot, 'run'));
  record('run-dir', { files: runFiles });

  // ---- 9. crash of the launcher ------------------------------------------
  if (!options.skipCrash) {
    const second = startPackage(extractRoot);
    const ready2 = await waitReady(second, options.startTimeoutMs);
    assert(ready2 !== null, 'second start printed a READY line');
    if (ready2 !== null) {
      const health2 = await waitUntil(async () => {
        const answer = await httpGet(ready2.port, '/healthz');
        return answer.statusCode === 200;
      }, options.healthTimeoutMs, 'second start health 200');
      assert(health2, 'second start reaches HTTP 200');

      const state2 = readState(extractRoot);
      const crashLauncher = state2?.launcherPid;
      const crashWorker = state2?.workerPid;
      assert(pidAlive(crashLauncher) && pidAlive(crashWorker), 'second start has both pids alive');

      // Hard kill: no graceful path, no chance to clean up. The worker holds a
      // pipe from the launcher, so it must notice the broken pipe and exit.
      process.kill(crashLauncher, 'SIGKILL');
      const workerDiedWithLauncher = await waitUntil(() => !pidAlive(crashWorker), 20000, 'worker to die with the launcher');
      record('crash', { launcherPid: crashLauncher, workerPid: crashWorker, workerDiedWithLauncher });
      assert(workerDiedWithLauncher, 'worker exits when the launcher is killed');

      const stale = readState(extractRoot);
      assert(stale !== null, 'stale run/state.json left behind after a hard kill');
      const stopStale = spawnSync(COMSPEC, ['/c', join(extractRoot, 'stop.cmd')], { encoding: 'utf8', cwd: tmpdir(), windowsHide: true });
      record('stop-stale', { status: stopStale.status, stdout: stopStale.stdout.trim().slice(0, 600) });
      assert(stopStale.status === 0, `stop.cmd cleans a stale state (exit ${stopStale.status})`);
      assert(!existsSync(join(extractRoot, 'run', 'state.json')), 'stale state removed by stop.cmd');
      if (typeof stale.attemptRoot === 'string') {
        assert(!existsSync(stale.attemptRoot), 'attempt tree removed after the crash recovery');
      }
    }
  }

  // ---- cleanup ------------------------------------------------------------
  if (!options.keep) {
    rmSync(extractRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    assert(!existsSync(extractRoot), 'package directory is removable (no file locks left)');
    record('cleanup', { removed: extractRoot });
  }

  results.archiveBytes = zipBytes;
  results.archiveSha256 = sha256File(zipPath);
  results.extractRoot = extractRoot;
  record('summary', {
    entryCount: fileCount,
    checks: results.checks.length,
    failed: results.checks.filter((entry) => !entry.ok).length,
  });
  finish(0);
}

run().catch((error) => {
  process.stderr.write(`[smoke] unexpected error: ${error.stack ?? error.message}\n`);
  results.checks.push({ check: 'no unexpected exception', ok: false, error: error.message });
  finish(1);
});
