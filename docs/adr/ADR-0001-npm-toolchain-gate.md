# ADR-0001：npm 工具链门禁从精确锁版本改为有界 11.x 窗口

- 状态：**Accepted（2026-11-01）**
- 相关：`scripts/check-node-version.mjs`、`package.json`、`tests/wp0/repository-baseline.test.js`

## 1. 背景

合流前的门禁逻辑是：

```js
} else if (npmVersion && npmVersion !== '11.6.0') {
  console.error(`npm 11.6.0 is required; actual npm is ${npmVersion}`);
  process.exitCode = 1;
}
```

即 npm 必须**恰好**等于 `11.6.0`，否则根 `npm test` 在第一行就退出。
本机实际 npm 是 `11.19.0`，于是：

```
$ npm test
> node scripts/check-node-version.mjs
npm 11.6.0 is required; actual npm is 11.19.0
EXIT=1
```

集成规范要求：为这个精确门禁写 ADR，决定"锁定可用的 11.6 工具链"
或"按可复现证据放宽到兼容 11.x"，并明确**不允许直接删门禁**。

## 2. 决策

同时做两件事，而不是二选一：

| 项 | 决定 | 说明 |
|---|---|---|
| `packageManager` | **保持 `npm@11.6.0`** | 规范工具链钉住不变；`tests/wp0/repository-baseline.test.js:14` 断言此值，且 `tests/wp0/**` 本次禁改 |
| `engines.npm` | `>=11.6.0` → **`>=11.6.0 <12.0.0`** | 声明**受支持窗口**，不降低原有下限 |
| `scripts/check-node-version.mjs` | 由"精确相等"改为"区间判定" | 保留门禁，语义更严：下限不变，新增上限，解析失败一律 fail-closed |

判定式：

```
npm_min  = 11.6.0（含）
npm_max  = 12.0.0（不含）
node_min = 24.9.0（含，未改）
```

### 为什么不选"精确锁 11.6.0"

1. **精确锁在本机不可自证**：仓库没有 corepack 启用，`packageManager` 不参与强制；
   把门禁写成精确相等，只会让所有装了其它 11.x 的机器在第一步就失败，而不能防止任何真实故障。
2. **缺少"其它 11.x 不安全"的证据**：没有缺陷、CVE 或行为差异记录支持排除 11.7–11.19。
   相反，本次取得了两者的等价性证据（见 §4）。
3. **下限本来就是为了"不低于"**：`engines.npm: ">=11.6.0"` 原文就是区间语义，
   门禁的精确相等与声明的 engines 自相矛盾。

### 为什么保留 `packageManager: npm@11.6.0`

它是**规范工具链声明**（写文档、复现构建时照它装），不是"本机运行版本"的断言。
保持它有三点好处：不与 WP0 基线断言冲突；不改变任何已定稿结论；
在需要完全复现时仍有一个确定的版本可装。

## 3. 门禁没有被削弱

改动后仍然 fail-closed，且覆盖面变大：

| 输入 | 旧行为 | 新行为 |
|---|---|---|
| npm 11.6.0 | 通过 | 通过 |
| npm 11.19.0 | **失败（假阴性）** | 通过 |
| npm 11.5.9 | 失败 | 失败（低于下限） |
| npm 9.8.0 | 失败 | 失败（低于下限） |
| npm 12.0.0 | 失败 | 失败（达到上限） |
| 无法解析的 npm 版本串 | 失败 | 失败（`parseVersion` 返回 null → fail-closed） |
| npm 未参与调用（直接 `node scripts/…`） | 通过并提示 | 通过并提示（与旧行为一致） |

实测探针：

```
$ npm run node:check
Toolchain gate passed: Node.js v24.20.0, npm 11.19.0

$ npm_config_user_agent="npm/9.8.0 node/v24.20.0 win32 x64" node scripts/check-node-version.mjs
npm >=11.6.0 <12.0.0 is required; actual npm is 9.8.0. An exact pin no longer applies: see ADR-0001. Do not bypass this gate.
EXIT=1
```

**没有删除门禁、没有注释掉断言、没有加白名单绕过。**

## 4. 等价性证据（两个版本各跑一遍完整根测试）

同一份工作树、同一 Node（v24.20.0），只换 npm：

| npm | 命令 | 门禁 | WP0 | contracts | detection | plugin-manager | 总计 | 退出码 |
|---|---|---|---|---|---|---|---|---|
| 11.19.0（本机全局） | `npm test` | 通过 | 19/19 | 305/305 | 121/121 | 135/135 | **580 / 0 fail** | **0** |
| 11.6.0（临时安装） | `npm test` | 通过 | 19/19 | 305/305 | 121/121 | 135/135 | **580 / 0 fail** | **0** |

- 11.19.0 与 11.6.0 均为本地完整根测试的一次性实测，未改动全局 npm。
- 11.6.0 取自临时前缀目录（`npm install npm@11.6.0 --prefix`）：
  ```
  $ node %TEMP%/npm116/node_modules/npm/bin/npm-cli.js --version
  11.6.0
  $ node %TEMP%/npm116/node_modules/npm/bin/npm-cli.js test
  Toolchain gate passed: Node.js v24.20.0, npm 11.6.0
  ...
  EXIT=0
  ```

两者产出的 `package-lock.json` 均为 `lockfileVersion: 3`，`npm install` 后
`npm ls` 的 workspace 解析结果一致（三个新包均为 `-> .\packages\…` 的本地链接，无 `extraneous`）。

## 5. 影响

- 根 `npm test` 在声明工具链下真实通过（580 条全绿）。
- `npm run check` **仍未通过**，但失败点与本 ADR 无关：
  仅剩 `license:check` 的第三方许可证策略问题，见 `ADR-0002`。
- `packageManager` 断言原样成立；`tests/wp0/repository-baseline.test.js` **源码未被修改**。

## 5.1 `tests/wp0/evidence/` 生成物刷新的**事实登记**

必须显式记录，不能声称"未动 `tests/wp0/**`"：

把三个包加入根 `workspaces` 必然改写 `package-lock.json`，而
`scripts/harness-generate-manifest.mjs` 把 `lockfileSha256` 写进证据并做**整文件字节比对**
（`harness-generate-manifest.mjs:28`），因此 `npm run harness:check` 立即报
`Stale generated evidence`，根 `npm test` 在 WP0 段即失败。在不改这些生成物的前提下，
"根 `npm test` 必须真实通过"与"禁止修改 `tests/wp0/**`"在当前实现下**逻辑互斥**。

处置：用仓库自带的 `npm run harness:generate` 刷新，**不做任何手工编辑**。被改动的 3 个文件与实测差异：

| 文件 | 差异 |
|---|---|
| `harness-package-layer.json` | `lockfileSha256` 更新；`packageCount` 仍 869（不变）；`installedPackageCount` 798→796 |
| `harness-input-summary.json` | 随 lockfile 摘要更新 |
| `harness-license-findings.json` | `packages[]` 中 `@emnapi/runtime`、`@img/sharp-wasm32` 的 `installed` 由 `true` 变 `false`、`files`/`filesSha256` 清空（`npm install` 按平台裁剪了两个可选 WASM 包） |

**结论类断言没有被翻转**：`license-findings` 当时仍为 `BLOCKED_BY_LICENSE_POLICY`，
`harness-check-manifest.mjs` 仍强制该结论，MPL 依赖仍留档。

> **后续变更（2026-11-01）**：上面这段描述的是本 ADR 起草时点的状态。
> 维护者随后在 `ADR-0002` 选择选项 A，许可门禁转绿，`harness-license-findings.json` 的状态
> 已改为 `RESOLVED_BY_ADR_0002`，`harness-check-manifest.mjs` 的断言同步改为"必须记录决策
> 与 20 个逐包清单"。因此"仍为 BLOCKED / 仍强制该结论"两句**已不再成立**，保留原文仅作历史记录。

这属于"用仓库自带生成器刷新派生证据"，不是篡改证据；但**字面上违反了"禁改 `tests/wp0/**`"**，
因此在此登记为**已披露的规则偏离**。处置建议：把规则细化为
"生成物只能由 `harness:generate` 或测试运行刷新，且刷新必须备案"。

## 6. 复发条件

出现下列任一情况应重新评审本 ADR：

- npm 12 发布且项目需要它；
- 需要 corepack 强制统一 npm 版本；
- 任一 11.x 版本被发现有影响 lockfile 或生命周期脚本行为的安全问题。
