import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPackageLayer,
  digestJson,
  readJson,
  sha256File,
  stableJson,
} from '@aegisharness/harness-adapter';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidenceDir = join(root, 'tests', 'wp0', 'evidence');
const profileDir = join(root, 'plugins', 'dsh-defense-profile');
const toolsDir = join(root, 'plugins', 'dsh-defense-tools');
const approvedPath = join(profileDir, 'approved-hashes.json');
const packagePath = join(evidenceDir, 'harness-package-layer.json');
const findingsPath = join(evidenceDir, 'harness-contract-findings.json');
const inputPath = join(evidenceDir, 'harness-input-summary.json');
const checkOnly = process.argv.includes('--check');
const policy = readJson(join(profileDir, 'profile.json'));

/*
 * ADR-0004 §2.1: the provider must be present as the *last* direct entry, so the
 * relative order of the existing 19 entries is unchanged (validate.js requires
 * `direct` to equal `allowedPluginIds` position by position).
 *
 * This gate runs before every evidence write/comparison on purpose. With it
 * below, `--check` reported a stale `approved-hashes.json` / package layer first,
 * which describes a *symptom* of the unapplied ADR and hides the cause. Once
 * ADR-0004 lands in the profile this block becomes a no-op.
 */
const EXTENSION_PROVIDER_ID = 'deepseek-llm-api-extensions';
const EXTENSION_PROVIDER_PACKAGE = '@deepseek-ai/dsh-deepseek-llm-api-extensions';
if (policy.pluginPackages?.[EXTENSION_PROVIDER_ID] !== EXTENSION_PROVIDER_PACKAGE
  || policy.allowedPluginIds?.at(-1) !== EXTENSION_PROVIDER_ID) {
  assert.fail(
    'ADR-0004 is not applied yet: allowedPluginIds must end with '
    + `"${EXTENSION_PROVIDER_ID}" and pluginPackages["${EXTENSION_PROVIDER_ID}"] must be `
    + `"${EXTENSION_PROVIDER_PACKAGE}" (observed ${JSON.stringify(policy.allowedPluginIds?.at(-1))} / `
    + `${JSON.stringify(policy.pluginPackages?.[EXTENSION_PROVIDER_ID])}).`,
  );
}

function writeEvidence(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (checkOnly) {
    assert.ok(existsSync(path), `Missing generated evidence: ${path}`);
    assert.equal(readFileSync(path, 'utf8'), text, `Stale generated evidence: ${path}`);
  } else {
    writeFileSync(path, text);
  }
}

const approved = {
  schemaVersion: '1.0',
  author: 'PT-dove',
  upstream: policy.upstream,
  files: {},
};
for (const [directory, prefix, files] of [
  [profileDir, 'plugins/dsh-defense-profile', ['package.json', 'cordis.patch.yml', 'profile.json']],
  [toolsDir, 'plugins/dsh-defense-tools', ['package.json', 'lib/index.js', 'lib/runtime-inspect.js']],
]) {
  for (const filename of files) {
    approved.files[`${prefix}/${filename}`] = { sha256: sha256File(join(directory, filename)) };
  }
}
writeEvidence(approvedPath, approved);

const packageLayer = buildPackageLayer(root);
writeEvidence(packagePath, packageLayer);

const lock = readJson(join(root, 'package-lock.json'));
const dshLock = lock.packages['node_modules/@deepseek-ai/dsh'];
const sessionLogSource = readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js'), 'utf8');
const inventorySource = readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js'), 'utf8');
const workingDirectorySource = readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-working-directory/lib/index.js'), 'utf8');
const basePatch = readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8');
assert.match(sessionLogSource, /const inject = \["deepseekLlmApiExtensions", "sessions"\]/);
assert.match(inventorySource, /"deepseekLlmApiExtensions",/);
assert.match(workingDirectorySource, /required: true/);
assert.match(basePatch, /id: deepseek-llm-api-extensions/);

/*
 * M2 / ADR-0004+0005 已按 §2.1 落地（provider 末位 + allowedPluginIds/pluginPackages +
 * `effectiveConfig` 的四个键）。两份发现的 `observed` / `runtimeObservation` 是**历史事实**，
 * 逐字保留；`resolution` 记录决策出处。顶层 status 只声明"本机 Windows 上合同已闭合"，
 * 不含任何四 OS 含义——Ubuntu 22.04/24.04、Debian 12 未执行。
 */
const findings = {
  schemaVersion: '1.0',
  status: 'GO_FROZEN_CONTRACT_LOCAL_WINDOWS',
  upstream: {
    name: '@deepseek-ai/dsh',
    version: dshLock.version,
    resolved: dshLock.resolved,
    integrity: dshLock.integrity,
    license: dshLock.license,
    fixedCommit: policy.upstream.commit,
    fixedCommitPackageJson: 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/ce7073d51254c26cd63b22a60835b8f948deb447/apps/cli/package.json',
    npmGitHead: null,
    binSha256: sha256File(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')),
  },
  findings: [
    {
      id: 'HAR-UPSTREAM-001',
      // ADR-0004 已落地（provider 在 allowedPluginIds 末位）；observed /
      // runtimeObservation 是历史事实，不改写。
      status: 'RESOLVED_BY_ADR_0004',
      contract: 'HARNESS_PROFILE_CONTRACT §2 and §4; AT-HAR-001',
      observed: 'session-log-deepseek and plugin-package-inventory-deepseek export required inject deepseekLlmApiExtensions, but the frozen direct plugin list has no provider. Official dsh-base and dsh-sdk-minimal both mount @deepseek-ai/dsh-deepseek-llm-api-extensions. The explicit no-base tree leaves both required plugins pending while stdio still answers initialize.',
      resolution: 'Resolved by ADR-0004 (docs/implementation/adr/ADR-0004-harness-llm-api-extensions-provider.md): the profile mounts the upstream @deepseek-ai/dsh-deepseek-llm-api-extensions provider as the last allowed plugin id, both consumers become active, and the registered request-field set is asserted to stay within {dsh_session_log, dsh_plugin_packages}.',
      sourceSha256: {
        sessionLog: sha256File(join(root, 'node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js')),
        inventory: sha256File(join(root, 'node_modules/@deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js')),
        officialBasePatch: sha256File(join(root, 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')),
      },
      runtimeObservation: 'Consumer: exit 0 with protocol-only stdout, stderr "dsh: warning: 2 entries did not activate ... waiting for service: deepseekLlmApiExtensions".',
      evidence: 'tests/wp0/evidence/harness-stdio-shutdown.json',
    },
    {
      id: 'HAR-UPSTREAM-002',
      // ADR-0005 已落地（单条 allowlist + 模板再渲染 + 中性根）；runtimeObservation
      // 是历史事实，不得改写。
      status: 'RESOLVED_BY_ADR_0005',
      contract: 'HARNESS_PROFILE_CONTRACT §2 system-prompt runtime additions; AT-HAR-001/002',
      observed: 'dsh-working-directory registers working-directory:current with required=true. dsh-system-prompt retains required contexts even when includeRuntimeContext=false. A real prompt therefore contains the per-attempt cwd despite the frozen configuration wording.',
      resolution: 'Resolved by ADR-0005 option A (docs/implementation/adr/ADR-0005-harness-cwd-runtime-context.md): the single non-interpolated context is accepted, its text must re-render from the declared template, and the cwd it names must stay under the neutral per-analysis root.',
      sourceSha256: {
        workingDirectory: sha256File(join(root, 'node_modules/@deepseek-ai/dsh-working-directory/lib/index.js')),
        systemPrompt: sha256File(join(root, 'node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js')),
      },
      runtimeObservation: 'A real Messages request carried "Current working directory: <per-attempt cwd>" in messages[] while initialize reported no approvals and system prompt carried only the defense persona.',
      evidence: 'tests/wp0/evidence/harness-context-overflow.json',
    },
    {
      id: 'HAR-UPSTREAM-003',
      contract: 'Package presence versus loaded capability',
      evidence: 'The official @deepseek-ai/dsh launcher declares many high-risk packages as dependencies. They remain in the lockfile/package/SBOM evidence, but high-risk acceptance is evaluated on actual Loader entries, service providers, inject and model tools; package names alone are not treated as loaded capabilities.',
      sourceSha256: {
        launcherPackage: sha256File(join(root, 'node_modules/@deepseek-ai/dsh/package.json')),
      },
    },
  ],
};
writeEvidence(findingsPath, findings);

/* Supply-chain licence review of the real dependency tree. Every non-permissive
 * package is recorded here with its real dependents, so the finding stays
 * auditable. The policy decision lives in ADR-0002 (option A) and the reviewed
 * package list lives in scripts/license-reviewed-copyleft.mjs; this file records
 * the observed tree and the resolution, it does not decide anything. */
const copyleftPackages = [];
for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  if (!location.includes('node_modules/') || entry.link) continue;
  if (!/MPL|LGPL/.test(entry.license ?? '')) continue;
  const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const dependents = Object.entries(lock.packages).flatMap(([parent, parentEntry]) => {
    if (parentEntry.link) return [];
    const declared = {
      ...parentEntry.dependencies,
      ...parentEntry.optionalDependencies,
      ...parentEntry.peerDependencies,
    };
    return declared[name] ? [parent || '<root>'] : [];
  });
  copyleftPackages.push({
    name,
    version: entry.version,
    license: entry.license,
    resolved: entry.resolved,
    integrity: entry.integrity,
    optional: entry.optional === true,
    installed: existsSync(join(root, location)),
    dependents,
  });
}
const licenseFindings = {
  schemaVersion: '1.0',
  author: 'PT-dove',
  // 曾经的 BLOCKED_BY_LICENSE_POLICY 是未决策状态；ADR-0002 于 2026-11-01 由维护者
  // 签字选择选项 A（保留 office/附件功能包 + 扩展已评审白名单），因此这里记录的是
  // "已决策"而不是"仍被阻断"。包清单仍然逐条保留，便于复核没有依赖被悄悄裁掉。
  status: 'RESOLVED_BY_ADR_0002',
  decision: 'docs/implementation/adr/ADR-0002-third-party-license-policy.md — option A',
  gate: 'scripts/check-licenses.mjs two-tier allowlist: permissive set plus the reviewed weak-copyleft package list',
  observed: 'The official @deepseek-ai/dsh launcher transitively requires MPL-2.0 (@deepseek-ai/libreoffice-kit via dsh-office-to-pdf, dsh-skill-office) and LGPL-3.0-or-later (sharp/libvips via dsh-attachment-local).',
  resolution: 'Reviewed per package in scripts/license-reviewed-copyleft.mjs (6 MPL-2.0, 14 LGPL-3.0-or-later). THIRD_PARTY_NOTICES carries both licence notices, the source-availability statement and the LGPL relink/replaceability obligation. npm run license:check enforces set equality against the lockfile, the stated package counts, and the ADR §3.2 table.',
  packages: copyleftPackages,
};
writeEvidence(join(evidenceDir, 'harness-license-findings.json'), licenseFindings);

const profileManifest = readJson(join(profileDir, 'package.json'));
const workerManifest = readJson(join(root, 'apps/harness-worker/package.json'));
const input = {
  schemaVersion: '1.0',
  author: 'PT-dove',
  upstream: policy.upstream,
  directDependencies: {
    profile: profileManifest.dependencies,
    worker: workerManifest.dependencies,
  },
  lockfileSha256: packageLayer.lockfileSha256,
  packageLayerSha256: digestJson(packageLayer),
  approvedHashesSha256: digestJson(approved),
  findingsSha256: digestJson(findings),
  licenseFindingsSha256: digestJson(licenseFindings),
};
writeEvidence(inputPath, input);

if (checkOnly) {
  assert.equal(stableJson(readJson(approvedPath)), stableJson(approved));
}
console.log(`${checkOnly ? 'Checked' : 'Generated'} Harness evidence: ${packageLayer.installedPackageCount}/${packageLayer.packageCount} locked packages installed and file-hashed.`);
console.log(`Frozen-contract findings: ${findings.findings.map((finding) => finding.id).join(', ')}.`);
