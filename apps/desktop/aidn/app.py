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
from . import webview_suspend
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
        self._webview_suspended = False
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
                # 托盘左键 = 显示/隐藏切换；菜单里的「打开界面」是明确的显示。
                "show": self.toggle_window,
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
                # 先告诉页面"你被藏了"：WebView2 的 hide() 不触发 visibilitychange，页面自己
                # 发现不了（实测关窗 5 分钟后 document.hidden 仍是 false），前端定时器会一直满速跑。
                # 这一步是省电的主力，且完全在 JS 侧，不碰 compositor。
                self._notify_shell_hidden()
                # 之后才尝试挂起 WebView2（默认关闭，需 AIDN_ENABLE_WEBVIEW_SUSPEND=1）。
                self._suspend_webview()
        except Exception:  # noqa: BLE001
            log.exception("隐藏窗口失败")

    def _notify_shell_hidden(self) -> None:
        """告诉页面前端"窗口已收起"，让它停表并暂停常驻动画（webui 与 console-next 各一份）。"""
        if self._window is None:
            return
        try:
            self._window.evaluate_js(
                "window.__aidnShellHidden && window.__aidnShellHidden();"
            )
        except Exception:  # noqa: BLE001 - 页面未就绪时忽略，隐藏本身不受影响
            log.debug("通知页面停止轮询失败（页面可能还没加载完）")

    # ------------------------------------------------------- WebView2 空闲挂起
    def _suspend_enabled(self) -> bool:
        """WebView2 挂起**默认关闭**：需要显式 `AIDN_ENABLE_WEBVIEW_SUSPEND=1` 才开启。

        为什么默认关：2026-11-05 Window B 抓到功能回退 —— 挂起成功后约 18 分钟，壳进程连同它的
        WebView2 子进程一起消失（日志最后一行是 `mode=trysuspend` 的挂起成功，之后没有任何退出
        记录；`shell-post.log` 出现 `Failed to unregister class Chrome_WidgetWin_0. Error = 1411`）。
        用户视角就是"托盘壳闲置十几分钟后自己没了"。
        功能不回退优先于省电：默认不动 compositor，省电改由页面侧停表承担
        （壳调 `window.__aidnShellHidden()` / `window.__aidnShellResume()`，见 webui/app.js）。
        `AIDN_NO_WEBVIEW_SUSPEND=1` 仍作为硬关闭开关保留（优先级更高）。
        """
        if os.environ.get("AIDN_NO_WEBVIEW_SUSPEND") == "1":
            return False
        return os.environ.get("AIDN_ENABLE_WEBVIEW_SUSPEND") == "1"

    def _suspend_webview(self) -> None:
        """窗口收起后挂起 WebView2：页面 JS 与合成器一起停，renderer 不再被定时器唤醒。

        为什么允许重试：`hide()` 是瞬时的，而页面/引擎可能还在加载或导航，此时
        `TrySuspendAsync` 必然失败 —— 用 6×0.5 s 的窗口等它稳定；期间一旦窗口重新可见
        就立刻放弃，绝不把用户眼前的窗口挂起。
        """
        if self._quitting or not self._suspend_enabled():
            return
        if self._window is None or self._webview_suspended:
            return
        result = webview_suspend.suspend(
            self._window,
            should_continue=lambda: not self._window_visible and not self._quitting,
            attempts=6,
            delay=0.5,
        )
        self._webview_suspended = bool(result.get("suspended"))
        if result.get("ok"):
            log.info("WebView2 已挂起：%s（mode=%s，第 %s 次尝试）",
                     result.get("reason"), result.get("mode"), result.get("attempts"))
        else:
            log.warning("WebView2 未能挂起，已降级为不挂起：%s（尝试 %s 次）",
                        result.get("reason"), result.get("attempts"))

    def _resume_webview(self, source: str = "") -> None:
        """窗口要重新出现/导航前先恢复渲染。幂等；没挂起时是空操作。"""
        if self._window is None:
            return
        result = webview_suspend.resume(self._window)
        if result.get("resumed"):
            log.info("WebView2 已恢复渲染（%s）", source or "窗口显示")
        elif not result.get("ok"):
            # 引擎尚未初始化时 resume 也会失败：属于正常时序，别打 warning 吓用户。
            log.debug("WebView2 恢复渲染未执行（%s）：%s", source, result.get("reason"))
        self._webview_suspended = False

    def _notify_shell_visible(self) -> None:
        """告诉页面前端"窗口真的可见了"，让它恢复轮询/动画。

        为什么需要这一句：WebView2 的 `hide()` / `show()` 都不触发 `visibilitychange`
        （实测：关窗 5 分钟后页面仍 `document.hidden=true`；挂起并重载后的页面会继承 hidden），
        而前端为了省电在 hidden 时停表 —— 两者叠加就是"重开窗口后数据不刷新"。
        这里调用页面暴露的 `window.__aidnShellResume()`（webui 与 console-next 各实现一份）。
        """
        if self._window is None:
            return
        try:
            self._window.evaluate_js(
                "window.__aidnShellResume && window.__aidnShellResume();"
            )
        except Exception:  # noqa: BLE001 - 页面还没加载完时忽略，下一次显示会再发
            log.debug("通知页面恢复轮询失败（页面可能还没加载完）")

    def _schedule_visible_notify(self, delays: tuple[float, ...] = (0.8, 2.5)) -> None:
        """导航/重载之后补发恢复通知：页面加载完才知道自己该不该轮询，所以要等一会儿再喊。"""

        def worker() -> None:
            for delay in delays:
                time.sleep(delay)
                if not self._window_visible or self._quitting:
                    return
                self._notify_shell_visible()

        threading.Thread(target=worker, name="aidn-visible-notify", daemon=True).start()

    def request_show_window(self, source: str, view: str | None = None) -> tuple[int, dict]:
        log.info("显示窗口（来源 %s）", source)
        if self._window is None:
            # 无窗口模式（默认浏览器打开）：直接开浏览器。
            self.open_in_browser()
            return (200, {"ok": True, "window": "browser", "state": self.state()})
        try:
            self._resume_webview("显示窗口")
            self._window.show()
            self._window.restore()
            self._window_visible = True
            # 显示之后兜底解冻 + **明确告知页面"窗口真的可见了"**：
            # WebView2 的 hide()/show() 不触发 visibilitychange，挂起后重载的页面会一直认为
            # 自己是 hidden（实测重开后 document.hidden=true），前端因此停表、界面不刷新。
            # 页面里的 window.__aidnShellResume() 就是给这一句话用的（webui 与 console-next 都有）。
            self._resume_webview("显示后兜底")
            self._notify_shell_visible()
            # 立即那次常常打在"页面还在重载"的时间窗里（钩子还没定义），补两次延迟重试。
            self._schedule_visible_notify()
            if view:
                self._window.evaluate_js(f"location.hash = '#/{view}';")
        except Exception as error:  # noqa: BLE001
            log.exception("显示窗口失败：%s", error)
            return (500, {"ok": False, "error": str(error)})
        return (200, {"ok": True, "window": "embedded", "state": self.state()})

    def toggle_window(self) -> tuple[int, dict]:
        """托盘左键：可见就收起来，不可见就亮出来。"""
        if self._window is None:
            return self.open_in_browser()
        if self._window_visible:
            self._hide_window()
            return (200, {"ok": True, "window": "hidden", "state": self.state()})
        return self.request_show_window("tray")

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
            # 立即生效只做得到一半，且必须说清楚：
            # - 切到浏览器：现在就把页面交给默认浏览器，并把内嵌窗口收起来；
            # - 切回内嵌：无窗口模式没有 GUI 循环可以接管（pywebview 的 start() 只能
            #   在主线程调一次），所以只能下次启动生效 —— 与其假装生效，不如直说。
            if mode == "browser":
                self.open_in_browser()
                if self._window is not None and self._window_visible:
                    self._hide_window()
            elif self._window is None:
                notes.append("当前以浏览器方式运行，切回内嵌窗口需要重启程序")

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
        self._resume_webview("导航前")  # 挂起状态下导航不会执行，先恢复渲染
        try:
            window.load_url(url)
        except Exception:  # noqa: BLE001 - 旧版 pywebview 没有 load_url
            try:
                window.evaluate_js(f"location.replace({url!r});")
            except Exception:  # noqa: BLE001
                log.exception("窗口导航到 %s 失败", url)
        # 导航出来的新页面同样会继承 hidden 态（hide()/show() 不触发 visibilitychange），
        # 加载完补发一次"窗口可见"通知，否则页面会一直不轮询。
        self._schedule_visible_notify()

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

