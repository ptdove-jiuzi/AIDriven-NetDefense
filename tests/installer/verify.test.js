/**
 * `/verify` — the read-only check.
 *
 * The assertion that matters most here is the boring one: **nothing is written**. A verify
 * that "repairs what it finds" cannot be used to decide whether to trust an install.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runInstall } from '../../deploy/windows/installer/src/install.mjs';
import { runVerify } from '../../deploy/windows/installer/src/verify.mjs';
import { createPayload, disarmContext, tempRoot } from './fixtures/payload.mjs';

const INSTALLER_SOURCE = fileURLToPath(new URL('../../deploy/windows/installer/', import.meta.url));

async function installed(t) {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const context = disarmContext(join(root, 'install-root'));
  const result = await runInstall({
    layout: context.layout,
    options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE },
    logger: context.logger,
    ops: context.ops,
  });
  assert.equal(result.code, 0, result.message);
  return { root, payload, ...context };
}

/** Path → size+mtime, so a write of the same bytes is still detected. */
function snapshot(directory) {
  const out = new Map();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        const stats = statSync(child);
        out.set(child, `${stats.size}:${stats.mtimeMs}`);
      }
    }
  };
  walk(directory);
  return out;
}

test('/verify passes a freshly installed tree and reports what it did not check', async (t) => {
  const { layout, payload, logger } = await installed(t);
  const result = await runVerify({ layout, logger });

  assert.equal(result.code, 0, result.message);
  assert.equal(result.report.checked, payload.fileCount);
  assert.equal(result.report.missing, 0);
  assert.equal(result.report.mismatched, 0);
  assert.equal(result.report.extras, 0);
  assert.equal(result.report.version, '0.0.1');
  assert.equal(result.report.signatureChecked, false, 'verify must not imply an Authenticode check happened');
  assert.match(result.message, /未做签名校验/u);
});

test('/verify writes absolutely nothing', async (t) => {
  const { layout, logger } = await installed(t);
  const before = snapshot(layout.dataRoot);
  const beforeJournal = readFileSync(layout.journalPath);
  const beforePlan = existsSync(layout.planPath) ? readFileSync(layout.planPath) : null;

  const result = await runVerify({ layout, logger });
  assert.equal(result.code, 0, result.message);

  const after = snapshot(layout.dataRoot);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'verify created or removed files');
  for (const [path, signature] of before) {
    assert.equal(after.get(path), signature, `verify modified ${path}`);
  }
  assert.deepEqual(readFileSync(layout.journalPath), beforeJournal);
  if (beforePlan !== null) assert.deepEqual(readFileSync(layout.planPath), beforePlan);
});

test('/verify reports a tampered payload file with 12', async (t) => {
  const { layout, logger } = await installed(t);
  writeFileSync(join(layout.appRoot, 'apps/daemon/bin.js'), '// swapped after install\n');

  const result = await runVerify({ layout, logger });
  assert.equal(result.code, 12, result.message);
  assert.equal(result.report.mismatched, 1);
});

test('/verify reports a missing file with 12', async (t) => {
  const { layout, logger } = await installed(t);
  const { rmSync } = await import('node:fs');
  rmSync(join(layout.appRoot, 'rules/pack.json'));

  const result = await runVerify({ layout, logger });
  assert.equal(result.code, 12, result.message);
  assert.equal(result.report.missing, 1);
});

test('/verify catches a rewritten manifest even when every file matches it', async (t) => {
  const { layout, logger } = await installed(t);
  const manifestPath = join(layout.appRoot, 'manifests', 'files.sha256');
  writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}# appended comment\n`);

  const result = await runVerify({ layout, logger });
  assert.equal(result.code, 12, result.message);
  assert.match(result.message, /清单被改写/u);
});

test('/verify on a machine with no install is 10, not a false pass', async (t) => {
  const root = tempRoot(t);
  const { layout, logger } = disarmContext(join(root, 'install-root'));
  const result = await runVerify({ layout, logger });
  assert.equal(result.code, 10);
  assert.match(result.message, /未安装/u);
});
