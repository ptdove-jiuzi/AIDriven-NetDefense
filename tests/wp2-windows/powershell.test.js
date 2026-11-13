import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POWERSHELL_FLAGS,
  SCRIPT_PREAMBLE,
  WINDOWS_ERROR_CODES,
  classifyFailure,
  createPowerShellClient,
  escapePsLiteral,
  parseWindowsDate,
  psQuote,
  stripBom,
  toArray,
  toInteger,
  toText,
  wrapScript,
} from '../../packages/collectors/windows/index.js';import { createFakeRunner } from './helpers.js';

test('the interpreter invocation never uses a command shell and carries the script as one encoded argument', () => {
  // CL-5: `-Command -` (script on stdin) is truncated by Windows PowerShell 5.1 as soon as
  // the script contains a multi-line brace block, silently and with exit code 0. The script
  // therefore travels base64-encoded (UTF-16LE) in a single `-EncodedCommand` argument.
  assert.deepEqual([...POWERSHELL_FLAGS], [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
  ]);
  assert.equal(POWERSHELL_FLAGS.includes('-Command'), false, '-Command - is the truncated path');
  assert.match(SCRIPT_PREAMBLE, /\$ErrorActionPreference='Stop'/u);
  assert.match(SCRIPT_PREAMBLE, /\$ProgressPreference='SilentlyContinue'/u);
});

test('wrapScript prepends the preamble and never interpolates the body', () => {
  const body = "# aegis-source:demo\nWrite-Output 'x'";
  const wrapped = wrapScript(body);
  assert.ok(wrapped.startsWith(SCRIPT_PREAMBLE));
  assert.ok(wrapped.includes(body));
  assert.equal(wrapScript("$x = '$(calc)'").includes("$x = '$(calc)'"), true);
});

test('single quotes are doubled so a value cannot terminate a PowerShell literal', () => {
  assert.equal(escapePsLiteral("O'Brien"), "O''Brien");
  assert.equal(psQuote("'; Start-Process calc.exe; '"), "'''; Start-Process calc.exe; '''");
  assert.equal(psQuote('back`tick'), "'back`tick'");
});

test('ConvertTo-Json single-object output is normalized to an array', () => {
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(toArray([{ a: 1 }]), [{ a: 1 }]);
});

test('scalar coercion rejects values that would change identity silently', () => {
  assert.equal(toInteger(5), 5);
  assert.equal(toInteger(' 42 '), 42);
  assert.equal(toInteger('4.2'), null);
  assert.equal(toInteger(''), null);
  assert.equal(toText(''), null);
  assert.equal(toText(0), '0');
  assert.equal(toText(null), null);
});

test('Windows PowerShell and PowerShell 7 date shapes both parse', () => {
  const epoch = 1_700_000_000_000;
  assert.equal(parseWindowsDate(`/Date(${epoch})/`), epoch);
  assert.equal(parseWindowsDate(`/Date(${epoch}+0800)/`), epoch);
  assert.equal(parseWindowsDate('2023-11-14T22:13:20.0000000Z'), epoch);
  assert.equal(parseWindowsDate('not a date'), null);
  assert.equal(parseWindowsDate({}), null);
});

test('a byte-order mark is stripped before JSON parsing', () => {
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
});

test('failure classification prefers the actionable cause over the incidental wording', () => {
  const denied = classifyFailure({ ok: false, stderr: 'Get-WinEvent : Attempted to perform an unauthorized operation. Access is denied', code: 1 });
  assert.equal(denied.code, WINDOWS_ERROR_CODES.ACCESS_DENIED);
  assert.match(denied.remediation, /Event Log Readers/u);

  const channel = classifyFailure({ ok: false, stderr: 'The specified channel could not be found', code: 1 });
  assert.equal(channel.code, WINDOWS_ERROR_CODES.CHANNEL_NOT_FOUND);

  const empty = classifyFailure({ ok: false, stderr: 'No events were found that match the specified selection criteria.', code: 0 });
  assert.equal(empty.code, WINDOWS_ERROR_CODES.NO_EVENTS);

  const other = classifyFailure({ ok: false, stderr: 'something else', code: 2 });
  assert.equal(other.code, WINDOWS_ERROR_CODES.COMMAND_FAILED);
});

test('timeout and truncation outrank every text-based classification', () => {
  const timedOut = classifyFailure({ ok: false, stderr: 'Access is denied', timedOut: true, code: null });
  assert.equal(timedOut.code, WINDOWS_ERROR_CODES.TIMEOUT);

  const truncated = classifyFailure({ ok: false, stderr: 'Access is denied', truncated: true, code: null });
  assert.equal(truncated.code, WINDOWS_ERROR_CODES.OUTPUT_TRUNCATED);
});

test('a Chinese permission message is classified as access denied', () => {
  const denied = classifyFailure({ ok: false, stderr: 'Get-WinEvent : 拒绝访问。', code: 1, timedOut: false, truncated: false });
  assert.equal(denied.code, WINDOWS_ERROR_CODES.ACCESS_DENIED);
});

test('non-JSON stdout is a BAD_JSON failure rather than a silent empty result', async () => {
  const runner = createFakeRunner(() => ({ ok: true, code: 0, stdout: 'not json at all', stderr: '', durationMs: 1, timedOut: false, truncated: false }));
  const client = createPowerShellClient({ runner });

  await assert.rejects(
    () => client.runJson('# aegis-source:x'),
    (error) => error.code === WINDOWS_ERROR_CODES.BAD_JSON,
  );
});

test('empty stdout is an explicit EMPTY_OUTPUT failure, never "no new events"', async () => {
  // The old behaviour returned null here, and three sources (event log ×3, run keys,
  // scheduled tasks) reported `ok` with zero events for ten minutes (COLLECTOR-LIVE §4
  // CL-5). An interpreter that exits 0 without printing is a defect, not a quiet channel.
  const runner = createFakeRunner(() => ({ ok: true, code: 0, stdout: '  \r\n', stderr: '', durationMs: 1, timedOut: false, truncated: false }));
  const client = createPowerShellClient({ runner });

  await assert.rejects(
    () => client.runJson('# aegis-source:x'),
    (error) => error.code === WINDOWS_ERROR_CODES.EMPTY_OUTPUT,
  );
  await assert.rejects(
    () => client.runText('# aegis-source:x'),
    (error) => error.code === WINDOWS_ERROR_CODES.EMPTY_OUTPUT,
  );
});

test('the client sends the script encoded in argv and puts nothing on stdin', async () => {
  const runner = createFakeRunner(() => ({ ok: true, code: 0, stdout: '{"a":1}', stderr: '', durationMs: 1, timedOut: false, truncated: false }));
  const client = createPowerShellClient({ runner, executable: 'pwsh.exe' });

  await client.runJson('# aegis-source:demo');

  const call = runner.calls[0];
  assert.equal(call.executable, 'pwsh.exe');
  assert.deepEqual(call.args.slice(0, POWERSHELL_FLAGS.length), [...POWERSHELL_FLAGS]);
  assert.equal(call.args.length, POWERSHELL_FLAGS.length + 1, 'exactly one encoded script argument');
  assert.equal(call.stdin, undefined, 'the script must not travel on stdin any more');
  const decoded = Buffer.from(call.args[POWERSHELL_FLAGS.length], 'base64').toString('utf16le');
  assert.ok(decoded.includes('# aegis-source:demo'), 'the decoded argument is the whole wrapped script');
  assert.ok(decoded.includes("$ErrorActionPreference='Stop'"), 'the preamble travels with it');
  assert.equal(call.args.some((arg) => arg.includes('aegis-source')), false, 'no plaintext script in argv');
});

test('probe reports the classified error code instead of throwing', async () => {
  const runner = createFakeRunner(() => ({
    ok: false, code: 1, stdout: '', stderr: 'Access is denied', durationMs: 5, timedOut: false, truncated: false,
  }));
  const client = createPowerShellClient({ runner });
  const probe = await client.probe();

  assert.equal(probe.ok, false);
  assert.equal(probe.errorCode, WINDOWS_ERROR_CODES.ACCESS_DENIED);
});

test('an empty script is a programming error', async () => {
  const client = createPowerShellClient({ runner: createFakeRunner() });
  await assert.rejects(() => client.runText('   '), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
});
