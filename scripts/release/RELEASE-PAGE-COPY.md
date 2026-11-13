# AIDriven NetDefense 0.0.1-rc.5 · 下载与安装（发布页正文前置段）

> 本段写给**第一次用**的人。未签名是设计事实，不是安装包损坏。
> 作者 / author: `PT-dove` · 仓库 / repo: `AIDriven-NetDefense`

---

## 1. 两个包，选一个（30 秒）

| 你想要 | 下这个 | 大小 | 大概多久 |
|---|---|---|---|
| 开始菜单有图标、「应用和功能」里能卸载 | `AIDrivenNetDefense-Setup-0.0.1-rc.5.exe` | 67.9 MB | 安装 8–12 分钟 |
| 只想试一下，不想动系统（不写注册表、不建服务） | `AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip` | 148.4 MB | 解压 1–3 分钟 |

- 系统：**Windows 10 / 11 x64**。rc.5 在 Windows 11 x64 上验证过；**Windows 10 未验证**（如实说明，不吹）。
- 便携版里也有一个要双击的 `AIDrivenNetDefense.exe`，它**同样**会被 SmartScreen 拦一次，处理方式见第 3 节。
- 两个包**功能一样**，区别只在"装进系统"还是"解压即用"。

## 2. 先校验（可选，但建议；约 30 秒）

本页两个文件的 SHA256（与随页发布的 `SHA256SUMS.txt` 应逐字相同）：

```text
ca0297d0f4e8e7941ba1c3c2910e02380f01df5ae70289b2bcb91f9c6070884a  AIDrivenNetDefense-Setup-0.0.1-rc.5.exe
58491004e6dc76f94983a8c67f3146e74277b88caa405ac26ec5f4427c853366  AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip
```

Windows 自带命令（把文件名换成你下载的那个）：

```bat
certutil -hashfile AIDrivenNetDefense-Setup-0.0.1-rc.5.exe SHA256
```

两边一致 → 文件完整；**不一致就不要运行**，重新下载。
（SHA256 只证明"文件没被改坏"，不证明"发布者可信"——本版没有代码签名，见第 3 节。）

## 3. SmartScreen：一定会出现，这是预期

未签名 → Windows 不认识发布者。你会看到：

```text
Windows 已保护你的电脑
Microsoft Defender SmartScreen 阻止了无法识别的应用启动。
运行此应用可能会导致你的电脑存在风险。
        发布者：未知发布者
        [ 不运行 ]   [ 更多信息 ]
```

（Windows 10 / 11 的措辞略有差异，英文系统显示 "Windows protected your PC / Unknown publisher"。）

操作：点 **「更多信息」** → 右下角出现 **「仍要运行」** → 点它。
浏览器下载时若提示"不是常见下载"，选 **「保留 / 仍然保留」**。

- 本项目**不会**提供任何"绕过 SmartScreen"的脚本或教程，也不购买证书：这是已接受的风险。
- 想确认发布者：右键文件 → 属性 → 详细信息，`CompanyName = PT-dove`、`ProductName = AIDriven Net Defense`、`ProductVersion = 0.0.1-rc.5`。

## 4. 安装：默认目录**需要管理员权限**（最容易卡住的一步）

双击 `Setup.exe` **不会**弹 UAC（安装器以普通用户权限启动）。装到默认的
`C:\Program Files\AIDriven Net Defense` 时，普通权限写不进去。

- **推荐做法**：右键 `Setup.exe` → **「以管理员身份运行」**（此时才会弹 UAC，点"是"）→ 装到默认目录。
- 或者：安装窗口里把路径改成你有写权限的目录（例如 `D:\Apps\AIDriven Net Defense`）。
- 如果都不做：安装会先解压几百 MB，然后报 **`[WinError 5]` / "失败 / Failed"**。
  不会留下半成品安装，可以安全重试。

静默安装（给自动化用）：

```bat
AIDrivenNetDefense-Setup-0.0.1-rc.5.exe /S /DIR="D:\Apps\AIDriven Net Defense" [/AUTOSTART] [/NOSHORTCUT] [/NOREG]
```

## 5. 第一次打开：看到「降级」和 0 条告警，是预期，不是装坏了

- 概览页健康状态显示 **「降级 / degraded」**、原因 **`sources:none`**：
  rc.5 的桌面壳以 **mock 模式 + 0 个采集源**运行，所以它**没有真实数据**。这是本版已知限制。
- 告警页 **0 条**：同上，不是没装上。页面里有「检查采集」「配置模型」两个入口。
- 模型（可选，可跳过）：设置或 Agent 页会显示 **「未注册任何模型」**。不配也能浏览界面；
  配了才能用 Agent 能力。包内不附带任何 API Key 或模型权重。

## 6. 卸载

- 正常入口：**设置 → 应用 → 已安装的应用 → AIDriven Net Defense → 卸载**
  （或「应用和功能」里同名条目）。
- **rc.5 已知问题**：从"应用和功能"点卸载**可能没有任何反应**。原因：卸载器需要管理员权限，
  非提权运行时会在写日志后直接退出，而它在无控制台模式下没有可见提示。绕法二选一：

  a) 打开安装目录里的 `installer\` 子目录，右键
     `AIDrivenNetDefense-Setup-0.0.1-rc.5.exe` → **「以管理员身份运行」** → 选"卸载"；

  b) 管理员命令行：

  ```bat
  "C:\Program Files\AIDriven Net Defense\installer\AIDrivenNetDefense-Setup-0.0.1-rc.5.exe" /S /uninstall /DIR="C:\Program Files\AIDriven Net Defense"
  ```

- 卸载器会校验归属凭据：**目录不是本安装器装的会被拒绝**并说明原因（rc.5 新行为，防止误删）。
- 卸载后会保留：`%LOCALAPPDATA%\AIDriven Net Defense\`（设置、事件库、日志）。
  要彻底清除，请手动删除该目录；安装器镜像会在**重启后**自动消失。

## 7. 已知限制（本版）

- **未签名**：见第 3 节。
- 只有 **Windows x64**。
- 桌面壳数据是 **mock + 0 采集源**，`/healthz` 报 `degraded` 是诚实值。
- 界面 7 种语言里中文 / English 完整，ja / ko / es / ru / th 是英文占位（已标注 `_machine: true`）。
- **更新检查未接线**：本版不会自动更新，也不会发出更新请求。
- 提权安装验收在本版**未完成**（UAC 无人应答被系统取消），非提权端到端安装/卸载已实测通过。

---

<details>
<summary>English summary (short)</summary>

Unsigned pre-release. SmartScreen will warn — that is expected: click **More info → Run anyway**,
then verify SHA256 (`certutil -hashfile <file> SHA256`) against the values above.
Installing into `C:\Program Files` needs elevation: **right-click Setup.exe → Run as administrator**
(double-click does not raise UAC, and a non-elevated install fails with `WinError 5` after extraction).
First launch shows `degraded / sources:none` and zero alerts because rc.5 ships a mock daemon with
no collectors — that is expected, not a broken install. To uninstall: if "Apps & features" does
nothing, right-click `installer\AIDrivenNetDefense-Setup-0.0.1-rc.5.exe` → Run as administrator → Uninstall.
`%LOCALAPPDATA%\AIDriven Net Defense` is kept after uninstall; delete it manually for a full wipe.

</details>
