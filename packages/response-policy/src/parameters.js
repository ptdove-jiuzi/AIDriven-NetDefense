/**
 * parameters.js — closed, per-action parameter normalisation.
 *
 * Parameters are the part of a response request that most often becomes a shell
 * string, a path or a rule fragment. This module therefore refuses, by
 * construction, everything the catalog did not declare:
 *
 *   - an undeclared key (an attacker-added `command`, `args`, `sudo`, …);
 *   - a missing required key;
 *   - a non-scalar value, `null`, `NaN`, `Infinity`, `-0` tricks, numeric strings;
 *   - an out-of-range integer or an out-of-enum string;
 *   - a path with traversal, a device namespace, an ADS, a non-NFC spelling;
 *   - any string carrying shell metacharacters — nothing here is ever handed to
 *     a shell, so metacharacters are evidence of an attempt, not data;
 *   - oversized input: >16 keys, >1024 bytes per string, >4096 canonical bytes.
 *
 * The result digest is what `ExecutionGrant.parameters_digest` must equal, so a
 * grant issued for `direction=outbound` cannot be replayed with `direction=both`.
 */

import { canonicalDigest, canonicalSize } from '@aegisharness/contracts';
import {
  DEFAULT_PARAMETER_ROOTS,
  MAX_PARAMETER_BYTES,
  MAX_PARAMETER_KEYS,
  MAX_PARAMETER_ROOTS,
  MAX_PARAMETER_STRING_BYTES,
} from './catalog.js';
import { policyFail } from './errors.js';
import { normalizeCanonicalPath, PARAMETER_PATH_CODES } from './paths.js';
import { REASON_CODES } from './reasons.js';

const SHELL_METACHARACTERS = /[;&|`$<>(){}\[\]*?~^!\n\r\t]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * @param {string} value Candidate text.
 * @param {string} path Dot path.
 */
function assertNoShellSyntax(value, path) {
  if (SHELL_METACHARACTERS.test(value)) {
    policyFail(
      REASON_CODES.DENY_PARAMETER_COMMAND_STRING,
      path,
      'parameter must not carry shell metacharacters; no parameter is ever executed',
    );
  }
  if (CONTROL_CHARACTERS.test(value)) {
    policyFail(REASON_CODES.DENY_PARAMETER_NONCANONICAL, path, 'parameter must not carry control characters');
  }
  if (value !== value.normalize('NFC')) {
    policyFail(REASON_CODES.DENY_PARAMETER_NONCANONICAL, path, 'parameter must be NFC-normalised');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PARAMETER_STRING_BYTES) {
    policyFail(REASON_CODES.DENY_PARAMETER_TOO_LARGE, path, 'string parameter is too large', {
      maxBytes: MAX_PARAMETER_STRING_BYTES,
    });
  }
}

/**
 * Resolve the allowed roots for a root-bound path parameter.
 *
 * @param {object} spec Catalog parameter spec (`root` names a root set).
 * @param {'linux' | 'windows'} os Target OS.
 * @param {unknown} policyRoots Caller override, `{ [rootName]: string[] }`.
 * @returns {readonly string[] | null} Canonical roots, or `null` when unbound.
 */
function resolveRoots(spec, os, policyRoots) {
  const key = spec.root;
  if (key === undefined) return null;
  const defaults = DEFAULT_PARAMETER_ROOTS[os]?.[key] ?? [];
  let source = defaults;
  if (policyRoots !== undefined && policyRoots !== null) {
    if (!isPlainObject(policyRoots)) {
      policyFail(REASON_CODES.DENY_INPUT_INVALID, '$.policyRoots', 'policyRoots must be a plain object');
    }
    const provided = policyRoots[key];
    if (provided !== undefined) {
      if (!Array.isArray(provided) || provided.length === 0 || provided.length > MAX_PARAMETER_ROOTS) {
        policyFail(
          REASON_CODES.DENY_INPUT_INVALID,
          `$.policyRoots.${key}`,
          `policyRoots.${key} must be 1..${MAX_PARAMETER_ROOTS} paths`,
        );
      }
      source = provided;
    }
  }
  return Object.freeze(source.map((root, index) => {
    const path = `$.policyRoots.${key}[${index}]`;
    try {
      return normalizeCanonicalPath(os, root, PARAMETER_PATH_CODES, path);
    } catch (error) {
      // 根的形态错误是"部署配置不合法"，不是"用户参数不合法"：统一折成
      // DENY_INPUT_INVALID，避免审计里把配置错误记成请求参数错误。
      policyFail(REASON_CODES.DENY_INPUT_INVALID, path, 'policyRoots entry is not a canonical absolute path', {
        cause: typeof error?.code === 'string' ? error.code : 'POLICY_ROOT_INVALID',
      });
    }
    return '';
  }));
}

/**
 * Require a canonical path to sit at or below one of the declared roots.
 *
 * Windows comparison folds case because NTFS does; POSIX does not, so a
 * case-different POSIX path really is a different directory.
 *
 * @param {string} value Canonical path.
 * @param {readonly string[]} roots Canonical roots.
 * @param {'linux' | 'windows'} os Target OS.
 * @param {string} path Dot path.
 */
function assertInsideRoot(value, roots, os, path) {
  const separator = os === 'windows' ? '\\' : '/';
  const fold = os === 'windows' ? (text) => text.toLowerCase() : (text) => text;
  const candidate = fold(value);
  for (const root of roots) {
    const folded = fold(root);
    const prefix = folded.endsWith(separator) ? folded : `${folded}${separator}`;
    if (candidate === folded || candidate.startsWith(prefix)) return;
  }
  policyFail(
    REASON_CODES.DENY_PARAMETER_OUTSIDE_ROOT,
    path,
    'path parameter must stay inside the declared root',
    { roots: [...roots] },
  );
}

/**
 * @param {object} spec Catalog parameter spec.
 * @param {unknown} value Raw value.
 * @param {string} path Dot path.
 * @param {'linux' | 'windows'} os Target OS, needed for path parameters.
 * @param {unknown} policyRoots Caller root override.
 * @returns {string | number | boolean} Normalised scalar.
 */
function normalizeValue(spec, value, path, os, policyRoots) {
  switch (spec.type) {
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        policyFail(REASON_CODES.DENY_PARAMETER_TYPE, path, 'parameter must be a safe integer');
      }
      if (value < spec.min || value > spec.max) {
        policyFail(REASON_CODES.DENY_PARAMETER_RANGE, path, 'integer parameter is out of range', {
          min: spec.min,
          max: spec.max,
        });
      }
      return value === 0 ? 0 : value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        policyFail(REASON_CODES.DENY_PARAMETER_TYPE, path, 'parameter must be a boolean');
      }
      return value;
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        policyFail(REASON_CODES.DENY_PARAMETER_ENUM, path, 'parameter must be one of the declared values', {
          values: [...spec.values],
        });
      }
      return value;
    }
    case 'path': {
      if (typeof value !== 'string') {
        policyFail(REASON_CODES.DENY_PARAMETER_TYPE, path, 'path parameter must be a string');
      }
      // Metacharacter scan first: a traversal attempt dressed as `$(...)` should be
      // reported as command syntax rather than silently folded into a path error.
      assertNoShellSyntax(value, path);
      const canonical = normalizeCanonicalPath(os, value, PARAMETER_PATH_CODES, path);
      const roots = resolveRoots(spec, os, policyRoots);
      if (roots !== null) assertInsideRoot(canonical, roots, os, path);
      return canonical;
    }
    case 'string': {
      if (typeof value !== 'string') {
        policyFail(REASON_CODES.DENY_PARAMETER_TYPE, path, 'string parameter must be a string');
      }
      assertNoShellSyntax(value, path);
      return value;
    }
    default: {
      // Unreachable for a verified catalog; kept fail-closed rather than assumed.
      policyFail(REASON_CODES.DENY_PARAMETER_TYPE, path, 'parameter spec type is not implemented', {
        type: spec.type,
      });
    }
  }
  return undefined;
}

/**
 * Normalise an action's parameters.
 *
 * @param {object} action Frozen catalog descriptor.
 * @param {unknown} raw Caller supplied parameters; `undefined` means "none given".
 * @param {{ os: 'linux' | 'windows', policyRoots?: unknown }} options Normalisation context.
 * @returns {{ value: Readonly<Record<string, string | number | boolean>>, digest: string }} Normalised
 *   parameters and their canonical digest.
 * @throws {import('./errors.js').PolicyError} On any undeclared or non-canonical shape.
 */
export function normalizeParameters(action, raw, options) {
  const os = options?.os;
  const policyRoots = options?.policyRoots;
  const spec = action.parameters;
  const specNames = Object.keys(spec);

  if (raw === undefined) {
    const normalized = {};
    for (const name of specNames) {
      if (spec[name].required === true) {
        policyFail(REASON_CODES.DENY_PARAMETER_MISSING, `$.parameters.${name}`, 'required parameter is missing', {
          name,
        });
      }
    }
    return Object.freeze({ value: Object.freeze(normalized), digest: canonicalDigest(normalized) });
  }
  if (!isPlainObject(raw)) {
    policyFail(REASON_CODES.DENY_PARAMETER_SHAPE, '$.parameters', 'parameters must be a plain object');
  }

  const names = Object.getOwnPropertyNames(raw);
  if (names.length > MAX_PARAMETER_KEYS) {
    policyFail(REASON_CODES.DENY_PARAMETER_TOO_LARGE, '$.parameters', 'too many parameters', {
      maxKeys: MAX_PARAMETER_KEYS,
    });
  }
  const symbols = Object.getOwnPropertySymbols(raw);
  if (symbols.length > 0) {
    policyFail(REASON_CODES.DENY_PARAMETER_SHAPE, '$.parameters', 'parameters must not carry symbol keys');
  }
  // 非有限数必须在 canonicalSize 之前拦下：canonicalize 遇到 NaN/Infinity 会抛
  // ERR_NUMBER_NOT_FINITE，若让它冒到外面，调用方拿到的就是"形状错误"而不是
  // "类型错误"，审计里看不出真正的意图。
  for (const name of names) {
    const value = raw[name];
    if (typeof value === 'number' && !Number.isFinite(value)) {
      policyFail(REASON_CODES.DENY_PARAMETER_TYPE, `$.parameters.${name}`, 'parameter must be a finite number');
    }
  }
  let size;
  try {
    size = canonicalSize(raw);
  } catch {
    policyFail(REASON_CODES.DENY_PARAMETER_SHAPE, '$.parameters', 'parameters must be canonicalisable');
  }
  if (size > MAX_PARAMETER_BYTES) {
    policyFail(REASON_CODES.DENY_PARAMETER_TOO_LARGE, '$.parameters', 'parameters are too large', {
      bytes: size,
      maxBytes: MAX_PARAMETER_BYTES,
    });
  }

  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(spec, name)) {
      policyFail(REASON_CODES.DENY_PARAMETER_UNKNOWN_FIELD, `$.parameters.${name}`, 'undeclared parameter', {
        name,
      });
    }
  }
  for (const name of specNames) {
    if (spec[name].required === true && !Object.prototype.hasOwnProperty.call(raw, name)) {
      policyFail(REASON_CODES.DENY_PARAMETER_MISSING, `$.parameters.${name}`, 'required parameter is missing', {
        name,
      });
    }
  }

  const normalized = {};
  for (const name of specNames) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    normalized[name] = normalizeValue(spec[name], raw[name], `$.parameters.${name}`, os, policyRoots);
  }
  return Object.freeze({ value: Object.freeze(normalized), digest: canonicalDigest(normalized) });
}

/**
 * Contract-independent digest helper used by tests and by callers that cache a
 * previously normalised parameter set.
 *
 * @param {Record<string, string | number | boolean>} value Normalised parameters.
 * @returns {string} Canonical digest.
 */
export function parametersDigest(value) {
  return canonicalDigest(value);
}
