/**
 * The ZIP codec behind the portable package (author PT-dove).
 *
 * The archive *is* the deliverable, so its two properties are asserted rather than
 * assumed: the same inputs must produce the same bytes (otherwise the sha256 in
 * status/DIST-PACKAGE.md is meaningless), and the reader must reject a corrupted
 * entry instead of handing back plausible-looking bytes.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { crc32 } from '../../scripts/release/lib/crc32.mjs';
import { ZipArchive } from '../../scripts/release/lib/zip-read.mjs';
import { writeZipSync } from '../../scripts/release/lib/zip-write.mjs';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const FIXTURE_NAMES = ['a b/重复 名字.txt', 'a.txt', 'empty.txt', 'nested/deep/file.bin'];

const ROOT = mkdtempSync(join(tmpdir(), 'dist-zip-'));
const SOURCE = join(ROOT, 'src');
mkdirSync(join(SOURCE, 'a b'), { recursive: true });
mkdirSync(join(SOURCE, 'nested', 'deep'), { recursive: true });
writeFileSync(join(SOURCE, 'a.txt'), 'hello\n');
writeFileSync(join(SOURCE, 'empty.txt'), '');
writeFileSync(join(SOURCE, 'a b', '重复 名字.txt'), 'x'.repeat(5000));
writeFileSync(join(SOURCE, 'nested', 'deep', 'file.bin'), Buffer.from([0, 1, 2, 3, 255]));

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function entriesFor(names = FIXTURE_NAMES) {
  return names.map((name) => ({ name, absPath: join(SOURCE, ...name.split('/')) }));
}

test('crc32 matches the reference values for the standard check string', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('')), 0);
});

test('the same entries produce byte-identical archives regardless of input order', () => {
  const forward = join(ROOT, 'forward.zip');
  const backward = join(ROOT, 'backward.zip');
  writeZipSync({ outPath: forward, entries: entriesFor() });
  writeZipSync({ outPath: backward, entries: entriesFor([...FIXTURE_NAMES].reverse()) });
  assert.equal(sha256(forward), sha256(backward), 'entry order must not leak into the archive bytes');
});

test('a rebuilt archive keeps its hash when only mtime changes', () => {
  const first = join(ROOT, 'first.zip');
  writeZipSync({ outPath: first, entries: entriesFor() });
  const before = sha256(first);
  // Rewriting the files changes their timestamps: the usual reason a "reproducible"
  // archive is not reproducible.
  for (const name of FIXTURE_NAMES) {
    const path = join(SOURCE, ...name.split('/'));
    writeFileSync(path, readFileSync(path));
  }
  const second = join(ROOT, 'second.zip');
  writeZipSync({ outPath: second, entries: entriesFor() });
  assert.equal(sha256(second), before);
});

test('non-ASCII names, spaces and empty files survive the round trip', () => {
  const archivePath = join(ROOT, 'roundtrip.zip');
  writeZipSync({ outPath: archivePath, entries: entriesFor() });
  const archive = new ZipArchive(archivePath);
  try {
    assert.deepEqual(archive.entries.map((entry) => entry.name).sort(), [...FIXTURE_NAMES].sort());
    const restored = join(ROOT, 'out');
    assert.equal(archive.extractAll(restored), FIXTURE_NAMES.length);
    for (const name of FIXTURE_NAMES) {
      assert.deepEqual(
        readFileSync(join(restored, ...name.split('/'))),
        readFileSync(join(SOURCE, ...name.split('/'))),
        `${name} must round-trip byte for byte`,
      );
    }
  } finally {
    archive.close();
  }
});

test('a corrupted payload is rejected instead of being returned', () => {
  const archivePath = join(ROOT, 'corrupt.zip');
  writeZipSync({ outPath: archivePath, entries: entriesFor() });
  const bytes = readFileSync(archivePath);
  // The offset comes from the reader, so this does not depend on header layout guesses.
  const probe = new ZipArchive(archivePath);
  const entry = probe.entries.find((candidate) => candidate.name === 'a.txt');
  probe.close();
  const header = bytes.subarray(entry.localOffset, entry.localOffset + 30);
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  bytes[dataStart] ^= 0xff;
  writeFileSync(archivePath, bytes);

  const broken = new ZipArchive(archivePath);
  try {
    assert.throws(
      () => broken.readFile(broken.entries.find((candidate) => candidate.name === 'a.txt')),
      /CRC mismatch|size mismatch|corrupt deflate stream/,
    );
  } finally {
    broken.close();
  }
});

test('the writer refuses duplicate and unsafe entry names', () => {
  const target = join(ROOT, 'dupes.zip');
  assert.throws(
    () => writeZipSync({ outPath: target, entries: [
      { name: 'a.txt', absPath: join(SOURCE, 'a.txt') },
      { name: 'a.txt', absPath: join(SOURCE, 'a.txt') },
    ] }),
    /duplicate entry/,
  );
  assert.throws(
    () => writeZipSync({ outPath: target, entries: [{ name: '../escape.txt', absPath: join(SOURCE, 'a.txt') }] }),
    /unsafe entry name/,
  );
  assert.throws(
    () => writeZipSync({ outPath: target, entries: [{ name: '/abs.txt', absPath: join(SOURCE, 'a.txt') }] }),
    /unsafe entry name/,
  );
});

test('the reader refuses to extract an entry that escapes the destination', () => {
  const archivePath = join(ROOT, 'traversal.zip');
  writeZipSync({ outPath: archivePath, entries: entriesFor(['a.txt']) });
  const archive = new ZipArchive(archivePath);
  try {
    archive.entries[0].name = '../escape.txt';
    assert.throws(() => archive.extractAll(join(ROOT, 'escape-out')), /unsafe entry name/);
  } finally {
    archive.close();
  }
});
