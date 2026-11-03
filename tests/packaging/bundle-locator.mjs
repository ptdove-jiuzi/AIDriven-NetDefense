/**
 * One place that answers the two questions every packaging suite asks: where the
 * delivered bundle is, and how its stored paths become absolute ones again.
 *
 * The bundle ships no build-host path — `launch-plan.json` stores paths relative
 * to the bundle root — so a suite has to resolve them exactly the way a shipped
 * launcher does: join every stored path onto the root it is looking at. Keeping
 * that in one module means a bundle rename touches one file, and it keeps each
 * suite from growing its own slightly different join.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this file (`tests/packaging/` → repository). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Delivered bundle directory name under `<repo parent>/_m8_poc/bundle/`. */
export const DEFAULT_BUNDLE_NAME = 'aegis-embedded-win32-x64-v13-relocatable';

/** Where the delivered bundle lives; `M8_BUNDLE_DIR` overrides it. */
export function defaultBundleRoot() {
  return resolve(process.env.M8_BUNDLE_DIR
    ?? join(dirname(REPO_ROOT), '_m8_poc', 'bundle', DEFAULT_BUNDLE_NAME));
}

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
