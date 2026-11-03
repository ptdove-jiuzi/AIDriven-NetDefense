/**
 * Network table source (§5.1 "网络": 5 s poll).
 *
 * `Get-NetTCPConnection` / `Get-NetUDPEndpoint` come from the NetTCPIP module and return
 * typed endpoints including the owning pid, which `netstat -ano` only offers as text.
 * TCP state is normalized to a lowercase token because the cmdlet returns an enum whose
 * JSON shape differs between Windows PowerShell 5.1 and PowerShell 7.
 *
 * `OwningProcess = 0` is not a process: the socket is owned by the kernel (TIME_WAIT,
 * terminating connection) or the mapping is not available to this account. Both cases are
 * reported as an absent `pid` with `attribution: 'unavailable'` rather than as pid 0, which
 * would falsely point at the System Idle Process.
 *
 * Identity: a TCP socket is the 5-tuple plus its creation time. The owning pid is *not*
 * part of the identity but *is* part of the digest, so a socket that is re-attributed to a
 * different process becomes a `changed` event on the same entity instead of an
 * added/removed pair that hides the re-attribution.
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
import { parseWindowsDate, toInteger, toText } from '../powershell.js';

export const CONNECTIONS_SOURCE_ID = 'windows.network-table';
export const CONNECTIONS_INTERVAL_MS = 5_000;
export const CONNECTIONS_TYPE = 'windows.connection';

export const CONNECTIONS_FIELDS = Object.freeze([
  { name: 'protocol', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'local_address', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'local_port', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'remote_address', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'remote_port', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'state', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'pid', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'attribution', type: 'string', completeness: 'always', sensitivity: 'D0' },
]);

export const CONNECTIONS_SCRIPT = [
  '# aegis-source:connections',
  "$tcp = @(Get-NetTCPConnection -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; remoteAddress = [string]$_.RemoteAddress; remotePort = [int]$_.RemotePort; state = [string]$_.State; owningProcess = [int]$_.OwningProcess; creationTime = $_.CreationTime } })",
  "$udp = @(Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; owningProcess = [int]$_.OwningProcess } })",
  'ConvertTo-Json -InputObject ([pscustomobject]@{ tcp = $tcp; udp = $udp }) -Depth 4 -Compress',
].join('\n');

const TCP_STATES = Object.freeze({
  1: 'closed',
  2: 'listen',
  3: 'syn_sent',
  4: 'syn_received',
  5: 'established',
  6: 'fin_wait1',
  7: 'fin_wait2',
  8: 'close_wait',
  9: 'closing',
  10: 'last_ack',
  11: 'time_wait',
  12: 'delete_tcb',
});

/**
 * Entity ids must not contain '#' or ':' (both delimit a stable key), but IPv6 addresses
 * are full of colons. The previous implementation mapped ':' to '-', so `2001:db8::1` and
 * `2001-db8--1` would have collapsed into the same identity. Delegating to
 * {@link identityToken} hashes anything that is not already a safe token, which keeps the
 * identity injective and still deterministic.
 */
export function addressToken(address) {
  return identityToken(String(address ?? ''));
}

function normalizeState(value) {
  const text = toText(value);
  if (text === null) {
    return 'unknown';
  }
  const numeric = /^\d+$/.test(text) ? Number(text) : null;
  if (numeric !== null && TCP_STATES[numeric] !== undefined) {
    return TCP_STATES[numeric];
  }
  return text.toLowerCase().replace(/\s+/g, '_');
}

function normalizeOwner(value) {
  const pid = toInteger(value);
  if (pid === null || pid <= 0) {
    return { pid: undefined, attribution: 'unavailable' };
  }
  return { pid, attribution: 'exact' };
}

function normalizeTcp(row) {
  const localPort = toInteger(row.localPort);
  if (localPort === null || localPort < 0) {
    return null;
  }
  const remotePort = toInteger(row.remotePort);
  const owner = normalizeOwner(row.owningProcess);
  const localAddress = toText(row.localAddress) ?? 'unknown';
  const remoteAddress = toText(row.remoteAddress) ?? 'unknown';
  const state = normalizeState(row.state);
  const creationMs = parseWindowsDate(row.creationTime);

  const { payload } = buildPayload({
    protocol: 'tcp',
    local_address: localAddress,
    local_port: localPort,
    remote_address: remoteAddress,
    remote_port: remotePort === null ? undefined : remotePort,
    state,
    pid: owner.pid,
    attribution: owner.attribution,
  });

  const entityId = [
    'tcp',
    addressToken(localAddress),
    localPort,
    addressToken(remoteAddress),
    remotePort === null ? 0 : remotePort,
    creationMs === null ? 0 : creationMs,
  ].join('-');

  const digest = stateDigest({
    state: payload.state,
    pid: payload.pid ?? null,
    attribution: payload.attribution,
  });
  return { entityId, digest, payload };
}

function normalizeUdp(row) {
  const localPort = toInteger(row.localPort);
  if (localPort === null || localPort < 0) {
    return null;
  }
  const owner = normalizeOwner(row.owningProcess);
  const localAddress = toText(row.localAddress) ?? 'unknown';

  const { payload } = buildPayload({
    protocol: 'udp',
    local_address: localAddress,
    local_port: localPort,
    state: 'listening',
    pid: owner.pid,
    attribution: owner.attribution,
  });

  // A UDP endpoint has no state machine and no remote peer, so its identity is the local
  // binding plus its owner; the digest is constant and only presence transitions emit.
  const entityId = `udp-${addressToken(localAddress)}-${localPort}-${owner.pid ?? 'na'}`;
  return { entityId, digest: stateDigest({ protocol: 'udp' }), payload };
}

export function connectionsDescriptor({ intervalMs = CONNECTIONS_INTERVAL_MS } = {}) {
  return createSourceDescriptor({
    stableSourceId: CONNECTIONS_SOURCE_ID,
    type: CONNECTIONS_TYPE,
    kind: 'poll',
    intervalMs,
    permissions: {
      required: ['NetTCPIP module (Get-NetTCPConnection, Get-NetUDPEndpoint)'],
      optional: ['Administrator for complete socket to process attribution'],
      degradedWithout: ['pid: connections whose owner is not resolvable report attribution "unavailable"'],
    },
    fields: CONNECTIONS_FIELDS,
    blindSpots: [
      'A connection that opens and closes between two polls is never observed',
      'Socket to process attribution can be incomplete for kernel-owned or protected sockets (OwningProcess = 0)',
      'Only the TCP and UDP endpoint tables are read; raw sockets and ICMP are not represented',
      'UDP endpoints have no remote peer or state machine, so remote_address/remote_port are absent on those rows',
      'A listening TCP socket reports remote port 0 and a wildcard remote address; that is the real table value, not a parse failure',
    ],
    gapSemantics: [
      'poll: a failed read produces no records and no gap; the source degrades through last_error and goes stale after two intervals',
      'poll: an endpoint that disappears and reappears within one generation reuses its stable key, so the re-appearance is deduplicated locally',
      'poll: a read whose table exceeds maxEntities is reported as truncated and suppresses removals for that cycle',
    ],
    rotation: 'none: the endpoint table is a point-in-time snapshot',
  });
}

export const CONNECTIONS_DESCRIPTOR = connectionsDescriptor();

export function createConnectionsSource({
  powershell,
  clock = Date.now,
  intervalMs = CONNECTIONS_INTERVAL_MS,
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
  const descriptor = connectionsDescriptor({ intervalMs });

  return Object.freeze({
    descriptor,
    sourceId: CONNECTIONS_SOURCE_ID,

    async read() {
      const table = await powershell.runJson(CONNECTIONS_SCRIPT);
      const tcpRows = table?.tcp == null ? [] : (Array.isArray(table.tcp) ? table.tcp : [table.tcp]);
      const udpRows = table?.udp == null ? [] : (Array.isArray(table.udp) ? table.udp : [table.udp]);

      const items = [];
      let unattributed = 0;
      for (const row of tcpRows) {
        if (row === null || typeof row !== 'object') {
          continue;
        }
        const normalized = normalizeTcp(row);
        if (normalized !== null) {
          items.push(normalized);
          if (normalized.payload.pid === undefined) {
            unattributed += 1;
          }
        }
      }
      for (const row of udpRows) {
        if (row === null || typeof row !== 'object') {
          continue;
        }
        const normalized = normalizeUdp(row);
        if (normalized !== null) {
          items.push(normalized);
          if (normalized.payload.pid === undefined) {
            unattributed += 1;
          }
        }
      }

      const observedAt = clock();
      const diff = differ.diff(items);
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: CONNECTIONS_TYPE,
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
        // A kernel-owned socket (TIME_WAIT, terminating connection) has no owning process on
        // every healthy host, so `attribution: 'unavailable'` is normal data, not a degraded
        // read. Declaring it as a degraded field would have marked the source partial on every
        // single cycle and, worse, would have cleared a real permission denial.
        degradedFields: Object.freeze([]),
        stats: Object.freeze({
          tcp: tcpRows.length,
          udp: udpRows.length,
          unattributed,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
        }),
      };
    },
  });
}
