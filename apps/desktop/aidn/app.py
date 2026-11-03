"""app.py —— 把 daemon 监管、本地服务器、窗口和托盘拼成一个进程。

线程与阻塞点（只有两处会阻塞，其余都是短任务）：

- **主线程**：`webview.start()`（内嵌窗口模式），或在无窗口模式下等待退出事件；
- **托盘线程**：Win32 消息循环，负责图标与菜单。

关窗口 = 隐藏到托盘（closing 事件返回 False 取消关闭）；只有托盘「退出」或
`/shell/api/quit` 才真正结束 daemon 子进程并让主循环退出。
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

from . import SHELL_VERSION, PRODUCT_NAME, paths, settings as settings_mod
from .daemon import DaemonSupervisor
from .server import LocalServer
from .tray import Tray

log = logging.getLogger("aidn.app")


class ShellController:
    def __init__(self, settings: settings_mod.Settings, open_mode_override: str | None = None,
                 background: bool = False) -> None:
        self.settings = settings
        self._open_mode_override = open_mode_override
        self._background = background
        self._settings_path = paths.settings_path()
        self._window = None
        self._webview = None
        self._tray: Tray | None = None
        self._server: LocalServer | None = None
        self._quit_event = threading.Event()
        self._quitting = False
        self._window_visible = False
        self._started_at = time.time()
        self.supervisor = DaemonSupervisor(self.settings, self._persist_settings)

    # ------------------------------------------------------------------ 启动
    def open_mode(self) -> str:
        if self._open_mode_override:
            return self._open_mode_override
        return self.settings.open_mode

    def start_daemon(self) -> bool:
        return self.supervisor.start()

    def start_server(self) -> int:
        web_root = _pick_web_root()
        log.info("界面静态根：%s", web_root)
        self._server = LocalServer(self, web_root, int(self.settings.ui_port or 0))
        port = self._server.start()
        if self.settings.ui_port != port:
            self.settings.ui_port = port
            self._persist_settings(self.settings)
            log.info("界面端口已写回设置：%d", port)
        return port

    def start_tray(self) -> bool:
        self._tray = Tray(
            icon_path=paths.icon_path(),
            tooltip=f"{PRODUCT_NAME} · {SHELL_VERSION}",
            actions={
                "show": lambda: self.request_show_window("tray"),
                "browser": self.open_in_browser,
                "settings": lambda: self.request_show_window("tray", view="settings"),
                "quit": lambda: self.request_quit("tray"),
            },
        )
        return self._tray.start()

    def start_window(self) -> bool:
        """创建并显示 pywebview 窗口。必须在主线程调用。"""
        try:
            import webview  # 延迟导入：托盘模式不需要它也能活
        except Exception as error:  # noqa: BLE001
            log.exception("pywebview 不可用：%s", error)
            return False
        self._webview = webview
        self._window = webview.create_window(
            f"{PRODUCT_NAME}  网域智防 · 内测版",
            url=self.url,
            width=self.settings.window_width,
            height=self.settings.window_height,
            min_size=(900, 620),
            background_color="#f4f5f7",
            text_select=True,
        )
        self._window.events.closing += self._on_closing
        self._window_visible = True
        return True

    def run(self) -> int:
        """阻塞到退出。返回进程退出码。"""
        try:
            if self.open_mode() == "browser":
                log.info("打开方式=默认浏览器，不创建内嵌窗口")
                self.open_in_browser()
                self._quit_event.wait()
            else:
                if not self.start_window():
                    log.error("内嵌窗口创建失败，退化为默认浏览器")
                    self.open_in_browser()
                    self._quit_event.wait()
                else:
                    # pywebview 在主线程阻塞，直到窗口被 destroy。
                    # --background（开机自启）时在 GUI 起来的回调里立刻缩到托盘。
                    bootstrap = self._hide_window if self._background else None
                    self._webview.start(debug=False, private_mode=False, func=bootstrap)
                    log.info("窗口循环结束")
        finally:
            self._shutdown()
        return 0

    # -------------------------------------------------------------- 窗口动作
    def _on_closing(self) -> bool:
        """pywebview 关闭事件：返回 False 取消关闭，改为隐藏到托盘。"""
        if self._quitting:
            return True
        log.info("窗口关闭请求 → 隐藏到托盘（daemon 继续运行）")
        threading.Thread(target=self._hide_window, name="aidn-hide", daemon=True).start()
        return False

    def _hide_window(self) -> None:
        try:
            time.sleep(0.05)
            if self._window is not None:
                self._window.hide()
                self._window_visible = False
                log.info("窗口已隐藏")
        except Exception:  # noqa: BLE001
            log.exception("隐藏窗口失败")

    def request_show_window(self, source: str, view: str | None = None) -> tuple[int, dict]:
        log.info("显示窗口（来源 %s）", source)
        if self._window is None:
            # 无窗口模式（默认浏览器打开）：直接开浏览器。
            self.open_in_browser()
            return (200, {"ok": True, "window": "browser", "state": self.state()})
        try:
            self._window.show()
            self._window.restore()
            if view:
                self._window.evaluate_js(f"location.hash = '#/{view}';")
            self._window_visible = True
        except Exception as error:  # noqa: BLE001
            log.exception("显示窗口失败：%s", error)
            return (500, {"ok": False, "error": str(error)})
        return (200, {"ok": True, "window": "embedded", "state": self.state()})

    def request_close_window(self) -> tuple[int, dict]:
        """与「用户点窗口关闭按钮」走同一条路径：隐藏，不退出。"""
        log.info("收到关闭窗口请求（等价于用户点关闭按钮）")
        if self._window is None:
            return (200, {"ok": True, "window": "none", "state": self.state()})
        hidden = self._on_closing()
        if hidden is not False:
            return (200, {"ok": True, "window": "closing", "state": self.state()})
        time.sleep(0.25)
        return (200, {"ok": True, "window": "hidden", "state": self.state()})

    def open_in_browser(self) -> tuple[int, dict]:
        url = self.url
        if os.environ.get("AIDN_NO_OPEN") == "1":
            # 验收脚本用：只回报地址，不真的弹浏览器窗口。
            log.info("AIDN_NO_OPEN=1，跳过打开浏览器：%s", url)
            return (200, {"ok": True, "url": url, "opened": False, "state": self.state()})
        log.info("在默认浏览器中打开：%s", url)
        try:
            webbrowser.open(url, new=2)
        except Exception as error:  # noqa: BLE001
            log.exception("打开浏览器失败：%s", error)
            return (500, {"ok": False, "error": str(error), "state": self.state()})
        return (200, {"ok": True, "url": url, "opened": True, "state": self.state()})

    # ------------------------------------------------------------------ 退出
    def request_quit(self, source: str) -> tuple[int, dict]:
        if self._quitting:
            return (200, {"ok": True, "already": True})
        log.info("收到退出请求（来源 %s），开始结束 daemon 与界面", source)
        self._quitting = True
        threading.Thread(target=self._quit_async, name="aidn-quit", daemon=True).start()
        return (200, {"ok": True, "quitting": True})

    def _quit_async(self) -> None:
        time.sleep(0.15)  # 让 HTTP 响应先写回，否则前端看到连接断开
        try:
            if self._tray is not None:
                self._tray.stop()
        except Exception:  # noqa: BLE001
            log.exception("停止托盘失败")
        try:
            if self._window is not None:
                self._window.destroy()
        except Exception:  # noqa: BLE001
            log.exception("销毁窗口失败")
        self._quit_event.set()

    def _shutdown(self) -> None:
        log.info("开始收尾")
        try:
            if self._tray is not None:
                self._tray.stop()
        except Exception:  # noqa: BLE001
            log.exception("停止托盘失败")
        try:
            self.supervisor.stop()
        except Exception:  # noqa: BLE001
            log.exception("停止 daemon 失败")
        try:
            if self._server is not None:
                self._server.stop()
        except Exception:  # noqa: BLE001
            log.exception("停止本地服务器失败")
        try:
            paths.runtime_state_path().unlink(missing_ok=True)
        except OSError:
            pass
        log.info("已退出")

    # --------------------------------------------------------------- 管理接口
    def restart_daemon(self) -> tuple[int, dict]:
        log.info("请求重启 daemon")
        ok = self.supervisor.restart()
        return (200 if ok else 500, {"ok": ok, "state": self.state()})

    def open_logs(self) -> tuple[int, dict]:
        target = paths.log_dir()
        target.mkdir(parents=True, exist_ok=True)
        try:
            os.startfile(str(target))  # noqa: S606 - 只打开自己的日志目录
        except Exception as error:  # noqa: BLE001
            log.exception("打开日志目录失败：%s", error)
            return (500, {"ok": False, "error": str(error)})
        return (200, {"ok": True, "path": str(target)})

    def update_settings(self, payload: dict) -> tuple[int, dict]:
        """保存设置并**立即生效**。

        四项各自的生效方式不同，这里逐条写清楚，不做「重启后生效」的含糊处理：

        - `open_mode`：只改下次启动用的默认值；本次要不要换界面形态由用户自己决定
          （点一下「在浏览器中打开」不需要重开程序）。
        - `autostart`：直接写/删 HKCU Run，写完立刻读回真实状态再回报。
        - `ui_port`：**就地重新绑定**本地服务器；内嵌窗口跟着导航到新地址。
        - `daemon_port`：重启 daemon 让它绑到新端口（配置里端口是启动参数）。
        - `log_dir`：关旧句柄、在新目录打开当天的 `desktop-YYYYMMDD.log`。
        """
        changed: list[str] = []
        notes: list[str] = []

        if "open_mode" in payload:
            mode = payload.get("open_mode")
            if mode not in ("embedded", "browser"):
                return (400, {"ok": False, "error": "open_mode 只能是 embedded 或 browser"})
            self.settings.open_mode = mode
            self._open_mode_override = None
            changed.append(f"open_mode={mode}")

        if "autostart" in payload:
            enabled = bool(payload.get("autostart"))
            actual = settings_mod.set_autostart(enabled)
            self.settings.autostart = actual
            if actual != enabled:
                notes.append("写入注册表后读回的状态与请求不一致，已按真实状态显示")
            changed.append(f"autostart={actual}")

        if "ui_port" in payload:
            try:
                port = int(payload.get("ui_port"))
            except (TypeError, ValueError):
                return (400, {"ok": False, "error": "界面端口必须是整数"})
            if not 0 <= port <= 65535:
                return (400, {"ok": False, "error": "界面端口必须在 0..65535"})
            if self._server is None:
                return (409, {"ok": False, "error": "界面服务尚未启动"})
            try:
                actual = self.restart_server(port)
            except Exception as error:  # noqa: BLE001
                log.exception("界面端口切换失败：%s", error)
                return (500, {"ok": False, "error": f"端口 {port} 不可用：{error}", "state": self.state()})
            self.settings.ui_port = actual
            changed.append(f"ui_port={actual}")
            if actual != port:
                notes.append(f"端口 {port} 被占用，已自动改用 {actual}")

        if "daemon_port" in payload:
            try:
                port = int(payload.get("daemon_port"))
            except (TypeError, ValueError):
                return (400, {"ok": False, "error": "daemon 端口必须是整数"})
            if not 0 <= port <= 65535:
                return (400, {"ok": False, "error": "daemon 端口必须在 0..65535"})
            self.settings.daemon_port = port
            ok = self.supervisor.restart()
            changed.append(f"daemon_port={self.supervisor.port}")
            if not ok:
                notes.append(f"daemon 未能重启：{self.supervisor.last_error or '未知原因'}")

        if "log_dir" in payload:
            raw = payload.get("log_dir")
            if not isinstance(raw, str):
                return (400, {"ok": False, "error": "log_dir 必须是字符串"})
            target = raw.strip()
            try:
                resolved = self.apply_log_dir(target)
            except Exception as error:  # noqa: BLE001
                log.exception("日志目录切换失败：%s", error)
                return (500, {"ok": False, "error": f"日志目录不可用：{error}", "state": self.state()})
            self.settings.log_dir = "" if target == "" else str(resolved)
            changed.append(f"log_dir={resolved}")

        self._persist_settings(self.settings)
        log.info("设置已更新：%s", ", ".join(changed) or "无变化")
        return (200, {"ok": True, "changed": changed, "notes": notes, "state": self.state()})

    # ------------------------------------------------------- 设置的即时生效
    def restart_server(self, port: int) -> int:
        """把本地界面服务器换到 *port*，返回真实端口。

        **先起新、后停旧**：调用方（设置页）正在旧端口上等这次 HTTP 响应，先停旧
        会把那个响应连根切断，用户看到的是「设置失败」，而实际上已经生效。旧监听
        在响应写完之后再关，中间那一小段时间两个端口并存，且只有新端口进了 self。
        """
        previous_port = self._server.port if self._server else None
        previous = self._server
        web_root = _pick_web_root()
        server = LocalServer(self, web_root, port)
        actual = server.start()
        self._server = server
        if previous is not None:
            stopper = threading.Timer(0.8, previous.stop)
            stopper.daemon = True
            stopper.start()
        log.info("界面端口 %s → %s", previous_port, actual)
        self._navigate_window(f"http://127.0.0.1:{actual}/")
        self.write_runtime_state()
        return actual

    def _navigate_window(self, url: str) -> None:
        window = self._window
        if window is None:
            return
        try:
            window.load_url(url)
        except Exception:  # noqa: BLE001 - 旧版 pywebview 没有 load_url
            try:
                window.evaluate_js(f"location.replace({url!r});")
            except Exception:  # noqa: BLE001
                log.exception("窗口导航到 %s 失败", url)

    def apply_log_dir(self, raw: str) -> Path:
        """把日志切到新目录；空串表示回到默认目录。返回真实目录。"""
        from . import logsetup

        target = paths.default_log_dir() if raw.strip() == "" else Path(raw.strip()).expanduser()
        target = target.resolve()
        target.mkdir(parents=True, exist_ok=True)
        paths.set_log_dir_override(target)
        written = logsetup.set_log_dir(target)
        log.info("日志目录已切换：%s（当前文件 %s）", target, written)
        return target

    # ------------------------------------------------------------------- 状态
    def daemon_port(self) -> int:
        return self.supervisor.port

    def daemon_token(self) -> str | None:
        return self.supervisor.read_token()

    @property
    def url(self) -> str:
        if self._server is None:
            return "—"
        return self._server.url

    def state(self) -> dict:
        from . import logsetup

        probe = self.supervisor.probe()
        autostart_registered, autostart_command = settings_mod.autostart_state()
        log_file = logsetup.current_file()
        return {
            "shell": {
                "product": PRODUCT_NAME,
                "version": SHELL_VERSION,
                "pid": os.getpid(),
                "url": self.url,
                "ui_port": self._server.port if self._server else None,
                "open_mode": self.open_mode(),
                "autostart": autostart_registered,
                "autostart_command": autostart_command,
                "tray_installed": bool(self._tray and self._tray.installed),
                "tray_error": self._tray.error if self._tray else None,
                "window_available": self._window is not None,
                "window_visible": self._window_visible,
                "data_dir": str(paths.data_dir()),
                "install_root": str(paths.install_root()),
                "log_dir": str(paths.log_dir()),
                "log_file": str(log_file) if log_file else None,
                "node_path": self.supervisor.node_path,
                "daemon_entry": self.supervisor.entry_path,
                "rules_path": str(paths.rules_path()),
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(self._started_at)),
                "uptime_s": round(time.time() - self._started_at, 1),
            },
            "settings": {
                "open_mode": self.settings.open_mode,
                "ui_port": self.settings.ui_port,
                "daemon_port": self.settings.daemon_port,
                "autostart": self.settings.autostart,
                "log_dir": self.settings.log_dir,
                "default_log_dir": str(paths.default_log_dir()),
                "settings_file": str(self._settings_path),
            },
            "daemon": probe,
        }

    def write_runtime_state(self) -> None:
        """给第二个实例/自动化脚本留一个握手文件。"""
        import json

        payload = {
            "pid": os.getpid(),
            "ui_port": self._server.port if self._server else None,
            "daemon_port": self.supervisor.port,
            "url": self.url,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(self._started_at)),
        }
        path = paths.runtime_state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ---------------------------------------------------------------- internals
    def _persist_settings(self, settings: settings_mod.Settings) -> None:
        settings_mod.save(self._settings_path, settings)


def _pick_web_root() -> Path:
    """外部 console 目录优先（可单独升级界面），否则用内置最小页。"""
    external = paths.console_dir()
    if (external / "index.html").is_file():
        log.info("使用外部控制台目录：%s", external)
        return external
    bundled = paths.webui_dir()
    if not (bundled / "index.html").is_file():
        raise RuntimeError(f"内置界面缺失：{bundled / 'index.html'}")
    return bundled


def open_log_dir_on_explorer(path: Path) -> None:
    """给 main.py 用：启动失败时把日志目录摊到用户面前。"""
    try:
        subprocess.Popen(["explorer", str(path)])  # noqa: S603,S607
    except OSError:
        pass
