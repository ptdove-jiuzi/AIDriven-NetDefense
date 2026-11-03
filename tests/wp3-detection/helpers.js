/**
 * helpers.js — shared fixtures for the detection package tests.
 *
 * Every helper is pure and synthetic: no real user data, no real clock and no
 * writes outside the temporary directory handed out by `withTempDir()`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetectionEngine, createManualClock } from '../../packages/detection/index.js';

/**
 * Create a temporary directory removed when the test finishes.
 *
 * @param {{ after: (fn: () => void) => void }} t Node test context.
 * @returns {string} Absolute temporary directory path.
 */
export function withTempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aegisharness-wp3-detection-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/**
 * Build a synthetic telemetry event.
 *
 * @param {object} [overrides] Fields replacing the defaults.
 * @returns {object} Event object owned by the caller.
 */
export function makeEvent(overrides = {}) {
  return {
    eventId: 'evt-0001',
    observedAt: 1000,
    type: 'process_start',
    source: '10.0.0.1',
    severity: 'info',
    fields: {
      process: {
        name: 'example-process',
        path: '/tmp/example/tool',
        parent: 'example-parent',
      },
      user: { name: 'example-user' },
      network: { remoteAddress: '10.0.0.8' },
    },
    ...overrides,
  };
}

/**
 * Build a condition rule that matches `example-process`.
 *
 * @param {object} [overrides] Rule fields replacing the defaults.
 * @returns {object} Rule object owned by the caller.
 */
export function makeConditionRule(overrides = {}) {
  return {
    ruleId: 'proc.example-start',
    version: '1.0.0',
    type: 'condition',
    severity: 'high',
    fields: ['process.name'],
    fingerprint: ['process.name'],
    when: { field: 'process.name', operator: 'eq', value: 'example-process' },
    ...overrides,
  };
}

/**
 * Wrap rules and an optional allowlist into a rule pack.
 *
 * @param {object[]} rules Rules to include.
 * @param {object[]} [allowlist] Allowlist entries.
 * @returns {object} Rule pack object.
 */
export function makePack(rules, allowlist) {
  const pack = {
    schemaVersion: '1.0',
    packId: 'test-pack',
    packVersion: '1.2.3',
    rules,
  };
  if (allowlist !== undefined) {
    pack.allowlist = allowlist;
  }
  return pack;
}

/**
 * Build an engine with deterministic defaults.
 *
 * @param {{
 *   rules?: object[],
 *   allowlist?: object[],
 *   rulePack?: object,
 *   limits?: object,
 *   clock?: { now: () => number },
 *   cpuClock?: { now: () => number },
 *   analysisGate?: (alert: object, context: object) => boolean,
 *   maxEventsPerIngest?: number,
 *   ids?: { next: (kind: string) => string },
 *   startAt?: number
 * }} [options] Engine options.
 * @returns {ReturnType<typeof createDetectionEngine>} Engine handle.
 *
 * The default CPU clock never advances, so ordinary cases can never trip the
 * 50ms per-rule budget on a slow machine. Isolation cases inject their own.
 * `ids` is optional and omitted by default, so the engine keeps minting random
 * identifiers unless a case explicitly needs a replayable factory.
 */
export function createTestEngine(options = {}) {
  const clock = options.clock ?? createManualClock(options.startAt ?? 0);
  const rulePack = options.rulePack ?? makePack(options.rules ?? [makeConditionRule()], options.allowlist);
  const configuration = { rulePack, clock, cpuClock: options.cpuClock ?? { now: () => 0 } };
  if (options.limits !== undefined) {
    configuration.limits = options.limits;
  }
  if (options.analysisGate !== undefined) {
    configuration.analysisGate = options.analysisGate;
  }
  if (options.maxEventsPerIngest !== undefined) {
    configuration.maxEventsPerIngest = options.maxEventsPerIngest;
  }
  if (options.ids !== undefined) {
    configuration.ids = options.ids;
  }
  return createDetectionEngine(configuration);
}

/**
 * Recursively freeze an object graph, including arrays.
 *
 * @param {unknown} value Value to freeze.
 * @returns {unknown} The same value, deeply frozen.
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}
