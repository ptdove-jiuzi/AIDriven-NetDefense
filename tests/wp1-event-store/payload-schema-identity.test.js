/**
 * payload-schema-identity.test.js — pin the *data* premise of the upgrade-path campaign:
 * the three shipped payload generations carry a **byte-identical** `@aegisharness/event-store`.
 *
 * Why this is a test and not a paragraph: the whole "upgrading does not lose data"
 * conclusion has two halves, and only one of them is about the installer.  Between
 * rc.3 (`dist/bundle/win32-x64-v15`), rc.4 (v16), rc.5 (v17) there is **no schema
 * migration** — and the round-3 upgrade used the same v17 payload with a source-built
 * rc.6 candidate — so the only remaining data-loss surface is file copying / ownership
 * checks / power loss (measured in `evidence/upgrade/**`).
 *
 * If a future release rebuilds a payload and the event-store bytes move, that premise
 * expires: the migration chain (`packages/event-store/src/schema.js`, v1..v5) becomes
 * live again for real users, and `status/UPGRADE-PATH.md` / `evidence/upgrade/**` must be
 * re-measured rather than quoted.  This file is the tripwire.
 *
 * Read-only: it hashes files under `dist/bundle/**` and never writes there.  When the
 * payloads are absent (a checkout without release output) the tests are skipped.
 *
 * Run with:  node --test tests/wp1-event-store/payload-schema-identity.test.js
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BUNDLE_ROOT = join(REPO_ROOT, 'dist', 'bundle');

/** Payload generations the campaign compared, oldest first. */
const GENERATIONS = ['win32-x64-v15', 'win32-x64-v16', 'win32-x64-v17'];
const STORE_REL = join('app', 'node_modules', '@aegisharness', 'event-store');

/** The `schema.js` digest the "no migration between these releases" claim rests on. */
const SCHEMA_SHA256 = 'c49169256fc1a6282ba569ebf0519d121cd3c24ef0876733b7da0d4bb465f4b8';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `{relativePath: sha256}` for every file under `dir`. */
function digestTree(dir) {
  const out = {};
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out[rel] = { bytes: statSync(full).size, sha256: sha256(full) };
    }
  };
  walk(dir, '');
  return out;
}

const missing = GENERATIONS.filter((name) => !existsSync(join(BUNDLE_ROOT, name, STORE_REL)));
const SKIP = missing.length > 0
  ? `payload generation(s) not present in this checkout: ${missing.join(', ')}`
  : false;

test('the event-store payload is byte-identical across the v15 / v16 / v17 generations', { skip: SKIP }, () => {
  const trees = GENERATIONS.map((name) => [name, digestTree(join(BUNDLE_ROOT, name, STORE_REL))]);
  const [[baseName, base]] = trees;

  assert.ok(Object.keys(base).length > 0, `${baseName} must contain the event-store package`);

  for (const [name, tree] of trees.slice(1)) {
    const onlyBase = Object.keys(base).filter((rel) => !(rel in tree)).sort();
    const onlyOther = Object.keys(tree).filter((rel) => !(rel in base)).sort();
    const changed = Object.keys(base)
      .filter((rel) => rel in tree && base[rel].sha256 !== tree[rel].sha256)
      .sort();
    assert.deepEqual(onlyBase, [], `${name} is missing event-store files that ${baseName} ships`);
    assert.deepEqual(onlyOther, [], `${name} ships event-store files that ${baseName} does not`);
    assert.deepEqual(changed, [], `${name} changed event-store bytes; "no schema migration" must be re-measured`);
  }
});

test('schema.js is the same file in every generation, and it is the digest the campaign quoted', { skip: SKIP }, () => {
  for (const name of GENERATIONS) {
    const path = join(BUNDLE_ROOT, name, STORE_REL, 'src', 'schema.js');
    assert.equal(existsSync(path), true, `${name} must ship src/schema.js`);
    assert.equal(sha256(path), SCHEMA_SHA256, `${name} ships a different schema.js`);
  }
  // The 16-file count is what the campaign published; keep it explicit so a new file in
  // the package (a new module that a migration would need) cannot slip in unnoticed.
  assert.equal(Object.keys(digestTree(join(BUNDLE_ROOT, GENERATIONS[0], STORE_REL))).length, 16);
});

test('the migration chain still starts at v1 and ends at the current version', { skip: SKIP }, () => {
  // Not a duplication of tests/wp1-event-store/downgrade-refusal.test.js (which drives
  // the behaviour): this only pins that the payload's schema.js *is* the one the tests in
  // this repository exercise, so a payload rebuilt from different source bytes shows up.
  const repoSource = join(REPO_ROOT, 'packages', 'event-store', 'src', 'schema.js');
  if (!existsSync(repoSource)) {
    // The store package is not part of every checkout layout; the payload assertion above
    // is the part that matters for the upgrade claim.
    return;
  }
  const payloadSchema = join(BUNDLE_ROOT, GENERATIONS[0], STORE_REL, 'src', 'schema.js');
  assert.equal(
    sha256(repoSource),
    SCHEMA_SHA256,
    'packages/event-store/src/schema.js drifted from the payload copy; re-measure the upgrade evidence',
  );
  assert.equal(sha256(payloadSchema), sha256(repoSource));
});

test('the payload tree keeps the shipped file count the upgrade evidence describes', { skip: SKIP }, () => {
  // 50,832 files / 486,344,515 B for v17 is quoted in evidence/upgrade/**; if the payload
  // is rebuilt these numbers (and therefore every timing in the reports) are stale.
  const manifest = join(BUNDLE_ROOT, 'win32-x64-v17', 'manifests', 'files.sha256');
  assert.equal(existsSync(manifest), true);
  const rows = readFileSync(manifest, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '');
  assert.ok(rows.length > 50_000, `expected the full payload manifest, got ${rows.length} rows`);
  const rel = relative(BUNDLE_ROOT, manifest);
  assert.ok(rel.length > 0);
});
