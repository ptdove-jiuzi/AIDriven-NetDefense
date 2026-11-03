import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalDigest,
  canonicalize,
  canonicalSize,
} from '../../packages/contracts/src/index.js';
import { expectCode, fixedDigest } from './helpers.js';

test('键序不同的语义等价对象得到相同规范化文本与摘要', () => {
  const left = { b: 2, a: [1, 'x'], c: { z: true, y: null } };
  const right = { c: { y: null, z: true }, a: [1, 'x'], b: 2 };
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(canonicalDigest(left), canonicalDigest(right));
  assert.equal(
    canonicalize(left),
    '{"a":[1,"x"],"b":2,"c":{"y":null,"z":true}}',
  );
});

test('转义写法不同但解析值相同的字符串摘要一致', () => {
  const escaped = JSON.parse('"\\u00e9"');
  const literal = '\u00e9';
  assert.equal(escaped, literal);
  assert.equal(canonicalDigest({ value: escaped }), canonicalDigest({ value: literal }));
});

test('数组顺序改变会改变摘要', () => {
  assert.notEqual(canonicalDigest(['a', 'b']), canonicalDigest(['b', 'a']));
});

test('摘要固定为 64 位小写 hex', () => {
  assert.match(canonicalDigest({ any: 'value' }), /^[0-9a-f]{64}$/);
  assert.equal(canonicalDigest({ any: 'value' }).length, 64);
});

test('循环引用被拒绝', () => {
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  expectCode(() => canonicalize(cyclic), 'ERR_INPUT_NOT_OBJECT', '$.self');
});

test('undefined / 函数 / Symbol 被拒绝', () => {
  expectCode(() => canonicalize({ a: undefined }), 'ERR_FIELD_TYPE', '$.a');
  expectCode(() => canonicalize({ a: () => 1 }), 'ERR_FIELD_TYPE', '$.a');
  expectCode(() => canonicalize({ a: Symbol('s') }), 'ERR_FIELD_TYPE', '$.a');
});

test('类实例与 Date 等非普通对象被拒绝', () => {
  class Box {
    constructor() {
      this.value = 1;
    }
  }
  expectCode(() => canonicalize(new Box()), 'ERR_INPUT_NOT_OBJECT', '$');
  expectCode(() => canonicalize({ at: new Date(0) }), 'ERR_INPUT_NOT_OBJECT', '$.at');
});

test('非安全整数与非有限数被拒绝', () => {
  expectCode(() => canonicalize(2 ** 53), 'ERR_NUMBER_PRECISION_LOSS', '$');
  expectCode(() => canonicalize(Number.NaN), 'ERR_NUMBER_NOT_FINITE', '$');
  expectCode(() => canonicalize(Number.POSITIVE_INFINITY), 'ERR_NUMBER_NOT_FINITE', '$');
});

test('孤立代理项被拒绝，不再与另一个孤立代理项撞摘要', () => {
  // 旧实现对 \ud800 与 \ud801 都输出同一份替换字节，摘要相同。
  expectCode(() => canonicalDigest('\ud800'), 'ERR_UNPAIRED_SURROGATE', '$');
  expectCode(() => canonicalDigest('\ud801'), 'ERR_UNPAIRED_SURROGATE', '$');
  expectCode(() => canonicalize({ text: 'a\ud800b' }), 'ERR_UNPAIRED_SURROGATE', '$.text');
  // 合法的代理对必须继续可用，且两种写法等价。
  assert.equal(canonicalDigest('\ud83d\ude00'), canonicalDigest('\u{1F600}'));
});

test('稀疏数组被拒绝，不输出非法 JSON', () => {
  // eslint-disable-next-line no-sparse-arrays
  expectCode(() => canonicalize([, 1]), 'ERR_FIELD_TYPE', '$[0]');
  const sparse = [1, 2, 3];
  delete sparse[1];
  expectCode(() => canonicalize(sparse), 'ERR_FIELD_TYPE', '$[1]');
  assert.equal(canonicalize([0, 1]), '[0,1]');
});

test('已知答案向量：ASCII 对象的规范化字节与独立 oracle 一致', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.equal(
    canonicalDigest({ b: 1, a: [true, null] }),
    fixedDigest('{"a":[true,null],"b":1}'),
  );
});

test('已知答案向量：中文键按码位排序后原样输出 UTF-8', () => {
  const value = { n: 1, 名称: '防御' };
  assert.equal(canonicalize(value), '{"n":1,"名称":"防御"}');
  assert.equal(canonicalDigest(value), fixedDigest('{"n":1,"名称":"防御"}'));
});

test('二次规范化幂等', () => {
  const value = { b: [1, { d: '文本' }], a: 0.25 };
  const once = canonicalize(value);
  assert.equal(canonicalize(JSON.parse(once)), once);
});

test('中文与 emoji 在 round-trip 中不被破坏', () => {
  const value = { 中文: '防御', emoji: '\u{1F6E1}\u{FE0F}', 换行: 'line' };
  const text = canonicalize(value);
  assert.ok(text.includes('防御'));
  assert.ok(text.includes('\u{1F6E1}'));
  assert.deepStrictEqual(JSON.parse(text), value);
});

test('-0 规范化为 0，控制符写成小写 \\u00xx', () => {
  assert.equal(canonicalize(-0), '0');
  assert.equal(canonicalize({ key: -0 }), '{"key":0}');
  assert.equal(canonicalize('a\u0001b'), '"a\\u0001b"');
  assert.equal(canonicalSize('a\u0001b'), 10);
});

test('canonicalSize 与 canonicalize 的 UTF-8 字节数一致', () => {
  const value = { text: '中文' };
  assert.equal(canonicalSize(value), Buffer.byteLength(canonicalize(value), 'utf8'));
});

/*
 * canonicalize 不得静默丢弃内容：过去 `arr.x = 'y'` 与 `[1]` 摘要相同，
 * 带 Symbol 键的对象也与去掉该键的对象摘要相同，等于让内容凭空消失。
 */
test('带非索引键的数组被拒绝，不再与纯数组撞摘要', () => {
  const arr = [1];
  arr.x = 'y';
  const error = expectCode(() => canonicalize(arr), 'ERR_FIELD_TYPE', '$');
  assert.equal(error.details.key, 'x');
  expectCode(() => canonicalDigest(arr), 'ERR_FIELD_TYPE', '$');
  // 合法数组的摘要不受影响。
  assert.equal(canonicalize([1]), '[1]');
  assert.equal(canonicalize([1, 2]), '[1,2]');
});

test('带 Symbol 键的对象被拒绝', () => {
  const value = { a: 1 };
  value[Symbol('hidden')] = 2;
  const error = expectCode(() => canonicalDigest(value), 'ERR_FIELD_TYPE', '$');
  assert.ok(Array.isArray(error.details.symbols));
  assert.deepStrictEqual([...error.details.symbols], ['Symbol(hidden)']);
  expectCode(() => canonicalize({ nested: value }), 'ERR_FIELD_TYPE', '$.nested');
});

test('带 Symbol 键的数组同样被拒绝', () => {
  const arr = [1];
  arr[Symbol('hidden')] = 2;
  expectCode(() => canonicalize(arr), 'ERR_FIELD_TYPE', '$');
});

/*
 * "数字样"的键不等于数组索引：2**32-1 超出数组索引上界，不会进入 `[...]`，
 * 过去被当成索引静默丢弃，arr 与 [1] 摘要相同，HIDDEN 凭空消失。
 */
test('数组上超出索引上界的键 4294967295 被拒绝，details.key 正确', () => {
  const arr = [1];
  arr['4294967295'] = 'HIDDEN';
  const error = expectCode(() => canonicalize(arr), 'ERR_FIELD_TYPE', '$');
  assert.equal(error.details.key, '4294967295');
  expectCode(() => canonicalDigest(arr), 'ERR_FIELD_TYPE', '$');
  // 纯数组的规范化文本与摘要不受影响。
  assert.equal(canonicalize([1]), '[1]');
});

/*
 * length 之外的自有数字键这是普通写法构造不出来的（写 arr[3] 会自动把 length 抬到 4，
 * 调小 length 会删除元素），所以用 Proxy 暴露一个 target 上不存在、且下标 >= length
 * 的自有索引键，代表"序列化范围之外但仍存在于对象上"的键。
 */
test('数组上 length 之外的自有数字索引键被拒绝，details.key 正确', () => {
  const fixture = [1];
  const arr = new Proxy(fixture, {
    ownKeys: () => ['0', 'length', '3'],
    getOwnPropertyDescriptor: (target, key) => (key === '3'
      ? { value: 'HIDDEN', writable: true, enumerable: true, configurable: true }
      : Reflect.getOwnPropertyDescriptor(target, key)),
  });
  assert.equal(arr.length, 1);
  const error = expectCode(() => canonicalize(arr), 'ERR_FIELD_TYPE', '$');
  assert.equal(error.details.key, '3');
});

test('普通对象上的非枚举自有键被拒绝，不与去掉该键的对象撞摘要', () => {
  const value = { a: 1 };
  Object.defineProperty(value, 'secret', {
    value: 2,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  const error = expectCode(() => canonicalize(value), 'ERR_FIELD_TYPE', '$.secret');
  assert.equal(error.details.key, 'secret');
  expectCode(() => canonicalDigest(value), 'ERR_FIELD_TYPE', '$.secret');
  expectCode(() => canonicalize({ nested: value }), 'ERR_FIELD_TYPE', '$.nested.secret');
  assert.equal(canonicalize({ a: 1 }), '{"a":1}');
});

test('数组上的非枚举索引被拒绝', () => {
  const arr = [0];
  Object.defineProperty(arr, 0, {
    value: 1,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  const error = expectCode(() => canonicalize(arr), 'ERR_FIELD_TYPE', '$[0]');
  assert.equal(error.details.key, '0');
  // 可枚举的同值数组仍正常。
  assert.equal(canonicalize([1]), '[1]');
});

/*
 * 浮点 KAT：把规范化文本写成字面量锁定当前实现（String(value)，即 ES Number::toString），
 * 防止后续"顺手美化"数字格式而悄悄改变已发布摘要。字面量均来自实测，不是猜测。
 */
test('浮点规范化文本 KAT：0.1 / 1e-7 / 0.1+0.2 / 1e-10 / 5e-324', () => {
  assert.equal(canonicalize(0.1), '0.1');
  assert.equal(canonicalize(1e-7), '1e-7');
  assert.equal(canonicalize(0.1 + 0.2), '0.30000000000000004');
  assert.equal(canonicalize(1e-10), '1e-10');
  assert.equal(canonicalize(5e-324), '5e-324');
  assert.equal(canonicalize(-1.5), '-1.5');
  assert.equal(canonicalize({ x: 0.1, y: 1e-7 }), '{"x":0.1,"y":1e-7}');
});

/*
 * 实测结论（锁定现状，不改动 digest 算法）：1e21 是 Number.isInteger 意义上的整数，
 * 只是超出安全整数范围，因此在 writeNumber 的格式化分支之前就被
 * ERR_NUMBER_PRECISION_LOSS 拒绝；"1e+21" 这类大数指数文本在 canonicalize 中不可达。
 * 能产出指数记号的只有 |x| < 1e-6 的非整数，形如 "1e-7"（ES 规范写法，无 +0 填充）。
 */
test('1e21 在格式化之前就被安全整数检查拒绝，大数指数文本不可达', () => {
  assert.equal(Number.isInteger(1e21), true);
  expectCode(() => canonicalize(1e21), 'ERR_NUMBER_PRECISION_LOSS', '$');
  expectCode(() => canonicalize(-1e21), 'ERR_NUMBER_PRECISION_LOSS', '$');
  expectCode(() => canonicalize({ big: 1e21 }), 'ERR_NUMBER_PRECISION_LOSS', '$.big');
});

test('回归：合法数组与对象摘要不变', () => {
  assert.equal(canonicalize({ a: [1, 2], b: 'x' }), '{"a":[1,2],"b":"x"}');
  assert.equal(canonicalDigest({ a: 1 }), fixedDigest('{"a":1}'));
  assert.equal(canonicalDigest([true, null, 3]), fixedDigest('[true,null,3]'));
});
