/**
 * Windows service persistence source (§5.1 "服务持久化": SCM read-only enumeration, 60 s).
 *
 * `Get-CimInstance Win32_Service` is a *read-only* enumeration over SCM. Nothing here
 * starts, stops, reconfigures or deletes a service: the collector's job is to notice that a
 * service definition changed, and any response action belongs to the approval-gated
 * response path, not to a collector.
 *
 * What counts as a change: the executable command, the logon account, the start mode, the
 * current state and the set of trigger types. In particular `state` is part of the digest,
 * because a service flipped to `Stopped` while its binary path stays the same is still an
 * event ("it used to run and now it does not"), while the pid of the hosting process is
 * deliberately excluded — it changes on every restart of the service.
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
import { toArray, toInteger, toText } from '../powershell.js';

export const SERVICES_SOURCE_ID = 'windows.service-table';
export const SERVICES_INTERVAL_MS = 60_000;
export const SERVICES_TYPE = 'windows.service';

export const SERVICES_FIELDS = Object.freeze([
  { name: 'name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'display_name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'state', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'start_mode', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'logon_account', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'binary_path', type: 'string', completeness: 'always', sensitivity: 'D2' },
  { name: 'service_type', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'process_id', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
]);

export const SERVICES_SCRIPT = [
  '# aegis-source:services',
  '$rows = @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; displayName = [string]$_.DisplayName; state = [string]$_.State; startMode = [string]$_.StartMode; logonAccount = [string]$_.StartName; binaryPath = [string]$_.PathName; serviceType = [string]$_.ServiceType; processId = [int]$_.ProcessId } })',
  'ConvertTo-Json -InputObject $rows -Depth 3 -Compress',
].join('\n');

export function servicesDescriptor({ intervalMs = SERVICES_INTERVAL_MS } = {}) {
  return createSourceDescriptor({
    stableSourceId: SERVICES_SOURCE_ID,
    type: SERVICES_TYPE,
    kind: 'poll',
    intervalMs,
    permissions: {
      required: ['WMI read access to root\\cimv2 (Win32_Service)'],
      optional: ['Administrator for the PathName of protected services'],
      degradedWithout: ['binary_path: protected services may report an empty path to a non-elevated collector'],
    },
    fields: SERVICES_FIELDS,
    blindSpots: [
      'Only services registered in SCM are enumerated; drivers and user-mode scheduled tasks are separate sources',
      'A service created and deleted between two polls (shorter than intervalMs) is never observed',
      'The hosting process id is informational and is excluded from change detection because it changes on every restart',
      'A changed binary_path is reported, but the collector does not read or hash the referenced file',
    ],
    gapSemantics: [
      'poll: a failed read produces no records and no gap; the source degrades through last_error and goes stale after two intervals',
      'poll: a service that is reconfigured back to its previous state between two reads produces no event',
    ],
    rotation: 'none: the service table is a point-in-time snapshot keyed by the case-insensitive service name',
  });
}

export const SERVICES_DESCRIPTOR = servicesDescriptor();

function normalizeRow(row) {
  const name = toText(row.name);
  if (name === null) {
    return null;
  }
  const processId = toInteger(row.processId);
  const { payload } = buildPayload({
    name,
    display_name: toText(row.displayName),
    state: toText(row.state),
    start_mode: toText(row.startMode),
    logon_account: toText(row.logonAccount),
    binary_path: toText(row.binaryPath),
    service_type: toText(row.serviceType),
    process_id: processId !== null && processId > 0 ? processId : undefined,
  });

  // SCM service names are case-insensitive, so the identity is folded to lower case;
  // the payload keeps the display spelling for the analyst.
  const digest = stateDigest({
    state: payload.state ?? null,
    start_mode: payload.start_mode ?? null,
    logon_account: payload.logon_account ?? null,
    binary_path: payload.binary_path ?? null,
    service_type: payload.service_type ?? null,
  });
  return {
    entityId: `svc-${identityToken(name.toLowerCase())}`,
    digest,
    payload,
  };
}

export function createServicesSource({
  powershell,
  clock = Date.now,
  intervalMs = SERVICES_INTERVAL_MS,
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
  const descriptor = servicesDescriptor({ intervalMs });

  return Object.freeze({
    descriptor,
    sourceId: SERVICES_SOURCE_ID,

    async read() {
      const rows = toArray(await powershell.runJson(SERVICES_SCRIPT));
      const items = [];
      let missingPath = 0;
      for (const row of rows) {
        if (row === null || typeof row !== 'object') {
          continue;
        }
        const normalized = normalizeRow(row);
        if (normalized !== null) {
          items.push(normalized);
          if (normalized.payload.binary_path === undefined) {
            missingPath += 1;
          }
        }
      }

      const observedAt = clock();
      const diff = differ.diff(items);
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: SERVICES_TYPE,
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
        degradedFields: missingPath > 0 ? Object.freeze(['binary_path']) : Object.freeze([]),
        stats: Object.freeze({
          services: items.length,
          missingBinaryPath: missingPath,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
        }),
      };
    },
  });
}
