/**
 * File-backed auth log: byte-offset cursor, complete-line-only consumption, rotation and
 * truncation detection, and the permission behaviour a non-root collector actually meets.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AUTH_LOG_SOURCE_ID,
  assertReadResult,
  createAuthLogSource,
  createMemoryFileSystem,
  parseAuthLine,
  severityForAuthLine,
} from '../../packages/collectors/linux/index.js';

const BASE = Date.UTC(2023, 10, 14, 22, 13, 20); // 2023-11-14T22:13:20Z
const LOG_PATH = '/var/log/auth.log';

function fixture() {
  return JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/auth-log.json', import.meta.url)), 'utf8'));
}

function sourceFor(manifest, options = {}) {
  const fileSystem = createMemoryFileSystem(manifest);
  const source = createAuthLogSource({ fileSystem, clock: () => BASE, ...options });
  return { fileSystem, source };
}

test('a syslog line is parsed into host, identifier, pid and message', () => {
  const parsed = parseAuthLine('Oct 31 10:00:01 lab-host sshd[812]: Failed password for root', { nowMs: BASE });
  assert.equal(parsed.host, 'lab-host');
  assert.equal(parsed.identifier, 'sshd');
  assert.equal(parsed.pid, 812);
  assert.equal(parsed.message, 'Failed password for root');
  assert.equal(parsed.timestampStyle, 'syslog');
  assert.equal(parsed.timestampMs, Date.UTC(2023, 9, 31, 10, 0, 1));
});

test('a December line read in mid-November belongs to the previous year', () => {
  const parsed = parseAuthLine('Dec 31 23:59:59 lab-host sshd[1]: BREAK-IN ATTEMPT', { nowMs: BASE });
  assert.equal(new Date(parsed.timestampMs).getUTCFullYear(), 2022, 'a stamp in the future must roll back a year');
});

test('an ISO 8601 line keeps its own timezone', () => {
  const parsed = parseAuthLine('2023-11-14T22:13:20.123456+00:00 lab-host sshd[812]: Failed password', { nowMs: BASE });
  assert.equal(parsed.timestampStyle, 'iso8601');
  assert.equal(parsed.timestampMs, Date.UTC(2023, 10, 14, 22, 13, 20));
  assert.equal(parsed.identifier, 'sshd');
});

test('a line without a timestamp is not guessed at', () => {
  assert.equal(parseAuthLine('kernel: [12345.678] random noise'), null);
  assert.equal(parseAuthLine(''), null);
});

test('auth messages are mapped to a severity by what they say', () => {
  assert.equal(severityForAuthLine('Failed password for invalid user admin'), 'medium');
  assert.equal(severityForAuthLine('BREAK-IN ATTEMPT from 203.0.113.9'), 'high');
  assert.equal(severityForAuthLine('Accepted publickey for test'), 'low');
  assert.equal(severityForAuthLine('session opened for user root'), 'info');
  assert.equal(severityForAuthLine(''), 'info');
});

test('the first read starts at the end by default and consumes nothing', async () => {
  const { source } = sourceFor({ files: { [LOG_PATH]: fixture().content } });
  const result = await source.read();
  assertReadResult(result, { stableSourceId: AUTH_LOG_SOURCE_ID });

  assert.equal(result.initialized, true);
  assert.equal(result.initialPosition, 'end');
  assert.deepEqual(result.records, []);
  assert.equal(result.nextCursor.offset, Buffer.byteLength(fixture().content, 'utf8'));
});

test('appended lines are delivered with the byte offset as the stable position', async () => {
  const first = fixture().content;
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: first } });
  const initial = await source.read();

  fileSystem.write(LOG_PATH, `${first}${fixture().appendAfterFirstRead}`);
  const result = await source.read({ cursor: initial.nextCursor });

  assert.equal(result.status, 'ok');
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.equal(record.type, 'linux.auth');
  assert.equal(record.sourceSequence, Buffer.byteLength(first, 'utf8'));
  assert.equal(record.payload.identifier, 'sshd');
  assert.equal(record.payload.message, 'Accepted publickey for test from 198.51.100.4 port 40022 ssh2');
  assert.equal(record.severity, 'low');
  assert.equal(record.observedAt, Date.UTC(2023, 9, 31, 10, 1, 0));
});

test('re-reading the same offset rebuilds the same source sequence, never a new one', async () => {
  const first = fixture().content;
  const { source } = sourceFor({ files: { [LOG_PATH]: `${first}${fixture().appendAfterFirstRead}` } });
  const initial = await source.read();

  const a = await source.read({ cursor: initial.nextCursor });
  const b = await source.read({ cursor: initial.nextCursor });
  assert.deepEqual(
    a.records.map((record) => record.sourceSequence),
    b.records.map((record) => record.sourceSequence),
    'a replayed read must produce identical positions so the collector can dedupe it',
  );
});

test('a trailing partial line is not consumed until its newline arrives', async () => {
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: '' } }, { initialPosition: 'start' });
  const initial = await source.read();

  fileSystem.write(LOG_PATH, fixture().partialTrailing);
  const partial = await source.read({ cursor: initial.nextCursor });
  assert.deepEqual(partial.records, [], 'a half-written line must not be emitted');
  assert.equal(partial.nextCursor.offset, 0);
  assert.equal(partial.hasMore, true);

  fileSystem.write(LOG_PATH, `${fixture().partialTrailing}\n`);
  const completed = await source.read({ cursor: partial.nextCursor });
  assert.equal(completed.records.length, 1);
  assert.equal(completed.records[0].payload.message, 'Failed password for root from 203.0.113.9');
});

test('a replaced file is reported as rotated with the previous file identity', async () => {
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: fixture().content } });
  const initial = await source.read();

  fileSystem.write(LOG_PATH, 'Oct 31 11:00:00 lab-host sshd[1]: after rotation\n', { ino: 999 });
  const result = await source.read({ cursor: initial.nextCursor });
  assertReadResult(result, { stableSourceId: AUTH_LOG_SOURCE_ID });

  assert.equal(result.status, 'rotated');
  assert.equal(result.rotation.reason, 'log_rotated');
  assert.notEqual(result.rotation.previousFileId, result.rotation.fileId);
  assert.deepEqual(result.records, []);
});

test('a truncated file is reported as log_truncated, not as new content', async () => {
  // Same inode on purpose: a truncation keeps the file identity, unlike a rotation.
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: { content: fixture().content, ino: 500 } } });
  const initial = await source.read();

  fileSystem.write(LOG_PATH, 'Oct 31 11:00:00 lab-host sshd[1]: x\n', { ino: 500 });
  const result = await source.read({ cursor: initial.nextCursor });
  assert.equal(result.status, 'rotated');
  assert.equal(result.rotation.reason, 'log_truncated');
  assert.equal(result.rotation.previousSize, Buffer.byteLength(fixture().content, 'utf8'));
});

test('a copy-truncate rotation that regrew past the old offset is still detected', async () => {
  const original = `${fixture().content}${fixture().appendAfterFirstRead}`;
  // Start from the head so the first read actually consumes lines and therefore stores the
  // last-line digest that makes content evidence possible on the next poll.
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: { content: original, ino: 700 } } }, {
    initialPosition: 'start',
  });
  const initial = await source.read();
  const oldOffset = initial.nextCursor.offset;
  assert.ok(oldOffset > 0);

  // The file was copied away and truncated, then grew again beyond the old offset with
  // different content. `size < offset` is false now, so only content evidence can catch it.
  // Aligned on a line boundary (so the cheap "is it a newline" check passes), with a short
  // last line whose content differs: only the stored last-line digest can catch this.
  const prefix = `AAAAAAAAAA\n${'x'.repeat(oldOffset - 12)}\n`;
  assert.equal(Buffer.byteLength(prefix, 'utf8'), oldOffset);
  const regrown = `${prefix}Oct 31 12:00:00 lab-host sshd[9]: after regrow\n`;
  fileSystem.write(LOG_PATH, regrown, { ino: 700 });

  const result = await source.read({ cursor: initial.nextCursor });
  assertReadResult(result, { stableSourceId: AUTH_LOG_SOURCE_ID });
  assert.equal(result.status, 'rotated');
  assert.equal(result.rotation.reason, 'log_truncated');
  assert.equal(result.rotation.detail, 'tail_changed');
  assert.deepEqual(result.records, []);
});

test('an idle poll does not erase the evidence a later copytruncate needs', async () => {
  const original = `${fixture().content}${fixture().appendAfterFirstRead}`;
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: { content: original, ino: 700 } } }, {
    initialPosition: 'start',
  });
  const first = await source.read();
  const offset = first.nextCursor.offset;

  // An auth log is idle most of the time: an empty poll must carry the digest forward.
  const idle = await source.read({ cursor: first.nextCursor });
  assert.deepEqual(idle.records, []);
  assert.equal(idle.nextCursor.tailDigest, first.nextCursor.tailDigest);

  const prefix = `AAAAAAAAAA\n${'x'.repeat(offset - 12)}\n`;
  assert.equal(Buffer.byteLength(prefix, 'utf8'), offset);
  fileSystem.write(LOG_PATH, `${prefix}Oct 31 12:00:00 lab-host sshd[9]: after regrow\n`, { ino: 700 });

  const result = await source.read({ cursor: idle.nextCursor });
  assert.equal(result.status, 'rotated', 'without the carried digest this would silently resume at the old offset');
  assert.equal(result.rotation.detail, 'tail_changed');
});

test('a very small file is still verified, and a long line does not disable the check', async () => {
  // 33 bytes: shorter than any line-based probe window.
  const small = 'Oct 31 10:00:01 h s[1]: x\n';
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: { content: small, ino: 700 } } }, {
    initialPosition: 'start',
  });
  const first = await source.read();
  assert.equal(first.nextCursor.offset, Buffer.byteLength(small, 'utf8'));

  const replaced = `${'z'.repeat(Buffer.byteLength(small) - 1)}\nmore\n`;
  fileSystem.write(LOG_PATH, replaced, { ino: 700 });
  const result = await source.read({ cursor: first.nextCursor });
  assert.equal(result.status, 'rotated');
  assert.equal(result.rotation.detail, 'tail_changed');

  // A single line longer than the 512-byte probe window.
  const long = `${'q'.repeat(700)}\n`;
  const longFs = createMemoryFileSystem({ files: { [LOG_PATH]: { content: long, ino: 701 } } });
  const longSource = createAuthLogSource({ fileSystem: longFs, clock: () => BASE, initialPosition: 'start' });
  const longFirst = await longSource.read();
  assert.equal(longFirst.records.length, 1);
  longFs.write(LOG_PATH, `${'w'.repeat(700)}\n`, { ino: 701 });
  const longResult = await longSource.read({ cursor: longFirst.nextCursor });
  assert.equal(longResult.status, 'rotated', 'a line longer than the probe window must not disable verification');
  assert.equal(longResult.rotation.detail, 'tail_changed');
});

test('the startup window is covered: a copytruncate right after start is detected', async () => {
  const original = `${fixture().content}${fixture().appendAfterFirstRead}`;
  const { fileSystem, source } = sourceFor({ files: { [LOG_PATH]: { content: original, ino: 700 } } });
  // Default initialPosition 'end': the first read consumes nothing but must still leave
  // content evidence, otherwise a rotation before the first poll is invisible.
  const first = await source.read();
  assert.deepEqual(first.records, []);
  assert.equal(typeof first.nextCursor.tailDigest, 'string', 'the init read must record the tail digest');

  const offset = first.nextCursor.offset;
  const prefix = `AAAAAAAAAA\n${'x'.repeat(offset - 12)}\n`;
  assert.equal(Buffer.byteLength(prefix, 'utf8'), offset);
  fileSystem.write(LOG_PATH, `${prefix}Oct 31 12:00:00 lab-host sshd[9]: after regrow\n`, { ino: 700 });

  const result = await source.read({ cursor: first.nextCursor });
  assert.equal(result.status, 'rotated');
  assert.equal(result.rotation.reason, 'log_truncated');
});

test('a cursor that points into the middle of a line is rejected, not resumed', async () => {
  const content = 'Oct 31 10:00:01 lab-host sshd[1]: first\nOct 31 10:00:02 lab-host sshd[2]: second\n';
  const { source } = sourceFor({ files: { [LOG_PATH]: { content, ino: 700 } } });
  await source.read();

  const result = await source.read({
    cursor: { path: LOG_PATH, fileId: '1:700', offset: 10, size: Buffer.byteLength(content) },
  });
  assert.equal(result.status, 'rotated');
  assert.equal(result.rotation.reason, 'log_truncated');
  assert.equal(result.rotation.detail, 'not_at_line_boundary');
});

test('a log line with invalid UTF-8 does not drift the byte offsets', async () => {
  // 0xFF is not valid UTF-8: decoding and re-encoding would turn it into three bytes.
  const first = 'Oct 31 10:00:01 lab-host sshd[1]: bad byte \u00ff here\n';
  const second = 'Oct 31 10:00:02 lab-host sshd[2]: second line\n';
  const { source } = sourceFor({ files: { [LOG_PATH]: { content: `${first}${second}`, ino: 700 } } }, {
    initialPosition: 'start',
  });
  const result = await source.read();

  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].sourceSequence, 0);
  assert.equal(result.records[1].sourceSequence, Buffer.byteLength(first, 'utf8'));
  assert.equal(result.nextCursor.offset, Buffer.byteLength(`${first}${second}`, 'utf8'));
});

test('a denied auth log is denied with the path named, never an empty success', async () => {
  const { source } = sourceFor({
    files: { [LOG_PATH]: fixture().content },
    denied: [LOG_PATH],
  });
  const result = await source.read();
  assertReadResult(result, { stableSourceId: AUTH_LOG_SOURCE_ID });

  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.permissions.missing, [LOG_PATH]);
});

test('a system without auth.log or secure is an error, not an empty healthy page', async () => {
  const { source } = sourceFor({ files: {} });
  const result = await source.read();
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.denials.every((denial) => denial.outcome === 'not_found'), true);
});

test('the second candidate path is used when the first does not exist', async () => {
  const { source } = sourceFor(
    { files: { '/var/log/secure': fixture().content } },
    { candidatePaths: ['/var/log/auth.log', '/var/log/secure'] },
  );
  const result = await source.read();
  assert.equal(result.status, 'ok');
  assert.equal(result.permissions.granted[0], '/var/log/secure');
  assert.equal(result.nextCursor.path, '/var/log/secure');
});

test('bounded reads stop at the byte cap and continue on the next poll without loss', async () => {
  const content = `${fixture().content}${fixture().appendAfterFirstRead}`;
  const { source } = sourceFor({ files: { [LOG_PATH]: content } }, {
    initialPosition: 'start',
    maxBytesPerRead: 120,
  });

  const collected = [];
  let cursor = null;
  for (let round = 0; round < 20; round += 1) {
    const batch = await source.read({ cursor });
    collected.push(...batch.records);
    cursor = batch.nextCursor;
    if (batch.hasMore !== true) {
      break;
    }
  }

  const positions = collected.map((record) => record.sourceSequence);
  const lines = content.split('\n').filter((line) => line.length > 0);
  assert.equal(positions.length, lines.length, 'every line is delivered exactly once across the chunked reads');
  assert.equal(new Set(positions).size, positions.length, 'no position is reused');
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(positions[index] > positions[index - 1], 'positions must strictly increase');
  }
});

test('a line that cannot be parsed is still preserved as evidence', async () => {
  const { source } = sourceFor({ files: { [LOG_PATH]: fixture().garbage } }, { initialPosition: 'start' });
  const result = await source.read();
  assert.equal(result.initialized, true, 'the first read also reads when it starts at the beginning');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.parsed, false);
  assert.match(result.records[0].payload.line, /random noise/);
  assert.equal(result.records[0].severity, 'info');
});
