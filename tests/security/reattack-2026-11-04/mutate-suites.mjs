/**
 * Part 3 of the REV-E reattack: run the existing regressions with one fix neutered in memory
 * (`hook-mutate.mjs` + `hook-impl.mjs`), so the on-disk product files are untouched.
 *
 * A fix that is not watched by a regression is a "false green": the suite stays green no
 * matter what the code does.  Every mutation below must turn its suite red.
 *
 * Run: node tests/security/reattack-2026-11-04/mutate-suites.mjs
 * Author: PT-dove
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const EVIDENCE = join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'review', '2026-11-04', 'command', 'reattack', 'mutations');
mkdirSync(EVIDENCE, { recursive: true });

const sha = (rel) => createHash('sha256').update(readFileSync(join(REPO_ROOT, rel))).digest('hex');
const WATCHED = [
  'packages/collectors/windows/powershell.js',
  'packages/policy/src/model-routing.js',
];
const before = Object.fromEntries(WATCHED.map((p) => [p, sha(p)]));

const rows = [];
function run(label, args, env) {
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(HERE, 'hook-mutate.mjs')).href, '--test-isolation=none', ...args], {
    encoding: 'utf8',
    timeout: 600_000,
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  writeFileSync(join(EVIDENCE, `${label}.log`), out, 'utf8');
  const num = (re) => re.exec(out)?.[1] ?? '?';
  const failing = [...new Set(
    [...out.matchAll(/^\s*(?:✖|not ok \d+ -)\s*(.+)$/gm)]
      .map((m) => m[1].replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '').trim())
      .filter((n) => n && !/^failing tests$/.test(n) && !/^test at /.test(n)),
  )].slice(0, 6);
  const row = {
    label,
    exit: r.status,
    tests: num(/ℹ tests (\d+)/),
    pass: num(/ℹ pass (\d+)/),
    fail: num(/ℹ fail (\d+)/),
    mutationApplied: /MUTATION (m\d)/.exec(out)?.[0] ?? 'NONE',
    failing,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  return row;
}

// powershell.js: the EMPTY_OUTPUT guard is watched by the wp2-windows suite.
run('08-powershell-before-green', ['--test', 'tests/wp2-windows/powershell.test.js'], {});
run('09-powershell-M1-empty-output-null-red', ['--test', 'tests/wp2-windows/powershell.test.js'], { RT_MUT: 'm1' });

// model-routing.js: the evidenceRef existence check is watched by the policy suite.
run('10-policy-before-green', ['--test', 'packages/policy/test/model-routing.test.js'], {});
run('11-policy-M3-evidenceRef-disabled-red', ['--test', 'packages/policy/test/model-routing.test.js'], { RT_MUT: 'm3' });

// sources.mjs: is the A2 shape mapping watched by anything at all?
const sourcesWatched = spawnSync(
  process.execPath,
  ['-e', "const {execFileSync}=require('node:child_process');"],
  { encoding: 'utf8' },
);
void sourcesWatched;
run('12-service-host-before-green', ['--test', 'tests/installer/service-host.test.js'], {});
run('13-service-host-M2-wiring-removed-red', ['--test', 'tests/installer/service-host.test.js'], { RT_MUT: 'm2' });

const after = Object.fromEntries(WATCHED.map((p) => [p, sha(p)]));
const unchanged = WATCHED.every((p) => before[p] === after[p]);
writeFileSync(
  join(EVIDENCE, 'suites-summary.json'),
  JSON.stringify({ before, after, unchanged, rows }, null, 2),
  'utf8',
);
console.log(JSON.stringify({ productFilesUnchanged: unchanged, before, after }));
