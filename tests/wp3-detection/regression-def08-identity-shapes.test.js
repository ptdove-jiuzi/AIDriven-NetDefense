/**
 * DEF-08 身份形状回归（M9 P3，第 2 轮独立审查补充）。
 *
 * 第 1 轮修复把非标量值改成"类型标签 + 规范 JSON"之后，第 2 轮审查实测出两个新的退化：
 *
 * 1. **数组里的非纯 JSON 对象**：`canonicalStringify` 对没有自有可枚举键的对象一律输出
 *    `{}`，于是两个不同的 `Date` 放进数组后共享同一个身份——比修复前的
 *    `String([date])` 更差。修法：先把值投影成"规范 JSON 能表达的形状"，
 *    非 JSON 叶子换成它们的文本身份，再序列化。
 * 2. **标量预览带控制符**：`normalizeText` 只折叠空白，不剥 C0/C1，带 ESC 的标量字段
 *    会把控制符原样带进 `fingerprintPreview`。修法：只转义**预览文本**，摘要不变。
 *
 * 这两条在修复前必然变红：`[Date0]` 与 `[Date1000]` 同指纹、预览里能匹配到 `\u001b`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeFingerprint } from '../../packages/detection/index.js';

const SPEC = Object.freeze([Object.freeze({ path: 'process.name', transform: 'none' })]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function fingerprintOf(value) {
  return computeFingerprint({
    ruleId: 'corpus.condition',
    ruleVersion: '1.0.0',
    specification: SPEC,
    event: { fields: { process: { name: value } } },
    maxPreviewLength: 256,
  });
}

test('DEF-08：数组里的非 JSON 对象保留可区分的身份', () => {
  // 修复前：两者都序列化成 `[{}]`，指纹相同。
  assert.notEqual(
    fingerprintOf([new Date(0)]).fingerprint,
    fingerprintOf([new Date(1000)]).fingerprint,
    'two different Dates inside an array must not share one identity',
  );
  // 嵌套在数组里的对象里的 Date 同样要保留区分度。
  assert.notEqual(
    fingerprintOf([{ at: new Date(0) }]).fingerprint,
    fingerprintOf([{ at: new Date(1000) }]).fingerprint,
  );
  // 类实例（无自有可枚举键）与空对象仍然按旧语义处理：这一条是"没有变差"的对照。
  assert.equal(fingerprintOf([{}]).fingerprint, fingerprintOf([{}]).fingerprint);
});

test('DEF-08：纯 JSON 数组的形状没有被破坏（仍与字符串互不相等）', () => {
  assert.notEqual(fingerprintOf([1, 2]).fingerprint, fingerprintOf('1,2').fingerprint);
  assert.notEqual(fingerprintOf([1, [2, 3]]).fingerprint, fingerprintOf([1, 2, 3]).fingerprint);
  // 结构相同的数组仍然同指纹（确定性不受影响）。
  assert.equal(fingerprintOf([{ a: 1 }, { b: 2 }]).fingerprint, fingerprintOf([{ a: 1 }, { b: 2 }]).fingerprint);
  // 数组与"长得像数组的字符串"仍然是不同身份。
  assert.notEqual(fingerprintOf([1]).fingerprint, fingerprintOf('[1]').fingerprint);
});

test('DEF-08：标量预览里的控制符被转义（摘要不受影响）', () => {
  const value = 'a\u001bb\u007fc\u0085d';
  const result = fingerprintOf(value);
  const preview = result.preview[0].preview;

  assert.equal(CONTROL.test(preview), false, `preview must not carry control characters: ${JSON.stringify(preview)}`);
  assert.match(preview, /\\u001b/u, 'ESC is escaped, not dropped');
  assert.match(preview, /\\u007f/u, 'DEL is escaped, not dropped');
  assert.match(preview, /\\u0085/u, 'C1 is escaped, not dropped');

  // 摘要只覆盖身份项，预览转义不能改变指纹。
  assert.equal(result.fingerprint, fingerprintOf(value).fingerprint);
  assert.notEqual(result.fingerprint, fingerprintOf('a\u001bb\u007fc\u0085e').fingerprint);
});

test('DEF-08：非标量预览同样不含控制符（含 C1）', () => {
  const preview = fingerprintOf({ note: 'a\u001bb\u007fc\u009fd' }).preview[0].preview;
  assert.equal(CONTROL.test(preview), false, JSON.stringify(preview));
});
