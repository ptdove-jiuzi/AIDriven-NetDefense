/**
 * Reviewed weak-copyleft components — the single source of truth for the
 * second tier of the license gate.
 *
 * These are the exact packages reviewed in
 * `docs/implementation/adr/ADR-0002-third-party-license-policy.md` (option A).
 * They arrive as transitive dependencies of the DeepSeek Harness launcher tree
 * and are shipped unmodified, with the obligations recorded in
 * `THIRD_PARTY_NOTICES`.
 *
 * Deliberately *not* part of the permissive allowlist: a new dependency that
 * happens to be MPL-2.0 or LGPL-3.0-or-later must fail the gate until a human
 * reviews the added obligation and extends this file, the ADR table and the
 * notices together. `scripts/check-licenses.mjs` cross-checks all three so they
 * cannot drift apart silently.
 *
 * This file is data only — it must stay importable without side effects so
 * tests can build fixtures from it.
 */

/** @type {ReadonlyMap<string, ReadonlySet<string>>} License identifier → reviewed package names. */
export const REVIEWED_WEAK_COPYLEFT = new Map([
  [
    'MPL-2.0',
    new Set([
      '@deepseek-ai/libreoffice-kit',
      '@deepseek-ai/libreoffice-kit-darwin-arm64',
      '@deepseek-ai/libreoffice-kit-darwin-x64',
      '@deepseek-ai/libreoffice-kit-wasm',
      '@deepseek-ai/libreoffice-kit-win32-arm64',
      '@deepseek-ai/libreoffice-kit-win32-x64',
    ]),
  ],
  [
    'LGPL-3.0-or-later',
    new Set([
      '@img/sharp-libvips-darwin-arm64',
      '@img/sharp-libvips-darwin-x64',
      '@img/sharp-libvips-linux-arm',
      '@img/sharp-libvips-linux-arm64',
      '@img/sharp-libvips-linux-ppc64',
      '@img/sharp-libvips-linux-riscv64',
      '@img/sharp-libvips-linux-s390x',
      '@img/sharp-libvips-linux-x64',
      '@img/sharp-libvips-linuxmusl-arm64',
      '@img/sharp-libvips-linuxmusl-x64',
      '@img/sharp-wasm32',
      '@img/sharp-win32-arm64',
      '@img/sharp-win32-ia32',
      '@img/sharp-win32-x64',
    ]),
  ],
]);

/** Human readable names used inside `THIRD_PARTY_NOTICES`. */
export const REVIEWED_WEAK_COPYLEFT_LABELS = new Map([
  ['MPL-2.0', 'Mozilla Public License 2.0'],
  ['LGPL-3.0-or-later', 'GNU Lesser General Public License, version 3.0 or later'],
]);

/** Path of the ADR that authorises this list. */
export const LICENSING_ADR_PATH = 'docs/implementation/adr/ADR-0002-third-party-license-policy.md';
