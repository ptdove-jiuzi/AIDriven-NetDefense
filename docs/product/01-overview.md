# 产品概览

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文对应开发树 `0.0.0`，记录 2026-11-03 的真实状态；0.0.1 未冻结，本文不构成发布承诺。

- 产品名：AIDriven NetDefense / 网域智防
- 内部代号：AegisHarness（仅代码 scope）
- 作者：PT-dove

---

## 1. 它要解决的问题

单机（工作站、服务器、实验机）上的安全监测通常落在两个极端：

- 要么装一个只会转发日志的采集器，检测逻辑在远端，本机没有判断力；
- 要么装一个「智能体」把原始日志和命令执行一起交出去，本机失去控制权。

AIDriven NetDefense 的取法是：

1. **本机自己判断**。采集、检测、聚合、存储、查询全部在本地完成，不依赖模型，不依赖外网。
2. **模型只在需要解释时介入**。只有当某个告警值得分析时，才把**受控摘要**交给分析运行时；原始证据不出本机。
3. **默认不动手**。系统给出告警和处置建议，真实处置需要人工批准，且本构建只到「计划」为止。

---

## 2. 三条设计原则

| 原则 | 具体含义 | 在代码中的落点 |
|---|---|---|
| 确定性优先 | 告警的产生不依赖模型输出；同一输入必得同一结果 | `packages/detection` 的声明式规则与指纹聚合 |
| 本地优先 | 唯一网络面是回环 HTTP；数据写在本机数据目录；模型出口只有一个受控组件 | `apps/daemon/src/api/server.js`、`apps/model-broker` |
| 人在环 | 高危动作先过策略闸门，再过人工批准，最后才可能执行 | `packages/response-policy`、`apps/response-helper` |

> 原则不等于已交付能力。第二、三条的**执行侧**目前没有真实动作；第三条的**审批侧**只有数据模型
> 与策略层，**没有 HTTP 端点、也没有 daemon 接线**（路由闭集里没有任何审批或响应路由，见
> [04-gaps.md](./04-gaps.md) §3）。不要把「原则里有批准」读成「系统里能点批准」。

---

## 3. 组件构成（真实包名）

### 3.1 核心链路

| 组件 | 包名 | 职责 | 当前状态 |
|---|---|---|---|
| 数据契约 | `@aegisharness/contracts` | 封闭、带版本的事件/告警/分析/响应数据结构 | 在树，335 条单测通过 |
| 采集器（通用） | `@aegisharness/collector-common` | 采集器身份、游标、去重、背压、缺口、能力声明 | 在树，95 条通过 |
| 采集器（Linux） | `@aegisharness/collector-linux` | Linux 侧采集适配 | 在树，158 条通过；**未在真实主机持续采集** |
| 采集器（Windows） | `@aegisharness/collector-windows` | Windows 侧采集适配（含 PowerShell 源） | 在树，184 条通过；**未在真实主机持续采集** |
| 检测引擎 | `@aegisharness/detection` | 规则编译与求值、指纹聚合、严重度迟滞、分析请求限流 | 在树，175 条通过 |
| 事件存储 | `@aegisharness/event-store` | SQLite WAL 单写者事务存储（T1–T5）、保留与容量水位、审计链 | 在树，290 条通过 |
| daemon | `@aegisharness/daemon` | 调度、管道、告警落库、回环只读 API、生命周期 | 在树，346 条通过（门禁下限 343）；M5 P1 族经根因重构后第 13 轮独立复核 GO（`status/MASTER-M5-REDESIGN.md`） |
| CLI | `@aegisharness/cli` | 回环只读客户端：`status` / `health` / `alerts` / `analysis`，支持 keyset 翻页 | 在树，269 条（268 pass + 1 skip）通过；**未与真实 daemon 端到端对接** |
| 插件管理器 | `@aegisharness/plugin-manager` | 离线校验解包后的插件目录，只读，绝不执行插件代码 | 在树，156 条通过 |
| 模型出口 | `@aegisharness/model-broker` | 唯一模型出口：准入、预算预留、脱敏、固定端点、不重试 | 在树，74 条（73 pass + 1 skip）通过；**未接真实生产凭据** |
| 响应策略 | `@aegisharness/response-policy` | 动作目录 × OS 矩阵 → `allow` / `needs_approval` / `deny` | 在树，143 条通过 |
| 响应助手 | `@aegisharness/response-helper` | 把裁决变成计划，做目标绑定与漂移检测 | 在树，167 条通过；**本构建 dry-run only** |
| Harness 适配 | `@aegisharness/harness-adapter` | 四层清单生成、fail-closed 校验、stdio 宿主 | 在树，随 WP0 套件验证 |
| Harness 启动器 | `@aegisharness/harness-worker` | 以固定 profile 启动分析运行时 | 在树；**daemon 主链路未调用它** |

### 3.2 空目录（明确不存在的东西）

以下目录存在但**为空**，不要从目录名推断能力：

- `apps/console/` —— 没有图形控制台
- `apps/sandbox-launcher/` —— 没有沙箱启动器
- `packages/ipc/`、`packages/policy/`、`packages/response/` —— 没有 IPC 通道、没有独立策略包、没有响应执行包（真的策略在 `packages/response-policy`，计划器在 `apps/response-helper`）
- `deploy/windows/`、`deploy/systemd/` —— 没有服务单元、没有安装器

---

## 4. 数据流（当前真实形态）

```text
[采集源]  →  scheduler（daemon 内）
              ↓  批量事件
         pipeline：去重 → 检测规则求值 → 指纹聚合 → 告警 upsert
              ↓
         event-store（SQLite WAL，单写者）
              ↓                         ↘
   只读查询 API（回环）             analysis_outbox（分析请求行）
              ↓                         ↛  （下游未接线）
         aegis-cli                 harness-worker（独立进程，需 DSH_HOME）
                                        ↓
                                   model-broker（唯一模型出口）
```

两处断点必须写清楚：

1. **采集源未随程序分发**。`apps/daemon/bin.js` 不注入任何采集器；`full` 模式下 `createDaemon` 会在没有采集源时拒绝启动。真实采集需要宿主程序注入采集源（`apps/daemon/src/daemon.js`）。
2. **分析链路两端未连接**。daemon 只把分析请求写入 `analysis_outbox`；`harness-worker` 是独立启动器，只做 profile 预检并拉起分析运行时，不读写事件库。中间没有已交付的调度/桥接组件。

---

## 5. 0.0.1 的范围

以 `PRODUCT.md` 为准：

**在范围内**：Windows/Linux 单机代理、本地 daemon/CLI/本地控制面、检测告警证据审计、事件存储与恢复、受控模型分析与人工审批、内置 Harness、安装卸载升级回滚、四 OS 验证、长稳与发布材料。

**明确不在 0.0.1**：

| 项 | 原因 |
|---|---|
| MCP 控制面 | 已暂缓，不在本版本 |
| Gateway Edition | 尚未立项，不属于单机代理范围 |
| 未经验证的真实自动响应 | 执行侧未实现 |
| 公有云托管服务 | 与本地优先定位冲突 |

---

## 6. 当前阶段定性

| 维度 | 结论 |
|---|---|
| 代码完整度 | 核心链路组件均在树，单测与安全语料覆盖较厚 |
| 本地可跑 | daemon（`mock` 模式）/ CLI / 各包 API 可在开发环境调用 |
| 可交付形态 | 仅源码树与开发验证 bundle；**无安装包** |
| 本地候选 | **`LOCAL_CANDIDATE_GO`**（win32-x64、本地开发内测）：3 个 P1 已关闭 + 双门禁 EXIT=0 + 语料 420/420，独立只读复核 0×P0/0×P1 |
| 可用于生产 | **否**。正式发布仍是 `NO_GO`，原因见 [04-gaps.md](./04-gaps.md) 六类未闭合缺口 |
| 建议表述 | 见 [04-gaps.md](./04-gaps.md) §6（与 `RELEASE_STATUS.md` §6 逐字一致，不得改写强度） |

---

## 7. 与历史命名的关系

`@aegisharness/*` 是既有 npm scope，也是当前所有包名与命令名（`aegis-cli`、`aegis-daemon`）的来源。
发布冻结期间不做批量改名；若正式版需要统一为 `AIDriven NetDefense`，另开一次独立迁移并重建基线。
在此之前，**对外文档可以写产品名，但命令与包名仍是 `aegis-*`**，两者不是同一层概念。
