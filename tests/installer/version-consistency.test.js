/**
 * The shipped version has to be ONE value in THREE places.
 *
 *   1. the PE resource `FileVersion` of `dist/desktop/AIDrivenNetDefense.exe`;
 *   2. `apps/desktop/aidn.SHELL_VERSION` read back from that same executable;
 *   3. the release package name — `dist/release/<version>/latest.json`.`version` and
 *      the name of the directory that holds it.
 *
 * Why this test exists: rc.3 shipped a desktop shell whose PE resource said
 * `0.0.1-rc.3` while the tray tooltip, /shell/api and the about page said
 * `0.0.1-rc.1`, because SHELL_VERSION was a hard-coded constant. The constant was
 * replaced by a read of the executable's own version resource; this test is the
 * regression guard that all three sources are equal, and it fails with all three
 * values printed rather than with a bare "not equal".
 *
 * LEVEL OF EVIDENCE — read this before trusting the result:
 *
 *   * ① is a real read of the PE version resource of the shipped .exe, using
 *     GetFileVersionInfoW/VerQueryValueW through ctypes. The reader is written here,
 *     independently of the product code, so it cannot inherit the product's bugs.
 *   * ② is **function-level, not process-level**. This test starts a normal Python
 *     interpreter, sets `sys.frozen = True` and `sys.executable = <that exe>`, inserts
 *     `apps/desktop` on `sys.path` and imports `aidn`. `SHELL_VERSION` is computed by
 *     the product's own `_version_from_own_resource()`, reading the very bytes of ①,
 *     but the interpreter is not the frozen shell. A process-level read-back would be
 *     `AIDrivenNetDefense.exe --version`, which starts the tray/single-instance
 *     machinery and therefore is not something a unit test may depend on. The
 *     process-level check was done by hand during rc.3
 *     (docs/implementation/evidence/rc3/close/shell-version-assert.json); this file
 *     states plainly which half it covers.
 *   * ③ is plain file/JSON reading in this process.
 *
 * The test is read-only, needs no GUI, no network and no administrator rights, and is
 * repeatable: run `node --test tests/installer/version-consistency.test.js`.
 * Two environment overrides exist so the negative direction can be demonstrated
 * without touching the repository (see docs/implementation/status/A3-ELEVATION.md):
 *   AIDN_DESKTOP_EXE=<path>    assert against another executable
 *   AIDN_RELEASE_DIR=<path>    assert against another release directory
 *   AIDN_PYTHON=<path>         pin the interpreter (same convention as other tests)
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const DESKTOP_EXE = process.env.AIDN_DESKTOP_EXE
  ? path.resolve(process.env.AIDN_DESKTOP_EXE)
  : path.join(REPO_ROOT, 'dist', 'desktop', 'AIDrivenNetDefense.exe');
const RELEASE_ROOT = path.join(REPO_ROOT, 'dist', 'release');
const AIDN_PACKAGE_DIR = path.join(REPO_ROOT, 'apps', 'desktop');

// SEED-05: the single version source (`deploy/windows/installer/VERSION`).
//
// The artifact-side assertion ("the three version sources agree") compares the shipped
// PE/SHELL_VERSION with the release directory that matches *this* version. `dist/release/**`
// is a build output, rebuilt by the release team, so a clean checkout or an in-progress
// build may not have the artifact yet: in that case the test skips **explicitly** rather
// than failing. When the artifact exists it is compared strictly (version + directory name
// + PE + shell). The source-side assertions further down never skip: a missing or drifting
// VERSION / Setup.ps1 / build-dist.cmd / version_info / build-desktop / launcher is a red.
const SOURCE_VERSION_FILE = process.env.AIDN_VERSION_FILE
  ? path.resolve(process.env.AIDN_VERSION_FILE)
  : path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'VERSION');

function readSourceVersion() {
  return readFileSync(SOURCE_VERSION_FILE, 'utf8').trim();
}

/** Interpreters to try, in order. `AIDN_PYTHON` wins so CI can pin one. */
const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'];

function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.stdout.write(sys.version)'], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

const PYTHON = pickPython();

/**
 * Reads the two executable-side values in one Python process.
 *
 * Kept as an inline program rather than a file next to this test: `tests/installer` is
 * shared with another workstream, and a helper file would be a new write scope for a
 * test that must stay self-contained.
 */
const PYTHON_PROGRAM = String.raw`
import ctypes
import json
import sys
from ctypes import wintypes


def read_pe_version(path):
    """FileVersion / ProductVersion / FileDescription straight out of the PE resource."""
    dll = ctypes.WinDLL("version")
    dll.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    dll.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    dll.GetFileVersionInfoW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    ]
    dll.GetFileVersionInfoW.restype = wintypes.BOOL
    dll.VerQueryValueW.argtypes = [
        ctypes.c_void_p, wintypes.LPCWSTR,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT),
    ]
    dll.VerQueryValueW.restype = wintypes.BOOL

    ignored = wintypes.DWORD()
    size = dll.GetFileVersionInfoSizeW(path, ctypes.byref(ignored))
    if not size:
        raise RuntimeError("no version resource in " + path)
    buffer = ctypes.create_string_buffer(size)
    if not dll.GetFileVersionInfoW(path, 0, size, buffer):
        raise RuntimeError("GetFileVersionInfoW failed for " + path)

    pointer = ctypes.c_void_p()
    length = wintypes.UINT()
    translations = []
    if dll.VerQueryValueW(
        buffer, "\\VarFileInfo\\Translation", ctypes.byref(pointer), ctypes.byref(length)
    ) and pointer.value:
        count = length.value // 4
        for item in (wintypes.DWORD * count).from_address(pointer.value):
            translations.append((item & 0xFFFF, (item >> 16) & 0xFFFF))
    if not translations:
        translations = [(0x0804, 0x04B0), (0x0409, 0x04B0)]

    values = {}
    for language, codepage in translations:
        prefix = "\\StringFileInfo\\%04x%04x\\" % (language, codepage)
        for name in ("FileVersion", "ProductVersion", "FileDescription"):
            if name in values:
                continue
            if dll.VerQueryValueW(
                buffer, prefix + name, ctypes.byref(pointer), ctypes.byref(length)
            ) and pointer.value and length.value:
                text = ctypes.wstring_at(pointer.value, length.value).split("\x00")[0].strip()
                if text:
                    values[name] = text
    return values


def read_shell_version(exe, package_dir):
    """Function-level read-back: the product's own code, pointed at the real exe."""
    if package_dir not in sys.path:
        sys.path.insert(0, package_dir)
    sys.frozen = True
    sys.executable = exe
    import aidn

    return {
        "value": aidn.SHELL_VERSION,
        "fallback": aidn.SHELL_VERSION_FALLBACK,
        "own_resource": aidn._version_from_own_resource(),
        "implementation": "apps/desktop/aidn/__init__.py:_version_from_own_resource",
    }


def main():
    exe, package_dir = sys.argv[1], sys.argv[2]
    result = {"exe": exe, "level": "function-level (not a frozen shell process)"}
    try:
        result["pe"] = read_pe_version(exe)
    except Exception as error:
        result["pe_error"] = "%s: %s" % (type(error).__name__, error)
    try:
        result["shell"] = read_shell_version(exe, package_dir)
    except Exception as error:
        result["shell_error"] = "%s: %s" % (type(error).__name__, error)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


main()
`;

// Four-part forms ("0.0.1.0", what PyInstaller writes for a MSIX-shaped resource) are
// accepted by the *format* check on purpose: the interesting failure is the three
// sources disagreeing, and a format check that fires first would hide that. The
// release-directory filter below only ever sees semantic versions.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(\.\d+)?(-[A-Za-z0-9.]+)?$/;

function versionDirectories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => VERSION_PATTERN.test(name))
    .map((name) => ({ name, path: path.join(root, name) }))
    .filter((entry) => statSync(entry.path).isDirectory())
    .filter((entry) => existsSync(path.join(entry.path, 'latest.json')))
    .sort((left, right) => statSync(right.path).mtimeMs - statSync(left.path).mtimeMs);
}

function readReleasePackage() {
  if (process.env.AIDN_RELEASE_DIR) {
    const dir = path.resolve(process.env.AIDN_RELEASE_DIR);
    const record = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    return { dirName: path.basename(dir), version: String(record.version ?? ''), record, source: dir };
  }
  const candidates = versionDirectories(RELEASE_ROOT);
  if (candidates.length === 0) return undefined;
  let canonical = '';
  try {
    canonical = readSourceVersion();
  } catch {
    canonical = '';
  }
  const versionOf = (entry) => {
    try {
      return String(JSON.parse(readFileSync(path.join(entry.path, 'latest.json'), 'utf8')).version ?? '');
    } catch {
      return '';
    }
  };
  // Only the artifact for the *current* version is evidence about the current version.
  const chosen = candidates.find((entry) => entry.name === canonical)
    ?? candidates.find((entry) => versionOf(entry) === canonical);
  if (!chosen) return undefined;
  const record = JSON.parse(readFileSync(path.join(chosen.path, 'latest.json'), 'utf8'));
  return { dirName: chosen.name, version: String(record.version ?? ''), record, source: chosen.path };
}

function collectFacts() {
  const run = spawnSync(PYTHON, ['-c', PYTHON_PROGRAM, DESKTOP_EXE, AIDN_PACKAGE_DIR], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (run.status !== 0) {
    const detail = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`the version probe failed (exit ${run.status}): ${detail}`);
  }
  const probe = JSON.parse(run.stdout);
  const pkg = readReleasePackage();
  return {
    probe,
    peFileVersion: probe.pe?.FileVersion ?? '',
    peProductVersion: probe.pe?.ProductVersion ?? '',
    shellVersion: probe.shell?.value ?? '',
    shellFallback: probe.shell?.fallback ?? '',
    packageVersion: pkg?.version ?? '',
    packageDirName: pkg?.dirName ?? '',
    packageSource: pkg?.source ?? '',
    probeError: probe.pe_error ?? probe.shell_error ?? '',
  };
}

let facts;
let gatherError;
try {
  facts = collectFacts();
} catch (error) {
  gatherError = error;
}

function describeAll(current) {
  return [
    `① PE FileVersion          = ${JSON.stringify(current.peFileVersion)}`,
    `② SHELL_VERSION read-back = ${JSON.stringify(current.shellVersion)}  (function-level, not a frozen process)`,
    `③ package latest.json     = ${JSON.stringify(current.packageVersion)}  (dir ${JSON.stringify(current.packageDirName)})`,
    `source exe = ${DESKTOP_EXE}`,
    `source package = ${current.packageSource}`,
  ].join('\n  ');
}

const skipReason = (() => {
  if (gatherError) return false;
  if (process.platform !== 'win32') return 'PE version resources are a Windows-only check';
  if (!PYTHON) return 'no Python interpreter with ctypes found (set AIDN_PYTHON)';
  if (!existsSync(DESKTOP_EXE)) return `desktop executable not built: ${DESKTOP_EXE}`;
  if (!facts.packageVersion) {
    let canonical = '(unreadable VERSION)';
    try {
      canonical = readSourceVersion();
    } catch {
      // The source-side tests will fail on the missing file; this skip only covers the
      // release artifact, which is a build output.
    }
    return `release artifact for ${canonical} not built yet (dist/release/${canonical}/latest.json missing); `
      + 'source-side version consumers are still asserted strictly';
  }
  return false;
})();

test('the three version sources agree', { skip: skipReason }, (t) => {
  assert.equal(gatherError, undefined, `could not collect the three values: ${gatherError?.message ?? ''}`);
  t.diagnostic(describeAll(facts));

  assert.equal(facts.probeError, '', `a version source could not be read:\n${describeAll(facts)}`);
  assert.match(facts.peFileVersion, VERSION_PATTERN, `① is not a version string:\n${describeAll(facts)}`);
  assert.ok(facts.shellVersion, `② is empty:\n${describeAll(facts)}`);
  assert.ok(facts.packageVersion, `③ is empty:\n${describeAll(facts)}`);

  // The single assertion this file exists for. Every mismatch prints all three values,
  // because "expected rc.3, got rc.1" with no context is what took three review rounds.
  assert.deepEqual(
    {
      peFileVersion: facts.peFileVersion,
      shellVersion: facts.shellVersion,
      packageVersion: facts.packageVersion,
      packageDirName: facts.packageDirName,
    },
    {
      peFileVersion: facts.peFileVersion,
      shellVersion: facts.peFileVersion,
      packageVersion: facts.peFileVersion,
      packageDirName: facts.peFileVersion,
    },
    `three version sources disagree:\n  ${describeAll(facts)}`,
  );
});

test('the SHELL_VERSION read-back is a real read, not the fallback constant', { skip: skipReason }, (t) => {
  assert.equal(gatherError, undefined, `could not collect the three values: ${gatherError?.message ?? ''}`);
  t.diagnostic(`fallback constant = ${JSON.stringify(facts.shellFallback)}`);
  // If the resource read failed, SHELL_VERSION silently falls back to 0.0.0-dev. Then
  // ② would no longer be evidence of anything, so it must be asserted separately: a
  // fallback that happened to equal the package version would otherwise pass.
  assert.notEqual(facts.shellVersion, facts.shellFallback, `② fell back to the constant:\n  ${describeAll(facts)}`);
  assert.equal(
    facts.shellVersion,
    facts.peFileVersion,
    `② was read from the wrong bytes:\n  ${describeAll(facts)}`,
  );
});

test('the package directory name equals latest.json.version', { skip: skipReason }, (t) => {
  assert.equal(gatherError, undefined, `could not collect the three values: ${gatherError?.message ?? ''}`);
  t.diagnostic(`release directory = ${facts.packageSource}`);
  assert.equal(
    facts.packageDirName,
    facts.packageVersion,
    `③ is self-inconsistent (directory name vs latest.json):\n  ${describeAll(facts)}`,
  );
});

test('ProductVersion agrees with FileVersion (same resource block)', { skip: skipReason }, (t) => {
  assert.equal(gatherError, undefined, `could not collect the three values: ${gatherError?.message ?? ''}`);
  t.diagnostic(`ProductVersion = ${JSON.stringify(facts.peProductVersion)}`);
  // rc.3 upgraded both strings; a build that stamps only one of them would show two
  // different versions in Explorer's Details tab. Not part of the three-source
  // contract, but the same class of drift, so it is asserted here rather than never.
  assert.equal(
    facts.peProductVersion,
    facts.peFileVersion,
    `PE resource is internally inconsistent:\n  ${describeAll(facts)}`,
  );
});

// ------------------------------------------------------------------ SEED-05
// A single version source: `deploy/windows/installer/VERSION` is the one place the
// installer version is written down; Setup.ps1 / build-dist.cmd derive from it, and the
// PE resource template (which the spec consumes) must agree with it. The product
// version itself is not changed here — the file records the version that is being
// shipped; these assertions make drift a red test instead of a release surprise.

const VERSION_FILE = SOURCE_VERSION_FILE;
const SETUP_PS1 = path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'Setup.ps1');
const BUILD_DIST = path.join(REPO_ROOT, 'deploy', 'windows', 'installer', 'build-dist.cmd');
const VERSION_INFO = path.join(REPO_ROOT, 'apps', 'desktop', 'assets', 'version_info.txt');
const DESKTOP_SPEC = path.join(REPO_ROOT, 'apps', 'desktop', 'AIDrivenNetDefense.spec');
const BUILD_DESKTOP = path.join(REPO_ROOT, 'scripts', 'desktop', 'build-desktop.mjs');
const LAUNCHER_VERSION = path.join(REPO_ROOT, 'scripts', 'release', 'assets', 'launcher', 'lib', 'version.mjs');

function readCanonicalVersion() {
  return readFileSync(VERSION_FILE, 'utf8').trim();
}

test('SEED-05: VERSION is a valid version string and equals the shipped PE FileVersion', (t) => {
  const canonical = readCanonicalVersion();
  t.diagnostic(`VERSION = ${canonical}`);
  assert.match(canonical, VERSION_PATTERN, 'the single version source is not a version string');
  if (!existsSync(DESKTOP_EXE)) {
    t.diagnostic(`no built desktop executable at ${DESKTOP_EXE}; PE comparison not evaluated`);
    return;
  }
  const probe = spawnSync(PYTHON, ['-c', PYTHON_PROGRAM, DESKTOP_EXE, AIDN_PACKAGE_DIR], {
    encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  assert.equal(probe.status, 0, `the PE probe failed: ${probe.stderr}`);
  const pe = JSON.parse(probe.stdout).pe ?? {};
  assert.equal(
    canonical,
    pe.FileVersion,
    `the single version source and the shipped PE disagree: VERSION=${canonical} PE=${pe.FileVersion}`,
  );
});

test('SEED-05: Setup.ps1 and build-dist.cmd derive their version from VERSION, not a second literal', () => {
  const canonical = readCanonicalVersion();
  const setup = readFileSync(SETUP_PS1, 'utf8');
  assert.match(setup, /VersionFile\s*=\s*Join-Path\s*\$PSScriptRoot\s*'VERSION'/u, 'Setup.ps1 must read VERSION');
  assert.match(setup, /Get-Content\s+-LiteralPath\s+\$script:VersionFile/u, 'Setup.ps1 must read VERSION contents');
  const fallback = setup.match(/\$script:ProductVer\s*=\s*'([^']+)'/u);
  assert.ok(fallback, 'Setup.ps1 must keep a reviewed fallback literal');
  assert.equal(fallback[1], canonical, `Setup.ps1 fallback ${fallback[1]} differs from VERSION ${canonical}`);

  const build = readFileSync(BUILD_DIST, 'utf8');
  assert.match(build, /for \/f[^\r\n]*usebackq[^\r\n]*"%~dp0VERSION"/u, 'build-dist.cmd must read VERSION');
  assert.match(build, /copy \/y "%~dp0VERSION"/u, 'build-dist.cmd must package VERSION for the in-tree copy');
  const buildFallback = build.match(/if not defined VER set "VER=(\d[^"]*)"/u);
  assert.ok(buildFallback, 'build-dist.cmd must keep a reviewed fallback literal');
  assert.equal(buildFallback[1], canonical, `build-dist.cmd fallback ${buildFallback[1]} differs from VERSION ${canonical}`);
});

test('SEED-05: the PE resource template and the spec agree with VERSION', () => {
  const canonical = readCanonicalVersion();
  const info = readFileSync(VERSION_INFO, 'utf8');
  const versions = [...info.matchAll(/StringStruct\('(?:FileVersion|ProductVersion)',\s*'([^']+)'\)/gu)].map((m) => m[1]);
  assert.equal(versions.length, 2, 'version_info.txt must declare FileVersion and ProductVersion');
  for (const value of versions) assert.equal(value, canonical, `version_info.txt says ${value}, VERSION says ${canonical}`);
  assert.match(
    readFileSync(DESKTOP_SPEC, 'utf8'),
    /version\s*=\s*str\(APP_DIR\s*\/\s*"assets"\s*\/\s*"version_info\.txt"\)/u,
    'the desktop spec must consume the version_info template',
  );
});

test('SEED-05: build-desktop.mjs derives the payload label and node input from VERSION', () => {
  const canonical = readCanonicalVersion();
  const text = readFileSync(BUILD_DESKTOP, 'utf8');
  assert.match(
    text,
    /VERSION_FILE\s*=\s*join\(REPO,\s*'deploy',\s*'windows',\s*'installer',\s*'VERSION'\)/u,
    'build-desktop.mjs must point at the single version source',
  );
  assert.match(text, /const VERSION = readVersion\(\);/u, 'build-desktop.mjs must derive VERSION at runtime');
  const fallback = text.match(/VERSION_FALLBACK\s*=\s*'([^']+)'/u);
  assert.ok(fallback, 'build-desktop.mjs must keep a reviewed fallback literal');
  assert.equal(fallback[1], canonical, `build-desktop.mjs fallback ${fallback[1]} differs from VERSION ${canonical}`);
  // The node runtime build input used to be pinned to a superseded release directory;
  // it must now be derived from the same version (behaviour-equivalent fallback list).
  assert.match(
    text,
    /join\(REPO,\s*'dist',\s*'installer',\s*VERSION,\s*'payload',\s*'runtime',\s*'node'\)/u,
    'build-desktop.mjs node input must be version-derived',
  );
  assert.doesNotMatch(text, /dist',\s*'installer',\s*'0\.0\.1-rc\.1'/u, 'a superseded release path must not be hard-coded');
});

test('SEED-05: the portable launcher reads the same VERSION file and its label matches it', async () => {
  const canonical = readCanonicalVersion();
  const text = readFileSync(LAUNCHER_VERSION, 'utf8');
  assert.match(
    text,
    /VERSION_FILE\s*=\s*resolve\(HERE,[^)]*'deploy',\s*'windows',\s*'installer',\s*'VERSION'\)/u,
    'the launcher must resolve the single version source',
  );
  const fallback = text.match(/RELEASE_LABEL_FALLBACK\s*=\s*'([^']+)'/u);
  assert.ok(fallback, 'the launcher must keep a reviewed fallback literal');
  assert.equal(fallback[1], canonical, `launcher fallback ${fallback[1]} differs from VERSION ${canonical}`);
  // Dynamic check: the exported label really is the value read from the repo file.
  const module = await import(pathToFileURL(LAUNCHER_VERSION).href);
  assert.equal(module.RELEASE_LABEL, canonical, `launcher RELEASE_LABEL=${module.RELEASE_LABEL}, VERSION=${canonical}`);
});
