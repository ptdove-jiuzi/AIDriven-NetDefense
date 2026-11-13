/**
 * R6-003 · "the packaged console bytes can be rebuilt from the current source".
 *
 * The defect this file exists for: the build stages a *pinned* copy of
 * `apps/console` (`dist/_v14-inputs/console-v2`), the release chain wraps the
 * staged tree, and nothing in the repository compares a shipped copy with the tree
 * it claims to be built from. SEED-02 was found exactly there — the source
 * `styles.css` had the `[hidden]` fallback (sha `5a3c6160…`) while twelve `dist/**`
 * copies and the rc.3 portable package still carried `25b68c6e…` — and every gate
 * stayed green because no assertion looked at both sides.
 *
 * Three properties, in order:
 *
 * 1. **Rebuildability.** `freeze-console.mjs` reproduces the source byte for byte,
 *    twice, from a tree that is not the one it was written against. A payload that
 *    cannot be produced from the tree is hand-maintained, and hand-maintained
 *    payloads are how the twelve stale copies happened.
 * 2. **Artifact integrity.** Every artifact named in `dist-parity.ledger.json`
 *    still holds the bytes the ledger records for it, re-derived from disk rather
 *    than trusted from its own `bundle.json`.
 * 3. **Drift is a decision, not an accident.** A shipped artifact may lag the
 *    source only when the ledger records *that exact* pair — source digest, artifact
 *    digest, owner, reason. Editing `apps/console` changes the source digest, so
 *    this test goes red until the payload is rebuilt or a new decision is recorded;
 *    editing the payload changes the artifact digest and does the same. A stale
 *    drift record left behind after a rebuild is red too.
 *
 * What it deliberately does not do: it never writes `dist/**`. Freezing goes to a
 * temporary directory, and both sides are read-only. It also does not open the
 * 143 MB rc.3 portable zip — the in-repository v15 payload is the input that zip is
 * wrapped from, and unzipping it per run would double the gate's I/O for the same
 * bytes. That boundary is recorded in the ledger, not hidden here.
 *
 * `AEGIS_DIST_PARITY_SOURCE` points the source side at another directory. It exists
 * for the mutation proof — "edit the source and the assertion must fail" — so the
 * proof does not have to edit the product tree, which belongs to another domain.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestTree, freezeConsole, sha256File } from './freeze-console.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LEDGER_PATH = join(REPO_ROOT, 'tests', 'packaging', 'dist-parity.ledger.json');
const DEFAULT_SOURCE = join(REPO_ROOT, 'apps', 'console');
const SOURCE = resolve(process.env.AEGIS_DIST_PARITY_SOURCE ?? DEFAULT_SOURCE);

const SCRATCH = mkdtempSync(join(tmpdir(), 'aegis-dist-parity-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Same construction `freeze-console.mjs` uses, so two trees agree only on bytes. */
function payloadDigest(files) {
  const text = [...files]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    .map((row) => `${row.sha256}  ${row.path}`)
    .join('\n');
  return createHash('sha256').update(text).digest('hex');
}

/** The console files the shipped bundle declares, with the `console/` prefix gone. */
function declaredConsoleFiles(root) {
  const bundle = readJson(join(root, 'bundle.json'));
  return {
    bundle,
    files: bundle.console.files.map((row) => ({
      path: row.path.startsWith('console/') ? row.path.slice('console/'.length) : row.path,
      sha256: row.sha256,
    })),
  };
}

/** Re-read every declared file from the bundle, never trusting its own manifest. */
function payloadOnDisk(root, declared) {
  return declared.map((row) => {
    const absolute = join(root, 'console', ...row.path.split('/'));
    return {
      path: row.path,
      sha256: existsSync(absolute) ? sha256File(absolute) : 'missing',
      declared: row.sha256,
    };
  });
}

function artifactRoot(artifact) {
  const root = resolve(REPO_ROOT, ...artifact.bundleRoot.split('/'));
  assert.ok(existsSync(join(root, 'bundle.json')), `artifact bundle missing: ${root}`);
  return root;
}

test('the console payload is rebuildable from the current source, deterministically', () => {
  assert.ok(existsSync(join(SOURCE, 'index.html')), `console source has no index.html: ${SOURCE}`);
  const first = join(SCRATCH, 'freeze-a');
  const second = join(SCRATCH, 'freeze-b');
  const a = freezeConsole({ source: SOURCE, dest: first });
  assert.equal(a.ok, true, `freeze failed: ${JSON.stringify(a.failures)}`);
  const b = freezeConsole({ source: SOURCE, dest: second });
  assert.equal(b.ok, true, `second freeze failed: ${JSON.stringify(b.failures)}`);

  // The snapshot is the source, file for file: a payload built from this freeze
  // carries exactly these bytes and nothing the tree does not have.
  const source = digestTree(SOURCE);
  assert.deepEqual(a.files, source.files, 'the frozen payload must be the source tree, file for file');
  assert.equal(a.sourceDigest, source.digest, 'the recorded snapshot digest must be re-derivable');
  assert.equal(a.snapshotDigest, a.sourceDigest, 'the copy on disk must hash to the source digest');

  // Determinism: two freezes of an unchanged tree may not differ. A payload whose
  // bytes depend on when it was frozen cannot be compared with anything.
  assert.equal(b.snapshotDigest, a.snapshotDigest, 'two freezes of the same tree must be byte-identical');
  assert.ok(a.fileCount >= 10, `implausibly small console payload: ${a.fileCount} files`);
});

test('every recorded artifact still holds the bytes the ledger records', () => {
  const ledger = readJson(LEDGER_PATH);
  assert.equal(ledger.author, 'PT-dove');
  assert.equal(ledger.source, 'apps/console');
  assert.ok(Array.isArray(ledger.artifacts) && ledger.artifacts.length > 0, 'the ledger must name at least one artifact');

  for (const artifact of ledger.artifacts) {
    const root = artifactRoot(artifact);
    const { bundle, files } = declaredConsoleFiles(root);
    const sourcePaths = new Set(digestTree(SOURCE).files.map((row) => row.path));
    assert.equal(bundle.console?.declaredSourcePath, ledger.source,
      `${artifact.id}: the payload no longer declares ${ledger.source} as its console source`);
    assert.equal(artifact.declaredSourcePath, ledger.source,
      `${artifact.id}: the ledger record is stale about the declared source`);

    const onDisk = payloadOnDisk(root, files);
    const missing = onDisk.filter((row) => row.sha256 === 'missing');
    assert.deepEqual(missing.map((row) => row.path), [], `${artifact.id}: declared console files missing from disk`);
    const differing = onDisk.filter((row) => row.sha256 !== row.declared);
    assert.deepEqual(differing.map((row) => row.path), [],
      `${artifact.id}: bundle.json claims digests the shipped bytes do not have`);

    // Only the files the console source owns take part in the comparison with the
    // source digest; `serve.mjs` comes from the packaging shell and is accounted for
    // by `nonSourceFiles` below.
    const diskDigest = payloadDigest(onDisk.filter((row) => sourcePaths.has(row.path)));
    assert.equal(diskDigest, artifact.payloadDigest,
      `${artifact.id}: the shipped console bytes changed since the ledger was recorded `
      + `(${diskDigest.slice(0, 12)}… != ${artifact.payloadDigest.slice(0, 12)}…). `
      + 'Either rebuild the payload (release chain) or re-record the ledger — a silent byte change is the defect.');

    // Files the payload carries that the console source does not own (today:
    // `serve.mjs`, copied from the packaging shell). Named, not tolerated: an
    // undeclared extra file is a payload change nobody reviewed.
    const extras = files.map((row) => row.path).filter((path) => !sourcePaths.has(path));
    assert.deepEqual(extras.sort(), [...artifact.nonSourceFiles].sort(),
      `${artifact.id}: the set of non-source console files changed without being declared`);
  }
});

test('a shipped artifact may lag the source only as a recorded, owned drift', () => {
  const ledger = readJson(LEDGER_PATH);
  const source = digestTree(SOURCE);
  const drift = ledger.drift ?? null;

  for (const artifact of ledger.artifacts) {
    const root = artifactRoot(artifact);
    const { files } = declaredConsoleFiles(root);
    const sourcePaths = new Set(source.files.map((row) => row.path));
    const artifactDigest = payloadDigest(
      payloadOnDisk(root, files).filter((row) => sourcePaths.has(row.path)),
    );
    const inSync = artifactDigest === source.digest;

    if (inSync) {
      // A rebuild happened. A drift record that still claims this artifact lags is
      // now a lie, and a lie about drift hides the next real one.
      const stale = drift?.artifacts?.[artifact.id];
      assert.equal(stale, undefined,
        `${artifact.id} is back in sync with ${ledger.source}, but the ledger still records a drift for it `
        + `(${String(stale).slice(0, 12)}…). Remove the stale drift record — do not leave the gate agreeing with a fiction.`);
      continue;
    }

    if (drift === null) {
      assert.fail(`${artifact.id} does not carry the current ${ledger.source} bytes `
        + `(source ${source.digest.slice(0, 12)}…, payload ${artifactDigest.slice(0, 12)}…). `
        + 'This is R6-003: the package was not rebuilt after the source changed. Rebuild it, or record the '
        + 'drift in tests/packaging/dist-parity.ledger.json with an owner and a reason.');
    }

    // The decision must be about *today's* pair. If the source moved again, the
    // recorded decision is stale and has to be made again by whoever owns it.
    assert.equal(drift.sourceDigest, source.digest,
      `the source tree changed after the drift was recorded `
      + `(recorded ${String(drift.sourceDigest).slice(0, 12)}…, now ${source.digest.slice(0, 12)}…). `
      + `Rebuild ${artifact.id} from the current source, or re-record the drift with an owner and a reason.`);
    assert.equal(drift.artifacts?.[artifact.id], artifactDigest,
      `the shipped bytes of ${artifact.id} changed after the drift was recorded `
      + `(recorded ${String(drift.artifacts?.[artifact.id]).slice(0, 12)}…, now ${artifactDigest.slice(0, 12)}…). `
      + 'Re-record the drift — an artifact changing unattended is the defect this file exists for.');
    assert.equal(typeof drift.owner, 'string');
    assert.ok(drift.owner.length > 0, 'a drift record must name who owns the rebuild');
    assert.equal(typeof drift.reason, 'string');
    assert.ok(drift.reason.length > 40, 'a drift record must say why the lag is tolerated, not just that it exists');

    // The file-level list is the part a reviewer reads: it must name the files that
    // actually differ, so the size of the lag is visible at a glance.
    const changed = source.files
      .filter((row) => {
        const shipped = join(root, 'console', ...row.path.split('/'));
        return !existsSync(shipped) || sha256File(shipped) !== row.sha256;
      })
      .map((row) => row.path)
      .sort();
    assert.deepEqual([...(drift.changedFiles ?? [])].sort(), changed,
      `the drift record must list exactly the ${ledger.source} files whose shipped bytes differ`);
  }
});
