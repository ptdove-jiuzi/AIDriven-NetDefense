import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readJson, sha256File } from '@aegisharness/harness-adapter';
import { approved, packageLayer, policy } from './helpers.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('package layer has exact lockfile and release-file evidence for the official launcher', () => {
  const dsh = packageLayer.packages.find((entry) => entry.name === '@deepseek-ai/dsh');
  assert.ok(dsh);
  assert.equal(dsh.version, '0.2.2-alpha.2');
  assert.equal(dsh.license, 'MIT');
  assert.equal(dsh.integrity, 'sha512-mdcpgF8D1eFQV8Gu3T/sYLkBwfw9h/Li0uPIxXyby1VybJgrFg8BU1Le40FiMnN+heL7k3zOMuAVe7sFq/JO4w==');
  assert.equal(dsh.resolved, 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2-alpha.2.tgz');
  assert.ok(dsh.files.some((file) => file.path === 'lib/bin.js' && /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(packageLayer.packages.every((entry) => !entry.installed || entry.files.length > 0));
});

test('every contract direct package is exact and present in the package layer', () => {
  const profile = readJson(join(root, 'plugins', 'dsh-defense-profile', 'package.json'));
  for (const [name, version] of Object.entries(profile.dependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue;
    const matches = packageLayer.packages.filter((entry) => entry.name === name && entry.version === version && entry.installed);
    assert.ok(matches.length > 0, `${name}@${version} is missing from installed lockfile evidence`);
  }
  assert.deepEqual(profile.dsh.profile.bundles, []);
  const patch = readFileSync(join(root, 'plugins', 'dsh-defense-profile', 'cordis.patch.yml'), 'utf8');
  assert.ok(!patch.includes("name: '@deepseek-ai/dsh-base'"));
  assert.ok(!patch.includes("name: '@deepseek-ai/dsh-sdk-minimal'"));
});

test('approved source hashes are current and independently readable', () => {
  for (const [name, record] of Object.entries(approved.files)) {
    assert.equal(sha256File(join(root, name)), record.sha256, name);
  }
  assert.equal(policy.author, 'PT-dove');
  assert.equal(policy.upstream.commit, 'ce7073d51254c26cd63b22a60835b8f948deb447');
});
