/**
 * Network connection table source (§5.1 "网络": procfs net/tcp(6), udp(6), 5 s).
 *
 * Why `/proc/net/*` and not `ss`/`netstat`: the tables expose the socket inode, which is the
 * only stable handle that can be tied back to a process via `/proc/<pid>/fd`. `ss` prints a
 * formatted table and needs its own privileges.
 *
 * Identity: the socket inode. It is unique for the lifetime of a socket, so a
 * connect/disconnect pair is an added/removed transition rather than a mutated row. Rows
 * whose inode is `0` (kernel sockets and most TIME_WAIT entries) fall back to a hash of the
 * 4-tuple plus state, which is declared as an approximation.
 *
 * Blind spots are structural, not incidental:
 * - a connection that opens and closes inside one 5 s interval is never in the table;
 * - `socket:[inode]` → pid resolution requires read access to `/proc/<pid>/fd`, so the
 *   owner of another user's socket is unknown unless the collector runs as root (not
 *   required and not assumed);
 * - TIME_WAIT rows carry no inode and therefore no owner;
 * - only the current network namespace is visible.
 */

import {
  buildSnapshotRecord,
  createSnapshotDiffer,
  shortHash,
  stateDigest,
} from '../diff.js';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertNonNegativeInteger,
  assertPositiveInteger,
} from '../errors.js';
import { DEFAULT_MAX_ENTITIES } from '../diff.js';
import { assertSourceDescriptor } from './descriptor.js';
import { normalizePayload } from '../payload.js';

export const CONNECTION_SOURCE_ID = 'linux.procfs-connections';
export const CONNECTION_INTERVAL_MS = 5_000;
export const DEFAULT_NET_ROOT = '/proc/net';
export const DEFAULT_PROC_ROOT_FOR_OWNERS = '/proc';
export const DEFAULT_MAX_OWNER_SCAN = 200_000;

export const TCP_STATES = Object.freeze({
  '01': 'established',
  '02': 'syn_sent',
  '03': 'syn_recv',
  '04': 'fin_wait1',
  '05': 'fin_wait2',
  '06': 'time_wait',
  '07': 'close',
  '08': 'close_wait',
  '09': 'last_ack',
  '0A': 'listen',
  '0B': 'closing',
  '0C': 'new_syn_recv',
});

export const CONNECTION_FIELDS = Object.freeze([
  { name: 'protocol', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'family', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'local_address', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'local_port', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'remote_address', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'remote_port', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'state', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'uid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'inode', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'pid', type: 'integer', completeness: 'admin', sensitivity: 'D1' },
  { name: 'process_name', type: 'string', completeness: 'admin', sensitivity: 'D2' },
  { name: 'tx_queue', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'rx_queue', type: 'integer', completeness: 'always', sensitivity: 'D1' },
]);

export const CONNECTION_DESCRIPTOR = assertSourceDescriptor({
  stableSourceId: CONNECTION_SOURCE_ID,
  kind: 'poll',
  intervalMs: CONNECTION_INTERVAL_MS,
  requiresRoot: false,
  emits: ['linux.connection'],
  declaredPaths: [
    `${DEFAULT_NET_ROOT}/tcp`,
    `${DEFAULT_NET_ROOT}/tcp6`,
    `${DEFAULT_NET_ROOT}/udp`,
    `${DEFAULT_NET_ROOT}/udp6`,
  ],
  permissions: {
    required: [`read access to ${DEFAULT_NET_ROOT}/tcp,udp,tcp6,udp6 (world readable)`],
    optional: [
      'root for reading /proc/<pid>/fd of other users (socket to process association)',
      'hidepid=0/1 for the same association as a non-root user',
    ],
    degradedWithout: ['pid', 'process_name'],
  },
  fields: CONNECTION_FIELDS,
  blindSpots: [
    'A connection opened and closed inside one 5 s interval is never present in the table',
    'The socket inode to pid association requires read access to /proc/<pid>/fd; other users sockets stay unowned without root, which is reported as fieldGaps [pid, process_name] instead of degrading the read',
    'TIME_WAIT and other kernel-owned rows report inode 0 and are identified by a 4-tuple hash instead of an inode',
    'Only the network namespace of the collector process is visible; host sockets from other namespaces are not enumerated',
    'Raw sockets (/proc/net/raw, raw6) and unix domain sockets are not covered',
    'Queue depths change continuously and are reported but excluded from the state digest, so a queue-only change is not an event',
  ],
  rotation: 'none: the four tables are append-only views of live kernel state; a table that disappears (IPv6 disabled) is reported as a declined table, not as an empty connection list',
  gapSemantics: [
    'poll: all four tables unreadable yields status=error and no records, never an empty-but-healthy result',
    'poll: one missing table (for example tcp6 with IPv6 compiled out) is a host blind spot, reported in stats.missingTables and not as a degraded read',
    'poll: two consecutive identical reads produce no records; an idle network is not a gap',
    'poll: more distinct sockets than maxEntities truncates the read and is reported as an io_error gap with an unknown count',
  ],
  degradation: {
    onDenied: 'status=denied, permissions.missing names the net table directory, nothing is published, and removals for the blinded family are suppressed',
    onPartial: 'status=partial when a table was denied or a row could not be parsed; the readable tables are still published',
    onEmptyTable: 'status=error with code ENOENT when all four tables are absent; a genuinely empty table (no rows) is a valid ok read',
    neverHealthyWhenEmpty: true,
  },
  emittedGapReasons: ['permission_denied', 'io_error'],
});

/** `0100007F` (little-endian hex) → `127.0.0.1`. */
export function decodeIpv4(hex) {
  if (typeof hex !== 'string' || hex.length !== 8) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, `malformed IPv4 hex: ${String(hex)}`);
  }
  const bytes = [];
  for (let index = 6; index >= 0; index -= 2) {
    const value = Number.parseInt(hex.slice(index, index + 2), 16);
    if (!Number.isSafeInteger(value)) {
      throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, `malformed IPv4 hex: ${hex}`);
    }
    bytes.push(value);
  }
  return bytes.join('.');
}

/**
 * `/proc/net/tcp6` stores the address as four 32-bit words in host (little-endian) byte
 * order: the bytes inside each 4-byte word are reversed, but the words themselves keep
 * their network order. `00000000000000000000000001000000` → `::1`.
 */
export function decodeIpv6(hex) {
  if (typeof hex !== 'string' || hex.length !== 32) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, `malformed IPv6 hex: ${String(hex)}`);
  }
  const groups = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    const bytes = [];
    for (let byte = 6; byte >= 0; byte -= 2) {
      bytes.push(chunk.slice(byte, byte + 2).toLowerCase());
    }
    // Two 16-bit groups per word, in network order.
    groups.push(`${bytes[0]}${bytes[1]}`, `${bytes[2]}${bytes[3]}`);
  }
  // RFC 5952: compress the longest run of zero groups (length >= 2), leftmost on a tie.
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index] === '0000') {
      if (currentStart < 0) {
        currentStart = index;
        currentLength = 0;
      }
      currentLength += 1;
      if (currentLength > bestLength) {
        bestLength = currentLength;
        bestStart = currentStart;
      }
    } else {
      currentStart = -1;
      currentLength = 0;
    }
  }
  const short = (group) => group.replace(/^0+(?=.)/, '');
  if (bestLength >= 2) {
    const head = groups.slice(0, bestStart).map(short).join(':');
    const tail = groups.slice(bestStart + bestLength).map(short).join(':');
    return `${head}::${tail}`;
  }
  return groups.map(short).join(':');
}

export function decodeAddress(hex, family) {
  return family === 'ipv6' ? decodeIpv6(hex) : decodeIpv4(hex);
}

function parseEndpoint(token) {
  if (typeof token !== 'string' || !token.includes(':')) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, `malformed endpoint: ${String(token)}`);
  }
  const index = token.lastIndexOf(':');
  const addressHex = token.slice(0, index);
  const port = Number.parseInt(token.slice(index + 1), 16);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, `malformed port: ${token}`);
  }
  return { addressHex, port };
}

/**
 * Parse one `/proc/net/{tcp,udp}` table. Returns `{ rows, malformed }`; a single bad row
 * never discards the rest of the table.
 */
export function parseNetTable(text, { protocol, family }) {
  const rows = [];
  let malformed = 0;
  const lines = typeof text === 'string' ? text.split('\n') : [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('sl')) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 10) {
      malformed += 1;
      continue;
    }
    try {
      const local = parseEndpoint(parts[1]);
      const remote = parseEndpoint(parts[2]);
      const queue = parts[4].split(':');
      const uid = Number.parseInt(parts[7], 10);
      const inode = Number.parseInt(parts[9], 10);
      rows.push(Object.freeze({
        protocol,
        family,
        localAddress: decodeAddress(local.addressHex, family),
        localPort: local.port,
        remoteAddress: decodeAddress(remote.addressHex, family),
        remotePort: remote.port,
        stateCode: parts[3].toUpperCase(),
        state: TCP_STATES[parts[3].toUpperCase()] ?? 'unknown',
        txQueue: Number.parseInt(queue[0] ?? '0', 16) || 0,
        rxQueue: Number.parseInt(queue[1] ?? '0', 16) || 0,
        uid: Number.isSafeInteger(uid) ? uid : null,
        inode: Number.isSafeInteger(inode) && inode >= 0 ? inode : 0,
      }));
    } catch {
      malformed += 1;
    }
  }
  return Object.freeze({ rows: Object.freeze(rows), malformed });
}

const SOCKET_LINK_PATTERN = /^socket:\[(\d+)\]$/;

/**
 * Build `inode → {pid, name}` by scanning `/proc/<pid>/fd`. Bounded by `maxEntries` so a
 * pathological process cannot make the poll unbounded; `denied` counts directories we may
 * not read (the normal case for another user's processes).
 */
export async function scanSocketOwners({
  fileSystem,
  procRoot = '/proc',
  maxEntries = DEFAULT_MAX_OWNER_SCAN,
}) {
  const owners = new Map();
  const listing = await fileSystem.readDir(procRoot, { maxEntries: 262_144 });
  if (!listing.ok) {
    return Object.freeze({
      ok: false,
      code: listing.code,
      outcome: listing.outcome,
      owners,
      scanned: 0,
      denied: 0,
      truncated: false,
    });
  }

  let scanned = 0;
  let denied = 0;
  let truncated = false;
  const pidNames = listing.entries
    .filter((entry) => entry.kind === 'directory' && /^\d+$/.test(entry.name))
    .map((entry) => entry.name);

  for (const pid of pidNames) {
    if (scanned >= maxEntries) {
      truncated = true;
      break;
    }
    const fdDir = `${procRoot}/${pid}/fd`;
    const fds = await fileSystem.readDir(fdDir, { maxEntries: 4096 });
    if (!fds.ok) {
      if (fds.outcome === 'permission_denied') {
        denied += 1;
      }
      continue;
    }
    const commResult = await fileSystem.readText(`${procRoot}/${pid}/comm`, { maxBytes: 256 });
    const name = commResult.ok ? commResult.text.trim().slice(0, 64) : null;
    for (const entry of fds.entries) {
      if (scanned >= maxEntries) {
        truncated = true;
        break;
      }
      scanned += 1;
      const link = await fileSystem.readLink(`${fdDir}/${entry.name}`);
      if (!link.ok) {
        continue;
      }
      const match = SOCKET_LINK_PATTERN.exec(link.target);
      if (match === null) {
        continue;
      }
      const inode = Number.parseInt(match[1], 10);
      if (!Number.isSafeInteger(inode)) {
        continue;
      }
      if (!owners.has(inode)) {
        owners.set(inode, Object.freeze({ pid: Number.parseInt(pid, 10), name }));
      }
    }
  }

  return Object.freeze({ ok: true, owners, scanned, denied, truncated });
}

export function createProcfsConnectionSource({
  fileSystem,
  clock = Date.now,
  intervalMs = CONNECTION_INTERVAL_MS,
  netRoot = DEFAULT_NET_ROOT,
  procRoot = DEFAULT_PROC_ROOT_FOR_OWNERS,
  maxEntities = DEFAULT_MAX_ENTITIES,
  resolveOwners = true,
  maxOwnerScanEntries = DEFAULT_MAX_OWNER_SCAN,
  includeDatagram = true,
} = {}) {
  if (!fileSystem || typeof fileSystem.readText !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a file system exposing readText/readDir is required',
    );
  }
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('maxEntities', maxEntities);
  assertNonNegativeInteger('maxOwnerScanEntries', maxOwnerScanEntries);

  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = Object.freeze({ ...CONNECTION_DESCRIPTOR, intervalMs });
  const tables = includeDatagram
    ? [
      { file: 'tcp', protocol: 'tcp', family: 'ipv4' },
      { file: 'tcp6', protocol: 'tcp', family: 'ipv6' },
      { file: 'udp', protocol: 'udp', family: 'ipv4' },
      { file: 'udp6', protocol: 'udp', family: 'ipv6' },
    ]
    : [
      { file: 'tcp', protocol: 'tcp', family: 'ipv4' },
      { file: 'tcp6', protocol: 'tcp', family: 'ipv6' },
    ];

  return Object.freeze({
    descriptor,

    async read() {
      const observedAt = clock();
      const denials = [];
      const rows = [];
      let malformed = 0;
      let readableTables = 0;
      let missingTables = 0;
      let truncatedReads = 0;
      let ownerFieldsMissing = false;

      for (const table of tables) {
        const result = await fileSystem.readText(`${netRoot}/${table.file}`, { maxBytes: 4 * 1024 * 1024 });
        if (!result.ok) {
          if (result.outcome === 'permission_denied') {
            denials.push({
              path: `${netRoot}/${table.file}`,
              code: result.code,
              outcome: result.outcome,
              // Exact entity prefix, so a denied tcp table does not suppress tcp6 removals.
              entityPrefix: `${table.protocol}${table.family === 'ipv6' ? '6' : '4'}-`,
            });
          } else {
            // A missing table is normal (IPv6 compiled out, netns without udp6), so it is
            // not a denial; it is still counted so an all-missing read can fail loudly.
            missingTables += 1;
          }
          continue;
        }
        readableTables += 1;
        if (result.truncated) {
          truncatedReads += 1;
        }
        const parsed = parseNetTable(result.text, { protocol: table.protocol, family: table.family });
        malformed += parsed.malformed;
        for (const row of parsed.rows) {
          rows.push(row);
        }
      }

      if (readableTables === 0) {
        const denied = denials.length > 0;
        return Object.freeze({
          status: denied ? 'denied' : 'error',
          errorCode: denied ? 'EACCES' : 'ENOENT',
          records: [],
          denials: denials.length > 0
            ? denials
            : [{ path: netRoot, code: 'ENOENT', outcome: 'not_found' }],
          permissions: { granted: [], missing: denied ? [netRoot] : [] },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: false,
          observedAt,
          error: {
            code: denied ? 'EACCES' : 'ENOENT',
            message: `no network table under ${netRoot} could be read`,
          },
        });
      }

      let ownerScan = Object.freeze({ ok: false, owners: new Map(), scanned: 0, denied: 0, truncated: false });
      if (resolveOwners) {
        ownerScan = await scanSocketOwners({
          fileSystem,
          procRoot,
          maxEntries: maxOwnerScanEntries,
        });
        // An unreadable /proc/<pid>/fd of *other users* is the documented non-root state, not
        // a broken read: the socket/pid association is declared `admin` completeness, so its
        // absence is reported in stats and fieldGaps instead of degrading the whole source.
        // Degrading here would make every non-root host permanently `partial` and drown the
        // real degradation signal.
        if (!ownerScan.ok || ownerScan.denied > 0) {
          ownerFieldsMissing = true;
        }
      }

      const items = [];
      for (const row of rows) {
        const owner = row.inode > 0 ? ownerScan.owners.get(row.inode) : undefined;
        const pid = owner === undefined ? null : owner.pid;
        const processName = owner === undefined ? null : owner.name;
        const digest = stateDigest({
          protocol: row.protocol,
          local: `${row.localAddress}:${row.localPort}`,
          remote: `${row.remoteAddress}:${row.remotePort}`,
          state: row.state,
          uid: row.uid,
          pid,
        });
        const entityId = row.inode > 0
          ? `${row.protocol}${row.family === 'ipv6' ? '6' : '4'}-${row.inode}`
          : `${row.protocol}${row.family === 'ipv6' ? '6' : '4'}-q-${shortHash({
            local: `${row.localAddress}:${row.localPort}`,
            remote: `${row.remoteAddress}:${row.remotePort}`,
            state: row.state,
          }, 12)}`;
        items.push({
          entityId,
          digest,
          payload: normalizePayload({
            protocol: row.protocol,
            family: row.family,
            local_address: row.localAddress,
            local_port: row.localPort,
            remote_address: row.remoteAddress,
            remote_port: row.remotePort,
            state: row.state,
            uid: row.uid,
            inode: row.inode,
            pid,
            process_name: processName,
            tx_queue: row.txQueue,
            rx_queue: row.rxQueue,
            owner_resolved: owner !== undefined,
          }).payload,
        });
      }

      // A denied table blinds exactly one family, so only that family's removals are
      // suppressed. An unparsable row or a truncated read is global evidence loss.
      const globalLoss = malformed > 0 || truncatedReads > 0;
      const deniedPrefixes = denials
        .map((denial) => denial.entityPrefix)
        .filter((prefix) => typeof prefix === 'string');
      const diff = differ.diff(items, {
        suppressRemovalsFor: (entry) => globalLoss
          || deniedPrefixes.some((prefix) => entry.entityId.startsWith(prefix)),
      });
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: 'linux.connection',
          entityId: entry.entityId,
          digest: entry.digest,
          observedAt,
          change: entry.kind === 'snapshot' ? 'snapshot' : entry.kind,
          payload: normalizePayload(entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true }).payload,
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      // A missing table (IPv6 compiled out, no udp6 in this namespace) is a documented blind
      // spot of the host, not a degraded read; it stays in stats. A denied table, an
      // unparsable row or a truncated read *is* a degraded read.
      let status = 'ok';
      if (denials.length > 0 || malformed > 0 || truncatedReads > 0) {
        status = 'partial';
      }

      return Object.freeze({
        status,
        records,
        denials,
        permissions: { granted: [netRoot], missing: [] },
        nextCursor: null,
        identity: { fileId: CONNECTION_SOURCE_ID, size: items.length },
        snapshot: diff.snapshot,
        truncated: diff.truncated || truncatedReads > 0,
        observedAt,
        fieldGaps: ownerFieldsMissing ? Object.freeze(['pid', 'process_name']) : Object.freeze([]),
        suppressedRemovals: diff.suppressedRemovals,
        stats: Object.freeze({
          rows: rows.length,
          malformed,
          missingTables,
          truncatedReads,
          ownerFieldsMissing,
          ownerScan: Object.freeze({
            ok: ownerScan.ok,
            scanned: ownerScan.scanned,
            denied: ownerScan.denied,
            truncated: ownerScan.truncated,
            resolved: ownerScan.owners.size,
          }),
        }),
        error: null,
      });
    },
  });
}
