/**
 * Regression: the Run/RunOnce source used to report a healthy empty read while the registry
 * keys held values (RUNTIME collector acceptance, run-b/run-c evidence).
 *
 * Root cause of the pre-fix behaviour: the generated script called
 *
 *   Get-Item -LiteralPath 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
 *
 * A bare `HKLM\...` string is a *filesystem* path, not a registry provider path; `Get-Item`
 * throws `ItemNotFoundException`, and the script's own `catch` only records
 * `UnauthorizedAccessException`/`SecurityException` as `deniedKeys`, so the failure was
 * silently treated as "this key does not exist". The source then published 0 rows and
 * reported `ok: true` — exactly the "0 条却 ok" shape A2-SHAPE §6 forbids.
 *
 * The fix derives the drive-qualified form (`HKLM:\...`) inside the loop while keeping the
 * declared form as the payload `key_path`. This file is the regression that fails on the
 * old script and passes on the new one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUN_KEY_PATHS,
  buildRunKeysScript,
  createCommandRunner,
  createPowerShellClient,
  createRunKeysSource,
} from '../../packages/collectors/windows/index.js';
import { createClock} from './helpers.js';

const HKLM_RUN = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const HKCU_RUN = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';

/** PowerShell that reports how many value names the provider sees for one key. */
function providerCountScript(key) {
  const drive = key.replace(/^([A-Za-z]+)\\/u, '$1:\\');
  return `$k = Get-Item -LiteralPath '${drive}' -ErrorAction Stop; [string]$k.GetValueNames().Count`;
}

test('the read script derives a drive-qualified registry path before Get-Item', () => {
  const script = buildRunKeysScript([HKLM_RUN]);
  // The declared form stays in `$targets`: it is the payload `key_path`, not a provider path.
  assert.equal(script.includes(`$targets = @('${HKLM_RUN}')`), true);
  // Without this translation `Get-Item` resolves the hive as a file path and throws
  // ItemNotFoundException, which the script used to swallow as "the key is missing".
  assert.match(script, /-replace '\^\(HKLM\|HKCU\|HKU\|HKCR\)/u);
  assert.match(script, /-LiteralPath \$k/u);
});

test('the declaration still keeps the bare hive form that the payload requires', () => {
  assert.equal(RUN_KEY_PATHS.some((key) => key.startsWith('HKLM\\')), true);
  assert.equal(RUN_KEY_PATHS.some((key) => key.startsWith('HKCU\\')), true);
  for (const key of RUN_KEY_PATHS) {
    assert.equal(key.includes(':\\'), false, `declared key must not carry a drive qualifier: ${key}`);
  }
  assert.equal(HKCU_RUN.includes(':\\'), false);
});

test(
  'a real read returns the values the registry provider sees (Windows only)',
  { skip: process.platform !== 'win32' ? 'registry provider test needs Windows' : false },
  async () => {
    const runner = createCommandRunner({ timeoutMs: 30_000 });
    const powershell = createPowerShellClient({ runner, timeoutMs: 30_000 });

    const expected = Number(await powershell.runText(providerCountScript(HKLM_RUN)));
    assert.equal(Number.isSafeInteger(expected), true);

    const source = createRunKeysSource({ powershell, clock: createClock(), keys: [HKLM_RUN] });
    const collected = await source.read({ cursor: null, generation: 0 });

    assert.equal(Array.isArray(collected.records), true);
    assert.equal(
      collected.records.length,
      expected,
      `the source read ${collected.records.length} row(s) but the provider reports ${expected} value(s)`,
    );
    for (const record of collected.records) {
      assert.equal(record.payload.key_path, HKLM_RUN, 'the payload must keep the declared key form');
      assert.equal(record.payload.hive, 'HKLM');
    }
  },
);
