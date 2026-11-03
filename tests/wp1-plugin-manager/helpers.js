// author: PT-dove
// Shared fixtures for the offline plugin-directory checker tests. Every fixture lives
// inside a freshly created temporary directory and is removed by its owner's cleanup().

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { createDiagnostics } from '../../apps/plugin-manager/src/index.js';

export const ENTRY_PATH = 'lib/index.js';
export const ENTRY_SOURCE_OK = 'export function apply() {}\n';

/**
 * Creates an isolated sandbox directly under the real temporary directory.
 * @returns {{root: string, resolve: Function, write: Function, mkdir: Function, cleanup: Function}}
 */
export function createSandbox() {
  const tempRoot = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(tempRoot, 'aegis-wp1-')));
  let cleaned = false;

  function absolute(relativePath) {
    return join(root, ...String(relativePath).split('/'));
  }

  return {
    root,
    resolve(...parts) {
      return join(root, ...parts);
    },
    absolute,
    write(relativePath, content) {
      const target = absolute(relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    mkdir(relativePath) {
      const target = absolute(relativePath);
      mkdirSync(target, { recursive: true });
      return target;
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      const pathFromTemp = relative(tempRoot, root);
      if (
        pathFromTemp === ''
        || pathFromTemp === '..'
        || pathFromTemp.startsWith(`..${sep}`)
        || isAbsolute(pathFromTemp)
      ) {
        throw new Error(`refusing to remove a sandbox outside the temporary directory: ${root}`);
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A minimal, fully compliant plugin.json.
 * @param {object} [overrides]
 * @returns {object}
 */
export function manifestFixture(overrides = {}) {
  return {
    schemaVersion: '1.0',
    id: 'com.example.anomaly-notes',
    name: 'Anomaly Notes',
    version: '1.0.0',
    api: 'aegis-extension-v1',
    engine: { dsh: '0.2.2-alpha.2' },
    entry: ENTRY_PATH,
    permissions: ['analysis.dto.read'],
    ...overrides,
  };
}

/**
 * A minimal, fully compliant package.json for the default manifest.
 * @param {object} [overrides]
 * @returns {object}
 */
export function packageFixture(overrides = {}) {
  return {
    name: 'com.example.anomaly-notes',
    version: '1.0.0',
    type: 'module',
    main: ENTRY_PATH,
    exports: { '.': { default: `./${ENTRY_PATH}` } },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.6-alpha.1' },
    ...overrides,
  };
}

/**
 * Writes a plugin package (package.json, plugin.json, entry module, extra modules).
 * @param {ReturnType<typeof createSandbox>} sandbox
 * @param {string} directory package directory inside the sandbox
 * @param {{manifest?: object, packageJson?: object|null, entrySource?: string|null, modules?: Record<string, string>}} [options]
 * @returns {string} absolute package directory
 */
export function writePluginPackage(sandbox, directory, options = {}) {
  const {
    manifest = manifestFixture(),
    packageJson = null,
    entrySource = ENTRY_SOURCE_OK,
    modules = {},
  } = options;
  const prefix = directory === '' ? '' : `${directory}/`;
  const pkg = packageJson ?? {
    name: manifest.id,
    version: manifest.version,
    type: 'module',
    main: ENTRY_PATH,
    exports: { '.': { default: `./${ENTRY_PATH}` } },
    peerDependencies: { '@deepseek-ai/cordis': '4.0.6-alpha.1' },
  };

  sandbox.write(`${prefix}package.json`, `${JSON.stringify(pkg, null, 2)}\n`);
  sandbox.write(`${prefix}plugin.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  if (entrySource !== null) sandbox.write(`${prefix}${ENTRY_PATH}`, entrySource);
  for (const [relativePath, content] of Object.entries(modules)) {
    sandbox.write(`${prefix}${relativePath}`, content);
  }
  return sandbox.resolve(directory);
}

/**
 * @param {unknown} value
 * @returns {Error|null}
 */
export function captureError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

/**
 * @param {ReadonlyArray<{code: string}>} diagnostics
 * @returns {string[]}
 */
export function codesOf(diagnostics) {
  return diagnostics.map((item) => item.code);
}

/**
 * @param {ReadonlyArray<{code: string}>} diagnostics
 * @param {string} code
 * @returns {boolean}
 */
export function hasCode(diagnostics, code) {
  return diagnostics.some((item) => item.code === code);
}

/**
 * Runs validatePluginJson with a fresh diagnostics sink.
 * @param {unknown} raw
 * @param {Function} validatePluginJson
 * @returns {{manifest: object|null, toolFullNames: string[], diagnostics: ReadonlyArray<object>, codes: string[]}}
 */
export function checkManifest(raw, validatePluginJson) {
  const diagnostics = createDiagnostics();
  const result = validatePluginJson(raw, { diagnostics });
  const listed = diagnostics.list();
  return {
    manifest: result.manifest,
    toolFullNames: result.toolFullNames,
    diagnostics: listed,
    codes: codesOf(listed),
  };
}
