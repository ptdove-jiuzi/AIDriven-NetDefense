/**
 * Re-check the RUNTIME install acceptance evidence without touching the machine.
 *
 * This does not run an installer. It recomputes the report's PASS/FAIL claims from the
 * raw artifacts the acceptance runs produced, so `REPORT.md` cannot drift away from the
 * bytes on disk. Re-run with:
 *
 *   node --test tests/installer/install-cycle-verify.test.js
 *
 * When the evidence is absent (a normal checkout, or before any acceptance run) every
 * case is skipped instead of failing: this file must never turn a green suite red for a
 * reason that is not about the installer.
 *
 * Evidence layout (see docs/implementation/evidence/runtime/install/REPORT.md):
 *   baseline-BEFORE-ANY-INSTALL.json      what the machine looked like before
 *   A-C-INDEPENDENT-REVIEW.md             independent re-verification of the elevated run
 *   run/B-unpriv/result.json              stage B verdict (unprivileged overwrite upgrade)
 *   run/B-unpriv/residue-diff-CORRECTED.json   uninstall residue, correct direction
 *   payload-extract/install-py-comparison.json  shipped vs source module comparison
 *   DEFECT-self-uninstall/REPORT.md       P1: in-tree uninstaller kills itself
 *
 * Author: PT-dove
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const EVID = path.join(REPO, 'docs', 'implementation', 'evidence', 'runtime', 'install');
const RUN = path.join(EVID, 'run');

const RC3_SETUP_SHA256 = 'b76f0966e24c22eca6d27ee6d8b21bd168dba94d58e75c42a99ce9c1a4057003';

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const exists = (file) => fs.existsSync(file);

const baseline = readJson(path.join(EVID, 'baseline-BEFORE-ANY-INSTALL.json'));
const b = readJson(path.join(RUN, 'B-unpriv', 'result.json'));
const residue = readJson(path.join(RUN, 'B-unpriv', 'residue-diff-CORRECTED.json'));
const parity = readJson(path.join(EVID, 'payload-extract', 'install-py-comparison.json'));
const bDone = Boolean(b && residue);

test('the acceptance run used the rc.3 Setup whose bytes we verified', { skip: !baseline && 'no baseline recorded' }, () => {
  assert.equal(baseline.setup.sha256, RC3_SETUP_SHA256);
  assert.equal(baseline.setup.bytes, 66322648);
});

test('B: first install is a genuine first install (upgradedFrom null)', { skip: !bDone && 'stage B evidence missing' }, () => {
  assert.equal(b.install1.pass, true);
  assert.equal(b.install1.upgradedFromIsNull, true, 'first install must not claim an upgrade');
  assert.equal(b.install1.fields.version, '0.0.1-rc.3');
  assert.equal(b.install1.fields.channel, 'installed');
  assert.equal(b.install1.fields.entryKind, 'exe');
  assert.equal(b.install1.fields.desktopExe, 'AIDrivenNetDefense.exe');
});

test('B: overwrite upgrade records upgradedFrom and keeps the version', { skip: !bDone && 'stage B evidence missing' }, () => {
  assert.equal(b.install2.pass, true);
  assert.equal(b.install2.upgradedFrom, '0.0.1-rc.3');
  assert.equal(b.install2.fields.version, '0.0.1-rc.3');
  assert.equal(b.install2.registryHive, 'HKCU', 'an unprivileged install must register in HKCU');
});

test('B: user data under data\\ survives the upgrade byte for byte', { skip: !bDone && 'stage B evidence missing' }, () => {
  assert.equal(b.dataSurvival.pass, true);
  assert.equal(b.dataSurvival.sha256AfterUpgrade, b.dataSurvival.sha256BeforeUpgrade);
});

test('B: the installer copy in the tree is the same bytes as the shipped Setup', { skip: !bDone && 'stage B evidence missing' }, () => {
  assert.equal(b.installerCopy.equalsDistSetup, true);
  assert.equal(b.installerCopy.sha256, RC3_SETUP_SHA256);
  assert.equal(b.quietUninstallString.insideTree, true, 'the recorded uninstaller must live inside the install tree');
});

test('C: uninstall leaves no file from the installed tree behind', { skip: !bDone && 'stage B evidence missing' }, () => {
  assert.equal(residue.verdict, 'ZERO_RESIDUE');
  assert.equal(residue.installedFileCount, 47227);
  assert.equal(residue.remainingFromInstallAfterUninstall, 0);
  assert.equal(b.uninstall.installDirExists, false);
  assert.equal(b.uninstall.registryRemaining.length, 0);
  assert.equal(b.uninstall.processesRemaining.length, 0);
  assert.equal(b.uninstall.shortcutsRemaining.length, 0);
  assert.equal(b.uninstall.autostartRemaining.length, 0);
  assert.equal(b.uninstall.servicesRemaining.length, 0);
  assert.equal(b.uninstall.scheduledTasksRemaining.length, 0);
});

test('C: the user-facing uninstaller (in-tree copy) is known-broken, and that is recorded', { skip: !bDone && 'stage B evidence missing' }, () => {
  // This is the P1 defect, not an acceptance failure: it must stay documented so a
  // future "all green" run cannot quietly drop it.
  assert.ok(exists(path.join(EVID, 'DEFECT-self-uninstall', 'REPORT.md')));
  assert.match(String(b.uninstall.uninstallerSelfMatchNote ?? ''), /DEFECT-1/);
});

test('A/C: the elevated Program Files run was independently re-verified', { skip: !exists(path.join(EVID, 'A-C-INDEPENDENT-REVIEW.md')) && 'no independent review' }, () => {
  const text = fs.readFileSync(path.join(EVID, 'A-C-INDEPENDENT-REVIEW.md'), 'utf8');
  assert.match(text, /A（Program Files 真装）与 C（卸载零残留）成立|\*\*A（Program Files 真装）与 C（卸载零残留）成立\*\*/);
  assert.match(text, /healthz/i);
});

test('payload parity: the shipped installer is not the current source', { skip: !parity && 'extracted comparison not present' }, () => {
  const install = parity.modules?.['aidn.install'];
  assert.ok(install, 'aidn.install must be in the comparison');
  assert.equal(install.identical_structure, false);
  for (const symbol of ['_record_is_ours', '_bundle_is_ours', '_link_reason', '_is_junction', '_manifest_has_rows']) {
    assert.ok(install.names_only_in_source.includes(symbol), `${symbol} must be reported as source-only`);
  }
  const main = parity.modules?.main;
  if (main?.identical_structure !== undefined) {
    assert.equal(main.identical_structure, false, 'the shipped main also predates the elevation gate');
  }
});
