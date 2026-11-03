# ADR-0003：合同扩展字段 `Alert.window_start` / `window_end` 的偏离登记

- 状态：**Accepted（2026-11-01）**
- 相关：`packages/contracts/src/objects/alert.js`、`packages/detection/src/contracts-adapter.js`、`docs/design/SOFTWARE_DESIGN.md`

## 1. 偏离事实

`packages/contracts/src/objects/alert.js` 把 `window_start` 与 `window_end` 设为
`required: true` 的必备字段，而设计基线未列这两个字段。

**被偏离条款**：`docs/design/SOFTWARE_DESIGN.md` §4.2「主要对象」表，Finding/Alert 行

> | Finding/Alert | rule_id/rule_version、event_ids、fingerprint、severity、first/last_seen、count、status、evidence_refs |

该行未包含 `window_start` / `window_end`。

## 2. 为什么必须加

本次重构按设计 §4.1「ID 使用随机 UUID」移除了检测层的内容派生 ID：

- 旧：`alertId = shortHash(fingerprint | windowStart, 32)`，ID 即身份，天然幂等；
- 新：`alert_id` 是注入工厂产出的随机 UUIDv4，**不再可由内容推导**。

于是告警的幂等写入失去了可用键。唯一可靠的替代是 `(fingerprint, window_start)`——
15 分钟聚合窗口是设计 §6 明确规定的告警边界，`window_start` 是该窗口的规范起点。

**这个键必须能在 DTO 内表达**，否则 `packages/event-store`（T1 事务，设计 §7.2）
无法在只有 DTO 的情况下做幂等 upsert。因此 `window_start` 不是可选项，是移除内容派生 ID 的
必然配套。

`window_end` 一并加入，是因为只给起点会让消费方各自重算窗口长度（15 分钟 vs 可配置
`aggregationWindowMs`），重算分歧会直接变成"同一告警被判成两条"。

## 3. 豁免范围

- 仅限 `Alert` 对象新增这两个字段；`Finding` 不加（单次观测无窗口语义）。
- **不修改** `docs/design/SOFTWARE_DESIGN.md`：本次任务的禁改清单包含"已定稿设计文档"。
- 不放宽任何既有字段约束；`Alert` 仍是封闭 schema，未知字段一律拒绝。
- 不影响 `schemaVersion`：仍为 `1.0`，两个对象此前在 contracts 中并不存在，
  没有已发布的旧消费者需要兼容。

## 4. 风险

1. 后续审查者若按 §4.2 旧表核对，会把"合同多出两个字段"判为偏离；
   若按新合同核对，会判"设计漏字段"。两边都缺一个权威口径。
2. 不在版本库外的临时状态文件属于可重写文件，不能长期承载可审计的偏离记录——这正是本 ADR 存在的原因。
3. 若设计复议决定不接受这两个字段，替代方案只有"恢复内容派生 ID"或"由 event-store 自行维护
   外部映射表"，两者都比当前方案代价高。

## 5. 回写验收判据（关闭本 ADR 的条件）

全部满足时，把本 ADR 状态改为 `Superseded`，并在设计 §4.2 落地：

1. `SOFTWARE_DESIGN.md` §4.2 的 Finding/Alert 行补入 `window_start`、`window_end`；
2. 同一节补一句：「`(fingerprint, window_start)` 是告警唯一 upsert 键；`alert_id` 为仅插入代理键」；
3. 设计文档头部的版本号递增（当前 v1.3 → v1.4），并在本 ADR 回填对应版本号作为引用锚点
   （设计文档目前没有独立的修订记录章节，因此以头部版本行为准，不新增章节）；
4. 偏离条目改为指向设计新版本，而非本 ADR。

## 6. 证据

- 字段定义：`packages/contracts/src/objects/alert.js:41`（`window_start`）、`:42`（`window_end`），均 `required: true`；
  同一文件 `:21-22` 的注释说明了"去掉内容派生 ID 后唯一 upsert 键是 `(fingerprint, window_start)`"
- 跨字段校验：同文件对 `window_start <= first_seen`、`last_seen <= window_end` 的关系校验（`validateAlert` 内）
- 适配层填充：`packages/detection/src/contracts-adapter.js:259-260`（`toAlert()`）
- 独立审查认定"字段本身必要"：合同审查检查项 A6
- 消费约束：`packages/detection/INTEGRATION.md:117`（`alert_id` 不得被 upsert 覆盖）

> 行号维护说明：本 ADR 的指针曾因 `packages/detection` 的改动整体位移而失效过一次。
> `tests/wp3-detection/adr-pointers.test.js` 现在会校验这几处指针确实指向声称的内容，
> 改动相关文件后若忘记更新本 ADR，该测试会失败。
