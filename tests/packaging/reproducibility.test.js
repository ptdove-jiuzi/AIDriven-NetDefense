/**
 * ADR-0009 G2: the comparison rules themselves must be testable without
 * building two 430 MiB bundles.
 *
 * A reproducibility gate is only as good as its comparator. The failure modes
 * that matter are quiet ones:
 *
 * - stripping the `bundle.json` row and then forgetting to compare `bundle.json`
 *   at all — the gate would pass while the artifact's own record of itself drifted;
 * - comparing counts of rows instead of rows, so a swapped pair of files passes;
 * - treating "the two manifests agree" as "the manifests describe the bytes on
 *   disk", which lets an unhashed stray file ride along;
 * - silently skipping a malformed row, which turns corruption into a smaller
 *   successful comparison.
 *
 * Each test below pins one of those. The two-bundle run itself is a separate,
 * heavy, evidence-producing step (`tests/packaging/repro-compare.mjs`), not part
 * of this suite.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_BUNDLE_WHITELIST,
  DEFAULT_STRIPPED_PATHS,
  compareBundleJson,
  compareHashManifests,
  compareManifestDirectory,
  parseHashManifest,
  verifyManifestAgainstDisk,
} from './repro-compare.mjs';

const HEADER = [
  '# AegisHarness embedded runtime bundle — SHA-256 manifest',
  '# Format: <sha256>  <path relative to bundle root>, two spaces, no quotes.',
  '',
];

/** Build a manifest body from `[path, digest]` pairs, in the given order. */
function manifest(rows) {
  return [...HEADER, ...rows.map(([path, digest]) => `${digest}  ${path}`), ''].join('\n');
}

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

/** A minimal `bundle.json` shaped like the real one, with two whitelist-sensitive parts. */
function bundleJson({ builtAt = '2026-11-03T10:00:00.000Z', packages = 239, files = 46921 } = {}) {
  return {
    schemaVersion: '1.0',
    author: 'PT-dove',
    kind: 'packaging-poc',
    builtAt,
    bundledNode: 'v24.20.0',
    counts: { packages, prunedNames: 407 },
    source: { lockfileSha256: A, closureRoots: ['@deepseek-ai/dsh', '@aegisharness/harness-worker'] },
    paths: { node: 'runtime/node/node.exe', worker: 'app/node_modules/@aegisharness/harness-worker/bin.js' },
    summary: { hashedFiles: files },
  };
}

test('two manifests that agree compare equal and report how many files they covered', () => {
  const rows = [['app/package.json', A], ['launch/launch-plan.json', B], ['bundle.json', C]];
  const result = compareHashManifests(manifest(rows), manifest(rows));
  assert.equal(result.equal, true);
  // bundle.json is stripped by default, so it must not be counted as compared.
  assert.equal(result.compared, 2);
  assert.equal(result.nonEmpty, true);
  assert.deepEqual(result.differing, []);
  assert.deepEqual(result.onlyLeft, []);
  assert.deepEqual(result.onlyRight, []);
});

test('one differing digest is reported with its path instead of being absorbed by the row count', () => {
  const left = manifest([['a.js', A], ['b.js', B]]);
  const right = manifest([['a.js', A], ['b.js', C]]);
  const result = compareHashManifests(left, right);
  assert.equal(result.equal, false);
  // Same number of rows, same paths: only the per-file comparison can catch this.
  assert.equal(result.compared, 2);
  assert.deepEqual(result.differing, [{ path: 'b.js', left: B, right: C }]);
});

test('a file present on only one side is reported rather than passing as a shared file', () => {
  const left = manifest([['a.js', A], ['only-left.js', B]]);
  const right = manifest([['a.js', A], ['only-right.js', C]]);
  const result = compareHashManifests(left, right);
  assert.equal(result.equal, false);
  assert.equal(result.compared, 1);
  assert.deepEqual(result.onlyLeft, ['only-left.js']);
  assert.deepEqual(result.onlyRight, ['only-right.js']);
});

test('the bundle.json row is stripped from both manifests and the exclusion is reported', () => {
  const left = manifest([['a.js', A], ['bundle.json', B]]);
  const right = manifest([['a.js', A], ['bundle.json', C]]);
  const result = compareHashManifests(left, right, { strip: DEFAULT_STRIPPED_PATHS });
  assert.equal(result.equal, true, 'a differing bundle.json row must not fail the file comparison');
  assert.deepEqual(result.stripped, [{ path: 'bundle.json', inLeft: true, inRight: true }]);
  assert.equal(result.strippedRows, 1);
  // Not stripping is the control: without the exclusion the same pair differs.
  assert.equal(compareHashManifests(left, right, { strip: [] }).equal, false);
});

test('a bundle.json that differs only in a whitelisted field passes, and the field is named', () => {
  const left = bundleJson({ builtAt: '2026-11-03T10:00:00.000Z' });
  const right = bundleJson({ builtAt: '2026-11-03T10:07:31.512Z' });
  const result = compareBundleJson(left, right, { whitelist: DEFAULT_BUNDLE_WHITELIST });
  assert.equal(result.equal, true);
  assert.equal(result.whitelistDiffers, true);
  assert.deepEqual(result.whitelisted.map((row) => row.path), ['builtAt']);
  assert.ok(result.leafPaths > 10, 'the comparison must actually walk the document');
  // `leafPaths` expands array elements, so it is not the number of settings; the
  // two counts are reported apart so nobody reads 241 positions as 241 fields.
  assert.ok(result.arrayElementPaths >= 0 && result.arrayElementPaths < result.leafPaths);
});

test('a bundle.json that differs in any non-whitelisted field fails, including array order', () => {
  const base = bundleJson();
  assert.equal(compareBundleJson(base, bundleJson({ packages: 238 })).equal, false,
    'a changed package count must fail: that number is what the release claim is made from');
  assert.equal(compareBundleJson(base, bundleJson({ files: 46920 })).equal, false);

  const reordered = bundleJson();
  reordered.source.closureRoots = [...reordered.source.closureRoots].reverse();
  const order = compareBundleJson(base, reordered);
  assert.equal(order.equal, false, 'a reordered list is a different artifact, not the same set');
  assert.deepEqual(order.differing.map((row) => row.path).sort(), ['source.closureRoots[0]', 'source.closureRoots[1]']);

  const removed = bundleJson();
  delete removed.paths.worker;
  const missing = compareBundleJson(base, removed);
  assert.equal(missing.equal, false);
  assert.deepEqual(missing.onlyLeft, ['paths.worker']);
});

test('the stripped manifest digest is one value a reviewer can re-derive, and it is order-sensitive', () => {
  const rows = [['a.js', A], ['b.js', B], ['bundle.json', C]];
  const same = compareHashManifests(manifest(rows), manifest(rows));
  assert.equal(same.strippedDigest.left, same.strippedDigest.right);
  assert.match(same.strippedDigest.left, /^[0-9a-f]{64}$/);

  // The gate itself is per-file ("逐文件哈希一致"), so a reordered manifest still
  // passes the comparison — but the digest changes, which is how a reviewer sees
  // that the generator, not the bytes, moved.
  const reordered = compareHashManifests(manifest(rows), manifest([['b.js', B], ['a.js', A], ['bundle.json', C]]));
  assert.equal(reordered.equal, true);
  assert.notEqual(reordered.strippedDigest.left, reordered.strippedDigest.right);
});

test('a malformed manifest row is an error, not a silently smaller comparison', () => {
  const good = manifest([['a.js', A]]);
  assert.equal(parseHashManifest(good).rows.size, 1);
  assert.throws(() => parseHashManifest(`${good}not-a-row\n`), /malformed row/);
  assert.throws(() => parseHashManifest(`${good}${'d'.repeat(63)}  short-digest.js\n`), /malformed row/);
});

test('a duplicated path fails the gate instead of being silently collapsed to one row', () => {
  // `parseHashManifest` keeps the first row for a repeated path. Without a hard
  // failure here, a manifest that lists one file twice with two different digests
  // would compare clean against a manifest that lists it once — the extra row
  // would vanish from the comparison entirely.
  const once = manifest([['a.js', A]]);
  const twice = manifest([['a.js', A], ['a.js', B]]);
  const parsed = parseHashManifest(twice);
  assert.equal(parsed.rows.size, 1);
  assert.deepEqual(parsed.duplicates, ['a.js']);
  const result = compareHashManifests(once, twice);
  assert.equal(result.equal, false, 'a duplicated row must fail the gate, not just be reported');
  assert.equal(result.duplicatedPaths, 1);
});

test('a manifest with no rows cannot pass by comparing nothing', () => {
  const empty = manifest([]);
  const result = compareHashManifests(empty, empty);
  assert.equal(result.equal, true, 'no row differs, which is why `nonEmpty` has to exist');
  assert.equal(result.nonEmpty, false);
  assert.equal(result.compared, 0);
});

test('the manifests/ directory is compared too, so the evidence files are not unhashed', () => {
  // `files.sha256` excludes all of `manifests/`, so without this the prune gate
  // numbers and the licence gap list would be covered by no digest at all.
  const root = mkdtempSync(join(tmpdir(), 'g2-mdir-'));
  try {
    for (const side of ['left', 'right']) {
      mkdirSync(join(root, side, 'manifests', 'licenses', 'pkg@1.0.0'), { recursive: true });
      writeFileSync(join(root, side, 'manifests', 'files.sha256'), manifest([['a.js', A]]));
      writeFileSync(join(root, side, 'manifests', 'trim-report.json'), '{"gate":"same"}\n');
      writeFileSync(join(root, side, 'manifests', 'licenses', 'pkg@1.0.0', 'LICENSE.txt'), 'MIT\n');
    }
    const same = compareManifestDirectory(join(root, 'left'), join(root, 'right'));
    assert.equal(same.equal, true);
    assert.equal(same.totalFiles, 3);
    assert.equal(same.compared, 2, 'files.sha256 is excluded because it is compared row by row');
    assert.deepEqual(same.excluded, ['manifests/files.sha256']);

    // A drift in one of them must be caught: this is the P1 the reviewer raised.
    writeFileSync(join(root, 'right', 'manifests', 'trim-report.json'), '{"gate":"drifted"}\n');
    const drifted = compareManifestDirectory(join(root, 'left'), join(root, 'right'));
    assert.equal(drifted.equal, false);
    assert.deepEqual(drifted.differing.map((row) => row.path), ['manifests/trim-report.json']);

    // A file present on one side only is a difference, not a smaller comparison.
    writeFileSync(join(root, 'right', 'manifests', 'extra.json'), '{}\n');
    const extra = compareManifestDirectory(join(root, 'left'), join(root, 'right'));
    assert.equal(extra.equal, false);
    assert.deepEqual(extra.onlyRight, ['manifests/extra.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the manifest is re-derived from disk, so agreeing manifests cannot hide a wrong byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'g2-repro-'));
  try {
    mkdirSync(join(root, 'manifests'), { recursive: true });
    mkdirSync(join(root, 'app'), { recursive: true });
    const payload = Buffer.from('payload\n');
    writeFileSync(join(root, 'app', 'kept.txt'), payload);
    const digest = createHash('sha256').update(payload).digest('hex');
    const write = (rows) => writeFileSync(join(root, 'manifests', 'files.sha256'), manifest(rows));

    write([['app/kept.txt', digest]]);
    const ok = verifyManifestAgainstDisk(root);
    assert.equal(ok.ok, true);
    assert.equal(ok.verified, 1);

    // Same manifest, different bytes: the file comparison would still pass.
    writeFileSync(join(root, 'app', 'kept.txt'), Buffer.from('tampered\n'));
    const drifted = verifyManifestAgainstDisk(root);
    assert.equal(drifted.ok, false);
    assert.deepEqual(drifted.mismatched.map((row) => row.path), ['app/kept.txt']);

    // A file on disk that no row covers is an unhashed artifact, not a pass.
    writeFileSync(join(root, 'app', 'kept.txt'), payload);
    writeFileSync(join(root, 'app', 'stray.tmp'), Buffer.from('stray\n'));
    const stray = verifyManifestAgainstDisk(root);
    assert.equal(stray.ok, false);
    assert.deepEqual(stray.unlisted, ['app/stray.tmp']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
