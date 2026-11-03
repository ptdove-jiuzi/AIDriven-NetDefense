/**
 * License gate.
 *
 * Two tiers, both fail-closed:
 *
 * 1. `permissiveLicenses` — licenses that may appear anywhere in the locked tree
 *    without further review.
 * 2. `REVIEWED_WEAK_COPYLEFT` (scripts/license-reviewed-copyleft.mjs) — weak
 *    copyleft licenses that may appear **only on the exact packages named there**.
 *
 * Four cross-checks keep the three places that describe the same fact — the
 * reviewed list, the ADR table and `THIRD_PARTY_NOTICES` — from drifting apart:
 *
 *   a. every copyleft license identifier in the lockfile is reviewed, and every
 *      package carrying it is on the reviewed list;
 *   b. the set of locked packages per license is **equal** to the reviewed set
 *      (not merely non-empty), so dropping 5 of 6 packages fails;
 *   c. the per-license package count stated in `THIRD_PARTY_NOTICES` matches the
 *      reviewed set size, and the notices carry the obligations text;
 *   d. every package name quoted in the ADR's reviewed table exists in the
 *      reviewed list, and every reviewed package is quoted in the ADR.
 *
 * Adding a package here without updating the ADR and the notices therefore fails
 * the gate. So does removing one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LICENSING_ADR_PATH,
  REVIEWED_WEAK_COPYLEFT,
  REVIEWED_WEAK_COPYLEFT_LABELS,
} from './license-reviewed-copyleft.mjs';

const permissiveLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
]);

/**
 * Mandatory obligation phrases, per license.
 *
 * The gate previously only checked that the license *label* and the words
 * "source code ... available" existed, so deleting the whole MPL obligation
 * paragraph still passed (found in round-2 review). These phrases are the
 * obligations themselves: file-level copyleft for MPL, replaceability for LGPL.
 * Rewording the notices is fine — but it must be a deliberate edit that updates
 * this list too, not an accident that silently drops an obligation.
 */
const REQUIRED_NOTICE_PHRASES = new Map([
  [
    'MPL-2.0',
    ['file-level copyleft', 'retained, unmodified', 'source disclosed'],
  ],
  [
    'LGPL-3.0-or-later',
    ['never statically linked', 'replaceable', 'copyright notices'],
  ],
]);

/**
 * Slice the obligation block that belongs to one license.
 *
 * The notices keep component lists and obligation blocks separate: the block is
 * introduced by `<SPDX-id> obligations` and ends where the release checklist
 * starts. Checking the whole file instead would let one license's text satisfy
 * the other license's requirement.
 *
 * @param {string} text Whole `THIRD_PARTY_NOTICES`.
 * @param {string} label Human readable license label.
 * @returns {string} The obligation block, or an empty string when absent.
 */
function sectionOf(text, label) {
  const license = [...REVIEWED_WEAK_COPYLEFT_LABELS.entries()]
    .find(([, candidate]) => candidate === label)?.[0];
  if (license === undefined) return '';
  const heading = `${license} obligations`;
  const start = text.indexOf(heading);
  if (start === -1) return '';
  // 结束位置取"下一个义务段标题"与"发布检查清单"中更早的那个：
  // 若只取后者，MPL 段会把 LGPL 段一并圈进来，隔离语义就名存实亡（第三轮复核 P3-2）。
  const nextHeading = text.indexOf(' obligations (', start + heading.length);
  const checklist = text.indexOf('Release checklist', start);
  const candidates = [nextHeading, checklist].filter((index) => index !== -1);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start, end);
}

/** Package name of a lockfile location, stripping every `node_modules/` prefix. */
function packageNameOf(location) {
  const marker = 'node_modules/';
  const index = location.lastIndexOf(marker);
  return index === -1 ? location : location.slice(index + marker.length);
}

/** Split an SPDX expression into its identifiers. */
function licenseIdentifiersOf(expression, label) {
  const tokens = expression.match(/[A-Za-z0-9][A-Za-z0-9.-]*|AND|OR|WITH|\(|\)/g) ?? [];
  const identifiers = tokens.filter((token) => !['AND', 'OR', '(', ')'].includes(token));
  assert.ok(identifiers.length > 0, `${label} has an empty license expression`);
  return identifiers;
}

const rootManifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
assert.equal(rootManifest.author, 'PT-dove', 'Root author must be PT-dove');
assert.equal(rootManifest.license, 'Apache-2.0', 'Root must use Apache-2.0');
assert.equal(rootManifest.type, 'module', 'Root must be ESM-only');
assert.match(readFileSync('LICENSE', 'utf8'), /Apache License\s+Version 2\.0/);
assert.match(readFileSync('NOTICE', 'utf8'), /PT-dove/);

const thirdParty = readFileSync('THIRD_PARTY_NOTICES', 'utf8');
assert.match(thirdParty, /DeepSeek Harness 0\.2\.2-alpha\.2/);
assert.match(thirdParty, /Copyright \(c\) 2026 DeepSeek/);
assert.match(thirdParty, /MIT License/);
// 义务段必须真的写进发布物，而不是只存在于 ADR 里：两条弱 copyleft 各自需要许可证
// 全文指引与源获取方式，LGPL 还需要可替换性声明。
for (const [license, label] of REVIEWED_WEAK_COPYLEFT_LABELS) {
  assert.ok(thirdParty.includes(label), `THIRD_PARTY_NOTICES must carry the ${license} notice (${label})`);
  // 光有标签不够：义务正文被整段删掉时，只查标签会放过（第二轮复核实测）。
  // 这里按许可证取它自己的义务段，逐条要求正文短语仍在。
  const section = sectionOf(thirdParty, label);
  assert.ok(section.length > 0, `THIRD_PARTY_NOTICES must have a numbered ${license} section`);
  for (const phrase of REQUIRED_NOTICE_PHRASES.get(license) ?? []) {
    assert.ok(
      section.includes(phrase),
      `the ${license} obligation section lost the requirement "${phrase}"; deleting an obligation `
        + 'must fail the gate, not just deleting the heading',
    );
  }
}
assert.match(thirdParty, /Source code for these components is available/,
  'THIRD_PARTY_NOTICES must state how to obtain the corresponding source');
assert.match(thirdParty, /relink|replace/i,
  'THIRD_PARTY_NOTICES must state the LGPL relink/replaceability obligation');

let externalCount = 0;
let localCount = 0;
const observedLicenses = new Set();
const reviewedHits = [];
const lockedByLicense = new Map();

for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  if (entry.link) continue;
  const label = location || '<root>';
  assert.equal(typeof entry.license, 'string', `${label} has no declared license in lockfile`);
  for (const identifier of licenseIdentifiersOf(entry.license, label)) {
    if (permissiveLicenses.has(identifier)) {
      observedLicenses.add(identifier);
      continue;
    }
    const reviewed = REVIEWED_WEAK_COPYLEFT.get(identifier);
    assert.ok(
      reviewed !== undefined,
      `${label} uses license ${identifier}, which is neither permissive-allowlisted nor `
        + 'weak-copyleft-reviewed. Review the obligation, then extend ADR-0002 and '
        + 'THIRD_PARTY_NOTICES before adding it here.',
    );
    const name = packageNameOf(location);
    assert.ok(
      reviewed.has(name),
      `${label} uses reviewed weak-copyleft license ${identifier} but the package ${name} `
        + `is not in the ADR-0002 reviewed list for it. Review the added obligation first; `
        + 'a new copyleft dependency must never pass by accident.',
    );
    observedLicenses.add(identifier);
    reviewedHits.push(`${name} (${identifier})`);
    const seen = lockedByLicense.get(identifier) ?? new Set();
    seen.add(name);
    lockedByLicense.set(identifier, seen);
  }

  if (location.includes('node_modules/')) {
    externalCount += 1;
    assert.match(entry.version ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${label} is not exact`);
    assert.match(entry.resolved ?? '', /^https:\/\//, `${label} has no HTTPS resolved URL`);
    assert.match(entry.integrity ?? '', /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/, `${label} has no integrity hash`);
  } else {
    localCount += 1;
    assert.equal(entry.license, 'Apache-2.0', `${label} workspace must use Apache-2.0`);
    if (location) {
      const workspace = JSON.parse(readFileSync(`${location}/package.json`, 'utf8'));
      assert.equal(workspace.author, 'PT-dove', `${label} author must be PT-dove`);
      assert.equal(workspace.type, 'module', `${label} must be ESM-only`);
    }
  }
}

// (b) 逐许可证的**集合相等**：只校验"至少有一个"会放过"6 个里只剩 1 个"的漂移
// （独立审查用 fixture 实测过这个缺口）。
for (const [license, reviewed] of REVIEWED_WEAK_COPYLEFT) {
  const locked = lockedByLicense.get(license) ?? new Set();
  const missing = [...reviewed].filter((name) => !locked.has(name));
  const unexpected = [...locked].filter((name) => !reviewed.has(name));
  assert.equal(
    missing.length,
    0,
    `ADR-0002 lists ${license} packages that are not in package-lock.json: ${missing.join(', ')}. `
      + 'Either the feature packages were removed (then ADR-0002 and THIRD_PARTY_NOTICES must '
      + 'shrink with them) or the lockfile is stale.',
  );
  assert.equal(
    unexpected.length,
    0,
    `package-lock.json ships ${license} packages that ADR-0002 never reviewed: ${unexpected.join(', ')}.`,
  );
}

// (c) NOTICES 里写的数量必须是真数量，否则"6 packages / 14 packages"可以永久失真。
for (const [license, reviewed] of REVIEWED_WEAK_COPYLEFT) {
  const label = REVIEWED_WEAK_COPYLEFT_LABELS.get(license);
  const pattern = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+—\\s+(\\d+)\\s+packages?`, 'u');
  const match = pattern.exec(thirdParty);
  assert.ok(match !== null, `THIRD_PARTY_NOTICES must state the ${license} package count next to its label`);
  assert.equal(
    Number(match[1]),
    reviewed.size,
    `THIRD_PARTY_NOTICES claims ${match[1]} ${license} packages but the reviewed list has ${reviewed.size}`,
  );
}

// (d) ADR 表格与 reviewed 列表必须逐名对齐（两个方向都要查）。
// 只取 §3.2 里的表格行：表格下方的说明性段落允许出现 `@img/sharp-win32-*` 这类通配写法。
const adr = readFileSync(LICENSING_ADR_PATH, 'utf8');
const adrSection = adr.slice(adr.indexOf('### 3.2'), adr.indexOf('### 3.3'));
assert.ok(adrSection.length > 0, 'ADR-0002 must keep its §3.2 reviewed-package table');
const adrTable = adrSection
  .split('\n')
  .filter((line) => line.trimStart().startsWith('|'))
  .join('\n');
assert.ok(adrTable.length > 0, 'ADR-0002 §3.2 must contain a table of reviewed packages');
const adrNames = new Set([...adrTable.matchAll(/`(@[^`]+)`/gu)].map((match) => match[1]));
for (const [license, reviewed] of REVIEWED_WEAK_COPYLEFT) {
  for (const name of reviewed) {
    assert.ok(
      adrNames.has(name),
      `ADR-0002 §3.2 does not quote ${name}; the ADR and the reviewed ${license} list have drifted apart`,
    );
  }
}
for (const name of adrNames) {
  const reviewedSomewhere = [...REVIEWED_WEAK_COPYLEFT.values()].some((set) => set.has(name));
  assert.ok(reviewedSomewhere, `ADR-0002 §3.2 quotes ${name} but the reviewed list does not contain it`);
}

console.log(`License check passed: ${externalCount} external and ${localCount} local locked packages.`);
console.log(`Reviewed licenses: ${[...observedLicenses].sort().join(', ')}`);
if (reviewedHits.length > 0) {
  console.log(`Reviewed weak-copyleft components (ADR-0002): ${reviewedHits.sort().join(', ')}`);
}
