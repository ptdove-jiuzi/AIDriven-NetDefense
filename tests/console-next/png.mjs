/**
 * UI2-B11 · PNG 解码与像素差（零依赖，仅 node:zlib）
 *
 * Edge `--screenshot` 产出 8-bit PNG（通常为 RGBA / color type 6）。这里实现
 * 最小但正确的解码：IHDR + IDAT（inflate）+ 5 种 filter（None/Sub/Up/Average/Paeth），
 * 以及用于视觉回归的 `diffPng` / `compareAgainstBaseline`。
 *
 * 不支持的格式会显式抛错，不上报"通过"（fail-closed）。
 *
 * @author PT-dove
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const COLOR_TYPE_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解码 PNG。
 *
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,channels:number,colorType:number,bitDepth:number,pixels:Buffer,interlace:number}}
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('png: not a PNG buffer');
  }
  let offset = 8;
  let header = null;
  const idat = [];
  let palette = null;
  let transparency = null;
  let ended = false;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error('png: truncated chunk');
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataEnd + 4; // 跳过 CRC（不校验；CRC 校验留给专门工具）
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (header === null) throw new Error('png: missing IHDR');
  if (!ended) throw new Error('png: missing IEND');
  if (header.compression !== 0 || header.filter !== 0) throw new Error('png: unsupported compression/filter method');
  if (header.interlace !== 0) throw new Error('png: interlaced PNG is not supported');
  if (header.bitDepth !== 8) throw new Error(`png: only 8-bit PNG is supported (got ${header.bitDepth})`);
  const channels = COLOR_TYPE_CHANNELS[header.colorType];
  if (channels === undefined) throw new Error(`png: unsupported color type ${header.colorType}`);
  if (header.colorType === 3 && palette === null) throw new Error('png: palette image without PLTE');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const expected = header.height * (stride + 1);
  if (raw.length < expected) throw new Error(`png: IDAT too short (${raw.length} < ${expected})`);
  const pixels = Buffer.alloc(header.width * header.height * channels);
  unfilter(raw, pixels, header.width, header.height, channels, stride);

  if (header.colorType === 3) {
    // 调色板 → RGBA，便于统一比较。
    const rgba = Buffer.alloc(header.width * header.height * 4);
    for (let index = 0; index < header.width * header.height; index += 1) {
      const paletteIndex = pixels[index];
      const alpha = transparency !== null && paletteIndex < transparency.length ? transparency[paletteIndex] : 255;
      rgba[index * 4 + 0] = palette[paletteIndex * 3 + 0] ?? 0;
      rgba[index * 4 + 1] = palette[paletteIndex * 3 + 1] ?? 0;
      rgba[index * 4 + 2] = palette[paletteIndex * 3 + 2] ?? 0;
      rgba[index * 4 + 3] = alpha;
    }
    return { ...header, channels: 4, pixels: rgba };
  }
  return { ...header, channels, pixels };
}

function unfilter(raw, out, width, height, channels, stride) {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const previousStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[rawOffset + x];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[previousStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[previousStart + x - channels] : 0;
      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4:
          reconstructed = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`png: unknown row filter ${filter}`);
      }
      out[rowStart + x] = reconstructed & 0xff;
    }
    rawOffset += stride;
  }
  void width;
}

export function loadPng(filePath) {
  return decodePng(fs.readFileSync(filePath));
}

export function savePngBaseline(filePath, buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

/**
 * 像素差。两张图尺寸/通道必须一致（不同尺寸 → 直接 fail，不做缩放猜测）。
 *
 * @param {ReturnType<typeof decodePng>} a
 * @param {ReturnType<typeof decodePng>} b
 * @param {{pixelThreshold?:number}} [options] 单通道差 > pixelThreshold 记为"变了"
 * @returns {{width:number,height:number,totalPixels:number,changedPixels:number,changedRatio:number,meanAbsDiff:number,maxChannelDiff:number,box:{x0:number,y0:number,x1:number,y1:number}|null}}
 */
export function diffPng(a, b, options = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`png: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  if (a.channels !== b.channels) throw new Error('png: channel mismatch');
  const pixelThreshold = options.pixelThreshold ?? 8;
  const totalPixels = a.width * a.height;
  let changedPixels = 0;
  let sumAbs = 0;
  let maxChannelDiff = 0;
  const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  for (let index = 0; index < totalPixels; index += 1) {
    let pixelChanged = false;
    for (let channel = 0; channel < a.channels; channel += 1) {
      const offset = index * a.channels + channel;
      const delta = Math.abs(a.pixels[offset] - b.pixels[offset]);
      if (delta > maxChannelDiff) maxChannelDiff = delta;
      sumAbs += delta;
      if (delta > pixelThreshold) pixelChanged = true;
    }
    if (pixelChanged) {
      changedPixels += 1;
      const x = index % a.width;
      const y = Math.floor(index / a.width);
      if (x < box.x0) box.x0 = x;
      if (y < box.y0) box.y0 = y;
      if (x > box.x1) box.x1 = x;
      if (y > box.y1) box.y1 = y;
    }
  }
  return {
    width: a.width,
    height: a.height,
    totalPixels,
    changedPixels,
    changedRatio: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    meanAbsDiff: totalPixels === 0 ? 0 : sumAbs / (totalPixels * a.channels),
    maxChannelDiff,
    box: changedPixels === 0 ? null : box,
  };
}

/**
 * 与基线比较；基线不存在时（且允许写基线）写入并返回 `{baselineCreated:true}`。
 *
 * @param {string} baselinePath
 * @param {Buffer} actualBuffer
 * @param {{updateBaseline?: boolean, maxChangedRatio?: number, pixelThreshold?: number}} [options]
 */
export function compareAgainstBaseline(baselinePath, actualBuffer, options = {}) {
  const update = options.updateBaseline === true || process.env.B11_UPDATE_BASELINE === '1';
  if (!fs.existsSync(baselinePath)) {
    savePngBaseline(baselinePath, actualBuffer);
    return { baselineCreated: true, baselinePath, diff: null };
  }
  if (update) {
    savePngBaseline(baselinePath, actualBuffer);
    return { baselineCreated: false, updated: true, baselinePath, diff: null };
  }
  const expected = decodePng(fs.readFileSync(baselinePath));
  const actual = decodePng(actualBuffer);
  const diff = diffPng(expected, actual, { pixelThreshold: options.pixelThreshold ?? 8 });
  const limit = options.maxChangedRatio ?? 0.01;
  return {
    baselineCreated: false,
    updated: false,
    baselinePath,
    diff,
    // 判据以"变化像素占比"为准：maxChannelDiff 仍保留在报告里供诊断，但抗锯齿/字体的单点色值
    // 跳变不应单独把一次回归判红（会出现"全页 0.04% 变化却 213 单通道差"的假红）。
    ok: diff.changedRatio <= limit,
    limit,
  };
}
