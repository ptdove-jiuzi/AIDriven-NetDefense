/**
 * The built artifact, checked from the outside (author PT-dove).
 *
 * `package.test.js` pins the rules on a synthetic payload; this file checks the
 * real deliverable in `dist/` — and skips, loudly, when it has not been built.
 * Everything here reads the archive's own bytes, so a report that disagrees with
 * the archive fails here rather than in someone's shell an hour later.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ZipArchive } from '../../scripts/release/lib/zip-read.mjs';
import { DEFAULT_LABEL, EXPECTED_PAYLOAD } from '../../scripts/release/pack-portable.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARCHIVE = join(REPO_ROOT, 'dist', `AIDriven-NetDefense-${DEFAULT_LABEL}-win-x64-portable.zip`);
const REPORT = join(REPO_ROOT, 'dist', `AIDriven-NetDefense-${DEFAULT_LABEL}-win-x64-portable.report.json`);
const SIDECAR = `${ARCHIVE}.sha256`;

const built = existsSync(ARCHIVE);

test('the built archive matches its own report', { skip: built ? false : `not built: ${ARCHIVE}` }, () => {
  assert.ok(existsSync(REPORT), `the pack report must exist next to the archive: ${REPORT}`);
  const report = JSON.parse(readFileSync(REPORT, 'utf8'));
  const bytes = readFileSync(ARCHIVE);
  const actual = createHash('sha256').update(bytes).digest('hex');

  assert.equal(report.archive.sha256, actual, 'the report must describe this exact archive');
  assert.equal(report.archive.bytes, bytes.length);
  assert.equal(report.counts.zipFiles, report.counts.payloadFiles + report.counts.addedFiles);
  assert.equal(report.payload.bundleJsonSha256, EXPECTED_PAYLOAD.bundleJsonSha256,
    'the payload must be the recorded v13 tree');
  assert.equal(report.payload.identityHolds, true);
  assert.equal(report.frozen, false, 'the label must be marked as not frozen');
  assert.equal(report.productVersion, '0.0.0');

  const sidecar = readFileSync(SIDECAR, 'utf8').trim();
  assert.equal(sidecar.split(/\s+/)[0], actual, 'the .sha256 sidecar must match the archive');
});

test('the built archive holds exactly payload + added files', { skip: built ? false : 'not built' }, () => {
  const report = JSON.parse(readFileSync(REPORT, 'utf8'));
  const archive = new ZipArchive(ARCHIVE);
  try {
    const files = archive.fileEntries();
    assert.equal(files.length, report.counts.zipFiles);
    assert.equal(files.length, EXPECTED_PAYLOAD.files + report.counts.addedFiles);
    assert.equal(new Set(files.map((entry) => entry.name)).size, files.length, 'no duplicate entries');
    for (const entry of files) {
      assert.equal(entry.name.startsWith('/'), false, `absolute entry name: ${entry.name}`);
      assert.equal(entry.name.includes('\\'), false, `backslash entry name: ${entry.name}`);
      assert.equal(entry.name.split('/').includes('..'), false, `escaping entry name: ${entry.name}`);
      assert.equal(entry.name.startsWith('run/'), false, `runtime state leaked into the archive: ${entry.name}`);
    }
  } finally {
    archive.close();
  }
});

test('SHA256SUMS inside the built archive verifies and covers every added file', { skip: built ? false : 'not built' }, () => {
  const report = JSON.parse(readFileSync(REPORT, 'utf8'));
  const archive = new ZipArchive(ARCHIVE);
  try {
    const byName = new Map(archive.fileEntries().map((entry) => [entry.name, entry]));
    const rows = archive.readFile(byName.get('SHA256SUMS')).toString('utf8')
      .split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
    assert.equal(rows.length, report.sha256sums.rows);

    const listed = new Set();
    for (const row of rows) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(row);
      assert.ok(match !== null, `malformed row: ${row.slice(0, 80)}`);
      const [, expected, name] = match;
      listed.add(name);
      const entry = byName.get(name);
      assert.ok(entry !== undefined, `SHA256SUMS lists ${name}, which is not in the archive`);
      const actual = createHash('sha256').update(archive.readFile(entry)).digest('hex');
      assert.equal(actual, expected, `${name} does not hash to its recorded value`);
    }
    for (const name of report.addedFiles) {
      if (name === 'SHA256SUMS') continue;
      assert.ok(listed.has(name), `${name} is shipped but missing from SHA256SUMS`);
    }
    assert.equal(report.sha256sums.coversWholePayload, false,
      'the key-file list must not claim to cover the whole payload');
  } finally {
    archive.close();
  }
});

test('bundle.json inside the archive is the recorded v13 file', { skip: built ? false : 'not built' }, () => {
  const archive = new ZipArchive(ARCHIVE);
  try {
    const entry = archive.fileEntries().find((candidate) => candidate.name === 'bundle.json');
    assert.ok(entry !== undefined, 'bundle.json must be shipped');
    const actual = createHash('sha256').update(archive.readFile(entry)).digest('hex');
    assert.equal(actual, EXPECTED_PAYLOAD.bundleJsonSha256);
  } finally {
    archive.close();
  }
});
