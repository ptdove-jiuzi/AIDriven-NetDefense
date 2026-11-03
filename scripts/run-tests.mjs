/**
 * Test runner with a floor.
 *
 * `node --test` exits 0 when a glob matches **nothing** — verified: a typo like
 * `tests/wp9/**\/*.test.js` prints `ℹ tests 0` and exits 0. That makes every
 * `test:*` script fail-open: rename a directory, or break a glob, and a whole
 * suite disappears from the gate while `npm test` stays green.
 *
 * This wrapper keeps the visible spec output and adds a minimum count, so a suite
 * can only pass if it actually ran at least the number of tests the repository is
 * known to have.
 *
 * Usage: `node scripts/run-tests.mjs <minimum> <glob> [maxSkip]`
 * The glob is handed to node unchanged (node expands it itself).
 *
 * `maxSkip` 是可选的**第三个位置参数**，不传时**不检查**跳过数（保持既有各段的行为不变）。
 * 传入时必须显式写明该段允许的跳过条数：静态 `{ skip: true }` 会把一条本该验证功能的
 * 用例变成"永不执行"，而 `node --test` 对跳过一律返回成功。允许跳过的段必须在
 * `docs/implementation/status/*.md` 里写清原因与平台，这里只负责让"跳过悄悄变多"变红。
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const [minimumArgument, pattern, maxSkipArgument] = process.argv.slice(2);
const minimum = Number(minimumArgument);
const maxSkip = maxSkipArgument === undefined ? null : Number(maxSkipArgument);

if (maxSkip !== null && (!Number.isInteger(maxSkip) || maxSkip < 0)) {
  console.error('run-tests: third argument (maxSkip) must be a non-negative integer when supplied');
  process.exit(1);
}

if (!Number.isInteger(minimum) || minimum < 1) {
  console.error('run-tests: first argument must be a positive integer test minimum');
  process.exit(1);
}
if (typeof pattern !== 'string' || pattern.length === 0) {
  console.error('run-tests: second argument must be a test glob');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', pattern], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
process.stdout.write(stdout);
process.stderr.write(stderr);

if (result.error !== undefined && result.error !== null) {
  console.error(`run-tests: could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  // 让 node --test 的退出码原样透传；下面的计数只用于"跑到了但没有失败"的情形。
  process.exit(result.status ?? 1);
}

/**
 * Read a counter from the spec (`ℹ tests 26`) or TAP (`# tests 26`) summary.
 *
 * Takes the **last** match on purpose: the summary block is printed at the end, so
 * a test that prints `ℹ tests 9999` in its own output cannot inflate the count.
 *
 * @param {string} output Combined child output.
 * @param {string} name Counter name.
 * @returns {number | null} Parsed value, or `null` when absent.
 */
function readCounter(output, name) {
  const matches = [...output.matchAll(new RegExp(`^[#ℹ]\\s*${name}\\s+(\\d+)$`, 'gmu'))];
  if (matches.length === 0) {
    return null;
  }
  return Number(matches[matches.length - 1][1]);
}

const tests = readCounter(`${stdout}\n${stderr}`, 'tests');
const failed = readCounter(`${stdout}\n${stderr}`, 'fail');
const skipped = readCounter(`${stdout}\n${stderr}`, 'skipped');

if (tests === null) {
  console.error(`run-tests: no test summary found for ${pattern}; refusing to report success`);
  process.exit(1);
}
if (failed !== null && failed > 0) {
  console.error(`run-tests: ${failed} test(s) failed for ${pattern}`);
  process.exit(1);
}
if (tests < minimum) {
  console.error(
    `run-tests: ${pattern} ran ${tests} test(s) but this suite must run at least ${minimum}. `
      + 'A shrinking suite means the glob stopped matching, not that the code got better.',
  );
  process.exit(1);
}
if (maxSkip !== null) {
  if (skipped === null) {
    console.error(`run-tests: ${pattern} is declared skip-tolerant (<= ${maxSkip}) but no skip counter was found`);
    process.exit(1);
  }
  if (skipped > maxSkip) {
    console.error(
      `run-tests: ${pattern} skipped ${skipped} test(s) but this suite allows at most ${maxSkip}. `
        + 'A silently growing skip list hides missing coverage; record the reason and platform in the status file.',
    );
    process.exit(1);
  }
}

console.log(`run-tests: ${tests} test(s) ran for ${pattern} (minimum ${minimum}).`);
