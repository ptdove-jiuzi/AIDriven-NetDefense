# 未实现与未验证

> **版本状态：0.0.1 未发布，不可作为正式版本分发。**
>
> 本文是 0.0.1 的**缺口清单**。它的作用不是免责，而是让评审者一眼看出：
> 哪些东西不存在，哪些东西存在但没有证据。

- 作者：PT-dove
- 事实基准：`docs/implementation/RELEASE_STATUS.md`（**R4 基线重签 / 16:30，现行口径 §9**；§0–§8 为第 3 轮记录）的 §9.7 结论、§4 正式发布 blocker、§5 登记；源码树空目录；各包 `package.json`

> **两个层级不要混读**：本地发布候选已是 **`LOCAL_CANDIDATE_GO`**（口径：win32-x64、本地开发内测；
> 3 个 P1 关闭、`npm test` / `npm run check` 双 EXIT=0、语料 420/420、独立只读复核 0×P0/0×P1）；
> **正式发布仍是 `NO_GO`**。本文第 1 节列的六类缺口，卡的是后者，不是前者。
> 反过来也一样：不要因为本地候选 GO，就把任何一条缺口写成「已闭合」。

---

## 0. 两种缺口的区别

| 类型 | 含义 | 处理方式 |
|---|---|---|
| **未实现** | 功能不存在，跑不起来 | 需要开发，不是补证据 |
| **未验证** | 代码存在，但没有真实环境/端到端证据 | 需要实验与取证，可能需要修 bug |

把「未验证」写成「未实现」会低估工作量；把「未实现」写成「未验证」会高估成熟度。两者都不能写成「完成」。

### 0.1 事实订正（2026-11-05，仅订正与磁盘冲突的条目）

本文主体成文于 2026-11-03，**早于 rc.1–rc.5 的打包与安装链落地**。下表是逐项对磁盘复核过的订正；
**未列出的条目未被复核**，引用前请自行核对。订正只把与实物冲突的句子改准，不放宽任何缺口判定。

| 位置 | 原文断言 | 2026-11-05 实测 | 证据 |
|---|---|---|---|
| §1 第 1 行 | 安装器「未实现」，`deploy/windows/` 为空目录 | **部分实现**（正文该行已改） | `deploy/windows/installer/**`、`dist/release/0.0.1-rc.5/` |
| §1 第 2 行 | 无代码签名 | **仍成立**：`*.pfx/*.p12/*.cer/*.sig/*.cat` 在 apps/packages/deploy/scripts/dist/release/docs/tests/plugins 下计数 **0**；`Get-AuthenticodeSignature` 对 rc.5 Setup.exe 返回 `NotSigned` | 本会话复算，见 `docs/implementation/status/DOCS-COMMANDER.md` |
| §1 第 4 行 | 真实响应未实现 | **仍成立**：`apps/response-helper/src/build.js:15` 仍为 `EXECUTION_ENABLED = false` | `apps/response-helper/src/build.js:15` |
| §3 图形控制台 | `apps/console/` 为空目录 | **已实现**（正文该行已改） | `apps/console/**`、`apps/console-next/**` |
| §3 采集器装配 | `apps/daemon/bin.js` 不注入采集源 | **已接线**：`bin.js:34` 引入 `src/adapters/collector-sources.js`，`:51` 解析 `--collectors <path>` | `apps/daemon/bin.js:34,51` |
| §3 沙箱启动器 | `apps/sandbox-launcher/` 为空目录 | **仍成立**：目录在、文件数 0 | `apps/sandbox-launcher/` |

---

## 1. 六类发布级缺口（缺一不可写成正式可发布）

| # | 项 | 类型 | 现状（可核实） | 影响 |
|---|---|---|---|---|
| 1 | **正式安装器 / 升级器** | **部分实现**（2026-11-05 订正，原写「未实现」） | Windows 安装链在树：`deploy/windows/installer/`（`Setup.ps1` 54 583 B、`app/aidn/install.py` 40 489 B、`src/uninstall.mjs` 13 214 B、`VERSION`=`0.0.1-rc.5`）；候选包 `dist/release/0.0.1-rc.5/AIDrivenNetDefense-Setup-0.0.1-rc.5.exe`（67 860 347 B，sha256 `ca0297d0…`，**未签名**）；升级=覆盖安装，rc.5 起旧树可原地升级（`latest.json`）。**仍缺**：`deploy/systemd/` 仍为空；无 `*.msi`/`*.msix`/`*.nsi`/`*.appx`/`*.dmg`/`*.deb`/`*.rpm`/`*.service`；**提权安装未验收** | 有卸载路径且非提权装/卸已实测（`evidence/rc5/accept/FINAL/RESULT.json`：非提权 21/21 PASS）；但提权验收结论是 `blocked(uac-cancelled)`，故仍不能算可交付的正式安装件 |
| 2 | **代码签名** | 未实现 | 全仓无 `*.pfx`/`*.p12`/`*.cer`/`*.sig`/`*.cat`；无 `signtool` / `osslsigncode` 调用 | 交付物来源不可验证；Windows SmartScreen 无法通过 |
| 3 | **四 OS 验证** | 未验证 | 只有 **win32-x64** 实跑；Linux / macOS / win32-arm64 无运行证据；`mkfifo` 等分支在非 Linux 无有效覆盖 | 不得宣称跨平台可用 |
| 4 | **真实响应执行** | 未实现 | `apps/response-helper/src/build.js` 的 `EXECUTION_ENABLED = false`；`executeStub()` 恒返回 `dry_run_only`、`performed: false` | 「辅助响应」只有计划侧；处置侧没有代码路径 |
| 5 | **真实生产密钥** | 未验证 | 只用回环桩 broker 与测试 token；未接真实模型凭据；token 轮换/吊销的真机行为未观测 | 生产部署路径未经观测 |
| 6 | **真实 OS 采集** | 未验证 | 采集器在虚拟文件系统 / mock 源上验证；`/var/log/auth.log` 等为虚拟路径字符串；未在真实主机持续采集 | 采集保真度、资源占用（RSS/CPU）未知 |

> **2026-11-05 订正**：第 **2、4** 项是**代码不存在**（无签名证书、无真实执行路径），不是「还没测」；
> 第 **1** 项自 2026-11-05 起**代码已存在**（安装/卸载链在树，候选包已产出），剩下的是「无签名 + 提权路径未验收」；
> 第 3、5、6 项是**代码在但没在真实环境跑过**。
>
> 这六项目前都有**规格文档**（`docs/implementation/adr/ADR-0009-release-distribution.md`
> 与 `docs/implementation/release/*.md`），但每份都自述「规格（未实现）」或「全部未执行」。
> **有规格不等于有能力**：规格描述的是打算怎么做，不是已经做到。

---

## 2. 明确不在 0.0.1 范围

这两项不是缺口，是范围外。任何文档都不得把它们算作 0.0.1 的待办或承诺：

| 项 | 状态 | 说明 |
|---|---|---|
| **Gateway Edition** | 未立项 | 没有 ADR，没有代码，不属于单机代理范围。不要在架构图里画它 |
| **MCP 控制面** | 已暂缓 | 仓库内没有 MCP 服务端/客户端实现，也没有启用的 MCP 能力 |

---

## 3. 其他未实现

| 项 | 现状 | 影响 |
|---|---|---|
| 图形控制台 | **已实现**（2026-11-05 订正，原写「`apps/console/` 为空目录」）。`apps/console/` 15 个文件（`index.html` 24 330 B、`app.js` 77 414 B、`i18n/locales/` 含 7 种语言）；新控制台 `apps/console-next/` 6 页（概览/告警/分析/Agent/模型与用量/设置），随 rc.5 载荷 `console/`（63 文件）分发 | 原「只能命令行使用」已失效；界面语言状态与页面数见 rc.5 `RELEASE-NOTES.md` |
| 沙箱启动器 | `apps/sandbox-launcher/` 为空目录 | 无 OS 级执行隔离 |
| 审批端点 | 路由闭集只有 5 条只读/探针路径 + 1 条内部采集轮询 `POST /api/v1/collectors/:id/poll`；**没有**审批或响应路由 | 「人工审批」在 0.0.1 范围内但尚未提供可调用的接口；审批只在数据模型与策略层存在 |
| 告警处置动作 | 没有把告警与 response-helper 连起来的调度 | 计划器目前只能被库调用，不能由 daemon 触发 |
| 分析派发器 | `analysis_outbox` 只写不读（除只读 API 展示） | 告警不会自动进入 Harness |
| Harness → 存储回写 | `harness-worker` 不读写事件库 | 分析报告不会落 `analysis_report` |
| 备份 / 恢复演练 | `recovery_manifest` 表存在，流程未做发布级验证 | 数据可恢复性未证明 |
| 规则包分发 | 仓库不随产品附带任何规则包 | 开箱无法检测，必须自备 `schemaVersion 1.0` 规则包 |
| 采集器装配 | **已接线**（2026-11-05 订正，原写「`apps/daemon/bin.js` 不注入采集源」）。`bin.js:34` 引入 `src/adapters/collector-sources.js`，`:51` 解析 `--collectors <path>` | 原「`full` 模式无法用自带入口启动」已失效；真实源 10 分钟实测 `store.events=45775`（`docs/implementation/status/A-WAVE-RESULT.md`） |

---

## 4. 其他未验证

| 项 | 说明 | 出处 |
|---|---|---|
| CLI ↔ 真实 daemon 端到端 | 全部 CLI 测试走进程内 mock loopback；无真实进程对跑 | RELEASE_STATUS §4「补充未验证」 |
| 告警列表翻页的一致性 | 已实现 keyset cursor（`--cursor` / `--all` / `--max-pages`）并在 `tests/wp5-cli` 覆盖；但「翻页期间被合并的告警会被跳过、`has_more` 可能提前变 `false`」是**设计边界**，未在真实数据上量化 | 06 §5、`apps/cli/src/commands.js` |
| 多客户端并发翻页 | 未做并发压测 | RELEASE_STATUS §4、06 §13 |
| `SQLITE_BUSY → 503` | 未实测 | RELEASE_STATUS §4 |
| 响应体 256 KiB 裁剪 | **合同合法数据下**端点级不可达，仅 `buildPage` 单测用小 `byteCap` 覆盖；绕过合同直写库（如超长 `rule_id`）可以触发 | `M7_API_CONTRACT.md` §9、RELEASE_STATUS §4 |
| 性能 / 浸泡 | `tests/bench`、`tests/soak` 不被任何门禁引用；RSS 增长与「认证限流放大」在性能维度**未复证**（只证了功能语义） | RELEASE_STATUS §4「补充未验证」 |
| bundle 可复现安装 | bundle 不能 `npm ci`（保留指向已剪包的声明依赖），`manifests.test.js` 显式放行 | RELEASE_STATUS §4「补充未验证」 |
| 审计覆盖面 | daemon 全链路是否都写审计、哈希链在异常中断后是否可验证，未独立验证 | 本文档判断 |
| 独立审查完整性 | **第 3 轮的缺口已关闭**：`reviews/release-evidence-closure.md`（第 2 轮结论 `GO_WITH_FIXES`，第 3 轮 §12 记 3 个 P1 全 **CLOSED**）、`reviews/m8-formal-final-review.md`、`reviews/m8-postfix-final-review.md` 均在树；M7-API 现为 **GO**（346/346），M8 为「实质 GO、表述待订正」。**仍有 2 条待订正**：① `status/M8-DFA-PRUNE.md` 自述「独立只读复核 2 轮」与报告不符；② `RELEASE_STATUS.md` §9/§9.8 把 `reviews/release-r4-audit.md` 列为「新建」，但 2026-11-03 16:33 实测**该文件不存在** | RELEASE_STATUS §3、§5 P2-2；`reviews/` 目录实查 |
| Harness 整体验收 | `status/WP0-HARNESS.md` 仍为 `blocked`：HAR-UPSTREAM-001（缺服务 provider）、HAR-UPSTREAM-002（cwd 运行时上下文泄漏）、许可门禁 | 该状态文件 §blockers |
| 许可「合规」结论 | `dfa` 的做法是**不再分发**，不是补齐许可文本；`deploy/embedded-runtime/license-attestations.json` 中该条仍为 `open` | RELEASE_STATUS §6「正式可发布」行 + 该 json |
| 门禁自身的概率性失败 | `tests/wp1-event-store/crash.test.js` 有一次 `EXIT=1`（`ERR_STORE_LOCKED`，pid 存活判定竞态），单跑 5/5 绿、复跑全绿；不能因此写成「门禁恒绿」 | RELEASE_STATUS §2.1、§5 P2-13 |

---

## 5. 闭合这些缺口需要什么

不是承诺，只是判定标准——满足以下条件才能改状态：

| 缺口 | 闭合判据 |
|---|---|
| 安装器 | 产出签名的安装包 + 静默安装/卸载脚本 + 在一台干净机器上完成安装→启动→卸载的完整记录 |
| 代码签名 | 签名证书 + 可验证的签名链 + 目标机 `Get-AuthenticodeSignature` 输出 |
| 四 OS | 每个 OS 上都跑完整门禁 + 打包 + 启动 + API 冒烟，且有原始日志 |
| 真实响应 | `EXECUTION_ENABLED = true` 的独立分支 + 每类动作的正向与拒绝用例 + 回滚验证 + 独立安全审查 |
| 生产密钥 | 真实凭据接入记录 + 轮换/吊销演练 + 出网流量观测 |
| 真实采集 | 在真实主机连续运行 ≥ 设定时长，记录事件量、RSS、CPU、缺口 |
| 审批 | 状态变更端点 + 授权模型 + CSRF/Origin 校验 + 端到端审计 |

---

## 6. 禁止使用的表述

对外材料、演示、口头介绍都不许出现。下表前 6 条是 `RELEASE_STATUS.md` §6「禁止的表述」原文，第 7 条来自本文档旧版，一并保留：

```text
可发布                    ← §6 原文
已达发布标准              ← §6 原文
跨平台可用                ← §6 原文
许可已合规                ← §6 原文
响应处置已就绪            ← §6 原文
本地候选已签收（正式）    ← §6 原文
生产可用                  ← 本文档旧版条目，§6 未列，一并禁用
```

第 6 条容易被忽略：「本地发布候选 = `LOCAL_CANDIDATE_GO`」是**内部口径（win32-x64、本地开发内测）**，
不是签收，也不等于可发布。写对外材料时不要把它压缩成「已签收」。

推荐表述（`RELEASE_STATUS.md` §6 原文，不得改写强度）：

```text
本地候选基线（win32-x64）：门禁 2 837 条全绿、M9 语料 420/420、M9-P3 四套 335/175/158/156、
3 个 P1 已关闭并经独立只读复核（0×P0/0×P1）；正式发布链未建。
```

补一句口径差异，避免读者被两个数字绕住：§6 那句写的是 §2 那次（14:46 / 14:54，2 837 / 2 840）；
§8.2 的第二路复核在 15:17 / 15:21 读到 **2 842**；R4 在 16:13–16:24 重跑，仍是 **2 842 / 2 840 pass / 2 skip / 0 fail**
（§9.3），差异全在第 11 段 `wp5-cli`（并发会话在扩用例）。引用时请带上「哪一次」，不要合成一个新数字。

---

## 7. 一句话总结

> 0.0.1 的**代码主体在**，**本地自动化门禁在**；
> 但**交付链（安装/签名/跨平台）**和**执行链（真实处置/模型/采集）**都还没有。
> 这两条链不闭合，它就不是一个可以交给别人安装使用的产品。
