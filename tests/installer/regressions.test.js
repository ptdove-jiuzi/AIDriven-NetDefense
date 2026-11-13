/**
 * Regressions for the P0/P1 round (see `docs/implementation/reviews/p1-p2-review.md`).
 *
 * One test per finding, and each one is written so that **reverting the fix turns it red**:
 *
 * | test | finding |
 * |---|---|
 * | repair fails during staging → the working install survives | P0 / R1 |
 * | repair fails after SWAP_B → app.prev is put back, records agree | P0 (restore half) |
 * | ...and the service, bin\ and shortcut it depends on are kept | P0 (same rule, other side effects) |
 * | SWAP_B crash scene converges with 26 | H1 |
 * | STAGED crash scene converges with 26 | H1 |
 * | a ROLLING_BACK scene with an unidentifiable app\ is diagnosed, not deleted | H2 / P0 |
 * | combination 4 stops and touches nothing | H1 / H2 |
 * | rollback revokes registry, shortcut, bin\, data | H3 |
 * | `--event-log-readers` was evidence of nothing | H4 (false green) |
 * | a service that is already gone is not a failure | H5 |
 * | deferred removal keeps its marker when rmdir fails (executed) | H6 |
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appRootOwnership,
  assessExistingTreePair,
  journalSwapProgress,
  runInstall,
} from '../../deploy/windows/installer/src/install.mjs';
import { loadJournal, PHASES } from '../../deploy/windows/installer/src/journal.mjs';
import {
  deferredRemovalCommand,
  eventLogReadersScript,
  isServiceAbsentError,
  isServiceAbsentText,
  OpsError,
} from '../../deploy/windows/installer/src/ops.mjs';
import { runUninstall } from '../../deploy/windows/installer/src/uninstall.mjs';
import { runVerify } from '../../deploy/windows/installer/src/verify.mjs';
import { manifestDigestOf } from '../../deploy/windows/installer/src/recovery.mjs';
import { createPayload, disarmContext, readPlan, tempRoot } from './fixtures/payload.mjs';

const INSTALLER_SOURCE = fileURLToPath(new URL('../../deploy/windows/installer/', import.meta.url));
const INSTALLER_ROOT = fileURLToPath(new URL('../../deploy/windows/installer/', import.meta.url));

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function install({ layout, logger, ops, payload, version = '0.0.1' }) {
  return runInstall({
    layout,
    options: { payload, toVersion: version, engineSource: INSTALLER_SOURCE },
    logger,
    ops,
  });
}

/** Install once and return the context, with the receipt already verified. */
async function installed(t) {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const context = disarmContext(join(root, 'install-root'));
  const result = await install({ ...context, payload: payload.root });
  assert.equal(result.code, 0, result.message);
  return { root, payload, ...context };
}

/** Overwrite a journal phase (and optionally append the step that phase implies). */
function forcePhase(layout, phase, patch = {}) {
  const journal = readJsonFile(layout.journalPath);
  // A journal whose `phase` was edited while `steps` still ends in a settled `SWAP_B` from a
  // *previous, committed* transaction is a state the engine cannot produce (`beginJournal`
  // always starts with an empty `steps`). Asserting against it gives both false reds and
  // false greens, so the scene is rebuilt: every phase up to the crash point settled, the
  // last one still open — which is exactly what a crash leaves behind.
  const path = [PHASES.STAGED, PHASES.SWAP_A, PHASES.SWAP_B, PHASES.ROLLING_BACK];
  const upto = path.slice(0, path.indexOf(phase) + 1);
  journal.phase = phase;
  journal.steps = upto.map((name, index) => ({
    phase: name,
    at: new Date().toISOString(),
    ok: index === upto.length - 1 ? null : true,
    detail: 'crash scene',
  }));
  Object.assign(journal, patch);
  writeFileSync(layout.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  return journal;
}

// ----------------------------------------------------------------------------- P0 / R1

test('P0: a repair that fails during staging keeps the working install, and install.json stays accurate', async (t) => {
  const { root, layout, logger, ops, payload } = await installed(t);
  const digestBefore = manifestDigestOf(layout.appRoot);
  const receiptBefore = readJsonFile(layout.installReceiptPath);
  const sampleBefore = readFileSync(join(layout.appRoot, 'apps/daemon/bin.js'), 'utf8');

  // The repair payload is corrupt: one file was changed after its manifest was written.
  // That is the realistic trigger (bad download / antivirus lock / full disk), not a
  // hand-made state.
  const broken = createPayload(join(root, 'payload-broken'), {
    tamper: { path: 'apps/daemon/bin.js', contents: '// corrupted after manifest\n' },
  });
  const result = await install({ layout, logger, ops, payload: broken.root });

  assert.equal(result.code, 12, result.message);

  // 1. The verified install is still there, byte-identical.
  assert.equal(existsSync(layout.appRoot), true, 'rollback deleted the working install (P0)');
  assert.equal(manifestDigestOf(layout.appRoot), digestBefore);
  assert.equal(readFileSync(join(layout.appRoot, 'apps/daemon/bin.js'), 'utf8'), sampleBefore);
  assert.equal(existsSync(layout.stagingRoot), false, 'staging must still be cleaned up');

  // 2. install.json still describes exactly that tree — not "installed" over an empty disk.
  const receiptAfter = readJsonFile(layout.installReceiptPath);
  assert.deepEqual(receiptAfter, receiptBefore);
  assert.equal(receiptAfter.manifestDigest, digestBefore);
  assert.equal(readJsonFile(layout.versionFloorPath).hardFloorMax, '0.0.1');

  // 3. The journal explains what happened, in terms of the disk.
  const journal = loadJournal(layout.journalPath);
  assert.equal(journal.state, 'ok');
  assert.equal(journal.journal.phase, 'ROLLED_BACK');
  const rollback = journal.journal.data.rollback;
  assert.ok(rollback, 'the rollback must record what it did and what it left');
  assert.equal(rollback.facts.appExists, true);
  assert.equal(rollback.facts.receiptRemoved, false);
  assert.match(rollback.claim, /仍在/u);
  assert.ok(
    journal.journal.data.steps.some((step) => String(step.detail ?? '').includes('保留原有 app')),
    'the journal must say the tree was preserved, not silently skipped',
  );

  // 4. ...and the guard that produced that outcome is not a coincidence: the same transaction
  //    reports "app is not mine". Remove the ownership check and this assertion goes red.
  const reloaded = loadJournal(layout.journalPath).journal;
  const ownership = appRootOwnership({ layout, journal: reloaded });
  assert.equal(ownership.owned, false);
  assert.match(ownership.reason, /SWAP_A 未成功/u);
  assert.deepEqual(journalSwapProgress(reloaded), { swapA: false, swapB: false });
});

test('P0: a repair that fails after SWAP_B puts app.prev back and leaves the records agreeing', async (t) => {
  const { layout, logger, ops, root } = await installed(t);
  const digestBefore = manifestDigestOf(layout.appRoot);
  const receiptBefore = readJsonFile(layout.installReceiptPath);

  // Fail after the swap+data writes but before the commit: the service cannot start.
  const failing = {
    ...ops,
    serviceStart() {
      throw new OpsError('E_SERVICE_START', 'simulated SCM failure', { status: 1053 });
    },
  };
  const planBefore = readPlan(layout).length;
  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops: failing, payload: payload.root });

  assert.equal(result.code, 23, result.message);

  // The old tree is back, byte-identical, and it is the tree install.json describes.
  assert.equal(existsSync(layout.appRoot), true, 'app\\ must be restored from app.prev');
  assert.equal(existsSync(layout.appPrevRoot), false, 'app.prev must be consumed by the restore');
  assert.equal(manifestDigestOf(layout.appRoot), digestBefore);
  assert.deepEqual(readJsonFile(layout.installReceiptPath), receiptBefore);

  // Everything the restored install needs to keep running must still be there. `app\` is not
  // the whole installation: a rollback that restores the tree and deletes the service, the
  // service host or the shortcut leaves a working tree wired to nothing (P0, one directory over).
  const repairOps = readPlan(layout).slice(planBefore).map((entry) => entry.op);
  assert.equal(existsSync(layout.serviceHostExe), true, 'bin\\aegis-svc.exe belongs to the old install');
  assert.equal(repairOps.includes('service.delete'), false, 'the old install still needs its service');
  assert.equal(repairOps.includes('eventlog.readers.remove'), false, 'the old install still needs its group membership');
  assert.equal(repairOps.includes('shortcut.delete'), false, 'the old install still needs its Start-menu entry');

  const journal = loadJournal(layout.journalPath).journal;
  assert.equal(journal.phase, 'ROLLED_BACK');
  assert.equal(journal.data.rollback.facts.appExists, true);
  assert.match(journal.data.rollback.claim, /仍在且清单与 install\.json 一致/u);
  // A repair never created the data area, so it must not lose it either (D3/D4/D6).
  assert.equal(existsSync(layout.tokenPath), true, 'a failed repair must keep the API token');
  assert.equal(existsSync(layout.configPath), true, 'a failed repair must keep the config');
  assert.ok(existsSync(join(layout.dataDir, 'rules', 'pack.json')), 'a failed repair must keep the rule pack');
  assert.ok(
    journal.data.steps.some((step) => String(step.detail ?? '').includes('保留既有服务')),
    'the journal must say the service was kept on purpose',
  );
});

test('P0: a rollback that already restored the old tree is not deleted by the next /install', async (t) => {
  const { layout, logger, ops, root } = await installed(t);
  const digest = manifestDigestOf(layout.appRoot);
  const receiptBefore = readFileSync(layout.installReceiptPath, 'utf8');
  const sampleBefore = readFileSync(join(layout.appRoot, 'apps/daemon/bin.js'), 'utf8');

  // The window this test is about: rollback step 2 already renamed `app.prev` back to `app\`,
  // then the process died before `enter(ROLLED_BACK)`. The step history still ends in a
  // settled `SWAP_B`, and `from === to` because a same-version repair swaps two byte-identical
  // manifests — so "which tree is this" cannot be answered by the digest alone.
  forcePhase(layout, PHASES.ROLLING_BACK, {
    fromManifestDigest: digest,
    toManifestDigest: digest,
    // What the interrupted rollback had already flushed before the rename (write-ahead).
    rollback: { restoreStarted: true, restoreAt: new Date().toISOString() },
  });
  assert.equal(existsSync(layout.appPrevRoot), false, 'the restore already consumed app.prev');
  assert.equal(existsSync(layout.stagingRoot), false);

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  assert.equal(result.code, 26, result.message);
  assert.equal(existsSync(layout.appRoot), true, 'the restored, working tree must survive recovery');
  assert.equal(manifestDigestOf(layout.appRoot), digest);
  assert.equal(readFileSync(join(layout.appRoot, 'apps/daemon/bin.js'), 'utf8'), sampleBefore);
  assert.equal(readFileSync(layout.installReceiptPath, 'utf8'), receiptBefore, 'install.json must stay accurate');

  const journal = loadJournal(layout.journalPath).journal;
  assert.equal(journal.phase, 'ROLLED_BACK');
  assert.match(journal.data.rollback?.claim ?? '', /仍在/u, 'the journal must say the old install is still there');
  assert.equal(journal.data.rollback?.facts?.appExists, true);
});

test('P0: the restore flag is written before the rename (window produced by real failures, not injected)', async (t) => {
  // The test above injects `rollback.restoreStarted` and therefore only tests the consumer.
  // This one produces the same window the way production does — a repair that fails after the
  // registry writes, whose rollback then cannot finish — and then asserts the writer: the flag
  // must be on disk *before* the rename, because that is what stops the next /install from
  // deleting the tree the rollback just restored (`from === to` on every same-version repair,
  // so the digest cannot tell the two trees apart).
  const { layout, logger, ops, root } = await installed(t);
  const digest = manifestDigestOf(layout.appRoot);
  const receiptBefore = readFileSync(layout.installReceiptPath, 'utf8');

  let shortcutWritten = false;
  const failing = {
    ...ops,
    shortcutCreate(spec) {
      ops.shortcutCreate(spec);
      shortcutWritten = true;
      throw new Error('simulated: shortcut written, then failed');
    },
    // The rollback gets past the restore and dies on the registry (reg.exe blocked, AV, …).
    registrySet(key, name, type, value) {
      if (shortcutWritten) throw new Error('simulated: reg.exe blocked during rollback');
      return ops.registrySet(key, name, type, value);
    },
  };

  const payload = createPayload(join(root, 'payload2'));
  const repair = await install({ layout, logger, ops: failing, payload: payload.root });
  assert.equal(repair.code, 24, repair.message);
  assert.equal(existsSync(layout.appPrevRoot), false, 'the restore already consumed app.prev');
  assert.equal(manifestDigestOf(layout.appRoot), digest, 'the old tree is back when the rollback dies');

  const crashed = loadJournal(layout.journalPath).journal;
  assert.equal(crashed.phase, PHASES.ROLLING_BACK);
  assert.equal(crashed.data.rollback?.restoreStarted, true,
    'the restore must be recorded on disk before the rename it describes');

  // And the next run has to believe that record.
  const next = await install({ layout, logger, ops, payload: createPayload(join(root, 'payload3')).root });
  assert.equal(next.code, 26, next.message);
  assert.equal(existsSync(layout.appRoot), true);
  assert.equal(manifestDigestOf(layout.appRoot), digest);
  assert.equal(readFileSync(layout.installReceiptPath, 'utf8'), receiptBefore);
  assert.match(loadJournal(layout.journalPath).journal.data.rollback?.claim ?? '', /仍在/u);
});

// ------------------------------------------------------------------------------- H1

test('H1: a crash at SWAP_B is converged by /install with exit 26 (no manual directory moving)', async (t) => {
  const { layout, logger, ops, root } = await installed(t);
  const digest = manifestDigestOf(layout.appRoot);

  // Build the crash scene the way a power cut would: the rename happened, the settle did not,
  // staging is still on disk, journal says SWAP_B.
  const staging = layout.stagingDir;
  mkdirSync(join(layout.installDir, 'staging'), { recursive: true });
  cpSync(layout.appRoot, staging, { recursive: true });
  renameSync(layout.appRoot, layout.appPrevRoot);
  forcePhase(layout, PHASES.SWAP_B, { toManifestDigest: digest, fromManifestDigest: digest });

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  assert.equal(result.code, 26, result.message);
  assert.match(result.message, /中断恢复/u);
  assert.equal(existsSync(layout.appRoot), true, 'the old tree must be restored');
  assert.equal(existsSync(layout.appPrevRoot), false);
  assert.equal(existsSync(layout.stagingRoot), false);
  assert.equal(manifestDigestOf(layout.appRoot), digest);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'ROLLED_BACK');

  // The entry point is reachable, not just defined: the same run reports the convergence.
  assert.equal(loadJournal(layout.journalPath).journal.data.recovery.action, 'restore-appprev');
});

test('H1: a crash at STAGED is converged by discarding staging, keeping the old tree', async (t) => {
  const { layout, logger, ops, root } = await installed(t);
  const digest = manifestDigestOf(layout.appRoot);

  mkdirSync(join(layout.stagingRoot, 'junk'), { recursive: true });
  writeFileSync(join(layout.stagingRoot, 'junk', 'half-copied.bin'), 'partial');
  // This scene is a *repair* that crashed while staging: an install already exists, which is
  // the whole reason the branch has to protect it. (A fresh install crashing at STAGED has no
  // tree at `app\` to protect, which is a different journal: `preexisting.app === false`.)
  forcePhase(layout, PHASES.STAGED, {
    op: 'repair',
    preexisting: { app: true, appPrev: false, bin: true, shortcut: false },
  });

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  assert.equal(result.code, 26, result.message);
  assert.equal(existsSync(layout.stagingRoot), false);
  assert.equal(manifestDigestOf(layout.appRoot), digest, 'the installed tree must not be touched');
});

// ---------------------------------------------------------------------------- H1 / H3

test('H1/H3: a crash between the receipts and COMMITTED converges to "nothing installed" — and says so everywhere', async (t) => {
  const { layout, logger, ops, root } = await installed(t);

  // This is a real window in `runInstall`: install.json / uninstall.json / version-floor are
  // written at :552-591 and `enter(COMMITTED)` only comes after that. A power cut there leaves
  // a complete tree, every side effect, and a phase still reading SWAP_B. Recovery used to
  // delete `app\` and the service only, leaving `install.json` claiming an install that was
  // gone, plus `bin\`, the data area and a 39-file `install\engine` — H3, on the new path.
  assert.equal(existsSync(layout.installReceiptPath), true);
  assert.equal(existsSync(layout.uninstallRegistryPath), true);
  forcePhase(layout, PHASES.SWAP_B);

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });
  assert.equal(result.code, 26, result.message);

  // Converged to "nothing installed" — and every record agrees with that.
  assert.equal(existsSync(layout.appRoot), false);
  assert.equal(existsSync(layout.installReceiptPath), false, 'install.json must not describe a tree that is gone');
  assert.equal(existsSync(layout.uninstallRegistryPath), false);
  assert.equal(existsSync(layout.serviceHostExe), false);
  assert.equal(existsSync(layout.configDir), false);
  assert.equal(existsSync(layout.dataDir), false);
  assert.equal(existsSync(join(layout.installDir, 'engine')), false);

  const revoked = readPlan(layout).map((entry) => entry.op);
  for (const op of ['service.delete', 'eventlog.readers.remove', 'shortcut.delete', 'registry.delete-key']) {
    assert.ok(revoked.includes(op), `recovery must revoke ${op}, not only delete the tree`);
  }

  const journal = loadJournal(layout.journalPath).journal;
  assert.equal(journal.phase, 'ROLLED_BACK');
  assert.equal(journal.data.rollback.facts.appExists, false);

  // The contradiction the review reported: `/verify` said "not installed" while install.json
  // said "0.0.1 installed". With the receipt gone the two cannot disagree any more.
  const verify = await runVerify({ layout, logger });
  assert.equal(verify.code, 10);
  assert.match(verify.message, /未安装/u);
});

test('H2: combination 4 stops before writing anything, and does not rename an unverified tree', async (t) => {
  const { layout, logger, ops, root } = await installed(t);

  // app + app.prev + staging, with app.prev's manifest rewritten so it cannot be attributed
  // to either the receipt or the tree in app (the state §6.2 forbids auto-resolving).
  cpSync(layout.appRoot, layout.appPrevRoot, { recursive: true });
  mkdirSync(layout.stagingDir, { recursive: true });
  writeFileSync(join(layout.appPrevRoot, 'manifests', 'files.sha256'), `${'0'.repeat(64)}  apps/daemon/bin.js\n`);

  const journalBefore = readFileSync(layout.journalPath, 'utf8');
  const appDigestBefore = manifestDigestOf(layout.appRoot);
  const prevDigestBefore = manifestDigestOf(layout.appPrevRoot);
  const planBefore = readPlan(layout).length;

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  assert.equal(result.code, 10, result.message);
  assert.match(result.message, /组合 4|无法唯一判定/u);
  assert.match(result.message, /未做任何改动/u);

  // Nothing moved, nothing deleted, nothing started, nothing written.
  assert.equal(existsSync(layout.appRoot), true);
  assert.equal(existsSync(layout.appPrevRoot), true);
  assert.equal(manifestDigestOf(layout.appRoot), appDigestBefore);
  assert.equal(manifestDigestOf(layout.appPrevRoot), prevDigestBefore);
  assert.equal(readFileSync(layout.journalPath, 'utf8'), journalBefore, 'the journal must not be rewritten either');
  assert.equal(readPlan(layout).length, planBefore, 'no service/registry action may be attempted');
  assert.equal(existsSync(layout.stagingDir), true, 'the pre-existing staging tree is not ours to delete here');

  // The classifier agrees with the refusal, and says why.
  const verdict = assessExistingTreePair({ layout, receipt: readJsonFile(layout.installReceiptPath) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.details.appDigest, appDigestBefore);
});

test('H2: an in-swap combination-4 diagnosis writes nothing — not even a rollback', async (t) => {
  // The precheck refuses a *pre-existing* app+app.prev pair. This test is about the second
  // line of defence: the disk changes between the precheck and SWAP_A, so the pair only
  // appears while the swap is already in flight. That branch must diagnose and stop; if it
  // fell through to the generic catch, rollback would clean staging and rewrite the journal
  // (phase ROLLED_BACK) while printing "stopped, nothing done".
  const { layout, logger, ops, root } = await installed(t);
  const appDigestBefore = manifestDigestOf(layout.appRoot);
  const planBefore = readPlan(layout).length;

  const payload = createPayload(join(root, 'payload2'));
  const result = await runInstall({
    layout,
    logger,
    ops,
    options: { payload: payload.root, toVersion: '0.0.1', engineSource: INSTALLER_SOURCE },
    hooks: {
      onPhase(phase) {
        if (phase !== PHASES.SWAP_A) return;
        // The race: `app.prev` shows up with a manifest that belongs to neither side.
        cpSync(layout.appRoot, layout.appPrevRoot, { recursive: true });
        writeFileSync(join(layout.appPrevRoot, 'manifests', 'files.sha256'), 'not the old manifest\n');
      },
    },
  });

  assert.equal(result.code, 10, result.message);
  assert.match(result.message, /未执行任何回滚动作/u);

  // Nothing moved, nothing cleaned, nothing recorded as rolled back.
  assert.equal(existsSync(layout.appRoot), true);
  assert.equal(manifestDigestOf(layout.appRoot), appDigestBefore);
  assert.equal(existsSync(layout.appPrevRoot), true, 'the diagnosis must not delete or rename app.prev');
  assert.equal(readFileSync(join(layout.appPrevRoot, 'manifests', 'files.sha256'), 'utf8'), 'not the old manifest\n');
  assert.equal(existsSync(layout.stagingDir), true, 'a diagnosis must not clean staging');
  assert.equal(readPlan(layout).length, planBefore, 'no service/registry action may follow a diagnosis');

  const journal = loadJournal(layout.journalPath).journal;
  assert.equal(journal.phase, PHASES.SWAP_A, 'the phase must stay where the swap was interrupted');
  assert.ok(journal.data.diagnosis, 'the reason must be in the journal, not only in the message');
  assert.match(journal.data.diagnosis.reason, /组合 4|无法唯一判定/u);
});

test('H2: an interrupted SWAP_A with an unidentifiable app.prev is diagnosed, not resolved', async (t) => {
  const { layout, logger, ops, root } = await installed(t);

  cpSync(layout.appRoot, layout.appPrevRoot, { recursive: true });
  mkdirSync(layout.stagingDir, { recursive: true });
  writeFileSync(join(layout.appPrevRoot, 'manifests', 'files.sha256'), 'not a manifest\n');

  forcePhase(layout, PHASES.SWAP_A);
  const appDigestBefore = manifestDigestOf(layout.appRoot);

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  // 25 = "refused, nothing done" — the recovery table's read-only diagnosis exit.
  assert.equal(result.code, 25, result.message);
  assert.equal(existsSync(layout.appRoot), true);
  assert.equal(existsSync(layout.appPrevRoot), true);
  assert.equal(manifestDigestOf(layout.appRoot), appDigestBefore);
  assert.equal(loadJournal(layout.journalPath).journal.phase, PHASES.SWAP_A, 'phase must stay where the crash left it');
});

test('H2/P0: a ROLLING_BACK scene whose app\\ cannot be identified is diagnosed, never deleted', async (t) => {
  const { layout, logger, ops, root } = await installed(t);
  const oldDigest = manifestDigestOf(layout.appRoot);

  // `app.prev` is a byte-identical copy of the install (so the receipt recognises it), while
  // `app\` holds a third tree: a readable manifest that matches neither `from` nor `to`.
  // Rolling back the "obvious" way deletes exactly this tree — and it may be the only copy
  // of whatever the operator had. Same rule as §6.2 combination 4.
  cpSync(layout.appRoot, layout.appPrevRoot, { recursive: true });
  writeFileSync(join(layout.appRoot, 'manifests', 'files.sha256'), `${'a'.repeat(64)}  apps/daemon/bin.js\n`);
  const unknownDigest = manifestDigestOf(layout.appRoot);
  assert.notEqual(unknownDigest, oldDigest);

  forcePhase(layout, PHASES.ROLLING_BACK);

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  // 25 = refused, nothing done — not 26, because nothing was converged.
  assert.equal(result.code, 25, result.message);
  assert.match(result.message, /ROLLING_BACK|无法|判定/u);
  assert.equal(existsSync(layout.appRoot), true, 'an unidentifiable tree must not be deleted');
  assert.equal(existsSync(layout.appPrevRoot), true, 'app.prev must not be consumed by a refused recovery');
  assert.equal(manifestDigestOf(layout.appRoot), unknownDigest, 'the tree must be byte-identical afterwards');
  assert.equal(loadJournal(layout.journalPath).journal.phase, PHASES.ROLLING_BACK,
    'phase must stay where the crash left it');
});

// ------------------------------------------------------------------------------- H3

test('H3: rollback revokes the registry keys, shortcut, bin\\ and data area it created', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));

  // Fail right after the registry writes: ARP entry exists, shortcut not yet.
  const failing = {
    ...ops,
    shortcutCreate() {
      throw new Error('simulated shortcut failure');
    },
  };
  const result = await install({ layout, logger, ops: failing, payload: payload.root });
  assert.equal(result.code, 10, result.message);

  const plan = readPlan(layout);
  const ops_ = plan.map((entry) => entry.op);

  // What the failing run created...
  assert.ok(ops_.includes('registry.set'));
  assert.ok(ops_.includes('eventlog.readers.add'));
  assert.ok(ops_.includes('service.install'));
  // ...must be revoked, not left behind.
  assert.equal(ops_.filter((op) => op === 'registry.delete-key').length, 3,
    'ARP, HKLM\\SOFTWARE\\<product> and the event log source must all be deleted');
  assert.ok(ops_.includes('eventlog.readers.remove'), 'D14 delete side');
  assert.ok(ops_.includes('service.delete'));
  // The Start-menu entry: `shortcut.create` never ran (it threw), but the entry it would have
  // written belongs to this fresh install, so the revocation must still be recorded. Before
  // this was made unconditional the branch was unreachable in disarm (no `.lnk` exists), which
  // is how a "shortcut is revoked" claim could be made without ever executing.
  assert.ok(ops_.includes('shortcut.delete'), 'the Start-menu entry must be revoked, not just claimed');

  // Disk side: nothing of this install survives, and the receipt is not a lie.
  assert.equal(existsSync(layout.appRoot), false);
  assert.equal(existsSync(layout.configDir), false, 'the config this run created must be gone');
  assert.equal(existsSync(layout.dataDir), false, 'the data area (incl. api-token) must be gone');
  assert.equal(existsSync(layout.serviceHostExe), false, 'bin\\aegis-svc.exe is outside every manifest and must be removed');
  assert.equal(existsSync(join(layout.installDir, 'engine')), false,
    'the engine copy under install\\engine is not covered by any app manifest either');
  assert.equal(existsSync(layout.installReceiptPath), false);
  assert.equal(existsSync(layout.uninstallRegistryPath), false, 'the uninstall registration describes an install that is gone');
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'ROLLED_BACK');
});

// ------------------------------------------------------------------------------- H4

test('H4: the old `--event-log-readers` assertion was true by construction, not by behaviour', async (t) => {
  // Proof 1: the receiving binary never parsed the flag, so no group membership could ever
  // have been created by it. (This is the property the old assertion could not see.)
  const source = readFileSync(join(INSTALLER_ROOT, '..', '..', '..', 'apps', 'service-host', 'native', 'aegis-svc.cpp'), 'utf8');
  assert.equal(source.includes('--event-log-readers'), false,
    'the native host must not be assumed to implement a flag it does not parse');

  // Proof 2 is deliberately about the *evidence channel*, and says so: the recorder's argv is
  // a literal, so any assertion over it can only test the recorder. This asserts the property
  // that made the old check vacuous — the argv does not vary with the version, the payload or
  // the machine — and then asserts the flag is gone from that channel. It is not, and cannot
  // be, evidence about the host binary; Proof 1 and the `eventlog.readers.*` plan entries are.
  const first = disarmContext(join(tempRoot(t), 'a'));
  const second = disarmContext(join(tempRoot(t), 'b'));
  first.ops.serviceInstall({ version: '0.0.1' });
  second.ops.serviceInstall({ version: '9.9.9' });
  const argvA = readPlan(first.layout).find((entry) => entry.op === 'service.install').argv;
  const argvB = readPlan(second.layout).find((entry) => entry.op === 'service.install').argv;
  const normalize = (argv, layout) => argv.map((value) => value.split(layout.root).join('<root>'));
  assert.deepEqual(normalize(argvA, first.layout), normalize(argvB, second.layout),
    'the recorded argv does not vary with anything the old assertion claimed to test');
  assert.equal(argvA.includes('--event-log-readers'), false);
  assert.equal(argvB.includes('--event-log-readers'), false);

  // Proof 3: what replaces it is an executable action with a real inverse — and it is checked
  // by *running* things, not by looking at a string. A generated PowerShell snippet that does
  // not parse is exactly the same class of failure as the flag: recorded, never executed.
  const add = eventLogReadersScript({ account: 'NT SERVICE\\AIDrivenNetDefenseDaemon', action: 'add' });
  const remove = eventLogReadersScript({ account: 'NT SERVICE\\AIDrivenNetDefenseDaemon', action: 'remove' });
  assert.match(add, /S-1-5-32-573/u);
  assert.match(add, /Get-LocalGroup -SID \$sid/u, 'the group must be resolved by SID, not by localized name');
  assert.match(add, /Add-LocalGroupMember -Group \$group -Member \$acct/u);
  assert.match(add, /NT SERVICE\\AIDrivenNetDefenseDaemon/u);
  assert.match(add, /-not \$present/u, 'add must be idempotent (probe membership first)');
  assert.match(remove, /Remove-LocalGroupMember -Group \$group -Member \$acct/u);
  assert.equal(remove.includes('-not'), false, 'remove is guarded by the positive membership test');

  // `Add-LocalGroupMember -SID` only exists in recent builds' parameter set. Using it would
  // work on this workstation and fail on Server 2016 — a portability bug invisible to review.
  assert.equal(/(Add|Remove)-LocalGroupMember[^}]*?-SID\b/u.test(add + remove), false,
    'the group object must be passed through -Group; -SID is not in the portable parameter set');

  // The parser is the authority on syntax: compile both snippets (no execution, no mutation).
  for (const [label, script] of [['add', add], ['remove', remove]]) {
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; $null = [scriptblock]::Create($env:AIDND_SCRIPT); "parsed"'], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, AIDND_SCRIPT: script },
    });
    assert.equal(parsed.status, 0, `${label} script must be valid PowerShell: ${parsed.stderr || parsed.stdout}`);
    assert.match(parsed.stdout, /parsed/u);
  }

  // The read-only half (group lookup + membership probe) is executed for real. The mutating
  // half is not: it needs elevation and would change the machine, which is why the assertions
  // above are about the parts that can be checked without it.
  const probe = add.split('; ').filter((statement) => !statement.startsWith('if (-not')).join('; ');
  const probed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `${probe}; "present=$present"`], { encoding: 'utf8', windowsHide: true });
  assert.equal(probed.status, 0, `membership probe must run: ${probed.stderr || probed.stdout}`);
  assert.match(probed.stdout, /present=(True|False)/u, 'the probe must actually evaluate $present');
});

// ------------------------------------------------------------------------------- H5

test('H5: "service does not exist" is success for a delete, so a half-done uninstall finishes', async (t) => {
  // Unit: every shape the absence can arrive in.
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'exit 1060', { status: 1060 })), true);
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'aegis-svc.exe 退出码 1060：')), true);
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'The specified service does not exist')), true);
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'exit 1072', { status: 1072 })), false);
  assert.equal(isServiceAbsentError(new Error('boom')), false);

  // The raw-text judgement `sc.exe` needs (its exit code is authoritative, the text is not:
  // on a zh-CN box `sc` writes OEM-encoded bytes and Node decodes them as UTF-8).
  assert.equal(isServiceAbsentText('sc 退出码 1060：'), true);
  assert.equal(isServiceAbsentText('The specified service does not exist as an installed service.'), true);
  assert.equal(isServiceAbsentText('服务在 90000 ms 内未停止'), false);

  // Integration: an uninstall whose service was already removed must reach UNINSTALLED,
  // not stop at 30 with the phase stuck at UNINSTALLING (which then deadlocked /install).
  const { layout, logger, ops } = await installed(t);
  const absentOps = {
    ...ops,
    serviceDelete() {
      throw new OpsError('E_SERVICE_DELETE', 'aegis-svc.exe 退出码 1060：', { status: 1060 });
    },
  };

  const first = await runUninstall({ layout, logger, ops: absentOps });
  assert.equal(first.code, 0, first.message);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'UNINSTALLED');
  assert.equal(existsSync(layout.installReceiptPath), false);

  // And a second run must not fall back into the failure mode: no 30, no `UNINSTALLING`.
  // (It may answer 0 again because the program tree is removed by a *deferred* command, so
  // `app\` is still on disk in a disarm run — that is the documented G5 deviation, not a bug.)
  const second = await runUninstall({ layout, logger, ops: absentOps });
  assert.notEqual(second.code, 30, second.message);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'UNINSTALLED');
});

test('H5: a service that is already gone is not a failure for `sc stop` either', async (t) => {
  const { layout, logger, ops } = await installed(t);

  // The other entrance into the same deadlock: `sc stop` (not `--uninstall-service`) answers
  // 1060 once the service is gone. Treated as a failure, `/uninstall` returned 20 with the
  // phase parked at UNINSTALLING, so every rerun answered 20 while `/install` answered 15.
  const absentOps = {
    ...ops,
    serviceStop() {
      throw new OpsError('E_SERVICE_STOP', 'sc stop 失败：指定的服务未安装。', { status: 1060 });
    },
  };
  const result = await runUninstall({ layout, logger, ops: absentOps });
  assert.equal(result.code, 0, result.message);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'UNINSTALLED');

  // Control: a service that refuses to stop is still 20, and the phase still says "resumable".
  const second = await installed(t);
  const blocked = await runUninstall({
    layout: second.layout,
    logger: second.logger,
    ops: {
      ...second.ops,
      serviceStop() {
        throw new OpsError('E_SERVICE_STOP', '服务在 90000 ms 内未停止', {});
      },
    },
  });
  assert.equal(blocked.code, 20, blocked.message);
  assert.equal(loadJournal(second.layout.journalPath).journal.phase, 'UNINSTALLING');
});

// ------------------------------------------------------------------------------- H6

test('H6: the deferred removal chains with `&&`, so a failed rmdir cannot delete its own marker', () => {
  const pending = 'C:\\ProgramData\\X\\install\\pending-removal.json';
  const target = 'C:\\Program Files\\X';
  const command = deferredRemovalCommand({ target, pendingPath: pending });

  // What the fix is: the operator between `rmdir` and `del` decides whether a failed removal
  // still deletes the only record that the program tree has to disappear.
  const legacy = `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${target}" & del /f /q "${pending}"`;
  assert.equal(operatorBeforeDelete(command), '&&');
  assert.equal(operatorBeforeDelete(legacy), '&', 'the negative control must be distinguishable');

  // `del` may only run if `rmdir` succeeded, and the marker is deleted last.
  assert.ok(command.indexOf('rmdir') < command.indexOf('del'));
  assert.equal(/(^|[^&])&([^&]|$)/u.test(command), false, 'no unconditional `&` may appear anywhere');
  assert.equal(command.split('&&').length >= 3, true);
  assert.match(command, /ping -n 3/u, 'the delay that lets the running engine exit must stay');
});

test('H6: a failing rmdir really leaves the marker behind (executed, with the `&` version as control)', (t) => {
  const root = tempRoot(t);
  const marker = join(root, 'pending-removal.json');
  const target = join(root, 'no-such-directory'); // rmdir fails; the chain must stop there
  const run = (command) => spawnSync('cmd.exe', ['/c', command], {
    encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
  });

  writeFileSync(marker, '{"txid":"x"}\n');
  const fixed = run(deferredRemovalCommand({ target, pendingPath: marker }));
  assert.notEqual(fixed.status, 0, 'rmdir on a missing directory must fail the chain');
  assert.equal(existsSync(marker), true,
    'the marker is the only record that the program tree still has to disappear (H6)');

  // Negative control: the old unconditional `&` deletes the record of its own failure. If this
  // ever stops holding, the assertion above stopped proving anything.
  const legacy = `ping -n 2 127.0.0.1 >nul & rmdir /s /q "${target}" & del /f /q "${marker}"`;
  const broken = run(legacy);
  assert.equal(broken.status, 0);
  assert.equal(existsSync(marker), false, 'negative control: `&` deletes the marker although rmdir failed');
});

test('H6: the uninstall uses that command and keeps the marker itself', async (t) => {
  const { layout, logger, ops } = await installed(t);
  const result = await runUninstall({ layout, logger, ops });
  assert.equal(result.code, 0, result.message);

  const removal = readPlan(layout).find((entry) => entry.op === 'fs.deferred-removal');
  assert.equal(operatorBeforeDelete(removal.command), '&&');
  assert.equal(existsSync(layout.pendingRemovalPath), true);
});

/**
 * The operator that guards the `del` segment of a `cmd` chain.
 *
 * Exported from no module on purpose: this is the test's own reading of the string, kept
 * tiny so that "it is `&&`" cannot be mistaken for "it looks like `&&`".
 */
function operatorBeforeDelete(command) {
  const parts = command.split(/(&&|(?<![&])&(?![&]))/u);
  for (let index = 0; index < parts.length; index += 1) {
    if (/^\s*del\s/u.test(parts[index])) return parts[index - 1];
  }
  return null;
}
