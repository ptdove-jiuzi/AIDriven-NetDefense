# AIDriven NetDefense

**网域智防** — a local-first network defense agent for a single host.

> **Status: pre-release source drop.** The version in this tree is `0.0.0`. The first
> complete version is planned as `0.0.1` and has not been frozen. No installer, no signed
> binary and no release artifact is distributed from this repository. Treat everything here
> as work in progress, not as a finished product.

Author: **PT-dove**

---

## 1. What this is

AIDriven NetDefense is a single-host defense agent. It collects host telemetry, evaluates it
against detection rules, stores findings and alerts as evidence, and — only through a
governed model-analysis path — produces a conclusion a human can act on.

The product is deliberately narrow. It is not a SIEM, not a gateway appliance, and not a
cloud service. One machine, one user, local data.

### Design stance

Four rules shape the codebase; most of the unusual decisions in it follow from these:

1. **Data stays on the host.** Collected evidence and analysis requests are not shipped to a
   hosted service. Any model endpoint is explicitly registered by the local operator, with a
   per-endpoint budget and a frozen resolution of scheme/host/port/path.
2. **Evidence is accountable.** An alert's `count` must be explainable by event rows that
   actually exist in storage. Code paths that could produce a count without a traceable row
   are treated as defects, not as acceptable approximations.
3. **Fail closed.** When a budget is exhausted, a signature does not verify, a policy field is
   missing, or an integrity check cannot be performed, the operation is refused. Degradation
   is surfaced as an explicit `degraded` state, never as a silent downgrade.
4. **A human approves action.** The response side produces plans. It does not execute.

---

## 2. What is in the tree

| Path | Contents |
|---|---|
| `apps/daemon` | The agent: ingestion pipeline, storage adapters, local read API, health |
| `apps/cli` | Command-line client for the local API |
| `apps/console` | Local web console — static files, no build step, no framework, no CDN |
| `apps/desktop` | Desktop shell (Python, tkinter) that supervises the daemon and hosts the console |
| `apps/model-broker` | Governed model endpoint: admission, budgets, circuit breaking, request shaping |
| `apps/harness-worker` | Worker that runs the analysis session out of process |
| `apps/plugin-manager` | Plugin inventory and compatibility checks |
| `apps/response-helper` | Response **planning** (action execution is not implemented, see §3) |
| `apps/service-host` | Service supervision helpers |
| `packages/contracts` | Data contracts: events, findings, alerts, analysis reports |
| `packages/collectors` | Telemetry collectors (common / linux / windows) |
| `packages/detection` | Rule evaluation engine and contract adapters |
| `packages/event-store` | Durable event log, dedupe keys, transactional ingest, recovery |
| `packages/policy` | Budget and escalation policy |
| `packages/response-policy` | Response gating and approval policy |
| `packages/harness-adapter` | Validation and transport for the analysis session |
| `packages/ipc`, `packages/test-support` | Local IPC helpers and shared test utilities |
| `plugins/` | The defense profile (plugin tree manifest) and defense tools |
| `deploy/` | Runtime staging, systemd unit templates, Windows installer prototype |
| `scripts/` | Build, gate and release tooling |
| `tests/` | Unit, contract, integration, e2e, packaging, security-corpus and soak suites |
| `docs/design/` | Architecture, plugin system, harness contract, test & acceptance criteria |
| `docs/product/` | Product-facing descriptions, including an explicit gap list |
| `docs/adr/` | Accepted architecture decision records |

---

## 3. Capability boundaries — what this does **not** do

This section exists because the honest description of a security tool is mostly a list of
what it cannot do yet. The following are **absent or unverified today**:

| Area | Current state |
|---|---|
| **Signed installer / uninstaller** | A Windows installer prototype and a transaction engine live under `deploy/windows/installer/`. There is no signed `.exe`, no MSI/MSIX, no packaged release. |
| **Code signing** | No certificate, no signature chain, no `signtool` invocation. |
| **Cross-platform validation** | Only `win32-x64` has actually been run. Linux and win32-arm64 paths exist in code but carry no runtime evidence. Do not assume they work. |
| **Response execution** | `apps/response-helper` produces plans only. Execution is disabled in code; every action reports `dry_run_only`. |
| **Approval API** | The local API has a closed set of read/probe routes. There is no approval or response endpoint, so "human approval" exists in the data model and policy layer only. |
| **Bundled detection rules** | No rule pack ships with the repository. Detection needs a rule pack supplied by the operator. |
| **Real-host collection** | Collectors are exercised against mock and virtual sources. Continuous collection on a real host, with measured RSS/CPU, has not been demonstrated. |
| **Model credentials** | Tests use loopback stubs and test tokens. Real credential handling, rotation and revocation are unobserved. |
| **Auto-update** | Designed in ADR-0011, which is **not accepted** and therefore not published here. No updater exists. |
| **MCP control plane / gateway edition** | Out of scope. No implementation, not planned for the first version. |
| **Performance and soak numbers** | Bench and soak suites exist but are not wired into any gate. No published figures. |

If you need any of the above, this repository is not the tool you are looking for — yet.

---

## 4. Requirements

- **Node.js** `>= 24.9.0` (see `.nvmrc`)
- **npm** `>= 11.6.0 < 12.0.0` — enforced by `scripts/check-node-version.mjs`, which fails closed
- **Python 3.11+** only if you want the optional desktop shell (`apps/desktop`)
- No network access is required to build or to run the test suites; the model endpoint used
  by tests is a loopback stub

---

## 5. Build and test

```bash
npm ci
npm test          # full gated suite, per-work-package
npm run check     # test suite + SBOM check + license check
```

Useful subsets:

```bash
npm run test:wp0              # repository baseline, harness manifest, toolchain gate
npm run test:wp1-event-store  # storage, dedupe, transactional ingest, recovery
npm run test:wp5-daemon       # pipeline, API, health
npm run test:wp6-model-broker # admission, budgets, credentials, request shaping
npm run sbom:check            # CycloneDX SBOM consistency
npm run license:check         # third-party license policy
```

The optional desktop shell:

```bash
python apps/desktop/main.py
```

`npm test` is not read-only: the harness suites regenerate evidence files under
`tests/wp0/` while they run. Expect the working tree to change after a full test run.

---

## 6. Documentation

| Start here | Why |
|---|---|
| `docs/product/01-overview.md` | What the product is, in product language |
| `docs/product/04-gaps.md` | The gap list — read this before believing any capability claim |
| `docs/design/SOFTWARE_DESIGN.md` | Architecture, data model, storage, budgets |
| `docs/design/TEST_AND_ACCEPTANCE.md` | Acceptance criteria, including data-boundary invariants |
| `docs/adr/` | Accepted decisions, with the reasoning that led to them |

---

## 7. Versioning

- `0.0.0` — the current development tree. Not a release.
- `0.0.1` — the first complete version, frozen only after functionality, install/upgrade,
  multi-OS validation, signing and the release gate all pass.
- Afterwards: `0.0.x` patches, `0.x.0` features, `1.0.0` stable.

Version numbers are not raised early to imply that a release happened.

---

## 8. License

Apache License 2.0 — see `LICENSE`. Copyright 2026 PT-dove.

Third-party attributions, including the obligations for the weak-copyleft components in the
dependency tree, are recorded in `THIRD_PARTY_NOTICES`. The machine-readable component
inventory is `sbom.cdx.json`. Security reports: see `SECURITY.md`.

---

## 9. 中文摘要

**网域智防（AIDriven NetDefense）** 是一台机器、一个用户的本地网络防御代理。它采集主机遥测，
按规则判定，把告警与证据落到本地事件库，并且只通过受预算与端点白名单约束的模型通道给出
可供人判断的结论。**不联网托管、不替代 SIEM、不做网关。**

四条贯穿全仓的原则：

1. **数据不出本机** —— 端点由本机操作者显式登记并冻结，每个端点单独计预算；
2. **证据可追责** —— 告警的 `count` 必须能对应到库里真实存在的事件行；
3. **失败即拒绝** —— 预算耗尽、签名不符、策略字段缺失一律拒绝，降级必须显式可见；
4. **动作要人批** —— 响应侧只产出方案，不执行动作。

**当前边界（先说不能做什么）**：没有签名的安装包、没有代码签名、只有 win32-x64 实跑过；
响应执行在代码里是关闭的（只出计划）；没有审批接口；不附带任何规则包，检测需要你自备；
真实主机长时采集、真实模型凭据、性能与浸泡数据均未验证；自动更新只停留在未通过的设计稿。

**构建**：Node.js ≥ 24.9.0、npm ≥ 11.6.0 < 12.0.0，执行 `npm ci` 后 `npm test` 或
`npm run check`。测试用回环桩，不需要联网。桌面壳可选：`python apps/desktop/main.py`。

**版本**：树内为 `0.0.0`；第一个完整版本是 `0.0.1`，尚未冻结。
**许可**：Apache-2.0，版权 2026 PT-dove；第三方义务见 `THIRD_PARTY_NOTICES`。
