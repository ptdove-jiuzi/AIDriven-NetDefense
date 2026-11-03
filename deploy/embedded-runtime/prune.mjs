#!/usr/bin/env node
/**
 * Generate or inspect the reviewed prune list (author PT-dove).
 *
 * usage:
 *   node deploy/embedded-runtime/prune.mjs                     # report to stdout
 *   node deploy/embedded-runtime/prune.mjs --write              # rewrite prune-list.json
 *   node deploy/embedded-runtime/prune.mjs --blocked            # only the packages the gate refused
 *   node deploy/embedded-runtime/prune.mjs --profile daemon-console --write
 *
 * `--profile` selects the bundle composition the list is derived from. A prune
 * decision is only valid for the closure it was computed against, so a list
 * generated for the worker payload is *not* a valid list for daemon+console: the
 * daemon reaches packages the worker never imported. The writer names the file
 * after the profile (`prune-list-<profile>.json`, `prune-list.json` for the
 * default `worker`) so the two can never be confused for one another.
 *
 * The list is generated, but it is not self-approving: `build.mjs --prune` runs
 * the same gate again before staging anything, so editing this file by hand to
 * remove a package the profile loads makes the build fail rather than producing a
 * bundle that cannot boot.
 */

import { readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeClosure, loadLockfile } from './lib/closure.mjs';
import { isInside } from './lib/paths.mjs';
import { DEFAULT_PROFILE, loadProfile } from './lib/profiles.mjs';
import {
  analyzeUsage,
  buildDependentsIndex,
  loadReachedCorpus,
  pruneCandidates,
} from './lib/usage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const AUTHOR = 'PT-dove';

/**
 * Names the gate allows but this task deliberately does not remove.
 *
 * The gate is an over-approximating net; it answers "is this package provably
 * unused", not "should this package ship". Removing a package is a decision with
 * its own review cost, so a name the tightened gate newly clears is held here
 * instead of silently joining the payload. `--write` keeps the hold in the file,
 * so regenerating the list cannot expand the prune surface by accident.
 */
const HELD = new Map([
  ['@deepseek-ai/dsh-persona',
    'the only occurrences are fragments of @deepseek-ai/dsh-personalized-recommendations, so the token rule '
    + 'clears it; removal is outside M8-DFA-PRUNE scope and needs its own review before it changes the payload'],
]);

function packageSize(directory) {  let total = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  walk(directory);
  return total;
}

/**
 * One row per package name.
 *
 * The closure can hold two copies of the same package (nested lockfile paths).
 * Pruning is name-level, so the list reports the name once with the copies it
 * removes; otherwise the file claims N entries while the builder removes fewer.
 */
function dedupeByName(rows) {
  const byName = new Map();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (existing === undefined) {
      byName.set(row.name, { ...row, copies: 1 });
      continue;
    }
    existing.sizeBytes += row.sizeBytes;
    existing.copies += 1;
    if (existing.version !== row.version) existing.version = `${existing.version}, ${row.version}`;
  }
  return [...byName.values()].sort((left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name, 'en'));
}

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const onlyBlocked = argv.includes('--blocked');
  let profileName = process.env.M8_BUNDLE_PROFILE ?? DEFAULT_PROFILE;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') profileName = argv[index + 1] ?? DEFAULT_PROFILE;
  }
  const bundleProfile = loadProfile(profileName);
  const CLOSURE_ROOTS = bundleProfile.closureRoots;
  const OUTPUT = join(HERE, bundleProfile.name === DEFAULT_PROFILE ? 'prune-list.json' : `prune-list-${bundleProfile.name}.json`);

  const { packages } = loadLockfile(REPO_ROOT);
  const profilePath = join(REPO_ROOT, 'plugins', 'dsh-defense-profile', 'profile.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const closure = computeClosure({ repoRoot: REPO_ROOT, packages, roots: CLOSURE_ROOTS });
  const usage = analyzeUsage({ repoRoot: REPO_ROOT, nodes: closure.nodes, profile, closureRoots: CLOSURE_ROOTS });
  const corpus = loadReachedCorpus({ usage, repoRoot: REPO_ROOT });
  const dependentsIndex = buildDependentsIndex({ nodes: closure.nodes });

  const protectedNames = new Set(CLOSURE_ROOTS);
  for (const name of Object.values(profile.pluginPackages ?? {})) protectedNames.add(name);
  for (const node of closure.nodes.values()) {
    if (isInside(node.sourceDir, join(REPO_ROOT, 'plugins'))) protectedNames.add(node.name);
  }

  const rows = pruneCandidates({
    usage,
    nodes: closure.nodes,
    corpus,
    protectedNames,
    dependentsIndex,
    sizeOf: (node) => packageSize(node.sourceDir),
  });
  const allowed = rows.filter((row) => row.allowed && !HELD.has(row.name));
  const held = rows.filter((row) => row.allowed && HELD.has(row.name));
  const blocked = rows.filter((row) => !row.allowed);
  const unique = dedupeByName(allowed);
  const bytes = unique.reduce((sum, row) => sum + row.sizeBytes, 0);

  if (!write) {
    const shown = onlyBlocked ? blocked : rows;
    for (const row of shown.filter((row) => (onlyBlocked ? true : row.allowed))) {
      const flag = HELD.has(row.name) ? 'HOLD ' : row.allowed ? 'prune' : 'KEEP ';
      process.stdout.write(`${flag} ${(row.sizeBytes / 1048576).toFixed(2).padStart(8)} MiB  ${row.name}@${row.version}\n`);
      if (onlyBlocked && !row.allowed) process.stdout.write(`        ${row.blockers.join('\n        ')}\n`);
      if (onlyBlocked && HELD.has(row.name)) process.stdout.write(`        ${HELD.get(row.name)}\n`);
    }
    process.stdout.write(`\nclosure ${closure.nodes.size} · reachable ${usage.reachableNames.size} · prunable ${unique.length} names (${allowed.length} copies, ${(bytes / 1048576).toFixed(1)} MiB) · kept-by-gate ${blocked.length} · held-back ${held.length}\n`);
    process.stdout.write(`gate: corpus ${corpus.entries.length} files (${corpus.skipped.length} unreadable/non-text), dynamic specifier sites ${usage.dynamicSites.length}\n`);
    return;
  }

  const document = {
    schemaVersion: '1.0',
    author: AUTHOR,
    generatedBy: 'deploy/embedded-runtime/prune.mjs',
    reviewNote: 'Generated evidence. A separate read-only agent reviews this decision and records the outcome in '
      + 'docs/implementation/status/M8-FORMAL-PACKAGING.md; the builder re-runs the same gate, so this file is a '
      + 'decision record, not an authority.',
    inputs: {
      lockfileSha256: readFileSync(join(REPO_ROOT, 'package-lock.json')),
      profileSha256: readFileSync(profilePath),
      bundleProfileName: bundleProfile.name,
      bundleProfileSha256: bundleProfile.sha256,
      closureRoots: bundleProfile.closureRoots,
    },
    gate: {
      closurePackages: closure.nodes.size,
      reachablePackages: usage.reachableNames.size,
      reachedFiles: usage.reachedFiles.size,
      corpusFiles: corpus.entries.length,
      corpusSkipped: corpus.skipped.length,
      dynamicSpecifierSites: usage.dynamicSites.map((site) => site.file),
      protectedPackages: [...protectedNames].sort(),
      rule: [
        'a package is prunable only when all of the following hold',
        '1. no file reachable from the mounted profile imports it (module graph)',
        '2. no reached file mentions its name as a standalone token (computed specifiers);',
        '   an occurrence inside a longer identifier, hex digest or base64 run is a different name',
        '3. it is not a closure root or a reviewed workspace package',
        '4. it is not an optional platform variant of a reachable package',
      ],
    },
    summary: {
      prunable: unique.length,
      prunableCopies: allowed.length,
      keptByGate: blocked.length,
      heldBack: held.length,
      prunableBytes: bytes,
      prunableMiB: Number((bytes / 1048576).toFixed(1)),
    },
    heldBack: held.map((row) => ({ name: row.name, version: row.version, reason: HELD.get(row.name) })),
    packages: unique.map((row) => ({
      name: row.name,
      version: row.version,
      license: row.license,
      sizeBytes: row.sizeBytes,
      copies: row.copies,
      declaredBy: row.evidence.declaredBy.slice(0, 4),
      declaredByCount: row.evidence.declaredBy.length,
    })),
  };
  // Hash the inputs rather than embedding them: the file must stay reviewable.
  const crypto = process.getBuiltinModule('node:crypto');
  document.inputs.lockfileSha256 = crypto.createHash('sha256').update(document.inputs.lockfileSha256).digest('hex');
  document.inputs.profileSha256 = crypto.createHash('sha256').update(document.inputs.profileSha256).digest('hex');
  writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`wrote ${OUTPUT}: ${allowed.length} packages, ${(bytes / 1048576).toFixed(1)} MiB\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`prune: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
