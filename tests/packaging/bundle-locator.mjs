/**
 * One place that answers the two questions every packaging suite asks: where the
 * delivered bundle is, and how its stored paths become absolute ones again.
 *
 * The bundle ships no build-host path — `launch-plan.json` stores paths relative
 * to the bundle root — so a suite has to resolve them exactly the way a shipped
 * launcher does: join every stored path onto the root it is looking at. Keeping
 * that in one module means a bundle rename touches one file, and it keeps each
 * suite from growing its own slightly different join.
 *
 * The delivered bundle is **inside the repository**: the newest complete
 * `dist/bundle/win32-x64-v<N>` artifact. The old sibling `_m8_poc` tree was a
 * v13-era build scratch whose profile is stale by construction (BASE-01: it still
 * routes to `deepseek-v4.1-flash` while the approved profile says
 * `deepseek-chat`), so reading it silently would let a gate pass on bytes that
 * are not the deliverable. Every path this module answers is required to resolve
 * inside the repository, and an explicit override is held to the same
 * completeness contract as the discovered artifact.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file (`tests/packaging/` → repository). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Where delivered artifacts live, relative to the repository root. */
export const BUNDLE_PARENT_RELATIVE = join('dist', 'bundle');

/** Directory-name shape of a delivered artifact: `win32-x64-v<N>`. */
export const BUNDLE_DIRECTORY_PATTERN = /^win32-x64-v(\d+)$/;

/**
 * The four shipped markers that make a directory a *complete* delivered bundle.
 *
 * A build writes into its output directory incrementally, so the version number
 * alone is not evidence: `dist/bundle/win32-x64-v16` can exist, look promising,
 * and still be ~500 MiB short of launchable. Discovery must skip such a tree
 * instead of pointing a gate at a half-written one.
 */
export const COMPLETE_BUNDLE_MARKERS = [
  'bundle.json',
  join('launch', 'launch-plan.json'),
  join('runtime', 'node', 'node.exe'),
  join('manifests', 'files.sha256'),
];

/** True when `root` carries every marker a delivered bundle must have. */
export function isCompleteBundle(root) {
  return COMPLETE_BUNDLE_MARKERS.every((marker) => existsSync(join(root, marker)));
}

/**
 * Reject a bundle root that is not strictly inside the repository.
 *
 * Returning the resolved absolute path means callers can keep comparing paths
 * without each of them re-deriving the guard.
 */
function requireInsideRepository(candidate, label) {
  const absolute = resolve(candidate);
  const fromRoot = relative(resolve(REPO_ROOT), absolute);
  if (fromRoot.length === 0 || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(`${label} must resolve inside the repository ${resolve(REPO_ROOT)}, got ${absolute}`);
  }
  return absolute;
}

/**
 * The newest complete `dist/bundle/win32-x64-v<N>` artifact.
 *
 * Highest version wins, but only among complete trees: while a rebuild is in
 * progress the newer directory exists without being launchable, and silently
 * choosing it would make every measurement a measurement of a half-written tree.
 */
function latestCompleteBundle() {
  const parent = join(REPO_ROOT, BUNDLE_PARENT_RELATIVE);
  if (!existsSync(parent)) {
    throw new Error(`no delivered bundle: ${parent} does not exist; build one with `
      + 'node deploy/embedded-runtime/build.mjs --profile desktop --out dist/bundle/win32-x64-v15 --allow-repo-output');
  }
  const complete = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, match: BUNDLE_DIRECTORY_PATTERN.exec(entry.name) }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({ name: entry.name, version: Number(entry.match[1]), root: join(parent, entry.name) }))
    .filter((entry) => isCompleteBundle(entry.root))
    .sort((left, right) => right.version - left.version);
  if (complete.length === 0) {
    throw new Error(`no complete delivered bundle under ${parent}; expected a ${BUNDLE_DIRECTORY_PATTERN.source} directory `
      + `holding ${COMPLETE_BUNDLE_MARKERS.join(', ')}; build one with `
      + 'node deploy/embedded-runtime/build.mjs --profile desktop --out dist/bundle/win32-x64-v15 --allow-repo-output');
  }
  return complete[0].root;
}

/**
 * Where the delivered bundle lives; `M8_BUNDLE_DIR` overrides it.
 *
 * The override is an override of *which in-repository bundle*, not of the rule
 * that the bundle is in the repository: a path outside `REPO_ROOT`, or one that
 * is not a complete bundle, is refused with an explicit error rather than read.
 */
export function defaultBundleRoot() {
  const override = process.env.M8_BUNDLE_DIR;
  if (override !== undefined && override.length > 0) {
    const root = requireInsideRepository(override, 'M8_BUNDLE_DIR');
    if (!isCompleteBundle(root)) {
      throw new Error(`M8_BUNDLE_DIR is not a complete bundle: ${root} (missing one of ${COMPLETE_BUNDLE_MARKERS.join(', ')})`);
    }
    return root;
  }
  return latestCompleteBundle();
}

/** Directory name of the delivered bundle (`<repo>/dist/bundle/<name>`). */
export const DEFAULT_BUNDLE_NAME = basename(defaultBundleRoot());

/**
 * Absolute form of a path stored relative to a bundle root.
 *
 * An absolute `stored` value is a finding, not something to pass through: that is
 * exactly the shape of the defect this module exists to make visible.
 */
export function fromBundle(root, stored, label = 'path') {
  if (typeof stored !== 'string' || stored.length === 0) {
    throw new Error(`${label} must be a non-empty bundle-relative path, saw ${JSON.stringify(stored)}`);
  }
  if (isAbsolute(stored)) {
    throw new Error(`${label} must be bundle-relative, but the bundle stores an absolute path: ${stored}`);
  }
  const absolute = resolve(root, ...stored.split('/'));
  // A relative path that climbs out of the root is worse than an absolute one: it
  // still looks portable while reading somebody else's files.
  if (absolute !== resolve(root) && !absolute.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`${label} escapes the bundle root ${resolve(root)}: ${stored}`);
  }
  return absolute;
}

/** The raw launch plan, exactly as shipped (paths still relative). */
export function readPlan(root) {
  const path = join(root, 'launch', 'launch-plan.json');
  if (!existsSync(path)) throw new Error(`launch plan missing at ${path}; build the bundle first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The launch plan with every stored path resolved against `root`. */
export function resolvePlanPaths(plan, root) {
  return {
    ...plan,
    node: { ...plan.node, executable: fromBundle(root, plan.node.executable, 'node.executable') },
    worker: { ...plan.worker, entry: fromBundle(root, plan.worker.entry, 'worker.entry') },
    profile: {
      ...plan.profile,
      templateDir: fromBundle(root, plan.profile.templateDir, 'profile.templateDir'),
      templateToolsDir: fromBundle(root, plan.profile.templateToolsDir, 'profile.templateToolsDir'),
      sourceMirror: fromBundle(root, plan.profile.sourceMirror, 'profile.sourceMirror'),
      preparer: fromBundle(root, plan.profile.preparer, 'profile.preparer'),
    },
  };
}

/**
 * The build-host paths a shipped byte must never contain, in all three spellings
 * the same path is written as: native (`D:\x`), forward-slashed (`D:/x`), and
 * backslash-escaped inside JSON (`D:\\x`).
 *
 * This is deliberately re-derived here rather than imported from the builder: a
 * guard that asks the code under test what to look for cannot fail when that code
 * is wrong. Only the families that are actually about *this machine* are listed —
 * repository, its parent (where the scratch build tree lives), the bundle itself,
 * its parent, and the build user's profile. Bare product or account names are not
 * banned: third-party sources legitimately contain words like that, and a guard
 * that fires on them gets switched off.
 */
export function hostPathNeedles(bundleRoot) {
  const candidates = [
    ['repository', REPO_ROOT],
    ['repository parent', dirname(REPO_ROOT)],
    ['bundle root', bundleRoot],
    ['bundle parent', dirname(bundleRoot)],
    ['build user profile', process.env.USERPROFILE],
  ];
  const seen = new Set();
  const needles = [];
  for (const [label, value] of candidates) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const absolute = resolve(value);
    // A drive or UNC root would match unrelated text in every package.
    if (dirname(absolute) === absolute) continue;
    const spellings = [absolute, absolute.split(sep).join('/'), absolute.split(sep).join('\\\\')];
    // Some tools lower-case a drive letter, so a case-sensitive guard would pass
    // exactly the spelling it was widened to catch.
    for (const spelling of [...spellings, ...spellings.map((item) => item.toLowerCase())]) {
      if (spelling.length < 6 || seen.has(spelling)) continue;
      seen.add(spelling);
      needles.push({ label, spelling, bytes: Buffer.from(spelling, 'utf8') });
    }
  }
  return needles;
}

/**
 * Every file under `root` that carries one of the build-host paths above.
 *
 * All file types are read, not only text extensions: `.map`, `.node`, `.dll` and
 * extensionless files are where a leaked path hides.
 */
export function scanBundleForHostPaths(root, { skip = [], cap = 256 * 1024 * 1024 } = {}) {
  const needles = hostPathNeedles(root);
  const skipped = new Set(skip.map((name) => name.split(sep).join('/')));
  const offenders = [];
  let scanned = 0;
  let oversized = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (skipped.has(relativePath)) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = statSync(path).size;
      if (size > cap) {
        oversized += 1;
        continue;
      }
      scanned += 1;
      const bytes = readFileSync(path);
      for (const needle of needles) {
        if (bytes.includes(needle.bytes)) {
          offenders.push({ path: relativePath, label: needle.label, spelling: needle.spelling });
        }
      }
    }
  };
  walk(root);
  return { scanned, oversized, offenders, needles: needles.length };
}
