/**
 * Regressions for the P0/P1 round (see `docs/implementation/reviews/p1-p2-review.md`).
 *
 * One test per finding, and each one is written so that **reverting the fix turns it red**:
 *
 * | test | finding |
 * |---|---|
 * | repair fails during staging → the working install survives | P0 / R1 |
 * | repair fails after SWAP_B → app.prev is put back, records agree | P0 (restore half) |
 * | SWAP_B crash scene converges with 26 | H1 |
 * | STAGED crash scene converges with 26 | H1 |
 * | combination 4 stops and touches nothing | H1 / H2 |
 * | rollback revokes registry, shortcut, bin\, data | H3 |
 * | `--event-log-readers` was evidence of nothing | H4 (false green) |
 * | a service that is already gone is not a failure | H5 |
 * | deferred removal keeps its marker when rmdir fails | H6 |
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
  OpsError,
} from '../../deploy/windows/installer/src/ops.mjs';
import { runUninstall } from '../../deploy/windows/installer/src/uninstall.mjs';
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
  journal.phase = phase;
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

  // The payload argument is unused after the setup; keep the variable meaningful.
  assert.ok(payload.fileCount > 0);
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
  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops: failing, payload: payload.root });

  assert.equal(result.code, 23, result.message);

  // The old tree is back, byte-identical, and it is the tree install.json describes.
  assert.equal(existsSync(layout.appRoot), true, 'app\\ must be restored from app.prev');
  assert.equal(existsSync(layout.appPrevRoot), false, 'app.prev must be consumed by the restore');
  assert.equal(manifestDigestOf(layout.appRoot), digestBefore);
  assert.deepEqual(readJsonFile(layout.installReceiptPath), receiptBefore);

  const journal = loadJournal(layout.journalPath).journal;
  assert.equal(journal.phase, 'ROLLED_BACK');
  assert.equal(journal.data.rollback.facts.appExists, true);
  assert.equal(journal.data.rollback.claim.length > 0, true);
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
  forcePhase(layout, PHASES.STAGED);

  const payload = createPayload(join(root, 'payload2'));
  const result = await install({ layout, logger, ops, payload: payload.root });

  assert.equal(result.code, 26, result.message);
  assert.equal(existsSync(layout.stagingRoot), false);
  assert.equal(manifestDigestOf(layout.appRoot), digest, 'the installed tree must not be touched');
});

// ---------------------------------------------------------------------------- H1 / H2

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

  // Disk side: nothing of this install survives, and the receipt is not a lie.
  assert.equal(existsSync(layout.appRoot), false);
  assert.equal(existsSync(layout.configDir), false, 'the config this run created must be gone');
  assert.equal(existsSync(layout.dataDir), false, 'the data area (incl. api-token) must be gone');
  assert.equal(existsSync(layout.serviceHostExe), false, 'bin\\aegis-svc.exe is outside every manifest and must be removed');
  assert.equal(existsSync(layout.installReceiptPath), false);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'ROLLED_BACK');
});

// ------------------------------------------------------------------------------- H4

test('H4: the old `--event-log-readers` assertion was true by construction, not by behaviour', async (t) => {
  // Proof 1: the receiving binary never parsed the flag, so no group membership could ever
  // have been created by it. (This is the property the old assertion could not see.)
  const source = readFileSync(join(INSTALLER_ROOT, '..', '..', '..', 'apps', 'service-host', 'native', 'aegis-svc.cpp'), 'utf8');
  assert.equal(source.includes('--event-log-readers'), false,
    'the native host must not be assumed to implement a flag it does not parse');

  // Proof 2: the flag was emitted unconditionally — the assertion tested a constant in the
  // recorder, which is why it stayed green while the feature did not exist.
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

  // Proof 3: what replaces it is an executable action with a real inverse.
  const add = eventLogReadersScript({ account: 'NT SERVICE\\AIDrivenNetDefenseDaemon', action: 'add' });
  const remove = eventLogReadersScript({ account: 'NT SERVICE\\AIDrivenNetDefenseDaemon', action: 'remove' });
  assert.match(add, /S-1-5-32-573/u);
  assert.match(add, /Add-LocalGroupMember/u);
  assert.match(add, /NT SERVICE\\\\AIDrivenNetDefenseDaemon/u);
  assert.match(add, /-not/u, 'add must be idempotent (probe membership first)');
  assert.match(remove, /Remove-LocalGroupMember/u);
  assert.equal(remove.includes('-not'), false, 'remove is guarded by the positive membership test');
});

// ------------------------------------------------------------------------------- H5

test('H5: "service does not exist" is success for a delete, so a half-done uninstall finishes', async (t) => {
  // Unit: every shape the absence can arrive in.
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'exit 1060', { status: 1060 })), true);
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'aegis-svc.exe 退出码 1060：')), true);
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'The specified service does not exist')), true);
  assert.equal(isServiceAbsentError(new OpsError('E_SERVICE_DELETE', 'exit 1072', { status: 1072 })), false);
  assert.equal(isServiceAbsentError(new Error('boom')), false);

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
