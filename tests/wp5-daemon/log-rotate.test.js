/**
 * log-rotate.test.js — retention of daemon log files.
 *
 * Acceptance criterion from OPS-DIAG (N-037 §4): with a 200 MB fake log tree,
 * after one retention pass the directory total must be <= 64 MiB and the newest
 * log must not be lost. The tree below is built with **real bytes** (not sparse
 * files) so the number `bytes_after` reports is also the number the OS reports
 * for the directory.
 *
 * Every temporary directory is created under the OS temp root and removed in
 * `after`; nothing outside it is ever touched.
 */

import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DEFAULT_LOG_POLICY, enforceLogRetention } from '../../apps/daemon/src/log-rotate.js';

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const LATEST_MARKER = 'MARKER-LATEST-LOG-STILL-HERE\n';

/**
 * Create a log file of exactly `size` bytes, optionally starting with a marker,
 * and set its mtime.
 *
 * @param {string} file Target path.
 * @param {number} size Byte size.
 * @param {{head?: string, mtimeMs?: number}} [options] Marker and timestamp.
 * @returns {number} Bytes written.
 */
function writeLog(file, size, options = {}) {
  const head = options.head ?? '';
  mkdirSync(path.dirname(file), { recursive: true });
  const headBytes = Buffer.from(head, 'utf8');
  const descriptor = openSync(file, 'w');
  let remaining = size - headBytes.length;
  try {
    if (headBytes.length > 0) {
      writeSync(descriptor, headBytes);
    }
    const chunk = Buffer.alloc(Math.min(MiB, Math.max(1, remaining)), 0x78);
    while (remaining > 0) {
      const length = Math.min(chunk.length, remaining);
      writeSync(descriptor, chunk, 0, length);
      remaining -= length;
    }
  } finally {
    closeSync(descriptor);
  }
  const stamp = options.mtimeMs === undefined ? new Date() : new Date(options.mtimeMs);
  if (options.mtimeMs !== undefined) {
    utimesSync(file, stamp, stamp);
  }
  return statSync(file).size;
}

/**
 * Total bytes of every regular file under `directory` (what the OS reports).
 *
 * @param {string} directory Root.
 * @returns {number} Byte total.
 */
function totalBytesOnDisk(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += totalBytesOnDisk(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

function tempRoot(name) {
  return mkdtempSync(path.join(tmpdir(), `aidn-${name}-`));
}

describe('DEFAULT_LOG_POLICY', () => {
  it('is frozen and carries the two-end shared thresholds', () => {
    assert.ok(Object.isFrozen(DEFAULT_LOG_POLICY));
    assert.deepEqual({ ...DEFAULT_LOG_POLICY }, {
      maxFileBytes: 8 * MiB,
      maxTotalBytes: 64 * MiB,
      maxAgeDays: 7,
      protectMs: 60 * 60 * 1000,
    });
  });
});

describe('enforceLogRetention — 200 MB tree', () => {
  const base = tempRoot('log-rotate-200m');
  const root = path.join(base, 'logs');
  const nested = path.join(root, 'nested');
  const now = Date.now();
  const expired = [path.join(root, 'app-expired.log'), path.join(nested, 'app-expired-2.stderr.log')];
  const oldFiles = [1, 2, 3, 4, 5].map((index) => path.join(root, `app-old-${index}.log`));
  const tiny = [1, 2, 3, 4].map((index) => path.join(root, `tiny-recent-${index}.log`));
  const latest = path.join(root, 'desktop-20261105.log');
  let injected = 0;
  let first;
  let second;

  before(() => {
    injected += writeLog(expired[0], 40 * MiB, { head: 'EXPIRED-1\n', mtimeMs: now - 10 * DAY_MS });
    injected += writeLog(expired[1], 10 * MiB, { head: 'EXPIRED-2\n', mtimeMs: now - 8 * DAY_MS });
    // Distinct mtimes so "oldest first" is deterministic: app-old-1 is the oldest.
    oldFiles.forEach((file, index) => {
      injected += writeLog(file, 30 * MiB, { mtimeMs: now - 2 * DAY_MS - (oldFiles.length - index) * 60_000 });
    });
    tiny.forEach((file, index) => {
      injected += writeLog(file, 1024, { head: `TINY-${index}\n`, mtimeMs: now - (index + 1) * 60_000 });
    });
    injected += writeLog(latest, 2 * MiB, { head: LATEST_MARKER, mtimeMs: now });

    first = enforceLogRetention({ directories: [root], nowMs: now });
    second = enforceLogRetention({ directories: [root], nowMs: now });
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('injects more than 200 MB of real log bytes', () => {
    assert.ok(injected > 200 * MiB, `injected=${injected}`);
    assert.equal(first.bytes_before, injected);
    assert.equal(first.examined, 12);
  });

  it('brings the directory total down to the 64 MiB cap', () => {
    assert.ok(first.bytes_after <= DEFAULT_LOG_POLICY.maxTotalBytes, `bytes_after=${first.bytes_after}`);
    const onDisk = totalBytesOnDisk(root);
    assert.equal(onDisk, first.bytes_after, 'reported bytes_after must equal what the OS reports');
    assert.ok(onDisk <= DEFAULT_LOG_POLICY.maxTotalBytes, `onDisk=${onDisk}`);
  });

  it('removes files older than the 7 day window', () => {
    for (const file of expired) {
      assert.equal(existsSync(file), false, `${path.basename(file)} should have been expired`);
      assert.equal(first.deleted.includes(file), true);
    }
  });

  it('trims the oldest files first and keeps the newest log intact', () => {
    assert.equal(first.deleted.length, 5, 'two expired files plus three oldest 30 MB files');
    for (const file of oldFiles.slice(0, 3)) {
      assert.equal(existsSync(file), false, `${path.basename(file)} is the oldest and must go first`);
    }
    for (const file of oldFiles.slice(3)) {
      assert.equal(existsSync(`${file}.1`), true, `${path.basename(file)} should be rotated, not deleted`);
    }
    assert.equal(existsSync(latest), true, 'the newest log file must never be deleted');
    assert.equal(readFileSync(latest).subarray(0, LATEST_MARKER.length).toString('utf8'), LATEST_MARKER);
  });

  it('rotates oversized stale files without changing their bytes', () => {
    assert.equal(first.rotated.length, 2);
    for (const entry of first.rotated) {
      assert.equal(entry.bytes, 30 * MiB);
      assert.equal(existsSync(entry.path), false);
      assert.equal(statSync(entry.to).size, 30 * MiB);
    }
  });

  it('never touches a file modified inside the protection window', () => {
    for (const file of tiny) {
      assert.equal(existsSync(file), true, `${path.basename(file)} is active (mtime < 1h) and must survive`);
      assert.equal(existsSync(`${file}.1`), false, 'an active file must not be renamed either');
      assert.equal(readFileSync(file, 'utf8').startsWith('TINY-'), true);
    }
  });

  it('is idempotent: a second pass deletes and rotates nothing', () => {
    assert.deepEqual(second.deleted, []);
    assert.deepEqual(second.rotated, []);
    assert.equal(second.bytes_after, first.bytes_after);
    assert.equal(second.bytes_before, first.bytes_after);
    assert.equal(totalBytesOnDisk(root), first.bytes_after);
  });
});

describe('enforceLogRetention — safety rules', () => {
  const base = tempRoot('log-rotate-safe');
  const now = Date.now();

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('never rotates a freshly modified oversized file', () => {
    const root = path.join(base, 'protected');
    const file = path.join(root, 'active-big.log');
    writeLog(file, 20 * MiB, { head: 'ACTIVE\n', mtimeMs: now });
    const result = enforceLogRetention({ directories: [root], nowMs: now });
    assert.deepEqual(result.rotated, []);
    assert.deepEqual(result.deleted, []);
    assert.equal(result.bytes_after, 20 * MiB);
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.1`), false);
  });

  it('leaves an over-limit tree alone when every file is active', () => {
    const root = path.join(base, 'all-active');
    writeLog(path.join(root, 'a.log'), 40 * MiB, { mtimeMs: now - 60_000 });
    writeLog(path.join(root, 'b.log'), 40 * MiB, { mtimeMs: now - 120_000 });
    const result = enforceLogRetention({ directories: [root], nowMs: now });
    assert.deepEqual(result.deleted, []);
    assert.equal(result.bytes_after, 80 * MiB, 'no active file may be sacrificed to the cap');
  });

  it('never deletes the newest file even when every file is expired', () => {
    const root = path.join(base, 'all-expired');
    const older = path.join(root, 'older.log');
    const newest = path.join(root, 'newest.log');
    writeLog(older, 100 * 1024, { mtimeMs: now - 9 * DAY_MS - 3600_000 });
    writeLog(newest, 100 * 1024, { mtimeMs: now - 9 * DAY_MS });
    const result = enforceLogRetention({ directories: [root], nowMs: now });
    assert.deepEqual(result.deleted, [older]);
    assert.equal(existsSync(newest), true);
    assert.equal(result.bytes_after, 100 * 1024);
  });

  it('does not follow a symlink out of the directory', () => {
    const root = path.join(base, 'symlink-root');
    mkdirSync(root, { recursive: true });
    const outside = path.join(base, 'outside.log');
    writeLog(outside, 2 * MiB, { head: 'OUTSIDE\n', mtimeMs: now - 10 * DAY_MS });
    let linked = false;
    try {
      symlinkSync(outside, path.join(root, 'link.log'), 'file');
      linked = true;
    } catch {
      // Windows 未开启开发者模式时普通用户建不了符号链接；此时仍要求
      // 目标文件不被删除（遍历本身不跟随）。
    }
    const result = enforceLogRetention({ directories: [root], nowMs: now });
    assert.equal(existsSync(outside), true, 'a file outside the directory must never be deleted');
    if (linked) {
      assert.equal(result.skipped.some((entry) => entry.reason === 'symlink-not-followed'), true);
      assert.equal(result.examined, 0);
    }
  });

  it('reports unusable directories instead of throwing', () => {
    const result = enforceLogRetention({
      directories: [path.join(base, 'does-not-exist'), ''],
      nowMs: now,
    });
    assert.equal(result.examined, 0);
    assert.equal(result.bytes_before, 0);
    assert.equal(result.bytes_after, 0);
    assert.ok(result.skipped.length >= 2);
    assert.equal(result.skipped.some((entry) => entry.reason.startsWith('directory-unavailable')), true);
    assert.equal(result.skipped.some((entry) => entry.reason === 'invalid-directory'), true);
  });

  it('falls back to the documented defaults for nonsense policy values', () => {
    const root = path.join(base, 'bad-policy');
    const file = path.join(root, 'stale-big.log');
    writeLog(file, 10 * MiB, { mtimeMs: now - 2 * 60 * 60 * 1000 });
    const result = enforceLogRetention({
      directories: [root],
      nowMs: now,
      policy: { maxFileBytes: 0, maxTotalBytes: -1, maxAgeDays: Number.NaN, protectMs: Number.POSITIVE_INFINITY },
    });
    assert.deepEqual(result.rotated.map((entry) => entry.to), [`${file}.1`]);
    assert.equal(existsSync(`${file}.1`), true);
  });

  it('accepts a single directory string and no arguments at all', () => {
    const root = path.join(base, 'single-string');
    writeLog(path.join(root, 'one.log'), 1024, { mtimeMs: now });
    const result = enforceLogRetention({ directories: root, nowMs: now });
    assert.equal(result.examined, 1);
    const empty = enforceLogRetention();
    assert.equal(empty.examined, 0);
    assert.deepEqual(empty.deleted, []);
  });
});
