/**
 * Deterministic ZIP writer (author PT-dove).
 *
 * Why not `Compress-Archive` or a library: both stamp the current time into every
 * entry, and the archive is the deliverable — a package whose hash changes every
 * time you rebuild it cannot be compared, re-verified, or referenced from a status
 * file. This writer therefore fixes every field that would otherwise float:
 *
 *   * timestamp      constant 1980-01-01 00:00:00 (the ZIP epoch)
 *   * entry order    sorted by name, byte order, never filesystem order
 *   * permissions    0, DOS attributes 0 — no host mode bits leak in
 *   * extra fields   none, no comments, no data descriptors
 *   * compression    one fixed zlib level per archive
 *
 * Same inputs => same bytes => same sha256. `tests/dist/zip.test.js` pins that.
 *
 * Limits are checked rather than silently truncated: this is a classic ZIP
 * (4 GiB / 65 535 entries), which is far above anything this package needs.
 */

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

import { crc32 } from './crc32.mjs';

const LOCAL_HEADER_SIGNATURE = 0x04034B50;
const CENTRAL_HEADER_SIGNATURE = 0x02014B50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054B50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;
const FLAG_UTF8 = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MAX_ENTRIES = 0xffff;
const MAX_UINT32 = 0xffffffff;

function needsUtf8Flag(nameBuffer) {
  for (const byte of nameBuffer) {
    if (byte > 0x7f) return true;
  }
  return false;
}

/**
 * @param {object} options
 * @param {string} options.outPath            archive to create (overwritten)
 * @param {Array<{name: string, absPath: string}>} options.entries
 *        `name` is the in-archive path with forward slashes and no leading slash.
 * @param {number} [options.level]            zlib level, default 6
 */
export function writeZipSync({ outPath, entries, level = 6 }) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('writeZipSync: no entries');
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`writeZipSync: ${entries.length} entries exceeds the classic ZIP limit of ${MAX_ENTRIES}`);
  }

  const sorted = [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].name === sorted[index - 1].name) throw new Error(`writeZipSync: duplicate entry ${sorted[index].name}`);
  }

  const fd = openSync(outPath, 'w');
  const central = [];
  let offset = 0;

  try {
    for (const entry of sorted) {
      if (entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.includes('..')) {
        throw new Error(`writeZipSync: unsafe entry name ${entry.name}`);
      }
      const data = readFileSync(entry.absPath);
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      const flags = needsUtf8Flag(nameBuffer) ? FLAG_UTF8 : 0;
      const compressed = data.length === 0 ? Buffer.alloc(0) : deflateRawSync(data, { level });
      const method = data.length === 0 ? METHOD_STORE : METHOD_DEFLATE;
      const payload = method === METHOD_STORE ? data : compressed;
      const checksum = crc32(data);

      if (data.length > MAX_UINT32 || payload.length > MAX_UINT32) {
        throw new Error(`writeZipSync: ${entry.name} is too large for a classic ZIP`);
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
      local.writeUInt16LE(VERSION_NEEDED, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      local.writeUInt16LE(0, 28);

      writeSync(fd, local);
      writeSync(fd, nameBuffer);
      if (payload.length > 0) writeSync(fd, payload);

      central.push({
        nameBuffer,
        flags,
        method,
        checksum,
        compressedSize: payload.length,
        uncompressedSize: data.length,
        offset,
      });
      offset += local.length + nameBuffer.length + payload.length;
      if (offset > MAX_UINT32) throw new Error('writeZipSync: archive exceeds the classic ZIP 4 GiB limit');
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const record of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
      header.writeUInt16LE(VERSION_MADE_BY, 4);
      header.writeUInt16LE(VERSION_NEEDED, 6);
      header.writeUInt16LE(record.flags, 8);
      header.writeUInt16LE(record.method, 10);
      header.writeUInt16LE(DOS_TIME, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(record.checksum, 16);
      header.writeUInt32LE(record.compressedSize, 20);
      header.writeUInt32LE(record.uncompressedSize, 24);
      header.writeUInt16LE(record.nameBuffer.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk start
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(0, 38); // external attributes
      header.writeUInt32LE(record.offset, 42);
      writeSync(fd, header);
      writeSync(fd, record.nameBuffer);
      centralSize += header.length + record.nameBuffer.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    writeSync(fd, end);

    return { entries: central.length, bytes: offset + centralSize + end.length, level };
  } finally {
    closeSync(fd);
  }
}
