import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const PROFILE_SOURCE = join(repositoryRoot, 'plugins', 'dsh-defense-profile');
export const DEFENSE_TOOLS_SOURCE = join(repositoryRoot, 'plugins', 'dsh-defense-tools');
export const DSH_BIN = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'));

function passthroughEnvironment() {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'OS'];
  return Object.fromEntries(allowed.flatMap((name) => (
    process.env[name] === undefined ? [] : [[name, process.env[name]]]
  )));
}

/** Stage only reviewed files inside one per-attempt temporary root. */
export function stageAegisAnalysis({ root, brokerBaseURL = 'http://127.0.0.1:9/anthropic' }) {
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const dshHome = join(root, 'dsh-home');
  const cwd = join(root, 'cwd');
  const sessionRoot = join(root, 'session');
  const profileDir = join(dshHome, 'profiles', 'aegis-analysis');
  const toolsDir = join(profileDir, 'node_modules', '@aegisharness', 'dsh-defense-tools');
  for (const directory of [home, tmp, cwd, sessionRoot, profileDir]) {
    mkdirSync(directory, { recursive: true });
  }
  for (const filename of ['package.json', 'cordis.patch.yml', 'profile.json']) {
    cpSync(join(PROFILE_SOURCE, filename), join(profileDir, filename), { force: false, errorOnExist: true });
  }
  cpSync(DEFENSE_TOOLS_SOURCE, toolsDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (source) => !source.includes('node_modules'),
  });

  const runtimeManifest = join(sessionRoot, 'runtime.json');
  const env = {
    ...passthroughEnvironment(),
    HOME: home,
    USERPROFILE: home,
    TMP: tmp,
    TEMP: tmp,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    AEGIS_ANALYSIS_CWD: cwd,
    AEGIS_SESSION_ROOT: sessionRoot,
    AEGIS_BROKER_BASE_URL: brokerBaseURL,
    AEGIS_BROKER_TOKEN: 'wp0-harmless-single-attempt-token',
    AEGIS_RUNTIME_MANIFEST: runtimeManifest,
    NO_COLOR: '1',
  };
  return { home, tmp, dshHome, cwd, sessionRoot, profileDir, toolsDir, runtimeManifest, env };
}
