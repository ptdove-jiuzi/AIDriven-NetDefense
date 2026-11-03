/**
 * Declared-directory file metadata source (§5.1 "文件元数据", reconciliation side).
 *
 * Scope discipline: this source records **metadata only** — path, kind, size, mode, owner,
 * inode, mtime, symlink target — plus an optional content hash when explicitly enabled. It
 * never reads file content by default, because §5.1 says file collection records metadata,
 * hashes (when configured) and changes, not content.
 *
 * It is the reconciliation half of the file source: the event half (inotify) belongs to the
 * file watcher, and a 60 s reconciliation pass is what makes a dropped inotify event
 * recoverable. Running this source alone therefore gives you *changes with up to one
 * interval of delay*, never "real-time file monitoring".
 *
 * Two hard limits from the design are enforced rather than approximated:
 * - at most 32 roots; a 33rd root is rejected and reported, never silently ignored;
 * - a per-root entry cap; exceeding it marks the read partial and reports the truncated
 *   root, so a huge directory cannot silently hide the rest.
 */

import { createHash } from 'node:crypto';
import {
  DEFAULT_MAX_ENTITIES,
  buildSnapshotRecord,
  createSnapshotDiffer,
  shortHash,
  stateDigest,
} from '../diff.js';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonNegativeInteger,
  assertPositiveInteger,
} from '../errors.js';
import { assertSourceDescriptor } from './descriptor.js';
import { normalizePayload } from '../payload.js';

export const DIRECTORY_SOURCE_ID = 'linux.declared-directories';
export const DIRECTORY_INTERVAL_MS = 60_000;
export const MAX_DECLARED_ROOTS = 32;
export const DEFAULT_MAX_ENTRIES_PER_ROOT = 4_096;
export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_HASH_MAX_BYTES = 1 * 1024 * 1024;

/** A conservative default; production configuration must declare the roots it cares about. */
export const DEFAULT_ROOTS = Object.freeze(['/etc']);

export const DIRECTORY_FIELDS = Object.freeze([
  { name: 'path', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'root', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'rel_path', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'kind', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'size', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'mode', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'uid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'gid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'inode', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'dev', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'mtime', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'link_target', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'sha256', type: 'string', completeness: 'opt_in', sensitivity: 'D2' },
]);

export function describeDeclaredDirectorySource({
  roots = DEFAULT_ROOTS,
  intervalMs = DIRECTORY_INTERVAL_MS,
  stableSourceId = DIRECTORY_SOURCE_ID,
  recursive = false,
  maxDepth = DEFAULT_MAX_DEPTH,
  includeContentHash = false,
} = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_CONFIG, 'roots must be a non-empty array');
  }
  if (roots.length > MAX_DECLARED_ROOTS) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_CONFIG,
      `at most ${MAX_DECLARED_ROOTS} declared roots are supported (${roots.length} requested)`,
      { roots: roots.length, limit: MAX_DECLARED_ROOTS },
    );
  }
  const descriptor = assertSourceDescriptor({
    stableSourceId,
    kind: 'poll',
    intervalMs,
    requiresRoot: false,
    emits: ['linux.file-metadata'],
    declaredPaths: roots,
    permissions: {
      required: [`read+execute on each declared root (${roots.join(', ')})`],
      optional: [
        'root for the contents of directories with a restrictive mode (/root, /etc/ssl/private, /var/lib/*)',
        'read access to a file for its content hash when includeContentHash is enabled',
      ],
      degradedWithout: [
        'entries below an unreadable subdirectory',
        'sha256 (only when includeContentHash is enabled)',
      ],
    },
    fields: DIRECTORY_FIELDS,
    blindSpots: [
      'Metadata only: file content is not read unless includeContentHash is explicitly enabled',
      'A 60 s reconciliation pass cannot see a file created and deleted inside the interval, and cannot prove that no such file existed',
      'Directories are not entered by default (recursive=false); with recursive=true the depth is capped, and deeper entries are not seen',
      'An inode-preserving in-place edit with an identical size and a restored mtime is invisible to metadata comparison',
      'Only the current mount namespace is visible; entries on an unmounted path are reported as not_found',
    ],
    rotation: 'none: files are compared by inode plus state digest; a replaced file has a new inode and surfaces as an added/removed pair, a truncated one as changed',
    gapSemantics: [
      'poll: a root that cannot be listed is reported in denials and as an unreadable root row; the other roots are still published',
      'poll: exceeding maxEntriesPerRoot marks the read partial and the truncated root is named, so a huge directory never silently hides entries',
      'poll: a root declared but absent is not_found (normal for an optional path) and is not a gap',
      'poll: an unchanged tree produces no records; a quiet interval is not a gap',
    ],
    degradation: {
      onDenied: 'status=denied when no declared root can be listed; nothing is published',
      onPartial: 'status=partial when a root or a subtree is unreadable or a cap was hit; readable entries are still published',
      onEmptyTable: 'zero entries across readable roots is a valid ok read (an empty declared directory really is empty), but an unreadable root never counts as empty',
      neverHealthyWhenEmpty: true,
    },
    emittedGapReasons: ['permission_denied', 'io_error'],
  });

  return Object.freeze({
    ...descriptor,
    recursive,
    maxDepth,
    includeContentHash,
  });
}

export function createDeclaredDirectorySource({
  fileSystem,
  clock = Date.now,
  roots = DEFAULT_ROOTS,
  intervalMs = DIRECTORY_INTERVAL_MS,
  maxRoots = MAX_DECLARED_ROOTS,
  maxEntriesPerRoot = DEFAULT_MAX_ENTRIES_PER_ROOT,
  maxEntities = DEFAULT_MAX_ENTITIES,
  recursive = false,
  maxDepth = DEFAULT_MAX_DEPTH,
  includeContentHash = false,
  hashMaxBytes = DEFAULT_HASH_MAX_BYTES,
  stableSourceId = DIRECTORY_SOURCE_ID,
} = {}) {
  if (!fileSystem || typeof fileSystem.readDir !== 'function' || typeof fileSystem.stat !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a file system exposing stat/readDir is required',
    );
  }
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('maxRoots', maxRoots);
  assertPositiveInteger('maxEntriesPerRoot', maxEntriesPerRoot);
  assertPositiveInteger('maxDepth', maxDepth);
  assertNonNegativeInteger('hashMaxBytes', hashMaxBytes);
  if (maxRoots > MAX_DECLARED_ROOTS) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_CONFIG,
      `maxRoots must not exceed the design limit of ${MAX_DECLARED_ROOTS}`,
      { maxRoots },
    );
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_CONFIG, 'roots must be a non-empty array');
  }
  if (roots.length > MAX_DECLARED_ROOTS) {
    // The design's hard limit is enforced here rather than silently applied: a 33rd root is
    // a configuration error the operator must see, not a root that quietly stops working.
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_CONFIG,
      `at most ${MAX_DECLARED_ROOTS} declared roots are supported (${roots.length} requested)`,
      { roots: roots.length, limit: MAX_DECLARED_ROOTS },
    );
  }

  const accepted = roots.slice(0, maxRoots);
  const rejected = roots.slice(maxRoots);
  const descriptor = describeDeclaredDirectorySource({
    roots: accepted,
    intervalMs,
    stableSourceId,
    recursive,
    maxDepth,
    includeContentHash,
  });
  const differ = createSnapshotDiffer({ maxEntities });

  async function walk(root, relative, depth, items, denials, state) {
    const dirPath = relative.length === 0 ? root : `${root}/${relative}`;
    const listing = await fileSystem.readDir(dirPath, { maxEntries: maxEntriesPerRoot });
    if (!listing.ok) {
      if (listing.outcome === 'permission_denied') {
        denials.push({ path: dirPath, code: listing.code, outcome: listing.outcome });
        state.deniedDirs += 1;
      } else if (listing.outcome !== 'not_found') {
        denials.push({ path: dirPath, code: listing.code, outcome: listing.outcome });
        state.errors += 1;
      }
      return;
    }
    if (listing.truncated) {
      state.truncatedRoots.push(dirPath);
    }

    for (const entry of listing.entries) {
      if (state.entries >= maxEntriesPerRoot * accepted.length) {
        state.capped = true;
        return;
      }
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      const childPath = `${root}/${childRelative}`;
      state.entries += 1;
      const stat = await fileSystem.stat(childPath);
      if (!stat.ok) {
        if (stat.outcome === 'permission_denied') {
          denials.push({ path: childPath, code: stat.code, outcome: stat.outcome });
          state.deniedEntries += 1;
        }
        continue;
      }

      let sha256 = null;
      if (includeContentHash && stat.kind === 'file' && stat.size <= hashMaxBytes && hashMaxBytes > 0) {
        const content = await fileSystem.readText(childPath, { maxBytes: hashMaxBytes });
        if (content.ok) {
          sha256 = createHash('sha256').update(content.bytes).digest('hex');
        }
      }

      items.push({
        entityId: `fs-${shortHash(childPath, 20)}`,
        digest: stateDigest({
          kind: stat.kind,
          size: stat.size,
          mode: stat.mode,
          uid: stat.uid,
          gid: stat.gid,
          dev: stat.dev,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          linkTarget: stat.linkTarget,
          sha256,
        }),
        payload: normalizePayload({
          path: childPath,
          root,
          rel_path: childRelative,
          kind: stat.kind,
          size: stat.size,
          mode: stat.mode,
          uid: stat.uid,
          gid: stat.gid,
          inode: stat.ino,
          dev: stat.dev,
          mtime: new Date(stat.mtimeMs).toISOString(),
          link_target: stat.linkTarget,
          ...(sha256 === null ? {} : { sha256 }),
        }).payload,
      });

      if (recursive && stat.kind === 'directory' && depth < maxDepth) {
        await walk(root, childRelative, depth + 1, items, denials, state);
      }
    }
  }

  return Object.freeze({
    descriptor,
    rejectedRoots: Object.freeze(rejected),

    async read() {
      const observedAt = clock();
      const denials = [];
      const items = [];
      const state = {
        entries: 0,
        deniedDirs: 0,
        deniedEntries: 0,
        errors: 0,
        capped: false,
        truncatedRoots: [],
      };
      let readableRoots = 0;

      for (const root of accepted) {
        const rootStat = await fileSystem.stat(root);
        if (!rootStat.ok || rootStat.kind !== 'directory') {
          if (rootStat.ok) {
            denials.push({ path: root, code: 'ENOTDIR', outcome: 'not_directory' });
          } else if (rootStat.outcome === 'permission_denied') {
            denials.push({ path: root, code: rootStat.code, outcome: rootStat.outcome });
            // The root row documents "declared but unreadable" so the tree is never empty.
            items.push({
              entityId: `fsroot-${shortHash(root, 20)}`,
              digest: stateDigest({ root, readable: false, code: rootStat.code }),
              payload: normalizePayload({
                path: root,
                root,
                rel_path: '.',
                kind: 'root',
                readable: false,
                error_code: rootStat.code,
              }).payload,
            });
          }
          continue;
        }
        readableRoots += 1;
        await walk(root, '', 0, items, denials, state);
      }

      if (readableRoots === 0) {
        const denied = denials.some((entry) => entry.outcome === 'permission_denied');
        return Object.freeze({
          status: denied ? 'denied' : 'error',
          records: [],
          denials,
          permissions: { granted: [], missing: denied ? denials.map((entry) => entry.path) : [] },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: false,
          rejectedRoots: Object.freeze(rejected),
          observedAt,
          error: {
            code: denied ? 'EACCES' : 'ENOENT',
            message: denied
              ? 'none of the declared roots is readable by this account'
              : 'none of the declared roots exists on this system',
          },
        });
      }

      // Suppression is scoped to the denied subtrees: an entry below a directory we could not
      // list may still exist, but an entry that really vanished from a readable directory is
      // a genuine deletion. A capped or truncated walk is global evidence loss.
      const deniedPaths = denials.map((denial) => denial.path);
      const globalLoss = state.capped || state.truncatedRoots.length > 0;
      const diff = differ.diff(items, {
        suppressRemovalsFor: (entry) => {
          if (globalLoss) {
            return true;
          }
          const path = entry.item.payload.path;
          return typeof path === 'string'
            && deniedPaths.some((denied) => path === denied || path.startsWith(`${denied}/`));
        },
      });
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: 'linux.file-metadata',
          entityId: entry.entityId,
          digest: entry.digest,
          observedAt,
          change: entry.kind === 'snapshot' ? 'snapshot' : entry.kind,
          payload: normalizePayload(entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true }).payload,
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      const blind = denials.length > 0 || globalLoss;
      let status = 'ok';
      if (blind || rejected.length > 0) {
        status = blind && items.length === 0 ? 'denied' : 'partial';
      }
      const missing = status === 'denied' ? denials.map((denial) => denial.path) : [];

      return Object.freeze({
        status,
        records,
        denials,
        permissions: { granted: accepted.filter((root) => !denials.some((d) => d.path === root)), missing },
        suppressedRemovals: diff.suppressedRemovals,
        nextCursor: null,
        identity: { fileId: stableSourceId, size: items.length },
        snapshot: diff.snapshot,
        truncated: diff.truncated || state.capped,
        rejectedRoots: Object.freeze(rejected),
        observedAt,
        stats: Object.freeze({
          entries: state.entries,
          deniedDirs: state.deniedDirs,
          deniedEntries: state.deniedEntries,
          errors: state.errors,
          truncatedRoots: Object.freeze([...state.truncatedRoots]),
          clippedByEntityLimit: diff.truncated,
        }),
        error: null,
      });
    },
  });
}
