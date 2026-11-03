# Windows 采集适配器集成说明

面向 daemon 调度方与后续维护者。维护人：`PT-dove`。
所有结论以 `packages/collectors/windows/*.js` 与 `packages/collectors/common/INTEGRATION.md` 为准。
状态与测试证据见 `docs/implementation/status/WP2-WINDOWS.md`。

## 1. 来源矩阵与实现方式

| 来源 | stable_source_id | 类型 | 间隔 | 读取方式 | 事件 type |
|---|---|---|---|---|---|
| 进程 | `windows.process-table` | poll | 5 s | PowerShell `Get-CimInstance Win32_Process` | `windows.process` |
| TCP/UDP | `windows.network-table` | poll | 5 s | PowerShell `Get-NetTCPConnection` / `Get-NetUDPEndpoint` | `windows.connection` |
| 事件日志 | `windows.event-log.<slug>` | event | 30 s（订阅探测） | PowerShell `Get-WinEvent` + `EventRecordID` 游标 | `windows.event_log` |
| 服务 | `windows.service-table` | poll | 60 s | PowerShell `Get-CimInstance Win32_Service` | `windows.service` |
| 计划任务 | `windows.scheduled-task-table` | poll | 60 s | PowerShell `Get-ScheduledTask` / `Get-ScheduledTaskInfo` | `windows.scheduled_task` |
| Run 键 | `windows.run-key` | poll | 60 s | PowerShell `Get-Item` + `GetValueNames()` | `windows.run_key` |
| 声明目录元数据 | `windows.file-metadata` | poll | 60 s | **`node:fs`**（非子进程） | `windows.file_metadata` |

为什么目录元数据不用 PowerShell：同一份 `FindFirstFile`/`GetFileAttributesEx` 元数据，
少一个进程、无控制台编码问题，而且**没有任何字符串会进入命令解释器**，根路径不可能成为
命令注入面。反过来，进程/连接/服务/任务/注册表用 PowerShell 是因为 CIM 与注册表 API
在 Node 里没有稳定绑定，而 `Get-WinEvent` 的 `EventRecordID` 是唯一能表达
"大于某个记录号"的游标。

> **与设计 §5.1 的机制偏离（需主控/ADR 确认）**：设计写的机制是进程用 *Toolhelp32 快照*、
> 网络用 *GetExtendedTcpTable/GetExtendedUdpTable*、文件用 *ReadDirectoryChangesW + 对账*。
> 本实现分别用 `Win32_Process`、`Get-NetTCPConnection`/`Get-NetUDPEndpoint`、纯对账（无订阅）。
> 理由：前两者在 Node 里需要原生扩展（本仓库不允许新增依赖、也没有 N-API 构建链），
> CIM/NetTCPIP 能给出同样的对象集合且带类型化字段；目录源没有 `ReadDirectoryChangesW`
> 绑定，只实现对账一半。**这是对已定稿设计的偏离，不能由实现自行定案**：
> 若要回到设计机制，需要新增原生模块或 ADR 认可替代方案。


## 2. 子进程方案（`runner.js` + `powershell.js`）

### 2.1 调用形态

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -
```

- 脚本**走 stdin**（`-Command -` 表示"把 stdin 整段当一个脚本"），因此没有第二层引号解析，
  没有 cmd.exe 夹在中间，也不受 `-EncodedCommand` 的 base64 长度限制。
- `shell: false` 是硬编码的；`runner.js` 是包内唯一 `import 'node:child_process'` 的文件，
  由 `tests/wp2-windows/no-injection.test.js` 静态断言保证。
- 可执行文件按 **basename** 过白名单（默认仅 `powershell.exe`、`pwsh.exe`）。配置写错也不会
  退化成"能跑任意二进制"。
- `-NoProfile` 不只是提速：profile 往 stdout 写一行，就会毁掉每一次 `ConvertTo-Json` 解析。
- 脚本前置 `$ErrorActionPreference='Stop'`、UTF-8 输出、`$ProgressPreference='SilentlyContinue'`，
  避免进度流与 JSON 正文交错。

### 2.2 不让用户输入进入命令

三层，缺一不可：

1. **先校验**：`assertChannelName`（字母数字与 `. _ / -`，禁引号/反引号/`$`/`;`/`|`/`&`/`<>`/换行）、
   `assertRegistryKey`（只允许 `HKLM\`/`HKCU\` 前缀的普通路径）、`assertRootPath`（绝对路径、
   禁通配符与 `..`）。不合法即抛错，**在生成脚本之前**失败。
2. **再转义**：`psQuote()` 把 `'` 变成 `''`，整体包成单引号字面量。PowerShell 的单引号字符串
   不做变量展开，因此 `$(...)`、反引号、`$var` 都不会生效。
3. **变量复用**：脚本里第一次出现是 `$channel = '…'`，之后一律用 `$channel`，不再二次拼接。
   注册表读取用 `-LiteralPath`，值名里的 `*`/`?` 无法扩大查询范围。

数值参数（`$after`、`Select-Object -First N`）先用 `Number.isSafeInteger` 校验再插值，
不接收字符串。

### 2.3 失败分类

`runner` 把**非零退出码**也视为失败（`spawn` 只通过 `close` 事件报退出码，不会给你
error 对象——早期实现因此把所有失败的 PowerShell 都当成成功）。分类顺序是刻意的：

`TIMEOUT` → `OUTPUT_TRUNCATED` → `ACCESS_DENIED` → `CHANNEL_NOT_FOUND` → `NO_EVENTS` → `COMMAND_FAILED`

权限错误常常同时提到通道名，先判 `ACCESS_DENIED` 才不会把一个可修的 ACL 问题伪装成
通道拼写错误。每个错误码都带一句 `remediation`，直接进能力快照给运维看。

## 3. 接入 `collectors/common`

`adapter.js` 的 `createSourceBinding({ source, collector, clock })` 是唯一接触公共层的地方，
承担四项义务：

> binding **不接收** `capability` 对象：`runtime.addSource()` 内部创建 capability 且不对外暴露，
> 通过单独句柄更新在官方装配路径上根本不会执行。所有运维可见信息都经 collector 自身写入
> （`noteError` / `probeSubscription`），它握有同一份状态。

1. **read → publish → commit**。`publish` 只改内存，`commit` 是唯一落盘点。失败时持久游标不动，
   下一次读重放同一区间，稳定键完全相同，去重窗口吸收重叠。
2. **代次推进在 publish 之前，且 `cursor: null`**。事件日志被清空（记录号回退）时，`read()` 返回
   `reset: { reason:'log_cleared', gapStart, gapEnd }` 与带新代次的 `nextCursor`；binding 先
   `advanceGeneration({ reason, cursor: null, gapStart, gapEnd })` 再 `publish()`。
   传 `cursor: null` 是必须的：`advanceGeneration` 立即落盘，若把新代次位置一起写进去而随后
   `publish` 失败，这批记录就被跳过、只剩一条 count 0 的代次缺口。传 null 后失败只会导致
   新代次从 0 重读，去重窗口吸收重叠。
3. **错误 → 能力状态**。
   - `ACCESS_DENIED` → `noteError({ code: 'permission_denied', fatal: true })` → `unavailable`；
   - `CHANNEL_NOT_FOUND` → 同样 `unavailable`（配置错误，不是"零事件"）；
   - `TIMEOUT` / `OUTPUT_TRUNCATED` / `BAD_JSON` / `COMMAND_FAILED` → `degraded`；
   - `NO_EVENTS` → **不是错误**：返回 `{ ok:true, empty:true }`，不 publish（否则会把
     `nextCursor: null` 写进真实游标，等于清空事件日志游标）；
   - 截断读（`truncated: true`）→ `noteError({ code:'source_truncated', fatal:false })` → `degraded`；
   - `INVALID_ARGUMENT` / `INVALID_CONFIG` / `INVALID_RECORD` / `PATH_NOT_ALLOWED` /
     `EXECUTABLE_NOT_ALLOWED` / `SOURCE_LIMIT_EXCEEDED` / `SOURCE_UNKNOWN`，以及公共层抛出的
     `INVALID_RECORD` / `UNCOMMITTED_BATCH` / `STALE_BATCH` → **直接抛出**，这是本包的 bug，
     不能伪装成"主机不健康"。
   - `degradedFields` 只**返回**给调用方，不写能力状态：`setPermissions({ missing: [] })` 会让
     `common/capability.js` 清掉 `fatalError`，把一次真实的 `permission_denied` 解除锁定。
4. **订阅健康**。事件源只看 `probe()`：零业务事件不是故障；`probe` 失败才降级。

`index.js` 另外提供 `createWindowsSources()`（按需构造来源，`channels`/`roots`/`runKeys` 显式声明）
与 `attachWindowsSources({ runtime, sources })`（注册进 `createCollectorRuntime`，每个源独立能力状态）。

### 3.1 `truncated` 与 `hasMore` 的区别

- `hasMore`：本次读到了页大小上限，**还有积压**，应立刻继续读。事件日志的 500 条分页用它。
- `truncated`：本次读**真的丢了数据**（表超过 `maxEntities`、目录超预算、子树不可读）。
  只有它会把源降级。

早期实现让事件日志用 `truncated` 表示"分页未完"，结果任何繁忙主机每轮都产生一条截断降级；
现在两者严格分开。


## 4. 权限与降级矩阵

| 来源 | 必需权限 | 缺失后 | 降级表现 |
|---|---|---|---|
| 进程 | WMI `root\cimv2` 读 | `unavailable`（无 WMI 则整源不可用） | 非提权时 `image_path`/`command_line` 为空 → `degradedFields` |
| 连接 | NetTCPIP 模块 | `unavailable` | `OwningProcess=0` → `pid` 缺省、`attribution: 'unavailable'` |
| 事件日志 | 通道读权限（Security 需 Administrator 或 Event Log Readers） | `unavailable` | 绝不用"空结果"冒充无权限 |
| 服务 | WMI `Win32_Service` 读 | `unavailable` | 受保护服务的 `binary_path` 可能为空 → `degradedFields` |
| 计划任务 | ScheduledTasks 模块 | `unavailable` | 其他用户任务的 `action` 读不到 → `degradedFields` |
| Run 键 | 声明键的读权限 | `unavailable` | 键不存在只计入 `stats.missingKeys`，不算失败 |
| 目录元数据 | 对声明根的列目录权限 | 部分不可读仍 `ready` | 不可读子树计入 `stats.unreadable`，**其条目既不报 present 也不报 removed** |

目录源在"子树不可读"时的处理值得单独说明：把读不到的子树当成"全被删除"，会产出
海量假的 removed 事件。实现上 `diff()` 支持 `suppressRemovalsFor` 谓词，目录源用它把
失败前缀下的所有条目保留在跟踪表中并计入 `suppressedRemovals`。

## 5. 字段完整性与 payload 合同

`payload.js` 是必须经过的一层，原因不是洁癖，而是 `contracts` 的 TelemetryEvent
是一个**封闭对象**：

- 键必须匹配 `^[a-z][a-z0-9_]{0,63}$`。`imagePath`、`recordId`、`localAddress` 会被整条拒绝。
- 值只能是 string / safe integer / boolean（或同类型标量数组）。**`null` 被拒绝**，
  所以"未知"用"省略该键"表达，例如 `pid` 缺席 + `attribution: 'unavailable'`。
- 字符串必须 NFC、无 C0/C1 控制符、无双向符、无零宽字符。真实数据三者都有：
  事件日志消息多行、命令行带制表符、厂商文本可能带 RTL 标记。
- payload 总字节 ≤ 16 KiB。

分工：**键**违反模式是编程错误 → 抛 `INVALID_RECORD`；**值**无法表达是运行期数据 →
丢弃并计入 `dropped`，不让一行脏数据毁掉整批。

快照类来源的 digest 一律在**归一化之后**计算，否则两条只有控制符差异的行会被判成"变化"。

## 6. 短寿对象与轮转

- 进程/连接：比 `intervalMs` 更短的存活期完全不可见（声明在 `blindSpots`）。这不是缺陷，
  是轮询的固有盲区；4688 审计事件是后续可选的补强，本包未实现。
- 事件日志：`EventRecordID` 是代次内的单调位置；被保留策略淘汰的记录只能通过记录号跳变
  体现，不会补发。记录号回退 → `log_cleared` → 代次 +1 + 未知数量缺口。
- 目录：只做**对账**，没有 `ReadDirectoryChangesW` 订阅；两次对账之间创建又删除的文件不可见。
- 快照类来源一律 `identity: null`。给它们伪造 `identity` 会让进程表缩小被判成
  `log_truncated`，产生虚假代次推进——这是本包相对早期源码的接口变化。

## 7. 仍需 daemon / 其他模块完成的事

本包只产出"契约形状的草稿"，以下不在范围内：

1. `boot_id`：`createSourceCollector({ bootId })` 不传就是 `null`，契约要求非空。
2. `integrity`：默认 `null`；投递前必须补 `{ algorithm:'sha256', digest: canonicalDigest(payload) }`。
3. `native_record_id` 为 `null` 时投递前要**省略该键**，不能留 `null`。
4. 缺口持久化：`runtime.drainGaps()` 的结果必须落库，内存账本重启即失。
   **注意**：`createSourceCollector` 没有公开的 `recordGap`，因此本包无法为"截断读"写缺口账本条目；
   目前截断只体现为 `result.truncated` 与能力状态 `source_truncated`（`degraded`）。
   要让截断进入缺口账本，需要公共层提供一个公开写入接口 —— **这是本任务无法自行补齐的公共层缺口**。
5. event-store 的唯一约束（按稳定键）尚未实现；`persistedKeyWindow=2048` 之外的重叠
   必须由它幂等吸收。
6. 调度器：本包不启动定时器、不 spawn 进程；谁读、多久读、并发多少由 daemon 决定。
   事件源需要每 `descriptor.intervalMs`（默认 30 s）调用一次 `binding.probe()`。


## 8. 未验证项

- 未在真实 Windows 主机上读取真实事件日志、注册表与服务表。所有测试使用合成 fixture、
  临时目录与可控命令运行器；唯一会真正启动进程的测试是 `runner.test.js` 里一条
  `'-Command -'` 往返用例，脚本内容是常量表达式，不触碰任何用户数据。
- `Get-ScheduledTask` 在无 ScheduledTasks 模块的老系统上会整体失败（归类 `COMMAND_FAILED`），
  该路径未在真机验证。
- `Win32_Process` 在非提权下的字段缺失是按文档假设实现的，未真机对照。
- 目录源未实现 `ReadDirectoryChangesW`，因此"事件驱动 + 60 s 对账"只实现了对账一半。
