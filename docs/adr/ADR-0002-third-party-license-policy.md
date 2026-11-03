# ADR-0002：第三方许可证策略（MPL-2.0 / LGPL-3.0-or-later）

- 状态：**Accepted（2026-11-01）**
- 相关：`scripts/check-licenses.mjs`、`scripts/license-reviewed-copyleft.mjs`、`THIRD_PARTY_NOTICES`、`sbom.cdx.json`

## 1. 背景

根 `npm run check` 的最后一段 `license:check` 曾经**失败**，原因不是本仓库自有代码，
而是官方 `@deepseek-ai/dsh` 启动树的传递依赖里含有两份不在 `scripts/check-licenses.mjs`
reviewed allowlist 内的许可证：

| 许可证 | 组件数 | 代表包 | 传入路径 |
|---|---|---|---|
| `MPL-2.0` | 6 | `@deepseek-ai/libreoffice-kit@0.1.5` + 5 个平台/ WASM 变体 | `@deepseek-ai/dsh-office-to-pdf`、`@deepseek-ai/dsh-skill-office` |
| `LGPL-3.0-or-later` | 14 | `@img/sharp-libvips-*`（各平台）、`@img/sharp-wasm32`、`@img/sharp-win32-*` | `@deepseek-ai/dsh-attachment-local` |

这不是集成引入的。许可门禁的初始记录已经把它记为待决事项：

```json
// harness-license-findings（生成证据）
"status": "BLOCKED_BY_LICENSE_POLICY",
"gate": "scripts/check-licenses.mjs permissive allowlist",
"resolutionRequired": "A licensing ADR must either extend the reviewed allowlist for these
  exact packages with THIRD_PARTY_NOTICES obligations, or remove the feature packages from the
  shipped launcher tree. Neither is a WP0-B code change, so the allowlist was not edited."
```

## 2. 决定

维护者在"A / B"之间选择 **选项 A**：
**保留 office / 附件功能包，扩展 reviewed allowlist，并承担相应随附义务。**

明确**不选**选项 B（裁剪功能包）——因此本仓库**没有**裁剪任何依赖，WP0 已冻结的依赖树、四层清单
和 `harness-package-layer.json` 不受本次决策影响；后续只需复核 allowlist 变更未触及四层证据。

被否决的选项与理由：

- **选项 B（裁剪 `dsh-office-to-pdf`、`dsh-skill-office`、`dsh-attachment-local`）**：合规上更干净，
  但会移除附件与文档分析能力（对防御产品是能力回退），并且要重跑 WP0 全部四层证据与门禁。
  维护者认为能力保留优先。
- **选项 C（保持门禁为红）**：不可接受，`npm run check` 将永久不可用，发布门禁无法闭合。

## 3. 应用内容（本次实际改动）

### 3.1 门禁改为两层，且默认更严

`scripts/check-licenses.mjs` 不再是一个"宽松白名单"，而是：

1. `permissiveLicenses` —— 可自由出现的宽松许可证集合（原有 13 个，**未增加一个弱 copyleft**）；
2. `reviewedWeakCopyleft` —— 弱 copyleft 许可证 → **精确包名** 的映射。弱 copyleft 只能出现在
   被点名的包上；**任何新增的 MPL/LGPL 依赖仍会让门禁失败**，直到有人评审义务并扩展该表。

因此这次不是"把 MPL/LGPL 放进白名单让门禁变绿"，而是把已评审的**20 个包**逐一点名登记。
门禁另加两条反向校验：

- `THIRD_PARTY_NOTICES` 必须真的包含 MPL-2.0 / LGPL-3.0-or-later 义务段、源获取方式和可替换性声明，
  否则失败（义务不能只存在于 ADR 里）；
- ADR 点名的包如果在锁文件里全部消失（功能包被裁掉或上游改了许可证写法），也失败，
  以免留下无主声明。

### 3.2 已评审的 20 个包

下表是 `scripts/license-reviewed-copyleft.mjs` 与 `THIRD_PARTY_NOTICES` 的对齐基准：
`npm run license:check` 会逐名比对这三处，任何一个方向漂移都会失败（所以包名必须写全，
不能用 `-darwin-arm64` 这种省略写法）。

| 许可证 | 包 |
|---|---|
| `MPL-2.0`（6） | `@deepseek-ai/libreoffice-kit`、`@deepseek-ai/libreoffice-kit-darwin-arm64`、`@deepseek-ai/libreoffice-kit-darwin-x64`、`@deepseek-ai/libreoffice-kit-wasm`、`@deepseek-ai/libreoffice-kit-win32-arm64`、`@deepseek-ai/libreoffice-kit-win32-x64` |
| `LGPL-3.0-or-later`（14） | `@img/sharp-libvips-darwin-arm64`、`@img/sharp-libvips-darwin-x64`、`@img/sharp-libvips-linux-arm`、`@img/sharp-libvips-linux-arm64`、`@img/sharp-libvips-linux-ppc64`、`@img/sharp-libvips-linux-riscv64`、`@img/sharp-libvips-linux-s390x`、`@img/sharp-libvips-linux-x64`、`@img/sharp-libvips-linuxmusl-arm64`、`@img/sharp-libvips-linuxmusl-x64`、`@img/sharp-wasm32`、`@img/sharp-win32-arm64`、`@img/sharp-win32-ia32`、`@img/sharp-win32-x64` |

`@img/sharp-wasm32` 的声明是 `Apache-2.0 AND LGPL-3.0-or-later AND MIT`，`@img/sharp-win32-*` 是
`Apache-2.0 AND LGPL-3.0-or-later`；表达式里的每个标识符都必须通过，因此它们同样需要被点名。

### 3.3 `THIRD_PARTY_NOTICES` 新增义务段

- **MPL-2.0**：文件级 copyleft。保留许可证文本与版权声明；以未修改形式分发；
  若将来修改这些包的任何文件，该文件须以 MPL-2.0 提供并公开源码；自有代码仍为 Apache-2.0。
- **LGPL-3.0-or-later**：以共享库形式在运行时按路径加载，未静态链接进自有二进制；
  worker 另在独立沙箱进程中运行，因此属于"使用该库的作品"而非结合作品。
  **可替换性**：库文件保持为 `node_modules/@img/` 下的普通可替换文件，加载时不校验哈希、
  不限制用户替换；替换后的库不在测试矩阵内，但**不被阻止**。
- **源获取方式**：MPL 包的对应源即 npm registry 上被版本/URL/SHA-512 精确锁定的发布 tarball，
  上游为 `https://github.com/deepseek-ai/deepseek-harness`；LGPL 的对应源为
  `https://github.com/libvips/libvips` 与打包脚本 `https://github.com/lovell/sharp-libvips`。
- **发布检查清单**新增四项：许可证文本复核、"不得未经评审新增/移除 copyleft 包"、
  "LGPL 库仍可替换且未静态链接"、"SBOM 仍列出每个 copyleft 组件"。

### 3.4 许可证据的处置

起草时生成的许可证据记录的是
`status: "BLOCKED_BY_LICENSE_POLICY"`。独立复核指出：这三条状态文字是生成器里的**硬编码常量**，
不是"会被时间超越的快照"，而检查器又断言它必须保持该值——于是 `npm test` 的绿色会依赖一条已为假的
结论，门禁方向被倒置。

因此本轮**已刷新**该证据，而不是留给下一阶段：

| 项 | 变化 |
|---|---|
| 许可证据 | `status` → `RESOLVED_BY_ADR_0002`；新增 `decision`（指向本 ADR）与 `resolution`（点名执行门禁）；20 个包及其真实 dependents 原样保留，一个都没删 |
| `scripts/harness-check-manifest.mjs` | 断言改为"必须记录决策 ADR、必须点名执行门禁、包数必须为 20、且每个包都在已评审清单里"（含反向检查：证据里出现的 copyleft 包不能在清单外） |
| 环境与哈希证据 | 用 `scripts/harness-evidence.mjs` 重算；环境记录为当次运行的 Node / npm 版本，两者均在门禁窗口内，此差异在此披露 |

生成证据里的六个退出码中，`npm-ci` 仍是初始基线那一次的真实结果，其余五个是重跑的真实结果。
**这里必须说清楚**：退出码是 `scripts/harness-evidence.mjs` 从命令行参数 `--command=name=code`
收进去的，脚本自身无法自证；`npm-ci=0` 的唯一凭据是当次运行的原始日志。
该 JSON 的 `provenance` 字段只写"最近一次真实运行"，没有逐条标注来源，不要把它当作来源证明。

另外两件**读者必须知道**的事：

1. **`npm test` 不是只读的**：`tests/wp0/harness/**` 每次运行都会重写所辖证据
   （含随机临时路径），因此证据哈希索引**一跑测试就失配**，且没有任何门禁读它。
   它是"生成时刻的快照"，不是防篡改机制。让这些测试改写临时目录属于后续任务。
2. 两次 `npm ci` 的安装包数不同（804 与 874）：804 = 当时已安装的 796 个锁定包
   （`harness-package-layer.json`）+ 8 个 workspace 链接；874 那次跑在重新生成 lockfile 之前，
   树形与现在不同。两者都 `EXIT=0`，且 `npm ls --all` 无 extraneous/missing。

**仍待完成的部分**：四层证据整体重建、真实 stdio 与变异矩阵复跑、四 OS 证据。本轮**没有**改动
依赖树、profile 或四层清单内容。

## 4. 风险与重新评审触发条件
1. 若上游升级改变**链接方式**（例如把 libvips 静态链进 worker，或把 libreoffice-kit 源码并入自有文件），
   本结论失效，必须重新评审。
2. 若新增任何 MPL/LGPL 依赖，门禁会失败并停止发布——这是设计意图，不是缺陷。
3. 若裁剪 office/附件功能包，`THIRD_PARTY_NOTICES` 与 §3.2 表格必须同步缩减。
4. 本 ADR 记录的是工程合规判断，**不构成法律意见**。

## 5. 证据

应用后的真实输出（2026-11-01，`node v24.20.0` / `npm 11.19.0`）。
原文最后一行是 20 个组件的完整逐条列表，此处**节选**并用 `…` 省略重复项；未做任何重排或改写：

```
$ npm run license:check
> npm run node:check && node scripts/check-licenses.mjs
Toolchain gate passed: Node.js v24.20.0, npm 11.19.0
License check passed: 869 external and 9 local locked packages.
Reviewed licenses: 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, CC-BY-3.0, CC0-1.0,
  ISC, LGPL-3.0-or-later, MIT, MPL-2.0, Python-2.0, Unlicense, WTFPL
Reviewed weak-copyleft components (ADR-0002): @deepseek-ai/libreoffice-kit (MPL-2.0), … ,
  @deepseek-ai/libreoffice-kit-win32-x64 (MPL-2.0), @img/sharp-libvips-darwin-arm64 (LGPL-3.0-or-later), … ,
  @img/sharp-win32-x64 (LGPL-3.0-or-later)
EXIT=0
```

完整原文为当次 `npm run license:check` 的终端输出；应用前的失败输出作为历史保留在版本库之外的构建记录里。

门禁行为由 `tests/wp0/license-gate.test.js`（10 条）覆盖，负例都是能变红的：
新增未评审 MPL/LGPL 包、换成未评审的 copyleft 许可证、少发一个已评审包、删掉义务段、
NOTICES 数量撒谎、ADR 表格与清单漂移。

