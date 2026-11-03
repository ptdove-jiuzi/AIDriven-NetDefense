/**
 * Minimal ZIP reader (author PT-dove) — central directory parsing plus entry
 * extraction, no dependency and no shelling out to `tar`/`Expand-Archive`.
 *
 * The verifier must be able to answer "how many files are in this archive, and
 * does each one still hash to what the archive claims" without trusting an
 * extractor's own accounting. Reading the central directory directly is also the
 * only way to count *file* entries rather than directory entries, which is what
 * the acceptance criterion (`payload count + added count`) is expressed in.
 */

import { crc32 } from './crc32.mjs';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;
const END_RECORD_SIZE = 22;
const MAX_COMMENT = 0xffff;

export class ZipArchive {
  constructor(path) {
    this.path = path;
    this.fd = openSync(path, 'r');
    this.entries = [];
    this._readCentralDirectory();
  }

  _readAt(position, length) {
    const buffer = Buffer.alloc(length);
    const read = readSync(this.fd, buffer, 0, length, position);
    if (read !== length) throw new Error(`short read at ${position} (wanted ${length}, got ${read})`);
    return buffer;
  }

  _readCentralDirectory() {
    const size = this._fileSize();
    const tailLength = Math.min(size, END_RECORD_SIZE + MAX_COMMENT);
    const tail = this._readAt(size - tailLength, tailLength);
    let endOffset = -1;
    for (let index = tail.length - END_RECORD_SIZE; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
      const commentLength = tail.readUInt16LE(index + 20);
      if (index + END_RECORD_SIZE + commentLength === tail.length) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw new Error(`not a ZIP archive (no end record): ${this.path}`);

    const total = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported by this reader');
    }

    const central = this._readAt(centralOffset, centralSize);
    let cursor = 0;
    for (let index = 0; index < total; index += 1) {
      if (central.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
        throw new Error(`central directory entry ${index} has a bad signature`);
      }
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const checksum = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      this.entries.push({
        name,
        flags,
        method,
        crc32: checksum,
        compressedSize,
        uncompressedSize,
        localOffset,
        isDirectory: name.endsWith('/'),
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
  }

  _fileSize() {
    // Needed before the first read, so it comes from the descriptor we already hold.
    return fstatSync(this.fd).size;
  }

  /** Raw (still compressed) payload of one entry. */
  readRaw(entry) {
    const header = this._readAt(entry.localOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) throw new Error(`bad local header for ${entry.name}`);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    return this._readAt(start, entry.compressedSize);
  }

  /** Decompressed bytes of one entry, with the CRC checked. */
  readFile(entry) {
    const raw = this.readRaw(entry);
    if (entry.method === METHOD_STORE) {
      const actual = crc32(raw);
      if (actual !== entry.crc32) throw new Error(`CRC mismatch for ${entry.name}`);
      return raw;
    }
    if (entry.method !== METHOD_DEFLATE) throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
    let data;
    try {
      data = raw.length === 0 ? Buffer.alloc(0) : inflateRawSync(raw);
    } catch (error) {
      throw new Error(`corrupt deflate stream for ${entry.name}: ${error.message}`);
    }
    if (data.length !== entry.uncompressedSize) throw new Error(`size mismatch for ${entry.name}`);
    if (crc32(data) !== entry.crc32) throw new Error(`CRC mismatch for ${entry.name}`);
    return data;
  }

  fileEntries() {
    return this.entries.filter((entry) => !entry.isDirectory);
  }

  /**
   * Extract everything under `destination`. Refuses entry names that would escape
   * the destination (`..`, absolute, drive-qualified) instead of "best effort"
   * writing them somewhere surprising.
   */
  extractAll(destination) {
    const root = resolve(destination);
    const rootWithSep = root.endsWith(sep) ? root.toLowerCase() : `${root.toLowerCase()}${sep}`;
    let written = 0;
    for (const entry of this.entries) {
      const normalized = entry.name.replace(/\\/g, '/');
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`refusing to extract unsafe entry name: ${entry.name}`);
      }
      const target = resolve(join(root, ...normalized.split('/').filter((part) => part.length > 0)));
      if (!target.toLowerCase().startsWith(rootWithSep)) {
        throw new Error(`entry escapes the destination: ${entry.name}`);
      }
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, this.readFile(entry));
      written += 1;
    }
    return written;
  }

  close() {
    closeSync(this.fd);
  }
}
