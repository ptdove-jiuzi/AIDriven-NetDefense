import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshot(value, seen = new Set()) {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (seen.has(value)) throw new Error('Circular runtime configuration');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => snapshot(entry, seen));
    if (typeof value === 'object') {
      if (typeof value.get === 'function' && Object.keys(value).length === 0) {
        return snapshot(value.get(), seen);
      }
      const result = {};
      for (const [key, entry] of Object.entries(value)) {
        const projected = snapshot(entry, seen);
        if (projected !== undefined) result[key] = projected;
      }
      return result;
    }
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function stateName(state) {
  return ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'][state] ?? `unknown:${state}`;
}

function injectOf(entry) {
  const exported = entry.moduleNamespace?.inject
    ?? entry.moduleNamespace?.default?.inject
    ?? entry.fiber?.runtime?.inject;
  if (Array.isArray(exported)) return [...exported];
  if (exported && typeof exported === 'object') return Object.keys(exported);
  return [];
}

function pluginRows(ctx) {
  return [...ctx.loader.entries()].map((entry, order) => {
    const fiber = entry.fiber;
    const missing = fiber && fiber.state !== 2
      ? Object.keys(fiber.inject ?? {}).filter((name) => fiber.ctx.get(name) === undefined)
      : [];
    return {
      order,
      id: entry.id,
      package: entry.options.name,
      disabled: entry.disabled,
      state: fiber ? stateName(fiber.state) : 'unresolved',
      exportedName: entry.moduleNamespace?.name ?? entry.moduleNamespace?.default?.name ?? fiber?.runtime?.name ?? null,
      configuredInject: Array.isArray(entry.options.inject)
        ? [...entry.options.inject]
        : entry.options.inject && typeof entry.options.inject === 'object'
          ? Object.keys(entry.options.inject)
          : [],
      exportedInject: injectOf(entry),
      resolvedInject: Object.keys(fiber?.inject ?? {}),
      missingServices: missing,
      patch: {
        source: 'cordis.patch.yml',
        baseUrl: entry.parent.tree.ctx.baseUrl ?? null,
      },
      config: snapshot(fiber?.effectiveConfig ?? entry.options.config ?? {}),
    };
  });
}

function serviceRows(ctx) {
  const rows = [];
  const seen = new Set();
  for (const key of Reflect.ownKeys(ctx.reflect.store)) {
    const implementation = ctx.reflect.store[key];
    if (!implementation?.name || seen.has(implementation)) continue;
    seen.add(implementation);
    rows.push({
      name: implementation.name,
      provider: implementation.fiber?.entry?.id ?? 'dsh-launcher',
      providerPackage: implementation.fiber?.entry?.options?.name ?? '@deepseek-ai/dsh',
      state: stateName(implementation.fiber?.state),
      scope: typeof key === 'symbol' ? key.toString() : String(key),
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name, 'en')
    || left.provider.localeCompare(right.provider, 'en'));
}

function modelRows(ctx) {
  const rows = [];
  const llm = ctx.get('llm');
  for (const [provider, registration] of llm?.adapters ?? []) {
    const adapter = registration.adapter;
    const connection = adapter?.dependencies?.options?.();
    rows.push({
      provider,
      info: adapter?.providerInfo?.(provider) ?? null,
      baseURL: connection?.baseURL ?? null,
      models: snapshot(connection?.models ?? []),
      maxTokens: connection?.maxTokens ?? null,
      defaultContextWindow: connection?.defaultContextWindow ?? null,
      retryPolicy: snapshot(adapter?.providerRetryPolicy?.(provider) ?? connection?.retryPolicy ?? null),
      remoteModelListing: connection?.listing !== undefined,
      attachmentProviderPresent: adapter?.dependencies?.resolveAttachments?.() !== undefined,
      extensionProviderPresent: ctx.get('deepseekLlmApiExtensions') !== undefined,
    });
  }
  return rows;
}

/*
 * ADR-0004 §3.3: the set of top-level request fields handed to the official
 * adapter must be closed. `providers` is a class field of the upstream registry
 * rather than a documented API, so the shape is checked *before* use: a missing
 * or renamed field must read as "unverifiable" (fail closed), never as
 * "empty set = allowed".
 */
function extensionFieldRows(root) {
  try {
    const registry = root.get('deepseekLlmApiExtensions');
    const providers = registry?.providers;
    if (!(providers instanceof Map)) return { verifiable: false, fields: [] };
    return { verifiable: true, fields: [...providers.keys()].sort() };
  } catch {
    return { verifiable: false, fields: [] };
  }
}

/*
 * ADR-0005 §7.1: assembling without an agent makes `working-directory` return
 * `""`, so the captured context text says nothing about the real request. The
 * stub is the minimum shape upstream reads: `session.header.cwd` and `append`
 * for working-directory, `ctx.fiber.assertActive` for its recovery guard,
 * `inject` for its directory-change notice, and `options` for agent-loop's
 * `provider`/`model` system-prompt variables. It adds no dependency and never
 * runs in production: the capture itself only happens when
 * AEGIS_RUNTIME_MANIFEST is set.
 */
function contextProbeAgent() {
  // The stub exists only to make a *captured* manifest representative; when no
  // manifest is being written there is nothing to capture, so no stub is built.
  // Keep this guard in step with the comment above and with scheduleRuntimeManifest.
  if (!process.env.AEGIS_RUNTIME_MANIFEST) return undefined;
  const cwd = process.env.AEGIS_ANALYSIS_CWD;
  if (!cwd) return undefined;
  return {
    session: {
      header: { cwd },
      inheritedEventCount: 0,
      seq: 0,
      snapshotEvents: () => [],
      append() {},
    },
    ctx: { fiber: { assertActive() {} } },
    options: {},
    inject() {},
  };
}

export async function captureRuntimeManifest(ctx) {
  const root = ctx.root;
  const profileContext = root.get('profileContext');
  const systemPrompt = root.get('systemPrompt');
  if (!systemPrompt) throw new Error('Missing systemPrompt during runtime capture');
  const stubAgent = contextProbeAgent();
  let captureError;
  let assembly;
  try {
    assembly = await systemPrompt.assemble(stubAgent ? { agent: stubAgent } : {});
  } catch (error) {
    /*
     * The probe agent needs live services (working-directory stats the cwd), so a
     * capture that races shutdown is recorded instead of hidden. The degraded
     * assembly keeps the rest of the layers observable; because its context text
     * is empty, four-layer validation fails closed instead of accepting it.
     */
    captureError = error;
    assembly = await systemPrompt.assemble({});
  }
  const plugins = pluginRows(root);
  const active = plugins.filter((entry) => !entry.disabled && entry.state === 'active');
  const hasActive = (pattern) => active.some((entry) => `${entry.id} ${entry.package}`.toLowerCase().includes(pattern));
  const patchPath = profileContext?.patchPath;
  const profileDir = profileContext?.dir;
  const overlays = (profileContext?.overlays ?? []).map((overlay, index) => ({
    index,
    source: overlay.source ?? overlay.path ?? 'command-line-overlay',
    value: snapshot(overlay),
  }));
  return {
    schemaVersion: '1.0',
    ...(captureError ? { captureError: String(captureError), captureStack: captureError?.stack } : {}),
    capturedFrom: 'live-cordis-runtime',
    plugins: {
      entries: plugins,
      patchSources: [
        ...(patchPath ? [{ path: patchPath, sha256: sha256(patchPath) }] : []),
        ...(profileDir ? [{ path: join(profileDir, 'package.json'), sha256: sha256(join(profileDir, 'package.json')) }] : []),
      ],
      overlays,
      startedBundles: [...(profileContext?.startedBundles ?? [])],
    },
    services: {
      providers: serviceRows(root),
      inject: plugins.map((entry) => ({
        consumer: entry.id,
        configured: entry.configuredInject,
        exported: entry.exportedInject,
        resolved: entry.resolvedInject,
        missing: entry.missingServices,
      })),
    },
    model: {
      tools: snapshot(assembly.tools),
      promptSections: snapshot(assembly.sections),
      runtimeContexts: snapshot(assembly.contexts),
      extensionFields: extensionFieldRows(root),
      providers: modelRows(root),
      effective: {
        automaticCompaction: hasActive('compaction'),
        sessionTitle: hasActive('session-title'),
        llmRetryPlugin: hasActive('llm-retry'),
        telemetry: hasActive('telemetry') || hasActive('otel'),
        stdoutLoggerPlugin: hasActive('stdout') || hasActive('logger'),
        hmr: hasActive('hmr'),
        jobs: hasActive('jobs'),
        ptc: hasActive('ptc'),
        mcp: hasActive('mcp'),
        subagent: hasActive('subagent'),
        pluginManager: hasActive('plugin-manager'),
        fsTools: assembly.tools.some((tool) => /(?:^|\.)(?:fs|file|read|write|edit|glob|grep)(?:\.|$)/i.test(tool.name)),
        workingDirectoryTools: assembly.tools.some((tool) => /working[-_.]?directory|(?:^|\.)cd(?:\.|$)/i.test(tool.name)),
        shellTools: assembly.tools.some((tool) => /shell|bash|pwsh|terminal|pty|subprocess/i.test(tool.name)),
        webTools: assembly.tools.some((tool) => /web|browser/i.test(tool.name)),
      },
    },
  };
}

export function scheduleRuntimeManifest(ctx) {
  const output = process.env.AEGIS_RUNTIME_MANIFEST;
  if (!output) return;
  ctx.loader.await()
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(captureRuntimeManifest.bind(null, ctx))
    .then((manifest) => {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    }, (error) => {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify({ schemaVersion: '1.0', captureError: String(error), stack: error?.stack }, null, 2)}\n`, { flag: 'wx' });
    });
}
