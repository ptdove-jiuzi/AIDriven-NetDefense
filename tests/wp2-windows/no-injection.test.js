import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  POWERSHELL_FLAGS,
  PROCESS_SCRIPT,
  RUN_KEY_PATHS,
  WINDOWS_ERROR_CODES,
  buildReadScript,
  buildRunKeysScript,
  createCommandRunner,
  createPowerShellClient,
  createWindowsSources,
  describeWindowsSources,
} from '../../packages/collectors/windows/index.js';

const PACKAGE_ROOT = 'packages/collectors/windows';

function sourceFiles(directory = PACKAGE_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files.sort();
}

function read(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Strip comments before asserting on behaviour: the module headers deliberately quote the
 * patterns they refuse (`Never shell: true`), and a raw text match would flag the warning as
 * if it were the bug.
 *
 * A regex that only drops full-line line-comments cannot do this job: a trailing
 * `const x = 1; // shell: true` keeps its comment, and a block-comment pass happily eats a
 * comment opener that sits inside a glob or a string. So comments are removed by a real
 * scanner that understands string, template and regex literals: a line-comment marker is only
 * a comment when it starts outside one. Everything else — a marker inside 'https&#58;//…' or
 * inside a character-class regex — survives.
 */
function codeOnly(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  // The last significant (non-space) character emitted, and the identifier being built;
  // both are only used to tell a division `/` from the start of a regex literal.
  let previous = '';
  let word = '';
  const REGEX_AFTER = new Set([
    '', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '~', '^',
  ]);
  const KEYWORD_BEFORE_REGEX = /^(?:return|typeof|instanceof|in|of|new|delete|void|do|else|case|yield|await)$/u;

  while (i < n) {
    const ch = text[i];
    const next = i + 1 < n ? text[i + 1] : '';

    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out.push('\n');
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out.push(ch);
      i += 1;
      while (i < n) {
        const c = text[i];
        out.push(c);
        i += 1;
        if (c === '\\') {
          if (i < n) {
            out.push(text[i]);
            i += 1;
          }
          continue;
        }
        if (c === ch) break;
      }
      previous = ch;
      word = '';
      continue;
    }
    if (ch === '/' && (REGEX_AFTER.has(previous) || KEYWORD_BEFORE_REGEX.test(word))) {
      out.push(ch);
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = text[i];
        out.push(c);
        i += 1;
        if (c === '\\') {
          if (i < n) {
            out.push(text[i]);
            i += 1;
          }
          continue;
        }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      previous = '/';
      word = '';
      continue;
    }

    out.push(ch);
    i += 1;
    if (/[A-Za-z0-9_$]/.test(ch)) {
      // An identifier or a number is significant for the division/regex decision too:
      // `4 / 2` must stay a division while `( /re/ )` starts a literal.
      word += ch;
      previous = ch;
    } else if (!/\s/.test(ch)) {
      word = '';
      previous = ch;
    }
  }
  return out.join('');
}

/**
 * Ways to obtain a process-spawning primitive that are refused everywhere in the package.
 *
 * The specifier is deliberately *not* part of any one pattern. The earlier scan matched only
 * `from 'node:child_process'` / `require('node:child_process')`, so `from "node:child_process"`,
 * `import("node:child_process")` and `globalThis.process.getBuiltinModule('child_process')`
 * all passed. The closure used here is:
 *   1. the bare token `child_process` may appear in exactly one file, whatever the quoting,
 *      prefix or surrounding expression, and
 *   2. the dynamic loaders that could reach the same module without ever spelling the token
 *      are banned outright.
 */
const CHILD_PROCESS_TOKEN = 'child_process';
const CHILD_PROCESS_IMPORTER = join(PACKAGE_ROOT, 'runner.js');

const FORBIDDEN = [
  ['a CommonJS require()', /\brequire\s*\(/u],
  ['a dynamic import()', /\bimport\s*\(/u],
  ['module.createRequire', /\bcreateRequire\b/u],
  ['process.getBuiltinModule', /\bgetBuiltinModule\b/u],
  ['process.binding', /\bprocess\s*\.\s*binding\s*\(/u],
  ['Module._load', /\bModule\s*\.\s*_load\b/u],
  ['execSync', /\bexecSync\b/u],
  ['spawnSync', /\bspawnSync\b/u],
  ['execFileSync', /\bexecFileSync\b/u],
  ['eval()', /(^|[^.\w$])eval\s*\(/u],
  ['new Function', /\bnew\s+Function\s*\(/u],
  ['shell: true', /\bshell\s*:\s*true\b/u],
  ['Invoke-Expression', /Invoke-Expression|\biex\b/u],
  ['cmd.exe', /cmd\.exe/u],
];

test('exactly one module reaches child_process, in any quoting style or loader form', () => {
  // Quoting-agnostic on purpose: `includes` sees 'child_process', "child_process",
  // `child_process`, node:child_process, getBuiltinModule('child_process') and a string that
  // is concatenated at runtime, because the token has to be spelled somewhere.
  const offenders = sourceFiles().filter((path) => read(path).includes(CHILD_PROCESS_TOKEN));
  assert.deepEqual(offenders, [CHILD_PROCESS_IMPORTER]);

  const runner = codeOnly(read(CHILD_PROCESS_IMPORTER));
  assert.match(runner, /\bfrom\s*['"]node:child_process['"]/u);
  assert.match(runner, /shell: false/u);
  assert.equal(/shell:\s*true/u.test(runner), false);
  assert.equal(/execSync|spawnSync|execFileSync/u.test(runner), false);
  assert.equal(/-EncodedCommand/u.test(runner), false);
});

test('no module performs a dynamic module load or a synchronous child process call', () => {
  for (const path of sourceFiles()) {
    const text = codeOnly(read(path));
    for (const [label, pattern] of FORBIDDEN) {
      assert.equal(pattern.test(text), false, `${path} uses ${label}`);
    }
  }
});

test('no module builds a command string out of template literals handed to a shell', () => {
  for (const path of sourceFiles()) {
    const text = codeOnly(read(path));
    assert.equal(/exec\(\s*`/u.test(text), false, `${path} calls exec with a template literal`);
    assert.equal(/Invoke-Expression|\biex\b/u.test(text), false, `${path} references Invoke-Expression`);
    assert.equal(/cmd\.exe/u.test(text), false, `${path} invokes cmd.exe`);
  }
});

test('codeOnly removes a trailing // comment but keeps a // inside a literal', () => {
  const sample = [
    "const url = 'https://example.test/x'; // shell: true",
    'const pattern = /[\'"]/; /* cmd.exe */',
    'const kept = `a // b`;',
    'const division = 4 / 2; // execSync',
  ].join('\n');
  const code = codeOnly(sample);

  assert.equal(/shell:\s*true/u.test(code), false, 'the trailing comment must be gone');
  assert.equal(/cmd\.exe/u.test(code), false, 'the block comment must be gone');
  assert.equal(/execSync/u.test(code), false);
  assert.match(code, /https:\/\/example\.test\/x/u, 'a // inside a string is not a comment');
  assert.match(code, /a \/\/ b/u, 'a // inside a template literal is not a comment');
  assert.match(code, /4 \/ 2/u);
});

test('the runner hands argv as an array and the script only through stdin', async () => {
  const calls = [];
  const runner = createCommandRunner({
    execFile: (executable, args, options, done) => {
      calls.push({ executable, args, options });
      done(null, '{"ok":true}', '', { code: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 });
    },
  });

  const script = '# aegis-source:processes\nGet-Process';
  const result = await runner.run({
    executable: 'pwsh.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', '-'],
    stdin: script,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(Array.isArray(call.args), true, 'argv must be an array, never one command string');
  assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-Command', '-']);
  assert.equal(call.options.shell, false, 'shell must be explicitly false, not merely absent');
  assert.equal(call.options.input, script, 'the script travels on stdin');
  assert.equal(call.args.includes(script), false, 'no argument may carry the script');
  assert.equal(call.args.some((arg) => arg.includes('Get-Process')), false);

  // A single command string is a programming error, not something to hand to a shell.
  await assert.rejects(
    () => runner.run({ executable: 'pwsh.exe', args: '-Command Get-Process' }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_ARGUMENT,
  );
  await assert.rejects(
    () => runner.run({ executable: 'cmd.exe', args: [] }),
    (error) => error.code === WINDOWS_ERROR_CODES.EXECUTABLE_NOT_ALLOWED,
  );
});

test('the PowerShell client keeps the script off the command line', async () => {
  const calls = [];
  const client = createPowerShellClient({
    runner: {
      async run(request) {
        calls.push(request);
        return { ok: true, code: 0, signal: null, stdout: '[]', stderr: '', durationMs: 1, timedOut: false, truncated: false };
      },
    },
  });

  await client.runJson('# aegis-source:processes\nGet-Process');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, POWERSHELL_FLAGS, 'argv must be the module-level constant');
  assert.equal(Object.isFrozen(POWERSHELL_FLAGS), true);
  assert.equal(POWERSHELL_FLAGS[POWERSHELL_FLAGS.length - 1], '-', 'the trailing - makes stdin the script');
  assert.equal(calls[0].args.some((arg) => arg.includes('Get-Process')), false, 'the script is not an argument');
  assert.match(calls[0].stdin, /^[^\n]*\n# aegis-source:processes\nGet-Process/u, 'the script travels on stdin');
});

test('every script is derived from a module-level constant, never from runtime concatenation', () => {
  const runner = codeOnly(read(join(PACKAGE_ROOT, 'runner.js')));
  assert.equal(/args\s*:\s*[^,\n}]*\+/u.test(runner), false, 'argv must not be concatenated');

  const powershell = codeOnly(read(join(PACKAGE_ROOT, 'powershell.js')));
  assert.match(powershell, /args: POWERSHELL_FLAGS/u);
  assert.equal(/args\s*:\s*`/u.test(powershell), false, 'argv must not be a template literal');

  // The Run key script is a pure function of the declared constant: same input, same text,
  // and the only interpolation allowed is a single-quoted `psQuote` literal.
  assert.equal(buildRunKeysScript(), buildRunKeysScript(RUN_KEY_PATHS));
  const script = buildRunKeysScript(RUN_KEY_PATHS);
  assert.equal(script.split('$(').length - 1, 0, 'no subexpression can reach the script');
  assert.equal(script.includes('`'), false, 'no backtick can reach the script');
  assert.equal(/\$\{/u.test(script), false, 'no interpolation can reach the script');
  assert.equal(script.split("'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'").length - 1, 1);
});

test('a hostile channel name is refused before any script exists', () => {
  assert.throws(
    () => buildReadScript("Security'; Start-Process calc.exe; '", 0),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
  assert.throws(
    () => createWindowsSources({ include: ['eventLog'], channels: ['Evil; calc'], powershell: { runJson: async () => null } }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
});

test('a hostile registry key is refused before any script exists', () => {
  assert.throws(
    () => buildRunKeysScript(["HKCU\\Run'; calc; '"]),
    (error) => error.code === WINDOWS_ERROR_CODES.PATH_NOT_ALLOWED,
  );
});

test('a validated channel appears exactly once, inside a single-quoted literal', () => {
  const channel = 'Microsoft-Windows-Sysmon/Operational';
  const script = buildReadScript(channel, 0);
  const occurrences = script.split(channel).length - 1;
  assert.equal(occurrences, 1, 'the channel must only ever be embedded as the $channel literal');
  assert.match(script, /\$channel = 'Microsoft-Windows-Sysmon\/Operational'/u);
  assert.match(script, /-LogName \$channel/u, 'later uses go through the variable, not a second literal');
  assert.equal(script.includes('`'), false, 'no backtick escaping anywhere in the script');
});

test('an unknown source name is refused instead of silently collecting nothing', () => {
  assert.throws(
    () => createWindowsSources({ include: ['processes', 'nope'], powershell: { runJson: async () => null } }),
    (error) => error.code === WINDOWS_ERROR_CODES.SOURCE_UNKNOWN,
  );
});

test('the directories source cannot be requested without a declared root', () => {
  assert.throws(
    () => createWindowsSources({ include: ['directories'] }),
    (error) => error.code === WINDOWS_ERROR_CODES.INVALID_CONFIG,
  );
});

test('the default source set covers the whole §5.1 matrix', () => {
  const sources = createWindowsSources({
    powershell: { runJson: async () => null, runText: async () => 'ok' },
    channels: ['Security'],
    roots: ['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'],
    clock: () => 1_700_000_000_000,
  });
  const names = sources.map((entry) => entry.name);
  assert.deepEqual(names.sort(), [
    'connections', 'directories', 'eventLog:Security', 'processes', 'runKeys', 'scheduledTasks', 'services',
  ].sort());
});

test('every declared descriptor is discoverable without touching the host', () => {
  const descriptors = describeWindowsSources({ channels: ['Security', 'System'] });
  const ids = descriptors.map((descriptor) => descriptor.stableSourceId);
  assert.equal(ids.includes('windows.process-table'), true);
  assert.equal(ids.includes('windows.network-table'), true);
  assert.equal(ids.includes('windows.service-table'), true);
  assert.equal(ids.includes('windows.scheduled-task-table'), true);
  assert.equal(ids.includes('windows.run-key'), true);
  assert.equal(ids.includes('windows.event-log.security'), true);
  assert.equal(ids.includes('windows.event-log.system'), true);
});

test('the process script is a constant, so no runtime value can reach the interpreter', () => {
  assert.equal(/\$\$|\$\{/u.test(PROCESS_SCRIPT), false);
  assert.equal(PROCESS_SCRIPT.includes('+'), false);
});
