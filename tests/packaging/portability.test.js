/**
 * M8 bundle portability verification: the delivered directory must survive a move.
 *
 * The defect this file exists for: every launch artifact used to record the
 * directory the bundle was built in (`D:\…\_m8_poc\bundle\…`) as a literal. That
 * is invisible on the build machine — the paths still resolve — and fatal the
 * moment the tree is copied, renamed, or handed to someone else. A bundle that
 * cannot be relocated is not a distributable, so the property is asserted here
 * rather than argued for in prose.
 *
 * What is proven, in order:
 *
 * 1. the shipped artifacts store *no* absolute path and declare how the root is
 *    found at launch (`%~dp0..` for the stub, `import.meta.url` for the preparer);
 * 2. a copy, renamed to a directory that never existed during the build, still
 *    verifies every row of its own `manifests/files.sha256`;
 * 3. that copy boots from its new location — through the shipped preparer and
 *    through the shipped `.cmd` stub — mounts 21/21 plugin entries active, offers
 *    exactly the two defense tools, and **loads every module from the copy**, not
 *    from the original tree.
 *
 * Point 3 is the one that matters: the original bundle is deliberately still on
 * disk, so a leftover absolute path would keep working and hide itself. The module
 * trace (absolute file paths of what Node actually loaded) is what distinguishes
 * "it launched" from "it launched from here".
 *
 * A copy is 430 MiB / 47 k files, so it is made once and shared by the tests below.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT, defaultBundleRoot, fromBundle, readPlan } from './bundle-locator.mjs';
import { reapAll, trackedSpawn } from './child-reaper.mjs';
import { sha256File } from '../../deploy/embedded-runtime/lib/stage.mjs';

const ORIGINAL_ROOT = defaultBundleRoot();
const TRIPWIRE = join(REPO_ROOT, 'tests', 'packaging', 'network-tripwire.mjs');
const MODULE_TRACE = join(REPO_ROOT, 'tests', 'packaging', 'module-trace.mjs');
const SANITIZED_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem';
const EXPECTED_TOOLS = ['analysis.submit_result', 'evidence.get_summary'];
const MIN_FREE_MIB = 1200;
// A drive-letter or UNC path, without mistaking a URL scheme (`http://`) for one.
const DRIVE_OR_UNC = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]|^\\\\/;

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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, milliseconds);
    timer.unref();
  });
}

/**
 * The relocated copy, created once.
 *
 * The copy is made under a fresh temporary directory and then renamed, so the
 * directory it finally runs from has never existed before: a path baked in at
 * build time, or even a path derived once at copy time, cannot be right by luck.
 * A failure is memoised and rethrown, so a later test fails with the original
 * reason instead of quietly passing on a partial tree.
 */
let relocated;
function ensureRelocated() {
  if (relocated !== undefined) {
    if (relocated.error !== undefined) throw relocated.error;
    return relocated;
  }
  let parent;
  try {
    assert.ok(existsSync(join(ORIGINAL_ROOT, 'bundle.json')), `build the bundle first: ${ORIGINAL_ROOT} is missing`);
    const free = statfsSync(tmpdir());
    const freeMiB = Math.round((free.bavail * free.bsize) / 1048576);
    assert.ok(freeMiB >= MIN_FREE_MIB, `relocation needs ${MIN_FREE_MIB} MiB free under ${tmpdir()}, saw ${freeMiB} MiB`);

    parent = mkdtempSync(join(tmpdir(), 'm8-portability-'));
    const first = join(parent, 'copy-first');
    const root = join(parent, `relocated-${randomUUID().slice(0, 8)}`);
    // This copy is the slowest step in the whole packaging suite (430 MiB / 47 107
    // files), and when the process dies mid-copy the runner has nothing to report
    // but "the file failed" — which is exactly how R6-006② was observed once:
    // 526 609 ms, no assertion detail, and a complete relocated tree left behind
    // because the after-hook never ran. These two lines cost nothing and make the
    // next occurrence attributable from the captured output alone: how long the
    // copy took, and how much room it had to do it in.
    process.stderr.write(`portability: copying ${ORIGINAL_ROOT} -> ${first} (${freeMiB} MiB free under temp)\n`);
    const copyStarted = Date.now();
    cpSync(ORIGINAL_ROOT, first, { recursive: true, dereference: false, preserveTimestamps: false, force: true });
    process.stderr.write(`portability: copied in ${Date.now() - copyStarted} ms\n`);
    renameSync(first, root);
    relocated = { parent, root };
    return relocated;
  } catch (error) {
    // A half-written copy is 430 MiB; keep the parent so the after-hook can still
    // remove it instead of leaving it to the temp cleaner.
    relocated = { error, parent };
    throw error;
  }
}

after(() => {
  if (relocated?.parent !== undefined && existsSync(relocated.parent)) {
    rmSync(relocated.parent, { recursive: true, force: true });
  }
});

/**
 * `kill()` without waiting is not cleanup: the pipes stay attached and the file never
 * exits, which reads as "the runner hung" rather than "a test leaked a process".
 */
after(async () => {
  await reapAll();
});

/** Every row of the shipped hash manifest, checked against the bytes at `root`. */
function verifyHashes(root) {
  const manifestPath = join(root, 'manifests', 'files.sha256');
  const rows = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  assert.ok(rows.length > 40000, `the manifest must cover the whole bundle, saw ${rows.length} rows`);
  const mismatched = [];
  for (const line of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.ok(match !== null, `malformed manifest row: ${line.slice(0, 120)}`);
    const path = join(root, match[2]);
    if (!existsSync(path)) {
      mismatched.push(`${match[2]}: missing`);
      continue;
    }
    const actual = sha256File(path);
    if (actual !== match[1]) mismatched.push(`${match[2]}: ${actual.slice(0, 12)}… != ${match[1].slice(0, 12)}…`);
  }
  assert.deepEqual(mismatched.slice(0, 5), [], `the copied bundle does not match its own manifest (${mismatched.length} rows)`);
  return rows.length;
}

/**
 * Allow only the documented "entries did not activate" banner on stderr, exactly
 * as the boot suite does: anything else is a stack trace, and a stack trace in a
 * relocated bundle is the finding.
 */
function pendingCount(stderr) {
  if (stderr === '') return 0;
  const lines = stderr.trimEnd().split('\n');
  assert.match(lines[0], /^dsh: warning: \d+ entries? did not activate$/, `unexpected first stderr line: ${lines[0]}`);
  for (const line of lines.slice(1)) {
    assert.match(line, /^(.+) \((.+)\): pending \(waiting for service: (.+)\)$/, `unexpected stderr line: ${line}`);
  }
  return Number(/^dsh: warning: (\d+)/.exec(lines[0])[1]);
}

/**
 * Drive one newline-delimited JSON-RPC session against a relocated bundle.
 *
 * Local rather than shared with the boot suite on purpose: this file is the
 * independent check that a moved tree works, and a shared driver would let one
 * defect make both suites report the same wrong thing.
 */
async function bootFrom({ command, args, cwd, env, runtimeManifest, timeoutMs = 120000 }) {
  const child = trackedSpawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const frames = [];
  const pending = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  let failure;

  const exit = new Promise((resolveExit) => {
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
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
      if (waiter === undefined) continue;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { rpcError: frame.error }));
      else waiter.resolve(frame.result);
    }
  });

  function request(method, params = {}) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const answer = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        rejectRequest(new Error(`JSON-RPC ${method} timed out; stderr so far:\n${stderr}`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
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
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(runtimeManifest) && Date.now() < deadline) await sleep(50);
    await request('shutdown');
    const exitResult = await Promise.race([exit, sleep(timeoutMs).then(() => ({ code: 'timeout', signal: null }))]);
    return { initialize, frames, stderr, exit: exitResult, runtimeWritten: existsSync(runtimeManifest) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
  }
}

test('the shipped launch artifacts resolve the bundle root at launch, never at build time', () => {
  const plan = readPlan(ORIGINAL_ROOT);
  const launchDir = join(ORIGINAL_ROOT, 'launch');

  // 1. The plan stores relative paths and says how to resolve them.
  assert.ok(plan.pathConvention !== null && typeof plan.pathConvention === 'object',
    'the launch plan must declare pathConvention (schemaVersion 1.1), otherwise a reader cannot know its paths are relative');
  assert.equal(plan.pathConvention.kind, 'bundle-relative');
  assert.equal(plan.bundleRoot, '.');
  for (const [label, stored] of [
    ['node.executable', plan.node.executable],
    ['worker.entry', plan.worker.entry],
    ['profile.templateDir', plan.profile.templateDir],
    ['profile.templateToolsDir', plan.profile.templateToolsDir],
    ['profile.sourceMirror', plan.profile.sourceMirror],
    ['profile.preparer', plan.profile.preparer],
  ]) {
    assert.equal(isAbsolute(stored), false, `${label} must stay bundle-relative, saw ${stored}`);
    assert.equal(stored.includes('..'), false, `${label} must not climb out of the bundle: ${stored}`);
  }

  // 2. The stub derives the root from its own location, not from a stored string.
  const stub = readFileSync(join(launchDir, 'aegis-harness-worker.cmd'), 'utf8');
  assert.ok(stub.includes('for %%I in ("%~dp0..") do set "AEGIS_BUNDLE_ROOT=%%~fI"'),
    'the stub must resolve the bundle root from %~dp0 at every launch');
  assert.ok(stub.includes('"%NODE_EXE%" "%WORKER_ENTRY%" --profile aegis-analysis'),
    'the stub must launch the bundled runtime and worker entry it just resolved');

  // 3. The preparer does the same with its own module URL.
  const preparer = readFileSync(join(launchDir, 'prepare-attempt.mjs'), 'utf8');
  assert.match(preparer, /const BUNDLE_ROOT = realpathSync\.native\(join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.'\)\)/,
    'the preparer must derive the bundle root from its own import.meta.url');
  assert.equal(/const BUNDLE_ROOT = "/.test(preparer), false, 'the preparer must not carry a literal root');

  // 4. None of the three may name the host that built them: no drive letter, no
  //    UNC prefix, no build directory. The whole-tree byte sweep belongs to
  //    `bundle.test.js` (it already reads all 47 k files once); repeating it here
  //    would double the IO of a suite that copies 430 MiB, so this stays on the
  //    three files that are generated from a path while the sweep guards the rest.
  for (const name of ['launch-plan.json', 'aegis-harness-worker.cmd', 'prepare-attempt.mjs']) {
    const text = readFileSync(join(launchDir, name), 'utf8');
    assert.equal(DRIVE_OR_UNC.test(text), false, `${name} must not contain a drive or UNC path`);
    for (const host of [ORIGINAL_ROOT, REPO_ROOT, process.env.USERPROFILE]) {
      if (typeof host !== 'string' || host.length === 0) continue;
      assert.equal(text.includes(host), false, `${name} must not name ${host}`);
    }
  }
});

test('the stub runs the worker entry next to itself, not a path left over from the build', () => {
  // The relocated-boot test proves a moved bundle starts. On its own that is weak
  // evidence: the original tree is still on disk, so a stub that still pointed at
  // the build machine would start too (this is exactly what the pre-fix bundle
  // does — verified during review). This test isolates the resolution itself with
  // a synthetic sibling layout whose worker entry is a trap that exits 77. Only a
  // stub that resolves `<its own root>/app/node_modules/@aegisharness/
  // harness-worker/bin.js` can reach the trap; a stored path would run the real
  // entry and exit 0.
  const fake = mkdtempSync(join(tmpdir(), 'm8-stub-scope-'));
  try {
    mkdirSync(join(fake, 'launch'), { recursive: true });
    copyFileSync(
      join(ORIGINAL_ROOT, 'launch', 'aegis-harness-worker.cmd'),
      join(fake, 'launch', 'aegis-harness-worker.cmd'),
    );
    // The stub refuses to start without the bundled runtime, so the real one is
    // copied along. It is never executed: the trap entry runs first.
    cpSync(join(ORIGINAL_ROOT, 'runtime'), join(fake, 'runtime'), { recursive: true });
    const entryDir = join(fake, 'app', 'node_modules', '@aegisharness', 'harness-worker');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, 'bin.js'), [
      '// Trap for the launcher scope test: reaching this file proves the stub',
      '// resolved the entry from its own location.',
      "process.stdout.write('AUDIT_TRAP_RAN\\n');",
      'process.exit(77);',
      '',
    ].join('\n'));

    const trap = spawnSync(
      process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      ['/c', join(fake, 'launch', 'aegis-harness-worker.cmd')],
      // A different working directory on purpose: `%~dp0` must do the work, not cwd.
      { encoding: 'utf8', cwd: tmpdir(), env: buildEnvironment() },
    );
    assert.equal(
      trap.status,
      77,
      `the stub did not run the worker entry beside it (exit ${trap.status}; stdout=${JSON.stringify(trap.stdout)}; stderr=${JSON.stringify(trap.stderr)})`,
    );
    assert.match(trap.stdout, /AUDIT_TRAP_RAN/, 'the trap must have produced its marker');
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});

test('a copied bundle renamed to a new directory still verifies its own hash manifest', () => {
  const { root } = ensureRelocated();
  assert.ok(root !== ORIGINAL_ROOT, 'the copy must live somewhere else');
  assert.equal(isAbsolute(root), true);

  // The copy must not carry the original location either: if it did, the boot
  // below would keep loading the original tree and pass for the wrong reason.
  // This is proven by the manifest rather than by a second byte sweep — a tree
  // whose every digest matches a tree that is known to be clean cannot differ
  // from it in any byte, and reading 451 MB twice would only add wall time.
  for (const name of ['launch-plan.json', 'aegis-harness-worker.cmd', 'prepare-attempt.mjs']) {
    const text = readFileSync(join(root, 'launch', name), 'utf8');
    assert.equal(text.includes(ORIGINAL_ROOT), false, `${name} in the copy must not name the original tree`);
    assert.equal(DRIVE_OR_UNC.test(text), false, `${name} in the copy must not contain a drive or UNC path`);
  }

  const rows = verifyHashes(root);
  // The manifest is path-relative, so moving the tree cannot invalidate it. That
  // is the whole reason the shipped paths are stored relative to the bundle root.
  assert.ok(rows > 40000, `expected the full tree, verified ${rows} rows`);
});

test('the moved bundle boots and mounts 21/21 active plugins from its new location', async () => {
  const { root } = ensureRelocated();
  const plan = readPlan(root);
  const nodeExe = fromBundle(root, plan.node.executable, 'node.executable');
  const workerEntry = fromBundle(root, plan.worker.entry, 'worker.entry');
  const preparer = fromBundle(root, plan.profile.preparer, 'profile.preparer');
  const sourceMirror = fromBundle(root, plan.profile.sourceMirror, 'profile.sourceMirror');

  const policy = JSON.parse(readFileSync(join(sourceMirror, 'profile.json'), 'utf8'));
  const neutralRoot = policy.effectiveConfig.analysisCwdRoots[process.platform];
  const attemptRoot = join(neutralRoot, `m8-portability-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);

  try {
    // The shipped preparer, executed by the copied runtime, at the new location.
    const prepared = spawnSync(nodeExe, [preparer, '--root', attemptRoot], { encoding: 'utf8', env: buildEnvironment() });
    assert.equal(prepared.status, 0, `the relocated preparer failed:\n${prepared.stderr}`);
    const attempt = JSON.parse(prepared.stdout);
    assert.equal(attempt.root, attemptRoot);
    for (const key of ['home', 'tmp', 'cwd', 'session', 'dshHome', 'profileDir', 'toolsDir']) {
      assert.ok(attempt[key].startsWith(attemptRoot), `${key} must stay inside the attempt root`);
    }
    // The template it copied from must be the copy's, not the original's.
    assert.ok(attempt.profileDir.startsWith(attemptRoot), 'the attempt profile must be attempt-scoped');

    const tripwireLog = join(attemptRoot, 'session', 'net.log');
    const moduleTraceLog = join(attemptRoot, 'session', 'modules.log');
    const result = await bootFrom({
      command: nodeExe,
      args: [workerEntry, ...plan.worker.argv],
      cwd: attempt.cwd,
      env: buildEnvironment({
        ...attempt.env,
        DSH_HOME: attempt.dshHome,
        AEGIS_RUNTIME_MANIFEST: attempt.env.AEGIS_RUNTIME_MANIFEST,
        NODE_OPTIONS: `--import ${pathToFileURL(TRIPWIRE).href} --import ${pathToFileURL(MODULE_TRACE).href}`,
        M8_TRIPWIRE_LOG: tripwireLog,
        M8_MODULE_TRACE: moduleTraceLog,
      }),
      runtimeManifest: attempt.env.AEGIS_RUNTIME_MANIFEST,
    });

    assert.equal(result.initialize.serverInfo.name, 'deepseek-harness-sdk-runtime');
    assert.deepEqual(result.exit, { code: 0, signal: null }, 'the relocated bundle must shut down cleanly');
    assert.equal(result.frames.length, 2, `unexpected stdout frames: ${JSON.stringify(result.frames)}`);
    assert.ok(result.runtimeWritten, 'the relocated bundle must still write its live runtime manifest');

    const runtime = JSON.parse(readFileSync(attempt.env.AEGIS_RUNTIME_MANIFEST, 'utf8'));
    assert.equal(runtime.captureError, undefined, `runtime capture failed: ${runtime.captureError}`);
    const entries = runtime.plugins.entries;
    // 20 reviewed plugins plus the loader's own `include` root: 21 entries, all of
    // them active. This is the number the hand-off reports, so it is asserted by
    // value as well as by shape.
    assert.equal(entries.length, 21, `expected 21 mounted entries, saw ${entries.length}`);
    assert.equal(entries.length, policy.allowedPluginIds.length + 1);
    assert.deepEqual(
      entries.filter((entry) => entry.state !== 'active').map((entry) => [entry.id, entry.state, entry.missingServices]),
      [],
      'every mounted plugin must be active in a relocated bundle',
    );
    assert.deepEqual([...runtime.model.tools].map((tool) => tool.name).sort(), EXPECTED_TOOLS);

    // The decisive assertion: what Node actually loaded came from the copy. The
    // original tree is still on disk, so a residual absolute path would work and
    // stay invisible without this check.
    assert.ok(existsSync(moduleTraceLog), 'the module tracer produced no log');
    const traced = readFileSync(moduleTraceLog, 'utf8').split('\n').filter((line) => line.length > 0);
    assert.equal(traced.filter((line) => line.startsWith('<tracer-armed>')).length, 1,
      'the tracer must prove it was armed, otherwise the trace proves nothing');
    const loaded = traced.filter((line) => !line.startsWith('<tracer-armed>') && isAbsolute(line));
    assert.ok(loaded.length > 300, `the trace is too small to be a boot: ${loaded.length} modules`);
    const fromOriginal = loaded.filter((line) => line.startsWith(ORIGINAL_ROOT));
    assert.deepEqual(fromOriginal.slice(0, 5), [], 'the relocated bundle loaded modules from the original tree');
    // Two trees are legitimate: the copy itself, and the attempt-scoped environment
    // the preparer materialised (its own profile copy, and the native cache the
    // addon loader extracts into the attempt's temp). Anything else means the boot
    // reached back to a fixed path.
    const outside = loaded.filter((line) => !line.startsWith(root) && !line.startsWith(attemptRoot));
    assert.deepEqual(outside.slice(0, 5), [], 'the relocated bundle loaded modules from outside the copy and the attempt tree');
    assert.ok(loaded.some((line) => line.startsWith(root)),
      'the trace must show the copy being used, otherwise "it booted" says nothing about the copy');
    assert.ok(loaded.some((line) => line === join(root, 'app', 'node_modules', '@aegisharness', 'harness-worker', 'bin.js'))
      || loaded.some((line) => line.startsWith(join(root, 'app', 'node_modules', '@aegisharness', 'harness-worker'))),
    'the worker entry that ran must be the copy\'s');

    // Boot still attempts no connection, same contract as the in-place suite.
    const netRecords = readFileSync(tripwireLog, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    assert.equal(netRecords.filter((entry) => entry.kind === 'armed').length, 1, 'the tripwire must prove it was armed');
    assert.deepEqual(netRecords.filter((entry) => entry.kind !== 'armed' && entry.kind !== 'net.allowed'), [],
      'the relocated boot must not attempt any outbound connection');
    assert.equal(pendingCount(result.stderr), entries.filter((entry) => entry.state !== 'active').length);

    // And the shipped stub, from the new directory, in a different working directory.
    const stubAttempt = join(neutralRoot, `m8-portability-stub-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
    try {
      const stubPrepared = spawnSync(nodeExe, [preparer, '--root', stubAttempt], { encoding: 'utf8', env: buildEnvironment() });
      assert.equal(stubPrepared.status, 0, `the relocated preparer failed for the stub run: ${stubPrepared.stderr}`);
      const stubEnv = JSON.parse(stubPrepared.stdout);
      const viaStub = await bootFrom({
        command: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        args: ['/c', join(root, 'launch', 'aegis-harness-worker.cmd')],
        cwd: stubEnv.cwd,
        env: buildEnvironment({ ...stubEnv.env, DSH_HOME: stubEnv.dshHome }),
        runtimeManifest: stubEnv.env.AEGIS_RUNTIME_MANIFEST,
      });
      assert.equal(viaStub.initialize.serverInfo.name, 'deepseek-harness-sdk-runtime',
        `the moved stub must launch the moved bundle; stderr:\n${viaStub.stderr}`);
      assert.deepEqual(viaStub.exit, { code: 0, signal: null }, `the moved stub must exit cleanly; stderr:\n${viaStub.stderr}`);
      pendingCount(viaStub.stderr);
    } finally {
      rmSync(stubAttempt, { recursive: true, force: true });
    }
  } finally {
    rmSync(attemptRoot, { recursive: true, force: true });
  }
});
