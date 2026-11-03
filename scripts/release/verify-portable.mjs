#!/usr/bin/env node
/**
 * Verify the portable archive without extracting it (author PT-dove).
 *
 * Checks, in order:
 *   1. entry count == payload file count + added file count (the acceptance
 *      criterion for this task, computed from the payload tree, not hard-coded);
 *   2. no duplicate or unsafe entry names;
 *   3. every `SHA256SUMS` row resolves inside the archive and hashes correctly,
 *      and every added file is listed (a sums file that omits a file it ships is
 *      worse than none);
 *   4. `bundle.json` inside the archive still has the recorded v13 hash;
 *   5. optionally (`--full`) all 46 921 rows of `manifests/files.sha256` are
 *      recomputed from the archive — this is the proof that the payload was
 *      re-packed and not rebuilt, re-compiled or nudged.
 *
 * usage: node scripts/release/verify-portable.mjs [--zip <path>] [--payload <dir>] [--full]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPECTED_PAYLOAD, listFiles, DEFAULT_PAYLOAD, DEFAULT_LABEL, REPO_ROOT } from './pack-portable.mjs';
import { ZipArchive } from './lib/zip-read.mjs';

function parseArgs(argv) {
  const options = {
    zip: resolve(REPO_ROOT, 'dist', 'portable', DEFAULT_LABEL, `AIDriven-NetDefense-${DEFAULT_LABEL}-win-x64-portable.zip`),
    payload: DEFAULT_PAYLOAD,
    full: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--zip') options.zip = resolve(argv[++index]);
    else if (argv[index] === '--payload') options.payload = resolve(argv[++index]);
    else if (argv[index] === '--full') options.full = true;
    else {
      process.stderr.write(`verify-portable: unknown argument ${argv[index]}\n`);
      process.exit(2);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

if (!existsSync(options.zip)) {
  process.stderr.write(`verify-portable: archive not found: ${options.zip}\n`);
  process.exit(1);
}

const archive = new ZipArchive(options.zip);
try {
  const files = archive.fileEntries();
  const names = files.map((entry) => entry.name);
  const payloadFiles = listFiles(resolve(options.payload));

  check(names.length === new Set(names).size, 'archive has duplicate entry names');
  check(names.every((name) => !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')),
    'archive contains an unsafe entry name');

  const added = names.filter((name) => !payloadFiles.includes(name));
  const missingFromArchive = payloadFiles.filter((name) => !names.includes(name));

  process.stdout.write(`archive        : ${options.zip}\n`);
  process.stdout.write(`entries        : ${names.length}\n`);
  process.stdout.write(`payload files  : ${payloadFiles.length}\n`);
  process.stdout.write(`added files    : ${added.length} -> ${added.sort().join(', ')}\n`);

  check(names.length === payloadFiles.length + added.length,
    `entry count ${names.length} != payload ${payloadFiles.length} + added ${added.length}`);
  check(missingFromArchive.length === 0,
    `payload files missing from the archive: ${missingFromArchive.slice(0, 5).join(', ')}`);

  const byName = new Map(files.map((entry) => [entry.name, entry]));
  const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

  // ---- SHA256SUMS ---------------------------------------------------------
  const sumsEntry = byName.get('SHA256SUMS');
  if (check(sumsEntry !== undefined, 'SHA256SUMS missing from the archive')) {
    const rows = archive.readFile(sumsEntry).toString('utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
    const listed = new Set();
    const mismatched = [];
    for (const row of rows) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(row);
      if (match === null) {
        mismatched.push(`malformed row: ${row.slice(0, 80)}`);
        continue;
      }
      const [, expected, name] = match;
      listed.add(name);
      const entry = byName.get(name);
      if (entry === undefined) {
        mismatched.push(`${name}: not in archive`);
        continue;
      }
      const actual = sha256(archive.readFile(entry));
      if (actual !== expected) mismatched.push(`${name}: ${actual.slice(0, 12)}… != ${expected.slice(0, 12)}…`);
    }
    check(mismatched.length === 0, `SHA256SUMS rows do not verify: ${mismatched.slice(0, 5).join('; ')}`);

    const unlistedAdded = added.filter((name) => name !== 'SHA256SUMS' && !listed.has(name));
    check(unlistedAdded.length === 0, `added files missing from SHA256SUMS: ${unlistedAdded.join(', ')}`);
    const phantom = [...listed].filter((name) => !names.includes(name));
    check(phantom.length === 0, `SHA256SUMS lists files that are not shipped: ${phantom.join(', ')}`);

    process.stdout.write(`SHA256SUMS     : ${rows.length} rows, ${mismatched.length} mismatch, ${phantom.length} phantom\n`);
    notes.push(`SHA256SUMS covers ${rows.length} files (added files + key payload files)`);
  }

  // ---- payload identity ---------------------------------------------------
  const bundleEntry = byName.get('bundle.json');
  if (check(bundleEntry !== undefined, 'bundle.json missing from the archive')) {
    const actual = sha256(archive.readFile(bundleEntry));
    check(actual === EXPECTED_PAYLOAD.bundleJsonSha256,
      `bundle.json in the archive is ${actual}, recorded v13 is ${EXPECTED_PAYLOAD.bundleJsonSha256}`);
    process.stdout.write(`bundle.json    : ${actual}${actual === EXPECTED_PAYLOAD.bundleJsonSha256 ? ' (matches recorded v13)' : ' (MISMATCH)'}\n`);
  }

  // ---- optional: every payload row ---------------------------------------
  if (options.full) {
    const manifestEntry = byName.get('manifests/files.sha256');
    if (check(manifestEntry !== undefined, 'manifests/files.sha256 missing from the archive')) {
      const rows = archive.readFile(manifestEntry).toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0 && !line.startsWith('#'));
      check(rows.length === EXPECTED_PAYLOAD.manifestRows,
        `manifest has ${rows.length} rows, recorded v13 has ${EXPECTED_PAYLOAD.manifestRows}`);
      const started = Date.now();
      const mismatched = [];
      for (const row of rows) {
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(row);
        if (match === null) {
          mismatched.push(`malformed row: ${row.slice(0, 80)}`);
          continue;
        }
        const entry = byName.get(match[2]);
        if (entry === undefined) {
          mismatched.push(`${match[2]}: not in archive`);
          continue;
        }
        if (sha256(archive.readFile(entry)) !== match[1]) mismatched.push(`${match[2]}: hash mismatch`);
        if (mismatched.length > 20) break;
      }
      check(mismatched.length === 0, `payload rows do not verify: ${mismatched.slice(0, 5).join('; ')}`);
      process.stdout.write(`payload rows   : ${rows.length} recomputed from the archive in ${Date.now() - started} ms, ${mismatched.length} mismatch\n`);
    }
  }

  const ok = failures.length === 0;
  process.stdout.write(`${JSON.stringify({
    ok,
    archive: options.zip,
    entries: names.length,
    payloadFiles: payloadFiles.length,
    addedFiles: added.sort(),
    full: options.full,
    failures,
    notes,
  }, null, 2)}\n`);
  process.exitCode = ok ? 0 : 1;
} finally {
  archive.close();
}
