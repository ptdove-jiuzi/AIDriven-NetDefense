// Attempt-scoped environment for the shipped worker (author PT-dove).
//
// The shipped bundle already contains `launch/prepare-attempt.mjs`, which does
// this job — but it refuses any attempt root outside the reviewed "neutral
// analysis root", and on win32 that root is a fixed directory under ProgramData.
// This portable package is not allowed to write ProgramData, so the attempt tree
// is materialised here instead, under the caller's temp directory.
//
// What is copied is *not* re-decided: the file list, the directory layout and the
// environment keys are the ones `prepare-attempt.mjs` declares, and the shipped
// `approved-hashes.json` is still enforced before anything is copied. A tampered
// profile therefore fails closed exactly as it would in the shipped preparer; the
// only deliberate deviation is where the attempt tree is allowed to live.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Files copied verbatim from `dsh-home/profiles/aegis-analysis/`. */
export const PROFILE_FILES = ['package.json', 'profile.json', 'cordis.patch.yml', 'approved-hashes.json'];

/** Sub-tree copied verbatim from the same template. */
const TOOLS_SUBPATH = ['node_modules', '@aegisharness', 'dsh-defense-tools'];

/** Host facts the child cannot invent but that are not attempt-scoped. */
const PASSTHROUGH = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'OS'];

/**
 * Env keys handed to the worker. `launch-plan.json` lists these under
 * `environment.required`; the values are computed per attempt.
 */
const CLEARED = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_V8_COVERAGE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'npm_config_registry',
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Refuse to derive paths from a profile that is not the reviewed one.
 *
 * The profile decides the attempt layout and the cwd policy; a swapped
 * `profile.json` would silently widen both. `approved-hashes.json` is shipped
 * inside the same bundle and is itself covered by `manifests/files.sha256`.
 */
export function assertProfileApproved(bundleRoot) {
  const profileDir = join(bundleRoot, 'app', 'node_modules', 'plugins', 'dsh-defense-profile');
  const profilePath = join(profileDir, 'profile.json');
  const approvedPath = join(profileDir, 'approved-hashes.json');
  if (!existsSync(profilePath) || !existsSync(approvedPath)) {
    throw new Error(`profile or approval record missing under ${profileDir}`);
  }
  const approved = JSON.parse(readFileSync(approvedPath, 'utf8'));
  const record = approved?.files?.['plugins/dsh-defense-profile/profile.json'];
  if (record === undefined || typeof record.sha256 !== 'string') {
    throw new Error('approved-hashes.json does not cover profile.json');
  }
  const actual = sha256(readFileSync(profilePath));
  if (actual !== record.sha256) {
    throw new Error(`profile.json does not match approved-hashes.json (${actual} != ${record.sha256}); refusing to trust its paths`);
  }
  return { profileDir, sha256: actual };
}

/**
 * Materialise one disposable attempt tree and return the paths plus the env.
 *
 * Layout is identical to the shipped preparer's:
 *   <root>/home, tmp, cwd, session, dsh-home/profiles/aegis-analysis
 */
export function materializeAttempt({ bundleRoot, attemptRoot, brokerBaseURL, brokerToken }) {
  const templateDir = join(bundleRoot, 'dsh-home', 'profiles', 'aegis-analysis');
  if (!existsSync(join(templateDir, 'profile.json'))) {
    throw new Error(`profile template missing at ${templateDir}`);
  }
  if (existsSync(attemptRoot)) {
    throw new Error(`attempt root must not exist yet: ${attemptRoot}`);
  }

  const home = join(attemptRoot, 'home');
  const tmp = join(attemptRoot, 'tmp');
  const cwd = join(attemptRoot, 'cwd');
  const session = join(attemptRoot, 'session');
  const dshHome = join(attemptRoot, 'dsh-home');
  const profileDir = join(dshHome, 'profiles', 'aegis-analysis');
  for (const directory of [home, tmp, cwd, session, profileDir]) mkdirSync(directory, { recursive: true });

  for (const filename of PROFILE_FILES) {
    cpSync(join(templateDir, filename), join(profileDir, filename), { force: false, errorOnExist: true });
  }
  cpSync(join(templateDir, ...TOOLS_SUBPATH), join(profileDir, ...TOOLS_SUBPATH), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  const runtimeManifest = join(session, 'runtime.json');
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMP: tmp,
    TEMP: tmp,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AEGIS_ANALYSIS_CWD: cwd,
    AEGIS_SESSION_ROOT: session,
    AEGIS_BROKER_BASE_URL: brokerBaseURL,
    AEGIS_BROKER_TOKEN: brokerToken,
    AEGIS_RUNTIME_MANIFEST: runtimeManifest,
    NO_COLOR: '1',
  };
  for (const name of PASSTHROUGH) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of CLEARED) env[name] = '';

  return { root: attemptRoot, home, tmp, cwd, session, dshHome, profileDir, runtimeManifest, env };
}
