#!/usr/bin/env node
/**
 * Build `AIDriven-NetDefense-<label>-win-x64-portable.zip` from the already-built
 * v13 payload plus the portable launcher assets (author PT-dove).
 *
 * Design rules, all of them load-bearing:
 *
 * 1. The payload is opened read-only and never copied through a staging tree —
 *    nothing here can rewrite a payload byte, and the archive is assembled from
 *    the payload's own paths.
 * 2. The payload is *identified*, not assumed: its file count, its `bundle.json`
 *    hash and its `manifests/files.sha256` row count are recorded in the report,
 *    and two independent counts must agree before a zip is written.
 * 3. The archive is deterministic (see `lib/zip-write.mjs`), so the same payload
 *    and the same assets always produce the same sha256.
 * 4. `SHA256SUMS` covers the *added* files plus the payload files a consumer would
 *    check first; it deliberately does not cover all 47 107 payload files, because
 *    the payload already ships `manifests/files.sha256` for that. The two scopes
 *    are stated in the README and in status/DIST-PACKAGE.md.
 *
 * usage:
 *   node scripts/release/pack-portable.mjs \
 *     [--payload <dir>] [--assets <dir>] [--out <zip>] \
 *     [--label <label>] [--report <json>] [--level <1-9>] [--expect-payload-files <n>]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeZipSync } from './lib/zip-write.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const DEFAULT_PAYLOAD = resolve(REPO_ROOT, 'vendor', 'payloads', 'win32-x64-v13');
export const DEFAULT_LABEL = '0.0.1-rc.1';

/** Payload identity recorded by M8-PORTABILITY / M8-REPRODUCIBILITY (v13). */
export const EXPECTED_PAYLOAD = {
  files: 47107,
  bytes: 451070970,
  bundleJsonSha256: '32ecb3c14c95ed28e91c34cd9cfe15dc09c51ee27b81ff38b92871f762eccb4e',
  manifestRows: 46921,
  manifestDirFiles: 186,
};

/**
 * Payload files a consumer is most likely to want to verify by hand. Everything
 * else is covered by `manifests/files.sha256`, which is itself covered here.
 */
export const KEY_PAYLOAD_FILES = [
  'bundle.json',
  'launch/aegis-harness-worker.cmd',
  'launch/launch-plan.json',
  'launch/prepare-attempt.mjs',
  'manifests/files.sha256',
  'runtime/node/node.exe',
  'runtime/node/runtime.json',
];

/** Files this package adds on top of the payload. */
const ADDED_PATHS = [
  'README-快速开始.txt',
  'start.cmd',
  'stop.cmd',
  'launcher/aidnd-launch.mjs',
  'launcher/aidnd-stop.mjs',
  'launcher/lib/attempt.mjs',
  'launcher/lib/version.mjs',
];

function parseArgs(argv) {
  const options = {
    payload: DEFAULT_PAYLOAD,
    assets: join(HERE, 'assets'),
    out: join(REPO_ROOT, 'dist', 'portable', DEFAULT_LABEL, `AIDriven-NetDefense-${DEFAULT_LABEL}-win-x64-portable.zip`),
    label: DEFAULT_LABEL,
    report: undefined,
    level: 6,
    expectPayloadFiles: EXPECTED_PAYLOAD.files,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--payload') options.payload = argv[++index];
    else if (arg === '--assets') options.assets = argv[++index];
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--label') options.label = argv[++index];
    else if (arg === '--report') options.report = argv[++index];
    else if (arg === '--level') options.level = Number(argv[++index]);
    else if (arg === '--expect-payload-files') options.expectPayloadFiles = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/release/pack-portable.mjs [--payload d] [--assets d] [--out z] [--label s] [--report j] [--level 1-9]\n');
      process.exit(0);
    } else {
      process.stderr.write(`pack-portable: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.level) || options.level < 1 || options.level > 9) {
    process.stderr.write('pack-portable: --level must be 1-9\n');
    process.exit(2);
  }
  return options;
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Every file under `root`, as sorted forward-slash relative paths. */
export function listFiles(root) {
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  const payload = resolve(options.payload);
  const assets = resolve(options.assets);
  const out = resolve(options.out);

  if (!existsSync(join(payload, 'bundle.json'))) {
    process.stderr.write(`pack-portable: not a payload directory (bundle.json missing): ${payload}\n`);
    process.exit(1);
  }
  if (!existsSync(join(assets, 'start.cmd'))) {
    process.stderr.write(`pack-portable: assets directory incomplete: ${assets}\n`);
    process.exit(1);
  }
  if (out.startsWith(`${payload}${sep}`)) {
    process.stderr.write('pack-portable: refusing to write the archive inside the payload\n');
    process.exit(1);
  }

  const startedAt = Date.now();
  const payloadFiles = listFiles(payload);
  const payloadBytes = payloadFiles.reduce((total, relative) => total + statSync(join(payload, ...relative.split('/'))).size, 0);
  const bundleJsonSha256 = sha256OfFile(join(payload, 'bundle.json'));

  // Two counts that must agree: the tree walk, and the payload's own manifest +
  // the manifest directory that the manifest excludes. A tree that lost or gained
  // a file fails here instead of shipping.
  const manifestRows = readFileSync(join(payload, 'manifests', 'files.sha256'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#')).length;
  const manifestDirFiles = listFiles(join(payload, 'manifests')).length;

  const identity = {
    path: payload,
    files: payloadFiles.length,
    bytes: payloadBytes,
    bundleJsonSha256,
    manifestRows,
    manifestDirFiles,
    expected: EXPECTED_PAYLOAD,
    /**
     * `files.sha256` covers everything except `manifests/` itself, so the tree is
     * those rows plus the manifest directory. Stating the identity this way keeps
     * the count check meaningful even if the payload is later rebuilt.
     */
    identityHolds: manifestRows + manifestDirFiles === payloadFiles.length,
    matchesRecordedV13: bundleJsonSha256 === EXPECTED_PAYLOAD.bundleJsonSha256,
  };

  process.stdout.write(`payload: ${payload}\n`);
  process.stdout.write(`  files ${payloadFiles.length}, bytes ${payloadBytes}, bundle.json ${bundleJsonSha256}\n`);
  process.stdout.write(`  manifest rows ${manifestRows} + manifests/ ${manifestDirFiles} = ${manifestRows + manifestDirFiles} (tree ${payloadFiles.length})\n`);

  if (!identity.identityHolds) {
    process.stderr.write('pack-portable: payload file count does not reconcile with its own manifest\n');
    process.exit(1);
  }
  if (options.expectPayloadFiles !== 0 && payloadFiles.length !== options.expectPayloadFiles) {
    process.stderr.write(`pack-portable: payload has ${payloadFiles.length} files, expected ${options.expectPayloadFiles}\n`);
    process.exit(1);
  }
  // `--expect-payload-files 0` is the documented escape hatch for a deliberately
  // different payload (and for the synthetic payloads the tests build). It must be
  // visible in the report, not silent.
  if (options.expectPayloadFiles === 0) {
    process.stdout.write('  WARNING: payload identity not pinned (--expect-payload-files 0)\n');
  } else if (!identity.matchesRecordedV13) {
    process.stderr.write('pack-portable: bundle.json differs from the recorded v13 hash\n');
    process.exit(1);
  }

  // ---- added files ---------------------------------------------------------
  // `SHA256SUMS` is generated here, so it is never picked up from a previous run.
  const addedFiles = listFiles(assets).filter((relative) => relative !== 'SHA256SUMS');
  for (const required of ADDED_PATHS) {
    if (!addedFiles.includes(required)) {
      process.stderr.write(`pack-portable: asset missing: ${required}\n`);
      process.exit(1);
    }
  }
  const collisions = addedFiles.filter((relative) => payloadFiles.includes(relative));
  if (collisions.length > 0) {
    process.stderr.write(`pack-portable: added files collide with payload paths: ${collisions.join(', ')}\n`);
    process.exit(1);
  }

  // ---- SHA256SUMS ----------------------------------------------------------
  const sumsTargets = [...addedFiles, ...KEY_PAYLOAD_FILES].sort();
  const sumsLines = sumsTargets.map((relative) => {
    const absolute = addedFiles.includes(relative)
      ? join(assets, ...relative.split('/'))
      : join(payload, ...relative.split('/'));
    if (!existsSync(absolute)) throw new Error(`SHA256SUMS target missing: ${relative}`);
    return `${sha256OfFile(absolute)}  ${relative}`;
  });
  const sumsText = [
    '# AIDriven NetDefense portable package — key file checksums',
    '# scope: the files this package adds + the payload files a consumer checks first.',
    '# the full payload is covered by manifests/files.sha256 (46 921 rows); this list is not a replacement for it.',
    '# format: <sha256><two spaces><path relative to the package root>',
    '',
    ...sumsLines,
    '',
  ].join('\n');
  const sumsPath = join(assets, 'SHA256SUMS');
  writeFileSync(sumsPath, sumsText);

  // ---- assemble ------------------------------------------------------------
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
  writeFileSync(`${out}.sha256`, `${zipSha256}  ${out.split(/[\\/]/).pop()}\n`);

  const report = {
    schemaVersion: '1.0',
    author: 'PT-dove',
    generatedAt: new Date().toISOString(),
    label: options.label,
    productVersion: '0.0.0',
    frozen: false,
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
      addedFiles: addedFiles.length + 1, // + SHA256SUMS itself
      zipFiles: payloadFiles.length + addedFiles.length + 1,
    },
    payload: identity,
    sha256sums: {
      path: 'SHA256SUMS',
      rows: sumsLines.length,
      scope: 'added files + key payload files',
      coversWholePayload: false,
      wholePayloadManifest: 'manifests/files.sha256',
    },
    addedFiles: [...addedFiles, 'SHA256SUMS'].sort(),
    timings: { totalMs: Date.now() - startedAt, zipMs: writeMs },
  };

  if (options.report !== undefined) {
    mkdirSync(dirname(resolve(options.report)), { recursive: true });
    writeFileSync(resolve(options.report), `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`zip: ${out}\n`);
  process.stdout.write(`  bytes ${zipBytes}, sha256 ${zipSha256}\n`);
  process.stdout.write(`  entries ${written.entries} = payload ${payloadFiles.length} + added ${addedFiles.length + 1}\n`);
  process.stdout.write(`  SHA256SUMS rows ${sumsLines.length}\n`);
  process.stdout.write(`${JSON.stringify(report.counts)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
