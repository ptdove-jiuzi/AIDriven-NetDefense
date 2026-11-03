# ADR-0006：event-store 只读稳定键存在性探测（`hasDedupeKeys`）

- 状态：**Accepted（2026-11-02）**
- 作者：PT-dove
- 影响范围：`packages/event-store/src/**`（新增只读查询）、`apps/daemon/src/{pipeline.js,adapters/event-store.js}`（预过滤改造）、`tests/wp1-event-store/**`、`tests/wp5-daemon/**`

## 1. 问题事实（可复核）

T1 有两道幂等防线，判重键不同：

| 防线 | 键 | 位置 |
|---|---|---|
| 稳定来源键 | `(stable_source_id, source_generation, dedupe_key)` 唯一索引，`dedupe_key` = `native:<native_record_id>` 或 `seq:<source_seq>` | `packages/event-store/src/ingest.js:52-57,351-355`、`schema.js:71` |
| 事件主键 | `event_id` | `ingest.js:356-357` |

daemon 的**预过滤只用了 `event_id`**（`apps/daemon/src/pipeline.js:570` 调 `store.hasEvent(event.event_id)`），
而后端实体判重实际走稳定键。两者不一致时：

- 重放事件如果换了 `event_id`（同一 `source_seq` / 原生 ID），预过滤放行；
- 检测引擎把它当新观测，产出新的告警贡献；
- T1 命中稳定键 → 返回 `duplicate: true`，本次**什么都没写**；
- 但同一批里如果还有真实新观测，告警锚点落在新事件上，`upsertAlert` 会把**含重复观测的累计贡献**加进去。

实测：

```
批1: seq=1 @T1              → alert.count=1
批2: [seq=1 @T1 新id, seq=2] → stored_events=2, alert.count=3,
                               dangling=["<新id>"], alerts_dropped=0
```

即 `alert.count` 比真实入库事件数多 1，且 `event_ids` 里有**从未入库**的 id（悬空证据）。
既有修复只覆盖"整批都是重放"（`duplicate` 分支选择性保留），对混合批次无效。

## 2. 决定

### 2.1 新增只读接口（唯一新增能力）

`packages/event-store` 导出三个符号，放进新文件 `src/dedupe.js`：

```js
// 纯函数：与 T1 内部判重键逐字一致（ingest.js 改为调用它，不再各写一份）
dedupeKeyOf(event)  -> 'native:<native_record_id>' | 'seq:<source_seq>'
stableKeyOf(event)  -> Object.freeze({ stable_source_id, source_generation, dedupe_key })

// 只读存在性查询
hasDedupeKeys(store, keys) -> readonly boolean[]
```

`hasDedupeKeys(store, keys)`：

- `keys`：`{stable_source_id, source_generation, dedupe_key}` 的数组；顺序即返回顺序。
- 返回：与 `keys` **等长同序**的冻结布尔数组。`true` = 该稳定键已有行。
- 空数组 → 返回空冻结数组，**不执行任何 SQL**。
- 只发 `SELECT 1 FROM telemetry_event WHERE stable_source_id = ? AND source_generation = ? AND dedupe_key = ?`，
  逐键点查、命中唯一索引 `(stable_source_id, source_generation, dedupe_key)`；
  SQL 形状固定，复用句柄的 prepared-statement 缓存。成本与改造前"每事件一次 `hasEvent`"相当，
  不是新的全表扫描。
- **不调用 `assertWritable`**，只读句柄可用；不开事务、不写审计、不改任何状态。
- 键形态非法（非对象、字段缺失/类型错、`dedupe_key` 不匹配 `^(native:.+|seq:\d+)$`）→
  抛 `StoreError(ERR_STORE_INPUT)`，`details` 只含 `{ index, field }`，**不含键值或事件内容**。

### 2.2 明确的输出约束（本 ADR 的硬边界）

接口**只能**返回布尔/存在性。禁止：

- 返回完整事件行、`payload`、`canonical_json`、`payload_digest`、`observed_at`、`event_id` 等任何字段；
- 返回命中行数、行偏移、`ingest_seq`、首次/末次出现时间等可用于时间侧信道的数据；
- 提供"按稳定键取详情"的配套读接口（要读事件只能走已有的 `getEvent(eventId)`）。

理由：稳定键探测位于 daemon 的**每批热路径**，调用方不需要、也不应拿到证据内容；
把读面收窄成布尔，可以把"daemon 顺手读原始证据"这类越权挡在接口形态上，而不是靠约定。

### 2.3 daemon 预过滤改造

- 适配器接口新增 `hasStableKeys(events) -> boolean[]`（`events` 是待写入的合同事件数组）与
  `stableKeysOf(events) -> string[]`（不透明键编码，仅供调用方做批内相等比较）。
  - SQLite 适配器：`open()` 后调用 `api.stableKeyOf(event)` 派生键，再 `api.hasDedupeKeys(handle, keys)`。
    **不复制派生逻辑**，避免与 T1 漂移。
  - 内存适配器：本地派生（mock 模式不能加载 `node:sqlite`），并由 `tests/wp5-daemon/adapters.test.js`
    的 `stable key parity` 组用真实包的 `stableKeyOf` 逐例对拍，把这份重复钉住。
- `pipeline.ingestBatch`：
  - 有 `hasStableKeys` → 一次批量判定；键缺失或报 `true` 的事件直接丢弃（计入 `events_duplicate`）。
  - **批内自重复也要拦**：同一批里出现两条同稳定键事件时，后者按"已知"处理、不进检测。
    采集器的去重窗口是有界的，poll 契约也不保证批内稳定键唯一；放行会让 T1 判重、检测却已计数。
  - 没有 `hasStableKeys`（仅遗留测试替身）→ 回落到逐事件 `hasEvent`，行为与改造前一致。
  - 该读失败时：计入 `store_errors` / `store_errors_consecutive`，**不把事件当作已知**，
    由调度器不推进游标来重放（与 `hasEvent` 失败时的既有语义一致）。
  - 键形态非法（事件本身违反合同）→ 适配器回落到逐事件 `event_id` 探测，让 T1 单独拒绝坏事件，
    而不是让一条坏事件拖掉整批。

### 2.4 证据可验证性：两条写入路径统一

`alert.count` 与 `alert.event_ids` 必须自洽：**计数里每一次观测都要有一条能查到的事件行**。
复核发现该不变式只在单批内成立，跨批不成立，故补充两条规则：

1. **批内失败剥离**（`stripFailedObservations`）：某事件写入失败后，同批后续告警不得再引用它的 id，
   `count` 同步下调；整条告警无证据可留时丢弃并计入 `alerts_dropped`。
2. **跨批 attach 校验**（`retainedEventIds` + overlap 让位）：保留的告警在补写前逐条核验证据，
   只保留"已入库"或"本批即将写入"的 id，`count` 按删除条数下调；空证据的整条丢弃。
   若本批已重新观测到同一窗口的同一事件（引擎重建导致重放被重新检测），这部分观测让位，
   计入 `contributions_superseded`，避免同一次观测被计两遍。

### 2.5 锚点必须晚于它引用的证据

`attachRetained` 曾用"逆序轮转"给保留贡献分配锚点：第 1 条保留告警挂到本批最后一个事件，
第 2 条挂到倒数第二个……于是出现"位置 i 的 T1 提交了一行，引用位置 j>i 的事件"。
T1 是"先写自己的事件、再写告警"，j 的写入发生在 i 之后；j 一旦失败，i 那次已经提交的
告警行就永久指向一条从不存在的行，`count` 同时虚增、`truncated=false`（读者会以为证据完整）。

规则改为：**锚点下标 = 该保留告警引用的本批事件中的最大下标**；不引用本批事件时取最后一个事件。
这样任何一个被引用的 id 都落在锚点当次调用之内或其之前，跨批 attach 与批内写入共享同一条不变式。

### 2.6 被剥离的观测延后补记

`stripFailedObservations` 把失败事件的 id 从"待写入的告警"里剔除后，那条观测就没有任何
行认领了：事件失败、告警也不计它。若该事件之后重试成功，库里会多出一条可核实的事件，
而那一行的 `count` 永远停在旧值 —— 证据可查、行却不认，与"悬空 id"是同一不变式的反面。

规则：**剥离时按告警保留一份"单窗证据"贡献**（`event_ids` = 被剥离的 id 组，
`count` = 该组条数，`truncated=false`），交给既有的保留队列；它的事件重新入库时由
`attachRetained` 合并回同一行。若该事件始终不再重投，则 attach 时因证据不可核实在
`retainedEventIds` 被丢弃并计入 `alerts_dropped` —— 方向仍是 fail-closed，不造 id。

**延后不是当场判死**：保留队列是 pipeline 级的，而下一批很可能来自**另一个采集来源**。
如果那时这些 id 既不在本批、也不在库里，当场丢弃就等于断言"它永远不会来"；可来源 A 之后真的重投成功时，
引擎已经见过这条事件（不再重新检测），这次观测就永久少计。所以 attach 阶段把"本批核验不了"的部分
**留在队列里继续等**，只把能核验的部分写出去；唯一的界是条目自己的重试预算
（`MAX_CONTRIBUTION_ATTACH_ATTEMPTS`，8 次），耗尽才丢弃并计入 `contributions_dropped`。
这条规则对所有保留贡献生效，不只对被剥离的那一份。

**队列按来源分层**：上面那条"延后"只解决了"当拍丢"，
没有解决"谁有权排空"。`pendingContributions` 是 pipeline 级的单一队列，而 `daemon.js` 只建一个 pipeline、
`scheduler.js` 每个 tick 把**所有**到期来源的批次都交给它。于是来源 B 的批次仍然在消费来源 A 的证据：

- 每次 attach 都给 A 的条目 `+1 attempts`，B 连打 8 批就能把 A 的预算耗尽 → 丢弃 →
  A 随后重投成功时引擎已见过该事件、不再检测 → **事件入库而 `count` 永不认领**（永久少计，`truncated=false`）。

规则：**保留条目带上它所属的采集来源（`source_id`），`attachRetained` 只排空
`entry.source_id === meta.source_id` 的条目**；其他来源的条目原样留在队列，不 attach、不丢弃、
不消耗重试预算、不动计数器。`meta.source_id` 缺失时记为 `null`，`null` 自成作用域
（daemon 的 poll 永远带真实来源，只有不带 `meta` 的遗留调用方会落到这个桶，行为与改造前一致）。

作用域只决定**谁能把证据写回去、什么时候写**，不改 `count` 的加法语义：不同来源的观测仍按
T1 的 `(fingerprint, window_start)` upsert 合并成同一行，这正是设计想要的聚合。

**容量不设上限**：只把 attach 与预算按来源分开还不够，
**容量淘汰**本身是错的。三代做法都被独立复核打红，结局完全相同——事件随后入库、引擎已见过它、
`count` 永不认领，`truncated=false`，读侧看不出来：

| 做法 | 谁付代价 | 结论 |
|---|---|---|
| 全局"淘汰最旧"（`shift()`，32 条） | 被挤掉的**无关**来源 | 否决 |
| 全局上限 + 满则拒收新条目 | 下一个失败的来源 | 否决 |
| 每来源配额，淘汰自己的最旧 | 溢出者自己（但事件**照样会回来**） | 否决 |

关键判据是：写失败后**游标不推进**，那一批会重放，所以被淘汰条目的事件随后确实会入库；
"容量丢"不是"证据永不回来"那种 fail-closed，而是把一个**本来会自愈**的观测永久少计。
一次 99 事件的全失败降级批次在 32 条配额下实测 `dropped=67`，重放后 100 条事件入库、只有 33 行告警、
66 个窗口有事件而无告警行。

规则：**队列不按容量淘汰**。条目只在两种情况下离开队列：

1. 被同来源的后续批次 attach 并写入（正常路径，重放一次即清空）；
2. 该来源自己的 attach 次数达到 `MAX_CONTRIBUTION_ATTACH_ATTEMPTS`（8）——真实尝试耗尽后才丢弃并计入
   `contributions_dropped`。

队列规模由**未解决的写失败**决定，它不是常量上界：写一直失败时它会涨，而那正是 `store_errors` 已经
降级、`/status.pipeline.pendingContributions` 与 health 已经报 `pipeline:pending-contributions` 的状态。
`contributions_dropped` 自本决策起出现在 `/status.counters`（并由 checkpoint 持久化），任何一次丢弃都可查。

不新增写接口、不改 schema、不改 `count` 的加法语义。

**实现方式由 ADR-0007 取代（2026-11-02）**：本节"不按容量淘汰"的**结论**保留，
但"队列只在内存、规模由未解决写失败决定"这一实现被证明还不够——进程崩溃会让留存证据整体消失，
而已入库、已被引擎见过的那次观测从此再无人认领（ADR-0007 §1.2 有当前树的实测）。
自 ADR-0007 起：队列落盘到 `daemon_contribution_spool`（迁移 v5），内存只做缓存；
`contributions_dropped` 改为**观测级**计数，并与 `contributions_spool_errors` 一起进入 health 原因；
`count` 的贡献量按"该行尚未认领的证据"派生，使"写入成功但 spool 删除失败"的重放不双计。

## 2.7 不放大的部分

- 不新增"按稳定键更新告警"之类写接口。
- 不改 `dedupe_key` 的派生规则、不改唯一索引、不改 schema（**无迁移**）。
- 不改 `event_id` 主键判重这道防线。

## 3. 备选与取舍

| 方案 | 问题 |
|---|---|
| 让 daemon 自己维护有界稳定键窗口 | 重启即失效，正好覆盖"重放"这个主场景；且把判重语义复制到第二处，仍会漂移 |
| daemon 在 `duplicate` 分支继续补救 | 已证明只能覆盖纯重放批次；混合批次里重复观测已经进了 `count`，事后无法拆开 |
| 让 T1 接受"整批"并返回逐条结果 | 改动面远大于本项；批准一次事务边界重构要走单独 ADR |
| 直接按 `payload_digest` 判重 | 与设计 §5.2 的"代次 + 原生 ID"语义冲突，且同内容不同来源会被误合并 |

选**最小读接口**：只把"这个稳定键在不在"这一位信息交出去，判重仍由 T1 与唯一索引做权威裁定，
daemon 只是提前少做一次无意义的检测。

## 4. 验收（可回归的断言）

1. `hasDedupeKeys` 返回等长同序布尔数组；空输入零 SQL；键数 > 一批事件时仍逐位正确。
2. 返回值的 JSON 化只含 `true/false`：对返回数组做 `Object.keys`/深遍历断言无对象泄漏。
3. 键非法 → `ERR_STORE_INPUT`，`details` 只有 `{index, field}`，不含键值。
4. 只读句柄可调用；调用前后 `telemetry_event` / `audit_log` 行数不变。
5. **混合批次**：`[重放(同稳定键,新event_id), 新观测]` → `alert.count` 只增真实新观测；
   `event_ids` 全部能在 `telemetry_event` 里查到；不产生第二次分析请求。
6. **事务回滚**：批内某事件写入失败 → 该事件无行、无告警、无 outbox；
   已成功事件的 `alert` 行里每个 `event_id` 都能查到；`store_errors > 0` 且游标不推进。
7. **跨批保留**：保留贡献的证据无法核实时不得写出悬空 id；可核实时补写且 `count` 与事件行数一致。
8. **批内同键**：一批里两条同稳定键事件 → 第二条不进检测、不产生重复证据 id、后续批次正常写入。
9. 重跑 `tests/wp1-event-store`（≥280）与 `tests/wp5-daemon`（≥272）；下限只上调。
10. **锚点顺序**：多指纹/跨窗口的一批里出现 ≥2 条告警贡献、写入失败后原样重放，
    任何一次 T1 调用都不得引用当时尚未写入的事件；事后每个 `event_id` 都能在 `telemetry_event` 查到。
11. **部分写成功后重放**：先成功一条、再重放补齐另一条 → `count` 必须追平该窗口可核实的事件数，
    不得停在旧值（`truncated` 仍当且仅当 `count > event_ids.length`）。
12. **跨来源**：来源 A 的延后证据遇到来源 B 的批次时不得被排空——B 的批次不得增加
    `contributions_attach_attempts`、不得减少 `contributions_pending`、不得增加 `contributions_dropped`；
    A 重投后该窗口的 `count` 必须等于库里该窗口的事件数。同来源内事件永不回来时，
    重试预算耗尽后丢弃并计入 `contributions_dropped`。
13. **不得按容量丢弃**：任何容量上限/配额都不得淘汰延后证据——写失败后游标不推进、批次会重放，
    被淘汰的观测随后入库却永远不被 `count` 认领。一次 99 事件全失败批次重放后，99 个窗口都必须有告警行，
    `count` 必须等于库内事件数，`contributions_dropped` 必须为 0。

## 5. 遗留与风险

- 稳定键探测与随后的 T1 之间不是同一事务，理论上存在"探测时不在、写入时已在"的窗口。
  该窗口只会导致 T1 返回 `duplicate`，由既有 `duplicate` 分支处理（选择性保留），
  不会产生悬空证据；**单写者模型下不构成实际风险**，多写者被 `db.js` 的跨进程写锁排除。
- 探测是每批 O(n) 次点查（命中唯一索引）。未做百万行压测；`stats()` 的缓存策略不适用于本接口。
- 内存适配器的派生逻辑仍是第二份实现，靠 `stable key parity` 对拍测试而非结构保证一致；
  `packages/collectors/common/ids.js` 的 `buildStableKey` 是第三份编码（仅用于采集器进程内去重窗口），
  与 T1 的 `dedupe_key` 不共享代码，改规则时需同时改两边。
- `count > event_ids.length`（256 上限截断）时，落在上限之外的失败事件 id 无法识别，
  那一次观测不会被扣减，`count` 可能偏大 1。方向 fail-closed（不造 id）。
- 保留贡献若其事件既未入库、也不再重投，观测会被扣掉（`alerts_dropped` 可见），
  但该观测的告警计数不会自愈；这比写一条查不到证据的行要好。
  自 2.6 起，被批内剥离的观测会留一份单窗证据贡献，只有在**该事件被重试**时才会补回；
  永不重投时仍按上面这条处理（丢弃并计数）。
- 队列按来源分层后，**一个来源彻底消失时它自己的条目会长期留在队列里**（重试预算只在同来源批次上推进）。
  这是有意的：`daemon.status().pipeline.pendingContributions` 常驻非零是该来源还有未补记证据的唯一可见信号；
  丢掉的代价是永久少计且 `truncated=false`，读侧看不出来。**队列不设容量上限**：任何容量淘汰都会
  丢掉本来会随重放自愈的观测；规模由未解决的写失败决定，写一直失败时 `store_errors` 与 health 已经降级。
- 残余的内存风险：长时间、大流量、写持续失败时，延后队列会按失败窗口数增长（每条只带告警 DTO 与 id 列表）。
  当前没有额外的硬上限，这是刻意的取舍；若将来要加上限，必须先有**不丢证据**的落盘方案（新 ADR）。
- 锚点规则（2.5）与延后补记（2.6）都依赖"一次 T1 调用 = 一条事件 + 它的派生物"这个前提。
  若将来把 T1 改成整批事务，这两条要重新推导，不能照抄。
