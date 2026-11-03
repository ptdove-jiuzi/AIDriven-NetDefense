// author: PT-dove

import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import test from 'node:test';

import {
  createDiagnostics,
  ERROR_CODES,
  inspectPluginDirectory,
  scanModuleSource,
} from '../../apps/plugin-manager/src/index.js';

import { codesOf, createSandbox, writePluginPackage } from './helpers.js';

const UNSUPPORTED_CASES = [
  {
    label: 'node:fs builtin',
    source: "import 'node:fs';\nexport function apply() {}\n",
    detail: 'node:fs',
  },
  {
    label: 'fs builtin without the node prefix',
    source: "import 'fs';\nexport function apply() {}\n",
    detail: 'fs',
  },
  {
    label: 'bare package specifier',
    source: "import _ from 'lodash';\nexport function apply() {}\n",
    detail: 'lodash',
  },
  {
    label: 'Cordis subpath',
    source: "import { Service } from '@deepseek-ai/cordis/sub';\nexport function apply() {}\n",
    detail: '@deepseek-ai/cordis/sub',
  },
  {
    label: 'remote URL dynamic import',
    source: "export async function apply() { await import('https://x/y.js'); }\n",
    detail: 'https://x/y.js',
  },
  {
    label: 'child_process builtin',
    source: "import 'node:child_process';\nexport function apply() {}\n",
    detail: 'node:child_process',
  },
];

for (const testCase of UNSUPPORTED_CASES) {
  test(`unsupported module source is rejected: ${testCase.label}`, () => {
    const sandbox = createSandbox();
    try {
      const directory = writePluginPackage(sandbox, 'pkg', { entrySource: testCase.source });
      const result = inspectPluginDirectory(directory);

      assert.equal(result.ok, false, `${testCase.label} must not be accepted`);
      assert.ok(
        result.diagnostics.some((item) => item.code === ERROR_CODES.UNSUPPORTED_API),
        `${testCase.label} must report UNSUPPORTED_API, received ${JSON.stringify(codesOf(result.diagnostics))}`,
      );
      const incompatible = result.incompatibilities.map((item) => item.detail).join('\n');
      assert.ok(
        incompatible.includes(testCase.detail),
        `incompatibilities must name the specifier ${testCase.detail}: ${incompatible}`,
      );
    } finally {
      sandbox.cleanup();
    }
  });
}

test('a non-literal dynamic import is rejected as unverifiable', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: 'export async function apply(name) { return import(name); }\n',
    });
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, false);
    assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API));
    assert.ok(
      result.incompatibilities.some((item) => /non literal specifier/.test(item.detail)),
      JSON.stringify(result.incompatibilities),
    );
  } finally {
    sandbox.cleanup();
  }
});

test('CommonJS require is rejected', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: "const fs = require('fs');\nexport function apply() {}\n",
    });
    const result = inspectPluginDirectory(directory);
    assert.equal(result.ok, false);
    assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API));
    assert.ok(result.incompatibilities.some((item) => /require/.test(item.detail)));
  } finally {
    sandbox.cleanup();
  }
});

test('the Cordis root entry and in-package relative modules are allowed', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: [
        "import { Service } from '@deepseek-ai/cordis';",
        "import { helper } from './deep/helper.js';",
        'export function apply() { return helper(); }',
        '',
      ].join('\n'),
      modules: {
        'lib/deep/helper.js': [
          "import { another } from '../another.js';",
          'export function helper() { return another(); }',
          '',
        ].join('\n'),
        'lib/another.js': 'export function another() { return 1; }\n',
      },
    });
    const result = inspectPluginDirectory(directory);

    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.ok, true);
    assert.deepEqual(result.modules.map((module) => module.path).sort(), [
      'lib/another.js',
      'lib/deep/helper.js',
      'lib/index.js',
    ]);
    assert.deepEqual(result.modules.find((module) => module.path === 'lib/index.js').imports, [
      'lib/deep/helper.js',
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test('an import that escapes the package root is rejected as ENTRY_ESCAPE', () => {
  const unitDiagnostics = createDiagnostics();
  scanModuleSource("import '../outside.js';\nexport function apply() {}\n", {
    file: 'index.js',
    diagnostics: unitDiagnostics,
  });
  assert.deepEqual(codesOf(unitDiagnostics.list()), [ERROR_CODES.ENTRY_ESCAPE]);

  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: "import '../../outside.js';\nexport function apply() {}\n",
    });
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, false);
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.ENTRY_ESCAPE),
      JSON.stringify(result.diagnostics),
    );
    assert.deepEqual(
      result.modules.map((module) => module.path),
      ['lib/index.js'],
      'the escaping module must never enter the graph',
    );
  } finally {
    sandbox.cleanup();
  }
});

test('a missing entry file is rejected as ENTRY_MISSING', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', { entrySource: null });
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, false);
    assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.ENTRY_MISSING));
    assert.equal(result.entry, null);
    assert.deepEqual(result.modules, []);
  } finally {
    sandbox.cleanup();
  }
});

test('a missing helper module breaks the module graph', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: "import './helper.js';\nexport function apply() {}\n",
    });
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, false);
    assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.ENTRY_MISSING));
  } finally {
    sandbox.cleanup();
  }
});

test('a symlinked directory inside the package is rejected as PACKAGE_SYMLINK', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg');
    const target = sandbox.mkdir('external-target');
    symlinkSync(target, sandbox.resolve('pkg', 'docs'), 'junction');

    const result = inspectPluginDirectory(directory);
    assert.equal(result.ok, false);
    assert.deepEqual(codesOf(result.diagnostics), [ERROR_CODES.PACKAGE_SYMLINK]);
    assert.equal(result.digests.packageSha256, null, 'a package containing a link has no package digest');
  } finally {
    sandbox.cleanup();
  }
});

test('an entry reached through a symlinked directory is rejected', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', { entrySource: null });
    const real = sandbox.mkdir('real-lib');
    sandbox.write('real-lib/index.js', 'export function apply() {}\n');
    symlinkSync(real, sandbox.resolve('pkg', 'lib'), 'junction');

    const result = inspectPluginDirectory(directory);
    assert.equal(result.ok, false);
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.PACKAGE_SYMLINK),
      JSON.stringify(result.diagnostics),
    );
    assert.ok(
      codesOf(result.diagnostics).some((code) => code === ERROR_CODES.ENTRY_MISSING
        || code === ERROR_CODES.ENTRY_NOT_REGULAR),
      'the linked entry must not be accepted as a regular entry file',
    );
  } finally {
    sandbox.cleanup();
  }
});

test('the module graph is scanned recursively, not just the entry module', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: "import { helper } from './deep/helper.js';\nexport function apply() {}\n",
      modules: {
        'lib/deep/helper.js': "import 'node:child_process';\nexport function helper() {}\n",
      },
    });
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, false);
    assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API));
    assert.ok(
      result.incompatibilities.some((item) => item.detail.includes('node:child_process')),
      'the hidden builtin import in the helper module must be reported',
    );
    assert.ok(result.modules.some((module) => module.path === 'lib/deep/helper.js'));
  } finally {
    sandbox.cleanup();
  }
});

test('import text inside a string literal is not a false positive', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: [
        'const sample = "import \'node:fs\'";',
        'export function apply() { return sample.length; }',
        '',
      ].join('\n'),
    });
    const result = inspectPluginDirectory(directory);
    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.ok, true);
  } finally {
    sandbox.cleanup();
  }
});

test('import text inside a line comment is not a false positive', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      entrySource: [
        "// import 'node:fs' is mentioned only as documentation",
        '/* export default is not used here */',
        'export function apply() {}',
        '',
      ].join('\n'),
    });
    const result = inspectPluginDirectory(directory);
    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.ok, true);
  } finally {
    sandbox.cleanup();
  }
});
