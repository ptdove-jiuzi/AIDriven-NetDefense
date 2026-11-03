# 采集器公共层集成指南

面向写平台适配器、daemon 调度与投递链路的作者。维护人：PT-dove。所有结论以 `packages/collectors/common/*.js` 为准。

## 1. 适配器生命周期合同

```js
const state = collector.beginRead();            // 纯读，返回 { stableSourceId, collectorInstanceId, generation, cursor, sequence }
const records = await readFromSource(state);    // 适配器自己的活：读日志/扫表/收事件
const result = collector.publish({ records, nextCursor });  // 只改内存，不落盘
collector.commit(result);                       // 唯一提交点，返回 store.commit 的状态
```

- `publish` 不落盘：`store.load(stableSourceId)` 在提交前仍是 `null`（`restart-replay.test.js` 断言）。
- `publish` 期间不能再 `publish`：抛 `UNCOMMITTED_BATCH`。`result` 带不可枚举的批次 token，结构相同的克隆体 `commit` 会被判 `STALE_BATCH`。
- 崩溃窗口一：**提交前崩溃** → 持久游标未动，重启后 `beginRead()` 拿到旧 `cursor`/`sequence`，重读同一区间会重建**完全相同的稳定键**（键只由来源 id、代次、`nativeRecordId`/`sourceSequence` 决定）。
- 崩溃窗口二：**提交后崩溃** → 键已进持久环，重启时 `createSourceCollector` 把它 `seed` 进去重窗口，重叠部分在本地判 `duplicate` 丢弃。
- 无中间态时用 `publishAndCommit(args)`。

## 2. `sourceSequence` 义务

没有原生记录 ID 的源（行号、文件偏移、journald cursor 位置等）**必须**逐条给 `sourceSequence`（非负安全整数），它是"该记录在本代次内的稳定位置"。

- 给了：键为 `…:s<seq>`，重复读同一区间重建同键，提交前后的重叠都能被本地丢弃。
- 不给：键取自采集器内部到达计数器 `localSequence`（从持久 `sequence` 起每条 +1，且**重复项也占号**）。因此一旦该区间已提交，再读一遍就得到**新键**，`duplicates` 为 0、事件被再次投递——只能靠下游按稳定键幂等吸收。
- 同一代次内不得复用同一个 `sourceSequence`：后到的记录会被判 `duplicate` 静默丢弃（`published` 不计、`dropped` 也不计），是真实的数据丢失。
- 代次推进后位置从头开始（`sequence` 复位为 `-1`），键里带代次所以跨代次不必避让；但适配器也不能拿旧代次的偏移当新代次的位置。

## 3. 代次推进

判定用 `collector.detectIdentityChange(current, previous)`（封装 `evaluateSourceIdentity`），**顺序敏感**：

1. `previous` 为 `null` → `initial`；
2. `current.fileId !== previous.fileId` → `log_rotated`；
3. `current.size < previous.size` → `log_truncated`；
4. `current.firstRecordId <= previous.lastRecordId`（两者都给出时）→ `record_id_reuse`；
5. 否则 `continue`。

推进用 `collector.advanceGeneration({ reason, cursor, gapStart, gapEnd })`：

- `reason` 必须是 `GENERATION_REASONS` 之一，否则 `INVALID_ARGUMENT`。
- 有未提交批次时抛 `UNCOMMITTED_BATCH`。
- 缺口区间：`gapStart` 省略时取"上一批最大 `observedAt`"，再退化为 `now`；`gapEnd` 省略时取 `now`；`gapEnd < gapStart` 会被钳到 `gapStart`（不抛错）。
- 缺口 `count` 恒为 `0` 且 `unknownCount: true` —— 代次切换丢了多少条是未知量，别把它当 0 条事故读。
- 缺口 `reason`：`log_rotated`/`log_truncated` 原名保留，其余（含 `log_cleared`、`record_id_reuse`、`adapter_reset`）统一记 `generation_reset`。

## 4. `persistedKeyWindow = 2048` 的含义

`createCursorStore` 每次提交把本批全部稳定键写进 `recentKeys`，只保留**最新 2048 条**（`appendRecentKeys` 从尾部截断）。

- 它**小于**每源 50,000 的内存去重上限：内存能记住的，重启后记不住。
- 因此重启后本地最多只能丢弃**最近 2048 条**重叠；更早的重叠会作为新事件重新投递。
- 超过 2048 的那部分**必须**由 event-store 的唯一约束（按稳定键）幂等吸收。截至 2026-11-01 `packages/event-store` 仍为空目录，该约束尚未实现，接入前这是硬前置条件。
- 数值示例（`restart-replay.test.js` 已覆盖）：提交 3000 条 → 持久环存 2048 条 → 重启后整段重读 → `duplicates = 2048`、`published = 952`，952 条会再次进入投递链路。

## 5. `commit` 失败 = 结果未知

`commit` 的 `catch` 分支会：清空 `pending`、重新 `store.load` 对齐 `generation`/`sequence`/`cursor`，然后**重抛原错误**（`CURSOR_STORE_IO` 等）。若失败发生在写盘之后，重载会把内存对齐到已落盘的新状态（测试：`a commit that persisted before failing re-aligns memory with the store`）。

调用方义务：

- 按**至少一次**语义处理，不要假设"没写进去"。
- 重试前先看 `collector.identity()`：若 `sequence`/`cursor` 已前进，说明这次提交其实落盘了，重读重叠区间会得到 `duplicate`。
- **不要原样重放同一批**：`publish` 阶段已把键记进去重窗口，而 `commit` 失败并不会撤销它们；同 `sourceSequence` 的重放会被判 `duplicate` 并随新批次提交，等于静默丢数据。需要重投时用 `result.items[].stableKey` 调注入的 `dedupe.forget(key)` 释放，或换新位置。
- `abortPending()`：丢弃 pending 批次并返回其中的稳定键数组（无 pending 时返回 `[]`）。副作用是**入队事件不撤回**（`queue` 里已入队的条目仍在），键也**留在去重窗口**（重试会报 `duplicate`）——这正是有意的 at-most-once。

## 6. 缺口

- `createGapLedger` 纯内存。`gaps.drain()` 之后账本清空，**daemon 必须把返回的数组落库**，否则重启后这段缺口彻底消失。
- 每批 `result.gaps` 只是本批新增/合并后的条目，不是全量；对账请用 `gaps.list()` 或 `runtime.drainGaps()`。
- 两种"丢"必须分开对账：
  - `result.dropped`：本批**未入队**的记录数（`queue_full_events`、`queue_full_bytes`、`event_too_large`、`rate_limited`、`adapter_degraded`）。
  - `dedupe_capacity`：去重窗口挤掉的**旧键**数量，可能属于**别的源**（被淘汰键的来源记在 `gap.stableSourceId` 上），**不计入**本批 `result.dropped`。测试里 `published = 10, dropped = 0` 而 `gaps.stats().droppedCount = 6`。
- `count = 0` 且 `unknownCount: true` 表示"发生了丢弃但数量未知"，不计入 `droppedCount`；`approximate: true` 表示区间是折叠出来的并集，不是精确观测。

## 7. 限速

- 默认每源 100 事件/秒、全局 1,000 事件/秒（`LIMITS.perSourceEventsPerSecond`、`globalEventsPerSecond`）。
- 令牌桶：桶容量等于速率，按 `elapsedMs × rate / 1000` 惰性补充，不跑定时器；`clock` 必须注入且**单调**——时钟倒退不补令牌，只是不推进。
- 判定顺序：先看每源桶（`scope: 'source'`），再看全局桶（`scope: 'global'`），两者都足才扣减；拒绝时给 `retryAfterMs`。
- 被拒记录：`outcome: 'dropped'`、`dropReason: 'rate_limited'`，但**仍占 `sequence` 且仍写进去重窗口**。
- `createCollectorRuntime` 默认创建并共享**一个** limiter（全局上限才有意义）；传 `rateLimiter: null` 关闭准入；`createSourceCollector` 的 `rateLimiter` 默认也是 `null`（即单独使用时不限速）。

## 8. 能力与新鲜度

- `poll` 源：`commit` 成功即刷新 `lastSuccess`（**空批次也算推进**，所以零事件不会让 poll 源变 stale）；超过 `staleAfterCycles × intervalMs`（默认 2×5s，比较是严格大于，恰好 2 周期仍算新鲜）→ `staleReason: 'no_progress'`。
- `event` 源：只认 `lastValidSubscription`，由适配器每 30s 调 `collector.probeSubscription({ ok })`；超过 `staleAfterProbes × subscriptionProbeIntervalMs`（默认 60s）→ `subscription_probe_overdue`。**零业务事件不是故障**，`lastEvent` 仅供展示；`ok: false` 会写 `lastError.code = 'subscription_probe_failed'` 并把源降级。
- `ready` + `stale` 在快照里显示为 `lifecycle: 'degraded'`，`declaredLifecycle` 仍为 `'ready'`——判断"活着但数据陈旧"要看 `freshness`/`stale`，不要只看 `declaredLifecycle`。
- `runtime.report()` 的 `degraded` 数组按 `lifecycle ∈ {degraded, unavailable}` 归类，`stale` 数组来自 `snapshot.stale`，两者可以同时命中。
- 权限缺失用 `setPermissions({ missing: [...] })` 或 `noteError({ code: 'permission_denied', ... })`，两种都直接进 `unavailable`；`setPermissions({ missing: [] })` 会解latch 但保留 `lastError` 作为历史。

## 9. 事件信封与 contracts

- `schemaVersion` 固定 `'1.0'`（`EVENT_SCHEMA_VERSION`）。
- 信封**没有** `stable_key` 字段：TelemetryEvent 是封闭对象，未知字段会被拒。稳定键在 `publish().items[].stableKey`，或随时用 `buildStableKey({ stableSourceId, generation, nativeRecordId })` / `({ …, sequence })` 重算。
- 采集器产出的是"契约形状的草稿"，投递前必须补齐/清理：
  - `boot_id`：`createSourceCollector({ bootId })` 不传就是 `null`；契约要求非空（32 位小写 hex 或 UUIDv4）。
  - `integrity`：默认 `null`；契约要求 `{ algorithm: 'sha256', digest }`，且 `digest` 必须等于 `canonicalDigest(payload)`（`contracts/src/objects/telemetry-event.js:138`）。
  - `native_record_id`：无原生 ID 时是 `null`；契约里该字段不可为 `null`，无值时应**省略该键**而不是留 `null`（否则 `ERR_NULL_NOT_ALLOWED`）。
- 这些补齐属于适配器/契约层的职责，本包不做。

## 10. 适配器不得做的事

- **不要在 `admit` 里抛错**。抛错会被按"可能已投递"处理：键保持 remembered 并随提交持久化，记录记为 `dropped` + `adapter_degraded` 缺口（`count` 视情况为 1 或 0）。整批全抛时 `publish` 直接抛 `ADAPTER_DEGRADED` 且该批不提交。用 `{ accepted: false, reason }` 表达拒绝。
- **不要给 `nextCursor` 传 `NaN`、`Date`、`BigInt`、含 `undefined` 的对象**。`publish` 会做 JSON 往返 + `isDeepStrictEqual` 检查，一律 `INVALID_ARGUMENT`，且此时没有任何副作用。
- **不要跨进程共享同一个 cursor store 目录**。`createCursorStore` 是单写者：两个实例会抢同一个 `*.tmp`，提交序列会互相覆盖。
- 不要依赖 `snapshot()` 里的字段做安全判断（`lifecycle` 是派生值），也不要把 `abortPending()` 当成"撤回事件"。
- 不要在同一代次内复用 `sourceSequence`，不要用进程 id、时间戳、随机数当位置。

## 11. 集成检查清单

- [ ] `stableSourceId` 通过 `assertStableSourceId`（小写、≥2 段、≤96 字符），且跨重启不变。
- [ ] 每个源独占一个 cursor store 目录，进程内只有一个实例打开它。
- [ ] `bootId` 非空并注入 `createSourceCollector`；投递前补齐 `integrity`。
- [ ] 无原生 ID 的源逐条提供 `sourceSequence`，且同代次内不复用。
- [ ] `nextCursor` 只放可 JSON 往返、类型不变的值。
- [ ] `publish` 后必有 `commit` 或 `abortPending`，不留下 pending。
- [ ] `commit` 失败按至少一次处理：先读 `identity()` 对齐，再决定重读区间，避免同批重放。
- [ ] `queue.drain()` 有消费方，`events`/`bytes` 不无限增长。
- [ ] `gaps.drain()` 或 `runtime.drainGaps()` 的结果被落库。
- [ ] 事件源每 30s 调一次 `probeSubscription`；poll 源确认 `commit` 周期正常。
- [ ] `result.dropped` 与 `gaps.stats().droppedCount` 分开对账（后者含 `dedupe_capacity`）。
- [ ] 下游（event-store）已对稳定键建立唯一约束，覆盖超出 2048 条的旧重叠。
