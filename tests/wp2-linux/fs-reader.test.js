/**
 * The file-read abstraction is the boundary between "a Linux source read something" and "a
 * test touched the real machine". These tests pin down both implementations: the node-backed
 * one (against a temporary sandbox, never `/proc` or `/var/log`) and the memory-backed one
 * (against JSON fixtures).
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_READ_BYTES,
  classifyFsCode,
  createMemoryFileSystem,
  createNodeFileSystem,
  isExpectedFsFailure,
  isPermissionCode,
  normalizeVirtualPath,
} from '../../packages/collectors/linux/index.js';
import { createTestSandbox } from '../../packages/test-support/index.js';

test('classifyFsCode separates permission, missing, not-a-directory and io failures', () => {
  assert.equal(classifyFsCode('EACCES'), 'permission_denied');
  assert.equal(classifyFsCode('EPERM'), 'permission_denied');
  assert.equal(classifyFsCode('ENOENT'), 'not_found');
  assert.equal(classifyFsCode('ENOTDIR'), 'not_directory');
  assert.equal(classifyFsCode('EIO'), 'io_error');
  assert.equal(isPermissionCode('EACCES'), true);
  assert.equal(isPermissionCode('ENOENT'), false);
  assert.equal(isExpectedFsFailure('ENOENT'), true);
  assert.equal(isExpectedFsFailure('EACCES'), true);
  assert.equal(isExpectedFsFailure('EIO'), false);
});

test('virtual paths are normalized but never allowed to escape', () => {
  assert.equal(normalizeVirtualPath('/proc//1/stat'), '/proc/1/stat');
  assert.equal(normalizeVirtualPath('/etc/./crontab'), '/etc/crontab');
  assert.equal(normalizeVirtualPath('/'), '/');
  assert.throws(() => normalizeVirtualPath('/etc/../root/secret'), /must not contain '\.\.'/);
  assert.throws(() => normalizeVirtualPath('etc/crontab'), /must be absolute/);
});

test('the node file system reads inside an injected root without touching the real paths', async (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-linux-' });
  t.after(sandbox.cleanup);
  const root = join(sandbox.workRoot, 'root');
  mkdirSync(join(root, 'etc', 'cron.d'), { recursive: true });
  writeFileSync(join(root, 'etc', 'crontab'), 'SHELL=/bin/sh\n', 'utf8');
  writeFileSync(join(root, 'etc', 'cron.d', 'app'), '*/5 * * * * app /bin/true\n', 'utf8');

  const fileSystem = createNodeFileSystem({ root });

  const stat = await fileSystem.stat('/etc/crontab');
  assert.equal(stat.ok, true);
  assert.equal(stat.kind, 'file');
  assert.equal(stat.size, 'SHELL=/bin/sh\n'.length);

  const listing = await fileSystem.readDir('/etc');
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ['cron.d', 'crontab']);
  assert.equal(listing.entries.find((entry) => entry.name === 'cron.d').kind, 'directory');

  const content = await fileSystem.readText('/etc/crontab');
  assert.equal(content.ok, true);
  assert.equal(content.text, 'SHELL=/bin/sh\n');
  assert.equal(content.truncated, false);

  const missing = await fileSystem.stat('/etc/anacrontab');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'ENOENT');
  assert.equal(missing.outcome, 'not_found');

  const notDirectory = await fileSystem.readDir('/etc/crontab');
  assert.equal(notDirectory.ok, false);
  assert.equal(notDirectory.outcome, 'not_directory');

  // The default read cap exists so a log file cannot be pulled into memory unbounded.
  assert.equal(DEFAULT_MAX_READ_BYTES, 4 * 1024 * 1024);
});

test('offset and maxBytes produce the same slicing the auth log relies on', async (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-linux-' });
  t.after(sandbox.cleanup);
  const root = join(sandbox.workRoot, 'root');
  mkdirSync(join(root, 'var', 'log'), { recursive: true });
  writeFileSync(join(root, 'var', 'log', 'auth.log'), 'first line\nsecond line\nthird line\n', 'utf8');
  const fileSystem = createNodeFileSystem({ root });

  const head = await fileSystem.readText('/var/log/auth.log', { offset: 0, maxBytes: 11 });
  assert.equal(head.text, 'first line\n');
  assert.equal(head.truncated, true, 'a full buffer must be reported as possibly truncated');

  const tail = await fileSystem.readText('/var/log/auth.log', { offset: 11, maxBytes: 12 });
  assert.equal(tail.text, 'second line\n');
  assert.equal(tail.truncated, true);

  const rest = await fileSystem.readText('/var/log/auth.log', { offset: 23, maxBytes: 4096 });
  assert.equal(rest.text, 'third line\n');
  assert.equal(rest.truncated, false);
  assert.equal(rest.bytesRead, 11);
});

test('the memory file system reports permission denials as values, never as empty reads', async () => {
  const fileSystem = createMemoryFileSystem({
    files: {
      '/etc/passwd': 'root:x:0:0::/root:/bin/bash\n',
      '/var/log/auth.log': 'hidden\n',
    },
    denied: ['/var/log/auth.log', '/etc/ssl/private'],
    missing: ['/etc/anacrontab'],
  });

  const denied = await fileSystem.readText('/var/log/auth.log');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'EACCES');
  assert.equal(denied.outcome, 'permission_denied');

  // A denied directory denies its children, exactly like EACCES on the parent.
  const deniedChild = await fileSystem.stat('/etc/ssl/private/server.key');
  assert.equal(deniedChild.outcome, 'permission_denied');

  const missing = await fileSystem.readText('/etc/anacrontab');
  assert.equal(missing.outcome, 'not_found');

  const ok = await fileSystem.readText('/etc/passwd');
  assert.equal(ok.ok, true);
  assert.match(ok.text, /^root:/);
});

test('the memory file system derives directories from file paths and honours explicit listings', async () => {
  const fileSystem = createMemoryFileSystem({
    files: {
      '/proc/1/stat': '1 (systemd) S 0 1 1',
      '/proc/1/status': 'Name:\tsystemd\n',
      '/etc/cron.d/app': '*/5 * * * * app /bin/true\n',
    },
    directories: {
      '/proc': ['1', '2'],
      '/var/empty': [],
    },
  });

  const proc = await fileSystem.readDir('/proc');
  assert.deepEqual(proc.entries.map((entry) => entry.name), ['1', '2']);
  assert.equal(proc.entries[0].kind, 'directory');

  const empty = await fileSystem.readDir('/var/empty');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.entries, []);

  const derived = await fileSystem.readDir('/etc');
  assert.deepEqual(derived.entries.map((entry) => entry.name), ['cron.d']);

  const fileAsDir = await fileSystem.readDir('/etc/cron.d/app');
  assert.equal(fileAsDir.outcome, 'not_directory');
});

test('the memory file system can be mutated to model append, rotation and denial', async () => {
  const fileSystem = createMemoryFileSystem({
    files: { '/var/log/auth.log': 'a\n' },
  });

  assert.equal((await fileSystem.readText('/var/log/auth.log')).text, 'a\n');
  fileSystem.write('/var/log/auth.log', 'a\nb\n', { ino: 2 });
  assert.equal((await fileSystem.readText('/var/log/auth.log')).text, 'a\nb\n');
  assert.equal((await fileSystem.stat('/var/log/auth.log')).ino, 2);

  fileSystem.setDenied('/var/log/auth.log');
  assert.equal((await fileSystem.readText('/var/log/auth.log')).outcome, 'permission_denied');
  fileSystem.setDenied('/var/log/auth.log', false);
  assert.equal((await fileSystem.readText('/var/log/auth.log')).ok, true);

  fileSystem.remove('/var/log/auth.log');
  assert.equal((await fileSystem.stat('/var/log/auth.log')).outcome, 'not_found');
});

test('read instrumentation records which paths had their content read', async () => {
  const fileSystem = createMemoryFileSystem({
    files: {
      '/etc/passwd': 'root\n',
      '/etc/shadow': 'root:!:19000\n',
    },
  });

  await fileSystem.stat('/etc/passwd');
  await fileSystem.readText('/etc/shadow');
  const stats = fileSystem.stats();

  assert.equal(stats.stat, 1);
  assert.equal(stats.readText, 1);
  assert.deepEqual(stats.readPaths, ['/etc/shadow']);
  assert.equal(stats.bytes, 'root:!:19000\n'.length);

  fileSystem.resetStats();
  assert.equal(fileSystem.stats().readText, 0);
  assert.deepEqual(fileSystem.stats().readPaths, []);
});

test('the node file system refuses a traversal path before touching the disk', async (t) => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp2-linux-' });
  t.after(sandbox.cleanup);
  const fileSystem = createNodeFileSystem({ root: sandbox.workRoot });
  await assert.rejects(
    () => fileSystem.readText('/../escape'),
    (error) => error.name === 'LinuxCollectorError' && error.code === 'PATH_ESCAPE',
  );
});
