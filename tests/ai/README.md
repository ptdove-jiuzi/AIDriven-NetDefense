# tests/ai · 本机 OpenAI 兼容假 provider（跨席契约 v1）

给 **explain-chain / tier / cost-degrade** 三席使用：用本机假端点证明「请求真的发出去了」，
并让客户端能区分五种响应。**零外联**：只用 `node:http`，只监听 `127.0.0.1:0`，不连任何真实模型服务。

```js
import { startFakeProvider, BEHAVIORS } from '../ai/fake-provider.mjs'; // 按你自己的相对路径改
const provider = await startFakeProvider({ behaviors: { 'fixture-a': 'delta' } });
try {
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-not-a-real-provider-key-0001' },
    body: JSON.stringify({ model: 'fixture-a', stream: true }),
  });
  /* … 断言 … */
} finally {
  await provider.close(); // 必须：不留 socket / 定时器句柄
}
```

> 契约是跨席的：**字段名与行为语义不要单方改**，要改先报 Lead（N-036 §6）。作者：PT-dove。

## 1. 签名

```js
export const BEHAVIORS = Object.freeze(['delta', 'tool-call', 'rate-limit', 'timeout', 'truncated']);

export async function startFakeProvider(options = {}) -> Promise<FakeProvider>

// options
//   behaviors?: { [modelId]: 'delta'|'tool-call'|'rate-limit'|'timeout'|'truncated' }
//   defaultBehavior?: 同上（默认 'delta'；model 未登记时用它）
//   chunks?: string[]              // 默认 ['fake-delta-1','fake-delta-2']
//   gapMs?: number                 // 每帧之间的间隔，默认 0
//   usage?: {prompt_tokens, completion_tokens, total_tokens?} | null   // null = 不写 usage 帧
//   toolCall?: {name, arguments}   // ⚠ arguments 必须是 **JSON 字符串**（OpenAI 线格式），不是对象；
//                                  //   传对象会当场 TypeError（不做隐式序列化）
//   hangMs?: number                // timeout 行为挂多久后 destroy，默认 30000
//   truncateAfterChunks?: number   // truncated 行为写几帧后 destroy，默认 2
//   delayFirstByteMs?: number      // 写响应头前延迟，默认 0

// FakeProvider
//   port, origin ('http://127.0.0.1:<port>'), baseUrl (origin + '/v1'), requests[]
//   modelsSeen(): string[]                 // 出现过（首现顺序、去重）的 model 名
//   count(pathSub?): number                // path/url 包含该片段的请求数；不传 = 全部
//   reset(): void                          // 清空 requests（不回退 index）；等待中的 waitFor 以 ERESET 拒绝
//   waitForRequests(n, timeoutMs=2000)     // n 条请求到齐（且请求体解析完）→ resolve(records)，超时 ETIMEOUT
//   waitForAbort(timeoutMs=3000)           // 任一请求 abortedAt 落账 → resolve(该 record)，超时 ETIMEOUT
//   close(): Promise<void>                 // 幂等；清 socket + 定时器，之后等待一律 ECLOSED
//   附加只读：config（归一化配置）、closed（getter）
```

`requests[]` 每条记录（契约字段）：

| 字段 | 含义 |
|---|---|
| `index` | 到达序号（生命周期内单调递增，`reset()` 不回退） |
| `method` / `path` / `url` | 请求方法、pathname、原始 url |
| `headers` | 小写化后的请求头（含 `authorization`，可断言 Bearer 真的带上了） |
| `at` | 请求到达的 `Date.now()` |
| `body` | 解析后的 JSON（不是 JSON 则 `null`） |
| `rawBody` | 原始请求体文本 |
| `model` / `stream` | `body.model` / `body.stream === true` |
| `statusWritten` | 是否写过响应头（timeout 行为恒为 `false`） |
| `responseEnded` | 是否正常 `res.end()`（truncated 恒为 `false`） |
| `closedAt` / `abortedAt` / `closedAfterMs` | 连接关闭时刻 / 未正常结束即关闭的时刻 / 关闭耗时 |
| 附加 | `behavior`（解析出的行为）、`bodyReady` |

## 2. 行为语义（判据）

| behavior | 实际响应 |
|---|---|
| `delta` | `200 text/event-stream`；逐块 `data:{"choices":[{"delta":{"content":"…"}}]}`；末帧 `delta:{}, finish_reason:"stop"` + `usage`；再 `data: [DONE]` |
| `tool-call` | `200 SSE`；`delta.tool_calls[0]`（`id` / `type:"function"` / `function.name` / `function.arguments`）；末帧 `finish_reason:"tool_calls"` + `usage`；再 `[DONE]` |
| `rate-limit` | `429 application/json`：`{"error":{"message":"synthetic rate limit","type":"rate_limit_error"}}` |
| `timeout` | **不写响应头、不响应**，挂 `hangMs` 后 `res.destroy()`（客户端拿不到响应头） |
| `truncated` | `200 SSE`，写 `truncateAfterChunks` 帧后 `res.destroy()`：**没有 `[DONE]`、不 end**，客户端读流报错/中断 |

> **`toolCall.arguments` 必须是 JSON 字符串**（`JSON.stringify({...})`），这是 OpenAI 线格式；
> 传对象会直接 `TypeError`。Lead 的独立冒烟按此口径校验。

> **连接池卫生**：`truncated` 的响应永远不会正常结束，因此该响应头显式带 `connection: close`
> （并关掉 `res.shouldKeepAlive`），断连后连接**不可复用**。这样同一个 provider 实例上连续打
> 五种行为不会出现 `TypeError: fetch failed / SocketError: other side closed` 之类假红。
> 自测里有一条专门回归：`同一实例连续打五种行为…无连接级异常`。

- **行为按请求体里的 `model` 名映射**；未登记 → `defaultBehavior`。
- `GET /v1/models` → `{"object":"list","data":[{"id":"…"}]}`，`id` 取 `Object.keys(behaviors)`；没配则给五个默认名 `fake-delta` / `fake-tool-call` / `fake-rate-limit` / `fake-timeout` / `fake-truncated`。
- 非流式（`stream !== true`）时 `delta` / `tool-call` 返回完整 JSON（`chat.completion`），方便 explain 的兜底路径；`rate-limit` / `timeout` / `truncated` 与 `stream` 无关。**这是契约扩展，不是必用路径。**
- `usage` 帧回显时附加 `total_tokens`（= prompt + completion，未给时自动算）。

## 3. 三个高频断言片段

```js
// a) 流式增量拼起来 / 有 [DONE]
const text = await response.text();
const frames = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
const done = frames.at(-1) === '[DONE]';
const content = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
  .flatMap((p) => (p.choices ?? []).map((c) => c.delta?.content)).filter(Boolean).join('');

// b) 429 必须真的打到 provider
assert.equal(provider.count('/v1/chat/completions'), 1);
assert.equal(provider.requests[0].model, 'fixture-rate-limit');

// c) 取消：等 provider 侧连接关闭（不要 sleep 猜）
const aborted = await provider.waitForAbort(3000);  // 实测通常 < 50 ms
assert.equal(aborted.responseEnded, false);
```

## 4. 必须知道的坑

1. **`close()` 放 `finally`**：不关的话 `node --test` 会挂住（我们的自证就是「关完自然退出」）。
2. `waitForRequests` / `waitForAbort` **超时是 reject**（`code: 'ETIMEOUT'`），不是返回 `[]`——别静默吞掉。
3. `timeout` 行为本身不设客户端超时；**调用方自己要给 `AbortSignal.timeout(...)`**，否则你的测试会一直等（`hangMs` 到点服务端会 destroy，但那之前是真空档）。
4. `truncated` 在客户端只能从「无 `[DONE]` + 读流报错/中断」识别，别指望 HTTP 状态码不同（就是 200）。
5. **一个实例可连续打五种行为**：`truncated` 响应带 `connection: close`，断连后连接不复用，同 origin 的下一条请求照常可用；已用回归用例覆盖，不用自己再造「每行为一个 provider」的绕行。
6. 端口一律 `127.0.0.1:0`，**不得固定端口、不用 17900–17999**（PERF-CPU 保留段）。
7. 测试与证据里**不得出现真实 key**；canary 用 `fixture-not-a-real-provider-key-…`。
8. 拒绝非法配置（未知 behavior / 空 chunks / 负数值 / `toolCall.arguments` 不是字符串）会立刻 `TypeError`，不会静默降级。

## 5. 证据与自证

- 自证：`node --test tests/ai/fake-provider.test.js`（14 tests，见 `evidence/ai/fake-provider/RESULT.json` 与 `test-run.log`）。
- 门禁命令请用**文件或 `*.test.js` 通配**：
  `node scripts/run-tests.mjs 14 "tests/ai/**/*.test.js"`。
  ⚠ 不要用 `"tests/ai/**"`：`node --test` 会把通配到的**每个文件**都当测试文件跑，
  连 `README.md` 和 `.mjs` 辅助模块也算，结果必然红（本席实测 `tests/ai/**` → 3 个假红）。
- 生成证据：`node tests/ai/emit-evidence.mjs`（真实跑五种行为 + 同实例连续打 + 映射 + abort，并复跑测试统计 pass/fail）。
- 契约若确需变更：先 `send_message` 报 Lead，**不要单方改字段名/语义**。
