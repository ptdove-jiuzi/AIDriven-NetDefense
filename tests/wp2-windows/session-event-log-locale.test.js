/**
 * Regression: an idle event channel on a non-English Windows failed every read.
 *
 * `Get-WinEvent` signals "the query matched nothing" by throwing. The read script's catch
 * matched the *English* message only (`no events were found`), so on a zh-CN host the
 * exception was re-thrown (`找不到与指定的选择条件匹配的事件。`, fully-qualified id
 * `NoMatchingEventsFound,…`) and the adapter turned a healthy idle channel into
 * `COMMAND_FAILED` on every poll — prof-collector `probe-once.json` recorded exactly that
 * for System and Application.
 *
 * These tests run the **real** interpreter, because the defect lives in the PowerShell
 * error record, not in the JavaScript. `Get-WinEvent` is stubbed inside the script so the
 * localized exception shape is reproduced on any host:
 *
 * 1. RED control: the pre-fix catch shape re-throws the same exception (that is the bug).
 * 2. GREEN: the generated script swallows it and reports an empty page.
 * 3. The fix must stay narrow: a denied channel is still re-thrown, never read as "empty".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NO_EVENTS_PREDICATE,
  WINDOWS_ERROR_CODES,
  buildReadScript,
  createCommandRunner,
  createPowerShellClient,
} from '../../packages/collectors/windows/index.js';

const WINDOWS = process.platform === 'win32';
const SKIP = WINDOWS ? false : 'the defect is in the PowerShell error record; Linux has no Get-WinEvent';

/** Stub `Get-WinEvent` so the read script sees a localized empty-page error. */
const EMPTY_PAGE_STUB = [
  'function Get-WinEvent {',
  '  [CmdletBinding()] param([string]$LogName, [int]$MaxEvents, [string]$FilterXPath)',
  "  $errorRecord = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new('找不到任何与指定的选择条件匹配的事件。'), 'NoMatchingEventsFound', [System.Management.Automation.ErrorCategory]::NotSpecified, $null)",
  '  throw $errorRecord',
  '}',
].join('\n');

/** Stub that throws the way a denied channel does (still localized). */
const DENIED_STUB = [
  'function Get-WinEvent {',
  '  [CmdletBinding()] param([string]$LogName, [int]$MaxEvents, [string]$FilterXPath)',
  "  throw [System.UnauthorizedAccessException]::new('尝试执行未经授权的操作。')",
  '}',
].join('\n');

/** The catch body the generator emitted before this fix: English message only. */
const OLD_CATCH_SCRIPT = [
  '# aegis-source:event-log-old',
  "$channel = 'System'",
  '$newest = [long]0',
  'try {',
  '  $probe = @(Get-WinEvent -LogName $channel -MaxEvents 1 -ErrorAction Stop)',
  '  if ($probe.Count -gt 0) { $newest = [long]$probe[0].RecordId }',
  '} catch {',
  '  if ($_.Exception.Message -notmatch "(?i)no events were found") { throw }',
  '}',
  'ConvertTo-Json -InputObject ([pscustomobject]@{ newestRecordId = $newest; events = @() }) -Compress',
].join('\n');

async function withClient(run) {
  const runner = createCommandRunner({ timeoutMs: 30_000 });
  const client = createPowerShellClient({ runner, timeoutMs: 30_000 });
  try {
    return await run(client);
  } finally {
    client.dispose();
  }
}

test('the generated script keys on the locale-invariant error id, not on English text', () => {
  const script = buildReadScript('System', 0);
  assert.match(script, /FullyQualifiedErrorId -match "\(\?i\)\^NoMatchingEventsFound"/u);
  assert.equal(
    script.includes('if ($_.Exception.Message -notmatch "(?i)no events were found") { throw }'),
    false,
    'the English-only catch must be gone, not merely supplemented',
  );
  // The predicate is exported so a reviewer can see exactly what is tolerated without
  // reverse-engineering a generated string.
  assert.match(NO_EVENTS_PREDICATE, /NoMatchingEventsFound/u);
  assert.match(NO_EVENTS_PREDICATE, /找不到与指定的选择条件匹配的事件/u);
});

test('the pre-fix catch shape fails on a zh-CN empty page (the reported defect)', { skip: SKIP }, async () => {
  await withClient(async (client) => {
    // RED: this is the behaviour before the fix, reproduced with the real interpreter. The
    // English-only catch re-throws, so the read never reaches the empty-page path.
    await assert.rejects(
      () => client.runJson(`${EMPTY_PAGE_STUB}\n${OLD_CATCH_SCRIPT}`),
      (error) => error instanceof Error,
      'the English-only catch must re-throw the localized empty-page exception',
    );
  });
});

test('the fixed script reports an empty page on a zh-CN host', { skip: SKIP }, async () => {
  await withClient(async (client) => {
    const page = await client.runJson(`${EMPTY_PAGE_STUB}\n${buildReadScript('System', 999_999)}`);
    assert.deepEqual(page, { newestRecordId: 0, events: [] });
  });
});

test('the fixed script also accepts the localized message when the error id is rewritten', { skip: SKIP }, async () => {
  const rewrittenStub = [
    'function Get-WinEvent {',
    '  [CmdletBinding()] param([string]$LogName, [int]$MaxEvents, [string]$FilterXPath)',
    "  $errorRecord = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new('找不到与指定的选择条件匹配的事件。'), 'SomeRewrittenId,Microsoft.PowerShell.Commands.GetWinEventCommand', [System.Management.Automation.ErrorCategory]::NotSpecified, $null)",
    '  throw $errorRecord',
    '}',
  ].join('\n');
  await withClient(async (client) => {
    const page = await client.runJson(`${rewrittenStub}\n${buildReadScript('System', 7)}`);
    assert.deepEqual(page, { newestRecordId: 0, events: [] });
  });
});

test('a denied channel is still an error, not an empty page', { skip: SKIP }, async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.runJson(`${DENIED_STUB}\n${buildReadScript('Security', 0)}`),
      (error) => error instanceof Error && error.code !== WINDOWS_ERROR_CODES.NO_EVENTS,
      'the fix must not widen "empty page" to "any exception"',
    );
  });
});
