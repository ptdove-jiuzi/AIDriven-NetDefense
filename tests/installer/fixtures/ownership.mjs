/**
 * Issue the installer-built ownership credential from a fixture tree.
 *
 * RC5-N01 changed what authorizes a recursive delete: not "the directory contains files
 * that look like ours" but the credential `install()` writes into `install.json`
 * (HMAC-SHA256 over product/channel/version/canonical path/installId/payloadDigest).
 * Regression fixtures that are meant to *be* a genuine install therefore have to carry
 * one, and the only honest way to produce it is the shipped implementation itself — so
 * this helper calls `aidn.ownership.issue()` through Python instead of reimplementing the
 * message layout in JavaScript (a reimplementation would pass even if the product code
 * and the uninstaller drifted apart).
 *
 * Usage:
 *
 *     import { withOwnership } from './fixtures/ownership.mjs';
 *     createGenuineTree(target);        // record + payload + real manifest
 *     withOwnership(target);            // adds install.json.ownership for this path
 *
 * `AIDN_INSTALLER_APP` points the helper at a mutant copy for mutation runs; the
 * repository files are never modified.
 *
 * Author: PT-dove
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const INSTALLER_APP = process.env.AIDN_INSTALLER_APP
  ? resolve(process.env.AIDN_INSTALLER_APP)
  : join(REPO_ROOT, 'deploy', 'windows', 'installer', 'app');

const PYTHON_CANDIDATES = [process.env.AIDN_PYTHON, 'D:\\Python311\\python.exe', 'python'].filter(
  (value) => typeof value === 'string' && value.length > 0,
);

export function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ['-c', 'import sys; sys.stdout.write("ok")'], {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (probe.status === 0 && (probe.stdout ?? '').includes('ok')) return candidate;
  }
  return undefined;
}

const PYTHON = pickPython();

const ISSUE_PROGRAM = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from aidn import ownership
install_id = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else None
block = ownership.issue(sys.argv[2], channel=sys.argv[3], version=sys.argv[4], install_id=install_id)
sys.stdout.write(json.dumps(block))
`;

/** The `install.json.ownership` block the shipped installer would write for *target*. */
export function issueOwnership(target, { channel = 'installed', version = '0.0.1-rc.3', installId } = {}) {
  if (PYTHON === undefined) throw new Error('no Python interpreter found to issue the credential');
  const argv = ['-c', ISSUE_PROGRAM, INSTALLER_APP, target, String(channel), String(version)];
  if (installId) argv.push(String(installId));
  const result = spawnSync(PYTHON, argv, {
    encoding: 'utf8',
    timeout: 180_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`issuing the ownership credential failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(String(result.stdout ?? '').trim());
}

/** Add the credential to an existing fixture record, keeping its channel/version. */
export function withOwnership(target, options = {}) {
  const recordPath = join(target, 'install', 'install.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8').replace(/^\uFEFF/u, ''));
  const block = issueOwnership(target, {
    channel: options.channel ?? String(record.channel ?? 'installed'),
    version: options.version ?? String(record.version ?? '0.0.1-rc.3'),
    installId: options.installId,
  });
  record.ownership = block;
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { record, block };
}
