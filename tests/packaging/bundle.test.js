/**
 * M8 embedded-runtime bundle launch verification.
 *
 * What this file proves, and what it deliberately does not:
 *
 * - the bundle starts with **no Node on PATH** (`where node` fails inside the
 *   same sanitized environment the worker is launched with);
 * - the worker reaches the preflight + stdio stage offline: a JSON-RPC
 *   `initialize` is answered and `dsh-defense-tools` writes its live runtime
 *   manifest, which is only scheduled after `loader.await()` resolves;
 * - no outbound connection is attempted, enforced by an injected tripwire that
 *   is separately proven to block (a tripwire that cannot fail proves nothing);
 * - the shipped `.cmd` stub resolves the bundled runtime from its own location,
 *   never from PATH and never from a path stored at build time.
 *
 * It does **not** call a model: `initialize` only resolves local call config.
 * `session/prompt` and any real broker are out of scope for this PoC.
 *
 * Environment:
 * - `M8_BUNDLE_DIR` overrides which in-repository bundle is read; the override and
 *   the default must both be a complete `dist/bundle/win32-x64-v<N>` artifact.
 * - `M8_NODE_LICENSE` is passed through to the builder when a bundle has to be
 *   produced first, because the Windows Node installer ships no LICENSE file.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listBundleFiles, sha256File } from '../../deploy/embedded-runtime/lib/stage.mjs';
import { reapAll, trackedSpawn } from './child-reaper.mjs';
import {
  BUNDLE_DIRECTORY_PATTERN,
  defaultBundleRoot,
  isCompleteBundle,
  readPlan,
  resolvePlanPaths,
  scanBundleForHostPaths,
} from './bundle-locator.mjs';

after(async () => {
  await reapAll();
});

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The bundle stores no build-host path, so this suite resolves the launch plan
// against the root it is actually reading — the same join a shipped launcher does.
const BUNDLE_ROOT = defaultBundleRoot();
const TRIPWIRE = join(REPO_ROOT, 'tests', 'packaging', 'network-tripwire.mjs');
const MODULE_TRACE = join(REPO_ROOT, 'tests', 'packaging', 'module-trace.mjs');
const SANITIZED_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem';
const FORBIDDEN_PLUGIN_MARKERS = ['shell', 'mcp', 'telemetry', 'hmr', 'subagent', 'plugin-manager', 'jobs', 'ptc', 'compaction'];
const EXPECTED_TOOLS = ['analysis.submit_result', 'evidence.get_summary'];

function buildEnvironment(extra = {}) {
  return {
    PATH: SANITIZED_PATH,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    OS: 'Windows_NT',
    ...extra,
  };
}

/**
 * The launch plan with its stored paths resolved against the bundle under test.
 *
 * `readPlan` returns the shipped bytes, where every path is relative; this wrapper
 * is the only place that turns them absolute, so the convention is exercised
 * rather than sidestepped by a fixture.
 */
function loadPlan() {
  return resolvePlanPaths(readPlan(BUNDLE_ROOT), BUNDLE_ROOT);
}

/** Build once into the default location when the caller has not already done so. */
function ensureBundle() {
  if (existsSync(join(BUNDLE_ROOT, 'bundle.json'))) return;
  const args = [join(REPO_ROOT, 'deploy', 'embedded-runtime', 'build.mjs'), '--out', BUNDLE_ROOT];
  if (process.env.M8_NODE_LICENSE) args.push('--node-license', process.env.M8_NODE_LICENSE);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(result.status, 0, `bundle build failed:\n${result.stderr ?? ''}${result.stdout ?? ''}`);
}

/** Re-verify every row of the shipped hash manifest against the bytes on disk. */
function verifyBundleHashes() {
  const manifestPath = join(BUNDLE_ROOT, 'manifests', 'files.sha256');
  const rows = readFileSync(manifestPath, 'utf8').split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
  assert.ok(rows.length > 1000, `manifest must cover the whole bundle, saw ${rows.length} rows`);
  for (const line of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.ok(match !== null, `malformed manifest row: ${line}`);
    const path = join(BUNDLE_ROOT, match[2]);
    assert.ok(existsSync(path), `a file disappeared from the bundle: ${match[2]}`);
    assert.equal(sha256File(path), match[1], `bundle bytes changed: ${match[2]}`);
  }
}

/**
 * Allow only the documented "entries did not activate" banner on stderr.
 *
 * Anything else — a stack trace, a module-resolution error, a thrown exception —
 * fails, which is what makes the empty-stderr case meaningful in a fixed tree.
 * @returns the number of pending entries the banner announces
 */
function assertWorkerStderr(stderr) {
  if (stderr === '') return 0;
  const lines = stderr.trimEnd().split('\n');
  assert.match(lines[0], /^dsh: warning: \d+ entries? did not activate$/, `unexpected first stderr line: ${lines[0]}`);
  for (const line of lines.slice(1)) {
    assert.match(line, /^(.+) \((.+)\): pending \(waiting for service: (.+)\)$/, `unexpected stderr line: ${line}`);
  }
  const declared = Number(/^dsh: warning: (\d+)/.exec(lines[0])[1]);
  assert.equal(lines.length - 1, declared, 'the warning count must match the number of pending entries listed');
  return declared;
}

/**
 * Materialise one attempt-scoped environment with the preparer the bundle ships,
 * then layer the tripwire on top. Using the shipped preparer (rather than a test
 * local copy) means the verification exercises what a broker would really call.
 *
 * The attempt root lives under the profile's neutral analysis root (ADR-0005):
 * the working-directory text reaches the model context, so a path under the
 * user profile or the build tree would both leak and fail the assertion.
 */
function createAttempt(label) {
  const plan = loadPlan();
  const policy = JSON.parse(readFileSync(join(plan.profile.sourceMirror, 'profile.json'), 'utf8'));
  const neutralRoot = policy.effectiveConfig.analysisCwdRoots[process.platform];
  const root = join(neutralRoot, `m8-${label}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  try {
    const prepared = spawnSync(plan.node.executable, [plan.profile.preparer, '--root', root], {
      encoding: 'utf8',
      env: buildEnvironment(),
    });
    assert.equal(prepared.status, 0, `prepare-attempt failed: ${prepared.stderr}`);
    const attempt = JSON.parse(prepared.stdout);
    assert.equal(attempt.root, root);
    assert.ok(root.startsWith(neutralRoot), 'the attempt root must sit under the neutral analysis root');
    assert.notEqual(resolve(root), resolve(neutralRoot), 'the attempt root must not be the shared neutral root itself');
    for (const key of ['home', 'tmp', 'cwd', 'session', 'dshHome', 'profileDir', 'toolsDir']) {
      assert.ok(attempt[key].startsWith(root), `${key} must stay inside the attempt root`);
    }
    attempt.root = root;
    attempt.tripwireLog = join(root, 'session', 'net.log');
    attempt.moduleTraceLog = join(root, 'session', 'modules.log');
    attempt.runtimeManifest = attempt.env.AEGIS_RUNTIME_MANIFEST;
    return attempt;
  } catch (error) {
    // The preparer may have created part of the tree before failing; leave no residue.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function attemptEnvironment(attempt, plan) {
  return buildEnvironment({
    ...attempt.env,
    DSH_HOME: attempt.dshHome,
    AEGIS_RUNTIME_MANIFEST: attempt.runtimeManifest,
    NODE_OPTIONS: `--import ${pathToFileURL(TRIPWIRE).href} --import ${pathToFileURL(MODULE_TRACE).href}`,
    M8_TRIPWIRE_LOG: attempt.tripwireLog,
    M8_MODULE_TRACE: attempt.moduleTraceLog,
  });
}

/**
 * Package names behind the files the worker actually loaded.
 *
 * Walking up to the nearest `package.json` inside the bundle is what makes the
 * trace comparable to the prune list: the list is name-based, so a file under
 * `app/node_modules/@scope/name/lib/x.js` must map back to `@scope/name` exactly
 * as the third-party inventory spells it.
 */
function tracePackages(logPath) {
  assert.ok(existsSync(logPath), 'the module tracer produced no log at all');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0);
  assert.equal(lines.filter((line) => line.startsWith('<tracer-armed>')).length, 1,
    'the tracer must prove it was armed, otherwise an empty trace proves nothing');
  const names = new Set();
  const cache = new Map();
  for (const line of lines) {
    if (line.startsWith('<tracer-armed>')) continue;
    let directory = dirname(line);
    for (let guard = 0; guard < 32; guard += 1) {
      if (cache.has(directory)) {
        const cached = cache.get(directory);
        if (cached !== undefined) names.add(cached);
        break;
      }
      const manifestPath = join(directory, 'package.json');
      if (existsSync(manifestPath)) {
        let name;
        try {
          name = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
        } catch {
          name = undefined;
        }
        cache.set(directory, name);
        if (typeof name === 'string') names.add(name);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return names;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

/**
 * Drive the worker's newline-delimited JSON-RPC transport without a client SDK.
 * `command` is the bundled runtime (or `cmd` for the shipped stub) rather than
 * `process.execPath`, so the launch is really tested.
 */
async function probeWorker({ command, args, cwd, env, runtimeManifest, timeoutMs = 90000 }) {
  const child = trackedSpawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const frames = [];
  const pending = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  let failure;

  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    for (let index = stdoutBuffer.indexOf('\n'); index >= 0; index = stdoutBuffer.indexOf('\n')) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        failure ??= new Error(`non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      frames.push(frame);
      const waiter = pending.get(frame.id);
      if (waiter !== undefined) {
        pending.delete(frame.id);
        if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { rpcError: frame.error }));
        else waiter.resolve(frame.result);
      }
    }
  });

  function request(method, params = {}) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`JSON-RPC ${method} timed out; stderr so far:\n${stderr}\nframes: ${JSON.stringify(frames)}`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return answer;
  }

  try {
    const initialize = await request('initialize', {
      cwd,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxTokens: 2000,
      approvalRequests: false,
      capabilities: { userQuestions: false },
    });
    // The runtime manifest is written on a setImmediate after loader.await().
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(runtimeManifest) && Date.now() < deadline) await sleep(50);
    await request('shutdown');
    const exitResult = await Promise.race([exit, sleep(timeoutMs).then(() => ({ code: 'timeout', signal: null }))]);
    child.kill();
    return { initialize, frames, stderr, exit: exitResult, runtimeWritten: existsSync(runtimeManifest) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  }
}

function readTripwireLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

/**
 * "No network" is only meaningful when the tripwire proves it ran. An absent or
 * unwritable log must not be read as zero attempts, so every caller asserts the
 * `armed` record explicitly.
 */
function armedRecords(path) {
  return readTripwireLog(path).filter((entry) => entry.kind === 'armed');
}

function blockedRecords(path) {
  // `net.allowed` only exists for the stubbed-broker prompt test, which sets an
  // explicit loopback allowlist. Boot never sets it, so an allowed record here
  // would itself be a finding; it is filtered out of "blocked" to keep the two
  // meanings apart rather than counting one as the other.
  return readTripwireLog(path).filter((entry) => entry.kind !== 'armed' && entry.kind !== 'net.allowed');
}

test('the delivered bundle is the in-repository versioned artifact and its launch plan stores no build-host path', () => {
  ensureBundle();
  const raw = readPlan(BUNDLE_ROOT);
  const plan = resolvePlanPaths(raw, BUNDLE_ROOT);
  // The delivered bundle is an artifact *of this repository*, never a build-host
  // scratch tree: it must sit directly under `<repo>/dist/bundle/`, be a versioned
  // `win32-x64-v<N>` directory, carry the four completeness markers, and not
  // overlap a source tree. This replaces the pre-v14 assertion "the bundle lives
  // outside the repository": that was true only while the sole bundle was the
  // external `_m8_poc` build, and that tree is exactly what BASE-01 showed to be
  // stale. `v14-profile.test.js` already makes "in-repository artifact path" the
  // contract (`daemon-console.json.defaultOut = dist/bundle/win32-x64-v14`), and
  // rc.3 ships `dist/bundle/win32-x64-v15`; the invariant is inverted, not
  // relaxed — it now names the delivered artifact instead of accepting any
  // directory outside the tree.
  const insideRoot = relative(REPO_ROOT, BUNDLE_ROOT);
  assert.ok(insideRoot.length > 0 && !insideRoot.startsWith('..') && !isAbsolute(insideRoot),
    `the delivered bundle must live inside the repository, got ${BUNDLE_ROOT}`);
  const bundleParent = join(REPO_ROOT, 'dist', 'bundle');
  assert.equal(dirname(BUNDLE_ROOT), bundleParent,
    `the delivered bundle must be a direct child of ${bundleParent}`);
  assert.ok(BUNDLE_DIRECTORY_PATTERN.test(basename(BUNDLE_ROOT)),
    `the delivered bundle directory must be a versioned artifact (win32-x64-v<N>), got ${basename(BUNDLE_ROOT)}`);
  assert.ok(isCompleteBundle(BUNDLE_ROOT),
    `the delivered bundle must be complete (${BUNDLE_ROOT} is missing bundle.json / launch plan / runtime / hash manifest)`);
  for (const sourceDirectory of ['apps', 'packages', 'plugins', 'tests', 'docs']) {
    const fromSource = relative(join(REPO_ROOT, sourceDirectory), BUNDLE_ROOT);
    assert.ok(fromSource.startsWith('..') || isAbsolute(fromSource),
      `the delivered bundle must not sit inside the ${sourceDirectory}/ source tree: ${BUNDLE_ROOT}`);
  }

  assert.equal(plan.author, 'PT-dove');
  assert.equal(plan.kind, 'packaging-poc');
  assert.deepEqual(plan.worker.argv, ['--profile', 'aegis-analysis']);

  // The shipped plan must not name the machine it was assembled on: that is what
  // makes a copy launch itself instead of the original.
  assert.ok(raw.pathConvention !== null && typeof raw.pathConvention === 'object',
    'the plan must declare how its paths are to be read; without it a relative path is indistinguishable from a typo');
  assert.equal(raw.pathConvention.kind, 'bundle-relative', 'the plan must declare how its paths are to be read');
  assert.equal(raw.pathConvention.separator.includes('forward slash'), true, 'the plan must name the separator');
  assert.equal(raw.bundleRoot, '.', 'the bundle root is the directory the plan is resolved against, not a stored path');
  const DRIVE_OR_UNC = /(?:^|[\\/])[A-Za-z]:[\\/]|^\\\\/;
  for (const [label, stored] of [
    ['node.executable', raw.node.executable],
    ['worker.entry', raw.worker.entry],
    ['profile.templateDir', raw.profile.templateDir],
    ['profile.templateToolsDir', raw.profile.templateToolsDir],
    ['profile.sourceMirror', raw.profile.sourceMirror],
    ['profile.preparer', raw.profile.preparer],
  ]) {
    assert.equal(isAbsolute(stored), false, `${label} must be bundle-relative, saw ${stored}`);
    assert.equal(DRIVE_OR_UNC.test(stored), false, `${label} must not carry a drive or UNC prefix: ${stored}`);
    assert.equal(stored.split('/').includes('..'), false, `${label} must not escape the bundle root: ${stored}`);
  }

  // Resolving them the documented way must land inside this bundle and on a real
  // file. A relative path that escaped the root would be worse than an absolute
  // one, because it would still look portable.
  for (const [label, absolute] of [
    ['node.executable', plan.node.executable],
    ['worker.entry', plan.worker.entry],
    ['profile.templateDir', plan.profile.templateDir],
    ['profile.templateToolsDir', plan.profile.templateToolsDir],
    ['profile.sourceMirror', plan.profile.sourceMirror],
    ['profile.preparer', plan.profile.preparer],
  ]) {
    assert.ok(isAbsolute(absolute), `${label} must resolve to an absolute path in the launching process`);
    assert.ok(absolute.startsWith(BUNDLE_ROOT), `${label} must resolve inside the bundle: ${absolute}`);
    assert.ok(existsSync(absolute), `${label} resolves to a missing file: ${absolute}`);
  }

  assert.equal(plan.profile.dshHomePolicy, 'attempt-scoped', 'DSH_HOME must be per attempt, not the bundle');
  assert.match(plan.profile.note, /\.cordis/, 'the launch plan must explain why DSH_HOME cannot be the bundle');
  assert.deepEqual(plan.network.brokerHostAllowlist, ['127.0.0.1', '::1']);
  // The plan must state what the delivered payload deliberately does not do.
  // A bundle profile may override the builder's defaults: build.mjs:831-852 takes
  // `profile.document.nonGoals` when it is a non-empty array, replacing
  // `defaultNonGoals` (whose first three entries are a v13-era "code signing /
  // formal installer / uninstaller / updater" trio). The delivered v15/v16
  // desktop payloads declare their own list, because rc.3+ ships the desktop shell
  // and its installer chain — the old "no formal installer / updater" claim would
  // describe a payload that no longer exists. The assertions below pin the current
  // contract instead of accepting any list: the retired claim must stay retired
  // (a reappearance is a red flag), and the updater non-goal must be stated in the
  // current wording.
  assert.ok(Array.isArray(plan.nonGoals) && plan.nonGoals.length > 0,
    'the launch plan must declare a non-empty nonGoals array');
  for (const nonGoal of plan.nonGoals) {
    assert.equal(typeof nonGoal, 'string', `nonGoals entries must be strings, saw ${JSON.stringify(nonGoal)}`);
    assert.ok(nonGoal.trim().length > 0, 'nonGoals entries must not be empty');
  }
  const statedNonGoals = plan.nonGoals.join('\n');
  for (const nonGoal of [
    'code signing',
    'four-OS packaging',
    'model weights',
    'broker / sandbox-launcher integration',
    'service registration',
  ]) {
    assert.ok(statedNonGoals.includes(nonGoal), `launch plan must state the non-goal "${nonGoal}"`);
  }
  assert.equal(statedNonGoals.includes('formal installer / uninstaller'), false,
    'the retired "formal installer / uninstaller" non-goal must not reappear: rc.3+ ships the installer chain');
  assert.ok(plan.nonGoals.some((nonGoal) => nonGoal.includes('automatic download/apply of an update')),
    'the launch plan must state the updater non-goal in the current wording');

  const stub = readFileSync(join(BUNDLE_ROOT, 'launch', 'aegis-harness-worker.cmd'), 'utf8');
  assert.ok(stub.includes('%~dp0'), 'the stub must derive the bundle root from its own location');
  assert.ok(stub.includes('set "AEGIS_BUNDLE_ROOT=%%~fI"'),
    'the stub must normalise the derived root before using it');
  assert.ok(stub.includes('%AEGIS_BUNDLE_ROOT%\\runtime\\node\\node.exe'),
    'the stub must build the runtime path from the derived root');
  assert.ok(stub.includes('%AEGIS_BUNDLE_ROOT%\\app\\node_modules\\@aegisharness\\harness-worker\\bin.js'),
    'the stub must build the worker entry from the derived root');
  assert.equal(/[A-Za-z]:[\\/]/.test(stub), false, 'the stub must not contain a drive-letter path');
  assert.equal(stub.includes(BUNDLE_ROOT), false, 'the stub must not name the directory the bundle sits in');
  for (const line of stub.split(/\r?\n/)) {
    const trimmed = line.trim();
    assert.ok(!/^(npm|npx)\b/i.test(trimmed), `stub must not shell out to a package manager: ${trimmed}`);
    assert.ok(!/\bnode\.exe\b/i.test(trimmed) || trimmed.includes('%AEGIS_BUNDLE_ROOT%'),
      `stub must not rely on PATH for Node: ${trimmed}`);
  }
  assert.ok(!/%PATH%/.test(stub), 'stub must not resolve anything through PATH');
});

test('the bundled runtime reports Node 24 and the sanitized PATH has no Node', () => {
  ensureBundle();
  const plan = loadPlan();
  const version = spawnSync(plan.node.executable, ['--version'], { encoding: 'utf8', env: buildEnvironment() });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^v24\.\d+\.\d+$/);

  // Positive control: the host environment really does expose a Node on PATH,
  // so the failure below is caused by sanitization, not by a missing utility.
  const hostWhere = spawnSync('cmd', ['/c', 'where', 'node'], { encoding: 'utf8', env: buildEnvironment({ PATH: process.env.PATH }) });
  assert.equal(hostWhere.status, 0, 'positive control failed: host PATH must contain node');

  const where = spawnSync('cmd', ['/c', 'where', 'node'], { encoding: 'utf8', env: buildEnvironment() });
  assert.notEqual(where.status, 0, 'sanitized PATH must not expose a system Node');
});

test('the worker boots to the stdio stage with no system Node and no network, then exits 0', async () => {
  ensureBundle();
  const plan = loadPlan();
  const attempt = createAttempt('boot');
  try {
    const result = await probeWorker({
      command: plan.node.executable,
      args: [plan.worker.entry, ...plan.worker.argv],
      cwd: attempt.cwd,
      env: attemptEnvironment(attempt, plan),
      runtimeManifest: attempt.runtimeManifest,
    });

    assert.equal(result.initialize.serverInfo.name, 'deepseek-harness-sdk-runtime');
    assert.deepEqual(result.exit, { code: 0, signal: null }, 'shutdown must exit cleanly');
    assert.ok(result.runtimeWritten, 'runtime manifest must be written after loader.await()');

    // Two frames only: the initialize result and the shutdown result. Any extra
    // stdout line would mean the worker leaked diagnostics into the control channel.
    assert.equal(result.frames.length, 2, `unexpected stdout frames: ${JSON.stringify(result.frames)}`);

    // The bundle must behave exactly like the in-repository launch. The stderr
    // contract is asserted structurally rather than by diffing another task's
    // evidence file: that file is regenerated by whoever runs WP0, and it already
    // changed under this task once when the pending-service gap was fixed upstream.
    const declaredPending = assertWorkerStderr(result.stderr);

    const runtime = JSON.parse(readFileSync(attempt.runtimeManifest, 'utf8'));
    assert.equal(runtime.captureError, undefined, `runtime capture failed: ${runtime.captureError}\n${runtime.stack ?? ''}`);
    assert.equal(runtime.capturedFrom, 'live-cordis-runtime');

    const entries = runtime.plugins.entries;
    // The expected count is derived from the reviewed profile, not hardcoded, so
    // the test tracks profile evolution instead of pinning a stale number. One
    // extra entry (`include`) is the loader's own root include.
    const policy = JSON.parse(readFileSync(join(plan.profile.sourceMirror, 'profile.json'), 'utf8'));
    assert.equal(entries.length, policy.allowedPluginIds.length + 1,
      'the mounted tree must match the reviewed plugin allowlist (plus the loader include)');
    const outsideAllowlist = entries
      .map((entry) => entry.id.replace(/^include:/, ''))
      .filter((id) => id !== 'include' && !policy.allowedPluginIds.includes(id));
    assert.deepEqual(outsideAllowlist, [], 'a plugin outside the reviewed allowlist was mounted');

    const failed = entries.filter((entry) => entry.state === 'failed' || entry.state.startsWith?.('unknown'));
    assert.deepEqual(failed.map((entry) => [entry.id, entry.state]), [], 'no mounted plugin may fail');
    const pending = entries.filter((entry) => entry.state !== 'active');
    // Pending is allowed only for a declared missing service: that is the shape a
    // dependency- or version-complete tree produces. A staging defect shows up as
    // "failed" or as a missing package, both of which are rejected above.
    for (const entry of pending) {
      assert.ok((entry.missingServices ?? []).length > 0,
        `entry ${entry.id} is inert without naming a missing service, which the bundle must not ship`);
    }
    assert.equal(declaredPending, pending.length, 'stderr must announce exactly the entries that stayed pending');
    assert.deepEqual(runtime.plugins.startedBundles, [], 'no base/sdk-minimal bundle may be started');

    for (const marker of FORBIDDEN_PLUGIN_MARKERS) {
      const offenders = entries.filter((entry) => `${entry.id} ${entry.package}`.toLowerCase().includes(marker));
      assert.deepEqual(offenders.map((entry) => entry.package), [], `forbidden capability "${marker}" must not mount`);
    }

    assert.deepEqual([...runtime.model.tools].map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    assert.equal(runtime.model.effective.shellTools, false);
    assert.equal(runtime.model.effective.fsTools, false);
    assert.equal(runtime.model.effective.webTools, false);
    assert.equal(runtime.model.effective.workingDirectoryTools, false);
    assert.equal(runtime.model.effective.mcp, false);
    assert.equal(runtime.model.effective.subagent, false);
    assert.equal(runtime.model.effective.telemetry, false);
    assert.equal(runtime.model.effective.stdoutLoggerPlugin, false);
    assert.equal(runtime.model.effective.automaticCompaction, false);
    assert.equal(runtime.model.effective.hmr, false);
    assert.equal(runtime.model.effective.pluginManager, false);

    // ADR-0005（方案 A，已 Accepted）：`working-directory` 的 required+prepend 使这条上下文
    // 关不掉，所以门禁从"必须为空"改成"必须恰为声明的那一条，且其中的 cwd 落在中性根下"。
    // 旧断言 `text === ''` 只在探针无 agent、装配回调提前返回时成立；探针改为带桩 agent 后
    // 它会拿到真实文本，继续断言空值等于要求"探针拿不到真相"，与 ADR-0005 §7.1 相反。
    const bundleProfile = JSON.parse(readFileSync(
      join(plan.profile.sourceMirror, 'profile.json'), 'utf8',
    ));
    const neutralRoot = bundleProfile.effectiveConfig.analysisCwdRoots[process.platform];
    const template = bundleProfile.effectiveConfig.runtimeContextTextTemplate;
    const contexts = runtime.model.runtimeContexts ?? [];
    assert.equal(contexts.length, 1, 'exactly one runtime context is allowlisted (ADR-0005)');
    assert.equal(contexts[0].name, bundleProfile.effectiveConfig.runtimeContextAllowlist[0]);
    assert.equal(contexts[0].interpolate, false, 'the allowlisted context must not be interpolated');
    const rawContext = String(contexts[0].text ?? '');
    assert.ok(rawContext.startsWith(template.split('{cwd}')[0]), `runtime context text must follow ${JSON.stringify(template)}`);
    const quotedCwd = rawContext.slice(template.split('{cwd}')[0].length, rawContext.length - template.split('{cwd}')[1].length);
    const contextCwd = JSON.parse(`"${quotedCwd.replace(/"/gu, '\\"')}"`);
    assert.ok(isAbsolute(contextCwd), 'the runtime context cwd must be absolute');
    assert.ok(
      resolve(contextCwd).startsWith(resolve(neutralRoot) + sep),
      `the runtime context cwd must stay under the neutral analysis root ${neutralRoot}`,
    );
    for (const token of ['Users', 'AppData', '/home/', 'AIUSE']) {
      assert.equal(contextCwd.includes(token), false, `runtime context must not leak ${token}`);
    }

    // The only configured model route is the loopback broker from the profile.
    const providers = runtime.model.providers;
    assert.equal(providers.length, 1, 'exactly one model provider must be registered');
    assert.equal(providers[0].provider, 'deepseek-official');
    assert.equal(providers[0].baseURL, 'http://127.0.0.1:9/anthropic');
    assert.equal(providers[0].retryPolicy.maxRetries, 0);
    assert.equal(providers[0].remoteModelListing, false);
    assert.deepEqual(providers[0].models.map((model) => model.id), ['deepseek-chat']);
    assert.equal(providers[0].models[0].maxTokens, 2000);

    // Proof of life first: an empty log would otherwise be indistinguishable
    // from a tripwire that never loaded.
    assert.equal(armedRecords(attempt.tripwireLog).length, 1, 'the tripwire must prove it was armed');
    assert.deepEqual(blockedRecords(attempt.tripwireLog), [], 'the worker must not attempt any outbound connection');
    // The boot path talks to nothing, not even loopback: the allowlist that the
    // prompt smoke uses must be absent here, otherwise "zero attempts" would be
    // hiding a permitted connection.
    assert.deepEqual(readTripwireLog(attempt.tripwireLog).filter((entry) => entry.kind === 'net.allowed'), [],
      'the boot path must not open any connection, including to a loopback broker');

    // Pruning is only sound if the boot never loads a pruned package. The trace
    // is the runtime counterpart of the builder's static gate: a computed
    // specifier the graph missed would surface here.
    const loaded = tracePackages(attempt.moduleTraceLog);
    for (const required of [
      '@aegisharness/harness-worker',
      '@aegisharness/harness-adapter',
      '@aegisharness/dsh-defense-tools',
      '@deepseek-ai/dsh',
      '@deepseek-ai/cordis-plugin-loader',
    ]) {
      assert.ok(loaded.has(required), `the tracer must observe ${required}, otherwise the trace is not evidence`);
    }
    const trimReport = JSON.parse(readFileSync(join(BUNDLE_ROOT, 'manifests', 'trim-report.json'), 'utf8'));
    const prunedNames = new Set(trimReport.pruned.map((row) => row.name));
    const prunedButLoaded = [...loaded].filter((name) => prunedNames.has(name));
    assert.deepEqual(prunedButLoaded, [], 'a package the trim report removed was loaded at runtime');
    // The dead LibreOffice chain ends at `dfa`, the only package that ever had no
    // upstream licence text. Nothing in the boot may load it: `dfa` is imported
    // only by `fontkit`, and `fontkit` only by `libreoffice-kit`, both pruned.
    for (const name of ['dfa', 'fontkit', '@deepseek-ai/libreoffice-kit']) {
      assert.equal(loaded.has(name), false, `the boot loaded ${name}, which the trim removed`);
    }
    assert.ok(loaded.size < trimReport.summary.keptPackages + 5,
      `the trace saw ${loaded.size} packages but the bundle only kept ${trimReport.summary.keptPackages}`);

    // Booting must not mutate the reviewed profile bytes the preflight hashes,
    // neither in the attempt copy nor in the bundle's own template.
    const approved = JSON.parse(readFileSync(join(plan.profile.sourceMirror, 'approved-hashes.json'), 'utf8'));
    for (const [source, record] of Object.entries(approved.files)) {
      const profileRelative = source.startsWith('plugins/dsh-defense-profile/')
        ? source.slice('plugins/dsh-defense-profile/'.length)
        : undefined;
      const toolRelative = source.startsWith('plugins/dsh-defense-tools/')
        ? source.slice('plugins/dsh-defense-tools/'.length)
        : undefined;
      const attemptTarget = profileRelative === undefined
        ? join(attempt.toolsDir, toolRelative)
        : join(attempt.profileDir, profileRelative);
      const templateTarget = profileRelative === undefined
        ? join(plan.profile.templateToolsDir, toolRelative)
        : join(plan.profile.templateDir, profileRelative);
      assert.equal(sha256File(attemptTarget), record.sha256, `attempt copy diverged: ${source}`);
      assert.equal(sha256File(templateTarget), record.sha256, `bundle template was modified by a launch: ${source}`);
    }
    // The runtime must be reading the attempt copy, not the bundle template.
    assert.ok(runtime.plugins.patchSources.length > 0, 'the profile patch sources must be reported');
    for (const source of runtime.plugins.patchSources) {
      assert.ok(source.path.startsWith(attempt.dshHome), `runtime read a patch outside the attempt: ${source.path}`);
      assert.match(source.sha256, /^[0-9a-f]{64}$/);
    }
    // Nothing in the bundle may have changed during the launch.
    verifyBundleHashes();
  } finally {
    rmSync(attempt.root, { recursive: true, force: true });
  }
});

test('the shipped launcher stub starts the worker with a PATH that has no Node', async () => {
  ensureBundle();
  const plan = loadPlan();
  const attempt = createAttempt('stub');
  try {
    const stub = join(BUNDLE_ROOT, 'launch', 'aegis-harness-worker.cmd');
    const result = await probeWorker({
      command: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      args: ['/c', stub],
      cwd: attempt.cwd,
      env: attemptEnvironment(attempt, plan),
      runtimeManifest: attempt.runtimeManifest,
    });
    assert.equal(result.initialize.serverInfo.name, 'deepseek-harness-sdk-runtime');
    assertWorkerStderr(result.stderr);
    assert.deepEqual(result.exit, { code: 0, signal: null });
    // The stub clears NODE_OPTIONS on purpose, so the tripwire must NOT be armed
    // here. That is the hardening being asserted — not a network measurement.
    assert.deepEqual(readTripwireLog(attempt.tripwireLog), [],
      'the stub must clear NODE_OPTIONS, so an injected preload cannot arm');
  } finally {
    rmSync(attempt.root, { recursive: true, force: true });
  }
});

test('the network tripwire really blocks, so the zero-attempt result means something', () => {
  const attempt = createAttempt('tripwire');
  try {
    const env = buildEnvironment({ M8_TRIPWIRE_LOG: attempt.tripwireLog });
    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(TRIPWIRE).href, join(REPO_ROOT, 'tests', 'packaging', 'tripwire-selftest.mjs')],
      { encoding: 'utf8', env },
    );
    assert.equal(result.status, 0, `selftest failed: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).blocked, 'ERR_M8_NETWORK_BLOCKED');
    assert.equal(armedRecords(attempt.tripwireLog).length, 1, 'the selftest must also prove the tripwire armed');
    const blocked = blockedRecords(attempt.tripwireLog);
    assert.equal(blocked.length, 1, 'the blocked attempt must be recorded');
    assert.equal(blocked[0].kind, 'net.socket.connect');
  } finally {
    rmSync(attempt.root, { recursive: true, force: true });
  }
});

test('the builder refuses profile inputs whose approved hashes have drifted', () => {
  ensureBundle();
  const plan = loadPlan();
  const root = mkdtempSync(join(tmpdir(), 'm8-drift-'));
  try {
    const snapshot = join(root, 'snapshot');
    const profileSource = join(snapshot, 'dsh-defense-profile');
    const toolsSource = join(snapshot, 'dsh-defense-tools');
    cpSync(plan.profile.templateDir, profileSource, {
      recursive: true,
      filter: (source) => !source.includes(`${sep}node_modules`),
    });
    cpSync(plan.profile.templateToolsDir, toolsSource, { recursive: true });
    // One appended byte is enough: the packaged worker would reject it anyway.
    appendFileSync(join(toolsSource, 'lib', 'index.js'), '\n// tampered after review\n');

    const out = join(root, 'out');
    const result = spawnSync(process.execPath, [
      join(REPO_ROOT, 'deploy', 'embedded-runtime', 'build.mjs'),
      '--profile-snapshot', snapshot,
      '--out', out,
    ], { encoding: 'utf8', env: buildEnvironment() });
    assert.notEqual(result.status, 0, 'a drifted input must fail the build');
    assert.match(result.stderr, /approved-hashes\.json disagree/);
    assert.match(result.stderr, /lib[\\/]index\.js/);
    assert.ok(!existsSync(out), 'the build must fail before creating the output directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the output guard rejects spellings that only look outside the repository', () => {
  ensureBundle();
  const buildScript = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'build.mjs');
  const run = (out) => spawnSync(process.execPath, [buildScript, '--out', out], { encoding: 'utf8', env: buildEnvironment() });

  // Extended-length prefix: `resolve()` keeps it, so a lexical check would pass it
  // through and write straight into the repository.
  const extended = `\\\\?\\${join(REPO_ROOT, '_m8_guard_probe')}`;
  const extendedResult = run(extended);
  assert.notEqual(extendedResult.status, 0, 'an extended-length path must be refused');
  assert.match(extendedResult.stderr, /extended-length or device prefix/);

  // Junction: a directory that lexically sits outside the repository but resolves
  // into it. `relative()` would allow this; the canonical check must not.
  const linkRoot = mkdtempSync(join(tmpdir(), 'm8-junction-'));
  const junction = join(linkRoot, 'into-repo');
  try {
    symlinkSync(REPO_ROOT, junction, 'junction');
    const junctionResult = run(join(junction, '_m8_guard_probe'));
    assert.notEqual(junctionResult.status, 0, 'a junction into the repository must be refused');
    assert.match(junctionResult.stderr, /refusing to build inside the repository/);
    assert.ok(!existsSync(join(REPO_ROOT, '_m8_guard_probe')), 'the guard must not have written into the repository');
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }

  // The attempt preparer must refuse roots that resolve into the bundle from a
  // sibling-looking spelling, and must refuse a non-empty root.
  const plan = loadPlan();
  const nested = join(BUNDLE_ROOT, 'attempt');
  const nestedResult = spawnSync(plan.node.executable, [plan.profile.preparer, '--root', nested], { encoding: 'utf8', env: buildEnvironment() });
  assert.notEqual(nestedResult.status, 0, 'an attempt root inside the bundle must be refused');
  assert.match(nestedResult.stderr, /must not be inside the bundle/);

  // A root outside the profile's neutral analysis root is refused (ADR-0005),
  // and a non-empty root inside it is refused too.
  const policy = JSON.parse(readFileSync(join(plan.profile.sourceMirror, 'profile.json'), 'utf8'));
  const neutralRoot = policy.effectiveConfig.analysisCwdRoots[process.platform];

  const outside = mkdtempSync(join(tmpdir(), 'm8-outside-'));
  try {
    const outsideResult = spawnSync(plan.node.executable, [plan.profile.preparer, '--root', outside], { encoding: 'utf8', env: buildEnvironment() });
    assert.notEqual(outsideResult.status, 0, 'an attempt root outside the neutral analysis root must be refused');
    assert.match(outsideResult.stderr, /must be a subdirectory of the neutral analysis root/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  const occupied = join(neutralRoot, `m8-occupied-${randomUUID().slice(0, 8)}`);
  try {
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'leftover.txt'), 'poisoned\n');
    const occupiedResult = spawnSync(plan.node.executable, [plan.profile.preparer, '--root', occupied], { encoding: 'utf8', env: buildEnvironment() });
    assert.notEqual(occupiedResult.status, 0, 'a non-empty attempt root must be refused');
    assert.match(occupiedResult.stderr, /attempt root must be empty/);
  } finally {
    rmSync(occupied, { recursive: true, force: true });
  }
});

test('the bundle carries no symlink, no build-host path and no credential', () => {
  ensureBundle();
  const files = listBundleFiles(BUNDLE_ROOT);
  assert.ok(files.includes('launch/launch-plan.json'));
  assert.ok(existsSync(join(BUNDLE_ROOT, 'manifests', 'files.sha256')), 'the hash manifest is missing');
  assert.ok(existsSync(join(BUNDLE_ROOT, 'launch', 'prepare-attempt.mjs')), 'the attempt preparer is missing');

  // Independent re-derivation of the builder's leak gate, run against the bytes
  // that actually ship: the repository, its parent, the bundle root and the build
  // user's profile, in all three spellings. `manifests/` is included because it
  // is generated from the same inputs and can carry a path just as easily.
  const scan = scanBundleForHostPaths(BUNDLE_ROOT);
  assert.equal(scan.oversized, 0, 'every shipped file must be scannable, otherwise the guarantee has a hole');
  assert.ok(scan.scanned > 40000, `the scan must cover the whole bundle, saw ${scan.scanned} files`);
  assert.deepEqual(
    scan.offenders,
    [],
    `bundle must not name the build host: ${scan.offenders.slice(0, 5).map((row) => `${row.path} (${row.label}: ${row.spelling})`).join(', ')}`,
  );

  const offenders = [];
  // A literal token is only suspicious when it is not an obvious placeholder.
  const TOKEN_LITERAL = /AEGIS_BROKER_TOKEN["']?\s*[:=]\s*["']([^"']+)["']/g;
  const PLACEHOLDER = /harmless|placeholder|example|sample|dummy|single-attempt|poc/i;
  for (const path of files) {
    if (!/\.(?:js|mjs|cjs|json|yml|yaml|md|txt|cmd)$/i.test(path)) continue;
    const text = readFileSync(join(BUNDLE_ROOT, path), 'utf8');
    for (const match of text.matchAll(TOKEN_LITERAL)) {
      if (!PLACEHOLDER.test(match[1])) offenders.push(`${path} (credential: ${match[1].slice(0, 6)}…)`);
    }
  }
  assert.deepEqual(offenders, [], `bundle must not embed credentials: ${offenders.join(', ')}`);
});
