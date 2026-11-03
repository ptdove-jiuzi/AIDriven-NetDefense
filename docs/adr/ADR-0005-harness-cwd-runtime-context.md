# ADR-0005：`working-directory` 的 cwd 运行时上下文——接受还是去除（HAR-UPSTREAM-002）

- 状态：**Accepted（2026-11-02）**
- 关联发现：四层校验证据 `harness-validation.json` 的 `exactErrors[7]`「model: runtime context is still contributed by working-directory」
- 相关：`plugins/dsh-defense-profile/{profile.json,cordis.patch.yml}`、`packages/harness-adapter/validate.js:175-176`、`tests/wp0/harness/runtime.test.js:201-204`、`docs/design/HARNESS_PROFILE_CONTRACT.md` §2/§3
- 作者：PT-dove

## 1. 问题事实（全部可复核）

### 1.1 上下文不是 `system-prompt` 加的

profile 已经把 `system-prompt` 配成 `includeRuntimeContext: false`、`includeHarnessIdentity: false`，
但校验仍报"runtime context is still contributed by **working-directory**"。原因是贡献者另有其人：

| 上游文件:行 | 事实 |
|---|---|
| `node_modules/@deepseek-ai/dsh-working-directory/lib/index.js:13` | `static inject = ["fs", "sessionProjections", "systemPrompt"]` |
| 同上 `:45-53` | `ctx.systemPrompt.context({ name: "working-directory:current", order: WORKING_DIRECTORY, required: true, interpolate: false, text: … })` |
| 同上 `:55-69` | `ctx.on("system-prompt/assemble", …)` 且 `{ prepend: true }`：把该 context **强制前置**进装配结果，缺失则 `unshift` |

即：`required: true` + `prepend: true` 使这条上下文**无法由 profile 配置关掉**。
`includeRuntimeContext: false` 只能关掉 `system-prompt` 自己那份，管不到别人注入的 context。

### 1.2 校验器把它判为失败

```js
// packages/harness-adapter/validate.js:175-176
if (policy.effectiveConfig.runtimeContextsEmpty && (model?.runtimeContexts ?? []).length !== 0) {
  errors.push('model: runtime context is still contributed by working-directory');
}
```

`profile.json` 的 `effectiveConfig.runtimeContextsEmpty: true`，于是这条必然失败。

### 1.3 但 `working-directory` 插件不能删

`sdk-jsonrpc-server` 需要 `workingDirectory` 服务（合同 §2 第 20 行、§3 末段），
`filesystem` 与 `session-projection` 也围绕它工作。删插件 = worker 起不来。

## 2. 两个可选方案

### 方案 A（推荐）：接受这一条上下文，但把它变成**受约束、可断言的单一项**

做法：把"必须为空"改成"必须**恰好等于**声明的那一项"。

- `profile.json`：`effectiveConfig.runtimeContextsEmpty: true` →
  `effectiveConfig.runtimeContextAllowlist: ["working-directory:current"]`（并保留
  `runtimeContextsEmpty` 作为历史字段删除，或改为 `false` 并说明由 allowlist 取代）。
- `validate.js:175-176`：改为
  1. `runtimeContexts` 长度必须为 **1**；
  2. 唯一项的 `name` 必须等于 allowlist 中的名字；
  3. 其 `text` 必须**等于**声明值（见下），不得含用户名/用户目录/任意自由文本。
- 新增绑定约束（关键，否则等于放行任意路径外泄）：
  broker 创建的分析 cwd 必须是**中性根下的每分析空目录**，例如
  `%ProgramData%\AegisHarness\analysis\<uuid>`（Linux：`/var/lib/aegis/analysis/<uuid>`），
  **禁止**落在用户 profile（`<USERPROFILE>`）或仓库目录下；WP0 断言 `text` 与该声明值逐字符相等。
- 变异矩阵：现有 `runtime context` 变异（`runtime.test.js:201-204` 往 `runtimeContexts` 塞
  `{name:'working-directory:current', text:'cwd'}`）**必须重新定义**，否则实施后会变成"合法值被误杀"
  或"变异杀不掉"。新变异应至少三条：① 多一条非 allowlist 的 context → 失败；
  ② 同名但 `text` 不等于声明值 → 失败；③ `text` 含 `<USERPROFILE>` 前缀 → 失败。

### 方案 B：用受控 patch 去掉这条上下文

做法：不加载上游原包，改为仓库内 vendored/patched 版本（去掉 `:45-69` 的 context 注册与 assemble 钩子），
或对 `dsh-working-directory` 施加字节级 patch。

**代价（逐项列出，因为这是不推荐的全部理由）**：

1. **哈希与完整性体系被打破**：`approved-hashes.json`、SBOM 的 `hashes`、`package-lock.json` 的
   `integrity` 全部与实际文件不符。要么把 patch 后的文件也纳入自有哈希清单（等于自建一套完整性基准），
   要么放宽完整性校验——后者直接摧毁 `package integrity mutation` / `package integrity downgrade`
   两个变异的前提。
2. **升级影响不可控**：上游每次 bump 都要重放 patch；patch 一旦与上游改动冲突，
   冲突点落在"安全相关的那 25 行"上，最容易被人草率处理。
3. **与合同冲突**：合同 §2 对 `working-directory` 的描述是"defaultDirectory=每分析空目录 /
   SDK 必需服务 / 不注册对应工具"——它**接受该插件在场**，只是 `effectiveConfig` 里写了
   `runtimeContextsEmpty: true`。方案 B 是用改上游代码去迁就一个配置字段，方向反了。
4. **证据成本**：四层清单、`harness-package-layer.json` 的文件哈希、许可证据全要重做，
   且从此"包层"不再是纯上游产物，独立审查者无法再用上游 tarball 逐字节比对。

## 3. 决策

**采纳方案 A，并附加 §2 中三条绑定约束（单一项、名字匹配、文本必须等于中性根下的每分析空目录）。**

理由：方案 A 不修改任何上游字节，因此
- 包层/插件层/服务层三层的哈希与上游可比对性**完全保留**；
- 升级影响 = 只核对"上游是否仍注册这一个 context"，是**读**而非**改**；
- 真正的风险（路径外泄）用"值必须等于声明值 + 中性根 + 三条变异"来封，而不是靠删掉功能。

同时必须承认方案 A 的**残余风险**：模型仍会看到一个本机绝对路径。它泄露的是
"部署根 + 一个 UUID"，在"分析 cwd 用中性根"的约束下不含用户名与用户数据；
但这**是**一条真实的信息面，必须写进 `HARNESS_PROFILE_CONTRACT.md` 与发布说明，
不得宣称"零运行时上下文"。

## 4. 证据与升级影响（方案 A）

| 项 | 影响 |
|---|---|
| 包哈希 / SBOM / lockfile | **零变化**（不碰上游包、不加依赖） |
| `profile.json` | 1 个字段语义变化（`runtimeContextsEmpty` → allowlist） |
| `validate.js` | 1 处断言从"必须为空"改为"必须恰为声明项"，**更严**（从 0 条放宽到 1 条，但对该条做三重校验） |
| 变异矩阵 | `runtime context` 变异重定义为 3 条（见 §2）；`killedMutants` 数量只增不减 |
| 四层证据 | 四层清单由生成器重算；`harness-validation.json` 的 `exactErrors` 少一条 |
| 升级影响 | 上游 bump 后核对 `working-directory/lib/index.js` 的 context 名与 `required/prepend` 是否变化；变化即本 ADR 失效 |
| 四 OS | 仍只有 Windows 证据；Ubuntu/Debian 未跑，本 ADR 不随之下关闭 |

## 5. 关闭条件

1. 独立只读审查 PASS（审查者不得是实现者）；
2. 维护者批准方案 A 与"分析 cwd 必须位于中性根"这条产品约束；
3. 实施后 `exactErrors` 中不再出现该条；`runtimeContexts` 长度恒为 1 且文本等于声明值；
4. 三条新变异均能失败（并保留原 `killedMutants` 全部仍能失败）；
5. 合同 §2/§3 与发布说明写明"存在一条 cwd 上下文"这一事实；
6. 只有 Windows 证据 → 只能写"Windows 通过"。

## 6. 与冻结基线的关系

本 ADR 记录的是后续阶段的准备方案。冻结基线当时为 NO-GO，不得据此修改 profile
或重生成四层证据。

## 7. 独立只读审查结论（2026-11-02）→ **ACCEPT-WITH-CHANGES**

"不 fork 上游"的方向获认可，但**本文最关键的论断被现有证据直接推翻**，方案 A 的落地方式必须重做。

### 7.1 致命问题：三重校验的校验对象恒为 `""`

`runtimeContexts` 由 `plugins/dsh-defense-tools/lib/runtime-inspect.js:161` 在 **worker 启动、无 agent**
时 `systemPrompt.assemble({})` 采集。而上游 `working-directory/lib/index.js:53` 有
`if (context.agent === void 0) return next();`，注册回调的 `text` 因此返回 `""`。

实测证据（四层校验证据 `harness-four-layer-exact.json`）：

```json
"runtimeContexts": [{"name":"working-directory:current","text":"","interpolate":false}]
```

而 `dsh-system-prompt/lib/index.js:148-156` 的 `renderContextSections` 会 `.filter(text.length > 0)`
把它丢掉 —— **探针那一刻模型其实什么都没收到**。

后果：
- 声明值取**真实 cwd** → 探针永远拿到 `""` → 方案 A 实施后 `exactErrors` 仍有该条，**不可达成**；
- 声明值取 **`""`** → 校验恒真，对真实请求**零约束**（真实路径走 `agent-loop` 每请求 `refreshContext`）。

**结论**：现有 `exactErrors[7]` 在探针语义下是**误报**，真正的每请求泄露是**未检测**。
本文把两件事当成一件，是根本缺陷。修法二选一：
(a) 把采集点搬到**有 agent** 的会话（需改 `runtime-inspect.js`，而它在 `approved-hashes.json` 内）；
(b) 在 **broker 侧**对实际请求体（`system` + 首条 user content）做断言。
→ 本文 §4「只动 `profile.json` + `validate.js`」**不成立**。

### 7.2 §3 残余风险论断不成立

本文写"泄露的是部署根 + UUID，不含用户名与用户数据"。审查者从
`harness-context-overflow.json` 取到真实请求体文本：

```
Current working directory: "<TEMP>\\aegisharness-wp0b-XXXXXX\\work\\attempt\\cwd".
```

**含 OS 用户名**（历史原文的第二段路径就是本地用户目录名）。`contextText()`（上游 `:125-127`）
本身只输出一句 + JSON 化路径，这一点本文说对了；但路径来自 `AEGIS_ANALYSIS_CWD`，
当前实现落在 `%TEMP%`（含用户名），“中性根”是本文**新提出的待实现约束**，不是既成事实，
而 §4 影响表完全没写这条。

另两条本文未提的通道：
- `ensure()`（`:91-107`）在 cwd 不存在时回退到 `session.header.cwd ?? defaultDirectory`，
  `commit()`（`:138-156`）注入一条 **user message**（"changed from X to Y" / "is unavailable"），
  **两个路径都进模型**，且不在 `runtimeContexts` 里；
- 首条 `session.header.cwd` 是调用方原始项目路径 —— 一旦触发恢复，模型看到的是用户仓库路径，
  "逐字符等于声明值"会**要么误杀整个分析、要么静默泄露**。

### 7.3 三重校验不足

1. **"text 等于声明值"是自证**：声明值来自环境变量，而 `preflight.js:47-53` 只要求 `isAbsolute`
   且 `=== process.cwd()`，**不禁止** `<USERPROFILE>` 下的路径。必须改为**结构性谓词**
   （落在中性根 + 匹配 `^Current working directory: "<neutral>/[0-9a-f-]{36}"\.$`）。
2. **转义陷阱**：真实文本里路径分隔符是双反斜杠（`JSON.stringify` 产物）。按直觉写
   `text.includes('<USERPROFILE>')` 或转义串会得到相反结果 → §2 的变异 ③ **杀不掉**。
   正确做法是 `JSON.parse` 后按结构断言，不做整串比较。
3. **未校验** `interpolate === false`、`required === true`、`order`。若上游某版去掉
   `interpolate:false`，`renderContextSections:152` 会对文本做变量插值，三查全真但文本可被改写。
4. **"单一项"挡不住多 provider**：`register` 只防同名字段重复，不限制字段数量；
   `allowedPluginIds` 只约束"哪些插件进树"，不约束"已进树的插件注册几个字段"。

### 7.4 本文对方案 B 的成本估算方向错误

| 本文原述 | 审查实测 |
|---|---|
| "`approved-hashes.json` 全部与实际文件不符" | 该文件**只覆盖 6 个仓库内文件**，**0 条**该包记录 |
| "会摧毁 `package integrity mutation`/`downgrade` 两个变异的前提" | **错**。两个变异只改清单 JSON 的 `integrity` 字段，`validatePackages` 只校验**格式**、从不比对磁盘字节；patch 后照常通过 |
| "`filesystem`/`session-projection` 也围绕它工作" | 夸大。grep 显示只有 `sdk-jsonrpc-server` 真正依赖 `workingDirectory`（`:505` inject） |

→ 方案 B 的机械成本**低于**本文估计；但本文"不应 fork 上游"的**方向性**结论仍成立
（与 `THIRD_PARTY_NOTICES:50`「shipped unmodified, as published on the npm registry」这条
事实性陈述冲突，B 会让它变成假话）。

### 7.5 本文遗漏的必改项

1. **与设计不变式 D2 冲突**：`docs/design/SOFTWARE_DESIGN.md:194` 明确"用户名、路径默认不出域；
   只有显式授权的派生字段可出域"。本文未引用 D2、未申请例外 —— "写进发布说明"≠"取得授权"。
   方案 A 实质是给 D2 开默认放行的口子，**必须走显式例外**。
2. `scripts/harness-check-manifest.mjs:19` — `assert.ok(validation.exactErrors.some(e => e.includes('runtime context')))`：
   与本文 §5 关闭条件 3 **直接矛盾**，必须先改该断言。
3. `tests/wp0/harness/runtime.test.js:58`、`:83` 是正向断言该错误存在，实施后必红。
4. **中性根会连带打红 29 个 WP0 测试**：现测试沙箱 cwd 就在 `%TEMP%`（含用户名），
   加"不得位于 USERPROFILE"规则后 `createTestSandbox`/`helpers.js` 必须改路径，证据全重跑。
5. 改 `profile.json` 必须重生成 `approved-hashes.json`（它在清单内，`preflight.js:16-28` 逐文件比对）。

### 7.6 修正后的建议

- 方案 A 保留，但**校验对象从 `model.runtimeContexts` 移到 broker 侧的实际请求体**；
- "中性根"从口头约束升级为 `preflight` 规则 + 可失败变异；
- 关闭条件补三条（现有关闭条件一条都没覆盖"模型实际看到了什么"）：
  ① 每个分析的请求体中路径只出现声明的那一行且匹配中性根正则；
  ② `ensure()` 回退与 `commit` notice 文本在同一断言内覆盖；
  ③ `interpolate === false` 被断言；
- 与 ADR-0004 联合评审：`dsh_session_log` 会把同一个 cwd 随每次请求送出，
  两份 ADR 是同一泄露面的两条通道，**必须联合关闭**。

## 8. 实施记录（2026-11-02，Windows 11 x64）

### 8.1 落地形态（比 §2 更严）

`profile.json` 的 `effectiveConfig` 删除 `runtimeContextsEmpty`，写入四个键：

| 键 | 值 | 作用 |
|---|---|---|
| `runtimeContextAllowlist` | `["working-directory:current"]` | 封闭白名单，长度必须恰 1 |
| `analysisCwdRoots` | `{"win32":"C:\\ProgramData\\AegisHarness\\analysis","linux":"/var/lib/aegis/analysis"}` | 中性根；不得含用户名/仓库路径 |
| `runtimeContextTextTemplate` | `Current working directory: "{cwd}".` | 再渲染必须与原文**逐字符相等** |
| `extensionFields` | `["dsh_session_log","dsh_plugin_packages"]` | 与 ADR-0004 的字段封闭联动 |

`validate.js` 的断言：长度恰 1 → name 命中 allowlist → `interpolate === false` → 模板再渲染逐字符相等 →
cwd 绝对 → 拒绍含 `..` 的非规范路径 → `resolve()` 后必须在 `analysisCwdRoots[platform]` 下 →
不含 `Users` / `home` / `AppData` / 仓库根目录名。

### 8.2 §7.1 的致命问题已修：探针拿得到真实 text

`runtime-inspect.js` 改为用**最小桩 agent** 调 `systemPrompt.assemble({agent})`，使上游
`working-directory` 的 `context.agent === void 0` 早退不再触发。实测证据：

```json
[{"name":"working-directory:current",
  "text":"Current working directory: \"C:\\\\ProgramData\\\\AegisHarness\\\\analysis\\\\aegisharness-wp0b-XXXXXX\\\\work\\\\attempt\\\\cwd\".",
  "interpolate":false}]
```

修复前是 `text: ""`。`AEGIS_RUNTIME_MANIFEST` 门控保留，桩不进入真实请求装配链路。

### 8.3 三条变异（§2）已并入矩阵，全部可杀

| 变异 | 结果 |
|---|---|
| 多一条非 allowlist context | `model: runtime context count must be exactly 1` |
| 同名但 `text` 不等于声明值 | `model: runtime context text does not match template` |
| `text` 含 `<USERPROFILE>` 前缀 | `outside the neutral analysis root` + `leaks a user or repository path` |

`killedMutants` 15 → 19（拆 1 为 3，另加 2 条扩展字段变异），逐名钉在 `harness-check-manifest.mjs`。

### 8.4 未覆盖与残余风险（不得宣称"零运行时上下文"）

1. **只有探针点被约束**：真实每请求的 cwd 由 `agent-loop` 每请求 `refreshContext` 写入，
   **broker 侧对实际请求体的断言仍未实现**（§7.6 ②③）。当前"中性根"由沙箱路径保证，不是由请求期断言保证。
2. `required === true` 与 `order` **不可观测**：运行时快照里没有这两个字段，未断言；上游若去掉
   `prepend`/`required`，现有断言不会红，只能靠升级时人工核对。
3. `ensure()` 回退与 `commit` notice 两条通道（§7.2）仍未覆盖。
4. **四 OS**：`analysisCwdRoots.linux` 只被静态定义，从未执行；Ubuntu 22.04/24.04、Debian 12 未跑。
5. §7.2 引用的历史请求文本（`%TEMP%\…` 下的用户目录路径）来自**修复前**的
   `tests/wp0/evidence/harness-context-overflow.json`。该文件在收口时被重跑覆盖为中性根现值，
   历史原文以本节与 §7.2 的引用为准。
