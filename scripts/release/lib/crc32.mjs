/**
 * CRC-32 (IEEE 802.3, the one ZIP uses) — table driven, no dependency.
 * Exported because both the writer and the reader must agree byte for byte.
 */

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer, seed = 0) {
  let value = ~seed;
  for (let index = 0; index < buffer.length; index += 1) {
    value = TABLE[(value ^ buffer[index]) & 0xFF] ^ (value >>> 8);
  }
  return (~value) >>> 0;
}
