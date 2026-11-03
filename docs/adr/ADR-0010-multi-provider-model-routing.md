# ADR-0010：多 provider 模型路由与「小模型常态 / 大模型应急」分级

- 状态：**Accepted（2026-11-04）**。
  本 ADR 定方案与判据，实现另立任务；实现不得超出本文范围。
- 作者：PT-dove
- 关联：
  - `apps/model-broker/src/endpoint.js`（现行「单一固定 HTTPS 端点」不变量）
  - `apps/model-broker/src/policy.js`（`BROKER_LIMITS`、`CIRCUIT_POLICY`）
  - `docs/design/SOFTWARE_DESIGN.md` §8.2 / §9.1 / T2 预算
  - `docs/adr/ADR-0004-harness-llm-api-extensions-provider.md`
  - `docs/product/08-model-routing.md`（产品侧说明）
- 影响范围：`apps/model-broker`、`apps/daemon`（策略下发）、`apps/console`（设置页）、
  `packages/policy`（预算与分级判据）。**本阶段不改任何代码。**

---

## 1. 问题

现行实现与文档把「只能连一个固定 HTTPS 端点」当作安全不变量（`endpoint.js` 文件头、AT-DATA-004）：
它挡住了 SSRF、挡住了把 Bearer 凭据发到任意主机、挡住了「每次请求换一个上游」的合法外衣。

但产品需要相反的形态：

1. 用户要能填**多个** provider（默认 DeepSeek 官方 `https://api.deepseek.com`），
   也要能填本地部署的小模型（Ollama / llama.cpp，回环地址）。
2. 用户要按**能力分级**选模型：常态用便宜/本地的小模型盯守，命中攻击时升级到强模型快速判断与拦截。
3. 用户要能看见**每个 provider 花了多少**，并且能设上限。

这三条与「单固定端点」直接冲突。**不能靠放宽 `endpoint.js` 的校验糊过去**——
那会把一条明确的安全边界改成「URL 看起来合理就行」，属于把不变量降级成注释。

因此本 ADR 的做法是：**保留 brand + 解析期冻结的机制，把「唯一」换成「登记在册的有限集合」**。

---

## 2. 决策

### 2.1 Provider Registry（有限集合，不是自由 URL）

新增本地配置 `providers[]`，每项在**保存时**完成解析与冻结，运行时只接受 brand 对象：

| 字段 | 说明 | 约束 |
|---|---|---|
| `id` | 本地唯一标识，如 `deepseek`、`ollama-local` | `[a-z0-9-]{2,32}`，不可改名（改名视为新增） |
| `kind` | `openai-compatible` \| `deepseek` \| `ollama` | 决定请求/响应适配器 |
| `baseUrl` | 如 `https://api.deepseek.com/v1`、`http://127.0.0.1:11434/v1` | 见 2.2 |
| `credentialRef` | 指向本地凭据槽，不存明文 | 见 2.3 |
| `allowLoopback` | 是否允许回环地址 | 仅 `ollama` 与显式自建服务可置 true |
| `dailyInputTokens` / `dailyOutputTokens` | 该 provider 的日预算 | 缺省继承全局 |

**登记上限 8 个 provider**：超过就不是「个人安防软件」而是网关，属于另一个产品。

### 2.2 URL 规则（比现在宽，但仍是白名单）

- 只允许 `https:`；`http:` 仅当主机是回环（`127.0.0.0/8`、`::1`、`localhost`）且 `allowLoopback=true`。
- 仍拒绝 `userinfo`、`query`、`hash`；仍**不跟随重定向**（3xx 直接失败，不降级重试）。
- `baseUrl` 在保存时解析为 `{scheme, host, port, pathPrefix}` 并冻结，运行时不得由请求参数覆盖。
- 明确禁止：`file:`、`data:`、`ftp:`、UNC 路径、Unix socket 以外的任何 scheme。
- 代理：沿用现行「忽略 `HTTP(S)_PROXY`」的行为，避免把内网请求塞进代理（本机已有该坑）。

### 2.3 凭据

- 每个 provider 一个独立凭据槽；**跨 provider 复用凭据必须显式确认**（默认禁止）。
- 凭据只进 keyring/DPAPI 保护的文件，不进日志、不进 URL、不进错误消息、不进 console 的 DOM。
- console 只显示指纹（`sha256(secret)[:8]`），不提供「查看明文」。

### 2.4 模型分级（tier）

| tier | 典型 | 用途 | 约束 |
|---|---|---|---|
| `watch` | 本地 2B–7B / 最便宜的 API 小模型 | 常态盯守、告警归并、低危判定 | 单次输入 ≤ 4k tokens；**不得**直接产生响应动作 |
| `triage` | 中等模型 | 复核 watch 的结论、生成证据摘要 | 单次 ≤ 8k；可建议动作，需人工确认 |
| `respond` | 强模型（如 DeepSeek 旗舰） | 攻击确认、拦截决策、生成处置方案 | 单次 ≤ 12k；每次调用必须有 evidence bundle |

**默认路由 = `watch`。** 没有任何配置时，系统只跑 watch，不产生任何高成本请求。

### 2.4.1 分级开关（用户可关闭）

分级是**可选策略**，不是产品唯一形态。配置项 `routing.mode`：

| 取值 | 行为 | 成本 | 防御特性 |
|---|---|---|---|
| `tiered`（默认） | 常态 `watch`，满足 2.5 判据才升级 | 低 | 依赖小模型不漏判；漏判则不会升级 |
| `uniform` | **所有**分析都用 `routing.uniformModelId` 指定的单一模型，不做升级判断 | 高（按全量计） | 判据始终由同一模型给出，不依赖"先小后大"的两段式 |

规则：

1. `uniform` 必须显式给出 `uniformModelId`，且该模型必须存在于 `models[]`；缺失即拒绝保存（不静默回落到 `tiered`）。
2. 切到 `uniform` 时，`watch`/`triage` 的配置**保留但不生效**，切回 `tiered` 后立即恢复，不需要重填。
3. 切换必须记入本地审计日志：时间、操作者、旧值、新值。Agent 无权修改该开关（沿用「预算与配置只能由本地管理员修改」）。
4. 关闭分级时，界面必须同时显示两句话，不允许只显示其中一句：
   - 「将按全量请求计费，费用会明显上升」；
   - 「不再按级别递进，防御能力完全取决于所选模型」。
5. `uniform` 模式下仍然受 2.6 的预算上限约束（单分析 3 请求 / 12k / 2k、日预算），
   即"关掉分级"不等于"关掉预算"；预算耗尽仍 fail-closed。
6. `uniform` 模式下不产生 `escalatedFrom` 字段；用量页按单一 tier 聚合，避免把两套口径混在一张图上。

**不做的两件事**：不做「按告警等级自动在两种模式间切换」（会让成本与行为都不可预测）；
不做「每人一套模式」（本产品是单机单用户）。

### 2.5 升级（escalation）判据

从 `watch` 升到 `triage`/`respond` 必须**同时**满足：

1. 检测层给出 `severity >= high` 或命中 `critical` 规则；
2. `watch` 级已产出结构化结论（不是原始日志），并附带 `evidenceRef`；
3. 同一 `fingerprint` 在冷却期内未升级过（默认 5 分钟）；
4. 当小时升级次数未超上限（默认 20 次/小时，可配）；
5. 目标 provider 的日预算仍有余额。

**不允许的升级方式**（写进判据，实现时作为反例）：

- 因为「模型自己觉得不确定」就升级 —— 那会让成本不可控；
- 把原始事件全量塞给大模型 —— 升级请求只能带 `triage` 产出的摘要 + evidenceRef；
- 升级失败后自动换下一个更强 provider 重试 —— 一次分析只允许一次升级；
- 静默降级 —— 大模型不可用时必须在 UI 显示 `degraded`，并回落到 watch 继续盯守。

### 2.6 省钱的具体机制（与既有 T2 预算合并）

| 机制 | 数值/规则 | 来源 |
|---|---|---|
| 单分析请求数 | ≤ 3（含升级那一次） | 现行 `maxRequestsPerAnalysis` |
| 单分析 token | 12k 输入 / 2k 输出 | 设计 §9.1 |
| UTC 日预算 | 30k 输入 / 6k 输出（全局），另加 per-provider 上限 | 设计 §9.1 + 本 ADR |
| 并发 | 2 个分析；同一分析 1 个在途请求 | 现行 `BROKER_LIMITS` |
| 告警聚合 | 15 分钟窗口，同指纹不重复请求 | 设计 §5 |
| 升级冷却 | 5 分钟/指纹；20 次/小时 | 本 ADR |
| 结果复用 | 同 `fingerprint + rulesVersion` 命中缓存直接返回，不请求 | 本 ADR（新增） |
| 本地模型 | 回环调用不计费，但仍计入请求数与并发 | 本 ADR |

**预算不足时的行为**：拒绝新请求（fail-closed），不降级到"免费模型偷偷跑"，
也不把 reserved 当成已花。沿用 T2 的「reserved/sent/unknown 上界求和」口径。

### 2.7 可观测

每次请求记录：`providerId`、`modelId`、`tier`、`inputTokens`、`outputTokens`、
`escalatedFrom`（若有）、`fingerprint`、`decision`。
console 的「用量」页按 provider/tier 聚合，能回答「这周省了多少、升级了几次、哪次最贵」。

---

## 3. 与现行不变量的关系（必须显式承认）

| 现行 | 本 ADR 之后 |
|---|---|
| 只能连**一个**固定 HTTPS 端点 | 只能连**登记在册的 ≤8 个**端点，每个在保存时冻结 |
| 运行时不接受调用方传入的 URL | 不变（仍只接受 brand 对象） |
| 不跟随重定向 | 不变 |
| 无代理 | 不变 |
| 凭据单槽 | 每 provider 一槽，跨槽复用需显式确认 |

`endpoint.js` 的 brand 机制**保留**，只是从「单例」扩展为「注册表」。

### 3.1 AT-DATA-004 判据改写

**授权状态**：本 ADR 获维护者批准，改写自批准时刻生效。
实现者必须**同时**改判据与代码，不得只改 `endpoint.js` 而把 `TEST_AND_ACCEPTANCE.md` 留在旧口径。

判据原文（旧）：请求目标必须是**唯一固定**的 HTTPS 端点。
替换为：

> AT-DATA-004（v2）：broker 发出的每个模型请求，其目标 `{scheme, host, port, pathPrefix}`
> 必须**逐字段等于**本地 Provider Registry 中某个已冻结端点；注册表最多 8 项；
> 请求期不得由调用方传入或覆盖任何 URL 组成部分；不得跟随 3xx；不得读取 `HTTP(S)_PROXY`；
> 非回环目标必须是 `https`；`userinfo`/`query`/`hash` 一律拒绝。

同时必须新增三条阴性用例（缺一不可）：

1. 注销某个 provider 后，指向它的请求立即失败（不能靠缓存继续用）。
2. 把注册表中某端点的 host 改一个字符，旧 brand 对象失效（证明 brand 绑定的是冻结结果，不是形状）。
3. 构造一个形状与 brand 对象完全相同的普通对象传入，必须被拒绝（沿用现有 `isResolvedEndpoint` 的 WeakSet 语义）。

---

## 4. 验收判据（可执行，实现后逐条验）

1. 保存 `https://api.deepseek.com/v1` 成功；保存 `http://api.deepseek.com/v1` 失败（非回环 + http）。
2. 保存 `http://127.0.0.1:11434/v1` 且 `allowLoopback=true` 成功；`allowLoopback=false` 失败。
3. 保存 `https://user:pass@host/v1`、`https://host/v1?x=1`、`https://host/v1#a` 全部失败。
4. 端点返回 302 到另一主机时，请求失败且**不**发出第二次请求（抓包/桩验证）。
5. 无配置时只发 `watch` 请求；构造 `severity=low` 的告警，`respond` 请求数为 **0**。
6. 构造 `severity=critical` + `evidenceRef`，升级请求恰好 **1 次**，且 payload 中不含原始事件全文。
7. 同一 fingerprint 5 分钟内第二次触发，升级请求数为 **0**（冷却生效）。
8. 把 respond provider 的 baseUrl 改成不可达地址，系统在 UI 显示 `degraded`，watch 仍在跑。
9. 日预算耗尽后，新请求被拒且错误码可区分（预算 vs 网络 vs 鉴权）。
10. 用量页显示的 token 数与 broker 日志逐条求和一致（允许 ±0）。
11. `mode=uniform` 时，**任意** severity 的告警都产生 1 次请求，且请求的 `modelId` 等于 `uniformModelId`、
    记录中无 `escalatedFrom`。
12. `mode=uniform` 且 `uniformModelId` 为空/不存在时，保存被拒绝；运行态不得自动回落成 `tiered`。
13. 从 `uniform` 切回 `tiered` 后，不需要重填 watch/triage 配置即可恢复分级；
    切换前后各一条审计记录，字段含时间、操作者、旧值、新值。
14. `mode=uniform` 下预算耗尽仍然拒绝请求（证明"关分级 ≠ 关预算"）。

---

## 5. 风险与未决

| # | 风险 | 处理 |
|---|---|---|
| R1 | 多端点放大数据外带面 | 端点白名单 + 每端点预算 + 升级 payload 只带摘要；仍需一次独立安全评审 |
| R2 | 本地模型被误配成 LAN 地址 | 默认只允许回环；LAN 地址需二次确认并记审计 |
| R3 | 升级判据被检测层噪声打穿 | 冷却 + 小时上限 + 只认结构化结论；先用真实告警回放校准 |
| R4 | 成本可见性与 provider 账单不一致 | 明确声明「本地预算是准入上限，不冒充账单上限」（沿用设计原文） |
| R5 | 8 个 provider 的上限是否够用 | 未决；先按 8 做，超过再评估是否升为网关型产品 |

## 6. 实施顺序（2026-11-04）

1. `packages/policy`：tier 与 escalation 判据（纯函数，可单测）。
2. `apps/model-broker`：Provider Registry + brand 注册表 + 每端点预算端口。
3. `apps/daemon`：策略下发与 `degraded` 状态。
4. `apps/console`：provider 管理、模型分级、用量页。
5. 端到端：用回放告警跑一遍「低危不升级 / 高危升级一次 / 冷却生效」。

**未批准前不得开始实现**；尤其不得先改 `endpoint.js` 再补文档。
