# tests/bench — 性能基准

M9 性能与浸泡基准。作者：PT-dove。

## 怎么跑

```bash
# 自检（验证工具本身，不验证被测代码）
node --test tests/bench/self-check.test.js

# 基准（standard 档位，约 2.5 分钟；其中 35 s 是认证限流探针的固定等待）
node tests/bench/run-bench.mjs
node tests/bench/run-bench.mjs --profile quick          # 快速自检，约 20 秒
node tests/bench/run-bench.mjs --scenarios detection    # 只跑一个场景
node tests/bench/run-bench.mjs --no-gate                # 只出报告，不因检查项失败退出

# 短时浸泡（5–10 分钟，本任务明确不做 72h/7d）
node tests/soak/soak.mjs --minutes 6
```

产物写到 `docs/implementation/evidence/bench/`：一份机器可读 JSON + 一份同源的 Markdown。
退出码：`0` 全部 blocker 检查通过，`1` 有 blocker 失败，`2` 运行本身出错。

**不进 `npm test`**：性能门禁不该由单元测试承担（一次 GC 抖动就会变红），
且根 `package.json` 不在本任务可改范围内。

## 场景与它测的是什么

| 场景 | 测什么 | 关键设计 |
|---|---|---|
| `event-store` | T1 吞吐（纯事件 / 新建聚合 / 更新聚合 / 重复投递）、T2 预算周期、WAL 增长、备份耗时、RSS | 四个 T1 变体分开测；不主动 checkpoint；判重单独计时（它比写入快一个数量级，混进去会把吞吐虚高） |
| `detection` | 批量摄入吞吐、告警抑制、规则步数预算、分析请求限流 | 每项都配**对照组**或**可证伪的边界**，见下 |
| `daemon-api` | `/healthz`、`/readyz`、`/api/v1/status` 的延迟、并发与背压；认证限流是否误伤合法客户端 | 只读路由；keep-alive 池；真实 SQLite 库；背压用真实准入拒绝验证；并发每档重复 3 次取中位数与 CV；限流探针用独立实例 + 生产默认 60 s 窗口，在 +0/+5/+25/+35 s 四点取合法请求 |
| `soak` | 5–10 分钟真实 daemon 浸泡：RSS 趋势、WAL 峰值、poll 间隔漂移、API 延迟漂移 | 剔除预热段；用"间隔漂移"而非"应有 poll 次数"判断追不上 |

## 刻意避免的自欺式指标

这些是写这份基准时踩到或提前识别出的坑，改代码时不要退回去：

1. **吞吐口径混用**。同时给"计时和口径"（把单次延迟相加）与"墙钟口径"（含负载生成）。
   只报前者会把基准工具的开销藏起来，只报后者会让生成器慢看起来像存储慢。
2. **把判重当写入**。重复投递走的是"读 + 空事务"，实测快 20 倍以上。它必须单独计时。
3. **WAL 测不到**。测量期间主动 checkpoint 会把被测对象擦掉，于是"WAL 有界"恒真。
   所以只在备份阶段做一次 checkpoint，并单独记录。
4. **内存只看 `heapUsed`**。SQLite 页缓存是原生内存，`heapUsed` 看不见。
   必须看 RSS，并写明它包含什么。
5. **"检出少"当成"很快"**。detection 每个阶段都对账 `stats().events` 与投递数，
   并要求检出数 > 0。
6. **预算形同虚设**。步数预算压到 20 时，必须**同时**观察到规则隔离 **且** 检出数
   远低于默认预算的对照组（61 vs 1309）。只看"隔离发生了"不够——那可能是规则本来就不匹配。
7. **批大小混淆窗口跨度**。时钟按**每事件 1ms** 推进，而不是每批 1s；否则 batch=1
   会横跨 6000 秒，batch=512 只跨 12 秒，等于同时改了两个自变量。
8. **"应有 poll 次数 = 时长 / tickMs"**。本架构是"上次 poll 完成后等 tickMs"，
   有效间隔必然大于 tick。用那个公式会把正常行为判成缺陷（实测 60s 只跑出 115 次 poll）。
   改成看**间隔是否随时间变长**。
9. **预热段算进趋势**。前几十秒 RSS 从 59 MiB 爬到 85 MiB 是 JIT 与页缓存，
   不剔除会得到"300 MiB/min 的斜率"这种吓人但无意义的数字。
10. **只报均值**。所有延迟都给 p50/p90/p95/p99/max，精确秩，不用直方图分桶。
11. **"200 就是成功"**。status 响应体要做形状校验（`store.kind`、`counters`、`health`），
    否则空壳 200 和真实负载在延迟上没区别。

以下 5 条来自第一轮独立审查，是把"写对了"和"看起来写对了"区分开的关键：

12. **阈值与配置脱钩**。WAL 阈值曾写死 256 MiB，而 autocheckpoint 上限只有 4 MiB ——
    那条"WAL 有界"需要 64 倍退化才会红，等于恒真。现在阈值按
    `wal_autocheckpoint × page_size × 3` 计算（bench 读 PRAGMA，soak 用只读连接读一次）。
    凡是"物理上到不了的阈值"都是假门禁。
13. **期望值由实测值派生**。`requests <= distinct_fingerprints` 里的
    `distinct_fingerprints` 正是从 `analysisRequests` 里收集的，所以引擎零产出时
    `0 <= 0` 也通过。期望值必须是常数或与实测无关的量，否则检查在**缺功能**时反而最绿。
14. **结构性恒真的检查**。`no_batch_drop`（每批 25 条 vs 上限 500）与
    `no_source_failures`（来源是纯内存 Promise）在架构上不可能失败。这类检查只会制造
    "8/8 全绿"的错觉，已改为观测字段；补上真正能失败的对账：
    `soak.events_persisted`（落库数 ≥ 已接受数）。
15. **只看首末段会漏"先涨后平"**。涨完之后的点才进"首段"，于是 delta≈0。
    `self-check.test.js` 里专门留了一个用例记录这个盲区，soak 因此额外有
    `rss_peak_bounded`（峰值/首稳态 ≤ 2）与 `rss_absolute_cap`（≤ 512 MiB）。
    **不要删这两条**，它们是"首末段对比"的唯一补丁。
16. **计时区里混入负载生成**。曾把 `take()` 放在受测闭包的第一行，于是每 256 次操作
    就有一次"构造 256 条事件 + 校验 + 摘要"被计进单次延迟，两个吞吐口径只差 0.08%，
    双口径彻底失去诊断力。生成必须在计时之外。
17. **互斥的 blocker**。"锁定期内合法请求必须 200"与"打满后必须 429"在
    peer 记账的实现下互斥，于是门禁永久红、进而被 `--no-gate` 绕过。
    现在把窗口缩到 2s，"锁定期内被拒"降为 warn（观察项），"窗口过期后恢复 200"才是 blocker。
18. **地板宽到没有诊断力**。T1 地板曾为 20 ops/s（实测 462，余量 23 倍），
    detection 500（实测 3 万，余量 60 倍）。1/3 实测值才是回归守卫的合理量级，
    且必须是 blocker。
19. **不带源码摘要的证据**。没有 git 时，证据必须能回答"测的是哪版代码"。
    `env.code_digest` 对 `packages/event-store/src`、`packages/detection/src`、
    `apps/daemon/src` 做内容哈希；被测代码在跑完之后改过，摘要就不再匹配。
20. **单次测量当门禁 + 期望值由实测派生 + 没有"跑全"的断言**（并发扫描的三连坑）。
    原判据每档只测一次、`expected` 里写 `Math.max(...sweep)`、也没有检查断言 5 档都跑完，
    于是 R3 在 c=8 触发刹车后，判据被静默改写成 `throughput(c=8) >= throughput(c=2)` 并照样
    `pass`（吞吐当时从 c=4 的 5863 掉到 c=8 的 3954）。现在：
    - 每档 `REPEATS = 3` 次重复，判据吃**中位数**，同时报标准差与 CV；
    - `expected` 由纯常量函数 `scalingExpectation()` 生成，**不读任何实测值**，
      `self-check.test.js` 有回归用例断言"两组不同测量得到同一个 expected"；
    - `daemon.concurrency_sweep_complete` 是 **blocker**：缺档轮次的证据无效，必须重跑；
    - `daemon.concurrency_measurement_stable` 把 CV 报成 warn —— 它拦的是"用噪声下结论"，
      不是产品吞吐；
    - 每档请求数取整到并发度的整数倍且每 worker 至少 `MIN_PER_WORKER` 次，
      避免 `floor(200/32) = 6` 这种 20 ms 窗口。
    - 刹车（"不再升并发"）也从 `p99 > 20 × 顺序基线 p99` 改成常量上限
      `ABORT_P99_BUDGET_MS = 100`。原因：合法排队在 c=32 本来就有 25–27 倍
      （p99 12–13 ms vs 基线 0.47 ms），那个阈值低于正常水平，会把正常排队判成压垮。
21. **修复没有被判据守护，只有一条 warn 覆盖**（H-1）。认证限流 P1 修好之后，
    `daemon.backpressure_rejects` 的 `actual` 在修复前后**逐字节相同**
    （都是 `{"401":5,"429":7}`）——它只证明"错 token 仍被限流"，对"限流是否误伤
    合法客户端"零鉴别力；`daemon.auth_lockout_expires` 修复后恒真；唯一会变的那条
    是 `warn`，而 `evaluateChecks` 只看 `blocker`。实测：临时副本回退 auth 顺序后
    `verdict=pass checks=29 failures=0 warnings=1`（`status/M9-GATE-HARDEN.md` §2）。
    现在两条 **blocker** 成对存在：
    - `daemon.auth_lockout_spares_legitimate_client`：独立实例 + 生产默认 60 s 窗口，
      连发 5 个错 token 后在 **+0/+5/+25/+35 s** 四点带真 token 请求，全部必须 200；
      缺时点、出现未约定时点、任一点非 200，一律判失败（不降级为 warn）。
    - `daemon.auth_lockout_still_throttles_guesses`：合法请求之后紧接着的错 token
      必须仍是 429。**这一条不是可选项**——只有前者的话，把限流整段删掉同样会绿，
      等于把 P1（误伤）换成 P0（防爆破归零）。
    - `daemon.auth_lockout_quota_not_per_token`：5 个**互不相同**的错 token 之后再换一个
      新 token，必须仍是 429。堵的是"把失败桶按 token 记账"——那种退化下每个 token 各得
      一份新配额，攻击者轮换即可无限猜，而"同一个 token 连发"的判据看不出来。
    - `daemon.auth_failure_defaults_intact`：断言生效默认值未被弱化（`limit <= 5`、
      `window >= 36 s`）。探针实例显式传 5 / 60 s，所以"改 config 默认值"这一路它看不见：
      实测把默认值改成 1000 / 1 s 时，前面四条 auth 判据全绿而防爆破已失效。
    - `self-check.test.js` 有三条 `REGRESSION GUARD` / 退化对照：用真实 HTTP + 复刻的
      旧顺序证明"回退必红"，用"删掉限流"证明"恒真必红"，用"按 token 记账"证明
      "换个退化方向也红"。把四条 auth 判据的 `passed` 全改成 `true` 会让 10 条用例转红（变异测试）。

## 安全

- 所有数据在系统临时目录内，跑完即删。`lib/tempdir.js` 会**主动拒绝**仓库内路径与
  临时目录之外的路径——这是全文件最重要的一段代码。
- 不读写任何真实数据库、事件日志或用户数据；合成负载只用 `example-*` / `synthetic-*` 假名。
- `/api/v1/status` 的响应带 `csrf_token`：报告只保留字段形状，**不落盘任何 token 或请求头**。
- 环境信息脱敏：不写真实主机名、绝对临时路径、仓库路径、用户名目录（`<TEMP>` / `<REPO>` 占位）。
  `env.code_digest` 只含相对路径与内容哈希。
- 不在仓库内执行 `npm ci`；不修改生产代码。发现退化只报告。

## 目录

```
tests/bench/
  lib/prng.js        种子 PRNG + 子流派生
  lib/stats.js       精确秩分位数、趋势拟合、首末段对比
  lib/env.js         环境采集（CPU/内存/磁盘/Node/SQLite）
  lib/tempdir.js     临时目录 + 路径守卫
  lib/synthetic.js   合成负载（契约事件 / 引擎事件 / 基准时钟）
  lib/rulepack.js    基准规则包
  lib/sampler.js     内存与物理大小采样
  lib/report.js      JSON/Markdown 产物 + 门禁判定
  lib/concurrency.js 并发采样（重复 N 次取中位数/方差）与常量期望的判据
  lib/auth-lockout.js 认证限流探针（+0/+5/+25/+35 s 四点）与两条成对判据
  scenarios/*.js     三个场景
  run-bench.mjs      入口
  self-check.test.js 工具自检（38 例）
tests/soak/soak.mjs  短时浸泡入口
```
