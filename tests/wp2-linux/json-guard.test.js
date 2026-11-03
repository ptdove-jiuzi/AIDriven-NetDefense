/**
 * DEF-07 回归用例（M9 P3 修复）—— journald 侧的重复键。
 *
 * 缺陷：`parseJournaldOutput` 用 `JSON.parse` 解析 journalctl 的 JSON 流，
 * `{"__CURSOR":"s=abc","__CURSOR":"s=evil"}` 会被静默解释成 last-wins，
 * 而 contracts 的 `parseStrictJson` 与 plugin-manager 的解析器都拒绝重复键。
 * 同一份 JSON 文本在不同组件里得到不同解释。
 *
 * 修复后的契约：重复键（含转义等价键）整行拒收，计入 `malformed`；
 * 其余语义不变——尤其**不**把 `parseStrictJson` 的其余限制搬进来，
 * 否则带 ESC 的日志原文会整条消失（DEF-03 的攻击面）。
 *
 * 修复前这些用例必然变红：重复键那几条会得到 `entries.length === 1` 且游标是 last-wins 的值。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJournaldSource,
  createScriptedCommandRunner,
  findDuplicateJsonKey,
  parseJournaldOutput,
} from '../../packages/collectors/linux/index.js';
import { parseStrictJson } from '../../packages/contracts/src/index.js';

test('DEF-07：journald 的重复键被拒收，不再 last-wins', () => {
  const parsed = parseJournaldOutput('{"__CURSOR":"s=abc","__CURSOR":"s=evil","MESSAGE":"x"}');

  assert.equal(parsed.entries.length, 0, 'a duplicate-key line must not produce an entry');
  assert.equal(parsed.malformed, 1);
  assert.equal(parsed.withoutCursor, 0);
});

test('DEF-07：转义等价的重复键同样被拒收', () => {
  // `\u005f` 是 `_`：JSON.parse 认为这两个键是同一个（last-wins），
  // 只看原始文本的检查会漏掉它。
  const parsed = parseJournaldOutput(
    '{"__CURSOR":"s=abc","\\u005f\\u005fCURSOR":"s=evil","MESSAGE":"x"}',
  );
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.malformed, 1);
});

test('DEF-07：嵌套层里的重复键也被拒收', () => {
  const parsed = parseJournaldOutput('{"__CURSOR":"s=a","MESSAGE":{"a":1,"a":2}}');
  assert.equal(parsed.entries.length, 0);
  assert.equal(parsed.malformed, 1);
});

test('DEF-07：不同对象里的同名键不是重复，合法批次照常解析', () => {
  const parsed = parseJournaldOutput([
    '{"__CURSOR":"s=a","MESSAGE":"ok","NESTED":{"a":1},"OTHER":{"a":2}}',
    '{"__CURSOR":"s=b","MESSAGE":"second","LIST":[{"a":1},{"a":2}]}',
  ].join('\n'));

  assert.equal(parsed.malformed, 0);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].cursor, 's=a');
  assert.equal(parsed.entries[1].cursor, 's=b');
});

test('DEF-07：带控制符的日志原文仍然被接受（没有把严格解析器整体搬进来）', () => {
  // 这一条是修复边界的护栏：如果实现改成 `parseStrictJson`，ESC / NUL 会让整行消失，
  // 那就是 DEF-03 记录的攻击面（写日志的一方用一行 ESC 删掉自己的记录）。
  const message = 'ESC[31mfailed password for rootESC[0m';
  const line = JSON.stringify({ __CURSOR: 's=esc', MESSAGE: message, PRIORITY: '4' });
  const parsed = parseJournaldOutput(line);

  assert.equal(parsed.malformed, 0, 'a control character in MESSAGE must not reject the line');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].cursor, 's=esc');

  // 转义形式（\u001b）与原文等价，同样必须被接受。
  const escaped = '{"__CURSOR":"s=esc2","MESSAGE":"\\u001b[31mred\\u001b[0m"}';
  const parsedEscaped = parseJournaldOutput(escaped);
  assert.equal(parsedEscaped.malformed, 0);
  assert.equal(parsedEscaped.entries.length, 1);
});

test('DEF-07：语法错误仍然计入 malformed，批次不被丢弃', () => {
  const parsed = parseJournaldOutput([
    '{"__CURSOR":"s=ok","MESSAGE":"fine"}',
    'not json at all',
    '{"__CURSOR": "truncated',
  ].join('\n'));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.malformed, 2);
});

test('DEF-07：与 contracts 的重复键规则逐条一致（同一张样本表）', () => {
  // 交叉验证，防止两套实现悄悄分叉：本模块判"有重复键"的样本，
  // `parseStrictJson` 必须也报 ERR_DUPLICATE_KEY；反之亦然。
  const samples = [
    ['{"a":1,"a":2}', true],
    ['{"a":1,"b":2}', false],
    ['{"a":{"a":1}}', false],
    ['{"a":1,"\\u0061":2}', true],
    ['{"\\u00e9":1,"é":2}', true],
    ['[{"a":1},{"a":2}]', false],
    ['{"a":[1,2],"b":{"c":1,"c":2}}', true],
    ['"just a string"', false],
    ['{"a":1,"b":{"c":2},"d":3}', false],
    ['{"a":1,"b":2,"a":3}', true],
  ];

  for (const [text, expected] of samples) {
    const guard = findDuplicateJsonKey(text) !== null;
    let contractRejects = false;
    try {
      parseStrictJson(text);
    } catch (error) {
      contractRejects = error.code === 'ERR_DUPLICATE_KEY';
      assert.equal(
        error.code === 'ERR_DUPLICATE_KEY' || !guard,
        true,
        `${text}: the guard reported a duplicate but contracts reported ${error.code}`,
      );
    }
    assert.equal(guard, expected, `${text}: guard verdict`);
    assert.equal(contractRejects, expected, `${text}: contracts verdict`);
  }
});

test('DEF-07：扫描器对不合法文本不抢 JSON.parse 的职责', () => {
  // 未闭合字符串 / 非法转义：返回 null（由调用方的 JSON.parse 报语法错误）。
  assert.equal(findDuplicateJsonKey('{"a":"unterminated'), null);
  assert.equal(findDuplicateJsonKey('{"a":1,"\\q":2}'), null);
  assert.equal(findDuplicateJsonKey(''), null);
  assert.equal(findDuplicateJsonKey(undefined), null);
});

/**
 * DEF-07 的状态机面：重复键行被拒收之后，整页读结果会从 `ok` 变成 `partial`。
 *
 * 这条不是"顺手多测一点"：`parseJournaldOutput` 的 `malformed` 计数直接决定
 * `read()` 的 `status`（`journald.js` 里 `parsed.malformed > 0 … ? 'partial' : 'ok'`），
 * 而上游源健康判定看的就是 `status`。只钉 `malformed` 不钉 `status`，会让"状态机
 * 被改动"这件事在门禁里不可见。
 */
test('DEF-07：重复键行让整页读结果变成 partial，而不是静默 ok', async () => {
  const clean = JSON.stringify({
    __CURSOR: 's=abc;i=1',
    __REALTIME_TIMESTAMP: '1700000000000000',
    PRIORITY: '6',
    SYSLOG_IDENTIFIER: 'sshd',
    MESSAGE: 'accepted publickey',
  });
  const duplicate = '{"__CURSOR":"s=abc;i=1","__CURSOR":"s=evil;i=2","MESSAGE":"x"}';
  const runner = createScriptedCommandRunner([{ stdout: `${clean}\n${duplicate}\n` }]);
  const result = await createJournaldSource({ runner, clock: () => 1_700_000_000_000 }).read();

  assert.equal(result.records.length, 1, 'the duplicate-key line must not become a record');
  assert.equal(result.stats.malformed, 1);
  assert.equal(result.status, 'partial');
  // 对照：没有重复键的那一页仍然是 ok（拒绝的是重复键，不是"所有页面"）。
  const cleanRunner = createScriptedCommandRunner([{ stdout: `${clean}\n` }]);
  const cleanResult = await createJournaldSource({ runner: cleanRunner, clock: () => 1_700_000_000_000 }).read();
  assert.equal(cleanResult.status, 'ok');
  assert.equal(cleanResult.stats.malformed, 0);
});
