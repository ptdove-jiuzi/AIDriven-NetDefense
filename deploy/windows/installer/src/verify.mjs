/**
 * verify.mjs — `/verify`, the read-only check.
 *
 * It must not write a single byte: no journal, no log inside the install tree, no
 * "repair" of a missing file. That constraint is what makes it safe to run from an
 * auditor's session, from a support call, or right before deciding to uninstall.
 *
 * What it actually proves, and what it does not:
 *
 * - **proves** every file under `app\` matches `app\manifests\files.sha256`, that the
 *   manifest bytes equal the digest recorded at install time, and that no unlisted
 *   file was added;
 * - **does not prove** that the manifest itself is authentic — that needs
 *   `files.sha256.sig` and a trust anchor (code 13 territory, P4 in ADR §10.2). The
 *   report says so instead of implying a signature check happened.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT } from './exit-codes.mjs';
import { pathExists, readJson } from './fsx.mjs';
import { loadJournal, TERMINAL_PHASES } from './journal.mjs';
import { describeFailure, parseManifest, verifyTree } from './manifest.mjs';

const MANIFEST_DIR = 'manifests';

/**
 * @param {{ layout: object, logger: object }} ctx
 * @returns {Promise<{code: number, message: string, report: object|null}>}
 */
export async function runVerify({ layout, logger }) {
  if (!pathExists(layout.appRoot)) {
    return { code: EXIT.PRECHECK, message: `未安装：${layout.appRoot} 不存在`, report: null };
  }
  const manifestPath = join(layout.appRoot, MANIFEST_DIR, 'files.sha256');
  if (!pathExists(manifestPath)) {
    return { code: EXIT.MANIFEST, message: `载荷缺少 ${manifestPath}`, report: null };
  }

  let manifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { code: EXIT.MANIFEST, message: `files.sha256 解析失败：${error.message}`, report: null };
  }

  const result = await verifyTree({ root: layout.appRoot, rows: manifest.rows });
  const receipt = pathExists(layout.installReceiptPath) ? readJson(layout.installReceiptPath) : null;
  const digest = createHash('sha256').update(manifest.text).digest('hex');

  const report = {
    version: receipt?.version ?? null,
    fileCount: manifest.rows.length,
    checked: result.checked,
    manifestDigest: digest,
    receiptManifestDigest: receipt?.manifestDigest ?? null,
    missing: result.missing.length,
    mismatched: result.mismatched.length,
    extras: result.extras.length,
    journalPhase: loadJournal(layout.journalPath).state === 'ok'
      ? loadJournal(layout.journalPath).journal.phase
      : null,
    pendingProgramRemoval: pathExists(layout.pendingRemovalPath),
    signatureChecked: false,
  };

  if (!result.ok) {
    logger.error('校验失败', report);
    return { code: EXIT.MANIFEST, message: `校验失败：${describeFailure(result)}`, report };
  }
  if (report.receiptManifestDigest !== null && report.receiptManifestDigest !== digest) {
    logger.error('清单摘要与安装记录不一致', report);
    return {
      code: EXIT.MANIFEST,
      message: `app\\manifests\\files.sha256 摘要 ${digest} 与安装记录 ${report.receiptManifestDigest} 不同（清单被改写）`,
      report,
    };
  }
  if (report.journalPhase !== null && !TERMINAL_PHASES.has(report.journalPhase)) {
    logger.warn('存在非终止态 journal', { phase: report.journalPhase });
  }

  logger.info('校验通过', report);
  return { code: EXIT.OK, message: `校验通过：${result.checked} 条哈希一致（未做签名校验）`, report };
}
