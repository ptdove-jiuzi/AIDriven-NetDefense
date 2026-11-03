import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSnapshotGuard,
  createTestSandbox,
} from '@aegisharness/test-support';
import {
  buildFourLayerManifest,
  DSH_BIN,
  readJson,
  runStdioProbe,
  sha256File,
  stageAegisAnalysis,
} from '@aegisharness/harness-adapter';
import { startLocalBroker } from './local-broker.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidenceDir = join(root, 'tests', 'wp0', 'evidence');
const fixture = join(root, 'tests', 'fixtures', 'synthetic-security-events.json');
const diagnosticOverlay = join(root, 'tests', 'fixtures', 'upstream-required-service.probe.yml');

export const policy = readJson(join(root, 'plugins', 'dsh-defense-profile', 'profile.json'));
export const approved = readJson(join(root, 'plugins', 'dsh-defense-profile', 'approved-hashes.json'));
export const packageLayer = readJson(join(evidenceDir, 'harness-package-layer.json'));

export function saveEvidence(name, value) {
  const path = join(evidenceDir, name);
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text);
  return path;
}

/*
 * ADR-0005 §7.6: the per-analysis cwd must live under a neutral deployment root,
 * never under the OS user profile and never inside the repository. Tests use the
 * same root the broker is required to use, so `staged.cwd` is representative.
 */
export const ANALYSIS_ROOT = process.platform === 'win32'
  ? 'C:\\ProgramData\\AegisHarness\\analysis'
  : '/var/lib/aegis/analysis';

function ensureAnalysisRoot() {
  try {
    mkdirSync(ANALYSIS_ROOT, { recursive: true });
  } catch (error) {
    // No silent fallback to %TEMP%: that would reintroduce the user-profile path
    // the whole assertion exists to forbid, and the failure would be invisible.
    const wrapped = new Error(
      `Cannot create the neutral analysis root ${ANALYSIS_ROOT}: ${error?.message ?? String(error)}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }
  return ANALYSIS_ROOT;
}

const SANDBOX_PREFIX = 'aegisharness-wp0b-';
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };

/*
 * A crashed or timed-out run leaves its sandbox behind, and `mkdirSync` keeps
 * accepting new ones, so the analysis root grew unbounded (53 directories /
 * 13 MB when this was added). Sweep directories that are clearly not from a live
 * run: matching prefix and an mtime older than two hours. A sweep failure must
 * never fail the test — it is cache hygiene, not an assertion.
 */
function sweepStaleSandboxes(baseRoot) {
  let names;
  try {
    names = readdirSync(baseRoot);
  } catch (error) {
    console.warn(`harness sandbox sweep skipped for ${baseRoot}: ${error?.message ?? String(error)}`);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const path = join(baseRoot, name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory() || Date.now() - stat.mtimeMs < STALE_AFTER_MS) continue;
      rmSync(path, REMOVE_OPTIONS);
      removed += 1;
    } catch (error) {
      console.warn(`harness sandbox sweep could not remove ${path}: ${error?.message ?? String(error)}`);
    }
  }
  return removed;
}

export function createHarnessSandbox(t) {
  const analysisRoot = ensureAnalysisRoot();
  sweepStaleSandboxes(analysisRoot);
  const sandbox = createTestSandbox({
    prefix: SANDBOX_PREFIX,
    parentDir: analysisRoot,
  });
  copyFileSync(fixture, join(sandbox.mockRealRoot, 'security-events.json'));
  const guard = createSnapshotGuard({
    sandboxRoot: sandbox.root,
    protectedRoot: sandbox.mockRealRoot,
    sandboxBase: ANALYSIS_ROOT,
  });
  const before = guard.capture();
  t.after(() => {
    guard.assertUnchanged(before);
    /*
     * Deletion is retried because Windows keeps handles open for a moment after
     * a child process exits. A sandbox that still survives is reported, not
     * asserted: the underlying cause is not identified yet, and turning "cannot
     * delete" into a red test would only make the suite flaky without fixing it.
     */
    try {
      sandbox.cleanup();
    } catch (error) {
      console.error(`harness sandbox cleanup failed for ${sandbox.root}: ${error?.message ?? String(error)}`);
      try {
        rmSync(sandbox.root, REMOVE_OPTIONS);
      } catch (retryError) {
        console.error(`harness sandbox cleanup retry failed for ${sandbox.root}: ${retryError?.message ?? String(retryError)}`);
      }
    }
    if (existsSync(sandbox.root)) {
      console.error(`harness sandbox still exists after cleanup: ${sandbox.root}`);
    }
  });
  return sandbox;
}

export async function runHarnessProbe({
  sandbox,
  mode = 'shutdown',
  overlay = false,
  brokerMode,
  sessionId = 'wp0-analysis',
  workerScript = DSH_BIN,
} = {}) {
  const broker = brokerMode ? await startLocalBroker(brokerMode) : undefined;
  try {
    const attemptRoot = join(sandbox.workRoot, 'attempt');
    const staged = stageAegisAnalysis({
      root: attemptRoot,
      ...(broker ? { brokerBaseURL: broker.baseURL } : {}),
    });
    const stdio = await runStdioProbe({
      script: workerScript,
      scriptArgs: [
        '--profile',
        'aegis-analysis',
        ...(overlay ? ['--patch', diagnosticOverlay] : []),
      ],
      cwd: staged.cwd,
      env: staged.env,
      mode: brokerMode ? 'model' : mode,
      sessionId,
      timeoutMs: 25000,
    });
    const runtime = mode === 'eof' ? undefined : readJson(staged.runtimeManifest);
    const overlayEvidence = overlay ? [{
      path: relative(root, diagnosticOverlay).split(sep).join('/'),
      sha256: sha256File(diagnosticOverlay),
      approved: false,
      role: 'diagnostic-only unapproved-plugin probe',
    }] : undefined;
    // An EOF probe kills the worker on stdin close, so no live runtime snapshot can
    // exist: reading one would race service teardown and record a false "empty"
    // tool/context surface. That probe only asserts stdio behaviour.
    const manifest = runtime
      ? buildFourLayerManifest({ policy, packageLayer, runtime, stdio, overlayEvidence })
      : undefined;
    return {
      staged,
      stdio,
      runtime,
      manifest,
      broker: broker ? {
        baseURL: broker.baseURL,
        requests: broker.requests.map((request) => ({
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(Object.entries(request.headers)
            .filter(([name]) => name !== 'x-api-key' && name !== 'authorization' && name !== 'cookie')),
          body: request.body,
        })),
      } : undefined,
    };
  } finally {
    await broker?.close();
  }
}

export function terminalEvents(stdio) {
  return stdio.frames
    .filter((frame) => frame.method === 'session.event')
    .map((frame) => frame.params.event)
    .filter((event) => ['assistant/attempt', 'turn/end', 'llm/retry', 'llm/retry-started', 'compaction/start', 'compaction/end'].includes(event.type));
}
