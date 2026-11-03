# 已实现能力（0.0.1 开发树）

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文只记录**代码与测试能证明**的能力。每项都标出证据等级；等级不足的不得在对外材料里升级表述。

- 作者：PT-dove
- 事实基准：2026-11-03 的源码树 + `docs/implementation/RELEASE_STATUS.md`（**R4 基线重签 / 16:30，现行口径 §9**；§0–§8 是第 3 轮的记录）。门禁实测时刻以 §9.3 的 16:13–16:24 为准
- 引段口径：§2 与 §9.3 的逐段值除第 11 段 `wp5-cli` 外完全相同；**第 11 段与总数一律引 §9.3**，其余段引 §2 不影响数值

---

## 0. 证据等级

| 等级 | 含义 |
|---|---|
| **A · 已实测** | 有原始日志或可复跑命令，结果固定且已记录 |
| **B · 单测/集成覆盖** | 有自动化测试，但运行在进程内或 mock 传输上，未与真实外部组件对接 |
| **C · 仅代码存在** | 能力在树内，但没有针对该能力的对接验证 |
| **D · 未验证** | 代码或设计存在，没有任何证据 |

> 同一能力可以同时有多级：例如「CLI 能查询」是 B，「CLI 对真实 daemon 查询」是 D。

---

## 1. 本地 daemon

**包**：`@aegisharness/daemon` · 入口 `apps/daemon/bin.js`

### 能做什么

| 能力 | 说明 |
|---|---|
| 调度采集 | 固定 tick 调度、单源超时、批量上限 500 事件、源陈旧判定 30s、最多 32 个源 |
| 处理管道 | 事件预过滤去重 → 规则求值 → 告警聚合 upsert → 写入事件存储；统计接收/接受/重复/拒绝/丢弃 |
| 告警落库 | 按 `(fingerprint, window_start)` 合并，合并时抬升 `last_seen` 与 `count` |
| 分析入队 | 检测侧给出的分析请求写入 `analysis_outbox`（**只写，不派发**） |
| 回环只读 API | `/healthz`、`/readyz`、`/api/v1/status`、`/api/v1/alerts`、`/api/v1/analysis` |
| 生命周期 | 显式 `start()` / `shutdown(signal)`；优雅期 5000ms、排空 2000ms；状态写入 `daemon-state.json` |
| 故障收敛 | 未配置即拒绝启动；`full` 模式缺规则包或缺采集源直接失败，不静默空跑 |

### 两种模式

| 模式 | 存储 | 采集源 | 用途 |
|---|---|---|---|
| `full` | 真实 SQLite | **必须由宿主注入** | 目标形态，但仓库自带入口不注入采集源 |
| `mock` | 内存 | 可空 | 开发/自测；不落盘、不采集 |

### 不能做什么

- 不能自己加载采集器：`apps/daemon/bin.js` 不注入任何 source，`full` 模式会因此拒绝启动。
- 不能派发分析任务到 Harness：没有调度器/桥接组件。
- 不能执行任何响应动作。
- 没有 UI、没有插件热加载、没有远程管理面。

### 证据

| 项 | 等级 | 依据 |
|---|---|---|
| 346 条 daemon 测试通过 | **A** | `npm run test:wp5-daemon`，RELEASE_STATUS §2 第 10 段（346/346，门禁下限 343、`maxSkip` 0） |
| 管道/聚合/生命周期行为 | **B** | 上述测试为进程内调用，采集源为脚本化 mock |
| 与真实 OS 采集器联跑 | **D** | 未运行 |

---

## 2. CLI

**包**：`@aegisharness/cli` · 命令名 `aegis-cli` · 入口 `apps/cli/bin.js`

### 能做什么

| 能力 | 说明 |
|---|---|
| `status` | 生命周期、健康、调度器与源、管道、存储计数 |
| `health` | 存活/就绪探针，**不需要 token** |
| `alerts` | 最近告警，按 `last_seen` 降序；`--limit`、`--cursor`、`--all`、`--max-pages` |
| `analysis` | 分析任务列表，同上翻页选项 |
| `analysis <id>` | 单任务详情；**v0 服务端不提供该路由**，因此当前必然失败（退出码 10） |
| 翻页 | keyset cursor：单页读 + `--cursor` 续页，或 `--all` 自动走（`--max-pages` 上限 100，默认 10） |
| `--json` | 单条 JSON 文档输出，成功失败同构，便于脚本消费 |
| 退出码契约 | 0/1/2/3/4/5/6/7/8/9/10/11/12/13，逐因区分 |

### 安全属性（实现层面）

- 只发 `GET`；路由是**闭集**（`apps/cli/src/routes.js`），不是 `/api/v1/*` 前缀放行。
- 不跟随重定向；不打印 token、不打印请求头。
- 只读自己的配置文件与 token 文件，**不读**事件库、数据库或其它文件。
- 输出是白名单投影：daemon 多返回的字段（包括 `csrf_token`）不会被带出，只报「存在」。

### 不能做什么

- 不能写任何状态：没有 `--force`、`--yes`，没有写动词。
- 翻页有硬边界：`--limit` 上限 100；`--all` 受 `--max-pages`（上限 100）约束，撞上限时
  以 `truncated: true` 停下并给出 `next_cursor`，不会无限读；cursor 只能原样转发，不能自己构造或解码。
- 没有全局安装包发布，只能从源码树以 `node apps/cli/bin.js` 调用。

### 证据

| 项 | 等级 | 依据 |
|---|---|---|
| 269 条测试（268 pass + 1 skip）通过 | **A** | `RELEASE_STATUS` §9.3 第 11 段；门禁下限由 R4 §9.2 从 239 抬到 **269**（`maxSkip` 仍 1）；skip 为 Windows 无符号链接权限 |
| 配置/退出码/投影/翻页正确性 | **B** | `tests/wp5-cli` 全部走进程内 mock loopback |
| 对真实 daemon 的端到端调用 | **D** | 仓库内无该用例；RELEASE_STATUS §4 明确记录 |

---

## 3. 检测与告警

**包**：`@aegisharness/detection`

### 能做什么

| 能力 | 说明 |
|---|---|
| 规则包加载与校验 | `schemaVersion: "1.0"`、必填 `packId`/`packVersion`、至少一条规则、未知键拒绝 |
| 三类规则 | `condition`（表达式）、`threshold`（计数 + 窗口 1000..3600000ms）、`correlation` |
| 确定性求值 | 同输入同输出；严重度支持静态或字段映射（`severityFrom`） |
| 指纹聚合 | 按规则声明的 `groupBy` 或字段集生成指纹，同指纹同窗口合并为一条告警 |
| 严重度迟滞 | 避免告警在相邻级别间抖动 |
| 证据引用 | 告警行保存事件 id 列表，超限截断并置 `event_ids_truncated` |
| 分析请求限流 | 每条告警的锚点最多一个分析请求，避免放大 |

### 不能做什么

- 不执行任何外部命令、不查外部情报、不做机器学习检测。
- 不提供内置生产规则包：仓库内**没有**随产品分发的规则包文件，规则包必须由使用方提供。
- 规则只在单元测试与合成事件上验证过，未用真实主机日志评估误报/漏报。

### 证据

| 项 | 等级 | 依据 |
|---|---|---|
| 175 条测试通过 | **A** | RELEASE_STATUS §2 第 3 段 |
| 真实日志下的检测效果 | **D** | 未运行 |

---

## 4. 事件存储

**包**：`@aegisharness/event-store`

### 能做什么

| 能力 | 说明 |
|---|---|
| 单写者 SQLite WAL | 只有 daemon 能开可写连接；读写分离 |
| 强类型表 | 全部 `STRICT` 表，避免 `'1'` 与 `1` 混入同一整数列 |
| 幂等写入 | 去重键、告警窗口键、预算序号、nonce、`execution_id + result_seq`、审计前驱摘要，全部由库内唯一约束保证 |
| 迁移 | 只增不改，每个版本带 `checksum`，抓到「偷改旧迁移」 |
| 保留与容量 | 清理顺序：低价值遥测 → 过期分析索引 → 已聚合低级别事件；高严重度告警不删 |
| 容量水位 | 80% 开始清理、90% 停止新分析与新响应并写 `capability_state` |
| 审计链 | `audit_event` 带哈希前驱链，保留扫描不删中间行 |
| 只读消费 | `openStore({ readOnly: true })` 供 API 查询，`PRAGMA query_only=1` |

### 表清单（`packages/event-store/src/schema.js`，共 22 张，逐张可查）

业务表：`telemetry_event`、`finding`、`alert`、`evidence`、`analysis_outbox`、`analysis_report`、
`model_request_ledger`、`response_proposal`、`approval`、`execution`(+ outbox/inbox/result)、
`recovery_manifest`、`data_gap`、`capability_state`。

搬迁与内部表：`schema_migration`、`sequence_counter`、`audit_event`、`audit_chain_head`、
`daemon_contribution_spool`、`meta`。

> 前四张（`schema_migration`、`sequence_counter`、`audit_chain_head`、`daemon_contribution_spool`）
> 与 `meta` 常被漏写；它们是真实的表，不是实现细节的同义词。

### 不能做什么

- 不支持多写者、不支持网络访问、不支持跨机复制。
- 没有已验证的备份/恢复演练（`recovery_manifest` 表存在，但恢复流程未做发布级验证）。
- 容量清理在真实大库上的行为未观测。

### 证据

| 项 | 等级 | 依据 |
|---|---|---|
| 290 条测试通过 | **A** | RELEASE_STATUS §2 第 8 段 |
| 真实主机长时间写入与水位触发 | **D** | 未运行（bench/soak 不在门禁内） |

---

## 5. 内置 Harness

**包**：`@aegisharness/harness-adapter`、`@aegisharness/harness-worker`、`plugins/dsh-defense-profile`、`plugins/dsh-defense-tools`

### 能做什么

| 能力 | 说明 |
|---|---|
| 固定 profile | `aegis-analysis`：显式插件清单，`dsh.profile.bundles: []`，不使用默认树 |
| 四层清单 | 包层（逐文件 SHA-256）、插件层（真实 loader 结果）、服务层（provider/inject 解析）、模型面（systemPrompt / 路由 / 工具 schema） |
| fail-closed 预检 | `preflightWorker()` 校验 argv、环境、cwd、profile 目录、工具目录与已批准哈希 |
| stdio 宿主 | 真实上游 stdio JSON-RPC：`initialize → session/wait → shutdown`，stdout 仅协议帧 |
| 工具面收敛 | 只暴露两个防御工具；参数开放会被校验拒绝 |
| 模型面收敛 | 锁定单一模型与 token 预算；上下文超限与传输未知**不自动重试、不做 compaction** |

### 不能做什么

- **daemon 不会启动它**：没有从 `analysis_outbox` 到 worker 的派发器。
- 它**不读写事件库**：`apps/harness-worker/bin.js` 只做预检并 `runCli()`。
- 没有真实生产凭据下的运行记录。
- 上游依赖是 alpha 版本（`@deepseek-ai/dsh@0.2.2-alpha.2`），升级策略未定。

### 证据

| 项 | 等级 | 依据 |
|---|---|---|
| 30 条 WP0 治理+Harness 测试通过 | **A** | RELEASE_STATUS §2 第 1 段 |
| 四层清单可重建、15 个变异反例 | **B** | `status/WP0-HARNESS.md` 记录；`tests/wp0/evidence/` |
| WP0 整体验收 | **未通过** | 该状态文件仍为 `blocked`：HAR-UPSTREAM-001（缺服务 provider）、HAR-UPSTREAM-002（cwd 运行时上下文泄漏）与许可门禁未闭合 |
| 端到端「告警 → 分析 → 报告落库」 | **D** | 该链路不存在 |

---

## 6. dry-run helper（响应计划器）

**包**：`@aegisharness/response-policy`（裁决）+ `@aegisharness/response-helper`（计划）

### 能做什么

| 能力 | 说明 |
|---|---|
| 策略裁决 | 封闭动作目录 × OS 矩阵 → `allow` / `needs_approval` / `deny`，纯确定性 |
| 四个方法 | `describe`（自述能力）、`prepare`、`dryRun`、`executeStub` |
| 独立复核 | helper 不复用策略结论之外的东西：自己核动作允许列表、授权重绑定、时间窗、nonce 单次、宿主 OS 家族、能力位、目标身份 |
| 漂移检测 | 快照目标状态，与期望状态比对，漂移则拒绝并给出原因码 |
| 封闭信封 | 未声明键即拒绝；信封内没有 command/argv/shell/path 字段 |
| 恒 dry-run | `EXECUTION_ENABLED = false`（编译期常量），`executeStub()` 恒返回 `dry_run_only` / `performed: false` |

### 不能做什么

- 不挂起/终止进程、不封禁连接、不隔离网络、不隔离文件。
- 不写审计、不改库存状态（由 daemon 侧负责，当前未接）。
- 不提供 IPC 通道：helper 是库接口，daemon 未与之通信。

### 证据

| 项 | 等级 | 依据 |
|---|---|---|
| policy 143 条 + helper 167 条通过 | **A** | RELEASE_STATUS §2 第 9、12 段 |
| 真实处置副作用 | **D** | 设计上不存在 |

---

## 7. 支撑件（不直接面向使用者，但影响可信度）

| 组件 | 能力 | 等级 / 依据 |
|---|---|---|
| `@aegisharness/contracts` | 封闭、带版本的数据契约；335 条测试 | A（§2 第 2 段） |
| `@aegisharness/plugin-manager` | 离线校验插件目录，绝不执行插件代码；156 条 | A（§2 第 4 段） |
| `@aegisharness/model-broker` | 唯一模型出口：准入、预算、脱敏、固定端点、不重试；74 条（73 pass + 1 skip） | A（§2 第 13 段）；真实凭据 D |
| `collectors/common` + `linux` + `windows` | 采集器身份/游标/去重/背压/缺口；95 + 158 + 184 条 | A（§2 第 5–7 段）；真实主机 D |
| `deploy/embedded-runtime` | 自包含目录 PoC + 裁剪打包；packaging 六文件 **35/35**（§9.5 实跑）；第 2 轮记录是 31/31 | A（§9.5）；**不是安装包** |
| `tests/security-corpus` | 420 条安全语料，`MINIMUM_TESTS=420` 只升不降 | A（§2 第 14 段） |

---

## 8. 复跑方式（真实命令）

在仓库根执行，Node 需为 `v24.20.0`、npm `11.19.0`：

```bash
npm test                # 14 段，2 842 条（2 840 pass / 2 skip / 0 fail）
npm run check           # test + sbom:check + license:check
```

打包自检**不在** `npm test` 内，也不被任何门禁引用，需单独进目录跑：

```bash
cd tests/packaging
node --test --test-reporter=spec bundle.test.js manifests.test.js prune.test.js report.test.js prompt.test.js portability.test.js
```

> 当前目录下正好这 6 个用例文件（`portability.test.js` 是后加的）；`RELEASE_STATUS` §9.5 记的 35/35
> 就是用这六个文件跑出来的。若目录里再出现新的 `*.test.js`，上面这行就不再等于全量。

单包复跑示例：

```bash
npm run test:wp5-daemon
npm run test:wp5-cli
npm run test:wp7-response-helper
```

> 未运行的项必须写「未运行」。上面命令跑通不等于安装、签名、四 OS 或真实响应已验证。
