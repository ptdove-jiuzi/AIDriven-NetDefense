/**
 * replay-negatives.mjs — P1-RECOVERY-2 · agent-fix-r3 复跑四条否定用例。
 *
 * 与 R2 `tests/ai/r2/probe-negatives.mjs` **同一份场景实现**（`tests/ai/r2/lib/scenarios.mjs`，
 * 未改一行），差别只有两处：产物写到 `evidence/p1-recovery/40-agent/raw/`（R2 原路径在本席禁写域），
 * 以及多记一份 `provenance` 说明这是复跑而非新造用例。
 *
 * 前置条件（不得省略）：被测对象是真 daemon API + 真审批注册表；触发源是 R2 的测试替身 host
 * （真链路 `tool_calls` 被 chat-transport 丢弃 → 真链路里审批注册表收不到提案）。
 *
 * 用法：node tests/ai/r3/replay/replay-negatives.mjs
 *
 * @author PT-dove
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO, sha256File } from '../../r2/lib/harness.mjs';
import { CALL_ID, NEGATIVE_CASES } from '../../r2/lib/scenarios.mjs';
import { RAW_DIR } from './raw-dir.mjs';

mkdirSync(RAW_DIR, { recursive: true });

const results = {
  probe: 'negatives',
  seat: 'agent-fix-r3',
  task: 'P1-RECOVERY-2 · A',
  stamp: new Date().toISOString(),
  provenance: {
    scenarioImplementation: 'tests/ai/r2/lib/scenarios.mjs（原样引用，未改）',
    originalEntry: 'tests/ai/r2/probe-negatives.mjs',
    onlyChange: 'RAW_DIR → evidence/p1-recovery/40-agent/raw（R2 原路径 evidence/p1-close-2/** 在本席禁写域）',
  },
  callId: CALL_ID,
  preconditions: {
    realDaemonApi: 'apps/daemon/src/api/server.js（真路由）+ createChatHandlers（真处理器）',
    realApprovalRegistry: 'apps/daemon/src/api/chat.js#createApprovalRegistry',
    stubToolFrame: 'tests/ai/r2/stub-approval-host.mjs —— 真链路无 tool 帧（AGENT-001 ①），故触发源是替身',
    productBytes: {
      'apps/daemon/src/api/chat.js': sha256File(join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js')),
      'apps/model-broker/src/chat-transport.js': sha256File(join(REPO, 'apps', 'model-broker', 'src', 'chat-transport.js')),
      'apps/model-broker/bin/console-host.js': sha256File(join(REPO, 'apps', 'model-broker', 'bin', 'console-host.js')),
    },
  },
  cases: [],
};

for (const entry of NEGATIVE_CASES) {
  // Serial on purpose: one daemon stack at a time.
  // eslint-disable-next-line no-await-in-loop
  const observation = await entry.run();
  const failed = observation.expectations.filter((row) => row.pass !== true);
  results.cases.push({
    id: observation.id,
    title: observation.title,
    stubToolFrame: observation.stubToolFrame,
    canaryPath: observation.canaryPath,
    expectations: observation.expectations,
    observed: Object.fromEntries(Object.entries(observation).filter(([key]) => !['expectations', 'title'].includes(key))),
    summary: { total: observation.expectations.length, pass: observation.expectations.length - failed.length, fail: failed.length, failedIds: failed.map((row) => row.id) },
  });
  console.log(`[${observation.id}] ${observation.expectations.length - failed.length}/${observation.expectations.length} expectations pass${failed.length === 0 ? '' : ` — FAILED: ${failed.map((row) => row.id).join(', ')}`}`);
}

const allRows = results.cases.flatMap((entry) => entry.expectations);
results.totals = {
  cases: results.cases.length,
  expectations: allRows.length,
  pass: allRows.filter((row) => row.pass === true).length,
  fail: allRows.filter((row) => row.pass !== true).length,
};
results.verdict = results.totals.fail === 0
  ? '四条否定用例全部成立（真 daemon API + 真审批注册表 + 替身 tool 帧）：未审批不执行且无副作用 / 拒绝不执行且有日志级留痕（无持久审计通道）/ 超时自动作废且迟到的 approve 409 / 重放只决策一次。'
  : '存在不成立的 expectation，见 cases[].summary.failedIds';

const outFile = join(RAW_DIR, 'negatives.json');
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ totals: results.totals, verdict: results.verdict, rawFile: outFile }, null, 2));
process.exitCode = results.totals.fail === 0 ? 0 : 1;
