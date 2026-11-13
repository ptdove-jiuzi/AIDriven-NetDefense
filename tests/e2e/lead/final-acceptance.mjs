/**
 * final-acceptance.mjs — the Lead's single-command acceptance run.
 *
 * It freezes the build fingerprint first (so every number below belongs to one exact tree),
 * then runs each independent check as its own process, then re-computes the fingerprint to
 * prove the tree did not move under the measurements.
 *
 * usage: node tests/e2e/lead/final-acceptance.mjs [--out <dir>] [--skip-heavy]
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parseArgs, writeEvidence } from './common.mjs';

const REPO = process.cwd();
const CONSOLE_ROOT = join(REPO, 'apps', 'console-next');
const EXTENSIONS = ['.html', '.js', '.mjs', '.css', '.svg', '.json'];

/** Walk a directory, returning regular files with the wanted extensions. */
function walk(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) output.push(full);
  }
  return output;
}

/** sha256 over `path\0size\0content` for every asset, in a stable order. */
export function fingerprint() {
  const files = walk(CONSOLE_ROOT).sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  let bytes = 0;
  let newest = 0;
  for (const file of files) {
    const content = readFileSync(file);
    bytes += content.length;
    newest = Math.max(newest, statSync(file).mtimeMs);
    hash.update(relative(CONSOLE_ROOT, file).replaceAll('\\', '/')).update('\0');
    hash.update(String(content.length)).update('\0');
    hash.update(content);
  }
  return {
    fileCount: files.length,
    totalBytes: bytes,
    sha256: hash.digest('hex'),
    newestMtime: new Date(newest).toISOString(),
    latestFile: relative(CONSOLE_ROOT, files.reduce((newestFile, file) => (
      statSync(file).mtimeMs > statSync(newestFile).mtimeMs ? file : newestFile), files[0])),
  };
}

/** Run one check script and return its exit code plus a short tail. */
function runCheck(script, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(REPO, script), ...args], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('exit', (code) => {
      resolve({
        script,
        args,
        code,
        elapsedMs: Date.now() - started,
        // Keep only the tail: these scripts print large JSON evidence.
        tail: `${stdout}\n${stderr}`.trim().slice(-800),
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.out ?? join(REPO, 'docs', 'implementation', 'evidence', 'ui2', 'lead');
  mkdirSync(outDir, { recursive: true });
  const before = fingerprint();
  const checks = [];

  // Functional hard criteria — each is an independent process with its own exit code.
  checks.push(await runCheck('tests/e2e/lead/verify-i18n.mjs', ['--out', outDir]));
  checks.push(await runCheck('tests/e2e/lead/verify-drawer.mjs', ['--out', outDir]));
  checks.push(await runCheck('tests/e2e/lead/verify-placeholder.mjs', ['--out', outDir]));
  checks.push(await runCheck('tests/e2e/lead/verify-no-fake.mjs', ['--out', outDir]));
  checks.push(await runCheck('tests/e2e/lead/verify-secrets.mjs', ['--out', outDir]));
  checks.push(await runCheck('tests/e2e/lead/verify-inputs.mjs', ['--out', outDir]));
  checks.push(await runCheck('tests/e2e/lead/verify-settings-persistence.mjs', ['--out', outDir]));

  // The 6-view matrix, both stacks, both themes (48 view-checks total).
  const matrices = [];
  for (const [label, base, theme] of [
    ['data-dark', 'http://127.0.0.1:17512', 'dark'],
    ['data-light', 'http://127.0.0.1:17512', 'light'],
    ['empty-dark', 'http://127.0.0.1:17522', 'dark'],
    ['empty-light', 'http://127.0.0.1:17522', 'light'],
  ]) {
    const shotDir = join(outDir, 'shots', label);
    const result = await runCheck('tests/e2e/smoke-views.mjs', ['--base', base, '--theme', theme, '--out', shotDir]);
    matrices.push({ label, base, theme, ...result });
  }

  const after = fingerprint();
  const movedDuringRun = before.sha256 !== after.sha256;
  const summary = {
    at: new Date().toISOString(),
    build: { before, after, movedDuringRun },
    checks: checks.map((entry) => ({
      script: entry.script, code: entry.code, passed: entry.code === 0, elapsedMs: entry.elapsedMs,
    })),
    matrices: matrices.map((entry) => ({
      label: entry.label, code: entry.code, passed: entry.code === 0, elapsedMs: entry.elapsedMs,
    })),
    totals: {
      checksPassed: checks.filter((entry) => entry.code === 0).length,
      checksTotal: checks.length,
      matricesPassed: matrices.filter((entry) => entry.code === 0).length,
      matricesTotal: matrices.length,
    },
  };
  summary.pass = !movedDuringRun
    && summary.totals.checksPassed === summary.totals.checksTotal
    && summary.totals.matricesPassed === summary.totals.matricesTotal;

  const evidence = writeEvidence(outDir, 'final-acceptance.json', { summary, details: { checks, matrices } });
  // A machine-readable one-liner for whoever reads the log.
  writeFileSync(join(outDir, 'final-acceptance.txt'), [
    `at=${summary.at}`,
    `build=${before.sha256.slice(0, 16)} files=${before.fileCount} movedDuringRun=${movedDuringRun}`,
    ...checks.map((entry) => `${entry.code === 0 ? 'PASS' : 'FAIL'} checks/${entry.script.split('/').pop()} exit=${entry.code} ${entry.elapsedMs}ms`),
    ...matrices.map((entry) => `${entry.code === 0 ? 'PASS' : 'FAIL'} matrix/${entry.label} exit=${entry.code} ${entry.elapsedMs}ms`),
    `verdict=${summary.pass ? 'PASS' : 'FAIL'}`,
  ].join('\n'), 'utf8');
  process.stdout.write(`${JSON.stringify({ summary, evidence }, null, 2)}\n`);
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`final-acceptance: ${error?.stack ?? error}\n`);
  process.exit(1);
});

