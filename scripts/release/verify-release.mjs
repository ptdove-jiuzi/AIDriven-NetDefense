#!/usr/bin/env node
/**
 * Independent gate between "packed" and "uploaded".
 *
 * `finalize-release.mjs` writes the manifest; this script re-derives everything from
 * the bytes on disk and refuses to let the workflow continue if the two disagree.
 * Running it in a separate process is the point — a manifest that verifies itself in
 * the same process that wrote it proves only that the process is self-consistent.
 *
 * What is checked, each as a separately reported line:
 *
 *   1. `latest.json` parses and has exactly the ADR-0011 field set (no extras, none
 *      missing) — an extra field is a contract change the client does not know about;
 *   2. `version` equals the tag version the caller passed;
 *   3. `minVersion` is a string; empty means "no floor published" and is valid, a
 *      non-empty value must parse as a version;
 *   4. both asset files exist, are non-empty, and their size + sha256 equal the
 *      values in `latest.json`;
 *   5. each asset URL points at this repository's release for this tag and ends with
 *      the asset name (the client refuses cross-host and cross-release URLs, so a
 *      manifest that would be rejected at run time must not ship).  The expected
 *      prefix is built from ``UPDATE_REPO_NAME`` in
 *      ``apps/desktop/updater/constants.py`` — **not** from ``--repo``.  Building it
 *      from the argument would make the check circular: it would pass whatever
 *      spelling the caller and the manifest happened to agree on.
 *   5b. ``--repo`` itself must be ``ptdove-jiuzi`` + that same whitelisted name, so a
 *      typo in the workflow file is a failure here rather than a 404 after upload;
 *   6. `SHA256SUMS.txt` lists the same two packages with the same hashes.
 *
 * usage:
 *   node scripts/release/verify-release.mjs --dir <release-dir> --version <ver>
 *     --repo <owner/name> --tag <tag>
 *
 * Author: PT-dove
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
/** The update client's own whitelist; the only authority on how the repo is spelled. */
const UPDATER_CONSTANTS = join(REPO_ROOT, 'apps', 'desktop', 'updater', 'constants.py');

const EXPECTED_FIELDS = ['version', 'notes', 'minVersion', 'assets'];

/**
 * Read `UPDATE_REPO_NAME` from the updater the release is built for.
 *
 * Without this the whole URL check is circular: the expected prefix is built from
 * `--repo`, so whatever the caller passes "verifies". Anchoring the *name* to the
 * constant the shipped client actually compares against is what turns the check into
 * evidence — the client refuses an asset URL whose repo differs, so a manifest that
 * would be refused at run time must not pass here.
 */
function updaterRepoName() {
  if (!existsSync(UPDATER_CONSTANTS)) return null;
  const text = readFileSync(UPDATER_CONSTANTS, 'utf8');
  const match = /UPDATE_REPO_NAME\s*=\s*"([^"]+)"/.exec(text);
  return match ? match[1] : null;
}

function parseArgs(argv) {
  const options = { dir: undefined, version: undefined, repo: undefined, tag: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') options.dir = argv[++index];
    else if (arg === '--version') options.version = argv[++index];
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--tag') options.tag = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/release/verify-release.mjs --dir d --version v --repo owner/name --tag t\n');
      process.exit(0);
    } else {
      process.stderr.write(`verify-release: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  for (const key of ['dir', 'version', 'repo', 'tag']) {
    if (!options[key]) {
      process.stderr.write(`verify-release: --${key} is required\n`);
      process.exit(2);
    }
  }
  return options;
}

function sha256OfFile(path) {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let read = 0;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

const LOOSE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.dir);
  const failures = [];
  const notes = [];

  const record = (ok, message) => {
    notes.push(`${ok ? 'ok  ' : 'FAIL'}  ${message}`);
    if (!ok) failures.push(message);
  };

  // 1. manifest shape
  const manifestPath = join(dir, 'latest.json');
  if (!existsSync(manifestPath)) {
    record(false, 'latest.json missing');
    process.stdout.write(notes.join('\n') + '\n');
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    record(false, `latest.json is not valid JSON: ${error.message}`);
    process.stdout.write(notes.join('\n') + '\n');
    process.exit(1);
  }

  const keys = Object.keys(manifest).sort();
  record(
    JSON.stringify(keys) === JSON.stringify([...EXPECTED_FIELDS].sort()),
    `latest.json fields == ${EXPECTED_FIELDS.join(', ')} (got ${keys.join(', ') || 'nothing'})`,
  );

  // 2. version
  record(manifest.version === options.version, `version matches the tag suite (${manifest.version} vs ${options.version})`);

  // 3. minVersion
  const minVersion = manifest.minVersion;
  if (typeof minVersion !== 'string') {
    record(false, `minVersion must be a string, got ${typeof minVersion}`);
  } else if (minVersion === '') {
    record(true, 'minVersion is empty ("no security floor published")');
  } else {
    record(LOOSE_VERSION.test(minVersion), `minVersion parses as a version (${minVersion})`);
  }

  // 4/5. assets
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  record(assets.length === 2, `assets has 2 entries (got ${assets.length})`);

  // The repo name is taken from the updater, not from `--repo`: a check whose expected
  // value comes from the argument it is checking proves only self-consistency.
  const canonicalName = updaterRepoName();
  record(canonicalName !== null, `updater whitelist readable (${canonicalName ?? 'constants.py not found'})`);
  const [owner, repoName] = String(options.repo).split('/');
  record(owner === 'ptdove-jiuzi', `--repo owner is ptdove-jiuzi (got ${owner})`);
  record(repoName === canonicalName, `--repo name matches the updater whitelist (${repoName} vs ${canonicalName})`);
  const canonicalRepo = canonicalName ? `ptdove-jiuzi/${canonicalName}` : options.repo;

  const base = `https://github.com/${canonicalRepo}/releases/download/${encodeURIComponent(options.tag)}`;
  const seen = new Map();
  for (const asset of assets) {
    const name = String(asset.name ?? '');
    const path = join(dir, name);
    if (!existsSync(path)) {
      record(false, `${name || '(unnamed)'} exists in the release directory`);
      continue;
    }
    const size = statSync(path).size;
    record(size === asset.size, `${name} size ${size} == manifest ${asset.size}`);
    const digest = sha256OfFile(path);
    record(digest === asset.sha256, `${name} sha256 matches manifest`);
    record(String(asset.url ?? '').startsWith(`${base}/`) && String(asset.url).endsWith(`/${name}`),
      `${name} url points at ${base}/<name> (prefix from apps/desktop/updater/constants.py)`);
    record(name.includes(options.version), `${name} carries the version ${options.version}`);
    seen.set(name, digest);
  }

  // 6. SHA256SUMS
  const sumsPath = join(dir, 'SHA256SUMS.txt');
  if (!existsSync(sumsPath)) {
    record(false, 'SHA256SUMS.txt missing');
  } else {
    const rows = readFileSync(sumsPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map((line) => {
        const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line);
        return match ? { sha256: match[1], name: match[2].trim() } : null;
      });
    record(rows.every((row) => row !== null), 'SHA256SUMS.txt rows are well formed');
    const valid = rows.filter(Boolean);
    record(valid.length === 2, `SHA256SUMS.txt has 2 rows (got ${valid.length})`);
    for (const row of valid) {
      record(seen.get(row.name) === row.sha256, `SHA256SUMS agrees with latest.json for ${row.name}`);
    }
  }

  process.stdout.write(notes.join('\n') + '\n');
  if (failures.length > 0) {
    process.stderr.write(`verify-release: ${failures.length} check(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write('verify-release: all checks passed\n');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
