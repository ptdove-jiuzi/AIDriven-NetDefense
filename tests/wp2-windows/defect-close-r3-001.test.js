/**
 * defect-close-r3-001.test.js — 回归守卫：Run/RunOnce 源必须**记录被拒的键**，不能把它当成"值被删了"。
 *
 * 背景（BUG-LEDGER R3-001）：
 * - 产品脚本里两个 `catch` 块（`Get-Item` 失败、`GetValueNames` 失败）曾经是裸 `catch { continue }`，
 *   ACL 变化看起来与"开机自启项被删除"完全一样 → 差分层发出伪造的 `removed` 记录（假阴性证据）。
 * - A2 于 2026-11-04 21:25:58 修了脚本（两个 catch 都 `$deniedKeys += $declaredKey`），
 *   但当时**没有一条用例真的去跑 PowerShell**：`tests/wp2-windows/run-keys.test.js` 只看脚本字符串。
 *   本文件补的正是这个缺口：真注册表路径 + 真 `powershell.exe` + 真 ACL 拒绝。
 *
 * 它抓的回退（attacker 请按这个打）：
 * 1. 修复行 = `packages/collectors/windows/sources/run-keys.js` 第 155 行与第 160 行
 *    `if (Test-AccessDenied $_.Exception) { $deniedKeys += $declaredKey }`；
 *    - 把它改回 `catch { continue }`（不再分类）→ 本文件第 1 组用例转红（deniedKeys 为空、status=ok）；
 *    - 把 `$declaredKey` 改成 `$k`（provider 形式 `HKCU:\…`）→ 第 2 组"记录的是声明形式"断言转红，
 *      且第 1 组的 `denials[0].path === 声明形式` 也转红。
 * 2. 变异证明用的副本路径由 `DEFECT_CLOSE_RUN_KEYS_MODULE` 指定（缺省=仓库真实文件）；
 *    该环境变量只用于"把修复行改坏再跑一遍"的取证，不影响本文件在正常门禁里的判定。
 *
 * 运行：node --test tests/wp2-windows/defect-close-r3-001.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCommandRunner, createPowerShellClient } from '../../packages/collectors/windows/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const RUN_KEYS_MODULE = process.env.DEFECT_CLOSE_RUN_KEYS_MODULE === undefined
  ? path.join(REPO_ROOT, 'packages', 'collectors', 'windows', 'sources', 'run-keys.js')
  : path.resolve(process.env.DEFECT_CLOSE_RUN_KEYS_MODULE);

// The module under test may be the repository file (default) or a mutated copy produced for
// the mutation proof. A copy is imported as ESM; it resolves its own relative imports to the
// real sibling modules, so only the script text under test differs.
const { buildRunKeysScript, createRunKeysSource } = await import(pathToFileURL(RUN_KEYS_MODULE).href);

const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

/** Run a PowerShell script through the real interpreter (base64 so no quoting layer). */
function runPowerShell(script, timeoutMs = 20_000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
  );
}

/**
 * Create a real registry key under HKCU and deny every account `ReadKey` on it.
 *
 * Denying `ReadKey` to `Everyone` is what an ACL tightening looks like on a real host: the
 * key still exists (so it is not "missing"), but the collector account cannot enumerate it.
 * The owner keeps `ChangePermissions`, so cleanup can put the ACL back and delete the key.
 */
function createDeniedKey(declaredKey) {
  const provider = declaredKey.replace(/^(HKLM|HKCU|HKU|HKCR)\\/u, '$1:\\');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$provider = '${provider.replaceAll("'", "''")}'`,
    '$sub = $provider -replace \'^HKCU:\\\\(.*)$\', \'$1\'',
    'New-Item -Path $provider -Force | Out-Null',
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(',
    '  $sub,',
    '  [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,',
    '  [System.Security.AccessControl.RegistryRights]::ChangePermissions)',
    '$acl = $key.GetAccessControl()',
    "$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')",
    "$rule = New-Object System.Security.AccessControl.RegistryAccessRule($everyone, 'ReadKey', 'Deny')",
    '$acl.AddAccessRule($rule)',
    '$key.SetAccessControl($acl)',
    '$key.Close()',
    "Write-Output 'DENY_APPLIED'",
  ].join('\n');
  return runPowerShell(script);
}

/** Remove the deny rule and delete the throwaway key. */
function removeDeniedKey(declaredKey) {
  const provider = declaredKey.replace(/^(HKLM|HKCU|HKU|HKCR)\\/u, '$1:\\');
  const script = [
    "$ErrorActionPreference='Stop'",
    `$provider = '${provider.replaceAll("'", "''")}'`,
    '$sub = $provider -replace \'^HKCU:\\\\(.*)$\', \'$1\'',
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(',
    '  $sub,',
    '  [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,',
    '  [System.Security.AccessControl.RegistryRights]::ChangePermissions)',
    '$acl = $key.GetAccessControl()',
    "$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')",
    "$rule = New-Object System.Security.AccessControl.RegistryAccessRule($everyone, 'ReadKey', 'Deny')",
    '$acl.RemoveAccessRuleAll($rule)',
    '$key.SetAccessControl($acl)',
    '$key.Close()',
    'Remove-Item -LiteralPath $provider -Recurse -Force',
    "Write-Output 'CLEANED'",
  ].join('\n');
  return runPowerShell(script);
}

/** A PowerShell client that always takes the script transport (never the native reader). */
function scriptTransportOnly(client) {
  return {
    nativeCapable: false,
    runJson: (script, options) => client.runJson(script, options),
  };
}

test('both catch blocks record the *declared* key form, not the provider form', () => {
  const declared = 'HKCU\\SOFTWARE\\AegisHarness\\DefectClose\\shape-check';
  const script = buildRunKeysScript([declared]);

  // The fix line, twice: one for Get-Item, one for GetValueNames.
  assert.equal(
    script.split('$deniedKeys += $declaredKey').length - 1,
    2,
    'both catch blocks must record the denied key',
  );
  // The provider form (`HKCU:\…`) is derived inside the loop for the registry call only; a
  // denial recorded from it would put a drive-qualified string into the payload/denials.
  assert.equal(
    /\$deniedKeys \+= \$k\b/u.test(script),
    false,
    'a denial must not be recorded in the provider form ($k)',
  );
  assert.equal(/catch \{ continue \}/u.test(script), false, 'a bare "catch { continue }" is exactly the bug');
});

test(
  'a real PowerShell read records the denied key and does not fabricate a removal',
  { skip: process.platform !== 'win32' ? 'the registry provider and powershell.exe need Windows' : false },
  async (t) => {
    const suffix = `${process.pid}-${Date.now().toString(36)}`;
    const declaredKey = `HKCU\\SOFTWARE\\AegisHarness\\DefectClose\\runkeys-${suffix}`;

    const setup = createDeniedKey(declaredKey);
    if (setup.status !== 0 || !String(setup.stdout).includes('DENY_APPLIED')) {
      // A guard that cannot build its own real fixture must fail loudly, never pass silently.
      assert.fail(`could not create the denied registry key: ${String(setup.stderr).trim() || `exit ${setup.status}`}`);
    }

    try {
      const runner = createCommandRunner({ timeoutMs: 30_000 });
      const client = createPowerShellClient({ runner, timeoutMs: 30_000 });
      const source = createRunKeysSource({
        powershell: scriptTransportOnly(client),
        keys: [declaredKey],
      });

      const result = await source.read();

      // 1. The refusal is visible, and it names the declared key.
      assert.deepEqual(
        result.denials.map((entry) => entry.path),
        [declaredKey],
        'the denied key must be reported in denials, in the declared (payload) form',
      );
      assert.equal(result.denials[0].outcome, 'permission_denied');
      assert.equal(result.stats.deniedKeys, 1, 'a denied key must be counted as denied');
      assert.equal(result.stats.missingKeys, 0, 'a denied key is not a missing key');

      // 2. The read must degrade instead of claiming to be healthy.
      assert.equal(result.status, 'partial', 'a partially blind read must not claim to be ok');
      assert.notEqual(result.degradedFields.length, 0, 'the unreadable fields must be declared');

      // 3. Nothing may be reported as removed: the script saw a refusal, not an empty key.
      assert.deepEqual(result.records, [], 'a denied key must not fabricate a removed record');
      assert.equal(
        result.records.some((record) => record.payload.present === false),
        false,
        'no record may claim the value is gone',
      );

      t.diagnostic(`denied key exercised through real powershell.exe: ${declaredKey}`);
    } finally {
      const cleanup = removeDeniedKey(declaredKey);
      assert.equal(
        cleanup.status,
        0,
        `the throwaway registry key could not be removed: ${String(cleanup.stderr).trim()}`,
      );
    }
  },
);
