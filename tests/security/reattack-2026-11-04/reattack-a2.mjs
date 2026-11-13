/**
 * REV-E reattack for A2 (collector shape / empty-output) and the model-routing fix.
 *
 * Part 1 — fake runner: which "exit 0" outputs does the collector still treat as a silent
 *          empty read after the EMPTY_OUTPUT fix?
 * Part 2 — real PowerShell: is the run-key source's registry provider path fixed?
 * Part 3 — in-memory mutations (`hook-mutate.mjs`) to prove the regressions are watched.
 *
 * Run: node tests/security/reattack-2026-11-04/reattack-a2.mjs
 * Author: PT-dove
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const EVIDENCE = join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'review', '2026-11-04', 'command', 'reattack');
mkdirSync(join(EVIDENCE, 'a2'), { recursive: true });
mkdirSync(join(EVIDENCE, 'mutations'), { recursive: true });

const rows = [];
const note = (o) => {
  rows.push(o);
  console.log(JSON.stringify(o));
};
const save = (name, text) => writeFileSync(join(EVIDENCE, name), `${text}\n`, 'utf8');

// ---------------------------------------------------------------- part 1: fake runner
const { createPowerShellClient, toArray } = await import(
  new URL('../../../packages/collectors/windows/powershell.js', import.meta.url)
);

async function probe(label, stdout, { code = 0, stderr = '' } = {}) {
  const runner = { run: async () => ({ ok: true, code, stdout, stderr, durationMs: 1 }) };
  const client = createPowerShellClient({ runner });
  let outcome;
  try {
    const value = await client.runJson('# aegis-source:probe\n');
    outcome = { parsed: value === null ? 'null' : JSON.stringify(value), rows: toArray(value?.events ?? value) };
  } catch (error) {
    outcome = { error: error.code ?? error.name };
  }
  const silentEmpty = outcome.error === undefined && Array.isArray(outcome.rows) && outcome.rows.length === 0;
  note({
    id: label,
    stdout: JSON.stringify(stdout),
    outcome,
    expected: 'EMPTY_OUTPUT / BAD_JSON error: an exit-0 run that did not produce a table is not an empty read',
    verdict: outcome.error ? 'PASS(error)' : silentEmpty ? 'CONFLATED(silent empty read)' : 'OTHER',
  });
}

await probe('whitespace-space', ' ');
await probe('whitespace-crlf-tabs', '\r\n\t  \r\n');
await probe('bom-only', '\uFEFF');
await probe('bom-crlf', '\uFEFF\r\n');
await probe('empty-string', '');
await probe('whitespace-with-stderr-warning', ' \r\n', { stderr: 'WARNING: something went wrong' });
await probe('literal-null', 'null');
await probe('literal-null-bom', '\uFEFFnull');
await probe('empty-array', '[]');
await probe('empty-object', '{}');
await probe('number-zero', '0');
await probe('string-x', '"x"');
await probe('real-table-empty', '{"newestRecordId":0,"events":[]}');
await probe('nonjson', 'not json');

// ---------------------------------------------------- part 2: run-key provider path (real PS)
const { buildRunKeysScript, RUN_KEY_PATHS } = await import(
  new URL('../../../packages/collectors/windows/sources/run-keys.js', import.meta.url)
);
const script = buildRunKeysScript();
save('a2/runkeys-generated-script.ps1', script);
const psFile = join(EVIDENCE, 'a2', 'runkeys-generated-script.ps1');
const psRun = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024,
});
save('a2/runkeys-real-powershell.stdout.json', psRun.stdout ?? '');
save('a2/runkeys-real-powershell.stderr.txt', psRun.stderr ?? '');
let asShipped = { values: 0, deniedKeys: 0 };
try {
  const parsed = JSON.parse((psRun.stdout ?? '').trim());
  asShipped = { values: (parsed.values ?? []).length, deniedKeys: (parsed.deniedKeys ?? []).length };
} catch {
  asShipped = { values: -1, deniedKeys: -1 };
}
// same script with the provider colon added, to prove the colon is what makes the read work
const patched = script.replace(/'HKLM\\/g, "'HKLM:\\").replace(/'HKCU\\/g, "'HKCU:\\");
save('a2/runkeys-patched-colon-script.ps1', patched);
const fixedRun = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(EVIDENCE, 'a2', 'runkeys-patched-colon-script.ps1')], {
  encoding: 'utf8',
  timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024,
});
save('a2/runkeys-patched.stdout.json', fixedRun.stdout ?? '');
let asPatched = { values: 0, deniedKeys: 0 };
try {
  const parsed = JSON.parse((fixedRun.stdout ?? '').trim());
  asPatched = { values: (parsed.values ?? []).length, deniedKeys: (parsed.deniedKeys ?? []).length };
} catch {
  asPatched = { values: -1, deniedKeys: -1 };
}
note({
  id: 'run-key-provider-path',
  declaredKeys: RUN_KEY_PATHS,
  expected: 'the shipped script reads the declared keys (HKLM / HKCU provider form) and returns real values',
  actual: { asShipped: psRun.status === 0 ? asShipped : `exit=${psRun.status}`, colonPatched: asPatched },
  verdict: asShipped.values === 0 && asPatched.values > 0 ? 'BYPASS(provider path still missing: every key becomes missingKeys)' : 'PROBE',
  log: ['a2/runkeys-real-powershell.stdout.json', 'a2/runkeys-patched.stdout.json'],
});

// ------------------------------------------------------------------- part 3: mutations
function runSuite(label, suiteArgs, env) {
  const r = spawnSync(process.execPath, ['--import', join(HERE, 'hook-mutate.mjs'), ...suiteArgs], {
    encoding: 'utf8',
    timeout: 600_000,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  save(`mutations/${label}.log`, out);
  const tests = /ℹ tests (\d+)/.exec(out)?.[1] ?? '?';
  const pass = /ℹ pass (\d+)/.exec(out)?.[1] ?? '?';
  const fail = /ℹ fail (\d+)/.exec(out)?.[1] ?? '?';
  const failing = [...new Set([...out.matchAll(/^\s*(?:✖|not ok \d+ -)\s*(.+)$/gm)]
    .map((m) => m[1].replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '').trim())
    .filter((n) => n && !/^failing tests/.test(n)))];
  return { label, exit: r.status, tests, pass, fail, failing: failing.slice(0, 8) };
}

const suiteFiles = ['--test', 'tests/wp2-windows/powershell.test.js'];
note({ stage: 'powershell-before', ...runSuite('04-powershell-before-green', suiteFiles, {}) });
note({ stage: 'powershell-M1-empty-output-returns-null', ...runSuite('05-powershell-M1-red', suiteFiles, { RT_MUT: 'm1' }) });

const policyFiles = ['--test', 'packages/policy/test/model-routing.test.js'];
note({ stage: 'policy-before', ...runSuite('06-policy-before-green', policyFiles, {}) });
note({ stage: 'policy-M3-evidenceRef-check-disabled', ...runSuite('07-policy-M3-red', policyFiles, { RT_MUT: 'm3' }) });

save('a2-summary.json', JSON.stringify(rows, null, 2));
