import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTIONS_SCRIPT,
  CONNECTIONS_SOURCE_ID,
  addressToken,
  connectionsDescriptor,
  createConnectionsSource,
} from '../../packages/collectors/windows/index.js';
import { createClock, createScriptedPowerShell } from './helpers.js';

const CREATED = 1_699_000_000_000;

function tcp(overrides = {}) {
  return {
    localAddress: '10.0.0.5',
    localPort: 51515,
    remoteAddress: '93.184.216.34',
    remotePort: 443,
    state: 5,
    owningProcess: 4321,
    creationTime: `/Date(${CREATED})/`,
    ...overrides,
  };
}

function udp(overrides = {}) {
  return { localAddress: '0.0.0.0', localPort: 5353, owningProcess: 1234, ...overrides };
}

test('the connection script reads both endpoint tables and never interpolates input', () => {
  assert.match(CONNECTIONS_SCRIPT, /^# aegis-source:connections/mu);
  assert.match(CONNECTIONS_SCRIPT, /Get-NetTCPConnection/u);
  assert.match(CONNECTIONS_SCRIPT, /Get-NetUDPEndpoint/u);
  assert.equal(/Invoke-Expression|\biex\b|Start-Process|\.Invoke\(/u.test(CONNECTIONS_SCRIPT), false);
  assert.equal(/\$\{/u.test(CONNECTIONS_SCRIPT), false, 'no subexpression expansion belongs in a collector script');
});

test('the descriptor declares the short-lived connection blind spot and the attribution loss', () => {
  const descriptor = connectionsDescriptor();
  assert.equal(descriptor.stableSourceId, CONNECTIONS_SOURCE_ID);
  assert.equal(descriptor.intervalMs, 5_000);
  assert.equal(descriptor.blindSpots.some((entry) => /opens and closes between two polls/u.test(entry)), true);
  assert.match(descriptor.permissions.degradedWithout[0], /attribution/u);
  const pidField = descriptor.fields.find((field) => field.name === 'pid');
  assert.equal(pidField.completeness, 'best_effort');
});

test('a numeric TCP state enum and a textual state both normalize to one token', async () => {
  const powershell = createScriptedPowerShell({
    connections: {
      tcp: [tcp({ localPort: 1 }), tcp({ localPort: 2, state: 'Established' }), tcp({ localPort: 3, state: '6' })],
      udp: [],
    },
  });
  const source = createConnectionsSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();

  const states = result.records.map((record) => record.payload.state);
  assert.deepEqual(states.sort(), ['established', 'established', 'fin_wait1']);
});

test('OwningProcess 0 is reported as unattributed instead of pointing at the idle process', async () => {
  const powershell = createScriptedPowerShell({
    connections: { tcp: [tcp({ owningProcess: 0, state: 11 })], udp: [] },
  });
  const source = createConnectionsSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();

  const record = result.records[0];
  assert.equal(record.payload.attribution, 'unavailable');
  assert.equal('pid' in record.payload, false, 'pid must be absent, never 0');
  assert.equal(record.payload.state, 'time_wait');
  // A kernel-owned socket is normal on every host, so it is counted but not declared as a
  // degraded field: doing so would mark the source partial on every single cycle.
  assert.deepEqual([...result.degradedFields], []);
  assert.equal(result.stats.unattributed, 1);
});

test('IPv6 addresses that used to collide produce distinct entities', async () => {
  const powershell = createScriptedPowerShell({
    connections: {
      tcp: [
        tcp({ localAddress: '2001:db8::1', remoteAddress: '::1' }),
        tcp({ localAddress: '2001-db8--1', remoteAddress: '::1' }),
      ],
      udp: [],
    },
  });
  const source = createConnectionsSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();

  assert.equal(result.records.length, 2, 'two sockets must not collapse into one identity');
  assert.notEqual(addressToken('2001:db8::1'), addressToken('2001-db8--1'));
});

test('a UDP endpoint keeps a constant digest so only presence changes emit', async () => {
  const clock = createClock(CREATED);
  const routes = { connections: { tcp: [], udp: [udp()] } };
  const source = createConnectionsSource({ powershell: createScriptedPowerShell(routes), clock });

  const first = await source.read();
  assert.equal(first.snapshot, true);
  assert.equal(first.records[0].payload.protocol, 'udp');
  assert.equal('remote_address' in first.records[0].payload, false, 'UDP has no remote peer');

  const second = await source.read();
  assert.deepEqual(second.records, [], 'an unchanged UDP endpoint must not re-emit');
});

test('a closed TCP connection is reported as removed', async () => {
  const clock = createClock(CREATED);
  const routes = { connections: { tcp: [tcp()], udp: [] } };
  const source = createConnectionsSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.connections = { tcp: [], udp: [] };
  const result = await source.read();

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.change, 'removed');
  assert.equal(result.records[0].payload.present, false);
});

test('a single-object tcp table is accepted and a null table is an empty read', async () => {
  const single = createConnectionsSource({
    powershell: createScriptedPowerShell({ connections: { tcp: tcp(), udp: null } }),
    clock: createClock(CREATED),
  });
  assert.equal((await single.read()).records.length, 1);

  const none = createConnectionsSource({
    powershell: createScriptedPowerShell({ connections: null }),
    clock: createClock(CREATED),
  });
  const empty = await none.read();
  assert.deepEqual(empty.records, []);
  assert.equal(empty.identity, null);
});

test('a socket re-attributed to another pid is a change on the same entity, not a new socket', async () => {
  const clock = createClock(CREATED);
  const routes = { connections: { tcp: [tcp({ owningProcess: 100 })], udp: [] } };
  const source = createConnectionsSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.connections = { tcp: [tcp({ owningProcess: 200 })], udp: [] };
  const result = await source.read();

  assert.equal(result.records.length, 1, 'the 5-tuple did not change, so the identity did not change');
  assert.equal(result.records[0].payload.change, 'changed');
  assert.equal(result.records[0].payload.pid, 200);
});

test('a listening socket reports its real remote port 0 rather than dropping the field', async () => {
  const powershell = createScriptedPowerShell({
    connections: { tcp: [tcp({ state: 2, remoteAddress: '0.0.0.0', remotePort: 0 })], udp: [] },
  });
  const source = createConnectionsSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();

  assert.equal(result.records[0].payload.state, 'listen');
  assert.equal(result.records[0].payload.remote_port, 0);
  assert.equal(result.records[0].payload.remote_address, '0.0.0.0');
});
