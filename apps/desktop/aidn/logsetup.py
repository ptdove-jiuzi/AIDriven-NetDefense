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

try:  # 包内导入（正常路径）；被当作顶层模块直接 import 时退回同级导入
    from . import logrotate
except ImportError:  # pragma: no cover - 仅脚本式调用会走到
    import logrotate  # type: ignore[no-redef]

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


def _reopen_locked() -> Path:
    """按 `_state["dir"]` 重开 FileHandler 与 faulthandler（调用方已持锁）。

    轮转用的是「复制 + 原地 truncate」，文件身份没变，所以重开不是必须的；
    但重开一次可以把「某些平台把 append 解释成当前位置追加」这种边角情况也
    排除掉，保证截断后写入一定落在文件开头、不出现空洞。
    """
    log_dir = Path(_state["dir"])
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
    _state["file"] = target

    _enable_faulthandler(target)
    return target


def _enforce_locked(log_dir: Path) -> None:
    """对当前目录执行一次日志保留策略；失败绝不能影响日志本身。"""
    try:
        logrotate.enforce([log_dir])
    except Exception:  # noqa: BLE001
        pass


def maybe_rotate_active() -> Path | None:
    """当天日志超过 8 MiB 时轮转成 `<name>.1`（复制到 .1 + 原地 truncate）。

    返回轮转目标路径；没有轮转（未超阈值、没有当前文件、失败）返回 None。

    **不重命名**：`logging.FileHandler` 和 `faulthandler` 都持有以 O_APPEND
    打开的句柄，rename 之后它们的后续写入会落到改名后的旧文件上，当天的日志
    从此静默丢失；Windows 上重命名正被打开的文件还会直接 EPERM。truncate 不改
    文件身份，追加回到文件开头继续，崩溃栈依旧写当天那个文件。
    """
    with _lock:
        target = _state.get("file")
        if target is None:
            return None
        # 先把缓冲刷进文件，否则复制出来的 .1 会缺最后几行（它们会在 truncate
        # 之后落到当天文件的开头，看着像"顺序错乱"）。
        for handler in logging.getLogger().handlers:
            try:
                handler.flush()
            except Exception:  # noqa: BLE001
                pass
        try:
            result = logrotate.rotate_active(Path(target), logrotate.MAX_FILE_BYTES)
        except Exception:  # noqa: BLE001
            return None
        if not result.get("rotated"):
            return None
        _reopen_locked()
        logging.getLogger("aidn.log").info(
            "日志已轮转：%s（%s 字节）", result.get("target"), result.get("bytes")
        )
        rotated = result.get("target")
        return Path(rotated) if rotated else None


def set_log_dir(log_dir: Path) -> Path:
    """把日志切到 *log_dir*，返回新文件路径。"""
    with _lock:
        log_dir = Path(log_dir).resolve()
        _state["dir"] = log_dir
        target = _reopen_locked()

        # 换目录时顺手收一次旧日志：超过 7 天的删掉、总量压到 64 MiB 以内。
        _enforce_locked(log_dir)
        # 重启后当天文件可能早就超过 8 MiB（上一次运行留下的），先轮转再继续写。
        maybe_rotate_active()

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
        # `threading.ExceptHookArgs` 的字段名是 **exc_traceback**，不是 exc_tb；
        # 写成 exc_tb 会让钩子自己抛 AttributeError，子线程的栈就此丢掉
        # （Python 只会把 "Exception in threading.excepthook" 打到 stderr，
        #  --noconsole 下 stderr 是空的，等于彻底静默）。两个名字都认，避免版本差异。
        trace = getattr(args, "exc_traceback", None)
        if trace is None:
            trace = getattr(args, "exc_tb", None)
        text = "".join(traceback.format_exception(args.exc_type, args.exc_value, trace))
        log.critical(
            "子线程 %s 未捕获异常（进程继续运行）\n%s",
            getattr(args.thread, "name", "?"),
            text,
        )

    threading.excepthook = _thread_hook
