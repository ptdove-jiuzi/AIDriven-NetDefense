/**
 * CL-5: the PowerShell invocation must survive a multi-line brace block.
 *
 * Windows PowerShell 5.1 silently truncates a script fed through `-Command -` (stdin) as
 * soon as it contains a multi-line `{}` block: everything after the block never runs, with
 * exit code 0 and empty stderr. Three sources (event log ×3, run keys, scheduled tasks)
 * therefore returned zero rows while reporting `ok` (COLLECTOR-LIVE §4 CL-5).
 *
 * The fix is `-EncodedCommand`: the whole script travels base64 (UTF-16LE) in one argument,
 * decoded before execution, so a block cannot cut it short. This file proves the encoding
 * is lossless for exactly the shape that used to break, and that an empty stdout is now an
 * explicit failure instead of "no new events".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_ENCODED_COMMAND_CHARS,
  POWERSHELL_FLAGS,
  WINDOWS_ERROR_CODES,
  createPowerShellClient,
  encodeCommand,
  wrapScript,
} from '../../packages/collectors/windows/index.js';
import { createFakeRunner } from './helpers.js';

/** The shape that used to be truncated: statements before, inside and after a block. */
const MULTILINE_BLOCK_SCRIPT = [
  '# aegis-source:event-log',
  "Write-Output 'before'",
  'try {',
  "  Write-Output 'inside'",
  '} catch {',
  "  Write-Output 'caught'",
  '}',
  "Write-Output 'after'",
].join('\n');

function decode(argument) {
  return Buffer.from(argument, 'base64').toString('utf16le');
}

test('the script carrying a multi-line block survives the encoding intact', () => {
  const encoded = encodeCommand(MULTILINE_BLOCK_SCRIPT);
  const decoded = decode(encoded);
  assert.equal(decoded, wrapScript(MULTILINE_BLOCK_SCRIPT));
  // Every statement is present, including the ones *after* the block — those are exactly
  // what PowerShell 5.1 dropped on the stdin path.
  assert.ok(decoded.includes("Write-Output 'before'"));
  assert.ok(decoded.includes("Write-Output 'inside'"));
  assert.ok(decoded.includes("Write-Output 'after'"));
  assert.ok(decoded.trimEnd().endsWith("Write-Output 'after'"));
});

test('base64 is UTF-16LE, which is what -EncodedCommand decodes', () => {
  const encoded = encodeCommand("# aegis-source:x\nWrite-Output '中文'");
  const decoded = decode(encoded);
  assert.ok(decoded.includes("Write-Output '中文'"), 'non-ASCII must round-trip');
  assert.equal(/[^A-Za-z0-9+/=]/u.test(encoded), false, 'the argument is plain base64');
});

test('the invocation never puts the plaintext script in argv and never uses stdin', async () => {
  const runner = createFakeRunner(() => ({ ok: true, code: 0, stdout: '{"ok":true}', stderr: '', durationMs: 1, timedOut: false, truncated: false }));
  const client = createPowerShellClient({ runner });
  await client.runJson(MULTILINE_BLOCK_SCRIPT);

  const [call] = runner.calls;
  assert.deepEqual(call.args.slice(0, POWERSHELL_FLAGS.length), [...POWERSHELL_FLAGS]);
  assert.equal(POWERSHELL_FLAGS.at(-1), '-EncodedCommand');
  assert.equal(call.args.length, POWERSHELL_FLAGS.length + 1);
  assert.equal(call.stdin, undefined);
  assert.equal(call.args.some((arg) => arg.includes('aegis-source') || arg.includes('Write-Output')), false);
  assert.ok(decode(call.args.at(-1)).includes("Write-Output 'after'"));
});

test('a script too long for a Windows command line fails loudly instead of being cut', () => {
  // 30k characters of script -> ~80k base64 characters, well past the command-line budget.
  const huge = `# aegis-source:huge\n${'Write-Output 1\n'.repeat(2_000)}`;
  assert.throws(
    () => encodeCommand(huge),
    (error) => {
      assert.equal(error.code, WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
      assert.equal(error.details.limit, MAX_ENCODED_COMMAND_CHARS);
      return true;
    },
  );
});

test('an empty script is a programming error', () => {
  assert.throws(() => encodeCommand('   '), (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT);
});

test('"exit 0, printed nothing" is EMPTY_OUTPUT, not an empty read', async () => {
  const runner = createFakeRunner(() => ({ ok: true, code: 0, stdout: '\r\n', stderr: '', durationMs: 1, timedOut: false, truncated: false }));
  const client = createPowerShellClient({ runner });
  await assert.rejects(
    () => client.runJson('# aegis-source:processes\nGet-Process | ConvertTo-Json'),
    (error) => {
      assert.equal(error.code, WINDOWS_ERROR_CODES.EMPTY_OUTPUT);
      assert.equal(error.details.marker, 'processes');
      assert.match(error.remediation, /Never treat it as "no new events"/u);
      return true;
    },
  );
});

test('a real "no events were found" classification still means an empty read', async () => {
  // The legitimate empty case is a *failed* command whose stderr says the query matched
  // nothing; it must stay NO_EVENTS so the adapter can classify it as an empty read.
  const runner = createFakeRunner(() => ({
    ok: false,
    code: 1,
    stdout: '',
    stderr: 'Get-WinEvent : No events were found that match the specified selection criteria.',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  }));
  const client = createPowerShellClient({ runner });
  await assert.rejects(
    () => client.runJson('# aegis-source:event-log\nGet-WinEvent'),
    (error) => error.code === WINDOWS_ERROR_CODES.NO_EVENTS,
  );
});
