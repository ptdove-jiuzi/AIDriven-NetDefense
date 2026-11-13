/**
 * RC5-N01 (P1): the uninstall gate must be anchored to a credential *only the
 * installer can produce*, not to "this directory looks like one of ours".
 *
 * Re-attack RC4 (reviews/REATTACK-RC4.md §2.2/§2.3) showed that the previous criterion
 * was self-certifying: an attacker who can write inside the target directory writes a
 * full-field `install/install.json` plus a self-consistent `manifests/files.sha256`
 * (three arbitrary files, their real digests) and *both* channels then recursively delete
 * the whole tree (py-16/py-17/ps-14/ps-15 all BYPASSED).  "the hashes match the files"
 * proves consistency, not ownership.
 *
 * The credential (contract shared byte-for-byte by the Python and PowerShell channels):
 *
 *     key      : 32-byte constant compiled into the installer (Python module + Setup.ps1)
 *     message  : "aidn-ownership-v1" \n product \n channel \n version \n
 *                canonical target path \n installId \n payloadDigest
 *     token    : HMAC-SHA256(key, message) as lowercase hex
 *     record   : "ownership": {scheme, installId, payloadDigest, token}
 *
 * Uninstall recomputes the token with the path it is about to delete and compares in
 * constant time; it also requires the recorded `payloadDigest` to equal the digest of the
 * manifest on disk.  A copied tree therefore fails (path binding), a tree whose
 * credential is missing/edited fails, and a `bundle.json` + manifest payload without an
 * `install.json` no longer authorises a recursive delete at all.
 *
 * Every refusal asserts the stronger property the reviews asked for: exit 5 (or a PS
 * throw), refusal text on stderr/log, and the tree **byte-identical** afterwards.
 *
 * Evidence layout (this file writes nothing outside %TEMP%): see
 * docs/implementation/evidence/rc5/n01/.  Run with
 *   node --test tests/installer/rc5-ownership-credential.test.js
 * `AIDN_INSTALLER_APP` / `AIDN_SETUP_PS1` point the suite at a mutant copy for the
 * mutation runs; the repository files are never edited by this test.
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const INSTALLER_APP = process.env.AIDN_INSTALLER_APP
  ? resolve(process.env.AIDN_INSTALLER_APP)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const SETUP_PS1 = process.env.AIDN_SETUP_PS1
  ? resolve(process.env.AIDN_SETUP_PS1)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'Setup.ps1');
const INSTALL_FIXTURE = join(HERE, 'fixtures', 'install-fixture.py');
const PS_FIXTURE = join(HERE, 'fixtures', 'ps1-rc5-ownership.ps1');
const EXIT_TARGET_INVALID = 5;
const EXIT_OK = 0;

// ------------------------------------------------------------------ interpreters

const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);
function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}
const PYTHON = pickPython();
const TEST_WITH_PYTHON = (name, fn, options = {}) =>
  test(
    name,
    {
      ...options,
      skip: options.skip || (PYTHON === undefined ? 'no Python interpreter found' : false),
    },
    fn,
  );

/** Windows PowerShell 5.1 is what Setup.cmd uses; pwsh is the fallback. */
function pickPowerShell() {
  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh',
  ];
  for (const candidate of candidates) {
    if (candidate.includes('\\') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}
const POWERSHELL = process.platform === 'win32' ? pickPowerShell() : undefined;
const PS_SKIP = process.platform !== 'win32'
  ? 'the PowerShell installer is Windows-only'
  : (POWERSHELL ? false : 'no PowerShell interpreter found');
const TEST_WITH_PS = (name, fn) => test(name, { skip: PS_SKIP }, fn);

// ------------------------------------------------------------------ scratch helpers

const SCRATCH = [];
function scratch(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `aidn-rc5n01-${prefix}-`));
  SCRATCH.push(directory);
  return directory;
}
process.on('exit', () => {
  for (const directory of SCRATCH) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A leftover temp directory is not a test result.
    }
  }
});

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
/** PS 5.1's `Set-Content -Encoding UTF8` writes a BOM; read records tolerantly. */
function readJsonFile(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/u, '');
  return JSON.parse(text);
}
function writeJsonFile(path, value) {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `{relativePath: sha256}` for every file under *root* — the "byte-identical" proof. */
function snapshotTree(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files[relative(root, absolute).replaceAll('\\', '/')] = sha256File(absolute);
    }
  };
  walk(root);
  return files;
}

function plantSentinel(target, name = 'user-data-must-survive.txt') {
  const path = join(target, name);
  write(path, 'irreplaceable user file; a refused uninstall must not touch it\n');
  return path;
}

// ------------------------------------------------------------------ fixtures

/** Payload-shaped files; a real digest row for each one. */
const PAYLOAD_FILES = [
  ['AIDrivenNetDefense.exe', 'MZ fixture shell\n'],
  ['runtime/node/node.exe', 'fixture runtime placeholder\n'],
  ['console/index.html', '<!doctype html><title>fixture</title>\n'],
  ['rules/defense-seed-pack.json', '{"rules":[]}\n'],
];

function createPayloadDir(root) {
  for (const [relativePath, contents] of PAYLOAD_FILES) write(join(root, relativePath), contents);
  const rows = [
    '# AegisHarness embedded runtime bundle - SHA-256 manifest',
    '',
    ...PAYLOAD_FILES.map(([relativePath]) => `${sha256File(join(root, relativePath))}  ${relativePath}`),
    '',
  ];
  write(join(root, 'manifests', 'files.sha256'), rows.join('\n'));
  writeJsonFile(join(root, 'bundle.json'), {
    schemaVersion: '1.0',
    author: 'PT-dove',
    kind: 'v14-desktop',
    builtAt: '2026-11-05T00:00:00.000Z',
    product: 'AIDriven NetDefense',
    version: '0.0.1-rc.5',
    assets: {
      desktop: {
        target: 'AIDrivenNetDefense.exe',
        bytes: statSync(join(root, 'AIDrivenNetDefense.exe')).size,
        sha256: sha256File(join(root, 'AIDrivenNetDefense.exe')),
      },
    },
  });
  return root;
}

/** A full-field forged record: every identity field of a real install, right path. */
function writeInstallRecord(target, overrides = {}) {
  const record = {
    product: 'AIDriven NetDefense',
    version: '0.0.1-rc.5',
    installPath: target,
    installedAt: '2026-11-05T00:00:00+08:00',
    desktopExe: 'AIDrivenNetDefense.exe',
    entryKind: 'exe',
    autostart: false,
    upgradedFrom: null,
    channel: 'installed',
    ...overrides,
  };
  writeJsonFile(join(target, 'install', 'install.json'), record);
  return record;
}

/** Run the real installer's install() against a fixture payload; returns its record. */
function installWithPythonInstaller(target) {
  const payloadDir = createPayloadDir(join(scratch('payload'), 'payload'));
  const work = scratch('install-run');
  const env = {
    ...process.env,
    TEMP: join(work, 'temp'),
    TMP: join(work, 'temp'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    AIDN_SETUP_STARTMENU_DIR: join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: join(work, 'desktop'),
    AIDN_SETUP_DEFAULT_DIR: join(work, 'default'),
  };
  mkdirSync(env.TEMP, { recursive: true });
  const result = spawnSync(PYTHON, [INSTALL_FIXTURE, INSTALLER_APP, target, payloadDir], {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const line = String(result.stdout ?? '')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  assert.ok(line, `the install fixture produced no result (exit ${result.status}):\n${output}`);
  const parsed = JSON.parse(line);
  assert.equal(parsed.ok, true, `the installer refused to build the fixture tree:\n${JSON.stringify(parsed)}\n${output}`);
  return parsed.record;
}

/** Run the real Python uninstaller (`python main.py /uninstall /DIR=… /NOREG`). */
function runPythonUninstall(target) {
  const work = scratch('uninstall-run');
  const logDir = join(work, 'temp');
  mkdirSync(logDir, { recursive: true });
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
  delete env.PSModulePath;
  const result = spawnSync(
    PYTHON,
    [join(INSTALLER_APP, 'main.py'), '/uninstall', `/DIR=${target}`, '/NOREG'],
    { encoding: 'utf8', timeout: 180_000, cwd: work, env, windowsHide: true },
  );
  const logs = readdirSync(logDir).filter((name) => name.startsWith('AIDriven-Setup-') && name.endsWith('.log'));
  const log = logs.length > 0 ? readFileSync(join(logDir, logs[0]), 'utf8') : '';
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    log,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${log}`,
  };
}

/** A refused Python uninstall: exit 5, refusal reported, and not one byte changed. */
function assertPythonRefused(target, before, run, { requireCredentialText = true } = {}) {
  assert.equal(
    run.code,
    EXIT_TARGET_INVALID,
    `expected exit ${EXIT_TARGET_INVALID} (UninstallRefused), got ${run.code}:\n${run.output}`,
  );
  assert.match(run.output, /卸载被拒/u, 'the refusal must be reported as a refusal');
  if (requireCredentialText) {
    assert.match(
      run.output,
      /归属凭据|ownership/iu,
      `the refusal must name the missing/mismatching installer-built ownership credential:\n${run.output}`,
    );
  }
  assert.equal(existsSync(target), true, 'a refused uninstall deleted the target directory');
  assert.deepEqual(snapshotTree(target), before, 'a refused uninstall changed the directory');
}

/** Run the PowerShell fixture with a list of jobs; returns per-job verdicts. */
function runPsJobs(jobs) {
  const work = scratch('ps-run');
  const jobFile = join(work, 'jobs.json');
  writeFileSync(jobFile, JSON.stringify(jobs), 'utf8');
  const env = { ...process.env, AIDN_SETUP_TEST_DOTSOURCE: '1' };
  // A PS 7 parent exports a PS 7 PSModulePath; handing that to Windows PowerShell 5.1
  // hides its own modules (Get-FileHash would be "not recognized").
  delete env.PSModulePath;
  const result = spawnSync(
    POWERSHELL,
    [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', PS_FIXTURE,
      '-SetupPath', SETUP_PS1,
      '-WorkDir', work,
      '-JobFile', jobFile,
    ],
    { encoding: 'utf8', timeout: 300_000, windowsHide: true, env },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const marker = output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('AIDN_PS1_RC5_JSON:'))
    .pop();
  assert.ok(marker, `the PowerShell fixture produced no verdicts (exit ${result.status}):\n${output}`);
  // The fixture writes its verdicts as UTF-8 to a file (the console code page here is
  // CP936, which would mangle the Chinese refusal text on stdout).
  const verdictPath = marker.slice('AIDN_PS1_RC5_JSON:'.length).trim();
  assert.ok(existsSync(verdictPath), `the verdict file is missing: ${verdictPath}\n${output}`);
  const list = JSON.parse(readFileSync(verdictPath, 'utf8').replace(/^\uFEFF/u, ''));
  const entries = Array.isArray(list) ? list : [list];
  return { byName: new Map(entries.map((entry) => [entry.name, entry])), output };
}

function assertPsRefused(entry, target, before, output) {
  assert.ok(entry, 'the PowerShell fixture returned no verdict for this case');
  assert.equal(entry.refused, true, `the PowerShell channel did not refuse it:\n${JSON.stringify(entry)}\n${output}`);
  assert.equal(entry.deleted, false, 'a refused PowerShell uninstall deleted the directory');
  assert.match(String(entry.message ?? ''), /卸载被拒/u, 'the refusal must be reported as a refusal');
  assert.match(
    String(entry.message ?? ''),
    /归属凭据|ownership/iu,
    `the refusal must name the missing/mismatching installer-built ownership credential: ${entry.message}`,
  );
  assert.equal(existsSync(target), true, 'a refused PowerShell uninstall deleted the target directory');
  assert.deepEqual(snapshotTree(target), before, 'a refused PowerShell uninstall changed the directory');
}

// ================================================================== Python channel

TEST_WITH_PYTHON('python/positive: a tree the installer built is uninstalled (control)', () => {
  const target = join(scratch('py-positive'), 'AIDriven NetDefense');
  const record = installWithPythonInstaller(target);
  const block = record.ownership;
  assert.ok(block && typeof block === 'object', 'install() must write the ownership credential');
  assert.equal(block.scheme, 'hmac-sha256-v1');
  assert.match(String(block.installId), /^[0-9a-f]{32}$/u);
  assert.match(String(block.token), /^[0-9a-f]{64}$/u);
  assert.match(String(block.payloadDigest), /^[0-9a-f]{64}$/u);
  plantSentinel(target);

  const run = runPythonUninstall(target);
  assert.equal(run.code, EXIT_OK, `an installer-built tree must uninstall:\n${run.output}`);
  assert.equal(existsSync(target), false, 'the accepted install tree was not removed');
});

TEST_WITH_PYTHON('python/(a) forged full-field record + self-consistent manifest is refused', () => {
  const target = join(scratch('py-forged-a'), 'my-notes');
  createPayloadDir(target); // three arbitrary files + their real digests: "looks genuine"
  plantSentinel(target);
  writeInstallRecord(target);
  const before = snapshotTree(target);

  const run = runPythonUninstall(target);
  assertPythonRefused(target, before, run);
});

TEST_WITH_PYTHON('python/(b) the same forgery with an invented ownership token is refused', () => {
  const target = join(scratch('py-forged-b'), 'my-notes');
  createPayloadDir(target);
  plantSentinel(target);
  writeInstallRecord(target, {
    ownership: {
      scheme: 'hmac-sha256-v1',
      installId: 'a'.repeat(32),
      payloadDigest: sha256File(join(target, 'manifests', 'files.sha256')),
      token: 'b'.repeat(64),
    },
  });
  const before = snapshotTree(target);

  const run = runPythonUninstall(target);
  assertPythonRefused(target, before, run);
});

TEST_WITH_PYTHON('python/(c) an installer-built tree copied elsewhere (path rewritten) is refused', () => {
  const source = join(scratch('py-copy-src'), 'AIDriven NetDefense');
  installWithPythonInstaller(source);

  const target = join(scratch('py-copy-dst'), 'AIDriven NetDefense');
  cpSync(source, target, { recursive: true });
  // The attacker adjusts the identity field so only the credential still binds the path:
  // this is exactly "a genuine credential, used on a directory it was not issued for".
  const recordPath = join(target, 'install', 'install.json');
  const record = readJsonFile(recordPath);
  record.installPath = target;
  writeJsonFile(recordPath, record);
  const before = snapshotTree(target);

  const run = runPythonUninstall(target);
  assertPythonRefused(target, before, run);
  assert.match(run.output, /归属凭据|ownership|token/iu, 'the path-bound token must be what refuses');
});

TEST_WITH_PYTHON('python/(d1) an installer-built tree whose ownership block was removed is refused', () => {
  const target = join(scratch('py-tamper-remove'), 'AIDriven NetDefense');
  installWithPythonInstaller(target);
  const recordPath = join(target, 'install', 'install.json');
  const record = readJsonFile(recordPath);
  delete record.ownership;
  writeJsonFile(recordPath, record);
  const before = snapshotTree(target);

  const run = runPythonUninstall(target);
  assertPythonRefused(target, before, run);
});

TEST_WITH_PYTHON('python/(d2) an installer-built tree with one token hex character flipped is refused', () => {
  const target = join(scratch('py-tamper-flip'), 'AIDriven NetDefense');
  installWithPythonInstaller(target);
  const recordPath = join(target, 'install', 'install.json');
  const record = readJsonFile(recordPath);
  const token = String(record.ownership.token);
  record.ownership.token = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
  writeJsonFile(recordPath, record);
  const before = snapshotTree(target);

  const run = runPythonUninstall(target);
  assertPythonRefused(target, before, run);
});

TEST_WITH_PYTHON('python: a bundle.json + manifest payload tree (no install.json) may not be deleted', () => {
  const target = join(scratch('py-bundle-only'), 'looks-like-a-payload');
  createPayloadDir(target);
  plantSentinel(target);
  const before = snapshotTree(target);

  const run = runPythonUninstall(target);
  assertPythonRefused(target, before, run);
  assert.equal(existsSync(join(target, 'bundle.json')), true, 'the payload files were touched');
});

TEST_WITH_PYTHON('python: an empty directory is still removed (nothing to lose)', () => {
  const target = join(scratch('py-empty'), 'empty-dir');
  mkdirSync(target, { recursive: true });

  const run = runPythonUninstall(target);
  assert.equal(run.code, EXIT_OK, `an empty directory must be removable:\n${run.output}`);
  assert.equal(existsSync(target), false, 'the empty directory was not removed');
});

// ================================================================== PowerShell channel

TEST_WITH_PS('powershell/positive: a tree Install-Target built is uninstalled by Uninstall-Target', () => {
  const target = join(scratch('ps-positive'), 'AIDriven NetDefense');
  const payload = createPayloadDir(join(scratch('ps-payload'), 'payload'));

  const installed = runPsJobs([{ op: 'install', name: 'install', target, payload }]);
  const installEntry = installed.byName.get('install');
  assert.equal(installEntry.ok, true, `Install-Target failed:\n${JSON.stringify(installEntry)}\n${installed.output}`);
  const block = installEntry.ownership;
  assert.ok(block, 'Install-Target must write the ownership credential into install.json');
  assert.equal(block.scheme, 'hmac-sha256-v1');
  assert.match(String(block.installId), /^[0-9a-f]{32}$/u);
  assert.match(String(block.token), /^[0-9a-f]{64}$/u);

  const removed = runPsJobs([{ op: 'uninstall', name: 'uninstall', target }]);
  const entry = removed.byName.get('uninstall');
  assert.equal(entry.refused, false, `a genuine tree was refused: ${entry.message}\n${removed.output}`);
  assert.equal(entry.deleted, true, `the accepted tree was not removed:\n${removed.output}`);
  assert.equal(existsSync(target), false, 'the install tree survived an accepted uninstall');
});

TEST_WITH_PS('powershell/(a) forged full-field record + self-consistent manifest is refused', () => {
  const target = join(scratch('ps-forged-a'), 'my-notes');
  createPayloadDir(target);
  plantSentinel(target);
  writeInstallRecord(target, { channel: 'test' });
  const before = snapshotTree(target);

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  assertPsRefused(byName.get('case'), target, before, output);
});

TEST_WITH_PS('powershell/(b) the same forgery with an invented ownership token is refused', () => {
  const target = join(scratch('ps-forged-b'), 'my-notes');
  createPayloadDir(target);
  plantSentinel(target);
  writeInstallRecord(target, {
    channel: 'test',
    ownership: {
      scheme: 'hmac-sha256-v1',
      installId: 'c'.repeat(32),
      payloadDigest: sha256File(join(target, 'manifests', 'files.sha256')),
      token: 'd'.repeat(64),
    },
  });
  const before = snapshotTree(target);

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  assertPsRefused(byName.get('case'), target, before, output);
});

TEST_WITH_PS('powershell/(c) an installer-built tree copied elsewhere (path rewritten) is refused', () => {
  const source = join(scratch('ps-copy-src'), 'AIDriven NetDefense');
  const payload = createPayloadDir(join(scratch('ps-copy-payload'), 'payload'));
  const installed = runPsJobs([{ op: 'install', name: 'install', target: source, payload }]);
  assert.equal(installed.byName.get('install').ok, true, installed.output);

  const target = join(scratch('ps-copy-dst'), 'AIDriven NetDefense');
  cpSync(source, target, { recursive: true });
  const recordPath = join(target, 'install', 'install.json');
  const record = readJsonFile(recordPath);
  record.installPath = target;
  writeJsonFile(recordPath, record);
  const before = snapshotTree(target);

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  assertPsRefused(byName.get('case'), target, before, output);
});

TEST_WITH_PS('powershell/(d) an installer-built tree with the credential removed or edited is refused', () => {
  const removed = join(scratch('ps-tamper-remove'), 'AIDriven NetDefense');
  const payload = createPayloadDir(join(scratch('ps-tamper-payload'), 'payload'));
  assert.equal(runPsJobs([{ op: 'install', name: 'install', target: removed, payload }]).byName.get('install').ok, true);

  const removedRecordPath = join(removed, 'install', 'install.json');
  const removedRecord = readJsonFile(removedRecordPath);
  delete removedRecord.ownership;
  writeJsonFile(removedRecordPath, removedRecord);
  const removedBefore = snapshotTree(removed);

  const flipped = join(scratch('ps-tamper-flip'), 'AIDriven Net DefEnse');
  const payload2 = createPayloadDir(join(scratch('ps-tamper-payload2'), 'payload'));
  assert.equal(runPsJobs([{ op: 'install', name: 'install', target: flipped, payload: payload2 }]).byName.get('install').ok, true);

  const flippedRecordPath = join(flipped, 'install', 'install.json');
  const flippedRecord = readJsonFile(flippedRecordPath);
  const token = String(flippedRecord.ownership.token);
  flippedRecord.ownership.token = `${token[0] === 'a' ? 'b' : 'a'}${token.slice(1)}`;
  writeJsonFile(flippedRecordPath, flippedRecord);
  const flippedBefore = snapshotTree(flipped);

  const { byName, output } = runPsJobs([
    { op: 'uninstall', name: 'removed', target: removed },
    { op: 'uninstall', name: 'flipped', target: flipped },
  ]);
  assertPsRefused(byName.get('removed'), removed, removedBefore, output);
  assertPsRefused(byName.get('flipped'), flipped, flippedBefore, output);
});

// RC5-N01 P2（Lead 第三方探针发现）：install.json 里的 installPath 是绝对路径，当目标树位于
// 含非 ASCII 字符的路径（例如中文目录）上时，记录文件里就含有非 ASCII 字节。Windows PowerShell
// 5.1 的 `Get-Content` 对**无 BOM** 文件按系统 ANSI 代码页（本机 CP936）解码 → 中文 installPath
// 变乱码 → 身份比对在 ownership 校验**之前**就失败 → 真树被当成伪树拒删（连"凭据恒真"的变异都
// 救不回来）。默认 %ProgramFiles%\AIDriven Net Defense 是 ASCII，所以既有用例与验收没暴露。
// 下面两条把"非 ASCII 路径"钉成回归：真树必须可卸，同一路径上的伪树必须仍拒删。
TEST_WITH_PS('powershell: a genuine tree on a non-ASCII (Chinese) path is still accepted', () => {
  const target = join(scratch('ps-unicode'), 'AIDriven NetDefense 网域智防');
  const payload = createPayloadDir(join(scratch('ps-unicode-payload'), 'payload'));

  const installed = runPsJobs([{ op: 'install', name: 'install', target, payload }]);
  const installEntry = installed.byName.get('install');
  assert.equal(
    installEntry.ok,
    true,
    `Install-Target failed on a non-ASCII path:\n${JSON.stringify(installEntry)}\n${installed.output}`,
  );
  const record = readJsonFile(join(target, 'install', 'install.json'));
  assert.equal(record.installPath, target, 'the install record must round-trip the non-ASCII path verbatim');
  assert.match(String(record.ownership && record.ownership.token), /^[0-9a-f]{64}$/u);

  const removed = runPsJobs([{ op: 'uninstall', name: 'uninstall', target }]);
  const entry = removed.byName.get('uninstall');
  assert.equal(
    entry.refused,
    false,
    `a genuine tree on a non-ASCII path was refused: ${entry.message}\n${removed.output}`,
  );
  assert.equal(entry.deleted, true, `the non-ASCII tree was not removed:\n${removed.output}`);
  assert.equal(existsSync(target), false, 'the non-ASCII install tree survived an accepted uninstall');
});

TEST_WITH_PS('powershell: a forged tree on a non-ASCII (Chinese) path is still refused', () => {
  const target = join(scratch('ps-unicode-forged'), '我的资料 网域智防');
  createPayloadDir(target);
  plantSentinel(target);
  writeInstallRecord(target, { channel: 'test' });
  const before = snapshotTree(target);

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  assertPsRefused(byName.get('case'), target, before, output);
});

TEST_WITH_PS('powershell: a bundle.json + manifest payload tree (no install.json) may not be deleted', () => {
  const target = join(scratch('ps-bundle-only'), 'looks-like-a-payload');
  createPayloadDir(target);
  plantSentinel(target);
  const before = snapshotTree(target);

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  assertPsRefused(byName.get('case'), target, before, output);
});

TEST_WITH_PS('powershell: an empty directory is still removed (nothing to lose)', () => {
  const target = join(scratch('ps-empty'), 'empty-dir');
  mkdirSync(target, { recursive: true });

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  const entry = byName.get('case');
  assert.equal(entry.refused, false, `an empty directory must be removable:\n${JSON.stringify(entry)}\n${output}`);
  assert.equal(entry.deleted, true, 'the empty directory was not removed');
});

// ================================================================== cross-channel

TEST_WITH_PYTHON('cross-channel: both channels derive the same token from the same message', () => {
  const target = join(scratch('cross-token'), 'AIDriven NetDefense');
  const record = installWithPythonInstaller(target);
  const block = record.ownership;
  assert.ok(block && block.installId, 'install() must write the ownership credential before this test can compare it');

  const { byName, output } = runPsJobs([{
    op: 'credential',
    name: 'credential',
    target,
    channel: String(record.channel),
    version: String(record.version),
    installId: String(block.installId),
  }]);
  const entry = byName.get('credential');
  assert.ok(entry, `no verdict for the credential job:\n${output}`);
  assert.equal(entry.ok, true, `the PowerShell credential function failed: ${entry.error}\n${output}`);
  const psBlock = entry.credential;
  assert.equal(
    psBlock.token,
    block.token,
    `the two channels disagree on the ownership token (Python ${block.token} vs PS ${psBlock.token})`,
  );
  assert.equal(psBlock.payloadDigest, block.payloadDigest, 'the two channels disagree on the payload digest');
  assert.equal(psBlock.scheme, block.scheme, 'the two channels disagree on the scheme name');
}, { skip: PS_SKIP });

TEST_WITH_PS('cross-channel: a tree installed by the Python channel is uninstalled by the PowerShell channel', () => {
  const target = join(scratch('cross-py-to-ps'), 'AIDriven Net Defense');
  const record = installWithPythonInstaller(target);
  assert.ok(record.ownership, 'install() must write the ownership credential');
  plantSentinel(target);

  const { byName, output } = runPsJobs([{ op: 'uninstall', name: 'case', target }]);
  const entry = byName.get('uninstall') ?? byName.get('case');
  assert.ok(entry, `no verdict:\n${output}`);
  assert.equal(entry.refused, false, `the PowerShell channel refused a Python-installed tree: ${entry.message}\n${output}`);
  assert.equal(entry.deleted, true, `the Python-installed tree was not removed:\n${output}`);
});

TEST_WITH_PYTHON('cross-channel: a tree installed by the PowerShell channel is uninstalled by the Python channel', () => {
  const target = join(scratch('cross-ps-to-py'), 'AIDriven NetDefense');
  const payload = createPayloadDir(join(scratch('cross-ps-payload'), 'payload'));
  const installed = runPsJobs([{ op: 'install', name: 'install', target, payload }]);
  assert.equal(installed.byName.get('install').ok, true, `Install-Target failed:\n${installed.output}`);

  const run = runPythonUninstall(target);
  assert.equal(run.code, EXIT_OK, `the Python channel refused a PowerShell-installed tree:\n${run.output}`);
  assert.equal(existsSync(target), false, 'the PowerShell-installed tree was not removed by the Python channel');
}, { skip: PS_SKIP });
