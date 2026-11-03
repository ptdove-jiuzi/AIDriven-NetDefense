/**
 * 凭据与固定端点（AT-DATA-004 / 设计不变量 2）。
 *
 * 这里最重要的断言不是"抛错"，而是**凭据没有出现在任何可回显的通道里**：
 * 日志事件、错误 message、错误 details、JSON.stringify、String()。
 * 一个只在代码里"不打印"的实现，会在上层包装错误时把 Authorization 带出去。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { BROKER_CODES } from '../../apps/model-broker/src/errors.js';
import {
  CREDENTIAL_ENV_NAME,
  ProviderCredential,
  loadProviderCredential,
} from '../../apps/model-broker/src/credentials.js';
import { resolveFixedEndpoint } from '../../apps/model-broker/src/endpoint.js';
import {
  createHarness,
  expectBrokerErrorAsync,
  ledgerRows,
  makeIntent,
  makeTempDir,
  okHandler,
  openTestStore,
  seedAnalysis,
  startMockProvider,
  statusHandler,
  TEST_FIXTURE_KEY,
} from './helpers.js';

test('没有凭据：在预扣前失败关闭，且不产生网络请求', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider, credential: null });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_CREDENTIAL,
  );
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('凭据只出现在 Authorization header，不进入日志/错误/JSON', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(statusHandler(401));
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_PROVIDER,
  );

  // 1. 确实带上了（否则提供方鉴权根本无从谈起）。
  assert.equal(provider.requests[0].headers.authorization, `Bearer ${TEST_FIXTURE_KEY}`);

  // 2. 不在错误对象里。
  const errorText = `${error.message} ${JSON.stringify(error.details ?? {})}`;
  assert.ok(!errorText.includes(TEST_FIXTURE_KEY), 'error must not echo the credential');

  // 3. 不在日志里。
  assert.ok(harness.logs.events.length > 0, 'the run must emit log events');
  assert.ok(!harness.logs.asJson().includes(TEST_FIXTURE_KEY), 'logs must not contain the credential');

  // 4. 凭据对象自身不可被序列化出来。
  const credential = harness.credential;
  assert.equal(JSON.stringify(credential), '"[REDACTED]"');
  assert.ok(String(credential).includes('[REDACTED]'));
  assert.ok(!String(credential).includes(TEST_FIXTURE_KEY));
  assert.ok(!JSON.stringify({ credential }).includes(TEST_FIXTURE_KEY));
});

test('凭据来源：显式 > 受保护文件 > 环境变量', async (t) => {
  const dir = makeTempDir(t, 'wp6-cred');
  const filePath = path.join(dir, 'provider.key');
  fs.writeFileSync(filePath, 'file-sourced-key-0123456789\n', { mode: 0o600 });

  const fromFile = loadProviderCredential({ env: {}, filePath });
  assert.ok(fromFile instanceof ProviderCredential);
  assert.equal(fromFile.origin, 'file:configured');
  assert.equal(fromFile.header(), 'Bearer file-sourced-key-0123456789');

  const fromEnv = loadProviderCredential({ env: { [CREDENTIAL_ENV_NAME]: 'env-sourced-key-0123456789' } });
  assert.equal(fromEnv.origin, `env:${CREDENTIAL_ENV_NAME}`);

  const explicit = new ProviderCredential('explicit-key-0123456789', { origin: 'explicit' });
  assert.equal(loadProviderCredential({ credential: explicit }).origin, 'explicit');

  assert.equal(loadProviderCredential({ env: {} }), null, 'missing credential yields null, not a crash');
});

test('凭据文件：不存在、非普通文件、超长都失败关闭', async (t) => {
  const dir = makeTempDir(t, 'wp6-cred-bad');
  assert.throws(
    () => ProviderCredential.fromFile(path.join(dir, 'nope.key')),
    (error) => error.code === BROKER_CODES.ERR_BROKER_CREDENTIAL,
  );
  assert.throws(
    () => ProviderCredential.fromFile(dir),
    (error) => error.code === BROKER_CODES.ERR_BROKER_CREDENTIAL,
  );

  const big = path.join(dir, 'big.key');
  fs.writeFileSync(big, 'k'.repeat(5000));
  assert.throws(
    () => ProviderCredential.fromFile(big),
    (error) => error.code === BROKER_CODES.ERR_BROKER_CREDENTIAL,
  );
});

test('凭据内容校验：过短与多行都被拒绝，且错误不回显内容', async (t) => {
  assert.throws(
    () => new ProviderCredential('abc123', { origin: 'test' }),
    (error) => {
      assert.equal(error.code, BROKER_CODES.ERR_BROKER_CREDENTIAL);
      assert.ok(!error.message.includes('abc123'), 'the rejected value must not be echoed');
      return true;
    },
  );
  assert.throws(
    () => new ProviderCredential('line-one-0123456789\nline-two', { origin: 'test' }),
    (error) => error.code === BROKER_CODES.ERR_BROKER_CREDENTIAL,
  );
});

test('端点必须是固定 https 或显式允许的本地 mock', async () => {
  assert.throws(
    () => resolveFixedEndpoint({ url: 'http://api.example.com/v1/messages', model: 'm' }, {}),
    (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
  );
  assert.ok(resolveFixedEndpoint(
    { url: 'http://127.0.0.1:1234/v1/messages', model: 'm' },
    { allowInsecureLoopback: true },
  ));
  // 明文 + 非回环，即使显式允许也不行。
  assert.throws(
    () => resolveFixedEndpoint(
      { url: 'http://10.0.0.5/v1/messages', model: 'm' },
      { allowInsecureLoopback: true },
    ),
    (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
  );
});

test('端点拒绝 userinfo / query / fragment / 裸域名', async () => {
  const cases = [
    'https://user:pass@api.example.com/v1/messages',
    'https://api.example.com/v1/messages?target=evil',
    'https://api.example.com/v1/messages#frag',
    'https://api.example.com/',
  ];
  for (const url of cases) {
    assert.throws(
      () => resolveFixedEndpoint({ url, model: 'm' }, {}),
      (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
    );
  }
  assert.throws(
    () => resolveFixedEndpoint({ url: 'not a url', model: 'm' }, {}),
    (error) => error.code === BROKER_CODES.ERR_BROKER_ENDPOINT,
  );
});

test('模型路由固定：请求体自报其它模型即拒绝，且不预扣', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(okHandler());
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  const error = await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId, { model: 'gpt-5-other' })),
    BROKER_CODES.ERR_BROKER_ROUTE,
  );
  assert.equal(error.details.configured, 'deepseek-chat');
  assert.equal(provider.requests.length, 0);
  assert.equal(ledgerRows(store, analysisId).length, 0);
});

test('不跟随重定向：跳转目标永远收不到请求，债务仍按上界结清', async (t) => {
  const { store } = openTestStore(t);
  const provider = await startMockProvider(({ res }) => {
    res.writeHead(302, { location: '/v2/messages' });
    res.end();
  });
  const { analysis_id: analysisId } = seedAnalysis(store);
  const harness = createHarness(t, { store, provider });

  await expectBrokerErrorAsync(
    harness.broker.request(makeIntent(analysisId)),
    BROKER_CODES.ERR_BROKER_UNKNOWN,
  );

  assert.equal(provider.requests.length, 1, 'only the original endpoint may be contacted');
  assert.ok(provider.requests.every((request) => request.url === '/v1/messages'));
  const row = ledgerRows(store, analysisId)[0];
  assert.equal(String(row.state), 'settled');
  assert.equal(Number(row.settled_input), Number(row.input_upper));
});
