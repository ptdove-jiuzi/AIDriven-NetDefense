/**
 * TCP/UDP endpoint tables via `iphlpapi!GetExtendedTcpTable` / `GetExtendedUdpTable`.
 *
 * Replaces `Get-NetTCPConnection` + `Get-NetUDPEndpoint` (4078 ms of CPU and a wall time of
 * 21.6 s, which is past the source's 15 s timeout - so the old source never produced any
 * rows at all on the reference host) with four iphlpapi calls totalling about 1 ms.
 *
 * `TCP_TABLE_OWNER_MODULE_ALL` is used instead of `TCP_TABLE_OWNER_PID_ALL` because it also
 * carries `liCreateTimestamp`. The TCP entity identity is `5-tuple + creation time`, so
 * dropping the timestamp would collapse a reconnect onto the same entity - a silent
 * behaviour change, and precisely the pid/port reuse the identity exists to distinguish.
 *
 * Table layouts (x64 / Windows 10+, verified byte-for-byte against the NetTCPIP cmdlets and
 * against GetTcpTable2 - see docs/implementation/evidence/perf/fix-col-hot/):
 *
 *   MIB_TCPTABLE_OWNER_MODULE   header DWORD, rows start at offset 8 (the row type contains
 *                               LARGE_INTEGER, so the array is 8-byte aligned), row 160 B
 *   MIB_TCP6TABLE_OWNER_MODULE  same, row 192 B
 *   MIB_UDPTABLE_OWNER_PID      header DWORD, rows start at offset 4, row 12 B
 *   MIB_UDP6TABLE_OWNER_PID     same, row 28 B
 *
 * Rows are returned in the shape the NetTCPIP cmdlets produced so the source normalizers
 * (`normalizeTcp` / `normalizeUdp`) are unchanged: the state is spelled as the cmdlet enum
 * member ("TimeWait", not 11) and the creation time is already epoch milliseconds.
 */

import { fileTimeToEpochMs, formatIPv4, formatIPv6, portFromDword, withScopeId } from './format.js';

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_MODULE_ALL = 8;
const UDP_TABLE_OWNER_PID = 1;
const ERROR_SUCCESS = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NO_DATA = 232;

const TCP_LAYOUT = Object.freeze({
  [AF_INET]: Object.freeze({ base: 8, rowSize: 160, family: 'ipv4' }),
  [AF_INET6]: Object.freeze({ base: 8, rowSize: 192, family: 'ipv6' }),
});

const UDP_LAYOUT = Object.freeze({
  [AF_INET]: Object.freeze({ base: 4, rowSize: 12, family: 'ipv4' }),
  [AF_INET6]: Object.freeze({ base: 4, rowSize: 28, family: 'ipv6' }),
});

const INITIAL_TABLE_BYTES = 256 * 1024;
const MAX_TABLE_BYTES = 64 << 20;

/**
 * The MIB state numbers spelled as the NetTCPIP enum members.
 *
 * The script transport hands the normalizer the *member name* (`[string]$_.State` gives
 * "TimeWait"), which becomes the token `timewait`. If the native path handed over the raw
 * number instead, `normalizeState` would map it through its numeric table and produce
 * `time_wait`: a different state string for the same socket, i.e. one `changed` event for
 * every stateful socket on upgrade plus a silently different payload contract. Emitting the
 * enum spelling keeps both transports identical.
 */
const TCP_STATE_NAMES = Object.freeze({
  1: 'Closed',
  2: 'Listen',
  3: 'SynSent',
  4: 'SynReceived',
  5: 'Established',
  6: 'FinWait1',
  7: 'FinWait2',
  8: 'CloseWait',
  9: 'Closing',
  10: 'LastAck',
  11: 'TimeWait',
  12: 'DeleteTCB',
  13: 'Bound',
});

function stateName(number) {
  return TCP_STATE_NAMES[number] ?? String(number);
}

/**
 * Call one GetExtended*Table and grow the buffer until it accepts the size it reports as
 * needed. The returned size is only trusted when the call succeeds; on ERROR_NO_DATA the
 * host simply has no endpoint in that family, which is a valid empty read.
 */
function readTable(getter, af, tableClass, state) {
  let capacity = state.capacity;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (state.buffer === null || state.capacity !== capacity) {
      state.buffer = state.alloc(capacity);
      state.capacity = capacity;
    }
    state.encode(state.size, capacity);
    const status = getter(state.buffer, state.size, true, af, tableClass, 0);
    const used = state.decode(state.size);
    if (status === ERROR_SUCCESS) {
      return { buffer: state.buffer, capacity };
    }
    if (status === ERROR_NO_DATA) {
      return { buffer: null, capacity: 0 };
    }
    if (status !== ERROR_INSUFFICIENT_BUFFER) {
      throw new Error(`GetExtended*Table failed with status ${status}`);
    }
    const next = Math.min(MAX_TABLE_BYTES, Math.max(capacity * 2, used + 65536));
    if (next <= capacity) {
      throw new Error('GetExtended*Table: the kernel kept asking for a larger buffer');
    }
    capacity = next;
  }
  throw new Error('GetExtended*Table: buffer growth gave up');
}

/**
 * @param {object} bindings result of `loadBindings()`
 * @returns {() => { tcp: Array<object>, udp: Array<object> }} cmdlet-shaped rows
 */
export function createEndpointTableReader(bindings) {
  const { koffi } = bindings;
  const { GetExtendedTcpTable, GetExtendedUdpTable } = bindings;

  const makeState = () => ({
    buffer: null,
    capacity: INITIAL_TABLE_BYTES,
    size: koffi.alloc('uint32', 1),
    alloc: (bytes) => koffi.alloc('uint8', bytes),
    encode: (buffer, value) => koffi.encode(buffer, 'uint32', value),
    decode: (buffer) => koffi.decode(buffer, 'uint32'),
  });

  const tcpState4 = makeState();
  const tcpState6 = makeState();
  const udpState4 = makeState();
  const udpState6 = makeState();

  function readTcp(af, state) {
    const layout = TCP_LAYOUT[af];
    const { buffer, capacity } = readTable(GetExtendedTcpTable, af, TCP_TABLE_OWNER_MODULE_ALL, state);
    if (buffer === null) {
      return [];
    }
    const view = new DataView(koffi.view(buffer, capacity));
    const count = view.getUint32(0, true);
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const at = layout.base + index * layout.rowSize;
      if (at + layout.rowSize > capacity) {
        throw new Error(`TCP table (${layout.family}): row ${index} is past the end of the buffer`);
      }
      if (layout.family === 'ipv4') {
        rows.push({
          localAddress: formatIPv4(view.getUint32(at + 4, true)),
          localPort: portFromDword(view.getUint32(at + 8, true)),
          remoteAddress: formatIPv4(view.getUint32(at + 12, true)),
          remotePort: portFromDword(view.getUint32(at + 16, true)),
          state: stateName(view.getUint32(at, true)),
          owningProcess: view.getUint32(at + 20, true),
          creationTime: fileTimeToEpochMs(view.getBigInt64(at + 24, true)),
        });
      } else {
        rows.push({
          localAddress: withScopeId(
            formatIPv6(new Uint8Array(view.buffer, view.byteOffset + at, 16)),
            view.getUint32(at + 16, true),
          ),
          localPort: portFromDword(view.getUint32(at + 20, true)),
          remoteAddress: withScopeId(
            formatIPv6(new Uint8Array(view.buffer, view.byteOffset + at + 24, 16)),
            view.getUint32(at + 40, true),
          ),
          remotePort: portFromDword(view.getUint32(at + 44, true)),
          state: stateName(view.getUint32(at + 48, true)),
          owningProcess: view.getUint32(at + 52, true),
          creationTime: fileTimeToEpochMs(view.getBigInt64(at + 56, true)),
        });
      }
    }
    return rows;
  }

  function readUdp(af, state) {
    const layout = UDP_LAYOUT[af];
    const { buffer, capacity } = readTable(GetExtendedUdpTable, af, UDP_TABLE_OWNER_PID, state);
    if (buffer === null) {
      return [];
    }
    const view = new DataView(koffi.view(buffer, capacity));
    const count = view.getUint32(0, true);
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const at = layout.base + index * layout.rowSize;
      if (at + layout.rowSize > capacity) {
        throw new Error(`UDP table (${layout.family}): row ${index} is past the end of the buffer`);
      }
      if (layout.family === 'ipv4') {
        rows.push({
          localAddress: formatIPv4(view.getUint32(at, true)),
          localPort: portFromDword(view.getUint32(at + 4, true)),
          owningProcess: view.getUint32(at + 8, true),
        });
      } else {
        rows.push({
          localAddress: withScopeId(
            formatIPv6(new Uint8Array(view.buffer, view.byteOffset + at, 16)),
            view.getUint32(at + 16, true),
          ),
          localPort: portFromDword(view.getUint32(at + 20, true)),
          owningProcess: view.getUint32(at + 24, true),
        });
      }
    }
    return rows;
  }

  return function readEndpointTable() {
    return {
      tcp: [...readTcp(AF_INET, tcpState4), ...readTcp(AF_INET6, tcpState6)],
      udp: [...readUdp(AF_INET, udpState4), ...readUdp(AF_INET6, udpState6)],
    };
  };
}
