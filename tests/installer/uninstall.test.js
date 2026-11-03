/**
 * `/uninstall` and `/purge`.
 *
 * Two things are being checked beyond "the files went away":
 *
 * 1. **N7** — the default uninstall keeps the data and *says so*; only `/purge` deletes it,
 *    and it prints counts instead of a reassuring silence.
 * 2. **Resumability** — a failure mid-uninstall leaves `UNINSTALLING` on disk so the next
 *    run converges instead of refusing. That is the difference between a recoverable
 *    installer and one that needs a reimage.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runInstall } from '../../deploy/windows/installer/src/install.mjs';
import { loadJournal } from '../../deploy/windows/installer/src/journal.mjs';
import { runPurge, runUninstall } from '../../deploy/windows/installer/src/uninstall.mjs';
import { createPayload, disarmContext, readPlan, tempRoot } from './fixtures/payload.mjs';

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

test('/uninstall stops and unregisters the service, removes the program tree, keeps the data', async (t) => {
  const { layout, logger, ops } = await installed(t);
  const tokenBefore = readFileSync(layout.tokenPath, 'utf8');

  const result = await runUninstall({ layout, logger, ops });
  assert.equal(result.code, 0, result.message);

  // Data survives, and the message names the path instead of letting the user assume it is gone.
  assert.equal(readFileSync(layout.tokenPath, 'utf8'), tokenBefore);
  assert.ok(existsSync(layout.storeDir) || existsSync(layout.dataDir));
  assert.match(result.message, /数据仍位于/u);
  assert.match(result.message, /\/purge/u);

  // Program tree removal is deferred: the engine may be running from inside it, and a
  // running node.exe cannot be deleted. The marker is what recovery reads.
  const pending = JSON.parse(readFileSync(layout.pendingRemovalPath, 'utf8'));
  assert.equal(pending.target, layout.programRoot);
  const plan = readPlan(layout);
  const removal = plan.find((entry) => entry.op === 'fs.deferred-removal');
  assert.match(removal.command, /rmdir \/s \/q/u);
  assert.match(removal.command, /ping -n 3/u);

  // Registry + receipts are gone; the journal is terminal.
  assert.equal(existsSync(layout.installReceiptPath), false);
  assert.equal(existsSync(layout.uninstallRegistryPath), false);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'UNINSTALLED');

  const planOps = plan.map((entry) => entry.op);
  assert.ok(planOps.includes('service.stop'));
  assert.ok(planOps.includes('service.delete'));
  assert.equal(planOps.filter((op) => op === 'registry.delete-key').length, 3);
});

test('/uninstall on a machine with nothing installed is refused with 10, doing nothing', async (t) => {
  const root = tempRoot(t);
  const { layout, logger, ops } = disarmContext(join(root, 'install-root'));
  const result = await runUninstall({ layout, logger, ops });
  assert.equal(result.code, 10);
  assert.match(result.message, /没有可卸载的安装/u);
  assert.equal(readPlan(layout).length, 0);
});

test('/purge deletes the data and prints counts, and is idempotent when re-run', async (t) => {
  const { layout, logger, ops } = await installed(t);
  await runUninstall({ layout, logger, ops });

  const purge = await runPurge({ layout, logger, ops });
  assert.equal(purge.code, 0, purge.message);
  assert.match(purge.message, /删除 \d+ 项/u);
  assert.match(purge.message, /跳过 \d+ 项/u);
  assert.match(purge.message, /MiB/u);
  assert.equal(existsSync(layout.configDir), false);
  assert.equal(existsSync(layout.dataDir), false);
  assert.equal(existsSync(layout.journalPath), false, 'the journal is deleted last, on success only');

  // `/purge` deletes data, never the program tree. The deferred-removal marker is the only
  // record that the program tree still has to go, so it must survive — and say so.
  assert.ok(existsSync(layout.pendingRemovalPath));
  assert.match(purge.message, /程序区删除仍待执行/u);

  // A second purge finds nothing to do and still exits 0 — it must not report failure.
  const again = await runPurge({ layout, logger, ops });
  assert.equal(again.code, 0, again.message);
});

test('/purge refuses to run while another transaction is in flight (15)', async (t) => {
  const { layout, logger, ops } = await installed(t);
  const journal = JSON.parse(readFileSync(layout.journalPath, 'utf8'));
  journal.phase = 'SWAP_B';
  writeFileSync(layout.journalPath, JSON.stringify(journal));

  const result = await runPurge({ layout, logger, ops });
  assert.equal(result.code, 15);
  assert.equal(existsSync(layout.dataDir), true);
});

test('a failed /uninstall leaves UNINSTALLING on disk and the next run resumes', async (t) => {
  const { layout, logger, ops } = await installed(t);

  const brokenOps = {
    ...ops,
    serviceDelete() {
      throw new Error('simulated SCM failure');
    },
  };
  const first = await runUninstall({ layout, logger, ops: brokenOps });
  assert.equal(first.code, 30, first.message);
  assert.match(first.message, /注销服务失败/u);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'UNINSTALLING');
  assert.equal(readFileSync(layout.tokenPath, 'utf8').length > 0, true, 'a failed uninstall must not delete data');

  // The retry is not refused as "busy": UNINSTALLING is a resumable phase.
  const second = await runUninstall({ layout, logger, ops });
  assert.equal(second.code, 0, second.message);
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'UNINSTALLED');
});

test('purge refuses a path outside its registered roots, keeps the manifest, and resumes', async (t) => {
  const { root, layout, logger, ops } = await installed(t);
  const outside = join(root, 'not-ours');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'keep-me.txt'), 'not part of the product\n');

  // A layout that points one entry outside the roots the guard allows. This is the shape
  // of a real bug (a typo in dataDir), and the guard must stop it rather than obey.
  const broken = await runPurge({ layout: { ...layout, logsDir: outside }, logger, ops });
  assert.equal(broken.code, 31, broken.message);
  assert.match(broken.message, /拒绝删除未登记根/u);
  assert.ok(existsSync(join(outside, 'keep-me.txt')), 'the guard must not delete outside the install roots');
  assert.ok(existsSync(layout.purgeManifestPath), 'the manifest must survive a failed purge so a retry can resume');
  assert.equal(loadJournal(layout.journalPath).journal.phase, 'PURGING');

  const resumed = await runPurge({ layout, logger, ops });
  assert.equal(resumed.code, 0, resumed.message);
  assert.ok(existsSync(join(outside, 'keep-me.txt')), 'resuming must still not touch the foreign directory');
});
