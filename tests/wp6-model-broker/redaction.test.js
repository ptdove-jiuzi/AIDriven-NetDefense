/**
 * 出域检查（AT-DATA-001 / AT-MUT-001 的 broker 侧）。
 *
 * 每个用例都断言同一组结论：**被拒绝时零网络、零账本行**。
 * 只断言"抛了错"是不够的——错误可能发生在三行之后、已经在预扣甚至发送之后。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BROKER_CODES } from '../../apps/model-broker/src/errors.js';
import { buildOutboundPayload, estimateInputUpper, finalizeOutbound } from '../../apps/model-broker/src/redaction.js';
import {
  createHarness,
  expectBrokerErrorAsync,
  ledgerRows,
  makeIntent,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
} from './helpers.js';

const CANARY_SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
const CANARY_USER = 'alice-canary';

test('D1 字段经脱敏后出域：用户名与邮箱不可见', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const intent = makeIntent(analysisId, {
    fields: {
      process_name: `C:\\Users\\${CANARY_USER}\\app.exe`,
      rule_id: 'proc_persist',
      count: 3,
    },
  });
  const result = await harness.broker.request(intent);

  assert.equal(provider.requests.length, 1);
  const raw = provider.requests[0].raw;
  assert.ok(!raw.includes(CANARY_USER), 'username must not reach the provider');
  assert.ok(raw.includes('<user>'), 'profile path must be replaced with a placeholder');
  assert.ok(result.redactions.length >= 1);
  assert.equal(result.redactions[0].field, 'process_name');
  assert.deepEqual([...result.redactions[0].rules], ['windows_profile_path']);
});

test('自由文本被拒绝：没有字段身份就没有 allowlist', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  await expectBrokerErrorAsync(
    harness.broker.request({
      analysis_id: analysisId,
      messages: [{ role: 'user', content: 'raw evidence: powershell -enc AAAA' }],
    }),
    BROKER_CODES.ERR_BROKER_ALLOWLIST,
  );

  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('D2/D3 分级声明被拒绝', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  for (const classification of ['D2', 'D3', 'd1', 'UNKNOWN']) {
    const intent = {
      analysis_id: analysisId,
      messages: [{ role: 'user', content: { classification, fields: { rule_id: 'x' } } }],
    };
    await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_CLASSIFICATION);
  }
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('D0 声明不能夹带 D1 字段', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const intent = {
    analysis_id: analysisId,
    messages: [{
      role: 'user',
      content: { classification: 'D0', fields: { rule_id: 'proc_persist', process_name: 'demo.exe' } },
    }],
  };
  const error = await expectBrokerErrorAsync(
    harness.broker.request(intent),
    BROKER_CODES.ERR_BROKER_CLASSIFICATION,
  );
  assert.equal(error.details.field, 'process_name');
  assert.equal(error.details.required, 'D1');
  assert.equal(provider.requests.length, 0);
});

test('未知字段被拒绝（allowlist 之外一律失败关闭）', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  for (const field of ['command_line', 'user_name', 'file_path', 'raw_log', 'api_key']) {
    const intent = makeIntent(analysisId, { fields: { [field]: 'value' } });
    const error = await expectBrokerErrorAsync(
      harness.broker.request(intent),
      BROKER_CODES.ERR_BROKER_ALLOWLIST,
    );
    assert.equal(error.details.field, field);
  }
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('脱敏失败：检出秘密形态即拒绝，且错误消息不回显原文', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const intent = makeIntent(analysisId, { fields: { process_name: `leak ${CANARY_SECRET}` } });
  const error = await expectBrokerErrorAsync(
    harness.broker.request(intent),
    BROKER_CODES.ERR_BROKER_REDACTION_FAILED,
  );

  assert.ok(Array.isArray(error.details.rules));
  assert.ok(error.details.rules.length > 0);
  const serialized = `${error.message} ${JSON.stringify(error.details)}`;
  assert.ok(!serialized.includes(CANARY_SECRET), 'the error must not echo the secret');
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('私钥块与连接串同样触发失败关闭', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const samples = [
    // 样本必须在运行时逐字命中密钥块检测；拆成两段只是为了让仓库扫描不误报。
    ['-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIE...'].join(''),
    'postgres://svc:hunter2@db.internal:5432/aegis',
    'password=hunter2hunter2',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  ];
  for (const sample of samples) {
    await expectBrokerErrorAsync(
      harness.broker.request(makeIntent(analysisId, { fields: { process_name: sample } })),
      BROKER_CODES.ERR_BROKER_REDACTION_FAILED,
    );
  }
  assert.equal(provider.requests.length, 0);
});

test('单值字节上限：超过 16KiB 直接拒绝', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const huge = 'a'.repeat(17000);
  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId, { fields: { process_name: huge } })),
    BROKER_CODES.ERR_BROKER_LIMIT,
  );
  assert.equal(error.details.limit, 16384);
  assert.equal(provider.requests.length, 0);
});

test('请求体总字节上限：多字段累加超限即拒绝', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider, limits: { maxRequestBytes: 200 } });

  const intent = makeIntent(analysisId, {
    fields: { process_name: 'demo.exe', rule_id: 'proc_persist', count: 1 },
  });
  assert.throws(
    () => buildOutboundPayload(intent, { limits: { maxRequestBytes: 80 } }),
    (error) => {
      assert.equal(error.code, BROKER_CODES.ERR_BROKER_LIMIT);
      assert.equal(error.details.limit, 80);
      return true;
    },
  );
  await expectBrokerErrorAsync(harness.broker.request(intent), BROKER_CODES.ERR_BROKER_LIMIT);
  assert.equal(provider.requests.length, 0);
});

test('消息条数、字段条数、非法标量类型都被拒绝', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const base = makeIntent(analysisId);

  assert.throws(
    () => buildOutboundPayload({ analysis_id: analysisId, messages: [...base.messages, ...base.messages] }, {
      limits: { maxMessages: 3 },
    }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_LIMIT,
  );
  assert.throws(
    () => buildOutboundPayload({ analysis_id: analysisId, messages: base.messages }, { limits: { maxFields: 1 } }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_LIMIT,
  );
  // 嵌套对象 / 数组 / null：不做递归"尽力脱敏"，直接拒绝。
  for (const value of [{ nested: true }, ['a'], null]) {
    assert.throws(
      () => buildOutboundPayload({
        analysis_id: analysisId,
        messages: [{ role: 'user', content: { classification: 'D1', fields: { process_name: value } } }],
      }),
      (error) => error.code === BROKER_CODES.ERR_BROKER_INPUT,
    );
  }
  // 非安全整数。
  assert.throws(
    () => buildOutboundPayload({
      analysis_id: analysisId,
      messages: [{ role: 'user', content: { classification: 'D1', fields: { count: 1.5 } } }],
    }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_INPUT,
  );
  // 未授权的角色（tool 必须先折叠进 user）。
  assert.throws(
    () => buildOutboundPayload({
      analysis_id: analysisId,
      messages: [{ role: 'tool', content: { classification: 'D1', fields: { rule_id: 'x' } } }],
    }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_INPUT,
  );
});

test('digest 与字段输入顺序无关：同内容同摘要', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);

  const forward = buildOutboundPayload({
    analysis_id: analysisId,
    messages: [{ role: 'user', content: { classification: 'D1', fields: { rule_id: 'r', process_name: 'p', count: 2 } } }],
  });
  const reversed = buildOutboundPayload({
    analysis_id: analysisId,
    messages: [{ role: 'user', content: { classification: 'D1', fields: { count: 2, process_name: 'p', rule_id: 'r' } } }],
  });
  const wireForward = finalizeOutbound(forward, { model: 'm', maxTokens: 100 });
  const wireReversed = finalizeOutbound(reversed, { model: 'm', maxTokens: 100 });
  assert.equal(wireForward.digest, wireReversed.digest);
  assert.equal(wireForward.body, wireReversed.body);
});

test('input_upper 是保守上界：不小于最终报文字节数', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const payload = buildOutboundPayload(makeIntent(analysisId));
  const wire = finalizeOutbound(payload, { model: 'm', maxTokens: 2000 });
  const upper = estimateInputUpper(wire.body, payload.messages.length);
  assert.ok(upper > Buffer.byteLength(wire.body, 'utf8'));
});

test('摘要绑定 model 与 max_tokens：换模型/换预算即换摘要', async (t) => {
  const { store } = openTestStore(t);
  const { analysis_id: analysisId } = seedAnalysis(store);
  const payload = buildOutboundPayload(makeIntent(analysisId));

  const base = finalizeOutbound(payload, { model: 'm-one', maxTokens: 100 });
  const otherModel = finalizeOutbound(payload, { model: 'm-two', maxTokens: 100 });
  const otherBudget = finalizeOutbound(payload, { model: 'm-one', maxTokens: 900 });

  assert.notEqual(base.digest, otherModel.digest);
  assert.notEqual(base.digest, otherBudget.digest);
  assert.ok(base.bytes < base.body.length + 1);
});

test('ANSI 控制序列被剥离，不进入外发载荷', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const result = await harness.broker.request(makeIntent(analysisId, {
    fields: { process_name: '\u001B[31mevil.exe\u001B[0m' },
  }));
  assert.ok(!provider.requests[0].raw.includes('\\u001b'));
  assert.ok(provider.requests[0].raw.includes('evil.exe'));
  assert.deepEqual([...result.redactions[0].rules], ['ansi_escape']);
});
