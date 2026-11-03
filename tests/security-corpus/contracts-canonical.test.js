// author: PT-dove
// M9 对抗语料 —— contracts 规范化（canonicalize / canonicalDigest / canonicalSize）。
//
// 规范化的唯一职责：**同一份内容 → 同一串字节；不同内容 → 不同摘要**。
// 因此这里的重点是"碰撞面"：哪些输入会被静默吞掉、哪些输入会让它抛错之外的异常。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractError,
  ERROR_CODES,
  LIMITS,
  canonicalDigest,
  canonicalSize,
  canonicalize,
} from '../../packages/contracts/src/index.js';
import { expectRejection } from './support/harness.js';

test('键序不影响规范化文本（否则摘要会随插入顺序漂移）', () => {
  const first = { b: 2, a: 1, c: { z: 26, y: 25 } };
  const second = { c: { y: 25, z: 26 }, a: 1, b: 2 };
  assert.equal(canonicalize(first), canonicalize(second));
  assert.equal(canonicalDigest(first), canonicalDigest(second));
});

test('规范化文本里没有多余空白，且摘要固定 64 位小写 hex', () => {
  assert.equal(canonicalize({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
  assert.match(canonicalDigest({ a: 1 }), /^[0-9a-f]{64}$/u);
});

test('-0 与 0 得到同一份字节（IEEE-754 里两者相等，规范化必须一致）', () => {
  assert.equal(canonicalize({ a: -0 }), canonicalize({ a: 0 }));
  assert.equal(canonicalize({ a: -0 }), '{"a":0}');
});

test('非安全整数被拒绝，而不是被静默取整', () => {
  expectRejection(() => canonicalize({ a: 9007199254740993 }), {
    code: ERROR_CODES.ERR_NUMBER_PRECISION_LOSS,
    type: ContractError,
    pathIncludes: '$.a',
  });
});

test('非有限数被拒绝', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expectRejection(() => canonicalize({ a: value }), {
      code: ERROR_CODES.ERR_NUMBER_NOT_FINITE,
      type: ContractError,
    });
  }
});

test('循环引用被拒绝（不是栈溢出）', () => {
  const node = { name: 'root' };
  node.self = node;
  expectRejection(() => canonicalize(node), { code: ERROR_CODES.ERR_INPUT_NOT_OBJECT, type: ContractError });
});

test('稀疏数组被拒绝（空洞无法写成合法 JSON）', () => {
  // eslint-disable-next-line no-sparse-arrays
  expectRejection(() => canonicalize([1, , 3]), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
});

test('带非索引键的数组被拒绝，且 details 指出是哪个键', () => {
  const array = [1];
  array.x = 'hidden';
  const error = expectRejection(() => canonicalize(array), {
    code: ERROR_CODES.ERR_FIELD_TYPE,
    type: ContractError,
  });
  assert.equal(error.details?.key, 'x');
});

test('长度之外的数组数字键被拒绝（2^32-1 这类"看起来像索引"的键）', () => {
  const array = [1];
  array['4294967295'] = 'HIDDEN';
  expectRejection(() => canonicalize(array), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
});

test('非枚举数组索引被拒绝', () => {
  const array = [1];
  Object.defineProperty(array, '0', { value: 9, enumerable: false });
  expectRejection(() => canonicalize(array), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
});

test('Symbol 键（数组与对象）被拒绝，否则内容会凭空消失', () => {
  const array = [1];
  array[Symbol('s')] = 2;
  expectRejection(() => canonicalize(array), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });

  const object = { a: 1 };
  object[Symbol('s')] = 2;
  expectRejection(() => canonicalize(object), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
});

test('隐藏（非枚举）字符串键被拒绝', () => {
  const object = { a: 1 };
  Object.defineProperty(object, 'hidden', { value: 2, enumerable: false });
  const error = expectRejection(() => canonicalize(object), {
    code: ERROR_CODES.ERR_FIELD_TYPE,
    type: ContractError,
  });
  assert.equal(error.details?.key, 'hidden');
});

test('只接受普通对象与数组：类实例、Date、Map 一律拒绝', () => {
  class Custom {
    constructor() {
      this.a = 1;
    }
  }
  for (const value of [new Custom(), new Date(0), new Map([['a', 1]]), new Set([1])]) {
    expectRejection(() => canonicalize(value), { code: ERROR_CODES.ERR_INPUT_NOT_OBJECT, type: ContractError });
  }
});

test('函数、Symbol、BigInt 值被拒绝', () => {
  for (const value of [() => 1, Symbol('s'), 1n]) {
    expectRejection(() => canonicalize({ a: value }), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
  }
});

test('孤立代理项被拒绝：\uD800 与 \uD801 不能因为编码成 U+FFFD 而撞摘要', () => {
  expectRejection(() => canonicalize({ a: `x${String.fromCharCode(0xd800)}y` }), {
    code: ERROR_CODES.ERR_UNPAIRED_SURROGATE,
    type: ContractError,
  });
});

test('控制字符以 \\u00xx 小写转义写出，不同控制符不撞摘要', () => {
  const nul = canonicalize({ a: '\u0000' });
  const soh = canonicalize({ a: '\u0001' });
  assert.equal(nul, '{"a":"\\u0000"}');
  assert.notEqual(nul, soh);
  assert.notEqual(canonicalDigest({ a: '\u0000' }), canonicalDigest({ a: '\u0001' }));
});

test('引号与反斜杠被转义，不能靠拼字符串伪造出第二个键', () => {
  const injected = canonicalize({ a: 'x","b":"y' });
  const real = canonicalize({ a: 'x', b: 'y' });
  assert.notEqual(injected, real, 'a value containing JSON punctuation must not forge a sibling key');
  assert.equal(injected, '{"a":"x\\",\\"b\\":\\"y"}');
});

test('U+2028 / U+2029 原样输出（合法 JSON 文本，不能被当成换行切断）', () => {
  const text = canonicalize({ a: 'x\u2028y\u2029z' });
  assert.ok(text.includes('\u2028'));
  assert.equal(JSON.parse(text).a, 'x\u2028y\u2029z');
});

test('canonicalSize 等于规范化文本的 UTF-8 字节数', () => {
  const value = { a: '可疑进程', b: [1, 2, 3] };
  assert.equal(canonicalSize(value), Buffer.byteLength(canonicalize(value), 'utf8'));
});

test('长内容不会被截断：只在预览层截断，摘要覆盖全文', () => {
  const prefix = 'x'.repeat(5000);
  assert.notEqual(canonicalDigest({ a: `${prefix}A` }), canonicalDigest({ a: `${prefix}B` }));
});

test('同一对象连续两次规范化得到相同字节（无隐藏状态）', () => {
  const value = { a: [1, 2, 3], b: { c: 'x' } };
  const first = canonicalize(value);
  const second = canonicalize(value);
  assert.equal(first, second);
});

test('访问器被拒绝：canonicalize 不执行 getter，摘要不再依赖调用顺序（DEF-02 修复后）', () => {
  let calls = 0;
  const value = {
    get counter() {
      calls += 1;
      return calls;
    },
  };
  // 修复前：getter 被调用两次，两次摘要不同（"摘要 = 内容的函数"被破坏）。
  // 修复后：访问器不是数据，一律拒绝，且 getter **一次都不执行**。
  expectRejection(() => canonicalize(value), {
    code: ERROR_CODES.ERR_INPUT_UNREADABLE,
    type: ContractError,
    pathIncludes: '$.counter',
    label: 'accessor property',
  });
  expectRejection(() => canonicalDigest(value), {
    code: ERROR_CODES.ERR_INPUT_UNREADABLE,
    type: ContractError,
    label: 'canonicalDigest of accessor property',
  });
  assert.equal(calls, 0, 'the getter must never run: a digest may not depend on call order');

  // 对照：同样的内容写成数据属性，摘要稳定（拒绝的不是"有个 counter 键"）。
  assert.equal(canonicalDigest({ counter: 1 }), canonicalDigest({ counter: 1 }));
});

test('getter 抛错被归为 ContractError，不再以原始异常穿透（DEF-02 修复后）', () => {
  const value = {
    get bad() {
      throw new TypeError('hostile getter');
    },
  };
  // 修复前：原始 TypeError 穿透，`code === undefined`，调用方无法归类。
  const captured = expectRejection(() => canonicalize(value), {
    code: ERROR_CODES.ERR_INPUT_UNREADABLE,
    type: ContractError,
    label: 'throwing getter',
  });
  assert.ok(
    Object.values(ERROR_CODES).includes(captured.code),
    `${captured.code} must be a documented contract error code`,
  );
  assert.equal(captured instanceof TypeError, false, 'the original error type must not escape');
});

test('Proxy 的 ownKeys 抛错同样归为 ContractError（DEF-02 修复后）', () => {
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new RangeError('hostile proxy');
    },
  });
  expectRejection(() => canonicalize(proxy), {
    code: ERROR_CODES.ERR_INPUT_UNREADABLE,
    type: ContractError,
    label: 'proxy with a throwing ownKeys',
  });
  expectRejection(() => canonicalDigest(proxy), {
    code: ERROR_CODES.ERR_INPUT_UNREADABLE,
    type: ContractError,
    label: 'canonicalDigest of a proxy with a throwing ownKeys',
  });
});

test('内存对象有深度上限：超限报 ERR_MAX_DEPTH_EXCEEDED（DEF-02 修复后）', () => {
  // 修复前：`LIMITS.maxDepth = 6` 只作用于 JSON **文本**，对象图递归没有任何计数，
  // 200 层照常规范化、4000 层直接 RangeError。修复后：对象图与文本共用同一个上限。
  function nest(depth) {
    let node = { leaf: 1 };
    for (let index = 0; index < depth; index += 1) node = { child: node };
    return node;
  }

  // 上限内必须仍然可用（不是"一律拒绝嵌套对象"）。
  const allowed = nest(LIMITS.maxDepth - 1);
  const text = canonicalize(allowed);
  assert.equal(text.startsWith('{"child":{"child":'), true);
  assert.equal(text.includes('"leaf":1'), true);

  // 边界精确：等于 maxDepth 的嵌套必须被拒，且报的是合同错误码而不是 RangeError。
  expectRejection(() => canonicalize(nest(LIMITS.maxDepth)), {
    code: ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED,
    type: ContractError,
    label: `${LIMITS.maxDepth}-level object`,
  });
  expectRejection(() => canonicalize(nest(200)), {
    code: ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED,
    type: ContractError,
    label: '200-level object',
  });
});

test('规范化之后仍可继续规范化别的对象（失败不污染模块状态）', () => {
  assert.throws(() => canonicalize({ a: 9007199254740993 }));
  assert.equal(canonicalize({ a: 1 }), '{"a":1}');
});
