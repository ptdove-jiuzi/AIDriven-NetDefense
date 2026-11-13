/**
 * Independent re-verification of the uninstaller's ownership gate.
 *
 * This file was written from scratch in a **separate context** from the one that
 * implemented the gate (`deploy/windows/installer/app/aidn/install.py`). It does not
 * import, copy or trust that session's test file; it drives the real process
 *
 *     python main.py /uninstall /DIR=<fixture> /NOREG
 *
 * against three fixture directories and asserts, per case, the FULL contract:
 *
 *   1. exit code is exactly 5 (EXIT_TARGET_INVALID, the "you pointed me at the wrong
 *      directory" code — not the generic failure code),
 *   2. the sentinel file that lives next to the install-looking files still exists,
 *   3. **every** other file is still there, with the same sha256 as before (a refusal
 *      that deletes one file is a data-loss bug, not a pass),
 *   4. the refusal reason is present on stderr AND in the installer log (the log is
 *      what a user sees in a windowed build; stderr is what automation sees),
 *   5. the run never reached the stop/delete steps: a live process whose image sits
 *      inside the target is still alive afterwards, and the log has no "Stopping
 *      running programs" / "Deleting program files" step.
 *
 * The cases:
 *   (a) a directory with `install/install.json` whose `product` is not this product,
 *   (b) half-set trees: `install/` without `install.json`, and a record carrying only
 *       a product name,
 *   (c) a directory link (real symlink when the token allows it, junction otherwise)
 *       pointing at a tree that *does* look like a genuine install.
 *
 * One control case keeps the suite honest in the other direction: a genuine, fully
 * recorded install tree must still be uninstalled (exit 0, tree gone). Without it a
 * gate that refuses everything would look "green". Since RC5-N01 "genuine" includes the
 * installer-issued `install.json.ownership` credential for that exact path — the check
 * that a copied tree or a self-consistent forged record cannot pass.
 *
 * Everything is redirected: TEMP/TMP (the installer log), the Start Menu folder, the
 * desktop folder and the default target are all under `os.tmpdir()`; `/NOREG` stops
 * the registry write. The fixture directories are deleted at exit.
 *
 * Evidence: when `AIDN_REVERIFY_EVIDENCE_DIR` (or the repo default) is writable, the
 * runner drops a per-case JSON observation file plus the raw stdout/stderr/log of every
 * installer run under `<evidence>/runs/<run-id>/`. That is the raw output the report
 * quotes; nothing is inferred from memory.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { withOwnership } from './fixtures/ownership.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const INSTALLER_APP = join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const EXIT_TARGET_INVALID = 5;

/** Where the raw evidence goes (overridable so a CI box can point elsewhere). */
const EVIDENCE_ROOT =
  process.env.AIDN_REVERIFY_EVIDENCE_DIR ??
  join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'runtime', 'uninstall');
const RUN_ID = process.env.AIDN_REVERIFY_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');
const RAW_DIR = join(EVIDENCE_ROOT, 'runs', RUN_ID);

/** Interpreters to try, in order; `AIDN_PYTHON` wins so the harness can pin one. */
const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);

function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import json, sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}

const PYTHON = pickPython();
const SKIP = PYTHON === undefined ? 'no Python interpreter found' : false;
const testWithPython = (name, fn) => test(name, { skip: SKIP }, fn);

const SCRATCH = [];
const OBSERVATIONS = [];

function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), `aidn-reverify-${prefix}-`));
  SCRATCH.push(path);
  return path;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Recursive `{relativePath: {sha256, bytes}}` snapshot — the "not one file changed" proof. */
function snapshotTree(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files[relative(root, absolute).replaceAll('\\', '/')] = {
        sha256: sha256(absolute),
        bytes: statSync(absolute).size,
      };
    }
  };
  walk(root);
  return files;
}

function write(path, contents) {
  ensureDir(dirname(path));
  writeFileSync(path, contents, 'utf8');
}

// --------------------------------------------------------------------- installer run

/**
 * Run the real uninstaller against *target*.
 *
 * `TEMP`/`TMP` are redirected so the run's log file is isolated per invocation and the
 * Start Menu / desktop folders are redirected so nothing outside the scratch dir is
 * touched. The absolute path of the scratch run dir is recorded in the evidence too.
 */
function runUninstall(caseId, target) {
  const work = scratch('run');
  const logDir = join(work, 'temp');
  ensureDir(logDir);
  ensureDir(join(work, 'default'));
  const env = {
    ...process.env,
    TEMP: logDir,
    TMP: logDir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    AIDN_SETUP_STARTMENU_DIR: join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: join(work, 'desktop'),
    AIDN_SETUP_DEFAULT_DIR: join(work, 'default'),
  };
  const argv = [join(INSTALLER_APP, 'main.py'), '/uninstall', `/DIR=${target}`, '/NOREG'];
  const startedAt = new Date().toISOString();
  const result = spawnSync(PYTHON, argv, {
    encoding: 'utf8',
    timeout: 180_000,
    cwd: INSTALLER_APP,
    env,
    windowsHide: true,
  });
  const logNames = readdirSync(logDir)
    .filter((name) => name.startsWith('AIDriven-Setup-') && name.endsWith('.log'))
    .sort((a, b) => statSync(join(logDir, b)).mtimeMs - statSync(join(logDir, a)).mtimeMs);
  const logName = logNames[0] ?? '';
  const logText = logName ? readFileSync(join(logDir, logName), 'utf8') : '';

  ensureDir(RAW_DIR);
  writeFileSync(join(RAW_DIR, `${caseId}.stdout.txt`), result.stdout ?? '', 'utf8');
  writeFileSync(join(RAW_DIR, `${caseId}.stderr.txt`), result.stderr ?? '', 'utf8');
  writeFileSync(join(RAW_DIR, `${caseId}.installer.log.txt`), logText, 'utf8');
  writeFileSync(
    join(RAW_DIR, `${caseId}.command.txt`),
    [
      `started_at=${startedAt}`,
      `cwd=${INSTALLER_APP}`,
      `argv0=${PYTHON}`,
      `argv=${JSON.stringify(argv)}`,
      `TEMP=${logDir}`,
      `AIDN_SETUP_STARTMENU_DIR=${env.AIDN_SETUP_STARTMENU_DIR}`,
      `AIDN_SETUP_DESKTOP_DIR=${env.AIDN_SETUP_DESKTOP_DIR}`,
      `AIDN_SETUP_DEFAULT_DIR=${env.AIDN_SETUP_DEFAULT_DIR}`,
      `install_py_sha256_at_run_end=${installedSourceHash()}`,
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    code: result.status,
    signal: result.signal ?? null,
    error: result.error ? String(result.error) : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    logText,
    logName,
    argv,
    workDir: work,
    tempDir: logDir,
  };
}

function installedSourceHash() {
  try {
    return sha256(join(INSTALLER_APP, 'aidn', 'install.py'));
  } catch {
    return '(unreadable)';
  }
}

// ------------------------------------------------------------------ process evidence

const SYSTEM_CMD = 'C:\\Windows\\System32\\cmd.exe';

/** Is *pid* a live process? (signal 0 existence probe, no side effect on Windows.) */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Full image path of *pid* as the OS reports it, or '' when unavailable. */
function imagePath(pid) {
  const query = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  return (query.stdout ?? '').trim();
}

function killProcessTree(pid) {
  if (!pidAlive(pid)) return;
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && pidAlive(pid)) sleep(100);
}

/**
 * Start a long-lived process whose image lives inside *directory*.
 *
 * This is the empirical "the refusal happened before the stop step" probe: the
 * uninstaller stops every process whose image is under the target, so if the gate ever
 * ran after `procs.stop_under()` this process would be dead after a refused run.
 * `cmd.exe` is copied in because its DLLs resolve from System32/KnownDLLs, so a copy
 * runs fine from any directory.
 */
function startProbeProcess(directory) {
  const exe = join(directory, 'reverify-probe-cmd.exe');
  copyFileSync(SYSTEM_CMD, exe);
  const child = spawn(exe, ['/c', 'ping -n 120 127.0.0.1 >nul'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  // Never let a stuck probe keep the test runner alive; we prove liveness via pidAlive.
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pidAlive(child.pid)) return { pid: child.pid, exe, child };
    sleep(100);
  }
  throw new Error(`probe process did not start (${exe})`);
}

function stopProbe(probe) {
  if (!probe) return;
  killProcessTree(probe.pid);
  try {
    probe.child.kill('SIGKILL');
  } catch {
    // already gone
  }
}

// ------------------------------------------------------------------ fixtures

/** An `install/install.json` written exactly the way `install()` writes it. */
function writeInstallRecord(target, overrides = {}) {
  const record = {
    product: 'AIDriven NetDefense',
    version: '0.0.1-rc.3',
    installPath: target,
    installedAt: '2026-11-04T20:00:00+08:00',
    desktopExe: 'AIDrivenNetDefense.exe',
    entryKind: 'exe',
    autostart: false,
    upgradedFrom: null,
    channel: 'installed',
    ...overrides,
  };
  write(join(target, 'install', 'install.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * A tree a real install left behind: program files, a valid record **and** the payload
 * hash manifest matching those bytes, plus the RC5-N01 ownership credential. The
 * manifest matters: since R6-004 the uninstaller refuses a tree whose record is not
 * backed by payload bytes it can verify. The credential matters since RC5-N01: a record
 * that only agrees with itself is what an attacker can write, so the delete is
 * authorized by the installer-issued HMAC bound to this canonical path.
 */
function createGenuineInstallTree(target) {
  ensureDir(join(target, 'runtime', 'node'));
  write(join(target, 'runtime', 'node', 'node.exe'), 'fixture runtime placeholder\n');
  write(join(target, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  write(join(target, 'rules', 'defense-seed-pack.json'), '{"rules":[]}\n');
  const relativePaths = ['AIDrivenNetDefense.exe', 'runtime/node/node.exe', 'rules/defense-seed-pack.json'];
  const rows = [
    '# AegisHarness embedded runtime bundle - SHA-256 manifest',
    '',
    ...relativePaths.map((relative) => {
      const digest = createHash('sha256').update(readFileSync(join(target, relative))).digest('hex');
      return `${digest}  ${relative}`;
    }),
    '',
  ];
  write(join(target, 'manifests', 'files.sha256'), rows.join('\n'));
  writeInstallRecord(target);
  withOwnership(target, { channel: 'installed', version: '0.0.1-rc.3' });
}

function plantSentinel(root, name = 'USER-DATA-keep-me.txt') {
  const path = join(root, name);
  write(path, 'sentinel: this user file must survive a refused uninstall\n');
  return path;
}

/**
 * Create a directory link at *link* pointing at *real*.
 *
 * A real symlink needs SeCreateSymbolicLinkPrivilege; a junction does not. Both are
 * tried, and the fallback is recorded rather than hidden (see the evidence JSON).
 */
function linkDirectory(real, link) {
  try {
    symlinkSync(real, link, 'dir');
    return { kind: 'symlink', fallback: false, attempts: ['symlink:ok'] };
  } catch (error) {
    const first = `${error.code ?? error.name}: ${String(error.message).split('\n')[0]}`;
    symlinkSync(real, link, 'junction');
    return { kind: 'junction', fallback: true, attempts: [first, 'junction:ok'] };
  }
}

// ------------------------------------------------------------------ observation sink

function recordObservation(observation) {
  OBSERVATIONS.push(observation);
}

after(() => {
  try {
    ensureDir(RAW_DIR);
    writeFileSync(
      join(RAW_DIR, 'observations.json'),
      `${JSON.stringify(
        {
          suite: 'uninstall-ownership-reverify',
          runId: RUN_ID,
          generatedAt: new Date().toISOString(),
          node: process.version,
          python: PYTHON ?? null,
          installPySha256AtEnd: installedSourceHash(),
          observations: OBSERVATIONS,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (error) {
    // Evidence is not a test result; a read-only checkout must not turn green into red.
    console.error(`could not write observations.json: ${error}`);
  }
  for (const path of SCRATCH) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover scratch directory is not a test result.
    }
  }
});

// ------------------------------------------------------------------ the suite

testWithPython('control: a genuine, fully recorded install tree is still uninstalled', () => {
  const target = join(scratch('control'), 'AIDriven NetDefense');
  createGenuineInstallTree(target);
  const before = snapshotTree(target);

  const run = runUninstall('control', target);
  const observation = {
    case: 'control',
    target,
    exitCode: run.code,
    refusalText: '',
    beforeFileCount: Object.keys(before).length,
    afterExists: existsSync(target),
    command: run.argv.join(' '),
  };
  recordObservation(observation);

  assert.equal(run.code, 0, `a genuine install must still be removable; got ${run.code}\n${run.logText}\n${run.stderr}`);
  assert.equal(existsSync(target), false, 'the accepted install tree was not removed');
});

testWithPython('(a) install.json with a foreign product is refused: exit 5, sentinel and every file intact', () => {
  const target = join(scratch('case-a'), 'my-notes');
  // Plausible record, right path, right channel — only the product name is foreign.
  write(
    join(target, 'install', 'install.json'),
    `${JSON.stringify(
      {
        product: 'Some Other App',
        version: '9.9.9',
        installPath: target,
        channel: 'installed',
      },
      null,
      2,
    )}\n`,
  );
  write(join(target, 'notes.txt'), 'irreplaceable notes\n');
  write(join(target, 'sub', 'draft.md'), 'a draft\n');
  const sentinel = plantSentinel(target);
  const probe = startProbeProcess(target);
  const probeImage = imagePath(probe.pid);
  const before = snapshotTree(target);
  try {
    const run = runUninstall('case-a', target);
    const after = existsSync(target) ? snapshotTree(target) : {};
    recordObservation({
      case: 'a',
      target,
      exitCode: run.code,
      stderrHasRefusal: run.stderr.includes('卸载被拒'),
      stdoutHasRefusal: run.stdout.includes('卸载被拒'),
      sentinel,
      sentinelExists: existsSync(sentinel),
      before,
      after,
      filesUnchanged: JSON.stringify(before) === JSON.stringify(after),
      probePid: probe.pid,
      probeImage,
      probeImageUnderTarget: probeImage.toLowerCase().startsWith(target.toLowerCase()),
      probeAliveAfter: pidAlive(probe.pid),
      logHasStopStep: /停止正在运行的程序/u.test(run.logText),
      logHasDeleteStep: /删除程序文件/u.test(run.logText),
      logHasCompletion: /卸载完成/u.test(run.logText),
      logText: run.logText,
      stderr: run.stderr,
      stdout: run.stdout,
    });

    assert.equal(run.code, EXIT_TARGET_INVALID, `expected exit ${EXIT_TARGET_INVALID}, got ${run.code}\n${run.logText}\n${run.stderr}`);
    assert.ok(existsSync(sentinel), 'the sentinel file was deleted by a refused uninstall');
    assert.deepEqual(after, before, 'a refused uninstall changed the directory');
    assert.match(run.stderr, /卸载被拒/u, 'the refusal reason must reach stderr');
    assert.match(run.stderr, /product/u, 'the refusal reason must say the product identity did not match');
    assert.match(run.logText, /install\\install\.json 存在/u, 'the log must name the marker that was inspected');
    assert.ok(!/停止正在运行的程序/u.test(run.logText), 'the refusal happened before the stop step');
    assert.ok(!/删除程序文件/u.test(run.logText), 'the refusal happened before the delete step');
    assert.ok(!/卸载完成/u.test(run.logText), 'a refused run must not report completion');
    assert.equal(probeImage.toLowerCase(), probe.exe.toLowerCase(), `probe image path was not inside the target: ${probeImage}`);
    assert.ok(pidAlive(probe.pid), 'the refusal happened after the stop step: the probe process was killed');
  } finally {
    stopProbe(probe);
  }
});

testWithPython('(b) half-set trees (no record / thin record) are refused: exit 5, nothing deleted', () => {
  /** Run one half-set fixture and return its observation. */
  const verify = (caseId, target, extra) => {
    const sentinel = plantSentinel(target);
    const probe = startProbeProcess(target);
    const probeImage = imagePath(probe.pid);
    const before = snapshotTree(target);
    try {
      const run = runUninstall(caseId, target);
      const after = existsSync(target) ? snapshotTree(target) : {};
      const observation = {
        case: 'b',
        variant: caseId,
        target,
        exitCode: run.code,
        sentinel,
        sentinelExists: existsSync(sentinel),
        before,
        after,
        filesUnchanged: JSON.stringify(before) === JSON.stringify(after),
        probePid: probe.pid,
        probeImage,
        probeAliveAfter: pidAlive(probe.pid),
        logHasStopStep: /停止正在运行的程序/u.test(run.logText),
        logHasDeleteStep: /删除程序文件/u.test(run.logText),
        logHasCompletion: /卸载完成/u.test(run.logText),
        logText: run.logText,
        stderr: run.stderr,
        stdout: run.stdout,
        ...extra,
      };
      recordObservation(observation);
      return { run, observation };
    } finally {
      stopProbe(probe);
    }
  };

  // b1: `install/` exists but there is no install.json at all.
  const b1 = join(scratch('case-b1'), 'AIDriven NetDefense');
  ensureDir(join(b1, 'install'));
  write(join(b1, 'install', 'uninstall.json'), '{"note":"no record here"}\n');
  write(join(b1, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  const one = verify('case-b1', b1, { subcase: 'install/ without install.json' });

  assert.equal(one.run.code, EXIT_TARGET_INVALID, `(b1) expected exit ${EXIT_TARGET_INVALID}, got ${one.run.code}\n${one.run.logText}`);
  assert.ok(existsSync(one.observation.sentinel), '(b1) sentinel deleted by a refused uninstall');
  assert.deepEqual(one.observation.after, one.observation.before, '(b1) a refused uninstall changed the directory');
  assert.match(one.run.stderr, /没有任何安装标记/u, '(b1) the reason must state that no install marker exists');
  assert.ok(!one.observation.logHasStopStep, '(b1) refusal happened after the stop step');
  assert.ok(!one.observation.logHasDeleteStep, '(b1) refusal happened after the delete step');
  assert.ok(one.observation.probeAliveAfter, '(b1) the refusal happened after the stop step: probe was killed');

  // b2: install.json carries only a product name — no version/path/channel identity.
  const b2 = join(scratch('case-b2'), 'thin');
  ensureDir(join(b2, 'install'));
  write(join(b2, 'install', 'install.json'), `${JSON.stringify({ product: 'AIDriven NetDefense' })}\n`);
  const two = verify('case-b2', b2, { subcase: 'install.json with only a product field' });

  assert.equal(two.run.code, EXIT_TARGET_INVALID, `(b2) expected exit ${EXIT_TARGET_INVALID}, got ${two.run.code}\n${two.run.logText}`);
  assert.ok(existsSync(two.observation.sentinel), '(b2) sentinel deleted by a refused uninstall');
  assert.deepEqual(two.observation.after, two.observation.before, '(b2) a refused uninstall changed the directory');
  assert.match(two.run.stderr, /卸载被拒/u, '(b2) the refusal reason must reach stderr');
  assert.ok(two.observation.probeAliveAfter, '(b2) the refusal happened after the stop step: probe was killed');
});

testWithPython('(c) a symlink/junction to an install-looking tree is refused: exit 5, real tree intact', () => {
  const root = scratch('case-c');
  const real = join(root, 'real-install-tree');
  createGenuineInstallTree(real);
  const sentinel = plantSentinel(real);
  const probe = startProbeProcess(real);
  const probeImage = imagePath(probe.pid);
  const before = snapshotTree(real);

  const link = join(root, 'linked-install-tree');
  const linkInfo = linkDirectory(real, link);
  try {
    assert.ok(existsSync(link), `could not create a directory link (${linkInfo.kind})`);

    const run = runUninstall('case-c', link);
    const realStillThere = existsSync(real);
    const after = realStillThere ? snapshotTree(real) : {};
    recordObservation({
      case: 'c',
      link,
      real,
      linkKind: linkInfo.kind,
      symlinkFallbackToJunction: linkInfo.fallback,
      linkAttempts: linkInfo.attempts,
      exitCode: run.code,
      sentinel,
      sentinelExists: existsSync(sentinel),
      realStillThere,
      before,
      after,
      filesUnchanged: JSON.stringify(before) === JSON.stringify(after),
      logMentionsResolvedRealPath: run.logText.toLowerCase().includes(real.toLowerCase()),
      stderrMentionsResolvedRealPath: run.stderr.toLowerCase().includes(real.toLowerCase()),
      probePid: probe.pid,
      probeImage,
      probeAliveAfter: pidAlive(probe.pid),
      logHasStopStep: /停止正在运行的程序/u.test(run.logText),
      logHasDeleteStep: /删除程序文件/u.test(run.logText),
      logHasCompletion: /卸载完成/u.test(run.logText),
      logText: run.logText,
      stderr: run.stderr,
      stdout: run.stdout,
    });

    assert.equal(
      run.code,
      EXIT_TARGET_INVALID,
      `expected exit ${EXIT_TARGET_INVALID} for a ${linkInfo.kind}, got ${run.code}\n${run.logText}\n${run.stderr}`,
    );
    assert.ok(existsSync(sentinel), 'the uninstaller deleted files through the link');
    assert.ok(realStillThere, 'the uninstaller deleted the real directory behind the link');
    assert.deepEqual(after, before, 'a refused uninstall changed the real tree behind the link');
    assert.ok(
      run.logText.toLowerCase().includes(real.toLowerCase()),
      `the refusal must log the resolved real path (${real})\n${run.logText}`,
    );
    assert.ok(
      run.stderr.toLowerCase().includes(real.toLowerCase()),
      `the refusal on stderr must name the resolved real path (${real})\n${run.stderr}`,
    );
    assert.match(run.stderr, /符号链接|联接|junction/u, 'the reason must say the target is a link');
    assert.ok(!/停止正在运行的程序/u.test(run.logText), 'the refusal happened before the stop step');
    assert.ok(!/删除程序文件/u.test(run.logText), 'the refusal happened before the delete step');
    assert.ok(!/卸载完成/u.test(run.logText), 'a refused run must not report completion');
    assert.ok(pidAlive(probe.pid), 'the refusal happened after the stop step: probe was killed');
  } finally {
    stopProbe(probe);
  }
});
