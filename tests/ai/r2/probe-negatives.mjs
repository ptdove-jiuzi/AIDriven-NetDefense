/**
 * probe-negatives.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）四条否定用例的**取证入口**。
 *
 * 与门禁共用 `lib/scenarios.mjs` 的同一份场景实现，因此这里写下的每个数字都能被
 * `node --test tests/wp5-daemon/ai-r2-negatives.test.js` 复现。
 *
 * 前置条件（不得省略）：被测对象是真 daemon API + 真审批注册表；触发源是本席位测试替身 host
 * （真链路 `tool_calls` 被 chat-transport 丢弃 → 真链路里审批注册表永远收不到提案）。
 *
 * 用法：node tests/ai/r2/probe-negatives.mjs
 * 产物：`evidence/p1-close-2/agent/raw/negatives.json`（+ stdout 摘要）
 *
 * @author PT-dove
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RAW_DIR, REPO, sha256File } from './lib/harness.mjs';
import { CALL_ID, NEGATIVE_CASES } from './lib/scenarios.mjs';

mkdirSync(RAW_DIR, { recursive: true });

const results = {
  probe: 'negatives',
  seat: 'agent-approval-r2',
  task: 'task-2',
  stamp: new Date().toISOString(),
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
  // Serial on purpose: one daemon stack at a time (same reason the wp5 suite is serial).
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
  : '存在不成立的expectation，见 cases[].summary.failedIds';

const outFile = join(RAW_DIR, 'negatives.json');
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ totals: results.totals, verdict: results.verdict, rawFile: outFile }, null, 2));
process.exitCode = results.totals.fail === 0 ? 0 : 1;
