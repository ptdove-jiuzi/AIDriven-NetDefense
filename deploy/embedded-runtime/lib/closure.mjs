/**
 * Production dependency closure over `package-lock.json` (lockfileVersion 3).
 *
 * The bundle must not run `npm install`, so the closure is derived from the
 * committed lockfile and satisfied from the already-installed `node_modules`
 * tree. Two rules keep the result honest:
 *
 * - only production edges are followed (`dependencies`, `optionalDependencies`,
 *   and non-optional `peerDependencies`); `devDependencies` are never walked;
 * - a package that the lockfile places but the disk does not have is accepted
 *   **only** when every edge that reached it was optional or peer-optional,
 *   because that is exactly the platform-variant case npm skips. A package
 *   reached through a required edge and missing from disk fails the build.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EDGE_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Resolve one dependency name the way Node resolves it from `fromKey`. */
export function resolveDependencyKey(packages, fromKey, name) {
  let base = fromKey;
  for (let guard = 0; guard < 128; guard += 1) {
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (base === '') return undefined;
    const index = base.lastIndexOf('/node_modules/');
    base = index === -1 ? '' : base.slice(0, index);
  }
  return undefined;
}

/**
 * Dependency edges of one entry. The lockfile carries them for registry
 * packages; workspace packages (and any package pinned to a frozen snapshot) are
 * read from the manifest that will actually be copied, so an override cannot
 * silently keep the live working tree's dependency list.
 */
function dependencyEdges(repoRoot, entry, sourceDir) {
  const optional = new Set(Object.keys(entry.optionalDependencies ?? {}));
  for (const [name, meta] of Object.entries(entry.peerDependenciesMeta ?? {})) {
    if (meta?.optional === true) optional.add(name);
  }
  const names = new Set();
  for (const field of EDGE_FIELDS) {
    for (const name of Object.keys(entry[field] ?? {})) names.add(name);
  }
  const manifestPath = join(sourceDir ?? join(repoRoot, entry.nodeModulesKey), 'package.json');
  if (!existsSync(manifestPath)) {
    if (entry.link === true) throw new Error(`workspace manifest missing: ${manifestPath}`);
    return [...names].map((name) => ({ name, optional: optional.has(name) }));
  }
  const manifest = readJsonFile(manifestPath);
  for (const field of EDGE_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
    if (meta?.optional === true) optional.add(name);
  }
  return [...names].map((name) => ({ name, optional: optional.has(name) }));
}

export function loadLockfile(repoRoot) {
  const lock = readJsonFile(join(repoRoot, 'package-lock.json'));
  if (lock.lockfileVersion !== 3) {
    throw new Error(`unsupported lockfileVersion ${lock.lockfileVersion}; this builder needs 3`);
  }
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    packages[key] = { ...entry, nodeModulesKey: key };
  }
  return { lock, packages };
}

/** Root entry key for one package name, or a readable failure. */
export function rootKeyOf(packages, name) {
  const key = `node_modules/${name}`;
  if (packages[key] === undefined) throw new Error(`root dependency ${name} is absent from the lockfile`);
  return key;
}

/**
 * Walk every production edge reachable from the given roots.
 *
 * @param options.repoRoot repository root holding `package-lock.json` and `node_modules`
 * @param options.packages lockfile `packages` map with `nodeModulesKey` attached
 * @param options.roots package names that seed the walk
 * @param options.sourceOverrides optional map of package name → directory, used to
 *   pin workspace packages (`plugins/*`, `packages/*`, `apps/*`) to a frozen copy
 *   instead of whatever the live working tree currently holds
 * @returns `{ nodes, absent }` where `nodes` is a Map of key →
 *   `{ key, name, version, license, sourceDir, optionalOnly }`
 */
export function computeClosure({ repoRoot, packages, roots, sourceOverrides = new Map() }) {
  const nodes = new Map();
  const absent = [];
  const missingRequiredEdges = [];
  const queue = roots.map((name) => ({ key: rootKeyOf(packages, name), optionalOnly: false }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (nodes.has(next.key)) {
      const existing = nodes.get(next.key);
      if (!next.optionalOnly) existing.optionalOnly = false;
      continue;
    }
    const entry = packages[next.key];
    const name = (manifestNameOf(repoRoot, entry) ?? next.key.replace(/^.*node_modules\//, ''));
    const override = sourceOverrides.get(name);
    const sourceDir = override ?? join(repoRoot, entry.link === true ? entry.resolved : next.key);
    const manifestPath = join(sourceDir, 'package.json');
    if (!existsSync(manifestPath)) {
      // Lockfile-placed but not installed: only legitimate for optional/platform edges.
      if (!next.optionalOnly) missingRequiredEdges.push({ key: next.key, name, reason: 'missing on disk' });
      absent.push({ key: next.key, reason: 'not installed' });
      continue;
    }
    const manifest = readJsonFile(manifestPath);
    nodes.set(next.key, {
      key: next.key,
      name: manifest.name ?? name,
      version: manifest.version ?? entry.version ?? '0.0.0',
      license: manifest.license ?? entry.license ?? 'UNKNOWN',
      sourceDir,
      optionalOnly: next.optionalOnly,
      fromOverride: override !== undefined,
    });
    for (const edge of dependencyEdges(repoRoot, entry, sourceDir)) {
      const resolved = resolveDependencyKey(packages, next.key, edge.name);
      if (resolved === undefined) {
        if (edge.optional) {
          absent.push({ name: edge.name, from: next.key, reason: 'optional peer/dependency not installed' });
          continue;
        }
        missingRequiredEdges.push({ name: edge.name, from: next.key, reason: 'not in lockfile' });
        continue;
      }
      // A package that is present on disk must satisfy its own required edges,
      // even when an optional edge is what pulled it in.
      queue.push({ key: resolved, optionalOnly: edge.optional });
    }
  }

  if (missingRequiredEdges.length > 0) {
    const sample = missingRequiredEdges.slice(0, 10)
      .map((row) => `${row.name ?? row.key} (${row.reason}, from ${row.from ?? '-'})`)
      .join('; ');
    throw new Error(`production closure incomplete: ${missingRequiredEdges.length} required edge(s) unresolved: ${sample}`);
  }
  return { nodes, absent };
}

function manifestNameOf(repoRoot, entry) {
  const path = join(repoRoot, entry.link === true ? entry.resolved : entry.nodeModulesKey, 'package.json');
  if (!existsSync(path)) return undefined;
  return readJsonFile(path).name;
}
