import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCHEDULED_TASKS_SCRIPT,
  SCHEDULED_TASKS_SOURCE_ID,
  createScheduledTasksSource,
  scheduledTasksDescriptor,
} from '../../packages/collectors/windows/index.js';
import { createClock, createScriptedPowerShell } from './helpers.js';

const BASE = 1_700_000_000_000;

function task(overrides = {}) {
  return {
    taskPath: '\\Microsoft\\Windows\\Defrag\\',
    taskName: 'ScheduledDefrag',
    state: 'Ready',
    action: 'C:\\Windows\\System32\\defrag.exe -c -h',
    runAsUser: 'SYSTEM',
    runLevel: 'Highest',
    triggerTypes: 'MSFT_TaskDailyTrigger',
    lastRunTime: `/Date(${BASE})/`,
    lastResult: 0,
    nextRunTime: `/Date(${BASE + 86_400_000})/`,
    ...overrides,
  };
}

test('the task script is read-only and the descriptor declares the run-only blind spot', () => {
  assert.match(SCHEDULED_TASKS_SCRIPT, /^# aegis-source:scheduled-tasks/mu);
  assert.match(SCHEDULED_TASKS_SCRIPT, /Get-ScheduledTask\b/u);
  assert.equal(/Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|schtasks/u.test(SCHEDULED_TASKS_SCRIPT), false);

  const descriptor = scheduledTasksDescriptor();
  assert.equal(descriptor.stableSourceId, SCHEDULED_TASKS_SOURCE_ID);
  assert.equal(descriptor.blindSpots.some((entry) => /registered and removed between two polls/u.test(entry)), true);
  assert.equal(descriptor.blindSpots.some((entry) => /never produce a change event/u.test(entry)), true);
});

test('the first read emits the action, principal and trigger types', async () => {
  const powershell = createScriptedPowerShell({ 'scheduled-tasks': [task()] });
  const source = createScheduledTasksSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  const payload = result.records[0].payload;
  assert.equal(payload.task_path, '\\Microsoft\\Windows\\Defrag\\');
  assert.equal(payload.task_name, 'ScheduledDefrag');
  assert.equal(payload.action, 'C:\\Windows\\System32\\defrag.exe -c -h');
  assert.equal(payload.run_as_user, 'SYSTEM');
  assert.equal(payload.run_level, 'Highest');
  assert.equal(payload.trigger_types, 'MSFT_TaskDailyTrigger');
  assert.equal(payload.last_run_time, new Date(BASE).toISOString());
  assert.equal(payload.last_result, 0);
  assert.match(payload.next_run_time, /^\d{4}-\d{2}-\d{2}T/u);
});

test('a task running again is not a persistence change', async () => {
  const clock = createClock(BASE);
  const routes = { 'scheduled-tasks': [task()] };
  const source = createScheduledTasksSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes['scheduled-tasks'] = [
    task({ lastRunTime: `/Date(${BASE + 60_000})/`, lastResult: 1, nextRunTime: `/Date(${BASE + 172_800_000})/` }),
  ];
  const second = await source.read();

  assert.deepEqual(second.records, [], 'last-run telemetry must not produce an event');
});

test('a changed action or trigger type is a changed event', async () => {
  const clock = createClock(BASE);
  const routes = { 'scheduled-tasks': [task()] };
  const source = createScheduledTasksSource({ powershell: createScriptedPowerShell(routes), clock });

  await source.read();
  routes['scheduled-tasks'] = [task({ triggerTypes: 'MSFT_TaskLogonTrigger' })];
  const changedTrigger = await source.read();
  assert.equal(changedTrigger.records[0].payload.change, 'changed');

  routes['scheduled-tasks'] = [task({ triggerTypes: 'MSFT_TaskLogonTrigger', action: 'C:\\Users\\Public\\evil.exe' })];
  const changedAction = await source.read();
  assert.equal(changedAction.records[0].payload.change, 'changed');
  assert.equal(changedAction.records[0].payload.action, 'C:\\Users\\Public\\evil.exe');
});

test('tasks in different folders are different entities even with the same name', async () => {
  const powershell = createScriptedPowerShell({
    'scheduled-tasks': [
      task({ taskPath: '\\A\\', taskName: 'Same' }),
      task({ taskPath: '\\B\\', taskName: 'Same' }),
    ],
  });
  const source = createScheduledTasksSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].nativeRecordId, result.records[1].nativeRecordId);
});

test('a task with no readable action is declared as a degraded field', async () => {
  const powershell = createScriptedPowerShell({ 'scheduled-tasks': [task({ action: '' })] });
  const source = createScheduledTasksSource({ powershell, clock: createClock(BASE) });
  const result = await source.read();

  assert.deepEqual([...result.degradedFields], ['action']);
  assert.equal('action' in result.records[0].payload, false);
});
