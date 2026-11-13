"""v14_payload_smoke.py —— 联调：新桌面壳 + v14 载荷（dist\\bundle\\win32-x64-v14）。

验的是「壳能不能接上现成的 v14 安装树」，不是重打包安装器：

1. 用 junction 在临时目录复刻安装布局（exe 在根，`daemon\\` `runtime\\` `console\\` 指向 v14），
   **v14 目录全程只读**，一个字节都不写；
2. 起 exe → 壳应拉起 v14 树里的 `runtime\\node\\node.exe` 与 `apps\\daemon\\bin.js`；
3. 界面应改用 v14 的 `console\\index.html`（壳的规则是：安装根下有 `console\\index.html` 就用它）；
4. 同源代理 `/api/v1/status`、`/healthz` 可读；
5. 退出后两个进程都不留。

证明「真的是 v14 那份」用三件事，不靠猜：
- `os.path.realpath` 把 staging 里的 junction 还原成 v14 内的真实路径；
- daemon 进程的命令行里出现的就是 staging 的那两个入口；
- 页面与静态资源逐字节等于 v14 目录里的文件。

用法：
    python tests/desktop/v14_payload_smoke.py
    python tests/desktop/v14_payload_smoke.py --exe <path> --bundle <v14 目录>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import _support  # noqa: E402

REPO_ROOT = HERE.parents[1]
DEFAULT_EXE = REPO_ROOT / "dist" / "desktop" / "AIDrivenNetDefense.exe"
DEFAULT_BUNDLE = REPO_ROOT / "dist" / "bundle" / "win32-x64-v14"
UI_PORT = 17895

CREATE_DETACHED = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


class Report:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append({"check": name, "ok": bool(ok), "detail": detail})
        print(("  [PASS] " if ok else "  [FAIL] ") + name + (f" — {detail}" if detail else ""))
        return ok

    @property
    def failed(self) -> list[dict]:
        return [row for row in self.rows if not row["ok"]]


def make_junction(link: Path, target: Path) -> None:
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         f"New-Item -ItemType Junction -Path '{link}' -Target '{target}' | Out-Null"],
        capture_output=True, timeout=60,
    )


def drop_junction(link: Path) -> None:
    """只移除重解析点，不碰目标目录里的任何文件。"""
    if link.exists() or link.is_symlink():
        try:
            os.rmdir(link)
        except OSError:
            pass


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command_line_of(pid: int) -> str:
    """按 PID 取命令行（CIM）。`_support.process_commandline` 是按子串匹配的，这里不能用。"""
    script = (
        f"Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}' | "
        "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    text = (completed.stdout or "").strip()
    if not text:
        return ""
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return ""
    if isinstance(data, list):
        data = data[0] if data else {}
    return str(data.get("CommandLine") or "")


def http_bytes(url: str, timeout: float = 8.0) -> tuple[int, bytes]:
    import urllib.request

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as response:
            return response.status, response.read()
    except Exception:  # noqa: BLE001
        return 0, b""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", default=str(DEFAULT_EXE))
    parser.add_argument("--bundle", default=str(DEFAULT_BUNDLE))
    parser.add_argument("--keep", action="store_true", help="保留 staging 与数据目录")
    options = parser.parse_args(argv)

    exe = Path(options.exe).resolve()
    bundle = Path(options.bundle).resolve()
    report = Report()
    evidence: dict = {"generated_at": datetime.now().isoformat(timespec="seconds"),
                      "exe": str(exe), "bundle": str(bundle), "checks": []}

    print(f"壳   ：{exe}")
    print(f"载荷 ：{bundle}")

    daemon_entry = bundle / "apps" / "daemon" / "bin.js"
    node_exe = bundle / "runtime" / "node" / "node.exe"
    console_index = bundle / "console" / "index.html"
    required = {"daemon 入口": daemon_entry, "node 运行时": node_exe, "console 页面": console_index}
    missing = [name for name, path in required.items() if not path.is_file()]
    report.record("v14 载荷完整（daemon / node / console 三件都在）", not missing,
                  "、".join(missing) if missing else f"{bundle}")
    if missing:
        print("载荷不全，无法联调")
        return 1

    bundle_before = _support.snapshot(bundle)
    stage = Path(tempfile.mkdtemp(prefix="aidn-v14-stage-"))
    base = _support.temp_base("v14")
    shell: subprocess.Popen | None = None
    try:
        shutil.copy2(exe, stage / exe.name)
        for name, target in (("daemon", bundle), ("runtime", bundle / "runtime"), ("console", bundle / "console")):
            make_junction(stage / name, target)

        resolved = {
            "daemon": Path(os.path.realpath(stage / "daemon" / "apps" / "daemon" / "bin.js")),
            "node": Path(os.path.realpath(stage / "runtime" / "node" / "node.exe")),
            "console": Path(os.path.realpath(stage / "console" / "index.html")),
        }
        inside = all(bundle in path.parents for path in resolved.values())
        report.record("staging 的三个入口都解析回 v14 目录内", inside,
                      "，".join(f"{k}={v}" for k, v in resolved.items()))
        evidence["resolved"] = {k: str(v) for k, v in resolved.items()}

        env = _support.make_env(base)
        env["PATH"] = os.environ["PATH"]
        started = time.monotonic()
        shell = subprocess.Popen(
            [str(stage / exe.name), "--port", str(UI_PORT)], cwd=str(stage), env=env,
            creationflags=CREATE_DETACHED | CREATE_NEW_PROCESS_GROUP,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            _support.wait_until(
                lambda: _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[0] == 200,
                timeout=45, interval=0.3, label="壳就绪")
            shell_ready = True
        except AssertionError:
            shell_ready = False
        report.record("壳起来并监听本地界面端口", shell_ready, f"{time.monotonic() - started:.1f}s / :{UI_PORT}")
        if not shell_ready:
            return 1

        try:
            _support.wait_until(
                lambda: _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]["daemon"]["online"],
                timeout=60, interval=0.3, label="daemon 上线")
            online = True
        except AssertionError:
            online = False
        state = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]
        daemon = state["daemon"]
        evidence["state"] = state
        report.record("壳拉起了 daemon（v14 树里的 bin.js）", online,
                      f"pid={daemon['pid']} port={daemon['port']} last_error={daemon['last_error']}")

        command = ""
        if daemon["pid"]:
            command = command_line_of(int(daemon["pid"]))
        evidence["daemon_commandline"] = command
        uses_stage = str(stage / "runtime" / "node" / "node.exe").lower() in command.lower() \
            and str(stage / "daemon" / "apps" / "daemon" / "bin.js").lower() in command.lower()
        report.record("daemon 命令行用的是 staging 里的 node + bin.js（=v14 那一份）", uses_stage,
                      command[:220] or "取不到命令行")

        version = ""
        try:
            version = subprocess.run([str(node_exe), "--version"], capture_output=True, text=True,
                                     timeout=30).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            version = ""
        report.record("v14 自带 node 可执行", version.startswith("v24."), version or "跑不起来")

        status, body = _support.http(f"http://127.0.0.1:{UI_PORT}/healthz")
        report.record("/healthz 经同源代理可读", status == 200 and bool(body), f"http={status} body={body}")

        status, body = _support.http(f"http://127.0.0.1:{UI_PORT}/api/v1/status")
        report.record("/api/v1/status 经同源代理可读（token 由壳注入）", status == 200,
                      f"http={status} keys={sorted(body)[:6] if body else None}")

        code, page = http_bytes(f"http://127.0.0.1:{UI_PORT}/")
        same_page = code == 200 and page == console_index.read_bytes()
        report.record("界面用的是 v14 的 console/index.html（逐字节相同）", same_page,
                      f"http={code} bytes={len(page)} vs {console_index.stat().st_size}")
        report.record("页面标题来自 v14 控制台", "网域智防".encode("utf-8") in page)

        for relative in ("styles.css", "assets/mark.svg", "app.js"):
            target = bundle / "console" / relative
            if not target.is_file():
                report.record(f"静态资源 /{relative} 在 v14 里存在", False, "文件不存在")
                continue
            code, data = http_bytes(f"http://127.0.0.1:{UI_PORT}/{relative}")
            report.record(f"静态资源 /{relative} 与 v14 文件一致", code == 200 and data == target.read_bytes(),
                          f"http={code} bytes={len(data)}")

        shell_pid = state["shell"]["pid"]
        daemon_pid = daemon["pid"]
        _support.shell_post(UI_PORT, "/shell/api/quit")
        try:
            _support.wait_until(lambda: not _support.pid_alive(shell_pid), timeout=20, interval=0.3,
                                label="壳退出")
            shell_gone = True
        except AssertionError:
            shell_gone = False
        try:
            _support.wait_until(lambda: not _support.pid_alive(daemon_pid or 0), timeout=15, interval=0.3,
                                label="daemon 退出")
            daemon_gone = True
        except AssertionError:
            daemon_gone = False
        report.record("退出后壳与 v14 daemon 都消失", shell_gone and daemon_gone,
                      f"shell_gone={shell_gone} daemon_gone={daemon_gone}")
        shell = None

        bundle_after = _support.snapshot(bundle)
        changed = _support.diff_snapshot(bundle_before, bundle_after)
        report.record("v14 目录零写入（联调全程只读）", not changed,
                      f"{len(changed)} 个文件变化" + (f"：{changed[:5]}" if changed else ""))
        evidence["bundle_files"] = len(bundle_after)
    finally:
        if shell is not None and shell.poll() is None:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(shell.pid)], capture_output=True)
        for name in ("console", "runtime", "daemon"):
            drop_junction(stage / name)
        if not options.keep:
            shutil.rmtree(stage, ignore_errors=True)
            _support.rm(base)
        else:
            print(f"保留：{stage} / {base}")

        evidence["checks"] = report.rows
        evidence["total"] = len(report.rows)
        evidence["passed"] = len(report.rows) - len(report.failed)
        evidence["failed"] = report.failed
        target_dir = REPO_ROOT / "docs" / "implementation" / "evidence" / "desktop"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"v14-smoke-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}.json"
        target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n证据：{target}")
        print(f"总计 {evidence['total']} 条：通过 {evidence['passed']} / 失败 {len(report.failed)}")
        for row in report.failed:
            print(f"  - {row['check']}: {row['detail']}")
        print("联调结论：" + ("GO" if not report.failed else "NO_GO"))

    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
