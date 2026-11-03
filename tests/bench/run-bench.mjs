/**
 * run-bench.mjs — 性能基准入口。
 *
 * 用法：
 *   node tests/bench/run-bench.mjs                     # standard 档位
 *   node tests/bench/run-bench.mjs --profile quick     # 快速自检
 *   node tests/bench/run-bench.mjs --seed 1234 --out <dir>
 *   node tests/bench/run-bench.mjs --scenarios event-store,detection
 *   node tests/bench/run-bench.mjs --no-gate           # 只出报告，不因检查项退出非零
 *
 * 退出码：0 = 全部 blocker 检查通过；1 = 有 blocker 失败；2 = 运行本身出错。
 *
 * 这个入口**不进** `npm test`：根 `package.json` 不在本任务可改范围内，而且把性能
 * 门禁挂进单元测试会让一次 GC 抖动变成红构建。基准自己就是门禁。
 */

import process from 'node:process';

import { captureEnv, codeDigest } from './lib/env.js';
import {
  RESULT_SCHEMA,
  addCheck,
  evaluateChecks,
  renderMarkdown,
  stampOf,
  writeArtifacts,
} from './lib/report.js';
import { nowNs, elapsedMs } from './lib/stats.js';
import { createWorkload, workloadDigest } from './lib/synthetic.js';
import { createTempRoot } from './lib/tempdir.js';
import { runDaemonApiScenario } from './scenarios/daemon-api.js';
import { runDetectionScenario } from './scenarios/detection.js';
import { runEventStoreScenario } from './scenarios/event-store.js';

/** 可运行的场景表。顺序即是报告顺序：先存储、再检测、最后对外接口。 */
const SCENARIOS = Object.freeze({
  'event-store': { label: 'event-store', run: runEventStoreScenario },
  detection: { label: 'detection', run: runDetectionScenario },
  'daemon-api': { label: 'daemon-api', run: runDaemonApiScenario },
});

/** 默认种子。固定值，改它等于换了一套负载，历史数字立刻失去可比性。 */
const DEFAULT_SEED = 20261102;

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 参数（不含 node 与脚本名）。
 * @returns {{profile: string, seed: number, out: string|null, scenarios: string[],
 *   gate: boolean, list: boolean, help: boolean}} 选项。
 */
function parseArgs(argv) {
  const options = {
    profile: 'standard',
    seed: DEFAULT_SEED,
    out: null,
    scenarios: Object.keys(SCENARIOS),
    gate: true,
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case '--profile':
        options.profile = String(next);
        index += 1;
        break;
      case '--seed':
        options.seed = Number(next);
        index += 1;
        break;
      case '--out':
        options.out = String(next);
        index += 1;
        break;
      case '--scenarios':
        options.scenarios = String(next).split(',').map((entry) => entry.trim()).filter(Boolean);
        index += 1;
        break;
      case '--no-gate':
        options.gate = false;
        break;
      case '--list':
        options.list = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        // 未知参数直接失败：静默忽略会让"我明明传了 --profile standard"变成一次假运行。
        throw new Error(`unknown argument: ${token}`);
    }
  }
  if (!['quick', 'standard'].includes(options.profile)) {
    throw new Error(`--profile must be quick or standard, received ${options.profile}`);
  }
  if (!Number.isInteger(options.seed) || options.seed < 0) {
    throw new Error(`--seed must be a non-negative integer, received ${options.seed}`);
  }
  for (const name of options.scenarios) {
    if (!Object.prototype.hasOwnProperty.call(SCENARIOS, name)) {
      throw new Error(`unknown scenario: ${name} (known: ${Object.keys(SCENARIOS).join(', ')})`);
    }
  }
  return options;
}

/**
 * 打印用法。
 *
 * @returns {void}
 */
function printHelp() {
  process.stdout.write([
    'M9 性能基准',
    '',
    '  node tests/bench/run-bench.mjs [选项]',
    '',
    '  --profile <quick|standard>  负载规模（默认 standard）',
    '  --seed <整数>               负载种子（默认 20261102）',
    '  --scenarios <a,b>           只跑指定场景',
    '  --out <目录>                产物目录（默认 docs/implementation/evidence/bench）',
    '  --no-gate                   检查项失败也返回 0',
    '  --list                      列出场景后退出',
    '',
  ].join('\n'));
}

/**
 * 主流程。
 *
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`run-bench: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.list) {
    for (const [name, entry] of Object.entries(SCENARIOS)) {
      process.stdout.write(`${name}\t${entry.label}\n`);
    }
    return 0;
  }

  const runStart = nowNs();
  const generatedAt = new Date().toISOString();
  const tempRoot = createTempRoot('aegis-bench');
  const env = captureEnv({ tempRoot: tempRoot.root });
  process.stdout.write(`run-bench: profile=${options.profile} seed=${options.seed} scenarios=${options.scenarios.join(',')}\n`);
  process.stdout.write(`run-bench: node=${env.node.version} sqlite=${env.sqlite_version} cpus=${env.cpu.logical_cores}\n`);

  const scenarios = [];
  const checks = [];
  const raw = {};
  let runError = null;

  try {
    for (const name of options.scenarios) {
      const startedAt = nowNs();
      process.stdout.write(`run-bench: → ${name}\n`);
      const result = await SCENARIOS[name].run({
        seed: options.seed,
        profile: options.profile,
        tempRoot,
      });
      scenarios.push(result.scenario);
      for (const check of result.checks) {
        addCheck(checks, check);
      }
      // 负载摘要：证明"两次运行跑的是同一批负载"。没有它，换生成器后
      // 历史数字会静默失去可比性，而报告上看不出任何异常。
      // 注意 `event()` 只由序号派生（不消耗 PRNG），所以摘要与 label 无关。
      const digestWorkload = createWorkload({ seed: options.seed, label: name });
      result.raw.workload_digest = workloadDigest(
        Array.from({ length: 256 }, (_unused, offset) => digestWorkload.event(offset + 1)),
      );
      raw[name] = result.raw;
      const elapsed = elapsedMs(startedAt, nowNs());
      process.stdout.write(`run-bench:   ← ${name} ${(elapsed / 1000).toFixed(1)}s\n`);
    }
  } catch (error) {
    runError = error;
    process.stderr.write(`run-bench: scenario failed: ${error && error.stack ? error.stack : String(error)}\n`);
  } finally {
    tempRoot.cleanup();
  }

  // 运行结束时再算一次源码摘要：如果被测代码在运行期间被改过，这份证据就
  // 无法同时对应"开始时的代码"和"结束时的代码"。没有 git 时这是唯一能发现
  // 并发写者的手段（本次实测确实发生过：另一个会话在运行期间改了 pipeline.js）。
  const codeAfter = codeDigest();
  const codeStable = codeAfter.digest === env.code_digest.digest;
  addCheck(checks, {
    id: 'bench.code_stable_during_run',
    description: '被测量源码在本次运行期间未被修改（否则证据无法归因到某一版代码）',
    expected: env.code_digest.digest.slice(0, 16),
    actual: codeAfter.digest.slice(0, 16),
    passed: codeStable,
    note: codeStable
      ? undefined
      : '运行期间 packages/event-store/src、packages/detection/src 或 apps/daemon/src 有文件被改动；'
        + '本份数字应视为"跨两版代码"，需要重跑才能作为该版本的证据。',
  });

  const { verdict, failures, warnings } = evaluateChecks(checks);
  const durationMs = Number(elapsedMs(runStart, nowNs()).toFixed(3));
  const result = {
    schema: RESULT_SCHEMA,
    kind: 'bench',
    task_id: 'M9-BENCH-SOAK',
    author: 'PT-dove',
    generated_at: generatedAt,
    seed: options.seed,
    profile: options.profile,
    duration_ms: durationMs,
    env,
    code_digest_after: codeAfter,
    config: {
      scenarios: options.scenarios,
      gate_enabled: options.gate,
    },
    scenarios,
    checks,
    verdict: runError === null ? verdict : 'error',
    failures,
    warnings,
    findings: collectFindings(checks, scenarios),
    notes: [
      '所有写入都在系统临时目录内，跑完即删；未触碰任何真实数据库或日志。',
      '吞吐同时给"计时和口径"与"墙钟口径"两种：前者不含负载生成开销，后者含。',
      '分位数用精确秩（nearest-rank），不用直方图分桶，避免把尾延迟抹平。',
      'RSS 覆盖 SQLite 原生内存，heapUsed 不覆盖；只看 heapUsed 会得出"零增长"的假结论。',
      `本次未强制 GC（gc_exposed=${env.runtime.gc_exposed}），内存曲线受 GC 时机影响。`,
    ],
    limitations: [
      '单机、单进程、冷启动一次：**并发扫描每档已重复 3 次并报中位数与 CV**，'
        + '其余指标（吞吐、延迟、内存、备份）仍是单次运行，含机器噪声。',
      '**并发数字的绝对量级不可跨环境比较**：同一配置两次单次运行，status 在 c=32 的 p99 到过 19ms 与 61ms、'
        + '吞吐 3511 与 1101 req/s（约 3 倍差）。现在判据只看中位吞吐比值（>= 0.9）并把 CV 一并报出；'
        + '要比版本仍需独占机器重复 >= 5 次。',
      '本机空闲内存只有约 1.8 GiB，负载规模为此保守取值；结论不外推到更大数据量。',
      'SQLite 同步模式与页缓存策略按被测实现的默认值，未做调优对照。',
      'daemon API 只测只读路由；写路径（poll / 响应执行）不在本基准范围。',
      '并发扫描的负载生成器与被测 daemon 同进程同事件循环（独立复核 D-3 未修），'
        + '所以读到的是 inline 天花板，不是服务端独立进程的容量。',
      '未做 72h/7d 长稳；短时浸泡只能发现快速泄漏，不能证明长期稳定。',
    ],
    raw,
    artifacts: null,
  };

  const baseName = `bench-${options.profile}-${stampOf(generatedAt)}`;
  const markdown = renderMarkdown(result);
  const paths = writeArtifacts({ outDir: options.out ?? undefined, baseName, result: { ...result, artifacts: null }, markdown });
  // 产物路径要写回 JSON，所以再写一次（第二次内容只多两个路径字段，成本可忽略）。
  result.artifacts = paths;
  writeArtifacts({ outDir: options.out ?? undefined, baseName, result, markdown });

  process.stdout.write(`run-bench: verdict=${result.verdict} checks=${checks.length} failures=${failures.length} warnings=${warnings.length}\n`);
  process.stdout.write(`run-bench: json=${paths.json_path}\n`);
  process.stdout.write(`run-bench: markdown=${paths.markdown_path}\n`);
  if (failures.length > 0) {
    process.stdout.write(`run-bench: failing checks: ${failures.join(', ')}\n`);
  }

  if (runError !== null) {
    return 2;
  }
  if (options.gate === false) {
    return 0;
  }
  return verdict === 'pass' ? 0 : 1;
}

/**
 * 从检查项里提炼"发现"。
 *
 * 检查项回答"是否达标"，发现回答"看到了什么、值不值得跟进"。失败的 blocker
 * 会自动变成一条发现，避免报告里只有一行 FAIL 而没有解释。
 *
 * @param {object[]} checks 检查项。
 * @param {object[]} scenarios 场景。
 * @returns {object[]} 发现列表。
 */
function collectFindings(checks, scenarios) {
  const findings = [];
  for (const check of checks) {
    if (check.passed === false) {
      findings.push({
        id: `F-${findings.length + 1}`,
        severity: check.severity === 'warn' ? 'P2' : 'P1',
        title: check.description,
        detail: `期望 ${JSON.stringify(check.expected)}，实测 ${JSON.stringify(check.actual)}。`
          + (check.note === undefined ? '' : ` ${check.note}`),
        source_check: check.id,
        scope: 'observed-only',
      });
    }
  }
  // 场景自报的观察不进 findings（那是对数字的解释），只有检查失败才进。
  void scenarios;
  return findings;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`run-bench: fatal: ${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 2;
});
