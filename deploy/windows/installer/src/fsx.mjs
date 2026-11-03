/**
 * fsx.mjs — the filesystem verbs the state machine is allowed to use.
 *
 * Three rules are enforced here rather than trusted to callers:
 *
 * 1. **Atomic metadata writes.** `journal.json` and friends are written to a temp
 *    file, `fsync`ed, renamed, and the directory entry is flushed. A torn journal is
 *    worse than no journal: §6.2 recovery is driven by `phase`, and a half-written
 *    phase would send recovery down the wrong branch.
 * 2. **Guarded deletes.** `removeTree` refuses volume roots, shallow paths, and
 *    anything outside the roots the layout declared. One bad variable name must not
 *    turn into a recursive delete of `C:\Program Files`.
 * 3. **Copy is also a hash pass.** Staging copies are hashed while they are copied,
 *    so the "verify after extraction" step cannot silently verify a different file
 *    from the one that was written.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  fsyncSync,
} from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

/** Stream a file through SHA-256 without loading it into memory. */
export function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function fsyncDir(path) {
  // Windows cannot fsync a directory handle; the rename above is already ordered by
  // NTFS. Swallow only the errors that mean "not supported here".
  let fd;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EISDIR' && error.code !== 'EACCES' && error.code !== 'EBADF') {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write a file so that a crash leaves either the old bytes or the new bytes.
 *
 * @param {string} path Target.
 * @param {string} text Contents.
 */
export function writeFileAtomic(path, text) {
  ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, text, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDir(dirname(path));
}

export function writeJsonAtomic(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Refuse paths that must never be deleted recursively.
 *
 * @param {string} target Path about to be removed.
 * @param {readonly string[]} allowedRoots Roots the caller declared it may delete in.
 */
export function assertDeletable(target, allowedRoots) {
  const absolute = resolve(target);
  const { dir } = parse(absolute);
  if (dir === absolute) {
    throw new Error(`拒绝删除卷根：${absolute}`);
  }
  if (absolute.split(sep).filter(Boolean).length < 2) {
    throw new Error(`拒绝删除层级过浅的路径：${absolute}`);
  }
  const permitted = allowedRoots.some((root) => {
    const normalizedRoot = resolve(root);
    return absolute.toLowerCase() === normalizedRoot.toLowerCase()
      || `${absolute.toLowerCase()}${sep}`.startsWith(`${normalizedRoot.toLowerCase()}${sep}`);
  });
  if (!permitted) {
    throw new Error(`拒绝删除未登记根之下的路径：${absolute}（允许根：${allowedRoots.join(', ')}）`);
  }
}

export function removeTree(target, allowedRoots) {
  assertDeletable(target, allowedRoots);
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** Every regular file under `root` as forward-slash relative paths, sorted. */
export function listFiles(root, { skip = [] } = {}) {
  const files = [];
  const skipSet = new Set(skip);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        // A symlink in a payload would let "copy the bundle" write outside the target.
        throw new Error(`载荷包含符号链接，拒绝安装：${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (skipSet.has(relativePath)) continue;
        walk(path);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Copy a tree and hash every file as it is written.
 *
 * @param {string} source Source directory.
 * @param {string} target Destination directory (created).
 * @returns {Promise<{files: string[], digests: Map<string, string>}>}
 */
export async function copyTreeHashed(source, target) {
  const files = listFiles(source);
  const digests = new Map();
  for (const relativePath of files) {
    const from = join(source, relativePath);
    const to = join(target, relativePath);
    ensureDir(dirname(to));
    await new Promise((resolvePromise, rejectPromise) => {
      const hash = createHash('sha256');
      const input = createReadStream(from);
      const output = createWriteStream(to);
      input.on('error', rejectPromise);
      output.on('error', rejectPromise);
      input.on('data', (chunk) => {
        hash.update(chunk);
        if (!output.write(chunk)) input.pause();
      });
      output.on('drain', () => input.resume());
      input.on('end', () => {
        output.end(() => {
          digests.set(relativePath, hash.digest('hex'));
          resolvePromise();
        });
      });
    });
  }
  return { files, digests };
}

export function pathExists(path) {
  return existsSync(path);
}

export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function directorySize(path) {
  let total = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  walk(path);
  return total;
}
