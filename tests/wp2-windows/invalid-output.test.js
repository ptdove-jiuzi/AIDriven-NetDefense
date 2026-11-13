// author: PT-dove
// R3-005 回归：字面量 `null` / `{}` / `[]` 不能被当成"合法的 0 条"。
//
// 缺陷形态（`packages/collectors/windows/powershell.js:237-264` + `sources/run-keys.js`）：
// PowerShell 退出码 0 但 `ConvertTo-Json` 打出 `null`/`{}`（结果变量未赋值）或 `[]`
// （脚本没走形状分支）时，源仍报 `status: ok` / `records: 0`，与"真的 0 条"完全不可区分
// ——这正是 SEED-04"多源返回 0 却报 ok"的残留旁路。
//
// 修复后的判据：
// - 传输层（parseJsonOutput）：`null` 与空对象 `{}` 是退化输出 → INVALID_OUTPUT；
//   空数组 `[]` 仍合法，因为 table 源确实用 `[]` 表示零行（`ConvertTo-Json -InputObject @()`）。
// - 形状层（run-keys splitTable）：run-keys 脚本固定输出 `{values, deniedKeys}`，
//   所以 `null`/`[]`/`{}` 都是失败读取；合法的"0 条"是 `{values:[],deniedKeys:[]}`。
// 两边合起来才让"0 条"与"脚本没产出结构"可区分。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOWS_ERROR_CODES,
  createPowerShellClient,
  createRunKeysSource,
} from '../../packages/collectors/windows/index.js';

/** 假 runner：记录请求并返回预设 stdout，绝不执行任何命令。 */
function fakeRunner(stdout) {
  return {
    async run() {
      return {
        ok: true,
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    },
  };
}

for (const [label, stdout] of [
  ['JSON literal null', 'null'],
  ['JSON literal null with whitespace', '  null  '],
]) {
  test(`parseJsonOutput 拒绝退化输出：${label}`, async () => {
    const client = createPowerShellClient({ runner: fakeRunner(stdout) });
    await assert.rejects(
      () => client.runJson('# aegis-source:probe\nGet-Item'),
      (error) => {
        assert.equal(error.code, WINDOWS_ERROR_CODES.INVALID_OUTPUT);
        assert.equal(error.details.marker, 'probe');
        return true;
      },
    );
  });
}

test('parseJsonOutput 拒绝空对象 `{}`（脚本没有任何结果结构）', async () => {
  const client = createPowerShellClient({ runner: fakeRunner('{}') });
  await assert.rejects(
    () => client.runJson('# aegis-source:probe\nGet-Item'),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_OUTPUT,
  );
});

test('parseJsonOutput 仍接受空数组 `[]`：table 源的"真 0 行"就是它', async () => {
  const client = createPowerShellClient({ runner: fakeRunner('[]') });
  assert.deepEqual(await client.runJson('# aegis-source:processes\nGet-Process'), []);
});

function runKeysSourceReturning(value) {
  return createRunKeysSource({
    powershell: { runJson: async () => value },
    clock: () => 1_700_000_000_000,
  });
}

for (const [label, value] of [
  ['null', null],
  ['empty array', []],
  ['empty object', {}],
]) {
  test(`run-keys 把退化值 ${label} 当作失败读取，而不是"0 条却 ok"`, async () => {
    const source = runKeysSourceReturning(value);
    await assert.rejects(
      () => source.read(),
      (error) => error.code === WINDOWS_ERROR_CODES.INVALID_OUTPUT,
    );
  });
}

test('run-keys 的"真 0 条"仍是显式形状，且与退化值可区分', async () => {
  const source = runKeysSourceReturning({ values: [], deniedKeys: [] });
  const result = await source.read();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.records, []);
  assert.equal(result.stats.values, 0);
});
