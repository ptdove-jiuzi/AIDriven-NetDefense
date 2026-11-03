"""logsetup.py —— 单一日期日志文件 + 崩溃栈 + 运行时可改目录。

三条硬约束：

1. **文件名固定为 `desktop-YYYYMMDD.log`**，写在
   `%LOCALAPPDATA%\\AIDriven NetDefense\\logs\\`（或用户在设置里指定的目录）。
   按日分文件而不是按大小滚动：滚动会在同一目录留下 `desktop-YYYYMMDD.log.1`，
   而用户和排障脚本都只会去找当天的那个名字。
2. **崩溃必须留下栈**。三种崩溃路径分别处理：
   - 未捕获异常 → `sys.excepthook`（主线程）；
   - 子线程未捕获异常 → `threading.excepthook`（Python 3.8+）；
   - 解释器级崩溃（访问违例、栈溢出）→ `faulthandler` 直接写同一个文件。
3. **目录可热切换**：设置里改日志目录后不重启也要生效，所以文件句柄由本模块
   独占管理，`set_log_dir()` 关闭旧句柄、在新目录打开同名文件。

不写 token、不写请求头、不写用户事件内容；daemon 自己的 JSON 行日志另存
`data\\shell\\daemon.stderr.log`，由 daemon 进程直接重定向。
"""

from __future__ import annotations

import faulthandler
import logging
import sys
import threading
import time
import traceback
from pathlib import Path

_FORMAT = "%(asctime)s %(levelname)-7s %(name)-12s %(message)s"

_state = {
    "dir": None,          # 当前日志目录
    "file": None,         # 当前日志文件
    "handler": None,      # 当前 FileHandler
    "faulthandler": None, # faulthandler 打开的文件句柄
    "configured": False,
    "level": logging.INFO,
}

_lock = threading.RLock()


def log_file_name(when: float | None = None) -> str:
    """当天日志文件名：desktop-YYYYMMDD.log。"""
    return time.strftime("desktop-%Y%m%d.log", time.localtime(when))


def path_for(log_dir: Path) -> Path:
    return Path(log_dir) / log_file_name()


def _open_handler(log_dir: Path) -> tuple[logging.FileHandler, Path]:
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    target = path_for(log_dir)
    handler = logging.FileHandler(target, mode="a", encoding="utf-8", delay=False)
    handler.setFormatter(logging.Formatter(_FORMAT))
    return handler, target


def _enable_faulthandler(target: Path) -> None:
    """把解释器级崩溃也落到同一个文件。失败不影响正常日志。"""
    old = _state.get("faulthandler")
    if old is not None:
        try:
            faulthandler.disable()
        finally:
            try:
                old.close()
            except Exception:  # noqa: BLE001
                pass
        _state["faulthandler"] = None
    try:
        # 追加模式打开，与 FileHandler 共用同一个文件名；两者都用 O_APPEND，
        # 写入不会互相截断。
        stream = open(target, "a", encoding="utf-8", errors="replace")  # noqa: SIM115
        faulthandler.enable(file=stream, all_threads=True)
        _state["faulthandler"] = stream
    except Exception:  # noqa: BLE001
        pass


def setup(log_dir: Path, level: int = logging.INFO) -> Path:
    """配置根 logger 并返回当天日志文件路径。重复调用只换目录，不叠加 handler。"""
    with _lock:
        _state["level"] = level
        root = logging.getLogger()
        root.setLevel(level)

        if not _state["configured"]:
            if sys.stderr is not None and getattr(sys.stderr, "isatty", lambda: False)():
                stream = logging.StreamHandler(sys.stderr)
                stream.setFormatter(logging.Formatter(_FORMAT))
                root.addHandler(stream)
            _state["configured"] = True

        return set_log_dir(log_dir)


def set_log_dir(log_dir: Path) -> Path:
    """把日志切到 *log_dir*，返回新文件路径。"""
    with _lock:
        log_dir = Path(log_dir).resolve()
        handler, target = _open_handler(log_dir)

        root = logging.getLogger()
        previous = _state.get("handler")
        if previous is not None:
            root.removeHandler(previous)
            try:
                previous.close()
            except Exception:  # noqa: BLE001
                pass
        root.addHandler(handler)
        _state["handler"] = handler
        _state["dir"] = log_dir
        _state["file"] = target

        _enable_faulthandler(target)
        logging.getLogger("aidn.log").info("日志文件：%s", target)
        return target


def current_file() -> Path | None:
    return _state.get("file")


def current_dir() -> Path | None:
    return _state.get("dir")


def install_crash_handlers() -> None:
    """把三种崩溃路径都接到 logging / faulthandler 上。"""
    log = logging.getLogger("aidn.crash")

    def _excepthook(exc_type, exc_value, exc_tb) -> None:
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc_value, exc_tb)
            return
        text = "".join(traceback.format_exception(exc_type, exc_value, exc_tb))
        log.critical("未捕获异常，进程即将结束\n%s", text)

    sys.excepthook = _excepthook

    def _thread_hook(args) -> None:  # noqa: ANN001 - threading.ExceptHookArgs
        if args.exc_type is SystemExit:
            return
        text = "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_tb))
        log.critical(
            "子线程 %s 未捕获异常\n%s",
            getattr(args.thread, "name", "?"),
            text,
        )

    threading.excepthook = _thread_hook
