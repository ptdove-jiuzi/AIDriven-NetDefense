/**
 * defect-close-r6-001.test.js — 回归守卫：安全/安装器套件必须留在 `npm test` 的门禁链里。
 *
 * 背景（BUG-LEDGER R6-001）：
 * 缺陷**不是**"套件本身假绿"，而是"套件根本不在门禁里"：A1 的越权删除用例与
 * `tests/console/i18n/**` 曾经一条都不跑，于是拿 `npm test` 绿去证明这两件事=假绿。
 * 修复（2026-11-05，FIX-WAVE）把 `test:installer` / `test:console-i18n` 串进了 `npm test`。
 * 本文件把这件事变成**可失败**的机械判据：
 *
 * 1. `npm test` 的 `&&` 链里必须逐字包含这两段；
 * 2. 两段脚本必须存在、必须走 `scripts/run-tests.mjs <floor> "<glob>" [maxSkip]` 的形式，
 *    floor > 0 且 glob 真的能匹配到文件（floor=0 / 空 glob 会让门禁变空转）；
 * 3. **真跑**（仅独立上下文）：summary 存在、`tests >= floor`，并且"fail>0 却 exit 0"必须被抓
 *    —— 这一条抓的是 `|| true` / `; exit 0` 之类的吞失败改写。真跑**不**要求套件必须绿、
 *    **不**断言 skipped ≤ maxSkip：那两项由套件自己的门禁判，宿主残留（例如遗留的真实安装）
 *    会让它们变成不确定的红，而守卫必须是确定性的。
 * 4. 吞失败文本（`||`、`; exit 0`、`true`）与"fail>0+exit0 / fail=0+exit1"两个方向的一致性，
 *    用**纯函数 + 合成输入**在单元级各测一次，不靠真跑一段红的来证明。
 *
 * 负样本（证明检查器不是恒真）：同一检查器喂
 * `…/R6-001/fix/package-json-without-installer-console-i18n.json`（删段）与
 * `…/R6-001/fix/package-json-swallow-failure.json`（吞失败）都必须报缺；in-memory 的 floor=0
 * 变体必须被 floor 检查抓住。两份负样本都可以用环境变量
 * `DEFECT_CLOSE_PACKAGE_JSON=<path>` 把整个守卫喂进去复跑（此时真跑段落自动跳过、只留静态判据）。
 *
 * 递归/竞态保护：本文件自己就在 `tests/installer/**` 里，`npm run test:installer`（含 `npm test`）
 * 会把它再跑一遍。npm 会把 lifecycle 名（`npm_lifecycle_event=test:installer`）传给整棵进程树，
 * 命中时构件**绝不**再 spawn 一次 `npm run test:installer`——那会把安装器套件并行跑两遍，
 * 而兄弟用例正在真装/真写 `HKCU\…\Run`，等于把既有注册表竞态放大成稳定红。嵌套上下文里
 * 只断言"确实处于门禁上下文 + 静态链路正确"并 **pass**（不 skip：skip 会顶破 maxSkip=4）。
 * 只有独立 `node --test tests/installer/defect-close-r6-001.test.js` 时才做"真跑两段"。
 *
 * 运行：node --test tests/installer/defect-close-r6-001.test.js
 *
 * 作者：PT-dove
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PACKAGE_JSON = process.env.DEFECT_CLOSE_PACKAGE_JSON === undefined
  ? path.join(REPO_ROOT, 'package.json')
  : path.resolve(process.env.DEFECT_CLOSE_PACKAGE_JSON);
// "Control" assertions always mean the real repository package.json, even during a diagnostic
// run that points PACKAGE_JSON at a doctored copy.
const REAL_PACKAGE = path.join(REPO_ROOT, 'package.json');
const NEGATIVE_PACKAGE = path.join(
  REPO_ROOT,
  'docs',
  'implementation',
  'evidence',
  'defect-close',
  'R6-001',
  'fix',
  'package-json-without-installer-console-i18n.json',
);
const SWALLOW_PACKAGE = path.join(
  REPO_ROOT,
  'docs',
  'implementation',
  'evidence',
  'defect-close',
  'R6-001',
  'fix',
  'package-json-swallow-failure.json',
);
// 真跑只在"独立上下文 + 默认 package.json"下做：负样本诊断跑（用环境变量换 package）不应再花 90 s 真跑，
// 也不该借真跑结果去证明"删段/吞失败"这类静态判据。
const NEGATIVE_DIAGNOSTIC_RUN = process.env.DEFECT_CLOSE_PACKAGE_JSON !== undefined
  || process.env.DEFECT_CLOSE_R6_001_SKIP_REAL === '1';
const CHILD_ENV = process.env.DEFECT_CLOSE_R6_001_CHILD === '1';
// npm exports the lifecycle name to the whole process tree of a `npm run <name>`.
// This file lives inside `tests/installer/**`, so under `npm run test:installer` (and therefore
// under `npm test`) it is ALREADY part of the suite it would otherwise spawn. Spawning
// `npm run test:installer` from here would run the whole installer suite a second time,
// concurrently with the sibling tests that really install/upgrade and really write
// `HKCU\…\Run` — i.e. it turns an existing registry race into a reliable red (attacker: the
// outer suite fails T2/T6-T7 with 4 skips pinned at maxSkip, while single-file runs are green).
// So: nested → assert the gate context + static chain only, and PASS (never skip: skipping
// would eat the maxSkip budget of the very suite this file is part of).
const LIFECYCLE = process.env.npm_lifecycle_event ?? '';
const NESTED = CHILD_ENV || LIFECYCLE === 'test:installer';

const REQUIRED_SEGMENTS = [
  { name: 'test:installer', command: 'npm run test:installer' },
  { name: 'test:console-i18n', command: 'npm run test:console-i18n' },
];

const SCRIPT_FORM = /node scripts\/run-tests\.mjs (\d+) "([^"]+)"(?: (\d+))?/u;

/** Recursively count files matching `dir/**\/*ext` (the globs used by the two scripts). */
function countGlobFiles(glob) {
  const wildcard = glob.indexOf('/**/');
  if (wildcard === -1) {
    return 0;
  }
  const root = path.join(REPO_ROOT, glob.slice(0, wildcard));
  const suffix = glob.slice(wildcard + 4);
  if (!fs.existsSync(root)) {
    return 0;
  }
  let count = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(suffix.replace(/^\*+/u, ''))) {
        count += 1;
      }
    }
  };
  walk(root);
  return count;
}

/**
 * The single checker the guard and the negative sample both go through.
 *
 * @param {string} packagePath Path to a package.json.
 * @returns {{problems: string[], chain: string[], scripts: Record<string, string>}}
 */
function checkGate(packagePath) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const scripts = pkg.scripts ?? {};
  const chain = typeof scripts.test === 'string' ? scripts.test.split('&&').map((part) => part.trim()) : [];
  const seen = new Set();

  for (const segment of REQUIRED_SEGMENTS) {
    if (!chain.includes(segment.command)) {
      problems.push(`npm test 的链里缺少 "${segment.command}"：该套件不会跑，拿 npm test 绿证明它就是假绿`);
    }
    const body = scripts[segment.name];
    if (typeof body !== 'string' || body.length === 0) {
      problems.push(`缺少脚本 ${segment.name}`);
      continue;
    }
    // A `|| true` / `; exit 0` inside the segment script swallows that suite's failures just
    // as effectively as one in the chain, so scan the segment body too.
    for (const problem of swallowRewriteProblems(body)) {
      problems.push(`${segment.name}: ${problem}`);
    }
    const match = SCRIPT_FORM.exec(body);
    if (match === null) {
      problems.push(`${segment.name} 不是 run-tests.mjs 的 floor 形式：${body}`);
      continue;
    }
    const floor = Number(match[1]);
    const glob = match[2];
    const maxSkip = match[3] === undefined ? null : Number(match[3]);
    if (!Number.isInteger(floor) || floor <= 0) {
      problems.push(`${segment.name} 的 floor 必须 > 0（实际 ${match[1]}）：floor=0 让套件可以悄悄变空`);
    }
    const matched = countGlobFiles(glob);
    if (matched <= 0) {
      problems.push(`${segment.name} 的 glob "${glob}" 没有匹配到任何测试文件`);
    }
    seen.add(`${segment.name}|${floor}|${maxSkip}`);
  }

  if (typeof scripts.test === 'string') {
    problems.push(...swallowRewriteProblems(scripts.test));
  } else {
    problems.push('缺少 scripts.test：npm test 不是门禁');
  }

  return { problems, chain, scripts, declarations: [...seen] };
}

/**
 * "失败被吞掉"的纯文本判据：链里出现 `||`（短路成功）或显式 `exit 0` / `true` 兜底。
 * 抽成纯函数是为了用合成输入做单元级负样本，不必靠"真跑出一段红的"来证明检查器能红。
 *
 * @param {string} scriptText `scripts.test` 的原文。
 * @returns {string[]} 问题列表。
 */
function swallowRewriteProblems(scriptText) {
  if (typeof scriptText !== 'string') {
    return ['脚本缺失：无法判断失败是否会被吞掉'];
  }
  const problems = [];
  if (/\|\|/u.test(scriptText)) {
    problems.push('出现 "||"：失败会被吞掉');
  }
  if (/(?:^|[;&])\s*(?:exit\s+0|true)\b/u.test(scriptText)) {
    problems.push('出现 exit 0 / true：失败会被吞掉');
  }
  return problems;
}

/**
 * 真跑时唯一必须成立的"输出一致性"判据：报了失败就不能 exit 0。
 *
 * 只断言这一个方向，是因为另一个方向（0 失败但 exit≠0）可能来自**宿主状态**（floor 抖动、
 * 跳过数超 maxSkip），那会让守卫在宿主残留存在时变成不确定的红。两个方向的机制由
 * `exitConsistencyProblem` 在单元级用合成输入各测一次。
 *
 * @param {{fail: number|null, status: number|null}} input
 * @returns {string|null} 问题描述；一致时 null。
 */
function swallowedFailureProblem({ fail, status }) {
  if (fail === null || fail === undefined || typeof status !== 'number') {
    return '没有拿到 fail 计数或退出码，无法判断失败是否被吞';
  }
  if (fail > 0 && status === 0) {
    return `套件报了 ${fail} 条失败却 exit 0：失败被吞掉了`;
  }
  return null;
}

/**
 * 完整的两向一致性判据（单元级负样本用；不用于真跑，理由见 `swallowedFailureProblem`）。
 *
 * @param {{fail: number|null, status: number|null}} input
 * @returns {string|null} 问题描述；一致时 null。
 */
function exitConsistencyProblem({ fail, status }) {
  if (fail === null || fail === undefined || typeof status !== 'number') {
    return '没有拿到 fail 计数或退出码，无法判断一致性';
  }
  if (fail > 0 && status === 0) {
    return `套件报了 ${fail} 条失败却 exit 0：失败被吞掉`;
  }
  if (fail === 0 && status !== 0) {
    return `0 失败却 exit ${status}：退出码红了但不是失败计数（floor / 跳过上限 / 被改写）`;
  }
  return null;
}

/** Read one summary counter the same way scripts/run-tests.mjs does (last match wins). */
function readCounter(output, name) {
  const matches = [...output.matchAll(new RegExp(`^[#ℹ]\\s*${name}\\s+(\\d+)$`, 'gmu'))];
  return matches.length === 0 ? null : Number(matches[matches.length - 1][1]);
}

describe('R6-001：门禁链的机械判据', () => {
  it('npm test 链里逐字包含两段，脚本存在、floor>0、glob 真能匹配到文件', () => {
    const { problems, chain } = checkGate(PACKAGE_JSON);
    assert.deepEqual(problems, [], `门禁链不合格：\n${problems.join('\n')}`);
    for (const segment of REQUIRED_SEGMENTS) {
      assert.equal(chain.includes(segment.command), true, `${segment.command} 不在链里`);
    }
  });

  it('喂给同一检查器一份删掉该段的 package.json：两段都必须报缺（检查器可红）', () => {
    assert.equal(fs.existsSync(NEGATIVE_PACKAGE), true, `负样本不存在：${NEGATIVE_PACKAGE}`);
    const negative = checkGate(NEGATIVE_PACKAGE);
    assert.notEqual(negative.problems.length, 0, '删掉两段后检查器仍然全绿：它就是恒真的');
    for (const segment of REQUIRED_SEGMENTS) {
      assert.equal(
        negative.problems.some((problem) => problem.includes(segment.command)),
        true,
        `负样本里缺 ${segment.command} 却没有被报出来：${negative.problems.join(' | ')}`,
      );
      assert.equal(negative.chain.includes(segment.command), false);
    }
    // Control: the unmodified package must still pass the same checker.
    assert.deepEqual(checkGate(REAL_PACKAGE).problems, []);
  });

  it('floor=0 与空 glob 会被同一检查器拒绝（floor 检查不是恒真）', (t) => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-close-r6-001-'));
    const broken = {
      ...pkg,
      scripts: {
        ...pkg.scripts,
        'test:installer': 'npm run node:check && node scripts/run-tests.mjs 0 "tests/installer/**/*.test.js" 4',
        'test:console-i18n': 'npm run node:check && node scripts/run-tests.mjs 36 "tests/does-not-exist/**/*.test.js" 0',
      },
    };
    try {
      const tempPackage = path.join(tempDir, 'package.json');
      fs.writeFileSync(tempPackage, JSON.stringify(broken, null, 2), 'utf8');
      const { problems } = checkGate(tempPackage);
      assert.equal(problems.some((problem) => problem.includes('test:installer 的 floor 必须 > 0')), true,
        `floor=0 没有被抓住：${problems.join(' | ')}`);
      assert.equal(problems.some((problem) => problem.includes('没有匹配到任何测试文件')), true,
        `空 glob 没有被抓住：${problems.join(' | ')}`);
      t.diagnostic(`synthetic package.json: ${tempPackage}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('吞失败文本（|| / exit 0）被同一检查器拒绝 —— 用合成输入做单元负样本', () => {
    // Synthetic, no real run involved: the checker must reject every "make it green" rewrite.
    const cases = [
      { text: 'npm run test:wp0 && npm run test:installer || true', why: '|| true 兜底' },
      { text: 'npm run test:wp0 && npm run test:installer; exit 0', why: '; exit 0' },
      { text: 'npm run test:wp0 || npm run test:installer', why: '|| 短路' },
      { text: 'true', why: '整条链变成 true' },
    ];
    for (const item of cases) {
      const problems = swallowRewriteProblems(item.text);
      assert.notEqual(problems.length, 0, `吞失败文本没有被抓住：${item.why}（${item.text}）`);
    }
    // Control: the real chain (only && separators) must be clean, otherwise the check is恒真.
    assert.deepEqual(swallowRewriteProblems(JSON.parse(fs.readFileSync(REAL_PACKAGE, 'utf8')).scripts.test), []);
    // And the negative-sample package on disk (删段) must still be caught for a different reason.
    const negative = checkGate(NEGATIVE_PACKAGE);
    assert.notEqual(negative.problems.length, 0);
  });

  it('输出一致性判据（纯函数）：fail>0+exit0 与 fail=0+exit1 两个方向都能抓', () => {
    // Direction 1: a red suite that exits 0 = swallowed failure.
    assert.notEqual(exitConsistencyProblem({ fail: 2, status: 0 }), null);
    // Direction 2: a green suite that exits non-zero = gate red for another reason (floor/skip/wrapper).
    assert.notEqual(exitConsistencyProblem({ fail: 0, status: 1 }), null);
    // Consistent pairs must pass, in both directions.
    assert.equal(exitConsistencyProblem({ fail: 0, status: 0 }), null);
    assert.equal(exitConsistencyProblem({ fail: 3, status: 1 }), null);
    // The real-run-only judgement must catch the swallow direction and stay quiet on the other.
    assert.notEqual(swallowedFailureProblem({ fail: 2, status: 0 }), null);
    assert.equal(swallowedFailureProblem({ fail: 0, status: 1 }), null);
    // Unknown counters are not "pass".
    assert.notEqual(swallowedFailureProblem({ fail: null, status: 0 }), null);
  });
});

describe('R6-001：真跑两段（只证明"在跑 + 条数够 + 失败没被吞"，不要求套件绿）', () => {
  it('summary 存在、tests>=floor、fail>0 时不得 exit 0；跳过数只记录不判定', () => {
    if (NESTED) {
      // Being executed *by* `npm run test:installer` (or by our own deliberate child).
      // Do NOT spawn the suite again. What can be honestly asserted here is: this really is
      // the gate context, and the static chain verdict still holds.
      assert.equal(
        LIFECYCLE === 'test:installer' || CHILD_ENV,
        true,
        `nested run without a recognisable gate context (lifecycle=${LIFECYCLE || 'none'})`,
      );
      const { problems } = checkGate(PACKAGE_JSON);
      assert.deepEqual(problems, [], `门禁链在嵌套上下文里不合格：\n${problems.join('\n')}`);
      console.log(
        `[R6-001] nested gate context (lifecycle=${LIFECYCLE || 'none'}); `
        + 'spawn of npm run test:installer suppressed; static chain OK',
      );
      return;
    }

    if (NEGATIVE_DIAGNOSTIC_RUN) {
      // This is a negative-sample run (doctored package.json). The real-run truth is not
      // needed to judge a static criterion, and re-running a 90 s suite here would only add
      // host-state noise; what is asserted is that the doctored input IS rejected.
      const { problems } = checkGate(PACKAGE_JSON);
      assert.notEqual(problems.length, 0, '负样本诊断跑应当喂进一份会被拒绝的 package.json');
      console.log(`[R6-001] negative-sample run; real suite spawn skipped; problems=${problems.length}`);
      return;
    }

    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.startsWith('NODE_TEST') === false),
    );
    childEnv.DEFECT_CLOSE_R6_001_CHILD = '1';

    for (const segment of REQUIRED_SEGMENTS) {
      const body = pkg.scripts?.[segment.name];
      const match = SCRIPT_FORM.exec(String(body));
      assert.notEqual(match, null, `${segment.name} 不是 floor 形式`);
      const floor = Number(match[1]);
      assert.equal(Number.isInteger(floor) && floor > 0, true, `${segment.name} 缺少正 floor`);

      const result = spawnSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `npm run ${segment.name}`],
        { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: childEnv },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const tests = readCounter(output, 'tests');
      const failed = readCounter(output, 'fail');
      const skipped = readCounter(output, 'skipped');

      // 1) The suite really ran: a summary with a test count must exist.
      assert.notEqual(tests, null, `${segment.name} 没有产出 test summary（套件根本没跑起来）：\n${output.slice(-2000)}`);
      // 2) The floor mechanism is really exercised: the count must reach the floor.
      assert.equal(tests >= floor, true, `${segment.name} 只跑了 ${tests} 条 < floor ${floor}`);
      // 3) Failures must not be swallowed (the one deterministic direction, see swallowedFailureProblem).
      const swallowed = swallowedFailureProblem({ fail: failed, status: result.status });
      assert.equal(swallowed, null, `${segment.name}: ${swallowed}`);

      // Host-state readings (skip count, current reds) are RECORDED, not asserted: a machine with a
      // leftover real installation must not turn this guard red, otherwise the artifact is
      // non-deterministic. The skip-ceiling/floor invariants are the suite's own gate's job.
      console.log(
        `[R6-001] ${segment.name}: tests=${tests} (floor ${floor}) fail=${failed} `
        + `skipped=${skipped} exit=${result.status}`,
      );
    }
  });
});
