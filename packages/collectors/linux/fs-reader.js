/**
 * File-system abstraction shared by every Linux source (§5.1 file/procfs sources).
 *
 * Why an interface instead of calling `node:fs` directly:
 *
 * 1. A non-root collector is *expected* to be denied on `/var/log/auth.log`,
 *    `/proc/<pid>/exe` or `/var/spool/cron/*`. Permission outcomes therefore have to be
 *    values, not exceptions, so the caller can degrade the source instead of crashing.
 * 2. Tests must never touch the real `/proc`, `/etc` or `/var/log`. The same interface is
 *    implemented over an in-memory fixture manifest (`createMemoryFileSystem`), so every
 *    source is exercised against JSON fixtures only.
 * 3. Paths are virtual POSIX paths inside an injectable `root`. The real root is `/`; a
 *    test root is a temporary directory; a memory filesystem has no root at all.
 *
 * All methods are async and never throw for expected outcomes. A caller that gets
 * `{ ok: false, code: 'EACCES', outcome: 'permission_denied' }` must treat the source as
 * degraded — it must NOT convert that into "zero records, source healthy".
 */

import * as nodeFs from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertVirtualPath,
  classifyFsCode,
} from './errors.js';

export const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_DIR_ENTRIES = 65_536;

const FILE_KINDS = Object.freeze(['file', 'directory', 'symlink', 'other']);

function lengthOf(entries) {
  return Array.isArray(entries) ? entries.length : 0;
}

/**
 * Normalize a virtual path: collapse `.` and duplicate slashes, keep the leading `/`.
 * `..` is rejected by `assertVirtualPath` before this runs.
 */
export function normalizeVirtualPath(value) {
  const asserted = assertVirtualPath('path', value);
  const normalized = posix.normalize(asserted);
  if (!normalized.startsWith('/')) {
    // posix.normalize('/x') keeps the slash; anything else means the input was emptied.
    return '/';
  }
  return normalized;
}

function parentOf(virtualPath) {
  const index = virtualPath.lastIndexOf('/');
  return index <= 0 ? '/' : virtualPath.slice(0, index);
}

function baseNameOf(virtualPath) {
  const index = virtualPath.lastIndexOf('/');
  return index === -1 ? virtualPath : virtualPath.slice(index + 1);
}

function failure(code, extra = {}) {
  return Object.freeze({
    ok: false,
    code,
    outcome: classifyFsCode(code),
    ...extra,
  });
}

function kindFromDirent(dirent) {
  if (dirent.isSymbolicLink()) {
    return 'symlink';
  }
  if (dirent.isDirectory()) {
    return 'directory';
  }
  if (dirent.isFile()) {
    return 'file';
  }
  return 'other';
}

function createStats() {
  const counters = { stat: 0, readText: 0, readDir: 0, readLink: 0, bytes: 0, failures: 0 };
  const readPaths = new Set();
  const failedPaths = [];
  return {
    counters,
    readPaths,
    failedPaths,
    record(kind, virtualPath, amount = 0) {
      if (kind === 'bytes') {
        // Byte accounting is an amount, not a call count; counting it twice would make the
        // instrumentation lie about how much content was read.
        counters.bytes += amount;
        return;
      }
      counters[kind] = (counters[kind] ?? 0) + 1;
      if (kind === 'readText') {
        readPaths.add(virtualPath);
      }
    },
    recordFailure(virtualPath, code) {
      counters.failures += 1;
      failedPaths.push({ path: virtualPath, code });
    },
  };
}

function statsSnapshot(tracker) {
  return Object.freeze({
    ...tracker.counters,
    readPaths: Object.freeze([...tracker.readPaths].sort()),
    failedPaths: Object.freeze(tracker.failedPaths.map((entry) => Object.freeze({ ...entry }))),
  });
}

/**
 * Node-backed implementation. `root` is prepended to every virtual path.
 *
 * Containment is enforced lexically for `stat`/`readDir`/`readLink` (a `..` segment is
 * rejected outright) and *physically* for `readText`, where the resolved path is compared
 * against the real root with `realpath`: a symlink inside the root can otherwise point a
 * content read somewhere else. `stat`/`readDir` do not resolve symlinks, which is exactly
 * what a metadata source wants (it must see the link, not what it points at).
 */
export function createNodeFileSystem({
  root = '/',
  fs = nodeFs,
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  maxDirEntries = DEFAULT_MAX_DIR_ENTRIES,
} = {}) {
  if (root !== '/' && typeof root !== 'string') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'root must be a path string');
  }
  assertPositiveInteger('maxReadBytes', maxReadBytes);
  assertPositiveInteger('maxDirEntries', maxDirEntries);
  if (fs === null || typeof fs.lstat !== 'function' || typeof fs.readdir !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'fs must expose lstat/readdir/readFile/readlink (node:fs/promises shape)',
    );
  }

  const rootResolved = root === '/' ? '/' : resolve(root);
  const tracker = createStats();

  function toRealPath(virtualPath) {
    const normalized = normalizeVirtualPath(virtualPath);
    if (rootResolved === '/') {
      return { virtualPath: normalized, realPath: normalized };
    }
    const realPath = resolve(join(rootResolved, `.${normalized}`));
    if (realPath !== rootResolved && !realPath.startsWith(`${rootResolved}${sep}`)) {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.PATH_ESCAPE,
        `path escapes the injected root: ${virtualPath}`,
        { path: virtualPath },
      );
    }
    return { virtualPath: normalized, realPath };
  }

  async function linkTargetFor(realPath) {
    if (typeof fs.readlink !== 'function') {
      return null;
    }
    try {
      return await fs.readlink(realPath);
    } catch {
      return null;
    }
  }

  return Object.freeze({
    root: rootResolved,
    maxReadBytes,

    async stat(virtualPath) {
      const { virtualPath: normalized, realPath } = toRealPath(virtualPath);
      tracker.record('stat', normalized);
      try {
        const info = await fs.lstat(realPath);
        const kind = info.isSymbolicLink()
          ? 'symlink'
          : (info.isDirectory() ? 'directory' : (info.isFile() ? 'file' : 'other'));
        return Object.freeze({
          ok: true,
          path: normalized,
          kind: FILE_KINDS.includes(kind) ? kind : 'other',
          size: Number(info.size ?? 0),
          mode: Number(info.mode ?? 0),
          mtimeMs: Number(info.mtimeMs ?? 0),
          ctimeMs: Number(info.ctimeMs ?? 0),
          dev: Number(info.dev ?? 0),
          ino: Number(info.ino ?? 0),
          uid: Number(info.uid ?? 0),
          gid: Number(info.gid ?? 0),
          linkTarget: kind === 'symlink' ? await linkTargetFor(realPath) : null,
        });
      } catch (error) {
        if (error instanceof LinuxCollectorError) {
          throw error;
        }
        tracker.recordFailure(normalized, error.code ?? 'EIO');
        return failure(error.code ?? 'EIO', { path: normalized });
      }
    },

    async readText(virtualPath, { offset = 0, maxBytes = maxReadBytes } = {}) {
      const { virtualPath: normalized, realPath } = toRealPath(virtualPath);
      assertNonNegativeInteger('offset', offset);
      assertPositiveInteger('maxBytes', maxBytes);
      tracker.record('readText', normalized);
      let handle = null;
      try {
        if (rootResolved !== '/' && typeof fs.realpath === 'function') {
          const physical = await fs.realpath(realPath);
          if (physical !== rootResolved && !physical.startsWith(`${rootResolved}${sep}`)) {
            throw new LinuxCollectorError(
              LINUX_ERROR_CODES.PATH_ESCAPE,
              `resolved path escapes the injected root: ${virtualPath}`,
              { path: virtualPath, resolved: physical },
            );
          }
        }
        handle = await fs.open(realPath, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
        tracker.record('bytes', normalized, bytesRead);
        const bytes = buffer.subarray(0, bytesRead);
        return Object.freeze({
          ok: true,
          path: normalized,
          text: bytes.toString('utf8'),
          bytes,
          bytesRead,
          offset,
          // A full buffer means "there may be more"; the caller decides what to do with a
          // record that spans the boundary.
          truncated: bytesRead === maxBytes,
        });
      } catch (error) {
        tracker.recordFailure(normalized, error.code ?? 'EIO');
        return failure(error.code ?? 'EIO', { path: normalized, offset });
      } finally {
        if (handle !== null) {
          await handle.close().catch(() => {});
        }
      }
    },

    async readDir(virtualPath, { maxEntries = maxDirEntries } = {}) {
      const { virtualPath: normalized, realPath } = toRealPath(virtualPath);
      assertPositiveInteger('maxEntries', maxEntries);
      tracker.record('readDir', normalized);
      try {
        const dirents = await fs.readdir(realPath, { withFileTypes: true });
        const limited = dirents.slice(0, maxEntries);
        const entries = limited.map((dirent) => Object.freeze({
          name: String(dirent.name),
          kind: kindFromDirent(dirent),
        }));
        return Object.freeze({
          ok: true,
          path: normalized,
          entries: Object.freeze(entries),
          truncated: lengthOf(dirents) > entries.length,
          total: lengthOf(dirents),
        });
      } catch (error) {
        tracker.recordFailure(normalized, error.code ?? 'EIO');
        return failure(error.code ?? 'EIO', { path: normalized });
      }
    },

    async readLink(virtualPath) {
      const { virtualPath: normalized, realPath } = toRealPath(virtualPath);
      tracker.record('readLink', normalized);
      try {
        const target = await fs.readlink(realPath);
        return Object.freeze({ ok: true, path: normalized, target: String(target) });
      } catch (error) {
        tracker.recordFailure(normalized, error.code ?? 'EIO');
        return failure(error.code ?? 'EIO', { path: normalized });
      }
    },

    stats() {
      return statsSnapshot(tracker);
    },

    resetStats() {
      Object.assign(tracker.counters, { stat: 0, readText: 0, readDir: 0, readLink: 0, bytes: 0, failures: 0 });
      tracker.readPaths.clear();
      tracker.failedPaths.length = 0;
    },
  });
}

/**
 * In-memory filesystem driven by a JSON fixture manifest. Shape:
 *
 * ```json
 * {
 *   "files": { "/proc/1/stat": "1 (init) S 0 0 ..." ,
 *              "/etc/crontab": { "content": "...", "mtimeMs": 1, "mode": 420 } },
 *   "symlinks": { "/proc/1/exe": "/usr/bin/init" },
 *   "directories": { "/proc": ["1", "2"], "/var/spool/cron": { "entries": [], "denied": true } },
 *   "denied": ["/var/log/auth.log"],
 *   "missing": ["/proc/sys/kernel/osrelease"],
 *   "readCaps": { "/proc/1/cmdline": 8 }
 * }
 * ```
 *
 * Directories are derived from the file/symlink paths, so a fixture only has to list a
 * directory explicitly when it is empty, denied, or needs a specific order.
 */
export function createMemoryFileSystem(manifest = {}) {
  if (manifest === null || typeof manifest !== 'object') {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'manifest must be an object');
  }

  const files = new Map();
  const symlinks = new Map();
  const symlinkInodes = new Map();
  const explicitDirs = new Map();
  const denied = new Set();
  const missing = new Set();
  const readCaps = new Map();
  const tracker = createStats();

  const now = Number(manifest.nowMs ?? 1_700_000_000_000);
  let nextInode = 1000;

  function defineFile(path, definition) {
    const normalized = normalizeVirtualPath(path);
    const raw = typeof definition === 'string' ? { content: definition } : (definition ?? {});
    const content = typeof raw.content === 'string' ? raw.content : '';
    const bytes = Buffer.from(content, 'utf8');
    nextInode += 1;
    files.set(normalized, {
      content,
      bytes,
      size: raw.size === undefined ? bytes.length : Number(raw.size),
      mode: raw.mode === undefined ? 0o644 : Number(raw.mode),
      mtimeMs: raw.mtimeMs === undefined ? now : Number(raw.mtimeMs),
      ctimeMs: raw.ctimeMs === undefined ? now : Number(raw.ctimeMs),
      dev: raw.dev === undefined ? 1 : Number(raw.dev),
      ino: raw.ino === undefined ? nextInode : Number(raw.ino),
      uid: raw.uid === undefined ? 0 : Number(raw.uid),
      gid: raw.gid === undefined ? 0 : Number(raw.gid),
    });
  }

  for (const [path, definition] of Object.entries(manifest.files ?? {})) {
    defineFile(path, definition);
  }
  for (const [path, target] of Object.entries(manifest.symlinks ?? {})) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, `symlink target for ${path} must be a string`);
    }
    const normalized = normalizeVirtualPath(path);
    symlinks.set(normalized, target);
    // A symlink needs a stable inode of its own: deriving it from a mutable counter would
    // make every unrelated write look like a change to every symlink.
    nextInode += 1;
    symlinkInodes.set(normalized, nextInode);
  }
  for (const [path, definition] of Object.entries(manifest.directories ?? {})) {
    const normalized = normalizeVirtualPath(path);
    const raw = Array.isArray(definition) ? { entries: definition } : (definition ?? {});
    explicitDirs.set(normalized, {
      entries: Array.isArray(raw.entries) ? raw.entries.map((name) => String(name)) : null,
      mode: raw.mode === undefined ? 0o755 : Number(raw.mode),
      denied: raw.denied === true,
      mtimeMs: raw.mtimeMs === undefined ? now : Number(raw.mtimeMs),
    });
  }
  for (const path of manifest.denied ?? []) {
    denied.add(normalizeVirtualPath(path));
  }
  for (const path of manifest.missing ?? []) {
    missing.add(normalizeVirtualPath(path));
  }
  for (const [path, limit] of Object.entries(manifest.readCaps ?? {})) {
    readCaps.set(normalizeVirtualPath(path), Number(limit));
  }

  function isDenied(virtualPath) {
    if (denied.has(virtualPath)) {
      return true;
    }
    // A denied directory denies everything below it, which is what EACCES on the parent
    // actually does on a real filesystem.
    for (const entry of denied) {
      if (virtualPath.startsWith(`${entry}/`)) {
        return true;
      }
    }
    return false;
  }

  function childNames(directoryPath) {
    const names = new Set();
    const prefix = directoryPath === '/' ? '/' : `${directoryPath}/`;
    for (const path of [...files.keys(), ...symlinks.keys()]) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      if (rest.length === 0) {
        continue;
      }
      const [first] = rest.split('/');
      if (first.length > 0) {
        names.add(first);
      }
    }
    for (const path of explicitDirs.keys()) {
      if (!path.startsWith(prefix) || path === directoryPath) {
        continue;
      }
      const rest = path.slice(prefix.length);
      const [first] = rest.split('/');
      if (first.length > 0) {
        names.add(first);
      }
    }
    return [...names].sort();
  }

  function kindOf(virtualPath) {
    if (symlinks.has(virtualPath)) {
      return 'symlink';
    }
    if (files.has(virtualPath)) {
      return 'file';
    }
    if (explicitDirs.has(virtualPath) || virtualPath === '/') {
      return 'directory';
    }
    if (childNames(virtualPath).length > 0) {
      return 'directory';
    }
    return null;
  }

  return Object.freeze({
    root: '/',

    async stat(virtualPath) {
      const normalized = normalizeVirtualPath(virtualPath);
      tracker.record('stat', normalized);
      if (missing.has(normalized)) {
        tracker.recordFailure(normalized, 'ENOENT');
        return failure('ENOENT', { path: normalized });
      }
      if (isDenied(normalized)) {
        tracker.recordFailure(normalized, 'EACCES');
        return failure('EACCES', { path: normalized });
      }
      const kind = kindOf(normalized);
      if (kind === null) {
        tracker.recordFailure(normalized, 'ENOENT');
        return failure('ENOENT', { path: normalized });
      }
      if (kind === 'symlink') {
        return Object.freeze({
          ok: true,
          path: normalized,
          kind: 'symlink',
          size: 0,
          mode: 0o777,
          mtimeMs: now,
          ctimeMs: now,
          dev: 1,
          ino: symlinkInodes.get(normalized) ?? 999,
          uid: 0,
          gid: 0,
          linkTarget: symlinks.get(normalized),
        });
      }
      if (kind === 'directory') {
        const dir = explicitDirs.get(normalized);
        return Object.freeze({
          ok: true,
          path: normalized,
          kind: 'directory',
          size: 0,
          mode: dir === undefined ? 0o755 : dir.mode,
          mtimeMs: dir === undefined ? now : dir.mtimeMs,
          ctimeMs: now,
          dev: 1,
          ino: 900,
          uid: 0,
          gid: 0,
          linkTarget: null,
        });
      }
      const entry = files.get(normalized);
      return Object.freeze({
        ok: true,
        path: normalized,
        kind: 'file',
        size: entry.size,
        mode: entry.mode,
        mtimeMs: entry.mtimeMs,
        ctimeMs: entry.ctimeMs,
        dev: entry.dev,
        ino: entry.ino,
        uid: entry.uid,
        gid: entry.gid,
        linkTarget: null,
      });
    },

    async readText(virtualPath, { offset = 0, maxBytes = DEFAULT_MAX_READ_BYTES } = {}) {
      const normalized = normalizeVirtualPath(virtualPath);
      assertNonNegativeInteger('offset', offset);
      assertPositiveInteger('maxBytes', maxBytes);
      tracker.record('readText', normalized);
      if (missing.has(normalized) || !files.has(normalized)) {
        if (isDenied(normalized)) {
          tracker.recordFailure(normalized, 'EACCES');
          return failure('EACCES', { path: normalized, offset });
        }
        tracker.recordFailure(normalized, 'ENOENT');
        return failure('ENOENT', { path: normalized, offset });
      }
      if (isDenied(normalized)) {
        tracker.recordFailure(normalized, 'EACCES');
        return failure('EACCES', { path: normalized, offset });
      }
      const entry = files.get(normalized);
      const cap = readCaps.has(normalized) ? readCaps.get(normalized) : maxBytes;
      const limit = Math.min(maxBytes, Math.max(1, cap));
      const slice = entry.bytes.subarray(offset, offset + limit);
      tracker.record('bytes', normalized, slice.length);
      return Object.freeze({
        ok: true,
        path: normalized,
        text: slice.toString('utf8'),
        bytes: slice,
        bytesRead: slice.length,
        offset,
        truncated: offset + slice.length < entry.bytes.length && slice.length === limit,
      });
    },

    async readDir(virtualPath, { maxEntries = DEFAULT_MAX_DIR_ENTRIES } = {}) {
      const normalized = normalizeVirtualPath(virtualPath);
      assertPositiveInteger('maxEntries', maxEntries);
      tracker.record('readDir', normalized);
      if (missing.has(normalized)) {
        tracker.recordFailure(normalized, 'ENOENT');
        return failure('ENOENT', { path: normalized });
      }
      if (isDenied(normalized) || explicitDirs.get(normalized)?.denied === true) {
        tracker.recordFailure(normalized, 'EACCES');
        return failure('EACCES', { path: normalized });
      }
      const kind = kindOf(normalized);
      if (kind === null) {
        tracker.recordFailure(normalized, 'ENOENT');
        return failure('ENOENT', { path: normalized });
      }
      if (kind !== 'directory') {
        tracker.recordFailure(normalized, 'ENOTDIR');
        return failure('ENOTDIR', { path: normalized });
      }
      const explicit = explicitDirs.get(normalized);
      const all = explicit?.entries === null || explicit?.entries === undefined
        ? childNames(normalized)
        : [...explicit.entries];
      const entries = all.slice(0, maxEntries).map((name) => {
        const childPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;
        return Object.freeze({ name, kind: kindOf(childPath) ?? 'other' });
      });
      return Object.freeze({
        ok: true,
        path: normalized,
        entries: Object.freeze(entries),
        truncated: all.length > entries.length,
        total: all.length,
      });
    },

    async readLink(virtualPath) {
      const normalized = normalizeVirtualPath(virtualPath);
      tracker.record('readLink', normalized);
      if (isDenied(normalized)) {
        tracker.recordFailure(normalized, 'EACCES');
        return failure('EACCES', { path: normalized });
      }
      if (!symlinks.has(normalized)) {
        if (files.has(normalized) || kindOf(normalized) !== null) {
          tracker.recordFailure(normalized, 'EINVAL');
          return failure('EINVAL', { path: normalized });
        }
        tracker.recordFailure(normalized, 'ENOENT');
        return failure('ENOENT', { path: normalized });
      }
      return Object.freeze({ ok: true, path: normalized, target: symlinks.get(normalized) });
    },

    stats() {
      return statsSnapshot(tracker);
    },

    resetStats() {
      Object.assign(tracker.counters, { stat: 0, readText: 0, readDir: 0, readLink: 0, bytes: 0, failures: 0 });
      tracker.readPaths.clear();
      tracker.failedPaths.length = 0;
    },

    /**
     * Test helper: replace a file's content after the filesystem was built (append,
     * rewrite). The inode, dev and mode are preserved unless overridden, because that is
     * what an in-place append or rewrite does; pass `{ ino: n }` to model a rotation.
     */
    write(path, content, overrides = {}) {
      const normalized = normalizeVirtualPath(path);
      const previous = files.get(normalized);
      defineFile(path, {
        content,
        ...(previous === undefined ? {} : { ino: previous.ino, dev: previous.dev, mode: previous.mode }),
        ...overrides,
      });
    },

    /** Test helper: simulate `rm`. */
    remove(path) {
      const normalized = normalizeVirtualPath(path);
      files.delete(normalized);
      symlinks.delete(normalized);
    },

    setDenied(path, isDeniedNow = true) {
      const normalized = normalizeVirtualPath(path);
      if (isDeniedNow) {
        denied.add(normalized);
        return;
      }
      denied.delete(normalized);
      const explicit = explicitDirs.get(normalized);
      if (explicit !== undefined && explicit.denied) {
        // Granting access also restores the derived listing, so a fixture that was denied as
        // a whole directory behaves like the real thing once the permission is fixed.
        explicitDirs.set(normalized, { ...explicit, denied: false, entries: null });
      }
    },

    listPaths() {
      return Object.freeze([...files.keys()].sort());
    },
  });
}

export { baseNameOf, parentOf, FILE_KINDS, createStats };
