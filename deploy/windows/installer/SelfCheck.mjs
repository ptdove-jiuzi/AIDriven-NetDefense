// AIDriven NetDefense - post-install self check
// Author: PT-dove
//
// The bundled worker refuses to start unless its environment is produced by
// launch/prepare-attempt.mjs: an empty, attempt-scoped directory under the
// profile's declared analysis root, plus HOME/USERPROFILE/TMP/TEMP/DSH_HOME/
// AEGIS_SESSION_ROOT and AEGIS_ANALYSIS_CWD that matches the process cwd
// character for character. Hand-writing those variables in a .cmd drifts as
// soon as the profile changes, so this script asks the preparer for them.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = join(ROOT, 'runtime', 'node', 'node.exe');
const PREPARE = join(ROOT, 'launch', 'prepare-attempt.mjs');
const WORKER = join(ROOT, 'launch', 'aegis-harness-worker.cmd');

// Mirrors app/node_modules/plugins/dsh-defense-profile/profile.json
// effectiveConfig.analysisCwdRoots.win32. The payload is frozen; read it from
// the profile instead of hard-coding a second copy when that path changes.
const PROFILE_JSON = join(ROOT, 'app', 'node_modules', 'plugins', 'dsh-defense-profile', 'profile.json');

function fail(message) {
  process.stderr.write(`\n[self-check] ${message}\n`);
  process.exit(1);
}

if (!existsSync(NODE)) fail(`bundled runtime missing: ${NODE}`);
if (!existsSync(PREPARE)) fail(`preparer missing: ${PREPARE}`);
if (!existsSync(WORKER)) fail(`worker launcher missing: ${WORKER}`);

let neutralRoot;
try {
  const profile = JSON.parse(await (await import('node:fs/promises')).readFile(PROFILE_JSON, 'utf8'));
  neutralRoot = profile.effectiveConfig.analysisCwdRoots[process.platform];
} catch (error) {
  fail(`cannot read analysis root from profile: ${error.message}`);
}
if (!neutralRoot) fail(`profile declares no analysis root for ${process.platform}`);

mkdirSync(neutralRoot, { recursive: true });

const attempt = join(neutralRoot, `selfcheck-${Date.now()}`);
console.log('[self-check] install root :', ROOT);
console.log('[self-check] attempt root :', attempt);
console.log('');

const prepared = spawnSync(NODE, [PREPARE, '--root', attempt], {
  encoding: 'utf8',
  env: process.env,
  timeout: 120000,
});

if (prepared.error) fail(`preparer failed to run: ${prepared.error.message}`);
if (prepared.status !== 0) {
  process.stderr.write(prepared.stderr || '');
  fail(`preparer exited with ${prepared.status}`);
}

let plan;
try {
  plan = JSON.parse(prepared.stdout);
} catch (error) {
  process.stderr.write(prepared.stdout || '');
  fail(`preparer output is not JSON: ${error.message}`);
}

console.log('[self-check] attempt prepared, starting worker preflight');
console.log('[self-check] cwd         :', plan.cwd);
console.log('');

// stdin is closed on purpose: the worker is an interactive stdio CLI, so a
// headless check must hand it EOF instead of waiting for a prompt that will
// never come. Without this the check looks like a hang rather than a pass.
const worker = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', WORKER], {
  cwd: plan.cwd,
  env: plan.env,
  stdio: ['pipe', 'inherit', 'inherit'],
  input: '',
  timeout: 120000,
});

if (worker.error) fail(`worker failed to run: ${worker.error.message}`);

console.log('');
console.log('[self-check] worker exit code:', worker.status);
console.log('[self-check] attempt kept at :', attempt);
process.exit(worker.status === null ? 1 : worker.status);
