/**
 * probe-mutations.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）**可失败性变异**证据。
 *
 * ⚠ **这不是台账 ④（AGENT-001 无修复字节，④ 结构性缺失）**。
 *   AGENT-001 的修复需要改 `apps/model-broker/src/chat-transport.js` + `apps/daemon/src/api/chat.js`
 *   （本席位禁写域），没有"修复行"可以改坏。按 README §1（`evidence/p1-close-2/README.md`）
 *   本席位只能做"**用例/证据链的可失败性变异**"：证明"删掉哪个守卫 → 哪条断言会转红"。
 *   本文件产出的每一条都按此口径标注，**不得**被引用成台账 ④。
 *
 * 做法：把 `apps/daemon/src/api/chat.js` **只读复制**到 `%TEMP%\p1-close-2\agent\mutants\`
 * （相对 import 重写为绝对 file URL，产品目录零写入），逐条删/改一个守卫后重新 import，
 * 对同一组"断言取值"重新采样，比对"该变异声明的目标断言"是否从 pass 变 fail。
 * 收尾重算产品文件 sha256/mtime，证明**产品字节零变化**。
 *
 * 用法：node tests/ai/r2/probe-mutations.mjs
 * 产物：`evidence/p1-close-2/agent/raw/mutations.json`
 *
 * @author PT-dove
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RAW_DIR, REPO, sha256File, sleep } from './lib/harness.mjs';

const SOURCE = join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js');
const FIXTURE_SOURCE = join(REPO, 'tests', 'wp5-daemon', 'console-fixtures.mjs');
const FIXTURE_BASE = dirname(FIXTURE_SOURCE);
const STUB_HOST = join(REPO, 'tests', 'ai', 'r2', 'stub-approval-host.mjs');
const MUTANT_DIR = join(process.env.TEMP ?? REPO, 'p1-close-2', 'agent', 'mutants');
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(MUTANT_DIR, { recursive: true });

const sourceText = readFileSync(SOURCE, 'utf8');
const bytesBefore = { sha256: sha256File(SOURCE), bytes: statSync(SOURCE).size, mtimeMs: statSync(SOURCE).mtimeMs };
const STAMP = Date.now();

/** Rewrite `from './x.js'` to an absolute file URL so a copy can live anywhere. */
function withAbsoluteImports(text) {
  return text.replace(/from '(\.[^']+)'/gu, (match, specifier) => {
    const absolute = pathToFileURL(join(dirname(SOURCE), specifier)).href;
    return `from '${absolute}'`;
  });
}

const baseText = withAbsoluteImports(sourceText);

/**
 * Load a module from text placed under %TEMP%.
 *
 * @param {string} name File name suffix.
 * @param {string} text Module source.
 * @returns {Promise<{file: string, module: object}>} Loaded module.
 */
async function importText(name, text) {
  const file = join(MUTANT_DIR, `chat-${name}-${STAMP}.mjs`);
  writeFileSync(file, text, 'utf8');
  const module = await import(pathToFileURL(file).href);
  return { file, module };
}

/** Console error code → HTTP status (only the codes this probe can observe). */
const STATUS_BY_CODE = Object.freeze({ CALL_UNKNOWN: 409 });

/**
 * Call the approval handler and normalize throw/return into one shape.
 *
 * @param {object} handlers `createChatHandlers()` result.
 * @param {object} body Request body.
 * @returns {Promise<{status: number, code: string|null, body: any}>} Normalized response.
 */
async function handlerCall(handlers, body) {
  try {
    const result = await handlers.approval({ body });
    return { status: 200, code: null, body: result };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'THROWN';
    return { status: STATUS_BY_CODE[code] ?? 500, code, body: { error: { code, message: String(error?.message ?? error) } } };
  }
}

const SESSION_A = `s_${'a'.repeat(32)}`;
const SESSION_B = `s_${'b'.repeat(32)}`;

/**
 * Sample every assertion value a registry/handler-level mutation can move.
 *
 * Keys are **exactly** the expectation ids used by `lib/scenarios.mjs`, so a mutation can name
 * the assertion it is supposed to turn red.
 *
 * @param {{createApprovalRegistry: Function, createChatHandlers: Function}} module Mutant module.
 * @returns {Promise<Record<string, unknown>>} Observation keyed by expectation id.
 */
async function observe(module) {
  const { createApprovalRegistry, createChatHandlers } = module;
  const out = {};
  const channel = () => {
    const sent = [];
    return { sent, channel: { send: (event, payload) => sent.push({ event, payload }) } };
  };

  // N4 — duplicate callId must not add a second entry.
  {
    const sink = channel();
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    const first = registry.register({ callId: 'call_mut_dup', sessionId: SESSION_A, channel: sink.channel });
    const second = registry.register({ callId: 'call_mut_dup', sessionId: SESSION_A, channel: sink.channel });
    out['N4.duplicateRegisterReturns'] = [first, second];
    out['N4.duplicateRegisterSize'] = registry.size();
    registry.close();
  }

  // N3 — an unanswered approval expires with denied/APPROVAL_TIMEOUT.
  {
    const sink = channel();
    const registry = createApprovalRegistry({ timeoutMs: 40 });
    registry.register({ callId: 'call_mut_to', sessionId: SESSION_A, channel: sink.channel });
    await sleep(160);
    out['N3.timeoutFrames'] = sink.sent.filter((entry) => entry.event === 'tool').length;
    out['N3.toolStates'] = sink.sent.map((entry) => entry.payload.state);
    out['N3.registrySizeAfterTimeout'] = registry.size();
    registry.close();
  }

  // N4 — a decision from the wrong session must be refused and must not consume the entry.
  {
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    registry.register({ callId: 'call_mut_ws', sessionId: SESSION_A, channel: channel().channel });
    const handlers = createChatHandlers({ approvals: registry });
    const wrong = await handlerCall(handlers, { sessionId: SESSION_B, callId: 'call_mut_ws', decision: 'approve' });
    out['N4.wrongSessionHttpStatus'] = wrong.status;
    out['N4.wrongSessionErrorCode'] = wrong.code;
    out['N4.registrySizeAfterWrongSession'] = registry.size();
    registry.close();
  }

  // N4 — the same approval twice must produce exactly one decision frame.
  {
    const sink = channel();
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    registry.register({ callId: 'call_mut_rp', sessionId: SESSION_A, channel: sink.channel });
    const handlers = createChatHandlers({ approvals: registry });
    const first = await handlerCall(handlers, { sessionId: SESSION_A, callId: 'call_mut_rp', decision: 'approve' });
    const second = await handlerCall(handlers, { sessionId: SESSION_A, callId: 'call_mut_rp', decision: 'approve' });
    const decisions = sink.sent.filter((entry) => entry.payload.state === 'approved' || entry.payload.state === 'denied');
    out['N4.firstApproveHttpStatus'] = first.status;
    out['N4.replayHttpStatus'] = second.status;
    out['N4.replayErrorCode'] = second.code;
    out['N4.approvedFrames'] = decisions.filter((entry) => entry.payload.state === 'approved').length;
    out['N4.decisionFramesTotal'] = decisions.length;
    registry.close();
  }

  // N1 — a call that was never registered cannot be approved (CALL_UNKNOWN guard).
  {
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    const handlers = createChatHandlers({ approvals: registry });
    const unknown = await handlerCall(handlers, { sessionId: SESSION_A, callId: 'call_mut_unknown', decision: 'approve' });
    out['N1.unknownCallHttpStatus'] = unknown.status;
    out['N1.unknownCallErrorCode'] = unknown.code;
    out['N1.unknownCallExecutedClaim'] = JSON.stringify(unknown.body ?? {}).includes('"executed":true');
    registry.close();
  }

  // N2 — the decision response must never claim execution (0.0.1 has no executor).
  {
    const handlers = createChatHandlers({ approvals: { decide: () => ({ callId: 'call_mut_exec' }) } });
    const result = await handlerCall(handlers, { sessionId: SESSION_A, callId: 'call_mut_exec', decision: 'deny' });
    out['N2.denyExecuted'] = result.body?.executed ?? null;
    out['N2.denyReason'] = result.body?.reason ?? null;
  }

  // N1 — closing the stream must emit denied/STREAM_CLOSED once, only for that session.
  {
    const sink = channel();
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    registry.register({ callId: 'call_mut_ca', sessionId: SESSION_A, channel: sink.channel });
    registry.register({ callId: 'call_mut_cb', sessionId: SESSION_B, channel: sink.channel });
    const cancelled = registry.cancelSession(SESSION_A);
    const secondCancel = registry.cancelSession(SESSION_A);
    const frames = sink.sent.filter((entry) => entry.event === 'tool');
    out['N1.cancelSessionCancelled'] = cancelled;
    out['N1.cancelSessionDeniedState'] = frames[0]?.payload.state ?? null;
    out['N1.cancelSessionDeniedReason'] = frames[0]?.payload.reason ?? null;
    out['N1.cancelSessionSecondCancel'] = secondCancel;
    out['N1.cancelSessionOtherSessionKept'] = registry.size();
    registry.close();
  }

  return out;
}

/**
 * Mutation table.
 *
 * - `from` is the exact source text (string or RegExp) of the guard;
 * - `targets` are `{id, expected}` rows the mutation must turn from pass to fail,
 *   using **the same ids/expected values as `lib/scenarios.mjs`**.
 */
const MUTATIONS = Object.freeze([
  {
    id: 'M1-dedupe-duplicate-callid',
    guard: 'register(): `if (entries.has(input.callId)) return false;`（重复 callId 去重守卫）',
    redCase: 'N4（同一次审批重放只执行一次 · 重复 register 不增）',
    from: '      if (entries.has(input.callId)) {\n        return false;\n      }\n',
    to: '',
    targets: [{ id: 'N4.duplicateRegisterReturns', expected: [true, false] }],
  },
  {
    id: 'M2-timeout-decide',
    guard: 'register(): `setTimeout(() => { clear(entry); emitDecision(entry, \'denied\', \'APPROVAL_TIMEOUT\'); ... }, timeoutMs)`（超时判定）',
    redCase: 'N3（审批超时自动作废）',
    from: /entry\.timer = setTimeout\(\(\) => \{[\s\S]*?\}, timeoutMs\);/u,
    to: 'entry.timer = setTimeout(() => {}, timeoutMs);',
    targets: [
      { id: 'N3.timeoutFrames', expected: 1 },
      { id: 'N3.registrySizeAfterTimeout', expected: 0 },
    ],
  },
  {
    id: 'M3-session-match',
    guard: 'decide(): `entry.sessionId !== input.sessionId`（错误 session 不得消费）',
    redCase: 'N4（错 session 409 不消费）',
    from: 'if (entry === undefined || entry.sessionId !== input.sessionId) {',
    to: 'if (entry === undefined) {',
    targets: [
      { id: 'N4.wrongSessionHttpStatus', expected: 409 },
      { id: 'N4.wrongSessionErrorCode', expected: 'CALL_UNKNOWN' },
    ],
  },
  {
    id: 'M4-clear-on-decide',
    guard: 'decide(): `clear(entry)`（决策后清注册表，防重放）',
    redCase: 'N4（二次 approve 409 / 只有 1 条 approved 帧）',
    from: '      clear(entry);\n      const state = input.decision === \'approve\' ? \'approved\' : \'denied\';',
    to: '      const state = input.decision === \'approve\' ? \'approved\' : \'denied\';',
    targets: [
      { id: 'N4.replayHttpStatus', expected: 409 },
      { id: 'N4.approvedFrames', expected: 1 },
      { id: 'N4.decisionFramesTotal', expected: 1 },
    ],
  },
  {
    id: 'M5-call-unknown-guard',
    guard: 'approval(): `if (entry === null) throw new ConsoleError(CALL_UNKNOWN, ...)`（未注册/已过期调用必须 409）',
    redCase: 'N1（未审批执行被拒）/ N3（迟到 approve 409）',
    from: '    if (entry === null) {\n      throw new ConsoleError(CONSOLE_CODES.CALL_UNKNOWN, \'approval call is unknown or expired\', {\n        callId: ctx.body.callId,\n      });\n    }\n',
    to: '',
    targets: [
      { id: 'N1.unknownCallHttpStatus', expected: 409 },
      { id: 'N1.unknownCallErrorCode', expected: 'CALL_UNKNOWN' },
    ],
  },
  {
    id: 'M6-execution-disabled-flag',
    guard: 'approval(): 响应 `executed: false, reason: EXECUTION_DISABLED`（无执行器声明）',
    redCase: 'N2（拒绝后不执行）/ N4（批准也不执行）',
    from: '      executed: false,',
    to: '      executed: true,',
    targets: [{ id: 'N2.denyExecuted', expected: false }],
  },
  {
    id: 'M7-stream-closed-decide',
    guard: 'cancelSession(): `emitDecision(entry, \'denied\', \'STREAM_CLOSED\')`（关流必须留 denied 帧）',
    redCase: 'N1（流关闭→cancelSession denied/STREAM_CLOSED 可观测）',
    from: '        clear(entry);\n        emitDecision(entry, \'denied\', \'STREAM_CLOSED\');\n        count += 1;',
    to: '        clear(entry);\n        count += 1;',
    targets: [{ id: 'N1.cancelSessionDeniedReason', expected: 'STREAM_CLOSED' }],
  },
]);

/**
 * Check whether a mutation's target rows passed against a sample.
 *
 * @param {Record<string, unknown>} sample Observation.
 * @param {{id: string, expected: unknown}[]} targets Target rows.
 * @returns {{id: string, expected: unknown, actual: unknown, pass: boolean}[]} Rows.
 */
function checkTargets(sample, targets) {
  return targets.map((row) => ({
    id: row.id,
    expected: row.expected,
    actual: sample[row.id] ?? null,
    pass: JSON.stringify(sample[row.id] ?? null) === JSON.stringify(row.expected),
  }));
}

const baselineImport = await importText('baseline', baseText);
const baselineSample = await observe(baselineImport.module);
const baselineTargetRows = MUTATIONS.flatMap((mutation) => checkTargets(baselineSample, mutation.targets));
const baselineAllTargetsPass = baselineTargetRows.every((row) => row.pass === true);

const results = {
  probe: 'mutations',
  seat: 'agent-approval-r2',
  task: 'task-2',
  stamp: new Date().toISOString(),
  NOT_LEDGER_SEGMENT_4: '这不是台账 ④。AGENT-001 无修复字节（修复需改 apps/model-broker/src/chat-transport.js 与 apps/daemon/src/api/chat.js，均在本席位禁写域），④ 结构性缺失；本文件只证明"用例/证据链会因删掉守卫而转红"（README §1 允许的唯一变体，必须如此标注）。',
  source: SOURCE,
  mutantDir: MUTANT_DIR,
  sourceBytes: bytesBefore,
  baseline: {
    sample: baselineSample,
    targetsAllPass: baselineAllTargetsPass,
    targetRows: baselineTargetRows,
  },
  mutations: [],
  unexecutedDesigns: [
    {
      id: 'M9-route-wiring',
      guard: 'server.js 的路由表把 POST /api/v1/agent/approval 挂到 handlers.approval',
      redCase: 'N1–N5 全部（无路由 ⇒ 全部不可达）',
      whyNotExecuted: '属 apps/daemon/src/api/server.js（禁写域）；端到端可达性已由 N1–N5 真 HTTP 请求证明，变异需改产品源码。',
    },
  ],
};

// ------------------------------------------------------------------ M8: requiresApproval gate
//
// round-1 再攻击席点名"M4（删 requiresApproval 判定）→ 0 红 = 覆盖缺口"。本轮的补法是：
// 把 `tests/wp5-daemon/console-fixtures.mjs` **只读复制**到 %TEMP%，把它对 chat.js 的 import
// 指向变异 chat.js 复制件，再用这个 fixture 起**整条真 daemon 栈**（真 server.js 路由 + 真
// 设置库 + 本席位替身 host），于是"删审批门"可以被**端到端执行**，而不只是设计说明。

/** Rewrite the fixture copy so its `chat.js` import points at `chatModuleFile` (absolute paths). */
function fixtureTextFor(chatModuleFile) {
  const text = readFileSync(FIXTURE_SOURCE, 'utf8');
  return text.replace(/from '(\.[^']+)'/gu, (match, specifier) => {
    const resolved = resolve(FIXTURE_BASE, specifier);
    const target = resolved === SOURCE ? chatModuleFile : resolved;
    return `from '${pathToFileURL(target).href}'`;
  });
}

/**
 * Start the real console stack whose `createChatHandlers` comes from `chatModuleFile`.
 *
 * @param {string} chatModuleFile Absolute path of the chat.js copy to load.
 * @param {string} label Stack label (mutant file names).
 * @returns {Promise<{fixture: object, harness: object, canary: string, close: Function}>} Stack.
 */
async function startGateStack(chatModuleFile, label) {
  const fixtureFile = join(MUTANT_DIR, `fixtures-${label}-${STAMP}.mjs`);
  writeFileSync(fixtureFile, fixtureTextFor(chatModuleFile), 'utf8');
  const fixture = await import(pathToFileURL(fixtureFile).href);
  const canary = join(process.env.TEMP ?? REPO, 'p1-close-2', 'agent', `canary-gate-${label}.txt`);
  rmSync(canary, { force: true });
  const capture = fixture.createCaptureLogger();
  const harness = await fixture.startConsoleApi({
    settings: fixture.chatReadySettings(1),
    hostPath: STUB_HOST,
    childEnv: { R2_STUB_MODE: 'tool-noapproval', R2_CALL_ID: 'call_mut_gate', R2_CANARY_PATH: canary },
    logger: capture.logger,
    sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
  });
  return {
    fixture,
    harness,
    canary,
    close: async () => {
      try {
        await harness.close();
      } finally {
        rmSync(canary, { force: true });
        rmSync(fixtureFile, { force: true });
      }
    },
  };
}

/**
 * End-to-end observation of the approval gate: a `requiresApproval:false` proposal must not
 * register, and therefore cannot be approved.
 *
 * @param {string} chatModuleFile chat.js copy to load.
 * @param {string} label Stack label.
 * @returns {Promise<Record<string, unknown>>} Observation keyed by N5 expectation ids.
 */
async function observeApprovalGate(chatModuleFile, label) {
  const stack = await startGateStack(chatModuleFile, label);
  const sessionId = `s_${'e'.repeat(32)}`;
  const out = {};
  let stream = null;
  try {
    stream = await stack.fixture.openRawSse(
      stack.harness.address.port,
      '/api/v1/agent/chat',
      { sessionId, modelId: 'local-chat', messages: [{ role: 'user', content: 'write the canary file' }] },
      { token: stack.fixture.TEST_TOKEN, csrf: stack.harness.csrfToken },
    );
    await stream.onData((text) => text.includes('"state":"proposed"'));
    await sleep(120);
    out['N5.proposalRequiresApproval'] = stream.chunks().includes('"requiresApproval":false') ? false : true;
    out['N5.registrySizeAfterNoApprovalProposal'] = stack.harness.approvals.size();
    const approved = await stack.harness.request('/api/v1/agent/approval', {
      method: 'POST',
      body: { sessionId, callId: 'call_mut_gate', decision: 'approve' },
    });
    out['N5.approveHttpStatus'] = approved.status;
    out['N5.approveErrorCode'] = approved.body?.error?.code ?? null;
  } finally {
    if (stream !== null) {
      stream.request.destroy();
    }
    await stack.close();
  }
  return out;
}

{
  const gateTargets = [
    { id: 'N5.registrySizeAfterNoApprovalProposal', expected: 0 },
    { id: 'N5.approveHttpStatus', expected: 409 },
    { id: 'N5.approveErrorCode', expected: 'CALL_UNKNOWN' },
  ];
  const baselineGate = await observeApprovalGate(baselineImport.file, 'gate-baseline');
  const baselineRows = checkTargets(baselineGate, gateTargets);
  results.baselineGate = { sample: baselineGate, targetRows: baselineRows, allPass: baselineRows.every((row) => row.pass === true) };

  const gateMutation = {
    id: 'M8-requires-approval-gate',
    guard: "runStreamingTurn().dispatchEvent case 'tool'：`payload.requiresApproval === true` 才 approvals.register(...)（chat.js:592-596）",
    redCase: 'N5（requiresApproval:false 不进注册表）',
    from: "          && payload.state === 'proposed' && payload.requiresApproval === true\n",
    to: "          && payload.state === 'proposed'\n",
  };
  const applied = sourceText.replace(gateMutation.from, gateMutation.to);
  const replaced = applied !== sourceText;
  if (replaced !== true) {
    results.mutations.push({ id: gateMutation.id, guard: gateMutation.guard, redCase: gateMutation.redCase, replaced: false, error: 'mutation pattern not found in source' });
  } else {
    const gateMutant = await importText('m8-gate', withAbsoluteImports(applied));
    const mutantGate = await observeApprovalGate(gateMutant.file, 'gate-mutant');
    const rows = checkTargets(mutantGate, gateTargets);
    results.mutations.push({
      id: gateMutation.id,
      guard: gateMutation.guard,
      redCase: gateMutation.redCase,
      replaced: true,
      executedViaFixtureCopy: true,
      how: '把 tests/wp5-daemon/console-fixtures.mjs 只读复制到 %TEMP%，其 chat.js import 指向变异复制件 → 用该 fixture 起整条真 daemon 栈（真 server.js 路由 + 真设置库 + 替身 host），端到端采样 N5',
      mutantFile: gateMutant.file,
      mutantFixture: join(MUTANT_DIR, `fixtures-gate-mutant-${STAMP}.mjs`),
      targetRows: rows,
      mutantSample: Object.fromEntries(gateTargets.map((row) => [row.id, mutantGate[row.id] ?? null])),
      assertionTurnsRed: rows.some((row) => row.pass !== true),
    });
  }
  results.gateTotals = {
    baselineAllPass: results.baselineGate.allPass,
    executed: results.mutations.some((entry) => entry.id === gateMutation.id && entry.replaced === true),
    turnsRed: results.mutations.some((entry) => entry.id === gateMutation.id && entry.assertionTurnsRed === true),
  };
}

for (const mutation of MUTATIONS) {
  const applied = sourceText.replace(mutation.from, mutation.to);
  const replaced = applied !== sourceText;
  if (replaced !== true) {
    results.mutations.push({ id: mutation.id, guard: mutation.guard, redCase: mutation.redCase, replaced: false, error: 'mutation pattern not found in source' });
    continue;
  }
  const { file, module } = await importText(mutation.id, withAbsoluteImports(applied));
  const sample = await observe(module);
  const rows = checkTargets(sample, mutation.targets);
  results.mutations.push({
    id: mutation.id,
    guard: mutation.guard,
    redCase: mutation.redCase,
    mutantFile: file,
    replaced: true,
    targetRows: rows,
    mutantSample: Object.fromEntries(mutation.targets.map((row) => [row.id, sample[row.id]])),
    assertionTurnsRed: rows.some((row) => row.pass !== true),
  });
}

// Product bytes must be untouched: same sha256/size/mtime after all mutation work.
const bytesAfter = { sha256: sha256File(SOURCE), bytes: statSync(SOURCE).size, mtimeMs: statSync(SOURCE).mtimeMs };
results.productBytesUnchanged = JSON.stringify(bytesBefore) === JSON.stringify(bytesAfter);

results.totals = {
  mutations: results.mutations.length,
  executed: results.mutations.filter((entry) => entry.replaced === true).length,
  turningRed: results.mutations.filter((entry) => entry.assertionTurnsRed === true).length,
  unexecutedDesigns: results.unexecutedDesigns.length,
  stackLevelMutations: results.mutations.filter((entry) => entry.executedViaFixtureCopy === true).length,
};
const baselineEverythingPasses = baselineAllTargetsPass && results.baselineGate.allPass === true;
results.verdict = {
  baselineAllTargetsPass: baselineEverythingPasses,
  allExecutedMutationsTurnRed: results.mutations
    .filter((entry) => entry.replaced === true)
    .every((entry) => entry.assertionTurnsRed === true),
  productBytesUnchanged: results.productBytesUnchanged,
  note: '变异对象是 apps/daemon/src/api/chat.js 的只读复制件（%TEMP%），产品目录零写入；M8 额外把 tests/wp5-daemon/console-fixtures.mjs 只读复制到 %TEMP% 并把 chat.js import 指向变异件，从而端到端执行"删审批门"变异。红线：不改产品代码、不改用例断言。',
  NOT_LEDGER_SEGMENT_4: results.NOT_LEDGER_SEGMENT_4,
};

// Clean the mutant copies (they are reproducible from this script).
for (const entry of results.mutations) {
  if (typeof entry.mutantFile === 'string') {
    rmSync(entry.mutantFile, { force: true });
  }
}
rmSync(baselineImport.file, { force: true });

const outFile = join(RAW_DIR, 'mutations.json');
writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  verdict: results.verdict,
  totals: results.totals,
  mutations: results.mutations.map((entry) => ({ id: entry.id, replaced: entry.replaced, turnsRed: entry.assertionTurnsRed, targets: entry.targetRows })),
  rawFile: outFile,
}, null, 2));
process.exitCode = baselineEverythingPasses && results.verdict.allExecutedMutationsTurnRed && results.productBytesUnchanged ? 0 : 1;
