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
 * - nothing starts at import time: the collector packages are imported lazily so a
 *   `--dry-run` on a machine without PowerShell still works;
 * - on a non-Windows host the list is empty and the caller is told why, instead of the
 *   service failing later with an unrelated error;
 * - the include list is explicit, so "which sources are running" is answerable from the
 *   code rather than from whatever the package happens to export next release;
 * - **the returned list is already in the daemon's shape** (`{id, kind, poll}`). The
 *   mapping lives in `apps/daemon/src/adapters/collector-sources.js` and is shared with
 *   `apps/daemon/bin.js`; before this module did the mapping, handing the collector's
 *   `{name, source}` list to `createDaemon` failed at construction with `SOURCE_INVALID`
 *   (COLLECTOR-LIVE §4 CL-2, A2-SHAPE §5);
 * - every event gets a `boot_id` (A2-SHAPE §8). Without one, `telemetry_event.boot_id`
 *   is `NULL` and the store rejects every row (`ERR_NULL_NOT_ALLOWED`, CL-3).
 *
 * ## Security channel and elevation
 *
 * `Security` is readable only by an administrator / Event Log Readers member. Reading it
 * without those rights raises `UnauthorizedAccessException`, which the collector reports
 * as `unavailable` with code `ACCESS_DENIED` — never as an empty channel (design §5.1:
 * "权限不足即降级"). That is the default: **all three channels are declared**, and a
 * non-elevated install shows one `unavailable` source plus `health.status=degraded`
 * instead of silently not collecting it.
 *
 * A host that would rather not declare an unreadable source can pass
 * `probeSecurity: true`: it probes the channel once at startup and, when denied, leaves it
 * out **with a recorded reason** in `notes`. A2's 10-minute acceptance run uses an explicit
 * channel list (`channels: ['System','Application']`) for the same reason, and documents
 * it: the box is not elevated, so `Security` cannot be part of an `ok` run.
 */

import { createBootId, createCollectorSources } from '../../daemon/src/adapters/collector-sources.js';

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

/** Event channels the collector can read at all. */
export const ALL_EVENT_LOG_CHANNELS = Object.freeze(['Security', 'System', 'Application']);

/** Channels that do not need elevation. */
export const UNPRIVILEGED_EVENT_LOG_CHANNELS = Object.freeze(['System', 'Application']);

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
 * The Windows collector module, imported lazily (see the module header).
 *
 * @returns {Promise<{createWindowsSources: Function, attachWindowsSources: Function}>} Module.
 */
async function loadWindowsModule() {
  return import('../../../packages/collectors/windows/index.js');
}

/**
 * The platform-neutral collector runtime (cursor store, capability state, queue).
 *
 * @returns {Promise<object>} `@aegisharness/collector-common`.
 */
async function loadCommonModule() {
  return import('../../../packages/collectors/common/index.js');
}

/**
 * Build the daemon's `sources` array.
 *
 * @param {{
 *   platform?: string,
 *   include?: readonly string[],
 *   roots?: readonly string[],
 *   channels?: readonly string[]|null,
 *   probeSecurity?: boolean,
 *   timeoutMs?: number,
 *   bootId?: string|null,
 *   logger?: object
 * }} [options] Options.
 * @returns {Promise<{sources: object[], reason: string|null, notes: string[], bootId: string|null}>}
 */
export async function buildSources({
  platform = process.platform,
  include = ENABLED_SOURCES,
  roots = defaultDirectoriesRoots(),
  channels = null,
  // Default `false`: declare every channel and let a denied one surface as `unavailable`
  // (design §5.1). `true` opts into "skip a channel this account cannot read", which the
  // host then reports in `notes`.
  probeSecurity = false,
  // A single PowerShell call must be allowed to finish a *first* read: on a loaded host
  // `Get-NetTCPConnection` took ~95 s and one Application-channel page ~20 s, while the old
  // 15 s adapter default turned every first poll into SOURCE_TIMEOUT (CL-7). This is the
  // per-command budget, not the poll cadence.
  timeoutMs = 120_000,
  bootId = null,
  logger = null,
} = {}) {
  if (platform !== 'win32') {
    return {
      sources: [],
      reason: `当前平台 ${platform} 没有 Windows 采集器；full 模式将因无采集源而拒绝启动`,
      notes: [],
      bootId: null,
    };
  }

  const notes = [];
  let wanted = [...include];
  if (wanted.includes('directories') && roots.length === 0) {
    // Dropping one source with a recorded reason beats starting a service that cannot
    // start, and beats one that silently watches nothing.
    wanted = wanted.filter((name) => name !== 'directories');
    notes.push('directories 源已跳过：没有可监视的根（ProgramFiles / ProgramData 均未声明）');
  }

  const windows = await loadWindowsModule();
  const common = await loadCommonModule();
  const effectiveBootId = bootId ?? createBootId();
  const effectiveChannels = channels === null
    ? (await resolveEventLogChannels({ windows, include: wanted, probeSecurity, notes }))
    : [...channels];

  const wiring = createCollectorSources({
    createSources: windows.createWindowsSources,
    attachSources: windows.attachWindowsSources,
    createRuntime: common.createCollectorRuntime,
    options: {
      include: wanted,
      roots: [...roots],
      channels: effectiveChannels,
      timeoutMs,
    },
    cursorStore: common.createMemoryCursorStore({ clock: Date.now }),
    bootId: effectiveBootId,
    logger,
  });
  notes.push(`eventLog 通道：${effectiveChannels.join(' / ')}`);
  return { sources: [...wiring.sources], reason: null, notes, bootId: effectiveBootId };
}

/**
 * Decide which event channels this host may declare.
 *
 * The probe is one PowerShell round trip; without it the host would either always include
 * `Security` (and be permanently degraded on a normal user account) or never include it
 * (and silently not collect it on an administrator account).
 *
 * @param {{windows: object, include: readonly string[], probeSecurity: boolean, notes: string[]}} args Context.
 * @returns {Promise<string[]>} Channels to declare.
 */
async function resolveEventLogChannels({ windows, include, probeSecurity, notes }) {
  if (!include.includes('eventLog') || probeSecurity === false) {
    return [...ALL_EVENT_LOG_CHANNELS];
  }
  let securitySource = null;
  try {
    const probe = windows.createWindowsSources({
      include: ['eventLog'],
      channels: ['Security'],
    });
    securitySource = probe[0]?.source ?? null;
  } catch (error) {
    notes.push(`Security 通道探测未能装配：${error?.message ?? error}`);
    return [...UNPRIVILEGED_EVENT_LOG_CHANNELS];
  }
  if (securitySource === null || typeof securitySource.probe !== 'function') {
    return [...UNPRIVILEGED_EVENT_LOG_CHANNELS];
  }
  let probeResult;
  try {
    probeResult = await securitySource.probe();
  } catch (error) {
    probeResult = { ok: false, errorCode: error?.code ?? 'PROBE_FAILED' };
  }
  if (probeResult.ok === true) {
    notes.push('Security 通道可读（已提权或属于 Event Log Readers）：已声明该源');
    return [...ALL_EVENT_LOG_CHANNELS];
  }
  notes.push(
    `Security 通道不可读（${probeResult.errorCode ?? 'ACCESS_DENIED'}）：未声明该源，`
    + '需要以管理员身份或加入 Event Log Readers 后重启服务才会采集；'
    + '该源不会以 "0 条却 ok" 的形式出现，因为它根本不在运行列表里',
  );
  return [...UNPRIVILEGED_EVENT_LOG_CHANNELS];
}
