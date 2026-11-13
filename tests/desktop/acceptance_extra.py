"""acceptance_extra.py —— 补上 `acceptance.py` 没覆盖的三块真跑验收（作者 PT-dove）。

对应任务书里这三条：

- **2b 托盘退出**：向托盘隐藏窗口发 `WM_COMMAND(ID_QUIT)`，等于用户点右键菜单「退出」；
  走的是真实 Win32 消息路径，不是壳自己的 HTTP 退出接口。
- **4 设置四项**：内嵌/浏览器、开机自启（HKCU Run）、界面端口、daemon 端口；
  每项都读回真实状态（注册表 / settings.json / 新端口是否真在服务），最后重启验证保持。
- **6b 人为异常留栈**：在同一份 `desktop-YYYYMMDD.log` 上走主线程与子线程两条崩溃路径。

隔离原则与 `_support.py` 一致：数据目录走 `AIDN_BASE_DIR`，自启写
`AIDN_RUN_KEY` 指向的测试子键，真实 `%LOCALAPPDATA%` 与真实 Run 键前后快照比对。

用法：
    python tests/desktop/acceptance_extra.py
    python tests/desktop/acceptance_extra.py --exe <path>
"""

from __future__ import annotations

import argparse
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
sys.path.insert(0, str(HERE.parents[1] / "apps" / "desktop"))

import _support  # noqa: E402

REPO_ROOT = HERE.parents[1]
DEFAULT_EXE = REPO_ROOT / "dist" / "desktop" / "payload" / "AIDrivenNetDefense.exe"
REAL_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "AIDrivenNetDefense"
UI_PORT = 17881
UI_PORT_NEW = 17883
DAEMON_PORT_NEW = 17884

CREATE_DETACHED = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200


class Report:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, name: str, ok: bool, detail: str = "", **extra) -> bool:
        self.rows.append({"check": name, "ok": bool(ok), "detail": detail, **extra})
        print(("  [PASS] " if ok else "  [FAIL] ") + name + (f" — {detail}" if detail else ""))
        return ok

    @property
    def failed(self) -> list[dict]:
        return [row for row in self.rows if not row["ok"]]


# --------------------------------------------------------------- win32 小工具
def tray_hwnd() -> int | None:
    import ctypes
    import ctypes.wintypes as wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.FindWindowW.restype = wintypes.HWND
    handle = user32.FindWindowW("AIDrivenNetDefenseTrayWnd", None)
    return int(handle) if handle else None


def close_main_window(pid: int) -> bool:
    """按标题含「内测版」找主窗口并发 WM_CLOSE，返回是否找到。"""
    import ctypes
    import ctypes.wintypes as wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    found: list[int] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _lparam):  # noqa: ANN001
        buffer = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buffer, 512)
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if "内测版" in buffer.value and owner.value == pid:
            found.append(int(hwnd))
        return True

    user32.EnumWindows(callback, 0)
    for hwnd in found:
        user32.PostMessageW(wintypes.HWND(hwnd), 0x0010, 0, 0)  # WM_CLOSE
    return bool(found)


def tray_menu_quit() -> bool:
    """向托盘的隐藏窗口发 WM_COMMAND(1004) —— 与点菜单「退出」同一条路径。"""
    import ctypes
    import ctypes.wintypes as wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    hwnd = tray_hwnd()
    if not hwnd:
        return False
    return bool(user32.PostMessageW(wintypes.HWND(hwnd), 0x0111, 1004, 0))


# ------------------------------------------------------------------ 进程启动
def install_layout(exe: Path) -> tuple[Path, Path | None]:
    """返回「安装布局」下的 exe 与需要清理的 staging 目录。

    构建产物 `dist\\desktop\\AIDrivenNetDefense.exe` 只有它自己，同级没有
    `daemon\\apps\\daemon\\bin.js`；直接跑会如实报「找不到 daemon 入口」并停在离线态。
    那是**布局缺失**，不是验收要测的行为，所以这里照 `acceptance.py` 的做法用
    junction 复刻安装布局（daemon → 仓库根、runtime → payload 里的冻结 node）。
    """
    if (exe.parent / "daemon" / "apps" / "daemon" / "bin.js").is_file():
        return exe, None

    stage = Path(tempfile.mkdtemp(prefix="aidn-extra-stage-"))
    shutil.copy2(exe, stage / exe.name)
    targets: dict[str, Path] = {"daemon": REPO_ROOT}
    runtime = REPO_ROOT / "dist" / "desktop" / "payload" / "runtime"
    if (runtime / "node" / "node.exe").is_file():
        targets["runtime"] = runtime
    for name, target in targets.items():
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             f"New-Item -ItemType Junction -Path '{stage / name}' -Target '{target}' | Out-Null"],
            capture_output=True, timeout=60,
        )
    print(f"安装布局：{stage}（" + "，".join(f"{n} → {t}" for n, t in targets.items()) + "）")
    return stage / exe.name, stage


def cleanup_stage(stage: Path | None) -> None:
    """先摘掉 junction 再删目录。

    `shutil.rmtree` 对 Windows junction 的处理随版本而异，先 `os.rmdir` 只删重解析点，
    目标目录一个字节都不会动——这一步是防止误删仓库的保险。
    """
    if stage is None:
        return
    for child in stage.iterdir():
        if child.is_dir() and not child.is_symlink():
            try:
                os.rmdir(child)  # junction：只移除挂载点
            except OSError:
                shutil.rmtree(child, ignore_errors=True)
    shutil.rmtree(stage, ignore_errors=True)


def launch(exe: Path, env: dict[str, str], port: int) -> subprocess.Popen:
    return subprocess.Popen(
        [str(exe), "--port", str(port)], cwd=str(exe.parent), env=env,
        creationflags=CREATE_DETACHED | CREATE_NEW_PROCESS_GROUP,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def wait_state(port: int, timeout: float = 45.0) -> dict | None:
    try:
        _support.wait_until(
            lambda: _support.http(f"http://127.0.0.1:{port}/shell/api/state")[0] == 200,
            timeout=timeout, interval=0.3, label="桌面壳就绪",
        )
    except AssertionError:
        return None
    return _support.http(f"http://127.0.0.1:{port}/shell/api/state")[1]


def kill_tree(pid: int) -> None:
    """连 PyInstaller 引导器派生的子进程一起结束。

    onefile 的 exe 是「引导器 + 真正的壳」两段进程；只杀引导器会留下壳和它的
    daemon 继续占着端口，后面的用例就会连到上一个实例上（实测踩过）。
    """
    if not pid:
        return
    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        pass


def quit_and_wait(port: int, pid: int, daemon_pid: int | None, launcher: int | None = None) -> bool:
    _support.shell_post(port, "/shell/api/quit")
    try:
        _support.wait_until(lambda: not _support.pid_alive(pid), timeout=15, interval=0.3, label="主进程退出")
    except AssertionError:
        kill_tree(launcher or pid)
        return False
    if daemon_pid:
        try:
            _support.wait_until(lambda: not _support.pid_alive(daemon_pid), timeout=10, interval=0.3,
                                label="daemon 退出")
        except AssertionError:
            _support.kill_pid(daemon_pid)
    return True


# ---------------------------------------------------------------------- 自启
def read_run_value(key_path: str, value: str = RUN_VALUE) -> str | None:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ) as key:
            data, _ = winreg.QueryValueEx(key, value)
            return str(data)
    except FileNotFoundError:
        return None
    except OSError:
        return None


def run_key_exists(key_path: str) -> bool:
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_READ):
            return True
    except OSError:
        return False


# ----------------------------------------------------------------------- main
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", default=str(DEFAULT_EXE))
    options = parser.parse_args(argv)

    exe = Path(options.exe).resolve()
    if not exe.is_file():
        raise SystemExit(f"缺少 exe：{exe}")
    run_exe, stage = install_layout(exe)

    report = Report()
    print(f"验收目标：{exe}")
    print(f"实际运行：{run_exe}")
    real_before = _support.snapshot(_support.REAL_BASE)
    real_run_before = read_run_value(REAL_RUN_KEY)
    base = _support.temp_base("extra")
    env = _support.make_env(base)
    env["PATH"] = os.environ["PATH"]
    test_run_key = env["AIDN_RUN_KEY"]
    log_file = base / "logs" / f"desktop-{time.strftime('%Y%m%d')}.log"
    settings_file = base / "data" / "shell" / "settings.json"

    shell: subprocess.Popen | None = None
    try:
        # ================================================== 2b 托盘菜单「退出」
        print("\n[2b] 托盘菜单「退出」→ 两个进程都消失")
        shell = launch(run_exe, env, UI_PORT)
        state = wait_state(UI_PORT)
        if state is None:
            report.record("托盘退出：实例就绪", False, "45s 内未就绪")
            raise SystemExit(1)
        # 先等 daemon 真上线：这一项的断言是「关窗口后 daemon 还在」，
        # 不等它上线就把「本来还没起来」当成「被关窗口带走了」是假失败。
        try:
            _support.wait_until(
                lambda: _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]["daemon"]["online"],
                timeout=30, interval=0.3, label="daemon 上线")
            daemon_ready = True
        except AssertionError:
            daemon_ready = False
        state = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]
        shell_pid = state["shell"]["pid"]
        daemon_pid = state["daemon"]["pid"]
        report.record("托盘退出：daemon 已上线（先决条件）", daemon_ready,
                      f"pid={daemon_pid} last_error={state['daemon']['last_error']}")
        report.record("托盘退出：托盘窗口与图标都在",
                      bool(tray_hwnd()) and bool(state["shell"]["tray_installed"]),
                      f"hwnd={tray_hwnd()} installed={state['shell']['tray_installed']}")
        # 窗口是在 HTTP 就绪之后才创建的，先等它真出现，否则会误判成「关不掉」。
        appeared = False
        for _ in range(60):
            if close_main_window(shell_pid):
                appeared = True
                break
            time.sleep(0.4)
        time.sleep(1.4)
        after_close = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]
        report.record("托盘退出：先关窗口 → 窗口隐藏，主进程与 daemon 都还在",
                      bool(appeared and _support.pid_alive(shell_pid)
                           and after_close["shell"]["window_visible"] is False
                           and after_close["daemon"]["online"]),
                      f"window_found={appeared} shell_alive={_support.pid_alive(shell_pid)} "
                      f"window_visible={after_close['shell']['window_visible']} "
                      f"daemon_online={after_close['daemon']['online']}")
        posted = tray_menu_quit()
        try:
            _support.wait_until(lambda: not _support.pid_alive(shell_pid), timeout=15, interval=0.3,
                                label="托盘退出后主进程消失")
            gone = True
        except AssertionError:
            gone = False
        try:
            _support.wait_until(lambda: not _support.pid_alive(daemon_pid or 0), timeout=12, interval=0.3,
                                label="托盘退出后 daemon 消失")
            daemon_gone = True
        except AssertionError:
            daemon_gone = False
        report.record("托盘退出：WM_COMMAND(1004) 生效，主进程与 daemon 都消失",
                      bool(posted and gone and daemon_gone),
                      f"posted={posted} shell_gone={gone} daemon_gone={daemon_gone}")
        shell = None

        # ============================================================ 4 设置四项
        print("\n[4] 设置：即时生效 + 重启保持（隔离数据目录 / 隔离 Run 键）")
        shell = launch(run_exe, env, UI_PORT)
        state = wait_state(UI_PORT)
        if state is None:
            report.record("设置：实例就绪", False, "45s 内未就绪")
            raise SystemExit(1)
        shell_pid = state["shell"]["pid"]

        # 4a 切浏览器
        code, body = _support.shell_post(UI_PORT, "/shell/api/settings", {"open_mode": "browser"})
        saved = json.loads(settings_file.read_text(encoding="utf-8")) if settings_file.is_file() else {}
        time.sleep(0.8)
        after = _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[1]
        report.record("4a 切「浏览器」：立即生效（交浏览器 + 收内嵌窗口）+ 落盘",
                      code == 200 and saved.get("open_mode") == "browser"
                      and after["shell"]["window_visible"] is False,
                      f"http={code} settings={saved.get('open_mode')} window_visible={after['shell']['window_visible']}")

        # 4b 切回内嵌
        code, body = _support.shell_post(UI_PORT, "/shell/api/settings", {"open_mode": "embedded"})
        saved = json.loads(settings_file.read_text(encoding="utf-8"))
        notes = (body or {}).get("notes") or []
        report.record("4b 切回「内嵌」：落盘并如实说明本次不换形态",
                      code == 200 and saved.get("open_mode") == "embedded",
                      f"http={code} notes={notes}")

        # 4c 开机自启（写测试子键，不动真实 Run）
        code_on, _ = _support.shell_post(UI_PORT, "/shell/api/settings", {"autostart": True})
        value_on = read_run_value(test_run_key)
        code_off, _ = _support.shell_post(UI_PORT, "/shell/api/settings", {"autostart": False})
        value_off = read_run_value(test_run_key)
        real_run_after = read_run_value(REAL_RUN_KEY)
        report.record("4c 开机自启：写/删 Run 项并读回真实状态",
                      code_on == 200 and code_off == 200 and bool(value_on) and value_off is None
                      and "--background" in (value_on or ""),
                      f"enable_http={code_on} value={value_on} disable_http={code_off} after_off={value_off}")
        report.record("4c 真实 Run 键未被测试碰到", real_run_after == real_run_before,
                      f"before={real_run_before} after={real_run_after}")

        # 4d 界面端口
        code, body = _support.shell_post(UI_PORT, "/shell/api/settings", {"ui_port": UI_PORT_NEW})
        try:
            _support.wait_until(lambda: _support.http(f"http://127.0.0.1:{UI_PORT_NEW}/shell/api/state")[0] == 200,
                                timeout=10, interval=0.2, label="新端口服务起来")
            new_up = True
        except AssertionError:
            new_up = False
        try:
            _support.wait_until(lambda: _support.http(f"http://127.0.0.1:{UI_PORT}/shell/api/state")[0] == 0,
                                timeout=10, interval=0.2, label="旧端口关闭")
            old_down = True
        except AssertionError:
            old_down = False
        saved = json.loads(settings_file.read_text(encoding="utf-8"))
        report.record(f"4d 界面端口 {UI_PORT} → {UI_PORT_NEW}：新端口在服务、旧端口已关、已落盘",
                      code == 200 and new_up and old_down and saved.get("ui_port") == UI_PORT_NEW,
                      f"http={code} new_up={new_up} old_down={old_down} settings={saved.get('ui_port')}")

        # 4e daemon 端口
        code, body = _support.shell_post(UI_PORT_NEW, "/shell/api/settings", {"daemon_port": DAEMON_PORT_NEW})
        state_new = _support.http(f"http://127.0.0.1:{UI_PORT_NEW}/shell/api/state")[1]
        saved = json.loads(settings_file.read_text(encoding="utf-8"))
        report.record(f"4e daemon 端口 → {DAEMON_PORT_NEW}：立即重启并生效",
                      code == 200 and state_new["daemon"]["port"] == DAEMON_PORT_NEW
                      and state_new["daemon"]["online"] is True and saved.get("daemon_port") == DAEMON_PORT_NEW,
                      f"http={code} daemon_port={state_new['daemon']['port']} online={state_new['daemon']['online']} "
                      f"saved={saved.get('daemon_port')} changed={(body or {}).get('changed')}")

        # 4f 重启保持
        daemon_now = state_new["daemon"]["pid"]
        quit_ok = quit_and_wait(UI_PORT_NEW, shell_pid, daemon_now, shell.pid if shell else None)
        survivors = [row["ProcessId"] for row in _support.process_commandline(str(base))
                     if (row.get("Name") or "").lower() in ("aidrivennetdefense.exe", "node.exe")]
        report.record("4f 退出当前实例（两个进程都走掉）", quit_ok and not survivors,
                      f"quit_ok={quit_ok} survivors={survivors} "
                      f"settings_at_exit={settings_file.read_text(encoding='utf-8').strip() if settings_file.is_file() else 'MISSING'}")
        shell = None
        shell = launch(run_exe, env, UI_PORT_NEW)
        state2 = wait_state(UI_PORT_NEW)
        if state2 is None:
            report.record(f"4f 重启后设置保持（{UI_PORT_NEW}/{DAEMON_PORT_NEW}/embedded）", False,
                          "重启未就绪")
        else:
            report.record(f"4f 重启后设置保持（{UI_PORT_NEW}/{DAEMON_PORT_NEW}/embedded）",
                          state2["shell"]["ui_port"] == UI_PORT_NEW
                          and state2["daemon"]["port"] == DAEMON_PORT_NEW
                          and state2["settings"]["open_mode"] == "embedded",
                          f"ui={state2['shell']['ui_port']} daemon={state2['daemon']['port']} "
                          f"mode={state2['settings']['open_mode']} "
                          f"saved={json.loads(settings_file.read_text(encoding='utf-8')).get('daemon_port')}")

        # ==================================================== 6b 人为异常留栈
        print("\n[6b] 人为异常：同一份日志里要能看到完整栈")
        crash_base = _support.temp_base("crash")
        crash_env = _support.make_env(crash_base)
        script = (
            "import sys, threading\n"
            f"sys.path.insert(0, r'{HERE.parents[1] / 'apps' / 'desktop'}')\n"
            "from aidn import logsetup, paths\n"
            "logsetup.setup(paths.log_dir())\n"
            "logsetup.install_crash_handlers()\n"
            "def boom():\n"
            "    raise ValueError('验收人造异常：子线程')\n"
            "t = threading.Thread(target=boom, name='acceptance-thread')\n"
            "t.start(); t.join()\n"
            "raise RuntimeError('验收人造异常：主线程未捕获')\n"
        )
        completed = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", env=crash_env, timeout=60)
        crash_log = crash_base / "logs" / f"desktop-{time.strftime('%Y%m%d')}.log"
        text = crash_log.read_text(encoding="utf-8", errors="replace") if crash_log.is_file() else ""
        report.record("6b 主线程未捕获异常留下 Traceback 与异常文本",
                      "Traceback (most recent call last)" in text
                      and "验收人造异常：主线程未捕获" in text and completed.returncode != 0,
                      f"rc={completed.returncode} bytes={len(text)}")
        report.record("6b 子线程未捕获异常留下栈并标出线程名",
                      "验收人造异常：子线程" in text and "acceptance-thread" in text,
                      f"thread_stack={'acceptance-thread' in text}")
        report.record("6b 日志文件名是 desktop-YYYYMMDD.log",
                      crash_log.name.startswith("desktop-") and crash_log.name.endswith(".log"),
                      crash_log.name)
        _support.rm(crash_base)

    finally:
        if shell is not None and shell.poll() is None:
            kill_tree(shell.pid)
        # 兜底：把命令行里带着本次数据目录的 daemon 一起清掉，别留给下一个用例。
        for row in _support.process_commandline(str(base)):
            if (row.get("Name") or "").lower() in ("aidrivennetdefense.exe", "node.exe"):
                _support.kill_pid(row["ProcessId"])

        real_after = _support.snapshot(_support.REAL_BASE)
        changed = _support.diff_snapshot(real_before, real_after)
        report.record("真实 %LOCALAPPDATA%\\AIDriven NetDefense 零改动", not changed,
                      f"{len(changed)} 个文件变化" + (f"：{changed[:5]}" if changed else ""))
        report.record("真实 HKCU Run 项零改动", read_run_value(REAL_RUN_KEY) == real_run_before,
                      f"before={real_run_before} after={read_run_value(REAL_RUN_KEY)}")

        evidence = {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "exe": str(exe),
            "run_exe": str(run_exe),
            "staging": str(stage) if stage else None,
            "base_dir": str(base),
            "log_file": str(log_file),
            "total": len(report.rows),
            "passed": len(report.rows) - len(report.failed),
            "failed": report.failed,
            "checks": report.rows,
        }
        target_dir = REPO_ROOT / "docs" / "implementation" / "evidence" / "desktop"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"acceptance-extra-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}.json"
        target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n证据：{target}")
        print(f"总计 {evidence['total']} 条：通过 {evidence['passed']} / 失败 {len(report.failed)}")
        for row in report.failed:
            print(f"  - {row['check']}: {row['detail']}")
        print("验收结论：" + ("GO" if not report.failed else "NO_GO"))
        _support.rm(base)
        cleanup_stage(stage)

    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
