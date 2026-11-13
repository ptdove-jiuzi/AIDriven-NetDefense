/**
 * v14-selfcheck.mjs — the four acceptance checks the v14 payload has to pass on
 * its own bytes (author PT-dove).
 *
 * Why a script instead of four ad-hoc commands: each check has a failure mode that
 * a human reading a terminal transcript can miss — `--help` exiting 0 while
 * writing to stderr, a daemon that prints a port but never answers `/healthz`, a
 * console page that exists but is empty, a manifest that verifies only because it
 * lists nothing. Every one of those is asserted below, and the script exits
 * non-zero when any check fails.
 *
 * The checks are deliberately run against the **bundled** Node (`runtime/node/node.exe`),
 * not the host's: the whole point of the payload is that the host has no Node.
 *
 * usage: node tests/packaging/v14-selfcheck.mjs [--bundle <dir>] [--json]
 *
 * Exit 0 = all four checks passed. Exit 1 = at least one failed (details on stdout).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stop, trackedSpawn } from './child-reaper.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function parseArgs(argv) {
  const options = { bundle: join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v14'), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--bundle') options.bundle = resolve(argv[++index] ?? '');
    else if (token === '--json') options.json = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

/** A PATH with no Node on it: the payload must not depend on the host. */
function sanitizedEnv(extra = {}) {
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

function delay(ms) {
  return new Promise((done) => { setTimeout(done, ms); });
}

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', fail);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => done(hash.digest('hex')));
  });
}

/** 1. `node <bundle>/apps/daemon/bin.js --help` must exit 0 and print the three flags. */
function checkDaemonHelp({ bundle, node }) {
  const entry = join(bundle, 'apps', 'daemon', 'bin.js');
  if (!existsSync(entry)) return { ok: false, detail: `missing daemon entry: ${relative(bundle, entry)}` };
  const result = spawnSync(node, [entry, '--help'], { cwd: bundle, encoding: 'utf8', env: sanitizedEnv() });
  const missing = ['--data-dir', '--rules', '--mock'].filter((flag) => !result.stdout.includes(flag));
  const ok = result.status === 0 && missing.length === 0 && result.stderr.trim() === '';
  return {
    ok,
    exitCode: result.status,
    missingFlags: missing,
    stderrEmpty: result.stderr.trim() === '',
    stdoutFirstLine: result.stdout.split(/\r?\n/)[0],
    detail: ok ? 'exit 0, help lists --data-dir/--rules/--mock, stderr empty' : 'help contract not met',
    command: `"${node}" "${entry}" --help`,
  };
}

/**
 * 2. Start the daemon and require /healthz 200.
 *
 * Two invocations are exercised, and the first one is expected to *fail*:
 *
 * - `--rules <bundle>/rules/defense-seed-pack.json` is refused by the daemon with
 *   CONFIG_PATH_ESCAPE, because `detection.rulePackPath` is resolved inside the
 *   data directory. That containment is a daemon invariant (nothing it reads may
 *   live outside its one writable root), not a packaging defect — but a bundle
 *   that documents this argv would be documenting a command that cannot work, so
 *   the refusal is asserted here instead of being discovered by an operator.
 * - The packaged seeder (`launch/seed-rules.mjs`) copies the built-in packs into
 *   `<data dir>/rules/` after re-hashing them against `manifests/rule-packs.json`;
 *   the daemon then starts on the in-data-dir path and answers `/healthz` 200.
 */
async function checkDaemonHealth({ bundle, node }) {
  const entry = join(bundle, 'apps', 'daemon', 'bin.js');
  const rules = join(bundle, 'rules', 'defense-seed-pack.json');
  const seeder = join(bundle, 'launch', 'seed-rules.mjs');
  if (!existsSync(rules)) return { ok: false, detail: 'missing bundled rule pack' };
  const dataDir = mkdtempSync(join(tmpdir(), 'aegis-v14-selfcheck-'));
  const context = {
    literalCommand: `"${node}" "${entry}" --data-dir <temp> --rules "${rules}" --mock`,
    rulesRelative: relative(bundle, rules).split(sep).join('/'),
  };
  const literal = spawnSync(node, [entry, '--data-dir', dataDir, '--rules', rules, '--mock'], {
    cwd: bundle, encoding: 'utf8', env: sanitizedEnv(), timeout: 30000,
  });
  context.literalExit = literal.status;
  context.literalStderr = (literal.stderr ?? '').trim().split(/\r?\n/).slice(-1)[0] ?? '';
  const literalRefused = literal.status === 2 && /must stay inside the data directory/.test(literal.stderr ?? '');
  if (!literalRefused) {
    rmSync(dataDir, { recursive: true, force: true });
    return {
      ok: false, ...context,
      detail: 'the out-of-data-directory --rules path was not refused as documented; the daemon contract changed',
    };
  }
  if (!existsSync(seeder)) {
    rmSync(dataDir, { recursive: true, force: true });
    return { ok: false, ...context, detail: 'missing launch/seed-rules.mjs, so the bundled pack cannot reach a data directory' };
  }
  const seeded = spawnSync(node, [seeder, '--data-dir', dataDir], { cwd: bundle, encoding: 'utf8', env: sanitizedEnv(), timeout: 30000 });
  context.seederExit = seeded.status;
  context.seederStdout = (seeded.stdout ?? '').trim().slice(0, 600);
  if (seeded.status !== 0) {
    rmSync(dataDir, { recursive: true, force: true });
    return { ok: false, ...context, detail: `seed-rules failed: ${(seeded.stderr ?? '').trim().slice(0, 400)}` };
  }
  const seededRules = join(dataDir, 'rules', 'defense-seed-pack.json');
  if (!existsSync(seededRules)) {
    rmSync(dataDir, { recursive: true, force: true });
    return { ok: false, ...context, detail: `seed-rules did not produce ${seededRules}` };
  }
  const child = trackedSpawn(node, [entry, '--data-dir', dataDir, '--rules', seededRules, '--mock'], {
    cwd: bundle, env: sanitizedEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let transcript = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { transcript += chunk; });
  child.stderr.on('data', (chunk) => { transcript += chunk; });
  const record = {
    ...context,
    command: `"${node}" "${seeder}" --data-dir <temp> && "${node}" "${entry}" --data-dir <temp> --rules <temp>/rules/defense-seed-pack.json --mock`,
  };
  try {
    let port;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && port === undefined) {
      for (const line of transcript.split(/\r?\n/)) {
        if (!line.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line);
          // The daemon's log records use `msg`; older-shaped records used `message`.
          // Accepting both keeps this check about the daemon's behaviour rather than
          // about one field name.
          const text = parsed.msg ?? parsed.message;
          if (text === 'daemon ready' && Number.isInteger(parsed.port) && parsed.port > 0) port = parsed.port;
        } catch { /* not a log record */ }
      }
      if (port === undefined) await delay(100);
    }
    record.port = port ?? null;
    if (port === undefined) return { ok: false, ...record, detail: `daemon never reported a port; transcript tail: ${transcript.slice(-500)}` };
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await response.text();
    record.healthz = response.status;
    record.healthzBody = body.slice(0, 400);
    return { ok: response.status === 200, ...record, detail: response.status === 200 ? '/healthz answered 200' : `/healthz answered ${response.status}` };
  } finally {
    // Wait for the daemon to be gone, not merely for `kill()` to return: the pipes
    // stay attached to this process until it exits, and an un-reaped daemon would
    // keep the self-check from ever finishing.
    await stop(child, 'selfcheck daemon');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 3. The console page must be readable and must be the page that references the shipped script. */
async function checkConsole({ bundle, node }) {
  const page = join(bundle, 'console', 'index.html');
  if (!existsSync(page)) return { ok: false, detail: 'missing console/index.html' };
  const html = readFileSync(page, 'utf8');
  const script = join(bundle, 'console', 'serve.mjs');
  const record = {
    bytes: Buffer.byteLength(html),
    referencesAppJs: /src="app\.js"/.test(html),
    title: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null,
    command: `GET /index.html via console/serve.mjs`,
  };
  // Serving it is the part that proves an operator can actually open it: a file
  // on disk with no server is not a UI.
  if (!existsSync(script)) return { ok: false, ...record, detail: 'missing console/serve.mjs, so the page cannot be served' };
  const child = trackedSpawn(node, [script, '--daemon', 'http://127.0.0.1:9', '--port', '0'], {
    cwd: bundle, env: sanitizedEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  try {
    let url;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && url === undefined) {
      const match = /"listening":\s*"(http:\/\/127\.0\.0\.1:\d+\/)"/u.exec(out);
      if (match !== null) url = match[1];
      else await delay(100);
    }
    if (url === undefined) return { ok: false, ...record, detail: `console shell never listened: ${out.slice(-400)}` };
    record.url = url;
    const response = await fetch(`${url}index.html`);
    const body = await response.text();
    record.status = response.status;
    record.servedBytes = Buffer.byteLength(body);
    const ok = response.status === 200 && record.servedBytes > 1000 && /app\.js/.test(body);
    return { ok, ...record, detail: ok ? 'index.html served over loopback and references app.js' : 'served page does not look like the console' };
  } finally {
    await stop(child, 'selfcheck console');
  }
}

/** 4. Every row of files.sha256 must match the disk, and nothing outside manifests/ may be unlisted. */
async function checkManifest({ bundle }) {
  const manifestPath = join(bundle, 'manifests', 'files.sha256');
  if (!existsSync(manifestPath)) return { ok: false, detail: 'missing manifests/files.sha256' };
  const rows = readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter((line) => line !== '' && !line.startsWith('#'));
  const listed = new Set();
  const mismatched = [];
  const malformed = [];
  for (const row of rows) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(row);
    if (match === null) { malformed.push(row); continue; }
    const [, digest, path] = match;
    listed.add(path);
    const absolute = join(bundle, ...path.split('/'));
    if (!existsSync(absolute)) { mismatched.push(`${path} (missing)`); continue; }
    const actual = await sha256File(absolute);
    if (actual !== digest) mismatched.push(`${path} (${digest.slice(0, 12)} != ${actual.slice(0, 12)})`);
  }
  const unlisted = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const next = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (next === 'manifests') continue;
      if (entry.isDirectory()) walk(join(directory, entry.name), next);
      else if (entry.isFile() && !listed.has(next)) unlisted.push(next);
    }
  };
  walk(bundle, '');
  const ok = rows.length > 1000 && mismatched.length === 0 && unlisted.length === 0 && malformed.length === 0;
  return {
    ok,
    rows: rows.length,
    mismatched: mismatched.slice(0, 10),
    mismatchedCount: mismatched.length,
    unlisted: unlisted.slice(0, 10),
    unlistedCount: unlisted.length,
    malformedCount: malformed.length,
    detail: ok
      ? `${rows.length} rows, 0 mismatch, 0 unlisted, 0 malformed`
      : `${mismatched.length} mismatch / ${unlisted.length} unlisted / ${malformed.length} malformed`,
  };
}

function relative(bundle, path) {
  return path.startsWith(bundle) ? path.slice(bundle.length + 1).split(sep).join('/') : path;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundle = options.bundle;
  const node = join(bundle, 'runtime', 'node', 'node.exe');
  if (!existsSync(node)) throw new Error(`bundled runtime missing: ${node}`);
  const context = { bundle, node };
  const results = [
    { id: 'daemon-help', name: 'a bundled node runs apps/daemon/bin.js --help → exit 0', ...checkDaemonHelp(context) },
    { id: 'daemon-healthz', name: 'the packaged rules are seeded into the data dir and /healthz answers 200', ...(await checkDaemonHealth(context)) },
    { id: 'console', name: 'console/index.html is served and references app.js', ...(await checkConsole(context)) },
    { id: 'manifest', name: 'manifests/files.sha256 verifies every file, 0 mismatches', ...(await checkManifest(context)) },
  ];
  const failed = results.filter((check) => !check.ok);
  const summary = {
    schemaVersion: '1.0',
    author: 'PT-dove',
    bundle,
    bundledNode: (() => {
      const result = spawnSync(node, ['-v'], { encoding: 'utf8', env: sanitizedEnv() });
      return result.stdout.trim();
    })(),
    checks: results.map(({ id, name, ok, detail, ...rest }) => ({ id, name, ok, detail, evidence: rest })),
    passed: results.length - failed.length,
    failed: failed.length,
    ok: failed.length === 0,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const check of results) {
      process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.id}  ${check.detail}\n`);
    }
    process.stdout.write(`\n${summary.passed}/${results.length} checks passed\n`);
  }
  if (!summary.ok) process.exitCode = 1;
}

await main().catch((error) => {
  process.stderr.write(`v14-selfcheck: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
