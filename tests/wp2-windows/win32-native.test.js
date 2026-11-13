// author: PT-dove
// PERF-CPU / fix-col-hot: regression guard for the koffi -> Win32 native table reader.
//
// Three layers:
// 1) formatting (canonical IPv6 / port byte order / FILETIME) - these values go straight into
//    entityId and payload, so an off-by-one spelling is a whole-table identity drift;
// 2) the provider - an unavailable koffi must raise a classified error, never return an
//    empty table (an empty table is a legitimate read and must stay distinguishable);
// 3) the sources - a healthy native read must not touch PowerShell at all (steady-state
//    spawn count 0), and a failed native read must fall back and say so in stats.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WIN32_ERROR_CODES,
  Win32CollectorError,
  createConnectionsSource,
  createProcessSource,
  createWin32Provider,
  fileTimeToEpochMs,
  formatIPv4,
  formatIPv6,
  portFromDword,
} from '../../packages/collectors/windows/index.js';

const CREATED = 1_699_000_000_000;

function wmiRow(overrides = {}) {
  return {
    ProcessId: 1234,
    ParentProcessId: 4,
    Name: 'demo.exe',
    ExecutablePath: 'C:\\Program Files\\Demo\\demo.exe',
    CommandLine: '"C:\\Program Files\\Demo\\demo.exe" --flag',
    CreationDate: CREATED,
    ...overrides,
  };
}

function countingClient(table) {
  const state = { calls: 0 };
  return {
    state,
    client: {
      async runJson() {
        state.calls += 1;
        return table;
      },
    },
  };
}

const IPV6_CASES = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], '::'],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], '::1'],
  [[0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08], 'fe80::102:304:506:708'],
  [[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], '2001:db8::1'],
  // A single zero group must not be shortened (RFC 5952 4.2.3).
  [[0x20, 0x01, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], '2001:0:1::1'],
  // Two equal-length runs: the first one collapses (RFC 5952 4.2.2).
  [[0, 1, 0, 0, 0, 0, 0, 2, 0, 3, 0, 0, 0, 0, 0, 4], '1::2:3:0:0:4'],
  // IPv4-mapped keeps its dotted tail, which is what .NET prints.
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1], '::ffff:127.0.0.1'],
];

test('IPv6 is rendered in the canonical spelling .NET prints, and that spelling carries the identity', () => {
  for (const [bytes, expected] of IPV6_CASES) {
    assert.equal(formatIPv6(bytes), expected);
  }
});

test('IPv4 and ports are decoded from the network byte order the MIB tables store', () => {
  // 127.0.0.1 = 0x0100007F little-endian on the wire.
  assert.equal(formatIPv4(0x0100007f), '127.0.0.1');
  assert.equal(formatIPv4(0), '0.0.0.0');
  assert.equal(formatIPv4(0x0200a8c0), '192.168.0.2');
  // The port is stored as the network-order value read as a little-endian DWORD: the wire is
  // 00 50 for port 80 (0x5000), BB 01 for 443 (0xBB01), 14 E9 for 5353 (0xE914).
  assert.equal(portFromDword(0x00005000), 80);
  assert.equal(portFromDword(0x0000bb01), 443);
  assert.equal(portFromDword(0x0000e914), 5353);
});

test('FILETIME becomes epoch milliseconds, and a zero timestamp stays "unknown"', () => {
  assert.equal(fileTimeToEpochMs(0n), null, 'a zero FILETIME is not 1601-01-01');
  const ticks = BigInt(CREATED + 11_644_473_600_000) * 10_000n;
  assert.equal(fileTimeToEpochMs(ticks), CREATED);
  assert.equal(fileTimeToEpochMs(ticks + 9_999n), CREATED, 'sub-millisecond ticks are truncated');
});

test('the native provider reports an unavailable library instead of an empty table', async () => {
  const provider = createWin32Provider({
    load: async () => {
      throw new Win32CollectorError(
        WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE,
        'koffi is not loadable',
      );
    },
  });

  const ready = await provider.ready();
  assert.equal(ready.ok, false);
  assert.equal(ready.errorCode, WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE);

  await assert.rejects(() => provider.readProcessTable(), (error) => {
    assert.equal(error.code, WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE);
    return true;
  });
  assert.equal(provider.stats().failures >= 1, true);
});

test('a healthy native process read never starts PowerShell', async () => {
  // A stand-in with the provider contract: the assertion is about the wiring inside the
  // source, not about the host's kernel tables (those are covered by the integration test).
  const native = {
    transport: 'win32-koffi',
    async readProcessTable() {
      return [wmiRow()];
    },
  };
  const { state, client } = countingClient([]);
  const source = createProcessSource({ win32: native, powershell: client, clock: () => CREATED });

  const result = await source.read();

  assert.equal(state.calls, 0, 'the script transport must not be touched when the native read works');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.pid, 1234);
  assert.equal(result.stats.transport, 'win32-koffi');
  assert.equal(result.stats.fallback, null);
});

test('a failed native read falls back to the script transport and says so', async () => {
  const native = createWin32Provider({
    load: async () => {
      throw new Win32CollectorError(WIN32_ERROR_CODES.CALL_FAILED, 'NtQuerySystemInformation failed');
    },
  });
  const { state, client } = countingClient([wmiRow({ ProcessId: 4321 })]);
  const source = createProcessSource({ win32: native, powershell: client, clock: () => CREATED });

  const result = await source.read();

  assert.equal(state.calls, 1, 'the fallback must actually read the table');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.pid, 4321);
  assert.equal(result.stats.transport, 'powershell');
  assert.equal(result.stats.fallback.from, 'win32-koffi');
  assert.equal(result.stats.fallback.to, 'powershell');
  assert.equal(result.stats.fallback.errorCode, WIN32_ERROR_CODES.CALL_FAILED);
});

test('without a script client a native failure is surfaced, never swallowed', async () => {
  const native = createWin32Provider({
    load: async () => {
      throw new Win32CollectorError(WIN32_ERROR_CODES.CALL_FAILED, 'boom');
    },
  });
  const source = createProcessSource({ win32: native, clock: () => CREATED });
  await assert.rejects(() => source.read(), (error) => error.code === WIN32_ERROR_CODES.CALL_FAILED);
});

test('the connections source prefers the native endpoint tables and reports its transport', async () => {
  const native = {
    transport: 'win32-koffi',
    async readEndpointTable() {
      return {
        tcp: [{
          localAddress: '0.0.0.0',
          localPort: 445,
          remoteAddress: '0.0.0.0',
          remotePort: 0,
          state: 'Listen',
          owningProcess: 4,
          creationTime: CREATED,
        }],
        udp: [{ localAddress: '::', localPort: 5353, owningProcess: 2708 }],
      };
    },
  };
  const { state, client } = countingClient({ tcp: [], udp: [] });
  const source = createConnectionsSource({
    win32: native,
    powershell: client,
    // The 60 s Bound supplement has its own client; giving it an empty one keeps this
    // assertion about the *table* transport, not about the supplement beat.
    supplementPowershell: { runJson: async () => ({ tcp: [], udp: [] }) },
    clock: () => CREATED,
  });

  const result = await source.read();

  assert.equal(state.calls, 0);
  assert.equal(result.stats.tcp, 1);
  assert.equal(result.stats.udp, 1);
  assert.equal(result.stats.transport, 'win32-koffi');
  const tcp = result.records.find((record) => record.payload.protocol === 'tcp');
  assert.equal(tcp.payload.state, 'listen', 'the cmdlet enum spelling must normalize to the old token');
  assert.equal(tcp.payload.remote_port, 0);
});

test('the connections source falls back to the cmdlet script when the native read fails', async () => {
  const native = createWin32Provider({
    load: async () => {
      throw new Win32CollectorError(WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE, 'iphlpapi missing');
    },
  });
  const { state, client } = countingClient({
    tcp: [{
      localAddress: '127.0.0.1',
      localPort: 5000,
      remoteAddress: '127.0.0.1',
      remotePort: 5001,
      state: 'Established',
      owningProcess: 99,
      creationTime: CREATED,
    }],
    udp: [],
  });
  const source = createConnectionsSource({ win32: native, powershell: client, clock: () => CREATED });

  const result = await source.read();

  assert.equal(state.calls, 1);
  assert.equal(result.stats.transport, 'powershell');
  assert.equal(result.stats.fallback.errorCode, WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE);
  assert.equal(result.stats.tcp, 1);
  assert.equal(result.records[0].payload.state, 'established');
});

test('the real kernel tables answer on this Windows host', { skip: process.platform !== 'win32' ? 'needs Windows' : false }, async () => {
  const provider = createWin32Provider();
  const ready = await provider.ready();
  assert.deepEqual(ready, { ok: true, errorCode: null, message: null });

  const processes = await provider.readProcessTable();
  assert.equal(processes.length > 0, true);
  const current = processes.find((row) => row.ProcessId === process.pid);
  assert.ok(current, 'our own process must be in the table');
  assert.equal(current.CreationDate > 0, true, 'a creation time is required for the entity identity');
  assert.equal(typeof current.Name, 'string');
  assert.equal(Number.isSafeInteger(current.ParentProcessId), true);
  assert.match(current.ExecutablePath ?? '', /node(\.exe)?$/iu, 'the PEB image path is our own executable');

  const endpoints = await provider.readEndpointTable();
  assert.equal(Array.isArray(endpoints.tcp), true);
  assert.equal(Array.isArray(endpoints.udp), true);
  assert.equal(endpoints.tcp.length > 0, true, 'a host always has at least one TCP endpoint');
  const states = new Set();
  for (const row of endpoints.tcp.slice(0, 256)) {
    assert.equal(row.localPort >= 0 && row.localPort <= 65_535, true);
    assert.equal(typeof row.state, 'string');
    assert.equal(row.state.length > 0, true);
    assert.equal(Number.isSafeInteger(row.owningProcess), true);
    assert.equal(typeof row.localAddress, 'string');
    states.add(row.state);
  }
  assert.equal(states.has('Listen'), true, 'a listener must exist and be spelled like the cmdlet enum');
  for (const row of endpoints.udp.slice(0, 256)) {
    assert.equal(row.localPort >= 0 && row.localPort <= 65_535, true);
    assert.equal(typeof row.localAddress, 'string');
  }
});

// ---------------------------------------------------------------------------------------
// state=Bound supplement: the kernel tables cannot see bound-but-idle sockets, the NetTCPIP
// cmdlet can. It runs once a minute, its rows are cached, and every poll merges the cache
// through the ordinary normalizer - so a supplemented row keeps the entityId and payload it
// always had, and a failed refresh never empties the snapshot.
// ---------------------------------------------------------------------------------------

function boundRow(port, pid) {
  return {
    localAddress: '0.0.0.0',
    localPort: port,
    remoteAddress: '0.0.0.0',
    remotePort: 0,
    state: 'Bound',
    owningProcess: pid,
    creationTime: CREATED,
  };
}

function nativeWithOneListener() {
  return {
    transport: 'win32-koffi',
    async readEndpointTable() {
      return {
        tcp: [{
          localAddress: '0.0.0.0',
          localPort: 445,
          remoteAddress: '0.0.0.0',
          remotePort: 0,
          state: 'Listen',
          owningProcess: 4,
          creationTime: CREATED,
        }],
        udp: [],
      };
    },
  };
}

test('the supplement caches Bound rows and every poll merges them through the same normalizer', async () => {
  const client = {
    calls: 0,
    async runJson() {
      this.calls += 1;
      return {
        tcp: [boundRow(49_485, 10_000), boundRow(51_116, 5_116), { ...boundRow(445, 4), state: 'Listen' }],
        udp: [],
      };
    },
  };
  const source = createConnectionsSource({
    win32: nativeWithOneListener(),
    supplementPowershell: client,
    clock: () => CREATED,
  });

  const refreshed = await source.refreshSupplement();
  assert.deepEqual(refreshed, { ok: true, errorCode: null, rows: 2 }, 'only Bound rows are cached');

  const result = await source.read();
  assert.equal(client.calls, 1, 'the read itself must not start a second interpreter');
  assert.equal(result.stats.tcp, 3, 'one native listener plus two supplemented rows');
  assert.equal(result.stats.nativeTcp, 1);
  assert.equal(result.stats.supplementedTcp, 2);
  assert.equal(result.stats.supplement.enabled, true);
  assert.equal(result.stats.supplement.polls, 1);
  assert.equal(result.stats.supplement.cachedRows, 2);
  assert.equal(result.stats.supplement.ok, true);

  const bound = result.records.filter((record) => record.payload.state === 'bound');
  assert.equal(bound.length, 2);
  for (const record of bound) {
    assert.equal(record.payload.protocol, 'tcp');
    assert.equal(record.payload.remote_port, 0);
    assert.match(record.nativeRecordId, /^[A-Za-z0-9._:-]+$/u);
  }
});

test('a failed supplement keeps the cache, reports the error and never fails the poll', async () => {
  let fail = false;
  const client = {
    async runJson() {
      if (fail) {
        const error = new Error('the NetTCPIP cmdlet did not answer in time');
        error.code = 'TIMEOUT';
        throw error;
      }
      return { tcp: [boundRow(49_485, 10_000)], udp: [] };
    },
  };
  const source = createConnectionsSource({
    win32: nativeWithOneListener(),
    supplementPowershell: client,
    clock: () => CREATED,
  });

  await source.refreshSupplement();
  fail = true;
  const failed = await source.refreshSupplement();
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'TIMEOUT');

  const result = await source.read();
  assert.equal(result.stats.tcp, 2, 'the cached Bound row must survive a failed refresh');
  assert.equal(result.stats.supplement.ok, false);
  assert.equal(result.stats.supplement.errorCode, 'TIMEOUT');
  assert.equal(result.stats.supplement.cachedRows, 1);
  assert.equal(result.records.length > 0, true, 'the native rows still produce a snapshot');
});

test('the supplement runs on its own beat, not on every 5 s poll', async () => {
  let now = CREATED;
  const client = {
    calls: 0,
    async runJson() {
      this.calls += 1;
      return { tcp: [boundRow(49_485, 10_000)], udp: [] };
    },
  };
  const source = createConnectionsSource({
    win32: nativeWithOneListener(),
    supplementPowershell: client,
    clock: () => now,
    intervalMs: 5_000,
  });

  const first = await source.read();
  assert.equal(first.stats.supplement.polls, 1, 'the first poll warms the cache');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.calls, 1);

  for (let poll = 0; poll < 5; poll += 1) {
    now += 5_000;
    await source.read();
  }
  assert.equal(client.calls, 1, 'five more polls inside the 60 s window must not spawn anything');

  now += 61_000;
  const afterBeat = await source.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(afterBeat.stats.supplement.polls, 2, 'the beat fires once the interval elapsed');
  assert.equal(client.calls, 2, 'exactly one interpreter start per beat');
});
