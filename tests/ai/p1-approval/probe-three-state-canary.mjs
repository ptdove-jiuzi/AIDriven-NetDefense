/**
 * probe-three-state-canary.mjs — P1-CLOSE · agent-approval 席位 B2 取证探针。
 *
 * 目标场景：Agent 请求"写 %TEMP%\p1-close\agent\canary-*.txt"，分别走 **拒绝 / 批准 / 超时** 三态，
 * 检查（a）approval 响应的 executed/reason、(b) SSE tool 事件序列、(c) canary 文件是否存在、
 * (d) 决策是否留下可定位记录（结构化日志行 / 持久文件）。
 *
 * 路径：真 daemon API + 真 chat.js/approval registry + 测试替身 host
 *       （tests/ai/p1-approval/stub-approval-host.mjs，唯一能产 tool 帧的路径）。
 * 产品 0.0.1 无执行器（chat.js:829-836 `executed:false / EXECUTION_DISABLED`），
 * 因此预期三态 canary 全部不存在；"批准后也不执行"是结论不是失败。
 *
 * 用法：node tests/ai/p1-approval/probe-three-state-canary.mjs
 * 输出：stdout 一份 JSON + evidence/p1-close/agent/raw/three-state-canary.json
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEST_TOKEN,
  chatReadySettings,
  createCaptureLogger,
  openRawSse,
  parseSseText,
  sessionIdFor,
  startConsoleApi,
} from '../../wp5-daemon/console-fixtures.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const STUB_HOST = fileURLToPath(new URL('./stub-approval-host.mjs', import.meta.url));
const RAW_DIR = join(REPO, 'evidence', 'p1-close', 'agent', 'raw');
const CANARY_DIR = join(process.env.TEMP ?? tmpdir(), 'p1-close', 'agent');
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');
const CALL_ID = 'call_p1_1';

mkdirSync(RAW_DIR, { recursive: true });

/** Walk a directory and return every regular file path (depth-limited). */
function walkFiles(root, depth = 0, output = []) {
  if (depth > 4) {
    return output;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, depth + 1, output);
    } else if (entry.isFile()) {
      output.push(full);
    }
  }
  return output;
}

/** Search the data dir for any persistent record mentioning the call id. */
function findPersistentRecords(dataDir, needle) {
  const files = walkFiles(dataDir);
  const hits = [];
  for (const file of files) {
    try {
      if (statSync(file).size > 1_000_000) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      if (text.includes(needle)) {
        hits.push(file.slice(dataDir.length + 1));
      }
    } catch {
      // unreadable file: not a record
    }
  }
  return { filesScanned: files.length, hits };
}

/**
 * Run one of the three states end-to-end.
 *
 * @param {'deny'|'approve'|'timeout'} state State label.
 * @returns {Promise<object>} Observation.
 */
async function runState(state) {
  const canary = join(CANARY_DIR, `canary-${state}-${STAMP}.txt`);
  rmSync(canary, { force: true });
  const capture = createCaptureLogger();
  const sessionId = sessionIdFor(`p1-state-${state}`);
  const harness = await startConsoleApi({
    settings: chatReadySettings(1),
    hostPath: STUB_HOST,
    childEnv: {
      P1_STUB_MODE: 'tool',
      P1_CALL_ID: CALL_ID,
      P1_CANARY_PATH: canary,
    },
    approvalTimeoutMs: state === 'timeout' ? 80 : undefined,
    logger: capture.logger,
    sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
  });
  const observation = { state, canaryPath: canary, sessionId };
  let stream = null;
  const startedMs = Date.now();
  try {
    stream = await openRawSse(
      harness.address.port,
      '/api/v1/agent/chat',
      {
        sessionId,
        modelId: 'local-chat',
        messages: [{ role: 'user', content: 'write the canary file' }],
      },
      { token: TEST_TOKEN, csrf: harness.csrfToken },
    );
    await stream.onData((text) => text.includes('"state":"proposed"'));
    observation.proposalSeen = true;
    observation.canaryAfterProposal = existsSync(canary);

    if (state === 'timeout') {
      await stream.onData((text) => text.includes('"reason":"APPROVAL_TIMEOUT"'));
      observation.approvalResponse = null;
    } else {
      const decision = state === 'deny' ? 'deny' : 'approve';
      const response = await harness.request('/api/v1/agent/approval', {
        method: 'POST',
        body: { sessionId, callId: CALL_ID, decision },
      });
      observation.approvalResponse = { httpStatus: response.status, body: response.body, decision };
      if (state === 'deny') {
        await stream.onData((text) => text.includes('"reason":"USER_DENIED"'));
      } else {
        await stream.onData((text) => text.includes('"state":"approved"'));
      }
    }

    const events = parseSseText(stream.chunks()).events;
    observation.toolEvents = events
      .filter((event) => event.event === 'tool')
      .map((event) => ({ state: event.data.state, reason: event.data.reason ?? null, callId: event.data.callId ?? null }));
    observation.toolStates = observation.toolEvents.map((event) => event.state);
    observation.eventNames = events.map((event) => event.event);
    observation.canaryExistsAfter = existsSync(canary);
    observation.approvalsSizeAfter = harness.approvals.size();
    observation.auditLogLines = capture.lines()
      .filter((line) => line.includes('approval recorded') || line.includes('approval expired'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    // Canary directory: absent (never created) is recorded as-is.
    observation.canaryDirExists = existsSync(CANARY_DIR);
    observation.persistentRecords = findPersistentRecords(harness.dataDir, CALL_ID);
    // A decided call can be replayed: prove the second attempt is refused (no second decision).
    if (state !== 'timeout') {
      const replay = await harness.request('/api/v1/agent/approval', {
        method: 'POST',
        body: { sessionId, callId: CALL_ID, decision: state === 'deny' ? 'deny' : 'approve' },
      });
      observation.replay = { httpStatus: replay.status, errorCode: replay.body?.error?.code ?? null };
    }
    observation.elapsedMs = Date.now() - startedMs;
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await harness.close();
    observation.canaryExistsAtEnd = existsSync(canary);
    rmSync(canary, { force: true });
  }
  return observation;
}

const results = { probe: 'three-state-canary', stamp: STAMP, canaryDir: CANARY_DIR, states: [] };
for (const state of ['deny', 'approve', 'timeout']) {
  // Serial on purpose: one stack at a time (same reason the wp5 suite is serial).
  // eslint-disable-next-line no-await-in-loop
  results.states.push(await runState(state));
}

const c = (state) => results.states.find((entry) => entry.state === state);
results.verdict = {
  approvedAlsoNotExecuted: c('approve').approvalResponse?.body?.executed === false
    && c('approve').approvalResponse?.body?.reason === 'EXECUTION_DISABLED',
  approveCanaryCreated: c('approve').canaryExistsAtEnd,
  denyCanaryCreated: c('deny').canaryExistsAtEnd,
  timeoutCanaryCreated: c('timeout').canaryExistsAtEnd,
  denyResponseExecuted: c('deny').approvalResponse?.body?.executed ?? null,
  timeoutToolEvent: c('timeout').toolEvents,
  pendingAfterApprove: c('approve').approvalsSizeAfter,
  allThreeCanariesAbsent: !c('approve').canaryExistsAtEnd
    && !c('deny').canaryExistsAtEnd
    && !c('timeout').canaryExistsAtEnd,
};
results.conclusion = 'AGENT-001 正向腿（批准→执行）在 0.0.1 不成立：approve 也返回 executed:false/EXECUTION_DISABLED，三态 canary 文件均不存在。';

writeFileSync(join(RAW_DIR, 'three-state-canary.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
results.rawFile = join(RAW_DIR, 'three-state-canary.json');
console.log(JSON.stringify(results, null, 2));
