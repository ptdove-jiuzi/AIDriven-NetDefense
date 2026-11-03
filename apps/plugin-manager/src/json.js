// AegisHarness plugin manager — author: PT-dove
// Strict I-JSON decoding: fatal UTF-8 decoding plus a hand written recursive descent
// parser. JSON.parse is never used, so duplicate keys and depth abuse are rejected
// while the text is still being consumed.

import { ERROR_CODES, PluginCheckError } from './errors.js';

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const NUMBER_PATTERN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX_DIGITS = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

/**
 * Decodes bytes as UTF-8 and rejects any malformed sequence (including CESU-8 style
 * lone surrogates). A UTF-8 BOM is stripped by the decoder.
 * @param {Uint8Array|string} buffer
 * @param {string} label
 * @returns {string}
 */
export function decodeUtf8Strict(buffer, label = 'file') {
  if (typeof buffer === 'string') return buffer;
  if (!(buffer instanceof Uint8Array)) {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      `${label}: expected a Buffer or Uint8Array`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new PluginCheckError(ERROR_CODES.INVALID_UNICODE, `${label}: content is not valid UTF-8`);
  }
}

/**
 * Parses JSON with a closed grammar: no comments, no trailing commas, no NaN/Infinity,
 * no duplicate object keys, no raw control characters, no lone surrogates, bounded
 * nesting and bounded size.
 * @param {string} text
 * @param {{label?: string, maxBytes?: number, maxDepth?: number}} [options]
 * @returns {unknown}
 */
export function parseStrictJson(text, options = {}) {
  const { label = 'JSON', maxBytes = 65536, maxDepth = 32 } = options ?? {};
  if (typeof text !== 'string') {
    throw new PluginCheckError(ERROR_CODES.INVALID_ARGUMENT, `${label}: text must be a string`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      `${label}: maxBytes must be a positive integer`,
    );
  }
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
    throw new PluginCheckError(
      ERROR_CODES.INVALID_ARGUMENT,
      `${label}: maxDepth must be a positive integer`,
    );
  }

  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > maxBytes) {
    throw new PluginCheckError(
      ERROR_CODES.LIMIT_EXCEEDED,
      `${label}: ${byteLength} bytes exceeds the ${maxBytes} byte limit`,
    );
  }

  const length = text.length;
  let index = length > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;

  function fail(code, detail) {
    throw new PluginCheckError(code, `${label}: ${detail} at offset ${index}`);
  }

  function skipWhitespace() {
    while (index < length && WHITESPACE.has(text[index])) index += 1;
  }

  function codePointLabel(code) {
    return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }

  function parseHex4() {
    if (index + 4 > length) fail(ERROR_CODES.INVALID_JSON, 'truncated \\u escape');
    const quad = text.slice(index, index + 4);
    if (!HEX_DIGITS.test(quad)) fail(ERROR_CODES.INVALID_JSON, 'invalid \\u escape');
    index += 4;
    return Number.parseInt(quad, 16);
  }

  function parseString() {
    // Current character is the opening quote.
    index += 1;
    let out = '';
    for (;;) {
      if (index >= length) fail(ERROR_CODES.INVALID_JSON, 'unterminated string');
      const ch = text[index];
      const code = text.charCodeAt(index);
      if (ch === '"') {
        index += 1;
        return out;
      }
      if (code < 0x20) {
        fail(ERROR_CODES.INVALID_JSON, `raw control character ${codePointLabel(code)} in string`);
      }
      if (ch === '\\') {
        index += 1;
        if (index >= length) fail(ERROR_CODES.INVALID_JSON, 'unterminated escape sequence');
        const esc = text[index];
        if (esc === 'u') {
          index += 1;
          const unit = parseHex4();
          if (unit >= 0xdc00 && unit <= 0xdfff) {
            fail(ERROR_CODES.INVALID_UNICODE, 'unpaired low surrogate escape');
          }
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (text[index] !== '\\' || text[index + 1] !== 'u') {
              fail(ERROR_CODES.INVALID_UNICODE, 'unpaired high surrogate escape');
            }
            index += 2;
            const low = parseHex4();
            if (low < 0xdc00 || low > 0xdfff) {
              fail(ERROR_CODES.INVALID_UNICODE, 'unpaired high surrogate escape');
            }
            out += String.fromCharCode(unit, low);
          } else {
            out += String.fromCharCode(unit);
          }
          continue;
        }
        const mapped = SIMPLE_ESCAPES.get(esc);
        if (mapped === undefined) fail(ERROR_CODES.INVALID_JSON, `invalid escape \\${esc}`);
        out += mapped;
        index += 1;
        continue;
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        if (code <= 0xdbff && index + 1 < length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            out += ch + text[index + 1];
            index += 2;
            continue;
          }
        }
        fail(ERROR_CODES.INVALID_UNICODE, 'unpaired surrogate in string');
      }
      out += ch;
      index += 1;
    }
  }

  function parseNumber() {
    NUMBER_PATTERN.lastIndex = index;
    const match = NUMBER_PATTERN.exec(text);
    if (match === null) fail(ERROR_CODES.INVALID_JSON, 'invalid number literal');
    index += match[0].length;
    if (index < length) {
      const next = text[index];
      if (next !== undefined && /[0-9A-Za-z_.+\-]/.test(next)) {
        fail(ERROR_CODES.INVALID_JSON, 'invalid trailing character in number literal');
      }
    }
    const token = match[0];
    const value = Number(token);
    if (!Number.isFinite(value)) fail(ERROR_CODES.INVALID_JSON, 'number is not finite');
    // DEF-05：整数 token 必须"字面量 == 双精度值"。`9007199254740993` 会被 Number()
    // 静默取整成 9007199254740992，于是两份只差一个字面量的 manifest 得到同一个摘要，
    // "批准一个、运行另一个"就成立了。与 contracts 的 parseIntegerToken 对齐：
    // 先卡安全整数范围，再用 BigInt 回比十进制原文。
    // 浮点 token 走另一条路径（DEF-01 记录的是浮点精度，本轮不改）。
    if (!/[.eE]/.test(token)) {
      if (!Number.isSafeInteger(value)) {
        fail(ERROR_CODES.INVALID_JSON, 'integer literal exceeds Number.MAX_SAFE_INTEGER');
      }
      if (BigInt(token) !== BigInt(value)) {
        fail(ERROR_CODES.INVALID_JSON, 'integer literal cannot be represented exactly as a double');
      }
    }
    return value;
  }

  function parseLiteral(word, value) {
    if (text.slice(index, index + word.length) !== word) {
      fail(ERROR_CODES.INVALID_JSON, `unexpected literal, expected "${word}"`);
    }
    index += word.length;
    return value;
  }

  function parseObject(depth) {
    index += 1; // '{'
    const result = {};
    const seen = new Set();
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return result;
    }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') fail(ERROR_CODES.INVALID_JSON, 'expected a string object key');
      const key = parseString();
      if (seen.has(key)) fail(ERROR_CODES.DUPLICATE_KEY, `duplicate object key ${JSON.stringify(key)}`);
      seen.add(key);
      skipWhitespace();
      if (text[index] !== ':') fail(ERROR_CODES.INVALID_JSON, 'expected ":" after object key');
      index += 1;
      const value = parseValue(depth + 1);
      defineMember(result, key, value);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return result;
      }
      fail(ERROR_CODES.INVALID_JSON, 'expected "," or "}" in object');
    }
  }

  function parseArray(depth) {
    index += 1; // '['
    const result = [];
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return result;
    }
    for (;;) {
      const value = parseValue(depth + 1);
      result.push(value);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return result;
      }
      fail(ERROR_CODES.INVALID_JSON, 'expected "," or "]" in array');
    }
  }

  function parseValue(depth) {
    if (depth > maxDepth) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, `nesting deeper than ${maxDepth} levels`);
    }
    skipWhitespace();
    if (index >= length) fail(ERROR_CODES.INVALID_JSON, 'unexpected end of input');
    const ch = text[index];
    if (ch === '{') return parseObject(depth);
    if (ch === '[') return parseArray(depth);
    if (ch === '"') return parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber();
    if (ch === 't') return parseLiteral('true', true);
    if (ch === 'f') return parseLiteral('false', false);
    if (ch === 'n') return parseLiteral('null', null);
    fail(ERROR_CODES.INVALID_JSON, `unexpected character ${JSON.stringify(ch)}`);
  }

  const value = parseValue(1);
  skipWhitespace();
  if (index < length) {
    fail(ERROR_CODES.INVALID_JSON, 'trailing content after the JSON value');
  }
  return value;
}

/**
 * Assigns an own property without ever touching the prototype chain.
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 */
export function defineMember(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  target[key] = value;
}
