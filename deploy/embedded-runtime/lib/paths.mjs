/**
 * Path containment that survives the Windows spellings a lexical check misses.
 *
 * `path.relative()` alone is not a guard: with short (8.3) names, extended-length
 * prefixes (`\\?\D:\…`), or a junction in an ancestor, two spellings of the same
 * directory compare as unrelated. Everything here compares canonical real paths
 * instead, and refuses the prefix forms outright.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const EXTENDED_PREFIX = /^\\\\[?.]\\/;

/** Reject spellings whose meaning depends on the filesystem rather than the path. */
export function assertPlainAbsolutePath(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} must be a non-empty path`);
  if (EXTENDED_PREFIX.test(path)) {
    throw new Error(`${label} must not use an extended-length or device prefix: ${path}`);
  }
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
  return path;
}

/**
 * Canonical absolute form of a path that may not exist yet: the deepest existing
 * ancestor is resolved through `realpath`, and the missing suffix is re-appended.
 */
export function canonicalize(path) {
  const absolute = resolve(assertPlainAbsolutePath(path, 'path'));
  const missing = [];
  let current = absolute;
  for (let guard = 0; guard < 256; guard += 1) {
    try {
      const canonical = realpathSync.native(current);
      return missing.length === 0 ? canonical : join(canonical, ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
  return absolute;
}

function fold(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Whether `child` is `parent` itself or lies below it, after canonicalization. */
export function isInside(child, parent) {
  const canonicalChild = fold(canonicalize(child));
  const canonicalParent = fold(canonicalize(parent));
  if (canonicalChild === canonicalParent) return true;
  return canonicalChild.startsWith(canonicalParent.endsWith(sep) ? canonicalParent : `${canonicalParent}${sep}`);
}

/** Whether two paths denote overlapping trees in either direction. */
export function overlaps(left, right) {
  return isInside(left, right) || isInside(right, left);
}

/** Relative path with forward slashes, for manifests and diagnostics. */
export function slash(path) {
  return path.split(sep).join('/');
}

/**
 * Bundle-relative form of a path that ships inside the bundle.
 *
 * A distributable that records the directory it was built in cannot be moved:
 * the first copy or rename invalidates every stored path. So every generated
 * manifest, launcher and resolver stores a forward-slash path relative to the
 * bundle root, and the loader joins it with the root it discovered at launch.
 * A target that is not inside the root is a builder bug, not a path to store,
 * so this throws instead of writing `../…` into the bundle.
 */
export function portableRelative(root, target, label = 'path') {
  const value = relative(resolve(root), resolve(target)).split(sep).join('/');
  if (value.length === 0) return '.';
  if (value === '..' || value.startsWith('../') || isAbsolute(value)) {
    throw new Error(`${label} must live inside the bundle root ${canonicalize(root)}: ${target}`);
  }
  return value;
}

export function exists(path) {
  return existsSync(path);
}

export { relative };
