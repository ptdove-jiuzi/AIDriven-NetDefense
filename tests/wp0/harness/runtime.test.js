import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  stageAegisAnalysis,
  validateFourLayerManifest,
  validateLaunchArguments,
  validateWorkerEnvironment,
  verifyStagedProfile,
} from '@aegisharness/harness-adapter';
import {
  approved,
  createHarnessSandbox,
  packageLayer,
  policy,
  runHarnessProbe,
  saveEvidence,
  terminalEvents,
} from './helpers.js';
import { digestJson, projectManifestEvidence } from '@aegisharness/harness-adapter';

const workerBin = fileURLToPath(new URL('../../../apps/harness-worker/bin.js', import.meta.url));
const diagnosticOverlay = fileURLToPath(new URL('../../fixtures/upstream-required-service.probe.yml', import.meta.url));
let exactErrors;
// Filled by AT-HAR-001. The mutation matrix reuses it, so it is explicitly
// undefined until that probe runs: a `--test-name-pattern` run of the matrix
// alone must fail with the precondition message below, not a TypeError from
// `structuredClone(undefined)`.
let exactManifest = undefined;
let diagnosticErrors;
let diagnosticManifest;

function expectError(errors, pattern) {
  assert.ok(errors.some((error) => pattern.test(error)), `Missing error ${pattern}: ${errors.join('\n')}`);
}

test('AT-HAR-001: real stdio succeeds and the exact frozen tree passes four-layer validation', async (t) => {
  const sandbox = createHarnessSandbox(t);
  const probe = await runHarnessProbe({ sandbox });
  // A degraded capture (stub assembly threw and fell back to an empty context)
  // still yields a manifest, so the rest of this test would assert on a
  // half-observed runtime. Pin the non-degraded state explicitly.
  assert.equal(probe.runtime.captureError ?? null, null, 'runtime capture must not degrade');
  exactManifest = probe.manifest;
  exactErrors = validateFourLayerManifest(probe.manifest, policy, approved);
  saveEvidence('harness-stdio-shutdown.json', probe.stdio);
  const exactEvidence = projectManifestEvidence(probe.manifest);
  saveEvidence('harness-four-layer-exact.json', exactEvidence);
  assert.equal(exactEvidence.package.layerSha256, digestJson(packageLayer));
  assert.ok(exactEvidence.package.packages.every((entry) => (
    entry.files === undefined && (!entry.installed || entry.fileCount > 0)
  )));

  assert.deepEqual(probe.stdio.methods, ['initialize', 'session/wait', 'shutdown']);
  assert.equal(probe.stdio.exitCode, 0);
  assert.equal(probe.stdio.negativeControl.rejected, true);
  assert.ok(probe.stdio.stderrBytes <= policy.stderrMaxBytes);
  assert.ok(probe.stdio.frames.every((frame) => frame.jsonrpc === '2.0'));
  assert.equal(probe.stdio.control.approvalRequests, false);
  assert.equal(probe.stdio.control.userQuestions, false);
  // ADR-0004: the provider is part of the approved tree, so both consumers that
  // inject deepseekLlmApiExtensions must activate instead of waiting forever.
  assert.equal(probe.runtime.plugins.entries.find((entry) => entry.id === 'include:session-log-deepseek').state, 'active');
  assert.equal(probe.runtime.plugins.entries.find((entry) => entry.id === 'include:plugin-package-inventory-deepseek').state, 'active');
  assert.equal(probe.runtime.model.providers[0].extensionProviderPresent, true);
  // ADR-0004 §3.3: the registered field set is observable and closed.
  assert.deepEqual(probe.runtime.model.extensionFields, {
    verifiable: true,
    fields: ['dsh_plugin_packages', 'dsh_session_log'],
  });
  assert.deepEqual(exactErrors, []);
  assert.ok(!exactErrors.some((error) => error.includes('unapproved plugin')));
});

test('diagnostic overlay with an installed unapproved high-risk plugin is rejected by four-layer validation', async (t) => {
  const sandbox = createHarnessSandbox(t);
  const probe = await runHarnessProbe({ sandbox, overlay: true });
  diagnosticManifest = probe.manifest;
  diagnosticErrors = validateFourLayerManifest(probe.manifest, policy, approved);
  saveEvidence('harness-stdio-diagnostic-shutdown.json', probe.stdio);
  saveEvidence('harness-four-layer-diagnostic.json', projectManifestEvidence(probe.manifest));
  assert.equal(probe.manifest.plugins.overlaySourceFiles.length, 1);
  assert.equal(probe.manifest.plugins.overlaySourceFiles[0].path, 'tests/fixtures/upstream-required-service.probe.yml');
  assert.equal(probe.manifest.plugins.overlaySourceFiles[0].approved, false);
  assert.match(probe.manifest.plugins.overlaySourceFiles[0].sha256, /^[a-f0-9]{64}$/);

  assert.equal(probe.stdio.exitCode, 0);
  assert.equal(probe.stdio.stderr, '');
  /*
   * The overlay mounts an installed but unapproved high-risk package. cordis
   * loads whatever an overlay inserts — approval is not a loader gate — so the
   * security property is enforced by four-layer validation, not by the runtime
   * state. The entry is active, and must still be rejected on three separate
   * rules and never appear in the approved id/package maps.
   */
  const overlayEntry = probe.runtime.plugins.entries
    .find((entry) => entry.id === 'include:probe-unapproved-llm-retry');
  assert.ok(overlayEntry, 'the diagnostic overlay entry must appear in the resolved tree');
  assert.equal(overlayEntry.package, '@deepseek-ai/dsh-llm-retry');
  assert.equal(overlayEntry.state, 'active', 'cordis loads the overlay entry; rejection must come from validation');
  assert.ok(!policy.allowedPluginIds.includes('probe-unapproved-llm-retry'));
  assert.equal(policy.pluginPackages['probe-unapproved-llm-retry'], undefined);
  assert.equal(probe.runtime.model.providers[0].remoteModelListing, false);
  assert.deepEqual(probe.runtime.model.tools.map((tool) => tool.name), policy.allowedTools);
  assert.ok(probe.runtime.model.tools.every((tool) => tool.parameters.additionalProperties === false));
  expectError(diagnosticErrors, /unapproved plugin include:probe-unapproved-llm-retry/);
  expectError(diagnosticErrors, /overlay is not approved/);
  expectError(diagnosticErrors, /high-risk implementation llm-retry/);
  assert.ok(!diagnosticErrors.some((error) => error.includes('required provider deepseekLlmApiExtensions is absent')));
});

test('production stdio EOF closes the whole worker with protocol-only stdout', async (t) => {
  const sandbox = createHarnessSandbox(t);
  const probe = await runHarnessProbe({ sandbox, mode: 'eof' });
  saveEvidence('harness-stdio-eof.json', probe.stdio);
  assert.deepEqual(probe.stdio.methods, ['initialize']);
  assert.equal(probe.stdio.exitCode, 0);
  assert.ok(probe.stdio.frames.every((frame) => frame.jsonrpc === '2.0'));
  assert.ok(probe.stdio.stderrBytes <= policy.stderrMaxBytes);
});

test('worker wrapper preflights then invokes the official dsh runCli', async (t) => {
  const sandbox = createHarnessSandbox(t);
  const probe = await runHarnessProbe({ sandbox, workerScript: workerBin });
  saveEvidence('harness-stdio-worker-wrapper.json', probe.stdio);
  assert.equal(probe.stdio.exitCode, 0);
  assert.deepEqual(probe.stdio.methods, ['initialize', 'session/wait', 'shutdown']);
  assert.ok(probe.stdio.stderrBytes <= policy.stderrMaxBytes);
});

for (const [brokerMode, expectedCode, evidenceName] of [
  ['context', 'CONTEXT_WINDOW_EXCEEDED', 'harness-context-overflow.json'],
  ['transport', 'TRANSPORT', 'harness-transport-unknown.json'],
]) {
  test(`AT-HAR-005: ${brokerMode} failure has one request and no retry/compaction`, async (t) => {
    const sandbox = createHarnessSandbox(t);
    const probe = await runHarnessProbe({
      sandbox,
      brokerMode,
      sessionId: `wp0-${brokerMode}`,
    });
    saveEvidence(evidenceName, {
      stdio: probe.stdio,
      broker: probe.broker,
      runtime: probe.runtime,
    });

    assert.equal(probe.broker.requests.length, 1, 'No hidden model request is allowed');
    const request = probe.broker.requests[0];
    assert.equal(request.url, '/anthropic/v1/messages');
    assert.equal(request.body.model, policy.model.id);
    assert.equal(request.body.max_tokens, policy.model.maxTokens);
    assert.deepEqual(request.body.tools.map((tool) => tool.name), policy.allowedTools);
    assert.equal(request.headers['x-deepseek-harness-compact'], undefined);
    assert.equal(probe.stdio.exitCode, 0);
    const events = terminalEvents(probe.stdio);
    assert.ok(events.some((event) => event.type === 'turn/end' && event.data.reason.error.code === expectedCode));
    assert.ok(!events.some((event) => ['llm/retry', 'llm/retry-started', 'compaction/start', 'compaction/end'].includes(event.type)));
    assert.ok(probe.runtime.model.providers.every((provider) => provider.retryPolicy.maxRetries === 0));
  });
}

test('AT-HAR-001/002: independent mutation matrix fails closed', () => {
  // The baseline is the real exact-tree manifest captured above, validated with
  // the shipped policy: no hand-built "hypothetical" policy any more.
  assert.ok(exactManifest, 'the mutation matrix requires the exact-tree probe to have run first');
  const baseline = structuredClone(exactManifest);
  baseline.plugins.overlays = [];
  assert.deepEqual(validateFourLayerManifest(baseline, policy, approved), [], 'Exact tree baseline must start valid');

  const mutations = [
    ['missing required service', (manifest) => {
      manifest.services.providers = manifest.services.providers.filter((provider) => provider.name !== 'workingDirectory');
    }, /required provider workingDirectory is absent/],
    ['transitive high-risk implementation', (manifest) => {
      manifest.plugins.entries.push({
        id: 'include:tool-bash',
        package: '@deepseek-ai/dsh-tool-bash',
        state: 'active',
        disabled: false,
        missingServices: [],
        configuredInject: [],
        resolvedInject: [],
        exportedInject: [],
        config: {},
      });
    }, /unapproved plugin|high-risk implementation/],
    ['unapproved overlay', (manifest) => {
      manifest.plugins.overlays.push({ source: 'unapproved.yml' });
    }, /overlay is not approved/],
    ['profile hash mutation', (manifest) => {
      manifest.plugins.patchSources[0].sha256 = '0'.repeat(64);
    }, /hash does not match approved profile/],
    ['forbidden model tool', (manifest) => {
      manifest.model.tools.push({ name: 'shell.exec', parameters: { type: 'object', additionalProperties: false, properties: {} } });
    }, /tool surface differs|high-risk tool/],
    ['open tool arguments', (manifest) => {
      delete manifest.model.tools[0].parameters.additionalProperties;
    }, /does not reject unknown arguments/],
    ['LLM retry', (manifest) => {
      manifest.model.providers[0].retryPolicy.maxRetries = 5;
    }, /retry budget is not zero/],
    ['remote model listing', (manifest) => {
      manifest.model.providers[0].remoteModelListing = true;
    }, /remote \/models listing is enabled/],
    ['external broker', (manifest) => {
      manifest.model.providers[0].baseURL = 'https://example.invalid/anthropic';
    }, /loopback endpoint/],
    ['stdout logger', (manifest) => {
      manifest.model.effective.stdoutLoggerPlugin = true;
    }, /stdoutLogger is not proven disabled/],
    ['package integrity mutation', (manifest) => {
      delete manifest.package.packages[0].integrity;
    }, /lacks integrity/],
    ['package integrity downgrade', (manifest) => {
      manifest.package.packages[0].integrity = 'sha1-deadbeef';
    }, /lacks integrity/],
    ['package resolved mutation', (manifest) => {
      manifest.package.packages[0].resolved = 'http://registry.npmjs.org/insecure.tgz';
    }, /lacks HTTPS resolved/],
    ['session compression', (manifest) => {
      manifest.plugins.entries.find((entry) => entry.id === 'include:sessions').config.compression = 'zstd';
    }, /compression must be none/],
    // ADR-0005 §2: the old "must be empty" mutation is replaced by the three
    // failure modes of the single allowlisted context.
    ['runtime context extra', (manifest) => {
      manifest.model.runtimeContexts.push({ name: 'system-prompt:extra', text: '' });
    }, /count must be exactly 1/],
    ['runtime context text mismatch', (manifest) => {
      manifest.model.runtimeContexts[0].text = 'cwd';
    }, /cwd is outside the neutral analysis root|template/],
    ['runtime context user path', (manifest) => {
      manifest.model.runtimeContexts[0].text = 'Current working directory: "C:\\\\Users\\\\user\\\\analysis".';
    }, /leaks a user or repository path/],
    // ADR-0004 §3.3: a third registered request field must be rejected.
    ['unapproved extension field', (manifest) => {
      manifest.model.extensionFields.fields.push('dsh_telemetry');
    }, /unapproved extension field/],
    // ADR-0004 §7.3: an unobservable registry must fail closed, not read as empty.
    ['unverifiable extension fields', (manifest) => {
      manifest.model.extensionFields.verifiable = false;
    }, /unverifiable/],
  ];
  for (const [name, mutate, expected] of mutations) {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    expectError(validateFourLayerManifest(candidate, policy, approved), expected);
  }
  saveEvidence('harness-validation.json', {
    status: 'GO_FROZEN_CONTRACT_LOCAL_WINDOWS',
    exactErrors,
    diagnosticErrors,
    killedMutants: mutations.map(([name]) => name),
  });
});

test('AT-HAR-002: preflight rejects bad arguments, home patches and modified files', (t) => {
  const sandbox = createHarnessSandbox(t);
  validateLaunchArguments(['--profile', 'aegis-analysis']);
  assert.throws(() => validateLaunchArguments(['--profile', 'aegis-analysis', '--patch', diagnosticOverlay]), /overlays.*forbidden/);

  const stagedProfile = stageAegisAnalysis({ root: join(sandbox.workRoot, 'attempt') });
  validateWorkerEnvironment(stagedProfile.env, stagedProfile.cwd);
  verifyStagedProfile({ profileDir: stagedProfile.profileDir, toolsDir: stagedProfile.toolsDir, approved });
  appendFileSync(join(stagedProfile.profileDir, 'cordis.patch.yml'), '\n# unapproved mutation\n');
  assert.throws(
    () => verifyStagedProfile({ profileDir: stagedProfile.profileDir, toolsDir: stagedProfile.toolsDir, approved }),
    /hash differs/,
  );
  const launched = spawnSync(process.execPath, [workerBin, '--profile', 'aegis-analysis'], {
    cwd: stagedProfile.cwd,
    env: stagedProfile.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(launched.status, 1);
  assert.equal(launched.stdout, '');
  assert.match(launched.stderr, /hash differs/);
  saveEvidence('harness-preflight-rejection.log', launched.stderr);
  writeFileSync(join(stagedProfile.dshHome, 'cordis.patch.yml'), '- id: hmr\n  disabled: false\n');
  assert.throws(() => validateWorkerEnvironment(stagedProfile.env, stagedProfile.cwd), /Home-level.*not approved/);
});
