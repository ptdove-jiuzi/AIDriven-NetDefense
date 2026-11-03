import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  digestJson,
  readJson,
  rehydrateManifestEvidence,
  sha256File,
  validateFourLayerManifest,
} from '@aegisharness/harness-adapter';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'tests', 'wp0', 'evidence');
const policy = readJson(join(root, 'plugins', 'dsh-defense-profile', 'profile.json'));
const approved = readJson(join(root, 'plugins', 'dsh-defense-profile', 'approved-hashes.json'));
const validation = readJson(join(evidence, 'harness-validation.json'));
const packageLayer = readJson(join(evidence, 'harness-package-layer.json'));

assert.equal(validation.status, 'GO_FROZEN_CONTRACT_LOCAL_WINDOWS');
/*
 * The matrix in tests/wp0/harness/runtime.test.js is the contract's mutation
 * coverage. A bare `>= 15` let it silently shrink back from 19, so the gate now
 * pins the count *and* every name: deleting a mutation is a coverage regression,
 * not a number that happens to stay above a floor. Keep this list in step with
 * the matrix; renaming a mutation there means renaming it here in the same commit.
 */
const REQUIRED_MUTANTS = [
  'missing required service',
  'transitive high-risk implementation',
  'unapproved overlay',
  'profile hash mutation',
  'forbidden model tool',
  'open tool arguments',
  'LLM retry',
  'remote model listing',
  'external broker',
  'stdout logger',
  'package integrity mutation',
  'package integrity downgrade',
  'package resolved mutation',
  'session compression',
  'runtime context extra',
  'runtime context text mismatch',
  'runtime context user path',
  'unapproved extension field',
  'unverifiable extension fields',
];
assert.ok(
  validation.killedMutants.length >= REQUIRED_MUTANTS.length,
  `killedMutants has ${validation.killedMutants.length} entries, expected at least ${REQUIRED_MUTANTS.length}`,
);
for (const name of REQUIRED_MUTANTS) {
  assert.ok(validation.killedMutants.includes(name), `killed mutation "${name}" is missing from harness-validation.json`);
}
// ADR-0004 + ADR-0005 turn the exact tree from "must still fail" into "must pass".
// The old assertions demanded the two frozen-contract errors; keeping them would
// force the evidence to stay false.
assert.deepEqual(validation.exactErrors, []);
assert.ok(validation.diagnosticErrors.some((error) => error.includes('unapproved plugin')));

/*
 * Independent oracle: re-validate the saved evidence from files with the same
 * rules, never from the in-test objects. Any drift between the projection and
 * the package-layer file breaks the digest binding below.
 */
for (const [filename, expected] of [
  ['harness-four-layer-exact.json', validation.exactErrors],
  ['harness-four-layer-diagnostic.json', validation.diagnosticErrors],
]) {
  const view = readJson(join(evidence, filename));
  assert.equal(view.package.fileEvidence, 'harness-package-layer.json', filename);
  assert.equal(view.package.layerSha256, digestJson(packageLayer), `${filename}: package layer digest drift`);
  assert.ok(
    view.package.packages.every((entry) => entry.files === undefined && (!entry.installed || entry.fileCount > 0)),
    `${filename}: evidence must not inline per-file package hashes`,
  );
  assert.deepEqual(
    validateFourLayerManifest(rehydrateManifestEvidence(view, packageLayer), policy, approved),
    expected,
    `${filename}: re-validated evidence differs from the recorded verdict`,
  );
}

/*
 * ADR-0004 §3.3: the exact tree registers exactly the two upstream protocol
 * fields, and the set is proven observable rather than merely empty.
 */
const exactView = readJson(join(evidence, 'harness-four-layer-exact.json'));
assert.equal(exactView.model.extensionFields?.verifiable, true, 'the extension field set must be verifiable');
assert.deepEqual(
  exactView.model.extensionFields?.fields,
  ['dsh_plugin_packages', 'dsh_session_log'],
  'the exact tree must register only the two approved upstream request fields',
);

const diagnosticView = readJson(join(evidence, 'harness-four-layer-diagnostic.json'));
const overlays = diagnosticView.plugins.overlaySourceFiles;
assert.equal(overlays.length, 1, 'diagnostic overlay provenance is missing');
assert.equal(overlays[0].approved, false);
assert.equal(sha256File(join(root, overlays[0].path)), overlays[0].sha256, 'diagnostic overlay hash drift');
assert.ok(
  overlays[0].path.startsWith('tests/fixtures/'),
  'diagnostic overlay must live in the test fixture tree',
);

for (const [filename, methods] of [
  ['harness-stdio-shutdown.json', ['initialize', 'session/wait', 'shutdown']],
  ['harness-stdio-diagnostic-shutdown.json', ['initialize', 'session/wait', 'shutdown']],
  ['harness-stdio-worker-wrapper.json', ['initialize', 'session/wait', 'shutdown']],
  ['harness-stdio-eof.json', ['initialize']],
]) {
  const stdio = readJson(join(evidence, filename));
  assert.deepEqual(stdio.methods, methods, filename);
  assert.equal(stdio.exitCode, 0, filename);
  assert.ok(stdio.stderrBytes <= policy.stderrMaxBytes, filename);
  assert.ok(stdio.frames.every((frame) => frame.jsonrpc === '2.0'), filename);
}

for (const [filename, code] of [
  ['harness-context-overflow.json', 'CONTEXT_WINDOW_EXCEEDED'],
  ['harness-transport-unknown.json', 'TRANSPORT'],
]) {
  const probe = readJson(join(evidence, filename));
  assert.equal(probe.broker.requests.length, 1, filename);
  assert.equal(probe.broker.requests[0].url, '/anthropic/v1/messages', filename);
  assert.equal(probe.broker.requests[0].body.max_tokens, policy.model.maxTokens, filename);
  assert.equal(probe.broker.requests[0].body.tools.length, policy.allowedTools.length, filename);
  assert.ok(probe.stdio.frames.every((frame) => frame.jsonrpc === '2.0'), filename);
  assert.ok(probe.stdio.frames.some((frame) => (
    frame.method === 'session.event'
      && frame.params.event.type === 'turn/end'
      && frame.params.event.data.reason.error.code === code
  )), filename);
  assert.ok(!probe.stdio.frames.some((frame) => (
    frame.method === 'session.event'
      && ['llm/retry', 'llm/retry-started', 'compaction/start', 'compaction/end'].includes(frame.params.event.type)
  )), filename);
}

const overflow = readJson(join(evidence, 'harness-context-overflow.json'));
const requestBytes = JSON.stringify(overflow.broker.requests[0].body);
assert.equal(typeof overflow.broker.requests[0].body.system, 'string', 'A real model request must carry the assembled system prompt');
assert.ok(
  requestBytes.includes('Current working directory'),
  'The recorded cwd leak in HAR-UPSTREAM-002 must stay observable in evidence',
);
/*
 * ADR-0005 §7.6: the cwd the model actually saw must sit under the neutral
 * analysis root. The path is asserted *structurally after decoding*: the raw
 * body text escapes backslashes (`C:\\Users`), so `requestBytes.includes('C:\\Users')`
 * would match the escaped form and read the opposite of the truth (§7.3 pitfall 2).
 */
const contextStatements = overflow.broker.requests[0].body.messages
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((part) => part?.type === 'text' && typeof part.text === 'string')
  .map((part) => part.text)
  .filter((text) => text.includes('Current working directory'));
assert.ok(contextStatements.length > 0, 'the cwd runtime context line must stay observable in evidence');
const cwdMatch = /Current working directory: "((?:[^"\\]|\\.)*)"\./.exec(contextStatements[0]);
assert.ok(cwdMatch, 'the cwd context must keep the "Current working directory: \\"<cwd>\\"." shape');
const observedCwd = JSON.parse(`"${cwdMatch[1]}"`);
assert.ok(
  !/Users|AppData|\/home\/|AIUSE/.test(observedCwd),
  `the model must not see a user or repository path, saw ${observedCwd}`,
);
const analysisRoot = policy.effectiveConfig?.analysisCwdRoots?.[process.platform];
// A missing key used to skip the whole containment assertion, so a profile that
// never declared the neutral root would pass the cwd check by omission.
if (typeof analysisRoot !== 'string' || analysisRoot.length === 0) {
  assert.fail('profile.effectiveConfig.analysisCwdRoots is missing');
}
assert.ok(
  observedCwd.startsWith(`${analysisRoot}${sep}`),
  `the model-visible cwd must stay under ${analysisRoot}, saw ${observedCwd}`,
);
if (process.platform === 'win32') {
  assert.ok(observedCwd.includes('AegisHarness'), `the neutral deployment root must be visible, saw ${observedCwd}`);
}
/*
 * ADR-0004 §7.4: `dsh_session_log` and the cwd context are two channels of the
 * same leak surface, so the neutral-root rule applies to the whole request, not
 * only to `messages`.
 */
assert.ok(
  !/Users|AppData|\/home\//.test(requestBytes),
  'no request channel (system prompt, messages, extension fields) may carry an OS user path',
);
assert.ok(
  !requestBytes.includes('wp0-harmless-single-attempt-token'),
  'The single-attempt broker token must never appear in evidence',
);
assert.ok(
  readFileSync(join(evidence, 'harness-preflight-rejection.log'), 'utf8').includes('hash differs'),
  'Preflight rejection evidence is missing',
);

const input = readJson(join(evidence, 'harness-input-summary.json'));
const licenseFindings = readJson(join(evidence, 'harness-license-findings.json'));
assert.equal(input.licenseFindingsSha256, digestJson(licenseFindings), 'licence findings are not bound to the input summary');
// ADR-0002（选项 A）之后这条finding 的状态是"已决策"，不再是"仍被阻断"。
// 断言改成"必须记录决策与逐包清单"，而不是"必须仍然红"——否则门禁会倒逼证据保持失实。
assert.equal(licenseFindings.status, 'RESOLVED_BY_ADR_0002');
assert.match(licenseFindings.decision ?? '', /ADR-0002/u, 'the licence finding must name the deciding ADR');
assert.match(licenseFindings.resolution ?? '', /license:check/u, 'the licence finding must name the enforcing gate');
assert.ok(licenseFindings.packages.every((entry) => /MPL|LGPL/.test(entry.license)));
assert.ok(licenseFindings.packages.every((entry) => entry.dependents.length > 0));
assert.ok(
  licenseFindings.packages.some((entry) => entry.name === '@deepseek-ai/libreoffice-kit' && entry.license === 'MPL-2.0'),
  'the MPL-2.0 launcher dependency must stay recorded',
);
// 记录下来的 copyleft 包必须与已评审清单一致：证据不能比策略少，也不能比策略多。
const reviewedSource = readFileSync('scripts/license-reviewed-copyleft.mjs', 'utf8');
for (const entry of licenseFindings.packages) {
  assert.ok(
    reviewedSource.includes(`'${entry.name}'`),
    `${entry.name} is recorded as copyleft but missing from scripts/license-reviewed-copyleft.mjs`,
  );
}
assert.equal(licenseFindings.packages.length, 20, 'the reviewed copyleft inventory is 20 packages (6 MPL-2.0 + 14 LGPL-3.0-or-later)');
// 授权本身也要在：第二轮复核实测把 ADR-0002 整个移走时，本检查仍然 EXIT=0
// （它只读 JSON 里的 decision 字符串）。证据引用了一份不存在的决策，等于没有决策。
const licensingAdr = readFileSync('docs/implementation/adr/ADR-0002-third-party-license-policy.md', 'utf8');
assert.match(licensingAdr, /状态：\*\*Accepted/u, 'ADR-0002 must still be Accepted, not merely referenced');
assert.match(licensingAdr, /license-reviewed-copyleft\.mjs/u, 'ADR-0002 must name the reviewed package list');
assert.match(licensingAdr, /@deepseek-ai\/libreoffice-kit-win32-x64/u, 'ADR-0002 must keep the reviewed MPL-2.0 package table');
assert.match(licensingAdr, /@img\/sharp-libvips-linux-x64/u, 'ADR-0002 must keep the reviewed LGPL-3.0-or-later package table');

console.log('Harness evidence check passed: four-layer evidence re-validates from files, stdio/model probes are real, and frozen-contract NO-GO findings stay preserved.');
