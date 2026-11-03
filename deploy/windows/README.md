# Windows 安装引擎（P1 切片）

- 上游：`docs/implementation/adr/ADR-0009-release-distribution.md` §5.1、§6、§10.2(P1)、§10.4
- 操作细则：`docs/implementation/release/windows-install.md`、`release/upgrade-rollback-recovery.md`
- 状态：**可运行的引擎 + 真实跑过的测试；不是可分发包**
- 作者：PT-dove

## 1. 这里有什么

> **并行任务共存提示**：`deploy/windows/installer/` 里还有另一条并行任务产出的**测试通道安装器**
> （`Setup.cmd` / `Setup.ps1` / `INSTALL.txt` / `SelfCheck.mjs` / `build-dist.cmd`，用 PowerShell + WinForms，
> 自选安装路径、不注册服务、**不校验** `files.sha256`）。本目录的 `main.mjs` + `src/` 是 **P1 正式引擎**。
> 两者产物不兼容，**不要对同一棵树交替使用**；冲突清单见
> `docs/implementation/status/P1-P2-IMPLEMENTATION.md` §11。

```text
deploy/windows/installer/
  main.mjs              命令入口（/install /repair /uninstall /purge /verify，/S /silent /log）
  src/cli.mjs           参数解析（未知参数一律拒绝）
  src/paths.mjs         三区路径（程序 / 数据 / 安装元数据）+ armed|disarm 安全边界
  src/fsx.mjs           原子写、带哈希的复制、受限删除
  src/manifest.mjs      files.sha256 解析与全量校验（缺一即 12，多出也 12）
  src/journal.mjs       §6 状态机与写前日志
  src/version.mjs       三版本关系与版本地板（14 / 10）
  src/ops.mjs           特权动作：注册表 / 服务 / 快捷方式 / ACL，armed 执行或 disarm 记录
  src/install.mjs       安装/修复事务
  src/uninstall.mjs     卸载（保数据）与清除（/purge）
  src/verify.mjs        只读校验
```

引擎**不生成** `.exe`、不打包 `.zip`、不联网、不签名。ADR D1 的签名 `Setup.exe` 是打包层，本切片只做它能承载的引擎与判据。

## 2. armed 与 disarm

| | `armed`（默认） | `disarm` |
|---|---|---|
| 写入位置 | 真实 `%ProgramFiles%`、`%ProgramData%` | `--root` 之下（拒绝落在任何真实系统位置内） |
| 权限 | 必须提升（否则 11） | 不需要 |
| 服务 / 注册表 / 快捷方式 / ACL | 真正执行 | 只写 `install\plan\actions.jsonl` 计划 |
| 用途 | 用户在本机真正安装 | 测试与端到端演练 |

`armed` **不接受** `--root`：真实路径由 ADR §5.1 固定，能被重定向的"安装"不是安装。
系统临时目录（`%TEMP%`）是 disarm 唯一的例外，因为它本身就位于 `%LOCALAPPDATA%` 内。

## 3. 需要管理员权限的步骤（由用户决定何时在本机执行）

以下动作本仓库**一次也没有在本机执行过**。按顺序由用户执行：

1. 提升到管理员 PowerShell / cmd；
2. `node deploy\windows\installer\main.mjs /install /S --payload <已解压载荷> --version 0.0.X --engine-source deploy\windows\installer --log C:\Temp\aidnd.log`
3. 校验：`sc qc AIDrivenNetDefenseDaemon`、`sc qfailure AIDrivenNetDefenseDaemon`、`sc sdshow AIDrivenNetDefenseDaemon`
4. `node deploy\windows\installer\main.mjs /verify --log C:\Temp\aidnd-verify.log`
5. 卸载：`... /uninstall /S`（保数据）或 `... /purge /S /confirm`（清数据）
6. 装 P2 原生宿主后才能上表 2–3 步成立（见 `apps/service-host/native/build.md`）

**顺序上的硬前置**：`armed` 安装要求 `%ProgramFiles%\AIDriven NetDefense\bin\aegis-svc.exe` 已存在
（由载荷提供）。缺它时安装器退出 **10**，不会退化成 `sc.exe`——`sc create` 无法表达虚拟服务账号，
也无法设置 PRESHUTDOWN，`node.exe` 更不会被 SCM 接受（error 1053）。

## 4. 与 ADR 的两处偏差（有意，已登记）

| 偏差 | 原因 | 影响 |
|---|---|---|
| `/uninstall` 用**延迟删除**（`pending-removal.json` + `cmd /c ping · rmdir`）而不是"Setup.exe 从 %TEMP% 启动" | 本切片没有 EXE 引导器；引擎可能运行在 `programRoot` 内，而运行中的 `node.exe` 无法被删除 | 删除发生在进程退出后约 2 s；失败会留下标记，下次 `/verify` 与 `/uninstall` 可见 |
| `/upgrade` 与 `/rollback` **未实现**，直接拒绝（10 / 25） | 升级需要 DB 快照 + 单事务迁移（§6.3），半成品升级正是 §6 要防的状态 | 升级只能"卸载（保数据）→ 安装"；回滚需等 P1 完整实现 |

## 5. 验收判据（可执行）

> **在 Git Bash / MSYS 下必须用 `--` 形式的参数**（`--verify`、`--install`）。MSYS 会把 `\` 开头的
> 参数当路径改写：`/verify` 会变成 `D:/…/PortableGit/verify`，安装器看到的就不是命令了。要保留 `/install`
> 写法，用 cmd.exe / PowerShell，或设 `MSYS2_ARG_CONV_EXCL='*'`。这不是安装器的问题，是 shell 的。

在本机（无需管理员、不写系统位置）：

| # | 判据 | 命令 | 期望输出 |
|---|---|---|---|
| A1 | 全套测试通过 | `node --test "tests/installer/**/*.test.js"` | `ℹ pass 101` / `ℹ fail 0` |
| A2 | 载荷被改 ⇒ 中止并回滚，码 12 | `node --test --test-name-pattern="modified payload" tests/installer/tamper.test.js` | `ℹ pass 1`，用例断言 `12` + `app` 不存在 + journal `ROLLED_BACK` |
| A3 | 清单外新增文件也算篡改 | `node --test --test-name-pattern="unlisted extra file" tests/installer/tamper.test.js` | `ℹ pass 1` |
| A4 | 写前日志：动作前 phase 已落盘 | `node --test --test-name-pattern="write-ahead" tests/installer/tamper.test.js` | `ℹ pass 1` |
| A5 | 降级被阻断，码 14 | `node --test --test-name-pattern="RC-DG-1" tests/installer/version.test.js` | `ℹ pass 1` |
| A6 | 地板文件损坏 fail-closed，码 10 | `node --test --test-name-pattern="RC-DG-4" tests/installer/version.test.js` | `ℹ pass 1` |
| A7 | disarm 无 `--root` 被拒，码 10 | `node --test --test-name-pattern="without --root" tests/installer/safety.test.js` | `ℹ pass 1` |
| A8 | disarm 全流程不写真实系统位置 | `node --test --test-name-pattern="writes only under its --root" tests/installer/safety.test.js` | `ℹ pass 1` |
| A9 | 卸载保数据、清除打计数、失败可续跑 | `node --test tests/installer/uninstall.test.js` | `ℹ pass 6` |
| A10 | `/verify` 不写任何文件 | `node --test --test-name-pattern="writes absolutely nothing" tests/installer/verify.test.js` | `ℹ pass 1` |
| A11 | 卸载后真实 `%ProgramData%\AIDriven NetDefense` 仍不存在 | `ls "/c/ProgramData/AIDriven NetDefense"` | `No such file or directory` |

需要管理员（由用户执行，AI 不代跑）：

| # | 判据 | 命令 | 期望输出 |
|---|---|---|---|
| B1 | 服务名与账号 | `sc qc AIDrivenNetDefenseDaemon` | `SERVICE_START_NAME : NT SERVICE\AIDrivenNetDefenseDaemon`（**不是** LocalSystem） |
| B2 | 失败动作与非崩溃计数 | `sc qfailure AIDrivenNetDefenseDaemon` | 3 条 `RESTART -- delay 60000`、`RESET_PERIOD 86400`、`FAILURE_ACTIONS_FLAG TRUE` |
| B3 | 预关机超时 | `sc qfailure` 之后 `reg query "HKLM\SYSTEM\CurrentControlSet\Control" /v ServicesPipeTimeout` 不适用；改用 `sc queryex` + 事件日志源存在：`reg query "HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application\AIDriven NetDefense"` | 存在 `EventMessageFile`、`TypesSupported=7` |
| B4 | 程序区只读 | `icacls "%ProgramFiles%\AIDriven NetDefense\app"` | 含 `Users:(OI)(CI)(RX)`，无 `(W)`/`(F)` |
| B5 | 令牌权限收敛 | `icacls "%ProgramData%\AIDriven NetDefense\data\secrets"` | 只有 `Administrators` 与 `NT SERVICE\AIDrivenNetDefenseDaemon` 两条 ACE，无 `Users` |
| B6 | 安装日志不含 token | `findstr /C:"api-token" C:\Temp\aidnd.log` | 只有长度与摘要前 8 位，没有令牌原文 |
| B7 | 宿主被杀后无孤儿 node | `taskkill /F /PID <aegis-svc pid>` → `tasklist /FI "IMAGENAME eq node.exe"` | 没有该安装启动的 node 进程残留 |

B1–B7 目前**全部未执行**，因为本机没有构建过 `aegis-svc.exe`。

## 6. 明确不做（本切片）

- 不生成 `.exe` / `.msi` / `.zip` 交付形态；`--payload` 只接受**已解压的目录**（zip 需要解压后端，属新依赖）；
- 不签名、不写时间戳、不生成 `trust.json`（P4）；
- 不联网、不联网校验版本、不做自动更新；
- 不动 `app\launch\` 下任何文件（只断言，绝不改写）。
