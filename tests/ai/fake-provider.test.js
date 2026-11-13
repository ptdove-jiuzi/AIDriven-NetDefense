/**
 * AI-ENABLE · fake-provider 自证（node:test + native fetch 客户端）
 *
 * 证明目标是「客户端能区分五种行为」和「模型名 → 行为映射真的生效」，
 * 不是「代码里写了 if」。客户端一侧刻意只用 native fetch，不 import 假 provider 的内部状态。
 *
 * 跑法：node --test tests/ai/fake-provider.test.js
 * 端口一律 127.0.0.1:0；测试里没有任何真实 key，canary 只有 fixture 前缀。
 *
 * @author PT-dove
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BEHAVIORS, startFakeProvider } from './fake-provider.mjs';

/** 只用于断言"请求确实带上了凭据"，不是任何真实服务商的 key。 */
const CANARY = 'fixture-not-a-real-provider-key-0001';

function jsonHeaders() {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${CANARY}`,
    'x-fixture-source': 'tests/ai/fake-provider.test.js',
  };
}

function postChat(provider, body, init = {}) {
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
    ...init,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 SSE 文本拆成 data 帧；同时给出"是否有 [DONE]"和所有增量文本。 */
function parseSse(text) {
  const payloads = [];
  let done = false;
  let doneCount = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice('data: '.length);
    if (raw === '[DONE]') {
      done = true;
      doneCount += 1;
      continue;
    }
    payloads.push(JSON.parse(raw));
  }
  const contents = payloads.flatMap((payload) =>
    (payload.choices ?? [])
      .map((choice) => choice?.delta?.content)
      .filter((value) => typeof value === 'string'));
  return { payloads, done, doneCount, contents };
}

/** 读到流结束；返回收到的文本与（若中断）错误。 */
async function readStream(response) {
  const reader = response.body.getReader();
  let text = '';
  let error = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) text += Buffer.from(value).toString('utf8');
    }
  } catch (caught) {
    error = caught;
  }
  return { text, error };
}

// ---------------------------------------------------------------------------
// 0. 契约形状
// ---------------------------------------------------------------------------

test('BEHAVIORS 冻结且恰好五种（跨席契约）', () => {
  assert.deepEqual([...BEHAVIORS], ['delta', 'tool-call', 'rate-limit', 'timeout', 'truncated']);
  assert.equal(Object.isFrozen(BEHAVIORS), true);
});

test('非法 options 立刻抛 TypeError（不静默降级）', async () => {
  await assert.rejects(() => startFakeProvider({ defaultBehavior: 'nope' }), /defaultBehavior/);
  await assert.rejects(() => startFakeProvider({ behaviors: { m: 'nope' } }), /behaviors\["m"\]/);
  await assert.rejects(() => startFakeProvider({ chunks: [] }), /chunks/);
  await assert.rejects(() => startFakeProvider({ gapMs: -1 }), /gapMs/);
  // OpenAI 线格式：function.arguments 是 JSON **字符串**；传对象必须当场报错，不能悄悄序列化。
  await assert.rejects(
    () => startFakeProvider({ toolCall: { name: 'x', arguments: { target: 'host-1' } } }),
    /toolCall\.arguments must be a JSON string/,
  );
});

// ---------------------------------------------------------------------------
// 1. 五种行为各自可从客户端区分
// ---------------------------------------------------------------------------

test('delta：200 text/event-stream，增量拼接 === chunks.join("")，末尾 usage 帧 + [DONE]', async () => {
  const chunks = ['alpha-', 'beta-', 'gamma'];
  const usage = { prompt_tokens: 7, completion_tokens: 11 };
  const provider = await startFakeProvider({ chunks, gapMs: 2, usage, defaultBehavior: 'delta' });
  try {
    const response = await postChat(provider, { model: 'fixture-delta', stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);

    const text = await response.text();
    const sse = parseSse(text);
    assert.equal(sse.done, true);
    assert.equal(sse.doneCount, 1);
    assert.equal(sse.contents.join(''), chunks.join(''));

    const usageFrame = sse.payloads.find((payload) => payload.usage !== undefined);
    assert.ok(usageFrame, 'delta 末尾必须带 usage 帧');
    assert.deepEqual(usageFrame.usage, {
      prompt_tokens: 7,
      completion_tokens: 11,
      total_tokens: 18,
    });
    const finalFrame = sse.payloads.at(-1);
    assert.equal(finalFrame.choices[0].finish_reason, 'stop');

    const record = provider.requests[0];
    assert.equal(record.method, 'POST');
    assert.equal(record.path, '/v1/chat/completions');
    assert.equal(record.model, 'fixture-delta');
    assert.equal(record.stream, true);
    assert.equal(record.behavior, 'delta');
    assert.equal(record.statusWritten, true);
    assert.equal(record.responseEnded, true);
    assert.equal(record.abortedAt, null);
    assert.equal(typeof record.closedAfterMs, 'number');
    assert.equal(provider.count('/v1/chat/completions'), 1);
  } finally {
    await provider.close();
  }
});

test('tool-call：SSE 里出现 delta.tool_calls（function.name/arguments），随后 [DONE]', async () => {
  const toolCall = { name: 'lookup_alert', arguments: '{"alertId":"al-42","why":"explain"}' };
  const provider = await startFakeProvider({ behaviors: { 'fixture-tool': 'tool-call' }, toolCall });
  try {
    const response = await postChat(provider, { model: 'fixture-tool', stream: true });
    assert.equal(response.status, 200);
    const sse = parseSse(await response.text());

    const toolFrame = sse.payloads.find((payload) => payload.choices?.[0]?.delta?.tool_calls !== undefined);
    assert.ok(toolFrame, 'tool-call 行为必须出现 delta.tool_calls 帧');
    const call = toolFrame.choices[0].delta.tool_calls[0];
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'lookup_alert');
    assert.equal(call.function.arguments, toolCall.arguments);
    assert.deepEqual(JSON.parse(call.function.arguments), { alertId: 'al-42', why: 'explain' });

    const finish = sse.payloads.at(-1).choices[0].finish_reason;
    assert.equal(finish, 'tool_calls');
    assert.equal(sse.done, true);
    assert.equal(provider.requests[0].behavior, 'tool-call');
  } finally {
    await provider.close();
  }
});

test('rate-limit：429 application/json，error.type === rate_limit_error', async () => {
  const provider = await startFakeProvider({ behaviors: { 'fixture-rate-limit': 'rate-limit' } });
  try {
    const response = await postChat(provider, { model: 'fixture-rate-limit', stream: true });
    assert.equal(response.status, 429);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const payload = await response.json();
    assert.equal(payload.error.type, 'rate_limit_error');
    assert.equal(payload.error.message, 'synthetic rate limit');

    const record = provider.requests[0];
    assert.equal(record.statusWritten, true);
    assert.equal(record.responseEnded, true);
    assert.equal(provider.count('/v1/chat/completions'), 1);
  } finally {
    await provider.close();
  }
});

test('timeout：hangMs 内拿不到响应头，服务端 destroy 后 closedAt 落账', async () => {
  const hangMs = 400;
  const provider = await startFakeProvider({ behaviors: { 'fixture-timeout': 'timeout' }, hangMs });
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error('test guard fired')), 5_000);
  try {
    const startedAt = Date.now();
    // settle 成 value/error 都行，只为先挂好 rejection handler，避免 unhandledRejection。
    const settled = postChat(provider, { model: 'fixture-timeout', stream: true }, { signal: controller.signal })
      .then((response) => ({ response }), (error) => ({ error }));

    const first = await Promise.race([
      settled.then(() => 'headers'),
      delay(150).then(() => 'no-headers'),
    ]);
    assert.equal(first, 'no-headers', 'timeout 行为在 150 ms 内不得返回响应头');

    const outcome = await settled;
    assert.ok(outcome.error instanceof Error, 'hangMs 到点后客户端 fetch 必须失败（服务端 destroy）');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= hangMs - 50, `fetch 失败不应早于 hangMs，实测 ${elapsed} ms`);

    // 客户端先看到断开、服务端 close 事件可能晚一拍：用契约里的 waitForAbort 等落账。
    const record = await provider.waitForAbort(1_000);
    assert.equal(record.behavior, 'timeout');
    assert.equal(record.statusWritten, false, 'timeout 行为不得写响应头');
    assert.equal(record.responseEnded, false);
    assert.notEqual(record.closedAt, null);
    assert.ok(record.closedAfterMs >= hangMs - 50, `closedAfterMs 实测 ${record.closedAfterMs} ms`);
    assert.notEqual(record.abortedAt, null);
    assert.equal(provider.count('/v1/chat/completions'), 1);
  } finally {
    clearTimeout(guard);
    controller.abort();
    await provider.close();
  }
});

test('truncated：写 truncateAfterChunks 帧后 destroy，无 [DONE]、读流中断', async () => {
  const chunks = ['t1', 't2', 't3', 't4'];
  const provider = await startFakeProvider({
    behaviors: { 'fixture-truncated': 'truncated' },
    chunks,
    truncateAfterChunks: 2,
    gapMs: 2,
  });
  try {
    const response = await postChat(provider, { model: 'fixture-truncated', stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);

    const { text, error } = await readStream(response);
    const sse = parseSse(text);
    assert.equal(sse.done, false, 'truncated 不得出现 [DONE]');
    assert.equal(sse.doneCount, 0);
    assert.ok(sse.payloads.length >= 1, 'truncated 至少已写出部分帧');
    assert.ok(sse.payloads.length <= 2, `truncateAfterChunks=2，实收 ${sse.payloads.length} 帧`);
    assert.equal(sse.contents[0], 't1');
    assert.ok(error instanceof Error, '截断必须是"中断"：客户端读流应报错');

    // 服务端 destroy 的 close 事件可能比客户端读流出错晚一拍：用契约的 waitForAbort 等落账。
    const record = await provider.waitForAbort(1_000);
    assert.equal(record.behavior, 'truncated');
    assert.equal(record.statusWritten, true);
    assert.equal(record.responseEnded, false, 'truncated 不得 end');
    assert.notEqual(record.abortedAt, null);
    assert.equal(provider.count('/v1/chat/completions'), 1);
  } finally {
    await provider.close();
  }
});

// ---------------------------------------------------------------------------
// 2. 模型名 → 行为映射（同一服务器上互不影响）
// ---------------------------------------------------------------------------

test('同一实例连续打五种行为：全部可区分，且无 fetch failed / 连接级异常（截断/超时后同 origin 仍可用）', async () => {
  const provider = await startFakeProvider({
    behaviors: {
      'seq-delta': 'delta',
      'seq-rate-limit': 'rate-limit',
      'seq-tool': 'tool-call',
      'seq-truncated': 'truncated',
      'seq-timeout': 'timeout',
    },
    chunks: ['s1-', 's2', 's3'],
    gapMs: 2,
    usage: { prompt_tokens: 5, completion_tokens: 6 },
    toolCall: { name: 'seq_lookup', arguments: '{"id":"a-1"}' },
    hangMs: 250,
  });
  const connectionErrors = [];
  const seenBehaviors = [];
  const expectCleanResponse = async (model) => {
    const response = await postChat(provider, { model, stream: true }).catch((error) => {
      connectionErrors.push(`${model}: ${error?.name}: ${error?.message}`);
      return null;
    });
    assert.notEqual(response, null, `同实例连续打时 ${model} 出现连接级异常（fetch failed / SocketError）`);
    return response;
  };
  try {
    // 1) delta
    const deltaResponse = await expectCleanResponse('seq-delta');
    const deltaSse = parseSse(await deltaResponse.text());
    assert.equal(deltaResponse.status, 200);
    assert.equal(deltaSse.done, true);
    assert.equal(deltaSse.contents.join(''), 's1-s2s3');
    seenBehaviors.push('delta');

    // 2) truncated → 3) 同 origin 的 delta（关键回归：截断不能污染客户端连接池）
    const truncatedResponse = await expectCleanResponse('seq-truncated');
    assert.equal(truncatedResponse.status, 200);
    const truncatedRead = await readStream(truncatedResponse);
    assert.equal(parseSse(truncatedRead.text).done, false);
    assert.ok(truncatedRead.error instanceof Error, 'truncated 读流应中断');
    seenBehaviors.push('truncated');

    const afterTruncated = await expectCleanResponse('seq-delta');
    assert.equal(afterTruncated.status, 200);
    assert.equal(parseSse(await afterTruncated.text()).done, true);

    // 4) timeout（不写响应头、hangMs 后 destroy）→ 5) 同 origin 的 delta
    const timeoutSettled = postChat(provider, { model: 'seq-timeout', stream: true }).then(
      (response) => ({ response }),
      (error) => ({ error }),
    );
    const first = await Promise.race([timeoutSettled.then(() => 'headers'), delay(120).then(() => 'no-headers')]);
    assert.equal(first, 'no-headers', 'timeout 在 120 ms 内不得返回响应头');
    const timeoutOutcome = await timeoutSettled;
    assert.ok(timeoutOutcome.error instanceof Error, 'timeout 到点后客户端 fetch 必须失败');
    seenBehaviors.push('timeout');

    const afterTimeout = await expectCleanResponse('seq-delta');
    assert.equal(afterTimeout.status, 200);
    assert.equal(parseSse(await afterTimeout.text()).done, true);

    // 6) rate-limit  7) tool-call（五种行为都在同一实例上真的打过）
    const limitedResponse = await expectCleanResponse('seq-rate-limit');
    assert.equal(limitedResponse.status, 429);
    assert.equal((await limitedResponse.json()).error.type, 'rate_limit_error');
    seenBehaviors.push('rate-limit');

    const toolResponse = await expectCleanResponse('seq-tool');
    const toolSse = parseSse(await toolResponse.text());
    assert.ok(
      toolSse.payloads.some(
        (payload) => payload.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name === 'seq_lookup',
      ),
      'tool-call 行为必须出现 seq_lookup 帧',
    );
    seenBehaviors.push('tool-call');

    assert.deepEqual(seenBehaviors, ['delta', 'truncated', 'timeout', 'rate-limit', 'tool-call']);
    assert.deepEqual(connectionErrors, [], '同实例连续打不得出现连接级异常');
    assert.equal(provider.requests.length, 7);
    assert.deepEqual(provider.modelsSeen(), [
      'seq-delta',
      'seq-truncated',
      'seq-timeout',
      'seq-rate-limit',
      'seq-tool',
    ]);
    assert.deepEqual(
      provider.requests.map((record) => record.behavior),
      ['delta', 'truncated', 'delta', 'timeout', 'delta', 'rate-limit', 'tool-call'],
    );
  } finally {
    await provider.close();
  }
});

test('同一服务器：model=A→delta、model=B→rate-limit，各自独立；未登记 model 用 defaultBehavior', async () => {
  const provider = await startFakeProvider({
    behaviors: { 'fixture-model-delta': 'delta', 'fixture-model-limit': 'rate-limit' },
    chunks: ['m1', 'm2'],
    defaultBehavior: 'delta',
  });
  try {
    const deltaResponse = await postChat(provider, { model: 'fixture-model-delta', stream: true });
    const deltaText = await deltaResponse.text();

    const limitResponse = await postChat(provider, { model: 'fixture-model-limit', stream: true });
    const limitBody = await limitResponse.json();

    assert.equal(deltaResponse.status, 200);
    assert.equal(parseSse(deltaText).done, true);
    assert.equal(parseSse(deltaText).contents.join(''), 'm1m2');
    assert.equal(limitResponse.status, 429);
    assert.equal(limitBody.error.type, 'rate_limit_error');

    assert.deepEqual(provider.modelsSeen(), ['fixture-model-delta', 'fixture-model-limit']);
    assert.deepEqual(provider.requests.map((record) => record.model), ['fixture-model-delta', 'fixture-model-limit']);
    assert.deepEqual(provider.requests.map((record) => record.behavior), ['delta', 'rate-limit']);
    assert.equal(provider.count('/v1/chat/completions'), 2);

    // 映射缺失 → defaultBehavior
    const unknownResponse = await postChat(provider, { model: 'fixture-unregistered-model', stream: true });
    assert.equal(unknownResponse.status, 200);
    await unknownResponse.text();
    assert.equal(provider.requests[2].behavior, 'delta');
    assert.equal(provider.requests[2].model, 'fixture-unregistered-model');
  } finally {
    await provider.close();
  }
});

test('GET /v1/models 返回 {object:"list",data:[{id}]}，且被记账', async () => {
  const provider = await startFakeProvider({
    behaviors: { 'fixture-model-delta': 'delta', 'fixture-model-limit': 'rate-limit' },
  });
  try {
    const response = await fetch(`${provider.baseUrl}/models`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const payload = await response.json();
    assert.equal(payload.object, 'list');
    assert.deepEqual(payload.data.map((item) => item.id), ['fixture-model-delta', 'fixture-model-limit']);
    for (const item of payload.data) assert.equal(typeof item.id, 'string');

    assert.equal(provider.count('/v1/models'), 1);
    assert.equal(provider.requests[0].method, 'GET');
    assert.equal(provider.requests[0].path, '/v1/models');
  } finally {
    await provider.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 客户端 abort → provider 侧连接关闭（waitForAbort 实测）
// ---------------------------------------------------------------------------

test('客户端 abort：waitForAbort() 在 3000 ms 内返回，abortedAt 非空且 responseEnded=false', async (t) => {
  const chunks = Array.from({ length: 20 }, (_, index) => `chunk-${index}-`);
  const provider = await startFakeProvider({
    behaviors: { 'fixture-abort': 'delta' },
    chunks,
    gapMs: 50,
  });
  try {
    const controller = new AbortController();
    const response = await postChat(
      provider,
      { model: 'fixture-abort', stream: true },
      { signal: controller.signal },
    );
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, 'abort 前必须至少收到一帧');

    const abortAt = Date.now();
    controller.abort();
    const aborted = await provider.waitForAbort(3_000);
    const elapsedMs = Date.now() - abortAt;

    assert.ok(elapsedMs < 3_000, `waitForAbort 应在 3000 ms 内返回，实测 ${elapsedMs} ms`);
    assert.notEqual(aborted.abortedAt, null, 'abortedAt 必须落账');
    assert.equal(aborted.responseEnded, false, '被 abort 的请求不得标记为已正常结束');
    assert.equal(aborted.statusWritten, true);
    assert.equal(aborted.model, 'fixture-abort');
    assert.equal(provider.requests.length, 1);

    t.diagnostic(`client abort → provider 侧 close 实测 ${elapsedMs} ms（阈值 3000 ms）`);

    // 客户端侧：abort 之后继续读只能是"错误或结束"，不可能再拿到完整流 + [DONE]。
    const rest = await reader.read().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    assert.ok(rest.error instanceof Error || rest.value?.done === true, 'abort 后读流应报错或立即结束');
  } finally {
    await provider.close();
  }
});

// ---------------------------------------------------------------------------
// 4. 端口 / 零外联 / 无真实 key / 无句柄
// ---------------------------------------------------------------------------

test('端口严格 127.0.0.1:0 随机端口（不落在 17900–17999），canary 非真实 key', async () => {
  const provider = await startFakeProvider();
  try {
    assert.ok(Number.isInteger(provider.port) && provider.port > 0, `port 必须是真实端口，实测 ${provider.port}`);
    assert.ok(
      provider.port < 17_900 || provider.port > 17_999,
      `不得使用 PERF-CPU 保留端口段 17900–17999，实测 ${provider.port}`,
    );
    assert.equal(provider.origin, `http://127.0.0.1:${provider.port}`);
    assert.equal(provider.baseUrl, `${provider.origin}/v1`);

    const response = await postChat(provider, { model: 'any-fixture-model', stream: true });
    await response.text();
    assert.equal(provider.requests[0].headers.authorization, `Bearer ${CANARY}`);
    assert.match(CANARY, /^fixture-not-a-real-provider-key-/);
    assert.equal(provider.requests[0].url.includes('://'), false);

    const source = await readFile(new URL('./fake-provider.mjs', import.meta.url), 'utf8');
    assert.equal(/sk-[A-Za-z0-9]{16,}/.test(source), false, '模块源码不得含真实 key 形状');
    assert.equal(/api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/.test(source), false,
      '模块不得硬编码任何真实 provider 主机名（零外联）');
  } finally {
    await provider.close();
  }
});

test('waitForRequests 解析出完整记录；超时以 ETIMEOUT 明确拒绝', async () => {
  const provider = await startFakeProvider({ chunks: ['w1'] });
  try {
    const pending = postChat(provider, { model: 'fixture-wait', stream: true });
    const records = await provider.waitForRequests(1, 1_000);
    assert.equal(records.length, 1);
    assert.equal(records[0].model, 'fixture-wait');
    assert.equal(records[0].body.stream, true);
    assert.equal(records[0].body.model, 'fixture-wait');
    assert.equal(typeof records[0].rawBody, 'string');
    assert.equal(typeof records[0].headers, 'object');
    assert.equal(typeof records[0].at, 'number');
    await pending.then((response) => response.text());

    await assert.rejects(
      () => provider.waitForRequests(3, 120),
      (error) => {
        assert.equal(error.code, 'ETIMEOUT');
        assert.match(error.message, /timed out after 120ms/);
        return true;
      },
      'waiter 超时必须拒绝，不能静默挂住',
    );
  } finally {
    await provider.close();
  }
});

test('reset() 清空记录且服务继续可用；close() 幂等，关闭后等待立即拒绝', async () => {
  const provider = await startFakeProvider();
  try {
    const first = await postChat(provider, { model: 'fixture-before-reset', stream: true });
    await first.text();
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(provider.modelsSeen(), ['fixture-before-reset']);

    provider.reset();
    assert.equal(provider.requests.length, 0);
    assert.equal(provider.count('/v1/chat/completions'), 0);
    assert.deepEqual(provider.modelsSeen(), []);
    // index 单调递增，reset 不回退（避免其他席位把 index 当数组下标）
    assert.equal(provider.requests.length, 0);

    const second = await postChat(provider, { model: 'fixture-after-reset', stream: true });
    await second.text();
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].index, 1);
    assert.equal(provider.requests[0].model, 'fixture-after-reset');
  } finally {
    await provider.close();
  }

  assert.equal(provider.closed, true);
  await provider.close(); // 幂等
  await assert.rejects(() => provider.waitForRequests(1, 500), (error) => error.code === 'ECLOSED');
  await assert.rejects(() => provider.waitForAbort(500), (error) => error.code === 'ECLOSED');
});
