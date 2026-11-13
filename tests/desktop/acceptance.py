"""acceptance.py —— 真跑验收：打包好的 exe + 真实 daemon 子进程 + 真实托盘/窗口。

逐条对应任务书的验收项，任何一条不成立就退出码 1，并留下 JSON 证据：

1. 启动链：exe 起来后同时有主进程与 daemon，daemon 在线且窗口可见；
2. 关窗口 = 隐藏：主进程与 daemon 都还在，窗口 IsWindowVisible 为假；
3. 杀掉 daemon：5 秒内界面拿到的数据源变成「服务已断开」，且能一键重启；
4. 托盘退出：两者都消失，且没有孤儿 node 进程指着我这次的数据目录；
5. 单实例：第二次启动不产生第二个壳体，只把已有窗口叫到前台；
6. 日志：%LOCALAPPDATA%\\<产品>\\logs\\desktop-YYYYMMDD.log（本次走 AIDN_BASE_DIR）。

真实用户目录在测试前后做文件快照比对，断言「0 个文件被改动」。

用法：
    python tests/desktop/acceptance.py                # 用 dist\\desktop 里的 exe
    python tests/desktop/acceptance.py --exe <path>   # 指定 exe
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import _support  # noqa: E402

REPO_ROOT = HERE.parents[1]
DEFAULT_EXE = REPO_ROOT / "dist" / "desktop" / "AIDrivenNetDefense.exe"
WINDOW_NEEDLE = "内测版"
UI_PORT = 17871


class Checks:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append({"check": name, "ok": bool(ok), "detail": detail})
        print(("  [PASS] " if ok else "  [FAIL] ") + name + (f" — {detail}" if detail else ""))
        return ok

    @property
    def failed(self) -> list[dict]:
        return [row for row in self.rows if not row["ok"]]


# ------------------------------------------------------------------ win32 窗口
_user32 = ctypes.WinDLL("user32", use_last_error=True)
_user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
_user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
_user32.IsWindowVisible.argtypes = [wintypes.HWND]


def find_main_window() -> tuple[int, bool] | None:
    """返回标题含「内测版」的主窗口 (hwnd, 是否可见)。"""
    found: list[tuple[int, bool]] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _lparam):  # noqa: ANN001
        buffer = ctypes.create_unicode_buffer(512)
        _user32.GetWindowTextW(hwnd, buffer, 512)
        if WINDOW_NEEDLE in buffer.value:
            found.append((int(hwnd), bool(_user32.IsWindowVisible(hwnd))))
        return True

    _user32.EnumWindows(callback, 0)
    return found[0] if found else None


def make_stage(source_exe: Path) -> Path:
    """仿安装目录：exe 在根，daemon 走 `<root>\\daemon\\apps\\daemon\\bin.js`。

    用 junction 而不是复制：仓库有 node_modules，复制要几个 GB，而这里要验证的只是
    「安装布局下 exe 能不能找到 daemon」，不是复制本身。
    """
    stage = Path(os.environ["TEMP"]) / "aidn-acceptance-stage"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_exe, stage / source_exe.name)
    script = (
        f"New-Item -ItemType Junction -Path '{stage / 'daemon'}' -Target '{REPO_ROOT}' | Out-Null"
    )
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                   capture_output=True, timeout=60)
    if not (stage / "daemon" / "apps" / "daemon" / "bin.js").is_file():
        raise SystemExit(f"staging 布局不对：{stage / 'daemon' / 'apps' / 'daemon' / 'bin.js'} 不存在")
    return stage


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", default=str(DEFAULT_EXE))
    parser.add_argument("--keep", action="store_true", help="结束后保留 staging 与数据目录")
    options = parser.parse_args(argv)

    exe = Path(options.exe).resolve()
    if not exe.is_file():
        raise SystemExit(f"没有找可执行文件：{exe}（先跑 python apps/desktop/build.py）")

    print(f"验收目标：{exe}  ({exe.stat().st_size / 1048576:.1f} MB)")
    real_before = _support.snapshot(_support.REAL_BASE)
    checks = Checks()
    stage = make_stage(exe)
    base = _support.temp_base("acceptance")
    env = _support.make_env(base)
    env["PATH"] = os.environ["PATH"]
    log_dir = base / "logs"

    evidence: dict = {
        "started_at": datetime.now().isoformat(timespec="seconds"),
        "exe": str(exe),
        "exe_bytes": exe.stat().st_size,
        "base_dir": str(base),
        "staging": str(stage),
        "steps": [],
    }

    shell: subprocess.Popen | None = None
    try:
        # ---------------------------------------------------------- 1. 启动链
        print("\n[1] 启动链")
        started = time.monotonic()
        shell = subprocess.Popen([str(stage / exe.name), "--port", str(UI_PORT)],
                                 cwd=str(stage), env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            _support.wait_until(
                lambda: _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[0] == 200,
                timeout=40, interval=0.3, label="桌面壳 HTTP 就绪")
        except AssertionError as error:
            output = ""
            if shell.poll() is not None and shell.stdout is not None:
                output = shell.stdout.read().decode("utf-8", "replace")[-1500:]
            checks.record("启动链：本地界面服务器就绪", False, f"{error} / exe 输出: {output}")
            raise
        boot_seconds = time.monotonic() - started
        _status, state = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")
        shell_pid = state["shell"]["pid"]
        evidence["startup_seconds"] = round(boot_seconds, 2)
        evidence["shell_pid"] = shell_pid

        checks.record("启动链：界面服务器在 40s 内就绪", True, f"{boot_seconds:.1f}s")
        checks.record("启动链：主进程存活", _support.pid_alive(shell_pid), f"pid={shell_pid}")

        try:
            _support.wait_until(lambda: _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]["daemon"]["online"],
                                timeout=30, interval=0.3, label="daemon 上线")
            daemon_online = True
        except AssertionError:
            daemon_online = False
        _status, state = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")
        daemon = state["daemon"]
        daemon_pid = daemon["pid"]
        evidence["daemon"] = daemon
        checks.record("启动链：daemon 子进程在线", daemon_online, f"pid={daemon_pid} port={daemon['port']}")
        checks.record("启动链：daemon 进程真的存在", _support.pid_alive(daemon_pid or 0), f"pid={daemon_pid}")
        checks.record("/api/v1/status 经同源代理可读（token 由壳注入）",
                      _support.http(f"http://127.0.0.1:{UI_PORT}/api/v1/status")[0] == 200)

        # 窗口是在界面服务器就绪**之后**才创建的，且创建到真正 Show() 之间还有一段时间。
        # 立刻取一次会把「还没显示出来」误判成「没有窗口」，所以等它可见再断言。
        try:
            _support.wait_until(lambda: (find_main_window() or (0, False))[1], timeout=25, interval=0.3,
                                label="主窗口可见")
            window_visible = True
        except AssertionError:
            window_visible = False
        window = find_main_window()
        checks.record("窗口：pywebview 主窗口存在且可见",
                      bool(window and window[1] and window_visible),
                      f"hwnd={window[0] if window else None} visible={window[1] if window else None}")
        evidence["window_hwnd"] = window[0] if window else None
        checks.record("托盘：图标已注册", bool(state["shell"]["tray_installed"]),
                      str(state["shell"].get("tray_error") or "已注册"))
        checks.record("日志：desktop-YYYYMMDD.log 已生成",
                      (log_dir / f"desktop-{time.strftime('%Y%m%d')}.log").is_file(),
                      str(state["shell"]["log_file"]))

        # ------------------------------------------------- 2. 关闭 = 隐藏到托盘
        print("\n[2] 关窗口 = 隐藏到托盘")
        _support.shell_post(UI_PORT, "/shell/api/window/close")
        try:
            _support.wait_until(lambda: (find_main_window() or (0, True))[1] is False,
                                timeout=6, interval=0.2, label="窗口隐藏")
            hidden = True
        except AssertionError:
            hidden = False
        window_after = find_main_window()
        checks.record("关窗口后窗口不可见", hidden and bool(window_after and not window_after[1]))
        checks.record("关窗口后主进程仍在", _support.pid_alive(shell_pid), f"pid={shell_pid}")
        checks.record("关窗口后 daemon 仍在", _support.pid_alive(daemon_pid or 0), f"pid={daemon_pid}")

        # ------------------------------------------------- 5. 单实例（先做，窗口还藏着）
        print("\n[5] 单实例：第二次启动只唤起已有窗口")
        second = subprocess.run([str(stage / exe.name), "--port", str(UI_PORT)], cwd=str(stage), env=env,
                                capture_output=True, timeout=60)
        checks.record("第二个进程自行退出（退出码 0）", second.returncode == 0, f"exit={second.returncode}")
        _status, state = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")
        checks.record("第一次启动的壳没有被替换", state["shell"]["pid"] == shell_pid, f"pid={state['shell']['pid']}")
        try:
            _support.wait_until(lambda: (find_main_window() or (0, False))[1], timeout=6, interval=0.2,
                                label="窗口被重新显示")
            checks.record("已有窗口被叫到前台", True)
        except AssertionError:
            checks.record("已有窗口被叫到前台", False)

        # ------------------------------------------- 3. 杀掉 daemon → 断开 → 一键重启
        print("\n[3] 杀掉 daemon：5 秒内报「服务已断开」，可一键重启")
        _support.kill_pid(daemon_pid or 0)
        t0 = time.monotonic()
        disconnected_at = None
        while time.monotonic() - t0 < 8:
            code, body = _support.http(f"http://127.0.0.1:{UI_PORT}/api/v1/status", timeout=2)
            if code == 503 and body and body.get("error", {}).get("code") == "DAEMON_OFFLINE":
                disconnected_at = time.monotonic() - t0
                break
            time.sleep(0.15)
        checks.record("界面数据源在 5s 内变成 DAEMON_OFFLINE",
                      disconnected_at is not None and disconnected_at <= 5.0,
                      f"{disconnected_at:.2f}s" if disconnected_at is not None else "超时未变成 503")
        evidence["disconnect_seconds"] = round(disconnected_at, 2) if disconnected_at else None

        _status, state = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")
        checks.record("壳自知离线并给出原因", state["daemon"]["online"] is False and bool(state["daemon"]["last_error"]),
                      str(state["daemon"]["last_error"]))

        code, body = _support.shell_post(UI_PORT, "/shell/api/daemon/restart")
        restarted = code == 200 and body["state"]["daemon"]["online"] and body["state"]["daemon"]["pid"] != daemon_pid
        checks.record("一键重启后 daemon 回来且是新进程", restarted,
                      f"pid={body['state']['daemon']['pid'] if body else None}")
        new_daemon_pid = body["state"]["daemon"]["pid"] if body else None

        # ------------------------------------------------------ 4. 托盘退出
        print("\n[4] 退出：两者都消失，不留孤儿")
        _support.shell_post(UI_PORT, "/shell/api/quit")
        try:
            _support.wait_until(lambda: not _support.pid_alive(shell_pid), timeout=15, interval=0.3,
                                label="主进程退出")
            shell_gone = True
        except AssertionError:
            shell_gone = False
        try:
            _support.wait_until(lambda: not _support.pid_alive(new_daemon_pid or 0), timeout=15, interval=0.3,
                                label="daemon 退出")
            daemon_gone = True
        except AssertionError:
            daemon_gone = False

        checks.record("退出后主进程消失", shell_gone, f"pid={shell_pid}")
        checks.record("退出后 daemon 消失", daemon_gone, f"pid={new_daemon_pid}")
        orphans = [row for row in _support.process_commandline(str(base)) if "node" in (row.get("Name") or "").lower()]
        checks.record("没有指向本次数据目录的孤儿 node 进程", not orphans, f"{len(orphans)} 个")

        # ---------------------------------------------------------- 6. 日志内容
        log_file = log_dir / f"desktop-{time.strftime('%Y%m%d')}.log"
        content = log_file.read_text(encoding="utf-8", errors="replace") if log_file.is_file() else ""
        checks.record("日志记录了启动与退出", "启动" in content and "已退出" in content,
                      f"{len(content)} 字节")
        checks.record("日志里没有 bearer token", "Bearer " not in content and "api-token" not in content)

    finally:
        if shell is not None and shell.poll() is None:
            _support.kill_pid(shell.pid)
        real_after = _support.snapshot(_support.REAL_BASE)
        changed = _support.diff_snapshot(real_before, real_after)
        checks.record("真实 %LOCALAPPDATA%\\AIDriven NetDefense 零改动", not changed,
                      f"{len(changed)} 个文件变化" + (f"：{changed[:5]}" if changed else ""))
        evidence["checks"] = checks.rows
        evidence["finished_at"] = datetime.now().isoformat(timespec="seconds")
        evidence["failed"] = checks.failed
        evidence["total"] = len(checks.rows)
        evidence["passed"] = len(checks.rows) - len(checks.failed)

        evidence_dir = REPO_ROOT / "docs" / "implementation" / "evidence" / "desktop"
        evidence_dir.mkdir(parents=True, exist_ok=True)
        target = evidence_dir / f"acceptance-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n证据：{target}")

        if not options.keep:
            shutil.rmtree(stage, ignore_errors=True)
            _support.rm(base)
        else:
            print(f"保留：{stage} / {base}")

    ok = not checks.failed
    print(f"总计 {len(checks.rows)} 条：通过 {len(checks.rows) - len(checks.failed)} / 失败 {len(checks.failed)}")
    if not ok:
        for row in checks.failed:
            print(f"  - {row['check']}: {row['detail']}")
    print("验收结论：" + ("GO" if ok else "NO_GO"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
