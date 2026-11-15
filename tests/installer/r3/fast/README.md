# r3/fast · 升级四断言（红 / 绿 / 变异红）

## 一条命令

```bash
python tests/installer/r3/fast/run-four-assertions.py --variant all
```

（`--variant mutation|fix|mutA` 可单跑一条腿；三腿合计实测 14.5 s，单腿最慢约 6 s，远低于 570 s 上限。）

## 前置条件

* Windows；系统 Python 3.11+，需已装 `py7zr`（1.1.4）；
* **不需要**管理员、**不写**注册表、**不写** `%ProgramFiles%`、**不写** `apps/**` `deploy/**`；
* 工作根固定 `%LOCALAPPDATA%\Temp\p1wrap\`：`fastA/`（载荷 + 安装树）、`mutA/`（变异副本）、
  `logs/`（JSON 回执）。目录不存在会自动建，**不需要**先手工造 payload——脚本会调
  `tools/make_mini_payload.py`（rc5、rc6）与 `tools/make_archive.py` 现场生成 47 文件 / 2.7 KB 的迷你载荷；
* **TEMP 必须用长路径**：本机 `%TEMP%` 可能是 8.3 短名。安装器的 `paths.normalise()` 用
  `abspath`（不展开 8.3），而 `r3_interrupt.py` / `make_mini_payload.py` 用 `Path.resolve()`（会展开），
  两者混用时 `journal.target` 与 `/DIR=` 的字面路径不一致，`_journal_is_valid()` 直接判无效 →
  **修复版会被误判成红**。脚本里的 `long_path()` 已强制长名；这也是"不要用 `%TEMP%` 造目标路径"的原因。

## 三腿含义

| 腿 | 目录 | 含义 |
| --- | --- | --- |
| `mutation`（红） | `tests/installer/r3/mutation` | 与 `deploy/windows/installer/app` **逐字节相同**的回退体，即 shipped rc.6 的行为 |
| `fix`（绿） | `tests/installer/r3/fix` | 已含 `fix/UPGRADE-001.patch`（221 行 / 169+ 7− / 1 文件）的副本 |
| `mutA`（变异） | `%TEMP%\p1wrap\mutA` | `fix` 的**临时副本**：把 `install.py` 里"journal 有效就续做"的 `resumed = _resume_marker(target)` / `if resumed is None:` 换成 `resumed = None` / `if True:`，即恒不续做。`fix/` 原件不动 |

`mutA` 的自校验：脚本先断言该两行文本在 `install.py` 里**恰好出现 1 次**（`1 replacement`），否则直接退出
（抛出 `expected exactly 1 resume branch`）；替换后再 import 该副本。所以"只改一处"是脚本自己核过的，
不是靠肉眼。

## 断言清单

| id | 断言 | 判据 |
| --- | --- | --- |
| A1 | 冷装 | 空目录 `/S /DIR=<空目录> /NOREG /NOSHORTCUT` → exit 0；`install.json` 写 `version=0.0.1-rc.6`、`upgradedFrom=null`；入口 `AIDrivenNetDefense.exe` 在；无残留 `install/upgrade.pending.json` |
| A2 | 覆盖升级（中断后续装） | rc.5 真安装树被 rc.6 字节覆盖前 4 个文件（payload 新 / `manifests/files.sha256` 旧 / `install.json` 旧）→ 再跑 rc.6 → **exit 0** 且 `upgradedFrom == 0.0.1-rc.5`、`version == 0.0.1-rc.6`、journal 已删 |
| A3 | 两处 data 逐字节 0 差异 | `<target>\data` 升级前后全量 sha256 → 0 处不同；`%LOCALAPPDATA%\AIDriven NetDefense\data` 升级前后**只读**全量 sha256 → 0 处不同 |
| A4 | 记录字段 | `install.json` 的 `version` / `upgradedFrom` 正确，且 `install\` 下恰有 1 份 `install.json` |

A2 的"中断"按被测代码是否支持 journal 自动二选一，并在回执里如实标注：

* `fix` / `mutA` → `tools/r3_interrupt.py`：调产品自己的 `_write_journal(...)` + 真 `_copy_tree(...)`，journal 存在；
* `mutation` → 按 manifest 顺序覆盖前 4 个文件（shipped 代码里根本没有 journal，真机强杀留下的就是这个形状）。

A4 的注册表分支：**本轮不验**。`/NOREG` 下安装器不写注册表，脚本只做只读探测并记
`A4b NOT_VERIFIED / registryEntries: 0`。"卸载项恰 1 条"= **红线：会触碰主机真实安装的卸载键
`AIDrivenNetDefense`**（本机存在真实安装），因此 A4 只断言 `install.json` 字段。

## 实测（2026-11-16，本机）

```
mutation  1/4   A1 PASS；A2 FAIL（exit 1，安装被拒）→ A3/A4 记 BLOCKED
fix       4/4   A1..A4 全 PASS；A3 = target 8 文件 0 差异 + %LOCALAPPDATA% 13 文件 0 差异
mutA      1/4   A1 PASS；A2 FAIL（exit 1，且 journal 残留 true）
```

红态红的就是 A2：shipped 代码对"非空且无 marker"的目录直接拒绝；此时 A3/A4 **没有升级可断言**，
标 `BLOCKED` 而不是"通过"。

## 口径边界（重要）

* **中断状态不是真机 SIGKILL**：它是"用产品自己的 `_write_journal` + `_copy_tree`（`fix` 腿）或按 manifest
  顺序覆盖前 4 个文件（`mutation` 腿）造出的**形状**"，等价于"文件新、清单旧、记录旧"，但**没有真的杀掉进程**。
  真机强杀的时序、缓冲、句柄占用都不在本轮覆盖范围内。
* **A3 的 `%LOCALAPPDATA%` 一侧只读**：该目录是本机真实产品的数据目录（机器上有真实安装），脚本只做
  sha256 快照比对，**绝不写入、绝不创建**。若该目录不存在或为空 → 记 `未验证`，不为"凑一条绿"去创建它。
* 为了让 `find_existing()` 不落到主机真实安装上，脚本把 `AIDN_SETUP_DEFAULT_DIR` 指向
  `%TEMP%\p1wrap\fastA\no-default-install`（不存在的路径），且每次 `/DIR=` 都在 `%TEMP%\p1wrap\` 下。
  卸载只在自造的临时树上跑（本轮四断言不跑 `/uninstall`）。

## 明确不做（未验证）

* **断电三时点（TP1/TP2/TP3）**：真机强杀 + 486 MB 真实载荷，每次 250–570 s，超预算 → 不做；
* **跨重启**：需要真装 + 重启验证 → 不做；
* **全量 `npm test`**（8–12 min）→ 不做；
* **"卸载项恰 1 条"**：红线（会触碰主机真实安装的卸载键）→ 不做；
* **exe 级冷装**：只用迷你载荷 + `run_installer.py` 从源码驱动，不跑真 `Setup.exe` 的冷装/自解压路径 → 不做。

Author: PT-dove
