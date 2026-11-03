/**
 * paths.mjs — where an install lives, and the one place that decides it.
 *
 * ADR-0009 §5.1 fixes three roots (program / data / install metadata). This module
 * derives every path from those roots so no caller invents a fourth.
 *
 * **Two modes, and the difference is a safety boundary, not a convenience flag:**
 *
 * - `armed`   — writes the real product locations (`%ProgramFiles%`,
 *               `%ProgramData%`), registers a real service and real registry keys.
 *               Requires elevation and a Windows host.
 * - `disarm`  — writes only under an explicit `--root`, and the root is refused if it
 *               sits inside any real system location. Every privileged action is
 *               recorded to a plan file instead of executed.
 *
 * The tests use `disarm` exclusively, so a test run cannot register a service, write
 * `%ProgramData%`, or touch `%ProgramFiles%` even by accident. `armed` refuses a
 * `--root`, so an operator cannot "slightly" point an armed run elsewhere either.
 */

import { resolve, join, parse, sep, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const PRODUCT_NAME = 'AIDriven NetDefense';
export const PRODUCT_NAME_ZH = '网域智防';
export const SERVICE_NAME = 'AIDrivenNetDefenseDaemon';
export const SERVICE_DISPLAY_NAME = `${PRODUCT_NAME} 安全监测服务（${PRODUCT_NAME_ZH}）`;
export const SERVICE_DESCRIPTION = `${PRODUCT_NAME} 事件采集与检测守护进程（${PRODUCT_NAME_ZH}）`;

/**
 * ARP / upgrade identity. Fixed for the life of the product: the ARP key is derived
 * from it, so changing it makes Windows show two installed copies instead of one.
 */
export const UPGRADE_CODE = '{9C3D5F86-2B4A-4E97-9D31-6F0A8C1E5B72}';

export const REG_ARP_KEY = `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${UPGRADE_CODE}`;
export const REG_PRODUCT_KEY = `HKLM\\SOFTWARE\\${PRODUCT_NAME}`;
export const REG_EVENT_SOURCE_KEY = `HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\${PRODUCT_NAME}`;

/** ADR §5.2: 组按 SID 解析，不按本地化名。 */
export const EVENT_LOG_READERS_SID = 'S-1-5-32-573';

export function isInside(parent, candidate) {
  const parentParts = resolve(parent).split(sep).filter(Boolean);
  const candidateParts = resolve(candidate).split(sep).filter(Boolean);
  if (candidateParts.length < parentParts.length) return false;
  return parentParts.every((part, index) => part.toLowerCase() === candidateParts[index].toLowerCase());
}

function realRoots(env) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  const programData = env.ProgramData ?? 'C:\\ProgramData';
  const systemRoot = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  const home = env.USERPROFILE ?? homedir();
  return {
    programFiles: resolve(programFiles),
    programData: resolve(programData),
    systemRoot: resolve(systemRoot),
    home: resolve(home),
    // x86 / x64 split: both are system locations even though only one is canonical.
    programFilesX86: resolve(env['ProgramFiles(x86)'] ?? join(programFiles, '(x86)')),
    appData: resolve(env.APPDATA ?? join(home, 'AppData', 'Roaming')),
    localAppData: resolve(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')),
  };
}

/**
 * Reasons a `--root` must be refused in disarm mode. Returns a list of strings so the
 * caller can print every reason instead of only the first.
 */
export function rejectDisarmRoot(root, env = process.env) {
  const reasons = [];
  const absolute = resolve(root);
  const { root: volume, dir: volumeDir } = parse(absolute);

  // A drive root ("D:\") or a bare volume is never an install root: a recursive
  // delete of `D:\Program Files` would be a catastrophe, and one typo is all it takes.
  if (volumeDir === volume || dirname(absolute) === absolute) {
    reasons.push(`根目录不能是卷根（${absolute}）`);
  }
  if (absolute.split(sep).filter(Boolean).length < 2) {
    reasons.push(`根目录层级过浅，拒绝使用（${absolute}）`);
  }

  const real = realRoots(env);

  // The OS temp directory lives inside `%LOCALAPPDATA%`, so it would match the system-location
  // rule below even though it is exactly the scratch space this mode exists to use. It is
  // checked first and exempted explicitly rather than by narrowing the rule elsewhere.
  const scratch = resolve(tmpdir());
  if (isInside(scratch, absolute) && absolute.toLowerCase() !== scratch.toLowerCase()) {
    return [];
  }

  for (const [name, path] of Object.entries(real)) {
    if (isInside(path, absolute) || absolute.toLowerCase() === path.toLowerCase()) {
      reasons.push(`根目录落在真实系统位置 ${name}=${path} 内，disarm 模式拒绝（${absolute}）`);
    }
  }
  return reasons;
}

/**
 * Build the full layout. `root` is mandatory in disarm mode and forbidden in armed
 * mode; that asymmetry is what keeps the two modes from blurring.
 */
export function buildLayout({ mode, root = null, version = null, env = process.env } = {}) {
  if (mode !== 'disarm' && mode !== 'armed') {
    throw new Error(`mode must be 'armed' or 'disarm', got ${String(mode)}`);
  }
  if (mode === 'disarm' && root === null) {
    throw new Error('disarm 模式必须显式给出 --root（或 AIDRIVEN_INSTALL_ROOT）');
  }
  if (mode === 'armed' && root !== null) {
    throw new Error('armed 模式不接受 --root：真实路径由 ADR-0009 §5.1 固定，不可指向别处');
  }

  const real = realRoots(env);
  const programRoot = mode === 'armed'
    ? join(real.programFiles, PRODUCT_NAME)
    : join(resolve(root), 'ProgramFiles', PRODUCT_NAME);
  const dataRoot = mode === 'armed'
    ? join(real.programData, PRODUCT_NAME)
    : join(resolve(root), 'ProgramData', PRODUCT_NAME);
  const startMenuRoot = mode === 'armed'
    ? join(real.programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : join(resolve(root), 'ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs');

  const installDir = join(dataRoot, 'install');
  const dataDir = join(dataRoot, 'data');

  return Object.freeze({
    mode,
    version,
    root: root === null ? null : resolve(root),
    programRoot,
    appRoot: join(programRoot, 'app'),
    appPrevRoot: join(programRoot, 'app.prev'),
    binRoot: join(programRoot, 'bin'),
    serviceHostExe: join(programRoot, 'bin', 'aegis-svc.exe'),
    cliStub: join(programRoot, 'bin', 'aegis-cli.cmd'),
    dataRoot,
    configDir: join(dataRoot, 'config'),
    configPath: join(dataRoot, 'config', 'aegis.conf.json'),
    dataDir,
    storeDir: join(dataDir, 'store'),
    storePath: join(dataDir, 'store', 'aegis.db'),
    secretsDir: join(dataDir, 'secrets'),
    tokenPath: join(dataDir, 'secrets', 'api-token'),
    analysisDir: join(dataDir, 'analysis'),
    logsDir: join(dataRoot, 'logs'),
    installDir,
    journalPath: join(installDir, 'journal.json'),
    installReceiptPath: join(installDir, 'install.json'),
    uninstallRegistryPath: join(installDir, 'uninstall.json'),
    versionFloorPath: join(installDir, 'version-floor.json'),
    purgeManifestPath: join(installDir, 'purge-manifest.json'),
    pendingRemovalPath: join(installDir, 'pending-removal.json'),
    planDir: join(installDir, 'plan'),
    planPath: join(installDir, 'plan', 'actions.jsonl'),
    stagingRoot: join(installDir, 'staging'),
    stagingDir: version === null ? null : join(installDir, 'staging', version),
    backupRoot: join(installDir, 'backup', 'db'),
    startMenuRoot,
    startMenuDir: join(startMenuRoot, PRODUCT_NAME),
    startMenuShortcut: join(startMenuRoot, PRODUCT_NAME, `${PRODUCT_NAME} 命令行.lnk`),

    // ADR §5.1: node 运行时随载荷分发，卸载延迟删除时由它执行命令
    nodeExe: join(programRoot, 'app', 'runtime', 'node', 'node.exe'),
    enginePath: join(installDir, 'engine', 'main.mjs'),
    realRoots: real,
  });
}

/** All directories an installer may create, in creation order. */
export function directoriesToCreate(layout) {
  return [
    layout.programRoot,
    layout.appRoot,
    layout.binRoot,
    layout.dataRoot,
    layout.configDir,
    layout.dataDir,
    layout.storeDir,
    layout.secretsDir,
    layout.analysisDir,
    layout.logsDir,
    layout.installDir,
    layout.stagingRoot,
    layout.backupRoot,
    layout.startMenuDir,
  ];
}

/** Roots a guarded delete is allowed to touch. Anything else is refused. */
export function deletableRoots(layout) {
  return [layout.programRoot, layout.dataRoot].concat(
    layout.mode === 'disarm' ? [layout.root] : [],
  );
}

export { tmpdir };
