# AIDriven NetDefense / 网域智防 — 产品文档

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文对应开发树版本 `0.0.0`（路径 `D:\AIUSE\网络防御`），记录 **2026-11-03** 的真实状态。
> 0.0.1 尚未冻结：安装器、代码签名、四 OS 验证、真实响应执行均未完成。
> 本文随实现变化，不构成发布承诺、兼容性承诺、安装承诺或支持承诺。

- 产品名：AIDriven NetDefense（中文名：网域智防）
- 内部技术代号：AegisHarness（仅用于现有代码 scope 与历史文档，不作为对外名称）
- 文档作者：PT-dove
- 事实基准：源码树、`docs/implementation/` 下的契约与状态、`docs/implementation/evidence/` 下的原始日志

---

## 1. 一句话定位

AIDriven NetDefense 是**本地优先的 Windows/Linux 单机安全监测与辅助响应系统**：
采集与检测在本地确定性执行，告警与证据留在本机，模型只用于告警后的受控分析，处置动作默认不动手。

当前交付形态是**源码树 + 本地可跑组件**，不是可安装产品。

---

## 2. 文档地图

| 文档 | 内容 | 读者 |
|---|---|---|
| [01-overview.md](./01-overview.md) | 产品概览、设计原则、组件构成、0.0.1 范围 | 所有人 |
| [02-security-boundary.md](./02-security-boundary.md) | 信任边界、准入链、数据落地、明确不保证的安全属性 | 安全评审、运维 |
| [03-capabilities.md](./03-capabilities.md) | 当前**已实现**能力及各自的证据等级 | 研发、测试 |
| [04-gaps.md](./04-gaps.md) | **未实现 / 未验证** 清单，以及禁止使用的表述 | 研发、发布 |
| [05-cli.md](./05-cli.md) | `aegis-cli` 的真实命令、选项、配置、退出码 | 使用者 |
| [06-api.md](./06-api.md) | 只读查询 API v0 的真实端点、参数、字段、错误码 | 集成方 |
| [07-deployment.md](./07-deployment.md) | 部署前置条件、开发态运行方式、已知限制 | 运维 |

阅读顺序建议：01 → 02 → 03 → 04，需要动手时再看 05/06/07。

---

## 3. 当前状态摘要（一句话一条）

依据统一取 `docs/implementation/RELEASE_STATUS.md` **R4 基线重签（2026-11-03T16:30，现行口径在 §9）**；
`§0`–`§8` 是上一版（第 3 轮，15:04 生成 / 15:24 修订）的记录，引用时看章节号即可区分。

| 结论 | 内容 | 依据 |
|---|---|---|
| 版本 | 开发树 `0.0.0`；0.0.1 未冻结、未发布 | 根 `package.json`、`PRODUCT.md` |
| 代码 | daemon / CLI / 检测 / 事件存储 / Harness / dry-run helper 均在树内 | `apps/`、`packages/` |
| 本地门禁 | `npm test` **2 842** 条（2 840 pass / 2 skip / 0 fail）、`npm run check` EXIT=0 | `RELEASE_STATUS.md` §9.3（R4 于 16:13–16:24 重跑）；§2 的 2 837 是第 3 轮 14:46 那次，差异全在第 11 段并发写入 |
| 安全语料 | `tests/security-corpus` **420/420**，exit 0 | 同上 §9.3 / §9.5 |
| 打包自检 | `tests/packaging` 六文件 **35/35**，EXIT=0（第 2 轮记录的 31/31 已过时）；该段**不被任何门禁引用** | 同上 §9.5 |
| 独立审查 | **已成立**：3 个 P1 全部 CLOSED，`reviews/release-evidence-closure.md` §12 与第二路交叉验证均为 **0×P0 / 0×P1** | 同上 §0、§3、§8.1 |
| 跨平台 | 仅 **win32-x64** 实测；Linux / macOS / win32-arm64 无实跑 | 同上 §4 第 1 项 |
| 可安装性 | **无**安装器、无签名、无升级通道 | `deploy/windows/`、`deploy/systemd/` 为空目录；同上 §4 第 1–3 项 |
| 真实处置 | **无**。`EXECUTION_ENABLED = false`，执行方法恒返回 `dry_run_only` | `apps/response-helper/src/build.js`；同上 §4 第 4 项 |
| 本地候选 | **`LOCAL_CANDIDATE_GO`**（口径：win32-x64、本地开发内测）——不是签收，也不是可发布 | 同上 §9.7 |
| 正式发布 | **`NO_GO`**：四 OS、签名、安装器/升级/回滚、真实响应、生产密钥、真实 OS 采集**六类一项未闭合** | 同上 §4、§9.7 |

> 本地候选转 GO 带着两条必须同读的附注：① `tests/wp1-event-store/crash.test.js` 有一次概率性
> `EXIT=1`（`ERR_STORE_LOCKED`，pid 存活判定竞态，单跑 5/5 绿），不能写成「门禁恒绿」；
> ② 「认证限流放大」只在功能语义上证伪，**未做性能复证**。两条都在 `RELEASE_STATUS.md` §2.1 / §4。
>
> 还有一处**不能照抄**：`RELEASE_STATUS.md` §9 与 §9.8 把 `reviews/release-r4-audit.md` 列为「新建」
> 并计入写入清单，但 2026-11-03 16:33 实测**该文件不存在**（`reviews/` 下无 r4 文件，`status/MASTER-RELEASE-R4.md`
> 自己写的是「待独立只读复核」）。因此本文**不**宣称第 4 轮独立复核已成立；上面「独立审查」一行指的仍是
> 第 3 轮那三份**确实存在**的报告。

---

## 4. 术语

| 术语 | 含义 |
|---|---|
| daemon | 常驻本地进程，负责调度采集、跑检测、写告警、提供回环只读 API |
| pipeline | daemon 内的批处理链路：事件去重 → 检测 → 告警聚合 → 入存储 |
| event store | SQLite（WAL）单写者存储，表结构见 `packages/event-store/src/schema.js` |
| Harness | 告警后的分析运行时（profile + 工具 + 模型面），独立进程，不在 daemon 内 |
| response-policy | 确定性策略闸门：动作目录 × OS 矩阵 → allow / needs_approval / deny |
| response-helper | 把策略裁决变成**计划**的窄接口；本构建只到 dry-run |
| bundle | `deploy/embedded-runtime` 产出的自包含目录，开发验证物，**不是安装包** |
| 门禁 | 根 `npm test` / `npm run check` / SBOM / 许可检查等自动化关卡 |

---

## 5. 本文档的写作约束

这些约束对后续维护者同样有效：

1. **只写能核实的东西**。命令、端点、配置键、退出码必须能在源码中找到；测试数字必须来自日志或可复跑命令。
2. **区分四种状态**：已实测通过 / 仅单测覆盖 / 仅代码存在 / 未验证。不得合并表述。
3. **不写**安装步骤、下载链接、发布链接、截图、性能数字、支持矩阵——这些在 0.0.1 冻结前都不存在。
4. **不写**「可发布」「跨平台可用」「响应处置已就绪」「许可已合规」。
5. 任何能力变化必须同时更新 [03-capabilities.md](./03-capabilities.md) 与 [04-gaps.md](./04-gaps.md)，只改一处视为文档缺陷。

---

## 6. 相关但没有搬进本文档的材料

| 材料 | 位置 | 说明 |
|---|---|---|
| 只读 API 契约（权威） | `docs/implementation/M7_API_CONTRACT.md` | 06 章以其为准，冲突时以契约为准 |
| 发布状态清单 | `docs/implementation/RELEASE_STATUS.md` | 门禁计数、未验证项、证据索引的权威来源 |
| Agent 工作规则 | `AGENTS.md` | 提交、状态文件、审查隔离的规则 |
| 设计与验收 | `docs/design/` | 设计意图，非当前实现证明 |
| 嵌入运行时打包说明 | `deploy/embedded-runtime/README.md` | bundle 结构与构建方式（PoC 级） |
| 发布链规格 | `docs/implementation/release/`、`docs/implementation/adr/ADR-0009-release-distribution.md` | 安装/签名/升级/数据保留的**规格**。每份文件自述「规格（未实现）」「全部未执行」，**有规格不等于有能力** |
