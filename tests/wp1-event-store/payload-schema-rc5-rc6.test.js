/**
 * payload-schema-rc5-rc6.test.js — pin the *data* premise of the round-4 campaign:
 * the rc.5 (payload generation v17) and rc.6 (v18) installers ship an `@aegisharness/event-store`
 * whose **schema is byte-identical**, even though three module files changed.
 *
 * Why the distinction matters: the round-4 upgrade path installs rc.5 and overwrites it with
 * rc.6 (`status/UPGRADE-PATH.md` §9, `evidence/upgrade/r4/**`).  "No schema migration" is the
 * premise that makes "upgrade does not lose/convert data" measurable at the file-copy layer.
 * v17 -> v18 did ship **code** fixes in the same package (`src/db.js`, `src/index.js`,
 * `src/ingest.js`), so a blanket "16 files identical" assertion would be false and would
 * have to be weakened later — this file pins the precise fact instead:
 *
 *   - `src/schema.js`          identical, and equal to the digest the migration chain is pinned to
 *   - schema version constant  identical (no new migration step in the shipped payload)
 *   - the other 13 files       byte-identical (package.json + 12 modules)
 *   - exactly 3 files differ   (db.js / index.js / ingest.js) — code fixes, NOT a schema migration
 *
 * If those three files ever come back into sync, or a fourth one diverges, the premise moved:
 * re-measure `evidence/upgrade/r4/**` instead of editing the numbers here silently.
 *
 * Read-only: hashes files under `dist/bundle/**` and never writes there.  Skipped when a
 * payload generation is absent (a checkout without release output).
 *
 * Run with:  node --test tests/wp1-event-store/payload-schema-rc5-rc6.test.js
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const BUNDLE_ROOT = join(REPO_ROOT, 'dist', 'bundle');

/** rc.5 ships win32-x64-v17, rc.6 ships win32-x64-v18. */
const OLD = 'win32-x64-v17';
const NEW = 'win32-x64-v18';
const STORE_REL = join('app', 'node_modules', '@aegisharness', 'event-store');

/** The `schema.js` digest the "no migration between these releases" claim rests on. */
const SCHEMA_SHA256 = 'c49169256fc1a6282ba569ebf0519d121cd3c24ef0876733b7da0d4bb465f4b8';

/** Files that legitimately changed between v17 and v18 (code fixes, no schema change). */
const CHANGED_BETWEEN_V17_V18 = ['src/db.js', 'src/index.js', 'src/ingest.js'];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** `{relativePath: {bytes, sha256}}` for every file under `dir`. */
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

const missing = [OLD, NEW].filter((name) => !existsSync(join(BUNDLE_ROOT, name, STORE_REL)));
const SKIP = missing.length > 0
  ? `payload generation(s) not present in this checkout: ${missing.join(', ')}`
  : false;

const trees = SKIP
  ? {}
  : { [OLD]: digestTree(join(BUNDLE_ROOT, OLD, STORE_REL)), [NEW]: digestTree(join(BUNDLE_ROOT, NEW, STORE_REL)) };

test('the event-store package has the same 16 files in v17 (rc.5) and v18 (rc.6)', { skip: SKIP }, () => {
  const onlyOld = Object.keys(trees[OLD]).filter((rel) => !(rel in trees[NEW])).sort();
  const onlyNew = Object.keys(trees[NEW]).filter((rel) => !(rel in trees[OLD])).sort();
  assert.deepEqual(onlyOld, [], `${NEW} is missing event-store files that ${OLD} ships`);
  assert.deepEqual(onlyNew, [], `${NEW} ships event-store files that ${OLD} does not`);
  assert.equal(Object.keys(trees[OLD]).length, 16, 'the shipped package is the 16-file layout the campaign measured');
  assert.equal(Object.keys(trees[NEW]).length, 16);
});

test('schema.js is byte-identical in v17 and v18 — rc.5 -> rc.6 has no store schema migration', { skip: SKIP }, () => {
  for (const name of [OLD, NEW]) {
    const path = join(BUNDLE_ROOT, name, STORE_REL, 'src', 'schema.js');
    assert.equal(existsSync(path), true, `${name} must ship src/schema.js`);
    assert.equal(sha256(path), SCHEMA_SHA256, `${name} ships a different schema.js; "no migration" must be re-measured`);
  }
  assert.equal(
    trees[OLD]['src/schema.js'].sha256,
    trees[NEW]['src/schema.js'].sha256,
    'the schema module moved between the two payloads of the round-4 upgrade pair',
  );
});

test('the schema version constant is the same in both payloads (no new migration step shipped)', { skip: SKIP }, () => {
  const readVersion = (name) => {
    const text = readFileSync(join(BUNDLE_ROOT, name, STORE_REL, 'src', 'schema.js'), 'utf8');
    const match = text.match(/(?:SCHEMA_VERSION|SCH?EMA_CURRENT_VERSION)\s*=\s*(\d+)/u);
    assert.ok(match, `${name}: could not find the schema version constant in src/schema.js`);
    return Number(match[1]);
  };
  assert.equal(readVersion(NEW), readVersion(OLD), 'the shipped schema version changed; a migration chain became live again');
});

test('exactly the 3 known module files differ between v17 and v18 (code fixes, not schema)', { skip: SKIP }, () => {
  const changed = Object.keys(trees[OLD])
    .filter((rel) => rel in trees[NEW] && trees[OLD][rel].sha256 !== trees[NEW][rel].sha256)
    .sort();
  assert.deepEqual(
    changed,
    [...CHANGED_BETWEEN_V17_V18].sort(),
    `event-store payload bytes moved; the round-4 "no schema migration" premise must be re-measured. changed=${changed.join(',')}`,
  );
});

test('the other 13 event-store files are byte-identical between v17 and v18', { skip: SKIP }, () => {
  const identical = Object.keys(trees[OLD])
    .filter((rel) => rel in trees[NEW] && trees[OLD][rel].sha256 === trees[NEW][rel].sha256)
    .sort();
  assert.equal(identical.length, 13, `expected 13 byte-identical files, got ${identical.length}`);
  for (const rel of CHANGED_BETWEEN_V17_V18) {
    assert.equal(identical.includes(rel), false, `${rel} must NOT be in the identical set`);
  }
});

test('the v18 payload keeps the shipped file count / manifest size the round-4 evidence describes', { skip: SKIP }, () => {
  // 50k+ rows for the full payload: if the payload is rebuilt the timings quoted in
  // evidence/upgrade/r4/** are stale too.
  const manifest = join(BUNDLE_ROOT, NEW, 'manifests', 'files.sha256');
  assert.equal(existsSync(manifest), true, `${NEW} must ship manifests/files.sha256`);
  const rows = readFileSync(manifest, 'utf8').split(/\r?\n/u).filter((line) => line.trim() !== '');
  assert.ok(rows.length > 50_000, `expected the full payload manifest, got ${rows.length} rows`);
});
