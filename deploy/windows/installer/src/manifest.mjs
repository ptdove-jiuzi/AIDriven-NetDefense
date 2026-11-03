/**
 * manifest.mjs — the payload hash manifest, and the only full verification.
 *
 * `manifests/files.sha256` is the single authoritative list (ADR-0009 §5.1). Its
 * format is fixed by the builder (`deploy/embedded-runtime/lib/stage.mjs`):
 *
 *     # comment
 *     <sha256>  <path relative to the bundle root, forward slashes>
 *
 * The manifest excludes the `manifests/` directory because it cannot contain its own
 * digest. Everything else must be listed, and **an unlisted file is as much a
 * failure as a wrong digest** — dropping a DLL into `app\` is exactly the kind of
 * change the hash list exists to catch, and "extra files are ignored" would let it
 * pass. Both cases end at exit code 12.
 */

import { join } from 'node:path';

import { listFiles, pathExists, sha256File, sha256Text } from './fsx.mjs';

const HEX = /^[0-9a-f]{64}$/iu;
const SKIP_DIRS = Object.freeze(['manifests']);

export class ManifestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ManifestError';
    this.details = details;
  }
}

/**
 * Parse manifest text.
 *
 * @param {string} text Raw contents of `files.sha256`.
 * @returns {{rows: {digest: string, path: string, line: number}[], text: string, digest: string}}
 */
export function parseManifest(text) {
  const rows = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const match = /^([0-9a-fA-F]{64}) {2}(.+)$/u.exec(trimmed);
    if (match === null) {
      throw new ManifestError(`files.sha256 第 ${lineNumber} 行格式非法（应为 "<sha256>  <path>"）`, { line: lineNumber });
    }
    const digest = match[1].toLowerCase();
    const path = match[2];
    if (!HEX.test(digest)) {
      throw new ManifestError(`files.sha256 第 ${lineNumber} 行摘要非法`, { line: lineNumber });
    }
    assertSafeRelativePath(path, lineNumber);
    if (path === 'manifests/files.sha256') {
      throw new ManifestError('清单不得包含自身（manifests/files.sha256 无法覆盖自己）', { line: lineNumber });
    }
    if (seen.has(path)) {
      throw new ManifestError(`files.sha256 第 ${lineNumber} 行路径重复：${path}`, { line: lineNumber, path });
    }
    seen.add(path);
    rows.push({ digest, path, line: lineNumber });
  });

  if (rows.length === 0) {
    throw new ManifestError('files.sha256 没有任何条目：空清单无法证明任何载荷');
  }
  return { rows, text, digest: sha256Text(text) };
}

/**
 * A manifest path must be relative, forward-slash, and must not climb out.
 * A payload that can name `../../Windows/System32/x.dll` is not a payload.
 */
export function assertSafeRelativePath(path, line = null) {
  const fail = (reason) => {
    throw new ManifestError(`清单路径非法（${reason}）：${path}`, { line, path });
  };
  if (path.trim() === '') fail('空');
  if (path.includes('\\')) fail('含反斜杠');
  if (path.startsWith('/')) fail('绝对路径');
  if (/^[A-Za-z]:/u.test(path)) fail('带盘符');
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) fail('含 ..');
  if (segments.some((segment) => segment === '' || segment === '.')) fail('含空段或 .');
  return true;
}

/**
 * Verify a tree against parsed rows.
 *
 * @param {{ root: string, rows: readonly {digest: string, path: string}[], skip?: readonly string[] }} input
 * @returns {Promise<{checked: number, missing: string[], mismatched: {path: string, expected: string, actual: string}[], extras: string[], ok: boolean}>}
 */
export async function verifyTree({ root, rows, skip = SKIP_DIRS }) {
  const missing = [];
  const mismatched = [];
  const present = new Set();

  for (const row of rows) {
    const absolute = join(root, row.path);
    let actual;
    try {
      actual = await sha256File(absolute);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        missing.push(row.path);
        continue;
      }
      throw error;
    }
    present.add(row.path);
    if (actual.toLowerCase() !== row.digest) {
      mismatched.push({ path: row.path, expected: row.digest, actual: actual.toLowerCase() });
    }
  }

  const onDisk = pathExists(root) ? listFiles(root, { skip }) : [];
  const extras = onDisk.filter((path) => !present.has(path));

  return {
    checked: rows.length,
    missing,
    mismatched,
    extras,
    ok: missing.length === 0 && mismatched.length === 0 && extras.length === 0,
  };
}

/** Compact one-line summary for the log; never prints thousands of paths. */
export function describeFailure(result, limit = 5) {
  const parts = [];
  if (result.missing.length > 0) parts.push(`缺失 ${result.missing.length}（例：${result.missing.slice(0, limit).join('、')}）`);
  if (result.mismatched.length > 0) {
    const sample = result.mismatched.slice(0, limit).map((entry) => entry.path).join('、');
    parts.push(`摘要不符 ${result.mismatched.length}（例：${sample}）`);
  }
  if (result.extras.length > 0) parts.push(`清单外多出 ${result.extras.length}（例：${result.extras.slice(0, limit).join('、')}）`);
  return parts.join('；');
}
