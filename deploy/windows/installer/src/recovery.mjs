/**
 * recovery.mjs — converge an interrupted install transaction (§6.2 recovery table, H1).
 *
 * The one rule from journal.mjs that this module depends on: after a crash the journal can
 * only be *behind* the disk, never ahead of it. So the decision is made from **disk facts +
 * journal intent**, and never from the journal alone:
 *
 *   which tree is `app\`  ← the byte digest of `app\manifests\files.sha256` (§5.1's only
 *                           authoritative list), compared with the journal's
 *                           `fromManifestDigest` / `toManifestDigest`.
 *
 * Convergence targets, in the order §6.2 states them:
 *
 * - caught before the swap (`STAGED`)  → drop staging, keep the old tree, exit **26**;
 * - caught inside `SWAP_A` / `SWAP_B`  → restore `app` from `app.prev`, exit **26**;
 * - caught in `ROLLING_BACK`           → re-run the rollback (it is idempotent), exit **26**;
 * - **combination 4** (both trees present, staging present) → **manual**, nothing is touched,
 *   exit **25**. §6.2 forbids auto-resolving it, and N2 does not apply because the disk
 *   facts do not uniquely determine which tree is trustworthy.
 *
 * What this module deliberately does **not** do: finish an install forward (service
 * registration, receipts, DB migration). A half-finished tree with no receipt is not an
 * install, and §6.2 gives no convergence target for it — so it rolls back instead.
 *
 * It also does not implement the rollback itself. Convergence is delegated to the caller's
 * `rollback` (i.e. `rollbackInstall`), because that is the only implementation that knows
 * which side effects this transaction performed and how `install.json` must be reconciled.
 * A second, "recovery-flavoured" undo here is how H3 came back once already.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT } from './exit-codes.mjs';
import { pathExists } from './fsx.mjs';
import { MANIFEST_REL_PATH, PHASES, TERMINAL_PHASES } from './journal.mjs';

/** Phases whose interrupted state §6.2 gives a convergent action for. */
export const RECOVERABLE_PHASES = Object.freeze(new Set([
  PHASES.IDLE,
  PHASES.STAGED,
  PHASES.SWAP_A,
  PHASES.SWAP_B,
  PHASES.ROLLING_BACK,
]));

/** Phases belonging to the uninstall transaction; `/uninstall` resumes those itself. */
export const UNINSTALL_PHASES = Object.freeze(new Set([
  PHASES.UNINSTALLING,
  PHASES.UNINSTALLED,
  PHASES.PURGING,
]));

const MANIFEST_DIR = 'manifests';

/**
 * Byte digest of a tree's authoritative manifest, or `null` when it cannot be read.
 *
 * `null` is load-bearing: it means "this tree cannot be identified", which is exactly the
 * condition under which §6.2 forbids an automatic decision.
 */
export function manifestDigestOf(root) {
  if (root === null || root === undefined) return null;
  const path = join(root, MANIFEST_DIR, 'files.sha256');
  if (!pathExists(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** The three disk facts every branch of §6.2 is written in terms of. */
export function diskFacts(layout) {
  return {
    app: pathExists(layout.appRoot),
    appPrev: pathExists(layout.appPrevRoot),
    staging: layout.stagingRoot !== null && pathExists(layout.stagingRoot),
    appDigest: manifestDigestOf(layout.appRoot),
    appPrevDigest: manifestDigestOf(layout.appPrevRoot),
  };
}

function sameDigest(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

/**
 * Decide, and then perform, the §6.2 convergence for one interrupted transaction.
 *
 * @param {{ layout: object, journal: object, logger: object, ops: object }} ctx
 * @returns {Promise<{outcome: 'skip'|'none'|'converged'|'manual'|'failed', code: number,
 *   message: string, facts?: object, action?: string}>}
 */
export async function recoverTransaction({ layout, journal, logger, ops, rollback }) {
  const phase = journal.phase;
  if (TERMINAL_PHASES.has(phase)) {
    return { outcome: 'none', code: EXIT.OK, message: '无进行中事务' };
  }
  if (UNINSTALL_PHASES.has(phase)) {
    // `/uninstall` and `/purge` resume these themselves; an install must not touch them.
    return { outcome: 'skip', code: EXIT.BUSY, message: `phase=${phase} 属卸载事务，由 /uninstall 续跑` };
  }
  if (!RECOVERABLE_PHASES.has(phase)) {
    return {
      outcome: 'manual',
      code: EXIT.BUSY,
      message: `phase=${phase} 没有实现自动恢复（本切片仅覆盖 STAGED/SWAP_A/SWAP_B/ROLLING_BACK）；`
        + `请保留 ${layout.journalPath} 与 ${layout.programRoot} 现场并人工判定`,
    };
  }

  const facts = diskFacts(layout);
  const plan = classify({ layout, journal, facts });

  if (plan.kind === 'manual') {
    // §6.2 combination 4 / unidentified tree: print, do not touch.
    return {
      outcome: 'manual',
      code: EXIT.ROLLBACK_REFUSED,
      message: `${plan.reason}；已停止，未做任何改动（journal: ${layout.journalPath}）`,
      facts,
      action: 'diagnose-only',
    };
  }

  // Converge through the **same** rollback the in-process failure path uses.
  //
  // This is not a style choice. `rollbackInstall` is idempotent, op-aware (a fresh install
  // removes what it created; a repair leaves the restored install's service, group
  // membership, shortcut, `bin\` and data area alone), revokes every side effect the journal
  // recorded, and reconciles `install.json` with the tree on disk. Recovery used to do its
  // own reduced version — delete the tree, delete the service — which brought H3 straight
  // back on the new path: a crash in the window between writing the receipts and flushing
  // `COMMITTED` left `install.json` saying "installed" while `/verify` said "not installed",
  // plus a `bin\aegis-svc.exe` and a data area nothing described. One journal, one answer.
  if (typeof rollback !== 'function') {
    return {
      outcome: 'failed',
      code: EXIT.ROLLBACK_FAILED,
      message: `phase=${phase} 需要收敛，但调用方未注入回滚实现（内部错误）`,
      facts,
      action: plan.kind,
    };
  }

  const rolled = await rollback({ layout, journal, logger, ops });
  if (!rolled.ok) {
    journal.patch({
      recovery: { at: new Date().toISOString(), action: plan.kind, viaRollback: true, error: rolled.reason ?? 'unknown' },
    }).persist();
    logger.error('中断恢复失败，需人工介入', rolled.reason ?? 'unknown');
    return {
      outcome: 'failed',
      code: EXIT.ROLLBACK_FAILED,
      message: `中断恢复失败（phase=${phase}）：${rolled.reason ?? 'unknown'}`,
      facts,
      action: plan.kind,
    };
  }

  const after = diskFacts(layout);
  journal.patch({
    recovery: {
      at: new Date().toISOString(),
      action: plan.kind,
      viaRollback: true,
      actions: rolled.actions ?? [],
      restoredFrom: plan.restore === true ? 'app.prev' : null,
      factsBefore: facts,
      factsAfter: after,
    },
  }).persist();

  logger.warn('中断恢复完成', { phase, action: plan.kind, summary: plan.summary });
  return {
    outcome: 'converged',
    code: EXIT.ROLLED_BACK,
    message: `中断恢复已完成（phase=${phase} → ROLLED_BACK）：${plan.summary}`,
    facts: after,
    action: plan.kind,
  };
}

/**
 * Classify the crash scene into exactly one §6.2 action. Pure: no disk writes, so the
 * decision can be asserted in a test without performing it.
 */
export function classify({ journal, facts }) {
  const phase = journal.phase;
  const to = journal.data.toManifestDigest ?? null;
  const from = journal.data.fromManifestDigest ?? null;

  const dropStaging = { kind: 'drop-staging', restore: false, expectApp: false, summary: '删除未完成的 staging，保留 app 原样' };
  const restore = { kind: 'restore-appprev', restore: true, expectApp: true, summary: '把 app.prev 还原为 app' };

  if (phase === PHASES.IDLE || phase === PHASES.STAGED) {
    if (!facts.app && facts.appPrev) {
      // Not reachable from STAGED in this implementation (no rename happens before SWAP_A),
      // but the table is applied to disk facts, not to assumptions about our own code.
      return restore;
    }
    return dropStaging;
  }

  if (phase === PHASES.SWAP_A) {
    if (facts.app && facts.appPrev && facts.staging) {
      // §6.2 combination 4 — the one branch that must never be auto-resolved.
      return {
        kind: 'manual',
        reason: `app 与 app.prev 同时存在且 staging 仍在（§6.2 组合 4）：`
          + `app=${short(facts.appDigest)} app.prev=${short(facts.appPrevDigest)} to=${short(to)} from=${short(from)}`,
      };
    }
    if (facts.app && facts.appPrev) {
      // combination 3: the swap completed; decide by digest, never by directory name.
      if (sameDigest(facts.appDigest, from)) {
        // `app` is already the old tree; `app.prev` is a duplicate of it (or unidentifiable).
        if (sameDigest(facts.appPrevDigest, from)) {
          return { kind: 'drop-appprev', restore: false, expectApp: true, summary: 'app 已是旧版，删除重复的 app.prev' };
        }
        return { kind: 'manual', reason: 'app 是旧版但 app.prev 摘要无法识别，拒绝删除' };
      }
      if (sameDigest(facts.appDigest, to) && sameDigest(facts.appPrevDigest, from)) {
        return { ...restore, summary: '未提交的新版 app 回退为 app.prev' };
      }
      return { kind: 'manual', reason: `app 摘要既非 from 也非 to，无法判定（app=${short(facts.appDigest)}）` };
    }
    if (!facts.app && facts.appPrev) {
      // combination 2: the rename happened, SWAP_B did not.
      return restore;
    }
    return dropStaging; // combination 1: nothing was renamed yet.
  }

  if (phase === PHASES.SWAP_B) {
    if (facts.appPrev) {
      // ADR: "若 staging 也缺失 ⇒ 回滚（用 app.prev），回滚成功后 26". We always take the
      // rollback branch: finishing forward would need the service, health check and receipts,
      // which are not recovery's job, and a tree without a receipt is not an install.
      if (facts.app && !sameDigest(facts.appDigest, to)) {
        return { kind: 'manual', reason: `SWAP_B 现场 app 已存在且摘要不等于待装清单（${short(facts.appDigest)}）` };
      }
      return { ...restore, summary: 'SWAP_B 中断：用 app.prev 回滚到旧版' };
    }
    if (facts.app && sameDigest(facts.appDigest, to)) {
      // The rename landed but the settle did not. For a fresh install there is nothing to
      // restore, so the uncommitted tree is removed — it has no receipt and no service.
      return { kind: 'discard-uncommitted', restore: false, expectApp: false, summary: '删除未提交且无 app.prev 可还原的新树' };
    }
    return { kind: 'manual', reason: 'SWAP_B 现场既无 app.prev 也无法识别 app' };
  }

  // ROLLING_BACK: the rollback is idempotent by construction, so re-run it — but only over
  // trees it can identify. `app.prev` next to an `app\` whose manifest is neither the old nor
  // the new digest is the same "facts do not decide it" situation as §6.2 combination 4:
  // `restore` starts by deleting `app\`, and that tree may be the only trustworthy copy.
  if (facts.appPrev) {
    if (!facts.app) return { ...restore, summary: '续跑未完成的回滚' };
    if (sameDigest(facts.appDigest, from)) {
      return { kind: 'drop-appprev', restore: false, expectApp: true, summary: '回滚已完成，删除重复的 app.prev' };
    }
    return {
      kind: 'manual',
      reason: `ROLLING_BACK 现场 app 与 app.prev 并存，且 app 的清单既非旧版也非待装版（app=${short(facts.appDigest)}）`,
    };
  }
  if (facts.staging) return dropStaging;
  return { kind: 'drop-appprev-noop', restore: false, expectApp: facts.app, summary: '回滚已完成，清理遗留' };
}

function short(digest) {
  return typeof digest === 'string' ? digest.slice(0, 16) : String(digest);
}

export { MANIFEST_REL_PATH };
