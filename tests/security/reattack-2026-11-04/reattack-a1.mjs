/**
 * REV-E reattack harness for the Python uninstaller ownership gate.
 *
 * Run:  node tests/security/reattack-2026-11-04/reattack-a1.mjs
 * Writes raw evidence into docs/implementation/evidence/review/2026-11-04/command/reattack/a1/
 * and prints one JSON line per case: {id, expected, actual, verdict, log}
 *
 * Nothing under apps/ packages/ deploy/ is written: every fixture lives in %TEMP%,
 * the installer itself is only executed.
 *
 * Author: PT-dove
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const INSTALLER_APP = join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');
const PYTHON = existsSync('D:\\Python311\\python.exe') ? 'D:\\Python311\\python.exe' : 'python';
const EVIDENCE = join(
  REPO_ROOT,
  'docs',
  'implementation',
  'evidence',
  'review',
  '2026-11-04',
  'command',
  'reattack',
  'a1',
);
mkdirSync(EVIDENCE, { recursive: true });

const BASE = mkdtempSync(join(tmpdir(), 'rta1-'));
let seq = 0;
const results = [];

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function sentinel(root, name = 'keep-me-USERDATA.txt') {
  const p = join(root, name);
  write(p, 'irreplaceable user data; a refused uninstall must not touch this\n');
  return p;
}

function tree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(rel + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name), rel);
    }
  };
  walk(root, '');
  return out.sort();
}

function record(id, { expected, actual, verdict, note = '', raw = '' }) {
  seq += 1;
  const name = `${String(seq).padStart(2, '0')}-${id}`;
  write(join(EVIDENCE, `${name}.log`), `${raw}\n`);
  const row = { id, expected, actual, verdict, note, log: `a1/${name}.log` };
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
}

/** Run the real uninstaller. `rawTarget` is passed to /DIR verbatim. */
function runUninstall({ dirArg, cwd = INSTALLER_APP, mutateBefore = null, beforeSpawn = null }) {
  const work = mkdtempSync(join(tmpdir(), 'rta1-run-'));
  const logDir = join(work, 'temp');
  mkdirSync(logDir, { recursive: true });
  const env = {
    ...process.env,
    TEMP: logDir,
    TMP: logDir,
    PYTHONIOENCODING: 'utf-8',
    AIDN_SETUP_STARTMENU_DIR: join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: join(work, 'desktop'),
    AIDN_SETUP_PROGRAMDATA_DIR: join(work, 'programdata'),
  };
  if (beforeSpawn) beforeSpawn();
  const args = [join(INSTALLER_APP, 'main.py'), '/uninstall', `/DIR=${dirArg}`, '/NOREG'];
  const child = spawnSync(PYTHON, args, { encoding: 'utf8', timeout: 240_000, cwd, env });
  const logs = readdirSync(logDir).filter((n) => n.startsWith('AIDriven-Setup-') && n.endsWith('.log'));
  const log = logs.length > 0 ? readFileSync(join(logDir, logs[0]), 'utf8') : '';
  if (mutateBefore) mutateBefore(log);
  return { code: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '', log };
}

const genuineRecord = (target, over = {}) => ({
  product: 'AIDriven NetDefense',
  version: '0.0.1-rc.3',
  installPath: target,
  installedAt: '2026-11-04T20:00:00+08:00',
  desktopExe: 'AIDrivenNetDefense.exe',
  entryKind: 'exe',
  autostart: false,
  upgradedFrom: null,
  channel: 'installed',
  payloadKind: 'packaging-poc',
  payloadBuiltAt: '2026-11-04T11:32:56.343Z',
  payloadSchema: '1.0',
  ...over,
});

function genuineTree(target) {
  mkdirSync(join(target, 'runtime', 'node'), { recursive: true });
  write(join(target, 'runtime', 'node', 'node.exe'), 'fixture runtime placeholder\n');
  write(join(target, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  write(join(target, 'install', 'install.json'), `${JSON.stringify(genuineRecord(target), null, 2)}\n`);
}

function bundleTree(target, { bundle, manifest } = {}) {
  mkdirSync(join(target, 'runtime', 'node'), { recursive: true });
  write(join(target, 'runtime', 'node', 'node.exe'), 'fixture runtime placeholder\n');
  write(join(target, 'AIDrivenNetDefense.exe'), 'MZ fixture shell\n');
  write(join(target, 'bundle.json'), JSON.stringify(bundle ?? {
    schemaVersion: '1.0',
    author: 'PT-dove',
    kind: 'packaging-poc',
    builtAt: '2026-11-04T11:32:56.343Z',
    paths: { node: 'runtime/node/node.exe', console: 'console/index.html' },
  }, null, 2) + '\n');
  write(join(target, 'manifests', 'files.sha256'), manifest ?? (`${'a'.repeat(64)}  runtime/node/node.exe\n`));
}

const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'MISSING');

// ---------------------------------------------------------------- controls
{
  const t = join(BASE, 'control-genuine', 'AIDriven NetDefense');
  genuineTree(t);
  const r = runUninstall({ dirArg: t });
  record('control-genuine-record', {
    expected: 'exit 0 and tree removed (control: the gate must still let a real install uninstall)',
    actual: `exit=${r.code} treeExists=${existsSync(t)}`,
    verdict: r.code === 0 && !existsSync(t) ? 'PASS(control)' : 'FAIL(control)',
    raw: r.log,
  });
}
{
  const t = join(BASE, 'control-bundle', 'AIDriven NetDefense');
  bundleTree(t);
  const r = runUninstall({ dirArg: t });
  record('control-bundle-poc', {
    expected: 'exit 0 and tree removed',
    actual: `exit=${r.code} treeExists=${existsSync(t)}`,
    verdict: r.code === 0 && !existsSync(t) ? 'PASS(control)' : 'FAIL(control)',
    raw: r.log,
  });
}

// ------------------------------------------- attack 1: forged install.json
// Threat model: the /DIR value is attacker-influenced (or a typo), the attacker can plant
// files only inside the directory being deleted.  A forged record is the cheapest way to
// talk the gate into "this directory is ours".
const forgedRecords = [
  ['forged-record-version-only', { product: 'AIDriven NetDefense', version: '1.2.3' }],
  ['forged-record-channel-only', { product: 'AIDriven NetDefense', channel: 'portable' }],
  ['forged-record-zh-product', { product: '网域智防', version: '0.0.1' }],
  [
    'forged-record-array-types',
    { product: ['AIDriven NetDefense'], version: ['0.0.1'], installPath: ['x'], channel: ['installed'] },
  ],
  ['forged-record-nulls', { product: 'AIDriven NetDefense', version: null, installPath: null, channel: null }],
];
for (const [id, record_] of forgedRecords) {
  const t = join(BASE, id, 'user-documents');
  write(join(t, 'thesis.docx'), 'the only copy\n');
  write(join(t, 'install', 'install.json'), JSON.stringify(record_));
  const s = sentinel(t);
  const before = tree(t);
  const r = runUninstall({ dirArg: t });
  record(id, {
    expected: 'exit 5 (UninstallRefused), sentinel + thesis intact: a record the attacker wrote is not proof of ownership',
    actual: `exit=${r.code} sentinelExists=${existsSync(s)} tree=${JSON.stringify(tree(t))}`,
    verdict: r.code === 5 && existsSync(s) && JSON.stringify(tree(t)) === JSON.stringify(before) ? 'PASS' : 'BYPASS',
    note: r.code === 0 ? 'directory was deleted on a forged record' : '',
    raw: `record=${JSON.stringify(record_)}\n--- log ---\n${r.log}`,
  });
}

// ------------------------------- attack 2: forged bundle.json + sha256 manifest
const forgedBundles = [
  [
    'forged-bundle-minimal',
    { schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc', paths: { node: 'runtime/node/node.exe' } },
    `${'a'.repeat(64)}  runtime/node/node.exe\n`,
  ],
  [
    'forged-bundle-crlf-bom',
    { schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc', paths: { node: 'runtime/node/node.exe' } },
    `\uFEFF# header\r\n${'b'.repeat(64)}  runtime/node/node.exe\r\n`,
  ],
  [
    'forged-bundle-absurd-path',
    { schemaVersion: '1.0', author: 'PT-dove', kind: 'packaging-poc', paths: { node: '..\\..\\runtime/node/node.exe' } },
    `${'c'.repeat(64)}  ../../../../runtime/node/node.exe\n`,
  ],
];
for (const [id, bundle, manifest] of forgedBundles) {
  const t = join(BASE, id, 'user-documents');
  write(join(t, 'thesis.docx'), 'the only copy\n');
  bundleTree(t, { bundle, manifest });
  const s = sentinel(t);
  const r = runUninstall({ dirArg: t });
  record(id, {
    expected: 'exit 5, nothing deleted: hand-written bundle.json + one fabricated manifest row is not payload identity',
    actual: `exit=${r.code} sentinelExists=${existsSync(s)} victimFileExists=${existsSync(join(t, 'thesis.docx'))}`,
    verdict: r.code === 5 && existsSync(s) && existsSync(join(t, 'thesis.docx')) ? 'PASS' : 'BYPASS',
    note: r.code === 0 ? 'directory was deleted on a forged bundle pair' : '',
    raw: `bundle=${JSON.stringify(bundle)}\nmanifest=${JSON.stringify(manifest)}\n--- log ---\n${r.log}`,
  });
}

// --------------------------------------------- attack 3: path spelling variants
const pathCases = [
  ['path-trailing-dot', (t) => `${t}.`],
  ['path-trailing-space', (t) => `${t} `],
  ['path-extended-prefix', (t) => `\\\\?\\${t}`],
  ['path-device-prefix', (t) => `\\\\.\\${t}`],
  ['path-dotdot-reentry', (t) => `${dirname(t)}\\${'x'}\\..\\${'user-documents'}`],
  ['path-mixed-case', (t) => t.toUpperCase()],
  ['path-relative', (t) => '../'.repeat(0) + t.slice(3)], // C:\Users\... -> \Users\... (drive-relative)
  ['path-quoted', (t) => `"${t}"`],
];
for (const [id, make] of pathCases) {
  const t = join(BASE, id, 'user-documents');
  mkdirSync(join(t, 'nested'), { recursive: true });
  write(join(t, 'thesis.docx'), 'the only copy\n');
  genuineTree(t);
  const s = sentinel(t);
  const dirArg = make(t);
  const r = runUninstall({ dirArg });
  const deleted = !existsSync(t) || !existsSync(s);
  record(id, {
    expected: 'either a genuine tree is uninstalled (exit 0, tree gone) or the refusal leaves everything intact; never a partial delete',
    actual: `dirArg=${JSON.stringify(dirArg)} exit=${r.code} treeExists=${existsSync(t)} sentinelExists=${existsSync(s)}`,
    verdict:
      (r.code === 0 && !existsSync(t)) || (r.code === 5 && existsSync(s))
        ? 'PASS'
        : deleted && r.code !== 0
          ? 'INCONSISTENT'
          : `BYPASS/OTHER(exit=${r.code})`,
    note: r.code === 3 ? 'EXIT_ERROR / not-a-directory path' : '',
    raw: `dirArg=${dirArg}\n--- log ---\n${r.log}`,
  });
}

// ------------------------------------- attack 4: junction as a *child* of a real tree
{
  const root = join(BASE, 'junction-child');
  const t = join(root, 'AIDriven NetDefense');
  const victim = join(root, 'victim-docs');
  genuineTree(t);
  mkdirSync(victim, { recursive: true });
  write(join(victim, 'thesis.docx'), 'the only copy\n');
  const s = sentinel(victim);
  const mk = spawnSync('cmd', ['/c', 'mklink', '/J', join(t, 'linked'), victim], { encoding: 'utf8' });
  const r = runUninstall({ dirArg: t });
  record('junction-child-inside-owned-tree', {
    expected: 'the uninstaller must not delete *through* a junction that lives inside the tree it may delete',
    actual: `mklinkExit=${mk.status} uninstallExit=${r.code} victimSentinelExists=${existsSync(s)} victimFiles=${JSON.stringify(tree(victim))}`,
    verdict: existsSync(s) && existsSync(join(victim, 'thesis.docx')) ? 'PASS' : 'BYPASS',
    note: 'both the record and the child junction are attacker-plantable inside the target',
    raw: `mklink stdout=${mk.stdout} stderr=${mk.stderr}\n--- log ---\n${r.log}`,
  });
}

// --------------------------------------------- attack 5: TOCTOU root swap
{
  const root = join(BASE, 'toctou');
  const t = join(root, 'AIDriven NetDefense');
  const victim = join(root, 'victim-docs');
  genuineTree(t);
  mkdirSync(victim, { recursive: true });
  write(join(victim, 'thesis.docx'), 'the only copy\n');
  write(join(victim, 'sub', 'draft.md'), 'a draft\n');
  const s = sentinel(victim);
  const victimBefore = tree(victim);

  const work = mkdtempSync(join(tmpdir(), 'rta1-toctou-'));
  const logDir = join(work, 'temp');
  mkdirSync(logDir, { recursive: true });
  const env = {
    ...process.env,
    TEMP: logDir,
    TMP: logDir,
    PYTHONIOENCODING: 'utf-8',
    AIDN_SETUP_STARTMENU_DIR: join(work, 'start-menu'),
    AIDN_SETUP_DESKTOP_DIR: join(work, 'desktop'),
    AIDN_SETUP_PROGRAMDATA_DIR: join(work, 'programdata'),
  };
  const child = spawn(PYTHON, [join(INSTALLER_APP, 'main.py'), '/uninstall', `/DIR=${t}`, '/NOREG'], {
    cwd: INSTALLER_APP,
    env,
    stdio: 'ignore',
  });
  // Poll the run log for the ownership verdict, then swap the directory *after* the check.
  let swapped = false;
  let swapDetail = '';
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const logs = readdirSync(logDir).filter((n) => n.startsWith('AIDriven-Setup-'));
    const log = logs.length > 0 ? readFileSync(join(logDir, logs[0]), 'utf8') : '';
    if (!swapped && /install marker:/.test(log)) {
      const rm = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', t], { encoding: 'utf8' });
      const mk = spawnSync('cmd', ['/c', 'mklink', '/J', t, victim], { encoding: 'utf8' });
      swapped = true;
      swapDetail = `rmdirExit=${rm.status} mklinkExit=${mk.status} mklinkErr=${(mk.stderr || '').trim()}`;
      break;
    }
    if (child.exitCode !== null) break;
    spawnSync('cmd', ['/c', 'ping', '-n', '1', '-w', '5', '127.0.0.1'], { stdio: 'ignore' });
  }
  const exitCode = await new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit(child.exitCode);
    child.on('exit', (code) => resolveExit(code));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolveExit('TIMEOUT');
    }, 120_000);
  });
  const log = readdirSync(logDir).filter((n) => n.startsWith('AIDriven-Setup-')).map((n) => readFileSync(join(logDir, n), 'utf8')).join('\n');
  record('toctou-root-swap', {
    expected: 'a directory swapped to a junction after the ownership check must not make the uninstaller delete the junction target',
    actual: `swapped=${swapped} ${swapDetail} exit=${exitCode} victimSentinelExists=${existsSync(s)} victimFiles=${JSON.stringify(tree(victim))} victimBefore=${JSON.stringify(victimBefore)}`,
    verdict: existsSync(s) && existsSync(join(victim, 'thesis.docx')) ? 'PASS' : swapped ? 'BYPASS' : 'INCONCLUSIVE',
    note: swapped ? '' : 'the swap window was missed; report as not proven either way',
    raw: `target=${t}\nvictim=${victim}\n${swapDetail}\n--- log ---\n${log}`,
  });
}

// ---------------------------------------------------- attack 6: empty-dir exception
{
  const t = join(BASE, 'empty-dir', 'empty');
  mkdirSync(t, { recursive: true });
  const r = runUninstall({ dirArg: t });
  record('empty-dir-exception', {
    expected: 'by design an empty directory is removed (nothing to lose); recorded so the exception is not a silent surprise',
    actual: `exit=${r.code} treeExists=${existsSync(t)}`,
    verdict: r.code === 0 && !existsSync(t) ? 'PASS(by design)' : 'OTHER',
    raw: r.log,
  });
}

write(join(EVIDENCE, 'summary.json'), JSON.stringify({ base: BASE, results }, null, 2));
console.log(JSON.stringify({ base: BASE, total: results.length }));
process.exit(0);
