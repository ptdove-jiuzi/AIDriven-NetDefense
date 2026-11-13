# Security Policy / 安全策略

Product: **AIDriven NetDefense**（网域智防）· internal scope `@aegisharness/*` · author/contact **PT-dove**
Status at time of writing: `0.0.1` in development. **No release has been published.**

---

## 1. 适用范围与支持状态 / Scope and support

`0.0.1-rc.5` 候选包已在开发机构建完成，五个产物位于 `dist/release/0.0.1-rc.5/`：

| 产物 | 字节数 | sha256 |
|---|---|---|
| `AIDrivenNetDefense-Setup-0.0.1-rc.5.exe` | 67,860,347 | `ca0297d0…0884a` |
| `AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip` | 148,442,689 | `58491004…3366` |
| `latest.json` | 8,371 | — |
| `RELEASE-NOTES.md` | 7,534 | — |
| `SHA256SUMS.txt` | 223 | — |

但**这些产物没有对外发布**：仓库 `ptdove-jiuzi/AIDriven-NetDefense` 目前是公开仓库，
release 数 **0**、tag 数 **0**（核对方法见 `evidence/docs/privacy/07-reporting-flow.txt`）。
因此本文件支持的是**源码与本地候选构建**，不是“已发布的受支持版本”。

| 版本 | 状态 | 安全修复 |
|---|---|---|
| `0.0.1-rc.5`（本地候选构建） | 当前唯一构建快照 | 只针对此快照接收报告 |
| `0.0.1-rc.1` … `rc.4` | 历史候选包，已被 rc.5 取代 | 不再单独修复 |
| 更早的 `0.0.0` / WP0 基线 | 无 | 不支持 |
| 正式 `0.0.1` | 未发布 | — |

前提与限制（请勿当作“已保证”）：

- 两个包**未做代码签名**，Windows SmartScreen 可能告警；校验请以 `SHA256SUMS.txt` 与 `latest.json` 为准。
- **更新检查未接线**：常量 `AUTO_UPDATE_ENABLED = 0`（`apps/desktop/updater/constants.py:24`），
  唯一读取点是 `apps/desktop/updater/engine.py:146`，而更新器**没有被壳装配**——
  壳入口 `apps/desktop/main.py:32-33` 只装配 `aidn.app.ShellController`，`apps/desktop/aidn/**` 里没有任何
  `updater` 引用。因此运行时不存在这条出站路径，本版不会自动更新，也不存在“自动升级”这种修复通道。
- 本项目由单人维护，不提供 SLA、不提供漏洞赏金、不代表任何第三方机构的认证结论。
- 本仓库**没有**声称“绝对安全”“零风险”。可核对的边界与机制见
  [`docs/install/privacy-security.md`](docs/install/privacy-security.md)，逐条 `file:line` 证据见
  `evidence/docs/privacy/findings.md`。

---

## 2. 报告漏洞 / Reporting a vulnerability

### 2.1 现在实际能走通哪条路（结论）

三条路径按优先级排列，**第 1 条是否可用尚未验证**，第 2 条是当前确定可用的替代路径：

1. **GitHub 私有漏洞报告（Private vulnerability reporting / advisory）** —— 首选。
   若 `https://github.com/ptdove-jiuzi/AIDriven-NetDefense/security/advisories`
   页面上出现 **“Report a vulnerability”** 按钮，直接用它提交，内容仅维护者可见。
   **现状（未验证）**：匿名访问该页面时看不到该按钮，仓库 API 对未认证请求也不返回
   `security_and_analysis` 字段（值为 `null`），所以**无法从外部确认它是否已启用**。
   该功能需要维护者在 **Settings → Code security → Private vulnerability reporting** 打开；
   在打开之前，第 1 条路径可能直接不存在。
2. **最小化公开 issue（确定可用）** —— 仓库 `has_issues=true`，公开 issue 一定可用。
   只写一句话请求私下渠道，**不要**写复现步骤、影响范围、日志或任何技术细节：
   > “I have a security report for AIDriven NetDefense. Please provide a private channel
   > (or enable Private vulnerability reporting) and I will send the details there.”
3. **通过 GitHub 上的维护者资料页联系 PT-dove**（`https://github.com/ptdove-jiuzi`）。
   这是账号级联系，不保证及时，也不保证能附带附件。

**不要**把未修复漏洞的细节直接开成公开 issue。若你已经公开了，请仍按上面任一渠道私下通知，
以便评估影响并安排修复。

### 2.2 报告里请包含

- 受影响的构建：`0.0.1-rc.5` 的哪个产物 + 其 sha256（或源码提交）；安装版 / 便携版。
- 环境：Windows 版本、是否管理员、数据目录是否被改过。
- 影响：能读到什么、能改什么、是否能造成外联或越权；是否已实际触发。
- 最小复现：只用**临时目录 + 合成数据**的步骤；若可能，附一条可判定的期望/实际对比。
- 你希望如何署名（默认致谢；可要求匿名）。

### 2.3 绝对不要包含

- 真实 API Key、Bearer token、`data\secrets\` 下的任何内容；
- 真实用户的安全日志、个人数据、未脱敏截图；
- 对你没有所有权或明确授权的系统做的测试结果。

### 2.4 处理预期（best effort，不是承诺）

- 首次回复不承诺时限；确认后会在下一个候选包或发布说明中记录修复与致谢。
- 不签发 CVE、不提供赏金、不提供法律意见。
- 若报告涉及已发布产物，修复以新构建 + 校验和更新的方式交付（本版无自动更新通道）。

---

## 3. 已知安全边界（摘要）

- **唯一的出站方向是模型调用，且默认关闭**：`egressEnabled=false` + provider `enabled=false` + 默认无凭据；
  rc.5 产物中甚至没有打包 model-broker，因此当前没有可达的模型出站路径
  （`apps/daemon/src/api/settings-schema.js:121`、`:127`；`evidence/docs/privacy/09-defaults-and-payload.txt`）。
- **更新检查未接线**：`AUTO_UPDATE_ENABLED = 0`（`apps/desktop/updater/constants.py:24`），
  唯一读取点 `apps/desktop/updater/engine.py:146`；更新器未被壳装配
  （`apps/desktop/aidn/**` 零引用，`apps/desktop/main.py:32-33` 只装配 `ShellController`）
  → 运行时没有这条出站路径。
- **daemon 只绑字面回环**，通配/主机名地址拒绝启动（`apps/daemon/src/config.js:174`、`:260`）。
- **明文 HTTP、无 TLS、无 OS 沙箱、无代码签名、单用户假设**——这些是已知边界，不是待办承诺。
- 桌面壳默认 `mode=mock` 且 0 采集源，`/healthz` 报 `degraded` 是**诚实值**，不是故障。

---

## 4. 测试与处理要求 / Test and handling requirements

- 测试不得读取、清空或修改真实用户数据与安全日志；只用临时目录与合成数据。
- 快照类守卫必须在测试临时目录里显式配置一个 mock 真实目录，并在前后差异出现时失败。
- 不得启用自动更新、不得自动弹 UI。
- 依赖版本、解析地址、完整性哈希、许可证与生成的 SBOM 必须可复现、可审查。
- 不要把“本机通过”写成“安全已证明”：未运行的测试、未观测的行为必须标注未验证。

---

## 5. 身份与署名 / Attribution

项目作者与安全联系人为 **PT-dove**。上游与第三方版权声明归各自所有者；
`LICENSE` 现为 Apache-2.0 官方全文 + 附录版权行，第三方许可清单见 `NOTICE`、`THIRD_PARTY_NOTICES`；
许可与 SBOM 的机器校验（`npm run license:check`、`npm run sbom:check`）当前 exit 0。
