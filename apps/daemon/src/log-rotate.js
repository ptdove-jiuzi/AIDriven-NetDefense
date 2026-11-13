/**
 * log-rotate.js — size + age retention for daemon-owned log directories.
 *
 * Owner: OPS-DIAG 战役（作者 PT-dove）。`daemon.js` 在启动时调用本模块；导出的
 * 签名 `enforceLogRetention({directories, policy, nowMs})` 与骨架保持一致。
 *
 * Policy (shared with `apps/desktop/aidn/logrotate.py`):
 *   - a single log file is capped at 8 MiB;
 *   - a log directory is capped at 64 MiB in total;
 *   - files older than 7 days are removed;
 *   - the newest file and any file modified in the last hour are never removed or
 *     truncated (an active writer must not lose its tail).
 *
 * Why this exists: a daemon that appends to `*.log` forever eventually fills the
 * disk, and a full disk surfaces to the user as "daemon will not start".
 * Retention therefore has to be enforced by the product itself, with hard limits.
 *
 * Safety rules that are not negotiable:
 *
 *   1. This module never throws. Every failure is reported in `skipped` so a
 *      broken directory or a file locked by another process cannot take the
 *      daemon down during startup.
 *   2. Symbolic links are never followed and never modified. A link is reported
 *      and left alone: on Windows a junction can point at the user's profile and
 *      deleting "through" it would be a data-loss bug.
 *   3. A path is only acted on after `realpath` proves it lives inside one of
 *      the given directories.
 *   4. Idempotent: running it twice in a row with the same `nowMs` deletes
 *      nothing the second time and leaves `bytes_after` identical. Rotation
 *      products (`*.log.1`) are matched but never rotated again, so a retention
 *      tick cannot grow the suffix chain.
 *
 * The function is synchronous on purpose: startup code may call it with or
 * without `await`, and a plain object keeps the "never throws, always reports"
 * contract easy to reason about.
 */

import { lstatSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `*.log`, `*.log.N` and `*.stderr.log` — any name carrying a `.log` segment. */
const LOG_FILE_NAME = /\.log(?:\.|$)/iu;
const MAX_ROTATE_SUFFIX_ATTEMPTS = 100;

/** Default retention policy, mirrored in the desktop shell's logrotate module. */
export const DEFAULT_LOG_POLICY = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxAgeDays: 7,
  protectMs: 60 * 60 * 1000,
});

/**
 * Coerce one policy field. Zero, negative, `NaN` and `Infinity` fall back to the
 * documented default: a caller passing `maxTotalBytes: 0` must not be able to
 * turn retention into "delete every log file".
 *
 * @param {unknown} value Candidate value.
 * @param {number} fallback Documented default.
 * @returns {number} Usable value.
 */
function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Merge a partial policy with the defaults.
 *
 * @param {object} policy Partial policy.
 * @returns {{maxFileBytes: number, maxTotalBytes: number, maxAgeDays: number, protectMs: number}} Policy.
 */
function normalizePolicy(policy) {
  const source = policy !== null && typeof policy === 'object' ? policy : {};
  return {
    maxFileBytes: positiveNumber(source.maxFileBytes, DEFAULT_LOG_POLICY.maxFileBytes),
    maxTotalBytes: positiveNumber(source.maxTotalBytes, DEFAULT_LOG_POLICY.maxTotalBytes),
    maxAgeDays: positiveNumber(source.maxAgeDays, DEFAULT_LOG_POLICY.maxAgeDays),
    protectMs: positiveNumber(source.protectMs, DEFAULT_LOG_POLICY.protectMs),
  };
}

/**
 * `true` when `candidate` is a strict descendant of `root`.
 *
 * @param {string} root Resolved directory.
 * @param {string} candidate Resolved file.
 * @returns {boolean} Whether the file is inside the directory.
 */
function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * `true` when the path currently exists (a dangling link counts as taken).
 *
 * @param {string} target Path.
 * @returns {boolean} Existence.
 */
function entryExists(target) {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the caller's directory list, reporting unusable entries instead of throwing.
 *
 * @param {string | string[] | undefined | null} directories Directory list.
 * @param {Array<{path: string, reason: string}>} skipped Sink for problems.
 * @returns {Array<{given: string, root: string}>} Resolved roots.
 */
function normalizeDirectories(directories, skipped) {
  const list = Array.isArray(directories)
    ? directories
    : directories === undefined || directories === null
      ? []
      : [directories];
  const roots = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0) {
      skipped.push({ path: String(entry), reason: 'invalid-directory' });
      continue;
    }
    try {
      const root = realpathSync(entry);
      if (!statSync(root).isDirectory()) {
        skipped.push({ path: entry, reason: 'not-a-directory' });
        continue;
      }
      roots.push({ given: entry, root });
    } catch (error) {
      skipped.push({ path: entry, reason: `directory-unavailable: ${error.code ?? error.message}` });
    }
  }
  return roots;
}

/**
 * Recursively collect candidate log files under one resolved root.
 *
 * @param {{given: string, root: string}} root Resolved root.
 * @param {Array<{path: string, reason: string}>} skipped Sink for problems.
 * @returns {Array<{path: string, resolved: string, size: number, mtimeMs: number, deleted: boolean}>} Records.
 */
function collectLogFiles(root, skipped) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: directory, reason: `unreadable-directory: ${error.code ?? error.message}` });
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      let info;
      try {
        // `lstat`, not `stat`: a symlink must stay visible as a symlink so it can
        // be reported and skipped instead of being followed silently.
        info = lstatSync(full);
      } catch (error) {
        skipped.push({ path: full, reason: `stat-failed: ${error.code ?? error.message}` });
        continue;
      }
      if (info.isSymbolicLink()) {
        skipped.push({ path: full, reason: 'symlink-not-followed' });
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (!info.isFile() || !LOG_FILE_NAME.test(entry.name)) {
        continue;
      }
      let resolved;
      try {
        resolved = realpathSync(full);
      } catch (error) {
        skipped.push({ path: full, reason: `realpath-failed: ${error.code ?? error.message}` });
        continue;
      }
      if (!isInsideRoot(root.root, resolved)) {
        skipped.push({ path: full, reason: 'outside-directory' });
        continue;
      }
      found.push({ path: full, resolved, size: info.size, mtimeMs: info.mtimeMs, deleted: false });
    }
  };
  walk(root.root);
  return found;
}

/**
 * Pick a free rotation target: `<file>.1`, else `<file>.<epochMs>`, else `.n`.
 *
 * @param {string} file Current log file.
 * @returns {string} Unused path.
 */
function nextRotationName(file) {
  const first = `${file}.1`;
  if (!entryExists(first)) {
    return first;
  }
  const stamped = `${file}.${Date.now()}`;
  if (!entryExists(stamped)) {
    return stamped;
  }
  for (let index = 2; index < MAX_ROTATE_SUFFIX_ATTEMPTS; index += 1) {
    const candidate = `${stamped}.${index}`;
    if (!entryExists(candidate)) {
      return candidate;
    }
  }
  throw new Error('no free rotation suffix');
}

/**
 * `true` for a live log file (`foo.log`), `false` for a rotation product
 * (`foo.log.1`). Rotation products are never rotated again — that is what makes
 * repeated retention passes idempotent.
 *
 * @param {string} file Path.
 * @returns {boolean} Whether the name ends with `.log`.
 */
function isRotatableName(file) {
  return file.toLowerCase().endsWith('.log');
}

/**
 * Enforce the retention policy over one or more log directories.
 *
 * Order is part of the contract: expire by age, then trim by total bytes (oldest
 * first), then rotate files that are still too large. Rotation is a rename, so it
 * never changes the byte total and cannot push the tree back over the limit.
 *
 * @param {{directories?: string | string[], policy?: object, nowMs?: number}} [options] Options.
 * @returns {{
 *   examined: number,
 *   deleted: string[],
 *   rotated: Array<{path: string, to: string, bytes: number}>,
 *   truncated: Array<never>,
 *   bytes_before: number,
 *   bytes_after: number,
 *   skipped: Array<{path: string, reason: string}>
 * }} Report. `truncated` is always empty on this side — the daemon rotates by
 *   rename only; the key exists so both ends return the same shape.
 */
export function enforceLogRetention({ directories, policy = DEFAULT_LOG_POLICY, nowMs = Date.now() } = {}) {
  const result = {
    examined: 0,
    deleted: [],
    rotated: [],
    truncated: [],
    bytes_before: 0,
    bytes_after: 0,
    skipped: [],
  };
  const effective = normalizePolicy(policy);
  const timestamp = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();

  const roots = normalizeDirectories(directories, result.skipped);
  const records = [];
  for (const root of roots) {
    for (const record of collectLogFiles(root, result.skipped)) {
      records.push(record);
    }
  }
  result.examined = records.length;
  result.bytes_before = records.reduce((sum, record) => sum + record.size, 0);

  const isActive = (record) => timestamp - record.mtimeMs < effective.protectMs;

  // Exactly one newest record is pinned: "the latest log file is never deleted".
  // Ties are broken by path so the choice is deterministic across runs.
  let newest = null;
  for (const record of records) {
    if (
      newest === null
      || record.mtimeMs > newest.mtimeMs
      || (record.mtimeMs === newest.mtimeMs && record.path > newest.path)
    ) {
      newest = record;
    }
  }

  const deletable = (record) => !record.deleted && record !== newest && !isActive(record);
  const oldestFirst = (left, right) => left.mtimeMs - right.mtimeMs
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  /**
   * Unlink one record, reporting rather than throwing on failure (locked file,
   * permission denied, already gone).
   *
   * @param {{path: string, size: number, deleted: boolean}} record Record.
   * @returns {boolean} Whether it is gone now.
   */
  const removeRecord = (record) => {
    try {
      unlinkSync(record.path);
      record.deleted = true;
      result.deleted.push(record.path);
      return true;
    } catch (error) {
      result.skipped.push({ path: record.path, reason: `delete-failed: ${error.code ?? error.message}` });
      // A file that vanished between listing and unlinking is not a policy
      // failure; count it as gone so the byte accounting stays truthful.
      if (error.code === 'ENOENT') {
        record.deleted = true;
        return true;
      }
      return false;
    }
  };

  // 1) Anything older than maxAgeDays goes first: retention by age is the rule
  //    users actually understand ("keep a week").
  const expiredBefore = timestamp - effective.maxAgeDays * DAY_MS;
  for (const record of [...records].sort(oldestFirst)) {
    if (record.mtimeMs >= expiredBefore) {
      continue;
    }
    if (!deletable(record)) {
      continue;
    }
    removeRecord(record);
  }

  // 2) Trim the rest down to maxTotalBytes, oldest first. Active, newest and
  //    unremovable files are skipped; if nothing can be removed the tree stays
  //    over the limit and the reason is visible in `skipped`.
  let total = records.reduce((sum, record) => sum + (record.deleted ? 0 : record.size), 0);
  if (total > effective.maxTotalBytes) {
    for (const record of [...records].sort(oldestFirst)) {
      if (total <= effective.maxTotalBytes) {
        break;
      }
      if (!deletable(record)) {
        continue;
      }
      const before = record.size;
      if (removeRecord(record)) {
        total -= before;
      }
    }
  }

  // 3) Rotate — never truncate — a still-oversized file. Renaming preserves both
  //    bytes and mtime, and a writer holding the file open keeps writing to the
  //    same inode (on Windows the rename is refused, which lands in `skipped`
  //    and is the safe outcome).
  for (const record of records) {
    if (record.deleted || record.size <= effective.maxFileBytes || isActive(record)) {
      continue;
    }
    if (!isRotatableName(record.path)) {
      continue;
    }
    try {
      const to = nextRotationName(record.path);
      renameSync(record.path, to);
      result.rotated.push({ path: record.path, to, bytes: record.size });
      record.path = to;
      record.resolved = to;
    } catch (error) {
      result.skipped.push({ path: record.path, reason: `rotate-failed: ${error.code ?? error.message}` });
    }
  }

  result.bytes_after = records.reduce((sum, record) => {
    if (record.deleted) {
      return sum;
    }
    try {
      return sum + statSync(record.path).size;
    } catch {
      return sum;
    }
  }, 0);

  return result;
}
