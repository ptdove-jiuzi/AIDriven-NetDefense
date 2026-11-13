"""WebView2 空闲挂起：关窗口→托盘要真挂起，再打开要先恢复。

对应 PERF-CPU / N-034 的实测结论（`docs/implementation/evidence/perf/prof-shell/`）：
壳的「关窗口」是 hide 到托盘，隐藏后 WebView2 的 browser/renderer/gpu 全都还在，
而且 **hide() 不会让页面收到 visibilitychange** —— 页面仍认为自己是 visible，
`webui/app.js` 的递归 setTimeout 以 3.18 s 的满速一直轮询（术前实测壳 3.36 % 单核）。
所以修法有两层，本文件锁住的都是第二层（壳侧）的接线：

1. `_hide_window` 之后必须调用挂起；
2. `request_show_window` / 导航之前必须先恢复渲染，否则用户看到的是白屏；
3. 任何拿不到 CoreWebView2 的情况都必须降级（返回原因、不抛异常）；
4. `AIDN_NO_WEBVIEW_SUSPEND=1` 能一键关掉（A/B 测量与变异验证用）；
5. 退出流程不恢复（挂起态直接销毁窗口）。

这些都**不启动真实 GUI / 不启 daemon**，用假窗口 + 假后端。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402,F401  （统一隔离：不碰真实用户目录）

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "desktop"))

from aidn import settings as settings_mod  # noqa: E402
from aidn import webview_suspend  # noqa: E402
from aidn.app import ShellController  # noqa: E402


class _FakeWindow:
    """最小窗口替身：记录调用顺序。"""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.uid = "master"
        self.hidden = False

    def hide(self) -> None:
        self.calls.append("hide")
        self.hidden = True

    def show(self) -> None:
        self.calls.append("show")
        self.hidden = False

    def restore(self) -> None:
        self.calls.append("restore")

    def evaluate_js(self, *args, **kwargs):  # noqa: ANN002, ANN003
        self.calls.append("evaluate_js")
        return None

    def load_url(self, url: str) -> None:
        self.calls.append(f"load_url:{url}")


def _controller(background: bool = True) -> ShellController:
    controller = ShellController(settings_mod.Settings(), background=background)
    controller.state = lambda: {"stub": True}  # type: ignore[method-assign]
    return controller


class SuspendModuleDegrades(unittest.TestCase):
    """拿不到 WebView2 时必须返回原因，绝不抛。"""

    def test_status_without_backend(self) -> None:
        result = webview_suspend.status(None)
        self.assertIn("ok", result)
        self.assertFalse(result["ok"])
        self.assertTrue(result["reason"])

    def test_suspend_without_backend(self) -> None:
        result = webview_suspend.suspend(None)
        self.assertFalse(result["ok"])
        self.assertFalse(result["suspended"])
        self.assertTrue(result["reason"])

    def test_resume_without_backend(self) -> None:
        result = webview_suspend.resume(None)
        self.assertFalse(result["ok"])
        self.assertTrue(result["reason"])

    def test_suspend_honours_should_continue(self) -> None:
        calls: list[int] = []

        def never() -> bool:
            calls.append(1)
            return False

        result = webview_suspend.suspend(None, should_continue=never, attempts=3, delay=0)
        self.assertFalse(result["ok"])
        self.assertEqual(len(calls), 1, "should_continue 为假后不应继续重试")
        self.assertIn("放弃", result["reason"])


class HidePathSuspends(unittest.TestCase):
    """壳侧接线：关窗口→挂起；打开→先恢复；退出不恢复。"""

    def setUp(self) -> None:
        self._calls: list[tuple] = []
        self._real_suspend = webview_suspend.suspend
        self._real_resume = webview_suspend.resume

        def fake_suspend(window, **kwargs):  # noqa: ANN001, ANN003
            self._calls.append(("suspend", kwargs.get("attempts"), kwargs.get("delay")))
            return {"ok": True, "suspended": True, "reason": "stub", "attempts": 1}

        def fake_resume(window, **kwargs):  # noqa: ANN001, ANN003
            self._calls.append(("resume",))
            return {"ok": True, "resumed": True, "reason": "stub"}

        webview_suspend.suspend = fake_suspend  # type: ignore[assignment]
        webview_suspend.resume = fake_resume  # type: ignore[assignment]

    def tearDown(self) -> None:
        webview_suspend.suspend = self._real_suspend  # type: ignore[assignment]
        webview_suspend.resume = self._real_resume  # type: ignore[assignment]
        import os

        os.environ.pop("AIDN_NO_WEBVIEW_SUSPEND", None)
        os.environ.pop("AIDN_ENABLE_WEBVIEW_SUSPEND", None)

    def test_hide_window_calls_suspend(self) -> None:
        import os
        import time

        # 2026-11-05 起挂起**默认关闭**（长窗口稳定性事故，见 app.py::_suspend_enabled），
        # 要验证挂起路径本身，必须显式打开这个实验性开关。
        os.environ["AIDN_ENABLE_WEBVIEW_SUSPEND"] = "1"
        controller = _controller()
        window = _FakeWindow()
        controller._window = window  # noqa: SLF001
        controller._hide_window()  # noqa: SLF001
        time.sleep(0.1)  # _hide_window 先 sleep 0.05 再 hide
        self.assertIn("hide", window.calls)
        self.assertFalse(controller._window_visible)  # noqa: SLF001
        self.assertTrue(any(call[0] == "suspend" for call in self._calls), "隐藏后必须挂起 WebView2")

    def test_hide_window_default_does_not_suspend_but_tells_page(self) -> None:
        """默认语义：不动 compositor（挂起默认关），但仍要通知页面停表。"""
        import time

        controller = _controller()
        window = _FakeWindow()
        controller._window = window  # noqa: SLF001
        controller._hide_window()  # noqa: SLF001
        time.sleep(0.1)
        self.assertFalse([call for call in self._calls if call[0] == "suspend"],
                         "默认不允许挂起 WebView2（会导致壳十几分钟后消失）")
        self.assertIn("evaluate_js", window.calls, "隐藏后必须通知页面 __aidnShellHidden()")

    def test_suspend_can_be_disabled_by_env(self) -> None:
        import os
        import time

        os.environ["AIDN_NO_WEBVIEW_SUSPEND"] = "1"
        controller = _controller()
        controller._window = _FakeWindow()  # noqa: SLF001
        controller._hide_window()  # noqa: SLF001
        time.sleep(0.1)
        self.assertFalse([call for call in self._calls if call[0] == "suspend"])

    def test_show_window_resumes_before_show(self) -> None:
        controller = _controller()
        window = _FakeWindow()
        controller._window = window  # noqa: SLF001
        controller._webview_suspended = True  # noqa: SLF001
        status, body = controller.request_show_window("test")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIn("resume", [call[0] for call in self._calls], "显示窗口前必须先 Resume")
        self.assertLess(window.calls.index("show"), window.calls.index("restore"))
        self.assertFalse(controller._webview_suspended)  # noqa: SLF001

    def test_navigate_resumes_before_load(self) -> None:
        controller = _controller()
        window = _FakeWindow()
        controller._window = window  # noqa: SLF001
        controller._webview_suspended = True  # noqa: SLF001
        controller._navigate_window("http://127.0.0.1:1/")  # noqa: SLF001
        self.assertIn("resume", [call[0] for call in self._calls])
        self.assertTrue(any(call.startswith("load_url") for call in window.calls))

    def test_quit_path_does_not_suspend_or_resume(self) -> None:
        controller = _controller()
        controller._window = _FakeWindow()  # noqa: SLF001
        controller._quitting = True  # noqa: SLF001
        controller._suspend_webview()  # noqa: SLF001
        self.assertEqual(self._calls, [], "退出流程不该再挂起/恢复")


if __name__ == "__main__":
    unittest.main()

