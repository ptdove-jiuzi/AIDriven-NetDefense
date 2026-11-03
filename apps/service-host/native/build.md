# `aegis-svc.exe` 构建说明（未构建）

- 上游决定：`docs/implementation/adr/ADR-0009-release-distribution.md` D3、§3.2、§5.2
- 状态：**源码在仓，二进制不存在**。本仓库没有任何构建脚本会编译它，本机也没有执行过编译。

## 为什么它必须存在

`sc create ... binPath= node.exe` 不可行：`node.exe` 从不调用 `StartServiceCtrlDispatcher`，
SCM 会以 **error 1053** 判失败。虚拟服务账号 `NT SERVICE\AIDrivenNetDefenseDaemon` 也没有密码，
`sc create obj=` 表达不出来；`SERVICE_CONFIG_PRESHUTDOWN_INFO` 更没有 `sc.exe` 开关。
这三条各自都足以否决 `sc.exe`。

因此安装器在 `armed` 模式下**要求** `%ProgramFiles%\AIDriven NetDefense\bin\aegis-svc.exe` 存在，
缺它就退出 **10**，而不是退化成 `sc.exe` 并谎称成功。

## 构建（由用户决定何时在本机执行）

需要 Visual Studio 2022（或 Build Tools）的 MSVC，静态链接 CRT：

```powershell
# 在 “x64 Native Tools Command Prompt for VS 2022” 里执行
cl /nologo /O2 /MT /EHsc /DUNICODE /D_UNICODE `
   apps\service-host\native\aegis-svc.cpp `
   /Fe:build\aegis-svc.exe `
   /link /SUBSYSTEM:CONSOLE advapi32.lib user32.lib shell32.lib
```

| 项 | 说明 |
|---|---|
| 子系统 | 用 `CONSOLE` 而非 `WINDOWS`：服务模式下 `CREATE_NO_WINDOW` 已保证无窗口，而控制台子系统让 `--install-service` 的退出码和 stderr 能被安装器读到 |
| CRT | `/MT` 静态链接，目标机不需要 VC++ 可再发行包（`release/windows-install.md` §1「不得要求用户自行下载运行时」） |
| 签名 | **必须** Authenticode + RFC3161 时间戳后才能随包分发（ADR D9）。未签名的宿主会让 `WinVerifyTrust` 那一步（码 13）永远失败 |
| 命名 | 产物名固定 `aegis-svc.exe`，安装到 `%ProgramFiles%\AIDriven NetDefense\bin\` |

## 构建后必须补的证据

1. `signtool verify /pa /all build\aegis-svc.exe` 全绿；
2. `build\aegis-svc.exe --install-service --app <dir> --config <file>` 之后
   `sc qc AIDrivenNetDefenseDaemon` 显示 `SERVICE_START_NAME = NT SERVICE\AIDrivenNetDefenseDaemon`
   （**不是** LocalSystem）；
3. `sc qfailure AIDrivenNetDefenseDaemon` 显示 3 条 restart/60000、reset 86400；
4. `sc query AIDrivenNetDefenseDaemon` 在子进程被 `taskkill` 后由 SCM 拉起（失败动作生效）；
5. 宿主被强杀后**没有**遗留 `node.exe`（Job Object 生效）。

以上五条在本仓库内**全部未验证**，因此 `status/P1-P2-IMPLEMENTATION.md` 把 P2 的原生部分记为
`blocked-on-build`，而不是「已完成」。

## 已经可验证的替代物

`src/supervisor.mjs` 用 JavaScript 实现了同一份进程契约（ready 行、stop 命令、超时强杀整树），
`tests/installer/service-host.test.js` 对它做了端到端演练。原生宿主建出来后，两边的行为差异就是
要修的地方——这比在没有任何编译验证的情况下宣称 C++ 已完成要可核对。
