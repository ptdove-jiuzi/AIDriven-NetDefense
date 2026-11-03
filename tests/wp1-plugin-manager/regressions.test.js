// author: PT-dove
// Regression tests that pin the three acceptance-phase fixes:
//   1. validateOverlay must forward `builtins` into the Effective Manifest (and its digest).
//   2. tokenize must reject bare backslashes so `\u0070rocess` cannot hide a global.
//   3. every read in inspect is gated by the walked "regular file" set, so a symlinked
//      directory can never pull module content from outside the package.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import test from 'node:test';

import {
  createDiagnostics,
  digestOf,
  deriveSecurityProjection,
  ERROR_CODES,
  inspectPluginDirectory,
  scanModuleSource,
  validateOverlay,
  validatePluginJson,
} from '../../apps/plugin-manager/src/index.js';
import { snapshotDirectory } from '../../packages/test-support/snapshot.js';

import {
  captureError,
  codesOf,
  createSandbox,
  ENTRY_SOURCE_OK,
  manifestFixture,
  writePluginPackage,
} from './helpers.js';

const BACKSLASH = '\\';

const MANIFEST = manifestFixture();

function approve(rawManifest, packageSha256 = 'b'.repeat(64)) {
  const diagnostics = createDiagnostics();
  const { manifest } = validatePluginJson(rawManifest, { diagnostics });
  assert.deepEqual(
    diagnostics.list(),
    [],
    `fixture manifest must be valid: ${JSON.stringify(diagnostics.list())}`,
  );
  // The approval record must be self consistent: manifestSha256 is the JCS digest of the
  // stored manifest, which is the only authority for the derived security projection.
  return { manifest, manifestSha256: digestOf(manifest), packageSha256 };
}

const APPROVAL = approve(MANIFEST);

function overlayEntry() {
  return {
    id: APPROVAL.manifest.id,
    version: APPROVAL.manifest.version,
    manifestSha256: APPROVAL.manifestSha256,
    packageSha256: APPROVAL.packageSha256,
    ...deriveSecurityProjection(APPROVAL.manifest),
  };
}

function runOverlay(builtins) {
  const diagnostics = createDiagnostics();
  const result = validateOverlay(
    { schemaVersion: '1.0', plugins: [overlayEntry()] },
    { approved: new Map([[MANIFEST.id, APPROVAL]]), builtins, diagnostics },
  );
  const listed = diagnostics.list();
  return { result, diagnostics: listed, codes: codesOf(listed) };
}

test('regression: overlay builtins are carried into the Effective Manifest', () => {
  const outcome = runOverlay(['core.alpha', 'aegis.beta']);

  assert.deepEqual(outcome.codes, [], JSON.stringify(outcome.diagnostics));
  assert.ok(outcome.result.document !== null, 'a valid overlay must still produce a document');
  assert.deepEqual(
    outcome.result.document.builtins,
    ['aegis.beta', 'core.alpha'],
    'builtins must reach the document, sorted by id',
  );
  assert.equal(outcome.result.result, undefined);
  assert.match(outcome.result.digest, /^[0-9a-f]{64}$/);
  assert.equal(outcome.result.digest, digestOf(outcome.result.document));
});

test('regression: builtins are part of the Effective Manifest digest', () => {
  const withBuiltins = runOverlay(['core.alpha', 'aegis.beta']);
  const withoutBuiltins = runOverlay([]);
  const reversed = runOverlay(['aegis.beta', 'core.alpha']);

  assert.deepEqual(withBuiltins.codes, []);
  assert.deepEqual(withoutBuiltins.codes, []);
  assert.deepEqual(withoutBuiltins.result.document.builtins, [], 'no builtins means an empty list');

  assert.notEqual(
    withBuiltins.result.digest,
    withoutBuiltins.result.digest,
    'dropping the built-in inventory must change the digest',
  );
  assert.notEqual(
    digestOf(withBuiltins.result.document),
    digestOf(withoutBuiltins.result.document),
    'the two documents must canonicalise differently',
  );
  assert.equal(
    withBuiltins.result.digest,
    reversed.result.digest,
    'builtins are sorted, so input order must not influence the digest',
  );
});

test('regression: object builtins are sorted by id and copied verbatim', () => {
  const builtins = [
    { id: 'core.alpha', layer: 1, version: '1.0.0' },
    { id: 'aegis.beta', layer: 2 },
  ];
  const outcome = runOverlay(builtins);

  assert.deepEqual(outcome.codes, []);
  assert.deepEqual(outcome.result.document.builtins, [
    { id: 'aegis.beta', layer: 2 },
    { id: 'core.alpha', layer: 1, version: '1.0.0' },
  ]);
  assert.notEqual(
    outcome.result.document.builtins[1],
    builtins[0],
    'builtin entries must be copied, not aliased',
  );
  assert.equal(outcome.result.digest, digestOf(outcome.result.document));
});

test('regression: escaped identifiers cannot smuggle a dangerous global past the scanner', () => {
  const sandbox = createSandbox();
  try {
    const entrySource = [
      `export function apply() { const p = ${BACKSLASH}u0070rocess; return p.env; }`,
      '',
    ].join('\n');
    assert.ok(entrySource.includes(`${BACKSLASH}u0070rocess`), 'the fixture must hold a literal backslash');

    const directory = writePluginPackage(sandbox, 'pkg', { entrySource });
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, false, 'an escaped identifier must be refused');
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.INVALID_VALUE),
      `expected INVALID_VALUE, received ${JSON.stringify(result.diagnostics)}`,
    );
    assert.ok(
      result.diagnostics.some((item) => /escaped identifier sequence/.test(item.message)),
      JSON.stringify(result.diagnostics),
    );
    assert.equal(result.modules.length, 1);
    assert.deepEqual(
      result.modules[0].imports,
      [],
      'tokenisation must abort before any import is recorded',
    );

    // The scanner must bail out completely instead of trusting a half tokenised module.
    const unitDiagnostics = createDiagnostics();
    const scan = scanModuleSource(entrySource, {
      file: 'lib/index.js',
      diagnostics: unitDiagnostics,
    });
    assert.deepEqual(codesOf(unitDiagnostics.list()), [ERROR_CODES.INVALID_VALUE]);
    assert.deepEqual(scan.exports, [], 'no export surface may be derived from a rejected source');
    assert.deepEqual(scan.imports, []);
    assert.deepEqual(scan.specifiers, []);
  } finally {
    sandbox.cleanup();
  }
});

test('regression: legitimate backslash escapes in strings, templates, regex and comments stay legal', () => {
  const sandbox = createSandbox();
  try {
    const entrySource = [
      "const path = 'lib\\\\index.js';",
      `const tpl = \`a${BACKSLASH}tb\`;`,
      'const re = /[\\d.]+/;',
      `// a lone ${BACKSLASH} inside a comment is harmless`,
      `/* ${BACKSLASH}u0070rocess is mentioned in a block comment */`,
      'export function apply() { return [path, tpl, re.source]; }',
      '',
    ].join('\n');

    const directory = writePluginPackage(sandbox, 'pkg', { entrySource });
    const result = inspectPluginDirectory(directory);

    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.ok, true);
    assert.equal(result.entry.path, 'lib/index.js');
    assert.equal(result.entry.bytes, Buffer.byteLength(entrySource));
  } finally {
    sandbox.cleanup();
  }
});

test('regression: the module graph cannot read through a symlinked directory', () => {
  const sandbox = createSandbox();
  try {
    const secretPath = sandbox.write('outside/secret.js', "export const secret = 'outside';\n");
    const secretBefore = readFileSync(secretPath, 'utf8');

    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: "import './ext/secret.js';\nexport function apply() {}\n",
    });
    symlinkSync(sandbox.resolve('outside'), sandbox.resolve('pkg', 'lib', 'ext'), 'junction');

    const beforeOutside = snapshotDirectory(sandbox.resolve('outside'));
    const result = inspectPluginDirectory(directory);
    const afterOutside = snapshotDirectory(sandbox.resolve('outside'));

    assert.equal(result.ok, false);
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.PACKAGE_SYMLINK),
      `expected PACKAGE_SYMLINK, received ${JSON.stringify(result.diagnostics)}`,
    );
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.ENTRY_MISSING),
      'the refused read must be reported, not silently skipped',
    );

    assert.deepEqual(
      result.modules.map((module) => module.path),
      ['lib/index.js'],
      'nothing behind the symlink may enter the module graph',
    );
    assert.ok(
      !result.modules.some((module) => module.path === 'lib/ext/secret.js'),
      'the outside secret module must never be read',
    );

    assert.deepEqual(afterOutside, beforeOutside, 'the outside directory must stay untouched');
    assert.equal(readFileSync(secretPath, 'utf8'), secretBefore, 'the outside file content must not change');
    assert.match(secretBefore, /export const secret = 'outside';/);
  } finally {
    sandbox.cleanup();
  }
});

test('regression: plugin code is lexically scanned but never executed', () => {
  const sandbox = createSandbox();
  const sentinel = sandbox.resolve('sentinel.txt');
  const previousSentinel = process.env.AEGIS_WP1_SENTINEL;
  process.env.AEGIS_WP1_SENTINEL = sentinel;

  try {
    const entrySource = [
      "import { createRequire } from 'node:module';",
      'const loader = createRequire(import.meta.url);',
      "loader('node:fs').writeFileSync(process.env.AEGIS_WP1_SENTINEL, 'executed');",
      'export function apply() {}',
      '',
    ].join('\n');

    const directory = writePluginPackage(sandbox, 'pkg', {
      manifest: manifestFixture(),
      entrySource,
    });

    const before = snapshotDirectory(sandbox.root);
    const result = inspectPluginDirectory(directory);
    const after = snapshotDirectory(sandbox.root);

    assert.equal(result.ok, false, 'a package importing node:module must not be accepted');
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API),
      `expected UNSUPPORTED_API, received ${JSON.stringify(result.diagnostics)}`,
    );
    assert.ok(
      result.incompatibilities.some((item) => item.detail.includes('node:module')),
      'the module graph must have read and scanned the entry source',
    );
    assert.deepEqual(
      result.modules.map((module) => module.path),
      ['lib/index.js'],
      'the entry must actually be scanned, not short-circuited',
    );
    assert.equal(result.entry.bytes, Buffer.byteLength(entrySource));

    assert.equal(existsSync(sentinel), false, 'the sentinel must never be created');
    assert.deepEqual(after, before, 'inspection must not add, change or delete any file');
    assert.equal(result.sideEffects.executedPluginCode, false);
    assert.equal(result.sideEffects.writes, 0);

    const scanError = captureError(() => inspectPluginDirectory(42));
    assert.ok(scanError !== null && scanError.code === ERROR_CODES.INVALID_ARGUMENT);
    assert.equal(existsSync(sentinel), false);
  } finally {
    if (previousSentinel === undefined) delete process.env.AEGIS_WP1_SENTINEL;
    else process.env.AEGIS_WP1_SENTINEL = previousSentinel;
    sandbox.cleanup();
  }
});

test('regression: a normal package still reports the same digests', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', { entrySource: ENTRY_SOURCE_OK });
    const result = inspectPluginDirectory(directory);

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.ok, true);
    assert.equal(result.digests.manifestSha256, digestOf(manifestFixture()));
    assert.match(result.digests.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.modules.length, 1);
  } finally {
    sandbox.cleanup();
  }
});
