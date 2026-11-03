/**
 * Broker 内部小工具：摘要、UUID、ISO 时间、字节长度。
 *
 * 刻意不引第三方依赖：出口控制面的依赖面越小，供应链面越小。
 */

import { createHash, randomUUID } from 'node:crypto';

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function uuid() {
  return randomUUID();
}

export function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

export function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}
