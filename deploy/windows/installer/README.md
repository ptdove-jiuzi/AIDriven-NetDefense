# Windows x64 测试安装器

作者：PT-dove

把 v14 桌面载荷（含 daemon + console）装成一可用目录，并支持覆盖升级与卸载。
**这是测试通道的安装器，不是对外发布版本**：无签名、无服务注册、无自动更新。

## 文件

| 文件 | 作用 |
|---|---|
| `Setup.cmd` | 启动器。双击走图形界面；`/S` 走静默 |
| `Setup.ps1` | 安装器主体（PowerShell + WinForms，不依赖任何第三方运行时） |
| `build-dist.cmd` | 组装 `dist` 目录并生成 `SHA256SUMS.txt`、打 7z |
| `INSTALL.txt` | 给测试者看的说明，会被复制进 dist（ASCII 文件名，避免 cmd 代码页问题） |

## 两个用户要求，落在哪

**1. 自选安装路径**
图形界面里路径框 + 「浏览…」，默认 `%ProgramFiles%\AIDriven NetDefense`。
路径校验拒绝：空、盘符根目录、`%SystemRoot%` 之内、超过 180 字符。

**2. 新版本自动认上次路径并覆盖**
检测顺序（两路，任一命中即用）：

1. 卸载注册表键 `AIDrivenNetDefense` 的 `InstallLocation`（HKLM → WOW6432Node → HKCU）
2. 默认目录下的 `install\install.json`（注册表被清过时的兜底）

命中后：路径框预填该路径、顶部提示「检测到已安装：<版本>（<路径>）」、按钮语义变为覆盖升级。
覆盖时先按安装目录路径停掉正在运行的程序（含 daemon 子进程），再 `robocopy /E` 覆盖
（`/E` 不 purge，所以 `data\` 天然保留）；`install.json` 里记录 `upgradedFrom`，
并且升级前后会对 `data\` 里最大的文件做一次 SHA256 比对，指纹变了就中止。

**3. 快捷方式指向程序，而不是自检脚本**
- 开始菜单 `AIDriven NetDefense\AIDriven NetDefense.lnk` → `<安装目录>\AIDrivenNetDefense.exe`
- 桌面 `AIDriven NetDefense.lnk` → 同一个 exe
- 自检降级为二级菜单：`AIDriven NetDefense\诊断\自检.lnk` → `启动-自检.cmd`
- 装 `安装目录.lnk` 仍留在开始菜单一级

exe 的位置不写死：安装器按 `AIDrivenNetDefense.exe`、`app\`、`console\`、`bin\`、
`app\console\`、`app\bin\` 的顺序在载荷/安装目录里解析，命中路径写进 `install.json` 的 `desktopExe`。
找不到 exe 就在复制前直接报错 —— 这样 v13 的 `packaging-poc` 载荷不会被误装。

**4. 开机自启可选，默认关**
GUI 有「开机自动启动」勾选框（默认不勾）；静默用 `/AUTOSTART`。
写的是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `AIDrivenNetDefense` 值，
卸载时**无条件**清除，避免留下指向已删 exe 的死项。

**5. 卸载先杀进程再删文件**
按 `ExecutablePath` 与 `CommandLine` 双条件匹配安装目录（命令行匹配能抓到 daemon 的 node 子进程），
再把匹配集合的子进程树一起结束（先杀子后杀父，防止 supervisor 复活）。
删除时保留 `data\` / `install\` / 旧版 `dsh-home\` 由用户在弹窗里选择；
静默卸载 `/S /uninstall` 默认全删。

## 实现要点

- 不用 `csc.exe`（本机策略禁用），也不用 Inno/NSIS/WiX（未安装）；纯 PowerShell，系统自带即可跑。
- 非管理员时卸载键写 `HKCU`，避免静默失败；管理员时写 `HKLM`。
- 安装时把 `Setup.cmd` / `Setup.ps1` 复制进 `<安装目录>\installer\`，
  卸载入口因此不依赖原始解压目录是否还在。
- 自检脚本 `启动-自检.cmd` 由安装器生成，负责满足 worker 的四个前置条件：
  `HOME`、`USERPROFILE`、`TMP/TEMP`、`DSH_HOME`、`AEGIS_SESSION_ROOT` 必须是绝对且按次隔离，
  且 `AEGIS_ANALYSIS_CWD` 必须**逐字符等于**进程 cwd（worker 用字符串比较，不做路径归一化）。

## 构建

```bat
build-dist.cmd
```

默认读仓库内 `<repo>\vendor\payloads\win32-x64-v14`，
输出仓库内 `<repo>\dist\installer\0.0.1-rc.1\` 与 `<repo>\dist\installer\0.0.1-rc.1.7z`。
两个默认值都由 `%~dp0` 反推（`..\..\..` → 仓库根）得到，脚本内不再出现任何绝对路径。
`build-dist.cmd` 会先检查载荷里有没有 `AIDrivenNetDefense.exe`，没有就退 3，不会产出装不出程序的包。

## 静默模式（冒烟测试用）

```bat
Setup.cmd /S /DIR="D:\tmp\aidn-test" /NOREG
Setup.cmd /S /DIR="D:\tmp\aidn-test" /NOREG /AUTOSTART
Setup.cmd /S /uninstall /DIR="D:\tmp\aidn-test" /NOREG
```

`/NOREG` 跳过卸载注册表键，用于不污染真实系统。
`/NOSHORTCUT` 跳过全部快捷方式，`/AUTOSTART` 才写开机自启项。

测试用环境变量（正常使用不要设）：
- `AIDN_SETUP_DEFAULT_DIR` —— 覆盖「默认安装目录」，让验收脚本不必碰 `%ProgramFiles%`
- `AIDN_SETUP_TEST_DOTSOURCE=1` —— 只加载函数、不启动 GUI，供函数级断言使用

## 明确不做

- 不签名、不写 Program Files 以外的系统位置、不注册服务、不写 ProgramData、不改 PATH
- 不校验 `manifests/files.sha256`（属于 G4 完整性门禁，安装器当前只做文件复制；
  需要校验时先跑 `payload\manifests` 侧的全量校验）
- 不做增量更新与回滚（ADR 的升级/回滚属于 P1 正式工程）
