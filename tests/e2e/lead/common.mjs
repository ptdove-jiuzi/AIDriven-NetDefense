/**
 * common.mjs — shared helpers for the Lead's independent acceptance scripts.
 *
 * These scripts exist to be the "do not trust the implementer" layer: they drive a real
 * browser against the real console host and the real daemon, and they fail loudly.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The six contract views. */
export const VIEWS = Object.freeze(['overview', 'alerts', 'analysis', 'agent', 'models', 'settings']);

/** Default origin of the stack with data. */
export const DEFAULT_BASE = 'http://127.0.0.1:17512';

/** Parse `--key value` / `--flag` arguments. */
export function parseArgs(argv, defaults = {}) {
  const args = { base: DEFAULT_BASE, out: null, theme: 'dark', lang: 'zh-CN', ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    const takesValue = ['--base', '--out', '--theme', '--lang', '--canary', '--timeout'];
    if (takesValue.includes(flag)) {
      const key = flag.slice(2);
      args[key === 'timeout' ? 'timeoutMs' : key] = key === 'timeout' ? Number(next) : next;
      index += 1;
    } else if (flag.startsWith('--')) {
      args[flag.slice(2)] = true;
    }
  }
  return args;
}

/** Write a JSON evidence file (creating directories) and echo a one-line summary. */
export function writeEvidence(outDir, name, value) {
  if (outDir === null || outDir === undefined) return null;
  const file = join(outDir, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/** Build a view URL, using the app's documented URL overrides (§7.1) instead of storage. */
export function viewUrl(base, view, { theme = 'dark', lang = 'zh-CN' } = {}) {
  return `${base}/?theme=${encodeURIComponent(theme)}&lang=${encodeURIComponent(lang)}#/${view}`;
}

/** Merge a browser page report into the shape the final report needs. */
export function devtoolsOf(page) {
  const report = page.report();
  return {
    consoleErrors: report.consoleErrors.map((entry) => entry.text),
    exceptions: report.exceptions.map((entry) => entry.text),
    logErrors: report.logErrors.map((entry) => entry.text),
    failedRequests: report.failedRequests.map((entry) => entry.errorText),
    badResponses: report.badResponses,
    total: report.total,
  };
}

/** Assert a value, collecting failures instead of throwing on the first one. */
export class Checker {
  constructor(label) {
    this.label = label;
    this.failures = [];
    this.passes = 0;
    this.checks = [];
  }

  ok(condition, name, detail = undefined) {
    const passed = Boolean(condition);
    this.checks.push({ name, passed, detail });
    if (passed) this.passes += 1;
    else this.failures.push({ name, detail });
    return passed;
  }

  equal(actual, expected, name) {
    return this.ok(actual === expected, name, { actual, expected });
  }

  atMost(actual, limit, name) {
    return this.ok(typeof actual === 'number' && actual <= limit, name, { actual, limit });
  }

  summary() {
    return {
      label: this.label,
      pass: this.failures.length === 0,
      passed: this.passes,
      failed: this.failures.length,
      failures: this.failures,
      checks: this.checks,
    };
  }
}
