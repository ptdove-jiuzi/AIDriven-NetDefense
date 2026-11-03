/**
 * Declarative persistence sources: systemd units, cron, and declared directory metadata.
 *
 * The common thread is "declared but unreadable must still be reported": a spool crontab the
 * collector may not read, or a unit file behind a restrictive mode, produces a record that
 * says so instead of vanishing from the tree.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CRON_SOURCE_ID,
  DIRECTORY_SOURCE_ID,
  SYSTEMD_SOURCE_ID,
  assertReadResult,
  createCronSource,
  createDeclaredDirectorySource,
  createMemoryFileSystem,
  createSystemdUnitSource,
  parseCrontab,
  parseUnitContent,
} from '../../packages/collectors/linux/index.js';

const BASE = 1_700_000_000_000;

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

// ---------------------------------------------------------------- systemd units

test('unit content parsing keeps only the allowlisted keys', () => {
  const content = parseUnitContent([
    '[Unit]',
    'Description=OpenBSD Secure Shell server',
    'After=network.target',
    'Documentation=man:sshd(8)',
    '',
    '[Service]',
    'ExecStart=/usr/sbin/sshd -D',
    'ExecStartPre=-/usr/sbin/sshd -t',
    'EnvironmentFile=-/etc/default/ssh',
    'AmbientCapabilities=CAP_NET_BIND_SERVICE',
  ].join('\n'));

  assert.equal(content.Description, 'OpenBSD Secure Shell server');
  assert.equal(content.ExecStart, '/usr/sbin/sshd -D');
  assert.equal(content.ExecStartPre, '-/usr/sbin/sshd -t');
  assert.equal(content.EnvironmentFile, '-/etc/default/ssh');
  assert.equal(content.Documentation, undefined, 'non-allowlisted keys must not leak through');
  assert.equal(content.AmbientCapabilities, undefined);
});

test('the first systemd read reports units, masked state and enablement links', async () => {
  const fileSystem = createMemoryFileSystem(fixture('systemd.json'));
  const source = createSystemdUnitSource({ fileSystem, clock: () => BASE });
  const result = await source.read();
  assertReadResult(result, { stableSourceId: SYSTEMD_SOURCE_ID });

  assert.equal(result.snapshot, true);
  const byName = new Map(result.records.map((record) => [record.payload.unit_name, record.payload]));
  assert.deepEqual([...byName.keys()].sort(), [
    'apt-daily.service',
    'blocked.service',
    'evil.timer',
    'sshd.service',
  ]);

  assert.equal(byName.get('blocked.service').masked, true);
  assert.equal(byName.get('blocked.service').link_target, '/dev/null');
  assert.equal(byName.get('sshd.service').masked, false);
  assert.equal(byName.get('sshd.service').enabled, true);
  assert.deepEqual(byName.get('sshd.service').enabled_by, ['/etc/systemd/system/multi-user.target.wants']);
  assert.equal(byName.get('evil.timer').enabled, true);
  assert.equal(byName.get('apt-daily.service').origin, 'vendor');
  assert.equal(byName.get('sshd.service').origin, 'etc');
  assert.equal(byName.get('sshd.service').unit_type, '.service');
});

test('unit content is not read unless it is explicitly enabled', async () => {
  const fileSystem = createMemoryFileSystem(fixture('systemd.json'));
  const withoutContent = createSystemdUnitSource({ fileSystem, clock: () => BASE });
  const plain = await withoutContent.read();
  assert.deepEqual(fileSystem.stats().readPaths, [], 'metadata-only must not open a single unit file');
  assert.equal(plain.records.every((record) => record.payload.content_json === undefined), true);

  const contentFileSystem = createMemoryFileSystem(fixture('systemd.json'));
  const withContent = createSystemdUnitSource({
    fileSystem: contentFileSystem,
    clock: () => BASE,
    includeContent: true,
  });
  const detailed = await withContent.read();
  const sshd = detailed.records.find((record) => record.payload.unit_name === 'sshd.service');
  // DEF-04：payload 只接受标量，单元内容以一条 JSON 字符串承载（可逆，不丢字段）。
  const content = JSON.parse(sshd.payload.content_json);
  assert.equal(content.Description, 'OpenBSD Secure Shell server');
  assert.equal(content.ExecStart, '/usr/sbin/sshd -D $SSHD_OPTS');
  assert.ok(contentFileSystem.stats().readPaths.length > 0);
});

test('an unreadable unit file degrades the read instead of dropping the unit', async () => {
  const fileSystem = createMemoryFileSystem(fixture('systemd.json'));
  const source = createSystemdUnitSource({ fileSystem, clock: () => BASE });
  const result = await source.read();

  assert.equal(result.status, 'partial');
  assert.ok(result.denials.some((denial) => denial.path === '/etc/systemd/system/denied.service'));
  // The other units are still published, and the denied one has no record at all, which is
  // why the denial list (not the record count) is the signal.
  assert.equal(result.records.length, 4);
});

test('a changed unit file is a changed record, an unchanged read emits nothing', async () => {
  const fileSystem = createMemoryFileSystem(fixture('systemd.json'));
  const source = createSystemdUnitSource({ fileSystem, clock: () => BASE });
  await source.read();

  const quiet = await source.read();
  assert.deepEqual(quiet.records, []);

  fileSystem.write('/etc/systemd/system/evil.timer', '[Unit]\nDescription=Housekeeping\n', { mtimeMs: BASE + 60_000 });
  const changed = await source.read();
  assert.equal(changed.records.length, 1);
  assert.equal(changed.records[0].payload.change, 'changed');
  assert.equal(changed.records[0].payload.unit_name, 'evil.timer');
});

test('systemd reports a denied directory, an empty host and a missing path differently', async () => {
  const denied = createSystemdUnitSource({
    fileSystem: createMemoryFileSystem({ denied: ['/etc/systemd/system', '/usr/lib/systemd/system', '/run/systemd/system'] }),
    clock: () => BASE,
  });
  const deniedResult = await denied.read();
  assert.equal(deniedResult.status, 'denied');
  assert.equal(deniedResult.permissions.missing.length, 3);

  const empty = createSystemdUnitSource({
    fileSystem: createMemoryFileSystem({ directories: { '/etc/systemd/system': [], '/usr/lib/systemd/system': [] } }),
    clock: () => BASE,
  });
  const emptyResult = await empty.read();
  assert.equal(emptyResult.status, 'error');
  assert.equal(emptyResult.errorCode, 'EMPTY_UNIT_TABLE');

  const missing = createSystemdUnitSource({ fileSystem: createMemoryFileSystem({}), clock: () => BASE });
  const missingResult = await missing.read();
  assert.equal(missingResult.status, 'error');
  assert.equal(missingResult.error.code, 'ENOENT');
});

// ---------------------------------------------------------------- cron

test('crontab parsing handles system crontabs, specials, env lines and comments', () => {
  const parsed = parseCrontab(fixture('cron.json').files['/etc/crontab'].content);

  assert.equal(parsed.variables, 2);
  assert.equal(parsed.malformed.length, 0);
  assert.equal(parsed.entries.length, 3);

  const [hourly, daily, reboot] = parsed.entries;
  assert.equal(hourly.schedule, '17 * * * *');
  assert.equal(hourly.user, 'root');
  assert.equal(hourly.command, 'cd / && run-parts --report /etc/cron.hourly');
  assert.equal(daily.schedule, '25 6 * * *');
  assert.equal(reboot.schedule, '@reboot');
  assert.equal(reboot.special, true);
  assert.equal(reboot.user, 'root');
  assert.equal(reboot.command, '/usr/local/bin/agent.sh --daemon');
});

test('a user spool crontab has no user column, and a short line is malformed', () => {
  const parsed = parseCrontab('0 3 * * * /usr/local/bin/job.sh\n1 2 *\n', { hasUserField: false });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].user, null);
  assert.equal(parsed.entries[0].command, '/usr/local/bin/job.sh');
  assert.equal(parsed.malformed.length, 1);
  assert.equal(parsed.malformed[0].lineNumber, 2);
});

test('the first cron read publishes file rows and entry rows', async () => {
  const fileSystem = createMemoryFileSystem(fixture('cron.json'));
  const source = createCronSource({ fileSystem, clock: () => BASE });
  const result = await source.read();
  assertReadResult(result, { stableSourceId: CRON_SOURCE_ID });

  const entries = result.records.filter((record) => record.type === 'linux.cron.entry');
  const files = result.records.filter((record) => record.type === 'linux.cron.file');
  assert.equal(entries.length, 4, '/etc/crontab 3 entries + /etc/cron.d/app 1 entry');
  assert.ok(files.length >= 4);

  const reboot = entries.find((record) => record.payload.schedule === '@reboot');
  assert.equal(reboot.payload.user, 'root');
  assert.equal(reboot.payload.command, '/usr/local/bin/agent.sh --daemon');
  assert.equal(reboot.payload.present, true);
});

test('a denied spool directory is published as an unreadable row, not as an empty one', async () => {
  const fileSystem = createMemoryFileSystem(fixture('cron.json'));
  const source = createCronSource({ fileSystem, clock: () => BASE });
  const result = await source.read();

  assert.equal(result.status, 'partial');
  assert.ok(result.denials.some((denial) => denial.path === '/var/spool/cron/crontabs'));
  const spoolRow = result.records.find((record) => record.payload.path === '/var/spool/cron/crontabs');
  assert.equal(spoolRow.payload.readable, false, 'a declared-but-denied directory must stay visible');
  assert.equal(spoolRow.payload.error_code, 'EACCES');
});

test('cron script directories contribute metadata only, never content', async () => {
  const fileSystem = createMemoryFileSystem(fixture('cron.json'));
  const source = createCronSource({ fileSystem, clock: () => BASE });
  const result = await source.read();

  const backup = result.records.find((record) => record.payload.path === '/etc/cron.hourly/backup');
  assert.equal(backup.payload.kind, 'script');
  assert.equal(backup.payload.executable, true);
  assert.equal(backup.payload.command, undefined);
  assert.equal(fileSystem.stats().readPaths.includes('/etc/cron.hourly/backup'), false);

  const logrotate = result.records.find((record) => record.payload.path === '/etc/cron.daily/logrotate');
  assert.equal(logrotate.payload.kind, 'script');
});

test('a removed cron entry is reported as removed', async () => {
  const fileSystem = createMemoryFileSystem(fixture('cron.json'));
  const source = createCronSource({ fileSystem, clock: () => BASE });
  await source.read();

  fileSystem.write('/etc/cron.d/app', '# application tick\n');
  const after = await source.read();
  const removed = after.records.filter((record) => record.payload.change === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].type, 'linux.cron.entry');
  assert.equal(removed[0].payload.schedule, '*/5 * * * *');
  assert.equal(removed[0].payload.present, false);
});

test('a host without any declared cron path is an error, not an empty success', async () => {
  const source = createCronSource({
    fileSystem: createMemoryFileSystem({}),
    clock: () => BASE,
  });
  const result = await source.read();
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'EMPTY_CRON_TABLE');
});

test('the file cap degrades the read instead of silently truncating the tree', async () => {
  const fileSystem = createMemoryFileSystem(fixture('cron.json'));
  const source = createCronSource({ fileSystem, clock: () => BASE, maxFiles: 1, maxEntries: 1 });
  const result = await source.read();
  assert.equal(result.status, 'partial');
  assert.equal(result.stats.capped, true);
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------- declared directories

test('declared directories are metadata only unless hashing is enabled', async () => {
  const fileSystem = createMemoryFileSystem(fixture('directories.json'));
  const source = createDeclaredDirectorySource({ fileSystem, clock: () => BASE, roots: ['/etc'] });
  const result = await source.read();
  assertReadResult(result, { stableSourceId: DIRECTORY_SOURCE_ID });

  assert.deepEqual(fileSystem.stats().readPaths, [], 'no content is read for metadata records');
  const passwd = result.records.find((record) => record.payload.path === '/etc/passwd');
  assert.equal(passwd.payload.kind, 'file');
  assert.equal(passwd.payload.sha256, undefined);
  assert.equal(passwd.payload.rel_path, 'passwd');

  const localtime = result.records.find((record) => record.payload.path === '/etc/localtime');
  assert.equal(localtime.payload.kind, 'symlink');
  assert.equal(localtime.payload.link_target, '/usr/share/zoneinfo/UTC');

  const hashed = createDeclaredDirectorySource({
    fileSystem: createMemoryFileSystem(fixture('directories.json')),
    clock: () => BASE,
    roots: ['/etc'],
    includeContentHash: true,
  });
  const hashedResult = await hashed.read();
  const hashedPasswd = hashedResult.records.find((record) => record.payload.path === '/etc/passwd');
  assert.match(hashedPasswd.payload.sha256, /^[0-9a-f]{64}$/);
});

test('a denied entry inside a readable root keeps the root usable and the read partial', async () => {
  const fileSystem = createMemoryFileSystem(fixture('directories.json'));
  const source = createDeclaredDirectorySource({ fileSystem, clock: () => BASE, roots: ['/etc'] });
  const result = await source.read();

  assert.equal(result.status, 'partial');
  assert.ok(result.denials.some((denial) => denial.path === '/etc/shadow'));
  assert.ok(result.records.some((record) => record.payload.path === '/etc/passwd'));
  // The denied file has no record, so the denial list is the only place it appears.
  assert.equal(result.records.some((record) => record.payload.path === '/etc/shadow'), false);
});

test('recursion is opt-in and depth limited', async () => {
  const fileSystem = createMemoryFileSystem(fixture('directories.json'));
  const flat = await createDeclaredDirectorySource({ fileSystem, clock: () => BASE, roots: ['/etc'] }).read();
  assert.equal(flat.records.some((record) => record.payload.path === '/etc/ssh/sshd_config'), false);

  const recursive = await createDeclaredDirectorySource({
    fileSystem: createMemoryFileSystem(fixture('directories.json')),
    clock: () => BASE,
    roots: ['/etc'],
    recursive: true,
    maxDepth: 1,
  }).read();
  assert.equal(recursive.records.some((record) => record.payload.path === '/etc/ssh/sshd_config'), true);
  assert.equal(recursive.records.some((record) => record.payload.path === '/etc/ssh'), true);
});

test('an unchanged tree emits nothing and an edited file emits one changed record', async () => {
  const fileSystem = createMemoryFileSystem(fixture('directories.json'));
  const source = createDeclaredDirectorySource({ fileSystem, clock: () => BASE, roots: ['/etc'] });
  await source.read();

  const quiet = await source.read();
  assert.deepEqual(quiet.records, []);

  fileSystem.write('/etc/ld.so.preload', '/tmp/evil.so\n');
  const added = await source.read();
  assert.equal(added.records.length, 1);
  assert.equal(added.records[0].payload.change, 'changed');
  assert.equal(added.records[0].payload.path, '/etc/ld.so.preload');
});

test('a root that cannot be listed at all is denied, and a declared root that is absent is not', async () => {
  const denied = await createDeclaredDirectorySource({
    fileSystem: createMemoryFileSystem({ denied: ['/etc'] }),
    clock: () => BASE,
    roots: ['/etc'],
  }).read();
  assert.equal(denied.status, 'denied');
  assert.deepEqual(denied.permissions.missing, ['/etc']);

  const absent = await createDeclaredDirectorySource({
    fileSystem: createMemoryFileSystem({ files: { '/srv/data/x': 'x' } }),
    clock: () => BASE,
    roots: ['/opt/missing', '/srv/data'],
  }).read();
  assert.equal(absent.status, 'ok');
  assert.equal(absent.records.some((record) => record.payload.path === '/srv/data/x'), true);
});

test('roots beyond the configured maximum are rejected and reported, never silently scanned', async () => {
  const fileSystem = createMemoryFileSystem({
    files: { '/srv/a/x': 'x', '/srv/b/y': 'y', '/srv/c/z': 'z' },
  });
  const source = createDeclaredDirectorySource({
    fileSystem,
    clock: () => BASE,
    roots: ['/srv/a', '/srv/b', '/srv/c'],
    maxRoots: 2,
  });
  const result = await source.read();

  assert.deepEqual([...source.rejectedRoots], ['/srv/c']);
  assert.deepEqual([...result.rejectedRoots], ['/srv/c']);
  assert.equal(result.status, 'partial');
  assert.equal(result.records.some((record) => record.payload.path === '/srv/c/z'), false);
});

test('a declared root over the hard cap cannot even be configured', async () => {
  const roots = Array.from({ length: 33 }, (_, index) => `/srv/r${index}`);
  assert.throws(
    () => createDeclaredDirectorySource({ fileSystem: createMemoryFileSystem({}), roots }),
    /at most 32 declared roots/,
  );
});
