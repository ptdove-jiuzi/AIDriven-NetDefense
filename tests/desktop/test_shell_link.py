"""D4 回归：托盘壳必须能当 console-next 的宿主（v2 界面 + 写代理 + SSE 透传）。

修复前的真实缺陷（UI2-INTEGRATION D4 / NEEDED-DESKTOP-CHANGE.md）：

- `apps/desktop/aidn/server.py` 只代理 GET；`do_POST` 只认 `/shell/api/*` →
  console-next 的 `POST /api/v1/*` 拿到 **405**，`PUT` 落到 stdlib 默认 → **501**，
  chat/explain 的 SSE 拿不到流；
- 于是「托盘打开界面」即使 stage 了 v2 文件也只是**假加载**。

本文件用**真实 `LocalServer` + 假 daemon 上游**直调路由（不启 GUI、不启真 daemon）：
先跑修复前的 server.py 应该红，修复后转绿。变异（删掉写代理分支）也必须转红。

运行：python tests/desktop/run-tests.py test_shell_link
     python -m unittest tests.desktop.test_shell_link -v
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402

sys.path.insert(0, str(_support.APP_DIR))

from aidn.server import LocalServer  # noqa: E402

REPO_ROOT = _support.REPO_ROOT
CONSOLE_NEXT = REPO_ROOT / "apps" / "console-next"
TOKEN = "tok-d4-secret"


def csrf_for(token: str) -> str:
    """与 daemon `auth.js` / console-next `serve.mjs` 同式派生。"""
    digest = hashlib.sha256(f"aegis-csrf:{token}".encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


class _Upstream(BaseHTTPRequestHandler):
    """假 daemon：记录收到的请求；chat 走真 SSE（事件之间停顿，用于证明流式）。"""

    protocol_version = "HTTP/1.0"  # close-delimited，SSE 可以边写边到
    seen: list = []
    lock = threading.Lock()

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        pass

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self) -> bytes:
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length else b""
        with self.lock:
            self.seen.append({
                "method": self.command,
                "path": self.path,
                "headers": {name.lower(): value for name, value in self.headers.items()},
                "body": body,
            })
        return body

    def do_GET(self) -> None:  # noqa: N802
        self._record()
        if self.path.startswith("/healthz"):
            return self._json(200, {"status": "ok"})
        return self._json(404, {"error": {"code": "NOT_FOUND"}})

    def do_POST(self) -> None:  # noqa: N802
        body = self._record()
        if self.path == "/api/v1/agent/chat":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'event: delta\ndata: {"n":1}\n\n')
            self.wfile.flush()
            time.sleep(0.8)  # 第二段故意延迟：只有真流式才能先收到第一段
            self.wfile.write(b'event: done\ndata: {"n":2}\n\n')
            self.wfile.flush()
            return None
        if self.path == "/api/v1/settings":
            if body.strip() in (b"", b"{}"):
                return self._json(400, {"error": {"code": "SETTINGS_INVALID", "message": "empty"}})
            return self._json(200, {"ok": True})
        return self._json(404, {"error": {"code": "NOT_FOUND"}})

    def do_PUT(self) -> None:  # noqa: N802
        self._record()
        if self.path == "/api/v1/settings":
            return self._json(200, {"ok": True, "saved": True})
        return self._json(404, {"error": {"code": "NOT_FOUND"}})

    def do_DELETE(self) -> None:  # noqa: N802
        self._record()
        if self.path.startswith("/api/v1/"):
            return self._json(200, {"ok": True, "deleted": True})
        return self._json(404, {"error": {"code": "NOT_FOUND"}})


class FakeController:
    """只实现 server 会调用到的方法。"""

    def __init__(self, daemon_port: int = 0, token: str | None = None) -> None:
        self._port = daemon_port
        self._token = token

    def daemon_port(self) -> int:
        return self._port

    def daemon_token(self) -> str | None:
        return self._token

    def state(self) -> dict:
        return {"shell": {"pid": 1}, "daemon": {"online": self._port != 0}}


class ShellLinkTest(unittest.TestCase):
    upstream_port = 0

    @classmethod
    def setUpClass(cls) -> None:
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
        cls.upstream_port = cls.upstream.server_address[1]
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def setUp(self) -> None:
        _Upstream.seen = []
        self.controller = FakeController(daemon_port=self.upstream_port, token=TOKEN)
        # 直接把真实 console-next 目录当静态根：证明 v2 界面字节经壳原样送出。
        self.server = LocalServer(self.controller, CONSOLE_NEXT, 0)
        self.port = self.server.start()

    def tearDown(self) -> None:
        self.server.stop()

    # ---------------------------------------------------------------- helpers
    def request(self, method: str, path: str, body: bytes | None = None,
                headers: dict[str, str] | None = None, timeout: float = 5.0):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        request_headers = dict(headers or {})
        if body is not None:
            request_headers.setdefault("content-type", "application/json")
            request_headers.setdefault("content-length", str(len(body)))
        try:
            connection.request(method, path, body=body, headers=request_headers)
            return connection, connection.getresponse()
        except Exception:
            connection.close()
            raise

    def seen(self, path: str) -> list[dict]:
        return [entry for entry in _Upstream.seen if entry["path"] == path]

    # ------------------------------------------------- 1. v2 界面由壳原样提供
    def test_serves_console_next_index_verbatim(self) -> None:
        """托盘打开的界面字节必须就是 console-next 的 index.html（不是旧 apps/console）。"""
        connection, response = self.request("GET", "/")
        try:
            body = response.read()
        finally:
            connection.close()
        self.assertEqual(response.status, 200)
        expected = (CONSOLE_NEXT / "index.html").read_bytes()
        self.assertEqual(body, expected, "壳送出的首屏不是 console-next/index.html 的字节")
        self.assertGreaterEqual(body.count(b"data-route="), 6, "v2 外壳的六路由标记缺失")
        self.assertIn(b"x-console-v2", body + (CONSOLE_NEXT / "js" / "api.js").read_bytes(),
                      "console-next 的写请求标记在静态载荷里不可见")

    # ------------------------------------------------- 2. POST 写代理到达 daemon
    def test_post_write_reaches_daemon_with_bearer_and_csrf(self) -> None:
        """console-next 的 `POST /api/v1/*` 必须到达 daemon，并注入 Bearer + CSRF。"""
        connection, response = self.request(
            "POST", "/api/v1/settings", b'{"ui_port":1}',
            {"x-console-v2": "1", "origin": f"http://127.0.0.1:{self.port}"})
        try:
            body = response.read()
        finally:
            connection.close()
        # 假 daemon 对空 body 之外返回 200；修复前这里是 405（=缺陷锚点）。
        self.assertNotEqual(response.status, 405, "POST /api/v1/* 仍在壳层被 405 拒掉（D4 未修）")
        self.assertEqual(response.status, 200, body.decode("utf-8", "replace"))
        seen = self.seen("/api/v1/settings")
        self.assertEqual(len(seen), 1, "写请求没有到达 daemon")
        forwarded = seen[0]["headers"]
        self.assertEqual(forwarded.get("authorization"), f"Bearer {TOKEN}", "壳没有在服务端注入 bearer")
        self.assertEqual(forwarded.get("x-aegis-csrf"), csrf_for(TOKEN), "CSRF 派生值与 daemon 不一致")
        self.assertEqual(seen[0]["body"], b'{"ui_port":1}')
        # 跨源头不能被转发；宿主自己的写标记也不能漏给 daemon。
        self.assertNotIn("origin", forwarded)
        self.assertNotIn("referer", forwarded)
        self.assertNotIn("cookie", forwarded)
        self.assertNotIn("x-console-v2", forwarded, "x-console-v2 是宿主自己的闸门，不能转发")

    # ------------------------------------------------- 3. PUT 写代理到达 daemon
    def test_put_write_reaches_daemon(self) -> None:
        """console-next 的 settings 保存是 `PUT /api/v1/settings`（旧壳 = 501）。"""
        connection, response = self.request(
            "PUT", "/api/v1/settings", b'{"ui_port":1}', {"x-console-v2": "1"})
        try:
            body = response.read()
        finally:
            connection.close()
        self.assertNotEqual(response.status, 501, "PUT 仍是 stdlib 的 501（D4 未修）")
        self.assertEqual(response.status, 200, body.decode("utf-8", "replace"))
        self.assertEqual(len(self.seen("/api/v1/settings")), 1)

    def test_delete_is_routed_like_put(self) -> None:
        connection, response = self.request("DELETE", "/api/v1/credentials/x", None, {"x-console-v2": "1"})
        try:
            body = response.read()
        finally:
            connection.close()
        self.assertNotEqual(response.status, 501, "DELETE 仍是 stdlib 的 501（D4 未修）")
        self.assertEqual(response.status, 200, body.decode("utf-8", "replace"))
        self.assertEqual(len(self.seen("/api/v1/credentials/x")), 1, "DELETE 没有到达 daemon")

    # ------------------------------------------------- 4. 跨源写闸门必须留在壳层
    def test_write_without_console_header_rejected(self) -> None:
        connection, response = self.request("POST", "/api/v1/settings", b'{"ui_port":1}')
        try:
            body = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
        self.assertEqual(response.status, 403)
        self.assertEqual(body["error"]["code"], "CONSOLE_HEADER_REQUIRED")
        self.assertEqual(self.seen("/api/v1/settings"), [], "没带闸门的跨源写不能被代发")

    def test_write_with_foreign_origin_rejected(self) -> None:
        connection, response = self.request(
            "POST", "/api/v1/settings", b'{"ui_port":1}',
            {"x-console-v2": "1", "origin": "http://evil.example"})
        try:
            body = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
        self.assertEqual(response.status, 403)
        self.assertEqual(body["error"]["code"], "ORIGIN_REJECTED")
        self.assertEqual(self.seen("/api/v1/settings"), [])

    # ------------------------------------------------- 5. SSE 必须真流式
    def test_sse_streams_before_upstream_finishes(self) -> None:
        """chat 的两段事件之间有 0.8s：壳若整包 read() 缓存，第一段不可能先到。"""
        connection, response = self.request(
            "POST", "/api/v1/agent/chat", b'{"query":"x"}',
            {"x-console-v2": "1", "accept": "text/event-stream"}, timeout=5.0)
        try:
            self.assertEqual(response.status, 200)
            self.assertIn("text/event-stream", response.headers.get("content-type", ""))
            started = time.monotonic()
            first = response.read1(65536)
            first_elapsed = time.monotonic() - started
            self.assertIn(b"event: delta", first, f"第一段事件没先到：{first!r}")
            self.assertLess(first_elapsed, 0.6,
                            f"第一段事件 {first_elapsed:.3f}s 才到：壳在整包缓存（不是流式）")
            rest = response.read()
            self.assertIn(b"event: done", rest)
        finally:
            connection.close()

    # ------------------------------------------------- 6. 只读代理未被破坏
    def test_get_proxy_still_works(self) -> None:
        connection, response = self.request("GET", "/healthz")
        try:
            body = json.loads(response.read().decode("utf-8"))
        finally:
            connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(self.seen("/healthz")[0]["headers"].get("authorization"), f"Bearer {TOKEN}")

    # ------------------------------------------------- 7. daemon 离线时写请求明确报离线
    def test_write_returns_offline_when_daemon_absent(self) -> None:
        controller = FakeController(daemon_port=0, token=None)
        server = LocalServer(controller, CONSOLE_NEXT, 0)
        port = server.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5.0)
            try:
                connection.request("PUT", "/api/v1/settings", body=b"{}",
                                   headers={"x-console-v2": "1", "content-type": "application/json"})
                response = connection.getresponse()
                body = json.loads(response.read().decode("utf-8"))
            finally:
                connection.close()
        finally:
            server.stop()
        self.assertEqual(response.status, 503)
        self.assertEqual(body["error"]["code"], "DAEMON_OFFLINE")


if __name__ == "__main__":
    unittest.main()
