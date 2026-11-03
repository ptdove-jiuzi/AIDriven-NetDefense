/**
 * M8 bundle manifest and closure-completeness verification.
 *
 * Three independent claims are checked against the staged bytes rather than
 * against the builder's own bookkeeping:
 *
 * 1. `manifests/files.sha256` covers exactly the bundle files (minus itself) and
 *    every digest matches the file on disk;
 * 2. the third-party inventory names every staged package with an SPDX license
 *    identifier and a license text, and the notice file lists the same set;
 * 3. the staged dependency graph is closed: every production dependency of every
 *    staged package resolves inside the bundle, so a launch cannot fall back to
 *    the repository's `node_modules`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listBundleFiles, sha256File } from '../../deploy/embedded-runtime/lib/stage.mjs';
import { defaultBundleRoot } from './bundle-locator.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE_ROOT = defaultBundleRoot();
const APP_ROOT = join(BUNDLE_ROOT, 'app');
const NODE_MODULES = join(APP_ROOT, 'node_modules');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Every staged package directory. The tree is walked by shape rather than by an
 * assumed depth: `@scope/name`, plain `name`, nested `x/node_modules/y`, and the
 * `node_modules/plugins/*` mirrors the adapter's own relative root requires.
 */
function stagedPackages() {
  const packages = [];
  const strays = [];
  const walk = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (existsSync(join(path, 'package.json'))) {
        packages.push({ dir: path, manifest: readJson(join(path, 'package.json')) });
        const nested = join(path, 'node_modules');
        if (existsSync(nested)) walk(nested, 0);
      } else if (depth < 3) {
        walk(path, depth + 1);
      } else {
        strays.push(path);
      }
    }
  };
  walk(NODE_MODULES, 0);
  return { packages, strays };
}

/**
 * Resolve a dependency the way Node would, but stop at the bundle root: walking
 * past it would let a stray `node_modules` on the build machine satisfy a bundle
 * that is missing the package.
 */
function resolveInsideBundle(fromDir, name) {
  let directory = fromDir;
  for (let guard = 0; guard < 64; guard += 1) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (directory === APP_ROOT) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

test('the hash manifest covers exactly the bundle files and every digest matches', () => {
  const manifestPath = join(BUNDLE_ROOT, 'manifests', 'files.sha256');
  assert.ok(existsSync(manifestPath), 'files.sha256 is missing');
  const rows = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      assert.ok(match !== null, `malformed manifest row: ${line}`);
      return { sha256: match[1], path: match[2] };
    });
  const listed = rows.map((row) => row.path).sort();
  const actual = listBundleFiles(BUNDLE_ROOT, { skip: ['manifests'] });
  assert.deepEqual(listed, actual, 'manifest must list exactly the non-manifest bundle files');
  for (const row of rows) {
    assert.equal(sha256File(join(BUNDLE_ROOT, row.path)), row.sha256, `digest mismatch: ${row.path}`);
  }
  assert.ok(rows.length > 100, `expected a substantial file list, got ${rows.length}`);
});

test('the third-party inventory, notice file and license texts agree', () => {
  const inventory = readJson(join(BUNDLE_ROOT, 'manifests', 'third-party-packages.json'));
  assert.equal(inventory.author, 'PT-dove');
  assert.equal(inventory.count, inventory.packages.length);
  assert.ok(inventory.count > 100, `expected the production closure, got ${inventory.count} packages`);

  const notice = readFileSync(join(BUNDLE_ROOT, 'manifests', 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  const unknown = [];
  for (const pkg of inventory.packages) {
    assert.match(pkg.name, /^(?:@[^/]+\/)?[^/]+$/, `unexpected package name ${pkg.name}`);
    assert.ok(typeof pkg.version === 'string' && pkg.version.length > 0, `missing version for ${pkg.name}`);
    assert.ok(typeof pkg.license === 'string' && pkg.license.length > 0, `missing license id for ${pkg.name}`);
    if (pkg.license === 'UNKNOWN') unknown.push(pkg.name);
    assert.ok(notice.includes(`${pkg.name}@${pkg.version}\t${pkg.license}`), `notice is missing ${pkg.name}@${pkg.version}`);
    assert.ok(existsSync(join(BUNDLE_ROOT, pkg.path, 'package.json')), `inventory path does not exist: ${pkg.path}`);
    for (const file of pkg.licenseFiles) {
      assert.ok(existsSync(join(BUNDLE_ROOT, 'manifests', file)), `collected license text missing: ${file}`);
    }
  }
  assert.deepEqual(unknown, [], `packages without a declared license id: ${unknown.join(', ')}`);

  // License texts must actually be collected for the bulk of the tree, including
  // packages that keep theirs in a `licenses/` subdirectory.
  const withoutText = inventory.packages.filter((pkg) => pkg.licenseFiles.length === 0);
  assert.ok(
    withoutText.length <= Math.ceil(inventory.count * 0.1),
    `too many packages ship no license text (${withoutText.length}/${inventory.count}): ${withoutText.slice(0, 10).map((pkg) => pkg.name).join(', ')}`,
  );

  // The copyleft obligation does not depend on which package carries it: every
  // MPL-2.0 package that is still bundled must ship its text. The formal stage
  // prunes the LibreOffice runtime (the only MPL-2.0 payload of the PoC), so this
  // cannot pin a package name — but it must not become vacuous either.
  const mpl = inventory.packages.filter((pkg) => String(pkg.license).includes('MPL'));
  for (const pkg of mpl) {
    assert.ok(pkg.licenseFiles.length > 0, `the MPL package ${pkg.name} must ship its license text`);
  }
  const trimForMpl = readJson(join(BUNDLE_ROOT, 'manifests', 'trim-report.json'));
  const prunedMpl = trimForMpl.pruned.filter((row) => String(row.license).includes('MPL'));
  assert.ok(mpl.length > 0 || prunedMpl.length > 0,
    'no MPL-2.0 package is bundled or recorded as pruned, which means this check proved nothing');
  for (const row of prunedMpl) {
    assert.ok(!inventory.packages.some((pkg) => pkg.name === row.name),
      `${row.name} is recorded as pruned but is still inventoried`);
  }

  // Every package that ships no text must be named in the machine-readable gap
  // list: "no text" is an open obligation, not a formatting detail.
  const gaps = readJson(join(BUNDLE_ROOT, 'manifests', 'license-gaps.json'));
  assert.equal(gaps.count, gaps.packages.length, 'license-gaps.json count must match its list');
  assert.deepEqual(
    gaps.packages.map((row) => row.name).sort(),
    withoutText.map((row) => row.name).sort(),
    'the license gap list must name exactly the packages without license text',
  );
  for (const gap of gaps.packages) {
    assert.equal(gap.status, 'open', `${gap.name} must stay open until its upstream text is obtained`);
    assert.ok(typeof gap.action === 'string' && gap.action.length > 20, `${gap.name} needs an actionable next step`);
  }

  const nodeLicense = join(BUNDLE_ROOT, 'runtime', 'node', 'LICENSE-NODE.txt');
  assert.ok(existsSync(nodeLicense), 'the bundled Node license text is missing');
  assert.match(readFileSync(nodeLicense, 'utf8'), /Node\.js is licensed for use as follows/);
  assert.ok(notice.includes('Bundled Node.js runtime'));
  // The notice tells a reader where to find the Node text. A wrong path there is
  // a compliance defect in the one file whose job is compliance, so every
  // `runtime/...` path the notice names has to exist in the shipped tree.
  const referenced = [...notice.matchAll(/runtime\/[\w./-]*LICENSE-NODE\.txt/g)].map((match) => match[0]);
  assert.ok(referenced.length > 0, 'the notice must say where the Node license text lives');
  for (const path of new Set(referenced)) {
    assert.ok(existsSync(join(BUNDLE_ROOT, ...path.split('/'))), `the notice points at a missing file: ${path}`);
  }

  // The runtime metadata must describe where the license text really is.
  const runtimeMeta = readJson(join(BUNDLE_ROOT, 'runtime', 'node', 'runtime.json'));
  assert.equal(runtimeMeta.licenseFile, 'runtime/node/LICENSE-NODE.txt');
  assert.ok(existsSync(join(BUNDLE_ROOT, runtimeMeta.licenseFile)), 'runtime.json points at a missing license file');
  assert.equal(runtimeMeta.version.replace(/^v/, '').split('.')[0], '24');
  assert.ok(['attested', 'unattested'].includes(runtimeMeta.licenseProvenance),
    'runtime.json must state whether the license text is tied to the bundled binary');
  assert.equal(runtimeMeta.licenseMatchesBundledVersion, runtimeMeta.licenseProvenance === 'attested');
  assert.equal(runtimeMeta.licenseTextSha256, sha256File(join(BUNDLE_ROOT, runtimeMeta.licenseFile)),
    'runtime.json must record the digest of the text it ships');

  // An unattested Node license is a release blocker, and the bundle has to say so
  // in its own metadata rather than only in prose.
  const bundleMeta = readJson(join(BUNDLE_ROOT, 'bundle.json'));
  if (runtimeMeta.licenseProvenance !== 'attested') {
    assert.equal(bundleMeta.license.node.matchesBundledVersion, false);
    assert.ok(bundleMeta.releaseGaps.some((gap) => gap.id === 'node-license-provenance'),
      'an unattested Node license must appear in bundle.json releaseGaps');
  }
  assert.equal(bundleMeta.license.complete, runtimeMeta.licenseProvenance === 'attested' && gaps.count === 0,
    'bundle.json must not claim license completeness while a gap is open');
});

test('every staged production dependency resolves inside the bundle', () => {
  const { packages, strays } = stagedPackages();
  assert.deepEqual(strays, [], `every directory under node_modules must be a package: ${strays.slice(0, 5).join(', ')}`);
  assert.ok(packages.length > 100, `expected the production closure on disk, saw ${packages.length}`);

  /**
   * A dependency edge may be unsatisfied for exactly one reason: the package was
   * removed by the reviewed trim. Anything else — a packaging bug, a missing
   * platform variant, a hand-deleted directory — still fails. The trim report is
   * the authority for which names may be absent, and it has to name the very
   * package the edge asks for.
   */
  const trim = readJson(join(BUNDLE_ROOT, 'manifests', 'trim-report.json'));
  const pruned = new Set(trim.pruned.map((row) => row.name));
  const missing = [];
  const missingPruned = [];
  const names = new Set();
  for (const pkg of packages) {
    names.add(pkg.manifest.name);
    const optional = new Set(Object.keys(pkg.manifest.optionalDependencies ?? {}));
    for (const [name, meta] of Object.entries(pkg.manifest.peerDependenciesMeta ?? {})) {
      if (meta?.optional === true) optional.add(name);
    }
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const name of Object.keys(pkg.manifest[field] ?? {})) {
        if (optional.has(name)) continue;
        if (resolveInsideBundle(pkg.dir, name) !== undefined) continue;
        if (pruned.has(name)) missingPruned.push(`${pkg.manifest.name} -> ${name}`);
        else missing.push(`${pkg.manifest.name} -> ${name}`);
      }
    }
  }
  assert.deepEqual(missing.slice(0, 20), [], `unresolved production dependencies inside the bundle: ${missing.length}\n${missing.slice(0, 20).join('\n')}`);

  // A pruned edge is only tolerable while the package that declared it is itself
  // still shipped: a kept package must never depend on a name nobody kept.
  assert.ok(missingPruned.length > 0, 'the trimmed bundle must show the pruned edges it relies on, otherwise this assertion is vacuous');
  for (const name of pruned) {
    assert.ok(!names.has(name), `the trim report lists ${name} as pruned but it is still staged`);
  }

  // The worker chain itself must be present, otherwise the boot test would be
  // proving something other than the bundle.
  for (const required of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-sdk-app',
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
    '@deepseek-ai/dsh-llm-deepseek-api-key',
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-tool-executor-native',
    '@aegisharness/harness-worker',
    '@aegisharness/harness-adapter',
    '@aegisharness/dsh-defense-tools',
  ]) {
    assert.ok(names.has(required), `the bundle is missing ${required}`);
  }

  // A dev-only tool must not be swept in: the closure is production-only.
  assert.ok(!names.has('@cyclonedx/cyclonedx-npm'), 'devDependencies must not be staged');
});

test('the bundle contains no symlink and no directory outside its root', () => {
  // `listBundleFiles` throws on any symlink, which is the escape this guards.
  const files = listBundleFiles(BUNDLE_ROOT);
  assert.ok(files.length > 1000, `expected the full tree, saw ${files.length} files`);
  for (const path of files) {
    assert.ok(statSync(join(BUNDLE_ROOT, path)).isFile(), `unexpected non-file entry: ${path}`);
  }
});

test('every shipped license text is the one that was traced from upstream', () => {
  // The licensing claim is only reproducible if the provenance record and the
  // shipped bytes are tied together. Three independent links are checked:
  // repository attestation -> shipped text, shipped provenance -> shipped text,
  // and "no text" -> an open gap that names the package.
  const attestationsPath = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'license-attestations.json');
  assert.ok(existsSync(attestationsPath), 'the license attestation record is missing from the deploy directory');
  const attestations = readJson(attestationsPath);
  assert.equal(attestations.author, 'PT-dove');
  const deployDir = join(REPO_ROOT, 'deploy', 'embedded-runtime');
  const at = (relativePath) => join(deployDir, ...String(relativePath).split('/'));

  const runtimeMeta = readJson(join(BUNDLE_ROOT, 'runtime', 'node', 'runtime.json'));
  const bundleMeta = readJson(join(BUNDLE_ROOT, 'bundle.json'));
  const nodeRecord = attestations.node;
  assert.ok(nodeRecord !== undefined, 'the attestation record must cover the bundled runtime');
  assert.equal(sha256File(at(nodeRecord.file)), nodeRecord.sha256,
    'the recorded Node license text in the deploy directory is not the text that was traced');
  assert.equal(runtimeMeta.licenseProvenance, 'attested', 'the bundled runtime must ship an attested text');
  assert.equal(runtimeMeta.licenseMatchesBundledVersion, true);
  assert.equal(runtimeMeta.version, nodeRecord.version, 'the attestation must name the version that is bundled');
  assert.equal(runtimeMeta.licenseTextSha256, nodeRecord.sha256,
    'the bundle ships a different Node license text than the attestation records');
  assert.equal(sha256File(join(BUNDLE_ROOT, runtimeMeta.licenseFile)), nodeRecord.sha256);
  assert.equal(bundleMeta.license.node.attestedVersion, nodeRecord.version);
  assert.match(String(bundleMeta.license.node.source), /nodejs\.org\/dist\//,
    'the node license source must point at the official distribution');

  // The archive the text came from must be the release the binary came from.
  assert.equal(nodeRecord.binary.matchesBundledRuntime, true);
  assert.equal(sha256File(join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe')), nodeRecord.binary.sha256,
    'the bundled node.exe is not the binary the license attestation describes');
  assert.equal(bundleMeta.license.attestationsSha256, sha256File(attestationsPath),
    'the bundle records a different attestation file than the one in the repository');
  // The record has to travel with the bundle: a digest that can only be checked
  // against a file left in the build tree proves nothing to whoever receives it.
  const shippedAttestations = join(BUNDLE_ROOT, ...String(bundleMeta.license.attestationsFile).split('/'));
  assert.ok(existsSync(shippedAttestations), `the attestation record was not shipped: ${bundleMeta.license.attestationsFile}`);
  assert.equal(sha256File(shippedAttestations), bundleMeta.license.attestationsSha256,
    'the shipped attestation record is not the one the bundle claims');

  // Every supplemental text: the shipped copy must match both the repository copy
  // and the provenance entry that is shipped alongside it.
  const provenance = readJson(join(BUNDLE_ROOT, 'manifests', 'license-provenance.json'));
  const gaps = readJson(join(BUNDLE_ROOT, 'manifests', 'license-gaps.json'));
  const inventory = readJson(join(BUNDLE_ROOT, 'manifests', 'third-party-packages.json'));
  assert.equal(provenance.count, provenance.packages.length);
  assert.equal(bundleMeta.license.packagesSuppliedFromUpstreamRelease, provenance.packages.length);
  for (const entry of provenance.packages) {
    const shipped = join(BUNDLE_ROOT, 'manifests', entry.file);
    assert.ok(existsSync(shipped), `the provenance entry points at a missing text: ${entry.file}`);
    assert.equal(sha256File(shipped), entry.textSha256, `shipped text does not match its own provenance: ${entry.file}`);
    assert.equal(sha256File(shipped), entry.sha256, 'the shipped text is not the traced text');
    assert.match(String(entry.source), /^https:\/\//, 'a license source must be a real upstream URL');
    const packageRecord = inventory.packages.find((pkg) => pkg.name === entry.name && pkg.version === entry.version);
    assert.ok(packageRecord !== undefined, `${entry.name}@${entry.version} is attested but not inventoried`);
    assert.equal(packageRecord.license, entry.license, 'the text was filed under a different license id than the package declares');
    assert.deepEqual(packageRecord.licenseFiles, [entry.file], 'the inventory must point at the shipped text');
  }

  // The gap list and the attestation record must name the same open item, so the
  // remaining blocker cannot quietly disappear from one side or the other. A
  // package the trim removed is no longer shipped, so it must leave the gap list
  // — but only by leaving the bundle, never by the record being dropped.
  const shippedKeys = new Set(inventory.packages.map((row) => `${row.name}@${row.version}`));
  const unobtainableRows = attestations.unobtainable ?? [];
  const expectedGaps = unobtainableRows
    .map((row) => `${row.name}@${row.version}`)
    .filter((key) => shippedKeys.has(key));
  assert.deepEqual(gaps.packages.map((row) => `${row.name}@${row.version}`).sort(), expectedGaps.sort(),
    'the open gaps must be exactly the shipped packages whose upstream text does not exist');
  const trim = readJson(join(BUNDLE_ROOT, 'manifests', 'trim-report.json'));
  const prunedNames = new Set(trim.pruned.map((row) => row.name));
  for (const row of unobtainableRows) {
    assert.equal(row.status, 'open', `${row.name} must stay recorded as unobtainable`);
    assert.ok(row.evidence.length >= 2, `${row.name} must record why its text could not be obtained`);
    if (shippedKeys.has(`${row.name}@${row.version}`)) continue;
    // Not shipped: the only honest way out of the gap list is a reviewed removal.
    assert.ok(prunedNames.has(row.name),
      `${row.name}@${row.version} left the licence-gap list without being pruned, which hides a blocker`);
  }

  // And the headline: a bundle with an open gap may not call itself complete.
  assert.equal(bundleMeta.license.complete, gaps.count === 0 && runtimeMeta.licenseProvenance === 'attested');
  if (gaps.count > 0) {
    assert.ok(bundleMeta.releaseGaps.some((gap) => gap.id === 'third-party-license-texts' && gap.severity === 'blocker'),
      'an open license gap must stay a blocker in bundle.json');
  } else {
    assert.deepEqual(bundleMeta.releaseGaps.filter((gap) => gap.id === 'third-party-license-texts'), [],
      'a closed licence gap must not leave a blocker behind in releaseGaps');
  }
});
