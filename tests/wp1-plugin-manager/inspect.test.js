// author: PT-dove

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as publicSurface from '../../apps/plugin-manager/src/index.js';
import {
  digestOf,
  ERROR_CODES,
  inspectPluginDirectory,
  PLUGIN_MANAGER_CAPABILITIES,
  PluginCheckError,
  sha256Hex,
  toolFullName,
} from '../../apps/plugin-manager/src/index.js';
import { snapshotDirectory } from '../../packages/test-support/snapshot.js';

import {
  captureError,
  codesOf,
  createSandbox,
  ENTRY_PATH,
  ENTRY_SOURCE_OK,
  manifestFixture,
  writePluginPackage,
} from './helpers.js';

const SOURCE_DIRECTORY = fileURLToPath(new URL('../../apps/plugin-manager/src/', import.meta.url));

const TOOL = {
  name: 'notes',
  description: 'Summarize authorized DTO',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const FORBIDDEN_SOURCE_TOKENS = [
  'writeFile',
  'appendFile',
  'mkdirSync',
  'rmSync',
  'unlinkSync',
  'renameSync',
  'copyFileSync',
  'createWriteStream',
  'child_process',
  'worker_threads',
  'eval(',
  'new Function',
  'require(',
];

test('a compliant package is reported as ok with both digests, tool names and no side effects', () => {
  const sandbox = createSandbox();
  try {
    const manifest = manifestFixture({
      permissions: ['analysis.tool.register'],
      tools: [TOOL],
    });
    const directory = writePluginPackage(sandbox, 'pkg', { manifest });
    const result = inspectPluginDirectory(directory);

    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.ok, true);
    assert.equal(result.pluginId, manifest.id);
    assert.equal(result.version, manifest.version);
    assert.equal(result.api, 'aegis-extension-v1');
    assert.match(result.digests.manifestSha256, /^[0-9a-f]{64}$/);
    assert.match(result.digests.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.digests.manifestSha256, digestOf(manifest));
    assert.equal(result.entry.path, ENTRY_PATH);
    assert.equal(result.entry.sha256, sha256Hex(ENTRY_SOURCE_OK));
    assert.equal(result.entry.bytes, Buffer.byteLength(ENTRY_SOURCE_OK));

    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, 'notes');
    assert.equal(result.tools[0].fullName, `plugin.${manifest.id}.notes`);
    assert.equal(result.tools[0].fullName, toolFullName(manifest.id, 'notes'));

    assert.equal(result.sideEffects.writes, 0);
    assert.equal(result.sideEffects.executedPluginCode, false);
    assert.equal(result.sideEffects.staged, false);
    for (const [key, value] of Object.entries(result.sideEffects)) {
      assert.ok(value === false || value === 0, `sideEffects.${key} must be false or 0, got ${String(value)}`);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('inspecting the same directory twice yields identical digests and diagnostics', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg');
    const first = inspectPluginDirectory(directory);
    const second = inspectPluginDirectory(directory);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(first.digests, second.digests);
    assert.deepEqual(first.diagnostics, second.diagnostics);
    assert.equal(first.digests.packageSha256, second.digests.packageSha256);
  } finally {
    sandbox.cleanup();
  }
});

test('inspecting a valid package never modifies the package tree', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg');
    const before = snapshotDirectory(directory);
    const result = inspectPluginDirectory(directory);
    const after = snapshotDirectory(directory);

    assert.equal(result.ok, true);
    assert.deepEqual(after, before, 'no file may be created, changed or removed');
  } finally {
    sandbox.cleanup();
  }
});

test('rejected packages produce zero writes in the sandbox', () => {
  const sandbox = createSandbox();
  try {
    const unknownField = writePluginPackage(sandbox, 'bad-unknown-field', {
      manifest: manifestFixture({ ns: 'com.example.anomaly-notes' }),
    });
    const forbiddenImport = writePluginPackage(sandbox, 'bad-forbidden-import', {
      entrySource: "import 'node:fs';\nexport function apply() {}\n",
    });
    const engineMismatch = writePluginPackage(sandbox, 'bad-engine', {
      manifest: manifestFixture({ engine: { dsh: '0.2.1' } }),
    });

    const before = snapshotDirectory(sandbox.root);

    const unknownResult = inspectPluginDirectory(unknownField);
    const importResult = inspectPluginDirectory(forbiddenImport);
    const engineResult = inspectPluginDirectory(engineMismatch);

    const after = snapshotDirectory(sandbox.root);

    assert.equal(unknownResult.ok, false);
    assert.ok(codesOf(unknownResult.diagnostics).includes(ERROR_CODES.UNKNOWN_FIELD));
    assert.equal(importResult.ok, false);
    assert.ok(codesOf(importResult.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API));
    assert.equal(engineResult.ok, false);
    assert.ok(codesOf(engineResult.diagnostics).includes(ERROR_CODES.ENGINE_MISMATCH));

    assert.deepEqual(
      after,
      before,
      'a rejected package must not create, change or delete a single filesystem entry',
    );
    assert.equal(after.entries.length, before.entries.length);
  } finally {
    sandbox.cleanup();
  }
});

test('plugin code is never executed during inspection', () => {
  const sandbox = createSandbox();
  const sentinel = sandbox.resolve('sentinel.txt');
  const previousSentinel = process.env.AEGIS_WP1_SENTINEL;
  process.env.AEGIS_WP1_SENTINEL = sentinel;

  try {
    const manifest = manifestFixture();
    delete manifest.entry; // guarantees the package is rejected even before scanning

    const directory = writePluginPackage(sandbox, 'pkg', {
      manifest,
      entrySource: [
        "import { createRequire } from 'node:module';",
        'const loader = createRequire(import.meta.url);',
        "loader('node:fs').writeFileSync(process.env.AEGIS_WP1_SENTINEL, 'executed');",
        'export function apply() {}',
        '',
      ].join('\n'),
    });

    const before = snapshotDirectory(sandbox.root);
    const result = inspectPluginDirectory(directory);
    const after = snapshotDirectory(sandbox.root);

    assert.equal(result.ok, false);
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.MISSING_FIELD),
      JSON.stringify(result.diagnostics),
    );
    assert.equal(existsSync(sentinel), false, 'the sentinel must never be created');
    assert.deepEqual(after, before, 'inspection must not add any file to the sandbox');
    assert.equal(result.sideEffects.executedPluginCode, false);
  } finally {
    if (previousSentinel === undefined) delete process.env.AEGIS_WP1_SENTINEL;
    else process.env.AEGIS_WP1_SENTINEL = previousSentinel;
    sandbox.cleanup();
  }
});

test('the package advertises and exposes no install, unpack or execute capability', () => {
  assert.deepEqual(
    { ...PLUGIN_MANAGER_CAPABILITIES },
    {
      installs: false,
      unpacksArchives: false,
      enablesPlugins: false,
      executesPluginCode: false,
      writesFiles: false,
      network: false,
    },
  );
  for (const key of ['installs', 'unpacksArchives', 'enablesPlugins', 'executesPluginCode', 'writesFiles']) {
    assert.equal(PLUGIN_MANAGER_CAPABILITIES[key], false, `${key} must be false`);
  }

  const exportedNames = Object.keys(publicSurface);
  for (const forbidden of ['install', 'enable', 'remove', 'unpack', 'execute', 'write', 'stage']) {
    const offenders = exportedNames.filter((name) => {
      const lower = name.toLowerCase();
      if (forbidden === 'write') return lower.includes('write') && !lower.includes('writes');
      if (forbidden === 'stage') return lower.includes('stage');
      return lower.includes(forbidden);
    });
    assert.deepEqual(offenders, [], `no export may suggest ${forbidden}: ${offenders.join(', ')}`);
  }
  assert.equal(typeof publicSurface.inspectPluginDirectory, 'function');
  assert.equal(typeof publicSurface.validateOverlay, 'function');
  assert.equal(publicSurface.install, undefined);
  assert.equal(publicSurface.enable, undefined);
  assert.equal(publicSurface.remove, undefined);
});

test('the checker source contains no write, spawn or eval primitive', () => {
  const files = readdirSync(SOURCE_DIRECTORY).filter((name) => name.endsWith('.js')).sort();

  assert.ok(files.includes('index.js'), 'index.js must be present');
  assert.ok(files.includes('inspect.js'), 'inspect.js must be present');
  assert.ok(files.length >= 10, `expected the full source set, found ${files.join(', ')}`);

  for (const file of files) {
    const text = readFileSync(join(SOURCE_DIRECTORY, file), 'utf8');
    for (const token of FORBIDDEN_SOURCE_TOKENS) {
      assert.equal(
        text.includes(token),
        false,
        `${file} must not contain ${JSON.stringify(token)}`,
      );
    }
  }
});

test('inspect.js imports only read-only node:fs functions', () => {
  const text = readFileSync(join(SOURCE_DIRECTORY, 'inspect.js'), 'utf8');
  const matches = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/g)];

  assert.equal(matches.length, 1, 'inspect.js must have exactly one node:fs import statement');
  const imported = matches[0][1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .sort();

  assert.deepEqual(imported, ['lstatSync', 'readFileSync', 'readdirSync', 'realpathSync']);
  for (const name of imported) {
    assert.equal(
      /^(read|lstat|stat|access|exists|realpath|opendir|readdir)/.test(name),
      true,
      `${name} must be a read-only filesystem API`,
    );
  }
  assert.equal(/from\s*'node:fs'\s*;/.test(text), true);
  assert.equal(/import\s+\w+\s+from\s*'node:fs'/.test(text), false, 'no default node:fs import');
  assert.equal(/import\s+\*\s+as/.test(text), false, 'no namespace node:fs import');
});

test('invalid arguments are refused before anything is touched', () => {
  const sandbox = createSandbox();
  try {
    const filePath = sandbox.write('not-a-directory.txt', 'text');
    const before = snapshotDirectory(sandbox.root);

    const invalid = [
      ['non-string', 42, ERROR_CODES.INVALID_ARGUMENT],
      ['null', null, ERROR_CODES.INVALID_ARGUMENT],
      ['undefined', undefined, ERROR_CODES.INVALID_ARGUMENT],
      ['empty string', '', ERROR_CODES.INVALID_ARGUMENT],
      ['missing path', sandbox.resolve('does-not-exist'), ERROR_CODES.IO_ERROR],
    ];

    for (const [label, argument, expectedCode] of invalid) {
      const error = captureError(() => inspectPluginDirectory(argument));
      assert.ok(error !== null, `${label}: expected a PluginCheckError`);
      assert.ok(error instanceof PluginCheckError, `${label}: expected PluginCheckError, got ${error?.name}`);
      assert.equal(error.code, expectedCode, `${label}: expected ${expectedCode}, got ${error.code}`);
    }

    const fileError = captureError(() => inspectPluginDirectory(filePath));
    assert.ok(fileError instanceof PluginCheckError);
    assert.equal(fileError.code, ERROR_CODES.INVALID_ARGUMENT);

    const after = snapshotDirectory(sandbox.root);
    assert.deepEqual(after, before, 'argument errors must not create any file');
  } finally {
    sandbox.cleanup();
  }
});
