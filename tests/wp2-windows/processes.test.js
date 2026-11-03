import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROCESS_SCRIPT,
  PROCESS_SOURCE_ID,
  createProcessSource,
  processDescriptor,
} from '../../packages/collectors/windows/index.js';
import { createClock, createScriptedPowerShell } from './helpers.js';

const CREATED = 1_699_000_000_000;

function row(overrides = {}) {
  return {
    ProcessId: 1234,
    ParentProcessId: 4,
    Name: 'demo.exe',
    ExecutablePath: 'C:\\Program Files\\Demo\\demo.exe',
    CommandLine: '"C:\\Program Files\\Demo\\demo.exe" --flag',
    CreationDate: `/Date(${CREATED})/`,
    ...overrides,
  };
}

test('the process script is a constant that reads Win32_Process and never interpolates input', () => {
  assert.match(PROCESS_SCRIPT, /^# aegis-source:processes/mu);
  assert.match(PROCESS_SCRIPT, /Get-CimInstance -ClassName Win32_Process/u);
  assert.match(PROCESS_SCRIPT, /ConvertTo-Json/u);
  assert.equal(/\$\{|\+ \$/.test(PROCESS_SCRIPT), false);
});

test('the descriptor declares the poll interval, permissions and the short-lived blind spot', () => {
  const descriptor = processDescriptor();
  assert.equal(descriptor.stableSourceId, PROCESS_SOURCE_ID);
  assert.equal(descriptor.kind, 'poll');
  assert.equal(descriptor.intervalMs, 5_000);
  assert.equal(descriptor.generationAware, false);
  assert.equal(descriptor.permissions.required.length, 1);
  assert.deepEqual([...descriptor.permissions.degradedWithout], ['command_line', 'image_path']);
  assert.equal(descriptor.blindSpots.some((entry) => /starts and exits between two polls/u.test(entry)), true);
  assert.match(descriptor.rotation, /^none/u);
});

test('a first read emits a snapshot with snake_case payload and absolute start time', async () => {
  const powershell = createScriptedPowerShell({ processes: [row()] });
  const source = createProcessSource({ powershell, clock: createClock(CREATED + 5_000) });
  const result = await source.read();

  assert.equal(result.snapshot, true);
  assert.equal(result.identity, null, 'a point-in-time table must not expose a rotation identity');
  assert.equal(result.records.length, 1);

  const record = result.records[0];
  assert.equal(record.type, 'windows.process');
  assert.equal(record.payload.change, 'snapshot');
  assert.equal(record.payload.present, true);
  assert.equal(record.payload.pid, 1234);
  assert.equal(record.payload.image_path, 'C:\\Program Files\\Demo\\demo.exe');
  assert.equal(record.payload.start_time, new Date(CREATED).toISOString());
  for (const key of Object.keys(record.payload)) {
    assert.match(key, /^[a-z][a-z0-9_]*$/u, `payload key ${key} is not snake_case`);
  }
});

test('a recycled pid is a different entity because the creation time is part of the identity', async () => {
  const clock = createClock(CREATED + 10_000);
  const routes = { processes: [row()] };
  const source = createProcessSource({ powershell: createScriptedPowerShell(routes), clock });

  const first = await source.read();
  const firstKey = first.records[0].nativeRecordId;

  routes.processes = [row({ CreationDate: `/Date(${CREATED + 60_000})/`, CommandLine: 'other' })];
  const second = await source.read();

  const kinds = second.records.map((record) => record.payload.change).sort();
  assert.deepEqual(kinds, ['added', 'removed']);
  assert.notEqual(second.records.find((record) => record.payload.change === 'added').nativeRecordId, firstKey);
});

test('a vanished process is reported as removed with present false', async () => {
  const clock = createClock(CREATED + 10_000);
  const routes = { processes: [row()] };
  const source = createProcessSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes.processes = [];
  const result = await source.read();

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.change, 'removed');
  assert.equal(result.records[0].payload.present, false);
});

test('a read where every command line is blank is declared as a degraded field, not as complete', async () => {
  const powershell = createScriptedPowerShell({
    processes: [
      row({ ExecutablePath: '', CommandLine: '' }),
      row({ ProcessId: 99, ExecutablePath: null, CommandLine: null }),
    ],
  });
  const source = createProcessSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();

  assert.deepEqual([...result.degradedFields], ['image_path', 'command_line']);
  assert.equal(result.stats.missingCommandLine, 2);
  assert.equal(result.records.length, 2, 'a permission-limited read still emits what it could see');
  assert.equal('command_line' in result.records[0].payload, false);
});

test('a row without a usable pid is skipped instead of being indexed as pid null', async () => {
  const powershell = createScriptedPowerShell({
    processes: [row({ ProcessId: 'not-a-number' }), row({ ProcessId: 4321 })],
  });
  const source = createProcessSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].payload.pid, 4321);
});

test('a table larger than maxEntities is reported as truncated and removes nothing', async () => {
  const rows = [];
  for (let index = 0; index < 5; index += 1) {
    rows.push(row({ ProcessId: 100 + index, CreationDate: `/Date(${CREATED + index})/` }));
  }
  const powershell = createScriptedPowerShell({ processes: rows });
  const source = createProcessSource({ powershell, clock: createClock(CREATED), maxEntities: 2 });
  const result = await source.read();

  assert.equal(result.truncated, true);
  assert.equal(result.records.length, 2);
  assert.equal(result.stats.suppressedRemovals, 0);
});

test('a single-object ConvertTo-Json result is treated as a one-row table', async () => {
  const powershell = createScriptedPowerShell({ processes: row() });
  const source = createProcessSource({ powershell, clock: createClock(CREATED) });
  const result = await source.read();
  assert.equal(result.records.length, 1);
});

test('an empty table is a valid read, not an error', async () => {
  const source = createProcessSource({
    powershell: createScriptedPowerShell({ processes: [] }),
    clock: createClock(CREATED),
  });
  const result = await source.read();
  assert.deepEqual(result.records, []);
  assert.equal(result.snapshot, true);
  assert.deepEqual([...result.degradedFields], []);
});
