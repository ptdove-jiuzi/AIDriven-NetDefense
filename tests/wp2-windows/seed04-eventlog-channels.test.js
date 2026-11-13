// author: PT-dove
// SEED-04 ③ 补覆盖 — 块 2：多 channel event-log（Security / System / Application）真实源再攻击。
//
// 背景：REATTACK-RC4/seed04/REPORT.md:168 自认未覆盖"多 channel event-log"。这里把三个
// channel 各自建成**独立源**（`windows.event-log.<channel>`），在真实 Windows 事件日志上
// 跑出原始结果，并断言"诚实状态"而不是"0 条也 ok"：
//
// - System / Application：普通账户可读 → 必须真的读出记录（或显式 NO_EVENTS 空读）。
// - Security：本机（非提权）实测 `Get-WinEvent -LogName Security` = ACCESS_DENIED。
//   诚实投影是 **unavailable + 错误码**（capability.code=`permission_denied`，
//   binding.code=`ACCESS_DENIED`，订阅探针 ok=false），**不是** ok+0。
// - 若本机被提权，Security 可读 → 同样的正向断言（真条数），不把权限差异写成失败。
//
// 断言全部来自本机真实执行；原始 stdout 落在
// `docs/implementation/evidence/defect-close/SEED-04/cov/raw/02-eventlog-channels.raw.log`。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_LOG_PROBE_INTERVAL_MS,
  attachWindowsSources,
  channelSourceId,
  createWindowsSources,
} from '../../packages/collectors/windows/index.js';
import {
  createCollectorRuntime,
  createMemoryCursorStore,
} from '../../packages/collectors/common/index.js';

const BOOT_ID = 'c0f5a1b2c3d4e5f60718293a4b5c6d7f';
const CHANNELS = ['Security', 'System', 'Application'];
const REAL_READ_TIMEOUT_MS = 90_000;

function buildChannelSources() {
  const declared = createWindowsSources({
    include: ['eventLog'],
    channels: CHANNELS,
    intervalMs: EVENT_LOG_PROBE_INTERVAL_MS,
    timeoutMs: REAL_READ_TIMEOUT_MS,
  });
  const cursorStore = createMemoryCursorStore({ clock: Date.now });
  // Same seam as the daemon (`rateLimiter: null`): a poll is a bounded snapshot and a
  // rate bucket would turn "500 records read" into "100 published, 400 dropped".
  const runtime = createCollectorRuntime({ store: cursorStore, bootId: BOOT_ID, rateLimiter: null });
  const bindings = attachWindowsSources({ runtime, sources: declared });
  return { declared, bindings, runtime, cursorStore };
}

test('event-log 三 channel 各自是一个独立源，源 id 与游标互不串台', () => {
  const { declared, bindings } = buildChannelSources();
  assert.equal(declared.length, 3, 'three declared channels must produce three sources, not one multi-channel blob');
  const ids = bindings.map((binding) => binding.descriptor.stableSourceId);
  assert.deepEqual(ids, CHANNELS.map((channel) => channelSourceId(channel)));
  assert.equal(new Set(ids).size, 3);
  for (const channel of CHANNELS) {
    const binding = bindings.find((entry) => entry.descriptor.stableSourceId === channelSourceId(channel));
    assert.ok(binding, `channel ${channel} must have its own binding`);
    assert.equal(binding.descriptor.kind, 'event');
    assert.equal(binding.descriptor.intervalMs, EVENT_LOG_PROBE_INTERVAL_MS);
  }
  console.log(`[cov][event-log] declaredChannels=${CHANNELS.join('|')} sourceIds=${ids.join('|')}`);
});

test('event-log 真实源：每个 channel 的状态必须诚实（可读=真条数；被拒=unavailable+错误码，绝不 ok+0）', async () => {
  const { bindings, runtime } = buildChannelSources();
  const observations = [];

  for (const binding of bindings) {
    const sourceId = binding.descriptor.stableSourceId;
    const channel = binding.descriptor.channel ?? CHANNELS.find((name) => channelSourceId(name) === sourceId);
    const result = await binding.poll();
    const snapshot = runtime.report().sources.find((entry) => entry.stableSourceId === sourceId);
    const probe = await binding.probe();

    assert.ok(snapshot, `${sourceId} must appear in the capability report`);

    if (result.ok === true && result.published > 0) {
      // Honest success: real records came out of the real channel.
      assert.ok(Array.isArray(result.items) && result.items.length === result.published);
      const identity = runtime.get(sourceId).identity();
      assert.ok(identity?.cursor, 'a channel that delivered records must persist its record-id cursor');
      assert.equal(identity.cursor.channel, channel, 'each channel must keep its own cursor channel');
      assert.equal(Number.isSafeInteger(identity.cursor.lastRecordId), true);
      assert.ok(identity.cursor.lastRecordId > 0, 'a real event channel has record ids above zero');
      assert.equal(probe.ok, true, 'a readable channel must pass its subscription probe');
      // Spot-check the payload contract on a real record (no values persisted).
      const first = result.items[0].event;
      assert.equal(first.type, 'windows.event_log');
      assert.equal(first.payload.channel, channel);
      assert.equal(Number.isSafeInteger(first.payload.record_id), true, 'record id must reach the payload as an integer');
      assert.equal(typeof first.native_record_id, 'string', 'the stable key carries the native record id as text');
      assert.match(first.native_record_id, /^\d+$/u, 'a real event record id is decimal text');
    } else if (result.ok === true) {
      // A readable but quiet channel is an EXPLICIT empty read, never a bare zero.
      assert.equal(result.published, 0);
      assert.equal(result.empty, true, 'a zero-record success must be classified as an empty read (NO_EVENTS)');
      assert.equal(probe.ok, true);
    } else {
      // A refused channel must be an honest unavailable with a code — the whole point of the
      // block. `published === 0` is only acceptable together with `ok: false` + a code.
      assert.equal(typeof result.code, 'string');
      assert.ok(result.code.length > 0, 'a failed read must name its error code');
      assert.equal(result.published ?? 0, 0, 'a failed read publishes nothing');
      assert.equal(result.empty, undefined, 'a permission denial is a failure, not an empty read');
      assert.equal(snapshot.lifecycle, 'unavailable', `${sourceId} must latch unavailable, not ok`);
      assert.ok(snapshot.lastError, 'an unavailable source must retain the error that made it unavailable');
      assert.equal(typeof snapshot.lastError.code, 'string');
      assert.equal(snapshot.lastError.fatal, true, 'an access denial must be fatal for the source');
      if (result.code === 'ACCESS_DENIED') {
        assert.equal(snapshot.lastError.code, 'permission_denied', 'ACCESS_DENIED maps onto the fatal permission code');
        assert.equal(probe.ok, false, 'the subscription probe must fail too, not claim health');
        assert.equal(probe.errorCode, 'ACCESS_DENIED');
      }
    }

    // The universal anti-regression: whatever happened, a zero-event outcome is never
    // "ok with no explanation".
    if (result.published === 0) {
      assert.equal(
        result.ok === true ? result.empty === true : typeof result.code === 'string',
        true,
        `${sourceId} returned 0 records without an honest reason`,
      );
    }

    observations.push({
      sourceId,
      channel,
      ok: result.ok,
      code: result.code ?? null,
      published: result.published ?? 0,
      lifecycle: snapshot.lifecycle,
      errorCode: snapshot.lastError?.code ?? null,
      probeOk: probe.ok,
      cursorChannel: runtime.get(sourceId).identity()?.cursor?.channel ?? null,
      cursorRecordId: runtime.get(sourceId).identity()?.cursor?.lastRecordId ?? null,
    });
  }

  // The three channels must be independently classified: one unavailable channel must not
  // make the readable ones unhealthy (single-source failure isolation).
  const readable = observations.filter((entry) => entry.ok === true);
  const unavailable = observations.filter((entry) => entry.ok === false);
  assert.equal(readable.length + unavailable.length, 3);
  for (const entry of unavailable) {
    assert.equal(entry.lifecycle, 'unavailable');
  }
  for (const entry of readable) {
    assert.notEqual(entry.lifecycle, 'unavailable', `${entry.sourceId} must not be dragged down by another channel`);
  }
  assert.equal(
    new Set(observations.map((entry) => entry.sourceId)).size,
    3,
    'each channel must be observed as its own source',
  );
  console.log(`[cov][event-log] observations=${JSON.stringify(observations)}`);
});
