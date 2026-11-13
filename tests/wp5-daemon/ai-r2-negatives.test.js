/**
 * ai-r2-negatives.test.js — P1-CLOSER round-2 · T2（agent-approval-r2）门禁用例。
 *
 * 四条否定用例 + 一条审批门用例（N5）由 `tests/ai/r2/lib/scenarios.mjs` 实现，本文件只做断言：
 * 每个 `expectation` 一条断言，id 直接写进失败信息，便于把变异（`probe-mutations.mjs`）
 * 映射回"哪条守卫被删掉会让哪条断言转红"。
 *
 * **前置条件（显式标注，别把结论读大成"真 provider 链路已验审批"）**：
 *   - 被测对象：真 daemon API（`apps/daemon/src/api/server.js` 路由）+ 真 `chat.js` 处理器
 *     + 真 `createApprovalRegistry`；
 *   - 触发源：`tests/ai/r2/stub-approval-host.mjs` 测试替身。真链路上 `tool_calls` 被
 *     `chat-transport` 静默丢弃（AGENT-001 ①），因此**产品自身没有任何可产 tool 帧的路径**。
 *
 * 断言分节（每条一 it）：
 *   N1 未审批执行被拒且无副作用（决策前 registry size/canary；关流→cancelSession denied/STREAM_CLOSED）
 *   N2 拒绝后不执行且留痕（日志级成立 / 持久审计级不成立）
 *   N3 审批超时自动作废（denied/APPROVAL_TIMEOUT；超时后 approve → 409 CALL_UNKNOWN）
 *   N4 同一次审批重放只执行一次（去重 / 错 session / 二次 approve）
 *   N5 `requiresApproval:false` 不进审批注册表（审批门，round-1 覆盖缺口）
 *   + 三态 canary（deny / approve / timeout）
 *
 * 只读产品代码、不联网、只写 `%TEMP%\p1-close-2\agent\` 的 canary 与 stdio 替身日志。
 *
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NEGATIVE_CASES, runCanaryState } from '../ai/r2/lib/scenarios.mjs';

/** Per-case test titles (the four user-named cases + the approval-gate case). */
const CASE_TITLES = Object.freeze({
  N1: 'an unapproved proposal is never executed and closing the stream denies it (STREAM_CLOSED)',
  N2: 'deny records the decision without executing it (log-level trace yes, persistent audit no)',
  N3: 'an unanswered approval expires (APPROVAL_TIMEOUT) and a late approve is CALL_UNKNOWN',
  N4: 'replaying one approval decides exactly once (dedupe / wrong session / second approve)',
  N5: 'a requiresApproval:false proposal never enters the approval registry (approval gate)',
});

/**
 * Assert every expectation of an observation.
 *
 * @param {object} observation Scenario observation.
 */
function assertExpectations(observation) {
  assert.ok(Array.isArray(observation.expectations) && observation.expectations.length > 0, 'scenario must expose expectations');
  for (const row of observation.expectations) {
    assert.deepEqual(
      row.actual,
      row.expected,
      `${observation.id} expectation ${row.id} failed (expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(row.actual)})`,
    );
  }
}

describe('AGENT-001 round-2 · approval chain negative cases (real daemon API + real registry; tool frame from the seat stub)', () => {
  for (const entry of NEGATIVE_CASES) {
    it(`${entry.id} · ${CASE_TITLES[entry.id]}`, async () => {
      const observation = await entry.run();
      assertExpectations(observation);
    });
  }

  for (const state of /** @type {const} */ (['deny', 'approve', 'timeout'])) {
    it(`three-state canary · ${state} — the agent's %TEMP% file is never written and the response never claims execution`, async () => {
      const observation = await runCanaryState(state);
      assertExpectations(observation);
    });
  }
});
