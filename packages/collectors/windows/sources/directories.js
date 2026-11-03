/**
 * File metadata source for declared roots (§5.1 "文件元数据": reconciliation, 60 s).
 *
 * The design asks for `ReadDirectoryChangesW` plus periodic reconciliation. This module
 * implements the **reconciliation** half only, and says so in its descriptor: it walks the
 * declared roots on every interval and diffs metadata. There is no native change
 * notification here, which means anything created and deleted between two reconciliations is
 * invisible — exactly the short-lived-object blind spot every poll source carries.
 *
 * Why `node:fs` instead of a PowerShell child process: the metadata comes from the same
 * `FindFirstFile`/`GetFileAttributesEx` layer, one process less, no console encoding, and —
 * most importantly — no string ever reaches a command interpreter, so a root path can never
 * become a command injection vector.
 *
 * Bounds, per §5.1:
 * - at most 32 declared roots (`maxRoots`),
 * - a bounded depth and entry count per read, with `truncated` surfaced instead of silent
 *   overflow,
 * - one directory handle at a time (breadth-first, opened and closed per directory), which
 *   stays far below the 256-handle budget.
 *
 * Privacy, per §4.1: the raw absolute path stays local. The payload carries a declared
 * `root_id`, the root-relative path and a truncated SHA-256 of the absolute path so an
 * event can be correlated without shipping the user's directory layout.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import {
  DEFAULT_MAX_ENTITIES,
  buildSnapshotRecord,
  createSnapshotDiffer,
  identityToken,
  stateDigest,
} from '../diff.js';
import { createSourceDescriptor } from '../descriptor.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../errors.js';
import { buildPayload } from '../payload.js';

export const DIRECTORIES_SOURCE_ID = 'windows.file-metadata';
export const DIRECTORIES_INTERVAL_MS = 60_000;
export const DIRECTORIES_TYPE = 'windows.file_metadata';
export const MAX_ROOTS = 32;
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_HASH_BYTES = 1024 * 1024;

export const DIRECTORIES_FIELDS = Object.freeze([
  { name: 'root_id', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'relative_path', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'path_digest', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'entry_kind', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'size', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'mtime', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'content_hash', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
]);

/**
 * A declared root must be an absolute Windows path, free of wildcards, quotes and `..`
 * segments. Rejecting `..` is not cosmetic: a relative escape would let a misconfiguration
 * walk outside the declared root and quietly turn one root into the whole volume.
 */
export function assertRootPath(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_CONFIG, 'root path must be a non-empty string');
  }
  if (!win32.isAbsolute(rootPath) && !isAbsolute(rootPath)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED,
      'root path must be absolute',
      { details: { rootPath } },
    );
  }
  if (/['"`$;|&<>*?\u0000-\u001F\u007F]/u.test(rootPath)) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED,
      'root path must not contain quotes, wildcards or control characters',
      { details: { rootPath } },
    );
  }
  const segments = rootPath.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED,
      'root path must not contain traversal segments',
      { details: { rootPath } },
    );
  }
  return rootPath;
}

/** Normalize the `roots` option into `{ id, path }` entries. */
export function normalizeRoots(roots, { maxRoots = MAX_ROOTS } = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_CONFIG,
      'at least one declared root is required',
    );
  }
  if (roots.length > maxRoots) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.SOURCE_LIMIT_EXCEEDED,
      `at most ${maxRoots} roots may be declared`,
      { details: { declared: roots.length, maxRoots } },
    );
  }
  const seenIds = new Set();
  return Object.freeze(roots.map((entry, index) => {
    const raw = typeof entry === 'string' ? { path: entry } : entry;
    if (raw === null || typeof raw !== 'object') {
      throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_CONFIG, 'every root must be a string or { id, path }');
    }
    const rootPath = assertRootPath(raw.path);
    const id = raw.id === undefined ? `root-${index}` : raw.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id)) {
      throw new WindowsCollectorError(
        WINDOWS_ERROR_CODES.INVALID_CONFIG,
        'root id must be 1-32 characters of [A-Za-z0-9._-]',
        { details: { id: typeof id === 'string' ? id : null } },
      );
    }
    if (seenIds.has(id)) {
      throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_CONFIG, `duplicate root id: ${id}`, { details: { id } });
    }
    seenIds.add(id);
    return Object.freeze({ id, path: resolve(rootPath) });
  }));
}

export function directoriesDescriptor({ intervalMs = DIRECTORIES_INTERVAL_MS, roots = null } = {}) {
  const rootCount = Array.isArray(roots) ? roots.length : 0;
  return createSourceDescriptor({
    stableSourceId: DIRECTORIES_SOURCE_ID,
    type: DIRECTORIES_TYPE,
    kind: 'poll',
    intervalMs,
    permissions: {
      required: [`Read/list access to the ${rootCount} declared root(s)`],
      optional: ['Administrator to reconcile roots that deny access to the collector account'],
      degradedWithout: [
        'relative_path: subtrees that deny read access are skipped and counted in stats.unreadable, never reported as deleted',
      ],
    },
    fields: DIRECTORIES_FIELDS,
    blindSpots: [
      'Reconciliation only: there is no ReadDirectoryChangesW subscription, so a file created and removed between two intervals is never observed',
      'Reparse points (symlinks, junctions) are reported as entries but never descended, so targets outside the root are not followed',
      'File content is never read unless hashContent is enabled, and then only up to maxHashBytes',
      'A subtree that denies read access is skipped; its entries are neither reported as present nor as removed',
      `At most ${MAX_ROOTS} roots, a bounded depth and a bounded entry count per read`,
    ],
    gapSemantics: [
      'poll: a failed read produces no records and no gap; the source degrades through last_error and goes stale after two intervals',
      'poll: a read that hits the entry bound is reported as truncated and suppresses removals for that cycle',
      'poll: the depth bound is a permanent declared limit, not a truncation; entries below it are never collected and never reported as removed',
      'reconciliation: a change that is reverted between two reads produces no event',
    ],
    rotation: 'none: the file tree is reconciled by metadata digest, not by a log cursor',
  });
}

function pathDigest(absolutePath) {
  return createHash('sha256').update(absolutePath, 'utf8').digest('hex').slice(0, 16);
}

/**
 * True when the tracked entry lives inside one of the scopes this read could not open.
 *
 * A scope is `{ rootId, prefix }` and not a bare relative path on purpose: an unreadable root
 * used to be recorded as `''`, and `relativePath.startsWith('')` is true for every path, so a
 * single denied root silently suppressed removals for *every* declared root. The `rootId` in
 * the scope confines the suppression to the root that actually failed.
 */
function inUnreadableSubtree(item, scopes) {
  const rootId = item?.payload?.root_id;
  const relativePath = item?.payload?.relative_path;
  if (typeof rootId !== 'string' || typeof relativePath !== 'string') {
    return false;
  }
  return scopes.some((scope) => scope.rootId === rootId
    && (scope.prefix === ''
      || relativePath === scope.prefix
      || relativePath.startsWith(`${scope.prefix}/`)));
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Walk one root breadth-first, collecting metadata only.
 * `io` is injectable so tests can simulate a permission failure without touching a real ACL.
 */
function walkRoot({ root, io, maxDepth, remaining, hashContent, maxHashBytes }) {
  const entries = [];
  const queue = [{ absolute: root.path, relativePath: '', depth: 0 }];
  // Scopes this walk could not read, as `{ rootId, prefix }`. Their tracked entries must not be
  // reported as removed: a denied directory is an unknown, not an empty one.
  const unreadablePrefixes = [];
  let unreadable = 0;
  let depthLimited = 0;
  let hashedFiles = 0;
  let hashSkipped = 0;
  let linkedEntries = 0;
  // Set when the walk stopped because the entry budget ran out rather than because the tree
  // was fully enumerated. Without this the source could never report `truncated`: `remaining`
  // caps the output exactly at `maxEntities`, so the differ's own `items.length > maxEntities`
  // test was unreachable and the tail of a large root was silently dropped *and* reported as
  // removed on the next cycle.
  let budgetExhausted = remaining <= 0;

  while (queue.length > 0) {
    if (entries.length >= remaining) {
      budgetExhausted = true;
      break;
    }
    const current = queue.shift();
    let children;
    try {
      children = io.readdir(current.absolute, { withFileTypes: true });
    } catch (error) {
      if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'EACCES'
        || error.code === 'EPERM' || error.code === 'ENOTDIR')) {
        unreadable += 1;
        unreadablePrefixes.push({ rootId: root.id, prefix: current.relativePath });
        continue;
      }
      throw error;
    }

    children.sort((left, right) => (left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)));

    for (const child of children) {
      if (entries.length >= remaining) {
        budgetExhausted = true;
        break;
      }
      const absolute = join(current.absolute, child.name);
      const relativePath = current.relativePath === ''
        ? child.name
        : `${current.relativePath}/${child.name}`;
      let stat;
      try {
        stat = io.lstat(absolute);
      } catch (error) {
        if (error !== null && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'EACCES'
          || error.code === 'EPERM')) {
          unreadable += 1;
          // A denied lstat means "we do not know what this entry is", so its previously
          // tracked record must not be turned into a removal either.
          if (error.code !== 'ENOENT') {
            unreadablePrefixes.push({ rootId: root.id, prefix: relativePath });
          }
          continue;
        }
        throw error;
      }

      const isLink = typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink();
      const isDirectory = !isLink && typeof stat.isDirectory === 'function' && stat.isDirectory();
      const entryKind = isLink ? 'link' : (isDirectory ? 'directory' : 'file');

      let contentHash = null;
      if (hashContent && entryKind === 'file') {
        if (stat.size <= maxHashBytes) {
          try {
            contentHash = createHash('sha256').update(io.readFile(absolute)).digest('hex');
            hashedFiles += 1;
          } catch (error) {
            if (error !== null && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
              hashSkipped += 1;
            } else {
              throw error;
            }
          }
        } else {
          hashSkipped += 1;
        }
      }
      if (isLink) {
        linkedEntries += 1;
      }

      const { payload } = buildPayload({
        root_id: root.id,
        relative_path: relativePath,
        path_digest: pathDigest(absolute),
        entry_kind: entryKind,
        size: entryKind === 'directory' ? undefined : stat.size,
        mtime: toIso(stat.mtimeMs),
        content_hash: contentHash,
      });

      entries.push({
        entityId: `${root.id}-${identityToken(relativePath)}-${payload.path_digest.slice(0, 8)}`,
        digest: stateDigest({
          entry_kind: payload.entry_kind,
          size: payload.size ?? null,
          mtime: payload.mtime ?? null,
          content_hash: payload.content_hash ?? null,
        }),
        payload,
      });

      if (isDirectory) {
        if (current.depth + 1 > maxDepth) {
          depthLimited += 1;
        } else {
          queue.push({ absolute, relativePath, depth: current.depth + 1 });
        }
      }
    }
  }

  return {
    entries,
    unreadable,
    unreadablePrefixes,
    budgetExhausted,
    depthLimited,
    hashedFiles,
    hashSkipped,
    linkedEntries,
  };
}

export function createDirectoriesSource({
  roots,
  clock = Date.now,
  intervalMs = DIRECTORIES_INTERVAL_MS,
  maxRoots = MAX_ROOTS,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxEntities = DEFAULT_MAX_ENTITIES,
  hashContent = false,
  maxHashBytes = DEFAULT_MAX_HASH_BYTES,
  io = null,
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'intervalMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'maxDepth must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxHashBytes) || maxHashBytes < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'maxHashBytes must be a positive integer');
  }

  const declared = normalizeRoots(roots, { maxRoots });
  const services = io === null
    ? { readdir: readdirSync, lstat: lstatSync, readFile: readFileSync }
    : io;
  for (const name of ['readdir', 'lstat']) {
    if (typeof services[name] !== 'function') {
      throw new WindowsCollectorError(
        WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
        `io.${name} must be a function`,
      );
    }
  }

  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = directoriesDescriptor({ intervalMs, roots: declared });

  return Object.freeze({
    descriptor,
    sourceId: DIRECTORIES_SOURCE_ID,
    roots: declared,

    async read() {
      const items = [];
      const unreadablePrefixes = [];
      let budgetExhausted = false;
      let rootsRead = 0;
      const totals = {
        unreadable: 0,
        depthLimited: 0,
        hashedFiles: 0,
        hashSkipped: 0,
        linkedEntries: 0,
        missingRoots: 0,
      };

      for (const root of declared) {
        let rootStat;
        try {
          rootStat = services.lstat(root.path);
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
            // The root really is gone: its tracked entries are legitimate removals.
            totals.missingRoots += 1;
            continue;
          }
          if (error !== null && typeof error === 'object' && (error.code === 'EACCES' || error.code === 'EPERM')) {
            totals.unreadable += 1;
            // Scoped to this root only. A bare `''` prefix used to make every path of every
            // root "inside the unreadable subtree" and stopped removal reporting everywhere.
            unreadablePrefixes.push({ rootId: root.id, prefix: '' });
            continue;
          }
          throw error;
        }
        if (typeof rootStat.isDirectory === 'function' && !rootStat.isDirectory()) {
          totals.unreadable += 1;
          unreadablePrefixes.push({ rootId: root.id, prefix: '' });
          continue;
        }

        rootsRead += 1;
        const walked = walkRoot({
          root,
          io: services,
          maxDepth,
          remaining: maxEntities - items.length,
          hashContent,
          maxHashBytes,
        });
        items.push(...walked.entries);
        totals.unreadable += walked.unreadable;
        totals.depthLimited += walked.depthLimited;
        totals.hashedFiles += walked.hashedFiles;
        totals.hashSkipped += walked.hashSkipped;
        totals.linkedEntries += walked.linkedEntries;
        unreadablePrefixes.push(...walked.unreadablePrefixes);
        if (walked.budgetExhausted) {
          budgetExhausted = true;
        }
      }

      // Every declared root denied: this is a permission failure, not "the directory is
      // empty". Reporting zero events would look like the tree was wiped. A denial limited to
      // some roots still contributes the readable ones and is declared through
      // `degradedFields`.
      if (rootsRead === 0 && totals.unreadable > 0) {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.ACCESS_DENIED,
          'No declared root could be read by the collector account',
          { details: { roots: declared.length, unreadable: totals.unreadable } },
        );
      }

      // A budget stop hides an unknown tail of the tree: everything after the cut was simply
      // not seen, so no removal may be reported for this cycle.
      const truncated = budgetExhausted;
      const observedAt = clock();
      const diff = differ.diff(items, {
        suppressRemovalsFor: truncated
          ? () => true
          : (unreadablePrefixes.length === 0
            ? null
            : ({ item }) => inUnreadableSubtree(item, unreadablePrefixes)),
      });
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: DIRECTORIES_TYPE,
          entityId: entry.entityId,
          digest: entry.digest,
          revision: entry.revision,
          observedAt,
          change: entry.kind,
          payload: entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true },
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      return {
        records,
        nextCursor: null,
        identity: null,
        reset: null,
        snapshot: diff.snapshot,
        // `diff.truncated` cannot fire here (the walk caps output at the budget); the signal
        // comes from the walk itself.
        truncated,
        degradedFields: totals.unreadable > 0 ? Object.freeze(['relative_path']) : Object.freeze([]),
        stats: Object.freeze({
          roots: declared.length,
          entries: items.length,
          budgetExhausted,
          ...totals,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
        }),
      };
    },
  });
}

/** Exported for tests: the relative-path shape a walk produces, using the host separator. */
export function relativeFor(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}
