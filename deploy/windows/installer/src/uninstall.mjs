/**
 * uninstall.mjs — `/uninstall` (keep data) and `/purge` (delete data).
 *
 * Three properties this file is responsible for:
 *
 * 1. **Default keeps the data** (N7). The message the user sees names the data path and
 *    the command that would delete it; it never silently leaves data behind while
 *    implying a clean removal.
 * 2. **Resumable.** The phase marker is written before any destructive step and is only
 *    cleared when the whole inventory succeeded. A crash leaves `UNINSTALLING` (or
 *    `PURGING`) on disk, and re-running converges because every step tolerates a
 *    missing target.
 * 3. **The program tree is removed by a process that is not us.** The engine may be
 *    running from `programRoot\...`, and Windows will not delete a running image. The
 *    removal is handed to a detached `cmd` that waits for our exit (§ README).
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT } from './exit-codes.mjs';
import { directorySize, pathExists, readJson, removeTree, writeJsonAtomic } from './fsx.mjs';
import { beginJournal, loadJournal, PHASES, TERMINAL_PHASES } from './journal.mjs';
import { isServiceAbsentError, OpsError } from './ops.mjs';
import { REG_ARP_KEY, REG_EVENT_SOURCE_KEY, REG_PRODUCT_KEY, SERVICE_NAME } from './paths.mjs';
import { recoverTransaction } from './recovery.mjs';
import { rollbackInstall } from './install.mjs';

/**
 * @param {{ layout: object, logger: object, ops: object }} ctx
 * @returns {Promise<{code: number, message: string}>}
 */
export async function runUninstall({ layout, logger, ops }) {
  if (!pathExists(layout.uninstallRegistryPath) && !pathExists(layout.appRoot)) {
    return { code: EXIT.PRECHECK, message: `未找到安装登记 ${layout.uninstallRegistryPath}：本机没有可卸载的安装` };
  }

  const existing = loadJournal(layout.journalPath);
  if (existing.state === 'corrupt') {
    return { code: EXIT.PRECHECK, message: `journal 损坏，进入只读诊断：${existing.reasons.join('；')}` };
  }
  // `UNINSTALLING` is a resumable phase (§6.2): re-entering it is how a crashed uninstall
  // converges. Any other non-terminal phase means something else is mid-flight: converge it
  // first if §6.2 gives a convergent action (H1), otherwise refuse.
  const resuming = existing.state === 'ok' && existing.journal.phase === PHASES.UNINSTALLING;
  if (existing.state === 'ok' && !TERMINAL_PHASES.has(existing.journal.phase) && !resuming) {
    const recovered = await recoverTransaction({
      layout, journal: existing.journal, logger, ops, rollback: rollbackInstall,
    });
    if (recovered.outcome === 'converged') {
      logger.warn('先收敛了中断的安装事务，继续执行卸载', { phase: existing.journal.phase, action: recovered.action });
    } else if (recovered.outcome === 'failed') {
      return { code: EXIT.ROLLBACK_FAILED, message: recovered.message };
    } else if (recovered.outcome !== 'none') {
      const code = recovered.code === EXIT.ROLLBACK_REFUSED ? EXIT.ROLLBACK_REFUSED : EXIT.BUSY;
      return { code, message: `存在进行中事务（phase=${existing.journal.phase}）：${recovered.message}` };
    }
  }

  const registration = pathExists(layout.uninstallRegistryPath) ? readJson(layout.uninstallRegistryPath) : null;
  const journal = resuming
    ? existing.journal
    : beginJournal({
      path: layout.journalPath,
      op: 'uninstall',
      fromVersion: registration?.version ?? null,
      toVersion: null,
      paths: {
        app: layout.appRoot,
        appPrev: layout.appPrevRoot,
        staging: null,
        db: layout.storePath,
        dbSnapshot: null,
        programRoot: layout.programRoot,
        dataRoot: layout.dataRoot,
      },
      fromManifestDigest: null,
      toManifestDigest: null,
    });

  if (resuming) {
    logger.warn('续跑未完成的卸载', { txid: journal.txid, phase: journal.phase });
  }
  journal.enter(PHASES.UNINSTALLING, resuming ? '续跑' : '停止服务 → 注销 → 删程序区');

  try {
    // 1. Stop. A service that is not there is success: uninstall must be idempotent.
    //    A service that will not stop is exit 20, and nothing else has been touched yet.
    try {
      ops.serviceStop({ timeoutMs: 90_000 });
    } catch (error) {
      // Step 1 had the same hole as step 3: a service that is already gone has nothing to
      // stop, but the failure parked the phase at `UNINSTALLING` and answered 20 to every
      // rerun while `/install` answered 15 — a second one-way door (H5, other entrance).
      if (!isServiceAbsentError(error)) {
        journal.settle(false, error.message);
        logger.error('停止服务失败，未删除任何文件', error.message);
        return { code: EXIT.SERVICE_STOP, message: `停止服务失败：${error.message}` };
      }
      logger.warn('服务已不存在，无需停止');
    }

    // 2. Event Log Readers membership (D14). It goes before the service is unregistered,
    //    because `NT SERVICE\<name>` stops being resolvable once the service is deleted.
    try {
      ops.eventLogReadersRemove({ account: `NT SERVICE\\${SERVICE_NAME}` });
    } catch (error) {
      if (!isServiceAbsentError(error)) {
        throw new OpsError('E_EVENTLOG_READERS', `移除事件日志读者组成员失败：${error.message}`);
      }
      logger.warn('服务账号已不存在，跳过组成员移除');
    }

    // 3. Delete the service. `aegis-svc.exe` answers 1060 when it is already gone, and that is
    //    the desired end state of a delete — treating it as failure left the phase at
    //    `UNINSTALLING` forever, so no run could ever finish (H5).
    try {
      ops.serviceDelete();
    } catch (error) {
      if (!isServiceAbsentError(error)) throw new OpsError('E_SERVICE_DELETE', `注销服务失败：${error.message}`);
      logger.warn('服务已不存在，视为已注销');
    }
    ops.registryDeleteKey(REG_EVENT_SOURCE_KEY);

    // 4. ARP + product keys.
    ops.registryDeleteKey(REG_ARP_KEY);
    ops.registryDeleteKey(REG_PRODUCT_KEY);

    // 5. Start menu.
    if (pathExists(layout.startMenuDir)) {
      removeTree(layout.startMenuDir, [layout.startMenuRoot, layout.programRoot, layout.dataRoot]);
    }

    // 6. Program tree, deferred. `pending-removal.json` is the marker recovery reads.
    writeJsonAtomic(layout.pendingRemovalPath, {
      txid: journal.txid,
      target: layout.programRoot,
      requestedAt: new Date().toISOString(),
      reason: 'uninstall',
    });
    ops.scheduleProgramTreeRemoval({ target: layout.programRoot, pendingPath: layout.pendingRemovalPath });

    // 7. Receipts describing the install are gone with the install; the uninstall
    //    registration is removed too so a second run reports "nothing to uninstall".
    if (pathExists(layout.installReceiptPath)) removeTree(layout.installReceiptPath, [layout.installDir, layout.dataRoot]);
    if (pathExists(layout.uninstallRegistryPath)) removeTree(layout.uninstallRegistryPath, [layout.installDir, layout.dataRoot]);

    journal.enter(PHASES.UNINSTALLED, '已卸载（数据保留）').settle(true);
    logger.info('卸载完成，数据保留', { dataRoot: layout.dataRoot });

    return {
      code: EXIT.OK,
      message: `已卸载。数据仍位于 ${layout.dataRoot}；如需清除请运行 /purge`,
    };
  } catch (error) {
    // Leave the phase at UNINSTALLING: that marker is what lets the next run resume.
    journal.settle(false, error.message);
    logger.error('卸载失败，phase 保留为 UNINSTALLING 以便续跑', error.message);
    return { code: EXIT.UNINSTALL_FAILED, message: `卸载失败：${error.message}` };
  }
}

/** Directories `/purge` knows how to delete. Anything else is never touched. */
export function purgeInventory(layout) {
  return [
    { key: 'config', path: layout.configDir },
    { key: 'data', path: layout.dataDir },
    { key: 'logs', path: layout.logsDir },
    { key: 'engine', path: join(layout.installDir, 'engine') },
    { key: 'staging', path: layout.stagingRoot },
    { key: 'backup', path: join(layout.installDir, 'backup') },
    { key: 'plan', path: layout.planDir },
  ];
}

/**
 * @param {{ layout: object, logger: object, ops: object }} ctx
 * @returns {Promise<{code: number, message: string, deleted: string[], skipped: string[], failed: {path: string, reason: string}[]}>}
 */
export async function runPurge({ layout, logger, ops }) {
  const existing = loadJournal(layout.journalPath);
  if (existing.state === 'corrupt') {
    return { code: EXIT.PRECHECK, message: `journal 损坏，进入只读诊断：${existing.reasons.join('；')}`, deleted: [], skipped: [], failed: [] };
  }
  // `PURGING` is resumable: a crash mid-delete leaves partial state and the next run must
  // re-scan the manifest rather than refuse (§6.2, "不因某项已不存在而失败").
  const resuming = existing.state === 'ok' && existing.journal.phase === PHASES.PURGING;
  if (existing.state === 'ok' && !TERMINAL_PHASES.has(existing.journal.phase) && !resuming) {
    return {
      code: EXIT.BUSY,
      message: `存在进行中事务（phase=${existing.journal.phase}），请先完成或恢复`,
      deleted: [], skipped: [], failed: [],
    };
  }

  const inventory = purgeInventory(layout);
  // The manifest must land on disk **before** the first delete: it is the only record of
  // what PURGING is supposed to have removed (§4.1), and the resume path reads it back.
  if (!resuming) {
    writeJsonAtomic(layout.purgeManifestPath, {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      dataRoot: layout.dataRoot,
      entries: inventory,
    });
  }

  const journal = resuming
    ? existing.journal
    : beginJournal({
      path: layout.journalPath,
      op: 'purge',
      fromVersion: null,
      toVersion: null,
      paths: { app: null, appPrev: null, staging: null, db: layout.storePath, dbSnapshot: null, programRoot: layout.programRoot, dataRoot: layout.dataRoot },
      fromManifestDigest: null,
      toManifestDigest: null,
    });
  if (resuming) logger.warn('续跑未完成的清除', { txid: journal.txid });
  journal.enter(PHASES.PURGING, `${inventory.length} 项`);

  const deleted = [];
  const skipped = [];
  const failed = [];
  let freedBytes = 0;

  for (const entry of inventory) {
    if (!pathExists(entry.path)) {
      skipped.push(entry.path);
      continue;
    }
    try {
      freedBytes += directorySize(entry.path);
      removeTree(entry.path, [layout.dataRoot, layout.programRoot]);
      deleted.push(entry.path);
    } catch (error) {
      failed.push({ path: entry.path, reason: error.message });
    }
  }

  // Receipts and the floor go last, and the journal after them, so that a crash in the
  // middle still leaves a phase marker that says "keep going".
  for (const path of [layout.installReceiptPath, layout.uninstallRegistryPath, layout.versionFloorPath]) {
    if (pathExists(path)) {
      try {
        removeTree(path, [layout.installDir, layout.dataRoot]);
        deleted.push(path);
      } catch (error) {
        failed.push({ path: path, reason: error.message });
      }
    } else {
      skipped.push(path);
    }
  }

  if (failed.length > 0) {
    journal.settle(false, `${failed.length} 项失败`);
    const listing = failed.map((entry) => `${entry.path}（${entry.reason}）`).join('\n');
    logger.error('清除部分失败', { failed: failed.length });
    return {
      code: EXIT.PURGE_FAILED,
      message: `清除失败 ${failed.length} 项，已删 ${deleted.length} 项，跳过 ${skipped.length} 项：\n${listing}`,
      deleted, skipped, failed,
    };
  }

  // Only now may the journal go: it is the marker that made this resumable.
  if (pathExists(layout.journalPath)) removeTree(layout.journalPath, [layout.installDir, layout.dataRoot]);
  if (pathExists(layout.purgeManifestPath)) removeTree(layout.purgeManifestPath, [layout.installDir, layout.dataRoot]);

  // `pending-removal.json` is deliberately kept: it is the only record that the *program*
  // tree still has to disappear, and `/purge` never deletes the program tree. Removing the
  // marker here would turn an unfinished uninstall into an invisible one.
  const outstanding = pathExists(layout.pendingRemovalPath);

  // Remove the containers if (and only if) they are empty.
  for (const path of [layout.installDir, layout.dataRoot]) {
    if (pathExists(path) && isEmptyDirectory(path)) {
      removeTree(path, [layout.dataRoot, layout.programRoot]);
      deleted.push(path);
    }
  }

  logger.info('清除完成', { deleted: deleted.length, skipped: skipped.length, freedMiB: Number((freedBytes / 1048576).toFixed(2)) });
  return {
    code: EXIT.OK,
    message: `清除完成：删除 ${deleted.length} 项 / 跳过 ${skipped.length} 项 / 释放 ${(freedBytes / 1048576).toFixed(2)} MiB`
      + (outstanding ? `；程序区删除仍待执行（${layout.pendingRemovalPath} 仍在）` : ''),
    deleted, skipped, failed,
  };
}

export function isEmptyDirectory(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}
