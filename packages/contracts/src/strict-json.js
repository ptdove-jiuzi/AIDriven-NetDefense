import { ContractError, ERROR_CODES, isContractError } from './errors.js';
import { LIMITS } from './limits.js';
import { parseFloatToken, parseIntegerToken } from './numbers.js';
import { assertText, byteLength, RAW_EVIDENCE_CONTROLS } from './unicode.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const HEX4 = /^[0-9a-fA-F]{4}$/;

function fail(code, path, message, details) {
  throw new ContractError(code, path, message, details);
}

function joinPath(path, key) {
  return `${path}.${key}`;
}

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * 读取一个自有**数据**属性（DEF-12）。
 *
 * 旧实现直接 `raw.maxDepth`，于是 `{ get maxDepth() { throw ... } }` 会把原始
 * TypeError 送出合同边界。这里改为先取属性描述符：
 * - 自有数据属性 → 返回值；
 * - 访问器 / 继承属性 / 读取失败 → 视为"不可用的选项"，按合同错误处理，
 *   而不是退回默认值（静默忽略一个毒 options 会让调用方以为上限生效了）。
 */
function readOption(raw, key) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(raw, key);
  } catch (error) {
    fail(ERROR_CODES.ERR_INPUT_UNREADABLE, '$', `Cannot read option "${key}"`, {
      reason: messageOf(error),
    });
  }
  if (descriptor === undefined) {
    return undefined;
  }
  if (!('value' in descriptor)) {
    fail(ERROR_CODES.ERR_INPUT_UNREADABLE, '$', `Option "${key}" must be a plain data property`);
  }
  return descriptor.value;
}

function messageOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

/**
 * 解析选项归一化。
 *
 * 上限只能收紧不能放宽：每个上限都取 Math.min(调用方值, LIMITS 对应值)，
 * 非正整数（含 undefined / NaN / 字符串）一律回落默认值。否则调用方可以传
 * `{ maxDepth: 99 }` 或 `{ maxMessageBytes: 4000000 }` 把全局硬上限整个废掉。
 *
 * maxStringBytes 的历史语义是"可选择 raw evidence 通道"，因此它的天然天花板是
 * maxRawEvidenceStringBytes，而不是 maxStringBytes。
 */
function positiveIntegerOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function clampLimit(requested, fallback, ceiling) {
  return Math.min(positiveIntegerOr(requested, fallback), ceiling);
}

/**
 * `allowControls: true` 等价于 RAW_EVIDENCE_CONTROLS（\t \n \r），不是"全部放行"：
 * 解析器是公开导出，放任 true 放行 ESC 就等于把 ANSI 转义序列带进下游。
 *
 * 数组分支同样要过合同边界（DEF-12）：`Array.prototype.filter` 会经 `Get` 读
 * `length` 与每个下标，Proxy 的 get 陷阱在**类型判断之后**仍能把原始 TypeError 送出。
 * 因此这里手工按下标快照，并把读取包进 try；长度另有上限，避免毒数组变成 DoS。
 */
const MAX_ALLOW_CONTROLS_ENTRIES = 64;

function normalizeAllowControls(raw) {
  if (raw === true) return [...RAW_EVIDENCE_CONTROLS];
  if (!Array.isArray(raw)) return false;
  const allowed = [];
  try {
    const length = raw.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      fail(ERROR_CODES.ERR_FIELD_TYPE, '$', 'Option "allowControls" must be an array');
    }
    const bounded = Math.min(length, MAX_ALLOW_CONTROLS_ENTRIES);
    for (let index = 0; index < bounded; index += 1) {
      const entry = raw[index];
      if (RAW_EVIDENCE_CONTROLS.includes(entry) && !allowed.includes(entry)) {
        allowed.push(entry);
      }
    }
  } catch (error) {
    if (isContractError(error)) throw error;
    fail(ERROR_CODES.ERR_INPUT_UNREADABLE, '$', 'Option "allowControls" is not readable', {
      reason: messageOf(error),
    });
  }
  return allowed.length > 0 ? allowed : false;
}

/**
 * 先把 options 快照成局部标量，再进入解析（DEF-12）。
 *
 * 快照的意义不是性能，而是"一次读取"：解析过程中不再碰调用方对象，
 * 也就不存在"读 maxDepth 时是 2、读到一半变成 99"的时序差。
 */
function normalizeOptions(options) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    fail(ERROR_CODES.ERR_FIELD_TYPE, '$', 'Options must be a plain object');
  }
  const raw = {
    maxMessageBytes: readOption(options, 'maxMessageBytes'),
    maxStringBytes: readOption(options, 'maxStringBytes'),
    maxDepth: readOption(options, 'maxDepth'),
    maxObjectKeys: readOption(options, 'maxObjectKeys'),
    maxArrayItems: readOption(options, 'maxArrayItems'),
    allowControls: readOption(options, 'allowControls'),
  };
  return {
    maxMessageBytes: clampLimit(raw.maxMessageBytes, LIMITS.maxMessageBytes, LIMITS.maxMessageBytes),
    maxStringBytes: clampLimit(
      raw.maxStringBytes,
      LIMITS.maxStringBytes,
      LIMITS.maxRawEvidenceStringBytes,
    ),
    maxDepth: clampLimit(raw.maxDepth, LIMITS.maxDepth, LIMITS.maxDepth),
    maxObjectKeys: clampLimit(raw.maxObjectKeys, LIMITS.maxObjectKeys, LIMITS.maxObjectKeys),
    maxArrayItems: clampLimit(raw.maxArrayItems, LIMITS.maxArrayItems, LIMITS.maxArrayItems),
    allowControls: normalizeAllowControls(raw.allowControls),
  };
}

function decodeSource(source, options) {
  if (typeof source === 'string') {
    if (byteLength(source) > options.maxMessageBytes) {
      fail(ERROR_CODES.ERR_INPUT_TOO_LARGE, '$', 'JSON text exceeds the maximum message size');
    }
    if (source.charCodeAt(0) === 0xfeff) {
      fail(ERROR_CODES.ERR_ENCODING_NOT_UTF8, '$', 'UTF-8 BOM is not permitted');
    }
    return source;
  }
  // `instanceof` 本身也会跑代理的 `getPrototypeOf` 陷阱：一个带
  // `getPrototypeOf() { throw ... }` 的 Proxy 能让原始 TypeError 从类型判断这一行
  // 逃出合同边界（DEF-12 验收面）。类型判断也必须在合同错误边界内。
  let isBytes;
  try {
    isBytes = source instanceof Uint8Array;
  } catch (error) {
    fail(ERROR_CODES.ERR_INPUT_UNREADABLE, '$', 'Source bytes are not readable', {
      reason: messageOf(error),
    });
  }
  if (!isBytes) {
    fail(ERROR_CODES.ERR_FIELD_TYPE, '$', 'Source must be a string, Buffer or Uint8Array');
  }
  // 字节分支的读取全部包在合同边界内（DEF-12）：
  // `new Proxy(new Uint8Array(...), {})` 连陷阱都没有，读 `.byteLength` 就会抛
  // `TypeError: Method get TypedArray.prototype.byteLength called on incompatible receiver`；
  // 带陷阱的 Proxy、覆盖 `byteLength` 的子类同样如此。失败方向本来就是对的
  // （没有解析任何东西），但错误类型必须落在合同里，否则调用方无法把
  // "输入不合法" 与 "解析器被毒对象打断" 分开。
  //
  // 读到的字节先复制成一份自有快照：解析期间不再碰调用方对象，
  // 也就不存在"长度读出来是 N、解码时变成 M"的时序差。
  let bytes;
  try {
    const byteCount = source.byteLength;
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      fail(ERROR_CODES.ERR_FIELD_TYPE, '$', 'Source byte length is not a usable integer');
    }
    // 先看字节长度，再解码：超限输入根本不做 UTF-8 解释。
    if (byteCount > options.maxMessageBytes) {
      fail(ERROR_CODES.ERR_INPUT_TOO_LARGE, '$', 'JSON bytes exceed the maximum message size');
    }
    bytes = Uint8Array.prototype.slice.call(source);
    if (!(bytes instanceof Uint8Array) || bytes.length !== byteCount) {
      fail(ERROR_CODES.ERR_INPUT_UNREADABLE, '$', 'Source bytes changed while being snapshotted');
    }
  } catch (error) {
    if (isContractError(error)) throw error;
    fail(ERROR_CODES.ERR_INPUT_UNREADABLE, '$', 'Source bytes are not readable', {
      reason: messageOf(error),
    });
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(ERROR_CODES.ERR_ENCODING_NOT_UTF8, '$', 'Bytes are not valid UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail(ERROR_CODES.ERR_ENCODING_NOT_UTF8, '$', 'UTF-8 BOM is not permitted');
  }
  return text;
}


/**
 * 严格 JSON 解析器：只接受 RFC 8259 子集，并额外拒绝重复键、危险键、
 * 精度丢失、超限结构、非 NFC / 控制符 / 双向符 / 零宽字符。
 *
 * 刻意不使用 JSON.parse 做安全判定：它看不见重复键，也无法发现
 * 9007199254740993 这类被静默截断的整数。
 */
export function parseStrictJson(source, options) {
  const settings = normalizeOptions(options);
  const text = decodeSource(source, settings);
  const total = text.length;
  let index = 0;

  function syntaxError(message, at = index) {
    fail(ERROR_CODES.ERR_JSON_SYNTAX, '$', `${message} at offset ${at}`);
  }

  function skipWhitespace() {
    while (index < total && WHITESPACE.has(text.charCodeAt(index))) index += 1;
  }

  function checkText(value, path) {
    assertText(value, path, { allowControls: settings.allowControls });
    if (byteLength(value) > settings.maxStringBytes) {
      fail(
        ERROR_CODES.ERR_MAX_STRING_BYTES,
        path,
        `String exceeds ${settings.maxStringBytes} UTF-8 bytes`,
      );
    }
  }

  function readEscape() {
    const marker = text[index];
    index += 1;
    switch (marker) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': {
        const hex = text.slice(index, index + 4);
        if (!HEX4.test(hex)) syntaxError('Malformed \\u escape');
        const unit = Number.parseInt(hex, 16);
        index += 4;
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text[index] !== '\\' || text[index + 1] !== 'u') {
            fail(ERROR_CODES.ERR_UNPAIRED_SURROGATE, '$', 'High surrogate is not followed by a low surrogate');
          }
          const lowHex = text.slice(index + 2, index + 6);
          if (!HEX4.test(lowHex)) syntaxError('Malformed \\u escape');
          const low = Number.parseInt(lowHex, 16);
          if (!(low >= 0xdc00 && low <= 0xdfff)) {
            fail(ERROR_CODES.ERR_UNPAIRED_SURROGATE, '$', 'High surrogate is not followed by a low surrogate');
          }
          index += 6;
          return String.fromCharCode(unit, low);
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          fail(ERROR_CODES.ERR_UNPAIRED_SURROGATE, '$', 'Lone low surrogate escape');
        }
        return String.fromCharCode(unit);
      }
      default:
        syntaxError(`Invalid escape sequence \\${marker}`);
        return '';
    }
  }

  function parseString() {
    index += 1;
    let value = '';
    let segmentStart = index;
    for (;;) {
      if (index >= total) syntaxError('Unterminated string literal');
      const unit = text.charCodeAt(index);
      if (unit === 0x22) {
        value += text.slice(segmentStart, index);
        index += 1;
        return value;
      }
      if (unit === 0x5c) {
        value += text.slice(segmentStart, index);
        index += 1;
        value += readEscape();
        segmentStart = index;
        continue;
      }
      index += 1;
    }
  }

  function parseNumber(path) {
    const start = index;
    let isFloat = false;
    if (text[index] === '-') index += 1;
    if (text[index] === '0') {
      index += 1;
    } else if (text[index] >= '1' && text[index] <= '9') {
      index += 1;
      while (index < total && text[index] >= '0' && text[index] <= '9') index += 1;
    } else {
      syntaxError('Malformed number');
    }
    if (text[index] === '.') {
      isFloat = true;
      index += 1;
      if (!(text[index] >= '0' && text[index] <= '9')) syntaxError('Malformed fraction');
      while (index < total && text[index] >= '0' && text[index] <= '9') index += 1;
    }
    if (text[index] === 'e' || text[index] === 'E') {
      isFloat = true;
      index += 1;
      if (text[index] === '+' || text[index] === '-') index += 1;
      if (!(text[index] >= '0' && text[index] <= '9')) syntaxError('Malformed exponent');
      while (index < total && text[index] >= '0' && text[index] <= '9') index += 1;
    }
    const token = text.slice(start, index);
    return isFloat ? parseFloatToken(token, path) : parseIntegerToken(token, path);
  }

  function parseObject(path, depth) {
    if (depth > settings.maxDepth) {
      fail(ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED, path, `Nesting depth exceeds ${settings.maxDepth}`);
    }
    index += 1;
    const target = {};
    const seen = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return target;
    }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') syntaxError('Object key must be a string');
      const key = parseString();
      checkText(key, joinPath(path, key));
      if (FORBIDDEN_KEYS.has(key)) {
        fail(ERROR_CODES.ERR_FORBIDDEN_KEY, joinPath(path, key), `Key "${key}" is forbidden at any depth`);
      }
      if (seen.has(key)) {
        fail(ERROR_CODES.ERR_DUPLICATE_KEY, joinPath(path, key), `Duplicate key "${key}"`, { key });
      }
      seen.add(key);
      if (seen.size > settings.maxObjectKeys) {
        fail(ERROR_CODES.ERR_MAX_OBJECT_KEYS, path, `Object has more than ${settings.maxObjectKeys} keys`);
      }
      skipWhitespace();
      if (text[index] !== ':') syntaxError('Expected ":" after object key');
      index += 1;
      const value = parseValue(joinPath(path, key), depth + 1);
      defineOwn(target, key, value);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        break;
      }
      syntaxError('Expected "," or "}" in object');
    }
    if (Object.getPrototypeOf(target) !== Object.prototype) {
      fail(ERROR_CODES.ERR_FORBIDDEN_KEY, path, 'Parsed object prototype was polluted');
    }
    return target;
  }

  function parseArray(path, depth) {
    if (depth > settings.maxDepth) {
      fail(ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED, path, `Nesting depth exceeds ${settings.maxDepth}`);
    }
    index += 1;
    const items = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return items;
    }
    for (;;) {
      if (items.length >= settings.maxArrayItems) {
        fail(ERROR_CODES.ERR_MAX_ARRAY_ITEMS, path, `Array has more than ${settings.maxArrayItems} items`);
      }
      items.push(parseValue(`${path}[${items.length}]`, depth + 1));
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        break;
      }
      syntaxError('Expected "," or "]" in array');
    }
    return items;
  }

  function parseLiteral(literal, value, path) {
    if (text.slice(index, index + literal.length) !== literal) {
      syntaxError(`Invalid literal, expected "${literal}"`);
    }
    index += literal.length;
    return value;
  }

  function parseValue(path, depth) {
    skipWhitespace();
    if (index >= total) syntaxError('Unexpected end of input');
    const unit = text.charCodeAt(index);
    if (unit === 0x7b) return parseObject(path, depth);
    if (unit === 0x5b) return parseArray(path, depth);
    if (unit === 0x22) {
      const value = parseString();
      checkText(value, path);
      return value;
    }
    if (unit === 0x74) return parseLiteral('true', true, path);
    if (unit === 0x66) return parseLiteral('false', false, path);
    if (unit === 0x6e) return parseLiteral('null', null, path);
    return parseNumber(path);
  }

  if (total === 0) syntaxError('Empty input');
  const root = parseValue('$', 1);
  skipWhitespace();
  if (index !== total) syntaxError('Trailing content after top-level value');
  return root;
}
