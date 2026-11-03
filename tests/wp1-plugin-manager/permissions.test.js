// author: PT-dove

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALLOWED_EXPORTS,
  createDiagnostics,
  ERROR_CODES,
  INJECT_NAMES,
  inspectPluginDirectory,
  PERMISSIONS,
  PERMISSION_API,
  scanModuleSource,
} from '../../apps/plugin-manager/src/index.js';

import { codesOf, createSandbox, writePluginPackage } from './helpers.js';

const DOCUMENTED_PERMISSIONS = [
  'analysis.dto.read',
  'analysis.tool.register',
  'analysis.prompt.contribute',
  'analysis.event.subscribe',
  'analysis.report.render',
  'session.scratch.write',
];

const DOCUMENTED_API = {
  'analysis.dto.read': 'analysis.getDto',
  'analysis.tool.register': 'tools.register',
  'analysis.prompt.contribute': 'manifest.prompt',
  'analysis.event.subscribe': 'analysis.subscribe',
  'analysis.report.render': 'report.registerRenderer',
  'session.scratch.write': 'scratch',
};

function inspectEntry(entrySource) {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', { entrySource });
    return inspectPluginDirectory(directory);
  } finally {
    sandbox.cleanup();
  }
}

function scanEntry(source) {
  const diagnostics = createDiagnostics();
  const result = scanModuleSource(source, { file: 'lib/index.js', diagnostics });
  return { result, diagnostics: diagnostics.list(), codes: codesOf(diagnostics.list()) };
}

test('inject accepts the whitelisted service names', () => {
  const result = inspectEntry(
    [
      "export const inject = ['aegisAnalysis', 'aegisScratch'];",
      'export function apply(ctx) { return ctx; }',
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.equal(result.ok, true);
});

test('inject rejects names outside the four-item whitelist', () => {
  const result = inspectEntry(
    ["export const inject = ['aegisShell'];", 'export function apply() {}', ''].join('\n'),
  );
  assert.equal(result.ok, false);
  assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API));
  assert.ok(
    result.diagnostics.some((item) => /inject declares unsupported names: aegisShell/.test(item.message)),
    JSON.stringify(result.diagnostics),
  );
});

test('inject must be a literal array', () => {
  const result = inspectEntry(
    [
      "const injectNames = ['aegisAnalysis'];",
      'export const inject = injectNames;',
      'export function apply() {}',
      '',
    ].join('\n'),
  );
  assert.equal(result.ok, false);
  assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API));
  assert.ok(
    result.diagnostics.some((item) => /inject must be a literal array/.test(item.message)),
    JSON.stringify(result.diagnostics),
  );
});

test('an entry without a named apply export is rejected', () => {
  const result = inspectEntry('export function helper() { return 1; }\n');
  assert.equal(result.ok, false);
  assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.EXPORT_SHAPE_INVALID));
  assert.ok(
    result.diagnostics.some((item) => /must export a named function "apply"/.test(item.message)),
    JSON.stringify(result.diagnostics),
  );
});

test('export default is rejected', () => {
  const result = inspectEntry('export default function apply() {}\n');
  assert.equal(result.ok, false);
  const codes = codesOf(result.diagnostics);
  assert.ok(codes.includes(ERROR_CODES.UNSUPPORTED_API), `expected UNSUPPORTED_API, received ${codes}`);
  assert.ok(codes.includes(ERROR_CODES.EXPORT_SHAPE_INVALID), `expected EXPORT_SHAPE_INVALID, received ${codes}`);
  assert.ok(result.diagnostics.some((item) => /export default is not allowed/.test(item.message)));
});

test('extra named exports are rejected', () => {
  const result = inspectEntry('export function apply() {}\nexport const helper = 1;\n');
  assert.equal(result.ok, false);
  assert.ok(codesOf(result.diagnostics).includes(ERROR_CODES.EXPORT_SHAPE_INVALID));
  assert.ok(result.diagnostics.some((item) => /export "helper" is not allowed/.test(item.message)));
});

test('apply, dispose and inject are the only allowed exports', () => {
  assert.deepEqual([...ALLOWED_EXPORTS], ['apply', 'dispose', 'inject']);
  const result = inspectEntry(
    [
      'export function apply() {}',
      'export function dispose() {}',
      "export const inject = ['aegisLogger'];",
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.equal(result.ok, true);
});

test('dangerous globals cannot be reached from plugin source', () => {
  const cases = [
    ['process.env', 'export function apply() { return process.env.AEGIS_TOKEN; }\n', /"process"/],
    ['eval', "export function apply() { return eval('1'); }\n", /"eval"/],
    ['new Function', "export function apply() { return new Function('return 1')(); }\n", /"Function"/],
    ['require', "const fs = require('fs');\nexport function apply() {}\n", /require/],
    ['module.exports', 'module.exports = { apply() {} };\n', /module\.exports/],
    ['globalThis.process', 'export function apply() { return globalThis.process.env.X; }\n', /globalThis\.process/],
  ];

  for (const [label, source, messagePattern] of cases) {
    const outcome = scanEntry(source);
    assert.ok(
      outcome.codes.includes(ERROR_CODES.UNSUPPORTED_API),
      `${label} must report UNSUPPORTED_API, received ${JSON.stringify(outcome.codes)}`,
    );
    assert.ok(
      outcome.diagnostics.some((item) => messagePattern.test(item.message)),
      `${label} must name the construct in its message: ${JSON.stringify(outcome.diagnostics)}`,
    );
  }
});

test('the permission set is exactly the six documented permissions', () => {
  assert.equal(PERMISSIONS.length, 6);
  assert.deepEqual([...PERMISSIONS].sort(), [...DOCUMENTED_PERMISSIONS].sort());
  for (const permission of DOCUMENTED_PERMISSIONS) {
    assert.ok(PERMISSIONS.includes(permission), `missing permission ${permission}`);
  }
  assert.equal(new Set(PERMISSIONS).size, 6, 'permissions must not repeat');
});

test('PERMISSION_API maps every permission to its single documented interface', () => {
  assert.deepEqual(Object.keys(PERMISSION_API).sort(), [...DOCUMENTED_PERMISSIONS].sort());
  for (const [permission, api] of Object.entries(DOCUMENTED_API)) {
    assert.equal(PERMISSION_API[permission], api, `permission ${permission}`);
  }
  assert.equal(Object.keys(PERMISSION_API).length, 6);
});

test('the inject whitelist is the four documented service names', () => {
  assert.deepEqual([...INJECT_NAMES], ['aegisAnalysis', 'aegisReport', 'aegisScratch', 'aegisLogger']);
});
