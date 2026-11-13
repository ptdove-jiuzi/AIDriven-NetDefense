/**
 * REV-E mutation proof for the A1 uninstaller ownership gate.
 *
 * The product files are NEVER edited. The installer tree and its regression test are
 * copied into %TEMP%; each mutation is applied to the *copy*; the copied regression test
 * must turn red on exactly the cases that mutation removes, and green again after restore.
 *
 * Run: node tests/security/reattack-2026-11-04/mutate-a1.mjs
 * Author: PT-dove
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const EVIDENCE = join(
  REPO_ROOT,
  'docs',
  'implementation',
  'evidence',
  'review',
  '2026-11-04',
  'command',
  'reattack',
  'mutations',
);
mkdirSync(EVIDENCE, { recursive: true });

const MIRROR = join(tmpdir(), `rta1-mut-${Date.now()}`);
cpSync(join(REPO_ROOT, 'deploy', 'windows', 'installer'), join(MIRROR, 'deploy', 'windows', 'installer'), {
  recursive: true,
});
mkdirSync(join(MIRROR, 'tests', 'installer'), { recursive: true });
const testFile = join('tests', 'installer', 'uninstall-ownership.test.js');
cpSync(join(REPO_ROOT, testFile), join(MIRROR, testFile));
const INSTALL_PY = join(MIRROR, 'deploy', 'windows', 'installer', 'app', 'aidn', 'install.py');
const ORIGINAL = readFileSync(INSTALL_PY, 'utf8');

function runSuite(label) {
  const r = spawnSync(process.execPath, ['--test', join(MIRROR, testFile)], {
    encoding: 'utf8',
    timeout: 600_000,
    cwd: MIRROR,
    env: { ...process.env, AIDN_PYTHON: existsSync('D:\\Python311\\python.exe') ? 'D:\\Python311\\python.exe' : 'python' },
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  writeFileSync(join(EVIDENCE, `${label}.log`), out, 'utf8');
  const tests = /ℹ tests (\d+)/.exec(out)?.[1] ?? '?';
  const pass = /ℹ pass (\d+)/.exec(out)?.[1] ?? '?';
  const fail = /ℹ fail (\d+)/.exec(out)?.[1] ?? '?';
  // Names of failing tests: node --test prints "✖ name" / "not ok" lines.
  const failing = [...out.matchAll(/^\s*(?:✖|not ok \d+ -)\s*(.+)$/gm)]
    .map((m) => m[1].replace(/\s*\(\d+(\.\d+)?ms\)\s*$/, '').trim())
    .filter((n) => n && !n.startsWith('failing tests'));
  return { label, exit: r.status, tests, pass, fail, failing };
}

/** Insert `return <value>` immediately after a def line in the copied file. */
function mutate(fn, value) {
  const marker = `def ${fn}(`;
  const idx = ORIGINAL.indexOf(marker);
  if (idx < 0) throw new Error(`function not found: ${fn}`);
  const lineEnd = ORIGINAL.indexOf('\n', idx);
  const mutated = `${ORIGINAL.slice(0, lineEnd + 1)}    return ${value}  # MUTATION: ${fn} short-circuited\n${ORIGINAL.slice(lineEnd + 1)}`;
  writeFileSync(INSTALL_PY, mutated, 'utf8');
}

const record = [];
const note = (o) => {
  record.push(o);
  console.log(JSON.stringify(o));
};

// 0) baseline of the copied tree
note({ stage: 'before(mirror)', ...runSuite('01-before-green') });

const MUTATIONS = [
  ['M-A-record-is-ours', '_record_is_ours', "'MUTATION'", 'install.json content identity check'],
  ['M-B-bundle-is-ours', '_bundle_is_ours', 'True', 'bundle.json content identity check'],
  ['M-C-manifest-has-rows', '_manifest_has_rows', 'True', 'hash-manifest row check'],
  ['M-D-link-reason', '_link_reason', 'None', 'symlink/junction rejection'],
  ['M-E-install-marker', '_install_marker', "'MUTATION'", 'the whole ownership gate'],
];
for (const [label, fn, value, what] of MUTATIONS) {
  mutate(fn, value);
  const r = runSuite(`02-${label}`);
  note({ stage: label, removed: what, ...r });
  writeFileSync(INSTALL_PY, ORIGINAL, 'utf8');
}

// restored
note({ stage: 'after(restore)', ...runSuite('03-after-restore-green') });
writeFileSync(
  join(EVIDENCE, 'summary.json'),
  JSON.stringify({ mirror: MIRROR, originalSha: 'n/a', record }, null, 2),
  'utf8',
);
try {
  rmSync(MIRROR, { recursive: true, force: true, maxRetries: 3 });
} catch {}
