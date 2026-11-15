/**
 * run-approval-negatives.mjs — AGENT-001 · 审批四条否定用例（真链路，红 / 绿 / 变异红）。
 *
 * 唯一命令：
 *
 *   node tests/ai/r3/fast/run-approval-negatives.mjs --variant all
 *
 * 链路（真字节，无替身 provider）：
 *   daemon `createControlApi`（真路由 + 真 chat.js + 真审批注册表）
 *   → broker-client（stdio）→ **被测** `console-host.js` → `chat-transport.js`
 *   → 127.0.0.1 假 provider（`tests/ai/fake-provider.mjs`，真 HTTP，零外联）。
 *
 * 三个被测变体，只换 broker 代码：
 *   * `red`  —— 仓库里未打补丁的 `apps/model-broker`（**只读**，不写 apps/**）；
 *   * `fix`  —— `%TEMP%\p1wrap\broker-fix`：`apps/model-broker` 的临时副本 + `AGENT-001.patch`；
 *   * `mutB` —— `%TEMP%\p1wrap\mutB`：`fix` 副本再删掉 tool 帧上的 `requiresApproval: true`。
 *
 * 四条否定（任一前置不成立即判红，不做"看起来通过"）：
 *   N1 决策前无副作用：提案可见、注册表恰 1 条；此刻 SSE 里没有 `result` 帧、没有
 *      `executed:true`；用一个未注册的 callId 去 approve → 409 `CALL_UNKNOWN`，且不消费
 *      真正的待批项（size 仍为 1）。
 *   N2 决策留痕：approve 之后恰好 1 条 `msg="approval recorded"` 日志，带 callId 与 decision；
 *      响应体是 `{executed:false, reason:"EXECUTION_DISABLED"}`（0.0.1 没有执行器）。
 *   N3 超时：注册表 timeout=60 ms → 收到 `state=denied / reason=APPROVAL_TIMEOUT` 帧，
 *      registry 归零，迟到的 approve → 409。
 *   N4 重复/串话：同 callId 二次注册返回 `[true,false]`；错 session → 409 且不消费；
 *      正确 approve 只产生 1 条 `approved` 帧；再 approve → 409。
 *
 * 为什么用 `gapMs`：假 provider 在 tool_calls 片段之后、finish 之前留 2.5 s，
 * 这段窗口正是"提案已注册、流尚未结束"的状态——审批必须在这段里发生，否则 done 会
 * cancelSession 掉待批项（这就是 agent 在真链路上永远等不到决策的原因）。
 *
 * 边界：不做断电/跨重启；不跑全量 npm test；不写 apps/**、evidence/**。
 *
 * 产物：`%TEMP%\p1wrap\logs\approval-negatives-<variant>.json`。
 *
 * @author PT-dove
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeProvider } from '../../fake-provider.mjs';
import {
  TEST_TOKEN,
  createCaptureLogger,
  openRawSse,
  parseSseText,
  settingsDocument,
  startConsoleApi,
} from '../../../wp5-daemon/console-fixtures.mjs';
import { createApprovalRegistry } from '../../../../apps/daemon/src/api/chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const PATCH = join(REPO, 'tests', 'ai', 'r3', 'fix', 'AGENT-001.patch');
const REPO_BROKER = join(REPO, 'apps', 'model-broker');
const LOCAL_APP_DATA = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local');
/** 固定长路径工作根：%TEMP% 可能是 8.3 短名，会制造假红，故强制用长路径。 */
const TEMP_ROOT = join(LOCAL_APP_DATA, 'Temp', 'p1wrap');
const LOG_DIR = join(TEMP_ROOT, 'logs');
const BROKER_FIX = join(TEMP_ROOT, 'broker-fix');
const BROKER_MUT = join(TEMP_ROOT, 'mutB');

/** 假 provider 在 tool_calls 之后留出的窗口（毫秒）。审批必须在这段时间内完成。 */
const GAP_MS = 2500;
/** 等待"提案可见"时 onData 的上限；流提前结束时会立刻返回（红态就靠这个不卡满）。 */
const PROPOSAL_WAIT_MS = 12_000;

const rows = [];
const startedAt = Date.now();

/**
 * 记录一条断言。
 *
 * @param {string} id 断言 id。
 * @param {object} expected 期望。
 * @param {object} actual 实测。
 * @param {boolean} pass 是否通过。
 * @param {string} [note] 备注。
 * @returns {void}
 */
function assertRow(id, expected, actual, pass, note = '') {
  rows.push({ id, expected, actual, pass, note });
  const flag = pass ? 'PASS' : 'FAIL';
  console.log(`  ${id} ${flag} ${JSON.stringify(actual)}${note === '' ? '' : `  // ${note}`}`);
}

/** 递归列出目录下所有文件。 */
function walk(root, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walk(full, output);
    } else if (entry.isFile()) {
      output.push(full);
    }
  }
  return output;
}

/** 复制目录（临时副本用）。 */
function copyDir(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  for (const file of walk(source)) {
    const target = join(destination, relative(source, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
}

/**
 * 找到可用的 `patch` 可执行文件（Git for Windows 自带，但不在 Windows PATH 里）。
 *
 * @returns {string|null} 绝对路径或 null。
 */
function findPatchExe() {
  if (process.env.PATCH && existsSync(process.env.PATCH)) {
    return process.env.PATCH;
  }
  try {
    execFileSync('patch', ['--version'], { stdio: 'pipe' });
    return 'patch';
  } catch {
    // 继续找 Git 自带的那个
  }
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    // <root>/mingw64/libexec/git-core -> <root>/usr/bin/patch.exe
    const candidate = join(execPath, '..', '..', '..', 'usr', 'bin', 'patch.exe');
    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // 没有 git 也没有 patch：下面会报错
  }
  return null;
}

/**
 * 把 AGENT-001.patch 打到 `<stage>/apps/model-broker` 这份副本上（不碰 apps/**）。
 *
 * @param {string} stage 暂存根（下面是 apps/model-broker）。
 * @returns {{patched: boolean, patchExe: string|null, chatTransport: string, consoleHost: string, note: string}} 结果。
 */
function applyPatch(stage) {
  const broker = join(stage, 'apps', 'model-broker');
  const chatTransport = join(broker, 'src', 'chat-transport.js');
  const consoleHost = join(broker, 'bin', 'console-host.js');
  const patchExe = findPatchExe();
  if (patchExe === null) {
    return { patched: false, patchExe, chatTransport, consoleHost, note: 'no patch executable found' };
  }
  try {
    execFileSync(patchExe, ['-p1', '--no-backup-if-mismatch', '-i', PATCH], { cwd: stage, stdio: 'pipe' });
  } catch (error) {
    return { patched: false, patchExe, chatTransport, consoleHost, note: `patch failed: ${error.message}` };
  }
  const transportText = readFileSync(chatTransport, 'utf8');
  const hostText = readFileSync(consoleHost, 'utf8');
  const marked = transportText.includes('TOOL_ARGUMENTS_MAX_CHARS') && hostText.includes("type: 'tool'");
  return {
    patched: marked,
    patchExe,
    chatTransport,
    consoleHost,
    note: marked ? 'ok' : 'patch applied but the two AGENT-001 markers are missing',
  };
}

/**
 * 准备被测 broker 目录。
 *
 * @param {'red'|'fix'|'mutB'} name 变体。
 * @returns {{hostPath: string, info: object}} 被测 host 与事实。
 */
function ensureVariant(name) {
  if (name === 'red') {
    return {
      hostPath: join(REPO_BROKER, 'bin', 'console-host.js'),
      info: { variant: 'red', hostPath: join(REPO_BROKER, 'bin', 'console-host.js'), patched: false, note: 'repo copy, read-only' },
    };
  }

  const stage = name === 'fix' ? BROKER_FIX : BROKER_MUT;
  // 每次都从仓库的 apps/model-broker 重新复制（只读源），保证变体是"未打补丁 + 本变体的改动"，
  // 不受上一次运行残留影响（patch 重复打会判定 already applied）。
  copyDir(REPO_BROKER, join(stage, 'apps', 'model-broker'));
  const applied = applyPatch(stage);
  const hostPath = applied.consoleHost;
  if (!applied.patched) {
    throw new Error(`${name}: cannot build patched broker (${applied.note})`);
  }

  let note = 'AGENT-001.patch applied to a temp copy';
  if (name === 'mutB') {
    // 变异：删掉转发 tool 帧时的 `requiresApproval: true`（daemon 的注册门严格要求 === true）。
    const text = readFileSync(applied.consoleHost, 'utf8');
    const needle = '            requiresApproval: true,\n';
    const hits = text.split(needle).length - 1;
    if (hits !== 1) {
      throw new Error(`mutB: expected exactly 1 requiresApproval line, found ${hits}`);
    }
    writeFileSync(applied.consoleHost, text.replace(needle, ''), 'utf8');
    note = 'AGENT-001.patch + requiresApproval deleted (mutation)';
  }
  return {
    hostPath,
    info: {
      variant: name,
      hostPath,
      patched: true,
      chatTransport: applied.chatTransport,
      consoleHost: applied.consoleHost,
      chatTransportSha256: sha256File(applied.chatTransport),
      consoleHostSha256: sha256File(applied.consoleHost),
      note,
    },
  };
}

/** 文件 SHA-256。 */
function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 一个模型/provider 指向本地假 provider 的设置文档。 */
function settingsFor(baseUrl) {
  return settingsDocument({
    models: {
      egressEnabled: true,
      providers: [{
        id: 'fake-provider',
        kind: 'openai-compatible',
        baseUrl,
        enabled: true,
        allowLoopback: true,
        dailyInputTokens: 300000,
        dailyOutputTokens: 60000,
        pricing: null,
      }],
      models: [{
        id: 'fake-tool-call',
        providerId: 'fake-provider',
        tier: 'watch',
        maxInputTokens: 4096,
        maxOutputTokens: 512,
        costClass: 'free-local',
      }],
    },
  });
}

/**
 * 容错解析：缓冲区末尾可能是半帧，解析不了就跳过。
 *
 * @param {string} text SSE 文本。
 * @returns {{event: string, data: any}[]} 事件。
 */
function safeEvents(text) {
  try {
    return parseSseText(text).events;
  } catch {
    const complete = text.slice(0, Math.max(0, text.lastIndexOf('\n\n') + 2));
    return complete === '' ? [] : parseSseText(complete).events;
  }
}

/** 帧名列表（去重前后都保留顺序）。 */
function eventNames(events) {
  return events.map((event) => event.event);
}

/** 一条 tool 帧的摘要。 */
function toolStates(events) {
  return events.filter((event) => event.event === 'tool').map((event) => ({
    state: event.data.state,
    callId: event.data.callId ?? null,
    requiresApproval: event.data.requiresApproval ?? null,
    executed: event.data.executed ?? null,
    reason: event.data.reason ?? null,
  }));
}

/**
 * 起一条链：假 provider + 真 daemon + 被测 broker host。
 *
 * @param {{hostPath: string, approvalTimeoutMs?: number, label: string}} options 选项。
 * @returns {Promise<object>} 夹具。
 */
async function startChain(options) {
  const fake = await startFakeProvider({
    behaviors: { 'fake-tool-call': 'tool-call' },
    toolCall: {
      name: 'write_file',
      arguments: JSON.stringify({ path: join(tmpdir(), 'p1wrap-approval-canary.txt'), content: 'must-never-be-written' }),
    },
    gapMs: GAP_MS,
  });
  const capture = createCaptureLogger();
  const harness = await startConsoleApi({
    hostPath: options.hostPath,
    settings: settingsFor(fake.baseUrl),
    logger: capture.logger,
    approvalTimeoutMs: options.approvalTimeoutMs ?? 60_000,
    sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
  });
  return {
    fake,
    capture,
    harness,
    sessionId: `s_${'a'.repeat(32)}`,
    otherSessionId: `s_${'b'.repeat(32)}`,
    label: options.label,
    close: async () => {
      await harness.close();
      await fake.close();
    },
  };
}

/** 打开 chat SSE 并等到提案帧（或流结束）。 */
async function openChat(chain) {
  const stream = await openRawSse(
    chain.harness.address.port,
    '/api/v1/agent/chat',
    { sessionId: chain.sessionId, modelId: 'fake-tool-call', messages: [{ role: 'user', content: 'write the canary' }] },
    { token: TEST_TOKEN, csrf: chain.harness.csrfToken },
  );
  const buffer = await stream.onData((text) => text.includes('"state":"proposed"'), PROPOSAL_WAIT_MS);
  return { stream, buffer, proposed: buffer.includes('"state":"proposed"') };
}

/** 等某一帧出现（或流结束）。 */
async function waitForFrame(stream, needle, timeoutMs) {
  const buffer = await stream.onData((text) => text.includes(needle), timeoutMs).catch(() => stream.chunks());
  return { buffer, seen: stream.chunks().includes(needle) };
}

/** POST /approval 的薄封装。 */
function approve(chain, body) {
  return chain.harness.request('/api/v1/agent/approval', { method: 'POST', body });
}

/** `approval recorded` 日志行。 */
function approvalLogLines(capture) {
  return capture.lines().filter((line) => line.includes('approval recorded'));
}

// --------------------------------------------------------------------------- N1/N2/N4（同一条流）
async function scenarioDecision(chain) {
  const opened = await openChat(chain);
  const prefix = safeEvents(opened.buffer);
  const prefixTool = toolStates(prefix);
  const callId = prefixTool.find((entry) => entry.state === 'proposed')?.callId ?? null;
  const origin = { proposedSeen: opened.proposed, callId, registryAfterProposal: chain.harness.approvals.size() };

  const unknown = callId === null
    ? { status: null, body: null }
    : await approve(chain, { sessionId: chain.sessionId, callId: 'call_not_registered_1', decision: 'approve' });
  const sizeAfterUnknown = chain.harness.approvals.size();

  assertRow(
    'N1',
    { proposedSeen: true, registryAfterProposal: 1, resultFrames: 0, executedTrue: 0, unknownStatus: 409, unknownCode: 'CALL_UNKNOWN', sizeAfterUnknown: 1 },
    {
      proposedSeen: origin.proposedSeen,
      registryAfterProposal: origin.registryAfterProposal,
      resultFrames: prefix.filter((event) => event.event === 'result').length,
      executedTrue: prefix.filter((event) => event.data?.executed === true).length,
      unknownStatus: unknown.status,
      unknownCode: unknown.body?.error?.code ?? null,
      sizeAfterUnknown,
      framesBeforeDecision: eventNames(prefix),
    },
    origin.proposedSeen === true
      && origin.registryAfterProposal === 1
      && prefix.filter((event) => event.event === 'result').length === 0
      && prefix.filter((event) => event.data?.executed === true).length === 0
      && unknown.status === 409
      && unknown.body?.error?.code === 'CALL_UNKNOWN'
      && sizeAfterUnknown === 1,
    origin.proposedSeen
      ? (origin.registryAfterProposal === 0
        ? 'PROPOSAL_NOT_REGISTERED：提案帧到了，但注册表没有登记（requiresApproval 不等于 true）'
        : '')
      : 'NO_PROPOSAL：真链路上没有 tool 帧，注册表收不到提案',
  );

  const wrongSession = callId === null
    ? { status: null, body: null }
    : await approve(chain, { sessionId: chain.otherSessionId, callId, decision: 'approve' });
  const sizeAfterWrongSession = chain.harness.approvals.size();

  const decided = callId === null
    ? { status: null, body: null }
    : await approve(chain, { sessionId: chain.sessionId, callId, decision: 'approve' });
  const logs = approvalLogLines(chain.capture);
  const decisionsLogged = logs.filter((line) => line.includes(callId ?? '\u0000') && line.includes('"decision":"approve"'));

  assertRow(
    'N2',
    { status: 200, executed: false, reason: 'EXECUTION_DISABLED', logLines: 1 },
    {
      status: decided.status,
      executed: decided.body?.executed ?? null,
      reason: decided.body?.reason ?? null,
      logLines: decisionsLogged.length,
      logSample: decisionsLogged[0] ?? null,
    },
    decided.status === 200
      && decided.body?.executed === false
      && decided.body?.reason === 'EXECUTION_DISABLED'
      && decisionsLogged.length === 1,
    decisionsLogged.length === 1 ? '' : '决策没有留下恰好一条可核对记录（或根本没有决策发生）',
  );

  const again = callId === null
    ? { status: null, body: null }
    : await approve(chain, { sessionId: chain.sessionId, callId, decision: 'approve' });

  await waitForFrame(opened.stream, 'event:done', 15_000);
  const finalEvents = safeEvents(opened.stream.chunks());
  const finalTool = toolStates(finalEvents);
  const approvedFrames = finalTool.filter((entry) => entry.state === 'approved');

  // N4a：注册表本身的去重语义（真产品导出，不经 HTTP）。
  const registry = createApprovalRegistry({ timeoutMs: 60_000 });
  const firstRegister = registry.register({ callId: 'call_dup_1', sessionId: 's_' + 'c'.repeat(32), channel: null });
  const secondRegister = registry.register({ callId: 'call_dup_1', sessionId: 's_' + 'c'.repeat(32), channel: null });
  const dupPair = [firstRegister, secondRegister];
  registry.close();

  assertRow(
    'N4',
    {
      duplicateRegister: [true, false],
      wrongSession: 409,
      sizeAfterWrongSession: 1,
      approvedFrames: 1,
      secondApprove: 409,
      resultFrames: 0,
    },
    {
      duplicateRegister: dupPair,
      wrongSession: wrongSession.status,
      wrongSessionCode: wrongSession.body?.error?.code ?? null,
      sizeAfterWrongSession,
      sizeAfterApprove: chain.harness.approvals.size(),
      approvedFrames: approvedFrames.length,
      secondApprove: again.status,
      resultFrames: finalEvents.filter((event) => event.event === 'result').length,
      executedTrue: finalEvents.filter((event) => event.data?.executed === true).length,
    },
    dupPair[0] === true && dupPair[1] === false
      && wrongSession.status === 409
      && sizeAfterWrongSession === 1
      && approvedFrames.length === 1
      && again.status === 409
      && finalEvents.filter((event) => event.event === 'result').length === 0,
    origin.proposedSeen ? '' : 'NO_PROPOSAL：注册表从未收到提案，串话/重复根本无从谈起',
  );

  return { origin, frames: eventNames(finalEvents), toolStates: finalTool, decision: decided.body };
}

// --------------------------------------------------------------------------- N3（独立短超时）
async function scenarioTimeout(chain) {
  const opened = await openChat(chain);
  const sizeAfterProposal = chain.harness.approvals.size();
  const callId = toolStates(safeEvents(opened.buffer)).find((entry) => entry.state === 'proposed')?.callId ?? null;

  const denied = await waitForFrame(opened.stream, '"reason":"APPROVAL_TIMEOUT"', 10_000);
  const sizeAfterTimeout = chain.harness.approvals.size();
  const late = callId === null
    ? { status: null, body: null }
    : await approve(chain, { sessionId: chain.sessionId, callId, decision: 'approve' });
  await waitForFrame(opened.stream, 'event:done', 15_000);
  const events = safeEvents(opened.stream.chunks());
  const deniedFrames = toolStates(events).filter((entry) => entry.state === 'denied' && entry.reason === 'APPROVAL_TIMEOUT');

  assertRow(
    'N3',
    { sizeAfterProposal: 1, deniedFrames: 1, sizeAfterTimeout: 0, lateApprove: 409 },
    {
      sizeAfterProposal,
      timeoutFrameSeen: denied.seen,
      deniedFrames: deniedFrames.length,
      sizeAfterTimeout,
      lateApprove: late.status,
      lateCode: late.body?.error?.code ?? null,
    },
    sizeAfterProposal === 1 && deniedFrames.length === 1 && sizeAfterTimeout === 0 && late.status === 409,
    sizeAfterProposal === 1
      ? ''
      : (opened.proposed
        ? 'PROPOSAL_NOT_REGISTERED：提案帧到了，但注册表没有登记（requiresApproval 不等于 true）'
        : 'NO_PROPOSAL：真链路上没有 tool 帧，60 ms 超时无从触发'),
  );
  return { sizeAfterProposal, deniedFrames: deniedFrames.length, sizeAfterTimeout, lateApprove: late.status };
}

// --------------------------------------------------------------------------- 一个变体跑完四组
async function runVariant(name) {
  const { hostPath, info } = ensureVariant(name);
  console.log(`=== variant: ${name} -> ${hostPath}`);
  const started = Date.now();

  const decisionChain = await startChain({ hostPath, label: `${name}-decision`, approvalTimeoutMs: 60_000 });
  let decision = null;
  try {
    decision = await scenarioDecision(decisionChain);
  } finally {
    await decisionChain.close();
  }

  const timeoutChain = await startChain({ hostPath, label: `${name}-timeout`, approvalTimeoutMs: 60 });
  let timeout = null;
  try {
    timeout = await scenarioTimeout(timeoutChain);
  } finally {
    await timeoutChain.close();
  }

  return { ...info, elapsedMs: Date.now() - started, decision, timeout };
}

// --------------------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2);
  const wanted = argv.includes('--variant') ? [argv[argv.indexOf('--variant') + 1]] : ['all'];
  const variants = wanted[0] === 'all' ? ['red', 'fix', 'mutB'] : wanted;
  mkdirSync(LOG_DIR, { recursive: true });

  const report = { patch: PATCH, gapMs: GAP_MS, variants: [] };
  for (const name of variants) {
    const before = rows.length;
    const facts = await runVariant(name);
    const slice = rows.slice(before);
    const result = {
      ...facts,
      assertions: slice,
      pass: slice.filter((row) => row.pass).length,
      total: slice.length,
    };
    report.variants.push({ name, pass: result.pass, total: result.total });
    const outFile = join(LOG_DIR, `approval-negatives-${name}.json`);
    writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`variant ${name}: ${result.pass}/${result.total} -> ${outFile}`);
  }

  report.productBytes = {
    'apps/model-broker/src/chat-transport.js': sha256File(join(REPO_BROKER, 'src', 'chat-transport.js')),
    'apps/model-broker/bin/console-host.js': sha256File(join(REPO_BROKER, 'bin', 'console-host.js')),
    'apps/daemon/src/api/chat.js': sha256File(join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js')),
  };
  report.elapsedMs = Date.now() - startedAt;
  writeFileSync(join(LOG_DIR, 'approval-negatives-summary.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ variants: report.variants, productBytes: report.productBytes, elapsedMs: report.elapsedMs }, null, 2));
  process.exitCode = 0;
}

await main();
