/**
 * install.mjs — the install/repair transaction (§6 state machine, `release/windows-install.md` §2).
 *
 * The shape is deliberately boring: every step is either a pure check, a write, or a
 * phase transition that was flushed *before* the write. Anything that can fail after
 * `SWAP_B` has a matching rollback, so the only two outcomes are "installed" and "as if
 * never installed" (N1).
 *
 * Two scope limits, stated here rather than discovered later:
 *
 * - **Upgrade (toVersion > fromVersion) is not implemented in this slice.** It needs a
 *   DB snapshot and a single-transaction migration, and a half-done upgrade is exactly
 *   the state §6 exists to prevent. The installer refuses with code 10 and says so,
 *   instead of copying new files over old ones and hoping.
 * - **`/repair` (same version) is implemented** and goes through SWAP_A/SWAP_B, so the
 *   swap path is exercised by tests rather than only described in a document.
 */

import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, statfsSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve } from 'node:path';

import { EXIT } from './exit-codes.mjs';
import {
  copyTreeHashed,
  directorySize,
  ensureDir,
  isDirectory,
  listFiles,
  pathExists,
  readJson,
  removeTree,
  sha256File,
  writeFileAtomic,
  writeJsonAtomic,
} from './fsx.mjs';
import { beginJournal, loadJournal, MANIFEST_REL_PATH, PHASES, TERMINAL_PHASES } from './journal.mjs';
import { describeFailure, parseManifest, verifyTree } from './manifest.mjs';
import { aclPlan, OpsError } from './ops.mjs';
import {
  REG_ARP_KEY,
  REG_EVENT_SOURCE_KEY,
  REG_PRODUCT_KEY,
  SERVICE_DISPLAY_NAME,
  SERVICE_NAME,
  UPGRADE_CODE,
} from './paths.mjs';
import { manifestDigestOf, recoverTransaction } from './recovery.mjs';
import { evaluateVersionRelation, nextFloorRecord, parseVersion, readTrust, readVersionFloor } from './version.mjs';

/** Default API port when the caller does not pick one. `0` would make the CLI unusable. */
export const DEFAULT_API_PORT = 8787;

const MANIFEST_DIR = 'manifests';

/** Failure carrying the exit code the contract requires for this situation. */
export class InstallFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InstallFailure';
    this.code = code;
  }
}

/**
 * A failure whose only correct handling is "stop and print" (§6.2 combination 4).
 *
 * `rollbackInstall` is not allowed to run for this one: the whole point of the branch is
 * that the disk facts do not say which tree is trustworthy, and rollback's first move is a
 * `rename`/`removeTree` on exactly those trees. Before this class existed, the throw fell
 * through to the generic `catch`, which rolled back anyway — the message said "stopped" while
 * the disk was being changed (H2).
 */
export class DiagnosticFailure extends InstallFailure {
  constructor(code, message, diagnosis = null) {
    super(code, message);
    this.name = 'DiagnosticFailure';
    this.noRollback = true;
    this.diagnosis = diagnosis;
  }
}

/** Which swap steps this transaction actually completed (from the journal, not the disk). */
export function journalSwapProgress(journal) {
  const steps = Array.isArray(journal?.data?.steps) ? journal.data.steps : [];
  const done = (phase) => steps.some((step) => step.phase === phase && step.ok === true);
  return { swapA: done(PHASES.SWAP_A), swapB: done(PHASES.SWAP_B) };
}

/**
 * May this transaction delete `app\`? (P0)
 *
 * Rollback used to delete `app\` unconditionally. When the install fails *before* the swap —
 * a corrupt payload, a locked file, a full disk during staging — `app\` is still the user's
 * **verified, working** install and there is no `app.prev` to restore it from, so the delete
 * was pure data loss with a journal that claimed "rolled back successfully".
 *
 * The rule is therefore: only a tree this transaction created may be removed, and "created"
 * means `SWAP_B` was durably recorded (`settle(true)`), because that is the step that moves
 * the staged tree onto `app\`. The digest is used as the second lock: if the tree on disk is
 * the one the receipt describes as installed, it is the active version and is not ours.
 */
export function appRootOwnership({ layout, journal }) {
  const swap = journalSwapProgress(journal);
  if (!pathExists(layout.appRoot)) {
    return { owned: false, exists: false, digest: null, reason: 'app\\ 不存在' };
  }
  const digest = manifestDigestOf(layout.appRoot);
  const to = journal?.data?.toManifestDigest ?? null;
  if (swap.swapB) {
    return { owned: true, exists: true, digest, reason: 'SWAP_B 已落盘：app\\ 是本事务的 staging 树' };
  }
  if (!swap.swapA) {
    return { owned: false, exists: true, digest, reason: '本事务尚未改动 app\\（SWAP_A 未成功）' };
  }
  if (digest !== null && digest === to) {
    return { owned: true, exists: true, digest, reason: 'app\\ 摘要等于本事务待装清单' };
  }
  return { owned: false, exists: true, digest, reason: 'app\\ 摘要无法证明它属于本事务' };
}

/**
 * Can `app\` and `app.prev` coexist without a human? (§6.2 combination 4)
 *
 * Refused unless the tree in `app.prev` is recognisable as a copy we already know about
 * (byte-identical to `app`, or the tree the receipt says was installed). An unreadable or
 * rewritten `app.prev` may be the only trustworthy old copy, and both "delete it" and
 * "rename it over app" destroy that possibility.
 */
export function assessExistingTreePair({ layout, receipt }) {
  const appDigest = manifestDigestOf(layout.appRoot);
  const prevDigest = manifestDigestOf(layout.appPrevRoot);
  const receiptDigest = receipt?.manifestDigest ?? null;
  const details = { appDigest, prevDigest, receiptDigest };
  if (appDigest === null) {
    return { ok: false, reason: `app 的 ${MANIFEST_REL_PATH} 不可读，无法判定哪一份可信`, details };
  }
  if (prevDigest === null) {
    return { ok: false, reason: `app.prev 的 ${MANIFEST_REL_PATH} 不可读或已被改写，无法唯一判定（§6.2 组合 4）`, details };
  }
  const recognised = new Set([appDigest, receiptDigest].filter((value) => typeof value === 'string'));
  if (!recognised.has(prevDigest)) {
    return {
      ok: false,
      reason: `app 与 app.prev 的清单摘要都不足以判定 app.prev 的来源（§6.2 组合 4）：`
        + `app=${appDigest.slice(0, 16)} app.prev=${prevDigest.slice(0, 16)} 记录=${String(receiptDigest).slice(0, 16)}`,
      details,
    };
  }
  return { ok: true, reason: 'app.prev 可识别为上一事务的保留副本', details };
}

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/** What the log is allowed to know about the token (ADR §5.1). */
export function tokenFingerprint(token) {
  return { length: token.length, digest: createHash('sha256').update(token).digest('hex').slice(0, 8) };
}

/** Best-effort free-space check; a missing measurement must not become a false refusal. */
export function checkDiskSpace(path, requiredBytes) {
  try {
    let probe = path;
    while (!pathExists(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const stats = statfsSync(probe);
    return { ok: Number(stats.bavail) * Number(stats.bsize) >= requiredBytes, checked: true };
  } catch {
    return { ok: true, checked: false };
  }
}

export function volumeOf(path) {
  return parsePath(resolve(path)).root.toLowerCase();
}

/** Directory map used for creation and for the plan assertion in tests. */
export function directoryPlan(layout) {
  return [
    layout.programRoot,
    layout.binRoot,
    layout.dataRoot,
    layout.configDir,
    layout.dataDir,
    layout.storeDir,
    layout.secretsDir,
    layout.analysisDir,
    layout.logsDir,
    layout.installDir,
    layout.backupRoot,
    layout.startMenuDir,
  ];
}

/**
 * Run the full install transaction.
 *
 * @param {{
 *   layout: object,
 *   options: { payload: string, toVersion: string, apiPort?: number, rulePack?: string|null,
 *              engineSource?: string|null, healthTimeoutMs?: number },
 *   logger: object,
 *   ops: object,
 *   hooks?: { onPhase?: (phase: string) => void|Promise<void> }
 * }} ctx
 * @returns {Promise<{code: number, message: string}>}
 */
export async function runInstall({ layout, options, logger, ops, hooks = {} }) {
  const onPhase = async (phase) => {
    if (typeof hooks.onPhase === 'function') await hooks.onPhase(phase);
  };

  // ---------------------------------------------------------------- precheck
  try {
    parseVersion(options.toVersion);
  } catch (error) {
    return { code: EXIT.PRECHECK, message: error.message };
  }

  const payload = resolve(options.payload);
  if (!isDirectory(payload)) {
    return { code: EXIT.PRECHECK, message: `载荷目录不存在：${payload}` };
  }
  const payloadManifestPath = join(payload, MANIFEST_DIR, 'files.sha256');
  if (!pathExists(payloadManifestPath)) {
    return { code: EXIT.PRECHECK, message: `载荷缺少 manifests/files.sha256：${payload}` };
  }

  // An unfinished transaction is never resumed implicitly: "run the installer again"
  // is the mistake §1 of the recovery doc exists to stop (code 15). What it *is* allowed to
  // do is converge the interrupted transaction first (H1): before this, a crash at SWAP_B
  // answered 15 to /install, /uninstall and /purge and 25 to /rollback — a one-way door with
  // no command that could open it.
  const existing = loadJournal(layout.journalPath);
  if (existing.state === 'corrupt') {
    return { code: EXIT.PRECHECK, message: `journal 损坏，进入只读诊断（不自动恢复）：${existing.reasons.join('；')}` };
  }
  if (existing.state === 'ok' && !TERMINAL_PHASES.has(existing.journal.phase)) {
    const recovered = await recoverTransaction({ layout, journal: existing.journal, logger, ops });
    if (recovered.outcome === 'converged') {
      return { code: EXIT.ROLLED_BACK, message: `${recovered.message}；本次安装未开始，请重新执行 /install` };
    }
    if (recovered.outcome === 'failed') {
      return { code: EXIT.ROLLBACK_FAILED, message: recovered.message };
    }
    const code = recovered.code === EXIT.ROLLBACK_REFUSED ? EXIT.ROLLBACK_REFUSED : EXIT.BUSY;
    return {
      code,
      message: `存在进行中事务（phase=${existing.journal.phase}, txid=${existing.journal.txid}）：${recovered.message}`,
    };
  }

  // staging is renamed onto `app`, so both must live on one volume (§6.2 跨卷硬前置).
  if (volumeOf(layout.stagingRoot) !== volumeOf(layout.appRoot)) {
    return { code: EXIT.PRECHECK, message: `E_CROSS_VOLUME：staging 与 app 不在同一卷（${layout.stagingRoot} vs ${layout.appRoot}）` };
  }

  // The native host is the only component that can create a virtual service account;
  // without it, refuse rather than approximate with `sc.exe` (ADR §3.2 / D4).
  if (layout.mode === 'armed' && !pathExists(layout.serviceHostExe)) {
    return { code: EXIT.PRECHECK, message: `缺少服务宿主 ${layout.serviceHostExe}（P2 原生宿主未构建），拒绝用 sc.exe 替代` };
  }

  const receipt = pathExists(layout.installReceiptPath) ? readJson(layout.installReceiptPath) : null;
  const fromVersion = receipt === null ? null : receipt.version;

  // §6.2 combination 4 is decided here, before a single byte is written. Deciding it inside
  // the swap (after `beginJournal` + a full staging copy) meant the refusal was followed by a
  // rollback that renamed an unverified `app.prev` onto `app\` — a tree nobody could verify
  // afterwards (H2). A diagnosis that writes is not a diagnosis.
  if (pathExists(layout.appRoot) && pathExists(layout.appPrevRoot)) {
    const verdict = assessExistingTreePair({ layout, receipt });
    if (!verdict.ok) {
      logger.error('app 与 app.prev 并存且无法唯一判定（§6.2 组合 4），已停止，未做任何改动', verdict.details);
      return {
        code: EXIT.PRECHECK,
        message: `${verdict.reason}；已停止，未做任何改动（journal: ${layout.journalPath}）`,
      };
    }
    logger.info('app 与 app.prev 并存，app.prev 可识别为保留副本', verdict.details);
  }

  const trust = readTrust(join(payload, MANIFEST_DIR, 'trust.json'));
  if (trust.state === 'corrupt') {
    return { code: EXIT.PRECHECK, message: `trust.json 不可用：${trust.reasons.join('；')}` };
  }
  const floorState = readVersionFloor(layout.versionFloorPath);
  const relation = evaluateVersionRelation({ toVersion: options.toVersion, fromVersion, trust, floor: floorState });
  if (relation.code !== 0) {
    return { code: relation.code, message: relation.reasons.join('；') };
  }
  if (relation.op === 'upgrade') {
    return {
      code: EXIT.PRECHECK,
      message: `升级路径未在本切片实现（${fromVersion} → ${options.toVersion}）：缺少 DB 快照与迁移事务，拒绝覆盖式升级`,
    };
  }

  // The daemon only accepts a rule pack inside `dataDir`, so it is copied as data.
  const rulePackSource = options.rulePack ?? join(payload, 'rules', 'pack.json');
  if (!pathExists(rulePackSource)) {
    return {
      code: EXIT.PRECHECK,
      message: `载荷缺少规则包 ${rulePackSource}：full 模式无法启动（可用 --rule-pack 指定）`,
    };
  }

  // Parse the manifest before copying: a malformed list is a payload bug, and finding
  // it after 47 000 copies wastes storage for nothing.
  let manifest;
  try {
    manifest = parseManifest(readFileSync(payloadManifestPath, 'utf8'));
  } catch (error) {
    return { code: EXIT.MANIFEST, message: `files.sha256 解析失败：${error.message}` };
  }

  const space = checkDiskSpace(layout.programRoot, Math.max(64 * 1024 * 1024, directorySize(payload) * 2));
  if (!space.ok) {
    return { code: EXIT.PRECHECK, message: '磁盘余量不足（需要载荷体积 ×2 加上快照余量）' };
  }

  logger.info('预检通过', {
    payload, toVersion: options.toVersion, fromVersion, op: relation.op,
    entries: manifest.rows.length, manifestDigest: manifest.digest, floor: relation.floor,
  });

  // ------------------------------------------------------------ staging copy
  ensureDir(layout.stagingRoot);
  const staging = layout.stagingDir;
  if (pathExists(staging)) {
    removeTree(staging, [layout.stagingRoot, layout.installDir, layout.dataRoot]);
  }

  const journal = beginJournal({
    path: layout.journalPath,
    op: relation.op,
    fromVersion,
    toVersion: options.toVersion,
    paths: {
      app: layout.appRoot,
      appPrev: layout.appPrevRoot,
      staging,
      db: layout.storePath,
      dbSnapshot: null,
      programRoot: layout.programRoot,
      dataRoot: layout.dataRoot,
    },
    fromManifestDigest: receipt === null ? null : receipt.manifestDigest ?? null,
    toManifestDigest: manifest.digest,
    dbSchemaBefore: null,
    dbSchemaAfter: null,
  });

  // Which side effects this transaction has already performed. Persisted in the journal
  // *before* the action, so both the in-process rollback and a later recovery know what may
  // be undone. Without it, rollback could only guess — and guessing "delete the registry key"
  // on a failed repair would remove a working install's registration (H3).
  const progress = {
    dirsCreated: false,
    binCopied: false,
    dataCreated: false,
    eventLogReadersAdded: false,
    serviceInstalled: false,
    registryWritten: false,
    shortcutCreated: false,
  };
  const mark = (key) => {
    progress[key] = true;
    journal.patch({ progress }).persist();
  };

  let committed = false;
  try {
    await copyTreeHashed(payload, staging);
    logger.info('载荷已展开到 staging', { staging, files: manifest.rows.length });

    // ----------------------------------------------------------- verify #1
    const stagedManifest = parseManifest(readFileSync(join(staging, MANIFEST_DIR, 'files.sha256'), 'utf8'));
    if (stagedManifest.digest !== manifest.digest) {
      throw new InstallFailure(EXIT.MANIFEST, 'staging 侧 files.sha256 摘要与源载荷不同（清单被改写）');
    }
    const stagedCheck = await verifyTree({ root: staging, rows: stagedManifest.rows });
    if (!stagedCheck.ok) {
      throw new InstallFailure(EXIT.MANIFEST, `载荷完整性校验失败：${describeFailure(stagedCheck)}`);
    }
    logger.info('staging 全量校验通过', { checked: stagedCheck.checked });

    journal.enter(PHASES.STAGED, `${stagedCheck.checked} 条哈希通过`).settle(true);
    await onPhase(PHASES.STAGED);

    // -------------------------------------------------------------- directories
    for (const path of directoryPlan(layout)) ensureDir(path);
    mark('dirsCreated');

    // -------------------------------------------------------------- swap
    if (pathExists(layout.appRoot)) {
      journal.enter(PHASES.SWAP_A, 'app → app.prev');
      await onPhase(PHASES.SWAP_A);
      if (pathExists(layout.appPrevRoot)) {
        // Defence in depth: the same §6.2 combination-4 decision was already made in the
        // precheck, but the disk can change between then and now. A `DiagnosticFailure` here
        // stops without rolling back, so nothing is renamed or deleted.
        const previousManifestPath = join(layout.appPrevRoot, MANIFEST_DIR, 'files.sha256');
        const previousDigest = pathExists(previousManifestPath)
          ? createHash('sha256').update(readFileSync(previousManifestPath)).digest('hex')
          : null;
        if (previousDigest !== (journal.data.fromManifestDigest ?? null)
          && previousDigest !== journal.data.toManifestDigest) {
          throw new DiagnosticFailure(
            EXIT.PRECHECK,
            'app 与 app.prev 同时存在且清单摘要无法唯一判定（§6.2 组合 4）：已停止，需人工判定',
            { appPrevDigest: previousDigest, fromManifestDigest: journal.data.fromManifestDigest },
          );
        }
        removeTree(layout.appPrevRoot, [layout.programRoot, layout.dataRoot]);
      }
      renameSync(layout.appRoot, layout.appPrevRoot);
      journal.settle(true);
    }

    journal.enter(PHASES.SWAP_B, 'staging → app');
    await onPhase(PHASES.SWAP_B);
    renameSync(staging, layout.appRoot);
    journal.settle(true);

    // ----------------------------------------------------------- verify #2
    const appManifestBytes = readFileSync(join(layout.appRoot, MANIFEST_DIR, 'files.sha256'));
    if (createHash('sha256').update(appManifestBytes).digest('hex') !== manifest.digest) {
      throw new InstallFailure(EXIT.MANIFEST, 'app\\manifests\\files.sha256 与 staging 侧摘要不同（安装器不得重算清单）');
    }
    const appCheck = await verifyTree({ root: layout.appRoot, rows: manifest.rows });
    if (!appCheck.ok) {
      throw new InstallFailure(EXIT.MANIFEST, `安装后全量校验失败：${describeFailure(appCheck)}`);
    }
    logger.info('app 全量校验通过', { checked: appCheck.checked });

    // -------------------------------------------------------------- side payload
    const hostSource = join(payload, 'bin', 'aegis-svc.exe');
    if (pathExists(hostSource)) {
      ensureDir(layout.binRoot);
      copyFileSync(hostSource, layout.serviceHostExe);
      mark('binCopied');
    }
    if (options.engineSource !== undefined && options.engineSource !== null) {
      if (!isDirectory(options.engineSource)) {
        throw new InstallFailure(EXIT.PRECHECK, `--engine-source 不是目录：${options.engineSource}`);
      }
      await copyTreeHashed(options.engineSource, join(layout.installDir, 'engine'));
    } else {
      logger.warn('未提供 --engine-source：ARP 卸载入口指向的引擎副本不存在（打包阶段必须补上）');
    }

    // -------------------------------------------------------------- data area
    if (relation.op === 'install') {
      ensureDir(layout.secretsDir);
      const token = generateToken();
      writeFileAtomic(layout.tokenPath, `${token}\n`);
      logger.info('已生成 API token', tokenFingerprint(token));
    } else {
      logger.info('repair：保留既有 token 与配置');
    }

    const ruleTarget = join(layout.dataDir, 'rules', 'pack.json');
    ensureDir(dirname(ruleTarget));
    copyFileSync(rulePackSource, ruleTarget);

    const port = options.apiPort ?? DEFAULT_API_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new InstallFailure(EXIT.PRECHECK, `--port 非法：${String(options.apiPort)}`);
    }
    writeJsonAtomic(layout.configPath, {
      dataDir: layout.dataDir,
      mode: 'full',
      api: { host: '127.0.0.1', port, tokenFile: 'secrets/api-token' },
      detection: { rulePackPath: 'rules/pack.json' },
      logging: { level: 'info' },
    });
    const accepted = await assertDaemonAcceptsConfig(join(layout.appRoot, 'apps', 'daemon', 'src', 'config.js'), layout.configPath, logger);
    if (!accepted.ok) {
      throw new InstallFailure(EXIT.PRECHECK, `生成的配置不被 daemon 接受：${accepted.reason}`);
    }
    // Only a fresh install *creates* the data area; a repair must never lose it (N7 / D3–D6).
    if (relation.op === 'install') mark('dataCreated');

    // -------------------------------------------------------------- ACL + service
    for (const entry of aclPlan(layout)) ops.acl(entry);
    try {
      ops.serviceInstall({ version: options.toVersion });
      // D14 (H4): the service account must be a member of `Event Log Readers` before the
      // service tries to read the Security log. This used to be a `--event-log-readers` flag
      // that the host binary never parsed — recorded, asserted, never implemented.
      ops.eventLogReadersAdd({ account: `NT SERVICE\\${SERVICE_NAME}` });
      mark('eventLogReadersAdded');
      ops.serviceStart();
      mark('serviceInstalled');
    } catch (error) {
      if (error instanceof OpsError) {
        throw new InstallFailure(EXIT.HEALTH, `服务注册/启动失败：${error.message}`);
      }
      throw error;
    }
    const health = await probeHealth({ layout, timeoutMs: options.healthTimeoutMs ?? 10_000, logger, ops });
    if (!health.ok) {
      throw new InstallFailure(EXIT.HEALTH, `健康检查失败：${health.reason}`);
    }

    // -------------------------------------------------------------- registry + shortcut
    writeArpEntries(ops, layout, options.toVersion);
    ops.registrySet(REG_PRODUCT_KEY, 'InstallLocation', 'REG_SZ', layout.programRoot);
    ops.registrySet(REG_EVENT_SOURCE_KEY, 'EventMessageFile', 'REG_EXPAND_SZ', '%SystemRoot%\\System32\\EventCreate.exe');
    ops.registrySet(REG_EVENT_SOURCE_KEY, 'TypesSupported', 'REG_DWORD', 7);
    mark('registryWritten');
    ops.shortcutCreate({
      lnk: layout.startMenuShortcut,
      target: layout.cliStub,
      args: '',
      workingDirectory: layout.programRoot,
      description: `${SERVICE_DISPLAY_NAME} 客户端`,
    });
    mark('shortcutCreated');

    // -------------------------------------------------------------- receipts
    const now = new Date().toISOString();
    writeJsonAtomic(layout.installReceiptPath, {
      schemaVersion: '1.0',
      product: 'AIDriven NetDefense',
      upgradeCode: UPGRADE_CODE,
      version: options.toVersion,
      op: relation.op,
      txid: journal.txid,
      installedAt: now,
      programRoot: layout.programRoot,
      dataRoot: layout.dataRoot,
      serviceName: SERVICE_NAME,
      manifestDigest: manifest.digest,
      fileCount: manifest.rows.length,
      apiPort: port,
      author: 'PT-dove',
    });
    writeJsonAtomic(layout.uninstallRegistryPath, {
      schemaVersion: '1.0',
      version: options.toVersion,
      programRoot: layout.programRoot,
      dataRoot: layout.dataRoot,
      serviceName: SERVICE_NAME,
      registryKeys: [REG_ARP_KEY, REG_PRODUCT_KEY, REG_EVENT_SOURCE_KEY],
      startMenuDir: layout.startMenuDir,
      enginePath: layout.enginePath,
      nodeExe: layout.nodeExe,
      installedAt: now,
    });

    // The floor only ever rises; `hardFloorMax` is machine memory, not a package claim.
    const previousFloor = readVersionFloor(layout.versionFloorPath);
    writeJsonAtomic(layout.versionFloorPath, {
      ...nextFloorRecord(previousFloor, relation.floor === '0.0.0' ? options.toVersion : relation.floor),
      source: 'install',
    });

    // -------------------------------------------------------------- commit
    journal.enter(PHASES.COMMITTED, `version=${options.toVersion}`).settle(true);
    await onPhase(PHASES.COMMITTED);
    committed = true;

    // Post-commit cleanup is not part of the transaction: a failure here must not turn a
    // successful install into exit 10 (§2 of the recovery doc: cleanup is separate and
    // idempotent, and the next run removes whatever is left).
    try {
      if (pathExists(layout.stagingRoot)) {
        removeTree(layout.stagingRoot, [layout.installDir, layout.dataRoot]);
      }
    } catch (error) {
      logger.warn('提交后清理 staging 失败（不影响本次安装结果）', error.message);
    }

    return {
      code: EXIT.OK,
      message: `已安装 ${options.toVersion} 到 ${layout.programRoot}；数据目录 ${layout.dataRoot}`,
    };
  } catch (error) {
    const code = error instanceof InstallFailure ? error.code : EXIT.PRECHECK;
    logger.error('安装中止', { code, message: error.message });
    if (error.noRollback === true) {
      // §6.2 combination 4: print, leave the disk exactly as it was, and say so in the journal
      // without changing the phase (changing it would hide which swap step was reached).
      journal.patch({
        diagnosis: {
          at: new Date().toISOString(),
          phase: journal.phase,
          reason: error.message,
          ...(error.diagnosis ?? {}),
        },
      }).persist();
      return { code, message: `${error.message}（未执行任何回滚动作）` };
    }
    if (!committed) {
      const rolled = await rollbackInstall({ layout, journal, logger, ops });
      if (!rolled.ok) {
        return { code: EXIT.ROLLBACK_FAILED, message: `${error.message}；回滚亦失败：${rolled.reason}` };
      }
      const claim = rolled.consistency?.claim ?? null;
      return { code, message: claim === null ? error.message : `${error.message}；回滚后：${claim}` };
    }
    return { code, message: error.message };
  }
}

/**
 * Undo a partially applied install. Any step whose target is already gone is a no-op,
 * so this is safe to re-enter after a crash (§6.2 `ROLLING_BACK`).
 *
 * Three properties, each of which used to be missing:
 *
 * 1. **It never deletes a tree this transaction did not create** (P0). A repair that fails
 *    while staging still has a verified, working install at `app\` and no `app.prev`; the
 *    old code removed `app\` anyway, so one corrupt download destroyed a working install
 *    while `install.json` kept claiming it was installed.
 * 2. **It revokes the side effects it performed** (H3): registry keys, the Start-menu
 *    shortcut, `bin\aegis-svc.exe`, the event-log group membership, and — for a fresh
 *    install only — the data area it created. Which of those happened is read from the
 *    journal, not guessed.
 * 3. **It leaves the three records agreeing** (filesystem / `install.json` / journal):
 *    a receipt that describes a tree which is not on disk is deleted, and a receipt whose
 *    manifest digest does not match the tree on disk turns the rollback into a failure (24)
 *    instead of a claim that everything is fine.
 *
 * @returns {Promise<{ok: boolean, reason?: string, actions?: string[], consistency?: object}>}
 */
export async function rollbackInstall({ layout, journal, logger, ops }) {
  try {
    const swap = journalSwapProgress(journal);
    const progress = journal.data.progress ?? {};
    const actions = [];
    journal.enter(PHASES.ROLLING_BACK, '安装失败，回滚');

    // 1. Only the tree this transaction put there may be removed.
    const ownership = appRootOwnership({ layout, journal });
    if (pathExists(layout.appRoot)) {
      if (ownership.owned) {
        removeTree(layout.appRoot, [layout.programRoot, layout.dataRoot]);
        actions.push('删除本事务新建的 app\\');
      } else {
        actions.push(`保留原有 app\\（${ownership.reason}）`);
      }
    }

    // 2. Restore the old tree, but only if this transaction is the one that moved it.
    if (pathExists(layout.appPrevRoot)) {
      if (swap.swapA === true) {
        if (pathExists(layout.appRoot)) {
          journal.settle(false, 'app 与 app.prev 同时存在，无法还原');
          return { ok: false, reason: 'app 与 app.prev 同时存在，还原会覆盖一份未经验证的树；需人工判定' };
        }
        renameSync(layout.appPrevRoot, layout.appRoot);
        actions.push('app.prev 还原为 app');
      } else {
        actions.push('保留 app.prev（不是本事务创建）');
      }
    }

    // 3. Staging is ours by construction: `beginJournal` preceded the copy.
    if (layout.stagingRoot !== null && pathExists(layout.stagingRoot)) {
      removeTree(layout.stagingRoot, [layout.installDir, layout.dataRoot, layout.programRoot]);
      actions.push('清空 staging');
    }

    // 4. Service: deleting an absent service is success (H5), so this needs no progress flag.
    try {
      ops.serviceDelete();
      actions.push('注销服务');
    } catch (error) {
      logger.warn('回滚阶段注销服务失败（可能尚未创建）', error.message);
    }

    // 5. Group membership, only if this transaction added it (D14 / H4).
    if (progress.eventLogReadersAdded === true) {
      try {
        ops.eventLogReadersRemove({ account: `NT SERVICE\\${SERVICE_NAME}` });
        actions.push('移除事件日志读者组成员');
      } catch (error) {
        logger.warn('回滚阶段移除组成员失败', error.message);
      }
    }

    // 6. Start-menu shortcut.
    if (progress.shortcutCreated === true) {
      if (pathExists(layout.startMenuShortcut)) {
        ops.shortcutDelete({ lnk: layout.startMenuShortcut });
        removeTree(layout.startMenuShortcut, [layout.startMenuDir, layout.startMenuRoot]);
      }
      actions.push('删除开始菜单快捷方式');
    }

    // 7. Registry. A fresh install removes what it wrote; a repair restores the registration
    //    that the still-working old install depends on (it must never be left deleted).
    if (progress.registryWritten === true) {
      if (journal.data.op === 'install') {
        for (const key of [REG_ARP_KEY, REG_PRODUCT_KEY, REG_EVENT_SOURCE_KEY]) ops.registryDeleteKey(key);
        actions.push('删除 ARP/产品/事件日志源注册表项');
      } else {
        restoreRegistration({ layout, journal, ops, logger });
        actions.push('按 install.json 恢复注册表登记');
      }
    }

    // 8. Service host copy (`bin\aegis-svc.exe`), outside `app\` and outside any manifest.
    if (progress.binCopied === true && pathExists(layout.serviceHostExe)) {
      removeTree(layout.serviceHostExe, [layout.binRoot, layout.programRoot]);
      actions.push('删除 bin\\aegis-svc.exe');
    }

    // 9. Data area: only a fresh install created it, and only then may it be removed (N7).
    if (progress.dataCreated === true && journal.data.op === 'install') {
      for (const path of [layout.configDir, layout.dataDir]) {
        if (pathExists(path)) removeTree(path, [layout.dataRoot]);
      }
      actions.push('删除本事务新建的配置与数据区');
    }

    // 10. Recompute the three records so they cannot disagree.
    const consistency = reconcileAfterRollback({ layout, journal, logger });
    if (!consistency.ok) {
      journal.settle(false, consistency.reason);
      return { ok: false, reason: consistency.reason, actions, consistency };
    }

    journal.patch({ rollback: consistency })
      .enter(PHASES.ROLLED_BACK, `已回滚：${actions.join('；')}`)
      .settle(true);
    logger.warn('回滚完成', { actions, claim: consistency.claim });
    return { ok: true, actions, consistency };
  } catch (error) {
    journal.enter(PHASES.ROLLING_BACK, `回滚失败：${error.message}`);
    logger.error('回滚失败，需人工介入', error.message);
    return { ok: false, reason: error.message };
  }
}

/**
 * Make the post-rollback claims about disk true.
 *
 * The receipt (`install.json`) is only ever trusted where it can be checked against the tree:
 * if it describes a version whose files are not there, it is deleted; if the tree is there
 * but its manifest digest differs from the receipt, that is not something rollback may paper
 * over — it is a 24.
 */
export function reconcileAfterRollback({ layout, logger }) {
  const appExists = pathExists(layout.appRoot);
  const appDigest = appExists ? manifestDigestOf(layout.appRoot) : null;
  const facts = {
    appExists,
    appDigest,
    appPrevExists: pathExists(layout.appPrevRoot),
    stagingExists: layout.stagingRoot !== null && pathExists(layout.stagingRoot),
    receiptExists: pathExists(layout.installReceiptPath),
    receiptRemoved: false,
  };

  if (!appExists && facts.receiptExists) {
    // A receipt for an install that is not on disk is exactly the "each record says something
    // different" state the P0 report described: journal=ROLLED_BACK, install.json=installed,
    // filesystem=nothing. Drop the claim that cannot be true.
    removeTree(layout.installReceiptPath, [layout.installDir, layout.dataRoot]);
    facts.receiptRemoved = true;
    logger.warn('回滚后 app\\ 不存在，已删除指向空处的 install.json');
  }

  if (appExists && facts.receiptExists) {
    const receipt = readJson(layout.installReceiptPath);
    if (typeof receipt.manifestDigest === 'string' && appDigest !== null && receipt.manifestDigest !== appDigest) {
      return {
        ok: false,
        facts,
        reason: `app 清单摘要 ${appDigest.slice(0, 16)} 与 install.json ${receipt.manifestDigest.slice(0, 16)} 不一致，需人工判定`,
      };
    }
  }

  const claim = appExists
    ? `旧版 app\\ 仍在且清单与 install.json 一致（${String(appDigest).slice(0, 16)}）`
    : '本机已回到未安装状态';
  return { ok: true, facts, claim };
}

/** Rewrite the registration a failed repair had already overwritten. */
function restoreRegistration({ layout, journal, ops, logger }) {
  const version = journal.data.fromVersion ?? null;
  if (version === null) {
    logger.warn('回滚阶段无法恢复注册表：journal 没有 fromVersion');
    return;
  }
  writeArpEntries(ops, layout, version);
  ops.registrySet(REG_PRODUCT_KEY, 'InstallLocation', 'REG_SZ', layout.programRoot);
  ops.registrySet(REG_EVENT_SOURCE_KEY, 'EventMessageFile', 'REG_EXPAND_SZ', '%SystemRoot%\\System32\\EventCreate.exe');
  ops.registrySet(REG_EVENT_SOURCE_KEY, 'TypesSupported', 'REG_DWORD', 7);
}

function writeArpEntries(ops, layout, version) {
  ops.registrySet(REG_ARP_KEY, 'DisplayName', 'REG_SZ', `AIDriven NetDefense 网域智防 ${version}`);
  ops.registrySet(REG_ARP_KEY, 'DisplayVersion', 'REG_SZ', version);
  ops.registrySet(REG_ARP_KEY, 'Publisher', 'REG_SZ', 'PT-dove');
  ops.registrySet(REG_ARP_KEY, 'InstallLocation', 'REG_SZ', layout.programRoot);
  ops.registrySet(
    REG_ARP_KEY,
    'UninstallString',
    'REG_SZ',
    `"${layout.nodeExe}" "${layout.enginePath}" /uninstall /silent`,
  );
  ops.registrySet(REG_ARP_KEY, 'NoModify', 'REG_DWORD', 1);
  ops.registrySet(REG_ARP_KEY, 'NoRepair', 'REG_DWORD', 1);
}

/**
 * Feed the generated config to the daemon's own validator.
 *
 * This is the check that catches a misspelled key before a service fails to start at
 * 3 a.m. It is skipped (with a warning) when the daemon source is not in this tree,
 * e.g. when the installer is exercised against a bare fixture payload.
 */
export async function assertDaemonAcceptsConfig(modulePath, configPath, logger) {
  if (!pathExists(modulePath)) {
    logger.warn('daemon 配置校验跳过（找不到 daemon 源码）', { modulePath });
    return { ok: true, skipped: true };
  }
  try {
    const { pathToFileURL } = await import('node:url');
    const module = await import(pathToFileURL(modulePath).href);
    const config = module.loadConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    return { ok: true, dataDir: config.dataDir };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * Probe the daemon the way §5.2 describes: loopback, token from `data\secrets\api-token`,
 * an unauthenticated liveness endpoint and then the authenticated status endpoint. A
 * token that is provisioned but unusable only shows up when somebody authenticates.
 */
export async function probeHealth({ layout, timeoutMs = 10_000, logger = null, ops = null, fetchImpl = globalThis.fetch }) {
  if (ops !== null && ops.mode === 'disarm') {
    return { ok: true, simulated: true };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '当前 Node 没有 fetch，无法执行健康检查' };
  }
  let port = DEFAULT_API_PORT;
  try {
    port = readJson(layout.configPath).api?.port ?? DEFAULT_API_PORT;
  } catch (error) {
    return { ok: false, reason: `读取配置失败：${error.message}` };
  }
  const token = pathExists(layout.tokenPath) ? readFileSync(layout.tokenPath, 'utf8').trim() : null;
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt';

  while (Date.now() < deadline) {
    try {
      const liveness = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
        headers: { host: `127.0.0.1:${port}` },
        signal: AbortSignal.timeout(2000),
      });
      if (liveness.status === 200) {
        if (token === null) return { ok: false, reason: '缺少 api-token 文件' };
        const status = await fetchImpl(`http://127.0.0.1:${port}/api/v1/status`, {
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2000),
        });
        if (status.status === 200) return { ok: true, port };
        last = `status HTTP ${status.status}`;
      } else {
        last = `healthz HTTP ${liveness.status}`;
      }
    } catch (error) {
      last = error.message;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (logger !== null) logger.error('健康检查超时', { port, last });
  return { ok: false, reason: `${timeoutMs} ms 内探活失败：${last}` };
}

/** Files under `app\` the manifest claims, for `/verify`. */
export function expectedInstalledFiles(layout) {
  return listFiles(layout.appRoot, { skip: [MANIFEST_DIR] });
}

export { MANIFEST_REL_PATH, sha256File };
