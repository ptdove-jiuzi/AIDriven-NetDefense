/**
 * v14 vs v13 payload delta (author PT-dove).
 *
 * Answers "what does the new payload add?" without rebuilding v13: both recipes are
 * derived from the *same* committed lockfile and their own reviewed prune lists, so
 * the difference between the two kept sets is the packages the daemon closure pulls
 * in beyond the worker closure. Nothing is copied and no bundle is touched.
 *
 * The numbers are only comparable while `package-lock.json` is unchanged: a lockfile
 * change moves both sides, and a delta computed across two lockfiles would describe a
 * difference that is not this task's.
 *
 * usage: node tests/packaging/v14-v13-delta.mjs [--json <file>]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeClosure, loadLockfile } from '../../deploy/embedded-runtime/lib/closure.mjs';
import { loadProfile } from '../../deploy/embedded-runtime/lib/profiles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const RUNTIME_DIR = join(REPO_ROOT, 'deploy', 'embedded-runtime');

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pruneNames(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const listed = Array.isArray(document) ? document : document.packages;
  return new Set(listed.map((entry) => (typeof entry === 'string' ? entry : entry.name)));
}

function prunePathFor(profileName) {
  // Same rule the builder applies: a per-profile list wins, otherwise the default
  // one is used. `worker` has no `prune-list-worker.json` — its list *is* the
  // default `prune-list.json`, which is why hard-coding `<profile>.json` fails.
  const perProfile = join(RUNTIME_DIR, `prune-list-${profileName}.json`);
  return existsSync(perProfile) ? perProfile : join(RUNTIME_DIR, 'prune-list.json');
}

function keptFor(profileName) {
  const profile = loadProfile(profileName);
  const { packages } = loadLockfile(REPO_ROOT);
  const closure = computeClosure({ repoRoot: REPO_ROOT, packages, roots: profile.closureRoots });
  const prunePath = prunePathFor(profileName);
  const pruned = pruneNames(prunePath);
  const kept = new Map([...closure.nodes].filter(([, node]) => !pruned.has(node.name)));
  const byName = new Map();
  for (const node of kept.values()) {
    if (!byName.has(node.name)) byName.set(node.name, { name: node.name, version: node.version, license: node.license, copies: 0 });
    byName.get(node.name).copies += 1;
  }
  return {
    profile: profileName,
    closureRoots: profile.closureRoots,
    closureNodes: closure.nodes.size,
    prunedNames: pruned.size,
    keptNodes: kept.size,
    keptNames: new Set(byName.keys()),
    packages: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name, 'en')),
    pruneList: {
      path: relative(REPO_ROOT, prunePath).split(sep).join('/'),
      sha256: sha256File(prunePath),
    },
  };
}

const v13 = keptFor('worker');
const v14 = keptFor('daemon-console');
const added = v14.packages.filter((pkg) => !v13.keptNames.has(pkg.name));
const removed = v13.packages.filter((pkg) => !v14.keptNames.has(pkg.name));

const document = {
  schemaVersion: '1.0',
  author: 'PT-dove',
  generatedFrom: {
    lockfile: 'package-lock.json',
    lockfileSha256: sha256File(join(REPO_ROOT, 'package-lock.json')),
    note: 'Both sides are derived from this one lockfile, so the delta is a composition change, not a lockfile drift.',
  },
  v13: {
    profile: v13.profile,
    closureRoots: v13.closureRoots,
    closureNodes: v13.closureNodes,
    prunedNames: v13.prunedNames,
    keptNodes: v13.keptNodes,
    keptUniqueNames: v13.keptNames.size,
    pruneList: v13.pruneList,
  },
  v14: {
    profile: v14.profile,
    closureRoots: v14.closureRoots,
    closureNodes: v14.closureNodes,
    prunedNames: v14.prunedNames,
    keptNodes: v14.keptNodes,
    keptUniqueNames: v14.keptNames.size,
    pruneList: v14.pruneList,
  },
  delta: {
    closureNodes: v14.closureNodes - v13.closureNodes,
    keptNodes: v14.keptNodes - v13.keptNodes,
    keptUniqueNames: v14.keptNames.size - v13.keptNames.size,
    addedCount: added.length,
    removedCount: removed.length,
  },
  added,
  removed,
};

const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex !== -1) {
  const target = process.argv[jsonIndex + 1];
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
