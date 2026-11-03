/**
 * sources.mjs — the collector wiring that `apps/daemon/bin.js` deliberately cannot do.
 *
 * `bin.js` refuses to run `full` mode without at least one collector source, because a
 * daemon that silently collects nothing looks healthy while producing no telemetry
 * (`docs/product/07-deployment.md` §5.1). The sources are injected by a *host
 * application*, and this is that host.
 *
 * Rules kept here:
 *
 * - nothing starts at import time: the collector package is imported lazily so a
 *   `--dry-run` on a machine without PowerShell still works;
 * - on a non-Windows host the list is empty and the caller is told why, instead of the
 *   service failing later with an unrelated error;
 * - the include list is explicit, so "which sources are running" is answerable from the
 *   code rather than from whatever the package happens to export next release.
 */

/** Sources this host starts. Kept explicit and ordered. */
export const ENABLED_SOURCES = Object.freeze([
  'processes',
  'connections',
  'services',
  'scheduledTasks',
  'runKeys',
  'eventLog',
  'directories',
]);

/**
 * Directories the `directories` source watches.
 *
 * The collector refuses to run with an empty root list ("the directories source was
 * requested but no roots were declared"), and it is right to: a directory watcher with no
 * directories is a source that reports nothing while claiming to be healthy. So the host
 * has to declare them, and it names the two locations the product actually cares about.
 */
export function defaultDirectoriesRoots(env = process.env) {
  return [env.ProgramFiles, env.ProgramData]
    .filter((value) => typeof value === 'string' && value.length > 0);
}

/**
 * Build the daemon's `sources` array.
 *
 * @param {{ platform?: string, include?: readonly string[], roots?: readonly string[] }} [options]
 * @returns {Promise<{sources: {name: string, source: object}[], reason: string|null, notes: string[]}>}
 */
export async function buildSources({
  platform = process.platform,
  include = ENABLED_SOURCES,
  roots = defaultDirectoriesRoots(),
} = {}) {
  if (platform !== 'win32') {
    return { sources: [], reason: `当前平台 ${platform} 没有 Windows 采集器；full 模式将因无采集源而拒绝启动`, notes: [] };
  }

  const notes = [];
  let wanted = [...include];
  if (wanted.includes('directories') && roots.length === 0) {
    // Dropping one source with a recorded reason beats starting a service that cannot
    // start, and beats one that silently watches nothing.
    wanted = wanted.filter((name) => name !== 'directories');
    notes.push('directories 源已跳过：没有可监视的根（ProgramFiles / ProgramData 均未声明）');
  }

  const module = await import('../../../packages/collectors/windows/index.js');
  const sources = module.createWindowsSources({ include: wanted, roots: [...roots] });
  return { sources, reason: null, notes };
}
