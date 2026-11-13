/**
 * M8 reclaim-report verification (`deploy/embedded-runtime/report.mjs`).
 *
 * The report is the only thing that tells a maintainer which old bundles are
 * safe to delete, and the status file quotes its output as the reproducible
 * evidence for the reclaim table. That makes two properties load-bearing:
 *
 * 1. it must survive every shape the tree really contains — a healthy bundle, an
 *    interrupted build with no `bundle.json`, and a build that died mid-write
 *    and left a truncated one;
 * 2. its text and `--json` paths must agree, otherwise "the cleanup advice is
 *    reproducible" is only true for whoever happens to run the other flag.
 *
 * History: the text path used to crash with
 * `Cannot read properties of undefined (reading 'slice')` on exactly the
 * directories added by an earlier fix (the ones with no `bundle.json`), and no
 * test referenced this file at all, so the regression shipped. The fixtures
 * below are minimal reproductions of that tree.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BUNDLE_NAME, defaultBundleRoot } from './bundle-locator.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPORT = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'report.mjs');
const DELIVERED_BUNDLE = defaultBundleRoot();

function run(args) {
  return spawnSync(process.execPath, [REPORT, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
}

function writeBundle(directory, { builtAt, files = 2, licenseGaps = 0 } = {}) {
  mkdirSync(join(directory, 'manifests'), { recursive: true });
  writeFileSync(join(directory, 'bundle.json'), `${JSON.stringify({
    schemaVersion: '1.0',
    builtAt,
    license: { node: { provenance: 'attested' }, packagesWithoutLicenseText: licenseGaps },
  }, null, 2)}\n`);
  for (let index = 0; index < files; index += 1) {
    writeFileSync(join(directory, `payload-${index}.bin`), 'x'.repeat(1024 * 1024));
  }
  writeFileSync(join(directory, 'manifests', 'third-party-packages.json'), `${JSON.stringify({
    count: 3, byLicense: { MIT: 3 }, packages: [],
  })}\n`);
  writeFileSync(join(directory, 'manifests', 'license-gaps.json'), `${JSON.stringify({ count: licenseGaps, packages: [] })}\n`);
  writeFileSync(join(directory, 'manifests', 'files.sha256'), '# header\n\ndeadbeef  payload-0.bin\n');
}

/**
 * Three sibling directories matching what `_m8_poc/bundle` actually holds:
 * a readable bundle, one with no marker, and one whose marker was truncated.
 */
function makeFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'm8-report-'));
  const siblings = join(root, 'bundle');
  mkdirSync(siblings, { recursive: true });
  writeBundle(join(siblings, 'healthy'), { builtAt: '2026-11-02T10:00:00.000Z', files: 2, licenseGaps: 1 });
  // Interrupted before `bundle.json` was written: still occupies disk.
  mkdirSync(join(siblings, 'no-marker', 'app'), { recursive: true });
  writeFileSync(join(siblings, 'no-marker', 'app', 'payload.bin'), 'y'.repeat(3 * 1024 * 1024));
  // Killed while writing `bundle.json`: the marker exists but does not parse.
  mkdirSync(join(siblings, 'torn-marker'), { recursive: true });
  writeFileSync(join(siblings, 'torn-marker', 'bundle.json'), '{"schemaVersion":"1.0","builtAt":');
  writeFileSync(join(siblings, 'torn-marker', 'payload.bin'), 'z'.repeat(4 * 1024 * 1024));
  return { root, siblings };
}

test('the reclaim report keeps working when a bundle.json is missing', () => {
  const { root, siblings } = makeFixtures();
  try {
    const result = run(['--siblings', siblings, '--current', join(siblings, 'healthy')]);
    assert.equal(result.status, 0, `the text report must not crash:\n${result.stderr}`);
    assert.equal(result.stderr, '', 'the text report must not write to stderr');
    // Regression guard for the original defect: the crash was a `.slice` of an
    // undefined digest, so both the exit code and this message are asserted.
    assert.equal(/reading 'slice'/.test(result.stderr), false);

    for (const name of ['healthy', 'no-marker', 'torn-marker']) {
      assert.ok(result.stdout.includes(name), `the report must list ${name}, an unreported tree is an unreclaimed one`);
    }
    assert.match(result.stdout, /total \d+\.\d MiB across 3 bundle\(s\); 2 not marked current/,
      'the total line is the whole point of the report; it must be printed');
    assert.match(result.stdout, /no-marker[\s\S]*no usable bundle\.json — interrupted build/,
      'a directory without a marker must be labelled rather than silently treated as a bundle');
    assert.match(result.stdout, /bundle\.json {2}missing/,
      'a missing marker digest must print as "missing", not throw');
    assert.match(result.stdout, /torn-marker[\s\S]*bundle\.json is unreadable/,
      'a truncated marker must be reported with its reason');
    // The damaged markers still carry a digest, so an operator can tell two
    // different interrupted builds apart.
    assert.match(result.stdout, /bundle\.json {2}[0-9a-f]{16}… {2}\[bundle\.json is unreadable/);
    assert.equal(result.stdout.includes('undefined'), false, 'no field may print as undefined');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the reclaim report agrees with itself on the text and JSON paths', () => {
  const { root, siblings } = makeFixtures();
  try {
    const args = ['--siblings', siblings, '--current', join(siblings, 'healthy')];
    const text = run(args);
    const json = run([...args, '--json']);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(json.status, 0, json.stderr);

    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.bundles.length, 3);
    assert.equal(parsed.deletable.length, 2);
    assert.equal(parsed.current, resolve(join(siblings, 'healthy')));

    // The two paths must not disagree: the status file quotes the text output
    // while reviewers run the JSON one.
    const textTotal = Number(/total (\d+\.\d) MiB/.exec(text.stdout)[1]);
    assert.equal(textTotal, Number(parsed.totalMiB.toFixed(1)),
      'text and JSON totals must be the same number');

    const summed = parsed.bundles.reduce((sum, row) => sum + row.logicalMiB, 0);
    assert.equal(Number(summed.toFixed(2)), parsed.totalMiB, 'totalMiB must be the sum of the rows');

    const unmarked = parsed.bundles.filter((row) => row.marked === false);
    assert.equal(unmarked.length, 2, 'both damaged trees must be marked unreadable');
    for (const row of unmarked) {
      assert.ok(row.logicalMiB > 0, `${row.name} still occupies disk and must be counted`);
      assert.equal(typeof row.bundleJsonError, 'string', `${row.name} must carry why its marker is unusable`);
      assert.equal(row.packages, 0, 'an unreadable marker must not be trusted for counts');
    }
    const healthy = parsed.bundles.find((row) => row.marked === true);
    assert.equal(healthy.packages, 3);
    assert.equal(healthy.licenseGaps, 1);
    assert.equal(healthy.nodeLicense, 'attested');
    assert.match(healthy.bundleJsonSha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the reclaim report refuses a path that is not a directory and still compares two bundles', () => {
  const { root, siblings } = makeFixtures();
  try {
    const missing = run(['--siblings', join(siblings, 'does-not-exist')]);
    assert.notEqual(missing.status, 0, 'a missing --siblings directory must fail loudly');
    assert.match(missing.stderr, /directory not found/);

    const bogus = run([join(siblings, 'does-not-exist')]);
    assert.notEqual(bogus.status, 0);
    assert.match(bogus.stderr, /not a directory/);

    // The two-path comparison is what produced the v8 → v9 delta table; it must
    // keep working and must not require a marker on either side.
    const before = join(siblings, 'healthy');
    const after = join(siblings, 'no-marker');
    const text = run([before, after]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /delta \(after - before\)/);
    assert.match(text.stdout, /size\s+[+-]\d+\.\d{2} MiB/);
    assert.match(text.stdout, /license gaps [+-]\d+/);

    const json = run([before, after, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.before.name, 'healthy');
    assert.equal(parsed.after.name, 'no-marker');
    assert.equal(typeof parsed.delta.packages, 'number');
    assert.equal(parsed.delta.logicalMiB, Number((parsed.after.logicalMiB - parsed.before.logicalMiB).toFixed(2)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real bundle pair is reported with figures that match its own manifests', () => {
  // Real-tree counterpart of the fixtures above. It compares the delivered bundle
  // against the previous in-repository release rather than sweeping the old
  // `_m8_poc` tree: the same code path, the same real manifests, two directories
  // instead of sixteen, so the gate does not spend three minutes on a stale
  // directory walk. Both sides are delivered artifacts now: v15 is the rc.3
  // payload and v16 the rc.4 payload, both under `dist/bundle/` with
  // `defaultBundleRoot()` selecting the newest complete one. The old baseline
  // (`aegis-embedded-win32-x64-v9-pruned`) only ever existed inside the external
  // `_m8_poc` build tree that the packaging suites no longer read, so a missing
  // pair must be a hard failure, not a skip: under `test:packaging`
  // (`run-tests.mjs` `maxSkip=0`) a skip already fails the gate, and a silent one
  // would hide that the report lost its real counterpart.
  const baseline = join(dirname(DELIVERED_BUNDLE), 'win32-x64-v15');
  assert.ok(existsSync(join(baseline, 'bundle.json')),
    `the previous in-repo release ${baseline} must remain for the real-pair report; `
    + 'if it was reclaimed, update this baseline deliberately instead of skipping the measurement');
  assert.ok(existsSync(join(DELIVERED_BUNDLE, 'bundle.json')),
    `the delivered bundle ${DELIVERED_BUNDLE} must be present for the real-pair report`);
  const text = run([baseline, DELIVERED_BUNDLE]);
  assert.equal(text.status, 0, `the delivered pair must be reportable:\n${text.stderr}`);
  assert.match(text.stdout, /delta \(after - before\)/);

  const json = JSON.parse(run([baseline, DELIVERED_BUNDLE, '--json']).stdout);
  assert.equal(json.before.name, 'win32-x64-v15');
  assert.equal(json.after.name, DEFAULT_BUNDLE_NAME,
    'the report must name the tree it measured, and it must be the delivered bundle');
  assert.equal(json.delta.logicalMiB, Number((json.after.logicalMiB - json.before.logicalMiB).toFixed(2)));
  assert.equal(json.delta.packages, json.after.packages - json.before.packages);

  // The delivered bundle's own bookkeeping has to match the tree the report
  // measured, otherwise "430 MiB / 240 packages" is a claim about nothing.
  const bundle = JSON.parse(readFileSync(join(DELIVERED_BUNDLE, 'bundle.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(join(DELIVERED_BUNDLE, 'manifests', 'third-party-packages.json'), 'utf8'));
  assert.equal(json.after.packages, inventory.count);
  assert.equal(json.after.packages, bundle.counts.packages);
  assert.equal(json.after.licenseGaps, bundle.license.packagesWithoutLicenseText);
  assert.equal(json.after.nodeLicense, bundle.license.node.provenance);
  assert.ok(json.after.files > 40000, `the delivered bundle must hold the full tree, saw ${json.after.files} files`);
  assert.ok(json.after.logicalMiB > 400, `the delivered bundle must be measured, saw ${json.after.logicalMiB} MiB`);
  // Every delivered package is either covered or named as an open gap: the two
  // numbers have to add up, which is the property the reclaim/ licensing story
  // depends on when it says how much is left to fix.
  assert.equal(
    json.after.licenseGaps,
    inventory.packages.filter((pkg) => pkg.licenseFiles.length === 0).length,
    'the gap count must equal the packages that carry no text',
  );
});
