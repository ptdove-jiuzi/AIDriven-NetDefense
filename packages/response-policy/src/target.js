/**
 * target.js — canonical target identity for the policy gate.
 *
 * A target is more than a name. Design §10.2 forbids terminating a bare PID,
 * quarantining a path string and touching a network rule that is not ours, so
 * every target kind here requires an **identity anchor** that the platform
 * adapter obtained from a handle or from our own `operation_id`:
 *
 *   file     → `object_id` + `object_id_source` ∈ {file_handle, parent_dir_handle}
 *   process  → `object_id` + `object_id_source` = process_handle + creation time
 *   network  → `operation_id` that this product issued
 *
 * The digest is computed over the *normalised* identity, which is what the
 * proposal, approval and grant bind to. Two inputs that differ only in spelling
 * must collapse to one digest; two inputs that name different objects must never
 * collide.
 */

import { canonicalDigest } from '@aegisharness/contracts';
import { isSupportedOs } from './catalog.js';
import { policyFail } from './errors.js';
import { normalizeCanonicalPath, TARGET_PATH_CODES } from './paths.js';
import { REASON_CODES } from './reasons.js';
import { parseUtcMs } from './time.js';

/** Target kinds mirrored from the contracts `normalized_target.target_kind`. */
export const TARGET_KINDS = Object.freeze(['process', 'network', 'file']);

/** Identity sources accepted per kind. Anything else is "not an identity". */
export const OBJECT_ID_SOURCES = Object.freeze({
  file: Object.freeze(['file_handle', 'parent_dir_handle']),
  process: Object.freeze(['process_handle']),
  network: Object.freeze(['operation_id']),
});

const OPAQUE_ID = /^[A-Za-z0-9_-]{22,128}$/u;
const IPV4_OR_IPV6 = /^[0-9A-Fa-f:.]+$/u;

const BRAND = Symbol('aegisharness.response-policy.normalized-target');

/**
 * Set of targets this module actually issued.
 *
 * A plain `value[BRAND] === true` check is forgeable: the brand is an enumerable
 * symbol, so `{ ...normalizedTarget, digest: 'f'.repeat(64) }` copies it and would
 * be accepted as "already normalised", letting a caller dictate a digest instead
 * of computing one. Membership in a `WeakSet` cannot be copied or guessed.
 */
const ISSUED_TARGETS = new WeakSet();

const ALLOWED_KEYS = Object.freeze({
  file: Object.freeze(['os', 'kind', 'path', 'object_id', 'object_id_source']),
  process: Object.freeze([
    'os',
    'kind',
    'image_path',
    'start_time',
    'object_id',
    'object_id_source',
    'pid',
  ]),
  network: Object.freeze([
    'os',
    'kind',
    'protocol',
    'local_address',
    'local_port',
    'remote_address',
    'remote_port',
    'operation_id',
    'object_id_source',
  ]),
});

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function assertClosed(target, kind) {
  const allowed = new Set(ALLOWED_KEYS[kind]);
  for (const key of Object.getOwnPropertyNames(target)) {
    if (!allowed.has(key)) {
      policyFail(REASON_CODES.DENY_TARGET_SHAPE, `$.target.${key}`, 'undeclared target field', { key });
    }
  }
  const symbols = Object.getOwnPropertySymbols(target);
  if (symbols.length > 0) {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target', 'target must not carry symbol keys', {
      symbols: symbols.map((symbol) => String(symbol)),
    });
  }
}

/**
 * @param {unknown} value Candidate object id.
 * @param {'file' | 'process' | 'network'} kind Target kind.
 * @param {string} path Dot path.
 * @returns {string} The id.
 */
function requireObjectId(value, kind, path) {
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) {
    policyFail(
      REASON_CODES.DENY_TARGET_INSUFFICIENT_IDENTITY,
      path,
      `${kind} target needs a high-entropy object_id (22..128 of [A-Za-z0-9_-])`,
      { kind },
    );
  }
  return value;
}

/**
 * @param {unknown} value Declared identity source.
 * @param {'file' | 'process' | 'network'} kind Target kind.
 * @param {string} path Dot path.
 * @returns {string} The accepted source.
 */
function requireObjectIdSource(value, kind, path) {
  const accepted = OBJECT_ID_SOURCES[kind];
  if (typeof value !== 'string' || !accepted.includes(value)) {
    policyFail(
      REASON_CODES.DENY_TARGET_INSUFFICIENT_IDENTITY,
      path,
      `${kind} identity must come from ${accepted.join(' or ')}`,
      { kind, accepted },
    );
  }
  return value;
}

function normalizeFileTarget(target, os) {
  if (typeof target.path !== 'string') {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target.path', 'file target needs a path string');
  }
  const path = normalizeCanonicalPath(os, target.path, TARGET_PATH_CODES, '$.target.path');
  const objectId = requireObjectId(target.object_id, 'file', '$.target.object_id');
  const source = requireObjectIdSource(target.object_id_source, 'file', '$.target.object_id_source');
  return { identity: { path, source }, objectId };
}

function normalizeProcessTarget(target, os) {
  if (typeof target.image_path !== 'string') {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target.image_path', 'process target needs image_path');
  }
  const imagePath = normalizeCanonicalPath(os, target.image_path, TARGET_PATH_CODES, '$.target.image_path');
  const startMs = parseUtcMs(target.start_time);
  if (startMs === null) {
    policyFail(
      REASON_CODES.DENY_TARGET_NONCANONICAL,
      '$.target.start_time',
      'process target needs a strict RFC3339 UTC creation time',
    );
  }
  if (target.pid !== undefined) {
    if (!Number.isSafeInteger(target.pid) || target.pid < 1 || target.pid > 4294967295) {
      policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target.pid', 'pid must be an integer in 1..4294967295');
    }
  }
  const objectId = requireObjectId(target.object_id, 'process', '$.target.object_id');
  const source = requireObjectIdSource(target.object_id_source, 'process', '$.target.object_id_source');
  return {
    identity: {
      image_path: imagePath,
      // 用解析后的瞬时重新格式化：`...:03Z` 与 `...:03.000Z` 是同一时刻，
      // 保留原始串会让同一进程对象得到两个摘要，进而误杀合法的审批/授权。
      start_time: new Date(startMs).toISOString(),
      source,
    },
    objectId,
    // pid 只回显、不进摘要：句柄 + 创建时间才是身份，pid 会被复用，
    // 让它参与摘要等于把一个不可靠字段当成身份锚点。
    pid: target.pid ?? null,
  };
}

function normalizeAddress(value, path) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, path, 'address must be a non-empty string');
  }
  if (value.includes('%') || value.includes('[') || value.includes(']')) {
    policyFail(REASON_CODES.DENY_TARGET_NONCANONICAL, path, 'zone ids and brackets are not canonical', {
      value,
    });
  }
  if (!IPV4_OR_IPV6.test(value) || !isIpLiteral(value)) {
    policyFail(REASON_CODES.DENY_TARGET_NONCANONICAL, path, 'address must be an IP literal, not a hostname', {
      value,
    });
  }
  return value.toLowerCase();
}

/** Local copy of the IPv4/IPv6 literal check so the module has no side effects. */
function isIpLiteral(value) {
  if (value.includes(':')) {
    const groups = value.split('::');
    if (groups.length > 2) return false;
    const parts = groups.flatMap((group) => (group.length === 0 ? [] : group.split(':')));
    if (value.includes('::')) {
      if (parts.length > 7) return false;
    } else if (parts.length !== 8) {
      return false;
    }
    return parts.every((part) => /^[0-9A-Fa-f]{1,4}$/u.test(part));
  }
  const octets = value.split('.');
  if (octets.length !== 4) return false;
  return octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255);
}

function normalizePort(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, path, 'port must be an integer in 0..65535');
  }
  return value;
}

function normalizeNetworkTarget(target) {
  if (target.protocol !== 'tcp' && target.protocol !== 'udp') {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target.protocol', 'protocol must be tcp or udp');
  }
  const localAddress = normalizeAddress(target.local_address, '$.target.local_address');
  const remoteAddress = normalizeAddress(target.remote_address, '$.target.remote_address');
  const localPort = normalizePort(target.local_port, '$.target.local_port');
  const remotePort = normalizePort(target.remote_port, '$.target.remote_port');
  const objectId = requireObjectId(target.operation_id, 'network', '$.target.operation_id');
  const source = requireObjectIdSource(
    target.object_id_source === undefined ? 'operation_id' : target.object_id_source,
    'network',
    '$.target.object_id_source',
  );
  return {
    identity: {
      protocol: target.protocol,
      local_address: localAddress,
      local_port: localPort,
      remote_address: remoteAddress,
      remote_port: remotePort,
      source,
    },
    objectId,
  };
}

/**
 * Normalise one raw target into the frozen identity this package uses everywhere.
 *
 * @param {unknown} raw Caller supplied target. Must carry an explicit `os`: the
 *   policy layer never infers the target's platform from the host, because that
 *   inference is exactly how a cross-OS plan slips through.
 * @returns {Readonly<{
 *   os: string, kind: string, objectId: string, identity: object, digest: string
 * }>} Frozen normalised target.
 * @throws {import('./errors.js').PolicyError} When any part is not canonical.
 */
export function normalizeTarget(raw) {
  if (!isPlainObject(raw)) {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target', 'target must be a plain object');
  }
  if (!isSupportedOs(raw.os)) {
    policyFail(REASON_CODES.DENY_OS_UNKNOWN, '$.target.os', 'target os must be linux or windows', {
      os: typeof raw.os === 'string' ? raw.os.slice(0, 16) : typeof raw.os,
    });
  }
  if (!TARGET_KINDS.includes(raw.kind)) {
    policyFail(REASON_CODES.DENY_TARGET_KIND_UNSUPPORTED, '$.target.kind', 'unknown target kind', {
      kind: typeof raw.kind === 'string' ? raw.kind.slice(0, 16) : typeof raw.kind,
    });
  }
  const os = raw.os;
  const kind = raw.kind;
  assertClosed(raw, kind);

  let normalized;
  if (kind === 'file') normalized = normalizeFileTarget(raw, os);
  else if (kind === 'process') normalized = normalizeProcessTarget(raw, os);
  else normalized = normalizeNetworkTarget(raw);

  // object_id 是身份锚点，必须进摘要：只把 identity（路径/地址）算进去，会让两个
  // 指向同一路径但由不同句柄绑定的对象得到同一个 digest，等于把「同一对象」的
  // 判断退化回路径比较。
  const digest = canonicalDigest({ identity: normalized.identity, kind, object_id: normalized.objectId, os });
  const target = deepFreeze({
    [BRAND]: true,
    os,
    kind,
    objectId: normalized.objectId,
    identity: normalized.identity,
    pid: normalized.pid ?? null,
    digest,
  });
  ISSUED_TARGETS.add(target);
  return target;
}

/**
 * @param {unknown} value Candidate.
 * @returns {boolean} True when `value` came out of {@link normalizeTarget}.
 */
export function isNormalizedTarget(value) {
  return value !== null
    && typeof value === 'object'
    && ISSUED_TARGETS.has(value)
    && value[BRAND] === true;
}

/**
 * Accept either a raw target or an already normalised one.
 *
 * @param {unknown} value Raw target object or normalised target.
 * @returns {ReturnType<typeof normalizeTarget>} Normalised target.
 * @throws {import('./errors.js').PolicyError} When a raw target is invalid.
 */
export function ensureNormalizedTarget(value) {
  return isNormalizedTarget(value) ? value : normalizeTarget(value);
}

/**
 * @param {unknown} target Normalised target.
 * @returns {string} Target digest.
 */
export function targetDigest(target) {
  if (!isNormalizedTarget(target)) {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target', 'target must be normalised first');
  }
  return target.digest;
}

/**
 * Contract-shaped view of a normalised target.
 *
 * Only the three fields `ResponseProposal.normalized_target` declares. Raw paths
 * and addresses deliberately stay out of the DTO — design §4 keeps local display
 * data out of the wire contract, so this function is the single conversion point.
 *
 * @param {ReturnType<typeof normalizeTarget>} target Normalised target.
 * @returns {{target_kind: string, digest: string, object_id: string}} DTO fields.
 */
export function toContractTarget(target) {
  if (!isNormalizedTarget(target)) {
    policyFail(REASON_CODES.DENY_TARGET_SHAPE, '$.target', 'target must be normalised first');
  }
  return Object.freeze({
    target_kind: target.kind,
    digest: target.digest,
    object_id: target.objectId,
  });
}

/**
 * Compare a contracts `normalized_target` DTO with a normalised target.
 *
 * @param {unknown} dto `{ target_kind, digest, object_id }`.
 * @param {ReturnType<typeof normalizeTarget>} target Normalised target.
 * @returns {'match' | 'kind_mismatch' | 'digest_mismatch' | 'object_mismatch' | 'shape'} Result.
 */
export function compareContractTarget(dto, target) {
  if (dto === null || typeof dto !== 'object' || Array.isArray(dto)) return 'shape';
  if (dto.target_kind !== target.kind) return 'kind_mismatch';
  if (dto.digest !== target.digest) return 'digest_mismatch';
  if (dto.object_id !== target.objectId) return 'object_mismatch';
  return 'match';
}
