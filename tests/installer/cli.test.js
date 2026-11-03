/**
 * Argument parsing.
 *
 * Small surface, high blast radius: an installer that reads `/uninstal` as "install" is
 * worse than one that refuses. So unknown input is an error, a value-taking flag without a
 * value is an error, and two commands in one invocation is an error.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CliError, parseArgv } from '../../deploy/windows/installer/src/cli.mjs';

test('/S and /silent both mean silent', () => {
  assert.equal(parseArgv(['/install', '/S']).silent, true);
  assert.equal(parseArgv(['/install', '/silent']).silent, true);
});

test('the published subcommands are all recognised', () => {
  for (const command of ['install', 'uninstall', 'purge', 'verify', 'repair', 'rollback']) {
    assert.equal(parseArgv([`/${command}`]).command, command);
  }
});

test('/log takes a path and --long spellings work too', () => {
  const parsed = parseArgv(['/install', '/log', 'D:\\tmp\\a.log']);
  assert.equal(parsed.logPath, 'D:\\tmp\\a.log');

  const long = parseArgv(['--install', '--root', 'D:\\scratch', '--version', '0.0.1']);
  assert.equal(long.command, 'install');
  assert.equal(long.root, 'D:\\scratch');
  assert.equal(long.version, '0.0.1');
});

test('a value-taking flag without a value is an error, not an empty string', () => {
  assert.throws(() => parseArgv(['/install', '/log']), CliError);
  assert.throws(() => parseArgv(['/install', '/log', '/silent']), CliError);
});

test('two commands in one invocation is an error', () => {
  assert.throws(() => parseArgv(['/install', '/uninstall']), /只能给出一个命令/u);
});

test('an unknown flag is an error', () => {
  assert.throws(() => parseArgv(['/install', '--frobnicate']), /未知参数/u);
  assert.throws(() => parseArgv(['/install', 'stray']), /无法识别的参数/u);
});

test('--port must be an integer', () => {
  assert.equal(parseArgv(['/install', '--port', '8787']).apiPort, 8787);
  assert.throws(() => parseArgv(['/install', '--port', 'eighty']), /必须是整数/u);
});

test('--mode is carried through for the safety check to validate', () => {
  assert.equal(parseArgv(['/verify', '--mode', 'disarm']).mode, 'disarm');
  // Parsing does not validate the value: that decision belongs to resolveMode, which has
  // the exit codes for it.
  assert.equal(parseArgv(['/verify', '--mode', 'nonsense']).mode, 'nonsense');
});

test('an empty argv parses to "no command" rather than throwing', () => {
  assert.equal(parseArgv([]).command, null);
});
