# Aegis Extension v1：dsh/Cordis 兼容合同（Normative）

- 版本：v1.0（已定稿，第三轮独立复核 GO）
- dsh：0.2.2-alpha.2
- Cordis：@deepseek-ai/cordis 4.0.6-alpha.1
- Node.js：>=24.9.0，ESM only

本文件是扩展实现的规范，不是示例。符合本 profile 的真实 dsh 风格 npm 包无需改写即可在隔离扩展宿主中运行；使用 profile 外 API 的包必须明确拒绝，不能宣称兼容全部 dsh 插件。

## 1. 包与模块加载

`package.json` 必须具有：`name`、`version`、`type="module"`、`main="lib/index.js"`、`exports["."].default="./lib/index.js"`、`peerDependencies["@deepseek-ai/cordis"]="4.0.6-alpha.1"`。`plugin.json` 按 PLUGIN_SYSTEM 的封闭 Schema 校验，入口必须与 package main/export 一致。

宿主使用固定 Node ESM 加载器解析入口。只允许包内相对 `.js` 导入、锁文件中带精确哈希的依赖以及固定 `@deepseek-ai/cordis`；默认拒绝所有 Node builtin、裸包动态解析、Native addon、worker_threads、child_process 和网络模块。静态检查与运行时 loader 均执行同一规则，动态 import 也受限制。

入口必须导出 `apply(ctx, config)`；可导出 `dispose()` 和 `inject`。inject 仅允许 `aegisAnalysis`、`aegisReport`、`aegisScratch`、`aegisLogger`，由受限宿主提供 RPC 代理。其他 inject、Service、事件或 Cordis 导出均报 `UNSUPPORTED_API`。apply 可同步或返回 Promise，也可返回 cleanup function；Config 只来自 plugin.json.configSchema，其他导出 Config 形式不在 v1 支持。

## 2. 生命周期

状态：`installed → enabled → starting → active → disposing → disposed`；异常进入 `failed` 并随后 disposed。

1. apply 输入先经 configSchema 校验。注册在 staging 区，apply 未成功前工具/事件/渲染器均不可见。
2. apply 成功才原子发布 staging 注册；失败则全部回滚并返回错误，无部分可见状态。
3. 工具调用先由 worker 按输入 Schema 校验，再发 `extension.invoke`；返回前由 worker 按输出 Schema 再校验。
4. 结束先停止新调用，依次执行 apply 返回的 cleanup 和可选 dispose，再清空注册并回收进程。
5. activate/cleanup/dispose 各 5 秒墙钟；超时取消当前 analysis 的扩展，迟到结果丢弃。disable 只影响后续 analysis，当前 analysis 保持原 manifest。

## 3. RPC 安全上下文与传输

launcher 为每个 `(analysis_id, attempt_id, plugin_id)` 创建独占 Unix socket/named pipe 和独立扩展进程。bridge 从通道、OS 对端 UID/SID、启动登记记录派生安全上下文，并绑定插件 version、packageSha256、manifestSha256 和 Effective Manifest digest。**RPC 报文不接受身份字段，调用方自报身份一律无效。**

通道使用 JSON-RPC 2.0，单消息最大 64KiB。每方向维护从 1 开始的单调 sequence，重复/倒退/跳号拒绝；request id 在通道内唯一。完成、dispose、超时或通道关闭即撤销上下文，旧通道和迟到响应不得调用工具或提交数据。

### 3.1 方法

| 方法 | 参数 | 结果/限制 |
|---|---|---|
| tools.register | 与 manifest 完全一致的单个工具声明 | 仅 apply/staging；注册代理 handler |
| analysis.getDto | evidenceRef、fields[] | 需 dto.read，bridge 重新校验字段/TTL/64KiB |
| analysis.subscribe | events[] | 仅 analysis.started、dto.received、tool.completed、finished |
| report.registerRenderer | rendererId、inputSchema、outputSchema | 纯数据投影，无 HTML/URI |
| scratch.write | relativePath、dataBase64 | 规范化相对路径，单文件 1MiB，总计 64MiB |
| log.write | level、message | 4KiB，控制字符清除，不写 stdout |

bridge→extension 方法为 `extension.invoke(toolName,args)` 和 `extension.event(name,payload)`。身份由通道决定，toolName 必须属于该插件。输入先校验再调用，输出返回前再校验。

错误采用 JSON-RPC error：`-32600` 无效帧、`-32601` 不支持方法、`-32602` 无效参数、`-32603` 内部错误；自定义 `1001` 权限拒绝、`1002` 摘要/版本不符、`1003` 超时、`1004` 资源超限、`1005` 通道关闭/迟到、`1006` Schema 不符。错误不得携带秘密、堆栈或其他 analysis 数据。

## 4. Overlay 规则

overlay 的 permissions、tools、prompt、runtime 由已批准 plugin.json 确定性派生且必须完全一致；只允许管理员修改 config。任何安全字段差异在 Effective Manifest 生成前拒绝。config 或 overlay 变化生成新 digest 并需管理员批准，当前 analysis 不变。

扩展只允许新增，不允许 patch/delete/replace 内置条目。完整工具名强制 `plugin.<id>.<tool>`，重名或注册顺序冲突整个 staging 失败。

## 5. 扩展资源上限

每扩展进程：RSS 256MiB、总 CPU 30 秒/analysis、单进程且禁止子进程、最多 64 个 FD/句柄、scratch 64MiB、单 RPC 64KiB。Linux 使用独立 cgroup、UID、namespace/seccomp；Windows 使用独立 Job Object、AppContainer/SID/restricted token。超限只终止对应扩展并使当前 analysis 失败/降级，其他 analysis 与核心必须继续；整棵进程树和 scratch 按合同回收。

## 6. 兼容验收

AT-PLG-001 必须使用针对上述固定 dsh/Cordis 版本构建、未经改写的真实 ESM dsh 风格包，完成 inspect/install/enable/apply/真实工具调用/dispose/disable/remove。另测所有不支持的 inject/service/event/builtin import 明确拒绝，不能用自定义 shim 冒充兼容。
