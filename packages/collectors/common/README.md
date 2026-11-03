# @aegisharness/collector-common

采集器的**平台中立公共层**。维护人：PT-dove。

## 1. 这个包是什么

一组纯逻辑模块，供 Windows / Linux 采集适配器与 daemon 共用：来源身份、稳定键、游标持久化、去重窗口、有界队列、缺口账、能力与新鲜度、准入限速。

- 没有平台 API：不出现 `process.platform`、注册表、WMI、EvtSubscribe、journald、inotify。
- 没有定时器：不出现 `setTimeout`/`setInterval`，调度由调用方负责；时间一律通过注入的 `clock`/`monotonic` 读取。
- 没有网络、子进程、环境探测。
- **唯一会落盘的模块是 `cursor-store.js`**（`node:fs`），且只写调用方传入的 `directory`。其余模块只在内存里工作。
- 唯一的外部随机源是 `node:crypto` 的 `randomUUID`，只在 `createCollectorInstanceId` 与 `createEventFactory` 的默认 `idFactory` 里出现，均可注入替换。
- 所有校验失败抛 `CollectorError`，带稳定 `code`（`ERROR_CODES`），调用方按 code 分类，不必解析文案。

## 2. 这个包不是什么

- 不是适配器：不读事件日志、不扫 procfs、不监听文件。适配器在 `packages/collectors/windows`、`packages/collectors/linux`（截至 2026-11-01 这两个目录仍为空，适配器尚未落地）。
- 不是 daemon：不调度轮询、不重试、不重连、不写数据库。`queue`/`gaps` 需要 daemon 主动 `drain()`。
- 不是契约层：不生成 `integrity` 摘要、不校验 TelemetryEvent 封闭 Schema。事件信封只是"契约形状的草稿"，投递前必须过 `packages/contracts`（见 `INTEGRATION.md` 第 9 节）。
- 不是 end-to-end 去重：本包记住的稳定键是**内存窗口 + 有限持久环**，跨进程的最终幂等由下游存储承担。

## 3. 模块地图

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `index.js` | 汇总再导出，唯一入口 | — |
| `limits.js` | 设计常量的唯一来源，可用 `resolveLimits` 覆盖 | `LIMITS`、`resolveLimits` |
| `errors.js` | 统一错误类型、错误码、标量断言 | `CollectorError`、`ERROR_CODES`、`assertInteger`、`assertTimestamp`、`toIsoTimestamp`、`assertNonEmptyString`、`isPlainObject` |
| `ids.js` | 来源标识校验、稳定键构造/解析 | `buildStableKey`、`parseStableKey`、`assertStableSourceId`、`isValidStableSourceId`、`createCollectorInstanceId`、`assertCollectorInstanceId`、`buildSourceIdentity`、`SOURCE_ID_PATTERN`、`MAX_SOURCE_ID_LENGTH`、`MAX_NATIVE_RECORD_ID_LENGTH` |
| `generation.js` | 判断"旧游标是否还有效"，推进代次 | `evaluateSourceIdentity`、`advanceGeneration`、`createGenerationState`、`assertGenerationReason`、`GENERATION_REASONS` |
| `events.js` | 生成 TelemetryEvent 形状的事件、字节测量、优先级 | `createEventFactory`、`measureEventBytes`、`priorityOfEvent`、`normalizeSeverity`、`EVENT_SCHEMA_VERSION`、`SEVERITIES` |
| `cursor-store.js` | 单写者、原子、可隔离损坏的游标文件 | `createCursorStore` |
| `dedupe-window.js` | 有界去重窗口（TTL + 每源上限 + 全局上限 + 三档优先级） | `createDedupeWindow`、`DEDUPE_PRIORITIES` |
| `event-queue.js` | 双通道有界队列，条数与字节双维度预留 | `createEventQueue`、`QUEUE_PRIORITIES`、`QUEUE_REJECTION_REASONS` |
| `gap-ledger.js` | 丢弃/跳过区间账本，相邻合并、溢出折叠 | `createGapLedger`、`GAP_REASONS` |
| `capability.js` | 每源 lifecycle / freshness / 错误 / 缺口 / 权限 | `createCapability`、`LIFECYCLES`、`FRESHNESS`、`STALE_REASONS`、`COLLECTOR_KINDS`、`DEFAULT_SUBSCRIPTION_REMEDIATION` |
| `rate-limiter.js` | 令牌桶准入（每源 + 全局，惰性补充） | `createRateLimiter` |
| `source-collector.js` | 单源 `beginRead → publish → commit` 流水线 | `createSourceCollector` |
| `runtime.js` | 多源编排，共享限速器，聚合健康报告 | `createCollectorRuntime` |

## 4. 最小可用示例

下面的调用顺序与 `tests/wp2-collector-common/restart-replay.test.js` 一致，字段名与实现一致。

```js
import {
  createCapability, createCollectorInstanceId, createCursorStore,
  createDedupeWindow, createEventQueue, createGapLedger, createSourceCollector,
} from '@aegisharness/collector-common';

const clock = Date.now;                       // 所有模块都接受时钟注入
const stableSourceId = 'linux.journald';
const collectorInstanceId = createCollectorInstanceId();

const store = createCursorStore({ directory: './state/linux' });  // 唯一落盘者
const queue = createEventQueue({});                               // 100k 条 / 256MiB / 10% 预留
const dedupe = createDedupeWindow({ clock });                     // 50k 每源 / 200k 全局 / 24h
const gaps = createGapLedger({ clock });
const capability = createCapability({
  stableSourceId, collectorInstanceId, kind: 'event', clock,
});

const collector = createSourceCollector({
  source: { stableSourceId, kind: 'event', intervalMs: 5_000 },
  store, queue, dedupe, gaps, capability,
  instanceId: collectorInstanceId,
  clock,
  bootId: '9f2b1c4d5e6f4a7b8c9d0e1f2a3b4c5d',   // 不传则事件里是 null
});

const state = collector.beginRead();
// { stableSourceId, collectorInstanceId, generation: 0, cursor: null, sequence: -1 }

const result = collector.publish({
  records: [
    { type: 'ssh.login', nativeRecordId: 's=3f2b1c4d5e6f4a7b;i=1', severity: 'medium',
      observedAt: 1_700_000_000_000, payload: { user: 'synthetic' } },
    { type: 'ssh.login', sourceSequence: 42, severity: 'info',
      observedAt: 1_700_000_000_100, payload: { user: 'synthetic' } },
  ],
  nextCursor: { cursor: 's=3f2b1c4d5e6f4a7b;i=2' },
});
// result.generation / result.nextCursor / result.sequence / result.items /
// result.published / result.duplicates / result.dropped / result.gaps
// result.items[i] = { stableKey, record, event, outcome, dropReason }
// outcome ∈ 'published' | 'duplicate' | 'dropped'
// 第一条的键是 'linux.journald#g0:n<s=3f2b1c4d5e6f4a7b;i=1>'，第二条是 'linux.journald#g0:s42'

const cursorState = collector.commit(result);   // 到这里才写盘
// { stableSourceId, generation: 0, cursor: { cursor: 's=3f2b1c4d5e6f4a7b;i=2' },
//   sequence: 42, generationReason: null, recentKeys: [...], updatedAt: '...' }

queue.drain();   // 交给投递方；high 通道先出
gaps.drain();    // 交给 daemon 落库
```

单批无中间态时可用 `publishAndCommit(args)`，返回 `{ ...result, committed: true, cursorState }`。
需要一次性跑多源时用 `createCollectorRuntime({ store, queue, dedupe, gaps, clock })`，`addSource()` 返回同形状的 collector，`report()` 聚合 `sources`/`degraded`/`stale`/`queue`/`dedupe`/`gaps`。

## 5. 不变量清单

1. **稳定键构成**：`buildStableKey` 只产出两种形状，`${stableSourceId}#g${generation}:n${nativeRecordId}` 与 `${stableSourceId}#g${generation}:s${sequence}`（`ids.js:99`）。数字型 `nativeRecordId` 转十进制字符串，字符串型裁掉首尾空白，且禁止出现 `#` 与 `:`（二者是键分隔符）。
2. **instance id 不进键**：`collector_instance_id` 只出现在事件信封与快照里；重启换 id 后同一批记录必须重建同一键（`restart-replay.test.js` 显式断言键中不含 `INSTANCE_A`/`INSTANCE_B`）。
3. **代次推进条件**（`evaluateSourceIdentity`，顺序敏感）：无前值 → `initial`；`fileId` 变化 → `log_rotated`；`size` 变小 → `log_truncated`；`current.firstRecordId <= previous.lastRecordId` → `record_id_reuse`；否则 `continue`。键里带代次，所以代次一推进，同一 `nativeRecordId` 就是新事件。
4. **队列双上限 + 10% 预留**：`normal` 只能用 `floor(maxEvents * (1 - ratio))` 条与 `floor(maxBytes * (1 - ratio))` 字节，其余留给 `high`；单事件另有独立的 `maxEventBytes`（256KiB）闸门，不占用整队预算（`event-queue.js:92`）。
5. **去重三档优先级**：全局超限时按 `low → normal → high` 逐档淘汰该档最旧的一条；每源超限则按该源插入顺序淘汰最旧，不看优先级（`dedupe-window.js:214`、`:225`）。淘汰量以 `dedupe_capacity` 缺口上报。
6. **缺口计数守恒**：`count` 是"确实丢了几条"，`count = 0` 表示"丢了但数量未知"，此时 `unknownCount = true` 且不计入 `stats().droppedCount`；合并只做相加，折叠成 `gap_ledger_overflow` 时保留 `byReason` 分项并置 `approximate: true`。
7. **两类新鲜度**：`poll` 看 `lastSuccess`，超过 `staleAfterCycles × intervalMs`（默认 2 个周期）即 `stale`；`event` 只看 `lastValidSubscription`，超过 `staleAfterProbes × subscriptionProbeIntervalMs`（默认 60s）即 `stale`，业务事件只作展示。
8. **commit 是唯一提交点**：`publish` 不落盘；被拒或未提交的批次不推进 `sequence`/`cursor`。

## 6. 设计映射

| 不变量 | `docs/design/SOFTWARE_DESIGN.md` 依据 |
|---|---|
| 1、2 | §5.2「稳定来源/通道身份与采集进程实例分离：`stable_source_id` 标识逻辑来源，`collector_instance_id` 仅用于健康诊断，不参与原生事件去重。」§5.2「Windows 唯一键为通道+日志代次+record ID；journald 使用 cursor；轮转文件使用稳定文件标识/来源代次+序列」 |
| 3 | §5.2「清空日志或记录 ID 重用必须递增 `source_generation`。」 |
| 4、7（poll） | §5.2「队列 100,000 且总字节 256MiB，高优先级预留 10%。」§5.1「高优先级 10% 预留同时适用于队列条数与字节数。」§5.1「轮询源超过 2 个采集周期未推进即为 stale」 |
| 5 | §5.2「去重/关联状态每源最多 50,000 指纹、全局 200,000，TTL 24 小时；超限时合并低优先级并生成资源缺口，不无限分配内存。」 |
| 6 | §5.2「所有丢弃/合并记录来源、区间、原因和计数。」 |
| 7（event） | §5.1「事件驱动源每 30 秒执行独立订阅健康探测并记录 `last_valid_subscription`，长期零业务事件不等于故障。」 |
| 8 | §5.2「采集器读取后未提交即重启时，按持久游标重叠重放，同一稳定键幂等去重。」 |
| 快照字段 | §5.1「每源保存 `lifecycle`、`last_success`、`last_event`、`last_error`、`last_gap`、权限说明。」 |
| 限速 | §5.2「每源默认 100 事件/秒、全局 1,000 事件/秒准入；单原始事件 256KiB。」 |

## 7. 测试入口

```bash
"C:\Program Files\nodejs\node.exe" --test "tests/wp2-collector-common/*.test.js"
```

截至 2026-11-01：95 tests / 95 pass（`node --test` 输出 `pass 95 fail 0`）。

包尚未加入根 workspaces，测试按相对路径 `../../packages/collectors/common/index.js` 导入（原因见 `restart-replay.test.js` 头部注释）。

## 8. 已知边界

- `persistedKeyWindow` 默认 2048，小于每源 50,000 的内存去重上限；跨重启只能本地丢弃最近 2048 条重叠，详见 `INTEGRATION.md` 第 4 节。
- `createCursorStore` 假定单写者：同一 `directory` 同时被两个进程打开会争抢同一个 `*.tmp`。
- `ERROR_CODES.EVENT_TOO_LARGE`、`SOURCE_UNKNOWN`、`RUNTIME_CLOSED` 已定义但当前没有抛出点；体积超限走的是 `admit` 的 `event_too_large` 拒绝与 `gaps` 记录。
