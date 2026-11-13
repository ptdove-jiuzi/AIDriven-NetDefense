/**
 * Value formatting shared by the native table readers.
 *
 * Every value produced here has to match exactly what the PowerShell path produced, because
 * the source normalizers (`sources/processes.js`, `sources/connections.js`) are deliberately
 * left untouched: the swimlane change is "how the table is obtained", not "what a row means".
 */

/** 1601-01-01T00:00:00Z in Unix milliseconds: FILETIME is 100 ns ticks since that epoch. */
export const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;

/**
 * Convert a Win32 FILETIME (100 ns ticks since 1601) to Unix epoch milliseconds.
 * A zero or negative value means "not available" (the kernel reports this for a few
 * pseudo-processes), and must not become 1601.
 */
export function fileTimeToEpochMs(fileTime) {
  if (typeof fileTime === 'bigint') {
    if (fileTime <= 0n) {
      return null;
    }
    return Number(fileTime / 10_000n) - FILETIME_EPOCH_OFFSET_MS;
  }
  if (typeof fileTime !== 'number' || !Number.isFinite(fileTime) || fileTime <= 0) {
    return null;
  }
  return Math.floor(fileTime / 10_000) - FILETIME_EPOCH_OFFSET_MS;
}

/** Dotted-quad from the DWORD the MIB tables store in network byte order. */
export function formatIPv4(dword) {
  return `${dword & 0xff}.${(dword >>> 8) & 0xff}.${(dword >>> 16) & 0xff}.${(dword >>> 24) & 0xff}`;
}

/**
 * Canonical RFC 5952 text for 16 raw address bytes.
 *
 * This is the spelling `[System.Net.IPAddress]::ToString()` produces, which is what both
 * `Get-NetTCPConnection` and `Get-NetUDPEndpoint` report: lowercase hex, no leading zeros,
 * the longest run of two or more zero groups (the first on a tie) collapsed to `::`, and an
 * IPv4-mapped address kept in its dotted form. Matching it is what makes the two
 * implementations comparable field by field.
 */
export function formatIPv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((bytes[index] << 8) | bytes[index + 1]);
  }
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  let bestStart = -1;
  let bestLength = 1;
  let runStart = -1;
  for (let index = 0; index <= 8; index += 1) {
    if (index < 8 && groups[index] === 0) {
      if (runStart < 0) {
        runStart = index;
      }
    } else if (runStart >= 0) {
      if (index - runStart > bestLength) {
        bestStart = runStart;
        bestLength = index - runStart;
      }
      runStart = -1;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) {
    return hex.join(':');
  }
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/**
 * Append the IPv6 scope id the way .NET does. A socket with scope id 0 (global address)
 * gets no suffix; a link-local endpoint gets `%<index>`, which the PowerShell path also
 * reported and which is therefore part of the entity identity.
 */
export function withScopeId(address, scopeId) {
  return scopeId > 0 ? `${address}%${scopeId}` : address;
}

/** Little-endian port DWORD from the MIB tables (network byte order in the low 16 bits). */
export function portFromDword(dword) {
  return ((dword & 0xff) << 8) | ((dword >>> 8) & 0xff);
}
