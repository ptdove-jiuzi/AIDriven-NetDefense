/**
 * procfs process source: parsing, identity, diffing and — most importantly — what happens
 * when the collector is not allowed to see everything.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CLOCK_TICKS_PER_SECOND,
  PROCESS_SOURCE_ID,
  assertReadResult,
  createMemoryFileSystem,
  createProcfsProcessSource,
  parseBtime,
  parseCmdline,
  parseProcStat,
  parseProcStatus,
} from '../../packages/collectors/linux/index.js';

const BASE = 1_700_000_000_000;

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

function sourceFor(name, options = {}) {
  const fileSystem = createMemoryFileSystem(fixture(name));
  const source = createProcfsProcessSource({ fileSystem, clock: () => BASE, ...options });
  return { fileSystem, source };
}

test('parseProcStat survives a comm containing spaces and parentheses', () => {
  const parsed = parseProcStat('5150 (weird ) name) R 4242 5150 5150 0 -1 4194304 10 0 0 0 1 0 0 0 20 0 1 0 1500 1000 100');
  assert.equal(parsed.pid, 5150);
  assert.equal(parsed.comm, 'weird ) name');
  assert.equal(parsed.state, 'R');
  assert.equal(parsed.ppid, 4242);
  assert.equal(parsed.threads, 1);
  // Field 22 is starttime: the boot-relative identity component.
  assert.equal(parsed.startTicks, 1500);
  assert.throws(() => parseProcStat('not a stat line'), /missing the \(comm\) field/);
});

test('parseProcStatus takes the effective uid, not the real one', () => {
  const status = parseProcStatus('Name:\tsshd\nUid:\t0\t1000\t1000\t1000\nGid:\t0\t1000\t1000\t1000\nThreads:\t4\nVmRSS:\t  900 kB\n');
  assert.equal(status.name, 'sshd');
  assert.equal(status.uid, 1000);
  assert.equal(status.gid, 1000);
  assert.equal(status.threads, 4);
  assert.equal(status.vmRssKb, 900);
});

test('parseCmdline joins argv and reports an empty vector as null', () => {
  assert.equal(parseCmdline('postgres\0-D\0/var/lib/data\0'), 'postgres -D /var/lib/data');
  assert.equal(parseCmdline('\0'), null);
  assert.equal(parseCmdline(''), null);
});

test('parseBtime reads the boot second out of /proc/stat', () => {
  assert.equal(parseBtime('cpu 1 2 3 4\nbtime 1699990000\nprocesses 1\n'), 1699990000);
  assert.equal(parseBtime('cpu 1 2 3 4\n'), null);
});

test('the first read emits one snapshot batch with boot-relative start times', async () => {
  const { source } = sourceFor('procfs.json');
  const result = await source.read();
  assertReadResult(result, { stableSourceId: PROCESS_SOURCE_ID });

  assert.equal(result.status, 'ok');
  assert.equal(result.snapshot, true);
  assert.equal(result.records.length, 3);
  for (const record of result.records) {
    assert.equal(record.type, 'linux.process');
    assert.equal(record.payload.change, 'snapshot');
    assert.equal(record.payload.present, true);
  }

  const init = result.records.find((record) => record.payload.pid === 1);
  assert.equal(init.payload.ppid, 0);
  assert.equal(init.payload.name, 'systemd');
  assert.equal(init.payload.uid, 0);
  assert.equal(init.payload.cmdline, '/sbin/init');
  assert.equal(init.payload.exe_path, '/usr/lib/systemd/systemd');
  // btime 1699990000 s + starttime 12 ticks * 10 ms
  assert.equal(init.payload.start_time, new Date(1_699_990_000_000 + 12 * (1000 / CLOCK_TICKS_PER_SECOND)).toISOString());

  const slippery = result.records.find((record) => record.payload.pid === 5150);
  assert.equal(slippery.payload.name, 'weird ) name');
  assert.equal(slippery.payload.cmdline, 'sh -c sleep 1');
});

test('identity is pid plus starttime, so a recycled pid is a different entity', async () => {
  const { fileSystem, source } = sourceFor('procfs.json');
  await source.read();

  // Same pid, different starttime: a new process that reused the pid.
  fileSystem.write('/proc/4242/stat', '4242 (postgres) S 1 4131 4131 0 -1 4194304 200 0 0 0 10 5 0 0 20 0 12 0 9999 300000 4000\n');
  const second = await source.read();
  const changes = second.records.filter((record) => record.payload.pid === 4242);
  assert.equal(changes.length, 2, 'a recycled pid must appear as one removal and one addition');
  assert.deepEqual(changes.map((record) => record.payload.change).sort(), ['added', 'removed']);
});

test('two identical reads emit nothing at all, and a content change emits changed', async () => {
  const { fileSystem, source } = sourceFor('procfs.json');
  await source.read();

  const quiet = await source.read();
  assert.deepEqual(quiet.records, []);

  fileSystem.write('/proc/4242/cmdline', 'postgres\0-D\0/srv/data\0');
  const changed = await source.read();
  assert.equal(changed.records.length, 1);
  assert.equal(changed.records[0].payload.change, 'changed');
  assert.equal(changed.records[0].payload.cmdline, 'postgres -D /srv/data');
});

test('a process that disappears is reported as removed, not silently dropped', async () => {
  const { fileSystem, source } = sourceFor('procfs.json');
  await source.read();
  fileSystem.remove('/proc/5150/stat');
  fileSystem.remove('/proc/5150/status');
  fileSystem.remove('/proc/5150/cmdline');
  fileSystem.remove('/proc/5150/exe');

  const after = await source.read();
  const removed = after.records.filter((record) => record.payload.change === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].payload.pid, 5150);
  assert.equal(removed[0].payload.present, false);
});

test('a restricted cmdline is a field gap, not a degraded read', async () => {
  const { source } = sourceFor('procfs-restricted.json');
  const result = await source.read();
  assertReadResult(result, { stableSourceId: PROCESS_SOURCE_ID });

  // cmdline/exe of another user's process is declared `admin` completeness. Reporting that as
  // "degraded" would make every non-root collector permanently degraded, which hides the
  // real degradation signal; it is reported as a field gap instead.
  assert.equal(result.status, 'ok');
  assert.deepEqual([...result.fieldGaps], ['cmdline', 'exe_path']);
  assert.equal(result.records.length, 2, 'the visible processes are still published');
  const restricted = result.records.find((record) => record.payload.pid === 4242);
  assert.equal(restricted.payload.restricted, true);
  assert.equal('cmdline' in restricted.payload, false, 'a null field is omitted, not carried');
  // "(deleted)" is stripped so the path stays comparable across reads.
  assert.equal(restricted.payload.exe_path, '/usr/lib/postgresql/16/bin/postgres');
  assert.equal(result.fieldDenials.length, 1);
  assert.equal(result.fieldDenials[0].field, 'cmdline');
  assert.deepEqual(result.denials, []);
});

test('a pid that becomes unreadable is not reported as removed', async () => {
  const { fileSystem, source } = sourceFor('procfs-restricted.json');
  const first = await source.read();
  assert.equal(first.status, 'ok');
  assert.equal(first.records.length, 2);

  // The pid was visible before and its own stat is now denied: "gone" and "invisible" are
  // indistinguishable, so publishing a removal would fabricate negative evidence.
  fileSystem.setDenied('/proc/4242/stat');
  const second = await source.read();
  assert.equal(second.status, 'partial');
  assert.ok(second.denials.some((denial) => denial.path === '/proc/4242/stat'));
  assert.deepEqual(second.records, []);
  assert.equal(second.suppressedRemovals, 1);
});

test('a denied /proc/<pid>/status is a structural denial, not a silent null', async () => {
  // procfs.json: nothing is denied to begin with, so any fieldGaps must come from this test.
  const { fileSystem, source } = sourceFor('procfs.json');
  const first = await source.read();
  assert.equal(first.status, 'ok');
  assert.deepEqual([...first.fieldGaps], []);

  // uid/gid/threads are declared `always`: losing them degrades the read instead of quietly
  // turning them into nulls, and it must not be reported as a cmdline/exe field gap.
  fileSystem.setDenied('/proc/4242/status');
  const second = await source.read();
  assert.equal(second.status, 'partial');
  assert.ok(second.denials.some((denial) => denial.path === '/proc/4242/status'));
  assert.deepEqual([...second.fieldGaps], [], 'a status denial is structural, not an admin-field gap');

  const denied = second.records.find((record) => record.payload.pid === 4242);
  if (denied !== undefined) {
    // DEF-04：null 不能进 payload，缺失的 uid 以"键不存在"表达。
    assert.equal('uid' in denied.payload, false);
    assert.equal(denied.payload.status_denied, true);
  }
});

test('a denied /proc is reported as denied with a named missing permission', async () => {
  const { source } = sourceFor('procfs-denied.json');
  const result = await source.read();
  assertReadResult(result, { stableSourceId: PROCESS_SOURCE_ID });

  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.permissions.missing, ['/proc']);
  assert.equal(result.errorCode, 'EACCES');
});

test('an empty /proc that was listed successfully is treated as denied, never as a healthy empty table', async () => {
  const fileSystem = createMemoryFileSystem({ directories: { '/proc': [] } });
  const source = createProcfsProcessSource({ fileSystem, clock: () => BASE });
  const result = await source.read();

  assert.equal(result.status, 'denied');
  assert.equal(result.errorCode, 'EMPTY_PROC_TABLE');
  assert.match(result.permissions.missing[0], /no visible process entries/);
  assert.deepEqual(result.records, []);
});

test('a boot id folds into the entity id so a reboot cannot collide', async () => {
  const first = createProcfsProcessSource({
    fileSystem: createMemoryFileSystem(fixture('procfs.json')),
    clock: () => BASE,
    bootId: '7f00112233445566778899aabbccddee',
  });
  const second = createProcfsProcessSource({
    fileSystem: createMemoryFileSystem(fixture('procfs.json')),
    clock: () => BASE,
    bootId: '0123456789abcdef0123456789abcdef',
  });

  const a = await first.read();
  const b = await second.read();
  const initIds = [a, b].map((result) => result.records.find((record) => record.payload.pid === 1).nativeRecordId);
  assert.notEqual(initIds[0], initIds[1]);
  // Without a boot id the entity falls back to a stable placeholder tag.
  const noBoot = createProcfsProcessSource({
    fileSystem: createMemoryFileSystem(fixture('procfs.json')),
    clock: () => BASE,
  });
  const c = await noBoot.read();
  assert.match(c.records.find((record) => record.payload.pid === 1).nativeRecordId, /^noboot-1-12-/);
});

test('a malformed stat row is skipped without failing the whole read', async () => {
  const fileSystem = createMemoryFileSystem({
    files: {
      '/proc/1/stat': 'garbage without parens',
      '/proc/2/stat': '2 (bash) S 1 2 2 0 -1 4194304 10 0 0 0 1 0 0 0 20 0 1 0 40 1000 100\n',
      '/proc/2/status': 'Name:\tbash\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n',
      '/proc/2/cmdline': 'bash\0',
    },
  });
  const source = createProcfsProcessSource({ fileSystem, clock: () => BASE });
  const result = await source.read();
  assert.equal(result.status, 'ok');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.pid, 2);
});
