/**
 * Test fixtures for the installer suite.
 *
 * A "payload" here is a bundle-shaped directory with a real `manifests/files.sha256`
 * produced by the same writer the release pipeline uses
 * (`deploy/embedded-runtime/lib/stage.mjs`), because a hand-written manifest would test
 * the verifier against a format that only the test knows about.
 *
 * Every fixture lives under `os.tmpdir()`, so a test cannot create a service, write
 * `%ProgramData%`, or touch `%ProgramFiles%` even if a `--root` guard regresses.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sha256File, writeHashManifest } from '../../../deploy/embedded-runtime/lib/stage.mjs';
import { createLogger } from '../../../deploy/windows/installer/src/log.mjs';
import { createOps } from '../../../deploy/windows/installer/src/ops.mjs';
import { buildLayout } from '../../../deploy/windows/installer/src/paths.mjs';

/** A temp directory that is removed when the test ends. */
export function tempRoot(t, prefix = 'aidnd-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function writeFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * Create a bundle-shaped payload.
 *
 * @param {string} root Directory to create (must be empty or absent).
 * @param {{ version?: string, trust?: object|null, extraFiles?: Record<string,string>,
 *           rulePack?: boolean, tamper?: {path: string, contents: string}|null }} [options]
 * @returns {{root: string, manifestPath: string, digest: string, fileCount: number}}
 */
export function createPayload(root, options = {}) {
  const { version = '0.0.1', trust = null, extraFiles = {}, rulePack = true, tamper = null } = options;

  const files = {
    'apps/daemon/bin.js': '#!/usr/bin/env node\n// fixture daemon entry\nprocess.exit(0);\n',
    'apps/daemon/package.json': `${JSON.stringify({ name: '@aegisharness/daemon', private: true, version: '0.0.0' }, null, 2)}\n`,
    'apps/service-host/bin.js': '#!/usr/bin/env node\n// fixture service host entry\nprocess.exit(0);\n',
    'launch/launch-plan.json': `${JSON.stringify({ note: 'fixture launch plan', root: '.' }, null, 2)}\n`,
    'runtime/node/node.exe': 'fixture node placeholder\n',
    'bin/aegis-svc.exe': 'fixture service host placeholder\n',
    ...(rulePack ? { 'rules/pack.json': `${JSON.stringify({ schemaVersion: '1.0', rules: [] }, null, 2)}\n` } : {}),
    ...extraFiles,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(join(root, relativePath), contents);
  }

  const manifestsDir = join(root, 'manifests');
  mkdirSync(manifestsDir, { recursive: true });
  if (trust !== null) {
    writeFile(join(manifestsDir, 'trust.json'), `${JSON.stringify(trust, null, 2)}\n`);
  }
  const { count } = writeHashManifest({ bundleRoot: root, manifestsDir });

  if (tamper !== null) {
    // Applied *after* the manifest is written, which is exactly the situation the hash
    // gate exists to catch.
    writeFile(join(root, tamper.path), tamper.contents);
  }

  const manifestPath = join(manifestsDir, 'files.sha256');
  return { root, manifestPath, digest: sha256File(manifestPath), fileCount: count };
}

/** A quiet logger: tests assert on results, not on log text. */
export function quietLogger() {
  return createLogger({ echo: false });
}

/**
 * The disarm context used by most tests.
 *
 * @param {string} root Temp root that holds a fake ProgramFiles/ProgramData pair.
 * @param {{ version?: string }} [options]
 */
export function disarmContext(root, { version = '0.0.1' } = {}) {
  const layout = buildLayout({ mode: 'disarm', root, version });
  const logger = quietLogger();
  const ops = createOps({ mode: 'disarm', layout, logger });
  return { layout, logger, ops };
}

/** Read the recorded plan lines (disarm ops backend). */
export function readPlan(layout) {
  if (!existsSync(layout.planPath)) return [];
  return readFileSync(layout.planPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export { sha256File };
