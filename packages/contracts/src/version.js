import { ContractError, ERROR_CODES } from './errors.js';

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(['1.0']);

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function splitSupported() {
  return SUPPORTED_SCHEMA_VERSIONS.map((raw) => {
    const [major, minor] = raw.split('.').map(Number);
    return { raw, major, minor };
  });
}

/** 严格解析 `major.minor`，拒绝 `1`、`1.0.0`、`v1.0`、`01.0`、`1.00` 与非字符串。 */
export function parseSchemaVersion(value, path = '$') {
  if (typeof value !== 'string') {
    throw new ContractError(ERROR_CODES.ERR_SCHEMA_VERSION_INVALID, path, 'schemaVersion must be a string');
  }
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    throw new ContractError(
      ERROR_CODES.ERR_SCHEMA_VERSION_INVALID,
      path,
      'schemaVersion must match major.minor without leading zeros',
    );
  }
  return Object.freeze({
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
  });
}

/**
 * 版本协商。安全边界（默认）要求版本与受支持版本完全相等；
 * 只有非安全边界才允许同 major 下向前兼容的 minor。
 */
export function negotiateSchemaVersion(value, options = {}) {
  const path = options.path ?? '$';
  const securityBoundary = options.securityBoundary !== false;
  const parsed = parseSchemaVersion(value, path);
  const supported = splitSupported();
  const majors = new Set(supported.map((entry) => entry.major));
  if (!majors.has(parsed.major)) {
    throw new ContractError(
      ERROR_CODES.ERR_SCHEMA_MAJOR_MISMATCH,
      path,
      `schemaVersion major ${parsed.major} is not supported`,
      { supported: SUPPORTED_SCHEMA_VERSIONS },
    );
  }
  const exact = supported.some((entry) => entry.raw === parsed.raw);
  if (securityBoundary) {
    if (!exact) {
      throw new ContractError(
        ERROR_CODES.ERR_SCHEMA_MINOR_UNSUPPORTED,
        path,
        `schemaVersion ${parsed.raw} is not an exact supported version on a security boundary`,
        { supported: SUPPORTED_SCHEMA_VERSIONS },
      );
    }
    return Object.freeze({ raw: parsed.raw, major: parsed.major, minor: parsed.minor, exact: true });
  }
  const sameMajor = supported.filter((entry) => entry.major === parsed.major);
  const highestMinor = Math.max(...sameMajor.map((entry) => entry.minor));
  if (parsed.minor < highestMinor) {
    throw new ContractError(
      ERROR_CODES.ERR_SCHEMA_MINOR_UNSUPPORTED,
      path,
      `schemaVersion ${parsed.raw} is older than the supported minor`,
      { supported: SUPPORTED_SCHEMA_VERSIONS },
    );
  }
  return Object.freeze({ raw: parsed.raw, major: parsed.major, minor: parsed.minor, exact });
}
