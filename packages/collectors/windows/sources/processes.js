/**
 * Process table source (§5.1 "进程": 5 s poll).
 *
 * The table is read natively through `NtQuerySystemInformation(SystemProcessInformation)`
 * plus a PEB walk for `ExecutablePath`/`CommandLine` (`win32/process-table.js`, koffi).
 * `Win32_Process` is still the *contract* — the native reader returns WMI-shaped rows — and
 * the WMI script remains the fallback transport, because a missing koffi install must never
 * turn into an empty table.
 *
 * `Win32_Process` was chosen originally over `tasklist` because it returns the parent pid,
 * the creation time and the full command line in one structured call. The creation time is
 * what makes pid reuse tractable: identity is `pid + creationEpochMs`, so a recycled pid
 * is a different entity and therefore a different stable key.
 *
 * Blind spots are inherent to polling: a process that starts and exits inside one interval
 * is never observed. Non-elevated collectors get `ExecutablePath`/`CommandLine` only for
 * their own processes, which is why those two fields are declared `completeness: admin`
 * and are *reported as degraded* when the process table comes back with every one of them
 * empty — a collector must not present a permission-limited read as a complete one.
 */

import {
  DEFAULT_MAX_ENTITIES,
  buildSnapshotRecord,
  createSnapshotDiffer,
  stateDigest,
} from '../diff.js';
import { createSourceDescriptor } from '../descriptor.js';
import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../errors.js';
import { buildPayload } from '../payload.js';
import { parseWindowsDate, toArray, toInteger, toText } from '../powershell.js';

export const PROCESS_SOURCE_ID = 'windows.process-table';
export const PROCESS_INTERVAL_MS = 5_000;
export const PROCESS_TYPE = 'windows.process';

export const PROCESS_FIELDS = Object.freeze([
  { name: 'pid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'ppid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'image_path', type: 'string', completeness: 'admin', sensitivity: 'D2' },
  { name: 'command_line', type: 'string', completeness: 'admin', sensitivity: 'D2' },
  { name: 'start_time', type: 'string', completeness: 'always', sensitivity: 'D1' },
]);

export const PROCESS_SCRIPT = [
  '# aegis-source:processes',
  '$rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate)',
  'ConvertTo-Json -InputObject $rows -Depth 3 -Compress',
].join('\n');

/**
 * The declared descriptor. Note `generationAware: false`: a shrinking process table is
 * normal, so `evaluateSourceIdentity` must never be applied to this source.
 */
export function processDescriptor({ intervalMs = PROCESS_INTERVAL_MS } = {}) {
  return createSourceDescriptor({
    stableSourceId: PROCESS_SOURCE_ID,
    type: PROCESS_TYPE,
    kind: 'poll',
    intervalMs,
    permissions: {
      required: ['Read access to the process table: NtQuerySystemInformation(SystemProcessInformation) with a per-process PEB read, or WMI root\\cimv2 Win32_Process on the fallback transport'],
      optional: ['SeDebugPrivilege (administrator) for other users command lines and image paths'],
      degradedWithout: ['command_line', 'image_path'],
    },
    fields: PROCESS_FIELDS,
    blindSpots: [
      'A process that starts and exits between two polls (shorter than intervalMs) is never observed',
      'Without elevation ExecutablePath and CommandLine are empty for processes owned by other users',
      'Kernel threads and protected processes are not enumerated',
      'A pid reused inside one interval is only distinguishable when CreationDate is present',
    ],
    gapSemantics: [
      'poll: a failed read produces no records and no gap; the source degrades through last_error and goes stale after two intervals',
      'poll: consecutive successful reads only emit added/changed/removed transitions, so a quiet interval is not a gap',
      'poll: a read whose table exceeds maxEntities is reported as truncated and suppresses removals for that cycle',
    ],
    rotation: 'none: the process table is a point-in-time snapshot; identity is pid plus creation time, so pid reuse yields a new entity',
  });
}

export const PROCESS_DESCRIPTOR = processDescriptor();

function normalizeRow(row) {
  const pid = toInteger(row.ProcessId);
  if (pid === null || pid < 0) {
    return null;
  }
  const creationMs = parseWindowsDate(row.CreationDate);
  const { payload } = buildPayload({
    pid,
    ppid: toInteger(row.ParentProcessId),
    name: toText(row.Name),
    image_path: toText(row.ExecutablePath),
    command_line: toText(row.CommandLine),
    start_time: creationMs === null ? null : new Date(creationMs).toISOString(),
  });
  // The digest covers everything except identity: a changed command line or parent is a
  // state change on the same process, not a new process. It is computed over the
  // *normalized* payload so that two rows differing only by stripped control characters
  // do not look like a change.
  const digest = stateDigest({
    ppid: payload.ppid ?? null,
    name: payload.name ?? null,
    image_path: payload.image_path ?? null,
    command_line: payload.command_line ?? null,
  });
  return {
    entityId: `${pid}-${creationMs === null ? 0 : creationMs}`,
    digest,
    payload,
  };
}

export function createProcessSource({
  powershell,
  win32 = null,
  clock = Date.now,
  intervalMs = PROCESS_INTERVAL_MS,
  maxEntities = DEFAULT_MAX_ENTITIES,
} = {}) {
  const native = win32 !== null && typeof win32?.readProcessTable === 'function' ? win32 : null;
  if (!native && (!powershell || typeof powershell.runJson !== 'function')) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a PowerShell client exposing runJson() is required',
    );
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'intervalMs must be a positive integer');
  }

  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = processDescriptor({ intervalMs });

  /**
   * Read the table, preferring the native provider.
   *
   * PERF-CPU: one `powershell.exe` start-up costs ~812 ms of CPU and `Get-CimInstance
   * Win32_Process` another ~1156 ms, every 5 s. The native path answers the same question
   * from the kernel in a few milliseconds with no subprocess at all.
   *
   * A native failure is a *value*: when a script client exists the read falls back to it and
   * the fallback is recorded in `stats`, so a broken koffi install degrades the transport
   * visibly instead of emptying the table.
   */
  async function readTableRows() {
    if (native !== null) {
      try {
        const rows = await native.readProcessTable();
        return { rows: toArray(rows), transport: native.transport ?? 'win32-koffi', fallback: null };
      } catch (error) {
        if (!powershell || typeof powershell.runJson !== 'function') {
          throw error;
        }
        const rows = toArray(await powershell.runJson(PROCESS_SCRIPT));
        return {
          rows,
          transport: 'powershell',
          fallback: Object.freeze({
            from: native.transport ?? 'win32-koffi',
            to: 'powershell',
            errorCode: error?.code ?? null,
            message: error?.message ?? String(error),
          }),
        };
      }
    }
    return {
      rows: toArray(await powershell.runJson(PROCESS_SCRIPT)),
      transport: 'powershell',
      fallback: null,
    };
  }

  return Object.freeze({
    descriptor,
    sourceId: PROCESS_SOURCE_ID,

    async read() {
      const table = await readTableRows();
      const rows = table.rows;
      const items = [];
      let missingImagePath = 0;
      let missingCommandLine = 0;

      for (const row of rows) {
        if (row === null || typeof row !== 'object') {
          continue;
        }
        const normalized = normalizeRow(row);
        if (normalized !== null) {
          items.push(normalized);
          // Permission degradation is detected from the data, not assumed: an unelevated
          // read returns the rows but blanks these two properties for other users.
          if (normalized.payload.image_path === undefined) {
            missingImagePath += 1;
          }
          if (normalized.payload.command_line === undefined) {
            missingCommandLine += 1;
          }
        }
      }

      const observedAt = clock();
      const diff = differ.diff(items);
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: PROCESS_TYPE,
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

      const allBlank = items.length > 0
        && missingImagePath === items.length
        && missingCommandLine === items.length;

      return {
        records,
        nextCursor: null,
        // A point-in-time table has no rotation identity. Returning one here would let a
        // shrink in the process count masquerade as `log_truncated`.
        identity: null,
        reset: null,
        snapshot: diff.snapshot,
        truncated: diff.truncated,
        degradedFields: allBlank ? Object.freeze(['image_path', 'command_line']) : Object.freeze([]),
        stats: Object.freeze({
          entities: items.length,
          missingImagePath,
          missingCommandLine,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
          transport: table.transport,
          fallback: table.fallback,
        }),
      };
    },
  });
}
