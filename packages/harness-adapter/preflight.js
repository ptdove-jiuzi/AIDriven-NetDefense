import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { sha256File } from './manifest.js';

function failure(message, code = 'ERR_HARNESS_PREFLIGHT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function contained(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && path !== '..' && !path.startsWith(`..${path.includes('\\') ? '\\' : '/'}`) && !isAbsolute(path);
}

export function verifyStagedProfile({ profileDir, toolsDir, approved }) {
  for (const [source, record] of Object.entries(approved.files)) {
    let target;
    if (source.startsWith('plugins/dsh-defense-profile/')) {
      target = join(profileDir, source.slice('plugins/dsh-defense-profile/'.length));
    } else if (source.startsWith('plugins/dsh-defense-tools/')) {
      target = join(toolsDir, source.slice('plugins/dsh-defense-tools/'.length));
    } else {
      failure(`Approved hash has unexpected source ${source}`);
    }
    if (!existsSync(target)) failure(`Approved file is missing: ${source}`);
    if (sha256File(target) !== record.sha256) failure(`Approved file hash differs: ${source}`);
  }
  return true;
}

export function validateLaunchArguments(argv) {
  if (JSON.stringify(argv) !== JSON.stringify(['--profile', 'aegis-analysis'])) {
    failure('Only exact "dsh --profile aegis-analysis" arguments are approved; overlays and plugin commands are forbidden');
  }
}

export function validateWorkerEnvironment(env, cwd) {
  const directories = {
    HOME: env.HOME,
    TMP: env.TMP,
    TEMP: env.TEMP,
    DSH_HOME: env.DSH_HOME,
    AEGIS_ANALYSIS_CWD: cwd,
    AEGIS_SESSION_ROOT: env.AEGIS_SESSION_ROOT,
  };
  for (const [name, value] of Object.entries(directories)) {
    if (!value || !isAbsolute(value)) failure(`${name} must be an absolute per-attempt directory`);
  }
  if (env.HOME !== env.USERPROFILE && process.platform === 'win32') {
    failure('USERPROFILE must equal the per-attempt HOME');
  }
  if (env.AEGIS_ANALYSIS_CWD !== cwd) failure('AEGIS_ANALYSIS_CWD must equal process cwd');
  if (env.AEGIS_RUNTIME_MANIFEST && !contained(env.AEGIS_SESSION_ROOT, env.AEGIS_RUNTIME_MANIFEST)) {
    failure('Runtime manifest must remain inside the per-attempt Session root');
  }
  if (existsSync(join(env.DSH_HOME, 'cordis.patch.yml'))) {
    failure('Home-level cordis.patch.yml is not approved');
  }
  let url;
  try {
    url = new URL(env.AEGIS_BROKER_BASE_URL);
  } catch {
    failure('AEGIS_BROKER_BASE_URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', '::1'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    failure('Broker baseURL must be a credential-free loopback endpoint');
  }
  if (!env.AEGIS_BROKER_TOKEN) failure('Single-attempt broker token is absent');
  if (env.DSH_TELEMETRY_DISABLED === undefined || env.DSH_TELEMETRY_DISABLED === '') {
    failure('Telemetry opt-out must be explicit');
  }
  return true;
}

export function preflightWorker({ argv, env, cwd, profileDir, toolsDir, approved }) {
  validateLaunchArguments(argv);
  validateWorkerEnvironment(env, cwd);
  verifyStagedProfile({ profileDir, toolsDir, approved });
  return true;
}
