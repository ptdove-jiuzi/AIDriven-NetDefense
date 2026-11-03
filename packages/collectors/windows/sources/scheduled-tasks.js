/**
 * Scheduled task persistence source (§5.1 "任务/启动持久化": Task Scheduler read-only, 60 s).
 *
 * `Get-ScheduledTask` + `Get-ScheduledTaskInfo` are read-only cmdlets from the
 * `ScheduledTasks` module. The source never registers, runs, disables or deletes a task.
 *
 * Change detection covers the *definition*: the resolved action command line, the run
 * account, the run level, the state and the trigger types. Last-run telemetry
 * (`last_run_time`, `last_result`, `next_run_time`) is emitted for context but is excluded
 * from the digest on purpose — a daily task running again is not a persistence change, and
 * folding it in would turn every scheduled run into a `changed` event.
 */

import {
  DEFAULT_MAX_ENTITIES,
  buildSnapshotRecord,
  createSnapshotDiffer,
  identityToken,
  stateDigest,
} from '../diff.js';
import { createSourceDescriptor } from '../descriptor.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../errors.js';
import { buildPayload } from '../payload.js';
import { parseWindowsDate, toArray, toInteger, toText } from '../powershell.js';

export const SCHEDULED_TASKS_SOURCE_ID = 'windows.scheduled-task-table';
export const SCHEDULED_TASKS_INTERVAL_MS = 60_000;
export const SCHEDULED_TASKS_TYPE = 'windows.scheduled_task';

export const SCHEDULED_TASKS_FIELDS = Object.freeze([
  { name: 'task_path', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'task_name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'state', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'action', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'run_as_user', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'run_level', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'trigger_types', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'last_run_time', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'last_result', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'next_run_time', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
]);

export const SCHEDULED_TASKS_SCRIPT = [
  '# aegis-source:scheduled-tasks',
  '$rows = @(Get-ScheduledTask -ErrorAction Stop | ForEach-Object {',
  '  $info = $null',
  '  try { $info = Get-ScheduledTaskInfo -TaskPath $_.TaskPath -TaskName $_.TaskName -ErrorAction Stop } catch { $info = $null }',
  '  $action = ($_.Actions | ForEach-Object { ([string]$_.Execute + " " + [string]$_.Arguments).Trim() }) -join " | "',
  '  $triggers = ($_.Triggers | ForEach-Object { [string]$_.CimClass.CimClassName }) -join ","',
  '  [pscustomobject]@{ taskPath = [string]$_.TaskPath; taskName = [string]$_.TaskName; state = [string]$_.State; action = $action; runAsUser = [string]$_.Principal.UserId; runLevel = [string]$_.Principal.RunLevel; triggerTypes = $triggers; lastRunTime = $info.LastRunTime; lastResult = [int]$info.LastTaskResult; nextRunTime = $info.NextRunTime }',
  '})',
  'ConvertTo-Json -InputObject $rows -Depth 3 -Compress',
].join('\n');

export function scheduledTasksDescriptor({ intervalMs = SCHEDULED_TASKS_INTERVAL_MS } = {}) {
  return createSourceDescriptor({
    stableSourceId: SCHEDULED_TASKS_SOURCE_ID,
    type: SCHEDULED_TASKS_TYPE,
    kind: 'poll',
    intervalMs,
    permissions: {
      required: ['ScheduledTasks PowerShell module (Get-ScheduledTask)'],
      optional: ['Administrator to read task actions and principals of tasks owned by other users'],
      degradedWithout: ['action: unreadable task actions are reported as absent, never as an empty command'],
    },
    fields: SCHEDULED_TASKS_FIELDS,
    blindSpots: [
      'A task registered and removed between two polls (shorter than intervalMs) is never observed',
      'Only the resolved action command line is captured; the referenced binary is not read or hashed',
      'Task XML details that do not change the action, principal, state or trigger types are not distinguished',
      'COM handler and custom task actions may serialize to an empty action string',
      'Last-run fields are informational only and never produce a change event on their own',
    ],
    gapSemantics: [
      'poll: a failed read produces no records and no gap; the source degrades through last_error and goes stale after two intervals',
      'poll: a task edited and reverted between two reads produces no event',
    ],
    rotation: 'none: the task table is a point-in-time snapshot keyed by the case-insensitive task path plus name',
  });
}

export const SCHEDULED_TASKS_DESCRIPTOR = scheduledTasksDescriptor();

function normalizeRow(row) {
  const name = toText(row.taskName);
  if (name === null) {
    return null;
  }
  const taskPath = toText(row.taskPath) ?? '\\';
  const lastRunMs = parseWindowsDate(row.lastRunTime);
  const nextRunMs = parseWindowsDate(row.nextRunTime);
  const lastResult = toInteger(row.lastResult);
  const action = toText(row.action);

  const { payload } = buildPayload({
    task_path: taskPath,
    task_name: name,
    state: toText(row.state),
    action,
    run_as_user: toText(row.runAsUser),
    run_level: toText(row.runLevel),
    trigger_types: toText(row.triggerTypes),
    last_run_time: lastRunMs === null ? null : new Date(lastRunMs).toISOString(),
    last_result: lastResult,
    next_run_time: nextRunMs === null ? null : new Date(nextRunMs).toISOString(),
  });

  const digest = stateDigest({
    state: payload.state ?? null,
    action: payload.action ?? null,
    run_as_user: payload.run_as_user ?? null,
    run_level: payload.run_level ?? null,
    trigger_types: payload.trigger_types ?? null,
  });

  // A task is addressed by its full path; the name alone is not unique across folders.
  return {
    entityId: `task-${identityToken(`${taskPath}${name}`.toLowerCase())}`,
    digest,
    payload,
  };
}

export function createScheduledTasksSource({
  powershell,
  clock = Date.now,
  intervalMs = SCHEDULED_TASKS_INTERVAL_MS,
  maxEntities = DEFAULT_MAX_ENTITIES,
} = {}) {
  if (!powershell || typeof powershell.runJson !== 'function') {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a PowerShell client exposing runJson() is required',
    );
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'intervalMs must be a positive integer');
  }

  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = scheduledTasksDescriptor({ intervalMs });

  return Object.freeze({
    descriptor,
    sourceId: SCHEDULED_TASKS_SOURCE_ID,

    async read() {
      const rows = toArray(await powershell.runJson(SCHEDULED_TASKS_SCRIPT));
      const items = [];
      let missingAction = 0;
      for (const row of rows) {
        if (row === null || typeof row !== 'object') {
          continue;
        }
        const normalized = normalizeRow(row);
        if (normalized !== null) {
          items.push(normalized);
          if (normalized.payload.action === undefined) {
            missingAction += 1;
          }
        }
      }

      const observedAt = clock();
      const diff = differ.diff(items);
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: SCHEDULED_TASKS_TYPE,
          entityId: entry.entityId,
          digest: entry.digest,
          revision: entry.revision,
          observedAt,
          change: entry.kind,
          payload: entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true },
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      return {
        records,
        nextCursor: null,
        identity: null,
        reset: null,
        snapshot: diff.snapshot,
        truncated: diff.truncated,
        degradedFields: missingAction > 0 ? Object.freeze(['action']) : Object.freeze([]),
        stats: Object.freeze({
          tasks: items.length,
          missingAction,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
        }),
      };
    },
  });
}
