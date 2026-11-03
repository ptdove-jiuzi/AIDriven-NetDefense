/**
 * M8 formal-stage trim verification.
 *
 * The bundle is 836 MiB because `@deepseek-ai/dsh` declares a dependency on every
 * capability it can host — LibreOffice, sherpa-onnx, sharp, node-pty, a browser
 * UI — while the reviewed `aegis-analysis` profile mounts twenty plugins and none
 * of those. Removing them is only acceptable if the removal is *reproducible*:
 * these tests re-derive the evidence, prove the gate still refuses a used
 * package, and check that the shipped bundle matches the reviewed decision.
 *
 * What is deliberately not re-proven here: that the trimmed bundle boots. That
 * lives in `bundle.test.js`, which points at the same bundle and asserts the
 * plugin count, the two defense tools, the network tripwire and the hashes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeClosure, loadLockfile } from '../../deploy/embedded-runtime/lib/closure.mjs';
import {
  analyzeUsage,
  buildDependentsIndex,
  evaluateCandidate,
  isTokenBounded,
  loadReachedCorpus,
  occurrencesOf,
  pruneCandidates,
} from '../../deploy/embedded-runtime/lib/usage.mjs';
import { isInside } from '../../deploy/embedded-runtime/lib/paths.mjs';
import { sha256File } from '../../deploy/embedded-runtime/lib/stage.mjs';
import { defaultBundleRoot } from './bundle-locator.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE_ROOT = defaultBundleRoot();
const PRUNE_LIST = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'prune-list.json');
const BUILD = join(REPO_ROOT, 'deploy', 'embedded-runtime', 'build.mjs');
const CLOSURE_ROOTS = [
  '@deepseek-ai/dsh',
  '@aegisharness/harness-worker',
  '@aegisharness/harness-adapter',
  '@aegisharness/dsh-defense-profile',
  '@aegisharness/dsh-defense-tools',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadProfile() {
  return readJson(join(REPO_ROOT, 'plugins', 'dsh-defense-profile', 'profile.json'));
}

/** One analysis pass, shared by every assertion in this file. */
function analyze() {
  const { packages } = loadLockfile(REPO_ROOT);
  const profile = loadProfile();
  const closure = computeClosure({ repoRoot: REPO_ROOT, packages, roots: CLOSURE_ROOTS });
  const usage = analyzeUsage({ repoRoot: REPO_ROOT, nodes: closure.nodes, profile, closureRoots: CLOSURE_ROOTS });
  const corpus = loadReachedCorpus({ usage, repoRoot: REPO_ROOT });
  // Same three sets the builder protects: closure roots, the plugins the profile
  // mounts, and every workspace package under `plugins/**`. Keeping this list in
  // sync matters — a narrower set here would let the test approve something the
  // builder refuses, and the mismatch would only surface at release time.
  const protectedNames = new Set(CLOSURE_ROOTS);
  for (const name of Object.values(profile.pluginPackages ?? {})) protectedNames.add(name);
  for (const node of closure.nodes.values()) {
    if (isInside(node.sourceDir, join(REPO_ROOT, 'plugins'))) protectedNames.add(node.name);
  }
  return {
    closure,
    usage,
    corpus,
    protectedNames,
    dependentsIndex: buildDependentsIndex({ nodes: closure.nodes }),
  };
}

/** Package names staged under `<bundle>/app/node_modules`, by manifest. */
function stagedNames(root) {
  const names = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      const manifestPath = join(path, 'package.json');
      if (existsSync(manifestPath)) {
        try {
          const manifest = readJson(manifestPath);
          if (typeof manifest.name === 'string') names.add(manifest.name);
        } catch {
          names.add(entry.name);
        }
        const nested = join(path, 'node_modules');
        if (existsSync(nested)) walk(nested);
      } else {
        walk(path);
      }
    }
  };
  walk(join(root, 'app', 'node_modules'));
  return names;
}

/** Run the builder's gate without staging anything. */
function planOnly(pruneListPath) {
  return spawnSync(process.execPath, [BUILD, '--prune', pruneListPath, '--plan-only'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: process.env.PATH },
  });
}

function writeTempList(directory, names) {
  const path = join(directory, 'prune.json');
  writeFileSync(path, `${JSON.stringify({ schemaVersion: '1.0', packages: names.map((name) => ({ name })) }, null, 2)}\n`);
  return path;
}

test('the reviewed prune list is still justified by the current tree', () => {
  const list = readJson(PRUNE_LIST);
  assert.equal(list.author, 'PT-dove');
  assert.ok(list.packages.length > 100, `expected a substantial prune list, saw ${list.packages.length}`);
  assert.equal(list.inputs.lockfileSha256, sha256File(join(REPO_ROOT, 'package-lock.json')),
    'the prune list was generated against a different lockfile');
  assert.equal(list.inputs.profileSha256, sha256File(join(REPO_ROOT, 'plugins', 'dsh-defense-profile', 'profile.json')),
    'the prune list was generated against a different profile');

  const { closure, usage, corpus, protectedNames, dependentsIndex } = analyze();
  const failures = [];
  for (const entry of list.packages) {
    const evaluation = evaluateCandidate({
      candidate: { name: entry.name },
      usage,
      nodes: closure.nodes,
      corpus,
      protectedNames,
      declaredBy: dependentsIndex.get(entry.name) ?? [],
    });
    if (!evaluation.allowed) failures.push(`${entry.name}: ${evaluation.blockers.join('; ')}`);
  }
  assert.deepEqual(failures, [], `the prune list no longer holds:\n${failures.slice(0, 10).join('\n')}`);

  // The list must not contain the packages the profile actually mounts, nor a
  // closure root: those are never prunable, and a list that names one is a
  // reviewer mistake that the builder would reject anyway.
  const listed = new Set(list.packages.map((entry) => entry.name));
  for (const name of protectedNames) {
    assert.ok(!listed.has(name), `${name} is a closure root or a mounted plugin and must not be pruned`);
  }
  const stillReachable = [...listed].filter((name) => usage.reachableNames.has(name));
  assert.deepEqual(stillReachable, [], 'the prune list contains packages the module graph reaches');

  // Sanity on the size claim: the sum the list reports has to be the sum of the
  // copies it removes, otherwise the "before/after" numbers are fiction.
  const total = list.packages.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  assert.equal(total, list.summary.prunableBytes, 'the per-entry sizes do not add up to the summary');
  assert.equal(list.summary.prunable, list.packages.length);
  assert.equal(list.summary.prunableCopies, [...closure.nodes.values()]
    .filter((node) => listed.has(node.name)).length,
  'the list must account for every lockfile copy of every pruned name');
});

test('the builder refuses to prune a package the profile loads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm8-prune-used-'));
  try {
    // `@deepseek-ai/dsh-agent` is mounted by the reviewed profile, so the module
    // graph reaches it directly. This is the "delete a used package" case: it has
    // to fail loudly, before anything is written.
    const list = writeTempList(directory, ['@deepseek-ai/dsh-agent']);
    const out = join(directory, 'out');
    const result = spawnSync(process.execPath, [BUILD, '--prune', list, '--out', out], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.notEqual(result.status, 0, 'pruning a mounted plugin must fail the build');
    assert.match(result.stderr, /cannot be justified/);
    assert.match(result.stderr, /dsh-agent/);
    assert.match(result.stderr, /module graph reaches/);
    assert.ok(!existsSync(out), 'the build must fail before creating the output directory');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the builder refuses a prune list entry that no longer exists', () => {
  const directory = mkdtempSync(join(tmpdir(), 'm8-prune-stale-'));
  try {
    const list = writeTempList(directory, ['a-package-that-never-existed']);
    const result = planOnly(list);
    assert.notEqual(result.status, 0, 'a stale entry must fail the build rather than be ignored');
    assert.match(result.stderr, /not in the production closure/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a package referenced only as a string is still kept', () => {
  // node-pty is not imported by anything the profile mounts, but a reached file
  // names it (the subprocess plugin resolves its pty backend from a string). The
  // gate must keep it: a name in the source is a possible computed specifier.
  const directory = mkdtempSync(join(tmpdir(), 'm8-prune-string-'));
  try {
    const list = writeTempList(directory, ['node-pty']);
    const result = planOnly(list);
    assert.notEqual(result.status, 0, 'a package named by a reached file must not be prunable');
    assert.match(result.stderr, /mentions the name/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unreadable code file blocks every candidate, a binary does not', () => {
  // The gate's "keep more" direction has one rule that is easy to get wrong and
  // impossible to observe on the current tree (the only skipped file is a `.node`
  // addon). Exercise it directly: absence of a reference cannot be proven from a
  // corpus with an unread code file in it, but a native binary cannot name a
  // package as a specifier, so it must not block.
  const node = { key: 'node_modules/totally-unused', name: 'totally-unused', version: '1.0.0', license: 'MIT', sourceDir: REPO_ROOT };
  const nodes = new Map([[node.key, node]]);
  const usage = { reachableNames: new Set(), reachedFiles: new Set() };
  const evaluate = (skipped) => evaluateCandidate({
    candidate: { name: 'totally-unused' },
    usage,
    nodes,
    corpus: { entries: [], skipped, repoRoot: REPO_ROOT },
    protectedNames: new Set(),
  });

  assert.equal(evaluate([]).allowed, true, 'with a clean corpus the candidate is prunable');
  assert.equal(evaluate([{ file: join(REPO_ROOT, 'lib', 'x.node'), reason: 'not a text module' }]).allowed, true,
    'a native binary must not block pruning');
  assert.equal(evaluate([{ file: join(REPO_ROOT, 'lib', 'x.json'), reason: 'above limit' }]).allowed, true,
    'an oversized data file is not code');

  const blocked = evaluate([{ file: join(REPO_ROOT, 'lib', 'gate.js'), reason: 'unreadable: EACCES' }]);
  assert.equal(blocked.allowed, false, 'an unreadable code file must block the candidate');
  assert.match(blocked.blockers.join(' '), /could not be scanned/);
  assert.equal(blocked.evidence.unscannedCodeFiles, 1);
});

test('the shipped bundle contains exactly the packages the trim report kept', () => {
  assert.ok(existsSync(join(BUNDLE_ROOT, 'bundle.json')), `the trimmed bundle is missing at ${BUNDLE_ROOT}`);
  const trim = readJson(join(BUNDLE_ROOT, 'manifests', 'trim-report.json'));
  const bundle = readJson(join(BUNDLE_ROOT, 'bundle.json'));
  const inventory = readJson(join(BUNDLE_ROOT, 'manifests', 'third-party-packages.json'));
  const names = stagedNames(BUNDLE_ROOT);

  assert.equal(trim.pruneList.sha256, sha256File(PRUNE_LIST),
    'the bundle was built from a different prune list than the one in the repository');
  assert.equal(bundle.prune.list.sha256, trim.pruneList.sha256);

  const pruned = new Set(trim.pruned.map((row) => row.name));
  assert.ok(pruned.size > 100, `expected a substantial trim, saw ${pruned.size}`);
  assert.equal(pruned.size, trim.summary.prunedNames);
  assert.equal(trim.pruned.length, trim.summary.prunedNodes);

  const leftovers = [...pruned].filter((name) => names.has(name));
  assert.deepEqual(leftovers, [], 'a pruned package is still staged in the bundle');

  // The inventory and the on-disk tree must agree with the trim summary: a bundle
  // that quietly keeps 654 packages while claiming 240 would pass a weaker check.
  // Counts are per lockfile copy; the tree check is per name, so both are compared
  // against their own unit instead of being conflated.
  const inventoryNames = new Set(inventory.packages.map((row) => row.name));
  assert.equal(inventory.count, trim.summary.keptPackages);
  assert.equal(bundle.counts.packages, trim.summary.keptPackages);
  assert.deepEqual([...names].sort(), [...inventoryNames].sort(),
    'the staged package names must be exactly the names the inventory claims');

  // Every pruned entry carries the evidence that allowed it, and no entry may
  // claim a removal whose bytes are still present under another name.
  for (const row of trim.pruned) {
    assert.equal(typeof row.evidence.moduleGraphReachable, 'boolean');
    assert.equal(row.evidence.moduleGraphReachable, false, `${row.name} was pruned while the graph reached it`);
    assert.equal(row.evidence.stringReferences, 0, `${row.name} was pruned while a reached file named it`);
    assert.ok(row.sizeBytes > 0, `${row.name} has no recorded size`);
  }

  const keptBytes = trim.pruned.reduce((sum, row) => sum + row.sizeBytes, 0);
  assert.equal(keptBytes, trim.summary.prunedBytes, 'the trim report sizes do not add up');
  assert.ok(trim.summary.prunedBytes > 100 * 1024 * 1024, 'the trim should remove more than 100 MiB to be worth the risk');
});

/**
 * `dfa@1.2.0` is the only package in the tree with no upstream licence text, and
 * it was the last release blocker in M8. Removing it is only legitimate if it is
 * unreachable *from this profile*, not merely "the gate did not find a use".
 *
 * The chain, read from the lockfile rather than assumed:
 *
 *   dfa <- fontkit <- @deepseek-ai/libreoffice-kit <- @deepseek-ai/dsh-skill-office
 *
 * Two independent gates keep that chain from ever running here, and both have to
 * be stated exactly, because the loose version of this claim is false:
 *
 * 1. `@deepseek-ai/dsh-skill-office` is a **declared** dependency of
 *    `@deepseek-ai/dsh-sdk-app`, which the profile does mount. A dependency
 *    closure therefore does contain dfa. What does not exist is an **import
 *    edge**: no file reachable from the mounted profile imports skill-office.
 *    The profile's `cordis.patch.yml` is an explicit `insert:` tree that
 *    inherits no bundle, so the patch `dsh-sdk-app` ships (which would mount
 *    `skill-office`) never applies, and the runtime manifest shows 21 entries
 *    that are exactly `allowedPluginIds`.
 * 2. Even if skill-office were loaded, it does not import the kit: its entry
 *    resolves the kit's `package.json` only to locate `lib/cli.js`
 *    (`import.meta.resolve`), so loading `fontkit`/`dfa` additionally requires
 *    spawning the LibreOffice CLI. `libreoffice-kit` is what carries the
 *    `import "fontkit"` side effect, and `fontkit` is what imports `dfa`.
 *
 * So the honest claim is "no mounted import reaches it", not "no code path
 * exists" — the latter would need the office CLI to be disabled *and* the
 * profile to stay as it is.
 */
test('the dfa licence blocker is closed by pruning a chain no mounted import reaches', () => {
  const list = readJson(PRUNE_LIST);
  const listed = new Set(list.packages.map((entry) => entry.name));
  for (const name of ['dfa', 'fontkit', '@deepseek-ai/libreoffice-kit']) {
    assert.ok(listed.has(name), `${name} must be in the reviewed prune list`);
  }

  // 1. The dependency chain, read from the lockfile rather than assumed: if a
  //    future dependency starts importing dfa directly, this assertion fails
  //    before the prune list can go stale.
  const { packages } = loadLockfile(REPO_ROOT);
  const dependentsOf = (target) => Object.entries(packages)
    .filter(([, entry]) => ['dependencies', 'optionalDependencies', 'peerDependencies']
      .some((field) => entry[field] !== undefined && entry[field][target] !== undefined))
    .map(([key]) => key.replace(/^.*node_modules\//, ''))
    .sort();
  assert.deepEqual(dependentsOf('dfa'), ['fontkit'],
    'dfa must be reachable only through fontkit; a new dependent invalidates this trim');
  assert.deepEqual(dependentsOf('fontkit'), ['@deepseek-ai/libreoffice-kit']);
  assert.deepEqual(dependentsOf('@deepseek-ai/libreoffice-kit'),
    ['@deepseek-ai/dsh-office-to-pdf', '@deepseek-ai/dsh-skill-office']);

  // 2. The near miss, asserted so nobody re-derives the wrong conclusion: the
  //    chain's top is declared by a *mounted* plugin, which is why a dependency
  //    closure contains dfa while the import graph does not.
  const sdkApp = packages['node_modules/@deepseek-ai/dsh-sdk-app'];
  assert.ok(sdkApp !== undefined, 'the profile mounts dsh-sdk-app as sdk-app-startup');
  assert.ok(sdkApp.dependencies?.['@deepseek-ai/dsh-skill-office'] !== undefined,
    'dsh-sdk-app declares skill-office: this trim rests on it never being imported, not on it being undeclared');

  // 3. No link of the chain is in the import graph the profile mounts.
  const { closure, usage, corpus, protectedNames, dependentsIndex } = analyze();
  for (const name of ['dfa', 'fontkit', '@deepseek-ai/libreoffice-kit', '@deepseek-ai/dsh-skill-office']) {
    assert.equal(usage.reachableNames.has(name), false, `${name} must not be imported from the mounted profile`);
  }
  // The profile mounts no office capability at all, which is the other half of
  // gate 1: an unimported plugin can only run if something mounts it by name.
  const profile = loadProfile();
  const mounted = [...profile.allowedPluginIds, ...Object.values(profile.pluginPackages ?? {})].join(' ').toLowerCase();
  for (const marker of ['office', 'skill', 'libreoffice']) {
    assert.equal(mounted.includes(marker), false, `the profile must mount no ${marker} capability`);
  }

  // 4. The gate allows it, and it allows it for the recorded reason.
  const evaluation = evaluateCandidate({
    candidate: { name: 'dfa' },
    usage,
    nodes: closure.nodes,
    corpus,
    protectedNames,
    declaredBy: dependentsIndex.get('dfa') ?? [],
  });
  assert.deepEqual(evaluation.blockers, [], `dfa must be prunable:\n${evaluation.blockers.join('\n')}`);
  assert.equal(evaluation.allowed, true);
  assert.equal(evaluation.evidence.stringReferences, 0);
  assert.deepEqual(evaluation.evidence.declaredBy, ['fontkit (dependencies)']);

  // 5. The occurrence that used to keep dfa in the bundle is a hex fragment of a
  //    commit hash in a URL, not a specifier. Asserted on the real bytes so the
  //    dismissal cannot be a comment that outlived the fact.
  const { bounded, embedded } = occurrencesOf(corpus, 'dfa');
  assert.deepEqual(bounded, [], 'no reached file may spell dfa as a standalone token');
  assert.ok(embedded.length >= 1,
    'the historical false positive is gone; re-derive this dismissal instead of inheriting it');
  const bodyFile = join(REPO_ROOT, 'node_modules', 'undici', 'lib', 'web', 'fetch', 'body.js');
  assert.ok(existsSync(bodyFile), 'the recorded occurrence lives in undici body.js');
  const text = readFileSync(bodyFile, 'latin1');
  const offset = text.indexOf('dfa');
  assert.ok(offset > 0, 'the historical occurrence moved; re-derive the dismissal');
  assert.equal(isTokenBounded(text, offset, 3), false, 'a hex fragment must not count as a mention');
  assert.match(text[offset - 1], /[0-9a-f]/, 'the fragment must sit inside a hex run');
  assert.match(text[offset + 3], /[0-9a-f]/, 'the fragment must sit inside a hex run');
  assert.equal(evaluation.evidence.dismissedSubstringHits, embedded.length,
    'every dismissed occurrence must be recorded in the evidence');
});

/**
 * The net that kept `dfa` for a whole release must still catch a real mention.
 * This is the negative half of the token rule: tightening it is only safe if the
 * cases it must keep blocking still block.
 */
test('the string-reference net blocks a real mention and ignores a fragment of a longer token', () => {
  const node = (name) => ({
    key: `node_modules/${name}`, name, version: '1.2.0', license: 'MIT', sourceDir: REPO_ROOT,
  });
  const evaluate = (name, text) => evaluateCandidate({
    candidate: { name },
    usage: { reachableNames: new Set(), reachedFiles: new Set() },
    nodes: new Map([[`node_modules/${name}`, node(name)]]),
    corpus: { entries: [{ file: join(REPO_ROOT, 'probe.js'), text }], skipped: [], repoRoot: REPO_ROOT },
    protectedNames: new Set(),
  });

  // Must block: every spelling that can really name the package.
  const blocking = [
    "require('dfa')",
    'import dfa from "dfa";',
    "await import('dfa/sub')",
    '{"dfa": "1.2.0"}',
    'node_modules/dfa/index.js',
    'dfa@1.2.0',
  ];
  for (const text of blocking) {
    const result = evaluate('dfa', text);
    assert.equal(result.allowed, false, `${JSON.stringify(text)} must block the candidate`);
    assert.match(result.blockers.join(' '), /mentions the name/);
    assert.ok(result.evidence.stringReferences > 0);
  }

  // Must not block: the name only exists inside a longer token, which is a
  // different name (a hex digest, a longer package name).
  const hexFragment = 'https://github.com/curl/blob/3434c6b46e682452973972e8313613dfa58cd690/lib/mime.c';
  const hex = evaluate('dfa', hexFragment);
  assert.equal(hex.allowed, true, `a hex fragment must not block: ${hex.blockers.join('; ')}`);
  assert.equal(hex.evidence.stringReferences, 0);
  assert.equal(hex.evidence.dismissedSubstringHits, 1, 'the dismissal must be counted, not silent');

  const longerName = evaluate('@deepseek-ai/dsh-persona', '{"bundles":["@deepseek-ai/dsh-personalized-recommendations"]}');
  assert.equal(longerName.allowed, true, 'a prefix of a longer package name is not a mention of the shorter one');
  assert.equal(longerName.evidence.dismissedSubstringHits, 1);
  const exactName = evaluate('@deepseek-ai/dsh-persona', '{"bundles":["@deepseek-ai/dsh-persona"]}');
  assert.equal(exactName.allowed, false, 'the exact name must still block');
});

/**
 * Closing the licence blocker is only worth anything if the delivered bytes say
 * so: the package must be gone, and the gap list must be empty and consistent
 * with the inventory (a `count: 0` that contradicts 240 inventory rows would be
 * the same kind of fiction this task exists to remove).
 */
/**
 * The list has to stay complete, not just sound.
 *
 * The first test proves every listed name is still allowed; that alone would let
 * a tightened rule clear a package and leave it shipping unnoticed, because a
 * sound list can still be stale. This closes the other direction: whatever the
 * gate now allows is either pruned or explicitly held, so regenerating cannot
 * quietly widen or narrow the payload.
 */
test('the prune list accounts for every package the gate allows', () => {
  const list = readJson(PRUNE_LIST);
  const listed = new Set(list.packages.map((entry) => entry.name));
  const held = new Map((list.heldBack ?? []).map((row) => [row.name, row.reason]));
  const { closure, usage, corpus, protectedNames, dependentsIndex } = analyze();
  const rows = pruneCandidates({
    usage,
    nodes: closure.nodes,
    corpus,
    protectedNames,
    dependentsIndex,
    sizeOf: () => 0,
  });
  const allowed = rows.filter((row) => row.allowed);
  const uncovered = allowed.filter((row) => !listed.has(row.name) && !held.has(row.name));
  assert.deepEqual(uncovered.map((row) => row.name), [],
    'the gate allows these but the list neither prunes nor holds them; regenerate with prune.mjs --write');
  // A held package must say why, and must not also be listed for removal.
  for (const [name, reason] of held) {
    assert.equal(listed.has(name), false, `${name} is both pruned and held`);
    assert.ok(typeof reason === 'string' && reason.length > 40, `${name} is held without a usable reason`);
  }
  // Set equality, not a count: names and lockfile copies are different units, and
  // conflating them is exactly how a "240 packages / 654 packages" claim goes wrong.
  assert.deepEqual(
    [...new Set(allowed.map((row) => row.name))].sort(),
    [...listed, ...held.keys()].sort(),
    'the gate-allowed names and the list (pruned + held) must be the same set',
  );
});

test('the delivered bundle ships no dfa copy and no open licence gap', () => {
  assert.ok(existsSync(join(BUNDLE_ROOT, 'bundle.json')), `the delivered bundle is missing at ${BUNDLE_ROOT}`);
  const gaps = readJson(join(BUNDLE_ROOT, 'manifests', 'license-gaps.json'));
  const bundle = readJson(join(BUNDLE_ROOT, 'bundle.json'));
  const inventory = readJson(join(BUNDLE_ROOT, 'manifests', 'third-party-packages.json'));
  const names = stagedNames(BUNDLE_ROOT);

  assert.equal(names.has('dfa'), false, 'the delivered bundle must not stage dfa');
  assert.equal(names.has('fontkit'), false, 'the delivered bundle must not stage fontkit');
  assert.equal(gaps.count, 0, `licence gaps must be empty, saw ${JSON.stringify(gaps.packages.map((row) => row.name))}`);
  assert.deepEqual(gaps.packages, []);
  assert.equal(bundle.license.packagesWithoutLicenseText, 0);
  assert.equal(bundle.license.complete, true, 'license.complete must be true once no gap is open');
  assert.deepEqual(bundle.releaseGaps, [], 'a closed gap must not stay in releaseGaps');
  assert.equal(bundle.prune.prunedNames, readJson(PRUNE_LIST).summary.prunable);

  const uncovered = inventory.packages.filter((row) => row.licenseFiles.length === 0);
  assert.deepEqual(uncovered.map((row) => `${row.name}@${row.version}`), [],
    'every inventoried package must carry a licence text');
  for (const row of inventory.packages) {
    for (const file of row.licenseFiles) {
      // `licenseFiles` is relative to `manifests/`, not to the bundle root.
      assert.ok(existsSync(join(BUNDLE_ROOT, 'manifests', file)),
        `${row.name}: recorded licence file is absent: ${file}`);
    }
  }
});
