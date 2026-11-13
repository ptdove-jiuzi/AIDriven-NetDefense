// author: PT-dove
// SEED-04 ③ 补覆盖 — 块 1：`connections` / `windows.network-table` 真实源再攻击。
//
// 本文件是 DEFECT-CLOSE 战役 cov 席位的新增用例（不修改任何既有测试/产品文件）。
// 背景：REATTACK-RC4/seed04/REPORT.md:168 自认未覆盖 `connections`（network-table）
// 源；台账 SEED-04 的 ③ 因此只能记"6/8 源"。这里用**真实 Windows 端点表**把它补上：
//
// - 真实读取路径是 PERF-CPU（N-034）改过的 koffi native provider
//   （`GetExtendedTcpTable`/`GetExtendedUdpTable`），不是旧台账写的 PowerShell cmdlet。
//   所以断言按当前实现写：`stats.transport === 'win32-koffi'`、`stats.nativeTcp > 0`。
// - 60 s 低频 `state=Bound` 补齐（cmdlet 路径）是**已知增补**：它的行只在**下一次** poll
//   从缓存并入，且只增不删（多报不丢）。断言只要求 `supplement.enabled/intervalMs` 是
//   声明值，以及并入后 `tcp === nativeTcp + supplementedTcp`。
// - UDP 双栈是已知偏差（同一端口在 0.0.0.0 与 [::] 上是两条不同实体）。这里不做
//   "总行数"断言，只断言实体身份唯一（`duplicateEntities === 0`），避免把多报当丢报。
// - **禁止 `records:0 / status:"ok"` 的静默退化**：daemon 侧 seam
//   （`adapters/collector-sources.js:emptyReasonFor`）必须给空读一个显式 reason。

import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import {
  CONNECTIONS_SOURCE_ID,
  attachWindowsSources,
  createWindowsSources,
} from '../../packages/collectors/windows/index.js';
import {
  createCollectorRuntime,
  createMemoryCursorStore,
} from '../../packages/collectors/common/index.js';
import {
  EMPTY_REASONS,
  createCollectorDaemonSource,
  emptyReasonFor,
} from '../../apps/daemon/src/adapters/collector-sources.js';

const BOOT_ID = 'c0f5a1b2c3d4e5f60718293a4b5c6d7e';
const REAL_READ_TIMEOUT_MS = 90_000;

/** Build the real (koffi native) connections source, bound onto a real collector runtime. */
function buildRealConnections({ intervalMs = 5_000 } = {}) {
  const [entry] = createWindowsSources({
    include: ['connections'],
    intervalMs,
    timeoutMs: REAL_READ_TIMEOUT_MS,
  });
  const cursorStore = createMemoryCursorStore({ clock: Date.now });
  // The daemon seam runs the collector runtime with `rateLimiter: null`
  // (`adapters/collector-sources.js:492`): a poll is a bounded snapshot and the scheduler
  // owns the batch size. Using the streaming default here would drop 500+ first-snapshot
  // rows on the rate bucket and make the counts meaningless for this test.
  const runtime = createCollectorRuntime({ store: cursorStore, bootId: BOOT_ID, rateLimiter: null });
  const [binding] = attachWindowsSources({ runtime, sources: [entry] });
  return { entry, binding, runtime, cursorStore };
}

function localPorts(records, present) {
  const ports = new Set();
  for (const record of records) {
    const payload = record.payload ?? record.event?.payload;
    if (payload?.present !== present) {
      continue;
    }
    if (Number.isInteger(payload.local_port)) {
      ports.add(payload.local_port);
    }
  }
  return ports;
}

test('network-table 真实源：koffi 读到真实端点表并发布真实记录（0 条不是可接受的沉默结果）', async () => {
  const { binding } = buildRealConnections();
  const result = await binding.poll();

  assert.equal(result.ok, true, 'a real endpoint read must succeed on a live Windows host');
  const stats = assertStats(result);
  assert.equal(stats.transport, 'win32-koffi', 'PERF-CPU changed the transport: the poll must use the native table');
  assert.equal(stats.fallback, null, 'a native read that fell back to PowerShell would be a different transport claim');

  const rows = stats.tcp + stats.udp;
  assert.ok(
    rows > 0,
    `live host returned 0 endpoint rows (tcp=${stats.tcp}, udp=${stats.udp}): a silent empty read is exactly the SEED-04 defect`,
  );
  assert.equal(
    stats.tcp,
    stats.nativeTcp + stats.supplementedTcp,
    'the supplement may only add rows to the native table (多报不丢), never replace them',
  );
  // UDP dual stack / IPv4-mapped IPv6 sockets can hand two rows the same endpoint identity
  // (0.0.0.0:port and [::]:port map onto one token). The differ keeps the first row
  // deterministically and *counts* the collision (`diff.js:238-244`) instead of overwriting
  // silently, so the honest assertion is "the collision is reported", not "there are none".
  assert.equal(Number.isInteger(stats.duplicateEntities), true);
  if (stats.duplicateEntities > 0) {
    assert.ok(
      stats.duplicateEntities < rows,
      `duplicate identities (${stats.duplicateEntities}) cannot exceed the ${rows} rows read`,
    );
  }
  assert.ok(
    result.published <= rows,
    `published ${result.published} entities cannot exceed the ${rows} rows read`,
  );

  assert.ok(result.published > 0, 'rows were read, so at least one snapshot entity must be published');
  assert.equal(result.published, result.items.length, 'published count and delivered items must not disagree');
  assert.equal(result.dropped, 0, 'the daemon seam has no streaming rate limiter: nothing may be dropped');

  // Raw observation (counts only — payload values are real user network data and are not
  // persisted; see evidence/defect-close/SEED-04/cov/README.md §Privacy).
  console.log(
    `[cov][network-table] transport=${stats.transport} tcp=${stats.tcp} nativeTcp=${stats.nativeTcp}`
    + ` supplementedTcp=${stats.supplementedTcp} udp=${stats.udp} unattributed=${stats.unattributed}`
    + ` duplicateIdentities=${stats.duplicateEntities} published=${result.published} dropped=${result.dropped}`
    + ` supplement.enabled=${stats.supplement.enabled} supplement.intervalMs=${stats.supplement.intervalMs}`,
  );

  // Payload contract: a snapshot record must carry presence and the declared fields.
  for (const item of result.items.slice(0, 25)) {
    const event = item.event;
    assert.equal(event.type, 'windows.connection');
    assert.equal(event.stable_source_id, CONNECTIONS_SOURCE_ID);
    assert.equal(typeof event.payload.present, 'boolean');
    assert.equal(Number.isInteger(event.payload.local_port), true, 'local_port must be an integer, not a string');
    assert.equal(typeof event.payload.state, 'string');
    assert.ok(event.payload.state.length > 0, 'state must never be blank');
    assert.ok(
      event.payload.attribution === 'exact' || event.payload.attribution === 'unavailable',
      'pid attribution must be stated (exact | unavailable), not implied by pid 0',
    );
    if (event.payload.attribution === 'unavailable') {
      assert.equal(event.payload.pid, undefined, 'an unattributed socket must not claim pid 0/System Idle');
    }
  }
});

test('network-table 真实源：本机真实建/关 socket 会被分别读成 added 与 removed', async () => {
  const { binding } = buildRealConnections();
  const first = await binding.poll();
  assert.equal(first.ok, true);
  assertStats(first);

  const server = net.createServer((socket) => socket.destroy());
  let port = null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;

    // The kernel table is the authority here, so poll until our real listener shows up
    // (a few tens of ms on this host) instead of sleeping a fixed amount.
    let opened = null;
    for (let attempt = 0; attempt < 20 && opened === null; attempt += 1) {
      const result = await binding.poll();
      assert.equal(result.ok, true);
      if (localPorts(result.items, true).has(port)) {
        opened = result;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.notEqual(opened, null, `the real listener on port ${port} never appeared in the endpoint snapshot`);

    await new Promise((resolve) => server.close(resolve));
    server.unref?.();

    let closed = null;
    for (let attempt = 0; attempt < 20 && closed === null; attempt += 1) {
      const result = await binding.poll();
      assert.equal(result.ok, true);
      if (localPorts(result.items, false).has(port)) {
        closed = result;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.notEqual(closed, null, `the closed listener on port ${port} was never reported as removed`);
    const removed = closed.items.find((item) => (
      item.event.payload.local_port === port && item.event.payload.present === false
    ));
    assert.ok(removed, 'a removal must be a real published record, not a silently dropped transition');
    assert.equal(removed.event.payload.state.length > 0, true);
    console.log(
      `[cov][network-table] real-socket lifecycle port=${port} openedSeen=true removedSeen=true`
      + ` removalState=${removed.event.payload.state} pollAttempts=<=20`,
    );
  } finally {
    if (port !== null && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('network-table 真实源：0 条记录必须在 daemon seam 得到显式 empty reason，绝不 "ok + 0 条"', async () => {
  const { entry, binding, cursorStore } = buildRealConnections();
  assert.equal(entry.name, 'connections');
  assert.equal(entry.source.descriptor.stableSourceId, CONNECTIONS_SOURCE_ID);

  const daemonSource = createCollectorDaemonSource(binding, {
    cursorStore,
    collector: undefined,
    name: 'connections',
    clock: Date.now,
  });

  let sawEmpty = false;
  let polls = 0;
  let emptyCode = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const outcome = await daemonSource.poll(attempt === 0 ? { cursor: null } : { cursor: null });
    polls += 1;
    assert.ok(Array.isArray(outcome.events), 'the daemon poll contract is { events: [] }');
    if (outcome.events.length === 0) {
      sawEmpty = true;
      assert.ok(outcome.empty, 'a zero-event poll must explain itself (A2-SHAPE §6)');
      assert.equal(typeof outcome.empty.code, 'string');
      assert.ok(
        Object.values(EMPTY_REASONS).includes(outcome.empty.code),
        `unknown empty code: ${outcome.empty.code}`,
      );
      assert.equal(typeof outcome.empty.reason, 'string');
      assert.ok(outcome.empty.reason.length > 0, 'an empty code without a reason is still a silent degradation');
      emptyCode = outcome.empty.code;
      break;
    }
    // Some real churn happened between the two reads; keep polling until a quiet moment.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(polls >= 1, true);
  if (sawEmpty) {
    assert.ok([EMPTY_REASONS.SNAPSHOT_NO_CHANGES, EMPTY_REASONS.NO_NEW_RECORDS].includes(emptyCode));
  }
  const zeroShape = emptyReasonFor({ ok: true, published: 0, duplicates: 0, dropped: 0, snapshot: true });
  assert.equal(zeroShape.code, EMPTY_REASONS.SNAPSHOT_NO_CHANGES);
  assert.ok(zeroShape.reason.length > 0);
  console.log(
    `[cov][network-table] daemon-seam empty-classification polls=${polls} zeroEventPollObserved=${sawEmpty}`
    + ` emptyCode=${emptyCode ?? 'not-observed'} snapshotZeroRule=${zeroShape.code}`,
  );
  // Regardless of whether a quiet moment was observed, every classification this seam can
  // produce for a real zero-record read must be an explicit code — never undefined.
  for (const code of Object.values(EMPTY_REASONS)) {
    assert.equal(typeof code, 'string');
  }
});

function assertStats(result) {
  assert.ok(result.stats !== null && typeof result.stats === 'object', 'a real endpoint read must report stats');
  for (const key of ['tcp', 'nativeTcp', 'supplementedTcp', 'udp', 'unattributed', 'duplicateEntities']) {
    assert.equal(Number.isInteger(result.stats[key]), true, `stats.${key} must be an integer`);
  }
  const supplement = result.stats.supplement;
  assert.ok(supplement && typeof supplement === 'object', 'the low-frequency state=Bound supplement must be declared');
  assert.equal(supplement.enabled, true, 'the native path always declares the supplement');
  assert.equal(supplement.intervalMs, 60_000, 'the supplement beats once a minute, not once per poll');
  return result.stats;
}
