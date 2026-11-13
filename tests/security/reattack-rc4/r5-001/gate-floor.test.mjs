/**
 * R5-001（原 P1-4「门禁未闭合」）独立攻击用例：`test:wp6-model-broker` 的 floor 是否真闭合。
 *
 * 攻击面：`node --test` 在 glob 匹配不到文件时 exit 0；`scripts/run-tests.mjs`
 * 用**第一个位置参数（floor）**把"实际跑到的条数"钉住（比较的是 `# tests`/`ℹ tests`
 * 计数，含 skipped 与 todo）。若 floor 远低于现场条数，整文件删除 / 大批删测仍然绿。
 *
 * 本用例只信当前工作树的原始输出，不读任何修复方自证材料、不写仓库文件。
 * 行为证明会建 `%TEMP%` 下的 tests 副本（删掉整份 test 文件）并用**同一个**
 * `scripts/run-tests.mjs` 跑；`apps/`、`packages/` 以 Windows directory junction
 * 指回仓库（测试文件里的相对 import 因此仍可解析），跑完清理（RC4_KEEP_TMP=1 可保留）。
 *
 * 一键复跑（仓库根）：
 *   node --test tests/security/reattack-rc4/r5-001/gate-floor.test.mjs
 *
 * 变异开关（证明"删掉门禁下限后本用例必有测试转红"）：
 *   RC4_PKG_JSON=<%TEMP% 下的 package.json 变异副本> node --test tests/security/reattack-rc4/r5-001/gate-floor.test.mjs
 *   M1：副本里删掉 floor 参数            -> R5-001-A 红（下限缺失 = fail-open）
 *   M2：副本里 floor 改回旧值 122        -> R5-001-B 红（假绿空间 = 实测 - 122）
 *   M3：本用例 R5-001-D 自带：删掉 36 条测试的 %TEMP% 副本 -> runner 必须 exit != 0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-tests.mjs');
const DEFAULT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const PACKAGE_JSON = process.env.RC4_PKG_JSON
  ? path.resolve(process.env.RC4_PKG_JSON)
  : DEFAULT_PACKAGE_JSON;

const SCRIPT_NAME = 'test:wp6-model-broker';
const EXPECTED_SUITE_DIR = 'tests/wp6-model-broker';
/** 删掉这一整份文件 = 一次性删掉 36 条测试（2026-11-05 实测，见 evidence/per-file-counts.log）。 */
const DROPPED_TEST_FILES = ['console-host.test.js'];
const MAX_BUFFER = 64 * 1024 * 1024;
const NODE = process.execPath;

function tail(text, lines = 25) {
  return String(text ?? '').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
}

function readPackageJson() {
  assert.ok(fs.existsSync(PACKAGE_JSON), `package.json 不存在：${PACKAGE_JSON}`);
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
}

/** 与 shell 无关的最小分词：保留双/单引号内的字符串（glob 通常被引号包住）。 */
function tokenize(text) {
  return text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripQuotes(token) {
  return token.replace(/^["']|["']$/g, '');
}

/**
 * 解析 `test:wp6-model-broker` 对 run-tests.mjs 的调用。
 * @returns {{ok: boolean, script: string | null, floorToken: string | null, glob: string | null,
 *            maxSkipToken: string | null, problems: string[]}}
 */
function parseGateScript(pkg) {
  const script = pkg?.scripts?.[SCRIPT_NAME];
  if (typeof script !== 'string' || script.trim() === '') {
    return {
      ok: false, script: null, floorToken: null, glob: null, maxSkipToken: null,
      problems: [`package.json 没有 script "${SCRIPT_NAME}"（该段完全进不了门禁）`],
    };
  }
  const marker = 'run-tests.mjs';
  const at = script.indexOf(marker);
  if (at < 0) {
    return {
      ok: false, script, floorToken: null, glob: null, maxSkipToken: null,
      problems: [`"${SCRIPT_NAME}" 没有调用 scripts/run-tests.mjs：${script}`],
    };
  }
  const argv = tokenize(script.slice(at + marker.length));
  const floorToken = argv[0] ?? null;
  const globToken = argv[1] ?? null;
  const maxSkipToken = argv[2] ?? null;
  const glob = globToken === null ? null : stripQuotes(globToken);
  const problems = [];
  if (floorToken === null) {
    problems.push('run-tests.mjs 后面没有任何参数：floor 与 glob 全部缺失');
  } else if (!/^\d+$/.test(floorToken)) {
    problems.push(
      `run-tests.mjs 的第一个参数不是纯数字 floor，而是 ${JSON.stringify(floorToken)}`
        + '（floor 缺失/被挪位 -> run-tests 退化为只跑不钉条数）',
    );
  }
  if (glob === null) {
    problems.push('run-tests.mjs 缺少第二个参数（测试 glob）');
  } else if (!glob.includes(EXPECTED_SUITE_DIR)) {
    problems.push(`测试 glob 不是 ${EXPECTED_SUITE_DIR}/**：${JSON.stringify(glob)}`);
  }
  return { ok: problems.length === 0, script, floorToken, glob, maxSkipToken, problems };
}

/** 与 scripts/run-tests.mjs 相同的计数口径：取**最后一条** summary 行，防被用例输出伪造。 */
function readCounter(output, name) {
  const matches = [...String(output).matchAll(new RegExp(`^[#ℹ]\\s*${name}\\s+(\\d+)$`, 'gmu'))];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

function parseAllCounters(output) {
  return {
    tests: readCounter(output, 'tests'),
    pass: readCounter(output, 'pass'),
    fail: readCounter(output, 'fail'),
    skipped: readCounter(output, 'skipped'),
    todo: readCounter(output, 'todo'),
  };
}

/**
 * 本用例自身就跑在 `node --test` 里：Node 24 会把 `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID`
 * 传给子进程，导致再 spawn 的 `node --test` 判定"递归调用"而直接跳过（拿不到 `# tests`）。
 * 行为证明必须真跑独立测试进程，所以显式清掉这两个环境变量。
 */
function childEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

/** 直接跑 `node --test --test-reporter=tap <glob>`（独立口径 1：TAP 的 `# tests`）。 */
function runTap(glob) {
  const result = spawnSync(NODE, ['--test', '--test-reporter=tap', glob], {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { result, output, counts: parseAllCounters(output) };
}

/** 真跑 `scripts/run-tests.mjs <floor> <glob> [maxSkip]`（独立口径 2：runner 自己的回执）。 */
function runGate(floorToken, glob, maxSkipToken) {
  const args = [RUNNER, String(floorToken), glob];
  if (maxSkipToken !== null && maxSkipToken !== undefined) args.push(String(maxSkipToken));
  const result = spawnSync(NODE, args, {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return { result, output, counts: parseAllCounters(output) };
}

/**
 * 建 `%TEMP%` 下的测试树：复制 tests/wp6-model-broker，删掉指定文件，
 * 再用 directory junction 把 apps/ 与 packages/ 指回仓库（相对 import 仍可解析）。
 */
function buildTempSuiteTree(droppedFiles) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rc4-r5-001-'));
  const copyDir = path.join(base, 'tests', 'wp6-model-broker');
  fs.cpSync(path.join(REPO_ROOT, 'tests', 'wp6-model-broker'), copyDir, { recursive: true });
  for (const name of droppedFiles) {
    const victim = path.join(copyDir, name);
    assert.ok(fs.existsSync(victim), `%TEMP% 副本里找不到要删的文件 ${name}`);
    fs.rmSync(victim);
  }
  const links = [];
  for (const name of ['apps', 'packages']) {
    const linkPath = path.join(base, name);
    const target = path.join(REPO_ROOT, name);
    fs.symlinkSync(target, linkPath, 'junction');
    links.push(linkPath);
  }
  const glob = path.join(copyDir, '**', '*.test.js').split(path.sep).join('/');
  return { base, copyDir, links, glob };
}

/** 清理临时树：只 rmdir junction 本身（绝不递归进仓库），再删副本目录。 */
function cleanupTempSuiteTree(tree) {
  if (process.env.RC4_KEEP_TMP === '1') {
    console.log(`[R5-001] RC4_KEEP_TMP=1，保留临时树：${tree.base}`);
    return;
  }
  for (const linkPath of tree.links) {
    if (!fs.existsSync(linkPath)) continue;
    const target = path.resolve(fs.readlinkSync(linkPath));
    const expected = [
      path.join(REPO_ROOT, 'apps'),
      path.join(REPO_ROOT, 'packages'),
    ].map((item) => path.resolve(item).toLowerCase());
    assert.ok(
      expected.includes(target.toLowerCase()),
      `拒绝清理可疑联接（目标不在仓库内）：${linkPath} -> ${target}`,
    );
    fs.rmdirSync(linkPath);
  }
  fs.rmSync(tree.base, { recursive: true, force: true });
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'apps', 'model-broker', 'package.json')),
    '清理后仓库 apps/model-broker 不见了，临时树清理路径异常',
  );
}

// 现场条数只测一次（TAP 全量约 20s），R5-001-B/C/D 共用。
// 注：wp6 套件里 lifecycle.test.js 的「超时：按上界结清债务」是时序竞态用例，
// 实测 7 次全量跑中出现过 1 次红（与 floor 无关）。这里对"整段红"重试一次并
// 在输出里明示，两次都红才判红 —— 不掩盖套件稳定性问题，也不让 flake 冒充变异。
function runTapStable(glob) {
  const first = runTap(glob);
  if (first.result.status === 0 && (first.counts.fail ?? 0) === 0) {
    return first;
  }
  console.log(
    `[R5-001] 首次 TAP 全量跑非 0（exit ${first.result.status}, fail ${first.counts.fail ?? '?'}），`
      + `按已知时序 flake 重试一次；首次尾部：\n${tail(first.output, 8)}`,
  );
  return runTap(glob);
}

let cachedMeasurement = null;
function measureSuite(glob) {
  if (cachedMeasurement === null) {
    const run = runTapStable(glob);
    assert.equal(
      run.result.status,
      0,
      `node --test --test-reporter=tap 未通过（exit ${run.result.status}）：\n${tail(run.output)}`,
    );
    assert.ok(run.counts.tests !== null && run.counts.tests > 0,
      `TAP 输出里没有 # tests 计数：\n${tail(run.output)}`);
    assert.equal(run.counts.fail ?? 0, 0,
      `现场已有 ${run.counts.fail} 条失败用例，无法把该数当作门禁基线：\n${tail(run.output)}`);
    cachedMeasurement = run;
  }
  return cachedMeasurement;
}

test('R5-001-A :: package.json 的 test:wp6-model-broker 必须带数值 floor 调用 run-tests.mjs', () => {
  const parsed = parseGateScript(readPackageJson());
  assert.deepEqual(parsed.problems, [], parsed.problems.join('；'));
  const floor = Number(parsed.floorToken);
  assert.ok(Number.isInteger(floor), `floor 不是整数：${JSON.stringify(parsed.floorToken)}`);
  assert.ok(floor > 0, `floor 必须是正整数（0/负数 = 门禁失效），实测 ${JSON.stringify(parsed.floorToken)}`);
  assert.ok(floor <= 1_000_000, `floor=${floor} 荒谬，超大值会把正常删测判红`);
  console.log(`[R5-001-A] pkg=${PACKAGE_JSON} script=${parsed.script}`);
  console.log(`[R5-001-A] floor=${floor} glob=${parsed.glob} maxSkip=${parsed.maxSkipToken}`);
});

test('R5-001-B :: floor 必须 >= 现场实测条数（否则删测假绿空间 > 0）', () => {
  const parsed = parseGateScript(readPackageJson());
  assert.deepEqual(parsed.problems, [], parsed.problems.join('；'));
  const floor = Number(parsed.floorToken);
  const measured = measureSuite(parsed.glob);
  const actual = measured.counts.tests;
  const slack = actual - floor;
  console.log(
    `[R5-001-B] 实测 ${actual} 条（pass ${measured.counts.pass}/fail ${measured.counts.fail}`
      + `/skip ${measured.counts.skipped}/todo ${measured.counts.todo}），floor=${floor}，假绿空间=${slack}`,
  );
  assert.ok(
    floor >= actual,
    `floor=${floor} < 实测 ${actual} 条：当前门禁下删掉 ${slack} 条测试仍然绿（假绿空间 ${slack} > 0）`,
  );
  assert.ok(
    floor <= actual * 2,
    `floor=${floor} > 实测 ${actual}×2 = ${actual * 2}，疑似荒谬值（正常回归会被冤枉判红）`,
  );
});

test('R5-001-C :: 用 package.json 里的 floor 真跑 runner 必须 exit 0 且条数 == 实测', () => {
  const parsed = parseGateScript(readPackageJson());
  assert.deepEqual(parsed.problems, [], parsed.problems.join('；'));
  const measured = measureSuite(parsed.glob);
  let gate = runGate(parsed.floorToken, parsed.glob, parsed.maxSkipToken);
  if (gate.result.status !== 0) {
    console.log(
      `[R5-001-C] 首次 runner 非 0（exit ${gate.result.status}, fail ${gate.counts.fail ?? '?'}），`
        + `按已知时序 flake 重试一次；首次尾部：\n${tail(gate.output, 8)}`,
    );
    gate = runGate(parsed.floorToken, parsed.glob, parsed.maxSkipToken);
  }
  assert.equal(
    gate.result.status,
    0,
    `当前脚本的 floor 跑 runner 竟然 exit ${gate.result.status}：\n${tail(gate.output)}`,
  );
  assert.equal(
    gate.counts.tests,
    measured.counts.tests,
    `runner 回报条数 ${gate.counts.tests} != TAP 实测 ${measured.counts.tests}`,
  );
  assert.equal(gate.counts.fail ?? 0, 0, `runner 下出现 ${gate.counts.fail} 条失败`);
  assert.match(
    gate.output,
    new RegExp(`run-tests: ${measured.counts.tests} test\\(s\\) ran`),
    'runner 没有打印预期的条数回执',
  );
});

test('R5-001-D :: 当前 floor 下「删掉整份 test 文件」的 %TEMP% 副本必须 exit != 0', () => {
  const parsed = parseGateScript(readPackageJson());
  assert.deepEqual(parsed.problems, [], parsed.problems.join('；'));
  const floor = Number(parsed.floorToken);
  const measured = measureSuite(parsed.glob);
  const tree = buildTempSuiteTree(DROPPED_TEST_FILES);
  try {
    let gate = runGate(parsed.floorToken, tree.glob, parsed.maxSkipToken);
    let floorHit = gate.output.match(
      /ran (\d+) test\(s\) but this suite must run at least (\d+)\./,
    );
    if (gate.result.status !== 0 && floorHit === null) {
      // 已知时序 flake 会让"删了也没用"的判据失真：只有「floor 拦下」才算数，否则重试一次。
      console.log(
        `[R5-001-D] 首次 runner 非 0 但不是 floor 拦的（exit ${gate.result.status}），`
          + `按已知时序 flake 重试一次；首次尾部：\n${tail(gate.output, 12)}`,
      );
      gate = runGate(parsed.floorToken, tree.glob, parsed.maxSkipToken);
      floorHit = gate.output.match(
        /ran (\d+) test\(s\) but this suite must run at least (\d+)\./,
      );
    }
    console.log(
      `[R5-001-D] 临时树 ${tree.glob}\n[R5-001-D] 删除 ${DROPPED_TEST_FILES.join(',')} 后 runner `
        + `exit=${gate.result.status} tests=${gate.counts.tests} fail=${gate.counts.fail}`,
    );
    assert.notEqual(
      gate.result.status,
      0,
      `删掉 ${DROPPED_TEST_FILES.join(',')} 后 runner 仍 exit 0 —— 门禁假绿：\n${tail(gate.output)}`,
    );
    assert.ok(
      floorHit !== null,
      `转红原因不是「条数低于 floor」（可能测试本身报错，不能算变异证明）：\n${tail(gate.output)}`,
    );
    const ranCount = Number(floorHit[1]);
    assert.equal(Number(floorHit[2]), floor, 'runner 回报的 floor 与 package.json 解析值不一致');
    assert.ok(ranCount < measured.counts.tests, `删文件后条数 ${ranCount} 未低于现场 ${measured.counts.tests}`);
    const dropped = measured.counts.tests - ranCount;
    console.log(`[R5-001-D] 实测被删掉 ${dropped} 条（现场 ${measured.counts.tests} -> 副本 ${ranCount}）`);
    assert.ok(dropped >= 1, `删除后条数没有下降（dropped=${dropped}），副本构造失败`);
  } finally {
    cleanupTempSuiteTree(tree);
  }
});

test('R5-001-E :: runner 第三参数 maxSkip 必须显式给出（否则 test.skip 整批绕过条数 floor）', () => {
  const parsed = parseGateScript(readPackageJson());
  assert.deepEqual(parsed.problems, [], parsed.problems.join('；'));
  assert.notEqual(
    parsed.maxSkipToken,
    null,
    'test:wp6-model-broker 未传第三参数 maxSkip：node --test 的 # tests 把 skipped 计入条数，'
      + '整文件 test.skip 不会让 floor 转红，跳过数可以悄悄涨',
  );
  const maxSkip = Number(parsed.maxSkipToken);
  assert.ok(
    Number.isInteger(maxSkip) && maxSkip >= 0 && maxSkip <= 5,
    `maxSkip 必须是非负小整数，实测 ${JSON.stringify(parsed.maxSkipToken)}`,
  );
});
