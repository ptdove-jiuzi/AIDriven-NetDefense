# @aegisharness/detection 集成说明

确定性、不执行规则脚本。时间全部来自注入的 `clock`，ID 全部由注入的 ID 工厂产出 UUIDv4。
`packages/contracts` 已实现：本包**仅** `src/contracts-adapter.js` 一个文件 import
`@aegisharness/contracts`，并作为唯一契约出入口；引擎核心与其它 `src` 文件不依赖 contracts。

## 1. 公共 API

| 函数 | 参数 | 返回 | 错误 |
|---|---|---|---|
| `createDetectionEngine(o)` | `{ rulePack, clock, ids?, cpuClock?, budgetQuantumMs?, allowNondeterministicBudget?, limits?, analysisGate?, maxEventsPerIngest? }` | 引擎句柄 | `RuleDefinitionError`（规则包非法）、`DetectionConfigError`（clock/limits/批大小/预算时钟非法、`ids` 不是 `ids.js` 的工厂、注入墙钟时钟但未声明） |
| `engine.ingest(events)` | 事件数组 | 结果对象：`at`、`detections`、`alerts`、`closedAlerts`、`analysisRequests`、`analysisDenied`、`gaps`、`ruleIsolations`、`decisions`、`eventsProcessed`、`eventsSuppressed` | 见下方「调用方编程错误」；抛出即冻结引擎（`ENGINE_FROZEN`） |
| `engine.advanceTo(at)` | 毫秒时间戳 | 同构结果（`eventsProcessed: 0`）；`at` 回退时状态不变，返回的 `at` 是**当前**（未回退的）时间戳 | `DetectionConfigError`（非非负整数）；抛出即冻结引擎 |
| `engine.flush()` | — | `advanceTo(clock.now())` 的结果 | 同上 |
| `engine.stats()` | — | 计数器、`gapsByKind`、`openFingerprints`、`thresholdGroups`、`correlationSlots`、`allowlistExpired`、`rulesEnabled/Isolated`、`budgetClock`/`budgetQuantumMs`/`nondeterministicBudget`、`fatal`（健康时为 `null`） | — |
| `engine.ruleStates()` | — | 按 `ruleId` 排序的 `{ ruleId, state, kind, reason, isolatedAt, batchId, cpuUsedMs, steps }[]` | — |
| `engine.rehabilitateRule(id)` | ruleId | `boolean`（未知 id 为 `false`） | — |
| `engine.setAlertStatus(alertId, s)` | 告警 id、目标状态 | `boolean`（非法迁移/已关闭为 `false` 且不改状态） | — |
| `engine.getAlert(id)`／`suppressions()`／`limits()` | — | 告警视图或 `null`／抑制记录副本／生效上限 | — |
| `loadRulePack(path)` | JSON 路径 | 编译后规则包 | `RuleDefinitionError`，`code` ∈ `RULE_PACK_PATH_INVALID`/`UNREADABLE`/`PARSE_ERROR`/`VERSION_MISMATCH`/`RULES`/`UNKNOWN_KEY`/`RULE_ID_DUPLICATE` 等 |
| `validateRulePack(pack)`／`resolveLimits(o)` | 规则包／部分 limits | 编译包／补全 limits | 同上（无文件类 code）／`DetectionConfigError` |
| 其余工具 | `createManualClock`、`createStepClock`、`createRealtimeClock`、`createMonotonicClock`（等价于 `createRealtimeClock`，已废弃）、`assertClock`、`assertBudgetClock`、`isRealtimeClock`、`DEFAULT_BUDGET_QUANTUM_MS`、`canonicalStringify`、`sha256Hex`、`shortHash`、`truncatePreview`、`compileExpression`、`evaluateExpression` 等 | 见源码 JSDoc | `DetectionConfigError`／`RuleDefinitionError`／`RangeError` |

结果数组恒按文档排序：detections `(observedAt, ruleId, fingerprint)`、alerts/closedAlerts
`(windowStart, fingerprint)`、analysisRequests `(hourStart, fingerprint, sequenceInHour)`、
analysisDenied `(hourStart, fingerprint, reason)`、gaps `(kind, ruleId, at)`、ruleIsolations `(ruleId, at)`。

**调用方编程错误（fail-closed）**：处理数据本身不抛错，但有两类调用方编程错误会直接抛
`DetectionConfigError`，且**不静默降级**：

1. `ingest(非数组)`——入参不是数组，属于契约违反；单条坏事件仍只降级为 `decisions` + gap。
2. **ID 工厂失败**——工厂抛错或返回非 canonical UUIDv4（`createSequenceIdFactory` 序号耗尽也走这条路）。
   它**不会**被记为 `rule-isolated`：`rule-isolated` 的归因是"规则故障"，把接线错误混进去会误导排障。

**批次不是原子的，失败的批次是致命的**（审查 P2-R2-1 的处置）：

`ingest` / `advanceTo` / `flush` 在运行过程中逐步修改状态（告警窗口、指纹表、限流计数、计数器），
因此批次中途抛错时，**失败之前的事件已经生效**，之后的事件被丢弃。回滚需要为每个批次快照整张
状态图，既不便宜也不诚实——部分状态就是真实状态。因此契约写死为：

1. 任何逃出批次的异常都会**冻结引擎**：后续每次 `ingest` / `advanceTo` / `flush` / `setAlertStatus` /
   `rehabilitateRule` 都抛 `DetectionConfigError`，`code = 'ENGINE_FROZEN'`，`detail` 给出出错的
   `batch`、`at`、`reason`，`stats().fatal` 同步可见。这样调用方不可能把"半落地的引擎"误当成健康引擎，
   简单重试也不会把已经落地的事件再投递一次。只读调用（`stats` / `getAlert` / `ruleStates` /
   `suppressions` / `limits`）不受影响，排障时仍然可读。
2. **恢复方式只有"丢弃并重建"**：新建引擎，从调用方自己持久化的最后耐久位点重放。引擎不自持
   任何耐久状态，因此重建永远可行。
3. 入参校验（`ingest` 必须是数组、`advanceTo` 必须是非负整数）发生在冻结检查**之前**，
   所以一次写错参数不会打死健康引擎。
4. `flush()` 先读 `clock.now()` 再走 `advanceTo`：clock 自身抛错时它抛的是原始 `Error`
   且**不冻结**（此时没有任何状态被改动）；同一个 clock 在 `ingest` 里抛错则会冻结。
   这个不对称是刻意的——只在真的可能已改状态时才冻结。

ID 工厂失败的时机决定后果，必须分清（下表为实测结果，不是推断；三列都是 `engine.stats()`
的**计数器**，不是结果数组——抛错时根本没有结果对象可读，`batch.alerts` 此刻是空的）：

| 失败的号 | `detections` | `alerts` | `analysisRequests` | 说明 |
|---|---|---|---|---|
| 检测号 | 0 | 0 | 0 | 检测对象还没构造出来，什么都没有落地 |
| 告警号 | 0 | 0 | 0 | 检测对象已构造，但 `detections` 计数在**聚合成功之后**才自增，所以仍是 0 |
| 请求号 | 0 | **1** | 0 | 告警已在聚合里建好并进入 `openAlerts`；`detections` 同样因聚合未返回而停在 0 |

注意 `detections` 的语义是"**已应用**的检测数"，不是"已构造的检测数"——排查时不要用
`detections > 0` 去推断"检测已落库、只差告警"，上表第二行就是反例。

配额与去重集合在取号**之后**才记账，所以失败那一次**没有被吃掉配额**：同一 `rateState`
换一个可用工厂可以立刻放行，且小时序号从 1 开始（`tests/wp3-detection/rate-limit.test.js`
用"同一个 rateState 前后对比"证明了这一点；旧写法用新建引擎重试，那条断言恒真，已废弃）。
但**整批告警已经被改写**，所以**不能靠"重试同一批"补发**——只能重建引擎后从耐久位点重放。

**顶层字段回退仅限** `eventId`/`observedAt`/`type`/`source`/`severity`（其余顶层键不透传，规则只能
经 `fields` 读取自定义字段）。

## 2. 与 packages/contracts 的字段映射（经 `src/contracts-adapter.js` 落地）

| 本包 | Finding/Alert | 说明 |
|---|---|---|
| `detectionId`／`alertId` | `finding_id`／`alert_id` | UUIDv4，由注入的 ID 工厂产出；告警 upsert 键是 `(fingerprint, window_start)` |
| `ruleId`／`ruleVersion` | `rule_id`／`rule_version` | 原样 |
| `eventIds` | `event_ids` | `eventIdsTruncated` 时数组不完整 |
| `fingerprint`／`fingerprintPreview` | `fingerprint`／`evidence_refs` 摘要 | 指纹对完整值求哈希；预览最长 `maxFingerprintValueLength`（含省略号） |
| `severity`／`peakSeverity` | `severity` | `info/low/medium/high/critical` |
| `firstSeen`／`lastSeen`／`count`／`status` | `first_seen`／`last_seen`／`count`／`status` | 同名字段直接对应 |

| 本包 `AnalysisRequest` | 设计 `AnalysisRequest` | 说明 |
|---|---|---|
| `requestId` | `analysis_id` | 由注入的 ID 工厂产出；重放一致靠注入固定工厂，不靠内容派生 |
| `requestKey`／`idempotencyKey` | `idempotency_key` | 同一 key 只放行一次 |
| `alertId`／`budgetClass`／`createdAt` | `alert_id`／`budget_class`／`created_at` | 原样 |
| `sequenceInHour` | `summary_dto.fields.sequence_in_hour` | 只进入 `summaryDto.fields.sequence_in_hour` 与独立元数据，**不再**映射为整个 `summary_dto` |
| — | `epoch` | 由编排层填写，detection 不感知恢复 epoch |

| 本包事件输入 | `TelemetryEvent` | 说明 |
|---|---|---|
| `eventId`／`observedAt`／`source`／`type`／`severity`／`fields` | `event_id`／`observed_at`／`stable_source_id`／`type`／`severity`／`payload` | 点路径读取，不支持数组下标 |
| — | `collector_instance_id`／`source_generation`／`boot_id`／`native_record_id`／`source_seq`／`received_at`／`integrity` | 采集层持有，detection 只消费左侧 6 个 |

### 2.1 ID 语义

`detectionId`／`alertId`／`requestId` 全部是 UUIDv4，由创建引擎时注入的 ID 工厂产出：生产用
`crypto.randomUUID`（`createRandomIdFactory()`），测试注入 `createSequenceIdFactory()` 之类的固定
工厂以重放。ID 与内容无关，因此同一份事件重放不会得到同一个 ID。

幂等不依赖 ID，而由 `idempotencyKey` 保证：同一 key 每小时只放行一次请求，重放由 event-store 的
唯一约束兜底。告警的 upsert 键是 `(fingerprint, window_start)`，与 `alertId` 无关——`alertId` 只
用于引用与状态迁移。

## 3. 与 event-store T1 事务的写入顺序

入参用 `ingest()` 的返回值，同一个事务提交：`telemetry_event`（含被白名单抑制的事件，抑制不删原始
事件）→ `finding`/`alert`（用 `alerts`/`closedAlerts` upsert，键为 `(fingerprint, window_start)`）→
`analysis_request` outbox（`idempotencyKey` 唯一约束兜底重放）→ `audit_event`（本批计数、`gaps`、
`ruleIsolations`、`analysisDenied`）。`decisions`、`stats()` 只做观测，不入库；`analysisDenied` 不进
outbox。

**硬约束（event-store 必须实现）**：`alert` 的唯一 upsert 键是 `(fingerprint, window_start)`；
**已存在行的 `alert_id` 不得被新值覆盖**——`alert_id` 是仅插入的代理键（insert-only surrogate key），
冲突时保留原值（或拒绝该 upsert 并报冲突），只有 `count`/`last_seen`/`severity` 等可变列按新值更新。
理由：状态 TTL 过期或指纹容量淘汰后，同一窗口可能被重建并得到新的 `alert_id`；
若覆盖旧行，先前写入的 `analysis_request.alert_id`、`evidence_ref.alert_id` 会变成悬挂引用
（设计 §4.2 / §7.2 要求三者同源）。

**已知行为**：条目过期（`state-expired`）或被淘汰（`fingerprint-limit`）之后到达的迟到事件，
会在**同一** `window_start` 重建告警，`count` 从 0 重新计数，且不会产生 `late-window` gap——
引擎的"旧窗口不复活"判定依赖内存里的 `closedWindowStart`，它随条目一起回收，
引擎**不保留**跨回收窗口的已关闭水位。需要严防该场景的部署应把 `stateTtlMs` / `maxFingerprints`
调到覆盖最长迟到窗口，并由 event-store 的 `alert_id` 不可覆盖约束兜底。

## 4. 与 packages/policy 的全局预算闸门

`analysisGate(alertView, ctx) => boolean`，`ctx = { at, fingerprint, ruleId, requestKey, hourStart }`。
顺序固定为「严重度门槛 → 幂等去重 → 闸门 → 小时计数」：闸门返回 `false` 或抛错都记
`analysisDenied{ reason: 'global-budget' }`，不占用小时配额、不写入去重集合，同小时后仍可放行。
policy 侧的全局预算拒绝、维护窗口、人工暂停都从这里接入，无需改规则包。

### 4.1 小时配额按小时分桶，事件时间回退不清零（P1-2）

小时配额的状态是**每指纹一张有界的桶表**（`Map<hourStart, { count, released }>`，LRU 保留
`RATE_BUCKETS_RETAINED = 6` 个桶）加一个 `minted` 集合（保留 `RATE_KEYS_RETAINED = 4096` 个已放行
`requestKey`）。语义：

1. `at` 回退到已经花掉配额的小时，读到的是**那个小时的计数**，不会因为"小时变了"就清零重来。
2. 同一个 `requestKey`（`shortHash(fingerprint|hourStart|severity)`）**永远不会被铸造第二次**：
   桶内去重 + 全局 `minted` 双重兜底，即使桶已被 LRU 淘汰也一样。旧实现（单桶 + 小时不等即重置）
   实测在 `770min → 775min → 790min → 778min` 序列里把 `de5e221d…` 这个 key 放行了两次，
   两次的 `requestId` 不同——同一个幂等键对应两份请求。
3. 迟到事件/回拨只影响"往哪一小时记账"，不会让任何一小时超过 `analysisPerFingerprintPerHour`。

告警聚合层对 `observedAt` 回退的处理是**显式**的：`firstSeen` 取最小值、`lastSeen` 取最大值、
计数照常累加（丢事件才是更坏的失败）；只有"窗口回退"（`windowStart` 早于已关闭窗口或当前开放窗口）
才记 `late-window` 且不产生 detection。`aggregate.js` 的 `addObservation` 里写明了这条边界。

## 5. gap 并入采集健康视图

`gaps` 每次调用返回，`stats().gapsByKind` 累计；同一次调用内按 `(kind, ruleId, detail)` 合并计数。

| gap.kind | 健康视图含义 |
|---|---|
| `invalid-event`、`ingest-batch-limit` | 摄入侧质量/背压：单批超限说明上游突发或限流 |
| `duplicate-event` | **预留**：当前不产生（幂等重复只进 `decisions`/`stats().duplicateEvents`） |
| `late-window` | 迟到事件（早于已关闭窗口或早于当前开放窗口）：不产生 detection/alert，只入 `decisions` 与 gap |
| `state-expired`、`fingerprint-limit` | 状态容量：指纹基数超限，需采样或调容量 |
| `correlation-slot-limit`、`threshold-window-overflow`、`threshold-group-limit` | 规则超出预算：链路过长、分组过多 |
| `rule-isolated` | 规则故障：与 `ruleIsolations` 一起告警，规则不自动康复 |

缺口只做计数与原因；`detail.fingerprint` 为摘要，可安全进入健康视图。

## 6. 上限语义与未实现项

`limits.maxThresholdGroups` 是**每规则**分组表上限（默认 4096，满时淘汰最久未命中分组并记
`threshold-group-limit`），而 `stats().thresholdGroups` 是**跨规则求和**，两者不可直接比较；
`maxCorrelationSlots` 是全局共享上限，`stats().correlationSlots` 同为其求和形式。

未实现：规则包签名验证（只做结构校验）、最低安全版本强制、规则包热更新与回滚、状态持久化快照、
全局预算计数（仅提供闸门接入点）。`threshold` 分组表与 `correlation` 槽位均为内存结构，重启后不
恢复，跨重启一致性由 event-store 快照负责。

## 7. 实现决策（规格未完全覆盖处）

- 规则必须声明静态 `severity`；`severityFrom` 可选覆盖，取到非法值或缺失时回退 `severity`。
- 首次观测只建立严重度、不写 `escalations`；待定升级先记 `deferred: true`，生效时原地定稿，同一
  `(from, to)` 不会产生两条记录；新观测一律先结案已到期的待定升级再观测。
- 窗口关闭时把 `severity`/`lastEscalationAt`/`pendingEscalation` 落到指纹条目并记下最近关闭窗口，
  `advanceTo` 与"事件触发滚动"两条路径产生相同告警视图；`windowStart` 不晚于该窗口的事件只记
  `late-window`，不复活告警。
- 首次建立严重度不计入 `escalations`；只有**已放行**的请求写入小时去重集合，被拒绝的可重试计数。
- 事件级时间戳取 `observedAt`；`clock` 用于 `advanceTo`/`flush`、结果 `at` 与白名单过期判定。
- 规则隔离时清空该规则瞬时状态而非逐条回滚；未声明 `fingerprint` 时默认取 `fields`/`groupBy`。
- 预算计量默认是确定性的步进时钟（见 §8）：`ruleCpuBudgetMs` 在默认模式下是"虚拟毫秒"，
  与墙钟无关；`budgetQuantumMs` 决定一次采样值多少钱。真要用墙钟就必须
  `allowNondeterministicBudget: true`，并接受"同一输入可能得到不同隔离集合"。
- 小时配额按小时分桶（见 §4.1），回拨不清零、同 key 不重铸；聚合层对 `observedAt` 回退
  取 min/max 并照常计数，只有窗口回退才记 `late-window`。

## 8. 预算时钟的两种模式（P1-1）

规则 CPU 预算（`limits.ruleCpuBudgetMs`）由**每规则一只**预算时钟计量。它决定"哪条规则被隔离"，
而隔离是永久的（只能 `rehabilitateRule` 手工恢复），所以计量方式直接决定输出是否可重放：

| 模式 | 怎么来 | 计量单位 | 重放一致性 | `stats().budgetClock` |
|---|---|---|---|---|
| **确定（默认）** | 不传 `cpuClock` | 每次采样前进固定量子（`budgetQuantumMs`，默认 `0.01` 虚拟毫秒），即"评估步数"而非墙钟 | 同一输入序列 + 同一输入时钟 → 逐字节一致 | `'step'` |
| 自定义 | 传自己的 `cpuClock`（测试脚本时钟、冻结时钟等） | 由调用方决定 | 由调用方负责 | `'custom'` |
| **墙钟** | `cpuClock: createRealtimeClock()` **且** `allowNondeterministicBudget: true` | `process.hrtime` 差值 | **丢失**：同一输入可能隔离不同规则 | `'realtime'` |

要点：

1. 只传 `createRealtimeClock()` 而**不**声明 `allowNondeterministicBudget: true` 时构造直接抛
   `DetectionConfigError`（`code: 'NONDETERMINISTIC_BUDGET'`，`path: 'cpuClock'`）。fail-closed 的理由：
   旧默认就是墙钟，实测 60 规则 × 1000 事件连跑三次得到 4337 / 6224 / 5734 条检测，并把全部 60 条规则
   永久隔离成 `cpu-budget-exceeded`——静默接受墙钟等于静默接受"零事件、零静默丢失"这条底线被破坏。
   `createMonotonicClock()` 仍可用，但它等价于 `createRealtimeClock()`（同样受这条约束），已标记废弃。
2. 计时器是**每规则**的：共用一只全局步进时钟会让单规则的计量随规则条数线性膨胀
   （60 条规则时 83 个事件就把 50ms 花光，检测数从 60000 掉到 4980）。默认量子下 1000 个事件的
   单批只计 10 虚拟毫秒，所以正常批量不会被误隔离；想让预算更紧可以调 `budgetQuantumMs`
   （例如 `1` 表示每次采样计 1 虚拟毫秒），或用 `limits.ruleCpuBudgetMs` 直接收紧。
3. 预算守卫仍然有效：`ruleCpuBudgetMs: 1` 时会在批次中途隔离规则（`tests/wp3-detection/budget-clock.test.js`
   断言隔离发生在批次中途，既不是全量放行也不是零放行）。
4. 隔离记录（`ruleIsolations[]` 与 `ruleStates()`）带 `cpuUsedMs` 与 `steps`，运维可据此区分
   "规则太慢"与"预算配太小"；`kind: 'error'` 的隔离这两个字段是 `null`（没有预算计量）。
5. `assertClock`（事件时钟）要求 `now()` 返回**整数**毫秒：`flush()` 走 `advanceTo(clock.now())`，
   而 `advanceTo` 只接受非负整数。旧代码在构造期只校验 `Number.isFinite`，于是 `now()` 返回 `1500.5`
   的引擎会先成功 `ingest`、再在 `flush()` 抛错并冻结；现在这类接线错误在构造期就失败。
   预算时钟用 `assertBudgetClock`，允许小数（墙钟本来就是小数毫秒）。

### 8.1 `toAnalysisRequest` 对 `classification` 是静默忽略，不是 fail-closed

`toAnalysisRequest(request, alert, { epoch, allowedSummaryFields, classification })` 只把
`allowedSummaryFields` 转给 `buildSummaryDto`，因此 `summary_dto.classification` 恒为 `D0`，
传 `'D1'` / `'D2'` 既不报错也不改变输出（用例
`tests/wp3-detection/contracts-integration.test.js` 锁死了"忽略且仍是 D0"）。

需要 fail-closed 的调用方应直接用 `buildSummaryDto(request, alert, { classification })`：它为任何
非 `D0` 的值抛 `DetectionConfigError`（`path: 'options.classification'`，`detail.requested` 带原值）。
保留静默忽略的原因是 `toAnalysisRequest` 是"装配 + 校验"的窄接口，把多余的调参键升级成异常会让
既有调用方在升级时突然失败；`D0` 不可被提级这一点在两条路径上都有用例。
