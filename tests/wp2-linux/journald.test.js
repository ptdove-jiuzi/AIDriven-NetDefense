/**
 * journald adapter.
 *
 * Every journal line in this file comes from `fixtures/journald-output.json`; the command
 * runner is scripted, so no test can ever execute a real `journalctl`. The argv the adapter
 * builds is asserted explicitly, which is what keeps that promise checkable.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AUTH_IDENTIFIERS,
  JOURNALD_SOURCE_ID,
  assertReadResult,
  classifyJournalctlFailure,
  createJournaldAuthSource,
  createJournaldSource,
  createScriptedCommandRunner,
  nativeIdForCursor,
  parseJournaldEntry,
  parseJournaldOutput,
  severityForPriority,
} from '../../packages/collectors/linux/index.js';

const BASE = 1_700_000_000_000;

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

/** Render the fixture as the JSON-lines stream journalctl would print. */
function journalStdout({ includeRaw = false } = {}) {
  const data = fixture('journald-output.json');
  const lines = data.entries.map((entry) => JSON.stringify(entry));
  if (includeRaw) {
    lines.push(...data.rawLines);
  }
  return `${lines.join('\n')}\n`;
}

test('syslog priorities map onto the shared severity scale', () => {
  assert.equal(severityForPriority(0), 'critical');
  assert.equal(severityForPriority(2), 'critical');
  assert.equal(severityForPriority(3), 'high');
  assert.equal(severityForPriority(4), 'medium');
  assert.equal(severityForPriority(5), 'low');
  assert.equal(severityForPriority(6), 'info');
  assert.equal(severityForPriority(7), 'info');
  assert.equal(severityForPriority('nonsense'), 'info');
});

test('a cursor becomes a key-safe native record id', () => {
  const cursor = 's=9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e;i=1b2c;b=7f00;m=5a1b2c;t=5f0a1b2c3d4e5;x=9d2e7c1a5b3f';
  const id = nativeIdForCursor(cursor);
  assert.match(id, /^j[0-9a-f]{32}$/);
  assert.equal(id.includes(':'), false, 'a native record id must not contain the key delimiter');
  assert.equal(nativeIdForCursor(cursor), id, 'the same cursor must always produce the same id');
  assert.throws(() => nativeIdForCursor(''), /non-empty string/);
});

test('a journal entry keeps the identity, the timestamp and a truncated message', () => {
  const data = fixture('journald-output.json');
  const entry = parseJournaldEntry(data.entries[0], { maxMessageChars: 20 });
  assert.equal(entry.priority, 4);
  assert.equal(entry.severity, 'medium');
  assert.equal(entry.severityName, 'warning');
  assert.equal(entry.identifier, 'sshd');
  assert.equal(entry.unit, 'ssh.service');
  assert.equal(entry.pid, 812);
  assert.equal(entry.observedAtMs, 1_700_000_000_123);
  assert.equal(entry.messageTruncated, true);
  assert.equal(entry.message.length, 20);
});

test('a binary MESSAGE becomes hex, not mojibake', () => {
  const data = fixture('journald-output.json');
  const entry = parseJournaldEntry(data.entries[3]);
  assert.equal(entry.messageEncoding, 'hex');
  assert.equal(entry.message, '68656c6c6f00ff');
  assert.equal(entry.messageBytes, 7);
});

test('an entry without a cursor is dropped from parsing, because it has no stable identity', () => {
  const data = fixture('journald-output.json');
  assert.equal(parseJournaldEntry(data.entries[4]), null);
});

test('parseJournaldOutput counts malformed and cursorless lines without discarding the batch', () => {
  const parsed = parseJournaldOutput(journalStdout({ includeRaw: true }));
  assert.equal(parsed.entries.length, 5);
  assert.equal(parsed.malformed, 2);
  assert.equal(parsed.withoutCursor, 1);
});

test('journalctl failures are classified from stderr, not from the exit code alone', () => {
  assert.deepEqual(
    classifyJournalctlFailure({ stderr: 'Failed to seek to cursor s=abc: Invalid argument', code: 1 }),
    { kind: 'invalid_cursor', resetCursor: true },
  );
  assert.equal(
    classifyJournalctlFailure({ stderr: 'Journal file access denied', code: 1 }).kind,
    'permission_denied',
  );
  assert.equal(
    classifyJournalctlFailure({ stderr: 'No journal files were found.', code: 1 }).kind,
    'permission_denied',
  );
  assert.deepEqual(
    classifyJournalctlFailure({ stderr: 'some other failure', code: 2 }),
    { kind: 'io_error', resetCursor: false, code: 2 },
  );
});

test('the adapter refuses to build without an injected runner', () => {
  assert.throws(() => createJournaldSource({}), /command runner exposing run\(\)/);
});

test('a read builds an allowlisted journalctl argv and parses only fixture content', async () => {
  const runner = createScriptedCommandRunner([
    { match: ['--lines=500'], stdout: journalStdout() },
  ]);
  const source = createJournaldSource({ runner, clock: () => BASE });
  const result = await source.read();
  assertReadResult(result, { stableSourceId: JOURNALD_SOURCE_ID });

  assert.equal(runner.calls().length, 1);
  const [call] = runner.calls();
  assert.equal(call.executable, 'journalctl');
  // --quiet is intentionally absent: it would suppress the only visibility hint journalctl
  // prints for a non-root account that cannot see the system journal.
  assert.deepEqual(call.args.slice(0, 3), ['--no-pager', '--output=json', '--system']);
  assert.equal(call.args.includes('--quiet'), false);
  assert.ok(call.args.some((arg) => arg.startsWith('--output-fields=')));
  assert.equal(call.args.includes('--lines=500'), true);
  assert.equal(call.args.some((arg) => arg.startsWith('--after-cursor=')), false);

  // The fixture deliberately contains one cursorless entry, which makes the page partial:
  // a record without a cursor has no stable identity and must not be published.
  assert.equal(result.status, 'partial');
  assert.equal(result.stats.withoutCursor, 1);
  assert.equal(result.records.length, 5);
  assert.equal(result.nextCursor.cursor, 's=9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e;i=1b30;b=7f00112233445566778899aabbccddee;m=5a1b60;t=5f0a1b2c3d800;x=9d2e7c1a5b43');
  assert.equal(result.backlogRisk, false);
});

test('a page where every record carries a cursor is a clean ok read', async () => {
  const data = fixture('journald-output.json');
  const clean = `${data.entries.slice(0, 3).map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const runner = createScriptedCommandRunner([{ stdout: clean }]);
  const result = await createJournaldSource({ runner, clock: () => BASE }).read();
  assertReadResult(result, { stableSourceId: JOURNALD_SOURCE_ID });
  assert.equal(result.status, 'ok');
  assert.equal(result.stats.malformed, 0);
  assert.equal(result.stats.withoutCursor, 0);
  assert.equal(result.records.length, 3);
});

test('authentication identifiers become linux.auth, everything else linux.journal', async () => {
  const runner = createScriptedCommandRunner([{ stdout: journalStdout() }]);
  const result = await createJournaldSource({ runner, clock: () => BASE }).read();

  const byCursor = new Map(result.records.map((record) => [record.payload.identifier, record]));
  assert.equal(byCursor.get('sshd').type, 'linux.auth');
  assert.equal(byCursor.get('sudo').type, 'linux.auth');
  assert.equal(byCursor.get('cron').type, 'linux.auth');
  assert.equal(byCursor.get('systemd').type, 'linux.journal');
  assert.equal(byCursor.get('kernel').type, 'linux.journal');
  assert.equal(byCursor.get('sshd').severity, 'medium');
  assert.equal(byCursor.get('kernel').severity, 'high');
});

test('a persisted cursor is sent as --after-cursor on the next read', async () => {
  const first = createScriptedCommandRunner([{ stdout: journalStdout() }]);
  const source = createJournaldSource({ runner: first, clock: () => BASE });
  const initial = await source.read();

  const second = createScriptedCommandRunner([{ stdout: '' }]);
  const next = createJournaldSource({ runner: second, clock: () => BASE });
  const result = await next.read({ cursor: initial.nextCursor });

  const [call] = second.calls();
  assert.ok(
    call.args.includes(`--after-cursor=${initial.nextCursor.cursor}`),
    'the stored cursor must be replayed verbatim',
  );
  assert.deepEqual(result.records, []);
  // An empty page keeps the cursor instead of resetting it to null.
  assert.equal(result.nextCursor.cursor, initial.nextCursor.cursor);
});

test('a full page is flagged as backlog risk, because journalctl tail-anchors the page', async () => {
  const runner = createScriptedCommandRunner([{ stdout: journalStdout() }]);
  const result = await createJournaldSource({ runner, clock: () => BASE, maxRecordsPerRead: 5 }).read();
  assert.equal(result.records.length, 5);
  assert.equal(result.backlogRisk, true);
});

test('an unreadable journal is denied with a named permission, never an empty page', async () => {
  const runner = createScriptedCommandRunner([
    { stdout: '', stderr: 'Journal file access denied', exitCode: 1 },
  ]);
  const result = await createJournaldSource({ runner, clock: () => BASE }).read();
  assertReadResult(result, { stableSourceId: JOURNALD_SOURCE_ID });

  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.equal(result.permissions.missing.length, 1);
  assert.match(result.permissions.missing[0], /systemd-journal group/);
  assert.equal(result.resetCursor, false);
  assert.equal(result.nextCursor, null);
});

test('an invalidated cursor asks the runtime for a generation reset', async () => {
  const runner = createScriptedCommandRunner([
    { stdout: '', stderr: 'Failed to seek to cursor s=dead: Invalid argument', exitCode: 1 },
  ]);
  const result = await createJournaldSource({ runner, clock: () => BASE })
    .read({ cursor: { cursor: 's=dead', lastRealtimeUs: null } });

  assert.equal(result.status, 'error');
  assert.equal(result.resetCursor, true);
  assert.equal(result.errorCode, 'invalid_cursor');
  assert.deepEqual(result.records, []);
});

test('the probe proves visibility by fetching one record, not by fetching zero', async () => {
  const data = fixture('journald-output.json');
  const one = `${JSON.stringify(data.entries[0])}\n`;
  const ok = createScriptedCommandRunner([{ stdout: one }]);
  const healthy = await createJournaldSource({ runner: ok, clock: () => BASE }).probe();
  assert.equal(healthy.ok, true);
  // `--lines=0` would prove nothing: a blind account also sees zero lines.
  assert.equal(ok.calls()[0].args.includes('--lines=1'), true);

  const denied = createScriptedCommandRunner([
    { stdout: '', stderr: 'Failed to open journal: Permission denied', exitCode: 1 },
  ]);
  const unhealthy = await createJournaldSource({ runner: denied, clock: () => BASE }).probe();
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.code, 'permission_denied');

  // Exit 0 with no record is still blindness, so the probe must not pass.
  const empty = createScriptedCommandRunner([{ stdout: '' }]);
  const blind = await createJournaldSource({ runner: empty, clock: () => BASE }).probe();
  assert.equal(blind.ok, false);
  assert.equal(blind.code, 'empty_journal');
});

test('a zero exit that carries the visibility hint is a denied read, not a healthy page', async () => {
  const hint = 'Hint: You are currently not seeing messages from other users and the system.\n'
    + '      Users in groups adm, systemd-journal can see all messages.\n';
  const runner = createScriptedCommandRunner([{ stdout: '', stderr: hint, exitCode: 0 }]);
  const result = await createJournaldSource({ runner, clock: () => BASE }).read();
  assertReadResult(result, { stableSourceId: JOURNALD_SOURCE_ID });

  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.match(result.permissions.missing[0], /systemd-journal/);
  assert.equal(result.errorCode, 'permission_denied');
});

test('a first read with no entry at all is denied, because a readable journal always has one', async () => {
  const runner = createScriptedCommandRunner([{ stdout: '', stderr: '', exitCode: 0 }]);
  const result = await createJournaldSource({ runner, clock: () => BASE }).read();
  assertReadResult(result, { stableSourceId: JOURNALD_SOURCE_ID });

  assert.equal(result.status, 'denied');
  assert.equal(result.errorCode, 'EMPTY_JOURNAL');
  assert.match(result.permissions.missing[0], /systemd-journal/);
});

test('the auth variant filters on the identifier list and always emits linux.auth', async () => {
  const runner = createScriptedCommandRunner([{ stdout: journalStdout() }]);
  const source = createJournaldAuthSource({ runner, clock: () => BASE });
  const result = await source.read();

  const [call] = runner.calls();
  const filters = call.args.filter((arg) => arg.startsWith('--identifier='));
  assert.equal(filters.length, AUTH_IDENTIFIERS.length);
  assert.ok(filters.includes('--identifier=sshd'));
  assert.equal(source.descriptor.stableSourceId, 'linux.auth.journald');
  assert.equal(source.descriptor.kind, 'event');
  assert.ok(result.records.length > 0);
});

test('malformed lines make the read partial but keep the good records', async () => {
  const runner = createScriptedCommandRunner([{ stdout: journalStdout({ includeRaw: true }) }]);
  const result = await createJournaldSource({ runner, clock: () => BASE }).read();
  assert.equal(result.status, 'partial');
  assert.equal(result.records.length, 5);
  assert.equal(result.stats.malformed, 2);
  assert.equal(result.stats.withoutCursor, 1);
});

test('the scripted runner fails loudly instead of silently reaching a real binary', async () => {
  const runner = createScriptedCommandRunner([]);
  await assert.rejects(
    () => createJournaldSource({ runner, clock: () => BASE }).read(),
    /scripted runner has no outcome for/,
  );
});
