# Harness 最小 Profile 合同

- 版本：v1.1（随软件设计说明书定稿）
- 上游提交：`ce7073d51254c26cd63b22a60835b8f948deb447`
- 文档负责人：PT-dove

本合同区分“包存在”“插件已加载”“运行时服务已注册”“工具对模型可见”。包名或依赖名本身不等于安全判定；最终门禁同时核对四层清单。

## 1. 宿主入口与传输

使用官方 dsh 启动器选择独立 `aegis-analysis` profile，由 broker 每次分析创建独立 worker。官方启动器提供 `loader` 与 `cmdlineArgs` 宿主服务；`sdk-jsonrpc-server` 通过生产 stdio 承载换行分隔 JSON-RPC。stdout 禁止 logger，stderr 仅诊断且有 64KiB 上限。

broker 控制序列固定为：`initialize`（静态模型、maxTokens、禁止审批/用户提问能力）→ `session/prompt`（低层入口，避免 slash 命令）→ `session/wait` → `shutdown`。不使用 session/resume、图片、working-directory/set、/compact、/permission、/plan、/goal 或插件管理。EOF、半关闭、超时和取消均关闭整个 worker；一次分析结束即退出，不复用 Session。

## 2. 内置直接插件清单

| 插件 ID | 包 | 必要配置/注入 | 运行时理由 |
|---|---|---|---|
| sdk-app-startup | @deepseek-ai/dsh-sdk-app | profile=aegis-analysis | 官方 stdio 生命周期、EOF 关闭 |
| sdk-jsonrpc-server | @deepseek-ai/dsh-sdk-jsonrpc-server | inject=[sdkAppStartup,loader]；maxTokensAsSuccess=false | 控制面；另需 agents/workingDirectory 服务 |
| llm-deepseek | @deepseek-ai/dsh-llm-deepseek-api-key | baseURL=本地 broker；apiKeyEnv=单次 broker token；静态 models | 模型传输；静态目录禁止 /models 外发 |
| session-log-deepseek | @deepseek-ai/dsh-session-log-deepseek | 固定版本默认格式 | Session 事件词汇 |
| plugin-package-inventory-deepseek | @deepseek-ai/dsh-plugin-package-inventory-deepseek | 只读固定安装清单 | 上游包清单兼容 |
| timer | @deepseek-ai/cordis-plugin-timer | 无远程任务 | Agent Loop 依赖 |
| llm | @deepseek-ai/dsh-llm | 仅 DeepSeek 本地路由 | LLM seam |
| session | @deepseek-ai/dsh-session | 单分析 Session | 会话事实 |
| session-projection | @deepseek-ai/dsh-session-projection | 仅内存/自有 Session | workingDirectory 依赖 |
| filesystem | @deepseek-ai/dsh-fs-local | 仅每分析空 cwd；OS 沙箱限制 | workingDirectory 校验；不注册 fs 工具 |
| working-directory | @deepseek-ai/dsh-working-directory | defaultDirectory=每分析空目录 | SDK 必需服务；不注册对应工具 |
| system-prompt | @deepseek-ai/dsh-system-prompt | 固定防御 persona；关闭身份/运行时附加 | 最小系统提示 |
| tools | @deepseek-ai/dsh-tools | 内置基线仅两个防御工具；扩展代理工具须列入 Effective Manifest | 工具注册表 |
| tool-executor-native | @deepseek-ai/dsh-tool-executor-native | 禁止 PTC | 工具执行器 |
| agent | @deepseek-ai/dsh-agent | 单根 Agent | Agent 注册 |
| agent-loop | @deepseek-ai/dsh-agent-loop | agents=[]，由 SDK 创建单 Session | Agent 驱动 |
| sessions | @deepseek-ai/dsh-session-persistence-jsonl | root=每分析专用目录，compression=none | 本地 Session |
| session-checkpoint-policy | @deepseek-ai/dsh-session-checkpoint-policy | 不触发辅助模型请求 | 持久化屏障 |
| defense-tools | @aegisharness/dsh-defense-tools | evidence.get_summary、analysis.submit_result | 经 broker 的 DTO/结果工具 |
| deepseek-llm-api-extensions | @deepseek-ai/dsh-deepseek-llm-api-extensions | 无 config、无 inject；必须是 `allowedPluginIds` 末位 | 上游两个消费者 inject 该服务的硬依赖；开放面由「已注册字段集合恰为 {dsh_session_log, dsh_plugin_packages}」夹住（ADR-0004） |
| defense-policy | @aegisharness/dsh-defense-policy | 最终拒绝 guard、schema/大小/attempt 校验 | 单调拒绝策略 |
| extension-bridge | @aegisharness/dsh-extension-bridge | 只连独立扩展进程，逐 RPC 权限/schema/配额检查 | 第三方插件隔离桥 |

## 3. 明确禁止加载的插件/服务

worker 内不得出现：动态 plugin manager、HMR、MCP、subagent/team、shell/PTY/subprocess/terminal、fs/attachment/working-directory 工具、web/browser、jobs、PTC、自动/命令 compaction、image offload、session title、LLM retry、非必要遥测、stdout logger。worker 外的受控插件管理器仅生成管理员批准的 overlay，详见 PLUGIN_SYSTEM。

`filesystem` 与 `working-directory` 服务仅为 SDK 必需接口保留，不向模型注册工具；worker OS 沙箱只允许每分析空 cwd 和自有 Session。若 WP0 证明可用更窄的只读目录服务替代，则通过 ADR 替换，不能悄悄扩大 fs 能力。

### 3.1 运行时上下文：存在且只有一条（ADR-0005）

`dsh-working-directory` 以 `required: true` + `prepend: true` 注入 `working-directory:current`，
**无法由 `includeRuntimeContext: false` 关掉**。ADR-0005 选择"接受并约束"而不是 fork 上游：

- 允许集合恒为 `["working-directory:current"]`（长度必须恰 1，名字必须命中，`interpolate` 必须为 `false`）；
- 其文本必须与声明模板 `Current working directory: "{cwd}".` **再渲染后逐字符相等**；
- 其中的 `cwd` 必须落在中性根下：Windows `C:\ProgramData\AegisHarness\analysis`，
  Linux `/var/lib/aegis/analysis`；不得含用户名、`AppData`、`home` 或仓库路径，也不得含 `..` 段。

因此**不得宣称"零运行时上下文"**：模型每次都会看到一条本机绝对路径（中性根 + 每分析目录），
它不含用户数据，但确实是一条信息面。真实每请求请求体尚未做字段级断言，属 M6 broker 范围。

## 4. 四层可验证清单

WP0 必须从实际发布产物生成并由独立审查者核对：

1. **包层**：所有直接与传递包名、精确版本、lockfile 条目、tarball/文件哈希和许可证。
2. **插件层**：解析后的插件 ID、包名、顺序、disabled 状态、patch 来源与哈希。
3. **服务层**：loader、cmdlineArgs、sdkAppStartup、agents、workingDirectory、fs、sessionProjections 等 provider 与 inject 关系；特别核对必需服务缺失和高危服务出现。
4. **模型面/有效配置**：实际工具 schema、模型路由、baseURL、静态 models、maxTokens、重试/compaction/遥测开关、stdout logger。

清单由构建过程生成，但不能自证；独立审查将其与固定上游源码和本合同逐项比较。内置内核之外的扩展插件只能来自 PLUGIN_SYSTEM 定义的受控 overlay，并进入每次分析的 Effective Manifest；未批准差异必须回到 ADR 审核，否则 Agent 功能裁剪。AT-HAR-001/002 必须同时验证四层，并包含缺失必需服务、传递依赖引入高危实现和未批准扩展插件的反例。
