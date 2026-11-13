/**
 * Test helpers for the Windows collector adapter.
 *
 * Ground rules (see AGENTS.md §6 and the WP2-WINDOWS status file):
 * - No real Windows event log, registry or process table is read. Every PowerShell result is
 *   synthesized here and every "command" goes through a fake runner that records the request
 *   instead of executing it.
 * - No real user directory is walked. The directory source is pointed at a throwaway sandbox
 *   created by `createTestSandbox`.
 */

import { createSourceCollector, createCapability } from '../../packages/collectors/common/index.js';
import { createCursorStore } from '../../packages/collectors/common/index.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../../packages/collectors/windows/index.js';

export const FIXED_NOW = 1_700_000_000_000;

/** A clock that returns a fixed instant and can be advanced explicitly. */
export function createClock(start = FIXED_NOW) {
  let now = start;
  const clock = () => now;
  clock.set = (value) => { now = value; };
  clock.advance = (delta) => { now += delta; };
  clock.now = () => now;
  return clock;
}

/**
 * Runner-shaped fake: `run()` resolves and records the request. `handler` decides the
 * outcome and may throw to simulate a rejected fake.
 */
export function createFakeRunner(handler = null) {
  const calls = [];
  return {
    calls,
    async run(request) {
      calls.push(request);
      if (handler === null) {
        return { ok: true, code: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, truncated: false };
      }
      return handler(request);
    },
  };
}

/**
 * PowerShell-client fake keyed by the `# aegis-source:<name>` marker that every script
 * carries. Routing on the body (instead of on call order) keeps the tests readable when a
 * source issues two scripts in one read.
 */
export function createScriptedPowerShell(routes = {}) {
  // No native reader: a fixture must be answered by the fixture, never by the live host.
  const nativeCapable = false;
  const calls = [];
  function resolveRoute(script) {
    const match = /^# aegis-source:([A-Za-z0-9-]+)/m.exec(String(script));
    const key = match === null ? 'default' : match[1];
    // `??` would treat a deliberately empty `null` route as "not configured"; a table that
    // is legitimately absent has to be expressible.
    const route = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : routes.default;
    if (route === undefined) {
      throw new WindowsCollectorError(
        WINDOWS_ERROR_CODES.SOURCE_UNKNOWN,
        `no fake route for script marker "${key}"`,
      );
    }
    return route;
  }
  function materialize(route, script) {
    const value = typeof route === 'function' ? route(script) : route;
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
  return {
    calls,
    nativeCapable,
    async runJson(script) {
      calls.push({ kind: 'json', script });
      return materialize(resolveRoute(script), script);
    },
    async runText(script) {
      calls.push({ kind: 'text', script });
      return materialize(resolveRoute(script), script);
    },
    async probe() {
      return { ok: true, durationMs: 1, errorCode: null };
    },
  };
}

/** A PowerShell client whose every call fails with the given adapter error. */
export function createFailingPowerShell(error) {
  return {
    async runJson() { throw error; },
    async runText() { throw error; },
  };
}

/** A PowerShell client that always returns the same JSON value. */
export function createStaticPowerShell(value) {
  return {
    async runJson() { return value; },
    async runText() { return 'ok'; },
  };
}

/**
 * Build a real `collector-common` collector plus its own cursor store inside the sandbox,
 * so the adapter tests exercise the actual publish/commit/dedupe pipeline instead of a stub.
 */
export function createTestCollector({ sandbox, source, clock }) {
  const store = createCursorStore({
    directory: sandbox.workRoot,
    fileName: `cursors-${source.stableSourceId.replace(/[^a-z0-9-]/g, '_')}-${Math.random().toString(16).slice(2)}.json`,
    clock,
  });
  const capability = createCapability({
    stableSourceId: source.stableSourceId,
    collectorInstanceId: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    kind: source.kind,
    intervalMs: source.intervalMs,
    clock,
  });
  const collector = createSourceCollector({
    source,
    store,
    capability,
    clock,
    bootId: '00112233445566778899aabbccddeeff',
  });
  return { collector, capability, store };
}

