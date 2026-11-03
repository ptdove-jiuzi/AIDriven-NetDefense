// author: PT-dove
/**
 * DEF-05 回归用例（M9 P2 修复）。
 *
 * 缺陷：plugin-manager 的 `parseStrictJson` 用 `Number(token)` 直接取值，
 * `9007199254740993` 被**静默取整**成 `9007199254740992`。第 1 轮独立审查验证了可达性：
 * 两份都合法的 manifest 只差 `configSchema.properties.n.minimum` 一个字面量，
 * `digestOf` 却给出同一个摘要 —— "批准一个、运行另一个"成立，不只是理论问题。
 *
 * 同一缺陷的第二半：字符串检查只覆盖 C0 + DEL，`\u0080`-`\u009f` 被放行，
 * 而 contracts 的 `assertText` 会拒绝它们；`configSchema` 里的字符串根本不查。
 *
 * 修复后：
 * - 整数 token 必须"字面量 == 双精度值"（与 contracts `parseIntegerToken` 对齐）；
 * - 控制符检查补上 `\u007f`-`\u009f`；
 * - `configSchema` 里任何位置的字符串（含键名）都不允许控制符。
 *
 * 修复前这些用例会红：`parseStrictJson` 返回 9007199254740992 而不是抛错，
 * 带 `\u0085` 的 name 得到 `manifest !== null`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ERROR_CODES,
  PluginCheckError,
  parseStrictJson,
  validatePluginJson,
} from '../../apps/plugin-manager/src/index.js';

import { checkManifest, manifestFixture } from './helpers.js';

/** 断言解析失败并返回错误码。 */
function expectJsonError(text, label) {
  let captured = null;
  try {
    parseStrictJson(text, { label });
  } catch (error) {
    captured = error;
  }
  assert.notEqual(captured, null, `${label}: the literal must be rejected`);
  assert.ok(
    captured instanceof PluginCheckError,
    `${label}: expected PluginCheckError, got ${captured?.constructor?.name}`,
  );
  assert.equal(captured.code, ERROR_CODES.INVALID_JSON, `${label}: unexpected code`);
  return captured;
}

function reject(raw, code, label) {
  const result = checkManifest(raw, validatePluginJson);
  assert.equal(result.manifest, null, `${label}: the manifest must be rejected`);
  assert.ok(
    result.codes.includes(code),
    `${label}: expected ${code}, received ${JSON.stringify(result.codes)}`,
  );
  return result;
}

// --------------------------------------------------------------- 数值精度

test('DEF-05：不可精确表示的超安全整数被拒绝，而不是静默取整', () => {
  // 旧行为：返回 9007199254740992（与 9007199254740993 撞值）。
  expectJsonError('9007199254740993', 'MAX_SAFE_INTEGER + 2');
  expectJsonError('-9007199254740993', 'negative MAX_SAFE_INTEGER - 2');
  expectJsonError('{"n":9007199254740993}', 'nested literal');
  expectJsonError('9007199254740992', 'MAX_SAFE_INTEGER + 1');

  // 边界内的值必须继续可用，否则"修精度"会变成"拒绝一切大整数"。
  assert.equal(parseStrictJson('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseStrictJson('-9007199254740991'), -Number.MAX_SAFE_INTEGER);
  assert.equal(parseStrictJson('{"n":-1}').n, -1);
  // 浮点路径不在本条缺陷范围内（DEF-01 单独登记），行为保持不变。
  assert.equal(parseStrictJson('1.5'), 1.5);
  assert.equal(parseStrictJson('1e3'), 1000);
});

test('DEF-05：摘要碰撞的可达路径被切断（同一份文本不能再解析成两个数）', () => {
  // 审查给的可达性论证：两份 manifest 只差一个 minimum 字面量，digestOf 却相同。
  const base = {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 0 } },
    required: [],
    additionalProperties: false,
  };
  const textFor = (literal) => JSON.stringify({
    schemaVersion: '1.0',
    configSchema: {
      ...base,
      properties: { n: { type: 'integer', minimum: literal } },
    },
  }).replace('"minimum":0', `"minimum":${literal}`);

  // 0 是可精确表示的，必须能解析。
  assert.equal(parseStrictJson(textFor(0)).configSchema.properties.n.minimum, 0);
  // 9007199254740993 一旦被接受，就会与 9007199254740992 得到同一个摘要。
  expectJsonError(textFor(9007199254740993), 'minimum literal that would collide');
});

// ------------------------------------------------------------ 控制符（含 C1）

test('DEF-05：name / description / prompt 里的 DEL 与 C1 被拒绝', () => {
  for (const control of ['\u007f', '\u0080', '\u0085', '\u009f']) {
    reject(
      manifestFixture({ name: `Anomaly${control}Notes` }),
      ERROR_CODES.INVALID_VALUE,
      `name with U+${control.codePointAt(0).toString(16)}`,
    );
    reject(
      manifestFixture({ description: `desc${control}ription` }),
      ERROR_CODES.INVALID_VALUE,
      `description with U+${control.codePointAt(0).toString(16)}`,
    );
    reject(
      manifestFixture({
        prompt: { role: 'user', position: 'analysis-context', text: `text${control}more` },
      }),
      ERROR_CODES.PROMPT_INVALID,
      `prompt.text with U+${control.codePointAt(0).toString(16)}`,
    );
  }
});

test('DEF-05：configSchema 里任何字符串（含键名）都不允许控制符', () => {
  const withControlInEnum = manifestFixture({
    configSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'slow\u0085'] },
      },
      required: [],
      additionalProperties: false,
    },
  });
  const result = reject(withControlInEnum, ERROR_CODES.SCHEMA_VIOLATION, 'enum value');
  assert.match(
    result.diagnostics.map((item) => item.path).join(' '),
    /\/configSchema\/properties\/mode\/enum\/1/u,
    'the diagnostic points at the offending string',
  );

  reject(
    manifestFixture({
      configSchema: {
        type: 'object',
        properties: { 'weird\u007fkey': { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
    }),
    ERROR_CODES.SCHEMA_VIOLATION,
    'property name',
  );
});

test('DEF-05：可打印字符串仍然被接受（修复没有把正常描述一起拒掉）', () => {
  const result = checkManifest(
    manifestFixture({
      name: 'Anomaly Notes',
      description: 'Summarizes authorized DTO · 中文说明 · emoji 🛡',
      configSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['fast', 'slow'], title: 'Mode' },
          retries: { type: 'integer', minimum: 0, maximum: 10 },
        },
        required: [],
        additionalProperties: false,
      },
    }),
    validatePluginJson,
  );
  assert.deepEqual(result.codes, []);
  assert.notEqual(result.manifest, null);
});
