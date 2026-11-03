/**
 * procfs network table source: address decoding, socket identity, owner association and the
 * difference between "no sockets" and "no table we were allowed to read".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CONNECTION_SOURCE_ID,
  DEFAULT_NET_ROOT,
  assertReadResult,
  createMemoryFileSystem,
  createProcfsConnectionSource,
  decodeIpv4,
  decodeIpv6,
  parseNetTable,
  scanSocketOwners,
} from '../../packages/collectors/linux/index.js';

const BASE = 1_700_000_000_000;

function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

function sourceFor(name, options = {}) {
  const fileSystem = createMemoryFileSystem(fixture(name));
  const source = createProcfsConnectionSource({ fileSystem, clock: () => BASE, ...options });
  return { fileSystem, source };
}

test('IPv4 addresses are decoded from the little-endian hex of procfs', () => {
  assert.equal(decodeIpv4('0100007F'), '127.0.0.1');
  assert.equal(decodeIpv4('00000000'), '0.0.0.0');
  assert.equal(decodeIpv4('5DB8D822'), '34.216.184.93');
  assert.throws(() => decodeIpv4('123'), /malformed IPv4 hex/);
});

test('IPv6 addresses are decoded from four little-endian words and compressed', () => {
  assert.equal(decodeIpv6('00000000000000000000000000000000'), '::');
  assert.equal(decodeIpv6('00000000000000000000000001000000'), '::1');
  // ::ffff:127.0.0.1 — the bytes inside each word are reversed, the word order is not.
  assert.equal(decodeIpv6('0000000000000000FFFF00000100007F'), '::ffff:7f00:1');
  assert.throws(() => decodeIpv6('00'), /malformed IPv6 hex/);
});

test('parseNetTable keeps good rows and counts the malformed ones', () => {
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 123456 1',
    '   1: broken-row',
    '   2: 0100007F:C1A4 5DB8D822:01BB 01 0000000A:0000001F 00:00000000 00000000  1000        0 123457 1',
  ].join('\n');

  const parsed = parseNetTable(table, { protocol: 'tcp', family: 'ipv4' });
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.malformed, 1);

  const listening = parsed.rows[0];
  assert.equal(listening.state, 'listen');
  assert.equal(listening.localPort, 8080);
  assert.equal(listening.inode, 123456);

  const established = parsed.rows[1];
  assert.equal(established.state, 'established');
  assert.equal(established.remotePort, 443);
  assert.equal(established.txQueue, 10);
  assert.equal(established.rxQueue, 31);
});

test('socket owners are resolved from /proc/<pid>/fd and non-socket descriptors are ignored', async () => {
  const fileSystem = createMemoryFileSystem(fixture('net.json'));
  const scan = await scanSocketOwners({ fileSystem });

  assert.equal(scan.ok, true);
  assert.equal(scan.owners.get(123456).pid, 1000);
  assert.equal(scan.owners.get(123456).name, 'nginx');
  assert.equal(scan.owners.get(123458).name, 'sshd');
  assert.equal(scan.owners.has(123459), false, 'udp socket has no fd in the fixture');
  assert.equal(scan.denied, 1, 'the unreadable fd directory is counted, not silently skipped');
});

test('the first read publishes every socket with an inode-based identity', async () => {
  const { source } = sourceFor('net.json');
  const result = await source.read();
  assertReadResult(result, { stableSourceId: CONNECTION_SOURCE_ID });

  assert.equal(result.snapshot, true);
  assert.equal(result.records.length, 5);
  for (const record of result.records) {
    assert.equal(record.type, 'linux.connection');
  }

  const listener = result.records.find((record) => record.payload.inode === 123456);
  assert.equal(listener.payload.protocol, 'tcp');
  assert.equal(listener.payload.local_port, 8080);
  assert.equal(listener.payload.state, 'listen');
  assert.equal(listener.payload.pid, 1000);
  assert.equal(listener.payload.process_name, 'nginx');
  assert.equal(listener.payload.owner_resolved, true);
  assert.match(listener.nativeRecordId, /^tcp4-123456-/);

  const v6 = result.records.find((record) => record.payload.family === 'ipv6');
  assert.equal(v6.payload.local_address, '::1');
  assert.equal(v6.payload.pid, 2001);
  assert.match(v6.nativeRecordId, /^tcp6-123458-/);

  const timeWait = result.records.find((record) => record.payload.state === 'time_wait');
  assert.equal(timeWait.payload.inode, 0);
  assert.match(timeWait.nativeRecordId, /^tcp4-q-/);
  assert.equal(timeWait.payload.owner_resolved, false);
});

test('an unreadable fd directory costs the pid fields, not the whole read', async () => {
  const { source } = sourceFor('net.json');
  const result = await source.read();

  // Another user's /proc/<pid>/fd is unreadable for a non-root collector by design. That is
  // declared `admin` completeness for pid/processName, so it must surface as a field gap and
  // must not degrade the whole socket table: otherwise every non-root host stays permanently
  // partial and the real degradation signal drowns.
  assert.equal(result.status, 'ok');
  assert.equal(result.stats.ownerScan.denied, 1);
  assert.deepEqual([...result.fieldGaps], ['pid', 'process_name']);
  assert.deepEqual(result.denials, []);
  assert.equal(result.records.length, 5, 'every socket is still published');
});

test('queue-only changes do not produce an event, a state change does', async () => {
  const { fileSystem, source } = sourceFor('net.json');
  await source.read();

  const original = fixture('net.json').files['/proc/net/tcp'].content;
  // Only the tx/rx queue columns change.
  fileSystem.write('/proc/net/tcp', original.replace('01 0000000A:00000000', '01 0000FFFF:0000FFFF'));
  const quiet = await source.read();
  assert.deepEqual(quiet.records, [], 'queue depth is excluded from the state digest');

  fileSystem.write('/proc/net/tcp', original.replace('5DB8D822:01BB 01', '5DB8D822:01BB 08'));
  const changed = await source.read();
  const transitions = changed.records.filter((record) => record.payload.inode === 123457);
  assert.equal(transitions.length, 1, 'the inode identity is stable, so a state change is one changed record');
  assert.equal(transitions[0].payload.change, 'changed');
  assert.equal(transitions[0].payload.state, 'close_wait');
});

test('a socket that disappears is reported as removed', async () => {
  const { fileSystem, source } = sourceFor('net.json');
  await source.read();
  const udp = fixture('net.json').files['/proc/net/udp'].content;
  fileSystem.write('/proc/net/udp', udp.split('\n').filter((line) => !line.includes('0035')).join('\n'));

  const after = await source.read();
  const removed = after.records.filter((record) => record.payload.change === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].payload.inode, 123459);
});

test('without owner resolution the sockets still appear, with pid null', async () => {
  const { source } = sourceFor('net.json', { resolveOwners: false });
  const result = await source.read();
  assert.equal(result.records.length, 5);
  for (const record of result.records) {
    // DEF-04：payload 拒绝 null，未解析出属主的 socket 直接**没有** pid 键。
    assert.equal('pid' in record.payload, false);
    assert.equal(record.payload.owner_resolved, false);
  }
});

test('a missing table is a host blind spot, all tables missing is an error', async () => {
  const partialFileSystem = createMemoryFileSystem({
    files: {
      '/proc/net/tcp': fixture('net.json').files['/proc/net/tcp'].content,
    },
  });
  const partial = await createProcfsConnectionSource({
    fileSystem: partialFileSystem,
    clock: () => BASE,
    resolveOwners: false,
  }).read();
  // IPv6 compiled out, or no udp6 in this namespace: the host genuinely has no such table,
  // so this is not a degraded read. It stays visible in stats.
  assert.equal(partial.status, 'ok');
  assert.equal(partial.stats.missingTables, 3);

  const emptyFileSystem = createMemoryFileSystem({ files: {} });
  const error = await createProcfsConnectionSource({
    fileSystem: emptyFileSystem,
    clock: () => BASE,
    resolveOwners: false,
  }).read();
  assert.equal(error.status, 'error');
  assert.equal(error.errorCode, 'ENOENT');
  assert.deepEqual(error.records, []);
});

test('a denied table directory is denied, never an empty socket list', async () => {
  const fileSystem = createMemoryFileSystem({
    files: {
      '/proc/net/tcp': '',
    },
    denied: [DEFAULT_NET_ROOT],
  });
  const result = await createProcfsConnectionSource({
    fileSystem,
    clock: () => BASE,
    resolveOwners: false,
  }).read();

  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.permissions.missing, [DEFAULT_NET_ROOT]);
});

test('a readable but empty table is a valid ok read', async () => {
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  const fileSystem = createMemoryFileSystem({
    files: {
      '/proc/net/tcp': header,
      '/proc/net/tcp6': header,
      '/proc/net/udp': header,
      '/proc/net/udp6': header,
    },
  });
  const result = await createProcfsConnectionSource({
    fileSystem,
    clock: () => BASE,
    resolveOwners: false,
  }).read();

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.records, []);
  assert.equal(result.stats.rows, 0);
});
