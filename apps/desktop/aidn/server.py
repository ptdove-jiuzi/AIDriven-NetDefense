"""server.py —— 桌面壳内置的本地服务器（静态页 + 同源代理 + 壳管理接口）。

为什么壳要自带一个服务器，而不是直接让浏览器连 daemon：

- daemon 的 `/api/v1/*` 需要 bearer token，而 token 只能从 0600 文件读；
  把 token 交给浏览器等于把它交给任何一个能读页面源码的本地进程；
- daemon 只接受 `Host: 127.0.0.1:<daemon端口>`，页面若直连会出现跨端口 Origin，
  daemon 会按 Origin 拒绝写请求；
- 同一个页面还要读写「壳自己的设置」，那是 daemon 不知道的东西。

所以：浏览器只跟壳说话，壳把只读请求转发给 daemon 并在服务端注入 Authorization。
浏览器永远看不到 token，也永远不知道 daemon 的端口在协议上意味着什么。
"""

from __future__ import annotations

import http.client
import json
import logging
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import paths

log = logging.getLogger("aidn.server")

BIND_HOST = "127.0.0.1"

ALLOWED_EXTENSIONS = {
    ".html", ".htm", ".css", ".js", ".mjs", ".svg", ".png", ".jpg", ".jpeg",
    ".gif", ".ico", ".webp", ".woff", ".woff2", ".json", ".txt", ".map",
}

MAX_BODY = 64 * 1024

SECURITY_HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": (
        "default-src 'self'; "
        "img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; "
        "connect-src 'self'; "
        "base-uri 'none'; "
        "form-action 'none'; "
        "frame-ancestors 'none'"
    ),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "AIDrivenNetDefenseShell"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- plumbing
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - stdlib 名称
        log.debug("%s - %s", self.address_string(), fmt % args)

    @property
    def app(self) -> "LocalServer":
        return self.server.app  # type: ignore[attr-defined]

    def _peer_ok(self) -> bool:
        address = self.client_address[0] if self.client_address else ""
        return address in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": message}})

    # ---------------------------------------------------------------- verbs
    def do_GET(self) -> None:  # noqa: N802 - stdlib 命名
        if not self._peer_ok():
            return self._error(403, "PEER_REJECTED", "only loopback peers are served")
        path = urlparse(self.path).path
        if path in ("/healthz", "/readyz"):
            return self._proxy(path)
        if path.startswith("/api/"):
            return self._proxy(path, with_query=True)
        if path == "/shell/api/state":
            return self._json(200, self.app.controller.state())
        if path.startswith("/shell/api/"):
            return self._error(405, "METHOD_NOT_ALLOWED", "此接口只接受 POST")
        return self._static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        return self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self._peer_ok():
            return self._error(403, "PEER_REJECTED", "only loopback peers are served")
        path = urlparse(self.path).path
        if not path.startswith("/shell/api/"):
            return self._error(405, "METHOD_NOT_ALLOWED", "只读端点不接受 POST")

        # 壳的写接口需要两个廉价但有效的门槛：自定义头（跨源页面无法在不触发
        # 预检的情况下伪造）与 Origin 校验（若浏览器给了 Origin，必须是本壳）。
        if self.headers.get("x-aidn-shell") != "1":
            return self._error(403, "SHELL_HEADER_REQUIRED", "缺少 x-aidn-shell 请求头")
        origin = self.headers.get("origin")
        if origin and origin not in self.app.allowed_origins():
            return self._error(403, "ORIGIN_REJECTED", "Origin 不是本机壳端点")

        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            return self._error(413, "BODY_TOO_LARGE", "请求体过大")
        raw = self.rfile.read(length) if length else b""
        payload: dict = {}
        if raw:
            try:
                parsed = json.loads(raw.decode("utf-8"))
                payload = parsed if isinstance(parsed, dict) else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self._error(400, "BAD_JSON", "请求体不是合法 JSON")

        try:
            return self.app.dispatch_post(self, path, payload)
        except Exception as error:  # noqa: BLE001
            log.exception("壳接口异常：%s", path)
            return self._error(500, "SHELL_INTERNAL", str(error))

    # --------------------------------------------------------------- helpers
    def _proxy(self, path: str, with_query: bool = False) -> None:
        target = self.path if with_query and "?" in self.path else path
        status, headers, body = self.app.proxy_get(target)
        if status == 0:
            return self._error(503, "DAEMON_OFFLINE", "daemon 未运行或未响应")
        content_type = headers.get("content-type", "application/json; charset=utf-8")
        self._send(status, body, content_type)

    def _static(self, path: str) -> None:
        relative = unquote(path).lstrip("/")
        if relative == "":
            relative = "index.html"
        if ".." in relative.split("/") or relative.startswith("."):
            return self._error(404, "NOT_FOUND", "no such file")
        candidate = (self.app.web_root / relative).resolve()
        try:
            candidate.relative_to(self.app.web_root)
        except ValueError:
            return self._error(404, "NOT_FOUND", "no such file")
        if not candidate.is_file():
            return self._error(404, "NOT_FOUND", "no such file")
        if candidate.suffix.lower() not in ALLOWED_EXTENSIONS:
            return self._error(404, "NOT_FOUND", "no such file")
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "image/svg+xml"):
            content_type = f"{content_type}; charset=utf-8"
        body = candidate.read_bytes()
        self._send(200, body, content_type)


class LocalServer:
    PORT_ATTEMPTS = 5

    def __init__(self, controller, web_root: Path, preferred_port: int) -> None:
        self.controller = controller
        self.web_root = web_root.resolve()
        self._preferred_port = preferred_port
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port = 0

    def _candidates(self) -> list[int]:
        """优先 preferred，被占用就逐个 +1；最后才让内核随便给一个。"""
        preferred = int(self._preferred_port or 0)
        if not preferred:
            return [0]
        return list(range(preferred, min(preferred + self.PORT_ATTEMPTS, 65536))) + [0]

    # ------------------------------------------------------------------ start
    def start(self) -> int:
        last_error: OSError | None = None
        for candidate in self._candidates():
            try:
                httpd = ThreadingHTTPServer((BIND_HOST, candidate), Handler)
            except OSError as error:
                last_error = error
                continue
            httpd.daemon_threads = True
            httpd.app = self  # type: ignore[attr-defined]
            self._httpd = httpd
            self.port = httpd.server_address[1]
            self._thread = threading.Thread(target=httpd.serve_forever, name="aidn-http", daemon=True)
            self._thread.start()
            log.info("本地界面服务已监听：http://%s:%d（静态根 %s）", BIND_HOST, self.port, self.web_root)
            return self.port
        raise RuntimeError(f"本地界面服务无法绑定回环端口：{last_error}")

    def stop(self) -> None:
        if self._httpd is None:
            return
        try:
            self._httpd.shutdown()
            self._httpd.server_close()
        except Exception:  # noqa: BLE001
            pass
        self._httpd = None
        log.info("本地界面服务已停止")

    @property
    def url(self) -> str:
        return f"http://{BIND_HOST}:{self.port}/" if self.port else "—"

    def allowed_origins(self) -> tuple[str, ...]:
        return (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}")

    # ------------------------------------------------------------------ proxy
    def proxy_get(self, path: str) -> tuple[int, dict, bytes]:
        """把只读请求转给 daemon，并在服务端补上 bearer token。"""
        port = self.controller.daemon_port()
        if not port:
            return (0, {}, b"")
        token = self.controller.daemon_token()
        headers = {"accept": "application/json", "host": f"127.0.0.1:{port}"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        connection = http.client.HTTPConnection(BIND_HOST, port, timeout=6.0)
        try:
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            body = response.read()
            return (response.status, {k.lower(): v for k, v in response.getheaders()}, body)
        except (OSError, http.client.HTTPException) as error:
            log.warning("代理 %s 失败：%s", path, error)
            return (0, {}, b"")
        finally:
            connection.close()

    # ------------------------------------------------------------- shell api
    def dispatch_post(self, handler: Handler, path: str, payload: dict) -> None:
        """路由壳的写接口。controller 的方法统一返回 (status, body) 二元组。"""
        target = self.controller
        routes = {
            "/shell/api/settings": lambda: target.update_settings(payload),
            "/shell/api/daemon/restart": target.restart_daemon,
            "/shell/api/window/close": target.request_close_window,
            "/shell/api/window/show": lambda: target.request_show_window("api"),
            "/shell/api/logs/open": target.open_logs,
            "/shell/api/quit": lambda: target.request_quit("api"),
        }
        action = routes.get(path)
        if action is None:
            return handler._error(404, "NOT_FOUND", "no such endpoint")
        status, body = action()
        return handler._json(status, body)
