/**
 * `@aegisharness/collector-windows` — Windows collection adapter.
 *
 * Layout:
 * - `errors.js`     error taxonomy and remediation text
 * - `runner.js`     the only module that spawns a process (allowlisted interpreter only)
 * - `powershell.js` script wrapping, JSON parsing, failure classification
 * - `payload.js`    payload normalization to the closed TelemetryEvent contract
 * - `descriptor.js` declaration validation (permissions, fields, blind spots, rotation)
 * - `diff.js`       snapshot diffing and stable entity identities
 * - `adapter.js`    binding onto `@aegisharness/collector-common`
 * - `sources/`      one module per declared source
 *
 * The seven first-version sources of §5.1 are registered in {@link SOURCE_FACTORIES}; each
 * one is a plain factory so the daemon decides which sources to run, and nothing in this
 * package starts a timer or spawns a process at import time.
 */

export * from './errors.js';
export * from './runner.js';
export * from './powershell.js';
export * from './payload.js';
export * from './descriptor.js';
export * from './diff.js';
export * from './adapter.js';

export * from './sources/processes.js';
export * from './sources/connections.js';
export * from './sources/event-log.js';
export * from './sources/services.js';
export * from './sources/scheduled-tasks.js';
export * from './sources/run-keys.js';
export * from './sources/directories.js';

import { createSourceBinding } from './adapter.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from './errors.js';
import { DEFAULT_ALLOWLIST, createCommandRunner } from './runner.js';
import { createPowerShellClient } from './powershell.js';
import { createProcessSource, PROCESS_DESCRIPTOR } from './sources/processes.js';
import { createConnectionsSource, CONNECTIONS_DESCRIPTOR } from './sources/connections.js';
import {
  createEventLogSource,
  describeEventLog,
  EVENT_LOG_PROBE_INTERVAL_MS,
} from './sources/event-log.js';
import { createServicesSource, SERVICES_DESCRIPTOR } from './sources/services.js';
import { createScheduledTasksSource, SCHEDULED_TASKS_DESCRIPTOR } from './sources/scheduled-tasks.js';
import { createRunKeysSource, RUN_KEYS_DESCRIPTOR, RUN_KEY_PATHS } from './sources/run-keys.js';
import { createDirectoriesSource, DIRECTORIES_INTERVAL_MS, DIRECTORIES_SOURCE_ID } from './sources/directories.js';

/**
 * The declared first-version source matrix. `event` sources are created per channel, which is
 * why only the static poll sources appear here.
 */
export const POLL_DESCRIPTORS = Object.freeze([
  PROCESS_DESCRIPTOR,
  CONNECTIONS_DESCRIPTOR,
  SERVICES_DESCRIPTOR,
  SCHEDULED_TASKS_DESCRIPTOR,
  RUN_KEYS_DESCRIPTOR,
]);

/** Declared defaults for the event-driven half (one source per channel). */
export const EVENT_SOURCE_DEFAULTS = Object.freeze({
  probeIntervalMs: EVENT_LOG_PROBE_INTERVAL_MS,
  channels: Object.freeze(['Security', 'System', 'Application']),
});

export const SOURCE_FACTORIES = Object.freeze({
  processes: 'createProcessSource',
  connections: 'createConnectionsSource',
  eventLog: 'createEventLogSource',
  services: 'createServicesSource',
  scheduledTasks: 'createScheduledTasksSource',
  runKeys: 'createRunKeysSource',
  directories: 'createDirectoriesSource',
});

/**
 * Build the set of sources for one collector process.
 *
 * `channels` is the only option that reaches a command line, and it is validated by
 * `describeEventLog` → `assertChannelName` before any script is built.
 */
export function createWindowsSources({
  runner = null,
  powershell = null,
  clock = Date.now,
  intervalMs = null,
  channels = EVENT_SOURCE_DEFAULTS.channels,
  roots = [],
  runKeys = RUN_KEY_PATHS,
  hashContent = false,
  include = null,
  executable = 'powershell.exe',
  timeoutMs = 15_000,
  allowlist = DEFAULT_ALLOWLIST,
} = {}) {
  const wanted = include === null
    ? new Set(['processes', 'connections', 'eventLog', 'services', 'scheduledTasks', 'runKeys', 'directories'])
    : new Set(include.map((entry) => {
      if (!Object.prototype.hasOwnProperty.call(SOURCE_FACTORIES, entry)) {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.SOURCE_UNKNOWN,
          `unknown Windows source: ${String(entry)}`,
          { details: { include: [...include] } },
        );
      }
      return entry;
    }));

  const needsPowerShell = [...wanted].some((name) => name !== 'directories');
  let client = powershell;
  if (client === null && needsPowerShell) {
    const effectiveRunner = runner ?? createCommandRunner({ allowlist, timeoutMs });
    client = createPowerShellClient({ runner: effectiveRunner, executable, timeoutMs });
  }

  const sources = [];
  const pick = (value, fallback) => (Number.isSafeInteger(value) && value > 0 ? value : fallback);

  if (wanted.has('processes')) {
    sources.push({
      name: 'processes',
      source: createProcessSource({
        powershell: client,
        clock,
        ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, 5_000) }),
      }),
    });
  }
  if (wanted.has('connections')) {
    sources.push({
      name: 'connections',
      source: createConnectionsSource({
        powershell: client,
        clock,
        ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, 5_000) }),
      }),
    });
  }
  if (wanted.has('services')) {
    sources.push({
      name: 'services',
      source: createServicesSource({
        powershell: client,
        clock,
        ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, 60_000) }),
      }),
    });
  }
  if (wanted.has('scheduledTasks')) {
    sources.push({
      name: 'scheduledTasks',
      source: createScheduledTasksSource({
        powershell: client,
        clock,
        ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, 60_000) }),
      }),
    });
  }
  if (wanted.has('runKeys')) {
    sources.push({
      name: 'runKeys',
      source: createRunKeysSource({
        powershell: client,
        clock,
        keys: runKeys,
        ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, 60_000) }),
      }),
    });
  }
  if (wanted.has('eventLog')) {
    const declaredChannels = Array.isArray(channels) && channels.length > 0
      ? channels
      : EVENT_SOURCE_DEFAULTS.channels;
    for (const channel of declaredChannels) {
      // Validate every channel up front: a bad channel name must fail at construction, not
      // on the first read, and must never reach the interpreter.
      describeEventLog(channel, { intervalMs: EVENT_LOG_PROBE_INTERVAL_MS });
      sources.push({
        name: `eventLog:${channel}`,
        source: createEventLogSource({
          powershell: client,
          channel,
          clock,
          ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, EVENT_LOG_PROBE_INTERVAL_MS) }),
        }),
      });
    }
  }
  if (wanted.has('directories')) {
    if (!Array.isArray(roots) || roots.length === 0) {
      // Silently skipping a source the caller explicitly asked for is how a host ends up
      // believing it watches autostart directories while collecting nothing.
      if (include !== null) {
        throw new WindowsCollectorError(
          WINDOWS_ERROR_CODES.INVALID_CONFIG,
          'the directories source was requested but no roots were declared',
        );
      }
    } else {
      sources.push({
        name: 'directories',
        source: createDirectoriesSource({
          roots,
          clock,
          hashContent,
          ...(intervalMs === null ? {} : { intervalMs: pick(intervalMs, DIRECTORIES_INTERVAL_MS) }),
        }),
      });
    }
  }

  return Object.freeze(sources.map((entry) => Object.freeze(entry)));
}

/**
 * Register every source with a `createCollectorRuntime` instance and return the bindings.
 * The runtime owns capability state, so one degraded source never marks the others unhealthy.
 */
export function attachWindowsSources({ runtime, sources } = {}) {
  if (runtime === null || typeof runtime !== 'object' || typeof runtime.addSource !== 'function') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a collector runtime exposing addSource() is required',
    );
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'at least one source is required');
  }

  return Object.freeze(sources.map((entry) => {
    const { descriptor } = entry.source;
    const collector = runtime.addSource({
      stableSourceId: descriptor.stableSourceId,
      kind: descriptor.kind,
      intervalMs: descriptor.intervalMs,
      subscriptionProbeIntervalMs: descriptor.intervalMs,
    });
    const binding = createSourceBinding({ source: entry.source, collector });
    return Object.freeze({ name: entry.name, descriptor, collector, binding });
  }));
}

/** All declared descriptors, including the ones that are instantiated per channel/root. */
export function describeWindowsSources({ channels = EVENT_SOURCE_DEFAULTS.channels } = {}) {
  const eventLogs = (Array.isArray(channels) ? channels : EVENT_SOURCE_DEFAULTS.channels)
    .map((channel) => describeEventLog(channel, { intervalMs: EVENT_LOG_PROBE_INTERVAL_MS }));
  const directoriesNote = Object.freeze({
    stableSourceId: DIRECTORIES_SOURCE_ID,
    kind: 'poll',
    intervalMs: DIRECTORIES_INTERVAL_MS,
    note: 'instantiated only when at least one root is declared',
  });
  return Object.freeze([...POLL_DESCRIPTORS, ...eventLogs, directoriesNote]);
}
