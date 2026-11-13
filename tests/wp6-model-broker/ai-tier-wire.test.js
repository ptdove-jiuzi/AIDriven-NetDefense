/**
 * AI-ENABLE / tier — 交付 B：**链路级独立复核**（不复用 explain-chain 席的用例）。
 *
 * 链路：真 daemon console API（`startConsoleApi`，真 HTTP + 真 SSE）
 *      → broker-client → **真 console host 子进程**（`apps/model-broker/bin/console-host.js`）
 *      → chat-transport → **本机假 provider**（`tests/ai/fake-provider.mjs`，127.0.0.1 临时端口）。
 *
 * 零外联：唯一的出站目标是回环地址上的假 server；没有任何 key（host 走 `credentialRef` 空槽）。
 *
 * 本文件要证明的事（全部以假 provider 的请求日志 / daemon 日志为准，不以"代码里写了"为准）：
 *
 * 0. **前提**：分级判据在仓库布局下真的可用（`routingJudgeStatus().available === true`）；
 *    判据缺失时 explain.js 的降级分支必须显式可查（`E_ROUTING_UNAVAILABLE`），不能伪装成"判过了"。
 * 1. 三条不同 severity 的告警 → 三次 explain，假 server 日志里的 `body.model` 各不相同，
 *    且与 tier 一一对应（low→watch、high→triage、critical→respond）；SSE `usage` 帧的
 *    `tier` / `modelId` 与日志一致，cost 按配置价格算出来而不是编造。
 * 2. 高危告警确实从小模型切换到强模型：同一份 settings 下 watch 模型与 triage/respond
 *    模型 id 不同，日志里能看到切换（不是恒定同一个模型）。
 * 3. **超预算拒绝升级并留记录**：`maxEscalationsPerHour` 用满后，第 N+1 条 critical 告警
 *    **停在默认 tier（watch 模型）**；证据字段 = SSE `usage.tier`/`usage.modelId` +
 *    daemon 日志 `msg='explain.route'` 的 `deniedCode`/`tier`/`modelId`/`escalate`。
 *    变异：把 `maxEscalationsPerHour` 从 2 调到 3，同一批告警里第 3 条就升档（转绿）。
 */

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { startFakeProvider } from '../ai/fake-provider.mjs';
import { routingJudgeStatus, selectExplainRoute } from '../../apps/daemon/src/api/explain.js';
import {
  createCaptureLogger,
  makeTempDir,
  settingsDocument,
  startConsoleApi,
} from '../wp5-daemon/console-fixtures.mjs';

/** 真 host 子进程脚本（与 daemon 门禁用的同一个文件）。 */
const HOST_PATH = resolve('apps/model-broker/bin/console-host.js');

const BASE = '2026-11-04T00:00:00.000Z';

const WATCH_MODEL = 'tier-watch-model';
const TRIAGE_MODEL = 'tier-triage-model';
const RESPOND_MODEL = 'tier-respond-model';

/** 三档齐全的 settings（不要依赖 wp5 fixture 的"只有 triage 一个模型"）。 */
function tieredSettings(providerBaseUrl, overrides = {}) {
  const routing = {
    mode: 'tiered',
    uniformModelId: null,
    defaultTier: 'watch',
    escalation: {
      enabled: true,
      minSeverity: 'high',
      // 冷却置 0：本文件要验的是 **tier 切换与小时上限**，不是冷却（那是另一条规则）。
      cooldownSeconds: 0,
      maxEscalationsPerHour: 20,
    },
  };
  return settingsDocument({
    models: {
      egressEnabled: true,
      providers: [{
        id: 'ollama-local',
        kind: 'ollama',
        baseUrl: providerBaseUrl,
        enabled: true,
        allowLoopback: true,
        dailyInputTokens: 30000,
        dailyOutputTokens: 6000,
        pricing: { inputUsdPerMTok: 0.5, outputUsdPerMTok: 1.5 },
      }],
      models: [
        { id: WATCH_MODEL, providerId: 'ollama-local', tier: 'watch', maxInputTokens: 4096, maxOutputTokens: 512, costClass: 'free-local' },
        { id: TRIAGE_MODEL, providerId: 'ollama-local', tier: 'triage', maxInputTokens: 8192, maxOutputTokens: 1024, costClass: 'cheap' },
        { id: RESPOND_MODEL, providerId: 'ollama-local', tier: 'respond', maxInputTokens: 12288, maxOutputTokens: 2000, costClass: 'expensive' },
      ],
      routing: { ...routing, ...(overrides.routing ?? {}) },
    },
  });
}

function makeAlert(id, severity) {
  return {
    alert_id: id,
    rule_id: 'proc.suspicious-start',
    rule_version: '1.0.0',
    severity,
    status: 'new',
    count: 2,
    first_seen: BASE,
    last_seen: BASE,
    window_start: BASE,
    window_end: BASE,
    event_ids: [`evt-${id}`],
    event_ids_truncated: false,
    // 这两个字段绝不允许出现在 provider 请求体里（链路侧的出域断言，另席负责，这里只做护栏）。
    canonical_json: '{"raw":"SECRET-RAW-BODY"}',
    raw_payload: 'SECRET-RAW-BODY',
  };
}

function usageOf(response) {
  return response.events.find((event) => event.event === 'usage')?.data ?? null;
}

/** 从假 provider 日志里取一条请求的模型名（按到达顺序）。 */
function modelAt(provider, index) {
  return provider.requests[index]?.body?.model ?? null;
}

/** daemon 日志里的 `explain.route` 记录（每次 explain 一条）。 */
function routeLogs(logger) {
  return logger.lines()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record !== null && record.msg === 'explain.route');
}

/**
 * ⓪ 前置：复核的**前提**是分级判据真的加载上了。
 *
 * explain.js v2 改成守卫式加载（`packages/policy` 不在发布包布局里），判据缺失时会走
 * `E_ROUTING_UNAVAILABLE` 的降级分支。若这一条不成立，本文件后面看到的"切换"就是降级路径，
 * 不是分级判据在起作用 —— 所以必须先钉住这个前置，再谈 tier 切换。
 */
test('⓪ 分级判据可用性前置：routingJudgeStatus().available === true，否则看到的是降级路径', () => {
  const status = routingJudgeStatus();
  console.log('routing-judge-status:\n%s', JSON.stringify(status, null, 2));
  assert.deepEqual(status, { available: true, error: null });
});

/**
 * ⓪b 守卫式加载的降级分支必须是**显式可查**的：判据缺失 → `E_ROUTING_UNAVAILABLE`，
 *     落在默认 tier，不伪造升档、不抛 4xx。这是"缺判据"与"判过了"的区别。
 */
test('⓪b 判据缺失时的降级分支：source=fallback、deniedCode=E_ROUTING_UNAVAILABLE，停在 watch', () => {
  const settings = tieredSettings('http://127.0.0.1:9/v1');
  const route = selectExplainRoute({
    settings,
    alert: { alert_id: 'tier-degraded-alert', severity: 'critical' },
    history: { recent: () => [] },
    nowMs: () => Date.UTC(2026, 10, 4, 12, 0, 0),
    routingModule: null,
  });
  console.log('degraded-route:\n%s', JSON.stringify({
    source: route.source,
    tier: route.tier,
    modelId: route.model?.id ?? null,
    escalate: route.escalate,
    deniedCode: route.deniedCode,
    deniedField: route.deniedField,
    reason: route.reason,
  }, null, 2));

  assert.equal(route.source, 'fallback');
  assert.equal(route.deniedCode, 'E_ROUTING_UNAVAILABLE');
  assert.equal(route.deniedField, 'routingModule');
  assert.equal(route.reason, 'routing-unavailable');
  assert.equal(route.escalate, false);
  assert.equal(route.tier, 'watch');
  assert.equal(route.model?.id, WATCH_MODEL);
});

test('① 三次不同 severity → 三个不同 tier 的请求：模型名出现在假 server 日志里（low→watch / high→triage / critical→respond）', async () => {
  const provider = await startFakeProvider({
    // 三个模型都要能被命中；行为全部是正常流式 delta。
    behaviors: {
      [WATCH_MODEL]: 'delta',
      [TRIAGE_MODEL]: 'delta',
      [RESPOND_MODEL]: 'delta',
    },
    chunks: ['TIER-', 'OK'],
    gapMs: 0,
    usage: { prompt_tokens: 111, completion_tokens: 22 },
  });
  const capture = createCaptureLogger();
  const alerts = [
    makeAlert('tier-alert-low', 'low'),
    makeAlert('tier-alert-high', 'high'),
    makeAlert('tier-alert-critical', 'critical'),
  ];
  const harness = await startConsoleApi({
    dataDir: makeTempDir(),
    settings: tieredSettings(provider.baseUrl),
    alerts,
    hostPath: HOST_PATH,
    logger: capture.logger,
  });

  const expectations = [
    { alertId: 'tier-alert-low', severity: 'low', tier: 'watch', model: WATCH_MODEL },
    { alertId: 'tier-alert-high', severity: 'high', tier: 'triage', model: TRIAGE_MODEL },
    { alertId: 'tier-alert-critical', severity: 'critical', tier: 'respond', model: RESPOND_MODEL },
  ];
  const table = [];
  try {
    for (const [index, expected] of expectations.entries()) {
      const response = await harness.sse(`/api/v1/alerts/${expected.alertId}/explain`, {});
      assert.equal(response.status, 200, `explain ${expected.alertId}: ${response.text.slice(0, 200)}`);
      await provider.waitForRequests(index + 1);
      const usage = usageOf(response);
      assert.ok(usage !== null, `no usage event for ${expected.alertId}`);
      table.push({
        severity: expected.severity,
        'expected tier': expected.tier,
        'actual usage.tier': usage.tier,
        'expected model': expected.model,
        'actual usage.modelId': usage.modelId,
        'actual provider log model': modelAt(provider, index),
        'usage.estimatedCostUsd': usage.estimatedCostUsd,
      });
      // 日志（假 provider）与 SSE usage 必须说的是同一件事。
      assert.equal(modelAt(provider, index), expected.model, `provider log model for ${expected.severity}`);
      assert.equal(usage.modelId, expected.model, `usage.modelId for ${expected.severity}`);
      assert.equal(usage.tier, expected.tier, `usage.tier for ${expected.severity}`);
      assert.equal(usage.providerId, 'ollama-local');
      // 价格来自 settings（0.5 / 1.5 美元每百万 token），daemon 侧计算，不是编造。
      const expectedCost = (111 * 0.5 + 22 * 1.5) / 1_000_000;
      assert.equal(usage.estimatedCostUsd, Math.round(expectedCost * 1_000_000) / 1_000_000);
      // 原始事件正文不得出域（护栏，不是本席主判据）。
      assert.equal(JSON.stringify(provider.requests[index].rawBody).includes('SECRET-RAW-BODY'), false);
    }
    console.log('wire-tier-table (three severities):\n%s', JSON.stringify(table, null, 2));
    assert.deepEqual(provider.requests.map((record) => record.body.model), [WATCH_MODEL, TRIAGE_MODEL, RESPOND_MODEL]);
    assert.deepEqual(provider.modelsSeen(), [WATCH_MODEL, TRIAGE_MODEL, RESPOND_MODEL]);
    assert.equal(provider.requests.length, 3);
    // 三次都是对同一个回环假 server 的 POST /v1/chat/completions。
    assert.equal(provider.count('/v1/chat/completions'), 3);
  } finally {
    await harness.close();
    await provider.close();
  }
});

test('② 超预算拒绝升级并留记录：maxEscalationsPerHour=2 用满后，第 3 条 critical 停在 watch 模型', async () => {
  const provider = await startFakeProvider({
    behaviors: {
      [WATCH_MODEL]: 'delta',
      [TRIAGE_MODEL]: 'delta',
      [RESPOND_MODEL]: 'delta',
    },
    chunks: ['CAP-', 'OK'],
    gapMs: 0,
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });
  const capture = createCaptureLogger();
  const alerts = [
    makeAlert('tier-cap-alert-1', 'critical'),
    makeAlert('tier-cap-alert-2', 'critical'),
    makeAlert('tier-cap-alert-3', 'critical'),
    makeAlert('tier-cap-alert-4', 'critical'),
  ];
  const harness = await startConsoleApi({
    dataDir: makeTempDir(),
    settings: tieredSettings(provider.baseUrl, {
      routing: {
        escalation: {
          enabled: true,
          minSeverity: 'high',
          cooldownSeconds: 0,
          maxEscalationsPerHour: 2,
        },
      },
    }),
    alerts,
    hostPath: HOST_PATH,
    logger: capture.logger,
  });

  try {
    const responses = [];
    for (const alert of alerts) {
      responses.push(await harness.sse(`/api/v1/alerts/${alert.alert_id}/explain`, {}));
      await provider.waitForRequests(responses.length);
    }
    for (const response of responses) assert.equal(response.status, 200, response.text.slice(0, 200));

    const usages = responses.map(usageOf);
    const logs = routeLogs(capture);
    assert.equal(logs.length, 4, 'one explain.route record per explanation');

    const table = usages.map((usage, index) => ({
      alert: alerts[index].alert_id,
      'expected tier': index < 2 ? 'respond' : 'watch',
      'actual usage.tier': usage.tier,
      'actual usage.modelId': usage.modelId,
      'actual provider log model': modelAt(provider, index),
      'log deniedCode': logs[index].deniedCode,
      'log escalate': logs[index].escalate,
      'log source': logs[index].source,
    }));
    console.log('wire-hourly-cap-table:\n%s', JSON.stringify(table, null, 2));

    // 前两条：升级真的发生，强模型真的被请求。
    assert.equal(modelAt(provider, 0), RESPOND_MODEL);
    assert.equal(modelAt(provider, 1), RESPOND_MODEL);
    assert.equal(usages[0].tier, 'respond');
    assert.equal(usages[1].tier, 'respond');
    assert.equal(logs[0].deniedCode, null);
    assert.equal(logs[1].deniedCode, null);
    assert.equal(logs[0].escalate, true);

    // 第 3、4 条：小时上限拒绝升级 → 停在默认 tier（watch 模型），且**拒绝原因可查**。
    for (const index of [2, 3]) {
      assert.equal(modelAt(provider, index), WATCH_MODEL, `request ${index} must stay on the watch model`);
      assert.equal(usages[index].tier, 'watch');
      assert.equal(usages[index].modelId, WATCH_MODEL);
      assert.equal(logs[index].deniedCode, 'E_HOURLY_CAP');
      assert.equal(logs[index].tier, 'watch');
      assert.equal(logs[index].modelId, WATCH_MODEL);
      assert.equal(logs[index].escalate, false);
      assert.equal(logs[index].source, 'fallback');
      assert.equal(logs[index].escalatedFrom, null);
    }

    // 链路总账：4 次 explain = 4 次真 provider 请求，模型序列 [强, 强, 弱, 弱]。
    assert.equal(provider.requests.length, 4);
    assert.deepEqual(provider.requests.map((record) => record.body.model), [
      RESPOND_MODEL, RESPOND_MODEL, WATCH_MODEL, WATCH_MODEL,
    ]);
  } finally {
    await harness.close();
    await provider.close();
  }
});

test('③ 变异：同一批告警把 maxEscalationsPerHour 2 → 3，第 3 条就升档（证明是规则在起作用）', async () => {
  const provider = await startFakeProvider({
    behaviors: {
      [WATCH_MODEL]: 'delta',
      [TRIAGE_MODEL]: 'delta',
      [RESPOND_MODEL]: 'delta',
    },
    chunks: ['MUT-', 'OK'],
    gapMs: 0,
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });
  const capture = createCaptureLogger();
  const alerts = [
    makeAlert('tier-mut-alert-1', 'critical'),
    makeAlert('tier-mut-alert-2', 'critical'),
    makeAlert('tier-mut-alert-3', 'critical'),
  ];
  const harness = await startConsoleApi({
    dataDir: makeTempDir(),
    settings: tieredSettings(provider.baseUrl, {
      routing: {
        escalation: {
          enabled: true,
          minSeverity: 'high',
          cooldownSeconds: 0,
          maxEscalationsPerHour: 3,
        },
      },
    }),
    alerts,
    hostPath: HOST_PATH,
    logger: capture.logger,
  });

  try {
    for (const [index, alert] of alerts.entries()) {
      const response = await harness.sse(`/api/v1/alerts/${alert.alert_id}/explain`, {});
      assert.equal(response.status, 200, response.text.slice(0, 200));
      await provider.waitForRequests(index + 1);
    }
    const logs = routeLogs(capture);
    console.log('wire-cap-mutation-table:\n%s', JSON.stringify({
      'maxEscalationsPerHour': 3,
      models: provider.requests.map((record) => record.body.model),
      'log deniedCodes': logs.map((record) => record.deniedCode),
    }, null, 2));

    // 与 ② 同一批输入、只改了上限：第 3 条不再被拒，而是升到 respond。
    assert.deepEqual(provider.requests.map((record) => record.body.model), [
      RESPOND_MODEL, RESPOND_MODEL, RESPOND_MODEL,
    ]);
    assert.deepEqual(logs.map((record) => record.deniedCode), [null, null, null]);
    assert.deepEqual(logs.map((record) => record.escalate), [true, true, true]);
    assert.deepEqual(logs.map((record) => record.tier), ['respond', 'respond', 'respond']);
  } finally {
    await harness.close();
    await provider.close();
  }
});
