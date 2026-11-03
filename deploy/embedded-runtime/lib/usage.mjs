/**
 * Usage evidence for dependency pruning (M8 formal stage).
 *
 * Pruning a dependency out of the bundle is only defensible if the decision is
 * reproducible from the shipped bytes. This module produces that evidence with
 * three independent, deliberately over-approximating signals:
 *
 * 1. **Module graph reachability** — a real file-level walk from the entry
 *    points the profile actually mounts (worker bin, adapter, dsh CLI, and every
 *    package named in `profile.json.pluginPackages`). Static `import`/`export
 *    from`/`require`/literal `import()` edges only.
 * 2. **String references** — every *reached* file is scanned for the candidate
 *    name as a literal token. A loader that resolves a package from a name table
 *    would not show up as an import edge, so an unread name table would
 *    otherwise look like an unused package. "Token" rather than "substring" is
 *    deliberate: a name that only occurs inside a longer identifier is a
 *    different name, not a mention of this one. `dfa` inside the hex commit hash
 *    `3434c6b4…dfa58cd690`, or `@deepseek-ai/dsh-persona` inside
 *    `@deepseek-ai/dsh-personalized-recommendations`, cannot be a specifier for
 *    the shorter package, and treating it as one makes the net keep packages for
 *    reasons no reviewer can act on. Embedded occurrences are still counted and
 *    reported (`dismissedSubstringHits`) so the dismissal is auditable instead of
 *    silent.
 * 3. **Runtime observation** — the set of files Node actually loaded during a
 *    real `initialize`/`shutdown` boot (captured by `tests/packaging/module-trace`).
 *
 * The direction of every approximation is "keep more": an unresolvable specifier
 * keeps its package, comments and string tables count as references, an unreadable
 * code file blocks every candidate, and platform variants of a reached package are
 * kept without asking. A candidate is pruned only when the signals that do run all
 * call it unused, and the builder re-checks the same gate before staging, so a stale
 * list fails the build instead of shipping a bundle whose worker cannot boot.
 *
 * Scope of the guarantee, stated exactly: the build runs **two** signals (module
 * graph + string references). The third — the modules a real `initialize`/`shutdown`
 * actually loads — can only be observed after a bundle exists, so it is applied as
 * a post-hoc check by `tests/packaging/bundle.test.js` against the built bundle.
 * Neither signal covers a code path the profile never mounts, which is why the
 * residual risk is recorded in the task status rather than claimed away.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isInside, slash } from './paths.mjs';

/** Files larger than this are not parsed; the package is kept instead. */
const PARSE_LIMIT = 8 * 1024 * 1024;
const SCRIPT_FILE = /\.(?:mjs|cjs|js|jsx|ts|mts|cts)$/i;

const LITERAL_SPECIFIERS = [
  // `import x from 'pkg'`, `export … from 'pkg'`, `export * from 'pkg'`
  /(?:^|[^\w$.])from\s*['"]([^'"\r\n]+)['"]/g,
  // bare side-effect import: `import 'pkg'`
  /(?:^|[^\w$.])import\s*['"]([^'"\r\n]+)['"]/g,
  // literal dynamic import: `import('pkg')`
  /(?:^|[^\w$.])import\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g,
  // `require('pkg')` / `require.resolve('pkg')`
  /(?:^|[^\w$.])require(?:\.resolve)?\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g,
];
/** A call whose argument is not a string literal: we cannot know what it loads. */
const DYNAMIC_SPECIFIER = /(?:^|[^\w$.])(?:import|require(?:\.resolve)?)\s*\(\s*[^'"\s)]/g;

const BUILTIN = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib', 'test', 'sea', 'sqlite', 'node:test', 'node:sqlite',
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fold(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * Package name a bare specifier resolves to. `@scope/name/sub` → `@scope/name`,
 * `name/sub` → `name`. Returns `undefined` for relative and absolute specifiers.
 */
export function packageNameOfSpecifier(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier)) {
    return undefined;
  }
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function subpathOf(specifier, packageName) {
  if (specifier === packageName) return '.';
  return `.${specifier.slice(packageName.length)}`;
}

function probeFile(base) {
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const suffix of ['/index.js', '/index.mjs', '/index.cjs']) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Flatten an `exports` value to a plain string target. */
function targetOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = targetOf(entry);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const condition of ['import', 'node', 'default', 'require']) {
      if (value[condition] !== undefined) {
        const target = targetOf(value[condition]);
        if (target !== undefined) return target;
      }
    }
  }
  return undefined;
}

function exportsMapOf(manifest) {
  const exported = manifest.exports;
  if (exported === undefined || exported === null) return undefined;
  if (typeof exported === 'string' || Array.isArray(exported)) return { '.': exported };
  const keys = Object.keys(exported);
  if (keys.every((key) => key.startsWith('.'))) return exported;
  // Condition-only object: `{ import: './x.js' }`
  return { '.': exported };
}

/**
 * Resolve one subpath of a package to a file, following `exports` when present.
 * A package that declares `exports` and does not list the subpath throws at
 * runtime, so returning `undefined` there matches Node rather than guessing.
 */
export function resolvePackageSubpath(packageDir, manifest, subpath) {
  const map = exportsMapOf(manifest);
  if (map !== undefined) {
    if (map[subpath] !== undefined) {
      const target = targetOf(map[subpath]);
      if (target !== undefined) return probeFile(join(packageDir, target));
    }
    for (const [key, value] of Object.entries(map)) {
      if (!key.includes('*')) continue;
      const [prefix, suffix] = key.split('*');
      if (!subpath.startsWith(prefix)) continue;
      if (suffix !== undefined && !subpath.endsWith(suffix)) continue;
      const middle = subpath.slice(prefix.length, subpath.length - (suffix ?? '').length);
      const target = targetOf(value);
      if (target === undefined) continue;
      const resolved = probeFile(join(packageDir, target.replace('*', middle)));
      if (resolved !== undefined) return resolved;
    }
    if (subpath === '.') {
      // Some packages add an `exports` map without a "." entry but still ship a
      // main file; keeping the extra file can only under-prune, never over-prune.
      const main = manifest.main ?? 'index.js';
      return probeFile(join(packageDir, main));
    }
    return undefined;
  }
  if (subpath === '.') {
    const main = manifest.main ?? 'index.js';
    return probeFile(join(packageDir, main)) ?? probeFile(join(packageDir, 'index.js'));
  }
  return probeFile(join(packageDir, subpath));
}

/** Node-style walk-up for a package directory, bounded by `upperBound`. */
export function resolvePackageDir(fromDir, packageName, upperBound) {
  let directory = fromDir;
  for (let guard = 0; guard < 64; guard += 1) {
    const candidate = join(directory, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (fold(directory) === fold(upperBound)) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

function specifiersOf(text) {
  const found = new Set();
  for (const pattern of LITERAL_SPECIFIERS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1].trim();
      if (specifier.length > 0) found.add(specifier);
    }
  }
  return [...found];
}

function hasDynamicSpecifier(text) {
  DYNAMIC_SPECIFIER.lastIndex = 0;
  return DYNAMIC_SPECIFIER.test(text);
}

/**
 * Seed entry files: the packages the shipped profile actually mounts.
 *
 * `@deepseek-ai/dsh` is seeded through its published `bin` (the CLI the worker
 * launches) and the profile's plugin packages are seeded by name, because the
 * Cordis loader imports them from `cordis.patch.yml` rather than from code.
 */
function seedEntries({ repoRoot, profile, closureRoots }) {
  const seeds = [];
  const notes = [];
  const entryOfPackage = (packageName) => {
    const packageDir = resolvePackageDir(repoRoot, packageName, repoRoot);
    if (packageDir === undefined) {
      notes.push({ kind: 'seed-missing', package: packageName });
      return;
    }
    const manifest = readJson(join(packageDir, 'package.json'));
    const files = new Set();
    for (const bin of Object.values(manifest.bin ?? {})) {
      const file = probeFile(join(packageDir, bin));
      if (file !== undefined) files.add(file);
    }
    const main = resolvePackageSubpath(packageDir, manifest, '.');
    if (main !== undefined) files.add(main);
    if (files.size === 0) {
      notes.push({ kind: 'seed-no-entry', package: packageName, dir: packageDir });
      for (const fallback of ['index.js', 'lib/index.js', 'bin.js']) {
        const file = probeFile(join(packageDir, fallback));
        if (file !== undefined) files.add(file);
      }
    }
    for (const file of files) seeds.push({ file, package: packageName, reason: 'entry' });
  };

  for (const packageName of closureRoots) entryOfPackage(packageName);
  for (const [pluginId, packageName] of Object.entries(profile.pluginPackages ?? {})) {
    entryOfPackage(packageName);
    notes.push({ kind: 'seed-plugin', pluginId, package: packageName });
  }
  return { seeds, notes };
}

/**
 * Walk the module graph from the seeds.
 *
 * Resolution walks up the *repository* `node_modules` because that is the tree
 * the bundle is staged from, so an edge that only resolves there and not inside
 * the bundle would still be reported as reached (the conservative direction).
 */
export function analyzeUsage({ repoRoot, nodes, profile, closureRoots }) {
  const reachedFiles = new Set();
  const reachedPackages = new Map(); // packageDir (folded) → { name, files:Set, reasons:Set }
  const dynamicSites = [];
  const unresolved = new Map();
  const parseSkipped = [];
  const { seeds, notes } = seedEntries({ repoRoot, profile, closureRoots });

  const knownDirs = new Map();
  for (const node of nodes.values()) {
    knownDirs.set(fold(resolve(node.sourceDir)), node.name);
  }

  const queue = [...seeds];
  for (const seed of queue) reachedFiles.add(resolve(seed.file));

  const markPackage = (dir, name, reason) => {
    const key = fold(dir);
    let record = reachedPackages.get(key);
    if (record === undefined) {
      record = { dir, name, files: new Set(), reasons: new Set() };
      reachedPackages.set(key, record);
    }
    if (reason !== undefined) record.reasons.add(reason);
    return record;
  };

  let index = 0;
  while (index < queue.length) {
    const current = queue[index];
    index += 1;
    const file = resolve(current.file);
    const ownerDir = packageDirOf(file, repoRoot);
    if (ownerDir !== undefined) {
      const record = markPackage(ownerDir, knownDirs.get(fold(ownerDir)) ?? current.package, current.reason);
      record.files.add(file);
    }
    if (!SCRIPT_FILE.test(file)) continue;
    let text;
    try {
      if (statSync(file).size > PARSE_LIMIT) {
        parseSkipped.push({ file, reason: 'too large' });
        if (ownerDir !== undefined) markPackage(ownerDir, current.package, 'parse-skipped');
        continue;
      }
      text = readFileSync(file, 'utf8');
    } catch {
      if (ownerDir !== undefined) markPackage(ownerDir, current.package, 'unreadable');
      continue;
    }
    if (hasDynamicSpecifier(text)) {
      // A computed specifier cannot be resolved statically. Recording the site is
      // all this can do: the actual net for these is the string scan (a name the
      // code can compute usually appears in the code) plus the platform-variant
      // rule. The site list is shipped in the prune report so a reviewer can eyeball
      // every place where "we do not know what it loads" is true.
      dynamicSites.push({ file: relative(repoRoot, file).split(sep).join('/'), package: current.package });
      if (ownerDir !== undefined) markPackage(ownerDir, current.package, 'dynamic-specifier');
    }
    for (const specifier of specifiersOf(text)) {
      if (specifier.startsWith('node:') || BUILTIN.has(specifier)) continue;
      const packageName = packageNameOfSpecifier(specifier);
      let target;
      if (packageName === undefined) {
        target = probeFile(isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier));
        if (target === undefined) {
          unresolved.set(`${current.package}:${specifier}`, 'relative target missing');
          continue;
        }
      } else if (specifier.startsWith('#') || specifier.startsWith('data:') || specifier.startsWith('file:')) {
        continue;
      } else {
        const packageDir = resolvePackageDir(dirname(file), packageName, repoRoot);
        if (packageDir === undefined) {
          unresolved.set(`${current.package}:${specifier}`, 'package not installed under the repository');
          continue;
        }
        const manifest = readJson(join(packageDir, 'package.json'));
        const subpath = subpathOf(specifier, packageName);
        target = resolvePackageSubpath(packageDir, manifest, subpath);
        if (target === undefined) {
          // The package is installed but this subpath is not exported/resolvable.
          // Keep the package: a resolution failure we cannot explain must not
          // become a deletion.
          markPackage(packageDir, packageName, `importer of ${specifier}`);
          unresolved.set(`${current.package}:${specifier}`, 'subpath not resolvable, package kept');
          continue;
        }
      }
      const resolved = resolve(target);
      if (reachedFiles.has(resolved)) continue;
      reachedFiles.add(resolved);
      queue.push({ file: resolved, package: packageName ?? current.package, reason: `imported by ${current.package}` });
    }
  }

  // A native package that resolves its platform binary by computed name
  // (`require('@img/sharp-' + platform)`) never shows an import edge. Keep the
  // platform variants of any reached package instead of trying to prove absence.
  for (const record of [...reachedPackages.values()]) {
    const manifestPath = join(record.dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      const variant = resolvePackageDir(record.dir, name, repoRoot);
      if (variant === undefined) continue;
      if (reachedPackages.has(fold(variant))) continue;
      markPackage(variant, name, `optional platform variant of ${record.name}`);
    }
  }

  const reachableNames = new Set([...reachedPackages.values()].map((record) => record.name));
  const reachableFilesByPackage = new Map();
  for (const record of reachedPackages.values()) {
    if (!reachableFilesByPackage.has(record.name)) reachableFilesByPackage.set(record.name, new Set());
    for (const file of record.files) reachableFilesByPackage.get(record.name).add(file);
  }

  return {
    seeds: seeds.length,
    seedNotes: notes,
    reachedFiles,
    reachedPackages,
    reachableNames,
    reachableFilesByPackage,
    dynamicSites,
    unresolved: [...unresolved.entries()].map(([site, reason]) => ({ site, reason })),
    parseSkipped,
  };
}

/**
 * Which closure package a file belongs to: the nearest ancestor directory that
 * has a `package.json`, stopping at the repository root.
 */
export function packageDirOf(file, repoRoot) {
  let directory = dirname(file);
  for (let guard = 0; guard < 64; guard += 1) {
    if (existsSync(join(directory, 'package.json'))) {
      if (fold(directory) === fold(repoRoot) || !isInside(directory, repoRoot)) return undefined;
      return directory;
    }
    if (fold(directory) === fold(repoRoot)) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/**
 * Read every reached file once so a candidate scan is a handful of `includes`
 * calls instead of hundreds of thousands of reads.
 *
 * Files above the cap are dropped from the corpus and reported. A file we could not
 * read is a file whose imports we do not know, so any unscannable *code* file (see
 * `SCRIPT_FILE`) blocks every candidate: absence of a reference cannot be proven from
 * a corpus with a hole in it. Binaries and data files are excluded — a `.node` cannot
 * name a package as a specifier, and a `.json`/`.yml` above the cap is not code.
 */
export function loadReachedCorpus({ usage, repoRoot, limitBytes = 4 * 1024 * 1024 }) {
  const entries = [];
  const skipped = [];
  // A compiled addon cannot name an npm package as a runtime specifier: it would
  // have to dlopen one, which the optional-platform rule below covers. Reading
  // tens of megabytes of `.node` bytes would only slow the gate down.
  const TEXTUAL = /\.(?:mjs|cjs|js|jsx|ts|mts|cts|json|yml|yaml)$/i;
  for (const file of usage.reachedFiles) {
    if (!TEXTUAL.test(file)) {
      skipped.push({ file, reason: 'not a text module (native binary, asset or map)' });
      continue;
    }
    try {
      if (statSync(file).size > limitBytes) {
        skipped.push({ file, reason: `above the ${limitBytes} byte scan limit` });
        continue;
      }
      entries.push({ file, text: readFileSync(file, 'latin1') });
    } catch (error) {
      skipped.push({ file, reason: `unreadable: ${error?.code ?? 'unknown'}` });
    }
  }
  return { entries, skipped, repoRoot };
}

/**
 * Characters that can be part of a package name or of any other identifier.
 *
 * A package name is `[A-Za-z0-9._@/-]+`, so an occurrence of the name that is
 * directly adjacent to a letter, digit or underscore on either side is part of a
 * longer token — a longer identifier, a hex digest, a base64 blob. Everything
 * else (quotes, whitespace, `/`, `-`, `.`, `@`, brackets, `=`, `:` …) counts as a
 * boundary, which keeps the check conservative wherever a name could really be
 * spelled as a specifier: `'dfa'`, `"dfa"`, `require("dfa")`, `dfa/sub`,
 * `node_modules/dfa/index.js`, `"dfa": "1.2.0"`.
 */
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/;

/** Is the occurrence of `length` chars at `index` a standalone token? */
export function isTokenBounded(text, index, length) {
  const before = index === 0 ? '' : text[index - 1];
  const after = index + length >= text.length ? '' : text[index + length];
  if (before !== '' && IDENTIFIER_CHAR.test(before)) return false;
  if (after !== '' && IDENTIFIER_CHAR.test(after)) return false;
  return true;
}

/**
 * Every occurrence of `name`, split into standalone tokens and occurrences that
 * are only part of a longer token. Both lists are returned because the caller
 * must keep the second one visible: "we looked and decided this is not a
 * mention" is a different claim from "there was nothing to look at".
 */
export function occurrencesOf(corpus, name) {
  const bounded = [];
  const embedded = [];
  for (const entry of corpus.entries) {
    let index = entry.text.indexOf(name);
    while (index !== -1) {
      const row = {
        file: slash(relative(corpus.repoRoot, entry.file)),
        offset: index,
        context: entry.text.slice(Math.max(0, index - 60), index + name.length + 60).replace(/\s+/g, ' '),
      };
      if (isTokenBounded(entry.text, index, name.length)) bounded.push(row);
      else embedded.push(row);
      index = entry.text.indexOf(name, index + 1);
    }
  }
  return { bounded, embedded };
}

/**
 * Does any reached file mention `name` as a standalone token?
 *
 * This is the net under computed specifiers: the loader imports plugin names it
 * reads from a config file, and any tool that builds a package name from a table
 * would leave the name in the source. Scanning the reached corpus (a superset of
 * the files that can execute) is the conservative direction.
 */
export function stringReferences(corpus, name) {
  return occurrencesOf(corpus, name).bounded;
}

/**
 * Apply the prune gate to one candidate.
 *
 * Returns `{ allowed, blockers, evidence }`. Every signal is over-approximating,
 * so a candidate is only allowed when all of them agree it is unused. Anything
 * that cannot be positively disproved becomes a blocker, never a deletion.
 */
export function evaluateCandidate({
  candidate, usage, nodes, corpus, runtimeObserved, protectedNames, declaredBy,
}) {
  const blockers = [];
  const node = [...nodes.values()].find((entry) => entry.name === candidate.name);
  if (node === undefined) {
    return { allowed: false, blockers: ['package is not in the production closure'], evidence: {} };
  }
  if (protectedNames !== undefined && protectedNames.has(candidate.name)) {
    blockers.push(`${candidate.name} is a closure root or a reviewed workspace package and is never prunable`);
  }
  if (usage.reachableNames.has(candidate.name)) {
    blockers.push(`the module graph reaches ${candidate.name} from the mounted profile`);
  }
  const { bounded: references, embedded } = occurrencesOf(corpus, candidate.name);
  if (references.length > 0) {
    blockers.push(`a reached file mentions the name: ${references.slice(0, 3).map((hit) => `${hit.file}:${hit.offset}`).join(', ')}`);
  }
  // A code file we could not read is a file whose imports we do not know. Absence
  // of a reference cannot be proven from a corpus with a hole in it, so any
  // unscannable module blocks every candidate. Native binaries and assets are
  // excluded (a `.node` cannot name a package as a specifier); data files large
  // enough to be skipped are not code either, which is a deliberate narrowing and
  // is listed as a known limit rather than claimed as full coverage.
  const unscannedCode = corpus.skipped.filter((entry) => SCRIPT_FILE.test(entry.file));
  if (unscannedCode.length > 0) {
    blockers.push(`${unscannedCode.length} reachable code file(s) could not be scanned: ${
      unscannedCode.slice(0, 3).map((entry) => `${entry.file} (${entry.reason})`).join(', ')
    }`);
  }
  if (runtimeObserved !== undefined && runtimeObserved.has(candidate.name)) {
    blockers.push(`the boot probe loaded ${candidate.name}`);
  }
  return {
    allowed: blockers.length === 0,
    blockers,
    evidence: {
      name: node.name,
      version: node.version,
      declaredBy: declaredBy ?? [],
      moduleGraphReachable: usage.reachableNames.has(candidate.name),
      stringReferences: references.length,
      // Occurrences that are only a fragment of a longer token (a hex digest, a
      // longer package name). They are recorded so a reviewer can see that the
      // net did look at them and why they are not mentions of this package.
      dismissedSubstringHits: embedded.length,
      dismissedSamples: embedded.slice(0, 3).map((hit) => `${hit.file}:${hit.offset}`),
      unscannedCodeFiles: unscannedCode.length,
      runtimeObserved: runtimeObserved === undefined ? 'not-provided' : runtimeObserved.has(candidate.name),
      corpusFiles: corpus.entries.length,
      corpusSkipped: corpus.skipped.length,
    },
  };
}

/**
 * Reverse dependency index in one pass.
 *
 * Reading every manifest once matters: a per-candidate walk of 654 manifests
 * turns a two-second gate into a three-minute one, and the gate is meant to run
 * on every build.
 */
export function buildDependentsIndex({ nodes }) {
  const index = new Map();
  for (const node of nodes.values()) {
    const manifestPath = join(node.sourceDir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch {
      continue;
    }
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (!index.has(name)) index.set(name, []);
        index.get(name).push(`${node.name} (${field})`);
      }
    }
  }
  for (const list of index.values()) list.sort();
  return index;
}

/** Packages declared as a dependency by anything in the closure (for evidence). */
export function dependentsOf({ index, name }) {
  return index.get(name) ?? [];
}

/**
 * Every closure package that the gate allows pruning, with its evidence.
 * Sorted largest first so the review sees the payload before the noise.
 */
export function pruneCandidates({ usage, nodes, corpus, runtimeObserved, protectedNames, sizeOf, dependentsIndex }) {
  const index = dependentsIndex ?? buildDependentsIndex({ nodes });
  const rows = [];
  for (const node of nodes.values()) {
    if (usage.reachableNames.has(node.name)) continue;
    const evaluation = evaluateCandidate({
      candidate: { name: node.name },
      usage,
      nodes,
      corpus,
      runtimeObserved,
      protectedNames,
      declaredBy: dependentsOf({ index, name: node.name }),
    });
    rows.push({
      name: node.name,
      version: node.version,
      license: node.license,
      sizeBytes: sizeOf === undefined ? 0 : sizeOf(node),
      allowed: evaluation.allowed,
      blockers: evaluation.blockers,
      evidence: evaluation.evidence,
    });
  }
  rows.sort((left, right) => right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name, 'en'));
  return rows;
}
