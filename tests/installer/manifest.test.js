/**
 * The hash manifest and the full verification pass.
 *
 * The cases that matter are the *failures*: a verifier that only proves "a good payload
 * passes" is a verifier that never ran. Each negative case here is one of the ways a
 * tampered or broken payload presents itself at the install gate.
 */

import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { sha256Text } from '../../deploy/windows/installer/src/fsx.mjs';
import {
  assertSafeRelativePath,
  describeFailure,
  ManifestError,
  parseManifest,
  verifyTree,
} from '../../deploy/windows/installer/src/manifest.mjs';
import { createPayload, tempRoot } from './fixtures/payload.mjs';

const HEADER = '# header line\n# format: <sha256>  <path>\n';

test('parseManifest reads the builder format and ignores comments and blank lines', () => {
  const text = `${HEADER}\n${'a'.repeat(64)}  apps/daemon/bin.js\n${'b'.repeat(64)}  rules/pack.json\n`;
  const parsed = parseManifest(text);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], { digest: 'a'.repeat(64), path: 'apps/daemon/bin.js', line: 4 });
  assert.equal(parsed.digest, sha256Text(text));
});

test('parseManifest rejects a line without the two-space separator', () => {
  assert.throws(() => parseManifest(`${'a'.repeat(64)} apps/x\n`), ManifestError);
});

test('parseManifest rejects a short digest', () => {
  assert.throws(() => parseManifest('abc  apps/x\n'), ManifestError);
});

test('parseManifest rejects an empty manifest instead of treating it as "nothing to check"', () => {
  assert.throws(() => parseManifest('# only comments\n\n'), /没有任何条目/u);
});

test('parseManifest rejects a manifest that names itself', () => {
  assert.throws(() => parseManifest(`${'a'.repeat(64)}  manifests/files.sha256\n`), /不得包含自身/u);
});

test('parseManifest rejects duplicate paths', () => {
  const text = `${'a'.repeat(64)}  a/b\n${'b'.repeat(64)}  a/b\n`;
  assert.throws(() => parseManifest(text), /路径重复/u);
});

test('manifest paths cannot climb out of the payload root', () => {
  for (const bad of ['../Windows/System32/x.dll', 'C:/Windows/x.dll', '/etc/passwd', 'a\\b', 'a//b', '']) {
    assert.throws(() => assertSafeRelativePath(bad), ManifestError, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(assertSafeRelativePath('apps/daemon/bin.js'), true);
});

test('verifyTree passes a pristine payload', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const result = await verifyTree({ root: payload.root, rows: parsed.rows });
  assert.equal(result.ok, true, describeFailure(result));
  assert.equal(result.checked, payload.fileCount);
});

test('verifyTree reports a modified file as a digest mismatch', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  writeFileSync(join(payload.root, 'apps/daemon/bin.js'), 'tampered\n');
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const result = await verifyTree({ root: payload.root, rows: parsed.rows });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatched.map((entry) => entry.path), ['apps/daemon/bin.js']);
});

test('verifyTree reports a deleted file as missing', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  
  rmSync(join(payload.root, 'rules/pack.json'));
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const result = await verifyTree({ root: payload.root, rows: parsed.rows });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['rules/pack.json']);
});

test('verifyTree reports an unlisted file as an extra, not as "fine"', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  appendFileSync(join(payload.root, 'apps/daemon/extra.dll'), 'dropped in later\n');
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const result = await verifyTree({ root: payload.root, rows: parsed.rows });
  assert.equal(result.ok, false);
  assert.deepEqual(result.extras, ['apps/daemon/extra.dll']);
});

test('verifyTree ignores everything under manifests/ (the manifest cannot cover itself)', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const before = await verifyTree({ root: payload.root, rows: parsed.rows });
  writeFileSync(join(payload.root, 'manifests/trust.json'), '{}\n');
  const after = await verifyTree({ root: payload.root, rows: parsed.rows });
  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
});

test('verifyTree on a missing directory reports every row as missing', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const result = await verifyTree({ root: join(root, 'elsewhere'), rows: parsed.rows });
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, parsed.rows.length);
});

test('describeFailure names the counts and a sample, and stays one line', async (t) => {
  const root = tempRoot(t);
  const payload = createPayload(join(root, 'payload'));
  writeFileSync(join(payload.root, 'apps/daemon/bin.js'), 'tampered\n');
  const parsed = parseManifest(readFileSync(payload.manifestPath, 'utf8'));
  const text = describeFailure(await verifyTree({ root: payload.root, rows: parsed.rows }));
  assert.match(text, /摘要不符 1/u);
  assert.match(text, /apps\/daemon\/bin\.js/u);
  assert.equal(text.includes('\n'), false);
});
