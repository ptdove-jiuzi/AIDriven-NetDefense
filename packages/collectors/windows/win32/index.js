/**
 * Native (koffi → Win32) table provider for the two hot Windows collectors.
 *
 * The provider is created lazily and never throws during construction: a host without
 * `koffi`, a non-Windows host or a missing export must fall back to the PowerShell transport
 * instead of breaking the collector at import time. Every failure is a *value*
 * (`ready()` / the thrown `Win32CollectorError` of a read), never a silently empty table,
 * because an empty table is a legitimate read and the two must stay distinguishable.
 *
 * Public surface (consumed by `sources/processes.js` and `sources/connections.js`):
 * - `readProcessTable()` → WMI-shaped rows
 * - `readEndpointTable()` → cmdlet-shaped `{ tcp, udp }`
 * - `ready()` → `{ ok, errorCode, message }` without performing a read
 * - `stats()` → counters for the degradation reporting and for the perf evidence
 */

import { WIN32_ERROR_CODES, Win32CollectorError, loadBindings } from './bindings.js';
import { createProcessTableReader } from './process-table.js';
import { createEndpointTableReader } from './endpoint-table.js';

export { WIN32_ERROR_CODES, Win32CollectorError } from './bindings.js';
export { formatIPv4, formatIPv6, portFromDword, fileTimeToEpochMs } from './format.js';

/** Stable identifier used in `stats.transport` so a degraded read is attributable. */
export const WIN32_TRANSPORT = 'win32-koffi';

function asWin32Error(error) {
  if (error instanceof Win32CollectorError) {
    return error;
  }
  return new Win32CollectorError(
    WIN32_ERROR_CODES.CALL_FAILED,
    error?.message ?? String(error),
    { reason: error?.stack ?? null },
  );
}

/**
 * @param {object} [options]
 * @param {() => Promise<object>} [options.load] binding loader (injectable for tests)
 * @param {() => number} [options.now] clock (injectable for tests)
 * @returns {Readonly<object>} provider
 */
export function createWin32Provider({ load = loadBindings, now = Date.now } = {}) {
  let bindings = null;
  let initialization = null;
  let failure = null;
  let processReader = null;
  let endpointReader = null;

  const counters = {
    processReads: 0,
    endpointReads: 0,
    failures: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastProcessDurationMs: null,
    lastEndpointDurationMs: null,
  };

  async function ensure() {
    if (bindings !== null) {
      return bindings;
    }
    if (failure !== null) {
      throw failure;
    }
    if (initialization === null) {
      initialization = Promise.resolve()
        .then(() => load())
        .then((loaded) => {
          bindings = loaded;
          return loaded;
        })
        .catch((error) => {
          failure = asWin32Error(error);
          throw failure;
        });
    }
    return initialization;
  }

  function recordFailure(error) {
    const normalized = asWin32Error(error);
    counters.failures += 1;
    counters.lastErrorCode = normalized.code;
    counters.lastErrorMessage = normalized.message;
    throw normalized;
  }

  function time(label, run) {
    const startedAt = now();
    try {
      const value = run();
      counters[label] = (counters[label] ?? 0) + 1;
      return value;
    } finally {
      counters[label === 'processReads' ? 'lastProcessDurationMs' : 'lastEndpointDurationMs'] = now() - startedAt;
    }
  }

  return Object.freeze({
    transport: WIN32_TRANSPORT,

    /** Probe the library without reading a table. */
    async ready() {
      try {
        await ensure();
        return Object.freeze({ ok: true, errorCode: null, message: null });
      } catch (error) {
        const normalized = asWin32Error(error);
        return Object.freeze({ ok: false, errorCode: normalized.code, message: normalized.message });
      }
    },

    async readProcessTable() {
      try {
        const loaded = await ensure();
        if (processReader === null) {
          processReader = createProcessTableReader(loaded);
        }
        return time('processReads', processReader);
      } catch (error) {
        return recordFailure(error);
      }
    },

    async readEndpointTable() {
      try {
        const loaded = await ensure();
        if (endpointReader === null) {
          endpointReader = createEndpointTableReader(loaded);
        }
        return time('endpointReads', endpointReader);
      } catch (error) {
        return recordFailure(error);
      }
    },

    stats() {
      return Object.freeze({ transport: WIN32_TRANSPORT, ...counters });
    },
  });
}
