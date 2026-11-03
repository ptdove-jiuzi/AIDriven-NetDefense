import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  LIMITS,
  parseStrictJson,
} from '../../packages/contracts/src/index.js';
import { expectCode } from './helpers.js';

function repeatArray(depth) {
  let text = '1';
  for (let index = 0; index < depth; index += 1) text = `[${text}]`;
  return text;
}

function buildObject(keyCount) {
  const parts = [];
  for (let index = 0; index < keyCount; index += 1) parts.push(`"k${index}":${index}`);
  return `{${parts.join(',')}}`;
}

function buildArray(itemCount) {
  const parts = [];
  for (let index = 0; index < itemCount; index += 1) parts.push(String(index));
  return `[${parts.join(',')}]`;
}

test('严格解析器对合法 JSON 与 JSON.parse 结果深度相等', () => {
  const text = '{"a":1,"b":[true,false,null,"文本"],"c":{"d":-2.5,"e":1e3}}';
  assert.deepStrictEqual(parseStrictJson(text), JSON.parse(text));
});

test('接受 Buffer 与 Uint8Array 形式的 UTF-8 输入', () => {
  const text = '{"阶段":"一"}';
  const bytes = Buffer.from(text, 'utf8');
  assert.deepStrictEqual(parseStrictJson(bytes), JSON.parse(text));
  assert.deepStrictEqual(parseStrictJson(new Uint8Array(bytes)), JSON.parse(text));
});

test('顶层重复键被拒绝', () => {
  expectCode(() => parseStrictJson('{"a":1,"a":2}'), 'ERR_DUPLICATE_KEY', '$');
});

test('嵌套重复键被拒绝且 details.key 给出键名', () => {
  const error = expectCode(
    () => parseStrictJson('{"outer":{"x":1,"x":2}}'),
    'ERR_DUPLICATE_KEY',
    '$.outer.x',
  );
  assert.equal(error.path, '$.outer.x');
  assert.ok(error.path.startsWith('$'));
  assert.equal(error.details.key, 'x');
});

/*
 * 深度计数约定：根容器本身计作第 1 层，因此最多允许 6 层容器。
 * 标量根（如 `1`）不占容器层数；6 层容器接受，第 7 层容器拒绝。
 */
test('深度约定：根容器算第 1 层，6 层接受、第 7 层拒绝', () => {
  function nestObjects(depth) {
    let text = '1';
    for (let index = 0; index < depth; index += 1) text = `{"a":${text}}`;
    return text;
  }
  assert.equal(parseStrictJson('1'), 1);
  assert.deepStrictEqual(parseStrictJson(nestObjects(6)), JSON.parse(nestObjects(6)));
  assert.deepStrictEqual(parseStrictJson(repeatArray(6)), JSON.parse(repeatArray(6)));
  expectCode(() => parseStrictJson(nestObjects(7)), 'ERR_MAX_DEPTH_EXCEEDED', '$');
  expectCode(() => parseStrictJson(repeatArray(7)), 'ERR_MAX_DEPTH_EXCEEDED', '$');
  // 非法上限（0 不是正整数）回落默认 6，不会把上限收紧成 0 也不会放宽。
  assert.deepStrictEqual(parseStrictJson(nestObjects(6), { maxDepth: 0 }), JSON.parse(nestObjects(6)));
});

test('解析选项无法放宽深度上限', () => {
  expectCode(() => parseStrictJson(repeatArray(7), { maxDepth: 99 }), 'ERR_MAX_DEPTH_EXCEEDED', '$');
});

test('解析选项无法放宽消息体积上限', () => {
  const text = `"${'a'.repeat(2 * 1024 * 1024)}"`;
  expectCode(() => parseStrictJson(text, { maxMessageBytes: 4000000 }), 'ERR_INPUT_TOO_LARGE', '$');
});

test('解析选项无法放宽对象键数上限', () => {
  expectCode(() => parseStrictJson(buildObject(200), { maxObjectKeys: 999 }), 'ERR_MAX_OBJECT_KEYS', '$');
});

test('解析选项无法放宽数组项数上限', () => {
  expectCode(() => parseStrictJson(buildArray(300), { maxArrayItems: 999 }), 'ERR_MAX_ARRAY_ITEMS', '$');
});

test('__proto__ / constructor / prototype 在任意层级都被拒绝', () => {
  expectCode(() => parseStrictJson('{"__proto__":{"polluted":true}}'), 'ERR_FORBIDDEN_KEY', '$');
  expectCode(() => parseStrictJson('{"a":{"constructor":{}}}'), 'ERR_FORBIDDEN_KEY', '$.a');
  expectCode(() => parseStrictJson('[{"prototype":1}]'), 'ERR_FORBIDDEN_KEY', '$');
  assert.equal({}.polluted, undefined);
});

test('嵌套深度 6 接受、深度 7 拒绝', () => {
  assert.deepStrictEqual(parseStrictJson(repeatArray(6)), JSON.parse(repeatArray(6)));
  expectCode(() => parseStrictJson(repeatArray(7)), 'ERR_MAX_DEPTH_EXCEEDED', '$');
});

test('对象 128 个键接受、129 个键拒绝', () => {
  assert.equal(Object.keys(parseStrictJson(buildObject(128))).length, 128);
  expectCode(() => parseStrictJson(buildObject(129)), 'ERR_MAX_OBJECT_KEYS', '$');
});

test('数组 256 项接受、257 项拒绝', () => {
  assert.equal(parseStrictJson(buildArray(256)).length, 256);
  expectCode(() => parseStrictJson(buildArray(257)), 'ERR_MAX_ARRAY_ITEMS', '$');
});

test('字符串 16384 字节接受、16385 字节拒绝', () => {
  const ok = `"${'a'.repeat(16384)}"`;
  const tooLong = `"${'a'.repeat(16385)}"`;
  assert.equal(parseStrictJson(ok).length, 16384);
  expectCode(() => parseStrictJson(tooLong), 'ERR_MAX_STRING_BYTES', '$');
});

test('maxStringBytes 可放宽到 raw evidence 通道，但默认配置仍拒绝', () => {
  const text = `{"raw_evidence":{"encoding":"utf-8","text":"${'a'.repeat(20480)}"}}`;
  const parsed = parseStrictJson(text, { maxStringBytes: LIMITS.maxRawEvidenceStringBytes });
  assert.equal(parsed.raw_evidence.text.length, 20480);
  expectCode(() => parseStrictJson(text), 'ERR_MAX_STRING_BYTES', '$.raw_evidence.text');
});

test('超过 1MiB 的字节输入先按长度拒绝，不做解码', () => {
  const oversized = Buffer.alloc(LIMITS.maxMessageBytes + 1, 0xff);
  expectCode(() => parseStrictJson(oversized), 'ERR_INPUT_TOO_LARGE', '$');
});

test('超过 1MiB 的字符串输入被拒绝', () => {
  expectCode(() => parseStrictJson(' '.repeat(LIMITS.maxMessageBytes + 1)), 'ERR_INPUT_TOO_LARGE', '$');
});

test('BOM 开头被拒绝', () => {
  expectCode(() => parseStrictJson('\uFEFF{"a":1}'), 'ERR_ENCODING_NOT_UTF8', '$');
  expectCode(
    () => parseStrictJson(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
    'ERR_ENCODING_NOT_UTF8',
    '$',
  );
});

test('非法 UTF-8 字节被拒绝', () => {
  expectCode(
    () => parseStrictJson(Buffer.from([0x7b, 0xff, 0x7d])),
    'ERR_ENCODING_NOT_UTF8',
    '$',
  );
});

test('孤立代理项转义 \\ud800 被拒绝', () => {
  expectCode(() => parseStrictJson('"\\ud800"'), 'ERR_UNPAIRED_SURROGATE', '$');
  expectCode(() => parseStrictJson('"\\udc00"'), 'ERR_UNPAIRED_SURROGATE', '$');
});

test('成对代理项转义被接受', () => {
  assert.equal(parseStrictJson('"\\ud83d\\ude00"'), '\u{1F600}');
});

test('裸控制符与 \\n 转义都被拒绝', () => {
  expectCode(() => parseStrictJson('"a\u0001b"'), 'ERR_STRING_CONTROL_CHARACTER', '$');
  expectCode(() => parseStrictJson('"a\\nb"'), 'ERR_STRING_CONTROL_CHARACTER', '$');
  expectCode(() => parseStrictJson('"a\\tb"'), 'ERR_STRING_CONTROL_CHARACTER', '$');
});

test('双向覆盖符 U+202E 被拒绝', () => {
  expectCode(() => parseStrictJson('"a\u202Eb"'), 'ERR_STRING_BIDI_OVERRIDE', '$');
});

test('零宽字符 U+200B 被拒绝', () => {
  expectCode(() => parseStrictJson('"a\u200Bb"'), 'ERR_STRING_ZERO_WIDTH', '$');
});

test('NFD 字符串被拒绝、NFC 字符串被接受', () => {
  expectCode(() => parseStrictJson(`"e\u0301"`), 'ERR_STRING_NOT_NFC', '$');
  assert.equal(parseStrictJson('"\u00e9"'), '\u00e9');
});

test('超出安全整数范围的整数被拒绝，边界值被接受', () => {
  expectCode(() => parseStrictJson('9007199254740993'), 'ERR_NUMBER_PRECISION_LOSS', '$');
  assert.equal(parseStrictJson('9007199254740991'), 9007199254740991);
  assert.equal(parseStrictJson('-0'), 0);
  assert.ok(Object.is(parseStrictJson('-0'), 0));
});

test('指数溢出为 Infinity 的数字被拒绝', () => {
  expectCode(() => parseStrictJson('1e400'), 'ERR_NUMBER_NOT_FINITE', '$');
});

test('JSON 词法非法的各种写法都被拒绝', () => {
  const bad = [
    '{"a":1} trailing',
    "{'a':1}",
    '{"a":1} // comment',
    '{"a":1,}',
    '[1,2,]',
    '+1',
    '.5',
    '01',
    '1.',
    '0x10',
    'NaN',
    'Infinity',
    'undefined',
    '{"a" 1}',
    '',
  ];
  for (const text of bad) {
    expectCode(() => parseStrictJson(text), 'ERR_JSON_SYNTAX', '$');
  }
});

test('解析结果不含原始 token 信息且键序与输入一致', () => {
  const value = parseStrictJson('{"b":1,"a":2}');
  assert.deepStrictEqual(Object.keys(value), ['b', 'a']);
  assert.equal(canonicalDigest(value), canonicalDigest({ a: 2, b: 1 }));
});

test('allowControls 显式放开时换行转义可以通过', () => {
  assert.equal(parseStrictJson('"a\\nb"', { allowControls: true }), 'a\nb');
});

test('allowControls: true 只等价于 \\t \\n \\r，ESC 仍然被拒绝', () => {
  // 公开导出上的 true 曾经等于"全部放行"，等于给了 ANSI 转义序列一条直通下游的路。
  expectCode(
    () => parseStrictJson('"a\\u001bb"', { allowControls: true }),
    'ERR_STRING_CONTROL_CHARACTER',
    '$',
  );
  assert.equal(parseStrictJson('"a\\nb"', { allowControls: true }), 'a\nb');
  assert.equal(parseStrictJson('"a\\tb"', { allowControls: true }), 'a\tb');
  assert.equal(parseStrictJson('"a\\rb"', { allowControls: true }), 'a\rb');
});

test('allowControls 数组与 RAW_EVIDENCE_CONTROLS 求交，NUL 仍然被拒绝', () => {
  expectCode(
    () => parseStrictJson('"a\\u0000b"', { allowControls: ['\u0000'] }),
    'ERR_STRING_CONTROL_CHARACTER',
    '$',
  );
  // 求交后仍非空的合法集合继续生效，证明不是"数组一律拒绝"。
  assert.equal(parseStrictJson('"a\\nb"', { allowControls: ['\n', '\u0000'] }), 'a\nb');
});
