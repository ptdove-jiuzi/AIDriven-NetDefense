/**
 * Error taxonomy for the Linux user-space collector.
 *
 * Why a separate class instead of `CollectorError` from `common`: that constructor only
 * accepts the shared, platform-neutral code set (see `common/errors.js`); a Linux-specific
 * failure such as `EXECUTABLE_NOT_ALLOWED` or `OUTPUT_TRUNCATED` is not part of it, and
 * silently reusing `INVALID_ARGUMENT` for all of them would make degradation decisions
 * impossible to audit.
 *
 * Every thrown value in this package is a `LinuxCollectorError`, so callers can classify
 * without parsing messages. Filesystem outcomes are *not* thrown: they are returned as
 * values (`{ ok: false, code }`) because "the file is unreadable" is an expected result of
 * a non-root collector, not a programming error.
 */

export const LINUX_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_CONFIG: 'INVALID_CONFIG',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  EXECUTABLE_NOT_ALLOWED: 'EXECUTABLE_NOT_ALLOWED',
  ARGUMENT_NOT_ALLOWED: 'ARGUMENT_NOT_ALLOWED',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  COMMAND_FAILED: 'COMMAND_FAILED',
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  READ_FAILED: 'READ_FAILED',
  PARSE_FAILED: 'PARSE_FAILED',
});

const KNOWN_CODES = new Set(Object.values(LINUX_ERROR_CODES));

export class LinuxCollectorError extends Error {
  code;

  details;

  constructor(code, message, details = undefined) {
    if (!KNOWN_CODES.has(code)) {
      throw new TypeError(`Unknown Linux collector error code: ${String(code)}`);
    }
    super(message);
    this.name = 'LinuxCollectorError';
    this.code = code;
    this.details = details;
  }
}

export function isLinuxCollectorError(value) {
  return value instanceof LinuxCollectorError;
}

export function asLinuxCollectorError(error) {
  if (error instanceof LinuxCollectorError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LinuxCollectorError(LINUX_ERROR_CODES.READ_FAILED, message, {
    reason: error instanceof Error ? error.name : typeof error,
  });
}

/**
 * Normalize an ENOENT/EACCES/... string into the three outcomes the sources care about.
 *
 * The distinction matters for the "no permission must never look like an empty but healthy
 * read" rule: `permission_denied` degrades the source, `not_found` is often legitimate
 * (a distro without `/var/log/auth.log`, a `cron.d` directory that does not exist), and
 * `io_error` is reported with the original code so the operator sees the real errno.
 */
export const FS_OUTCOMES = Object.freeze(['ok', 'permission_denied', 'not_found', 'not_directory', 'io_error']);

const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const NOT_FOUND_CODES = new Set(['ENOENT']);
const NOT_DIRECTORY_CODES = new Set(['ENOTDIR']);

export function isPermissionCode(code) {
  return typeof code === 'string' && PERMISSION_CODES.has(code);
}

export function classifyFsCode(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return 'not_found';
  }
  if (isPermissionCode(code)) {
    return 'permission_denied';
  }
  if (NOT_DIRECTORY_CODES.has(code)) {
    return 'not_directory';
  }
  if (NOT_FOUND_CODES.has(code)) {
    return 'not_found';
  }
  return 'io_error';
}

/**
 * A failed read is only "expected" when the path is genuinely absent or simply not
 * readable for this account. Anything else is a real I/O problem worth surfacing.
 */
export function isExpectedFsFailure(code) {
  const outcome = classifyFsCode(code);
  return outcome === 'not_found' || outcome === 'permission_denied' || outcome === 'not_directory';
}

export function assertNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a non-empty string`,
      { name, value: value === undefined ? null : String(value) },
    );
  }
  return value;
}

export function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a positive safe integer`,
      { name, value },
    );
  }
  return value;
}

export function assertNonNegativeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a non-negative safe integer`,
      { name, value },
    );
  }
  return value;
}

/**
 * Paths handled by this package are always absolute POSIX paths *inside* an injectable root
 * (the real `/`, or a temporary directory in tests, or nothing at all for a memory
 * filesystem). Rejecting `..` and backslashes keeps a configuration mistake from turning a
 * fixture root into an escape hatch.
 */
export function assertVirtualPath(name, value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a non-empty absolute POSIX path`,
      { name, value: value === undefined ? null : String(value) },
    );
  }
  if (!value.startsWith('/')) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be absolute: ${value}`,
      { name, value },
    );
  }
  if (value.includes('\0') || value.includes('\\')) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must not contain NUL or backslash: ${value}`,
      { name, value },
    );
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new LinuxCollectorError(
        LINUX_ERROR_CODES.PATH_ESCAPE,
        `${name} must not contain '..' segments: ${value}`,
        { name, value },
      );
    }
  }
  return value;
}
