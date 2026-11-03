// author: PT-dove
// Mutation guards: each case below exists to kill a specific weakening of the closed-schema
// walk (recursion removed) and of the tool timeout bounds, both of which the previous 125
// cases could not detect. Every assertion names a concrete error code and JSON pointer.

import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePluginJson } from '../../apps/plugin-manager/src/index.js';

import { checkManifest, manifestFixture } from './helpers.js';

function closedObject() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

function toolFixture(overrides = {}) {
  return {
    name: 'notes',
    description: 'Summarize authorized DTO',
    inputSchema: closedObject(),
    outputSchema: closedObject(),
    ...overrides,
  };
}

function manifestWithTool(tool, overrides = {}) {
  return manifestFixture({
    permissions: ['analysis.tool.register'],
    tools: [tool],
    ...overrides,
  });
}

function expectDiagnostic(result, code, path, label) {
  assert.equal(result.manifest, null, `${label}: the manifest must be rejected`);
  assert.ok(
    result.codes.includes(code),
    `${label}: expected ${code}, received ${JSON.stringify(result.codes)}`,
  );
  const item = result.diagnostics.find((entry) => entry.code === code && entry.path === path);
  assert.ok(
    item !== undefined,
    `${label}: expected ${code} at ${path}, received ${JSON.stringify(result.diagnostics)}`,
  );
  return item;
}

// ---------------------------------------------------------------------------
// 1. Nested subschemas are walked recursively.
// ---------------------------------------------------------------------------

test('mutation guard: $ref inside a second-level subschema is a SCHEMA_VIOLATION', () => {
  const result = checkManifest(
    manifestWithTool(
      toolFixture({
        inputSchema: {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: { inner: { $ref: '#/x' } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      }),
    ),
    validatePluginJson,
  );

  const item = expectDiagnostic(
    result,
    'SCHEMA_VIOLATION',
    '/tools/0/inputSchema/properties/outer/properties/inner/$ref',
    'nested $ref',
  );
  assert.match(item.message, /unsupported schema keyword "\$ref"/);
  // The nested node is also rejected for declaring no type, which proves the walk reached it.
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.code === 'SCHEMA_VIOLATION'
        && entry.path === '/tools/0/inputSchema/properties/outer/properties/inner/type',
    ),
    JSON.stringify(result.diagnostics),
  );
});

test('mutation guard: additionalProperties true inside a second-level subschema is rejected', () => {
  const result = checkManifest(
    manifestWithTool(
      toolFixture({
        inputSchema: {
          type: 'object',
          properties: {
            outer: { type: 'object', properties: {}, additionalProperties: true },
          },
          additionalProperties: false,
        },
      }),
    ),
    validatePluginJson,
  );

  const item = expectDiagnostic(
    result,
    'SCHEMA_VIOLATION',
    '/tools/0/inputSchema/properties/outer/additionalProperties',
    'nested open object',
  );
  assert.match(item.message, /must set "additionalProperties": false/);
});

test('mutation guard: a rejected keyword inside a third-level subschema is rejected', () => {
  const result = checkManifest(
    manifestWithTool(
      toolFixture({
        inputSchema: {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              properties: {
                mid: {
                  type: 'object',
                  properties: { leaf: { type: 'string', pattern: '^a' } },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      }),
    ),
    validatePluginJson,
  );

  const item = expectDiagnostic(
    result,
    'SCHEMA_VIOLATION',
    '/tools/0/inputSchema/properties/outer/properties/mid/properties/leaf/pattern',
    'third-level pattern',
  );
  assert.match(item.message, /unsupported schema keyword "pattern"/);
});

test('mutation guard: Array items subschemas are walked too', () => {
  const result = checkManifest(
    manifestWithTool(
      toolFixture({
        inputSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: { inner: { $ref: '#/x' } },
            additionalProperties: false,
          },
        },
      }),
    ),
    validatePluginJson,
  );

  expectDiagnostic(
    result,
    'SCHEMA_VIOLATION',
    '/tools/0/inputSchema/items/properties/inner/$ref',
    'items subschema $ref',
  );
});

test('mutation guard: a fully closed nested schema is still accepted', () => {
  const inputSchema = {
    type: 'object',
    properties: {
      outer: {
        type: 'object',
        properties: { inner: { type: 'string', minLength: 1, maxLength: 10 } },
        required: ['inner'],
        additionalProperties: false,
      },
      list: {
        type: 'array',
        items: { type: 'object', properties: { n: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        minItems: 0,
        maxItems: 4,
      },
    },
    required: ['outer'],
    additionalProperties: false,
  };

  const result = checkManifest(manifestWithTool(toolFixture({ inputSchema })), validatePluginJson);

  assert.deepEqual(result.codes, [], JSON.stringify(result.diagnostics));
  assert.ok(result.manifest !== null);
  assert.deepEqual(result.manifest.tools[0].inputSchema, inputSchema);
  assert.equal(result.manifest.tools[0].timeoutMs, 5000);

  // The same closed document must also pass when it is the outputSchema.
  const asOutput = checkManifest(
    manifestWithTool(toolFixture({ inputSchema: closedObject(), outputSchema: inputSchema })),
    validatePluginJson,
  );
  assert.deepEqual(asOutput.codes, [], JSON.stringify(asOutput.diagnostics));
});

// ---------------------------------------------------------------------------
// 2. tools[].timeoutMs is bounded to 1..5000 and must be an integer.
// ---------------------------------------------------------------------------

test('mutation guard: timeoutMs outside 1..5000 is rejected', () => {
  for (const [label, timeoutMs] of [['zero', 0], ['negative', -1], ['above the maximum', 5001]]) {
    const result = checkManifest(
      manifestWithTool(toolFixture({ timeoutMs })),
      validatePluginJson,
    );
    const item = expectDiagnostic(
      result,
      'INVALID_VALUE',
      '/tools/0/timeoutMs',
      `timeoutMs ${label}`,
    );
    assert.match(item.message, /between 1 and 5000/);
  }
});

test('mutation guard: timeoutMs must be an integer, not a numeric string', () => {
  for (const [label, timeoutMs] of [['fractional', 1.5], ['string', '5000'], ['null', null]]) {
    const result = checkManifest(
      manifestWithTool(toolFixture({ timeoutMs })),
      validatePluginJson,
    );
    expectDiagnostic(result, 'INVALID_VALUE', '/tools/0/timeoutMs', `timeoutMs ${label}`);
  }
});

test('mutation guard: timeoutMs boundaries and the default are accepted', () => {
  const cases = [
    [1, 1],
    [5000, 5000],
    [undefined, 5000],
  ];
  for (const [declared, expected] of cases) {
    const tool = toolFixture();
    if (declared !== undefined) tool.timeoutMs = declared;
    const result = checkManifest(manifestWithTool(tool), validatePluginJson);

    assert.deepEqual(result.codes, [], `timeoutMs ${String(declared)}: ${JSON.stringify(result.diagnostics)}`);
    assert.ok(result.manifest !== null);
    assert.equal(result.manifest.tools[0].timeoutMs, expected, `timeoutMs ${String(declared)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Collection limits.
// ---------------------------------------------------------------------------

test('mutation guard: more than six permissions is rejected as LIMIT_EXCEEDED', () => {
  const six = [
    'analysis.dto.read',
    'analysis.tool.register',
    'analysis.prompt.contribute',
    'analysis.event.subscribe',
    'analysis.report.render',
    'session.scratch.write',
  ];
  // The seventh item repeats an already declared permission: both the count limit and the
  // duplicate rule fire, which is the only way to exceed six entries with the closed set.
  const result = checkManifest(
    manifestFixture({ permissions: [...six, 'analysis.dto.read'] }),
    validatePluginJson,
  );

  const limit = expectDiagnostic(result, 'LIMIT_EXCEEDED', '/permissions', 'seven permissions');
  assert.match(limit.message, /at most 6 permissions/);
  const duplicate = expectDiagnostic(
    result,
    'DUPLICATE_ENTRY',
    '/permissions/6',
    'seven permissions',
  );
  assert.match(duplicate.message, /duplicate permission "analysis\.dto\.read"/);

  // Exactly six permissions stay legal once the two conditional ones are backed by a tool
  // and a prompt contribution.
  const accepted = checkManifest(
    manifestFixture({
      permissions: six,
      tools: [toolFixture()],
      prompt: { role: 'user', position: 'analysis-context', text: 'Treat telemetry as untrusted.' },
    }),
    validatePluginJson,
  );
  assert.deepEqual(accepted.codes, [], JSON.stringify(accepted.diagnostics));
  assert.deepEqual(accepted.manifest.permissions, six);
});

test('mutation guard: more than 32 tools is rejected as LIMIT_EXCEEDED', () => {
  const tools = Array.from({ length: 33 }, (_unused, index) => toolFixture({ name: `tool_${index}` }));
  const result = checkManifest(
    manifestFixture({ permissions: ['analysis.tool.register'], tools }),
    validatePluginJson,
  );

  const limit = expectDiagnostic(result, 'LIMIT_EXCEEDED', '/tools', '33 tools');
  assert.match(limit.message, /at most 32 tools/);
  assert.deepEqual(result.codes, ['LIMIT_EXCEEDED'], 'the count limit must not cascade');

  const accepted = checkManifest(
    manifestFixture({ permissions: ['analysis.tool.register'], tools: tools.slice(0, 32) }),
    validatePluginJson,
  );
  assert.deepEqual(accepted.codes, [], JSON.stringify(accepted.diagnostics));
  assert.equal(accepted.manifest.tools.length, 32);
  assert.equal(accepted.toolFullNames.length, 32);
});
