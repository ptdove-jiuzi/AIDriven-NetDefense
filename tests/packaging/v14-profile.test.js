/**
 * v14 composition verification (bundle profile `daemon-console`).
 *
 * What this file proves, and what it deliberately does not:
 *
 * - the v14 profile is a *superset* of the v13 worker profile: every closure root
 *   the worker payload needed is still there, so adding the daemon did not quietly
 *   drop the harness;
 * - `--allow-repo-output` is not a general "write anywhere in the repository"
 *   switch: it accepts `dist/bundle/<name>` and refuses the repository root, the
 *   shared parent, and any sibling reached with `..`;
 * - the shipped rule pack validates against the repository's own detection
 *   package, not against a copy of the rules maintained for the test;
 * - the delivered v14 bundle contains a runnable daemon entry, a console page, the
 *   rule pack, the bundled Node runtime and `manifests/files.sha256`, and the
 *   manifest describes every file that is actually on disk;
 * - the daemon starts from the bundle with its own runtime, the bundled rule pack
 *   and a temporary data directory, and `/healthz` answers 200;
 * - the console shell serves the static page and proxies `/healthz` to the daemon.
 *
 * It does **not** prove the console is a product UI: `apps/console` is empty at the
 * time of writing, so the staged page is the packaging-owned shell and
 * `bundle.json.console.isProductUi` says `false`. Nor does it prove service
 * registration, signing, or a four-OS payload.
 *
 * Environment:
 * - `M8_BUNDLE_V14_DIR` overrides the bundle location (default:
 *   `<repo>/dist/bundle/win32-x64-v14`). Unlike the v13 suite this default is
 *   inside the repository, because a delivered artifact under `dist/` is the point
 *   of v14.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUILD = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'build.mjs');
const PROFILES = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'profiles');
const RULE_PACK = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'rules', 'defense-seed-pack.json');
const BUNDLE_ROOT = resolve(process.env.M8_BUNDLE_V14_DIR ?? join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v14'));
/** The bundled runtime: the whole point is that the host node is not used. */
const BUNDLED_NODE = join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe');

const WORKER_ROOTS = [
  '@deepseek-ai/dsh',
  '@aegisharness/harness-worker',
  '@aegisharness/harness-adapter',
  '@aegisharness/dsh-defense-profile',
  '@aegisharness/dsh-defense-tools',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireBundle() {
  if (!existsSync(join(BUNDLE_ROOT, 'bundle.json'))) {
    throw new Error(`v14 bundle missing at ${BUNDLE_ROOT}; build it with: `
      + 'node deploy/embedded-runtime/build.mjs --profile daemon-console');
  }
}

/** A sanitized environment: no host PATH entry can provide node. */
function minimalEnv(extra = {}) {
  return {
    PATH: 'C:\\Windows\\System32;C:\\Windows',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    OS: 'Windows_NT',
    ...extra,
  };
}

test('profile: daemon-console keeps every worker closure root', () => {
  const worker = readJson(join(PROFILES, 'worker.json'));
  const v14 = readJson(join(PROFILES, 'daemon-console.json'));
  for (const root of WORKER_ROOTS) {
    assert.ok(worker.closureRoots.includes(root), `worker.json no longer lists ${root}`);
    assert.ok(v14.closureRoots.includes(root), `daemon-console.json dropped the worker root ${root}`);
  }
  assert.ok(v14.closureRoots.includes('@aegisharness/daemon'), 'daemon-console must add @aegisharness/daemon');
  assert.equal(new Set(v14.closureRoots).size, v14.closureRoots.length, 'closureRoots must not repeat a name');
  assert.equal(v14.defaultOut, 'dist/bundle/win32-x64-v14', 'v14 must default to an in-repository artifact path');
});

test('profile: console declares a preferred source and a shell fallback', () => {
  const v14 = readJson(join(PROFILES, 'daemon-console.json'));
  const consoleSpec = v14.assets.console;
  assert.equal(consoleSpec.preferredSource, 'apps/console');
  assert.equal(consoleSpec.shellSource, 'deploy/embedded-runtime/console-shell');
  assert.equal(consoleSpec.requireEntry, 'index.html');
  assert.ok(existsSync(join(REPO_ROOT, consoleSpec.shellSource, 'index.html')), 'the shell fallback must ship an index.html');
  assert.equal(v14.assets.rules.target, 'rules');
});

test('profile: --allow-repo-output is a dist/bundle allowlist, not the whole repository', () => {
  const cases = [
    { out: REPO_ROOT, ok: false, why: 'the repository root' },
    { out: join(REPO_ROOT, 'dist', 'bundle'), ok: false, why: 'the shared bundle parent' },
    { out: join(REPO_ROOT, 'apps', 'probe-v14'), ok: false, why: 'a source directory' },
    { out: join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v14-probe'), ok: true, why: 'a versioned directory under dist/bundle/' },
  ];
  for (const item of cases) {
    const result = spawnSync(process.execPath, [BUILD, '--profile', 'daemon-console', '--out', item.out,
      '--allow-repo-output', '--plan-only'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (item.ok) {
      assert.equal(result.status, 0, `expected ${item.why} to be accepted, saw: ${result.stderr}`);
    } else {
      assert.notEqual(result.status, 0, `expected ${item.why} to be refused, but the build proceeded`);
      assert.match(result.stderr, /refusing|only permits/i, `refusal of ${item.why} must say why: ${result.stderr}`);
    }
  }
});

test('profile: without --allow-repo-output every in-repository output is refused', () => {
  const result = spawnSync(process.execPath, [BUILD, '--profile', 'daemon-console',
    '--out', join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v14-probe'), '--plan-only'],
  { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-repo-output/);
});

test('rule pack: the shipped pack validates with the repository detection package', async () => {
  const detection = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'detection', 'src', 'rule-pack.js')).href);
  const pack = detection.loadRulePack(RULE_PACK);
  assert.equal(pack.schemaVersion, '1.0');
  assert.ok(pack.rules.length >= 3, `expected at least 3 rules, saw ${pack.rules.length}`);
  assert.equal(new Set(pack.rules.map((rule) => rule.ruleId)).size, pack.rules.length, 'rule ids must be unique');
  for (const rule of pack.rules) {
    assert.ok(['condition', 'threshold', 'correlation'].includes(rule.type));
  }
});

test('bundle: the v14 tree contains the daemon, the console, the rules, the runtime and the manifest', () => {
  requireBundle();
  const bundle = readJson(join(BUNDLE_ROOT, 'bundle.json'));
  assert.equal(bundle.bundleProfile.name, 'daemon-console');
  assert.ok(bundle.paths.daemonEntry, 'bundle.json must record the daemon entry');
  assert.ok(bundle.paths.console, 'bundle.json must record the console page');
  assert.ok(bundle.paths.rules, 'bundle.json must record the rule pack');

  for (const key of ['daemonEntry', 'daemonPackageEntry', 'console', 'consoleServer', 'rules', 'node', 'worker']) {
    assert.ok(existsSync(join(BUNDLE_ROOT, ...bundle.paths[key].split('/'))), `missing ${key}: ${bundle.paths[key]}`);
  }
  assert.ok(existsSync(join(BUNDLE_ROOT, 'manifests', 'files.sha256')), 'missing manifests/files.sha256');

  // The console is recorded as what it is. A future apps/console would flip this
  // to true without a test change, which is the point: the flag reports origin.
  assert.equal(typeof bundle.console.isProductUi, 'boolean');
  if (bundle.console.origin === 'packaging-shell') {
    assert.equal(bundle.console.isProductUi, false);
    assert.match(bundle.console.note, /not the product console/i);
  }
  assert.ok(Array.isArray(bundle.rules.packs) && bundle.rules.packs.length >= 1);
  assert.ok(bundle.rules.packs[0].rules >= 3);
});

test('bundle: manifests/files.sha256 describes every shipped byte and matches it', () => {
  requireBundle();
  const text = readFileSync(join(BUNDLE_ROOT, 'manifests', 'files.sha256'), 'utf8');
  const rows = text.split(/\r?\n/).filter((line) => line !== '' && !line.startsWith('#'));
  assert.ok(rows.length > 1000, `expected a populated manifest, saw ${rows.length} rows`);
  const listed = new Set();
  for (const row of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(row);
    assert.ok(match, `malformed manifest row: ${row}`);
    const [, digest, path] = match;
    assert.ok(!listed.has(path), `duplicate manifest entry: ${path}`);
    listed.add(path);
    const absolute = join(BUNDLE_ROOT, ...path.split('/'));
    assert.ok(existsSync(absolute), `manifest lists a file that is not there: ${path}`);
    assert.equal(createHash('sha256').update(readFileSync(absolute)).digest('hex'), digest, `digest mismatch: ${path}`);
  }
  // Every file outside manifests/ must be listed, or the manifest is partial.
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (next === 'manifests') continue;
      if (entry.isDirectory()) walk(join(directory, entry.name), next);
      else if (entry.isFile() && !listed.has(next)) missing.push(next);
    }
  };
  const missing = [];
  walk(BUNDLE_ROOT);
  assert.deepEqual(missing, [], 'files present on disk but absent from the manifest');
});

test('bundle: the bundled runtime runs the daemon entry and --help exits 0', () => {
  requireBundle();
  assert.ok(existsSync(BUNDLED_NODE), `bundled node missing at ${BUNDLED_NODE}`);
  const entry = join(BUNDLE_ROOT, 'apps', 'daemon', 'bin.js');
  const result = spawnSync(BUNDLED_NODE, [entry, '--help'], { cwd: BUNDLE_ROOT, encoding: 'utf8', env: minimalEnv() });
  assert.equal(result.status, 0, `daemon --help must exit 0, saw ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /--data-dir/);
  assert.match(result.stdout, /--rules/);
  assert.match(result.stdout, /--mock/);
  assert.equal(result.stderr, '');
});

test('bundle: the console shell serves the page and proxies /healthz to the daemon', async () => {
  requireBundle();
  const dataDir = mkdtempSync(join(tmpdir(), 'aegis-v14-'));
  const bundle = readJson(join(BUNDLE_ROOT, 'bundle.json'));
  const daemon = spawn(BUNDLED_NODE, [
    join(BUNDLE_ROOT, ...bundle.paths.daemonEntry.split('/')),
    '--data-dir', dataDir,
    '--rules', join(BUNDLE_ROOT, ...bundle.paths.rules.split('/')),
    '--mock',
  ], { cwd: BUNDLE_ROOT, env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let transcript = '';
  daemon.stdout.setEncoding('utf8');
  daemon.stderr.setEncoding('utf8');
  daemon.stdout.on('data', (chunk) => { transcript += chunk; });
  daemon.stderr.on('data', (chunk) => { transcript += chunk; });

  let shell;
  try {
    const port = await waitForPort(() => transcript);
    const health = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200, `expected /healthz 200, saw ${health.status}`);

    shell = spawn(BUNDLED_NODE, [
      join(BUNDLE_ROOT, ...bundle.paths.consoleServer.split('/')),
      '--daemon', `http://127.0.0.1:${port}`,
      '--port', '0',
    ], { cwd: BUNDLE_ROOT, env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let shellOut = '';
    shell.stdout.setEncoding('utf8');
    shell.stderr.setEncoding('utf8');
    shell.stdout.on('data', (chunk) => { shellOut += chunk; });
    shell.stderr.on('data', (chunk) => { shellOut += chunk; });
    const shellURL = await waitForListening(() => shellOut);

    const page = await fetchText(`${shellURL}index.html`);
    assert.equal(page.status, 200);
    assert.match(page.body, /网域智防/, 'the served page must be the console page');
    assert.match(page.body, /serve\.mjs|app\.js/, 'the page must reference the shipped script');

    // The shell proxies the daemon surface; 200 here proves the path is wired,
    // not merely that a file exists.
    const proxied = await fetchText(`${shellURL}healthz`);
    assert.equal(proxied.status, 200, `shell /healthz must proxy to the daemon, saw ${proxied.status}`);
    assert.match(proxied.body, /"status"/);

    // A traversal attempt must not read outside the console directory.
    const escape = await fetchText(`${shellURL}..%2f..%2fbundle.json`);
    assert.equal(escape.status, 404, `path traversal must be refused, saw ${escape.status}`);
  } finally {
    if (shell !== undefined) shell.kill();
    daemon.kill();
    await delay(200);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function delay(ms) {
  return new Promise((done) => { setTimeout(done, ms); });
}

/** Wait for the daemon's `daemon ready` line and return its loopback port. */
async function waitForPort(read) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const line of read().split(/\r?\n/)) {
      if (line.trim() === '' || !line.startsWith('{')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.message === 'daemon ready' && Number.isInteger(record.port) && record.port > 0) return record.port;
    }
    await delay(100);
  }
  throw new Error(`the daemon never reported a port; transcript:\n${read().slice(-2000)}`);
}

/** Wait for the shell's `listening` line and return its URL. */
async function waitForListening(read) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const match = /"listening":\s*"(http:\/\/127\.0\.0\.1:\d+\/)"/u.exec(read());
    if (match !== null) return match[1];
    await delay(100);
  }
  throw new Error(`the console shell never reported a listening address; transcript:\n${read().slice(-2000)}`);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: 'manual' });
  return { status: response.status, body: await response.text() };
}

async function fetchJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}
