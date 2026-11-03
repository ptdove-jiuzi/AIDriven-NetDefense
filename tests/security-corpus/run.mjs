// author: PT-dove
// M9 对抗语料运行器。
//
// 为什么不用根目录的 `scripts/run-tests.mjs`：那支脚本服务于根门禁的分段计数，
// 本语料不在根门禁内（本任务不允许改 package.json），所以自带一个**同样带下限**的
// 运行器：`node --test` 在 glob 匹配不到任何文件时会打印 0 条并以 0 退出，
// 没有下限的"全绿"可能只是"什么都没跑"。
//
// 用法：
//   node tests/security-corpus/run.mjs                  # 跑全部（下限 420）
//   node tests/security-corpus/run.mjs --evidence        # 额外写证据文件
//   node tests/security-corpus/run.mjs --timeout 120000   # 调整墙钟上限
//   node tests/security-corpus/run.mjs --minimum 420     # 只能**抬高**下限
//
// 环境：
//   AEGIS_M9_TMP_ROOT  可选。临时沙箱根目录；默认系统临时目录。CI 指向作业级目录即可
//                      让残留随作业一起回收。仓库内、家目录本身、`~/.ssh`、agent 数据目录、
//                      `~/Documents|Desktop|Downloads` 会被拒绝（退出码 2）。
//
// 退出码（三段式，CI 必须区分"代码坏了"和"机器不行"）：
//   0  全部通过，条数不低于下限，且没有跳过/待办，也没有遗留沙箱
//   1  有用例失败 / 条数不足 / 有跳过或 todo / 找不到测试摘要 / 摘要自相矛盾 / 超时 /
//      子进程起不来 / 遗留了沙箱
//   2  环境不满足（Node 版本、临时目录不可用）—— 重试无意义，应修环境

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { RUN_ID_ENV, TEMP_ROOT_ENV, resolveTempRoot, sandboxPrefix } from './support/harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'security-corpus');

/**
 * 语料规模下限：任何"少了一大截"的跑法都必须变红。
 *
 * 合同上的最低要求是 **414**（`M9-CORPUS-RECONCILE` 逐文件实测：29+36+26+45+96+23+22+10+16+55+56）。
 * 这里取的是**当前实数 420**（414 + `environment-isolation.test.js` 的 6 条），因为下限只设到
 * 414 就等于允许"顺手删掉那 6 条安全控制"仍然全绿。`--minimum` 只能把它抬高，不能调低 ——
 * 否则一条命令就能把门禁的下限悄悄改成 1。
 */
const MINIMUM_TESTS = 420;

/** 墙钟上限默认值。实测单轮 2.1–3.1 s，留两个数量级余量给慢盘 CI。 */
const DEFAULT_TIMEOUT_MS = 300_000;

/** 根 `package.json` 的 `engines.node`。低于它就是环境问题，不是用例问题。 */
const MINIMUM_NODE = [24, 9, 0];

/**
 * 从摘要里读一个计数器。
 *
 * **只读 stdout**：`node --test` 的摘要打在 stdout。把 stderr 也拼进来再取"最后一次匹配"，
 * 等于允许任何一条往 stderr 打印 `ℹ tests 9999` 的用例伪造全绿。
 *
 * @param {string} output 子进程 stdout。
 * @param {string} name 计数器名。
 * @returns {number | null} 数值，缺失则 `null`。
 */
function readCounter(output, name) {
  // `\r?$`：CI 里偶尔会给输出套一层伪终端，行尾变成 CRLF，带 `\r` 会让整片计数全部读不到。
  const matches = [...output.matchAll(new RegExp(`^[ℹ]\\s*${name}\\s+(\\d+(?:\\.\\d+)?)\\r?$`, 'gmu'))];
  return matches.length === 0 ? null : Number(matches[matches.length - 1][1]);
}

/**
 * 比较语义化版本。
 *
 * @param {string} actual 实际版本，例如 `24.20.0`。
 * @param {number[]} minimum 最低版本三段。
 * @returns {boolean} 是否达标。
 */
function versionAtLeast(actual, minimum) {
  const parts = String(actual).split('.').map((piece) => Number.parseInt(piece, 10) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0;
    if (have > minimum[index]) return true;
    if (have < minimum[index]) return false;
  }
  return true;
}

/**
 * 数出本次运行遗留的沙箱目录。只读，不删。
 *
 * 按**本次 run id** 过滤：并发实例的沙箱各有前缀，不会互相算成对方的泄漏。
 *
 * @param {string} tempRoot 临时根。
 * @param {string} prefix 本次运行的前缀。
 * @returns {string[] | null} 遗留目录名；**枚举失败返回 `null`**（未知），不要当成"零遗留"。
 */
function listOwnSandboxes(tempRoot, prefix) {
  try {
    return readdirSync(tempRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * 环境预检。失败一律交给调用方以退出码 2 结束。
 *
 * @returns {string[]} 问题清单，空数组表示环境可用。
 */
function preflight() {
  const problems = [];
  if (!versionAtLeast(process.versions.node, MINIMUM_NODE)) {
    problems.push(
      `node ${process.version} is below the required ${MINIMUM_NODE.join('.')} (see package.json engines)`,
    );
  }
  let tempRoot;
  try {
    tempRoot = resolveTempRoot();
  } catch (error) {
    problems.push(`temp root is unusable: ${error.message}`);
    return problems;
  }
  try {
    if (!statSync(tempRoot).isDirectory()) problems.push(`temp root is not a directory: ${tempRoot}`);
    const probe = path.join(tempRoot, `${sandboxPrefix()}preflight-${process.pid}`);
    mkdirSync(probe, { recursive: true });
    writeFileSync(path.join(probe, 'probe.txt'), 'ok', 'utf8');
    rmSync(probe, { recursive: true, force: true });
  } catch (error) {
    problems.push(`temp root is not writable: ${tempRoot}: ${error.message}`);
  }
  return problems;
}

const args = process.argv.slice(2);
const minimumIndex = args.indexOf('--minimum');
const requestedMinimum = minimumIndex >= 0 ? Number(args[minimumIndex + 1]) : MINIMUM_TESTS;
const writeEvidence = args.includes('--evidence');
const timeoutIndex = args.indexOf('--timeout');
const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : DEFAULT_TIMEOUT_MS;
const maxSkipIndex = args.indexOf('--max-skip');
const maxSkip = maxSkipIndex >= 0 ? Number(args[maxSkipIndex + 1]) : 0;

if (!Number.isInteger(requestedMinimum) || requestedMinimum < 1) {
  console.error('run: --minimum must be a positive integer');
  process.exit(1);
}
if (requestedMinimum < MINIMUM_TESTS) {
  console.error(
    `run: --minimum ${requestedMinimum} would lower the corpus floor; the floor is ${MINIMUM_TESTS} `
      + 'and may only be raised. Use `node --test <glob>` directly to run a subset.',
  );
  process.exit(1);
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
  console.error('run: --timeout must be an integer number of milliseconds (>= 1000)');
  process.exit(1);
}
if (!Number.isInteger(maxSkip) || maxSkip < 0) {
  console.error('run: --max-skip must be a non-negative integer');
  process.exit(1);
}

const environmentProblems = preflight();
if (environmentProblems.length > 0) {
  for (const problem of environmentProblems) console.error(`run: environment: ${problem}`);
  console.error('run: environment is not satisfied; this is not a test failure (exit 2)');
  if (writeEvidence) {
    try {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        path.join(EVIDENCE_DIR, 'corpus-run.json'),
        `${JSON.stringify({
          task: 'M9-SECURITY-CORPUS',
          generated_at: new Date().toISOString(),
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          environment_problems: environmentProblems,
          exit_code: 2,
          exit_reason: 'environment',
        }, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      console.error(`run: could not write evidence (keeping exit 2): ${error.message}`);
    }
  }
  process.exit(2);
}

const tempRoot = resolveTempRoot();
// 先定 run id 再算前缀：子进程（每个测试文件一个）继承同一个 id，泄漏才数得准。
// 顺序反了就会退化成公共前缀，别人的沙箱会被算成自己的泄漏。
// `?.trim() ||` 而不是 `??`：空串同样要当成"没给"，否则 `AEGIS_M9_RUN_ID=""` 会静默退回
// 公共前缀，把历史残留报成本次泄漏 —— 那正是这个机制要消灭的假红。
process.env[RUN_ID_ENV] = process.env[RUN_ID_ENV]?.trim() || `p${process.pid}`;
const prefix = sandboxPrefix();

const startedAt = new Date().toISOString();
const startedAtMs = Date.now();
const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=spec', 'tests/security-corpus/**/*.test.js'],
  { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs },
);
const wallMs = Date.now() - startedAtMs;

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
process.stdout.write(stdout);
process.stderr.write(stderr);

const counts = {
  tests: readCounter(stdout, 'tests'),
  pass: readCounter(stdout, 'pass'),
  fail: readCounter(stdout, 'fail'),
  cancelled: readCounter(stdout, 'cancelled'),
  skipped: readCounter(stdout, 'skipped'),
  todo: readCounter(stdout, 'todo'),
  duration_ms: readCounter(stdout, 'duration_ms'), // 可能带小数（例如 2249.18）
};

const leaked = listOwnSandboxes(tempRoot, prefix);

let exitCode = 0;
let exitReason = 'passed';

if (result.error !== undefined && result.error !== null) {
  const code = result.error.code ?? '';
  if (code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    exitCode = 1;
    exitReason = 'timeout';
    console.error(`run: the corpus did not finish within ${timeoutMs} ms; treated as a failure`);
  } else {
    exitCode = 1;
    exitReason = 'runner-error';
    console.error(`run: could not start the test runner: ${result.error.message}`);
  }
} else if (counts.tests === null) {
  console.error('run: no test summary found on stdout; refusing to report success');
  exitCode = 1;
  exitReason = 'no-summary';
} else if (counts.pass === null || counts.fail === null) {
  console.error('run: the summary is missing pass/fail counters; refusing to report success');
  exitCode = 1;
  exitReason = 'no-summary';
} else if (counts.pass + counts.fail + (counts.cancelled ?? 0) + (counts.skipped ?? 0) + (counts.todo ?? 0) !== counts.tests) {
  // 摘要自相矛盾通常意味着有人在伪造计数行，或者 reporter 换了格式。
  console.error(
    `run: inconsistent summary: tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} `
      + `cancelled=${counts.cancelled ?? 0} skipped=${counts.skipped ?? 0} todo=${counts.todo ?? 0}`,
  );
  exitCode = 1;
  exitReason = 'inconsistent-summary';
} else if (counts.fail > 0) {
  console.error(`run: ${counts.fail} test(s) failed`);
  exitCode = 1;
  exitReason = 'tests-failed';
} else if (counts.tests < requestedMinimum) {
  console.error(
    `run: only ${counts.tests} test(s) ran, the corpus requires at least ${requestedMinimum}. `
      + 'A shrinking corpus means the glob stopped matching, not that the code got better.',
  );
  exitCode = 1;
  exitReason = 'below-minimum';
} else if ((counts.skipped ?? 0) + (counts.todo ?? 0) > maxSkip) {
  // 跳过会让"没跑"看起来像"通过"。默认一条都不许跳。
  console.error(
    `run: ${counts.skipped ?? 0} skipped and ${counts.todo ?? 0} todo test(s); at most ${maxSkip} allowed. `
      + 'A silently growing skip list hides missing coverage.',
  );
  exitCode = 1;
  exitReason = 'skipped';
} else if (result.status !== 0) {
  // 不透传原始码：文档承诺的是三段式 0/1/2，透传出 4/5 之类的码会让 CI 的分支判断失效。
  exitCode = 1;
  exitReason = 'runner-exit';
  console.error(`run: the test runner exited with ${result.status} but the counters look green; trusting the exit code`);
}

if (leaked === null) {
  console.error(`run: could not enumerate ${tempRoot}; leftover sandboxes are unknown, not zero`);
} else if (leaked.length > 0) {
  console.error(
    `run: ${leaked.length} sandbox director(ies) left behind in ${tempRoot} (prefix ${prefix}): `
      + `${leaked.slice(0, 5).join(', ')}${leaked.length > 5 ? ', …' : ''}`,
  );
  if (exitCode === 0) {
    exitCode = 1;
    exitReason = 'sandbox-leak';
  }
}

if (writeEvidence) {
  const summary = {
    task: 'M9-SECURITY-CORPUS',
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    command: `${process.execPath} --test --test-reporter=spec tests/security-corpus/**/*.test.js`,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    temp_root: tempRoot,
    temp_root_source: process.env[TEMP_ROOT_ENV] === undefined ? 'os.tmpdir()' : TEMP_ROOT_ENV,
    counts,
    wall_ms: wallMs,
    minimum_required: requestedMinimum,
    max_skip_allowed: maxSkip,
    timeout_ms: timeoutMs,
    sandboxes_leaked: leaked === null ? null : leaked.length,
    exit_code: exitCode,
    exit_reason: exitReason,
    // 只写计数与命令，不写测试输出：输出里可能包含被测实现抛出的路径与栈。
    // 去重是必要的：spec reporter 会把失败用例在正文和 "failing tests:" 小结里各印一次。
    failing_tests: [...new Set([...stdout.matchAll(/^✖\s+(.+?)\s+\(\d/gmu)].map((match) => match[1]))].slice(0, 40),
  };
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(path.join(EVIDENCE_DIR, 'corpus-run.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log('run: evidence written to docs/implementation/evidence/security-corpus/corpus-run.json');
  } catch (error) {
    console.error(`run: could not write evidence: ${error.message}`);
    if (exitCode === 0) {
      exitCode = 1;
      exitReason = 'evidence-write-failed';
    }
  }
}

// 摘要行**无条件**打印：超时和"找不到摘要"时计数是 null，但 `exit N/reason` 正是值班的人
// 唯一能一眼看到的东西，缺了它 CI 日志里就只剩两条 stderr。
console.log(
  `run: ${counts.tests ?? 0} test(s), ${counts.pass ?? 0} passed, ${counts.fail ?? 0} failed, `
    + `${counts.skipped ?? 0} skipped, ${counts.todo ?? 0} todo (minimum ${requestedMinimum}, `
    + `wall ${wallMs} ms, exit ${exitCode}/${exitReason})`,
);
process.exit(exitCode);
