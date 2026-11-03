# ADR-0004：为 `deepseekLlmApiExtensions` 增加唯一 provider（HAR-UPSTREAM-001）

- 状态：**Accepted（2026-11-02）**
- 关联发现：四层校验证据 `harness-validation.json` 的 `exactErrors[4]`「services: required provider deepseekLlmApiExtensions is absent」
- 相关：`plugins/dsh-defense-profile/profile.json`、`cordis.patch.yml`、`packages/harness-adapter/validate.js`、`docs/design/HARNESS_PROFILE_CONTRACT.md` §2
- 作者：PT-dove

## 1. 问题事实（全部可复核）

profile 的 `requiredServices` 已声明 `deepseekLlmApiExtensions`，`requiredServiceProviders` 把它映射到
`include:deepseek-llm-api-extensions`，但 `cordis.patch.yml` 里**没有**这个 id 的插件条目，`allowedPluginIds`
里也没有它。因此四层校验必然报三类错：

```
services: required provider deepseekLlmApiExtensions is absent
services: include:session-log-deepseek inject deepseekLlmApiExtensions is unresolved
services: include:plugin-package-inventory-deepseek inject deepseekLlmApiExtensions is unresolved
```

这不是 profile 写错，而是**上游两个必需插件真的 inject 这个服务**：

| 上游文件:行 | 事实 |
|---|---|
| `node_modules/@deepseek-ai/dsh-session-log-deepseek/lib/index.js:15` | `const inject = ["deepseekLlmApiExtensions", "sessions"];` |
| 同上 `:139` | `ctx.deepseekLlmApiExtensions.register("dsh_session_log", { prepare: … })` |
| `node_modules/@deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js:19` | inject 列表含 `"deepseekLlmApiExtensions"` |
| 同上 `:146` | `ctx.deepseekLlmApiExtensions.register("dsh_plugin_packages", { prepare: … })` |

服务本体由 `@deepseek-ai/dsh-deepseek-llm-api-extensions@0.2.2-alpha.2`（MIT，`lib/index.js` 共 110 行）
提供：`DeepSeekLlmApiExtensionRegistry extends Service`，服务名 `deepseekLlmApiExtensions`
（`lib/index.js:39/44`），能力是 `register(field, provider)`（`:52`）——**按顶层请求字段注册 provider**。

同时，校验器已经**要求**该 registry 存在：

```js
// packages/harness-adapter/validate.js:197
if (route.extensionProviderPresent !== true) errors.push('model: DeepSeek extension registry is absent');
```

结论：在当前上游版本下，"不加 provider"与"四层校验通过"**逻辑互斥**。冻结合同本身已经把
"extension registry 必须在场"写成了验收条件，缺的只是 profile 树里那一行。

## 2. 决策

**采纳选项 A：增加唯一 provider，作为受控的最小树条目。**

不选的两条：

- **选项 B：改 profile 的 `requiredServices`/`requiredServiceProviders`，把该服务删掉。**
  不可行——上游两个插件的 `inject` 是硬依赖，cordis 会在初始化期直接报 unresolved，
  worker 起不来；且会同时违反 `validate.js:197`。这等于用"删门禁声明"换绿色，明令禁止。
- **选项 C：换掉 `session-log-deepseek` / `plugin-package-inventory-deepseek`。**
  这两者是合同 §2 明确要求的 Session 事件词汇与包清单兼容插件，替换等于改设计，
  代价远高于加一行 provider，且没有收益。

### 2.1 最小改动集（实施时；本轮未执行）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `plugins/dsh-defense-profile/package.json` | `dependencies` 增 `"@deepseek-ai/dsh-deepseek-llm-api-extensions": "0.2.2-alpha.2"` |
| 2 | `plugins/dsh-defense-profile/cordis.patch.yml` | 末尾（`defense-tools` 之后）插入一个条目：`id: deepseek-llm-api-extensions`、`name: '@deepseek-ai/dsh-deepseek-llm-api-extensions'`、**无 config、无 inject** |
| 3 | `plugins/dsh-defense-profile/profile.json` | `allowedPluginIds` 增 `"deepseek-llm-api-extensions"`；`pluginPackages` 增同名映射；`requiredServiceProviders.deepseekLlmApiExtensions` 保持 `include:deepseek-llm-api-extensions`（现值已正确） |
| 4 | `plugins/dsh-defense-profile/approved-hashes.json` | 按生成器重算（新增一个包的 tarball/文件哈希） |
| 5 | `package-lock.json` / `sbom.cdx.json` | 重新生成（该包已在锁文件中，作为直接依赖后 `dev`/`prod` 归属变化需重新导出） |
| 6 | 四层清单证据（package / plugin / service / model layer）| 用仓库自带生成器重算 |

**不新增任何代码**：provider 是上游包自带的 `Service`，无自定义实现、无新工具、无新 fs/网络能力。

### 2.2 顺序要求（易错点）

条目必须插在**引用它的插件之前还是之后**？cordis 的 `inject` 是**服务解析**而非加载顺序依赖：
provider 只要在同一棵树里注册即可。但 WP0 的四层清单会记录"解析后的插件顺序"
（`harness-validation.json` 的 `ordered direct tree`），因此插入位置会改变顺序清单 → 必须重算证据。
建议放在末尾，使既有条目的相对顺序完全不变，便于审查者逐项比对 diff。

## 3. 高危面影响评估

这是本 ADR 的核心，不能只说"加一行没事"。

### 3.1 它到底放开了什么

`register(field, provider)` 允许任意插件给**出站 DeepSeek 请求**增加**顶层字段**。
换言之，它是一个**请求构造期的数据出口**：拿到这个服务句柄的插件，可以把任意 JSON 塞进
发往模型的请求体（在 `baseURL` 之上、`messages` 之外）。这在"原始证据不出本机"的产品底线面前，
属于必须点名的能力。

### 3.2 在本树里实际被谁用、用了什么

**只有两个上游插件注册字段，且字段名与语义都是上游固定值**：

| 注册方 | 字段名 | 性质 |
|---|---|---|
| `session-log-deepseek:139` | `dsh_session_log` | 上游 Session 日志词汇 |
| `plugin-package-inventory-deepseek:146` | `dsh_plugin_packages` | 上游包清单 |

二者都是**上游自身协议字段**，不是把遥测内容外发；`prepare` 回调由上游实现，profile 无法注入。
本仓库自有插件（`dsh-defense-tools`）**不**注册任何字段。

### 3.3 风险与约束（必须同时成立）

| 风险 | 约束 |
|---|---|
| 未批准插件注册新字段 → 新增数据出口 | `allowedPluginIds` 是**封闭白名单**，四层校验逐 id 比对；任何新插件进树必须改 profile 并重跑 ADR |
| 第三方扩展运行期注册 | `effectiveConfig.thirdPartyExtensions=false`，且 `extension-bridge` 不在本树；本版本不开放 |
| 字段内容不受控 | **新增** WP0 断言：从运行时/清单导出"已注册字段集合"，必须 ⊆ `{dsh_session_log, dsh_plugin_packages}`；出现第三个字段即失败关闭 |
| 传输目标被改 | 已有约束不变：`validate.js:186-192` 要求 `baseURL` 为**无凭据回环**端点、`remoteModelListing===false` |

**结论**：加上 provider 后，本树的可外发面**没有实质扩大**——因为它本来就已通过 `session-log-deepseek`
与 `plugin-package-inventory-deepseek` 在使用这个服务，只是缺了 provider 导致**根本起不来**。
真正新增的是"显式承认该服务在场"，以及新增一条"注册字段集合必须封闭"的断言。

## 4. 证据与升级影响

- **哈希**：新增一个直接依赖包 → `approved-hashes.json`、`sbom.cdx.json`、`package-lock.json`
  三处必然变化；四层清单整体重算（由 `npm run harness:generate` 生成，不手工编辑）。
- **变异矩阵**：现有 `killedMutants` 中 `missing required service` 与本项直接相关，
  实施后该变异仍须能失败（把 provider 条目删掉 → 必须回到 `required provider … is absent`）。
  新增变异：`unapproved extension field`（往已注册字段集合塞第三个字段 → 必须失败）。
- **升级影响**：上游 `0.2.2-alpha.2` → 任何新版本都必须重新核对
  (a) 服务名是否仍为 `deepseekLlmApiExtensions`；(b) 两个上游插件注册的字段名是否变化；
  (c) `register()` 签名是否变化。任一项变化即本 ADR 失效，需重写。
- **未验证（必须写明）**：本 ADR 未运行真实 stdio worker，未验证"加 provider 后 worker 能起来"
  这一条只能由 `harness:check` + 真实 stdio 证据确认。

## 5. 关闭条件

1. 独立只读审查 PASS（审查者不得是实现者）；
2. 维护者批准；
3. 按 §2.1 落地后，`test:wp0` 的 `exactErrors` 中**不再出现**上述三条；
4. 新增"注册字段集合封闭"断言且能变红；
5. 四层证据由生成器重算，证据哈希索引同步；
6. 仍**只**有 Windows 证据 → 只能写"Windows 通过"。

## 6. 与冻结基线的关系

本 ADR 属后续阶段准备。冻结基线当时为 NO-GO，不得据此推进 profile 修改；
本文仅为待批方案。

## 7. 独立只读审查结论（2026-11-02）→ **ACCEPT-WITH-CHANGES**

方向（加唯一 provider）获认可，但**本文初稿有三处实质错误**，实施前必须按下列改正。
审查者用仓库内证据反驳，不采信本文自述。

### 7.1 本文的错误（已确认，勿沿用）

| 本文原述 | 审查实测 | 处置 |
|---|---|---|
| §3「可外发面没有实质扩大」 | **错**。两个插件目前是 `pending`、不注册字段；加 provider 后它们转 `active`，**每次请求体新增两个字段**：`dsh_session_log`（实测 3359 B / 9 事件，**内含 `cwd` 绝对路径**）与 `dsh_plugin_packages`（全部已装插件包名与版本） | 必须改写为"新增两条实质外发字段" |
| §3「缺 provider 导致根本起不来」 | **错**。实际是**降级运行**：`harness-stdio-shutdown.json` exit 0、协议正常，stderr 仅 `waiting for service: deepseekLlmApiExtensions` | 改为"两个插件无法激活" |
| §2.1「不新增任何代码」 | **自相矛盾**：§3.3/§5 要求的"注册字段集合封闭"断言必须改 `validate.js` + `runtime-inspect.js` + 测试 | 改为"新增 1 条校验 + 删除 3 条冻结断言" |
| §2.1 #6「用 `harness:generate` 重算四层清单」 | **错**。`harness:generate` 只写 package/contract/license/input-summary/approved-hashes；`harness-four-layer-{exact,diagnostic}.json` 由 `tests/wp0/harness/runtime.test.js` 在跑测试时写 | 更正来源 |
| §2.1 #5「SBOM 必然变化（dev/prod 归属变化）」 | 该包**已在** SBOM 与 lockfile 中且为 prod，归属不变；变化的只是 profile 节点的 `dependsOn` 多一条边 | 更正理由 |
| `validate.js:197` / `:186-192` | 实为 **`:198`** / `:186-195` | 更正行号 |
| `register()` 只影响顶层字段、不影响 `messages` | 结论对，但**依据未引**：`dsh-llm-deepseek/lib/index.js:1377` 有 `Object.hasOwn(body, field)` 冲突守卫。另 `prepare(request)` 收到的是**完整请求体**（含 messages/system/tools），即同时是"全量读取入口"，不只是"出口" | 补引证与风险定性 |

### 7.2 本文遗漏的必改项（照原稿实施会立刻红）

1. `scripts/harness-generate-manifest.mjs:63` — `assert.equal(policy.pluginPackages['deepseek-llm-api-extensions'], undefined)`：改 profile 后 `harness:check` **第一步就 assert 失败**。
2. `scripts/harness-check-manifest.mjs:20,22` — 要求 `status === 'NO_GO_FROZEN_CONTRACT'` 且 `exactErrors` **必须仍含** `deepseekLlmApiExtensions`：与本文 §5 关闭条件 3 **逻辑互斥**，必须先改该断言。
3. `tests/wp0/harness/runtime.test.js:55-61` — 正向断言该错误存在、且两插件 `state === 'pending'`；实施后必红。
4. `tests/fixtures/upstream-required-service.probe.yml` — 诊断 overlay 用的 id **就是** `deepseek-llm-api-extensions`，主树加入后 overlay 变重复条目，`:83` 的 `unapproved plugin` 断言不再成立。
5. `harness-contract-findings.json` 的 HAR-UPSTREAM-001 文案硬编码在生成器里，实施后成为假陈述。
6. `harness-input-summary.json`（`directDependencies.profile`）与 `harness-package-layer.json`（`lockfileSha256`）也会变。

### 7.3 仍然成立的部分

- 「插在末尾可保持既有 19 条相对顺序不变」——审查者用诊断 overlay 证据确认；
  且 `validate.js:94` 要求 `direct` 与 `allowedPluginIds` **逐位相等**，故 profile 里也必须追加在末位。
- 「删 `requiredServices` 不可行」——上游 `inject` 是硬依赖，且违反 `validate.js:198`。
- 新断言不得依赖非公开字段：`DeepSeekLlmApiExtensionRegistry.providers` 是类字段非文档 API，
  上游改成 `#providers` 会让断言**静默失效**（`undefined` 可能被当成"空集合=合法"）。
  → 改为在 broker 侧断言请求体字段集合，或对该字段做存在性前置检查。

### 7.4 与 ADR-0005 的耦合（重要）

单实施本 ADR 后 `exactErrors` 仍含 `runtime context is still contributed`，门禁**不会**转绿；
且 `dsh_session_log` 会把 cwd 绝对路径随每次请求送出，**与 ADR-0005 是同一个泄露面的两条通道**。
两份 ADR 必须联合评审、联合关闭，不能各自宣称"已解决"。

## 8. 实施记录（2026-11-02，Windows 11 x64）

§7 的六处必改点与两处 fixture 已全部落地，且**先于** profile 改动完成并单独复审：

| 项 | 落点 | 结果 |
|---|---|---|
| provider 条目 | `plugins/dsh-defense-profile/cordis.patch.yml` 末位（无 config/inject） | 两消费者由 `pending` → `active` |
| 白名单与映射 | `profile.json` 的 `allowedPluginIds` 末位 + `pluginPackages` | `validate.js` 的逐位相等仍成立 |
| 依赖 | profile `package.json` 增 `@deepseek-ai/dsh-deepseek-llm-api-extensions: 0.2.2-alpha.2` | lock/SBOM 重生成，`869 external + 15 local` 不变 |
| 注册字段封闭 | `runtime-inspect.js` 采 `extensionFields`（`providers` 非 `Map` 即 `verifiable:false`）；`validate.js` 判「子集 + 全员在场 + 不可验证即失败关闭」 | 证据：`{"verifiable":true,"fields":["dsh_plugin_packages","dsh_session_log"]}` |
| 生成器断言 | `harness-generate-manifest.mjs` 从"必须缺席"翻成"必须在场且末位" | 未采纳时 `--check` 直接报 `ADR-0004 is not applied yet` |
| 门禁断言 | `harness-check-manifest.mjs` 从"必须仍红"翻成 `exactErrors == []`，`killedMutants` 逐名 ≥ 19 | EXIT=0 |
| 诊断 overlay fixture | `tests/fixtures/upstream-required-service.probe.yml` 改为"已安装但未批准的高风险插件"（`@deepseek-ai/dsh-llm-retry`） | 仍被拒：`unapproved plugin` + `high-risk implementation` |

- `harness-validation.json`：`status = GO_FROZEN_CONTRACT_LOCAL_WINDOWS`，`exactErrors = []`，`killedMutants` 19/19 可杀。
- **仍然只有 Windows 证据**：`analysisCwdRoots.linux` 分支从未执行；Ubuntu 22.04/24.04、Debian 12 未跑。
- 残余风险（未因本 ADR 消失）：`dsh_session_log` 与 `dsh_plugin_packages` 现在**真的会随每次请求外发**。
  当前被"字段集合封闭 + 中性 cwd"夹住，但 broker 侧对实际请求体的字段级断言尚未在本 ADR 内完成。
