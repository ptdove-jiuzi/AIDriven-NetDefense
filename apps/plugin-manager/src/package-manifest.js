// AegisHarness plugin manager — author: PT-dove
// Validation of the dsh style package.json side of a plugin package. The host only
// ever loads the fixed ESM entry through the fixed peer dependency, so every field
// that could install, build or execute something is rejected explicitly.

import { ERROR_CODES } from './errors.js';
import { COMPATIBILITY_PROFILE } from './profile.js';

export const PACKAGE_JSON_ALLOWED_FIELDS = Object.freeze([
  'name',
  'version',
  'description',
  'license',
  'author',
  'type',
  'main',
  'exports',
  'engines',
  'peerDependencies',
  'peerDependenciesMeta',
  'dependencies',
  'optionalDependencies',
  'files',
  'keywords',
  'repository',
  'homepage',
  'bugs',
  'sideEffects',
  'private',
]);

const ALLOWED_FIELDS = new Set(PACKAGE_JSON_ALLOWED_FIELDS);

const FORBIDDEN_FIELDS = new Map([
  ['scripts', 'installation and dependency scripts are not allowed in a plugin package'],
  ['bin', 'executable binaries are not allowed in a plugin package'],
  ['gypfile', 'native build descriptions are not allowed in a plugin package'],
  ['imports', 'internal import maps are not allowed in a plugin package'],
  ['workspaces', 'workspaces are not allowed in a plugin package'],
  ['bundledDependencies', 'bundled dependencies are not allowed in a plugin package'],
  ['bundleDependencies', 'bundled dependencies are not allowed in a plugin package'],
]);

// The package version must match the manifest version exactly, so prerelease and build
// metadata are accepted here as long as the numeric core has no leading zeroes.
const SEMVER_TRIPLE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates a parsed package.json and returns the fields the rest of the pipeline needs.
 * Content problems are reported as diagnostics; nothing is thrown.
 * @param {unknown} raw
 * @param {{diagnostics: {add: Function}}} options
 * @returns {{name: string|null, version: string|null, type: string|null, main: string|null, exportsDefault: string|null, cordisPeer: string|null, dependencies: Record<string, string>|null}}
 */
export function validatePackageJson(raw, options = {}) {
  const { diagnostics } = options;
  const report = (code, path, message) => diagnostics.add(code, path, message);

  const result = {
    name: null,
    version: null,
    type: null,
    main: null,
    exportsDefault: null,
    cordisPeer: null,
    dependencies: null,
  };

  if (!isPlainObject(raw)) {
    report(ERROR_CODES.SCHEMA_VIOLATION, '', 'package.json must be a JSON object');
    return result;
  }

  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      report(ERROR_CODES.INVALID_VALUE, `/${key}`, FORBIDDEN_FIELDS.get(key));
      continue;
    }
    if (!ALLOWED_FIELDS.has(key)) {
      report(ERROR_CODES.UNKNOWN_FIELD, `/${key}`, `unknown package.json field "${key}"`);
    }
  }

  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    report(ERROR_CODES.INVALID_VALUE, '/name', 'package.json "name" must be a non-empty string');
  } else if (!NPM_NAME.test(raw.name) || raw.name.length > 214) {
    report(ERROR_CODES.INVALID_VALUE, '/name', 'package.json "name" must be a valid npm package name');
  } else {
    result.name = raw.name;
  }

  if (typeof raw.version !== 'string' || !SEMVER_TRIPLE.test(raw.version)) {
    report(
      ERROR_CODES.INVALID_VALUE,
      '/version',
      'package.json "version" must be a strict semver triple such as "1.0.0"',
    );
  } else {
    result.version = raw.version;
  }

  if (raw.type !== COMPATIBILITY_PROFILE.moduleType) {
    report(
      ERROR_CODES.MODULE_TYPE_INVALID,
      '/type',
      `package.json "type" must be "${COMPATIBILITY_PROFILE.moduleType}" (ESM only)`,
    );
  } else {
    result.type = raw.type;
  }

  if (typeof raw.main !== 'string' || raw.main !== COMPATIBILITY_PROFILE.entry) {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/main',
      `package.json "main" must be exactly "${COMPATIBILITY_PROFILE.entry}"`,
    );
  } else {
    result.main = raw.main;
  }

  validateExports(raw, report, result);
  validatePeerDependencies(raw, report, result);
  validateDependencies(raw, report, result);

  if ('optionalDependencies' in raw) {
    if (!isPlainObject(raw.optionalDependencies) || Object.keys(raw.optionalDependencies).length > 0) {
      report(
        ERROR_CODES.INVALID_VALUE,
        '/optionalDependencies',
        'optionalDependencies must be absent or an empty object; the runtime never resolves new packages',
      );
    }
  }

  if ('peerDependenciesMeta' in raw) {
    if (!isPlainObject(raw.peerDependenciesMeta) || Object.keys(raw.peerDependenciesMeta).length > 0) {
      report(
        ERROR_CODES.INVALID_VALUE,
        '/peerDependenciesMeta',
        'peerDependenciesMeta must be absent or empty; the Cordis peer may not be marked optional',
      );
    }
  }

  if ('engines' in raw) {
    if (!isPlainObject(raw.engines)) {
      report(ERROR_CODES.INVALID_VALUE, '/engines', 'engines must be an object');
    } else {
      const keys = Object.keys(raw.engines);
      if (keys.length !== 1 || keys[0] !== 'node') {
        report(
          ERROR_CODES.INVALID_VALUE,
          '/engines',
          'engines must declare exactly one key: "node"',
        );
      } else if (raw.engines.node !== COMPATIBILITY_PROFILE.nodeEngine) {
        report(
          ERROR_CODES.INVALID_VALUE,
          '/engines/node',
          `engines.node must be exactly "${COMPATIBILITY_PROFILE.nodeEngine}"`,
        );
      }
    }
  }

  return result;
}

function validateExports(raw, report, result) {
  if (!('exports' in raw)) {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/exports',
      'package.json must declare exports with the single key "." and the single condition "default"',
    );
    return;
  }
  const exportsField = raw.exports;
  if (!isPlainObject(exportsField)) {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/exports',
      'package.json "exports" must be an object with the single key "." (string shorthand is not allowed)',
    );
    return;
  }
  const keys = Object.keys(exportsField);
  if (keys.length !== 1 || keys[0] !== '.') {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/exports',
      `package.json "exports" may only contain the root key "."; found: ${keys.join(', ') || '(none)'}`,
    );
    return;
  }
  const rootEntry = exportsField['.'];
  if (!isPlainObject(rootEntry)) {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/exports/.',
      'exports["."] must be an object with the single condition "default"',
    );
    return;
  }
  const conditions = Object.keys(rootEntry);
  if (conditions.length !== 1 || conditions[0] !== 'default') {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/exports/.',
      `exports["."] may only declare the condition "default"; found: ${conditions.join(', ') || '(none)'}`,
    );
    return;
  }
  const expected = `./${COMPATIBILITY_PROFILE.entry}`;
  if (rootEntry.default !== expected) {
    report(
      ERROR_CODES.ENTRY_MISMATCH,
      '/exports/./default',
      `exports["."].default must be exactly "${expected}"`,
    );
    return;
  }
  result.exportsDefault = rootEntry.default;
}

function validatePeerDependencies(raw, report, result) {
  const peer = raw.peerDependencies;
  if (!isPlainObject(peer)) {
    report(
      ERROR_CODES.CORDIS_MISMATCH,
      '/peerDependencies',
      `peerDependencies must declare exactly "${COMPATIBILITY_PROFILE.cordisPackage}": "${COMPATIBILITY_PROFILE.cordis}"`,
    );
    return;
  }
  const keys = Object.keys(peer);
  if (keys.length !== 1 || keys[0] !== COMPATIBILITY_PROFILE.cordisPackage) {
    report(
      ERROR_CODES.CORDIS_MISMATCH,
      '/peerDependencies',
      `peerDependencies may only declare "${COMPATIBILITY_PROFILE.cordisPackage}" as its single key`,
    );
    return;
  }
  if (peer[COMPATIBILITY_PROFILE.cordisPackage] !== COMPATIBILITY_PROFILE.cordis) {
    report(
      ERROR_CODES.CORDIS_MISMATCH,
      `/peerDependencies/${COMPATIBILITY_PROFILE.cordisPackage}`,
      `peer dependency version must be exactly "${COMPATIBILITY_PROFILE.cordis}"`,
    );
    return;
  }
  result.cordisPeer = peer[COMPATIBILITY_PROFILE.cordisPackage];
}

function validateDependencies(raw, report, result) {
  if (!('dependencies' in raw)) return;
  const deps = raw.dependencies;
  if (!isPlainObject(deps)) {
    report(ERROR_CODES.INVALID_VALUE, '/dependencies', 'dependencies must be an object');
    return;
  }
  const accepted = {};
  let ok = true;
  for (const [name, spec] of Object.entries(deps)) {
    if (name === COMPATIBILITY_PROFILE.cordisPackage) {
      report(
        ERROR_CODES.CORDIS_MISMATCH,
        `/dependencies/${name}`,
        `"${name}" must be declared in peerDependencies, never in dependencies`,
      );
      ok = false;
      continue;
    }
    if (!NPM_NAME.test(name) || name.length > 214) {
      report(
        ERROR_CODES.INVALID_VALUE,
        `/dependencies/${name}`,
        `dependency name "${name}" is not a valid npm package name`,
      );
      ok = false;
      continue;
    }
    if (typeof spec !== 'string' || !EXACT_VERSION.test(spec)) {
      report(
        ERROR_CODES.INVALID_VALUE,
        `/dependencies/${name}`,
        `dependency "${name}" must pin an exact version (no ranges, tags, file:, link:, git or url specs)`,
      );
      ok = false;
      continue;
    }
    accepted[name] = spec;
  }
  if (ok) result.dependencies = accepted;
}
