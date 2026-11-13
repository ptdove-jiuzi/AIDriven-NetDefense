/**
 * probe-mutation-cases.mjs — P1-CLOSE · agent-approval 席位 ④ 的**可执行**变异证据。
 *
 * AGENT-001 没有修复字节（产品源码禁写），按战役纪律 ④ 的变异对象只能是**用例/证据链**：
 * 必须证明"删掉哪个守卫，四条否定用例里的哪条会红"。
 *
 * 做法：把 `apps/daemon/src/api/chat.js` **只读复制**到 `%TEMP%\p1-close\agent\mutants\`
 * （相对 import 重写为绝对 file URL，产品目录零写入），逐条删除一个守卫后重新 import，
 * 对同一组断言取值。不改 `apps/**`、不改 `tests/wp5-daemon/ai-approval-negatives.test.js`。
 *
 * 用法：node tests/ai/p1-approval/probe-mutation-cases.mjs
 * 输出：stdout 一份 JSON + evidence/p1-close/agent/raw/mutation-cases.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = join(REPO, 'apps', 'daemon', 'src', 'api', 'chat.js');
const RAW_DIR = join(REPO, 'evidence', 'p1-close', 'agent', 'raw');
const MUTANT_DIR = join(process.env.TEMP ?? tmpdir(), 'p1-close', 'agent', 'mutants');
const STAMP = Date.now();

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(MUTANT_DIR, { recursive: true });

const originalText = readFileSync(SOURCE, 'utf8');

/** Rewrite `from './x.js'` to an absolute file URL so the copy can live anywhere. */
function withAbsoluteImports(text) {
  return text.replace(/from '(\.[^']+)'/gu, (match, specifier) => {
    const absolute = pathToFileURL(join(dirname(SOURCE), specifier)).href;
    return `from '${absolute}'`;
  });
}

const baseText = withAbsoluteImports(originalText);

/** Mutation table: id, guard, exact replacer, which negative case it should turn red. */
const MUTATIONS = Object.freeze([
  {
    id: 'M1-duplicate-callid-guard',
    guard: 'register(): `if (entries.has(input.callId)) return false;`（重复 callId 守卫）',
    asset: 'registry',
    case: 'case 4（重复 register 只留一个条目）',
    from: '      if (entries.has(input.callId)) {\n        return false;\n      }\n',
    to: '',
    expectedBaseline: { registerReturns: [true, false], size: 1 },
    expectedMutant: {
      registerReturns: [true, true],
      size: 1,
      assertionTurnsRed: true,
      note: 'Map.set 覆盖同一 key，所以 size 仍是 1；守卫的可观察效果只有 register() 返回值（用例已断言该返回值）',
    },
  },
  {
    id: 'M2-timeout-timer',
    guard: 'register(): `setTimeout(...)` 超时定时器（过期自动 denied/APPROVAL_TIMEOUT）',
    asset: 'registry',
    case: 'case 3（超时自动作废）',
    from: /entry\.timer = setTimeout\(\(\) => \{[\s\S]*?\}, timeoutMs\);/u,
    to: 'entry.timer = setTimeout(() => {}, timeoutMs);',
    expectedBaseline: { decisionEventsAfterWait: 1, state: 'denied', reason: 'APPROVAL_TIMEOUT' },
    expectedMutant: { decisionEventsAfterWait: 0, assertionTurnsRed: true },
  },
  {
    id: 'M3-session-match',
    guard: 'decide(): `entry.sessionId !== input.sessionId`（session 匹配）',
    asset: 'registry',
    case: 'case 4（错误 session 的 approve 被拒）',
    from: 'if (entry === undefined || entry.sessionId !== input.sessionId) {',
    to: 'if (entry === undefined) {',
    expectedBaseline: { wrongSessionDecide: null, sizeAfter: 1 },
    expectedMutant: { wrongSessionDecideIsEntry: true, decisionEvents: 1, assertionTurnsRed: true },
  },
  {
    id: 'M4-clear-on-decide',
    guard: 'decide(): `clear(entry)`（决策后清注册表，防重放）',
    asset: 'registry',
    case: 'case 4（重复 approve 只决策一次）',
    from: '      clear(entry);\n      const state = input.decision === \'approve\' ? \'approved\' : \'denied\';',
    to: '      const state = input.decision === \'approve\' ? \'approved\' : \'denied\';',
    expectedBaseline: { firstDecide: 'entry', secondDecide: null, decisionEvents: 1 },
    expectedMutant: { secondDecideIsEntry: true, decisionEvents: 2, assertionTurnsRed: true },
  },
  {
    id: 'M5-executed-flag',
    guard: 'approval(): 响应 `executed: false, reason: EXECUTION_DISABLED`（无执行器声明）',
    asset: 'handler',
    case: 'case 2 / case 4（拒绝/批准后 executed 必须为 false）',
    from: '      executed: false,',
    to: '      executed: true,',
    expectedBaseline: { executed: false, reason: 'EXECUTION_DISABLED' },
    expectedMutant: { executed: true, assertionTurnsRed: true },
  },
]);

/** Deterministic session ids. */
const SESSION_A = `s_${'a'.repeat(32)}`;
const SESSION_B = `s_${'b'.repeat(32)}`;
const CALL_ID = 'call_p1_1';

/** Capture channel for registry decisions. */
function makeChannel() {
  const sent = [];
  return { sent, channel: { send: (event, payload) => sent.push({ event, payload }) } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exercise the registry-level assertions in the same shape as the four negative cases. */
async function registryObservations(createApprovalRegistry) {
  const out = {};

  // M1: duplicate register
  {
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    const first = registry.register({ callId: CALL_ID, sessionId: SESSION_A, channel: makeChannel().channel });
    const second = registry.register({ callId: CALL_ID, sessionId: SESSION_A, channel: makeChannel().channel });
    out.duplicateRegister = { registerReturns: [first, second], size: registry.size() };
    registry.close();
  }

  // M2: timeout
  {
    const { sent, channel } = makeChannel();
    const registry = createApprovalRegistry({ timeoutMs: 40 });
    registry.register({ callId: CALL_ID, sessionId: SESSION_A, channel });
    await sleep(140);
    out.timeout = {
      decisionEventsAfterWait: sent.filter((entry) => entry.event === 'tool').length,
      state: sent[0]?.payload?.state ?? null,
      reason: sent[0]?.payload?.reason ?? null,
      size: registry.size(),
    };
    registry.close();
  }

  // M3: wrong session
  {
    const { sent, channel } = makeChannel();
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    registry.register({ callId: CALL_ID, sessionId: SESSION_A, channel });
    const wrong = registry.decide({ callId: CALL_ID, sessionId: SESSION_B, decision: 'approve' });
    out.wrongSession = {
      wrongSessionDecideIsEntry: wrong !== null,
      decisionEvents: sent.filter((entry) => entry.event === 'tool').length,
      sizeAfter: registry.size(),
    };
    registry.close();
  }

  // M4: replay after decision
  {
    const { sent, channel } = makeChannel();
    const registry = createApprovalRegistry({ timeoutMs: 60_000 });
    registry.register({ callId: CALL_ID, sessionId: SESSION_A, channel });
    const first = registry.decide({ callId: CALL_ID, sessionId: SESSION_A, decision: 'approve' });
    const second = registry.decide({ callId: CALL_ID, sessionId: SESSION_A, decision: 'approve' });
    out.replay = {
      firstDecide: first === null ? null : 'entry',
      secondDecideIsEntry: second !== null,
      decisionEvents: sent.filter((event) => event.event === 'tool').length,
    };
    registry.close();
  }

  return out;
}

/** Exercise the approval handler response shape (M5). */
async function handlerObservation(createChatHandlers) {
  const handlers = createChatHandlers({
    approvals: { decide: () => ({ callId: CALL_ID }) },
  });
  const result = await handlers.approval({
    body: { sessionId: SESSION_A, callId: CALL_ID, decision: 'deny' },
  });
  return { executed: result.executed, reason: result.reason };
}

/** Load one module from text. */
async function importText(name, text) {
  const file = join(MUTANT_DIR, `chat-${name}-${STAMP}.mjs`);
  writeFileSync(file, text, 'utf8');
  const module = await import(pathToFileURL(file).href);
  return { file, module };
}

/** Clone the mutation table with `applied` recorded (no shared mutation of the source text). */
function applyMutation(text, mutation) {
  const applied = mutation.from instanceof RegExp ? text.replace(mutation.from, mutation.to) : text.replace(mutation.from, mutation.to);
  return { text: applied, replaced: applied !== text };
}

const results = { probe: 'mutation-cases', stamp: STAMP, source: SOURCE, mutantDir: MUTANT_DIR, mutations: [] };

// Baseline: the four negative-case assertions must PASS on the untouched copy.
const baselineImport = await importText('baseline', baseText);
const baselineRegistry = await registryObservations(baselineImport.module.createApprovalRegistry);
const baselineHandler = await handlerObservation(baselineImport.module.createChatHandlers);
const baseline = {
  duplicateRegister: baselineRegistry.duplicateRegister,
  timeout: baselineRegistry.timeout,
  wrongSession: baselineRegistry.wrongSession,
  replay: baselineRegistry.replay,
  handler: baselineHandler,
  assertionsPass: baselineRegistry.duplicateRegister.size === 1
    && baselineRegistry.duplicateRegister.registerReturns[1] === false
    && baselineRegistry.timeout.decisionEventsAfterWait === 1
    && baselineRegistry.timeout.reason === 'APPROVAL_TIMEOUT'
    && baselineRegistry.wrongSession.wrongSessionDecideIsEntry === false
    && baselineRegistry.replay.secondDecideIsEntry === false
    && baselineRegistry.replay.decisionEvents === 1
    && baselineHandler.executed === false,
};
results.baseline = { file: baselineImport.file, ...baseline };

for (const mutation of MUTATIONS) {
  const applied = applyMutation(baseText, mutation);
  if (applied.replaced !== true) {
    results.mutations.push({ id: mutation.id, replaced: false, error: 'mutation pattern not found in source' });
    continue;
  }
  const { file, module } = await importText(mutation.id, applied.text);
  const observation = mutation.asset === 'registry'
    ? await registryObservations(module.createApprovalRegistry)
    : { handler: await handlerObservation(module.createChatHandlers) };
  const expected = mutation.expectedMutant;
  let turnsRed = false;
  if (mutation.id === 'M1-duplicate-callid-guard') {
    // The guard's only observable effect is register()'s return value: `entries.set` would
    // otherwise overwrite the same key (size stays 1). The suite asserts the return value.
    turnsRed = observation.duplicateRegister.registerReturns[1] !== false;
  } else if (mutation.id === 'M2-timeout-timer') {
    turnsRed = observation.timeout.decisionEventsAfterWait !== 1;
  } else if (mutation.id === 'M3-session-match') {
    turnsRed = observation.wrongSession.wrongSessionDecideIsEntry === true;
  } else if (mutation.id === 'M4-clear-on-decide') {
    turnsRed = observation.replay.secondDecideIsEntry === true && observation.replay.decisionEvents === 2;
  } else if (mutation.id === 'M5-executed-flag') {
    turnsRed = observation.handler.executed === true;
  }
  results.mutations.push({
    id: mutation.id,
    guard: mutation.guard,
    redCase: mutation.case,
    mutantFile: file,
    replaced: true,
    expected,
    observation,
    assertionTurnsRed: turnsRed,
  });
}

results.unexecutedDesigns = [
  {
    id: 'M6-requiresApproval-gate',
    guard: "runStreamingTurn().dispatchEvent case 'tool'：`payload.requiresApproval === true` 才 approvals.register(...)",
    redCase: 'case 1/2/3/4（提案不进注册表 → 无审批可决策）',
    whyNotExecuted: '该分支在 runStreamingTurn 内部、未导出；要执行需整条 SSE turn，本席位按"设计+源码锚点"记录，未做执行级变异',
  },
  {
    id: 'M7-registry-wiring',
    guard: 'createChatHandlers(): `approvals` 注入与 `approval()` 处理器挂载（server.js 路由）',
    redCase: 'case 1/2/3/4（无注册表/无路由 → 全部不可达）',
    whyNotExecuted: '属 server.js 路由装配层；本席位只做只读源码锚点（server.js 路由表），未执行变异',
  },
];

results.verdict = {
  baselineAssertionsPass: baseline.assertionsPass,
  executedMutations: results.mutations.filter((entry) => entry.replaced === true).length,
  mutationsTurningRed: results.mutations.filter((entry) => entry.assertionTurnsRed === true).length,
  allExecutedMutationsTurnRed: results.mutations.every((entry) => entry.replaced === true && entry.assertionTurnsRed === true),
  unexecutedDesigns: results.unexecutedDesigns.length,
  note: '变异对象是 apps/daemon/src/api/chat.js 的只读复制件（产品目录零写入）；红线：不改产品代码、不改用例断言',
};

writeFileSync(join(RAW_DIR, 'mutation-cases.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
results.rawFile = join(RAW_DIR, 'mutation-cases.json');
console.log(JSON.stringify(results, null, 2));
