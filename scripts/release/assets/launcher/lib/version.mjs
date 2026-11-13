// AIDriven NetDefense — release identity constants (author PT-dove).
//
// Two numbers that must never be confused:
//
//   PRODUCT_VERSION  the repository version. It stays `0.0.0` until the full
//                    release gate passes; this package does not change it.
//   RELEASE_LABEL    the *packaging label* used in the artifact file name only
//                    (`AIDriven-NetDefense-<label>-win-x64-portable.zip`).
//
// The label is a pre-release marker. It says "this is the rc.N archive of an
// unfrozen tree", not "version 0.0.1 has been released". Nothing in this package
// may be read as a version freeze: see README-快速开始.txt §6.
//
// SEED-05: single version source. The label is read from
// `deploy/windows/installer/VERSION` — the same file Setup.ps1, build-dist.cmd and
// scripts/desktop/build-desktop.mjs use. Inside a shipped portable zip that repo-only
// file is absent, so the reviewed fallback below is what the launcher reports; it must
// stay equal to VERSION (asserted by tests/installer/version-consistency.test.js).

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION_FILE = resolve(HERE, '..', '..', '..', '..', '..', 'deploy', 'windows', 'installer', 'VERSION');
const RELEASE_LABEL_FALLBACK = '0.0.1-rc.6';

function readReleaseLabel() {
  try {
    const value = readFileSync(VERSION_FILE, 'utf8').trim();
    if (/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/u.test(value)) return value;
  } catch {
    // Shipped launcher: the repo-only version file is not part of the portable zip.
  }
  return RELEASE_LABEL_FALLBACK;
}

export const PRODUCT_VERSION = '0.0.0';
export const RELEASE_LABEL = readReleaseLabel();
export const PACKAGE_KIND = 'portable-preview';
export const VERSION_FROZEN = false;
export const AUTHOR = 'PT-dove';
