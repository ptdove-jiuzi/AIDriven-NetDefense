/**
 * Network table source (§5.1 "网络": 5 s poll).
 *
 * The endpoint tables are read natively through `GetExtendedTcpTable`
 * (`TCP_TABLE_OWNER_MODULE_ALL`) and `GetExtendedUdpTable` (`UDP_TABLE_OWNER_PID`) — see
 * `win32/endpoint-table.js`. The NetTCPIP cmdlets remain the fallback transport and the
 * *contract*: the native reader returns cmdlet-shaped rows, so the normalizers below are
 * shared by both paths.
 *
 * `Get-NetTCPConnection` / `Get-NetUDPEndpoint` come from the NetTCPIP module and return
 * typed endpoints including the owning pid, which `netstat -ano` only offers as text.
 * TCP state is normalized to a lowercase token because the cmdlet returns an enum whose
 * JSON shape differs between Windows PowerShell 5.1 and PowerShell 7, while the native path
 * hands over the raw MIB state number; both normalizations land on the same token.
 *
 * `OwningProcess = 0` is not a process: the socket is owned by the kernel (TIME_WAIT,
 * terminating connection) or the mapping is not available to this account. Both cases are
 * reported as an absent `pid` with `attribution: 'unavailable'` rather than as pid 0, which
 * would falsely point at the System Idle Process.
 *
 * Identity: a TCP socket is the 5-tuple plus its creation time (the native path reads
 * `liCreateTimestamp` for exactly that reason; `TCP_TABLE_OWNER_PID_ALL` would not carry it).
 * The owning pid is *not* part of the identity but *is* part of the digest, so a socket that
 * is re-attributed to a different process becomes a `changed` event on the same entity
 * instead of an added/removed pair that hides the re-attribution.
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

export const CONNECTIONS_SOURCE_ID = 'windows.network-table';
export const CONNECTIONS_INTERVAL_MS = 5_000;
/**
 * Cadence of the `state=Bound` supplement (see `createConnectionsSource`). Deliberately an
 * order of magnitude slower than the poll: those sockets are a pool held by long-lived
 * processes, not a stream, so 60 s of staleness costs nothing while 12 cmdlet runs per
 * minute would cost ~4 s of CPU each.
 */
export const CONNECTIONS_SUPPLEMENT_INTERVAL_MS = 60_000;
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
      required: ['Read access to the TCP/UDP endpoint tables: GetExtendedTcpTable(TCP_TABLE_OWNER_MODULE_ALL) and GetExtendedUdpTable(UDP_TABLE_OWNER_PID), or the NetTCPIP module (Get-NetTCPConnection, Get-NetUDPEndpoint) on the fallback transport'],
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
      'The kernel TCP table lists connected and listening sockets only: a socket that is bound but never connects or listens (the NetTCPIP cmdlet reports it as state "Bound") is supplied from a cached cmdlet read that runs once per 60 s, so those rows can be up to one interval stale',
      'A dual-stack endpoint appears once per address family in the kernel tables (0.0.0.0:port and [::]:port for the same socket), so UDP rows may contain both spellings of one socket',
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
  win32 = null,
  supplementPowershell = undefined,
  supplementIntervalMs = CONNECTIONS_SUPPLEMENT_INTERVAL_MS,
  clock = Date.now,
  intervalMs = CONNECTIONS_INTERVAL_MS,
  maxEntities = DEFAULT_MAX_ENTITIES,
} = {}) {
  const native = win32 !== null && typeof win32?.readEndpointTable === 'function' ? win32 : null;
  if (!native && (!powershell || typeof powershell.runJson !== 'function')) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'a PowerShell client exposing runJson() is required',
    );
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new WindowsCollectorError(WINDOWS_ERROR_CODES.INVALID_ARGUMENT, 'intervalMs must be a positive integer');
  }
  if (!Number.isSafeInteger(supplementIntervalMs) || supplementIntervalMs < 1) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
      'supplementIntervalMs must be a positive integer',
    );
  }

  // The supplement client is only needed on the native path: the script transport already
  // reports `state=Bound` rows itself. It is a separate client on purpose because the
  // NetTCPIP cmdlets need far longer than the poll timeout (21.6 s measured) and must never
  // inherit the 5 s source's failure deadline.
  // `supplementPowershell: null` disables the supplement explicitly; leaving it undefined
  // means "reuse the poll's client", which is what an embedder that only injected one client
  // expects.
  const supplementClient = native === null
    ? null
    : (supplementPowershell === undefined ? (powershell ?? null) : supplementPowershell);

  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = connectionsDescriptor({ intervalMs });

  /**
   * Low-frequency `state=Bound` supplement.
   *
   * The kernel TCP tables (`GetExtendedTcpTable` classes 5 and 8, `GetTcpTable2`,
   * `GetTcp6Table2`, and `netstat -ano`) do not expose sockets that are bound but neither
   * listening nor connected; the WMI provider behind `Get-NetTCPConnection` does, as
   * `state=Bound`. Measured on the reference host those are 187-240 rows (7-15% of the
   * table), so dropping them would be a functional regression even though the native path is
   * two orders of magnitude cheaper.
   *
   * The compromise is a cache: the expensive cmdlet runs on its own 60 s beat (one
   * `powershell.exe` per minute instead of twelve per minute per source), and every 5 s poll
   * merges the cached rows into the snapshot through the *same* `normalizeTcp`/diff pipeline,
   * so a supplemented row has the identical entityId and payload shape it always had.
   *
   * Failure policy: the cache is kept, `stats.supplement` records the failure, and the poll
   * still succeeds with the native rows. A failed supplement must never empty the snapshot.
   */
  const supplement = {
    rows: [],
    attempts: 0,
    inFlight: null,
    ok: null,
    errorCode: null,
    lastAttemptAt: null,
    lastOkAt: null,
  };

  function mergedSupplementRows(tcpRows) {
    if (supplementClient == null || supplement.rows.length === 0) {
      return [];
    }
    // A cached row older than five beats is not evidence about the current table any more.
    if (supplement.lastOkAt !== null && clock() - supplement.lastOkAt > supplementIntervalMs * 5) {
      return [];
    }
    // The native table wins: if the same socket is now visible there (a bound socket that
    // started listening), merging the cached row would duplicate one entity.
    const nativeKeys = new Set(tcpRows.map((row) => `${toText(row.localAddress)}|${toInteger(row.localPort)}|${toInteger(row.owningProcess)}`));
    return supplement.rows.filter((row) => !nativeKeys.has(
      `${toText(row.localAddress)}|${toInteger(row.localPort)}|${toInteger(row.owningProcess)}`,
    ));
  }

  function supplementStats() {
    return Object.freeze({
      enabled: supplementClient != null,
      intervalMs: supplementIntervalMs,
      polls: supplement.attempts,
      cachedRows: supplement.rows.length,
      ok: supplement.ok,
      errorCode: supplement.errorCode,
      lastAttemptAt: supplement.lastAttemptAt,
      lastOkAt: supplement.lastOkAt,
    });
  }

  /**
   * Refresh the cache. Resolves to `{ ok, rows, errorCode }`; never rejects, so a scheduled
   * refresh can be fired without a catch and the caller of `read()` is never affected.
   */
  async function refreshSupplement() {
    if (supplementClient == null || typeof supplementClient.runJson !== 'function') {
      return Object.freeze({ ok: false, errorCode: 'SUPPLEMENT_UNAVAILABLE', rows: 0 });
    }
    if (supplement.inFlight !== null) {
      return supplement.inFlight;
    }
    supplement.attempts += 1;
    supplement.lastAttemptAt = clock();
    supplement.inFlight = (async () => {
      try {
        // The script constant is unchanged; only the rows this path cannot see are kept.
        const table = await supplementClient.runJson(CONNECTIONS_SCRIPT);
        const bound = toArray(table?.tcp).filter((row) => normalizeState(row?.state) === 'bound');
        supplement.rows = bound;
        supplement.ok = true;
        supplement.errorCode = null;
        supplement.lastOkAt = clock();
        return Object.freeze({ ok: true, errorCode: null, rows: bound.length });
      } catch (error) {
        supplement.ok = false;
        supplement.errorCode = error?.code ?? 'COMMAND_FAILED';
        return Object.freeze({ ok: false, errorCode: supplement.errorCode, rows: supplement.rows.length });
      } finally {
        supplement.inFlight = null;
      }
    })();
    return supplement.inFlight;
  }

  function supplementDue() {
    if (supplementClient == null) {
      return false;
    }
    if (supplement.lastAttemptAt === null) {
      return true;
    }
    return clock() - supplement.lastAttemptAt >= supplementIntervalMs;
  }

  /**
   * Read both endpoint tables, preferring the native provider.
   *
   * PERF-CPU / functional fix: `Get-NetTCPConnection` measured 4078 ms of CPU and 21.6 s of
   * wall time, past this source's 15 s timeout, so the script path never produced a row on
   * the reference host. `GetExtendedTcpTable`/`GetExtendedUdpTable` answer the same question
   * in about a millisecond with no subprocess, and the script stays as the fallback.
   */
  async function readTableRows() {
    if (native !== null) {
      try {
        const table = await native.readEndpointTable();
        return {
          table,
          transport: native.transport ?? 'win32-koffi',
          fallback: null,
        };
      } catch (error) {
        if (!powershell || typeof powershell.runJson !== 'function') {
          throw error;
        }
        return {
          table: await powershell.runJson(CONNECTIONS_SCRIPT),
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
      table: await powershell.runJson(CONNECTIONS_SCRIPT),
      transport: 'powershell',
      fallback: null,
    };
  }

  return Object.freeze({
    descriptor,
    sourceId: CONNECTIONS_SOURCE_ID,

    /**
     * Refresh the `state=Bound` cache now, bypassing the 60 s beat. Exposed for the parity
     * measurement and for an operator that wants the cache warm before the first poll; the
     * poll path never awaits it.
     */
    refreshSupplement,

    async read() {
      const readResult = await readTableRows();
      // The supplement runs on its own beat and is never awaited from a poll: a 20 s cmdlet
      // must not stretch a 5 s interval, and a failed supplement must not fail the read.
      // It is skipped when the fallback transport already produced the whole table.
      if (readResult.transport !== 'powershell' && supplementDue()) {
        void refreshSupplement();
      }
      const table = readResult.table;
      const nativeTcpRows = table?.tcp == null ? [] : (Array.isArray(table.tcp) ? table.tcp : [table.tcp]);
      const udpRows = table?.udp == null ? [] : (Array.isArray(table.udp) ? table.udp : [table.udp]);
      const supplementedRows = readResult.transport === 'powershell' ? [] : mergedSupplementRows(nativeTcpRows);
      const tcpRows = supplementedRows.length === 0
        ? nativeTcpRows
        : [...nativeTcpRows, ...supplementedRows];

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
          nativeTcp: nativeTcpRows.length,
          supplementedTcp: tcpRows.length - nativeTcpRows.length,
          udp: udpRows.length,
          unattributed,
          duplicateEntities: diff.duplicateEntities,
          suppressedRemovals: diff.suppressedRemovals,
          transport: readResult.transport,
          fallback: readResult.fallback,
          supplement: supplementStats(),
        }),
      };
    },
  });
}
