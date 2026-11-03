// author: PT-dove
// M9 对抗语料 —— contracts 严格 JSON 解析器。
//
// 目标：证明 `parseStrictJson` 对重复键、深嵌套、超大数字、孤立代理项、控制字符和
// 非字符串输入一律**失败关闭**，并且失败方式是带错误码的 `ContractError`
// 而不是栈溢出、TypeError 或静默截断。
//
// 每条拒绝用例都配一条"对照组"断言（`JSON.parse` 会接受同一份文本），
// 否则"拒绝了"可能只是因为输入根本就是坏的语法，测试就永远为真。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractError,
  ERROR_CODES,
  LIMITS,
  parseStrictJson,
} from '../../packages/contracts/src/index.js';
import {
  STRICT_JSON_ACCEPTANCES,
  STRICT_JSON_OPTION_ATTEMPTS,
  STRICT_JSON_REJECTIONS,
} from './support/corpus.js';
import { expectRejection } from './support/harness.js';

const KNOWN_CODES = new Set(Object.values(ERROR_CODES));

test('语料表本身是自洽的：id 唯一、错误码来自 ERROR_CODES', () => {
  const ids = new Set();
  for (const entry of [...STRICT_JSON_REJECTIONS, ...STRICT_JSON_ACCEPTANCES]) {
    assert.ok(entry.id.length > 0, 'every case needs an id');
    assert.equal(ids.has(entry.id), false, `duplicate corpus id ${entry.id}`);
    ids.add(entry.id);
    assert.equal(typeof entry.json, 'string', `${entry.id} must carry the JSON text`);
  }
  for (const entry of STRICT_JSON_REJECTIONS) {
    assert.ok(KNOWN_CODES.has(entry.code), `${entry.id} uses unknown code ${entry.code}`);
    assert.ok(entry.note.length > 0, `${entry.id} must explain why the input is hostile`);
  }
  assert.ok(STRICT_JSON_REJECTIONS.length >= 45, 'the rejection corpus must not silently shrink');
  assert.ok(STRICT_JSON_ACCEPTANCES.length >= 10, 'the acceptance corpus must not silently shrink');
});

for (const entry of STRICT_JSON_REJECTIONS) {
  test(`拒绝：${entry.id}（${entry.note}）`, () => {
    const error = expectRejection(() => parseStrictJson(entry.json), {
      code: entry.code,
      type: ContractError,
      label: entry.id,
    });
    // 错误必须带路径，否则调用方无法定位是哪一段输入被拒。
    assert.equal(typeof error.path, 'string', `${entry.id}: error.path must be a string`);
    assert.ok(error.path.length > 0, `${entry.id}: error.path must not be empty`);
  });
}

for (const entry of STRICT_JSON_ACCEPTANCES) {
  test(`接受：${entry.id}`, () => {
    const parsed = parseStrictJson(entry.json);
    assert.deepEqual(parsed, entry.expect, `${entry.id} parsed value`);
  });
}

test('对照：JSON.parse 会静默接受重复键，所以"拒绝"不是语法问题', () => {
  const text = '{"a":1,"a":2}';
  assert.deepEqual(JSON.parse(text), { a: 2 }, 'JSON.parse keeps the last duplicate');
  expectRejection(() => parseStrictJson(text), { code: ERROR_CODES.ERR_DUPLICATE_KEY, type: ContractError });
});

test('对照：JSON.parse 会把 2^53+1 截断成 2^53，严格解析器必须拒绝', () => {
  const text = '{"a":9007199254740993}';
  assert.equal(JSON.parse(text).a, 9007199254740992, 'JSON.parse silently loses the low bit');
  expectRejection(() => parseStrictJson(text), {
    code: ERROR_CODES.ERR_NUMBER_PRECISION_LOSS,
    type: ContractError,
  });
});

test('对照：JSON.parse 看不见孤立代理项，严格解析器必须拒绝', () => {
  const text = '{"a":"\\ud800"}';
  assert.equal(JSON.parse(text).a.length, 1, 'JSON.parse produces a lone surrogate');
  expectRejection(() => parseStrictJson(text), {
    code: ERROR_CODES.ERR_UNPAIRED_SURROGATE,
    type: ContractError,
  });
});

test('深嵌套以错误码失败，而不是 RangeError: Maximum call stack size exceeded', () => {
  const depth = 20000;
  const text = `${'['.repeat(depth)}${']'.repeat(depth)}`;
  let captured = null;
  try {
    parseStrictJson(text);
  } catch (error) {
    captured = error;
  }
  assert.notEqual(captured, null, 'deep nesting must not be accepted');
  assert.equal(
    captured instanceof RangeError,
    false,
    'deep nesting must be rejected by the depth limit, not by exhausting the JS stack',
  );
  assert.equal(captured.code, ERROR_CODES.ERR_MAX_DEPTH_EXCEEDED);
});

test('深嵌套之后解析器仍可复用（没有残留的模块级状态）', () => {
  const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
  assert.throws(() => parseStrictJson(deep));
  assert.deepEqual(parseStrictJson('{"a":1}'), { a: 1 });
});

for (const entry of STRICT_JSON_OPTION_ATTEMPTS) {
  test(`选项不能放宽硬上限：${entry.id}（${entry.note}）`, () => {
    let captured = null;
    try {
      parseStrictJson(entry.json, entry.options);
    } catch (error) {
      captured = error;
    }
    assert.notEqual(captured, null, `${entry.id}: a caller supplied limit must not disable the global ceiling`);
    assert.equal(captured instanceof ContractError, true, `${entry.id}: expected ContractError`);
  });
}

test('合法输入在收紧选项后仍然可解析（收紧不等于坏掉）', () => {
  assert.deepEqual(parseStrictJson('{"a":1}', { maxDepth: 2 }), { a: 1 });
  assert.deepEqual(parseStrictJson('{"a":"x"}', { maxObjectKeys: 8 }), { a: 'x' });
});

test('source 只接受 string / Uint8Array，含 getter 的对象一律拒绝', () => {
  const hostile = {
    get length() {
      throw new Error('getter must never run');
    },
  };
  expectRejection(() => parseStrictJson(hostile), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });

  class FakeSource {
    toString() {
      return '{"a":1}';
    }
  }
  expectRejection(() => parseStrictJson(new FakeSource()), {
    code: ERROR_CODES.ERR_FIELD_TYPE,
    type: ContractError,
  });
  expectRejection(() => parseStrictJson(new Date(0)), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
  expectRejection(() => parseStrictJson([123]), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
});

test('Proxy 作为 source 不会被解引用：按"不是字节"拒绝', () => {
  const proxy = new Proxy({}, {});
  expectRejection(() => parseStrictJson(proxy), { code: ERROR_CODES.ERR_FIELD_TYPE, type: ContractError });
});

test('★ 缺陷 DEF-12（修复后）：恶意 source / options 一律归为 ContractError', () => {
  // 修复前：`decodeSource` 读 `source.byteLength`、`normalizeOptions` 直接读 options 的属性，
  // 访问器/陷阱可以把任意异常送出来（`code === undefined`，调用方无法归类）。
  // 修复后：source 与 options 先快照成自有数据，读不出来统一报 ERR_INPUT_UNREADABLE。
  const cases = [
    {
      label: 'proxy of bytes without traps',
      call: () => parseStrictJson(new Proxy(new Uint8Array([0x7b, 0x7d]), {})),
    },
    {
      label: 'proxy of bytes with a throwing byteLength',
      call: () => parseStrictJson(new Proxy(new Uint8Array([0x7b, 0x7d]), {
        get() {
          throw new TypeError('hostile byteLength');
        },
      })),
    },
    {
      label: 'Uint8Array subclass overriding byteLength',
      call: () => {
        class Hostile extends Uint8Array {
          get byteLength() {
            throw new TypeError('hostile subclass');
          }
        }
        return parseStrictJson(new Hostile([0x7b, 0x7d]));
      },
    },
    {
      label: 'options with a throwing maxDepth getter',
      call: () => parseStrictJson('{"a":1}', {
        get maxDepth() {
          throw new TypeError('hostile options');
        },
      }),
    },
  ];

  for (const entry of cases) {
    // 必须既"失败关闭"又"错误类型在合同里"：只断 throws 会让原始 TypeError 也算通过。
    const captured = expectRejection(entry.call, {
      code: ERROR_CODES.ERR_INPUT_UNREADABLE,
      type: ContractError,
      label: entry.label,
    });
    assert.ok(KNOWN_CODES.has(captured.code), `${entry.label}: ${captured.code} must be a documented code`);
  }
});

test('对照：合法的 Uint8Array 子类实例照常解析（上一条不是"一律拒绝"）', () => {
  class Plain extends Uint8Array {}
  assert.deepEqual(parseStrictJson(new Plain(Buffer.from('{"a":1}', 'utf8'))), { a: 1 });
});

test('Buffer 是 Uint8Array 的子类，合法 UTF-8 字节可解析', () => {
  const bytes = Buffer.from('{"a":"可疑进程"}', 'utf8');
  assert.deepEqual(parseStrictJson(bytes), { a: '可疑进程' });
});

test('非法 UTF-8 字节序列被拒绝（不做替换字符降级）', () => {
  // 0xC3 0x28 是经典的"看起来像两字节序列但不是"的畸形组合。
  const bytes = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
  expectRejection(() => parseStrictJson(bytes), {
    code: ERROR_CODES.ERR_ENCODING_NOT_UTF8,
    type: ContractError,
  });
});

test('UTF-8 BOM 字节被拒绝（不是静默剥掉）', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', 'utf8')]);
  expectRejection(() => parseStrictJson(bytes), {
    code: ERROR_CODES.ERR_ENCODING_NOT_UTF8,
    type: ContractError,
  });
});

test('超过 maxMessageBytes 的输入在解码之前就被拒绝', () => {
  const bytes = new Uint8Array(LIMITS.maxMessageBytes + 1);
  bytes.fill(0x20);
  expectRejection(() => parseStrictJson(bytes), {
    code: ERROR_CODES.ERR_INPUT_TOO_LARGE,
    type: ContractError,
  });
});

test('allowControls:true 只等于 \\t \\n \\r，不放行 ESC', () => {
  assert.deepEqual(parseStrictJson('{"a":"x\\ty\\nz\\rw"}', { allowControls: true }), { a: 'x\ty\nz\rw' });
  expectRejection(() => parseStrictJson('{"a":"x\\u001by"}', { allowControls: true }), {
    code: ERROR_CODES.ERR_STRING_CONTROL_CHARACTER,
    type: ContractError,
  });
});

test('解析 __proto__ / constructor 之后 Object.prototype 未被污染', () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort().join(',');
  for (const entry of STRICT_JSON_REJECTIONS) {
    if (entry.group !== 'forbidden-key') continue;
    try {
      parseStrictJson(entry.json);
    } catch {
      // 期望抛错，这里只关心副作用。
    }
  }
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(','), before);
  assert.equal({}.polluted, undefined, 'Object.prototype must stay clean');
  assert.equal({}.x, undefined);
});

test('解析出的对象没有可枚举之外的隐藏键（规范化时不会丢内容）', () => {
  const parsed = parseStrictJson('{"a":1,"b":[1,2]}');
  assert.deepEqual(Object.getOwnPropertyNames(parsed).sort(), ['a', 'b']);
  for (const key of Object.getOwnPropertyNames(parsed)) {
    assert.equal(Object.prototype.propertyIsEnumerable.call(parsed, key), true, `${key} must be enumerable`);
  }
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
});

test('同一份文本解析两次得到结构完全相同的对象（确定性）', () => {
  const text = '{"b":[1,2,3],"a":{"z":true,"y":null}}';
  assert.deepEqual(parseStrictJson(text), parseStrictJson(text));
  assert.equal(JSON.stringify(parseStrictJson(text)), JSON.stringify(parseStrictJson(text)));
});

test('数字 token 的下溢被拒绝（DEF-01 已修复，不再是静默归一化为 0）', () => {
  // 历史行为：1e-400 / -1e-400 / 0 解析成同一个值（静默归一），这里曾经钉的是那个现状。
  // DEF-01 修复后改为失败关闭：下溢报 ERR_NUMBER_PRECISION_LOSS，路径指向具体字段。
  // 本断言钉住修复后的行为——实现一旦回退到"静默归一"，它会立刻变红。
  for (const literal of ['1e-400', '-1e-400', '4.9e-400', '1e-9999']) {
    const error = expectRejection(() => parseStrictJson(`{"a":${literal}}`), {
      code: 'ERR_NUMBER_PRECISION_LOSS',
      type: ContractError,
      pathIncludes: '$.a',
      label: `parseStrictJson(${literal})`,
    });
    assert.ok(KNOWN_CODES.has(error.code), 'the error code must belong to ERROR_CODES');
  }

  // 对照组：拒绝只针对"真的丢了精度"，不是把所有小数一律毙掉。
  assert.equal(parseStrictJson('{"a":0}').a, 0);
  assert.equal(parseStrictJson('{"a":1.5}').a, 1.5);
  assert.equal(parseStrictJson('{"a":1e3}').a, 1000);
  // 次正规数仍有非零表示，不构成精度丢失，必须照常接受。
  assert.equal(parseStrictJson('{"a":1e-320}').a, 1e-320);
});
