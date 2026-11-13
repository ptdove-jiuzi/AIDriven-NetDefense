/**
 * UI2-B11 · §11 红线 3（SSE）：B2 `js/sse.js` 独立验收
 *
 * 覆盖合同 §3.1–§3.4 / §7.4：
 * - 增量解析：CRLF/CR/LF、多行 data、注释、未知字段、跨块切分、坏 JSON；
 * - 累积：按 seq 去重、乱序按 seq 排序、终态唯一（done/error 之后不再接受事件）；
 * - 断流：未收到终态 → interrupted（保留文本、不自动重连）；abort → aborted；
 * - HTTP 层错误包络（409/502 JSON）与 SSE error 事件区分。
 *
 * 运行：`node --test tests/console-next/sse.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SSE_EVENT_NAMES,
  createSseAccumulator,
  createSseParser,
  openSsePost,
} from '../../apps/console-next/js/sse.js';
import { startFakeDaemon } from './fake-daemon.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseAll(chunks) {
  const parser = createSseParser();
  const events = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return { events, stats: parser.stats() };
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

test('SSE 解析：CRLF/CR/LF、多行 data、注释、未知字段、缺省 event=message', () => {
  assert.deepEqual(SSE_EVENT_NAMES, ['delta', 'tool', 'usage', 'done', 'error']);
  const { events, stats } = parseAll([
    ': ping\r\n\r\n',
    'event: delta\r\n',
    'data: {"seq":1,\r\n',
    'data: "text":"A"}\r\n\r\n',
    'id: 9\r\nretry: 1000\r\n',
    'data: {"seq":2,"text":"B"}\r\n\r\n',
    'data: {"seq":3,"text":"C"}\n\n',
    'data: {"seq":4,"text":"D"}\r\r',
  ]);
  assert.equal(stats.comments, 1);
  assert.deepEqual(events.map((event) => event.event), ['delta', 'message', 'message', 'message']);
  assert.deepEqual(events[0].data, { seq: 1, text: 'A' });
  assert.deepEqual(events[1].data, { seq: 2, text: 'B' });
  assert.deepEqual(events[2].data, { seq: 3, text: 'C' });
  assert.deepEqual(events[3].data, { seq: 4, text: 'D' });
  assert.equal(stats.malformed, 0);
});

test('SSE 解析：跨块切分（含被切开的 \\r\\n）不丢帧、不重复', () => {
  const { events, stats } = parseAll([
    'event: delta\ndata: {"seq":1,',
    '"text":"跨',
    '块"}\n',
    '\n',
    'data: {"seq":2,"text":"!"}\r',
    '\n\r\n',
    '',
  ]);
  assert.deepEqual(events.map((event) => event.data), [{ seq: 1, text: '跨块' }, { seq: 2, text: '!' }]);
  assert.equal(stats.malformed, 0);
  assert.equal(stats.buffered, 0);
});

test('SSE 解析：坏 JSON → 本地 error 帧 SSE_MALFORMED（不回显原文）', () => {
  const malformed = [];
  const parser = createSseParser({ onMalformed: (frame) => malformed.push(frame) });
  const events = parser.push('data: {not json at all}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'error');
  assert.equal(events[0].data.code, 'SSE_MALFORMED');
  assert.equal(events[0].data.local, true);
  assert.equal(malformed.length, 1);
  assert.ok(!JSON.stringify(events[0]).includes('not json at all'), 'raw frame must not be echoed');
  assert.equal(parser.stats().malformed, 1);
});

// ---------------------------------------------------------------------------
// 累积器（§3.3）
// ---------------------------------------------------------------------------

test('累积器：按 seq 升序拼接；重复 seq 去重；乱序计数', () => {
  const accumulator = createSseAccumulator();
  accumulator.push({ event: 'delta', data: { seq: 2, text: 'B' } });
  accumulator.push({ event: 'delta', data: { seq: 1, text: 'A' } });
  accumulator.push({ event: 'delta', data: { seq: 2, text: 'B' } });
  accumulator.push({ event: 'delta', data: { seq: 3, text: 'C' } });
  assert.equal(accumulator.text, 'ABC', 'text must be ordered by seq and de-duplicated');
  assert.equal(accumulator.snapshot().stats.duplicates, 1);
  assert.equal(accumulator.snapshot().stats.outOfOrder, 1);
  assert.equal(accumulator.snapshot().stats.deltas, 3);
});

test('累积器：终态唯一——done/error 之后的事件一律忽略', () => {
  const accumulator = createSseAccumulator();
  accumulator.push({ event: 'delta', data: { seq: 1, text: 'A' } });
  accumulator.push({ event: 'done', data: { seq: 2, finishReason: 'stop', totalTokens: 1 } });
  const accepted = accumulator.push({ event: 'delta', data: { seq: 3, text: 'late' } });
  assert.equal(accepted, false);
  assert.equal(accumulator.terminal, 'done');
  assert.equal(accumulator.text, 'A');
  assert.equal(accumulator.events.length, 2);

  const errored = createSseAccumulator();
  errored.push({ event: 'error', data: { seq: 1, code: 'UPSTREAM_FAILED' } });
  assert.equal(errored.push({ event: 'done', data: { seq: 2, finishReason: 'stop' } }), false);
  assert.equal(errored.terminal, 'error');

  const interrupted = createSseAccumulator();
  interrupted.push({ event: 'delta', data: { seq: 1, text: 'partial' } });
  const snapshot = interrupted.finalize('interrupted');
  assert.equal(snapshot.terminal, 'interrupted');
  assert.equal(snapshot.text, 'partial', 'interrupted stream keeps accumulated text');
});

test('累积器：未知事件名仍计数/记录，但不参与文本', () => {
  const accumulator = createSseAccumulator();
  accumulator.push({ event: 'delta', data: { seq: 1, text: 'A' } });
  accumulator.push({ event: 'future.event', data: { seq: 2, x: 1 } });
  accumulator.push({ event: 'tool', data: { seq: 3, callId: 'call_1', state: 'proposed' } });
  assert.equal(accumulator.text, 'A');
  assert.equal(accumulator.snapshot().stats.unknownEvents, 1);
  assert.equal(accumulator.events.length, 3);
});

// ---------------------------------------------------------------------------
// openSsePost（真实 HTTP SSE 源）
// ---------------------------------------------------------------------------

test('openSsePost：delta 累积 + usage 尾部 + done 终态；不自动重连', async (t) => {
  const daemon = await startFakeDaemon(t);
  const handle = openSsePost(`${daemon.url}/api/v1/agent/chat`, { sessionId: 's_x', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: globalThis.fetch });
  const result = await handle.done;
  assert.equal(result.terminal, 'done');
  assert.equal(result.text, '先看这条告警。');
  assert.equal(result.done.finishReason, 'stop');
  assert.equal(result.usage.totalTokens, 165);
  assert.equal(result.autoRetry, false, 'chat is not idempotent: auto retry must stay off');
  assert.equal(daemon.requests.length, 1, 'exactly one HTTP request');
  assert.equal(daemon.requests[0].method, 'POST');
  assert.equal(daemon.requests[0].body.messages[0].content, 'hi');
  assert.equal(handle.accumulator.terminal, 'done');
});

test('openSsePost：SSE error 事件 → terminal=error，保留已收文本', async (t) => {
  const daemon = await startFakeDaemon(t, {
    sseFrames: [{ event: 'delta', data: { seq: 1, text: '部分' } }],
    mode: 'sse-error',
  });
  const handle = openSsePost(`${daemon.url}/api/v1/agent/chat`, {}, { fetchImpl: globalThis.fetch });
  const result = await handle.done;
  assert.equal(result.terminal, 'error');
  assert.equal(result.error.code, 'UPSTREAM_FAILED');
  assert.equal(result.text, '部分', 'text received before the error event is preserved');
  assert.equal(result.autoRetry, false);
});

test('openSsePost：HTTP 错误包络（502 JSON）→ terminal=error + httpError 字段', async (t) => {
  const daemon = await startFakeDaemon(t, { mode: 'json-error' });
  const result = await openSsePost(`${daemon.url}/api/v1/agent/chat`, {}, { fetchImpl: globalThis.fetch }).done;
  assert.equal(result.terminal, 'error');
  assert.equal(result.httpError.status, 502);
  assert.equal(result.httpError.code, 'UPSTREAM_FAILED');
  assert.equal(result.text, '');
});

test('openSsePost：半截断流 → interrupted，保留文本、不自动重连（1 次请求）', async (t) => {
  const daemon = await startFakeDaemon(t, {
    mode: 'half',
    sseFrames: [{ event: 'delta', data: { seq: 1, text: '半截' } }],
  });
  const handle = openSsePost(`${daemon.url}/api/v1/agent/chat`, {}, { fetchImpl: globalThis.fetch });
  const result = await handle.done;
  assert.equal(result.terminal, 'interrupted');
  assert.equal(result.interrupted, true);
  assert.equal(result.aborted, false);
  assert.equal(result.text, '半截');
  assert.equal(result.autoRetry, false);
  assert.equal(daemon.requests.length, 1);
});

test('openSsePost：abort() → terminal=aborted，已收文本保留，零重连', async (t) => {
  const daemon = await startFakeDaemon(t, {
    sseDelayMs: 60,
    sseFrames: [
      { event: 'delta', data: { seq: 1, text: '第一段' } },
      { event: 'delta', data: { seq: 2, text: '第二段' } },
      { event: 'done', data: { seq: 3, finishReason: 'stop', totalTokens: null } },
    ],
  });
  const handle = openSsePost(`${daemon.url}/api/v1/agent/chat`, {}, { fetchImpl: globalThis.fetch });
  // 等第一段到达后再取消
  for (let index = 0; index < 100 && handle.text === ''; index += 1) await sleep(5);
  assert.equal(handle.text, '第一段');
  handle.abort();
  const result = await handle.done;
  assert.equal(result.terminal, 'aborted');
  assert.equal(result.aborted, true);
  assert.equal(result.text, '第一段', 'cancelled stream keeps the text already received');
  assert.equal(result.autoRetry, false);
  assert.equal(daemon.requests.length, 1);
});
