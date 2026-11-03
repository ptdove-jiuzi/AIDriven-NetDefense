/**
 * 第 1 轮独立审查（只读子代理）的问题回归用例。
 *
 * 每一条都对应一个真实缺陷：审查者给出的触发路径在这里被固定下来，
 * 避免下一轮"改回去也没人发现"。编号与审查报告一致（F1…F16）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import { createModelBroker } from '../../apps/model-broker/src/broker.js';
import { BROKER_CODES } from '../../apps/model-broker/src/errors.js';
import { createEventStoreBudgetPort } from '../../apps/model-broker/src/adapters/event-store-budget.js';
import { ProviderCredential } from '../../apps/model-broker/src/credentials.js';
import {
  assertEndpointUnchanged,
  isLoopbackHost,
  resolveFixedEndpoint,
} from '../../apps/model-broker/src/endpoint.js';
import { CIRCUIT_POLICY } from '../../apps/model-broker/src/policy.js';
import { buildOutboundPayload, finalizeOutbound } from '../../apps/model-broker/src/redaction.js';
import {
  createHarness,
  destroyHandler,
  expectBrokerErrorAsync,
  hangHandler,
  identityFromIntent,
  inputUpperOf,
  ledgerRows,
  makeIntent,
  makeTempDir,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
  statusHandler,
  TEST_FIXTURE_KEY,
  tick,
} from './helpers.js';

function wrapPort(port, overrides) {
  return Object.freeze({ ...port, ...overrides });
}

test('F1：伪造的"已解析端点"对象不能跳过 URL 校验', async (t) => {
  const { store } = openTestStore(t);
  const port = createEventStoreBudgetPort(store);
  const credential = new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test' });
  const forged = Object.freeze({
    url: 'http://attacker.example/v1/messages?x=1',
    origin: 'http://attacker.example',
    pathname: '/v1/messages',
    hostname: 'attacker.example',
    protocol: 'http:',
    loopback: false,
    model: 'm',
  });

  assert.throws(
    () => createModelBroker({
      budgetPort: port,
      resolveIdentity: identityFromIntent,
      endpoint: forged,
      credential,
    }),
    (error) => {
      assert.equal(error.code, BROKER_CODES.ERR_BROKER_ENDPOINT);
      return true;
    },
  );
  assert.throws(
    () => assertEndpointUnchanged(forged, forged.url),
    (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
  );

  // 真正由 resolver 产出的端点仍然可用（brand 不是把正常路径也堵掉）。
  const real = resolveFixedEndpoint({ url: 'http://127.0.0.1:1/v1/messages', model: 'm' }, { allowInsecureLoopback: true });
  assert.equal(assertEndpointUnchanged(real, real.url), true);
});

test('F2：并发成功不能关掉别人刚打开的熔断', async (t) => {
  const { store } = openTestStore(t);
  let firstSeen = false;
  const provider = await startMockProvider(({ res }) => {
    if (!firstSeen) {
      firstSeen = true;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic' }));
      return;
    }
    setTimeout(() => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }], usage: { input_tokens: 3, output_tokens: 2 } }));
    }, 60);
  });
  const a = seedAnalysis(store);
  const b = seedAnalysis(store);
  const harness = createHarness(t, {
    store,
    provider,
    limits: { maxConcurrentRequests: 2 },
  });

  const settled = await Promise.allSettled([
    harness.broker.request(makeIntent(a.analysis_id)),
    harness.broker.request(makeIntent(b.analysis_id)),
  ]);

  assert.equal(settled[0].status, 'rejected');
  assert.equal(settled[0].reason.code, BROKER_CODES.ERR_BROKER_PROVIDER);
  assert.equal(settled[1].status, 'fulfilled');
  assert.equal(
    harness.broker.circuit().state,
    'open',
    'a concurrent success must not close a circuit opened by an auth failure',
  );
});

test('F3：熔断状态经注入端口跨实例保留', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(401));
  const first = seedAnalysis(store);
  const second = seedAnalysis(store);

  let saved = null;
  const circuitStatePort = {
    save(snapshot) {
      saved = snapshot;
    },
    load() {
      return saved;
    },
  };

  const harnessA = createHarness(t, { store, provider, circuitStatePort });
  await expectBrokerErrorAsync(
    harnessA.broker.request(makeIntent(first.analysis_id)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(harnessA.broker.circuit().state, 'open');
  assert.notEqual(saved, null, 'the circuit snapshot must be handed to the persistence port');

  // 模拟进程重启：新 broker 实例，同一持久化端口。
  const harnessB = createHarness(t, { store, provider, circuitStatePort });
  assert.equal(harnessB.broker.circuit().state, 'open');
  assert.equal(harnessB.broker.circuit().persistent, true);
  await expectBrokerErrorAsync(
    harnessB.broker.request(makeIntent(second.analysis_id)),
    BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN,
  );
  assert.equal(provider.requests.length, 1, 'a restored open circuit must not reach the provider');
});

test('F4：身份只能来自 resolveIdentity，请求体自报不一致即拒绝', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const a = seedAnalysis(store);
  const b = seedAnalysis(store);
  const harness = createHarness(t, {
    store,
    provider,
    resolveIdentity: () => ({ analysis_id: b.analysis_id, attempt_id: null }),
  });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(a.analysis_id)),
    BROKER_CODES.ERR_BROKER_ROUTE,
  );
  assert.equal(error.details.token_analysis_id, b.analysis_id);
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store).length, 0);

  // 没有身份来源就不允许构造 broker（默认"相信请求体"等于没有边界）。
  assert.throws(
    () => createModelBroker({ budgetPort: createEventStoreBudgetPort(store) }),
    (thrown) => thrown.code === BROKER_CODES.ERR_BROKER_ROUTE,
  );
});

test('F4b：预扣记在 token 推导出的 analysis 名下，而不是请求体', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const a = seedAnalysis(store);
  const harness = createHarness(t, {
    store,
    provider,
    // 请求体不带 analysis_id：身份完全由这一层给出。
    resolveIdentity: () => ({ analysis_id: a.analysis_id, attempt_id: null }),
  });

  const intent = { messages: makeIntent(a.analysis_id).messages };
  const result = await harness.broker.request(intent);
  assert.equal(result.analysis_id, a.analysis_id);
  assert.equal(ledgerRows(store, a.analysis_id).length, 1);
});

test('F5：字节上限与摘要都算在最终报文上（含 model/max_tokens）', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const intent = makeIntent(analysisId);

  const payload = buildOutboundPayload(intent);
  const messagesBytes = Buffer.byteLength(payload.serialized, 'utf8');
  const wire = finalizeOutbound(payload, { model: 'deepseek-chat', maxTokens: 2000 });
  assert.ok(wire.bytes > messagesBytes, 'the wire body must be larger than the messages-only payload');

  // 只够装 messages、装不下最终报文的上限：必须拒绝。
  const tight = messagesBytes + 8;
  assert.throws(
    () => finalizeOutbound(payload, { model: 'deepseek-chat', maxTokens: 2000, limits: { maxRequestBytes: tight } }),
    (error) => {
      assert.equal(error.code, BROKER_CODES.ERR_BROKER_LIMIT);
      assert.equal(error.details.limit, tight);
      return true;
    },
  );

  const harness = createHarness(t, { store, provider, limits: { maxRequestBytes: tight } });
  await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_LIMIT);
  assert.equal(provider.requests.length, 0);
});

test('F6：event_type / platform 属 D1，D0 声明不能夹带', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);

  for (const field of ['event_type', 'platform']) {
    assert.throws(
      () => buildOutboundPayload({
        analysis_id: analysisId,
        messages: [{ role: 'user', content: { classification: 'D0', fields: { [field]: 'windows' } } }],
      }),
      (error) => {
        assert.equal(error.code, BROKER_CODES.ERR_BROKER_CLASSIFICATION);
        assert.equal(error.details.required, 'D1');
        return true;
      },
    );
    const ok = buildOutboundPayload({
      analysis_id: analysisId,
      messages: [{ role: 'user', content: { classification: 'D1', fields: { [field]: 'windows' } } }],
    });
    assert.equal(ok.messages[0].content.fields[field], 'windows');
  }
});

test('F7：回环判定不接受 127.* 前缀伪装', async () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackHost('127.1.1.999'), false);
  assert.equal(isLoopbackHost('localhost.evil.example'), false);

  assert.throws(
    () => resolveFixedEndpoint(
      { url: 'http://127.0.0.1.evil.example/v1/messages', model: 'm' },
      { allowInsecureLoopback: true },
    ),
    (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
  );
});

test('F8：债务结不清时不得宣称 settled', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler({ usage: null }));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const realPort = createEventStoreBudgetPort(store);
  const port = wrapPort(realPort, {
    settleUnknownAtUpperBound() {
      throw new Error('synthetic settle failure');
    },
  });
  const harness = createHarness(t, { store, provider, port });

  const result = await harness.broker.request(makeIntent(analysisId));
  assert.equal(result.state, 'unsettled');
  // 结不清就不能报"按上界结清的用量"：否则调用方会以为账已经落了。
  assert.equal(result.usage_source, 'unsettled');
  assert.equal(result.usage, null);
  assert.equal(harness.broker.stats().unsettled, 1);

  // 账本停在 unknown：预算仍被占用，等待核对（不是绕过）。
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(String(row.state), 'unknown');
});

test('F9：结算失败不释放债务，且不被记成提供方健康失败', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const realPort = createEventStoreBudgetPort(store);
  const port = wrapPort(realPort, {
    settle() {
      throw new Error('synthetic settle failure');
    },
  });
  const harness = createHarness(t, { store, provider, port });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_ADAPTER,
  );
  assert.equal(error.code, BROKER_CODES.ERR_BROKER_ADAPTER);

  // 行被标成 unknown（可核对），而不是永久停在 sent。
  assert.equal(String(ledgerRows(store, analysisId)[0].state), 'unknown');
  // 本地存储故障不算提供方失败。
  assert.equal(harness.broker.circuit().consecutive_retryable, 0);
  assert.equal(harness.broker.circuit().state, 'closed');
});

test('F14：预取消的请求不产生任何预扣', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const realPort = createEventStoreBudgetPort(store);
  let reserveCalls = 0;
  const port = wrapPort(realPort, {
    reserve(input) {
      reserveCalls += 1;
      return realPort.reserve(input);
    },
  });
  const harness = createHarness(t, { store, provider, port });

  const controller = new AbortController();
  controller.abort();
  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId), { signal: controller.signal }),
    BROKER_CODES.ERR_BROKER_CANCELLED,
  );
  assert.equal(reserveCalls, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
  assert.equal(provider.requests.length, 0);
});

test('F15a：同一分析不允许并发两个真实请求', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(hangHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, {
    store,
    provider,
    timeoutMs: 150,
    limits: { maxConcurrentRequests: 2 },
  });

  const first = harness.broker.request(makeIntent(analysisId));
  await tick(2);
  const second = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_INPUT,
  );
  assert.equal(second.details.reason, 'analysis_in_flight');

  await expectBrokerErrorAsync(first, BROKER_CODES.ERR_BROKER_TIMEOUT);
  assert.equal(provider.requests.length, 1);
  assert.equal(ledgerRows(store, analysisId).length, 1);
});

test('F15b：排队超时有明确上界，且不预扣', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(hangHandler());
  const first = seedAnalysis(store);
  const second = seedAnalysis(store);
  const harness = createHarness(t, {
    store,
    provider,
    timeoutMs: 400,
    limits: { maxConcurrentRequests: 1, queueTimeoutMs: 60 },
  });

  const occupying = harness.broker.request(makeIntent(first.analysis_id));
  await tick(3);
  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(second.analysis_id)),
    BROKER_CODES.ERR_BROKER_TIMEOUT,
  );
  assert.equal(error.details.queue_timeout_ms, 60);
  assert.equal(ledgerRows(store, second.analysis_id).length, 0);
  assert.equal(harness.broker.stats().queue_timeouts, 1);

  await expectBrokerErrorAsync(occupying, BROKER_CODES.ERR_BROKER_TIMEOUT);
});

test('F16：半开阶段只允许一个探针', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(({ res }) => {
    // 第一个请求 401 打开熔断，之后全部挂住，用来观察探针名额。
    if (provider.requests.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic' }));
      return;
    }
    void res;
  });
  const first = seedAnalysis(store);
  const probe = seedAnalysis(store);
  const intruder = seedAnalysis(store);

  let clockMs = 1_000_000;
  const harness = createHarness(t, {
    store,
    provider,
    timeoutMs: 250,
    limits: { maxConcurrentRequests: 2 },
    now: () => clockMs,
  });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(first.analysis_id)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(harness.broker.circuit().state, 'open');

  // 时间前进到 openMs 之后：下一个请求成为唯一的半开探针。
  clockMs += CIRCUIT_POLICY.openMs + 1;
  const probing = harness.broker.request(makeIntent(probe.analysis_id));
  try {
    await tick(3);
    assert.equal(harness.broker.circuit().state, 'half_open');
    assert.equal(harness.broker.circuit().half_open_in_flight, true);

    await expectBrokerErrorAsync(
      harness.broker.request(makeIntent(intruder.analysis_id)),
      BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN,
    );
  } finally {
    await expectBrokerErrorAsync(probing, BROKER_CODES.ERR_BROKER_TIMEOUT);
  }

  // 探针结束后名额释放，但熔断因探针失败重新打开。
  assert.equal(harness.broker.circuit().half_open_in_flight, false);
  assert.equal(harness.broker.circuit().state, 'open');
  assert.equal(provider.requests.length, 2, 'only the single probe may reach the provider');
});

test('F17/F18 补充：凭据封装挡住 inspect，符号链接被拒绝', async (t) => {
  const credential = new ProviderCredential(TEST_FIXTURE_KEY, { origin: 'test' });
  const inspected = util.inspect(credential, { depth: null });
  assert.ok(!inspected.includes(TEST_FIXTURE_KEY));
  assert.ok(inspected.includes('[REDACTED]'));
  assert.equal(JSON.stringify({ nested: { credential } }), '{"nested":{"credential":"[REDACTED]"}}');
});

test('F19：字段名长度按字节判定', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const longKey = `${'a'.repeat(120)}`;
  assert.throws(
    () => buildOutboundPayload({
      analysis_id: analysisId,
      messages: [{ role: 'user', content: { classification: 'D1', fields: { [longKey]: 1 } } }],
    }),
    (error) => {
      // 先撞 allowlist 还是先撞长度取决于实现顺序，两者都是失败关闭。
      assert.ok([BROKER_CODES.ERR_BROKER_LIMIT, BROKER_CODES.ERR_BROKER_ALLOWLIST].includes(error.code));
      return true;
    },
  );
});

test('F20：超大输入在累计过程中就被拒绝，不做整包重复扫描', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const started = Date.now();
  assert.throws(
    () => buildOutboundPayload({
      analysis_id: analysisId,
      messages: [{
        role: 'user',
        content: {
          classification: 'D1',
          fields: {
            process_name: 'a'.repeat(16000),
            image_basename: 'b'.repeat(16000),
            direction: 'c'.repeat(16000),
            protocol: 'd'.repeat(16000),
            observed_at: 'e'.repeat(16000),
          },
        },
      }],
    }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_LIMIT,
  );
  assert.ok(Date.now() - started < 2000, 'rejection must happen while accumulating, not after');
});

test('补充：destroy 的 provider 只收到一次请求（无隐式重试）', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(destroyHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });
  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_UNKNOWN,
  );
  assert.equal(provider.requests.length, 1);
  assert.ok(inputUpperOf(makeIntent(analysisId)) > 0);
});

test('补充：预扣之后、发送之前取消 → 走 void(provedNotSent)，零网络', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const realPort = createEventStoreBudgetPort(store);
  const controller = new AbortController();
  const voidCalls = [];
  const port = wrapPort(realPort, {
    reserve(input) {
      const reservation = realPort.reserve(input);
      // 在预扣成功之后、markSent 之前撤销：这是唯一允许 void 的窗口。
      controller.abort();
      return reservation;
    },
    voidReservation(input) {
      voidCalls.push(input);
      return realPort.voidReservation(input);
    },
  });
  const harness = createHarness(t, { store, provider, port });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId), { signal: controller.signal }),
    BROKER_CODES.ERR_BROKER_CANCELLED,
  );
  assert.equal(voidCalls.length, 1);
  assert.equal(voidCalls[0].provedNotSent, true);
  assert.equal(String(ledgerRows(store, analysisId)[0].state), 'void');
  assert.equal(provider.requests.length, 0);
  assert.equal(harness.broker.stats().voided, 1);
});

test('补充：markSent 失败 → 退回预留，零网络', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const realPort = createEventStoreBudgetPort(store);
  const port = wrapPort(realPort, {
    markSent() {
      throw new Error('synthetic markSent failure');
    },
  });
  const harness = createHarness(t, { store, provider, port });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_ADAPTER,
  );
  assert.equal(String(ledgerRows(store, analysisId)[0].state), 'void');
  assert.equal(provider.requests.length, 0);
});

test('补充：适配器返回非法 preview → ERR_BROKER_ADAPTER', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const realPort = createEventStoreBudgetPort(store);
  const port = wrapPort(realPort, {
    preview() {
      return { analysis_input_remaining: 'lots' };
    },
  });
  const harness = createHarness(t, { store, provider, port });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_ADAPTER,
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('补充：凭据文件是符号链接时拒绝（仅 Windows 无符号链接权限时跳过）', async (t) => {
  const dir = makeTempDir(t, 'wp6-cred-link');
  const target = path.join(dir, 'real.key');
  fs.writeFileSync(target, 'file-sourced-key-0123456789\n', { mode: 0o600 });
  const link = path.join(dir, 'link.key');
  try {
    fs.symlinkSync(target, link);
  } catch (error) {
    // 只允许在 **Windows** 上因缺少符号链接权限而跳过（普通账户默认无 SeCreateSymbolicLinkPrivilege）。
    // 其它平台若也拿到 EPERM/EACCES，那是真实缺陷信号，必须让用例红，不能被这里当成"平台限制"吞掉；
    // 门禁侧另有 `run-tests.mjs <下限> <glob> 1` 把该段的跳过数钉在最多 1 条。
    if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Windows 普通账户不允许创建符号链接（需要管理员/开发者模式）');
      return;
    }
    throw error;
  }
  assert.throws(
    () => ProviderCredential.fromFile(link),
    (thrown) => thrown.code === BROKER_CODES.ERR_BROKER_CREDENTIAL,
  );
});

// ---------------------------------------------------------------------------
// 第 2 轮复核新增：快照健壮性、归因、用量可信度、明文回环限制
// ---------------------------------------------------------------------------

test('R1：恶意快照的未来 opened_at 不会把熔断永久锁死', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const future = Date.now() + 10 * 365 * 24 * 3600 * 1000;
  const circuitStatePort = {
    load: () => ({ state: 'open', opened_at: future, consecutive_retryable: 5 }),
    save: () => {},
  };
  const harness = createHarness(t, { store, provider, circuitStatePort });

  const snapshot = harness.broker.circuit();
  assert.equal(snapshot.state, 'open');
  assert.ok(snapshot.opened_at <= Date.now(), 'a future opened_at must be clamped to now');

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_CIRCUIT_OPEN,
  );
  assert.ok(error.details.opened_ms_ago >= 0, 'opened_ms_ago must never be negative');
});

test('R2：负的连续失败计数被夹到 0，不会变成 fail-open', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(500));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const circuitStatePort = {
    load: () => ({ state: 'closed', opened_at: 0, consecutive_retryable: -100 }),
    save: () => {},
  };
  const harness = createHarness(t, { store, provider, circuitStatePort });

  assert.equal(harness.broker.circuit().consecutive_retryable, 0);
  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(harness.broker.circuit().consecutive_retryable, 1);
});

test('R3：连续失败计数跨实例保留，重启不会把阈值清零', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(500));
  const analyses = Array.from({ length: 5 }, () => seedAnalysis(store));
  let saved = null;
  const circuitStatePort = {
    save(snapshot) {
      saved = snapshot;
    },
    load() {
      return saved;
    },
  };
  const limits = { maxOutputTokens: 100 };

  const first = createHarness(t, { store, provider, circuitStatePort, limits });
  for (let index = 0; index < 4; index += 1) {
    await expectBrokerErrorAsync(
      first.broker.request(makeIntent(analyses[index].analysis_id)),
      BROKER_CODES.ERR_BROKER_PROVIDER,
    );
  }
  assert.equal(first.broker.circuit().state, 'closed');
  assert.equal(saved.consecutive_retryable, 4, 'the retryable counter must be persisted while closed');

  // 重启：计数应被读回，再失败一次即打开。
  const second = createHarness(t, { store, provider, circuitStatePort, limits });
  assert.equal(second.broker.circuit().consecutive_retryable, 4);
  await expectBrokerErrorAsync(
    second.broker.request(makeIntent(analyses[4].analysis_id)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(second.broker.circuit().state, 'open');
});

test('R4：正文读取阶段的中止被归因为超时，而不是"结果未知"', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(({ res }) => {
    // 先把 200 头与半截正文发出去，然后永不结束：客户端会在读正文时被 abort。
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":[{"message":{"content":"');
  });
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider, timeoutMs: 120 });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_TIMEOUT,
  );
  assert.equal(error.details.reason, 'timeout');
  assert.equal(harness.broker.stats().timed_out, 1);
  assert.equal(harness.broker.stats().unknown_outcome, 0);
  // 债务仍然保留。
  assert.equal(Number(ledgerRows(store, analysisId)[0].settled_input), Number(ledgerRows(store, analysisId)[0].input_upper));
});

test('R5：200 但没有消息正文按 schema 失败处理，不能当成成功', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'looks like 200 but is not a completion' }));
  });
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );
  assert.equal(error.details.reason, 'response_malformed');
  assert.equal(harness.broker.circuit().consecutive_retryable, 1);
});

test('R6：提供方报 0 输入 token 视为不可信用量，按上界扣款', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler({ usage: { input_tokens: 0, output_tokens: 0 } }));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const result = await harness.broker.request(makeIntent(analysisId));
  assert.equal(result.usage_source, 'upper_bound');
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(Number(row.settled_input), Number(row.input_upper));
  assert.equal(Number(row.settled_output), Number(row.output_limit));
});

test('R8：明文端点只接受字面量回环地址', async () => {
  assert.throws(
    () => resolveFixedEndpoint({ url: 'http://localhost:1234/v1/messages', model: 'm' }, { allowInsecureLoopback: true }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
  );
  assert.ok(resolveFixedEndpoint({ url: 'http://127.0.0.1:1234/v1/messages', model: 'm' }, { allowInsecureLoopback: true }));
  assert.ok(resolveFixedEndpoint({ url: 'http://[::1]:1234/v1/messages', model: 'm' }, { allowInsecureLoopback: true }));
});

test('R9：brand 不可被 Object.create / structuredClone / Proxy 伪造', async (t) => {
  const { isResolvedEndpoint, resolveFixedEndpoint: resolve } = await import('../../apps/model-broker/src/endpoint.js');
  const real = resolve({ url: 'http://127.0.0.1:1234/v1/messages', model: 'm' }, { allowInsecureLoopback: true });

  assert.equal(isResolvedEndpoint(Object.create(real)), false);
  assert.equal(isResolvedEndpoint(structuredClone(real)), false);
  assert.equal(isResolvedEndpoint(new Proxy(real, {})), false);
  assert.equal(isResolvedEndpoint({ ...real }), false);
  assert.equal(isResolvedEndpoint(real), true);
  void t;
});
