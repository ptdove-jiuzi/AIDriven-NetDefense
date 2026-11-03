/**
 * License gate behaviour tests.
 *
 * `scripts/check-licenses.mjs` is the only thing standing between a licensing
 * policy decision and a published release, so its two-tier behaviour is tested
 * rather than assumed:
 *
 * - the reviewed weak-copyleft packages pass;
 * - a *new* MPL-2.0 / LGPL-3.0-or-later package fails, even though the license
 *   identifier itself is known (ADR-0002 option A names exact packages);
 * - an unreviewed copyleft license fails;
 * - dropping some (not all) of the packages of a reviewed license fails, which is
 *   what "the reviewed list is the shipped list" actually means;
 * - deleting the obligation text, or lying about the package count, fails;
 * - a package name that appears in the ADR table but not in the reviewed list (or
 *   the other way round) fails.
 *
 * Every case runs inside a temporary sandbox: the real repository, the real user
 * directories and the real node_modules are never touched.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createTestSandbox } from '@aegisharness/test-support';
import { REVIEWED_WEAK_COPYLEFT } from '../../scripts/license-reviewed-copyleft.mjs';

const SCRIPT_SOURCE = readFileSync('scripts/check-licenses.mjs', 'utf8');
const REVIEWED_SOURCE = readFileSync('scripts/license-reviewed-copyleft.mjs', 'utf8');
const NOTICES_SOURCE = readFileSync('THIRD_PARTY_NOTICES', 'utf8');
const ADR_RELATIVE = 'docs/implementation/adr/ADR-0002-third-party-license-policy.md';
const ADR_SOURCE = readFileSync(ADR_RELATIVE, 'utf8');

const MIT_ENTRY = {
  version: '1.0.0',
  license: 'MIT',
  resolved: 'https://registry.npmjs.org/fixture-mit/-/fixture-mit-1.0.0.tgz',
  integrity: 'sha512-AAAA',
};

/** One lockfile entry per reviewed package, built from the reviewed list itself. */
function reviewedLockfileEntries() {
  const entries = {};
  for (const [license, names] of REVIEWED_WEAK_COPYLEFT) {
    for (const name of names) {
      entries[`node_modules/${name}`] = {
        version: '1.0.0',
        license,
        resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-1.0.0.tgz`,
        integrity: 'sha512-BBBB',
      };
    }
  }
  return entries;
}

/** How many reviewed packages exist in total, used for the sandbox log assertions. */
const REVIEWED_TOTAL = [...REVIEWED_WEAK_COPYLEFT.values()].reduce((sum, set) => sum + set.size, 0);

/** Build a lockfile carrying the reviewed baseline plus any extra entries. */
function lockfileWith(extraEntries = {}, { dropPackage = null } = {}) {
  const packages = {
    '': { name: 'fixture', version: '0.0.0', license: 'Apache-2.0' },
    'node_modules/fixture-mit': MIT_ENTRY,
    ...reviewedLockfileEntries(),
  };
  if (dropPackage !== null) {
    delete packages[`node_modules/${dropPackage}`];
  }
  return { name: 'fixture', lockfileVersion: 3, packages: { ...packages, ...extraEntries } };
}

/**
 * Materialise a minimal repository that the gate can read, inside a sandbox.
 *
 * @param {{ lockfile?: object, notices?: string, adr?: string }} [options] Overrides for the negative cases.
 * @returns {{ root: string, cleanup: () => void }} Sandbox root and cleanup handle.
 */
function createGateFixture(options = {}) {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-license-' });
  const root = sandbox.workRoot;

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs/implementation/adr'), { recursive: true });

  writeFileSync(join(root, 'scripts/check-licenses.mjs'), SCRIPT_SOURCE);
  writeFileSync(join(root, 'scripts/license-reviewed-copyleft.mjs'), REVIEWED_SOURCE);
  writeFileSync(join(root, ADR_RELATIVE), options.adr ?? ADR_SOURCE);
  writeFileSync(join(root, 'THIRD_PARTY_NOTICES'), options.notices ?? NOTICES_SOURCE);
  writeFileSync(join(root, 'NOTICE'), 'AegisHarness\nCopyright 2026 PT-dove\n');
  writeFileSync(join(root, 'LICENSE'), 'Apache License\nVersion 2.0, January 2004\n');
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      { name: 'fixture', version: '0.0.0', private: true, type: 'module', license: 'Apache-2.0', author: 'PT-dove' },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify(options.lockfile ?? lockfileWith(), null, 2)}\n`,
  );

  return { root, cleanup: sandbox.cleanup };
}

/**
 * Run the gate inside a fixture and return its outcome instead of throwing.
 *
 * @param {string} root Fixture root used as the working directory.
 * @returns {{ status: number, stdout: string, stderr: string }} Process outcome.
 */
function runGate(root) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts/check-licenses.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? -1,
      stdout: error.stdout ?? '',
      stderr: `${error.stderr ?? ''}${error.message ?? ''}`,
    };
  }
}

test('license gate accepts the reviewed weak-copyleft packages and reports them', () => {
  const fixture = createGateFixture();
  try {
    const result = runGate(fixture.root);
    assert.equal(result.status, 0, `expected EXIT=0, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`License check passed: ${REVIEWED_TOTAL + 1} external and 1 local locked packages\\.`, 'u'));
    assert.match(result.stdout, /Reviewed weak-copyleft components/);
    assert.match(result.stdout, /@deepseek-ai\/libreoffice-kit \(MPL-2\.0\)/);
    assert.match(result.stdout, /@img\/sharp-libvips-linux-x64 \(LGPL-3\.0-or-later\)/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects a new MPL-2.0 package that ADR-0002 never reviewed', () => {
  const fixture = createGateFixture({
    lockfile: lockfileWith({
      'node_modules/unreviewed-office-kit': {
        version: '9.9.9',
        license: 'MPL-2.0',
        resolved: 'https://registry.npmjs.org/unreviewed-office-kit/-/unreviewed-office-kit-9.9.9.tgz',
        integrity: 'sha512-DDDD',
      },
    }),
  });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'a new MPL-2.0 dependency must not pass the gate');
    assert.match(result.stderr, /unreviewed-office-kit uses reviewed weak-copyleft license MPL-2\.0/);
    assert.match(result.stderr, /is not in the ADR-0002 reviewed list/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects a copyleft license that was never reviewed at all', () => {
  const fixture = createGateFixture({
    lockfile: lockfileWith({
      'node_modules/copyleft-thing': {
        version: '1.0.0',
        license: 'GPL-3.0-only',
        resolved: 'https://registry.npmjs.org/copyleft-thing/-/copyleft-thing-1.0.0.tgz',
        integrity: 'sha512-EEEE',
      },
    }),
  });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'an unreviewed GPL dependency must not pass the gate');
    assert.match(result.stderr, /GPL-3\.0-only, which is neither permissive-allowlisted nor/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects a lockfile that ships fewer packages than the ADR reviewed', () => {
  // 只想验"集合相等"：少一个就必须红。旧实现只断言"至少存在一个"，这种漂移会被放过。
  const fixture = createGateFixture({
    lockfile: lockfileWith({}, { dropPackage: '@img/sharp-win32-ia32' }),
  });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'dropping a single reviewed package must fail the gate');
    assert.match(result.stderr, /@img\/sharp-win32-ia32/);
    assert.match(result.stderr, /are not in package-lock\.json/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects notices without the MPL/LGPL obligations', () => {
  // 只保留 MIT 段：许可证结论还在，但随附义务被删掉了，这正是必须失败的情形。
  const truncated = NOTICES_SOURCE.slice(0, NOTICES_SOURCE.indexOf('Weak-copyleft components'));
  const fixture = createGateFixture({ notices: truncated });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'missing copyleft obligations must fail the gate');
    assert.match(result.stderr, /THIRD_PARTY_NOTICES must carry the MPL-2\.0 notice/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects notices whose MPL obligation body was deleted', () => {
  // 只删义务正文、保留标题与组件清单：第二轮复核实测旧实现会放行（它只查标签）。
  const start = NOTICES_SOURCE.indexOf('MPL-2.0 obligations');
  const end = NOTICES_SOURCE.indexOf('LGPL-3.0-or-later obligations');
  assert.ok(start > 0 && end > start, 'the fixture needs both obligation blocks');
  const gutted = `${NOTICES_SOURCE.slice(0, start)}MPL-2.0 obligations:\n\n${NOTICES_SOURCE.slice(end)}`;
  const fixture = createGateFixture({ notices: gutted });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'deleting an obligation body must fail the gate');
    assert.match(result.stderr, /the MPL-2\.0 obligation section lost the requirement/u);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects a notices count that disagrees with the reviewed list', () => {
  // 把 "6 packages" 改成 "5 packages"：义务段还在，但数量撒谎。
  const lying = NOTICES_SOURCE.replace(
    'GNU Lesser General Public License, version 3.0 or later — 14 packages',
    'GNU Lesser General Public License, version 3.0 or later — 13 packages',
  );
  assert.notEqual(lying, NOTICES_SOURCE, 'the fixture must actually change the notices text');
  const fixture = createGateFixture({ notices: lying });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'a false package count must fail the gate');
    assert.match(result.stderr, /claims 13 LGPL-3\.0-or-later packages but the reviewed list has 14/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects an ADR table that drifted from the reviewed list', () => {
  // 把 ADR 表格里的一个包名改错：ADR 说 A，代码审的是 B。
  const drifted = ADR_SOURCE.replace('`@img/sharp-win32-ia32`', '`@img/sharp-win32-mips`');
  assert.notEqual(drifted, ADR_SOURCE, 'the fixture must actually change the ADR text');
  const fixture = createGateFixture({ adr: drifted });
  try {
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'a drifted ADR table must fail the gate');
    assert.match(result.stderr, /ADR-0002 §3\.2 does not quote @img\/sharp-win32-ia32|quotes @img\/sharp-win32-mips/);
  } finally {
    fixture.cleanup();
  }
});

test('license gate rejects a workspace that drops the PT-dove Apache-2.0 contract', () => {
  const lockfile = lockfileWith({
    'packages/fixture-workspace': { version: '0.0.0', license: 'MIT' },
  });
  const fixture = createGateFixture({ lockfile });
  try {
    mkdirSync(join(fixture.root, 'packages/fixture-workspace'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'packages/fixture-workspace/package.json'),
      `${JSON.stringify({ name: 'fixture-workspace', type: 'module', author: 'PT-dove' }, null, 2)}\n`,
    );
    const result = runGate(fixture.root);
    assert.notEqual(result.status, 0, 'a non-Apache workspace must fail the gate');
    assert.match(result.stderr, /workspace must use Apache-2\.0/);
  } finally {
    fixture.cleanup();
  }
});

test('the shipped repository itself passes the gate it ships', () => {
  const result = runGate(process.cwd());
  assert.equal(result.status, 0, `repository license gate failed: ${result.stderr}`);
  assert.match(result.stdout, /Reviewed weak-copyleft components \(ADR-0002\): /);
});
