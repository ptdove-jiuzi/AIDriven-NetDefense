/**
 * M8 `session/prompt` smoke against a stubbed broker (author PT-dove).
 *
 * Why this file exists: the trim gate proves "no *reachable* file names a pruned
 * package" from a static module graph, and the boot test proves the worker reaches
 * the stdio stage. Neither of them executes the one code path that only runs when
 * a prompt is sent — the model transport. Release review therefore recorded the
 * prompt path as unverified (`P1-4`).
 *
 * This test closes that gap without inventing a credential and without permitting
 * egress:
 *
 * - a loopback stub broker (`stub-broker.mjs`) answers the real Messages wire
 *   protocol on `127.0.0.1:<ephemeral>`;
 * - the bundled runtime is launched with the shipped preparer, a sanitised PATH,
 *   the tripwire armed and the runtime module tracer attached;
 * - the only allowed network destination is that one loopback port. Every other
 *   connect still throws, and every attempt is recorded, so "it only talked to
 *   the stub" is measured rather than asserted.
 *
 * The assertion that matters for packaging: **the number of pruned packages
 * loaded during the prompt path is zero**. A package the trim removed that only
 * the model path needs would show up here and nowhere else.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startStubBroker } from './stub-broker.mjs';
import { reapAll, trackedSpawn } from './child-reaper.mjs';
import { defaultBundleRoot, readPlan, resolvePlanPaths } from './bundle-locator.mjs';
import { sha256File } from '../../deploy/embedded-runtime/lib/stage.mjs';

after(async () => {
  await reapAll();
});

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The bundle stores no build-host path, so the launch plan is resolved against
// the root under test, the same way a shipped launcher resolves it.
const BUNDLE_ROOT = defaultBundleRoot();
const TRIPWIRE = join(REPO_ROOT, 'tests', 'packaging', 'network-tripwire.mjs');
const MODULE_TRACE = join(REPO_ROOT, 'tests', 'packaging', 'module-trace.mjs');
const SANITIZED_PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem';
// Arbitrary but fixed: the stub echoes it back inside the assistant turn, which is
// how the test proves the reply travelled through the bundled transport.
const SESSION_ID = 'm8-prompt-smoke';
const PROMPT_TEXT = 'Synthetic harmless M8 prompt-path smoke; no evidence is analyzed.';

function buildEnvironment(extra = {}) {
  return {
    PATH: SANITIZED_PATH,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    SystemDrive: process.env.SystemDrive ?? 'C:',
    ComSpec: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    OS: 'Windows_NT',
    ...extra,
  };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, milliseconds);
    timer.unref();
  });
}

function loadPlan() {
  // `readPlan` returns the shipped bytes with bundle-relative paths; resolving
  // them here is what a launcher does, so the tests exercise the convention.
  return resolvePlanPaths(readPlan(BUNDLE_ROOT), BUNDLE_ROOT);
}

/**
 * The sibling suites may build the bundle concurrently, so a missing marker is
 * not a licence to build a second time into the same directory: wait for the
 * other build first, and only build when nobody else is going to.
 */
async function ensureBundle() {
  const marker = join(BUNDLE_ROOT, 'bundle.json');
  if (existsSync(marker)) return;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return;
    await sleep(500);
    if (!existsSync(join(BUNDLE_ROOT, 'launch'))) break;
  }
  if (existsSync(marker)) return;
  const args = [join(REPO_ROOT, 'deploy', 'embedded-runtime', 'build.mjs'), '--out', BUNDLE_ROOT];
  if (process.env.M8_NODE_LICENSE) args.push('--node-license', process.env.M8_NODE_LICENSE);
  if (process.env.M8_NODE_LICENSE_ATTESTATION) args.push('--node-license-attestation', process.env.M8_NODE_LICENSE_ATTESTATION);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(result.status, 0, `bundle build failed:\n${result.stderr ?? ''}${result.stdout ?? ''}`);
}

function readTripwireLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

function tracePackages(logPath) {
  assert.ok(existsSync(logPath), 'the module tracer produced no log at all');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0);
  assert.equal(lines.filter((line) => line.startsWith('<tracer-armed>')).length, 1,
    'the tracer must prove it was armed, otherwise an empty trace proves nothing');
  const names = new Set();
  const cache = new Map();
  for (const line of lines) {
    if (line.startsWith('<tracer-armed>')) continue;
    let directory = dirname(line);
    for (let guard = 0; guard < 32; guard += 1) {
      if (cache.has(directory)) {
        const cached = cache.get(directory);
        if (cached !== undefined) names.add(cached);
        break;
      }
      const manifestPath = join(directory, 'package.json');
      if (existsSync(manifestPath)) {
        let name;
        try {
          name = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
        } catch {
          name = undefined;
        }
        cache.set(directory, name);
        if (typeof name === 'string') names.add(name);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return names;
}

/** Every file under `root`, for the session-log proof. */
function walkFiles(root, found = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, found);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function createAttempt(plan, brokerURL) {
  const policy = JSON.parse(readFileSync(join(plan.profile.sourceMirror, 'profile.json'), 'utf8'));
  const neutralRoot = policy.effectiveConfig.analysisCwdRoots[process.platform];
  const root = join(neutralRoot, `m8-prompt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  try {
    const prepared = spawnSync(plan.node.executable, [
      plan.profile.preparer,
      '--root', root,
      '--broker-base-url', brokerURL,
      // A stub-only token: the provider reads it from the environment, and the
      // bundle never records it.
      '--broker-token', 'm8-stub-broker-token-not-a-credential',
    ], { encoding: 'utf8', env: buildEnvironment() });
    assert.equal(prepared.status, 0, `prepare-attempt failed: ${prepared.stderr}`);
    const attempt = JSON.parse(prepared.stdout);
    assert.equal(attempt.root, root);
    assert.equal(attempt.env.AEGIS_BROKER_BASE_URL, brokerURL, 'the attempt must point at the stub broker');
    for (const key of ['home', 'tmp', 'cwd', 'session', 'dshHome', 'profileDir', 'toolsDir']) {
      assert.ok(attempt[key].startsWith(root), `${key} must stay inside the attempt root`);
    }
    attempt.tripwireLog = join(root, 'session', 'net.log');
    attempt.moduleTraceLog = join(root, 'session', 'modules.log');
    return attempt;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Newline-delimited JSON-RPC driver that also keeps notifications, because a
 * streamed model turn necessarily emits them and an unexpected one must fail.
 */
function driveWorker({ command, args, cwd, env, timeoutMs = 120000 }) {
  const child = trackedSpawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const frames = [];
  const notifications = [];
  const pending = new Map();
  let stdoutBuffer = '';
  let stderr = '';
  let nextId = 1;
  let failure;

  const exit = new Promise((resolveExit) => {
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    for (let index = stdoutBuffer.indexOf('\n'); index >= 0; index = stdoutBuffer.indexOf('\n')) {
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        failure ??= new Error(`non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      frames.push(frame);
      if (frame.id === undefined && typeof frame.method === 'string') {
        notifications.push(frame);
        continue;
      }
      const waiter = pending.get(frame.id);
      if (waiter === undefined) continue;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(Object.assign(new Error(frame.error.message), { rpcError: frame.error }));
      else waiter.resolve(frame.result);
    }
  });

  function request(method, params = {}) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    const answer = new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        rejectRequest(new Error(`JSON-RPC ${method} timed out; stderr so far:\n${stderr}\nframes: ${JSON.stringify(frames).slice(0, 2000)}`));
      }, timeoutMs);
      timer.unref();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return answer;
  }

  return {
    request,
    frames,
    notifications,
    get stderr() {
      return stderr;
    },
    exit,
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
    },
  };
}

test('session/prompt reaches a stubbed broker and loads no pruned package', async () => {
  await ensureBundle();
  const plan = loadPlan();
  const broker = await startStubBroker();
  const attempt = createAttempt(plan, broker.url);
  const driver = driveWorker({
    command: plan.node.executable,
    args: [plan.worker.entry, ...plan.worker.argv],
    cwd: attempt.cwd,
    env: buildEnvironment({
      ...attempt.env,
      DSH_HOME: attempt.dshHome,
      NODE_OPTIONS: `--import ${pathToFileURL(TRIPWIRE).href} --import ${pathToFileURL(MODULE_TRACE).href}`,
      M8_TRIPWIRE_LOG: attempt.tripwireLog,
      // The single exception to "no egress": the loopback stub. Everything else
      // still throws, and the log distinguishes the two kinds.
      M8_TRIPWIRE_ALLOW: `127.0.0.1:${broker.port}`,
      M8_MODULE_TRACE: attempt.moduleTraceLog,
    }),
  });

  try {
    const initialize = await driver.request('initialize', {
      cwd: attempt.cwd,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxTokens: 2000,
      approvalRequests: false,
      capabilities: { userQuestions: false },
    });
    assert.equal(initialize.serverInfo.name, 'deepseek-harness-sdk-runtime');

    const prompt = await driver.request('session/prompt', {
      sessionId: SESSION_ID,
      contentBlocks: [{ type: 'text', text: PROMPT_TEXT }],
    });
    assert.equal(typeof prompt.messageId, 'string', 'session/prompt must accept the turn and return a message id');

    const wait = await driver.request('session/wait', { sessionId: SESSION_ID });
    assert.deepEqual(wait, {}, 'session/wait must settle the turn without error');

    await driver.request('shutdown');
    const exit = await Promise.race([driver.exit, sleep(120000).then(() => ({ code: 'timeout', signal: null }))]);
    assert.deepEqual(exit, { code: 0, signal: null }, `the prompt path must exit cleanly; stderr:\n${driver.stderr}`);

    // 1. The transport really ran: one Messages request, carrying the reviewed
    //    model id and the loopback credential the profile asked for.
    assert.equal(broker.requests.length, 1, `expected exactly one model request, saw ${broker.requests.length}`);
    const request = broker.requests[0];
    assert.equal(request.method, 'POST');
    assert.match(request.url, /\/anthropic\/v1\/messages$/, `unexpected broker route: ${request.url}`);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.body?.model, 'deepseek-chat');
    assert.equal(request.body?.stream, true, 'the provider must request a streamed answer');
    assert.ok(Array.isArray(request.body?.messages) && request.body.messages.length > 0, 'the prompt must be serialised');
    const toolNames = (request.body?.tools ?? []).map((tool) => tool.name);
    for (const required of ['evidence.get_summary', 'analysis.submit_result']) {
      assert.ok(toolNames.includes(required), `the model request must advertise ${required}, saw ${toolNames.join(', ')}`);
    }
    assert.ok(JSON.stringify(request.body).includes(PROMPT_TEXT), 'the user text must reach the transport');

    // 2. The answer was consumed, not just requested: the stub's text lands in
    //    the persisted session, which only happens after the stream is decoded.
    const logs = walkFiles(attempt.session).filter((path) => path.endsWith('.jsonl') || path.endsWith('.json'));
    assert.ok(logs.length > 0, 'the session must be persisted under the attempt root');
    const transcript = logs.map((path) => readFileSync(path, 'utf8')).join('\n');
    assert.ok(transcript.includes(broker.replyText), 'the streamed assistant turn must be recorded in the session');
    for (const path of logs) assert.ok(statSync(path).size > 0, `empty session artifact: ${path}`);

    // 3. Network discipline: only the loopback stub was contacted, nothing was
    //    blocked, and every allowed connection names the stub port.
    const records = readTripwireLog(attempt.tripwireLog);
    assert.equal(records.filter((entry) => entry.kind === 'armed').length, 1, 'the tripwire must prove it was armed');
    const blocked = records.filter((entry) => entry.kind !== 'armed' && entry.kind !== 'net.allowed');
    assert.deepEqual(blocked, [], 'the prompt path must not attempt any connection other than the stub');
    const allowedConnects = records.filter((entry) => entry.kind === 'net.allowed');
    assert.ok(allowedConnects.length > 0, 'the stub connection must be recorded, otherwise the allowlist was not exercised');
    for (const entry of allowedConnects) {
      assert.equal(entry.detail, `127.0.0.1:${broker.port}`, `an unexpected destination was allowed: ${entry.detail}`);
    }

    // 4. The packaging claim this file exists for.
    const loaded = tracePackages(attempt.moduleTraceLog);
    const trim = JSON.parse(readFileSync(join(BUNDLE_ROOT, 'manifests', 'trim-report.json'), 'utf8'));
    const prunedNames = new Set(trim.pruned.map((row) => row.name));
    const prunedButLoaded = [...loaded].filter((name) => prunedNames.has(name));
    assert.deepEqual(prunedButLoaded, [], 'the prompt path loaded a package the trim report removed');
    // The model transport is the one path a static graph is least able to cover,
    // so the licence-blocking package is asserted by name here as well.
    for (const name of ['dfa', 'fontkit', '@deepseek-ai/libreoffice-kit']) {
      assert.equal(loaded.has(name), false, `the prompt path loaded ${name}, which the trim removed`);
    }
    for (const required of [
      '@deepseek-ai/dsh-llm-deepseek',
      'eventsource-parser',
      '@aegisharness/dsh-defense-tools',
    ]) {
      assert.ok(loaded.has(required), `the tracer must observe ${required}, otherwise the prompt path was not exercised`);
    }
    assert.ok(loaded.size > 30, `the trace saw only ${loaded.size} packages, which is too few to be a prompt path`);

    // 5. The launch must not have mutated the shipped bundle.
    const manifestPath = join(BUNDLE_ROOT, 'manifests', 'files.sha256');
    const rows = readFileSync(manifestPath, 'utf8').split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
    const sample = rows.filter((_, index) => index % 997 === 0);
    assert.ok(sample.length > 0, 'the hash manifest must not be empty');
    for (const line of sample) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      assert.ok(match !== null, `malformed manifest row: ${line}`);
      assert.equal(sha256File(join(BUNDLE_ROOT, match[2])), match[1], `the prompt path mutated ${match[2]}`);
    }
  } finally {
    driver.kill();
    await broker.close();
    rmSync(attempt.root, { recursive: true, force: true });
  }
});

test('the stub broker refuses a route it does not implement', async () => {
  // The stub is only useful as evidence if it would fail on the wrong request:
  // a 404 here means the assertion in the test above cannot be satisfied by a
  // server that answers everything.
  const broker = await startStubBroker();
  try {
    const response = await fetch(`${broker.url}/v1/complete`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error.type, 'not_found_error');
    assert.equal(broker.requests.length, 1);
    assert.equal(broker.requests[0].url, '/anthropic/v1/complete');
  } finally {
    await broker.close();
  }
});

test('the loopback allowlist does not weaken the tripwire for anything else', async () => {
  // Proves the allowlist is narrow: the same env that permits the stub still
  // blocks a connect to a *different* loopback port, and the block is recorded.
  const broker = await startStubBroker();
  const root = mkdtempSync(join(tmpdir(), 'm8-allow-'));
  const log = join(root, 'net.log');
  try {
    const script = join(root, 'probe.mjs');
    mkdirSync(join(root, 'session'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(script, [
      "import net from 'node:net';",
      'const socket = net.connect({ host: \'127.0.0.1\', port: Number(process.argv[2]) });',
      "socket.on('error', (error) => { process.stdout.write(String(error.code)); process.exit(0); });",
      "socket.on('connect', () => { process.stdout.write('connected'); socket.destroy(); process.exit(0); });",
      '',
    ].join('\n'));
    const runWith = (port) => spawnSync(process.execPath, [
      '--import', pathToFileURL(TRIPWIRE).href, script, String(port),
    ], {
      encoding: 'utf8',
      env: buildEnvironment({
        M8_TRIPWIRE_LOG: log,
        M8_TRIPWIRE_ALLOW: `127.0.0.1:${broker.port}`,
      }),
    });

    const allowed = runWith(broker.port);
    assert.equal(allowed.stdout.trim(), 'connected', `the allowlisted port must be reachable: ${allowed.stderr}`);

    // A port that is almost certainly closed and definitely not allowlisted. The
    // tripwire throws synchronously, so the failure surfaces as an uncaught
    // exception rather than through the socket's `error` event — that is exactly
    // what "the call never reached the network stack" looks like.
    const other = runWith(broker.port + 1);
    assert.notEqual(other.status, 0, 'an unlisted port must not connect');
    assert.equal(other.stdout.trim(), '', 'the refused connect must not report success');
    assert.match(other.stderr, /ERR_M8_NETWORK_BLOCKED|M8 tripwire blocked/);

    const records = readTripwireLog(log);
    assert.ok(records.some((entry) => entry.kind === 'net.allowed'), 'the allowed connection must be recorded');
    const blockedRecords = records.filter((entry) => entry.kind !== 'armed' && entry.kind !== 'net.allowed');
    assert.equal(blockedRecords.length, 1, 'the refused connection must be recorded exactly once');
    assert.equal(blockedRecords[0].detail, `127.0.0.1:${broker.port + 1}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await broker.close();
  }
});

test('the prompt-path bundle is the reviewed one, not the untrimmed baseline', () => {
  // Guard against pointing this suite at the 654-package baseline by accident:
  // the pruned-package assertion above would then be vacuous.
  const trimPath = join(BUNDLE_ROOT, 'manifests', 'trim-report.json');
  assert.ok(existsSync(trimPath), `missing trim report at ${trimPath}`);
  const trim = JSON.parse(readFileSync(trimPath, 'utf8'));
  assert.ok(trim.summary.prunedNames > 100, `expected a trimmed bundle, saw ${trim.summary.prunedNames} pruned names`);
  assert.ok(trim.summary.keptPackages < trim.summary.closurePackages,
    'the bundle under test must be the pruned one');
  assert.ok(isAbsolute(BUNDLE_ROOT));
});
