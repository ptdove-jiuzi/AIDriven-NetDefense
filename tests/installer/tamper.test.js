/**
 * The hash gate: what happens when the payload does not match its own manifest.
 *
 * This is the case the whole P1 slice exists for. ADR §5.1 says "缺一即码 12" and §6 says
 * a failed install must leave nothing behind — so each test asserts both the exit code
 * *and* that the machine is in the state it was in before (N1).
 */

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runInstall } from '../../deploy/windows/installer/src/install.mjs';
import { loadJournal } from '../../deploy/windows/installer/src/journal.mjs';
import { createPayload, disarmContext, readPlan, tempRoot } from './fixtures/payload.mjs';

const INSTALLER_SOURCE = fileURLToPath(new URL('../../deploy/windows/installer/', import.meta.url));

test('a modified payload file aborts the install with 12 and leaves no program tree', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'), {
    tamper: { path: 'apps/daemon/bin.js', contents: '// replaced after the manifest was written\n' },
  });
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));

  const result = await runInstall({
    layout, options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE }, logger, ops,
  });

  assert.equal(result.code, 12, result.message);
  assert.match(result.message, /校验失败|摘要不符/u);
  assert.equal(existsSync(layout.appRoot), false, 'the payload must not survive a failed verification');
  assert.equal(existsSync(layout.stagingRoot), false, 'staging must be cleaned up');
  assert.equal(existsSync(layout.installReceiptPath), false, 'no receipt may be written for a failed install');

  const journal = loadJournal(layout.journalPath);
  assert.equal(journal.state, 'ok');
  assert.equal(journal.journal.phase, 'ROLLED_BACK');

  // The service was never registered, but rollback still tries to remove it (idempotent).
  const plan = readPlan(layout);
  assert.equal(plan.some((entry) => entry.op === 'service.install'), false);
  assert.equal(plan.some((entry) => entry.op === 'service.delete'), true);
});

test('an unlisted extra file in the payload aborts with 12 (not "extra files are fine")', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  // Written after the manifest, exactly like a dropped-in DLL.
  writeFileSync(join(payload.root, 'apps/daemon/injected.dll'), 'not in the manifest\n');
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));

  const result = await runInstall({
    layout, options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE }, logger, ops,
  });
  assert.equal(result.code, 12, result.message);
  assert.match(result.message, /清单外多出/u);
  assert.equal(existsSync(layout.appRoot), false);
});

test('a manifest rewritten during staging is caught by the digest comparison (12)', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));

  // Simulates the failure mode ADR §5.1 forbids: an installer that "fixes up" the payload
  // and then re-signs its own list. The digest is what makes it visible.
  const result = await runInstall({
    layout,
    options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE },
    logger,
    ops,
    hooks: {
      onPhase: (phase) => {
        if (phase === 'STAGED') {
          appendFileSync(join(layout.stagingDir, 'manifests', 'files.sha256'), `${'0'.repeat(64)}  apps/daemon/extra.js\n`);
        }
      },
    },
  });

  assert.equal(result.code, 12, result.message);
  assert.match(result.message, /清单被改写|摘要/u);
  assert.equal(existsSync(layout.appRoot), false);
});

test('the journal phase is on disk before the action it describes (write-ahead, §6.1)', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));

  let observedPhase = null;
  let observedAppExists = null;
  const result = await runInstall({
    layout,
    options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE },
    logger,
    ops,
    hooks: {
      onPhase: (phase) => {
        if (phase !== 'SWAP_B') return;
        // Read the journal *from disk* at the moment the swap is about to happen.
        observedPhase = JSON.parse(readFileSync(layout.journalPath, 'utf8')).phase;
        observedAppExists = existsSync(layout.appRoot);
        throw new Error('simulated power loss at SWAP_B');
      },
    },
  });

  assert.equal(observedPhase, 'SWAP_B', 'journal must be flushed before the rename, not after');
  assert.equal(observedAppExists, false, 'the rename must not have happened yet');

  // The simulated crash was recovered on the spot: no half-installed tree remains.
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(layout.appRoot), false);
  const journal = loadJournal(layout.journalPath);
  assert.equal(journal.journal.phase, 'ROLLED_BACK');
  assert.ok(journal.journal.data.steps.some((step) => step.phase === 'SWAP_B'),
    'the SWAP_B intent must remain in the history for a human to read');
});

test('a manifest path that climbs out of the payload is refused before copying (12)', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  appendFileSync(payload.manifestPath, `${'a'.repeat(64)}  ../../Windows/System32/evil.dll\n`);
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));

  const result = await runInstall({
    layout, options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE }, logger, ops,
  });
  assert.equal(result.code, 12);
  assert.match(result.message, /解析失败|清单路径非法/u);
  assert.equal(existsSync(layout.programRoot), false);
});
