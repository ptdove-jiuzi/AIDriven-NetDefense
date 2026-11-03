# ADR-0007：pending contribution 的持久化与计数权威

- 状态：**Accepted（2026-11-02）**
- 作者：PT-dove
- 关联：`docs/adr/ADR-0006-event-store-stable-key-probe.md`（§2.4–2.6、§4-12/13）
- 影响范围：`packages/event-store/src/{schema.js,spool.js,index.js}`（新增迁移 v5 与只读/只写 spool 接口）、
  `apps/daemon/src/{pipeline.js,health.js,adapters/event-store.js}`、`tests/wp1-event-store/**`、`tests/wp5-daemon/**`、根 `package.json`
- 取代：ADR-0006 §2.6 中"队列不设容量上限"的**实现方式**（结论保留，改为落盘 + 不再依赖内存队列）

## 1. 问题事实（可复核）

### 1.1 三代修法都只改了"丢在谁身上"

| 修法 | 结论 |
|---|---|
| 全局 32 槽、`shift()` 淘汰最旧 | 挤掉**无关来源**的可恢复证据；否决 |
| 全局上限 + 满则拒收新条目 | 损失转移给"下一个失败的来源"；否决 |
| 每来源配额 32、淘汰自己最旧 | 溢出者自己付代价，但**事件随后照样重放入库**，`count` 永不认领；否决 |

三代都违反同一条不变式：**写失败后游标不推进，那一批会重放**，所以被淘汰条目的事件随后确实会入库；
"容量丢"不是"证据永不回来"那种 fail-closed，而是把一个**本来会自愈**的观测永久少计，
且 `truncated=false` 让读侧以为证据完整。

### 1.2 容量上限去掉之后，根因仍在：留存证据只在内存里

容量上限去掉之后，队列已无容量上限（当前树 `pipeline.js:126-141`）。本次在**当前树**上用真实
scheduler + 真 SQLite + 真引擎重跑上述两种形态，并补了一个此前没有覆盖的形态：

| 形态 | 构造 | 当前树实测 | 判定 |
|---|---|---|---|
| 33 条同来源积压 | 33/99 条分属 33/99 个窗口、全部写失败 → 重放 | `pending=99 → 0`、99 事件 / 99 行、`problems=[]` | **已闭合**（容量路径） |
| 跨来源 | A 留 1 条 + B 33 条全失败 → A 重投 | 逐窗口 `count == stored`、`dropped=0` | **已闭合** |
| **部分写成功 + 进程重启** | `[e1 成功, e2 锚点失败]` → 崩溃 → 同一库重启 → 原批重放 | **`count=1`，窗口内已入库 2 条，`truncated=false`** | **未闭合** |

复现输出（仓库外的一次性复现脚本）：

```json
{"stage":"after_fail","pending":1,"dropped":0,"events":1,"alerts":[]}
{"stage":"after_restart_replay","pending":0,"dropped":0,"events":2,
 "alerts":[{"w":"2026-11-02T00:00:00.000Z","c":1,"ids":1,"tr":false}],
 "problems":[{"kind":"count_vs_stored","count":1,"stored_in_window":2,"delta":-1,"truncated":false},
             {"kind":"unclaimed_event","source_seq":101}],"pass":false}
```

对照组（同一形态**不重启**）：`{"pending":0,"events":2,"alerts":[{"c":2,"ids":2,"tr":false}],"problems":[]}`。

根因链条：

1. 锚点事件写失败 ⇒ 整条告警贡献被 `retainContribution` 留在 `pendingContributions`（**内存数组**）；
2. 崩溃/重启 ⇒ 队列消失，而 `e1` 已经入库、**永远不会再被检测**（同一进程内 `seenEventIds` 已见过它；
   重启后预过滤器又按稳定键把它当作"已有"直接丢弃，检测根本看不到它）；
3. 重放只补进了 `e2`，新引擎为它单独产出一条 `count=1` 的贡献 ⇒ 行里少了 `e1` 的那一次观测；
4. 没有任何计数器、日志或 health 原因记录这件事：`pending=0`、`dropped=0`、`health` 只看 `pending`。

即：**留存证据的生命周期必须覆盖进程生命周期，否则"可恢复证据"在崩溃点变成不可恢复。**
这不是容量问题，也不是作用域问题——两者都已修好；缺的是**持久化**。

## 2. 方案比较

| 方案 | 做法 | 能否满足不变式 | 代价 / 否决理由 |
|---|---|---|---|
| **A. 落盘 spool（选定）** | pending contribution 写入 SQLite 一张专用表，按 `source_id` + 窗口键组织，内存只做缓存；重启即恢复 | **能**。证据不再随进程消失，`count` 可在重放时补回 | 一次 schema 迁移（v5）+ 适配器 3 个方法 + pipeline 落盘/恢复；不触碰 T1 写面、不改 `count` 加法语义 |
| B. `count`/`event_ids` 从已入库事件派生，增量计数不再权威 | 每次告警写入前按库内事实重算 | 理论上能，但需要"把已入库事件重新过一遍规则包" | **否决**：判重键之外还要复算规则包（可热更新、可回滚），派生结果随规则版本变化；等于在 event-store 里重建一个检测引擎，且要新增"按窗口取事件"的读接口（ADR-0006 §2.2 刚把读面收窄成布尔）。工作量与风险都远超本次 P1 |
| C. 任何容量溢出必须 `truncated=true` + degraded | 保留容量上限，只把丢弃变可见 | **不能**。`truncated=true` 只描述"`count > event_ids.length`"，而这里的缺陷是 `count` **小于**库内事件数、`ids` 也缺——把它标成 truncated 是拿另一个谎盖住这个谎 | 单用**否决**：可见不等于正确；且容量上限本身就是"丢可恢复证据"，与任务禁止项冲突 |

**决定：A。** 并把 C 的**要求**（任何真实丢弃都必须显式降级、不得静默）作为 A 的伴随规则，
落在唯一剩下的丢弃路径（同来源 attach 预算耗尽）上；B 不采用，理由如上。

### 2.1 为什么落 SQLite 而不是 daemon 的 JSON checkpoint

- checkpoint 有 `MAX_STATE_BYTES = 512KB`，且**超限即隔离**（`state-store.js:222-225` 把整个文件改名成
  `.corrupt-*`）：一次 500 事件的降级批次足以把它撑爆，结果是**连游标一起丢**——那会新造一条静默丢失路径；
- checkpoint 每次保存要重写整份 JSON 并 fsync，逐条目落盘会退化成 O(n²) 写放大；
- SQLite 已经在库里、已经由 `db.js` 的跨进程写锁保护、已经是单写者模型的一部分，加一张表不需要第二套持久化纪律。

## 3. 决定（可执行的部分）

### 3.1 新增迁移 v5：`daemon_contribution_spool`

```sql
CREATE TABLE daemon_contribution_spool (
  spool_id     TEXT PRIMARY KEY,   -- 内容摘要：source_id + 窗口键 + 证据 id 的 sha256
  source_id    TEXT,               -- NULL = 未知来源（遗留调用方），自成作用域
  windows_json TEXT NOT NULL,      -- ["<fingerprint>\u0000<window_start>", ...]，用于按窗口隔离与诊断
  attempts     INTEGER NOT NULL CHECK (attempts >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  payload_json TEXT NOT NULL       -- {alerts:[...], requests:[...]}，与内存条目同形
) STRICT;
CREATE INDEX daemon_contribution_spool_source_idx ON daemon_contribution_spool (source_id, updated_at);
```

- `spool_id` 由内容派生（不是随机 id）：同一份证据重复失败重投时命中 `UPSERT`，
  **不会**随重试次数线性增长；同一 `(source_id, 窗口键集合, 证据 id 集合)` 只有一行。
- 迁移只追加（ADR 既有约束），不动任何已发布版本；无数据搬迁。

### 3.2 内存只做缓存

`pendingContributions` 仍是运行期的权威索引（避免每次 attach 都查库），但**不再是唯一的真相**：

| 时点 | 动作 |
|---|---|
| `createPipeline` | 从 spool 载入全部条目（`contributions_recovered` 计数）；载入失败 → `contributions_spool_errors+1`、内存起步为空、health 降级 |
| `retainContribution` | 入内存 + `UPSERT` 落盘；落盘失败 → `contributions_spool_errors+1`、日志 `error`、**条目仍在内存**（本进程内仍可补写），health 降级 |
| `attachRetained` 排空条目 | 写成功后 `DELETE` 该 `spool_id`；若本批只排空一部分，把剩余部分以新的内容摘要重新落盘并删除旧行 |
| 预算耗尽丢弃 | `DELETE` + `contributions_dropped += 观测条数` + `logger.error` + health 原因 |

**删除时点（实现必须照此）**：`DELETE` 只能发生在**承载该贡献的那次 T1 调用返回成功之后**。
在计划阶段（`attachRetained` 正在拼 plan 时）删除会开出一个窗口：行已经没了、锚点还没写，
此刻崩溃就是"证据既不在库里、也不在 spool 里"，重启后永久少计且 health 干净——正是本 ADR 要消灭的形态。
实现方式：`attachRetained` 只把结果记到 `plan.attachedOutcomes`（按锚点事件分组），
由 `ingestBatch` 在 `writeOne` 之后调用 `settleAttached(outcomes, committed, replacement)` 结算。
写失败时旧行**不得**先删后存：只有当替换副本（计划部分的重保留 + 未核验余量）都已落盘，才允许删除旧行。

**删除判据必须是主键身份，不是布尔**：两条普通路径会让"替换副本"落在**同一个** `spool_id` 上——
(a) 失败重试重新保留逐字节相同的内容 → `putContributionSpool` UPSERT 的正是待删的那一行；
(b) spool 写入失败时 `retainContribution` 仍返回内存条目（本进程要能继续重试）→ "已重新保留"为真但没落盘。
所以规则写成：**只有当一个 `spool_id` 不同、且确实落盘的替换副本存在时，才允许删除旧行**；
写失败/`duplicate` 且没有这样的替换时，旧行原样保留（残留行由 §3.3 的幂等条件中和，不会双计）。

### 3.3 计数权威：`count` 由"可认领的证据"派生
`attachRetained` 里一条保留告警的贡献量不再直接采信 DTO 的 `count`，而是：

```text
count = |{ id ∈ 该告警的 event_ids | id 未入库时由本批写入, 或已在库, 且不在该行已有的 event_ids 里 }|
```

最后一项（"不在该行已有的 `event_ids` 里"）是本轮新增的**幂等条件**，由适配器新方法
`alertEvidenceIds(fingerprint, window_start) -> string[]|null` 提供（只读、只返回该行自己的证据 id，
即 daemon 自己写进去的派生物，不是原始遥测）。

它解决两件事：

1. **崩溃在"写入成功"与"删除 spool 行"之间**：重启后那条 spool 行还在，但它引用的 id 已经在行里
   ⇒ 贡献量为 0 ⇒ 整条按 `contributions_superseded` 丢弃，`count` 不变（不双计）；
2. 一个已知脏边的另一半（已被计入该行的观测被重新补记）在保留路径上被顺带堵住。

**启动核对**：还有一类行任何内存索引都不再指向它——失败重试必须保留旧行，
而后续批次又把同一批证据提交了，旧行就此成为孤儿。它会让 `pendingContributions` 永久非零、health 永久降级，
而证据其实已经全部被认领。所以 `createPipeline` 载入 spool 时做一次核对：
**若某行的每个 `event_id` 都已被它对应的告警行认领（且该行未被截断），它的贡献量为 0，直接删除并计入
`contributions_reconciled`**。行缺失、被截断、读失败一律按"还欠着"保留（fail-closed）。

行被 256 条上限截断时无法判定"是否已认领"，此时**不做该过滤**（保守，可能多计 1），
与既有边界一致，方向与文档一致地写进 §5。

### 3.4 丢弃必须显式降级（C 的伴随规则）

| 计数器 | 语义 | 出口 |
|---|---|---|
| `contributions_pending` | 队列条目数 | `/status.pipeline`、health 原因（既有） |
| `contributions_recovered` | 本次启动从 spool 恢复的条目数 | `/status.pipeline` |
| `contributions_reconciled` | 启动核对时因"证据已被全部认领"而清掉的孤儿行数 | `/status.pipeline` |
| `contributions_spool_errors` | 落盘/载入/删除失败次数 | `/status.pipeline` + **health 原因** `pipeline:contributions-spool-degraded` |
| `contributions_dropped` | **观测级**（不是条目级）丢弃数 | `/status.pipeline` + **health 原因** `pipeline:contributions-dropped` |

`contributions_dropped` 从条目级改为观测级：一个条目可携带多条告警贡献，按条目 +1 会低估损失。

## 4. 不变量（本 ADR 的验收口径）

**I1.** `truncated=false` ⇒ `count` 等于该 `(fingerprint, window)` 内**已入库**事件数（不多不少）。
**I2.** `event_ids` 里每个 id 都能在 `telemetry_event` 查到（无悬空）。
**I3.** I1/I2 在跨来源、重放、部分写失败、**进程重启**四种情形下都成立。
**I4.** 不允许用"事件可能不回来"掩盖容量丢弃：队列不按容量淘汰；唯一的丢弃路径是
"同来源 attach 预算耗尽"，且必须同时 `contributions_dropped` 增长 + health 降级 + 一条 error 日志。
**I5.** 落盘失败不得静默：`contributions_spool_errors > 0` 必须出现在 health 原因里。
**I6.** 落盘行的删除晚于提交：任何一次 T1 调用发生时，它承载的留存条目的 spool 行必须仍然存在
（顺序断言）；提交成功后必须消失，残留行由 §3.3 的幂等条件中和。
**I7.** 删除判据是**主键身份**：只有当替换副本的 `spool_id` 与旧行不同、且确实落盘时，旧行才可删
（同内容 UPSERT、落盘失败返内存条目这两条路径都不得触发删除）。
**I8.** 孤儿可自愈：重启时若某行的证据已被其告警行全部认领，必须清掉该行（`contributions_reconciled`），
不得让已认领的证据永久占位、永久降级。

## 5. 遗留与风险

- **spool 行本身没有容量上限**（这是刻意的）：规模由"未解决的写失败 × 不同窗口数"决定，写一直失败时
  `store_errors`、`sources:degraded`、`pending-contributions` 已经在降级。若将来要加上限，必须先有
  **不丢证据**的淘汰方案（本 ADR 之前的四代尝试都证明容量淘汰会丢可恢复证据）。
- **预算耗尽仍然是丢弃路径**：`MAX_CONTRIBUTION_ATTACH_ATTEMPTS = 8` 只在**同来源自己的批次**上推进，
  且每次推进意味着"该来源又投了一批，但里面没有这条证据、库里也没有"。此时事件要么已入库（会被核验到），
  要么来源真的不再投它（采集器丢失/代次变化）。方向是 fail-closed，且现在**可见**（I4）。
- **`alertEvidenceIds` 是新的读面**：只返回该告警行自己的 `event_ids`（daemon 写进去的派生 id），
  不返回事件内容、不返回时间戳；比 ADR-0006 §2.2 限制的"稳定键探测"更窄。
- **256 条上限 + 幂等过滤**：行被截断时无法判断某 id 是否已认领，可能多计 1（既有边界）。
- 未做：多进程/多写者下的 spool 一致性（`db.js` 的写锁已排除多写者）；四 OS 未验证。

## 6. 验收（可回归的断言）

1. `daemon_contribution_spool` 由迁移 v5 建立；`MIGRATIONS` 版本列表与 `CURRENT_SCHEMA_VERSION` 一致；
   旧库（v4）升级后表存在、原有行数不变。
2. spool 三接口：`put` 幂等（同内容 UPSERT 不增行）、`list` 返回解析后的条目、`delete` 幂等；
   非法载荷（非对象、缺字段、超长）→ `ERR_STORE_INPUT`，且不写入。
3. **重启恢复**：部分写成功（锚点失败）→ 关闭 → 重开同一库 → 重放 → `count == stored_in_window`，`problems=[]`。
4. **同来源 33+ / 99 条全失败**：`contributions_dropped=0`、重放后每窗口都有行、`count` 追平。
5. **跨来源**：A 的条目不被 B 排空；B 的批次不增加 `contributions_attach_attempts`/`dropped`。
6. **重放成功**：重放不得把同一次观测计两遍（含"写成功后 spool 删除失败"的残留行）。
7. **落盘失败可见**：注入 spool 写入异常 → `contributions_spool_errors > 0` 且 health 原因为 degraded，
   但本进程内的补记仍然成功（内存兜底）。
8. 预算耗尽 → `contributions_dropped` 按**观测条数**增长且 health 出现 `pipeline:contributions-dropped`。
9. **删除晚于提交**：在一次承载留存条目的 T1 调用发生的那一刻，该条目的 spool 行必须仍然存在；
   提交成功后该行消失；写失败时该行必须仍然存在（不得"先删后存"）。
10. `tests/wp1-event-store`（≥280）与 `tests/wp5-daemon`（≥286）**只增不减**；根 `npm test` / `npm run check` 双 `EXIT=0`。
