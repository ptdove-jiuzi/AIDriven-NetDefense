/**
 * DEF-01 回归用例（M9 P3 修复）。
 *
 * 缺陷：`parseFloatToken` 只检查 `Number.isFinite`，于是不可精确表示的浮点字面量被
 * **静默归一**——`1e-400` / `-1e-400` / `0` 是同一个值，`1.0000000000000001` 与 `1`
 * 是同一个值。同一份内容因此有多种字节表示却只有一个摘要，与"摘要唯一对应一份内容"
 * 的前提冲突。整数路径早已用 `BigInt` 对账字面量，浮点路径没有对应校验。
 *
 * 修复后的合同：字面量归一化后必须等于该双精度值的**最短往返写法**，
 * 否则报 `ERR_NUMBER_PRECISION_LOSS`（不是语法错误、不是"不有限"）。
 *
 * 修复前这些用例必然变红：下溢那几条会返回 `0`，舍入那几条会返回 `1`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractError,
  ERROR_CODES,
  canonicalDigest,
  parseStrictJson,
} from '../../packages/contracts/src/index.js';

import { expectCode } from './helpers.js';

/** 断言抛 ContractError 且错误码是精度丢失（不是语法错误）。 */
function expectPrecisionLoss(fn, pathContains) {
  return expectCode(fn, ERROR_CODES.ERR_NUMBER_PRECISION_LOSS, pathContains);
}

test('DEF-01：下溢字面量被拒绝，而不是静默变成 0', () => {
  // 修复前：三者解析结果完全相同（都是 0），摘要也相同。
  for (const literal of ['1e-400', '-1e-400', '4.9e-400', '1e-9999']) {
    expectPrecisionLoss(() => parseStrictJson(literal), '$');
    expectPrecisionLoss(() => parseStrictJson(`{"a":${literal}}`), '$.a');
  }

  // 真正的 0 仍然可用：拒绝的是"下溢成 0"，不是"零"。
  assert.equal(parseStrictJson('0'), 0);
  assert.equal(parseStrictJson('-0'), 0);
  assert.equal(parseStrictJson('0.0'), 0);
  assert.equal(parseStrictJson('0e5'), 0);
  assert.equal(parseStrictJson('{"a":-0.0}').a, 0);
});

test('DEF-01：被静默舍入的字面量被拒绝，同一份内容不再有两种字节表示', () => {
  // 修复前：`{"a":1.0000000000000001}` 与 `{"a":1}` 得到同一个摘要。
  expectPrecisionLoss(() => parseStrictJson('1.0000000000000001'), '$');
  expectPrecisionLoss(() => parseStrictJson('{"a":1.0000000000000001}'), '$.a');
  expectPrecisionLoss(() => parseStrictJson('{"a":0.1000000000000000055511151231257827}'), '$.a');
  expectPrecisionLoss(() => parseStrictJson('2.0000000000000002'), '$');

  // 对照：最短往返写法照常接受，且等价写法（尾随零、指数）不受影响。
  assert.equal(parseStrictJson('1'), 1);
  assert.equal(parseStrictJson('1.0'), 1);
  assert.equal(parseStrictJson('1e0'), 1);
  assert.equal(parseStrictJson('1.00e0'), 1);
  assert.equal(parseStrictJson('100.0'), 100);
  assert.equal(parseStrictJson('1e2'), 100);
});

test('DEF-01：合法浮点不受影响（拒绝精度丢失，不是拒绝浮点）', () => {
  const cases = [
    ['0.1', 0.1],
    ['1.5', 1.5],
    ['-3e2', -300],
    ['2.5', 2.5],
    ['0.30000000000000004', 0.30000000000000004],
    ['1e-7', 1e-7],
    ['5e-324', 5e-324],
    ['1e-323', 1e-323],
    ['1.7976931348623157e308', Number.MAX_VALUE],
    ['0.000001', 0.000001],
    ['1.5e-7', 1.5e-7],
  ];
  for (const [text, expected] of cases) {
    assert.equal(parseStrictJson(text), expected, `${text} 必须继续可用`);
    assert.equal(parseStrictJson(`{"v":${text}}`).v, expected, `${text} 在对象里也必须继续可用`);
  }
});

test('DEF-01：错误类型是精度丢失，路径指向真正出问题的字段', () => {
  let captured = null;
  assert.throws(() => {
    try {
      parseStrictJson('{"outer":{"inner":1e-400}}');
    } catch (error) {
      captured = error;
      throw error;
    }
  }, (error) => {
    assert.ok(error instanceof ContractError, '必须是 ContractError');
    assert.equal(error.code, ERROR_CODES.ERR_NUMBER_PRECISION_LOSS);
    assert.notEqual(error.code, ERROR_CODES.ERR_JSON_SYNTAX, '这不是语法错误');
    assert.notEqual(error.code, ERROR_CODES.ERR_NUMBER_NOT_FINITE, '这不是"不有限"');
    assert.equal(error.path, '$.outer.inner');
    return true;
  });
  assert.notEqual(captured, null);
});

test('DEF-01：摘要把两份不同的字节分开（旧行为下它们相同）', () => {
  const exact = parseStrictJson('{"a":1}');
  // 旧行为：这一行解析成 {a:1}，摘要与上面一致。
  expectPrecisionLoss(() => canonicalDigest(parseStrictJson('{"a":1.0000000000000001}')), '$.a');
  // 可精确表示的不同值仍然给出不同摘要（修复没有把浮点压成同一个值）。
  assert.notEqual(canonicalDigest(exact), canonicalDigest(parseStrictJson('{"a":1.5}')));
  assert.notEqual(canonicalDigest(parseStrictJson('{"a":0.1}')), canonicalDigest(parseStrictJson('{"a":0.2}')));
});
