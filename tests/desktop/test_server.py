"""本地界面服务器：静态页、目录穿越、壳写接口的准入门槛、daemon 离线时的同源代理。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402

sys.path.insert(0, str(_support.APP_DIR))

from aidn.server import LocalServer  # noqa: E402


class FakeController:
    """只实现 server 真正会调用的那几个方法。"""

    def __init__(self, daemon_port: int = 0, token: str | None = None) -> None:
        self._port = daemon_port
        self._token = token
        self.calls: list[str] = []

    def daemon_port(self) -> int:
        return self._port

    def daemon_token(self) -> str | None:
        return self._token

    def state(self) -> dict:
        return {"shell": {"pid": 1}, "daemon": {"online": self._port != 0}}

    def update_settings(self, payload: dict):
        self.calls.append(f"settings:{payload}")
        return (200, {"ok": True, "echo": payload})

    def restart_daemon(self):
        self.calls.append("restart")
        return (200, {"ok": True})

    def request_close_window(self):
        self.calls.append("close")
        return (200, {"ok": True, "window": "hidden"})

    def request_show_window(self, source: str, view=None):
        self.calls.append(f"show:{source}")
        return (200, {"ok": True, "window": "embedded"})

    def open_logs(self):
        self.calls.append("logs")
        return (200, {"ok": True, "path": "x"})

    def request_quit(self, source: str):
        self.calls.append(f"quit:{source}")
        return (200, {"ok": True, "quitting": True})


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.web = Path(tempfile.mkdtemp(prefix="aidn-web-"))
        (self.web / "index.html").write_text("<html><body>probe</body></html>", encoding="utf-8")
        (self.web / "app.js").write_text("console.log(1);", encoding="utf-8")
        (self.web / "leak.py").write_text("print('source code')", encoding="utf-8")
        (self.web.parent / "outside.html").write_text("outside", encoding="utf-8")
        self.controller = FakeController(daemon_port=0)
        self.server = LocalServer(self.controller, self.web, _support.free_port())
        self.port = self.server.start()

    def tearDown(self) -> None:
        self.server.stop()
        _support.rm(self.web)

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    # ----------------------------------------------------------------- 静态页
    def test_index_served(self) -> None:
        status, body = _support.http(self.url("/"))
        self.assertEqual(status, 200)
        request = __import__("urllib.request", fromlist=["Request"]).Request(self.url("/"))
        opener = __import__("urllib.request", fromlist=["build_opener"]).build_opener(
            __import__("urllib.request", fromlist=["ProxyHandler"]).ProxyHandler({}))
        with opener.open(request, timeout=5) as response:
            self.assertIn(b"probe", response.read())
            self.assertIn("no-store", response.headers.get("cache-control", ""))

    def test_static_assets_allowed_list(self) -> None:
        status, _ = _support.http(self.url("/app.js"))
        self.assertEqual(status, 200)
        status, _ = _support.http(self.url("/leak.py"))
        self.assertEqual(status, 404, "白名单之外的扩展名（源码）不能给出去")

    def test_traversal_rejected(self) -> None:
        for path in ("/../outside.html", "/%2e%2e/outside.html", "/..%2Foutside.html"):
            status, body = _support.http(self.url(path))
            self.assertEqual(status, 404, f"{path} 必须被拒绝")
            self.assertIsNotNone(body)

    # --------------------------------------------------------------- 壳写接口
    def test_post_requires_shell_header(self) -> None:
        status, body = _support.http(self.url("/shell/api/settings"), method="POST", payload={"ui_port": 1})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "SHELL_HEADER_REQUIRED")
        self.assertEqual(self.controller.calls, [])

    def test_post_requires_matching_origin(self) -> None:
        status, body = _support.http(
            self.url("/shell/api/settings"),
            method="POST",
            payload={"ui_port": 1},
            headers={"x-aidn-shell": "1", "origin": "http://evil.example"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "ORIGIN_REJECTED")

    def test_post_with_same_origin_origin_header_ok(self) -> None:
        status, _ = _support.http(
            self.url("/shell/api/settings"),
            method="POST",
            payload={"ui_port": 1},
            headers={"x-aidn-shell": "1", "origin": f"http://127.0.0.1:{self.port}"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(self.controller.calls), 1)

    def test_read_only_endpoint_rejects_post_without_write_gate(self) -> None:
        # post-fix expectation (D4)：`/api/*` 的写方法现在会被代发到 daemon，
        # 但必须先过宿主侧的跨源写闸门。旧期望是 405 METHOD_NOT_ALLOWED（缺陷现状：
        # console-next 的写动作在壳层被一刀切拒掉），新期望是 403 CONSOLE_HEADER_REQUIRED。
        status, body = _support.http(self.url("/api/v1/status"), method="POST", payload={},
                                     headers={"x-aidn-shell": "1"})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "CONSOLE_HEADER_REQUIRED")

    def test_write_with_gate_reaches_proxy_not_405(self) -> None:
        # post-fix expectation (D4)：带 x-console-v2 的写请求不再被 405 拒，
        # daemon 离线时如实报 503（修复前是 405，那是「v2 界面假加载」的根因）。
        status, body = _support.http(self.url("/api/v1/settings"), method="PUT", payload={},
                                     headers={"x-console-v2": "1"})
        self.assertEqual(status, 503, "写代理应到达「daemon 离线」分支，而不是被壳层 405/501 拒掉")
        self.assertEqual(body["error"]["code"], "DAEMON_OFFLINE")

    def test_state_endpoint(self) -> None:
        status, body = _support.http(self.url("/shell/api/state"))
        self.assertEqual(status, 200)
        self.assertEqual(body["shell"]["pid"], 1)

    # ------------------------------------------------------------ daemon 离线
    def test_proxy_returns_503_when_daemon_down(self) -> None:
        status, body = _support.http(self.url("/api/v1/status"))
        self.assertEqual(status, 503, "daemon 不在时必须明确报离线，而不是空响应")
        self.assertEqual(body["error"]["code"], "DAEMON_OFFLINE")

    def test_healthz_proxy_returns_503_when_daemon_down(self) -> None:
        status, body = _support.http(self.url("/healthz"))
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "DAEMON_OFFLINE")


if __name__ == "__main__":
    unittest.main()
