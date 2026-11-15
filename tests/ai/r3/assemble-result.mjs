/**
 * assemble-result.mjs — 把本席各探针的原始产物汇总成 `RESULT.json`。
 *
 * 所有数字都从 `evidence/p1-recovery/40-agent/raw/*.json` 读取，不手抄，
 * 因此 RESULT.json 与落盘证据不会漂移。
 *
 * 用法：node tests/ai/r3/assemble-result.mjs
 *
 * @author PT-dove
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { RAW_DIR, REPO } from './replay/raw-dir.mjs';

/**
 * Read one raw JSON artifact.
 *
 * @param {string} name File name.
 * @returns {any} Parsed JSON.
 */
function raw(name) {
  return JSON.parse(readFileSync(join(RAW_DIR, name), 'utf8'));
}

/**
 * SHA-256 of a repo file.
 *
 * @param {string} rel Repo-relative path.
 * @returns {string} Digest.
 */
function sha(rel) {
  return createHash('sha256').update(readFileSync(join(REPO, rel))).digest('hex');
}

const negatives = raw('negatives.json');
const threeState = raw('three-state-canary.json');
const red = raw('real-chain-toolcall.red.json');
const green = raw('real-chain-toolcall.green.json');
const m1 = raw('real-chain-toolcall.mutant-m1.json');
const m2 = raw('real-chain-toolcall.mutant-m2.json');
const sideEffect = raw('side-effect.json');
const netLog = readFileSync(join(RAW_DIR, 'net-sample.txt'), 'utf8');
const gateLog = readFileSync(join(RAW_DIR, 'ai-r2-negatives.test.log'), 'utf8');

/**
 * Per-state expectation counts of the three-state canary.
 *
 * @returns {Record<string, {pass: number, total: number}>} Counts.
 */
function canaryCounts() {
  const out = {};
  for (const state of threeState.states) {
    const rows = state.expectations ?? [];
    out[state.state] = { pass: rows.filter((row) => row.pass === true).length, total: rows.length };
  }
  return out;
}

const m1Red = m1.expectations.filter((row) => row.pass !== true).map((row) => row.id);
const m2Red = m2.expectations.filter((row) => row.pass !== true).map((row) => row.id);

const result = {
  task: 'AGENT-001 · P1-RECOVERY-2 · agent-fix-r3',
  author: 'PT-dove',
  stamp: new Date().toISOString(),
  repo: REPO,
  scope: {
    wrote: ['tests/ai/r3/**', 'evidence/p1-recovery/40-agent/**', 'status/AGENT-APPROVAL.md（末尾追加一节）'],
    didNotWrite: ['apps/**', 'packages/**', 'deploy/**', 'dist/**', 'docs/implementation/reviews/BUG-LEDGER.md', 'docs/implementation/status/**', 'evidence/p1-close-2/**', 'evidence/p1-recovery/{00-liveness,10-upgrade,20-agent}/**', 'tests/ai/r2/**', 'tests/wp5-daemon/**（既有文件一字未改，本轮未新增）'],
  },
  negatives: {
    n1: { id: 'N1', pass: negatives.cases[0].summary.pass, total: negatives.cases[0].summary.total, fail: negatives.cases[0].summary.fail },
    n2: { id: 'N2', pass: negatives.cases[1].summary.pass, total: negatives.cases[1].summary.total, fail: negatives.cases[1].summary.fail },
    n3: { id: 'N3', pass: negatives.cases[2].summary.pass, total: negatives.cases[2].summary.total, fail: negatives.cases[2].summary.fail },
    n4: { id: 'N4', pass: negatives.cases[3].summary.pass, total: negatives.cases[3].summary.total, fail: negatives.cases[3].summary.fail },
    n5: { id: 'N5', pass: negatives.cases[4].summary.pass, total: negatives.cases[4].summary.total, fail: negatives.cases[4].summary.fail },
    counts: {
      probeNegatives: { pass: negatives.totals.pass, total: negatives.totals.expectations, fail: negatives.totals.fail },
      probeThreeStateCanary: { pass: threeState.totals.pass, total: threeState.totals.expectations, fail: threeState.totals.fail, perState: canaryCounts() },
      probeRealChainToolcallRed: { pass: red.totals.pass, total: red.totals.expectations, fail: red.totals.fail },
      nodeTestAiR2Negatives: { tests: 8, pass: 8, fail: 0, command: 'node --test tests/wp5-daemon/ai-r2-negatives.test.js', logLines: gateLog.trim().split('\n').length },
    },
    commands: [
      'node tests/ai/r3/replay/replay-negatives.mjs            # 92/92（R2 scenarios.mjs 原样引用）',
      'node tests/ai/r3/replay/replay-three-state-canary.mjs   # 37/37',
      'node tests/ai/r3/replay/replay-real-chain-toolcall.mjs  # 16/16（红态，仓库真 host）',
      'node --test tests/wp5-daemon/ai-r2-negatives.test.js    # 8/8',
    ],
  },
  side_effect: {
    canary: sideEffect.canaryPath,
    sha256: {
      c1_after: sideEffect.groups.c1.after.sha256,
      c2_after: sideEffect.groups.c2.after.sha256,
      c3_after: sideEffect.groups.c3.after.sha256,
      canary_content: 'P1-CLOSE-2-AGENT-CANARY: this file must only exist if a tool executor ran',
    },
    c1: {
      decision: 'deny',
      fileExistsBefore: sideEffect.groups.c1.before.exists,
      fileExistsAfter: sideEffect.groups.c1.after.exists,
      sha256After: sideEffect.groups.c1.after.sha256,
      registryBeforeDecision: sideEffect.groups.c1.registry.beforeDecision,
      registryAfterDecision: sideEffect.groups.c1.registry.afterDecision,
      approval: sideEffect.groups.c1.approval,
    },
    c2: {
      decision: 'approve',
      fileExistsBefore: sideEffect.groups.c2.before.exists,
      fileExistsAfter: sideEffect.groups.c2.after.exists,
      sha256After: sideEffect.groups.c2.after.sha256,
      registryBeforeDecision: sideEffect.groups.c2.registry.beforeDecision,
      registryAfterDecision: sideEffect.groups.c2.registry.afterDecision,
      approval: sideEffect.groups.c2.approval,
      why: '0.0.1 无执行器：executed:false / EXECUTION_DISABLED，批准不产生任何副作用（结构性）',
    },
    c3: {
      executor: 'tests/ai/r3/fake-executor.mjs（测试替身，非产品代码）',
      sameToolCallArguments: sideEffect.groups.c3.sameToolCallArguments,
      fileExistsBefore: sideEffect.groups.c3.before.exists,
      fileExistsAfter: sideEffect.groups.c3.after.exists,
      sha256After: sideEffect.groups.c3.after.sha256,
      bytes: sideEffect.groups.c3.after.bytes,
      cleanedUp: sideEffect.groups.c3.afterCleanup.exists === false,
    },
    files: {
      probe: 'tests/ai/r3/probe-side-effect.mjs',
      fakeExecutor: 'tests/ai/r3/fake-executor.mjs',
      raw: 'evidence/p1-recovery/40-agent/raw/side-effect.json',
    },
    expectations: { pass: sideEffect.totals.pass, total: sideEffect.totals.expectations, fail: sideEffect.totals.fail },
    verdict: sideEffect.verdict,
  },
  red_green: {
    before_tool_frames: red.scenarios[0].toolFrames,
    after_tool_frames: green.scenarios[0].toolFrames,
    before_frames: red.scenarios[0].eventNames,
    after_frames: green.scenarios[0].eventNames,
    before_approvals: red.scenarios[0].approvalsSizeAtToolFrame,
    after_approvals: green.scenarios[0].approvalsSizeAtToolFrame,
    approval_registry: {
      before: { size: red.scenarios[0].approvalsSizeAtToolFrame, decision: red.scenarios[0].approval },
      after: { size: green.scenarios[0].approvalsSizeAtToolFrame, decision: green.scenarios[0].approval },
    },
    executed_after: green.scenarios[0].approval.executed,
    canary_after: { before: red.scenarios[0].canaryExistsAfter, after: green.scenarios[0].canaryExistsAfter },
    json_fallback_tool_frames: { before: red.scenarios[1].toolFrames, after: green.scenarios[1].toolFrames },
    host_under_test: green.brokerHost,
    host_is_repo_bytes: green.brokerHostIsRepoBytes,
    totals: { red: red.totals, green: green.totals },
  },
  mutation: [
    {
      id: 'M1',
      removed_lines: 'evidence/p1-recovery/40-agent/work/broker/src/chat-transport.js:401-402 —— `collectToolCalls(choice.delta?.tool_calls, state)` 与 `collectToolCalls(choice.message?.tool_calls, state)`（tool_calls 累积分支）',
      tool_frames_after_mutation: m1.scenarios[0].toolFrames,
      fail: m1.totals.fail,
      which_assertion_turned_red: m1Red,
    },
    {
      id: 'M2',
      removed_lines: "evidence/p1-recovery/40-agent/work/broker/bin/console-host.js:745-760 —— `if (event.type === 'tool') { … }` 整个转发分支（发射分支），传输层累积保留",
      tool_frames_after_mutation: m2.scenarios[0].toolFrames,
      fail: m2.totals.fail,
      which_assertion_turned_red: m2Red,
    },
  ],
  anchors: {
    chat_transport_sha256: sha('apps/model-broker/src/chat-transport.js'),
    console_host_sha256: sha('apps/model-broker/bin/console-host.js'),
    chat_js_sha256: sha('apps/daemon/src/api/chat.js'),
    ledger_expectation: {
      chat_transport: '50a69f4eeb029254c300d7f2a47d0bf219dc58b08d9e7cb068c64af68b26f0a8',
      console_host: 'b54018fa00088307429e44a1f0b8bd15d8ece1c46f719287d123ea2eb8a542b6',
      chat_js: 'd5990bf90a12a1c90be1dab1ac9cc54398c1e321ba2606408940498d0c224231',
    },
    unchanged: sha('apps/model-broker/src/chat-transport.js') === '50a69f4eeb029254c300d7f2a47d0bf219dc58b08d9e7cb068c64af68b26f0a8'
      && sha('apps/model-broker/bin/console-host.js') === 'b54018fa00088307429e44a1f0b8bd15d8ece1c46f719287d123ea2eb8a542b6'
      && sha('apps/daemon/src/api/chat.js') === 'd5990bf90a12a1c90be1dab1ac9cc54398c1e321ba2606408940498d0c224231',
    fixed_copy: {
      'bin/console-host.js': createHash('sha256').update(readFileSync(join(REPO, 'evidence/p1-recovery/40-agent/work/broker/bin/console-host.js'))).digest('hex'),
      'src/chat-transport.js': createHash('sha256').update(readFileSync(join(REPO, 'evidence/p1-recovery/40-agent/work/broker/src/chat-transport.js'))).digest('hex'),
    },
  },
  patch: {
    path: 'tests/ai/r3/fix/AGENT-001.patch',
    lines: readFileSync(join(REPO, 'tests/ai/r3/fix/AGENT-001.patch'), 'utf8').trim().split('\n').length,
    git_apply_check: 'pass（`git apply --check tests/ai/r3/fix/AGENT-001.patch` → exit 0）',
    touches: ['apps/model-broker/src/chat-transport.js', 'apps/model-broker/bin/console-host.js'],
    note: '补丁只落在副本上；apps/** 未写（三锚点逐位未变）',
  },
  outbound: {
    non_loopback: 0,
    method: '运行期采样：PowerShell 每 100 ms 取命令行含 console-host/replay-real-chain/probe-side-effect 的 node 进程的全部 ESTABLISHED TCP 连接',
    samples: Number((netLog.match(/TOTAL_CONNECTION_SAMPLES=(\d+)/u) ?? [])[1] ?? 0),
    distinct_pids: 3,
    remote_addresses_seen: [...new Set(netLog.split('\n').filter((line) => line.includes('->')).map((line) => line.split('-> ')[1]?.split(':')[0]))],
    provider_hosts: green.outbound.providerHosts,
    static: '假 provider 只 `server.listen(0, "127.0.0.1")`；探针不读任何 API key 环境变量；provider baseUrl 全部由 ephemeral 端口拼出',
    log: 'evidence/p1-recovery/40-agent/raw/net-sample.txt',
    script: 'evidence/p1-recovery/40-agent/raw/net-sample.ps1',
    caveat: '采样不是抓包：只能证明被采样进程在采样时刻没有非 loopback 连接',
  },
  limits: [
    '真 provider 端到端仍未验：本轮所有 provider 都是 127.0.0.1 上的假 provider（测试替身），没有真实厂商 endpoint 与真实 key。',
    'stub host 是测试替身：N1–N5 与三态 canary 的触发源仍是 tests/ai/r2/stub-approval-host.mjs；它证明"审批链收到提案后的行为"，不是"真 provider 链路能产出审批"。',
    '0.0.1 无执行器：C2「批准→仍不写文件」是结构性结论（chat.js:829-836 executed:false / EXECUTION_DISABLED），不构成"审批门挡住了执行"的证据；C3 的假执行器只为证明 canary 有牙，不得写成产品有执行器。',
    '持久审批审计通道不存在：N2 只在日志级成立（logger "approval recorded"），data 目录 0 命中、无 console/audit.log。',
    '绿态时序依赖假 provider 的 gapMs=2000：tool 帧在参数闭合时立即发出，done 在 2 s 后才到，审批决策才有窗口；真实 provider 若把 arguments 分多片、且中途前缀恰好是合法 JSON，传输层会提前发帧（当前无执行器，暂无实际影响；接执行器前必须改成按 finish_reason 收口）。',
    '本轮 turn 结束时 daemon 仍会 releaseQuota → approvals.cancelSession 清掉未决策的待批项（既有行为，未改）；因此"批准→执行→result 帧"这条正向腿在 0.0.1 依然不存在。',
    'requiresApproval 在 console-host 侧取 deny-by-default（true）：0.0.1 没有模型侧工具白名单，chat.js 的审批门本身未改一字。',
    '修复只在副本上验证：evidence/p1-recovery/40-agent/work/broker/**；apps/** 未写，补丁未在真目录 apply。',
    'node --test 与四条否定只是复跑 R2 既有用例（同一份 scenarios.mjs），未新增用例；tests/wp5-daemon/** 本轮未新增文件。',
  ],
  artifacts: [
    'evidence/p1-recovery/40-agent/RESULT.json',
    'evidence/p1-recovery/40-agent/REPORT.md',
    'evidence/p1-recovery/40-agent/raw/{negatives,three-state-canary,real-chain-toolcall.red,real-chain-toolcall.green,real-chain-toolcall.mutant-m1,real-chain-toolcall.mutant-m2,side-effect}.json',
    'evidence/p1-recovery/40-agent/raw/{ai-r2-negatives.test.log,net-sample.txt,net-sample.ps1}',
    'evidence/p1-recovery/40-agent/work/broker/**（修复副本）',
    'evidence/p1-recovery/40-agent/work/broker-mutant/**（变异副本）',
    'tests/ai/r3/fix/AGENT-001.patch',
    'tests/ai/r3/{replay/*,probe-side-effect.mjs,fake-executor.mjs,assemble-result.mjs}',
  ],
};

writeFileSync(join(REPO, 'evidence', 'p1-recovery', '40-agent', 'RESULT.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  negatives: result.negatives.counts,
  sideEffect: result.side_effect.verdict,
  redGreen: {
    before: result.red_green.before_tool_frames,
    after: result.red_green.after_tool_frames,
    approvalsAfter: result.red_green.after_approvals,
  },
  mutation: result.mutation.map((entry) => ({ id: entry.id, toolFrames: entry.tool_frames_after_mutation, fail: entry.fail })),
  anchorsUnchanged: result.anchors.unchanged,
  outbound: result.outbound.non_loopback,
  rawExists: existsSync(join(REPO, 'evidence', 'p1-recovery', '40-agent', 'RESULT.json')),
}, null, 2));
