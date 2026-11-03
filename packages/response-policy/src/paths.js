/**
 * paths.js — canonical path validation shared by targets and parameters.
 *
 * This module never touches the filesystem. It cannot, and must not, answer
 * "does this file exist" or "is this a symlink" — that is the platform adapter's
 * job, and design §10.2 requires the adapter to bind file identity through a
 * secure file/parent-directory handle. What this module does is refuse every
 * *lexical* shape that makes handle-based binding meaningless:
 *
 *   - traversal (`..`) in any separator spelling;
 *   - relative paths, which depend on an unstated working directory;
 *   - device and UNC namespaces (`\\?\`, `\\.\`, `\\server\share`), which bypass
 *     normal path resolution and therefore normal handles;
 *   - NTFS alternate data streams (`file.txt:secret`), a second object hiding
 *     behind one path;
 *   - reserved device basenames (`CON`, `NUL`, `COM1`, …);
 *   - non-NFC strings, control characters, percent-encoding and doubled or
 *     trailing separators — all of which have several spellings for one object.
 *
 * Rejection is expressed through a caller-supplied code table so that a bad
 * *target* and a bad *parameter* stay distinguishable in the final reason code.
 */

import { policyFail } from './errors.js';
import { REASON_CODES } from './reasons.js';

/** Hard ceiling for one canonical path, in UTF-8 bytes. Windows MAX_PATH is 260
 * for legacy APIs, but long-path aware handles accept far more; 4096 is the
 * POSIX PATH_MAX and a sane universal bound for a single object name. */
export const MAX_PATH_BYTES = 4096;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const DRIVE_ABSOLUTE = /^[A-Za-z]:\\/u;

/** Windows reserved basenames, compared case-insensitively and extension-free. */
const RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'conin$',
  'conout$',
  'clock$',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
  // Windows 也把上标数字视作设备名：COM¹ / LPT² 之类。
  ...['¹', '²', '³'].flatMap((digit) => [`com${digit}`, `lpt${digit}`]),
]);

/** Code table used when validating a target object's path. */
export const TARGET_PATH_CODES = Object.freeze({
  shape: REASON_CODES.DENY_TARGET_SHAPE,
  noncanonical: REASON_CODES.DENY_TARGET_NONCANONICAL,
  traversal: REASON_CODES.DENY_TARGET_TRAVERSAL,
  device: REASON_CODES.DENY_TARGET_DEVICE_PATH,
  ads: REASON_CODES.DENY_TARGET_ADS,
  reserved: REASON_CODES.DENY_TARGET_RESERVED_NAME,
  tooLarge: REASON_CODES.DENY_TARGET_TOO_LARGE,
});

/** Code table used when validating a parameter that names a path. */
export const PARAMETER_PATH_CODES = Object.freeze({
  shape: REASON_CODES.DENY_PARAMETER_TYPE,
  noncanonical: REASON_CODES.DENY_PARAMETER_NONCANONICAL,
  traversal: REASON_CODES.DENY_PARAMETER_PATH_TRAVERSAL,
  device: REASON_CODES.DENY_PARAMETER_DEVICE_PATH,
  ads: REASON_CODES.DENY_PARAMETER_ADS,
  reserved: REASON_CODES.DENY_PARAMETER_RESERVED_NAME,
  tooLarge: REASON_CODES.DENY_PARAMETER_TOO_LARGE,
});

function utf8Length(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Validate a Windows path and return its canonical spelling.
 *
 * @param {string} raw Input path.
 * @param {typeof TARGET_PATH_CODES} codes Reason codes to raise.
 * @param {string} path Dot path for error reporting.
 * @returns {string} Canonical path: upper-case drive letter, backslash separators.
 */
function canonicalWindowsPath(raw, codes, path) {
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    policyFail(codes.device, path, 'UNC and device paths cannot be bound to a normal file handle', {
      value: raw,
    });
  }
  if (raw.includes('/')) {
    policyFail(codes.noncanonical, path, 'Windows paths must use backslash separators', { value: raw });
  }
  if (!DRIVE_ABSOLUTE.test(raw)) {
    policyFail(codes.noncanonical, path, 'Target path must be absolute with a drive letter', { value: raw });
  }
  const drive = raw[0].toUpperCase();
  const rest = raw.slice(3);
  if (rest.length === 0) {
    policyFail(codes.noncanonical, path, 'A drive root is not a targetable object', { value: raw });
  }
  const segments = rest.split('\\');
  for (const segment of segments) {
    if (segment.length === 0) {
      policyFail(codes.noncanonical, path, 'Path must not contain empty segments', { value: raw });
    }
    if (segment === '.') {
      policyFail(codes.noncanonical, path, 'Path must not contain "." segments', { value: raw });
    }
    if (segment === '..') {
      policyFail(codes.traversal, path, 'Path must not contain ".." segments', { value: raw });
    }
    if (segment.includes(':')) {
      policyFail(codes.ads, path, 'Alternate data stream syntax is not a valid target', { value: raw });
    }
    if (segment.endsWith(' ') || segment.endsWith('.')) {
      policyFail(codes.noncanonical, path, 'Path segments must not end with a space or a dot', { value: raw });
    }
    const basename = segment.split('.')[0].toLowerCase();
    if (RESERVED_BASENAMES.has(basename)) {
      policyFail(codes.reserved, path, 'Reserved device basename cannot name a file object', {
        value: raw,
        segment,
      });
    }
  }
  return `${drive}:\\${segments.join('\\')}`;
}

/**
 * Validate a POSIX path and return its canonical spelling.
 *
 * @param {string} raw Input path.
 * @param {typeof TARGET_PATH_CODES} codes Reason codes to raise.
 * @param {string} path Dot path for error reporting.
 * @returns {string} The path unchanged; POSIX has exactly one canonical spelling.
 */
function canonicalPosixPath(raw, codes, path) {
  if (!raw.startsWith('/')) {
    policyFail(codes.noncanonical, path, 'POSIX target paths must be absolute', { value: raw });
  }
  if (raw.includes('\\')) {
    policyFail(codes.noncanonical, path, 'POSIX paths must not contain backslashes', { value: raw });
  }
  if (raw === '/') {
    policyFail(codes.noncanonical, path, 'The filesystem root is not a targetable object', { value: raw });
  }
  if (raw.endsWith('/')) {
    policyFail(codes.noncanonical, path, 'Path must not end with a separator', { value: raw });
  }
  const segments = raw.slice(1).split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      policyFail(codes.noncanonical, path, 'Path must not contain empty segments', { value: raw });
    }
    if (segment === '.') {
      policyFail(codes.noncanonical, path, 'Path must not contain "." segments', { value: raw });
    }
    if (segment === '..') {
      policyFail(codes.traversal, path, 'Path must not contain ".." segments', { value: raw });
    }
  }
  return raw;
}

/**
 * Normalise one path for a given OS family.
 *
 * @param {'linux' | 'windows'} os Target OS family.
 * @param {unknown} raw Candidate path.
 * @param {typeof TARGET_PATH_CODES} [codes] Reason codes to raise.
 * @param {string} [path] Dot path for error reporting.
 * @returns {string} Canonical path.
 * @throws {import('./errors.js').PolicyError} On any non-canonical shape.
 */
export function normalizeCanonicalPath(os, raw, codes = TARGET_PATH_CODES, path = '$.path') {
  if (typeof raw !== 'string') {
    policyFail(codes.shape, path, 'Path must be a string');
  }
  if (raw.length === 0) {
    policyFail(codes.noncanonical, path, 'Path must not be empty');
  }
  if (utf8Length(raw) > MAX_PATH_BYTES) {
    policyFail(codes.tooLarge, path, `Path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, {
      bytes: utf8Length(raw),
    });
  }
  if (raw !== raw.normalize('NFC')) {
    policyFail(codes.noncanonical, path, 'Path must be NFC-normalised', { value: raw });
  }
  if (CONTROL_CHARACTERS.test(raw)) {
    policyFail(codes.noncanonical, path, 'Path must not contain control characters', { value: raw });
  }
  if (raw.includes('%')) {
    policyFail(codes.noncanonical, path, 'Percent-encoding is not accepted in a canonical path', {
      value: raw,
    });
  }
  // 穿越必须优先于分隔符/形状检查：`C:\a/../b` 既是混合分隔符又是穿越，审计要看到的
  // 是"穿越"，而不是"拼写不合法"。行首的相对穿越（`..\x`、`../x`）同样算穿越。
  // 只认整段 `..`，`a..b` 这类文件名不受影响。
  if (/^(?:\.\.(?:[\\/]|$))|[\\/]\.\.(?:[\\/]|$)/u.test(raw)) {
    policyFail(codes.traversal, path, 'Path must not contain ".." segments', { value: raw });
  }
  return os === 'windows'
    ? canonicalWindowsPath(raw, codes, path)
    : canonicalPosixPath(raw, codes, path);
}
