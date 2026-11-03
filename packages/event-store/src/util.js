/**
 * 存储层通用小工具：时钟、ID、摘要、时间解析。
 *
 * 这里刻意**不**重新实现规范化 JSON 或 DTO 校验：
 * 摘要与规范化一律复用 `packages/contracts`，否则会出现
 * "存储层算出的 digest 与合同层算出的 digest 不一致" 这种最难查的偏差。
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import { canonicalDigest, canonicalize } from '../../contracts/src/index.js';
import { STORE_CODES, StoreError } from './errors.js';

/** 审计链"没有前驱"的占位摘要，与合同层创世约定一致。 */
export const GENESIS_DIGEST = '0'.repeat(64);

export { canonicalDigest, canonicalize };

export function uuid() {
  return randomUUID();
}

/**
 * 高熵不透明令牌（nonce / idempotency_key / object_id）。
 * 32 个 base64url 字符，落在合同要求的 22..128 区间内。
 */
export function opaqueToken(byteLength = 24) {
  return randomBytes(byteLength).toString('base64url');
}

export function randomHex(byteLength = 16) {
  return randomBytes(byteLength).toString('hex');
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function hmacBase64(key, text) {
  return createHmac('sha256', key).update(String(text), 'utf8').digest('base64');
}

/** 当前时间的 RFC3339 UTC（毫秒精度，大写 Z），与合同字段规则一致。 */
export function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

export function msFromIso(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `not a parseable RFC3339 timestamp: ${String(iso)}`);
  }
  return ms;
}

/** UTC 日桶键 `YYYY-MM-DD`。预算按 UTC 日结算，不能用本地时区。 */
export function utcDayOf(iso) {
  return String(iso).slice(0, 10);
}

export function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `${name} must be a non-empty string`);
  }
  return value;
}

export function assertInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, `${name} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

/**
 * 注入式时钟：测试要能确定性地推进时间，不能靠 sleep。
 *
 * `monoMs` 是**单调时钟**源：没有它就无法区分"用户把系统时间往前调了 10 分钟"
 * 与"真的过了 10 分钟"（休眠唤醒）。注入时钟不提供 `monoMs` 时，
 * 存储层会明确跳过单调性校验，而不是拿 wall 时间假装单调。
 */
export function createClock(clock) {
  if (clock && typeof clock.nowIso === 'function' && typeof clock.nowMs === 'function') {
    return Object.freeze({
      nowIso: clock.nowIso,
      nowMs: clock.nowMs,
      monoMs: typeof clock.monoMs === 'function' ? clock.monoMs : null,
    });
  }
  if (clock !== undefined && clock !== null) {
    throw new StoreError(STORE_CODES.ERR_STORE_INPUT, 'clock must provide nowIso() and nowMs()');
  }
  return Object.freeze({
    nowIso: () => isoFromMs(Date.now()),
    nowMs: () => Date.now(),
    // performance.now() 是单调时钟，不受系统时间调整与 NTP 回拨影响。
    monoMs: () => performance.now(),
  });
}

/** 从 store 或显式参数解析"现在"，保证每个事务用的是同一个时间点。 */
export function resolveNow(store, explicit) {
  if (typeof explicit === 'string') return explicit;
  return store.clock.nowIso();
}

/** JSON 序列化使用规范化输出，保证"同样的值 → 同样的字节 → 同样的摘要"。 */
export function toCanonicalJson(value) {
  return canonicalize(value);
}

export function parseJson(text, context) {
  try {
    return JSON.parse(text);
  } catch (error) {
    // 库里出现解析不了的 JSON 说明数据被外部改过，属于一致性事故。
    throw new StoreError(STORE_CODES.ERR_DB_INTEGRITY, `${context}: stored JSON is not parseable`);
  }
}

/** 文件字节数；不存在或无权限时返回 `null`（容量评估需要区分"0 字节"与"读不到"）。 */
export function fileSizeOrNull(filePath) {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) {
      return null;
    }
    throw error;
  }
}
