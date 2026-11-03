import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const sbom = JSON.parse(readFileSync('sbom.cdx.json', 'utf8'));
assert.equal(sbom.bomFormat, 'CycloneDX');
assert.equal(sbom.specVersion, '1.6');
assert.equal(sbom.version, 1);
assert.equal(lock.lockfileVersion, 3);
assert.equal(sbom.metadata?.properties?.some(
  (property) => property.name === 'cdx:reproducible' && property.value === 'true',
), true, 'SBOM must be generated in reproducible mode');

function fullName(component) {
  return component.group ? `${component.group}/${component.name}` : component.name;
}

function packagePath(component) {
  return component.properties?.find((property) => property.name === 'cdx:npm:package:path')?.value;
}

const componentsByPath = new Map();
for (const component of sbom.components ?? []) {
  const location = packagePath(component);
  assert.equal(typeof location, 'string', `${fullName(component)}: missing npm package path`);
  assert.ok(!componentsByPath.has(location), `Duplicate SBOM package path: ${location}`);
  componentsByPath.set(location, component);
}
const rootComponent = sbom.metadata?.component;
assert.ok(rootComponent, 'SBOM has no root metadata component');
assert.equal(packagePath(rootComponent), '');

function packageName(location, entry) {
  if (entry.name) return entry.name;
  if (!location) return JSON.parse(readFileSync('package.json', 'utf8')).name;
  const marker = 'node_modules/';
  return location.slice(location.lastIndexOf(marker) + marker.length);
}

function normalizedLicenses(component) {
  return (component.licenses ?? []).flatMap((item) => {
    if (item.expression) return [item.expression];
    if (item.license?.id) return [item.license.id];
    if (item.license?.name) return [item.license.name];
    return [];
  }).map((value) => value.replace(/[\s()]/g, ''));
}

function checkIntegrity(location, entry, component) {
  const [algorithm, expected] = entry.integrity.split(/-(.+)/);
  const algorithms = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  assert.ok(
    (component.hashes ?? []).some((hash) => (
      hash.alg === algorithms[algorithm] && hash.content === expected
    )),
    `${location}: SBOM integrity does not match lockfile`,
  );
}

let checkedExternal = 0;
let checkedLocal = 0;
for (const [location, entry] of Object.entries(lock.packages ?? {})) {
  if (entry.link) continue;
  const label = location || '<root>';
  const name = packageName(location, entry);
  const external = location.includes('node_modules/');
  const component = location === ''
    ? rootComponent
    : external
      ? componentsByPath.get(location)
      : componentsByPath.get(`node_modules/${name}`);
  assert.ok(component, `${label}: missing ${name}@${entry.version} in SBOM`);
  assert.equal(fullName(component), name, `${label}: SBOM package name mismatch`);
  assert.equal(component.version, entry.version, `${label}: SBOM version mismatch`);
  assert.equal(component.type, location ? 'library' : 'application', `${label}: wrong component type`);
  assert.ok(
    normalizedLicenses(component).includes(entry.license.replace(/[\s()]/g, '')),
    `${label}: SBOM license does not match ${entry.license}`,
  );

  if (external) {
    checkedExternal += 1;
    const distributionUrls = (component.externalReferences ?? [])
      .filter((reference) => reference.type === 'distribution')
      .map((reference) => reference.url);
    assert.ok(distributionUrls.includes(entry.resolved), `${label}: resolved URL missing from SBOM`);
    checkIntegrity(label, entry, component);
    assert.ok(component.purl?.startsWith('pkg:npm/'), `${label}: npm purl missing`);
    assert.ok(component.purl.endsWith(`@${entry.version}`), `${label}: purl version mismatch`);
  } else {
    checkedLocal += 1;
  }
}

assert.equal(
  componentsByPath.size,
  Object.values(lock.packages).filter((entry) => !entry.link).length - 1,
  'SBOM component paths and lockfile entries differ',
);
/*
 * `local` 计数是**动态算出来的**，不加下限的话"把 workspace 从 package.json 里删掉并
 * 重新生成 lock/SBOM"会让全部断言继续自洽地通过（复核 R5-P1 实测）。
 * 16 = 15 个 workspace + 根组件（2026-11-02 接入 `apps/daemon` / `apps/model-broker` 时由 13 上调）；
 * 18 = 17 个 workspace + 根组件（2026-11-03 接入 `apps/cli` / `apps/response-helper` 时由 16 上调，
 * 实测见 `docs/implementation/evidence/release-gate/npm-check-after-integration.log`）。
 * 下限只允许上调。
 */
assert.ok(
  checkedLocal >= 18,
  `SBOM covered only ${checkedLocal} local locked packages; the workspace set appears to have shrunk`,
);
console.log(`SBOM check passed: ${checkedExternal} external and ${checkedLocal} local locked packages.`);
console.log('Every external component has exact version, resolved URL, integrity hash, and license evidence.');
