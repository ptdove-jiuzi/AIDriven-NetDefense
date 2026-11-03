import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const sbom = JSON.parse(readFileSync('sbom.cdx.json', 'utf8'));
const algorithms = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
const externalEntries = Object.entries(lock.packages ?? {})
  .filter(([location, entry]) => location.includes('node_modules/') && !entry.link);
sbom.components ??= [];

function packagePath(component) {
  return component.properties?.find(
    (property) => property.name === 'cdx:npm:package:path',
  )?.value;
}

function packageName(location, entry) {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  return location.slice(location.lastIndexOf(marker) + marker.length);
}

function applyEvidence(component, location, entry) {
  assert.match(entry.integrity ?? '', /^(sha256|sha384|sha512)-/);
  const [algorithm, content] = entry.integrity.split(/-(.+)/);
  component.hashes = [{ alg: algorithms[algorithm], content }];
  const references = component.externalReferences ??= [];
  if (!references.some((reference) => (
    reference.type === 'distribution' && reference.url === entry.resolved
  ))) {
    references.push({
      url: entry.resolved,
      type: 'distribution',
      comment: 'resolved value from package-lock.json',
    });
  }
}

function componentFromLock(location, entry) {
  const name = packageName(location, entry);
  const slash = name.lastIndexOf('/');
  const group = name.startsWith('@') && slash > 0 ? name.slice(0, slash) : undefined;
  const unscopedName = group ? name.slice(slash + 1) : name;
  const purlName = group ? `${encodeURIComponent(group)}/${unscopedName}` : unscopedName;
  return {
    type: 'library',
    ...(group ? { group } : {}),
    name: unscopedName,
    version: entry.version,
    'bom-ref': `lockfile:${location}`,
    licenses: [{ expression: entry.license }],
    purl: `pkg:npm/${purlName}@${entry.version}`,
    externalReferences: [],
    hashes: [],
    properties: [{ name: 'cdx:npm:package:path', value: location }],
  };
}

const componentsByPath = new Map(
  sbom.components.map((component) => [packagePath(component), component]),
);
let added = 0;
for (const [location, entry] of externalEntries) {
  let component = componentsByPath.get(location);
  if (!component) {
    component = componentFromLock(location, entry);
    sbom.components.push(component);
    componentsByPath.set(location, component);
    added += 1;
  }
  applyEvidence(component, location, entry);
}

sbom.components.sort((left, right) => (
  packagePath(left).localeCompare(packagePath(right), 'en')
));
writeFileSync('sbom.cdx.json', `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Applied lockfile resolved/integrity evidence to ${externalEntries.length} SBOM components.`);
console.log(`Added ${added} lockfile-only optional/platform components omitted by the current npm tree.`);
