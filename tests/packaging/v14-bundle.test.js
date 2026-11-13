/**
 * v14 payload contract (author PT-dove).
 *
 * The v13 bundle shipped only the stdio harness worker, so an installation had no
 * server and no UI. This suite is the regression test for that defect: it fails if
 * the delivered bundle stops containing a runnable daemon, a servable console, the
 * built-in rule packs, the bundled Node runtime, or a hash manifest that still
 * matches the bytes on disk.
 *
 * Everything here drives the *shipped* files — `<bundle>/apps/daemon/bin.js` and
 * `<bundle>/console/serve.mjs` — never the repository sources, and only through
 * the bundle's own `runtime/node/node.exe`. A suite that ran the repository copy
 * would pass on a bundle that cannot start.
 *
 * Bundle location: `dist/bundle/win32-x64-v14` under the repository, overridable
 * with `M14_BUNDLE_DIR`.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { reapAll, stop, trackedSpawn } from './child-reaper.mjs';
import { verifyManifestAgainstDisk } from './repro-compare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BUNDLE_ROOT = resolve(process.env.M14_BUNDLE_DIR ?? join(REPO_ROOT, 'dist', 'bundle', 'win32-x64-v14'));
/**
 * The profile the bundle under test must have been built from.
 *
 * Defaults to `daemon-console` so this suite keeps describing v14 exactly as it did.
 * v15 is the same payload plus the desktop shell, composed by the `desktop` profile;
 * pointing `M14_BUNDLE_DIR` at it and leaving this at the default would fail on a
 * name rather than on a defect, which is why the expectation is an input.
 */
const EXPECTED_PROFILE = process.env.M14_EXPECT_PROFILE ?? 'daemon-console';

/** Scratch lives inside the repository: the suite must not write anywhere else. */
const SCRATCH_ROOT = join(REPO_ROOT, 'dist', '_v14-selfcheck');

const NODE_EXE = join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe');
const DAEMON_ENTRY = join(BUNDLE_ROOT, 'apps', 'daemon', 'bin.js');
const CONSOLE_DIR = join(BUNDLE_ROOT, 'console');
const RULES_DIR = join(BUNDLE_ROOT, 'rules');

const bundleJson = () => JSON.parse(readFileSync(join(BUNDLE_ROOT, 'bundle.json'), 'utf8'));
const launchPlan = () => JSON.parse(readFileSync(join(BUNDLE_ROOT, 'launch', 'launch-plan.json'), 'utf8'));

/**
 * A leaked child is the one failure mode that produces no failing assertion: the
 * runner simply never exits. Reap every tracked child when the file finishes, and
 * fail with the pid if one refuses to die.
 */
after(async () => {
  await reapAll();
  for (const path of SCRATCH_DIRS) rmSync(path, { recursive: true, force: true });
});

/**
 * Scratch directories created by this process, removed when the file finishes.
 *
 * The directory is per-run (process id + a timestamp) instead of a fixed
 * `<SCRATCH_ROOT>/<name>`. A fixed name makes the scratch a *shared* resource: two
 * packaging runs against the same tree then seed the same directory, and whichever
 * one seeds first turns the other's `action: 'created'` assertion into `'unchanged'`
 * — a spurious red that says nothing about the payload. Sequential runs happened to
 * pass only because `scratchDir` cleaned the directory first, which in turn let one
 * run delete the files another run was about to assert on. The path stays inside the
 * repository (this suite must not write anywhere else); only the name is unique.
 */
const SCRATCH_DIRS = [];

function scratchDir(name) {
  const path = join(SCRATCH_ROOT, `${name}-${process.pid}-${Date.now().toString(36)}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  SCRATCH_DIRS.push(path);
  return path;
}

/** Run a shipped entry to completion with the bundled runtime. */
function run(args, { timeoutMs = 30_000, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const child = trackedSpawn(NODE_EXE, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { void stop(child, 'run timeout'); }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Start a long-running shipped entry and wait until it announces a port.
 *
 * The daemon writes one JSON object per line on **stderr** (its logger treats
 * stderr as the log stream and stdout as the data channel), while the console
 * shell announces on stdout. Watching both is not laziness: a watch that only
 * reads stdout would time out on a daemon that started perfectly.
 *
 * Reading the announcement is the only way to learn an ephemeral port, and it
 * also proves the process got past its own preflight instead of merely still
 * being alive.
 */
function startAnnouncing(args, { marker, timeoutMs = 30_000, env = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = trackedSpawn(NODE_EXE, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      // Await the kill here, not just fire it: a rejected announce used to leave the
      // process alive with its pipes attached, and the runner then waited forever.
      void stop(child, 'announce timeout');
      reject(new Error(`timed out waiting for "${marker}"; stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`));
    }, timeoutMs);
    /**
     * Two announcement shapes have to be accepted, because the bundle ships two
     * different programs:
     * - the daemon logs JSON Lines (one object per line);
     * - the console shell prints one pretty-printed object and keeps running.
     * A line-only parser therefore works for the daemon and never for the console,
     * which is exactly the bug this comment replaces.
     */
    const accept = (value) => {
      if (value === undefined) return false;
      if (!JSON.stringify(value).includes(marker)) return false;
      clearTimeout(timer);
      resolvePromise({ child, announcement: value, stdout: () => stdout, stderr: () => stderr });
      return true;
    };
    const inspect = () => {
      for (const buffer of [stdout, stderr]) {
        const trimmed = buffer.trim();
        if (trimmed.length === 0) continue;
        try {
          if (accept(JSON.parse(trimmed))) return;
        } catch {
          // Not a whole document; fall through to the line scan.
        }
        for (const line of trimmed.split(/\r?\n/)) {
          if (!line.includes(marker)) continue;
          try {
            if (accept(JSON.parse(line))) return;
          } catch {
            // A non-JSON line that merely mentions the marker is not the announcement.
          }
        }
      }
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; inspect(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; inspect(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited with ${code} before announcing "${marker}"; stderr=${stderr.slice(-800)}`));
    });
  });
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = await response.text();
  return { status: response.status, body, headers: response.headers };
}

/**
 * Seed the built-in rule pack into a data directory, the way the shipped launcher
 * does. The daemon refuses a rule pack outside `dataDir`, so this is not a
 * convenience: it is the only supported way to give a bundled pack to a bundled
 * daemon.
 */
async function seedRules(dataDir) {
  const result = await run([join(BUNDLE_ROOT, 'launch', 'seed-rules.mjs'), '--data-dir', dataDir]);
  assert.equal(result.code, 0, `seeder failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe('v14 payload: composition', () => {
  it('the delivered bundle exists where the profile says it does', () => {
    assert.ok(existsSync(join(BUNDLE_ROOT, 'bundle.json')),
      `no bundle at ${BUNDLE_ROOT}; build it with: node deploy/embedded-runtime/build.mjs --profile ${EXPECTED_PROFILE}`);
    assert.equal(bundleJson().bundleProfile.name, EXPECTED_PROFILE);
  });

  it('carries the four parts v13 lacked or must keep', () => {
    const required = [
      'apps/daemon/bin.js',          // forwarder the self-check types
      'console/index.html',          // the page an operator opens
      'console/serve.mjs',           // the only thing that serves it
      'runtime/node/node.exe',       // no Node on the target machine
      'manifests/files.sha256',      // integrity
      'manifests/rule-packs.json',   // what the seeder verifies against
      'launch/seed-rules.mjs',       // rule pack lives in the data dir, not the bundle
      'launch/launch-plan.json',
      'launch/aegis-daemon.cmd',
      'launch/aegis-console.cmd',
    ];
    for (const path of required) {
      assert.ok(existsSync(join(BUNDLE_ROOT, ...path.split('/'))), `missing from the bundle: ${path}`);
    }
    assert.ok(statSync(NODE_EXE).size > 1_000_000, 'the bundled node.exe is implausibly small');
  });

  it('stages at least one validated rule pack', () => {
    const { rules } = bundleJson();
    assert.ok(rules !== undefined, 'bundle.json has no rules section: a daemon with no rules detects nothing');
    assert.ok(rules.packs.length >= 1);
    for (const pack of rules.packs) {
      assert.ok(existsSync(join(BUNDLE_ROOT, ...pack.path.split('/'))), `rule pack missing: ${pack.path}`);
      assert.ok(pack.rules > 0, `${pack.path} declares no rules`);
      assert.match(pack.packId, /\S/);
      assert.equal(pack.sha256.length, 64);
    }
  });

  it('ships the product console, not only the packaging shell', () => {
    const { console: record } = bundleJson();
    assert.ok(record !== undefined, 'bundle.json has no console section');
    assert.equal(record.isProductUi, true, 'the staged console came from the packaging shell, so apps/console was empty');
    assert.equal(record.entry, 'console/index.html');
    assert.ok(existsSync(join(BUNDLE_ROOT, ...record.entry.split('/'))));
    if (record.serverFallback !== undefined) {
      // Pages from the product tree plus a server from the packaging tree is fine,
      // as long as it is stated. Silence is what would make it a surprise.
      assert.equal(record.serverFallback.path, 'console/serve.mjs');
      assert.equal(record.server, 'console/serve.mjs');
    }
  });

  it('the launch plan names a console server that exists', () => {
    const plan = launchPlan();
    assert.equal(plan.console.entry, 'console/index.html');
    assert.ok(plan.console.server !== undefined, 'launch plan promises no console server');
    assert.ok(existsSync(join(BUNDLE_ROOT, ...plan.console.server.split('/'))),
      `launch plan names a console server that is not in the bundle: ${plan.console.server}`);
    assert.equal(plan.daemon.entry, 'apps/daemon/bin.js');
  });

  it('the launch plan points the daemon at a rule pack inside the data directory', () => {
    const plan = launchPlan();
    assert.ok(Array.isArray(plan.daemon.argv));
    const argv = plan.daemon.argv;
    const rulesIndex = argv.indexOf('--rules');
    assert.ok(rulesIndex > 0, 'the launch plan passes no --rules');
    // The daemon resolves detection.rulePackPath inside dataDir, so the plan must
    // not advertise the bundle's own rules/ path: that argv is refused at startup.
    assert.match(argv[rulesIndex + 1], /<absolute data dir>/, `plan advertises a rule path the daemon refuses: ${argv[rulesIndex + 1]}`);
    assert.ok(existsSync(join(BUNDLE_ROOT, ...plan.daemon.builtInRulePack.split('/'))));
    assert.ok(existsSync(join(BUNDLE_ROOT, ...plan.daemon.seeder.split('/'))));
  });

  it('records the daemon entry and rule pack in bundle.json.paths', () => {
    const { paths } = bundleJson();
    assert.equal(paths.daemonEntry, 'apps/daemon/bin.js');
    assert.ok(existsSync(join(BUNDLE_ROOT, ...paths.daemonEntry.split('/'))));
    assert.match(paths.rules, /^rules\/.+\.json$/);
    assert.ok(existsSync(join(BUNDLE_ROOT, ...paths.rules.split('/'))));
  });
});

describe('v14 payload: manifest', () => {
  it('files.sha256 verifies every listed file against the bytes on disk', () => {
    const result = verifyManifestAgainstDisk(BUNDLE_ROOT);
    assert.equal(result.mismatched.length, 0, `differing: ${result.mismatched.slice(0, 5).join(', ')}`);
    assert.equal(result.unlisted.length, 0, `on disk but unlisted: ${result.unlisted.slice(0, 5).join(', ')}`);
    assert.equal(result.verified, result.listed);
    assert.ok(result.listed > 40_000, `implausibly few files: ${result.listed}`);
  });
});

describe('v14 payload: daemon', () => {
  it('node <bundle>/apps/daemon/bin.js --help exits 0', async () => {
    const result = await run([DAEMON_ENTRY, '--help']);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /aegis-daemon/);
    assert.match(result.stdout, /--data-dir/);
  });

  it('refuses to start without --rules, because no rules means detecting nothing', async () => {
    const dataDir = scratchDir('refuse');
    const result = await run([DAEMON_ENTRY, '--data-dir', dataDir, '--mock']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--rules/);
  });

  it('rejects a rule pack that lives outside the data directory', async () => {
    // This is the finding the seeder exists for: the bundle's own rules/ path is
    // the obvious thing to pass and the daemon refuses it. Pinning the refusal
    // means a future daemon that accepts it makes this suite say so, instead of
    // leaving the launcher doing an unnecessary copy.
    const dataDir = scratchDir('outside-rules');
    const result = await run([DAEMON_ENTRY, '--data-dir', dataDir, '--rules', join(RULES_DIR, 'defense-seed-pack.json'), '--mock']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /must stay inside the data directory/);
  });

  it('seeds the built-in pack into the data directory, idempotently', async () => {
    const dataDir = scratchDir('seeded');
    const first = await seedRules(dataDir);
    assert.equal(first.seeded.length, bundleJson().rules.packs.length);
    for (const row of first.seeded) {
      assert.equal(row.action, 'created');
      assert.ok(existsSync(row.path), `seeded file missing: ${row.path}`);
      assert.ok(row.path.startsWith(dataDir), 'the seeder wrote outside the data directory');
    }
    const second = await seedRules(dataDir);
    for (const row of second.seeded) assert.equal(row.action, 'unchanged');
  });

  it('serves /healthz 200 with --data-dir, seeded --rules and --mock', async () => {
    const dataDir = scratchDir('daemon');
    const seeded = await seedRules(dataDir);
    const rules = seeded.seeded[0].path;
    assert.ok(existsSync(rules), `rule pack missing: ${rules}`);
    const { child, announcement } = await startAnnouncing(
      [DAEMON_ENTRY, '--data-dir', dataDir, '--rules', rules, '--mock'],
      { marker: 'daemon ready' },
    );
    try {
      const port = announcement.address?.port ?? announcement.port;
      assert.ok(Number.isInteger(port) && port > 0, `no bound port in the announcement: ${JSON.stringify(announcement)}`);
      const health = await get(`http://127.0.0.1:${port}/healthz`);
      assert.equal(health.status, 200, `body: ${health.body}`);
      const body = JSON.parse(health.body);
      // `degraded` is the honest answer in mock mode: the store is in memory and no
      // collector is wired, so nothing is being collected. The gate is the 200 —
      // a 503 here would mean the process is up but refusing to work.
      assert.ok(['ok', 'degraded'].includes(body.status), `unexpected health status: ${body.status}`);
      assert.match(String(body.version), /\d+\.\d+\.\d+/);
    } finally {
      await stop(child, 'daemon');
    }
  });
});

describe('v14 payload: console', () => {
  it('serves index.html and proxies /healthz to the daemon', async () => {
    const dataDir = scratchDir('console-daemon');
    const seeded = await seedRules(dataDir);
    const daemon = await startAnnouncing(
      [DAEMON_ENTRY, '--data-dir', dataDir, '--rules', seeded.seeded[0].path, '--mock'],
      { marker: 'daemon ready' },
    );
    // The console spawn sits inside the same `try` as the daemon it talks to. When it
    // sat outside, a failed announce threw before `finally` existed and left the
    // daemon running — the leak that made this suite's runner never exit.
    let consoleServer;
    try {
      const port = daemon.announcement.address?.port ?? daemon.announcement.port;
      consoleServer = await startAnnouncing(
        [join(CONSOLE_DIR, 'serve.mjs'), '--daemon', `http://127.0.0.1:${port}`, '--port', '0'],
        { marker: 'listening' },
      );
      const url = consoleServer.announcement.listening;
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      const page = await get(`${url}index.html`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      const shipped = readFileSync(join(CONSOLE_DIR, 'index.html'), 'utf8');
      assert.equal(page.body, shipped, 'the served page is not the shipped page');

      // The two halves must be wired: the page is inert without the proxy, and a
      // proxy that answers from something other than the daemon proves nothing.
      const health = await get(`${url}healthz`);
      assert.equal(health.status, 200, `console proxy: ${health.body}`);
      assert.ok(['ok', 'degraded'].includes(JSON.parse(health.body).status), `console proxy body: ${health.body}`);
    } finally {
      await stop(consoleServer?.child, 'console server');
      await stop(daemon.child, 'daemon');
    }
  });

  it('refuses to bind a non-loopback interface', async () => {
    const result = await run([join(CONSOLE_DIR, 'serve.mjs'), '--daemon', 'http://127.0.0.1:9', '--host', '0.0.0.0']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /loopback-only/);
  });
});
