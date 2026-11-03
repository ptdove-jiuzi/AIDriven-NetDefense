// author: PT-dove
// Regression tests for the P0/P1 acceptance fixes:
//   1. an approval record must be self consistent (manifest hashes to manifestSha256);
//   2. the Effective Manifest digests the security projection (permissions/tools/prompt/runtime);
//   3. a regex literal after a keyword is not mistaken for a division;
//   4. both `export const inject = [...]` and `const inject = [...]; export { inject };`;
//   5. the report carries `staticScanOnly` and the declared dependencies;
//   6. package.json `name` is npm metadata (may be scoped) and versions may be prerelease;
//   7. a caller supplied profile is validated before use.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  buildEffectiveManifest,
  createDiagnostics,
  deriveSecurityProjection,
  digestOf,
  ERROR_CODES,
  inspectPluginDirectory,
  PluginCheckError,
  scanModuleSource,
  validateOverlay,
  validatePluginJson,
} from '../../apps/plugin-manager/src/index.js';

import {
  captureError,
  codesOf,
  createSandbox,
  manifestFixture,
  packageFixture,
  writePluginPackage,
} from './helpers.js';

const APPLY = 'export function apply() {}\n';

function approve(rawManifest, packageSha256 = 'b'.repeat(64)) {
  const diagnostics = createDiagnostics();
  const { manifest } = validatePluginJson(rawManifest, { diagnostics });
  assert.deepEqual(
    diagnostics.list(),
    [],
    `fixture manifest must be valid: ${JSON.stringify(diagnostics.list())}`,
  );
  // The approval record stores the digested document itself; `validated` is the normalised
  // manifest (defaults applied) and is only used by the consistency probe below.
  return {
    manifest: rawManifest,
    validated: manifest,
    manifestSha256: digestOf(rawManifest),
    packageSha256,
  };
}

function overlayEntry(record, overrides = {}) {
  return {
    id: record.manifest.id,
    version: record.manifest.version,
    manifestSha256: record.manifestSha256,
    packageSha256: record.packageSha256,
    ...deriveSecurityProjection(record.manifest),
    ...overrides,
  };
}

function runOverlay(entries, approved) {
  const diagnostics = createDiagnostics();
  const result = validateOverlay(
    { schemaVersion: '1.0', plugins: entries },
    { approved, diagnostics },
  );
  const listed = diagnostics.list();
  return { result, diagnostics: listed, codes: codesOf(listed) };
}

function inspectSource(entrySource, options = {}) {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg', {
      manifest: options.manifest ?? manifestFixture(),
      entrySource,
      packageJson: options.packageJson ?? null,
    });
    return inspectPluginDirectory(directory);
  } finally {
    sandbox.cleanup();
  }
}

function scan(source) {
  const diagnostics = createDiagnostics();
  const result = scanModuleSource(source, { file: 'lib/index.js', diagnostics });
  const listed = diagnostics.list();
  return { result, diagnostics: listed, codes: codesOf(listed) };
}

test('an approval record whose manifest does not hash to manifestSha256 is refused', () => {
  const m1 = manifestFixture({ id: 'com.example.alpha-notes', permissions: ['analysis.dto.read'] });
  const m2 = manifestFixture({
    id: 'com.example.alpha-notes',
    permissions: ['analysis.dto.read', 'session.scratch.write'],
  });
  const consistent = approve(m2);
  // The record advertises the digest of the old manifest while carrying the widened one.
  const forgedRecord = {
    manifest: consistent.manifest,
    manifestSha256: digestOf(m1),
    packageSha256: consistent.packageSha256,
  };
  const approved = new Map([[forgedRecord.manifest.id, forgedRecord]]);
  const entry = overlayEntry(forgedRecord);

  const outcome = runOverlay([entry], approved);

  assert.deepEqual(
    outcome.codes,
    [ERROR_CODES.OVERLAY_APPROVAL_MISMATCH],
    `expected exactly one OVERLAY_APPROVAL_MISMATCH, received ${JSON.stringify(outcome.codes)}`,
  );
  assert.equal(outcome.diagnostics[0].path, '/plugins/0/manifestSha256');
  assert.match(outcome.diagnostics[0].message, /not self consistent/);
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.result.digest, null);
  assert.notEqual(digestOf(m1), digestOf(m2), 'the two fixtures must really differ');
});

test('a self consistent approval record still passes', () => {
  const manifest = manifestFixture({
    id: 'com.example.alpha-notes',
    permissions: ['analysis.dto.read'],
  });
  const record = approve(manifest);
  assert.equal(record.manifestSha256, digestOf(record.manifest));

  const outcome = runOverlay([overlayEntry(record)], new Map([[manifest.id, record]]));

  assert.deepEqual(outcome.codes, [], JSON.stringify(outcome.diagnostics));
  assert.ok(outcome.result.document !== null);
  assert.match(outcome.result.digest, /^[0-9a-f]{64}$/);
});

test('the stored manifest must be the document that was digested', () => {
  // The record may not pair the normalised manifest (defaults already applied, e.g. the
  // injected timeoutMs) with the digest of the raw plugin.json document; that would let a
  // re-serialised manifest ride on an unchanged digest.
  const raw = manifestFixture({
    id: 'com.example.alpha-notes',
    permissions: ['analysis.tool.register'],
    tools: [
      {
        name: 'notes',
        description: 'Summarize authorized DTO',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  });
  const record = approve(raw);
  const entry = overlayEntry(record);
  const normalisedRecord = { ...record, manifest: record.validated };

  assert.notEqual(
    digestOf(normalisedRecord.manifest),
    record.manifestSha256,
    'the validated manifest injects the default timeoutMs and therefore hashes differently',
  );

  const outcome = runOverlay([entry], new Map([[raw.id, normalisedRecord]]));

  assert.deepEqual(outcome.codes, [ERROR_CODES.OVERLAY_APPROVAL_MISMATCH]);
  assert.equal(outcome.diagnostics[0].path, '/plugins/0/manifestSha256');
  assert.match(outcome.diagnostics[0].message, /not self consistent/);
  assert.equal(outcome.result.document, null);
  assert.equal(outcome.result.digest, null);
});

test('the Effective Manifest pins the security projection of each plugin', () => {
  const manifest = manifestFixture({
    id: 'com.example.alpha-notes',
    permissions: ['analysis.tool.register', 'session.scratch.write'],
    tools: [
      {
        name: 'notes',
        description: 'Summarize authorized DTO',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  });
  const record = approve(manifest);
  const outcome = runOverlay([overlayEntry(record)], new Map([[manifest.id, record]]));

  assert.deepEqual(outcome.codes, []);
  const [plugin] = outcome.result.document.plugins;
  const derived = deriveSecurityProjection(manifest);

  assert.ok(Object.hasOwn(plugin, 'security'), 'every plugin entry must carry a security block');
  assert.deepEqual(plugin.security, {
    permissions: derived.permissions,
    tools: derived.tools,
    prompt: derived.prompt,
    runtime: derived.runtime,
  });
  assert.deepEqual(plugin.security.permissions, manifest.permissions);
  assert.equal(plugin.security.tools.length, 1);
  assert.equal(plugin.security.tools[0].name, 'notes');
  assert.equal(plugin.security.prompt, null);
  assert.equal(plugin.security.runtime.engine.dsh, '0.2.2-alpha.2');
  assert.equal(plugin.security.runtime.limits.toolMs, 5000);
  assert.equal(outcome.result.digest, digestOf(outcome.result.document));
});

test('plugins that differ only in permissions produce different Effective Manifest digests', () => {
  const narrowManifest = manifestFixture({
    id: 'com.example.alpha-notes',
    permissions: ['analysis.dto.read'],
  });
  const wideManifest = manifestFixture({
    id: 'com.example.beta-notes',
    permissions: ['analysis.dto.read', 'session.scratch.write'],
  });
  const narrow = approve(narrowManifest);
  const wide = approve(wideManifest);
  const approved = new Map([
    [narrowManifest.id, narrow],
    [wideManifest.id, wide],
  ]);

  const narrowOnly = runOverlay([overlayEntry(narrow)], approved);
  const wideOnly = runOverlay([overlayEntry(wide)], approved);
  assert.deepEqual(narrowOnly.codes, []);
  assert.deepEqual(wideOnly.codes, []);
  assert.notEqual(narrowOnly.result.digest, wideOnly.result.digest);
  assert.notEqual(
    narrowOnly.result.document.plugins[0].security.permissions.length,
    wideOnly.result.document.plugins[0].security.permissions.length,
  );

  // Isolated check: two entries with the same identifiers and digests must digest differently
  // once their permissions differ, because `security` is part of the digested document.
  const base = {
    id: 'com.example.same-notes',
    version: '1.0.0',
    manifestSha256: 'a'.repeat(64),
    packageSha256: 'b'.repeat(64),
    permissions: ['analysis.dto.read'],
    tools: [],
    prompt: null,
    runtime: { api: 'aegis-extension-v1' },
    config: null,
  };
  const narrowDoc = buildEffectiveManifest({ plugins: [base] });
  const wideDoc = buildEffectiveManifest({
    plugins: [{ ...base, permissions: ['analysis.dto.read', 'session.scratch.write'] }],
  });
  const sameDoc = buildEffectiveManifest({ plugins: [{ ...base }] });

  assert.deepEqual(narrowDoc.document.plugins[0].security.permissions, ['analysis.dto.read']);
  assert.notEqual(
    narrowDoc.digest,
    wideDoc.digest,
    'a permission difference must survive into the digest',
  );
  assert.equal(sameDoc.digest, narrowDoc.digest, 'an identical entry must digest identically');
});

test('regex literals after keywords are not mistaken for division', () => {
  const entrySource = [
    'const re = /[\\w.]/g;',
    'function digits(s) { return /\\d+/.test(s); }',
    "function quote(s) { return /'/.test(s); }",
    "function kind() { return typeof /x/ === 'object'; }",
    "function pick(s) { return /a/g.test(s) ? 'yes' : 'no'; }",
    'export function apply(input) { return [digits(input), quote(input), kind(), pick(input), re.source]; }',
    '',
  ].join('\n');

  const unit = scan(entrySource);
  assert.deepEqual(unit.codes, [], JSON.stringify(unit.diagnostics));
  assert.deepEqual(unit.result.exports, ['apply'], 'only the named apply export is recorded');
  assert.deepEqual(unit.result.imports, []);

  const result = inspectSource(entrySource);
  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.equal(result.ok, true);

  // The regex tolerance must not weaken the escaped-identifier rejection.
  const mixed = scan('export function apply(s) { return /\\d+/.test(s) + \\u0070rocess; }\n');
  assert.deepEqual(mixed.codes, [ERROR_CODES.INVALID_VALUE]);
  assert.ok(mixed.diagnostics.some((item) => /escaped identifier sequence/.test(item.message)));
});

test('both inject declaration styles are accepted', () => {
  const inline = "export const inject = ['aegisAnalysis'];\nexport function apply() {}\n";
  const hoisted = [
    "const inject = ['aegisAnalysis', 'aegisScratch'];",
    'export { inject };',
    'export function apply() {}',
    '',
  ].join('\n');

  for (const [label, source] of [['export const inject', inline], ['export { inject }', hoisted]]) {
    const unit = scan(source);
    assert.deepEqual(unit.codes, [], `${label}: ${JSON.stringify(unit.diagnostics)}`);
    assert.ok(unit.result.exports.includes('inject'), `${label} must record the inject export`);

    const result = inspectSource(source);
    assert.deepEqual(result.diagnostics, [], `${label}: ${JSON.stringify(result.diagnostics)}`);
    assert.equal(result.ok, true, `${label} must be accepted by inspect`);
  }
});

test('an unverifiable inject value is rejected in both styles', () => {
  const badName = [
    "const inject = ['aegisShell'];",
    'export { inject };',
    'export function apply() {}',
    '',
  ].join('\n');
  const badCall = [
    'const inject = makeInject();',
    'export { inject };',
    'export function apply() {}',
    '',
  ].join('\n');

  const nameUnit = scan(badName);
  assert.deepEqual(nameUnit.codes, [ERROR_CODES.UNSUPPORTED_API]);
  assert.ok(
    nameUnit.diagnostics.some((item) => /inject declares unsupported names: aegisShell/.test(item.message)),
  );

  const callUnit = scan(badCall);
  assert.deepEqual(callUnit.codes, [ERROR_CODES.UNSUPPORTED_API]);
  assert.ok(
    callUnit.diagnostics.some((item) => /inject must be a literal array/.test(item.message)),
  );

  for (const [label, source] of [['bad name', badName], ['bad call', badCall]]) {
    const result = inspectSource(source);
    assert.equal(result.ok, false, `${label} must be rejected by inspect`);
    assert.ok(
      codesOf(result.diagnostics).includes(ERROR_CODES.UNSUPPORTED_API),
      `${label}: ${JSON.stringify(result.diagnostics)}`,
    );
    assert.ok(
      result.incompatibilities.some((item) => item.code === ERROR_CODES.UNSUPPORTED_API),
      `${label}: the finding must reach incompatibilities`,
    );
  }
});

test('the report marks itself as a static scan and surfaces declared dependencies', () => {
  const sandbox = createSandbox();
  try {
    const manifest = manifestFixture();
    const directory = writePluginPackage(sandbox, 'pkg', {
      manifest,
      packageJson: {
        ...packageFixture({ name: manifest.id, version: manifest.version }),
        dependencies: { 'example-dep': '1.2.3' },
      },
    });

    assert.equal(
      existsSync(sandbox.absolute('pkg/package-lock.json')),
      false,
      'the fixture must not contain a lockfile',
    );

    const result = inspectPluginDirectory(directory);

    assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
    assert.equal(result.ok, true);
    assert.equal(result.staticScanOnly, true);
    assert.equal(typeof result.staticScanOnly, 'boolean');
    assert.deepEqual(result.dependencies, { 'example-dep': '1.2.3' });
  } finally {
    sandbox.cleanup();
  }
});

test('a package without dependencies reports an empty dependency map', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg');
    const result = inspectPluginDirectory(directory);

    assert.equal(result.ok, true);
    assert.deepEqual(result.dependencies, {});
    assert.equal(result.staticScanOnly, true);
  } finally {
    sandbox.cleanup();
  }
});

test('a scoped package name and a prerelease version are accepted', () => {
  const manifest = manifestFixture({ version: '1.0.0-beta.1' });
  const pkg = {
    ...packageFixture({ version: '1.0.0-beta.1' }),
    name: '@example/anomaly-notes',
  };
  assert.notEqual(pkg.name, manifest.id, 'the fixture must use a name that differs from the id');

  const result = inspectSource(APPLY, { manifest, packageJson: pkg });

  assert.deepEqual(result.diagnostics, [], JSON.stringify(result.diagnostics));
  assert.equal(result.ok, true);
  assert.equal(result.pluginId, manifest.id);
  assert.equal(result.version, '1.0.0-beta.1');
  assert.equal(result.name, manifest.name);
});

test('a caller supplied profile must be complete', () => {
  const sandbox = createSandbox();
  try {
    const directory = writePluginPackage(sandbox, 'pkg');

    for (const profile of [{}, { api: 'aegis-extension-v1' }, { api: 'x', entry: 'lib/index.js', limits: {} }]) {
      const error = captureError(() => inspectPluginDirectory(directory, { profile }));
      assert.ok(error !== null, `${JSON.stringify(profile)} must be refused`);
      assert.ok(
        error instanceof PluginCheckError,
        `${JSON.stringify(profile)} must throw PluginCheckError, got ${error?.name}`,
      );
      assert.equal(error.name, 'PluginCheckError');
      assert.equal(error.code, ERROR_CODES.INVALID_ARGUMENT);
      assert.equal(error instanceof TypeError, false);
      assert.match(error.message, /profile/);
    }

    assert.equal(existsSync(sandbox.absolute('pkg/lib/index.js')), true);
  } finally {
    sandbox.cleanup();
  }
});

test('entry diagnostics: a parent segment is structural unsafety, not a location mismatch', () => {
  // The remaining literals (dist/index.js, ./lib/index.js, lib/index.mjs → ENTRY_MISMATCH) are
  // already pinned in plugin-manifest.test.js; only this exact literal is added here.
  const diagnostics = createDiagnostics();
  validatePluginJson(manifestFixture({ entry: 'lib/../x.js' }), { diagnostics });
  const listed = diagnostics.list();

  assert.deepEqual(codesOf(listed), [ERROR_CODES.ENTRY_PATH_UNSAFE]);
  assert.equal(listed[0].path, '/entry');
  assert.match(listed[0].message, /lib\/\.\.\/x\.js/);
});

const NOTES_TOOL_WITHOUT_TIMEOUT = {
  name: 'notes',
  description: 'Summarize authorized DTO',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

test('deriveSecurityProjection is identical for the raw document and the validated manifest', () => {
  const rawDocument = manifestFixture({
    id: 'com.example.alpha-notes',
    permissions: ['analysis.tool.register'],
    tools: [{ ...NOTES_TOOL_WITHOUT_TIMEOUT }],
  });
  assert.equal(
    Object.hasOwn(rawDocument.tools[0], 'timeoutMs'),
    false,
    'the fixture must not declare timeoutMs',
  );

  const validated = validatePluginJson(rawDocument, { diagnostics: createDiagnostics() }).manifest;
  assert.ok(validated !== null);
  assert.equal(validated.tools[0].timeoutMs, 5000, 'validation injects the default timeout');

  const fromRaw = deriveSecurityProjection(rawDocument);
  const fromValidated = deriveSecurityProjection(validated);

  assert.deepEqual(fromRaw, fromValidated, 'both inputs must derive the same projection');
  assert.equal(fromRaw.tools.length, 1);
  assert.equal(fromRaw.tools[0].timeoutMs, 5000, 'the default timeout must appear in the projection');
  assert.equal(fromValidated.tools[0].timeoutMs, 5000);
  assert.deepEqual(fromRaw.permissions, ['analysis.tool.register']);
  assert.equal(fromRaw.prompt, null);
  assert.equal(fromRaw.runtime.entry, 'lib/index.js');

  // A legal-but-incomplete document must fall back to the raw object instead of throwing.
  const incomplete = manifestFixture({ id: 'com.example.alpha-notes' });
  delete incomplete.permissions;

  const error = captureError(() => deriveSecurityProjection(incomplete));
  assert.equal(error, null, 'an incomplete document must not throw');

  const fallback = deriveSecurityProjection(incomplete);
  assert.deepEqual(fallback.permissions, [], 'a missing permissions array projects as empty');
  assert.deepEqual(fallback.tools, []);
  assert.equal(fallback.prompt, null);
  assert.equal(fallback.runtime.limits.toolMs, 5000);
});

test('inspect to overlay works end to end without a spurious tamper', () => {
  const sandbox = createSandbox();
  try {
    const manifest = manifestFixture({
      id: 'com.example.alpha-notes',
      permissions: ['analysis.tool.register'],
      tools: [{ ...NOTES_TOOL_WITHOUT_TIMEOUT }],
      configSchema: {
        type: 'object',
        properties: { threshold: { type: 'integer', minimum: 0, maximum: 100 } },
        required: ['threshold'],
        additionalProperties: false,
      },
    });
    const directory = writePluginPackage(sandbox, 'pkg', { manifest });

    const report = inspectPluginDirectory(directory);
    assert.deepEqual(report.diagnostics, [], JSON.stringify(report.diagnostics));
    assert.equal(report.ok, true);
    assert.ok(report.manifestDocument !== null, 'the report must expose the digested document');
    assert.equal(
      digestOf(report.manifestDocument),
      report.digests.manifestSha256,
      'the report must be self consistent',
    );
    assert.match(report.digests.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.tools[0].timeoutMs, 5000);

    const approved = new Map([
      [
        report.pluginId,
        {
          manifest: report.manifestDocument,
          manifestSha256: report.digests.manifestSha256,
          packageSha256: report.digests.packageSha256,
        },
      ],
    ]);
    const entry = {
      id: report.pluginId,
      version: report.version,
      manifestSha256: report.digests.manifestSha256,
      packageSha256: report.digests.packageSha256,
      ...deriveSecurityProjection(report.manifestDocument),
      config: { threshold: 25 },
    };
    const builtins = ['core.alpha', 'aegis.beta'];

    const acceptedDiagnostics = createDiagnostics();
    const accepted = validateOverlay(
      { schemaVersion: '1.0', plugins: [entry] },
      { approved, builtins, diagnostics: acceptedDiagnostics },
    );

    assert.deepEqual(acceptedDiagnostics.list(), [], JSON.stringify(acceptedDiagnostics.list()));
    assert.ok(accepted.document !== null);
    assert.deepEqual(
      accepted.document.builtins,
      ['aegis.beta', 'core.alpha'],
      'builtins must be sorted by id in the document',
    );
    assert.match(accepted.digest, /^[0-9a-f]{64}$/);
    assert.equal(accepted.digest, digestOf(accepted.document));
    assert.deepEqual(accepted.document.plugins[0].config, { threshold: 25 });
    assert.deepEqual(accepted.document.plugins[0].security.permissions, ['analysis.tool.register']);
    assert.equal(accepted.document.plugins[0].security.tools[0].timeoutMs, 5000);

    // The end-to-end path must still refuse a real escalation.
    const widenedDiagnostics = createDiagnostics();
    const widened = validateOverlay(
      {
        schemaVersion: '1.0',
        plugins: [
          { ...entry, permissions: [...entry.permissions, 'session.scratch.write'] },
        ],
      },
      { approved, builtins, diagnostics: widenedDiagnostics },
    );

    assert.deepEqual(codesOf(widenedDiagnostics.list()), [ERROR_CODES.OVERLAY_TAMPER]);
    assert.equal(widenedDiagnostics.list()[0].path, '/plugins/0/permissions');
    assert.equal(widened.document, null);
    assert.equal(widened.digest, null);

    // Mixed pairing: the record stores the validated manifest while the overlay entry was built
    // from the raw document. Both derive the same projection, so this must not be a tamper —
    // this pairing is exactly the false OVERLAY_TAMPER seen for unmodified plugins before the
    // projection learned to normalise its input.
    const validated = validatePluginJson(report.manifestDocument, {
      diagnostics: createDiagnostics(),
    }).manifest;
    assert.ok(validated !== null);
    const validatedSha = digestOf(validated);
    assert.notEqual(
      validatedSha,
      report.digests.manifestSha256,
      'the validated manifest hashes differently from the raw document',
    );

    const mixedDiagnostics = createDiagnostics();
    const mixed = validateOverlay(
      { schemaVersion: '1.0', plugins: [{ ...entry, manifestSha256: validatedSha }] },
      {
        approved: new Map([
          [
            report.pluginId,
            {
              manifest: validated,
              manifestSha256: validatedSha,
              packageSha256: report.digests.packageSha256,
            },
          ],
        ]),
        builtins,
        diagnostics: mixedDiagnostics,
      },
    );

    assert.deepEqual(
      mixedDiagnostics.list(),
      [],
      'a raw-document entry against a validated-manifest record is not a tamper',
    );
    assert.ok(mixed.document !== null);
    assert.match(mixed.digest, /^[0-9a-f]{64}$/);
  } finally {
    sandbox.cleanup();
  }
});
