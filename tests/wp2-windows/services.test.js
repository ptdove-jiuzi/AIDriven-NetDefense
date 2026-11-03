import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVICES_SCRIPT,
  SERVICES_SOURCE_ID,
  createServicesSource,
  servicesDescriptor,
} from '../../packages/collectors/windows/index.js';
import { createClock, createScriptedPowerShell } from './helpers.js';

const BASE = 1_700_000_000_000;

function service(overrides = {}) {
  return {
    name: 'Spooler',
    displayName: 'Print Spooler',
    state: 'Running',
    startMode: 'Auto',
    logonAccount: 'LocalSystem',
    binaryPath: 'C:\\Windows\\System32\\spoolsv.exe',
    serviceType: 'Own Process',
    processId: 1420,
    ...overrides,
  };
}

test('the service script enumerates SCM read-only and the descriptor claims no more than that', () => {
  assert.match(SERVICES_SCRIPT, /^# aegis-source:services/mu);
  assert.match(SERVICES_SCRIPT, /Get-CimInstance -ClassName Win32_Service/u);
  assert.equal(/Set-Service|Start-Service|Stop-Service|sc\.exe|New-Service|Remove-Service/u.test(SERVICES_SCRIPT), false);

  const descriptor = servicesDescriptor();
  assert.equal(descriptor.stableSourceId, SERVICES_SOURCE_ID);
  assert.equal(descriptor.intervalMs, 60_000);
  assert.equal(descriptor.blindSpots.some((entry) => /created and deleted between two polls/u.test(entry)), true);
  assert.match(descriptor.rotation, /^none/u);
});

test('a first read is a snapshot with snake_case fields and no process id when unset', async () => {
  const powershell = createScriptedPowerShell({
    services: [service(), service({ name: 'Idle', processId: 0 })],
  });
  const source = createServicesSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  assert.equal(result.snapshot, true);
  assert.equal(result.identity, null);

  const spooler = result.records.find((record) => record.payload.name === 'Spooler');
  const idle = result.records.find((record) => record.payload.name === 'Idle');
  assert.equal(spooler.payload.binary_path, 'C:\\Windows\\System32\\spoolsv.exe');
  assert.equal(spooler.payload.logon_account, 'LocalSystem');
  assert.equal(spooler.payload.process_id, 1420);
  assert.equal('process_id' in idle.payload, false, 'pid 0 is not a process');
  for (const key of Object.keys(spooler.payload)) {
    assert.match(key, /^[a-z][a-z0-9_]*$/u);
  }
});

test('a service restart (new hosting pid) is not a persistence change', async () => {
  const clock = createClock(BASE);
  const routes = { services: [service({ processId: 100 })] };
  const source = createServicesSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.services = [service({ processId: 999 })];
  const second = await source.read();

  assert.deepEqual(second.records, [], 'the hosting pid is excluded from the digest on purpose');
});

test('a changed binary path is a changed event on the same service entity', async () => {
  const clock = createClock(BASE);
  const routes = { services: [service()] };
  const source = createServicesSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.services = [service({ binaryPath: 'C:\\Users\\Public\\evil.exe' })];
  const second = await source.read();

  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].payload.change, 'changed');
  assert.equal(second.records[0].payload.binary_path, 'C:\\Users\\Public\\evil.exe');
});

test('service identity is case-insensitive, as SCM names are', async () => {
  const clock = createClock(BASE);
  const routes = { services: [service({ name: 'Spooler' })] };
  const source = createServicesSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.services = [service({ name: 'spooler' })];
  const second = await source.read();

  assert.deepEqual(second.records, [], 'a case-only difference must not look like a new service');
});

test('a removed service is reported with present false', async () => {
  const clock = createClock(BASE);
  const routes = { services: [service()] };
  const source = createServicesSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.services = [];
  const second = await source.read();

  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].payload.present, false);
});

test('unreadable binary paths are declared as a degraded field', async () => {
  const powershell = createScriptedPowerShell({ services: [service({ binaryPath: '' })] });
  const source = createServicesSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  assert.deepEqual([...result.degradedFields], ['binary_path']);
  assert.equal(result.stats.missingBinaryPath, 1);
});
