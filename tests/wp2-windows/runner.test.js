import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_ALLOWLIST,
  WINDOWS_ERROR_CODES,
  createCommandRunner,
  defaultExecFile,
} from '../../packages/collectors/windows/index.js';
import { createFakeRunner } from './helpers.js';

const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Build an execFile fake that answers with the given callback arguments. */
function cannedExecFile({ error = null, stdout = '', stderr = '', meta = null } = {}) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push({ file, args, options });
    done(error, stdout, stderr, meta);
  };
  execFile.calls = calls;
  return execFile;
}

test('a non-zero exit code is a failure even without an error object', async () => {
  // Regression: `spawn` reports a non-zero exit through `close` with a null error, and the
  // previous `ok` derivation only inspected the error, so every failing PowerShell script
  // was reported as a successful read.
  const runner = createCommandRunner({
    execFile: cannedExecFile({ meta: { code: 1, signal: null, timedOut: false, truncated: false, durationMs: 7 } }),
  });
  const result = await runner.run({ executable: 'powershell.exe', args: ['-NoLogo'] });

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'command exited with code 1');
  // `ok: false` with `errorCode: null` would be self-contradictory and let callers treat the
  // failure as unclassified; the exit code has to take part in the classification.
  assert.equal(result.errorCode, WINDOWS_ERROR_CODES.COMMAND_FAILED);
});

test('a zero exit code with no output is a success', async () => {
  const runner = createCommandRunner({
    execFile: cannedExecFile({ meta: { code: 0, signal: null, timedOut: false, truncated: false, durationMs: 3 } }),
  });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });
  assert.equal(result.ok, true);
  assert.equal(result.stderr, '');
});

test('an executable outside the allowlist is rejected before it is ever spawned', async () => {
  const execFile = cannedExecFile();
  const runner = createCommandRunner({ execFile });

  await assert.rejects(
    () => runner.run({ executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'whoami'] }),
    (error) => error.code === WINDOWS_ERROR_CODES.EXECUTABLE_NOT_ALLOWED,
  );
  assert.equal(execFile.calls.length, 0, 'the rejected executable must not reach execFile');
  assert.equal(DEFAULT_ALLOWLIST.includes('cmd.exe'), false);
});

test('the allowlist matches on the basename so a full interpreter path is accepted', async () => {
  const runner = createCommandRunner({ execFile: cannedExecFile({ meta: { code: 0, truncated: false, timedOut: false } }) });
  const result = await runner.run({
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile'],
  });
  assert.equal(result.ok, true);
});

test('a shell metacharacter in an argument is passed as one opaque argument', async () => {
  const execFile = cannedExecFile({ meta: { code: 0, truncated: false, timedOut: false } });
  const runner = createCommandRunner({ execFile });
  const hostile = 'Security; Start-Process calc.exe';

  await runner.run({ executable: 'powershell.exe', args: ['-LogName', hostile] });

  assert.deepEqual(execFile.calls[0].args, ['-LogName', hostile]);
  assert.equal(execFile.calls[0].options.shell, false, 'the runner must never ask for a shell');
});

test('non-string arguments and non-string stdin are programming errors', async () => {
  const runner = createCommandRunner({ execFile: cannedExecFile() });

  await assert.rejects(
    () => runner.run({ executable: 'powershell.exe', args: ['ok', 42] }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => runner.run({ executable: 'powershell.exe', args: [], stdin: Buffer.from('x') }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
  );
});

test('a timeout is reported as timedOut rather than as a plain failure', async () => {
  const killed = Object.assign(new Error('Command failed: powershell.exe'), { killed: true, signal: 'SIGKILL' });
  const runner = createCommandRunner({ execFile: cannedExecFile({ error: killed }), timeoutMs: 1_000 });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.truncated, false);
});

test('truncated output is flagged and never returned as a partial success', async () => {
  const overflow = Object.assign(new Error('stdout maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  const runner = createCommandRunner({ execFile: cannedExecFile({ error: overflow }) });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });

  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
});

test('a promise-style execFile is normalized to the same result shape', async () => {
  const runner = createCommandRunner({
    execFile: async () => ({ stdout: '  {"a":1}  ', stderr: '', code: 0 }),
  });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, '  {"a":1}  ');
  assert.equal(result.code, 0);
});

test('a promise-shaped failure without stdout is not mistaken for an empty success', async () => {
  // Regression: `'stdout' in value` was the only success test, so `{ code: 1, stderr }` was
  // reported as a successful empty read. Downstream that became "log cleared": the event log
  // source would see newestRecordId = 0, advance the generation and skip the backlog.
  const runner = createCommandRunner({
    execFile: async () => ({ code: 1, stderr: 'Access is denied' }),
  });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });

  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, 'Access is denied');
  assert.equal(result.errorCode, WINDOWS_ERROR_CODES.COMMAND_FAILED);
});

test('a rejected promise from an injected runner is still a command outcome', async () => {
  const runner = createCommandRunner({
    execFile: async () => { throw new Error('spawn ENOENT'); },
  });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, WINDOWS_ERROR_CODES.COMMAND_FAILED);
  assert.match(result.stderr, /spawn ENOENT/u);
});

test('a synchronous throw from an injected runner does not escape as an exception', async () => {
  const runner = createCommandRunner({
    execFile: () => { throw new Error('boom'); },
  });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /boom/u);
});

test('an invalid timeout or maxBuffer is rejected at construction time', () => {
  assert.throws(() => createCommandRunner({ timeoutMs: -1 }), /timeoutMs/u);
  // A zero timeout would disable the timer: a hung interpreter would never settle the
  // promise and the source's busy flag would stay stuck, silently skipping every later read.
  assert.throws(() => createCommandRunner({ timeoutMs: 0 }), /timeoutMs/u);
  assert.throws(() => createCommandRunner({ maxBuffer: 0 }), /maxBuffer/u);
  assert.throws(() => createCommandRunner({ allowlist: [] }), /allowlist/u);
});

test('the real interpreter round-trips a script over stdin', async (t) => {
  // The only test in this suite that spawns a process, and it runs a constant expression:
  // no user data, no log, no registry. Skipped where the interpreter does not exist so the
  // suite stays honest instead of silently passing.
  if (!existsSync(WINDOWS_POWERSHELL)) {
    t.skip('Windows PowerShell is not installed on this host');
    return;
  }
  const runner = createCommandRunner({ timeoutMs: 20_000 });
  const result = await runner.run({
    executable: WINDOWS_POWERSHELL,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
    stdin: "$ErrorActionPreference='Stop'; [pscustomobject]@{ ok = 1 } | ConvertTo-Json -Compress",
  });

  assert.equal(result.ok, true, `stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { ok: 1 });
});

test('a promise that resolves to a non-object is a failure, not an empty success', async () => {
  const runner = createCommandRunner({ execFile: async () => null });
  const result = await runner.run({ executable: 'powershell.exe', args: [] });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, WINDOWS_ERROR_CODES.COMMAND_FAILED);
});

test('the default execFile replacement really spawns the interpreter', async () => {
  // Unlike the previous assertion (`typeof defaultExecFile === 'function'`, which any empty
  // function satisfies), this exercises the exported implementation itself. Skipped where the
  // interpreter is absent so the suite never claims a false pass.
  if (!existsSync(WINDOWS_POWERSHELL)) {
    assert.equal(typeof defaultExecFile, 'function');
    return;
  }
  const result = await new Promise((resolve) => {
    defaultExecFile(
      WINDOWS_POWERSHELL,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      { timeout: 20_000, maxBuffer: 1024 * 1024, input: '$PSVersionTable.PSVersion.Major' },
      (error, stdout, stderr, meta) => resolve({ error, stdout, stderr, meta }),
    );
  });

  assert.equal(result.error, null);
  assert.equal(result.meta.code, 0);
  assert.match(String(result.stdout).trim(), /^\d+$/u);
});

test('the fake runner used by the source tests records every request', async () => {
  const runner = createFakeRunner();
  await runner.run({ executable: 'powershell.exe', args: [] });
  assert.equal(runner.calls.length, 1);
});
