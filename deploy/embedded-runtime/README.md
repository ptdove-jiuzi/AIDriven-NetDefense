# 内置运行时打包（M8 打包可行性 PoC）

作者：PT-dove

本目录只做一件事：**在仓库外组装一个 Windows x64 自包含目录**，用来验证
「目标机不装 Node、不装 dsh、无外网，也能把 harness worker 启动到预检/stdio 阶段」。

产出的目录**不含构建机的绝对路径**，可以直接复制到其它目录/盘符后启动（见「可搬迁性」）。

它不是安装包，不含签名、安装器、升级器、四 OS 形态和模型权重。正式 M8 阶段的工作
另开任务，见 `docs/implementation/status/M8-EMBEDDED-RUNTIME.md` 的待办。

## 产物结构

```text
<out>/                                   # 默认：../_m8_poc/bundle/aegis-embedded-win32-x64-v13-relocatable
├── bundle.json                          # 构建元数据：lockfile 哈希、闭包规模、输入来源、非目标
├── README-BUNDLE.md                     # 面向拿到 bundle 的人：这是什么／不是什么／怎么删
├── runtime/
│   ├── node/node.exe                    # 内置 Node 24 运行时
│   ├── node/LICENSE-NODE.txt            # Node 许可文本（与捆绑二进制同源，见「许可溯源」）
│   └── node/runtime.json                # 版本、许可来源、是否与被捆绑二进制同源
├── app/
│   ├── package.json                     # bundle 自身的应用清单（private，无依赖声明）
│   └── node_modules/
│       ├── @deepseek-ai/dsh/**          # dsh CLI 及其生产依赖闭包（按 lockfile 路径原样落盘）
│       ├── @aegisharness/harness-worker/**
│       ├── @aegisharness/harness-adapter/**
│       ├── @aegisharness/dsh-defense-tools/**     # 与 profile 内副本同源、同哈希
│       └── plugins/dsh-defense-profile|dsh-defense-tools/**   # 适配器相对根镜像
├── dsh-home/profiles/aegis-analysis/    # profile **模板**（不是运行期 DSH_HOME）
│   ├── package.json / profile.json / cordis.patch.yml / approved-hashes.json
│   └── node_modules/@aegisharness/dsh-defense-tools/**
├── launch/
│   ├── launch-plan.json                 # 权威路径（**相对 bundle 根**）+ 环境契约 + 非目标
│   ├── aegis-harness-worker.cmd         # 启动存根：用 %~dp0.. 现场解析 bundle 根
│   └── prepare-attempt.mjs              # 每次分析一次性环境的参考实现（用 import.meta.url 解析根）
└── manifests/
    ├── files.sha256                     # 除 manifests/ 自身外的全量文件哈希
    ├── third-party-packages.json        # 每个包的 SPDX 标识与许可文件
    ├── license-gaps.json                # 仍无上游全文的包（open 待办，不是合规声明）
    ├── license-provenance.json          # 每份「包外取得」的全文来自哪个上游发行
    ├── license-attestations.json        # 构建输入副本：来源 + sha256，可凭 bundle 自证
    ├── THIRD-PARTY-NOTICES.txt          # 汇总 NOTICE
    └── licenses/<name>@<version>/…      # 逐包许可全文（含 licenses/ 子目录）
```

## 构建

```powershell
# 在仓库根执行（license 相关参数都有默认值，通常不需要显式给）
node deploy/embedded-runtime/build.mjs `
  [--node-license <Node LICENSE 路径>] `
  [--node-license-attestation <该文本的通源记录.json>] `
  [--license-attestations <deploy/embedded-runtime/license-attestations.json>] `
  [--allow-license-gap] `
  [--no-prune] [--plan-only] [--profile-snapshot <冻结的 profile 输入目录>] `
  [--out <仓库外的目录>]
```

- **默认裁剪**：不带 `--prune` 时自动加载 `deploy/embedded-runtime/prune-list.json`，
  与默认输出名 `-v13-relocatable` 一致。`--no-prune` 才会产出全量 654 包的目录——此时**请同时换一个
  `--out`**，否则目录名会名不副实。
- **默认许可输入**：`license-attestations.json` 记录 Node 文本与两个包的上游全文
  （`licenses/**`）的来源与 sha256，构建逐个复算；`--no-license-attestations` 可退回
  「只带 `--node-license` 手工文本」的旧行为。来源记录会被复制进
  `manifests/license-attestations.json`，因此换个机器也能凭 bundle 自证。

- 构建全程不执行 `npm`/`npx`/`install`/下载：依赖从 lockfile 声明的、仓库里**已安装**的
  `node_modules` 只读拷贝。
- **输入闸门**：构建前逐个校验 `approved-hashes.json` 的 6 个文件；任何漂移都直接失败，
  因为这样的 bundle 内的 worker 会在自己的预检里拒绝启动。
- **许可闸门**：`--node-license` 的文本必须配 `--node-license-attestation`
  （`{ "version": "v24.20.0", "sha256": "<文本摘要>", "source": "<取得方式>" }`），
  版本或摘要不符即失败。确实拿不到时只能用 `--allow-license-gap`，缺口会写进
  `bundle.json.releaseGaps` 与 `manifests/license-gaps.json`，不会被当成合规。
- `--profile-snapshot <dir>` 把 `plugins/dsh-defense-profile`、`plugins/dsh-defense-tools`
  钉到一份冻结副本（目录内需含这两个子目录）。当另一个 Agent 正在改插件树、而白名单尚未
  重新生成时，这是唯一能让产物可复现的方式。**快照会同时作用于 `app/node_modules` 里的
  workspace 拷贝**，不只是模板。
- 构建还做三件事：把 `cordis.patch.yml` 里挂载的插件名逐个对到**裁剪后**的闭包；
  在收尾时审计**每一个**已批准文件在 bundle 内的所有副本（安装域、`plugins/*` 镜像、
  模板、输入源）哈希一致；拒绝把仓库绝对路径写进任何产物文件。
- `--force` 只会替换**带 `bundle.json` 标记**的旧 PoC 产物。**注意**：本机 shell 对批量删除
  有安全拦截（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），`--force` 在存在旧产物时可能被中断；
  此时旧目录保持原样，改名留档即可，不要强行删除。
- 输出路径保护用 `realpath` 规范化后比较，并拒绝 `\\?\` 扩展长度前缀、指向仓库的 junction、
  以及受保护系统目录（`%TEMP%` 例外）。

## 可搬迁性（本目录的核心不变量）

bundle 内**不存在构建机的绝对路径**。这不是风格问题：只要 `launch/` 里写死了构建目录，
目录一被复制或改名，启动器仍会去启动**原位置**的树——在构建机上完全看不出来，换台机器立刻报废。

因此三处都改成运行时解析：

| 文件 | 构建时写入 | 启动时怎么得到根 |
|---|---|---|
| `launch/launch-plan.json` | 相对 bundle 根的 posix 路径 + `pathConvention` 说明 | 调用方按 `join(dirname(<plan>), "..")` 解析 |
| `launch/aegis-harness-worker.cmd` | 不含任何路径 | `for %%I in ("%~dp0..") do set "AEGIS_BUNDLE_ROOT=%%~fI"` |
| `launch/prepare-attempt.mjs` | 不含任何路径 | `realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '..'))` |

构建收尾的泄漏闸门按 5 类目标 × 3 种写法（`D:\x`、`D:/x`、JSON 里的 `D:\\x`）对**所有文件类型**扫一遍：
仓库根、仓库父目录（临时构建树所在）、bundle 输出目录、输出目录父级、构建用户 profile。
命中任何一条即构建失败——**其中包括 bundle 自己的输出目录**，这正是 v12 及以前漏掉的那一类：
`launch/` 三个文件都写着 `D:\…\_m8_poc\bundle\aegis-…`，而旧闸门只扫仓库路径，所以它一路通过。

`tests/packaging/portability.test.js` 用「复制 → 改名到从未存在过的目录 → 逐行校验
`manifests/files.sha256` → 用新位置的 `prepare-attempt.mjs` 与 `.cmd` 各启动一次 →
断言模块追踪里每个已加载文件都在副本内、且没有一个来自原目录」来证明这条性质，
而不是只做文本断言（原目录仍在磁盘上，残留的绝对路径会「照样能跑」并把问题藏住）。

## 可复现性（G2）

同一 `package-lock.json` + 同一 reviewed profile 连续构建两次，**除 `bundle.json` 的 `builtAt` 外必须逐字节一致**。
判据在 ADR-0009 §10.1 G2：先剥离 `manifests/files.sha256` 里 `bundle.json` 那一行，其余行逐文件比哈希；
`bundle.json` 单独比白名单字段。

```powershell
# 两次构建，输出放在仓库外的不同目录
node deploy/embedded-runtime/build.mjs --out D:\_g2\run1\bundle
node deploy/embedded-runtime/build.mjs --out D:\_g2\run2\bundle

# 比较（--verify-disk 会额外用磁盘复算两侧清单）
node tests/packaging/repro-compare.mjs --left D:\_g2\run1\bundle --right D:\_g2\run2\bundle --verify-disk
```

为什么必须剥离那一行：`bundle.json` 里有 `builtAt`，它的值每次都不同，而它又被 `files.sha256` 覆盖，
所以整包「一个哈希」在跨构建之间永远不成立。剥离后比的是**内容**，`bundle.json` 的其余字段
（包数、闭包、裁剪门禁、许可记录、`paths`）仍然逐项比对，数组顺序也算——换序就是另一个产物。

**比较范围比 ADR 字面要求多一步。** `files.sha256` 排除了整个 `manifests/` 目录（它无法包含自身摘要），
所以 `trim-report.json`、`third-party-packages.json`、`license-gaps.json`、`license-provenance.json`、
`THIRD-PARTY-NOTICES.txt` 和 `licenses/**` 这 186 个文件**不被任何哈希覆盖**，而发布声明引用的
裁剪门禁数字、按许可计数、缺口清单恰恰来自它们。比较器因此额外逐文件比这 186 个文件
（`files.sha256` 除外，它已经逐行比过）。只比 `files.sha256` 会把「可复现」的范围说得比证据大。

本目录为此保持三条约束：

1. **不记录工作目录。** `runtime.json` 的 `licenseSource` 一度用 `process.cwd()` 相对化，
   于是同一个输入在仓库外构建会写成 `<external>/LICENSE-NODE.txt`，整个 bundle 差一个文件。
   现在 `stageNodeRuntime` 接受 `recordBase`，`build.mjs` 传仓库根，结果与在哪儿敲命令无关。
2. **不记录输出目录。** 见上一节：所有随包路径都是 bundle 相对的，输出目录换名字、换深度、
   带空格都不影响产物字节。
3. **顺序必须显式。** `listBundleFiles()`、`collectLicenseFiles()`、第三方清单与裁剪报告都显式排序；
   依赖闭包是固定种子的 BFS。新增任何遍历都要排序，否则 `files.sha256` 的行序会随文件系统返回顺序漂移。

`tests/packaging/reproducibility.test.js` 用 12 条反向用例守住比较器本身（单哈希不同、缺行、多行、
不剥离必须失败、非白名单字段变化、数组换序、重复行必须失败、空清单必须失败、`manifests/` 漂移、
畸形行、磁盘篡改、未列入清单的文件），免得「两次构建一致」变成一句没人验证的声明。

**未验证**：并发构建（两次都是串行）；Windows 以外的平台；跨文件系统（两侧都在 NTFS）；
跨 Node 版本——排序用了 `localeCompare(…, "en")`，同版本 Node 下确定，但结果受 ICU 版本影响，
Node 升级后 `trim-report.json` / `third-party-packages.json` 的行序可能变。

## 依赖裁剪

profile 只挂 20 个插件，而 `@deepseek-ai/dsh` 声明了它能托管的所有能力的依赖
（LibreOffice、sherpa-onnx、sharp、node-pty、浏览器 UI 等）。裁剪只发生在**暂存副本**里。

```powershell
node deploy/embedded-runtime/prune.mjs            # 看门禁结果（prune / KEEP 两栏）
node deploy/embedded-runtime/prune.mjs --blocked  # 只看被门禁拒绝的包和原因
node deploy/embedded-runtime/prune.mjs --write    # 重写 prune-list.json
```

一个包只有在**同时**满足下面五条时才可剪：

1. 从 profile 实际挂载的入口出发，模块图**到不了**它（`lib/usage.mjs` 的文件级遍历）；
2. **没有任何已到达文件**把它的名字写成**独立 token**（加载器/命令表按名字动态 `import`，这类边
   不在模块图里，所以名字出现就必须保留）。判据是「相邻字符不是标识符字符」：`'dfa'`、`"dfa"`、
   `require("dfa")`、`dfa/sub`、`node_modules/dfa/index.js`、`"dfa": "1.2.0"` 都算出现；而
   `dfa` 落在 hex 摘要（`…3434c6b4…dfa58cd690`）或更长的包名（`dsh-persona` 之于
   `dsh-personalized-recommendations`）里，属于**另一个名字**，不算出现——被排除的次数仍会记进
   证据的 `dismissedSubstringHits`，不是静默丢弃；
3. 它不是闭包根、不是 `plugins/**` 里的 workspace 包、不是 profile 挂载的插件；
4. 它不是任何可达包的**可选平台变体**（`require('@img/sharp-' + platform)` 这类算不出名字）；
5. 语料里**没有未扫描的代码文件**（`.js/.mjs/.cjs/.ts/...` 读不出来或超过上限时，整批候选
   一律拒绝；`.node`、`.json`、`.yml` 不算代码，不阻塞）。

门禁允许剪、但本任务**决定不剪**的包登记在 `prune.mjs` 的 `HELD` 里（当前 1 个：
`@deepseek-ai/dsh-persona`——第 2 条收紧后它被放行，但移除它属于新的裁剪决定，需要单独复核）。
`--write` 会把 `heldBack` 写进清单，所以重新生成不会悄悄扩大裁剪面。

构建时 `--prune` 会**重跑同一套门禁**：列表过期、或试图剪掉被使用的包，构建直接失败，
不创建输出目录。每次裁剪的证据落在 `manifests/trim-report.json`（逐包：可达性、独立 token 引用数、
被排除的子串次数、未扫描代码数、声明者、体积），NOTICE 里也会列出被剪掉的包，方便复核。

**证据的作用域**（不要读成"三条信号都通过才剪"）：构建期实际只跑**两条静态信号**（模块图 +
字符串引用）。第三条"运行时实际加载了哪些模块"只能在 bundle 造出来之后观测，由
`tests/packaging/bundle.test.js` 在真实 `initialize/shutdown` 中、以及
`tests/packaging/prompt.test.js` 在带桩 broker 的 `session/prompt` 全路径中**事后互证**。
两条静态信号都**不覆盖 profile 从未挂载的代码路径**；`session/prompt` 那条路径现由
`prompt.test.js` 覆盖（loopback 桩 broker + 模块追踪 + 只放行桩端口的 tripwire），
但它证明的是「随包客户端栈能走完这条路径且没加载被剪包」，不等于真实 broker/真实模型的行为。

`--plan-only` 只跑门禁并打印计划，不写盘。

## 验证

```powershell
node --test tests/packaging/bundle.test.js tests/packaging/manifests.test.js `
  tests/packaging/prune.test.js tests/packaging/report.test.js tests/packaging/prompt.test.js `
  tests/packaging/portability.test.js
```

`tests/packaging/prompt.test.js` 用 `stub-broker.mjs` 在 loopback 上实现 Messages 协议
（`POST <base>/v1/messages` + SSE），断言：恰好一次模型请求、携带被审模型 id 与两个防御工具、
流式回复被写进会话记录、**被裁剪包加载数 = 0**、除桩端口外零连接尝试。

`tests/packaging/bundle.test.js` 覆盖：

1. 构建元数据与路径约定：`launch/` 三个文件只存**相对 bundle 根**的路径、存根用 `%~dp0..`
   现场解析；`bundle.json` 里的路径字段同样是相对的。
2. 内置运行时是 Node 24，且净化后的 PATH 里 `where node` 失败（含正向对照，证明不是
   环境里本来就没有 `where`）；
3. worker 在「无系统 Node + tripwire 已武装」下完成 `initialize` 握手、写出 live 运行时
   清单、`shutdown` 退出码 0，且**启动前后 bundle 全部文件哈希不变**；
4. 交付的 `.cmd` 存根同样能起来，并证明它确实清掉了 `NODE_OPTIONS`（存根路径因此
   **不做**零网络断言——注入不进去，那会是永真断言）；
5. tripwire 自证能拦住连接（否则「零次连接」不构成证据）；
6. 输出路径守卫拒绝 `\\?\` 前缀、指向仓库的 junction；`prepare-attempt.mjs` 拒绝落在
   bundle 内或非空的 attempt 根；
7. bundle 内没有符号链接、没有仓库路径（全文件类型字节扫描）、没有凭据。

`tests/packaging/manifests.test.js` 覆盖：哈希清单全覆盖且逐条校验、第三方清单与
NOTICE 一致、**每个已落盘包的生产依赖都能在 bundle 内解析**（解析上界是 bundle 根，
不会飘到构建机的其它 `node_modules`）、devDependency 未被卷入、许可全文覆盖率。

## 不变量（改动本目录时必须保持）

- 不写仓库：`build.mjs` 用规范化路径拒绝仓库内（或覆盖其父目录）的输出；构建过程不碰
  仓库 `node_modules`、根 `package.json`、lockfile、SBOM。
- 不改被审查的字节：profile 与 tools 文件逐个 `copyFileSync` 原样复制，因为 worker 预检
  会比对 SHA-256。
- 不靠 PATH：存根只用 `%~dp0` 推 bundle 根，其它位置只写相对路径。
- **不写死构建机路径**：`launch/` 与各清单里只有相对 bundle 根的路径；泄漏闸门会拒绝
  仓库根、仓库父目录、输出目录及其父级、构建用户 profile 的任何拼写。
- 不联网：构建与启动都不下载；运行期只允许 loopback broker 端点。

## 许可溯源（当前状态）

- **Node 许可已按版本溯源**：`licenses/node-v24.20.0/LICENSE-NODE.txt` 取自官方发行包
  `https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip` 内的 `LICENSE`
  （zip 摘要 `6cac9ffb…`，与官方 `SHASUMS256.txt` 一致；该包内 `node.exe` 与捆绑二进制
  字节相同）。构建时按 `license-attestations.json` 复算 sha256，不符即失败，
  `runtime/node/runtime.json` 因此写 `licenseProvenance=attested`、
  `licenseMatchesBundledVersion=true`。
- **两个包的上游全文已补齐**：`@deepseek-ai/dsh-experimental-inspector@0.2.2-alpha.2`
  取自 `dsh-v0.2.2-alpha.2` tag 的仓库根 LICENSE；`@koromix/koffi-win32-x64@3.1.1`
  取自同版本 `koffi@3.1.1` tarball 的 `package/LICENSE.txt`（平台包本身不带文本）。
  来源、方式与摘要写在 `manifests/license-provenance.json`。
- **`dfa@1.2.0` 缺口已通过裁剪关闭**（不再是 blocker）：该包上游从不发许可文本，所以
  「补文本」这条路本来就不通；改走「证明它不在交付物里」。三类证据：
  ① 静态模块图——全 lockfile 里 `dfa` 只有一个父级 `fontkit`，`fontkit` 只有
  `@deepseek-ai/libreoffice-kit`，后者只有 `dsh-office-to-pdf` / `dsh-skill-office`，
  而这条链没有任何一环被 profile 挂载的入口 **import**。注意**不能说成「依赖闭包里没有」**：
  `dsh-skill-office` 是 `@deepseek-ai/dsh-sdk-app`（即 profile 挂载的 `sdk-app-startup`）的
  **硬声明依赖**，依赖闭包里确实有 dfa。真正断在两处：其一，本 profile 的
  `cordis.patch.yml` 是显式 `insert:` 树、不继承任何 bundle，所以 `dsh-sdk-app` 自带的那份
  patch（里面有 `skill-office`）不会被套用，运行期清单 21 条 = 20 个 `allowedPluginIds` +
  loader 自己的 `include`，没有任何 office 条目；
  其二，即使 `skill-office` 被加载，它也不 import 这个 kit，只用
  `import.meta.resolve("@deepseek-ai/libreoffice-kit/package.json")` 定位 `lib/cli.js`，
  所以还得多一步「spawn LibreOffice CLI」才会走到 `libreoffice-kit` 的
  `import "fontkit"` → `fontkit` 的 `import "dfa"`；
  ② 运行时模块追踪——v11（`dfa` 仍在磁盘上、可解析）与 v12 各跑一次真实
  `initialize → session/prompt → session/wait → shutdown`，追踪 1 136 个文件 / 75 个包，
  `dfa` 加载次数为 0，两次的包集合完全相同；并用「显式 require dfa」的正向对照证明追踪器
  确实会记录它；
  ③ 负面测试——`prune.test.js` 用合成的语料断言「`require('dfa')` 仍然会被拦下」，
  并断言 hex 片段不算名字，确保放行不是把整条规则关掉。
  当前 `manifests/license-gaps.json` 为 `count: 0`、`bundle.json.license.complete=true`。
  **仍未改变的事实**：`dfa` 的上游确实没有许可文本；这里只是让它不再被分发，
  不是给它补了一份文本，也不是对 MIT 义务的豁免声明。

## 已知缺口

- **`dfa@1.2.0` 已不再随包分发**（见「许可溯源」末条）。它的上游至今没有许可文本，
  该事实记录在 `license-attestations.json.unobtainable` 里且 `status: open`；
  但交付物不再包含这个包，所以 `manifests/license-gaps.json` 为空、
  `bundle.json.license.complete=true`。**不得**把这句读成「上游文本已补齐」。
- **零网络的适用范围**：tripwire 只覆盖 Node 层、本进程的 `net`/`dns`/`http(s)` 入口。
  当前 bundle 内有 10 个原生 `.node`（`koffi`、`node-addon-require-builtin`、`node-pty` 的
  conpty/prebuild 变体），原生 addon 直接建连、或 `child_process` 派生的非 Node 程序，
  都不会被这个 tripwire 看见。因此结论只能表述为「**Node 层零次连接尝试**」，
  不能表述为「进程级零外联」。
- **体积**：裁剪前 `@deepseek-ai/dsh` 的生产闭包约 735 MiB（含 `libreoffice-kit`、
  `sherpa-onnx`、`sharp`、`node-pty` 等本 profile 一个都不加载的重资产）。当前裁剪把
  654 包 / 836.3 MiB 降到 **239 个安装副本 / 430.2 MiB**（407 个包名 / 415 个副本 / 402.0 MiB）；
  `node-pty` 因源码里出现名字而被保守保留，`libreoffice-kit`、`sherpa-onnx`、`sharp`、`dfa`
  已移除。裁剪结论只对当前 lockfile 与 profile 配置成立，改插件 config 需要重算。
- **只到 stdio 阶段**：没有 broker、没有真实模型请求、没有 90 秒强杀与 Job Object 回收。
- **单 OS**：只有 Windows x64。
- **无签名/无升级**：校验和只建立完整性，不建立信任。
- **未接入根测试门禁**：`package.json` 的 `test:*` 不在本任务授权范围内，因此
  `tests/packaging/**` 目前只能手动运行。接入门禁属于根治理任务的改动。
