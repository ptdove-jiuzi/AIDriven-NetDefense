#!/usr/bin/env node
/**
 * Build `AIDrivenNetDefense-<ver>-win-x64-portable.zip` from a payload directory.
 *
 * This is the release-pipeline entry point.  It differs from `pack-portable.mjs`
 * (which produced the 0.0.1-rc.1 test package) in exactly one way: it does **not**
 * pin the recorded v13 identity.  The payload is now rebuilt by CI on every tag, so
 * a pinned hash would either fail every run or be widened until it proved nothing.
 * What replaces it is the invariant that actually matters and can hold for any
 * payload:
 *
 *   the tree walk, the payload's own `manifests/files.sha256`, and the number of
 *   files in `manifests/` must reconcile (`rows + manifestsFiles === treeFiles`).
 *
 * A tree that lost or gained a file fails that check, which is the failure mode a
 * pinned hash was protecting against in the first place.
 *
 * Naming is per `DIST-DECISION.md` §1: `AIDrivenNetDefense-<ver>-win-x64-portable.zip`
 * (product name without spaces), matching the Setup.exe stem.
 *
 * Determinism: entries are sorted and written with fixed timestamps by
 * `lib/zip-write.mjs`, so the same payload and the same assets produce the same
 * sha256.  That property is what lets `latest.json` quote a hash computed before
 * upload and still be true afterwards.
 *
 * usage:
 *   node scripts/release/pack-portable-release.mjs \
 *     --payload <dir> --version <ver> --out <zip> [--assets <dir>]
 *     [--level 1-9] [--report <json>]
 *
 * Author: PT-dove
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeZipSync } from './lib/zip-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/** Files this package adds on top of the payload (the portable launcher set). */
const ADDED_PATHS = [
  'README-快速开始.txt',
  'start.cmd',
  'stop.cmd',
  'launcher/aidnd-launch.mjs',
  'launcher/aidnd-stop.mjs',
  'launcher/lib/attempt.mjs',
  'launcher/lib/version.mjs',
];

/** Payload files a consumer is most likely to verify by hand. */
const KEY_PAYLOAD_FILES = [
  'bundle.json',
  'launch/launch-plan.json',
  'launch/aegis-harness-worker.cmd',
  'manifests/files.sha256',
  'runtime/node/node.exe',
  'runtime/node/runtime.json',
];

function parseArgs(argv) {
  const options = {
    payload: undefined,
    version: undefined,
    out: undefined,
    assets: join(HERE, 'assets'),
    level: 6,
    report: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--payload') options.payload = argv[++index];
    else if (arg === '--version') options.version = argv[++index];
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--assets') options.assets = argv[++index];
    else if (arg === '--level') options.level = Number(argv[++index]);
    else if (arg === '--report') options.report = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/release/pack-portable-release.mjs --payload d --version v --out z [--assets d] [--level 1-9] [--report j]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`pack-portable-release: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  for (const key of ['payload', 'version', 'out']) {
    if (!options[key]) {
      process.stderr.write(`pack-portable-release: --${key} is required\n`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.level) || options.level < 1 || options.level > 9) {
    process.stderr.write('pack-portable-release: --level must be 1-9\n');
    process.exit(2);
  }
  return options;
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file under `root`, as sorted forward-slash relative paths. */
function listFiles(root) {
  const found = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
      else throw new Error(`unsupported filesystem entry: ${relative}`);
    }
  };
  walk(root, '');
  found.sort();
  return found;
}

function fail(message) {
  process.stderr.write(`pack-portable-release: ${message}\n`);
  process.exit(1);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = resolve(options.payload);
  const assets = resolve(options.assets);
  const out = resolve(options.out);
  const version = options.version;

  if (!existsSync(join(payload, 'bundle.json'))) fail(`not a payload directory (bundle.json missing): ${payload}`);
  if (!existsSync(join(assets, 'start.cmd'))) fail(`assets directory incomplete: ${assets}`);
  if (out.toLowerCase().startsWith(`${payload.toLowerCase()}${sep}`)) fail('refusing to write the archive inside the payload');

  const startedAt = Date.now();
  const payloadFiles = listFiles(payload);
  const payloadBytes = payloadFiles.reduce((total, relative) => total + statSync(join(payload, ...relative.split('/'))).size, 0);
  const bundleJsonSha256 = sha256OfFile(join(payload, 'bundle.json'));

  const manifestRows = readFileSync(join(payload, 'manifests', 'files.sha256'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#')).length;
  const manifestDirFiles = listFiles(join(payload, 'manifests')).length;

  process.stdout.write(`payload: ${payload}\n`);
  process.stdout.write(`  files ${payloadFiles.length}, bytes ${payloadBytes}, bundle.json ${bundleJsonSha256}\n`);
  process.stdout.write(`  manifest rows ${manifestRows} + manifests/ ${manifestDirFiles} = ${manifestRows + manifestDirFiles}\n`);

  if (manifestRows + manifestDirFiles !== payloadFiles.length) {
    fail('payload file count does not reconcile with its own manifest (tree lost or gained a file)');
  }

  const addedFiles = listFiles(assets).filter((relative) => relative !== 'SHA256SUMS');
  for (const required of ADDED_PATHS) {
    if (!addedFiles.includes(required)) fail(`asset missing: ${required}`);
  }
  const collisions = addedFiles.filter((relative) => payloadFiles.includes(relative));
  if (collisions.length > 0) fail(`added files collide with payload paths: ${collisions.join(', ')}`);

  const sumsTargets = [...addedFiles, ...KEY_PAYLOAD_FILES].sort();
  const sumsLines = sumsTargets.map((relative) => {
    const absolute = addedFiles.includes(relative)
      ? join(assets, ...relative.split('/'))
      : join(payload, ...relative.split('/'));
    if (!existsSync(absolute)) throw new Error(`SHA256SUMS target missing: ${relative}`);
    return `${sha256OfFile(absolute)}  ${relative}`;
  });
  const sumsPath = join(assets, 'SHA256SUMS');
  writeFileSync(
    sumsPath,
    [
      '# AIDriven NetDefense portable package — key file checksums',
      '# scope: the files this package adds + the payload files a consumer checks first.',
      '# the whole payload is covered by manifests/files.sha256; this list is not a replacement.',
      '# format: <sha256><two spaces><path relative to the package root>',
      '',
      ...sumsLines,
      '',
    ].join('\n'),
  );

  const entries = [
    ...payloadFiles.map((relative) => ({ name: relative, absPath: join(payload, ...relative.split('/')) })),
    ...addedFiles.map((relative) => ({ name: relative, absPath: join(assets, ...relative.split('/')) })),
    { name: 'SHA256SUMS', absPath: sumsPath },
  ];

  mkdirSync(dirname(out), { recursive: true });
  const writeStarted = Date.now();
  const written = writeZipSync({ outPath: out, entries, level: options.level });
  const writeMs = Date.now() - writeStarted;

  const zipBytes = statSync(out).size;
  const zipSha256 = sha256OfFile(out);

  const report = {
    schemaVersion: '1.0',
    author: 'PT-dove',
    generatedAt: new Date().toISOString(),
    version,
    archive: {
      path: out,
      name: out.split(/[\\/]/).pop(),
      bytes: zipBytes,
      sha256: zipSha256,
      entryCount: written.entries,
      compressionLevel: options.level,
    },
    counts: {
      payloadFiles: payloadFiles.length,
      addedFiles: addedFiles.length + 1,
      zipFiles: payloadFiles.length + addedFiles.length + 1,
    },
    payload: {
      path: payload,
      files: payloadFiles.length,
      bytes: payloadBytes,
      bundleJsonSha256,
      manifestRows,
      manifestDirFiles,
      reconciles: true,
    },
    sha256sums: {
      path: 'SHA256SUMS',
      rows: sumsLines.length,
      scope: 'added files + key payload files',
      coversWholePayload: false,
      wholePayloadManifest: 'manifests/files.sha256',
    },
    timings: { totalMs: Date.now() - startedAt, zipMs: writeMs },
  };

  if (options.report !== undefined) {
    mkdirSync(dirname(resolve(options.report)), { recursive: true });
    writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`zip: ${out}\n  bytes ${zipBytes}\n  sha256 ${zipSha256}\n  entries ${written.entries}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
