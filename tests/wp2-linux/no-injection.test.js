import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ALLOWLIST,
  LINUX_ERROR_CODES,
  createCommandRunner,
  createJournaldSource,
} from '../../packages/collectors/linux/index.js';
import { DEFAULT_JOURNALCTL } from '../../packages/collectors/linux/sources/journald.js';

/**
 * The Linux twin of `tests/wp2-windows/no-injection.test.js`.
 *
 * `command.js` is the only module allowed to reach `node:child_process`, and it must do so
 * with an argv array, an explicit `shell: false` and a module-level allowlist. Without this
 * test the Windows package had a scan that only recognised one quoting style; a Linux
 * package with no scan at all is strictly weaker, so the same closure is asserted here.
 */
const PACKAGE_ROOT = 'packages/collectors/linux';
const COMMAND_MODULE = join(PACKAGE_ROOT, 'command.js');

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
 * Remove comments without touching string, template or regex literals. Stripping only
 * whole-line comments keeps a trailing `// shell: true` alive, and a raw block-comment pass
 * eats a comment opener that appears inside a glob or a character class.
 */
function codeOnly(text) {
  const out = [];
  const n = text.length;
  let i = 0;
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
      word += ch;
      previous = ch;
    } else if (!/\s/.test(ch)) {
      word = '';
      previous = ch;
    }
  }
  return out.join('');
}

const CHILD_PROCESS_TOKEN = 'child_process';

const FORBIDDEN = [
  ['a CommonJS require()', /\brequire\s*\(/u],
  ['a dynamic import()', /\bimport\s*\(\s*['"`]/u],
  ['module.createRequire', /\bcreateRequire\b/u],
  ['process.getBuiltinModule', /\bgetBuiltinModule\b/u],
  ['process.binding', /\bprocess\s*\.\s*binding\s*\(/u],
  ['Module._load', /\bModule\s*\.\s*_load\b/u],
  ['execSync', /\bexecSync\b/u],
  ['spawnSync', /\bspawnSync\b/u],
  ['execFileSync', /\bexecFileSync\b/u],
  ['child_process.exec', /\bchild_process\s*\.\s*exec\b/u],
  ['eval()', /(^|[^.\w$])eval\s*\(/u],
  ['new Function', /\bnew\s+Function\s*\(/u],
  ['shell: true', /\bshell\s*:\s*true\b/u],
  ['sh -c', /['"`](?:\/bin\/)?(?:sh|bash|dash)['"`]\s*,\s*\[\s*['"`]-c/u],
];

test('only command.js names child_process, in any quoting style or loader form', () => {
  const offenders = sourceFiles().filter((path) => read(path).includes(CHILD_PROCESS_TOKEN));
  assert.deepEqual(offenders, [COMMAND_MODULE]);

  const command = codeOnly(read(COMMAND_MODULE));
  assert.match(command, /\bfrom\s*['"]node:child_process['"]/u);
  assert.match(command, /shell: false/u);
  assert.equal(/shell:\s*true/u.test(command), false);
  assert.equal(/\bexecSync|spawnSync|execFileSync/u.test(command), false);
});

test('no module performs a dynamic module load or a shell-mediated execution', () => {
  for (const path of sourceFiles()) {
    const text = codeOnly(read(path));
    for (const [label, pattern] of FORBIDDEN) {
      assert.equal(pattern.test(text), false, `${path} uses ${label}`);
    }
  }
});

test('there is exactly one spawn call site in the package', () => {
  const spawnCallSites = sourceFiles().filter((path) => /\bspawn\s*\(/u.test(codeOnly(read(path))));
  assert.deepEqual(spawnCallSites, [COMMAND_MODULE]);
});

test('codeOnly drops trailing comments but keeps a // inside a literal', () => {
  const sample = [
    "const path = '/var/log/auth.log'; // shell: true",
    'const kept = `a // b`;',
    'const division = 4 / 2; // execSync',
  ].join('\n');
  const code = codeOnly(sample);

  assert.equal(/shell:\s*true/u.test(code), false);
  assert.equal(/execSync/u.test(code), false);
  assert.match(code, /\/var\/log\/auth\.log/u);
  assert.match(code, /a \/\/ b/u);
  assert.match(code, /4 \/ 2/u);
});

test('the allowlist is a frozen module-level constant of journalctl paths', () => {
  assert.equal(Object.isFrozen(DEFAULT_ALLOWLIST), true);
  assert.notEqual(DEFAULT_ALLOWLIST.length, 0);
  for (const entry of DEFAULT_ALLOWLIST) {
    assert.match(entry, /(?:^|\/)journalctl$/u, `${entry} is not a journalctl path`);
  }
  assert.match(
    codeOnly(read(COMMAND_MODULE)),
    /export const DEFAULT_ALLOWLIST = Object\.freeze\(/u,
    'the allowlist must be a literal constant, not something a caller can rebuild',
  );
});

test('the runner takes argv as an array, never a shell string', async () => {
  const calls = [];
  const runner = createCommandRunner({
    execFile: (executable, args, options, done) => {
      calls.push({ executable, args, options });
      done(null, '[]', '', { code: 0, signal: null, timedOut: false, truncated: false, durationMs: 1 });
    },
  });

  const result = await runner.run({ executable: '/usr/bin/journalctl', args: ['--no-pager', '--output=json'] });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(Array.isArray(call.args), true);
  assert.deepEqual(call.args, ['--no-pager', '--output=json']);
  // `shell` is not part of the request and is not forwarded: the only place it is decided is
  // the literal options object in `spawnExecFile`, so no caller can turn a shell on.
  assert.equal(call.options.shell, undefined, 'a shell must not be requestable through options');
  assert.equal(call.options.input, undefined, 'journalctl takes no stdin script');
  const command = codeOnly(read(COMMAND_MODULE));
  assert.match(command, /spawn\(executable, args, \{ shell: false,/u, 'shell: false is a literal at the spawn site');
  assert.equal(/shell\s*:\s*(?:options|opts|request|requestOptions)\b/u.test(command), false, 'shell must never be forwarded from a caller');

  await assert.rejects(
    () => runner.run({ executable: '/usr/bin/journalctl', args: '--no-pager --output=json' }),
    (error) => error.code === LINUX_ERROR_CODES.INVALID_ARGUMENT,
  );
});

test('a planted binary with the right basename is refused by the allowlist', async () => {
  const runner = createCommandRunner({ execFile: () => {} });
  for (const hostile of ['/tmp/evil/journalctl', '/bin/sh', 'bash', '/usr/bin/env']) {
    await assert.rejects(
      () => runner.run({ executable: hostile, args: ['-c', 'id'] }),
      (error) => error.code === LINUX_ERROR_CODES.EXECUTABLE_NOT_ALLOWED,
      hostile,
    );
  }
});

test('the journald source builds argv from constants and never from a string', async () => {
  const calls = [];
  const runner = {
    async run(request) {
      calls.push(request);
      return { ok: false, code: 1, signal: null, stdout: '', stderr: 'Failed to open system journal: Permission denied', durationMs: 1 };
    },
  };
  const source = createJournaldSource({ runner, clock: () => 1_700_000_000_000 });
  await source.read();

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.executable, DEFAULT_JOURNALCTL, 'the executable is the module-level default');
  assert.equal(Array.isArray(call.args), true, 'argv must be an array');
  for (const arg of call.args) {
    assert.equal(typeof arg, 'string');
    assert.equal(/[\n\r;&|`]/u.test(arg), false, `${arg} carries a shell metacharacter`);
  }
  assert.equal(call.args.includes('--no-pager'), true);
  assert.equal(call.args.includes('--output=json'), true);
});
