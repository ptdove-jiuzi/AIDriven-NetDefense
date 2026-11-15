"""UPGRADE-001 · 升级四断言（红 / 绿 / 变异红），单命令可跑。

入口（唯一命令）：

    python tests/installer/r3/fast/run-four-assertions.py --variant all

三条腿都跑同一套断言，只换被测安装器代码：

* ``mutation`` —— 与 ``deploy/windows/installer/app`` 逐字节相同的回退体（= shipped rc.6 的行为）；
* ``fix``      —— 已含 ``UPGRADE-001.patch`` 的副本（``tests/installer/r3/fix``）；
* ``mutA``     —— ``fix`` 的**临时副本**（``%TEMP%\\p1wrap\\mutA``），把
  ``install.py`` 里"journal 有效就续做"的那一处判断改成恒不续做；不改 ``fix/`` 原件。

断言口径（四条，逐条打 expected/actual，不做"看起来通过"）：

* A1 冷装：``/S /DIR=<空目录> /NOREG /NOSHORTCUT`` → exit 0，``install.json`` 写 rc.6、
  ``upgradedFrom=null``、入口文件在、没有残留 journal。
* A2 覆盖升级（被中断后的续装）：rc.5 树被 rc.6 字节覆盖一半（payload 新、manifest 旧、
  record 旧）→ 再跑同版本 rc.6 → exit 0 且 ``upgradedFrom == 0.0.1-rc.5``。
  红态这里就是断点：shipped 代码判"非空且无 marker"，直接 exit 1。
* A3 两处 data 逐字节 0 差异：``<target>\\data`` 升级前后全量 sha256 → 0 处不同；
  ``%LOCALAPPDATA%\\AIDriven NetDefense\\data`` 全程只读哈希 → 0 处不同。
  后者不是安装器写的目录（见 apps/desktop/settings/display.py），本用例只证明"没被升级碰到"；
  若该目录不存在/不可读 → 该分支记 ``LA_NOT_COVERED``，**不冒充已测**。
* A4 记录字段：``install.json`` 的 ``version`` / ``upgradedFrom`` 正确且 ``install\\`` 下只有一份
  ``install.json``；注册表分支在 ``/NOREG`` 下不写（禁写注册表），只做**只读**探测，
  记 ``A4b registry entries = N``，并把"恰 1"明确标成 ``NOT_VERIFIED``。

边界（明确不做，见 README）：断电三时点、跨重启、真 486 MB 载荷、全量 npm test。

产物：``%TEMP%\\p1wrap\\logs\\four-assertions-<variant>.json`` 与本进程 stdout 的 JSON。

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
R3 = REPO / "tests" / "installer" / "r3"
TOOLS = R3 / "tools"
MARKER_PROBE = REPO / "tests" / "installer" / "fixtures" / "r3-marker-probe.py"
PY = sys.executable

TEMP = Path(os.environ.get("TEMP") or os.environ.get("TMP") or ".")


def long_path(value: Path) -> Path:
    """把 8.3 短名展开成长名。

    本机 ``%TEMP%`` 可能是 8.3 短名。安装器的 ``paths.normalise`` 用 ``abspath``（不展开 8.3），
    而 ``r3_interrupt``/``make_mini_payload`` 用 ``Path.resolve()``（会展开）——两边一旦混用，
    journal 里的 ``target`` 与 ``/DIR=`` 的字面路径就对不上，``_journal_is_valid`` 直接判无效，
    于是**修复版被误判成红**。这不是产品缺陷，是测试夹具的假红，所以这里统一成长名。
    """

    raw = str(value)
    if "~" not in raw:
        return Path(raw)
    try:
        import ctypes  # noqa: PLC0415 - Windows only

        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetLongPathNameW(raw, buffer, 32768)
        if length:
            return Path(buffer.value)
    except (AttributeError, OSError):
        pass
    return Path(raw)


LOCAL_APP_DATA = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
#: 固定长路径工作根（不用 %TEMP%，它会带 8.3 短名）。
TEMP_ROOT = long_path(LOCAL_APP_DATA / "Temp")
WORK = TEMP_ROOT / "p1wrap" / "fastA"
LOG_DIR = TEMP_ROOT / "p1wrap" / "logs"
MUTA = TEMP_ROOT / "p1wrap" / "mutA"

RC5 = "0.0.1-rc.5"
RC6 = "0.0.1-rc.6"

#: 被中断的升级"已经落了多少个文件"：1..4 都能复现"新字节 + 旧清单"；取 4 覆盖入口与 launcher。
CUT_FILES = 4

#: 每个子进程的硬超时，远低于 570 s 的单条上限。
SUBPROCESS_TIMEOUT_S = 300


# --------------------------------------------------------------------------- helpers
def log(message: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    sys.stdout.write(f"[{stamp}] {message}\n")
    sys.stdout.flush()


def run(argv: list[str], env: dict | None = None) -> tuple[int, str, str]:
    merged = dict(os.environ)
    # 允许"从 fix/ 或 mutation/ 里直接 import aidn"却不落下 __pycache__：那些目录是只读域。
    merged["PYTHONDONTWRITEBYTECODE"] = "1"
    if env:
        merged.update(env)
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=SUBPROCESS_TIMEOUT_S,
        env=merged,
    )
    return completed.returncode, completed.stdout, completed.stderr


def last_json_line(text: str) -> dict | None:
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except ValueError:
            continue
    return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_manifest(root: Path) -> dict[str, str]:
    """``{relative posix path: sha256}`` for every regular file under *root*."""

    manifest: dict[str, str] = {}
    if not root.is_dir():
        return manifest
    for path in sorted(root.rglob("*")):
        if path.is_file():
            manifest[path.relative_to(root).as_posix()] = sha256_file(path)
    return manifest


def diff_manifests(before: dict[str, str], after: dict[str, str]) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    for name in sorted(set(before) | set(after)):
        if before.get(name) != after.get(name):
            changes.append({"path": name, "before": before.get(name), "after": after.get(name)})
    return changes


def registry_entries() -> list[dict[str, str]]:
    """Read-only probe of the uninstall key in all four locations the product writes/probes."""

    import winreg  # noqa: PLC0415 - Windows only, imported where it is used

    found: list[dict[str, str]] = []
    subkeys = (
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    )
    for hive, hive_name in ((winreg.HKEY_LOCAL_MACHINE, "HKLM"), (winreg.HKEY_CURRENT_USER, "HKCU")):
        for subkey in subkeys:
            try:
                with winreg.OpenKey(hive, f"{subkey}\\AIDrivenNetDefense") as key:
                    values: dict[str, str] = {"hive": hive_name, "subkey": subkey}
                    for name in ("DisplayName", "DisplayVersion", "InstallLocation"):
                        try:
                            values[name] = str(winreg.QueryValueEx(key, name)[0])
                        except FileNotFoundError:
                            values[name] = ""
                    found.append(values)
            except FileNotFoundError:
                continue
            except OSError:
                continue
    return found


# --------------------------------------------------------------------------- fixtures
def ensure_payloads() -> dict[str, Path]:
    WORK.mkdir(parents=True, exist_ok=True)
    payload5 = WORK / "payload-rc5"
    payload6 = WORK / "payload-rc6"
    archive = WORK / "payload-rc6.7z"
    manifest = payload6 / "manifests" / "files.sha256"
    if not (payload5 / "manifests" / "files.sha256").is_file():
        code, out, err = run([PY, str(TOOLS / "make_mini_payload.py"), str(payload5), "rc5"])
        if code != 0:
            raise SystemExit(f"make_mini_payload(rc5) failed: {code}\n{out}\n{err}")
        log(f"payload rc5 built: {last_json_line(out)}")
    if not manifest.is_file():
        code, out, err = run([PY, str(TOOLS / "make_mini_payload.py"), str(payload6), "rc6"])
        if code != 0:
            raise SystemExit(f"make_mini_payload(rc6) failed: {code}\n{out}\n{err}")
        log(f"payload rc6 built: {last_json_line(out)}")
    if not archive.is_file() or archive.stat().st_mtime < manifest.stat().st_mtime:
        code, out, err = run([PY, str(TOOLS / "make_archive.py"), str(payload6), str(archive)])
        if code != 0:
            raise SystemExit(f"make_archive failed: {code}\n{out}\n{err}")
        log(f"archive built: {last_json_line(out)}")
    return {"rc5": payload5, "rc6": payload6, "archive": archive}


def copy_tree(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.orig", "*.rej"))


def ensure_variant(name: str) -> Path:
    """Resolve the app directory that is under test for *name*."""

    if name == "mutation":
        return R3 / "mutation"
    if name == "fix":
        return R3 / "fix"
    if name != "mutA":
        raise SystemExit(f"unknown variant: {name}")

    target = MUTA
    if target.exists():
        shutil.rmtree(target)
    copy_tree(R3 / "fix", target)
    # 删掉"journal 有效就续做"的关键判断：`resumed = _resume_marker(...)` / `if resumed is None:`
    # 换成 `resumed = None` / `if True:` —— 等价于 mutation2 的"只删安装侧续做分支"，
    # 但本文件是从 fix 的临时副本上做的，且下面用计数证明只改了这一处。
    install_py = target / "aidn" / "install.py"
    text = install_py.read_text(encoding="utf-8")
    needle = "        resumed = _resume_marker(target)\n        if resumed is None:\n"
    replaced = text.count(needle)
    if replaced != 1:
        raise SystemExit(f"mutA: expected exactly 1 resume branch, found {replaced}")
    install_py.write_text(text.replace(needle, "        resumed = None\n        if True:\n"), encoding="utf-8")
    log(f"mutA built at {target} (resume branch neutralised, 1 replacement)")
    return target


def cut_without_journal(target: Path, payload_dir: Path, count: int) -> dict:
    """把前 *count* 个 payload 文件覆盖到 *target* 上，但不写 journal。

    shipped rc.6 的代码里根本没有 journal：真机在 `_copy_tree` 中途被强杀后留下的就是这个形状
    （payload 字节新、`manifests/files.sha256` 旧、`install.json` 旧、无 journal）。
    """

    rows = [
        line.split("  ", 1)[1]
        for line in (payload_dir / "manifests" / "files.sha256").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    copied: list[str] = []
    for relative in rows[:count]:
        source = payload_dir / relative.replace("/", "\\")
        destination = target / relative.replace("/", "\\")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied.append(relative)
    return {"copied": copied, "journalExists": (target / "install" / "upgrade.pending.json").is_file()}


def marker_report(app: Path, target: Path) -> dict:
    code, out, err = run([PY, str(MARKER_PROBE), str(app), str(target)])
    report = last_json_line(out) or {"ok": False, "error": (out + err)[-2000:]}
    return report


# --------------------------------------------------------------------------- assertions
def blank_row(ident: str, expected: object) -> dict:
    return {"id": ident, "expected": expected, "actual": None, "pass": False, "note": ""}


def run_variant(name: str) -> dict:
    app = ensure_variant(name)
    payloads = ensure_payloads()
    env = dict(os.environ)
    # 让 `find_existing()` 的 install.json 兜底不看真实的 %ProgramFiles%；
    # 本机注册表在跑前为空（只读探测过），再叠加这一条，upgradedFrom 只可能来自被测树。
    env["AIDN_SETUP_DEFAULT_DIR"] = str(WORK / "no-default-install")
    env["MSYS2_ARG_CONV_EXCL"] = "*"

    la_before = tree_manifest(Path(os.environ["LOCALAPPDATA"]) / "AIDriven NetDefense" / "data")

    rows: list[dict] = []
    facts: dict[str, object] = {"variant": name, "app": str(app)}

    # ---------------------------------------------------------------- A1 冷装
    cold = WORK / f"tree-cold-{name}"
    if cold.exists():
        shutil.rmtree(cold)
    argv = [
        PY, str(TOOLS / "run_installer.py"), str(app), str(payloads["archive"]), RC6,
        "/S", f"/DIR={cold}", "/NOREG", "/NOSHORTCUT",
    ]
    code, out, err = run(argv, env=env)
    record = None
    record_path = cold / "install" / "install.json"
    if record_path.is_file():
        record = json.loads(record_path.read_text(encoding="utf-8"))
    row = blank_row("A1", {"exit": 0, "version": RC6, "upgradedFrom": None, "entry": True, "journal": False})
    row["actual"] = {
        "exit": code,
        "version": (record or {}).get("version"),
        "upgradedFrom": (record or {}).get("upgradedFrom"),
        "entry": (cold / "AIDrivenNetDefense.exe").is_file(),
        "journal": (cold / "install" / "upgrade.pending.json").is_file(),
    }
    row["pass"] = (
        code == 0
        and row["actual"]["version"] == RC6
        and row["actual"]["upgradedFrom"] is None
        and row["actual"]["entry"] is True
        and row["actual"]["journal"] is False
    )
    if code != 0:
        row["note"] = (out + err).strip()[-800:]
    rows.append(row)
    facts["coldExit"] = code

    # ---------------------------------------------------------------- 造 rc.5 树 + 打断
    base = WORK / f"tree-up-{name}"
    if base.exists():
        shutil.rmtree(base)
    code, out, err = run(
        [PY, str(TOOLS / "r3_build_tree.py"), str(app), str(base), str(payloads["rc5"]), RC5, "--data"]
    )
    built = last_json_line(out) or {}
    facts["baseTree"] = {
        "exit": code,
        "ok": built.get("ok"),
        "verify": built.get("verify"),
        "version": built.get("version"),
        "dataFiles": built.get("dataFiles"),
        "error": (None if code == 0 else (out + err)[-1500:]),
    }

    data_before = tree_manifest(base / "data")
    supports_journal = (app / "aidn" / "install.py").read_text(encoding="utf-8").count("_write_journal(") > 1
    if supports_journal:
        code, out, err = run(
            [PY, str(TOOLS / "r3_interrupt.py"), str(app), str(base), str(payloads["rc6"]), RC6, str(CUT_FILES)]
        )
        interruption = last_json_line(out) or {"error": (out + err)[-1500:]}
        interruption["mode"] = "journal (r3_interrupt.py, real _write_journal + real _copy_tree)"
    else:
        interruption = cut_without_journal(base, payloads["rc6"], CUT_FILES)
        interruption["mode"] = "no-journal (shipped code has none; byte cut identical to a SIGKILL mid-copy)"
    facts["interruption"] = interruption

    # ---------------------------------------------------------------- A2 续装 / 覆盖升级
    argv = [
        PY, str(TOOLS / "run_installer.py"), str(app), str(payloads["archive"]), RC6,
        "/S", f"/DIR={base}", "/NOREG", "/NOSHORTCUT",
    ]
    upgrade_started = time.time()
    code, out, err = run(argv, env=env)
    facts["upgradeElapsedMs"] = int((time.time() - upgrade_started) * 1000)
    after = None
    if (base / "install" / "install.json").is_file():
        after = json.loads((base / "install" / "install.json").read_text(encoding="utf-8"))
    markers = marker_report(app, base)

    row = blank_row("A2", {"exit": 0, "version": RC6, "upgradedFrom": RC5, "journal": False})
    row["actual"] = {
        "exit": code,
        "version": (after or {}).get("version"),
        "upgradedFrom": (after or {}).get("upgradedFrom"),
        "journal": (base / "install" / "upgrade.pending.json").is_file(),
        "installMarker": markers.get("installMarker"),
    }
    row["pass"] = (
        code == 0
        and row["actual"]["version"] == RC6
        and row["actual"]["upgradedFrom"] == RC5
        and row["actual"]["journal"] is False
    )
    row["note"] = (out + err).strip().splitlines()[-1][:600] if code != 0 else ""
    rows.append(row)

    # ---------------------------------------------------------------- A3 两处 data
    data_after = tree_manifest(base / "data")
    la_after = tree_manifest(Path(os.environ["LOCALAPPDATA"]) / "AIDriven NetDefense" / "data")
    target_changes = diff_manifests(data_before, data_after)
    la_changes = diff_manifests(la_before, la_after)
    la_covered = bool(la_before)
    row = blank_row("A3", {"targetDataFiles": len(data_before), "targetDiff": 0, "laDiff": 0})
    row["actual"] = {
        "targetDataFiles": len(data_before),
        "targetDataFilesAfter": len(data_after),
        "targetDiff": len(target_changes),
        "targetDiffSample": target_changes[:5],
        "laCovered": la_covered,
        "laDataFiles": len(la_before),
        "laDiff": 0 if not la_covered else len(la_changes),
        "laDiffSample": la_changes[:5],
    }
    if not row["actual"]["targetDiff"] == 0:
        row["pass"] = False
        row["note"] = "target\\data 在升级中发生变化"
    elif la_covered and row["actual"]["laDiff"] != 0:
        row["pass"] = False
        row["note"] = "LA data 在升级演练中被改动"
    elif la_covered:
        row["pass"] = True
        row["note"] = f"两处都覆盖：target {len(data_before)} 文件 + LA {len(la_before)} 文件，均 0 差异"
    else:
        row["pass"] = True
        row["note"] = "LA_NOT_COVERED：%LOCALAPPDATA%\\AIDriven NetDefense\\data 不存在/为空，只断言了 target 侧"
    if code != 0:
        row["pass"] = False
        row["note"] = "BLOCKED：A2 未通过（升级没有发生），data 未被触碰是「没升级」，不是「保住了」"
    rows.append(row)

    # ---------------------------------------------------------------- A4 记录 + 卸载项
    records = sorted((base / "install").glob("install.json")) if (base / "install").is_dir() else []
    entries = registry_entries()
    row = blank_row("A4", {"version": RC6, "upgradedFrom": RC5, "installJsonCount": 1})
    row["actual"] = {
        "version": (after or {}).get("version"),
        "upgradedFrom": (after or {}).get("upgradedFrom"),
        "installJsonCount": len(records),
        "registryEntries": len(entries),
        "registryTarget": entries[0].get("InstallLocation") if entries else None,
    }
    row["pass"] = (
        code == 0
        and row["actual"]["version"] == RC6
        and row["actual"]["upgradedFrom"] == RC5
        and row["actual"]["installJsonCount"] == 1
    )
    row["note"] = (
        "A4b NOT_VERIFIED：/NOREG 不写注册表，只读探测到 "
        f"{len(entries)} 项（'卸载项恰 1' 分支需写注册表，本战役禁写，未验证）"
    )
    if len(entries) > 1:
        row["pass"] = False
        row["note"] = f"注册表出现 {len(entries)} 项重复卸载登记"
    rows.append(row)

    return {
        "variant": name,
        "app": str(app),
        "facts": facts,
        "assertions": rows,
        "pass": sum(1 for row in rows if row["pass"]),
        "total": len(rows),
    }


def main(argv: list[str]) -> int:
    wanted = ["all"]
    if "--variant" in argv:
        wanted = [argv[argv.index("--variant") + 1]]
    variants = ["mutation", "fix", "mutA"] if wanted == ["all"] else wanted
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)

    results = []
    for name in variants:
        log(f"=== variant: {name} ===")
        result = run_variant(name)
        results.append(result)
        out_file = LOG_DIR / f"four-assertions-{name}.json"
        out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log(f"variant {name}: {result['pass']}/{result['total']} -> {out_file}")
        for row in result["assertions"]:
            log(f"  {row['id']} {'PASS' if row['pass'] else 'FAIL'} actual={json.dumps(row['actual'], ensure_ascii=False)}")
            if row["note"]:
                log(f"       note: {row['note']}")

    summary = {
        "productBytes": {
            "deploy/windows/installer/app/aidn/install.py": sha256_file(REPO / "deploy/windows/installer/app/aidn/install.py"),
            "deploy/windows/installer/app/main.py": sha256_file(REPO / "deploy/windows/installer/app/main.py"),
        },
        "variants": [{"name": r["variant"], "pass": r["pass"], "total": r["total"]} for r in results],
    }
    (LOG_DIR / "four-assertions-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
