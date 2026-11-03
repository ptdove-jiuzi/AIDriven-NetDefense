<!-- AegisHarness plugin manager — author: PT-dove -->

# @aegisharness/plugin-manager

离线检查一个**已经解包**的 dsh 风格插件目录，只读、不执行、不落盘。

- 作者：PT-dove
- 许可证：Apache-2.0
- 运行环境：Node.js >= 24.9.0，纯 ESM，零第三方依赖（只用 `node:` 内置模块）

## 1. 范围

本包只做一件事：把一个目录当成**文本与字节**来检查，输出结构化的兼容性结论。

| 能力 | 说明 |
|---|---|
| 目录结构与文件类型检查 | 拒绝符号链接、特殊文件、超大文件 |
| 双摘要计算 | `manifestSha256`（plugin.json 的 JCS 摘要）、`packageSha256`（包树摘要） |
| package.json / plugin.json 封闭 Schema 校验 | 未知字段、缺失字段、越界值全部拒绝 |
| 源码静态扫描 | 词法分析 import/export、危险全局、CJS 入口，不加载任何模块 |
| 模块图遍历 | 从入口按相对 `.js` 导入做 BFS，校验路径安全与包根约束 |
| overlay 校验 | 安全字段必须与已批准 manifest 的派生投影逐字节一致 |

## 2. 非目标

以下行为**不在本包内**，也不应被调用方期待：

- 不解包归档，不做任何解压缩或暂存
- 不安装、不升级、不改写依赖
- 不启用/禁用/卸载插件
- 不加载、不编译、不执行被检查插件的任何代码，插件源码永远只被当作字符串读取
- 不访问网络，不做任何远程解析
- 不写文件、不建目录、不产生临时落盘

`inspectPluginDirectory` 的返回值里带有固定常量 `sideEffects`：

```js
{ writes: 0, executedPluginCode: false, staged: false }
```

## 3. 固定兼容 profile

```
dsh                        0.2.2-alpha.2
@deepseek-ai/cordis        4.0.6-alpha.1
Node.js                    >=24.9.0
模块类型                   module（ESM only）
入口                       lib/index.js
API 版本                   aegis-extension-v1
RPC 版本                   1.0
```

上限（`COMPATIBILITY_PROFILE.limits`）：

| 项 | 上限 | 项 | 上限 |
|---|---|---|---|
| plugin.json | 64 KiB | package.json | 64 KiB |
| 单源文件 | 256 KiB | 源文件数 | 128 |
| 工具数 | 32 | 工具超时 | 5000 ms |
| 工具结果 | 64 KiB | prompt 文本 | 4096 字节 |
| activate | 5000 ms | dispose | 5000 ms |
| 单条 RPC | 64 KiB | 包内单文件 | 8 MiB |

profile 之外的一切都必须拒绝：不保证任意 dsh 插件可用，只承诺这一份合同。

## 4. plugin.json 封闭字段

根对象必需字段：

| 字段 | 规则 |
|---|---|
| `schemaVersion` | 必须 `"1.0"` |
| `id` | 反向 DNS 小写，`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`，<= 128 字符；`aegis.` / `core.` / `builtin.` / `dsh.` 前缀保留给内置 |
| `name` | 1..64 字符，无控制字符，首尾无空格 |
| `version` | 严格 semver（可带 prerelease、可选 build metadata，禁止数值前导零） |
| `api` | 必须 `"aegis-extension-v1"` |
| `engine` | 封闭对象，只允许 `dsh` 一个键，值必须 `"0.2.2-alpha.2"` |
| `entry` | 必须 `"lib/index.js"`。结构性不安全的字符串（`..` 段、绝对路径/盘符、反斜杠、`%` 编码、控制字符）→ `ENTRY_PATH_UNSAFE`；仅位置不同（`dist/index.js`、`./lib/index.js`、`lib/index.mjs`）→ `ENTRY_MISMATCH` |
| `permissions` | 数组，最多 6 项，无重复，只能取 6 个权限之一 |

可选字段：`description`、`publisher`、`license`、`tools`、`prompt`、`configSchema`。其他任何键都是 `UNKNOWN_FIELD`。

### 4.1 工具项

每项封闭，只允许 `name`、`description`、`inputSchema`、`outputSchema`、`timeoutMs`（除 `timeoutMs` 外均必填）：

- `name` 匹配 `/^[a-z][a-z0-9_]{0,30}$/`，全数组不得重名；工具全名固定 `plugin.<id>.<name>`
- `description` 1..512 字符，无控制字符
- `inputSchema` / `outputSchema` 走封闭 Schema 子集
- `timeoutMs` 若出现必须是 1..5000 的整数，缺省 5000

### 4.2 prompt

封闭对象，只允许 `role`、`position`、`text`：

- `role` 必须 `"user"`（插件文本永不进入 system）
- `position` 必须 `"analysis-context"`
- `text` 按 **UTF-8 字节**计 1..4096，禁止 U+0000 及其他 C0 控制字符（允许 `\t`、`\n`）

### 4.3 configSchema

必须通过封闭 Schema 子集校验，且根 `type` 必须是 `"object"`。

### 4.4 交叉规则

| 情况 | 结果 |
|---|---|
| 有 tools 但没声明 `analysis.tool.register` | `PERMISSION_CONFLICT` |
| 声明了 `analysis.tool.register` 但 tools 为空 | `PERMISSION_CONFLICT` |
| 有 prompt 但没声明 `analysis.prompt.contribute` | `PERMISSION_CONFLICT` |
| 声明了 `analysis.prompt.contribute` 但没 prompt | `PERMISSION_CONFLICT` |

## 5. package.json 封闭字段

允许字段：`name`、`version`、`description`、`license`、`author`、`type`、`main`、`exports`、`engines`、`peerDependencies`、`peerDependenciesMeta`、`dependencies`、`optionalDependencies`、`files`、`keywords`、`repository`、`homepage`、`bugs`、`sideEffects`、`private`。

强制规则：

- `scripts`（含 `preinstall`/`install`/`postinstall`/`prepare` 等生命周期键）、`bin`、`gypfile`、`imports`、`workspaces`、`bundledDependencies`/`bundleDependencies` 直接 `INVALID_VALUE`，不允许任何安装期可执行面
- `type` 必须 `"module"`，否则 `MODULE_TYPE_INVALID`
- `main` 必须存在且等于 `lib/index.js`，否则 `ENTRY_MISMATCH`
- `exports` 必须是对象，且**只有** `"."` 一个键；`exports["."]` 必须是对象且**只有** `default` 一个条件，值 `"./lib/index.js"`；出现 `import`/`require`/`node` 条件、子路径或 `*` 通配一律 `ENTRY_MISMATCH`
- `peerDependencies` 必须存在，且唯一键为 `@deepseek-ai/cordis`，值精确 `4.0.6-alpha.1`，否则 `CORDIS_MISMATCH`
- `dependencies` 若出现，每个版本必须是精确版本（`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`），不接受 `^`、`~`、`>=`、`*`、`latest`、`file:`、`link:`、`git+`、`http(s):`、`npm:`；包名必须是合法 npm 名；`@deepseek-ai/cordis` 不得出现在这里
- `optionalDependencies`、`peerDependenciesMeta` 若出现必须为空对象
- `engines` 若出现只能有 `node` 一个键，值精确 `>=24.9.0`

`name` 必须等于 plugin.json 的 `id`，`version` 必须等于 plugin.json 的 `version`（由 `inspectPluginDirectory` 交叉比对）。

## 6. 六个权限与唯一接口

| 权限 | 唯一接口 | 边界 |
|---|---|---|
| `analysis.dto.read` | `analysis.getDto` | 字段/TTL/64KiB |
| `analysis.tool.register` | `tools.register` | 与 manifest 声明一致 |
| `analysis.prompt.contribute` | `manifest.prompt` | 仅 user/analysis-context，4KiB |
| `analysis.event.subscribe` | `analysis.subscribe` | 仅 analysis.started、dto.received、tool.completed、finished |
| `analysis.report.render` | `report.registerRenderer` | 纯数据投影 |
| `session.scratch.write` | `scratch` | 仅扩展自有目录，64MiB |

允许的 `inject`：`aegisAnalysis`、`aegisReport`、`aegisScratch`、`aegisLogger`。
允许的导出：`apply`（必需）、`dispose`、`inject`。

## 7. 源码静态扫描

`scanModuleSource` 只做词法分析，不执行、不编译、不做模块解析：

- 相对导入：必须以 `.js` 结尾，规范化后不得逃出包根（逃出即 `ENTRY_ESCAPE`），路径必须通过包内相对路径检查
- 精确 `@deepseek-ai/cordis` 允许；`@deepseek-ai/cordis/*`、其他裸包、`node:*`、Node builtin、URL 一律 `UNSUPPORTED_API`
- 动态 `import()` 的 specifier 必须是字符串字面量，否则 `UNSUPPORTED_API`
- `require`、`module.exports`、`exports.*` 一律 `UNSUPPORTED_API`（不支持 CJS）
- `process`、`eval`、`Function`、`Deno`、`Bun`、`Worker`、`Atomics`、`SharedArrayBuffer`、`globalThis.process`、`global.process`、`import.meta.resolve` 一律 `UNSUPPORTED_API`
- 入口导出面只允许 `apply`/`dispose`/`inject`；`export default` 与 `export *` 是 `UNSUPPORTED_API`，其他命名导出是 `EXPORT_SHAPE_INVALID`，缺 `apply` 也是 `EXPORT_SHAPE_INVALID`
- `inject` 必须字面量数组且元素都在白名单内，否则 `UNSUPPORTED_API`

同一包内的辅助模块（被入口相对导入的文件）不受入口导出面约束，只受导入与危险全局约束。

支持的常见写法包括 `return /\d+/.test(x)` 这类关键子后的正则字面量；`inject` 可以是
`export const inject = [...]`，也可以先声明再 `export { inject }`（值仍必须是白名单内的字面量数组）。

### 7.1 信任边界（重要）

**静态扫描是兼容性门禁，不是安全边界。** `inspectPluginDirectory` 的 `ok === true` 只表示
「这个包符合本 profile 的可检查部分」，不表示「运行它是安全的」。词法层无法判定
`(()=>{}).constructor('return process')()`、`Reflect.get(globalThis,'process')`、
`const { process: p } = globalThis`、`globalThis['pro'+'cess']` 这类构造，也无法替代进程隔离。
真正的边界由 `PLUGIN_SYSTEM.md` 第 2 节要求：每 analysis 独立扩展进程、独立 UID/SID、拒绝网络、
只经受限 RPC 交互、扩展进程拿不到 worker 的对象与凭据。

因此返回值里固定带 `staticScanOnly: true`；上层不得把 `ok` 当作授权依据，运行时 loader 必须
独立执行同一套导入规则（profile §1「静态检查与运行时 loader 均执行同一规则」）。

## 8. overlay 与 Effective Manifest

overlay 根封闭，只有 `schemaVersion`（必须 `"1.0"`）与 `plugins`（数组）。

每个条目的封闭字段：`id`、`version`、`packageSha256`、`manifestSha256`、`permissions`、`tools`、`prompt`、`runtime`、`config`。

规则：

0. 批准记录必须**自洽**：`manifestSha256` 必须等于批准记录里所存 `manifest` 对象的 JCS 摘要。
   不一致（例如 manifest 已更新、却仍保留旧 digest）直接 `OVERLAY_APPROVAL_MISMATCH`，不会派生任何投影。
   这是 `PLUGIN_SYSTEM.md` §5「权限扩大时保留旧批准权限和 digest，直到管理员重新确认」的
   强制点：**不允许「新 manifest + 旧 digest」的中间态**。
1. `id` 必须是小写反向 DNS 标识符，且存在于已批准集合，否则 `OVERLAY_APPROVAL_MISMATCH`
2. `version`、`manifestSha256`、`packageSha256` 必须与批准记录完全一致，否则 `OVERLAY_APPROVAL_MISMATCH`
3. `id` 命中内置列表或以保留前缀开头 → `OVERLAY_BUILTIN_IMMUTABLE`（只允许新增，禁止 patch/delete/replace 内置条目）
4. 条目内 `id` 重复 → `OVERLAY_DUPLICATE`
5. `permissions`、`tools`、`prompt`、`runtime` 与 `deriveSecurityProjection(manifest)` 做 **JCS 字符串严格相等**比较；任何新增、删除、修改（多一个权限、改 inputSchema、改 prompt 文本、调大 limits）都是 `OVERLAY_TAMPER`，绝不进入 Effective Manifest
6. 省略安全字段视为「未声明」：省略只在派生值为空（`[]` / `null`）时才等价，其余情况同样是 `OVERLAY_TAMPER`
7. 唯一例外是 `config`：只允许按已批准 manifest 的 `configSchema` 校验；没有 `configSchema` 却出现 `config` 是 `CONFIG_INVALID`

`deriveSecurityProjection` 的 `runtime` 是固定派生值：

```json
{
  "api": "aegis-extension-v1",
  "entry": "lib/index.js",
  "module": "esm",
  "node": ">=24.9.0",
  "engine": { "dsh": "0.2.2-alpha.2", "cordis": "4.0.6-alpha.1" },
  "limits": {
    "activateMs": 5000, "disposeMs": 5000, "toolMs": 5000,
    "toolResultBytes": 65536, "promptBytes": 4096,
    "scratchFileBytes": 1048576, "scratchTotalBytes": 67108864, "rpcBytes": 65536
  }
}
```

`buildEffectiveManifest` 产出 `{ schemaVersion, api, rpc: { version, methods }, builtins: [...按 id 排序], plugins: [...按 id 排序] }`，`digest` = JCS 规范化后 SHA-256。

每个 `plugins[]` 条目含 `id`、`version`、`manifestSha256`、`packageSha256`、`security`、`config`。
`security` 就是该插件的 `permissions` / `tools` / `prompt` / `runtime` 投影，**因此 digest 直接覆盖安全字段**：
两个仅有权限不同的 overlay 会得到不同 digest，broker/worker/extension host 比对同一 digest 时
不能只比 id 与双摘要。`builtins` 同样进入 digest，不被丢弃。

## 9. 两个摘要

- `manifestSha256`：`SHA-256(JCS(plugin.json 解析值))`，即对规范化后的文本做摘要
- `packageSha256`：**归档摘要的替代物**。对包树内每个普通文件按相对 POSIX 路径排序，逐个拼接 `相对路径\0文件SHA-256\0字节数\n`，再对整串做 SHA-256。目录不单独计入，空目录不影响结果，符号链接一律拒绝

包内不自证哈希：摘要只由检查方计算，插件无法在包内声明自己的摘要。

`inspectPluginDirectory` 的 `manifestSha256` 取的是**磁盘上 plugin.json 解析值**的 JCS 摘要；
`validateOverlay` 的批准记录则应存「被批准的那份 manifest 文档」并保证其摘要等于 `manifestSha256`（规则 0）。
两者一致的前提是批准时保存的是同一份文档，不要存归一化后被追加默认值的副本。

报告里另有 `manifestDocument`（`manifestSha256` 就是它的摘要，批准记录应原样保存它）、
`dependencies`（package.json 声明的运行时依赖）与 `staticScanOnly: true`。
`package.json` 的 `name` 允许是 `@scope/pkg` 形式，不要求等于 `plugin.json.id`；插件身份只由 `id` 决定，
`version` 必须与 manifest 完全一致（允许 prerelease）。

## 10. 错误码

| 码 | 含义 |
|---|---|
| `INVALID_ARGUMENT` | 程序性参数错误 |
| `IO_ERROR` | 读取失败 |
| `INVALID_JSON` | JSON 语法非法（含原始控制字符、尾随内容、非法数字） |
| `DUPLICATE_KEY` | 同一对象内重复键（解析阶段发现） |
| `INVALID_UNICODE` | 非法 UTF-8 或孤立代理项 |
| `LIMIT_EXCEEDED` | 超过大小/深度/数量上限 |
| `SCHEMA_VIOLATION` | Schema 本身或实例不符合封闭子集 |
| `UNKNOWN_FIELD` | 未知字段 |
| `MISSING_FIELD` | 缺失必填字段 |
| `INVALID_VALUE` | 值类型或取值非法 |
| `DUPLICATE_ENTRY` | 数组内重复项 |
| `ENTRY_PATH_UNSAFE` | 包内相对路径不安全 |
| `ENTRY_MISSING` | 入口或模块不存在 |
| `ENTRY_NOT_REGULAR` | 非普通文件 |
| `ENTRY_ESCAPE` | 路径逃出包根 |
| `ENTRY_MISMATCH` | entry / main / exports 不一致或不符合固定入口 |
| `ENGINE_MISMATCH` | engine.dsh 版本不符 |
| `CORDIS_MISMATCH` | Cordis peer 依赖不符 |
| `MODULE_TYPE_INVALID` | 非 ESM |
| `EXPORT_SHAPE_INVALID` | 导出面不符合 `apply`/`dispose`/`inject` |
| `UNSUPPORTED_API` | 使用了 profile 外的 API/模块/全局 |
| `UNSUPPORTED_PERMISSION` | 未知权限 |
| `PERMISSION_CONFLICT` | 权限与 tools/prompt 声明冲突 |
| `TOOL_NAME_INVALID` | 工具名不合规 |
| `PROMPT_INVALID` | prompt 字段或大小不合规 |
| `PACKAGE_SYMLINK` | 包内存在符号链接 |
| `PACKAGE_TOO_LARGE` | 包内文件超大 |
| `OVERLAY_SCHEMA` | overlay 结构非法 |
| `OVERLAY_DUPLICATE` | overlay 内 id 重复 |
| `OVERLAY_ESCALATION` | 保留给上层策略：显式扩权尝试 |
| `OVERLAY_TAMPER` | 安全字段与派生投影不一致 |
| `OVERLAY_BUILTIN_IMMUTABLE` | 试图改动内置条目 |
| `OVERLAY_APPROVAL_MISMATCH` | id/版本/双摘要与批准记录不符 |
| `CONFIG_INVALID` | overlay config 无 configSchema 或校验失败 |

`PluginCheckError` 只用于参数错误、IO 错误这类程序性失败；manifest 内容问题一律走 `diagnostics`，不抛异常。`diagnostics` 按插入顺序保存，同一 `(code, path)` 只保留第一条。

## 11. 本地试用

在包目录内直接引用（推荐）：

```bash
cd apps/plugin-manager
node --input-type=module -e "import { inspectPluginDirectory } from './src/index.js'; const r = inspectPluginDirectory('D:/work/my-plugin'); console.log(r.ok, r.diagnostics);"
```

只跑 JSON 与摘要：

```bash
cd apps/plugin-manager
node --input-type=module -e "import { digestOf, parseStrictJson } from './src/index.js'; console.log(digestOf(parseStrictJson('{\"b\":1,\"a\":2}')));"
```

从其他目录用绝对路径导入时，请把路径转成 file URL（Windows 上形如 `file:///D:/...`）。

`ok` 为 `true` 当且仅当 `diagnostics` 为空。`incompatibilities` 单独汇总 `UNSUPPORTED_API`、`ENGINE_MISMATCH`、`CORDIS_MISMATCH`、`UNSUPPORTED_PERMISSION`、`EXPORT_SHAPE_INVALID`，便于上层展示。

## 12. 实现取舍

- 词法层的正则/除号判定使用「前一个有效 token」启发式：标识符、数字、字符串、模板、`)`、`]`、`}`、正则之后视为除号，其余按正则字面量处理。这是静态扫描的保守近似，不追求完整的语法分析
- 入口必须严格是 `lib/index.js`，因此包内深层的“入口”不被接受；`ENTRY_ESCAPE` 只可能来自相对导入越界
- 同一源文件的多条同类诊断使用带行号的 path（如 `/lib/index.js:3`），以便保留全部发现而不是被去重
- 包树遍历上限 8192 个文件、单文件 8 MiB，超出即拒绝，避免检查器本身被拖垮
