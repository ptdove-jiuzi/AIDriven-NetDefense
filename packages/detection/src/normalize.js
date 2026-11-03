/**
 * normalize.js — field path handling, value normalization and fingerprint input
 * construction.
 *
 * Normalization is intentionally small and total: it never throws on odd input,
 * so a malformed event field can only ever produce a non-match, not a crash.
 */

import { canonicalStringify, sha256Hex, truncatePreview } from './canonical.js';
import { UnreadableFieldError } from './errors.js';

/** Path segments that must never be traversed. @type {readonly string[]} */
export const FORBIDDEN_PATH_SEGMENTS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Allowed fingerprint transforms. @type {readonly string[]} */
export const FINGERPRINT_TRANSFORMS = Object.freeze(['none', 'lower', 'path']);

/**
 * Split a dotted field path into segments.
 *
 * @param {unknown} path Candidate path.
 * @returns {string[] | null} Segments, or `null` when the path is unusable
 *   (not a string, empty segment, numeric segment or forbidden segment).
 */
export function splitPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) {
    return null;
  }
  const segments = path.split('.');
  for (const segment of segments) {
    if (segment.length === 0 || segment.length > 128) {
      return null;
    }
    if (FORBIDDEN_PATH_SEGMENTS.includes(segment)) {
      return null;
    }
    if (/^[0-9]+$/.test(segment)) {
      return null;
    }
  }
  return segments;
}

/**
 * Report whether a path is syntactically usable.
 *
 * @param {unknown} path Candidate path.
 * @returns {boolean} `true` when {@link splitPath} succeeds.
 */
export function isValidPath(path) {
  return splitPath(path) !== null;
}

/**
 * Normalize a text value: NFKC, trim, collapse whitespace runs to one space.
 *
 * `String(value)` 会对任意对象调用 `toString` / `valueOf`，而这两者都可能抛错
 * （最简单的例子：`Object.create(null)` 没有原型，无法转成原始值）。
 * 这种情况和"getter / Proxy 读不出来"是同一类**数据**故障：一条畸形事件不得
 * 因此把规则永久隔离（DEF-11 的验收面不限于属性访问），所以同样抛
 * `UnreadableFieldError`，由引擎降级为"本事件不命中 + 记缺口"。
 *
 * @param {unknown} value Value to normalize.
 * @param {string | null} [path] Dotted field path, for the gap detail.
 * @returns {string} Normalized text; empty string for `null`/`undefined`.
 */
export function normalizeText(value, path = null) {
  if (value === undefined || value === null) {
    return '';
  }
  let text;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch (error) {
    const reason = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error);
    throw new UnreadableFieldError(`field "${path ?? '<value>'}" cannot be converted to text: ${reason}`, {
      path,
      detail: { segment: null, reason },
    });
  }
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/**
 * Normalize a filesystem path: separators unified, duplicate separators
 * collapsed, trailing separator removed, drive letter lowercased.
 *
 * @param {unknown} value Value to normalize.
 * @returns {string} Normalized path.
 */
export function normalizePathValue(value) {
  const text = normalizeText(value).replace(/\\/gu, '/');
  const collapsed = text.replace(/\/{2,}/gu, '/');
  const withoutTrailing = collapsed.length > 1 ? collapsed.replace(/\/+$/u, '') : collapsed;
  return withoutTrailing.replace(/^([A-Za-z]):/u, (match, drive) => `${drive.toLowerCase()}:`);
}

/**
 * Apply a fingerprint transform to a raw field value.
 *
 * @param {unknown} value Raw field value.
 * @param {'none' | 'lower' | 'path'} transform Transform name.
 * @returns {string} Normalized value; empty string when the field is missing.
 */
export function applyTransform(value, transform, path = null) {
  const base = normalizeText(value, path);
  if (transform === 'lower') {
    return base.toLowerCase();
  }
  if (transform === 'path') {
    return normalizePathValue(base);
  }
  return base;
}

/**
 * 读一个点分字段路径。
 *
 * `event.fields` 优先；`fields` 不提供该路径时读事件顶层，因此 `type`、`source`、
 * `severity` 也能当普通字段名读。数组是不透明的：不支持下标段。
 *
 * 事件由引擎的 `readEventShape` 产出时会带上**读取缓存**（DEF-09）：同一个属性在
 * 同一事件内只会被读一次，条件、分组键与指纹看到的一定是同一个值。没有缓存的事件
 * （直接调用 `resolveField` 的调用方）行为不变。
 *
 * @param {object} event Normalized event.
 * @param {string} path Dotted path.
 * @returns {unknown} Field value, or `undefined` when absent.
 */
export function resolveField(event, path) {
  const segments = splitPath(path);
  if (segments === null) {
    return undefined;
  }
  if (event === null || typeof event !== 'object') {
    return undefined;
  }
  const cache = readCacheOf(event);
  const fields = event.fields;
  if (fields !== null && typeof fields === 'object' && !Array.isArray(fields)) {
    const nested = readPath(fields, segments, cache);
    if (nested !== undefined) {
      return nested;
    }
  }
  return readPath(event, segments, cache);
}

/**
 * Report whether a resolved value counts as missing.
 *
 * @param {unknown} value Resolved field value.
 * @returns {boolean} `true` for `undefined` and `null`.
 */
export function isMissingValue(value) {
  return value === undefined || value === null;
}

/**
 * 把指纹 / 分组输入里**非标量**的值编码成带类型标签的规范 JSON（DEF-08）。
 *
 * 旧实现一律 `String(value)`：任意两个不同对象都变成 `"[object Object]"`、
 * 任意数组都变成逗号拼接，于是恶意样本可以用一个对象把任意不同的观测合并成一个告警，
 * 或者把一个告警拆成多个。
 *
 * 修法刻意只覆盖非标量：标量的编码（字符串原文、数字、布尔）保持逐字节不变，
 * 因此既有指纹 / 分组键**不会变**；变化只发生在原本就互相碰撞的那一类值上。
 *
 * 类型标签放在规范化结构里（`[path, text, tag]` 三元组）而不是拼进文本，
 * 这样"字符串 `{"a":1}`"与"对象 `{a:1}`"在规范 JSON 里是不同长度的数组，
 * 不可能再撞在一起——不需要依赖任何"前缀字符不会出现在真实数据里"的假设。
 *
 * 为什么仍然先调一次 `normalizeText`：旧实现用 `String(value)` 发现"转不成文本"的值
 * （例如 `Object.create(null)`），并把它当作**数据故障**抛 `UnreadableFieldError`。
 * 这条语义是 DEF-11 的验收面，必须原样保留。
 *
 * @param {unknown} value 字段值。
 * @param {string} path 字段路径（用于缺口详情）。
 * @returns {'object' | 'array' | 'function' | 'symbol' | null} 类型标签；标量返回 `null`。
 */
function nonScalarTag(value) {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === 'object') {
    return 'object';
  }
  if (type === 'function' || type === 'symbol') {
    return type;
  }
  return null;
}

/**
 * 取一个值的缓存槽（按对象身份）。非对象（`symbol` / `bigint`）返回 `null`，
 * 因为它们不能当 `WeakMap` 键，只能逐次求值。
 *
 * 槽里存的是**失败原因**而不是错误对象：同一个坏值被两条规则、两个路径读到时，
 * 缺口详情必须各自指向自己的字段，而不是第一次那个（否则诊断路径会串味）。
 *
 * @param {WeakMap<object, object> | null} cache 事件级缓存。
 * @param {unknown} value 待缓存的值。
 * @returns {{reason: string | null, jsonText: string | null, identity: Map<string, string[]>} | null} 槽。
 */
function cacheSlot(cache, value) {
  if (cache === null || value === null) {
    return null;
  }
  const type = typeof value;
  if (type !== 'object' && type !== 'function') {
    return null;
  }
  let slot = cache.get(value);
  if (slot === undefined) {
    slot = { reason: null, jsonText: null, identity: new Map() };
    cache.set(value, slot);
  }
  return slot;
}

/**
 * 构造一条"这个值读不出来"的数据故障，路径按调用方传入。
 *
 * @param {string} path 字段路径。
 * @param {string} reason 底层原因。
 * @returns {UnreadableFieldError} 数据故障。
 */
function unreadableValue(path, reason) {
  return new UnreadableFieldError(`field "${path}" cannot be read as text or JSON: ${reason}`, {
    path,
    detail: { segment: null, reason },
  });
}

/**
 * 规范 JSON 文本；序列化失败（循环引用、毒 getter）按数据故障处理。
 *
 * 额外把 DEL / C1（U+007F–U+009F）转义成 `\uXXXX`：`JSON.stringify` 只转义 C0，
 * 而这段文本会进入 `fingerprintPreview`，检测记录随后要过 DTO 校验（拒绝控制符）。
 * 转义是单射的——真实字符串里的反斜杠会被 `JSON.stringify` 转成 `\\`，
 * 因此不会与转义序列撞车。
 *
 * @param {unknown} value 非标量值。
 * @param {string} path 字段路径。
 * @param {WeakMap<object, object> | null} [cache] 事件级序列化缓存（DEF-09）。
 * @returns {string} 规范 JSON 文本。
 */
function canonicalValueText(value, path, cache = null) {
  const slot = cacheSlot(cache, value);
  if (slot !== null) {
    // 同一个坏值在同一次事件里被第二次求值时重抛，不再遍历一次。
    if (slot.reason !== null) {
      throw unreadableValue(path, slot.reason);
    }
    if (slot.jsonText !== null) {
      return slot.jsonText;
    }
  }
  let text;
  try {
    text = canonicalStringify(jsonIdentityCopy(value, path));
  } catch (error) {
    const reason = error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message
      : String(error);
    if (slot !== null) {
      slot.reason = reason;
    }
    throw unreadableValue(path, reason);
  }
  const escaped = text.replace(/[\u007f-\u009f]/gu, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
  if (slot !== null) {
    slot.jsonText = escaped;
  }
  return escaped;
}

/**
 * 把值投影成"规范 JSON 可以表达"的形状：纯 JSON 部分原样保留，
 * 非纯 JSON 的叶子（`Date` / `Map` / 类实例）换成它们的文本身份。
 *
 * 为什么需要这一步：`canonicalStringify` 对没有自有可枚举键的对象一律输出 `{}`，
 * 于是"两个不同的 Date 放进数组"会共享同一个身份——那比旧实现的
 * `String([date])` **更差**（第 2 轮独立审查实测）。这里保留数组/对象的 JSON 形状
 * （所以 `[1,2]` 仍不与 `"1,2"` 撞），只把叶子换成有区分度的文本。
 *
 * @param {unknown} value 待投影的值。
 * @param {string} path 字段路径（用于数据故障详情）。
 * @returns {unknown} 纯 JSON 形状的副本。
 */
function jsonIdentityCopy(value, path) {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonIdentityCopy(item, path));
  }
  if (type === 'object' && isPlainJsonObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        value: jsonIdentityCopy(value[key], path),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  // 非 JSON 形状：保留旧的文本身份（`Date` 的 `toString` 有区分度，
  // `Object.create(null)` 仍在这里抛 `UnreadableFieldError`，DEF-11 的验收面）。
  return applyTransform(value, 'none', path);
}

/**
 * 判断是不是"纯 JSON 对象"（原型是 `Object.prototype` 或 `null`）。
 *
 * 只对这类值和数组使用规范 JSON 作身份：`Date`、`Map`、类实例没有自有可枚举键，
 * 规范化后都会变成 `{}`，改用规范 JSON 反而会**制造**新的碰撞（旧实现的
 * `String(date)` 是有区分度的）。这些值继续走旧的文本路径。
 *
 * @param {object} value 非标量值。
 * @returns {boolean} 是否为纯 JSON 对象。
 */
function isPlainJsonObject(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/**
 * 构造一个"身份项"：`[path, text]`（标量）或 `[path, text, tag]`（非标量）。
 *
 * @param {string} path 字段路径。
 * @param {unknown} value 字段值。
 * @param {'none' | 'lower' | 'path'} transform 指纹变换（只作用于标量文本）。
 * @param {WeakMap<object, object> | null} [cache] 事件级序列化缓存（DEF-09）。
 * @returns {Array<string>} 身份项。
 */
function identityEntry(path, value, transform, cache = null) {
  const tag = nonScalarTag(value);
  if (tag === null) {
    return [path, applyTransform(value, transform, path)];
  }
  const slot = cacheSlot(cache, value);
  const memoKey = `${tag}|${transform}`;
  if (slot !== null) {
    if (slot.reason !== null) {
      throw unreadableValue(path, slot.reason);
    }
    const memo = slot.identity.get(memoKey);
    if (memo !== undefined) {
      return [path, memo[0], memo[1]];
    }
  }
  let entry;
  if (tag === 'array' || isPlainJsonObject(value)) {
    // 旧语义：先跑一次 `String(value)` 探针——`Object.create(null)` 转不成文本，
    // 在旧实现里正是靠这一步抛 `UnreadableFieldError`（DEF-11 的验收面）。
    // 探针结果对这类值不使用（身份走规范 JSON），所以丢弃。
    try {
      applyTransform(value, transform, path);
    } catch (error) {
      rememberFailure(slot, error);
      throw error;
    }
    // 缓存按对象身份记忆，因此分组键与指纹看到的一定是同一份序列化结果：
    // 内层访问器不会被第二次执行（DEF-09 的嵌套面）。
    entry = [canonicalValueText(value, path, cache), tag];
  } else {
    // 非纯 JSON 对象（`Date`、`Map`、类实例）保留旧的文本身份：规范 JSON 会把它们
    // 都压成 `{}`，反而制造新的碰撞。文本同样按对象身份记忆，否则一个状态型
    // `toString` 会让分组键与指纹看到不同的值（DEF-09）。
    try {
      entry = [applyTransform(value, transform, path), tag];
    } catch (error) {
      rememberFailure(slot, error);
      throw error;
    }
  }
  if (slot !== null) {
    slot.identity.set(memoKey, entry);
  }
  return [path, entry[0], entry[1]];
}

/**
 * 记住"这个值读不出来"的原因，供同一次事件里的第二次求值复用。
 *
 * @param {{reason: string | null} | null} slot 缓存槽。
 * @param {unknown} error 抛出的错误。
 * @returns {void}
 */
function rememberFailure(slot, error) {
  if (slot === null) {
    return;
  }
  if (error instanceof UnreadableFieldError) {
    slot.reason = typeof error.detail?.reason === 'string' ? error.detail.reason : error.message;
    return;
  }
  slot.reason = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
}

/**
 * Build the canonical group key for a list of paths.
 *
 * @param {readonly string[]} paths Declared paths.
 * @param {object} event Event being evaluated.
 * @returns {string} Canonical text identifying the group.
 */
export function buildGroupKey(paths, event) {
  const cache = serializedCacheOf(event);
  return canonicalStringify(
    paths.map((path) => identityEntry(path, resolveField(event, path), 'none', cache)),
  );
}

/**
 * Build normalized `[path, value]` pairs for a fingerprint specification.
 *
 * 标量返回二元组（与旧实现的形状一致，摘要不变）；非标量返回
 * `[path, 规范 JSON 文本, 类型标签]`，因此不同对象 / 不同数组 / 对象与同形字符串
 * 不再共享指纹（DEF-08）。
 *
 * @param {readonly { path: string, transform: 'none' | 'lower' | 'path' }[]} specification Fingerprint fields.
 * @param {object} event Event being evaluated.
 * @returns {Array<Array<string>>} Pairs with fully normalized values (never truncated).
 */
export function buildFingerprintKeys(specification, event) {
  const cache = serializedCacheOf(event);
  return specification.map(
    (item) => identityEntry(item.path, resolveField(event, item.path), item.transform, cache),
  );
}

/**
 * Build the canonical fingerprint input text.
 *
 * @param {string} ruleId Rule identifier.
 * @param {string} ruleVersion Rule version.
 * @param {Array<[string, string]>} keys Normalized `[path, value]` pairs.
 * @returns {string} Canonical text hashed into the fingerprint.
 */
export function buildFingerprintInput(ruleId, ruleVersion, keys) {
  return canonicalStringify({ ruleId, version: ruleVersion, keys });
}

/**
 * 预览里的控制符转义（显示层）。
 *
 * `normalizeText` 只折叠空白，不剥 C0/C1，所以一个带 ESC 的标量字段会把控制符原样
 * 带进 `fingerprintPreview`；检测记录随后要过拒绝控制符的 DTO 校验。这里只改**预览文本**，
 * 摘要仍然用未转义的身份项，因此不影响指纹（第 2 轮独立审查实测的缺口）。
 *
 * @param {string} text 预览文本。
 * @returns {string} 转义后的预览文本。
 */
function escapePreviewControls(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

/**
 * Compute a fingerprint from untruncated normalized values.
 *
 * The digest always covers the complete values; only the preview is truncated,
 * so values that differ past the preview limit still produce distinct digests.
 *
 * @param {{ ruleId: string, ruleVersion: string, specification: readonly { path: string, transform: 'none' | 'lower' | 'path' }[], event: object, maxPreviewLength: number }} input Fingerprint input.
 * @returns {{ fingerprint: string, preview: Array<{ path: string, preview: string }> }} Digest and preview pairs.
 */
export function computeFingerprint(input) {
  const keys = buildFingerprintKeys(input.specification, input.event);
  return {
    fingerprint: sha256Hex(buildFingerprintInput(input.ruleId, input.ruleVersion, keys)),
    preview: keys.map(([path, value]) => ({
      path,
      preview: escapePreviewControls(truncatePreview(value, input.maxPreviewLength)),
    })),
  };
}

/**
 * 事件读取缓存的键（DEF-09）。用 Symbol 保证不会与事件字段名冲突，
 * 且不可枚举，因此不会出现在任何序列化 / 摘要里。
 */
const FIELD_READS = Symbol('aegis.detection.fieldReads');

/**
 * 非标量值的规范序列化缓存键（DEF-09）。
 *
 * 路径段的缓存只能保证"同一个属性被读一次"，保证不了"同一个值只被**遍历**一次"：
 * 分组键与指纹各调一次 `canonicalStringify`，嵌套访问器因此会被再执行一遍。
 * 实测 threshold + groupBy + fingerprint 的组合会让内层 getter 单事件执行 4 次。
 * 这仍是"同一事件内多次读取"的同一个缺陷，所以按对象身份记忆序列化结果。
 */
const FIELD_SERIALIZED = Symbol('aegis.detection.fieldSerialized');

/**
 * 给事件快照挂一份"每个属性只读一次"的缓存（DEF-09）。
 *
 * 缺陷：`readEventShape` 只把顶层字段拷成快照，`fields` 仍是调用方对象的引用，
 * `resolveField` 每次求值都重新进 getter。实测同一个事件里 getter 被读 ≥2 次：
 * 条件在 `v1` 上命中，同一条检测的指纹却是用 `v2` 算出来的。
 *
 * 缓存按 `(对象, 属性名)` 记忆首次读取的结果（包括抛出的错误），所以
 * "条件读到的值"与"指纹读到的值"必然是同一个，getter 只执行一次。
 *
 * @param {object} event 事件快照（`readEventShape` 的产物）。
 * @returns {object} 同一个事件对象。
 */
export function attachFieldReadCache(event) {
  if (event === null || typeof event !== 'object') {
    return event;
  }
  // 幂等：重复挂载不能抛 `Cannot redefine property`（两个属性都是 configurable: false）。
  if (Object.hasOwn(event, FIELD_READS)) {
    return event;
  }
  Object.defineProperty(event, FIELD_READS, {
    value: new WeakMap(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(event, FIELD_SERIALIZED, {
    value: new WeakMap(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return event;
}

/**
 * 取事件的读取缓存；没有（或读不出来）时返回 `null`，调用方退回直读。
 *
 * @param {object} event 事件对象。
 * @returns {WeakMap<object, Map<string, object>> | null} 缓存。
 */
function readCacheOf(event) {
  try {
    const cache = event[FIELD_READS];
    return cache instanceof WeakMap ? cache : null;
  } catch {
    return null;
  }
}

/**
 * 取事件的"规范序列化"缓存；没有时返回 `null`，调用方退回逐次序列化。
 *
 * @param {object} event 事件对象。
 * @returns {WeakMap<object, object> | null} 缓存。
 */
function serializedCacheOf(event) {
  if (event === null || typeof event !== 'object') {
    return null;
  }
  try {
    const cache = event[FIELD_SERIALIZED];
    return cache instanceof WeakMap ? cache : null;
  } catch {
    return null;
  }
}

/** `readPath` 的"属性不存在"哨兵：与"属性存在但值是 undefined"区分开。 */
const MISSING = Symbol('aegis.detection.missingField');

/**
 * 读一个属性，按缓存记忆结果（DEF-09）。
 *
 * @param {object} target 当前对象。
 * @param {string} key 属性名。
 * @param {string[]} segments 完整路径（用于缺口详情）。
 * @param {WeakMap<object, Map<string, object>> | null} cache 事件级缓存。
 * @returns {unknown} 属性值，或 `MISSING`。
 */
function readSegment(target, key, segments, cache) {
  if (cache === null) {
    if (!hasOwn(target, key, segments)) {
      return MISSING;
    }
    return readProperty(target, key, segments);
  }
  let perTarget = cache.get(target);
  if (perTarget === undefined) {
    perTarget = new Map();
    cache.set(target, perTarget);
  }
  const cached = perTarget.get(key);
  if (cached !== undefined) {
    if (cached.error !== undefined) {
      // 同一次事件里第二次读同一个坏属性：重抛同一个数据故障，而不是再进一次 getter。
      throw cached.error;
    }
    return cached.value;
  }
  let entry;
  try {
    entry = hasOwn(target, key, segments)
      ? { value: readProperty(target, key, segments) }
      : { value: MISSING };
  } catch (error) {
    perTarget.set(key, { error });
    throw error;
  }
  perTarget.set(key, entry);
  return entry.value;
}

function readPath(target, segments, cache = null) {
  let current = target;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    const read = readSegment(current, segment, segments, cache);
    if (read === MISSING) {
      return undefined;
    }
    current = read;
  }
  return current;
}

/**
 * `hasOwnProperty` 在 Proxy 上会触发 `getOwnPropertyDescriptor` / `has` 陷阱。
 *
 * 读取失败的语义必须与"字段不存在"区分开：不存在是正常数据（记为不命中），
 * 读不了是数据故障（记为缺口）。这里统一抛 `UnreadableFieldError`，
 * 让引擎按"数据故障"处理，而不是把异常算到规则头上。
 */
function hasOwn(target, key, segments) {
  try {
    return Object.prototype.hasOwnProperty.call(target, key);
  } catch (error) {
    throw unreadable(segments, key, error);
  }
}

function readProperty(target, key, segments) {
  try {
    return target[key];
  } catch (error) {
    throw unreadable(segments, key, error);
  }
}

function unreadable(segments, key, error) {
  const path = [...segments].join('.');
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  return new UnreadableFieldError(`field "${path}" (segment "${key}") is not readable: ${message}`, {
    path,
    detail: { segment: key, reason: message },
  });
}
