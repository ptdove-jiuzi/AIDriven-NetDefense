import { posix, win32 } from 'node:path';

/*
 * Path semantics follow the platform whose neutral root was declared: the policy
 * is keyed by `process.platform`, so the same platform must decide what
 * "absolute", "normalized" and "inside" mean. Mixing Node's host semantics with
 * the declared root is how `..` traversal slips through a `startsWith` test.
 */
const PATH_IMPL = process.platform === 'win32' ? win32 : posix;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** Placeholder the runtime-context text template uses for the analysis cwd. */
const CWD_PLACEHOLDER = '{cwd}';

/** Tokens that must never appear in a neutral deployment path. */
const NON_NEUTRAL_TOKENS = ['Users', 'home', 'AppData', 'AIUSE'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedPluginId(entry) {
  return entry.id.startsWith('include:') ? entry.id.slice('include:'.length) : entry.id;
}

function hasForbiddenImplementation(value, patterns) {
  const lower = value.toLowerCase();
  return patterns.find((pattern) => lower.includes(pattern));
}

function validatePackages(manifest, errors) {
  const layer = manifest.package;
  if (!layer || layer.source !== 'package-lock.json + installed npm release files') {
    errors.push('package: missing lockfile/release-file evidence');
    return;
  }
  if (!Array.isArray(layer.packages) || layer.packages.length === 0) {
    errors.push('package: empty package inventory');
    return;
  }
  for (const entry of layer.packages) {
    const label = `${entry.name}@${entry.version}`;
    if (!EXACT_VERSION.test(entry.version ?? '')) errors.push(`package: ${label} is not exact`);
    if (!/^https:\/\//.test(entry.resolved ?? '')) errors.push(`package: ${label} lacks HTTPS resolved`);
    if (!INTEGRITY.test(entry.integrity ?? '')) errors.push(`package: ${label} lacks integrity`);
    if (typeof entry.license !== 'string' || entry.license.length === 0) {
      errors.push(`package: ${label} lacks license`);
    }
    if (!entry.installed) {
      if (!entry.optional) errors.push(`package: required ${label} is not installed`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(entry.packageJsonSha256 ?? '')) {
      errors.push(`package: ${label} lacks release package.json hash`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      errors.push(`package: ${label} has no release file hashes`);
      continue;
    }
    for (const file of entry.files) {
      if (file.type === 'file' && !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
        errors.push(`package: ${label} file ${file.path} lacks SHA-256`);
      }
    }
  }
}

function validatePlugins(manifest, policy, approved, errors) {
  const layer = manifest.plugins;
  const entries = layer?.entries;
  if (!Array.isArray(entries)) {
    errors.push('plugins: missing actual Loader entries');
    return;
  }
  if ((layer.startedBundles ?? []).length > 0) errors.push('plugins: inherited bundle is not approved');
  if ((layer.overlays ?? []).length > 0) errors.push('plugins: command-line/home overlay is not approved');

  const patchHashes = new Map((layer.patchSources ?? []).map((source) => [source.path.split(/[\\/]/).pop(), source.sha256]));
  for (const filename of ['cordis.patch.yml', 'package.json']) {
    const expected = approved.files[`plugins/dsh-defense-profile/${filename}`]?.sha256;
    if (!expected || patchHashes.get(filename) !== expected) {
      errors.push(`plugins: ${filename} hash does not match approved profile`);
    }
  }

  const direct = [];
  for (const entry of entries) {
    if (entry.id === 'include') {
      if (entry.package !== 'cordis:include' || entry.state !== 'active') {
        errors.push('plugins: official include structural entry is invalid');
      }
      continue;
    }
    const id = normalizedPluginId(entry);
    direct.push(id);
    /*
     * The high-risk check must run for *every* Loader entry, approved or not:
     * an unapproved overlay entry is exactly where a forbidden capability shows
     * up, and `continue`-ing first made the rule unreachable for the only case
     * it guards. Both errors are reported; being unapproved is still a rejection.
     */
    const forbidden = hasForbiddenImplementation(`${id} ${entry.package}`, policy.forbiddenImplementationPatterns);
    if (forbidden) errors.push(`plugins: high-risk implementation ${forbidden} in ${entry.package}`);
    if (!policy.allowedPluginIds.includes(id)) {
      errors.push(`plugins: unapproved plugin ${entry.id} (${entry.package})`);
      continue;
    }
    if (policy.pluginPackages[id] !== entry.package) {
      errors.push(`plugins: ${id} package ${entry.package} is not approved`);
    }
    if (entry.disabled || entry.state !== 'active') {
      errors.push(`plugins: required ${id} is ${entry.state}${entry.disabled ? '/disabled' : ''}`);
    }
    for (const missing of entry.missingServices ?? []) {
      errors.push(`plugins: ${id} misses required service ${missing}`);
    }
  }
  if (JSON.stringify(direct) !== JSON.stringify(policy.allowedPluginIds)) {
    errors.push(`plugins: ordered direct tree differs: ${JSON.stringify(direct)}`);
  }

  const byId = new Map(entries.map((entry) => [normalizedPluginId(entry), entry]));
  const sdk = byId.get('sdk-jsonrpc-server');
  if (JSON.stringify(sdk?.configuredInject ?? []) !== JSON.stringify(['sdkAppStartup', 'loader'])) {
    errors.push('plugins: sdk-jsonrpc-server configured inject differs');
  }
  for (const service of ['agents', 'workingDirectory', 'sdkAppStartup', 'loader']) {
    if (!sdk?.resolvedInject?.includes(service)) errors.push(`plugins: sdk-jsonrpc-server lacks resolved inject ${service}`);
  }
  if (sdk?.config?.maxTokensAsSuccess !== false) errors.push('plugins: maxTokensAsSuccess must be false');
  if (byId.get('sessions')?.config?.compression !== 'none') errors.push('plugins: Session compression must be none');
  if (JSON.stringify(byId.get('agent-loop')?.config?.agents ?? null) !== '[]') {
    errors.push('plugins: agent-loop must start with agents=[]');
  }
}

function validateServices(manifest, policy, errors) {
  const providers = manifest.services?.providers;
  if (!Array.isArray(providers)) {
    errors.push('services: missing actual provider inventory');
    return;
  }
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  for (const required of policy.requiredServices) {
    const provider = byName.get(required);
    if (!provider) {
      errors.push(`services: required provider ${required} is absent`);
      continue;
    }
    if (provider.state !== 'active') errors.push(`services: ${required} is ${provider.state}`);
    const expected = policy.requiredServiceProviders[required];
    if (provider.provider !== expected) {
      errors.push(`services: ${required} provider ${provider.provider} differs from ${expected}`);
    }
  }
  const allowed = new Set([...policy.requiredServices, ...policy.allowedAuxiliaryServices]);
  for (const provider of providers) {
    if (!allowed.has(provider.name)) errors.push(`services: unapproved provider ${provider.name}`);
    const forbidden = hasForbiddenImplementation(
      `${provider.name} ${provider.providerPackage}`,
      policy.forbiddenImplementationPatterns,
    );
    if (forbidden) errors.push(`services: high-risk provider ${provider.name} (${forbidden})`);
  }
  for (const relation of manifest.services?.inject ?? []) {
    for (const missing of relation.missing ?? []) {
      errors.push(`services: ${relation.consumer} inject ${missing} is unresolved`);
    }
  }
}

/*
 * ADR-0004 §3.3 / §7.3: the registered top-level request field set must equal
 * the approved set. A subset test alone is not enough: `{verifiable: true,
 * fields: []}` would satisfy "actual ⊆ approved" while meaning "no field is
 * registered", which is exactly the unobservable state the contract forbids.
 * The subset loop rejects extras; the completeness check below rejects missing
 * entries, so together they require sorted set equality.
 */
function validateExtensionFields(model, policy, errors) {
  const approved = policy.effectiveConfig?.extensionFields;
  if (!Array.isArray(approved)) {
    errors.push('effectiveConfig.extensionFields is missing');
    return;
  }
  const actual = model?.extensionFields;
  if (actual?.verifiable !== true || !Array.isArray(actual.fields)) {
    errors.push('model: extension field set is unverifiable');
    return;
  }
  for (const field of actual.fields) {
    if (!approved.includes(field)) errors.push(`model: unapproved extension field ${field}`);
  }
  const missing = [...approved].filter((field) => !actual.fields.includes(field)).sort();
  if (missing.length > 0) {
    errors.push(`model: extension field set is incomplete: ${missing.join(', ')}`);
  }
}

/*
 * ADR-0005 §2 option A + §7.6: so long as `working-directory` cannot be turned
 * off from the profile, accept exactly one allowlisted, non-interpolated context
 * and bind its text to a neutral per-analysis cwd.
 */
function validateRuntimeContexts(model, policy, errors) {
  const config = policy.effectiveConfig ?? {};
  const allowlist = config.runtimeContextAllowlist;
  const roots = config.analysisCwdRoots;
  const template = config.runtimeContextTextTemplate;

  if (!Array.isArray(allowlist) || allowlist.length !== 1) {
    errors.push('effectiveConfig.runtimeContextAllowlist is missing');
  }
  if (roots === null || typeof roots !== 'object' || Array.isArray(roots)) {
    errors.push('effectiveConfig.analysisCwdRoots is missing');
  }
  if (typeof template !== 'string' || template.length === 0) {
    errors.push('effectiveConfig.runtimeContextTextTemplate is missing');
  }

  const contexts = model?.runtimeContexts;
  if (!Array.isArray(contexts) || contexts.length !== 1) {
    errors.push('model: runtime context count must be exactly 1');
    return;
  }
  const context = contexts[0];
  if (Array.isArray(allowlist) && context?.name !== allowlist[0]) {
    errors.push('model: runtime context name is not allowlisted');
  }
  if (context?.interpolate !== false) {
    errors.push('model: runtime context must not be interpolated');
  }

  // Without the declared contract there is nothing to compare against; the
  // missing-key errors above already fail the manifest closed.
  if (roots === null || typeof roots !== 'object' || typeof template !== 'string') return;
  const neutralRoot = roots[process.platform];
  if (typeof neutralRoot !== 'string' || neutralRoot.length === 0) {
    errors.push('effectiveConfig.analysisCwdRoots is missing');
    return;
  }
  if (NON_NEUTRAL_TOKENS.some((token) => neutralRoot.includes(token))) {
    errors.push('effectiveConfig.analysisCwdRoots is not neutral');
  }

  const parts = template.split(CWD_PLACEHOLDER);
  if (parts.length !== 2) {
    errors.push('model: runtime context text does not match template');
    return;
  }
  const [prefix, suffix] = parts;
  const text = typeof context?.text === 'string' ? context.text : '';
  const match = new RegExp(`^${escapeRegExp(prefix)}([\\s\\S]+?)${escapeRegExp(suffix)}$`).exec(text);
  if (!match) {
    errors.push('model: runtime context text does not match template');
    return;
  }

  // The captured cwd is a JSON string body (upstream renders the path with
  // JSON.stringify), so decode it before any structural predicate. Comparing
  // raw text against `C:\Users` would invert the result.
  let cwd;
  try {
    cwd = JSON.parse(`"${match[1]}"`);
  } catch {
    errors.push('model: runtime context text does not match template');
    return;
  }
  // Re-render with the canonical JSON encoding of the decoded path: the template
  // already carries the surrounding quotes, so the encoded body is what belongs
  // between them. Anything else (extra text, changed quotes, different escaping)
  // means the captured line was not produced by the declared template.
  if (typeof cwd !== 'string' || `${prefix}${JSON.stringify(cwd).slice(1, -1)}${suffix}` !== text) {
    errors.push('model: runtime context text is not reproduced by the template');
  }
  /*
   * A literal `..` segment is never produced by the runtime, and resolving it
   * before the containment test is not enough on its own: `...\analysis\..\..\..\Windows`
   * is a legal absolute path whose *resolved* target sits outside the root while
   * its raw text still starts with the root. Reject un-normalized input outright,
   * then compare resolved paths so the prefix test cannot be decorrelated from
   * what the filesystem would actually open.
   */
  const normalizedSegments = cwd.split(/[\\/]/);
  if (!PATH_IMPL.isAbsolute(cwd)) errors.push('model: runtime context cwd is not absolute');
  if (normalizedSegments.includes('..')) {
    errors.push('model: runtime context cwd is not normalized');
  } else if (!PATH_IMPL.resolve(cwd).startsWith(`${PATH_IMPL.resolve(neutralRoot)}${PATH_IMPL.sep}`)) {
    errors.push('model: runtime context cwd is outside the neutral analysis root');
  }
  if (NON_NEUTRAL_TOKENS.some((token) => cwd.includes(token))) {
    errors.push('model: runtime context leaks a user or repository path');
  }
}

function validateModel(manifest, policy, errors) {
  const model = manifest.model;
  const tools = model?.tools;
  if (!Array.isArray(tools)) {
    errors.push('model: missing actual tool schemas');
  } else {
    if (JSON.stringify(tools.map((tool) => tool.name)) !== JSON.stringify(policy.allowedTools)) {
      errors.push(`model: tool surface differs: ${tools.map((tool) => tool.name).join(',')}`);
    }
    for (const tool of tools) {
      if (tool.parameters?.additionalProperties !== false) {
        errors.push(`model: tool ${tool.name} does not reject unknown arguments`);
      }
      if (tool.parameters?.type !== 'object' || !tool.parameters.properties) {
        errors.push(`model: tool ${tool.name} has invalid object schema`);
      }
      const forbidden = hasForbiddenImplementation(tool.name, policy.forbiddenImplementationPatterns);
      if (forbidden) errors.push(`model: high-risk tool ${tool.name}`);
    }
  }
  const sections = model?.promptSections ?? [];
  if (sections.some((section) => section.name === 'harness:identity')) {
    errors.push('model: Harness identity prompt is enabled');
  }
  if (sections.some((section) => !['deployment:persona-prefix', 'deployment:persona-suffix'].includes(section.name))) {
    errors.push('model: unapproved prompt section');
  }
  // ADR-0005 replaced "runtime contexts must be empty" with a single, allowlisted,
  // structurally bounded context; see validateRuntimeContexts.
  validateRuntimeContexts(model, policy, errors);
  validateExtensionFields(model, policy, errors);

  const providers = model?.providers;
  if (!Array.isArray(providers) || providers.length !== 1) {
    errors.push('model: exactly one static provider route is required');
  } else {
    const route = providers[0];
    if (route.provider !== policy.model.provider) errors.push('model: provider route differs');
    let url;
    try {
      url = new URL(route.baseURL);
    } catch {
      errors.push('model: baseURL is invalid');
    }
    if (url && (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '::1'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash)) {
      errors.push('model: baseURL must be a credential-free loopback endpoint');
    }
    if (route.remoteModelListing !== false) errors.push('model: remote /models listing is enabled');
    if (route.attachmentProviderPresent !== false) errors.push('model: attachment provider is present');
    if (route.extensionProviderPresent !== true) errors.push('model: DeepSeek extension registry is absent');
    if (route.maxTokens !== policy.model.maxTokens) errors.push('model: maxTokens differs');
    if (route.defaultContextWindow !== policy.model.contextWindow) errors.push('model: contextWindow differs');
    if (route.retryPolicy?.maxRetries !== 0) errors.push('model: automatic retry budget is not zero');
    if (!Array.isArray(route.models) || route.models.length !== 1) {
      errors.push('model: static model catalog must contain exactly one route');
    } else {
      const entry = route.models[0];
      if (entry.id !== policy.model.id) errors.push('model: static model id differs');
      if (entry.maxTokens !== policy.model.maxTokens) errors.push('model: static route maxTokens differs');
      if (entry.contextWindow !== policy.model.contextWindow) errors.push('model: static route contextWindow differs');
      if (JSON.stringify(entry.inputModalities) !== JSON.stringify(['text'])) {
        errors.push('model: route must be text-only');
      }
    }
  }

  const effective = model?.effective ?? {};
  const falseFlags = {
    automaticCompaction: 'automaticCompaction',
    sessionTitle: 'sessionTitle',
    llmRetry: 'llmRetryPlugin',
    telemetry: 'telemetry',
    stdoutLogger: 'stdoutLoggerPlugin',
    hmr: 'hmr',
    pluginManager: 'pluginManager',
    jobs: 'jobs',
    ptc: 'ptc',
    mcp: 'mcp',
    subagent: 'subagent',
    fsTools: 'fsTools',
    workingDirectoryTools: 'workingDirectoryTools',
    shellTools: 'shellTools',
    webTools: 'webTools',
  };
  for (const [contractName, actualName] of Object.entries(falseFlags)) {
    if (effective[actualName] !== false) errors.push(`model: ${contractName} is not proven disabled`);
  }

  if (manifest.stdio) {
    if (manifest.stdio.stderrBytes > policy.stderrMaxBytes) errors.push('stdio: stderr exceeds bound');
    if (manifest.stdio.control?.approvalRequests !== false) errors.push('stdio: approvals were not disabled');
    if (manifest.stdio.control?.userQuestions !== false) errors.push('stdio: user questions were not disabled');
    if (manifest.stdio.control?.maxTokens !== policy.model.maxTokens) errors.push('stdio: initialize maxTokens differs');
  }
}

export function validateFourLayerManifest(manifest, policy, approved) {
  const errors = [];
  if (manifest.profile !== policy.profile) errors.push('manifest: profile identity differs');
  if (manifest.upstream?.version !== policy.upstream.version) errors.push('manifest: upstream version differs');
  if (manifest.upstream?.commit !== policy.upstream.commit) errors.push('manifest: upstream commit differs');
  validatePackages(manifest, errors);
  validatePlugins(manifest, policy, approved, errors);
  validateServices(manifest, policy, errors);
  validateModel(manifest, policy, errors);
  return [...new Set(errors)];
}

export function assertValidFourLayerManifest(manifest, policy, approved) {
  const errors = validateFourLayerManifest(manifest, policy, approved);
  if (errors.length > 0) {
    const error = new Error(`Harness manifest rejected:\n${errors.map((entry) => `- ${entry}`).join('\n')}`);
    error.code = 'ERR_HARNESS_MANIFEST';
    error.errors = errors;
    throw error;
  }
  return true;
}
