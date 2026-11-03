import { canonicalDigest } from './canonical.js';
import { ContractError, ERROR_CODES } from './errors.js';
import { LIMITS } from './limits.js';
import { assertText, byteLength } from './unicode.js';

function fail(code, path, message, details) {
  throw new ContractError(code, path, message, details);
}

export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** 只接受普通对象：排除 null、数组、Date/Map/类实例、null 原型对象。 */
export function assertPlainObject(value, path = '$') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(ERROR_CODES.ERR_INPUT_NOT_OBJECT, path, 'Expected a plain object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(ERROR_CODES.ERR_INPUT_NOT_OBJECT, path, 'Expected a plain object');
  }
  return value;
}

/**
 * 普通对象判定：排除 null、数组、Date/Map、类实例，以及 `Object.create(null)`
 * 这类无原型对象。canonicalize / 各校验器共用同一套语义。
 */
export function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 统一的"所有自有键"检查：封闭性必须覆盖全部自有键，而不只是可枚举的字符串键。
 *
 * - 给出 `allowedKeys`（键名数组 / Set / 以其为键的对象）时，
 *   `Object.getOwnPropertyNames` 中任何不在集合内的键（**含非枚举键**）都按未知字段拒绝；
 *   这封死了 `Object.defineProperty(obj, 'auto_approve', { enumerable: false })` 的隐形旁路。
 * - 省略 `allowedKeys` 时只拒绝隐藏键（非枚举自有键），供 payload / summary_dto.fields
 *   这类键集合由内容决定的容器使用：可枚举的未知键仍交给调用方给出更精确的错误码。
 * - 任何自有 Symbol 键一律拒绝，`details.symbols` 给出符号描述，`details.symbolKeys`
 *   给出 `String(sym)` 形式。
 *
 * 冻结对象与 parseStrictJson 的产出全部是可枚举属性，因此不会被误伤。
 */
export function assertNoHiddenKeys(value, path = '$', allowedKeys) {
  if (value === null || typeof value !== 'object') return value;
  let allowed = null;
  if (allowedKeys !== undefined) {
    allowed = allowedKeys instanceof Set
      ? allowedKeys
      : new Set(Array.isArray(allowedKeys) ? allowedKeys : Object.keys(allowedKeys));
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const enumerable = Object.prototype.propertyIsEnumerable.call(value, key);
    if (allowed === null ? !enumerable : !allowed.has(key)) {
      fail(ERROR_CODES.ERR_UNKNOWN_FIELD, `${path}.${key}`, `Unknown field "${key}"`);
    }
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    fail(ERROR_CODES.ERR_UNKNOWN_FIELD, path, 'Object carries symbol keys', {
      symbols: symbols.map((symbol) => (
        typeof symbol.description === 'string' ? symbol.description : String(symbol)
      )),
      symbolKeys: symbols.map((symbol) => String(symbol)),
    });
  }
  return value;
}

function validateArray(value, spec, path, options) {
  const minItems = spec.minItems ?? 0;
  const maxItems = spec.maxItems ?? LIMITS.maxArrayItems;
  if (value.length < minItems) {
    if (minItems >= 1) {
      fail(ERROR_CODES.ERR_ARRAY_EMPTY, path, `Array requires at least ${minItems} item(s)`);
    }
    fail(ERROR_CODES.ERR_ARRAY_ELEMENT_TYPE, path, 'Array is shorter than the declared minimum');
  }
  if (value.length > maxItems) {
    fail(ERROR_CODES.ERR_MAX_ARRAY_ITEMS, path, `Array exceeds ${maxItems} items`);
  }
  // 元素形状（类型 / 形态 / 枚举）错误统一折叠成 ERR_ARRAY_ELEMENT_TYPE，
  // 原始错误码放在 details.cause 里，原始 details（如枚举的 allowed）整体并入
  // details.causeDetails，path 精确指向出问题的下标。
  // message 必须带上 cause：只说"不是合法 string"会把"pattern 不符"误报成类型错误。
  const elementShapeCodes = new Set([
    ERROR_CODES.ERR_FIELD_TYPE,
    ERROR_CODES.ERR_FIELD_PATTERN,
    ERROR_CODES.ERR_FIELD_ENUM,
  ]);
  const items = value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    try {
      return validateField(item, spec.arrayOf ?? {}, itemPath, options);
    } catch (error) {
      if (error instanceof ContractError && elementShapeCodes.has(error.code)) {
        const causeDetails = error.details ?? {};
        const allowedHint = Array.isArray(causeDetails.allowed)
          ? `; allowed: ${causeDetails.allowed.join('|')}`
          : '';
        fail(
          ERROR_CODES.ERR_ARRAY_ELEMENT_TYPE,
          itemPath,
          `Array element ${index} is not a valid ${String(spec.arrayOf?.type ?? 'value')}: ${error.code}${allowedHint}`,
          { cause: error.code, causeDetails },
        );
      }
      throw error;
    }
  });
  if (spec.unique === true) {
    const seen = new Set();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const fingerprint = typeof item === 'string' ? item : canonicalDigest(item);
      if (seen.has(fingerprint)) {
        fail(
          ERROR_CODES.ERR_DUPLICATE_ARRAY_ELEMENT,
          `${path}[${index}]`,
          'Array contains duplicate items',
        );
      }
      seen.add(fingerprint);
    }
  }
  return items;
}

function validateField(value, spec, path, options) {
  if (value === undefined) {
    if (spec.required === true) fail(ERROR_CODES.ERR_MISSING_FIELD, path, 'Required field is missing');
    return undefined;
  }
  if (value === null) {
    if (spec.nullable !== true) fail(ERROR_CODES.ERR_NULL_NOT_ALLOWED, path, 'Field is not nullable');
    return null;
  }

  let result = value;
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Expected a string');
      const maxBytes = spec.maxBytes ?? LIMITS.maxStringBytes;
      if (byteLength(value) > maxBytes) {
        fail(ERROR_CODES.ERR_MAX_STRING_BYTES, path, `String exceeds ${maxBytes} UTF-8 bytes`);
      }
      assertText(value, path, { allowControls: spec.allowControls });
      break;
    }
    case 'integer': {
      if (typeof value !== 'number') fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Expected an integer');
      if (!Number.isSafeInteger(value)) {
        fail(ERROR_CODES.ERR_INTEGER_RANGE, path, 'Integer is outside the IEEE-754 safe range');
      }
      if (spec.min !== undefined && value < spec.min) {
        fail(ERROR_CODES.ERR_INTEGER_RANGE, path, `Integer must be >= ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        fail(ERROR_CODES.ERR_INTEGER_RANGE, path, `Integer must be <= ${spec.max}`);
      }
      result = value === 0 ? 0 : value;
      break;
    }
    case 'number': {
      if (typeof value !== 'number') fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Expected a finite number');
      if (!Number.isFinite(value)) {
        fail(ERROR_CODES.ERR_NUMBER_NOT_FINITE, path, 'Number must be finite');
      }
      if (spec.min !== undefined && value < spec.min) {
        fail(ERROR_CODES.ERR_NUMBER_RANGE, path, `Number must be >= ${spec.min}`);
      }
      if (spec.max !== undefined && value > spec.max) {
        fail(ERROR_CODES.ERR_NUMBER_RANGE, path, `Number must be <= ${spec.max}`);
      }
      result = value === 0 ? 0 : value;
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Expected a boolean');
      break;
    }
    case 'object': {
      if (!isPlainObject(value)) fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Expected a plain object');
      if (spec.fields) result = assertClosedObject(value, spec.fields, path, options);
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Expected an array');
      result = validateArray(value, spec, path, options);
      break;
    }
    default:
      fail(ERROR_CODES.ERR_FIELD_TYPE, path, `Unsupported field type "${String(spec.type)}"`);
  }

  if (spec.enum !== undefined && !spec.enum.includes(value)) {
    fail(ERROR_CODES.ERR_FIELD_ENUM, path, 'Value is not in the allowed set', { allowed: spec.enum });
  }
  if (spec.pattern !== undefined) {
    spec.pattern.lastIndex = 0;
    if (typeof value !== 'string' || !spec.pattern.test(value)) {
      fail(ERROR_CODES.ERR_FIELD_PATTERN, path, 'Value does not match the required pattern');
    }
  }
  if (typeof spec.validator === 'function') {
    spec.validator(value, path, options);
  }
  if (typeof spec.normalize === 'function') {
    result = spec.normalize(value, path, options);
  }
  return result;
}

/**
 * 封闭对象校验：未声明字段一律拒绝，返回按 spec 声明顺序排列、深度冻结的新对象。
 *
 * 封闭性不可由调用方关闭：历史实现支持 `options.allowedExtraKeys` 旁路，
 * 现已彻底删除。传入的 `options.allowedExtraKeys` 一律被忽略——既不报错，
 * 也不生效——未知字段无条件 ERR_UNKNOWN_FIELD。
 *
 * 必填判定只看自有属性（hasOwnProperty），绝不从原型链取值：即便同进程内
 * Object.prototype 被污染，`{}` 也必须按缺字段拒绝。
 *
 * 未知键判定用 Object.getOwnPropertyNames 而非 Object.keys：非枚举自有键同样会
 * 被检查（`defineProperty(obj, 'auto_approve', { enumerable: false })` 不再隐形），
 * Symbol 键同样拒绝。
 */
export function assertClosedObject(value, spec, path = '$', options = {}) {
  assertPlainObject(value, path);
  assertNoHiddenKeys(value, path, spec);
  const normalized = {};
  for (const key of Object.keys(spec)) {
    const present = Object.prototype.hasOwnProperty.call(value, key);
    const result = validateField(present ? value[key] : undefined, spec[key], `${path}.${key}`, options);
    if (result !== undefined) {
      Object.defineProperty(normalized, key, {
        value: result,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return deepFreeze(normalized);
}

/** 构造对外的合同记录：{ schemaVersion, digest, value }，digest 覆盖规范化 DTO。 */
export function buildContractRecord(normalized) {
  return Object.freeze({
    schemaVersion: normalized.schemaVersion,
    digest: canonicalDigest(normalized),
    value: normalized,
  });
}

/** 标量（string / 安全整数 / boolean）校验，返回规范化值。 */
export function normalizeScalar(value, path = '$') {
  if (typeof value === 'string') {
    if (byteLength(value) > LIMITS.maxStringBytes) {
      fail(ERROR_CODES.ERR_MAX_STRING_BYTES, path, `String exceeds ${LIMITS.maxStringBytes} UTF-8 bytes`);
    }
    assertText(value, path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail(ERROR_CODES.ERR_NUMBER_PRECISION_LOSS, path, 'Scalar numbers must be safe integers');
    }
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'boolean') return value;
  fail(ERROR_CODES.ERR_FIELD_TYPE, path, 'Scalar values must be string, integer or boolean');
  return undefined;
}

/** 标量或同类型标量数组（<= maxItems 项）。 */
export function normalizeScalarOrArray(value, path = '$', maxItems = LIMITS.maxArrayItems) {
  if (!Array.isArray(value)) return normalizeScalar(value, path);
  if (value.length > maxItems) {
    fail(ERROR_CODES.ERR_MAX_ARRAY_ITEMS, path, `Array exceeds ${maxItems} items`);
  }
  let kind;
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const scalar = normalizeScalar(item, itemPath);
    const itemKind = typeof scalar;
    if (kind === undefined) {
      kind = itemKind;
    } else if (kind !== itemKind) {
      fail(ERROR_CODES.ERR_FIELD_TYPE, itemPath, 'Arrays must contain a single scalar type');
    }
    return scalar;
  });
}
