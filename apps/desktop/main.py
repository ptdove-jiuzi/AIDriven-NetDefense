"""main.py —— AIDriven NetDefense 桌面壳入口（作者 PT-dove）。

启动顺序是刻意固定的，每一步失败都只有一个出口：

1. 建目录、起日志；
2. 抢单实例互斥体（抢不到就把已有窗口叫到前台，然后安静退出）；
3. 拉起 daemon（失败也继续：界面必须能打开并显示「离线」和原因）；
4. 起本地界面服务器；
5. 起托盘；
6. 建窗口并进入 GUI 循环。

`--noconsole` 打包后没有标准输出，所以任何致命错误都用 MessageBox 呈现，
并把完整堆栈写进日志文件。
"""

from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import sys
import urllib.request
from pathlib import Path

if __package__ in (None, ""):
    # 允许 `python main.py` 直接跑（开发期），也允许作为包被导入。
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from aidn import PRODUCT_NAME, SHELL_VERSION, logsetup, paths, settings as settings_mod
from aidn.app import ShellController

log = logging.getLogger("aidn.main")

MUTEX_NAME = "Local\\AIDrivenNetDefense.Desktop.Shell"
ERROR_ALREADY_EXISTS = 183

MB_ICONERROR = 0x00000010
MB_ICONINFORMATION = 0x00000040


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="AIDrivenNetDefense", add_help=True)
    parser.add_argument("--background", action="store_true", help="启动后直接缩到托盘（开机自启用）")
    parser.add_argument("--open-mode", choices=("embedded", "browser"), default=None, help="覆盖本次的打开方式")
    parser.add_argument("--port", type=int, default=None, help="覆盖本次界面端口")
    parser.add_argument("--version", action="store_true", help="打印版本后退出")
    return parser.parse_args(argv)


def message_box(text: str, title: str = PRODUCT_NAME, flags: int = MB_ICONERROR) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, text, title, flags)
    except Exception:  # noqa: BLE001
        pass


def acquire_single_instance() -> tuple[bool, int]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # 不声明 argtypes 时 Python str 会被按 ANSI 传递，句柄可能因参数不合法而返回 0，
    # 结果被误判成「已有实例」——那会让第二个实例之外的任何启动都直接退出。
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

    handle = kernel32.CreateMutexW(None, 0, MUTEX_NAME)
    if not handle:
        log.error("创建单实例互斥体失败（GetLastError=%s），按独占继续启动", ctypes.get_last_error())
        return (True, 0)
    already = ctypes.get_last_error() == ERROR_ALREADY_EXISTS
    return (not already, int(handle))


def focus_running_instance() -> bool:
    """第二个实例：读握手文件，请已有进程把窗口叫出来。"""
    path = paths.runtime_state_path()
    try:
        runtime = json.loads(path.read_text(encoding="utf-8"))
        port = int(runtime.get("ui_port") or 0)
    except Exception:  # noqa: BLE001
        return False
    if not port:
        return False
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/shell/api/window/show",
        data=b"{}",
        method="POST",
        headers={"content-type": "application/json", "x-aidn-shell": "1"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=3.0) as response:
            return response.status == 200
    except Exception as error:  # noqa: BLE001
        log.warning("唤醒已有实例失败：%s", error)
        return False


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    if args.version:
        sys.stdout.write(f"{PRODUCT_NAME} 桌面壳 {SHELL_VERSION}\n")
        return 0

    paths.ensure_runtime_dirs()

    # 设置的日志目录要先于第一条日志生效，否则用户改了目录之后，当次启动仍写默认目录。
    settings = settings_mod.load(paths.settings_path())
    if settings.log_dir:
        paths.set_log_dir_override(settings.log_dir)
    log_file = logsetup.setup(paths.log_dir())
    logsetup.install_crash_handlers()
    log.info("=== %s 桌面壳 %s 启动（pid=%d）===", PRODUCT_NAME, SHELL_VERSION, os.getpid())
    log.info("安装目录=%s 数据目录=%s 日志=%s", paths.install_root(), paths.data_dir(), log_file)

    unique, mutex_handle = acquire_single_instance()
    if not unique:
        log.info("已有实例在运行，尝试把它叫到前台后退出")
        focus_running_instance()
        return 0

    if args.port is not None and 0 <= args.port <= 65535:
        settings.ui_port = args.port

    controller = ShellController(settings, open_mode_override=args.open_mode, background=args.background)

    # daemon 起不来不阻止界面打开：界面要能显示「离线 + 原因」，否则用户只看到
    # 一个双击没反应的 exe。
    daemon_ok = controller.start_daemon()
    log.info("daemon 启动结果：%s", "成功" if daemon_ok else f"失败（{controller.supervisor.last_error}）")

    try:
        port = controller.start_server()
        log.info("界面地址：http://127.0.0.1:%d/", port)
    except Exception as error:  # noqa: BLE001
        log.exception("本地界面服务器启动失败：%s", error)
        message_box(f"界面服务启动失败：{error}\n\n日志：{log_file}", flags=MB_ICONERROR)
        controller.supervisor.stop()
        return 1

    controller.write_runtime_state()

    tray_ok = controller.start_tray()
    if not tray_ok:
        log.warning("托盘不可用：%s", controller._tray.error if controller._tray else "未知")  # noqa: SLF001

    try:
        return controller.run()
    except Exception as error:  # noqa: BLE001
        log.exception("界面循环异常：%s", error)
        message_box(f"程序异常退出：{error}\n\n日志：{log_file}", flags=MB_ICONERROR)
        controller._shutdown()  # noqa: SLF001
        return 1
    finally:
        if mutex_handle:
            try:
                ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(ctypes.c_void_p(mutex_handle))
            except Exception:  # noqa: BLE001
                pass


def run() -> int:
    """main 的防崩外壳：--noconsole 下一旦抛异常，用户只会看到「双击没反应」。"""
    try:
        return main()
    except SystemExit:
        raise
    except BaseException as error:  # noqa: BLE001
        log.exception("桌面壳启动失败：%s", error)
        message_box(
            f"启动失败：{error}\n\n日志：{logsetup.current_file() or paths.log_dir()}",
            flags=MB_ICONERROR,
        )
        return 1


if __name__ == "__main__":
    sys.exit(run())
