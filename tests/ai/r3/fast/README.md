# r3/fast · 审批四条否定（真链路，红 / 绿 / 变异红）

## 一条命令

```bash
node tests/ai/r3/fast/run-approval-negatives.mjs --variant all
```

（`--variant red|fix|mutB` 可单跑一条腿；三腿合计实测约 74 s，单腿最慢约 46 s，远低于 570 s 上限。）

## 前置条件

* Node v22（本机 `node v22.22.2`）；
* **不需要**管理员、**不写** `apps/**`（只读复制到 `%TEMP%`）、**不写**注册表、**不写** `evidence/**`；
* 需要本机有 `patch`（Git for Windows 自带）：脚本按 `PATCH` 环境变量 → PATH 里的 `patch` →
  `<git --exec-path>/../../../usr/bin/patch.exe` 的顺序找；找不到就直接报错退出，不会静默跳过补丁；
* 工作根固定 `%LOCALAPPDATA%\Temp\p1wrap\`：`broker-fix/`、`mutB/`（两份临时 broker 副本）、
  `logs/`（JSON 回执）。**不需要**先造任何东西，脚本每次从仓库重新复制 broker。

## 三腿含义

链路（真字节，无替身 host）：

```
daemon createControlApi（真路由 + 真 apps/daemon/src/api/chat.js + 真审批注册表）
  → broker-client（stdio JSON-RPC）→ 被测 console-host.js → chat-transport.js
  → 127.0.0.1 假 provider（tests/ai/fake-provider.mjs，真 HTTP，零外联、无 key）
```

| 腿 | host 路径 | 含义 |
| --- | --- | --- |
| `red` | `apps/model-broker/bin/console-host.js`（仓库原件） | 打补丁**之前**：`tool_calls` 在 `chat-transport.js` 就被丢掉 |
| `fix` | `%TEMP%\p1wrap\broker-fix\apps\model-broker\bin\console-host.js` | 打上 `tests/ai/r3/fix/AGENT-001.patch`（201 行 / 127+ 3− / 2 文件）的副本 |
| `mutB` | `%TEMP%\p1wrap\mutB\...` | `fix` 副本再删掉转发 tool 帧时的 `requiresApproval: true`（daemon 的注册门严格要求 `=== true`） |

脚本自校验：

* 打完补丁后检查两个代码标记（`chat-transport.js` 出现 `TOOL_ARGUMENTS_MAX_CHARS`、
  `console-host.js` 出现 `type: 'tool'`），缺一个就抛错，不把"没打上"当成"绿"；
* `mutB` 删行前断言 `requiresApproval: true,` **恰好 1 处**（`expected exactly 1 requiresApproval line`），
  删完再跑；
* 每次运行都从仓库**重新复制** broker，避免"patch 重复打 → already applied"的假失败。

**为什么不复用 `tests/ai/r3/replay/replay-negatives.mjs`（92 条：N1 22 / N2 20 / N3 15 / N4 23 / N5 12）**：
那是替身 host 触发的形状断言。本文件不复抄这 92 条，只补一条它做不到的对照——**打补丁前的红 vs 打补丁后的绿**，
所以触发源必须换成被测 broker 本体（`tests/ai/r2/stub-approval-host.mjs` 本次**未使用**，
因为它的前提正是"真链路没有 tool 帧"）。

## 断言清单

| id | 断言 | 判据 |
| --- | --- | --- |
| N1 | 决策前无副作用 | 提案帧可见 + 注册表恰 1 条；此刻 SSE 前缀里**无 `result` 帧、无 `executed:true`**；用未注册 callId 去 approve → **409 `CALL_UNKNOWN`**，且不消费真正的待批项（size 仍为 1） |
| N2 | 决策留痕 | approve 后恰好 1 条 `msg="approval recorded"` 日志，含 callId + decision；响应体 `{executed:false, reason:"EXECUTION_DISABLED"}` |
| N3 | 超时 | 独立链，注册表 `timeoutMs=60` → 收到 `state=denied / reason=APPROVAL_TIMEOUT` 帧，registry 归零，**迟到的 approve → 409** |
| N4 | 重复 / 串话 | 同 callId 二次注册 → `[true,false]`（真产品导出 `createApprovalRegistry`）；错 session → 409 且不消费（size 仍 1）；正确 approve **只 1 条 `approved` 帧**；再 approve → 409 |

`gapMs = 2500`：假 provider 在 tool_calls 片段之后、`finish_reason` 之前停 2.5 s。这段窗口就是
"提案已注册、流还没结束"的状态；审批必须在这段里发生——否则 `done` 会
`approvals.cancelSession()` 掉待批项（这正是 agent 在真链路上永远等不到决策窗口的原因）。

## 实测（2026-11-16，本机）

```
red    0/4   四条全红：SSE 只有 [usage, done]，tool 帧 0，注册表 0 → 审批链无从进入（note: NO_PROPOSAL）
fix    4/4   N1..N4 全绿（单腿 5,575 ms；N2 日志样本 callId=call_fake_0, decision=approve）
mutB   0/4   提案帧到了但注册表恒 0 → 四条全红（单腿 20,534 ms；note: PROPOSAL_NOT_REGISTERED）
```

红态红的是"提案根本到不了 daemon"；`note` 字段区分两种情况：`NO_PROPOSAL`（真链路 0 个 tool 帧）
与 `PROPOSAL_NOT_REGISTERED`（帧到了但没登记）。任一前置不成立即判红，**不放宽断言**。

## 口径边界（重要）

* **N2 是"决策留痕"，不是"执行成功"**：0.0.1 没有工具执行器，四条用例只断言决策被记录、且
  `executed:false / EXECUTION_DISABLED`；`write_file` 的 canary 文件**必须不存在**，本轮没有任何真实工具调用。
* 触发源是**真 broker**（不是替身 host），provider 是 127.0.0.1 的假 provider（真 HTTP、零外联）。
* 不验"断电/重启后审批注册表能否恢复"——注册表在内存里，`cancelSession` 即丢，本轮不覆盖。

## 明确不做（未验证）

* **断电三时点（TP1/TP2/TP3）**：真机强杀、超预算 → 不做；
* **跨重启** → 不做；
* **全量 `npm test`**（8–12 min）→ 不做；
* **"卸载项恰 1 条"**：红线（会触碰主机真实安装的卸载键 `AIDrivenNetDefense`）→ 不做；
* **exe 级冷装 / 真 `Setup.exe`** → 不做（本目录不涉及安装器）；
* **真实 provider**（真实 API key / 外网）→ 不做。

Author: PT-dove
