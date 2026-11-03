/**
 * DEF-02 / DEF-12 回归用例（M9 P2 修复）。
 *
 * 每条用例都对应 `docs/implementation/evidence/security-corpus/REPORT.md` §5 里的一条
 * 实测缺陷，断言的是**修复后的合同行为**：
 *
 * - DEF-02：`canonicalize` 只读数据属性（不执行 getter）、有深度上限、
 *   访问器 / Proxy 陷阱异常统一转 `ContractError`。
 * - DEF-12：`parseStrictJson` 先快照 source/options，非法类型与任意异常都不得
 *   以原始 `TypeError` 逃出合同边界。
 *
 * 这些用例在修复前必然变红：旧实现里 getter 会被执行两次而摘要不同、200 层对象
 * 照常序列化、字节分支的 Proxy 直接抛 `TypeError`（`code === undefined`）。
 * 换句话说，它们是"能失败"的回归，不是对现状的复述。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractError,
  ERROR_CODES,
  canonicalDigest,
  canonicalize,
  canonicalSize,
  parseStrictJson,
} from '../../packages/contracts/src/index.js';

/** 断言抛出 ContractError 且错误码符合预期；返回捕获到的错误。 */
function expectContractError(fn, code) {
  let captured = null;
  assert.throws(() => {
    try {
      fn();
    } catch (error) {
      captured = error;
      throw error;
    }
  }, (error) => {
    assert.ok(
      error instanceof ContractError,
      `期望 ContractError，实际 ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}（${error.message}）`);
    return true;
  });
  return captured;
}

/** 构造 depth 层嵌套对象：`{child:{child:...{leaf:1}}}`。 */
function nest(depth) {
  let node = { leaf: 1 };
  for (let index = 0; index < depth; index += 1) node = { child: node };
  return node;
}

// ------------------------------------------------------------------ DEF-02

// 旧行为：getter 被调用 2 次（两次 canonicalDigest），摘要不相等 ——
// 摘要不再是"内容的函数"。新行为：拒绝访问器，getter 一次都不执行。
test('DEF-02：canonicalize 不执行 getter，访问器对象一律 ContractError', () => {
  let calls = 0;
  const value = {
    get counter() {
      calls += 1;
      return calls;
    },
  };
  expectContractError(() => canonicalDigest(value), ERROR_CODES.ERR_INPUT_UNREADABLE);
  expectContractError(() => canonicalize(value), ERROR_CODES.ERR_INPUT_UNREADABLE);
  assert.equal(calls, 0, '访问器不得被执行，否则摘要会依赖调用顺序');
});

// 旧行为：原始 TypeError 直接穿透（`captured.message === 'hostile getter'`）。
test('DEF-02：getter 抛出的异常被转成 ContractError，原始 message 不逃出', () => {
  const value = {
    get bad() {
      throw new TypeError('hostile getter');
    },
  };
  const error = expectContractError(() => canonicalize(value), ERROR_CODES.ERR_INPUT_UNREADABLE);
  assert.equal(error.name, 'ContractError');
  assert.equal(error.path.includes('bad'), true, '错误里必须能定位到出问题的键');
});

// 旧行为：Proxy 的 ownKeys 陷阱抛出的 RangeError 原样穿透。
test('DEF-02：Proxy 陷阱异常被转成 ContractError', () => {
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new RangeError('hostile proxy');
    },
  });
  expectContractError(() => canonicalize(proxy), ERROR_CODES.ERR_INPUT_UNREADABLE);
});

// 旧行为：内存对象图没有深度计数，200 层照常规范化（4000 层则原生 RangeError）。
test('DEF-02：canonicalize 有深度上限，超限是 ERR_MAX_DEPTH_EXCEEDED 而不是栈溢出', () => {
  // 上限内的嵌套必须继续可用（不能为了修缺陷把正常对象也拒掉）。
  assert.equal(typeof canonicalize(nest(3)), 'string');
  expectContractError(() => canonicalize(nest(200)), ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED);
  expectContractError(() => canonicalSize(nest(200)), ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED);
});

// 数组分支同样不能靠 `map` / `hasOwnProperty` 去触发陷阱。
test('DEF-02：数组里的访问器与 Proxy 索引同样失败关闭', () => {
  const withAccessor = [1];
  Object.defineProperty(withAccessor, '0', {
    enumerable: true,
    configurable: true,
    get() {
      throw new TypeError('hostile index');
    },
  });
  expectContractError(() => canonicalize(withAccessor), ERROR_CODES.ERR_INPUT_UNREADABLE);

  const proxied = new Proxy([1, 2], {
    getOwnPropertyDescriptor() {
      throw new TypeError('hostile descriptor');
    },
  });
  expectContractError(() => canonicalize(proxied), ERROR_CODES.ERR_INPUT_UNREADABLE);
});

// 纯数据对象的行为必须完全不变，否则"修失败关闭"会顺手改掉摘要。
test('DEF-02：纯数据对象的规范化结果保持不变', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
});

// ------------------------------------------------------------------ DEF-12

// 旧行为：`new Proxy(new Uint8Array(...), {})` —— 连陷阱都没有 —— 抛
// `TypeError: Method get TypedArray.prototype.byteLength called on incompatible receiver`。
test('DEF-12：字节分支上的 Proxy 抛 ContractError 而不是原始 TypeError', () => {
  const plain = new Proxy(new Uint8Array([0x7b, 0x7d]), {});
  const evil = new Proxy(new Uint8Array([0x7b, 0x7d]), {
    get() {
      throw new TypeError('hostile byteLength');
    },
  });
  for (const source of [plain, evil]) {
    const error = expectContractError(
      () => parseStrictJson(source),
      ERROR_CODES.ERR_INPUT_UNREADABLE,
    );
    assert.equal(error.name, 'ContractError');
  }
});

// `instanceof` 本身会跑代理的 `getPrototypeOf` 陷阱：类型判断也必须落在合同边界内。
test('DEF-12：带 getPrototypeOf 陷阱的 Proxy 抛 ContractError 而不是原始 TypeError', () => {
  const proxy = new Proxy({}, {
    getPrototypeOf() {
      throw new TypeError('hostile getPrototypeOf');
    },
  });
  expectContractError(() => parseStrictJson(proxy), ERROR_CODES.ERR_INPUT_UNREADABLE);
});

// 旧行为：覆盖 byteLength 的 Uint8Array 子类同样抛原始 TypeError。
test('DEF-12：覆盖 byteLength 的 Uint8Array 子类抛 ContractError', () => {  class Hostile extends Uint8Array {
    get byteLength() {
      throw new TypeError('hostile subclass');
    }
  }
  expectContractError(
    () => parseStrictJson(new Hostile([0x7b, 0x7d])),
    ERROR_CODES.ERR_INPUT_UNREADABLE,
  );
});

// 旧行为：`normalizeOptions` 直接读 options 属性，带抛错 getter 的 options 把原始异常送出。
test('DEF-12：options 上的访问器不会被求值，抛错时转 ContractError', () => {
  let calls = 0;
  const options = {
    get maxDepth() {
      calls += 1;
      throw new TypeError('hostile options');
    },
  };
  expectContractError(() => parseStrictJson('{"a":1}', options), ERROR_CODES.ERR_INPUT_UNREADABLE);
  assert.equal(calls, 0, 'options 也必须按数据属性快照，不能执行 getter');
});

// 合法 options 的语义必须保持：上限只能收紧，非法值回落默认值。
test('DEF-12：合法 options 快照后语义不变', () => {
  assert.deepEqual(parseStrictJson('{"a":1}', { maxDepth: 2 }), { a: 1 });
  assert.deepEqual(parseStrictJson('{"a":1}', { maxDepth: '9' }), { a: 1 });
  expectContractError(
    () => parseStrictJson('{"a":{"b":{"c":1}}}', { maxDepth: 2 }),
    ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED,
  );
  expectContractError(() => parseStrictJson('{"a":1}', 'not-an-object'), ERROR_CODES.ERR_FIELD_TYPE);
});

// 非字节、非字符串的 source 必须仍然是明确的类型错误（不能被"快照失败"吞掉）。
test('DEF-12：非法 source 类型仍是 ERR_FIELD_TYPE', () => {
  for (const source of [42, true, null, { length: 1 }, [0x7b]]) {
    expectContractError(() => parseStrictJson(source), ERROR_CODES.ERR_FIELD_TYPE);
  }
});

// 第 2 轮独立审查发现的逃逸口：`allowControls` 走到了**类型判断之后**，
// `Array.prototype.filter` 会读 `length` 与下标，Proxy 的 get 陷阱仍能把原始
// TypeError 送出合同边界。修复前是 `TypeError: ... ac`、`code === undefined`。
test('DEF-12：options.allowControls 是毒数组时同样抛 ContractError', () => {
  const onIndex = new Proxy(['\t'], {
    get(target, key, receiver) {
      if (key === '0') throw new TypeError('hostile allowControls index');
      return Reflect.get(target, key, receiver);
    },
  });
  const onLength = new Proxy(['\t'], {
    get(target, key, receiver) {
      if (key === 'length') throw new TypeError('hostile allowControls length');
      return Reflect.get(target, key, receiver);
    },
  });
  for (const source of [onIndex, onLength]) {
    expectContractError(
      () => parseStrictJson('{"a":1}', { allowControls: source }),
      ERROR_CODES.ERR_INPUT_UNREADABLE,
    );
  }
  // 正常的 allowControls 语义必须保持不变：只放行 \t \n \r。
  assert.deepEqual(parseStrictJson('{"a":"x\\ty"}', { allowControls: ['\t'] }), { a: 'x\ty' });
  expectContractError(
    () => parseStrictJson('{"a":"x\\ny"}', { allowControls: ['\u001b'] }),
    ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
  );
});

// 毒数组的读取有长度上限（64），不会变成 DoS；超出的条目被忽略而不是被放行。
test('DEF-12：allowControls 的数组长度上限被钉住，超长数组不会拖死解析', () => {
  const long = Array.from({ length: 4096 }, () => '\u001b');
  long[0] = '\t';
  // 前 64 项里只有 \t 合法 → 放行 \t；\n 不在其中，仍然被拒。
  assert.deepEqual(parseStrictJson('{"a":"x\\ty"}', { allowControls: long }), { a: 'x\ty' });
  expectContractError(
    () => parseStrictJson('{"a":"x\\ny"}', { allowControls: long }),
    ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
  );
  // 只有第 70 项合法时，它已经超过上限 → 一个都不放行。
  const beyondCap = Array.from({ length: 128 }, () => '\u001b');
  beyondCap[70] = '\t';
  expectContractError(
    () => parseStrictJson('{"a":"x\\ty"}', { allowControls: beyondCap }),
    ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
  );

  // 边界精确到 64：下标 63 生效，下标 64 起被忽略。
  const atLast = Array.from({ length: 128 }, () => '\u001b');
  atLast[63] = '\t';
  assert.deepEqual(parseStrictJson('{"a":"x\\ty"}', { allowControls: atLast }), { a: 'x\ty' });

  const justBeyond = Array.from({ length: 128 }, () => '\u001b');
  justBeyond[64] = '\t';
  expectContractError(
    () => parseStrictJson('{"a":"x\\ty"}', { allowControls: justBeyond }),
    ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
  );
});
