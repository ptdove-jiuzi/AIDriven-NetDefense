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

import base64
import hashlib
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

#: 浏览器侧写闸门：与 `apps/console-next/serve.mjs` 的 `x-console-v2` 同形。
#: 跨源表单加不上自定义头，所以「有这道头」是宿主层唯一能自证的跨源写屏障。
CONSOLE_HEADER = "x-console-v2"
CONSOLE_HEADER_VALUE = "1"
CSRF_HEADER = "x-aegis-csrf"
#: SSE 路由（chat / explain）要豁免普通超时并**流式**转发。
STREAMING_PREFIXES = ("/api/v1/agent/chat", "/api/v1/alerts/")


def csrf_token_for(token: str) -> str:
    """与 daemon 同式派生：base64url(sha256("aegis-csrf:" + token))，无 padding。

    对应 `apps/daemon/src/api/auth.js` `createAuthGuard()` 与
    `apps/console-next/serve.mjs:192-193` 的 `csrfFor()`。
    """
    digest = hashlib.sha256(f"aegis-csrf:{token}".encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")

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

    def _send_stream(self, status: int, headers: dict, upstream) -> None:
        """把上游响应**边读边写**（SSE）；整包 `read()` 会让流在壳里变成一次性大响应。

        上游是 chunked 时 `read(n)` 会一直攒到 n 字节或 EOF，所以这里优先用 `read1()`：
        它「最多读一次」，有多少给多少，事件才能按到达顺序立刻转发。
        """
        self.send_response(status)
        self.send_header("content-type", headers.get("content-type", "text/event-stream; charset=utf-8"))
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("transfer-encoding", "chunked")
        for name, value in SECURITY_HEADERS.items():
            if name in ("content-type", "cache-control", "x-content-type-options"):
                continue
            self.send_header(name, value)
        self.end_headers()
        if self.command == "HEAD":
            return
        reader = getattr(upstream, "read1", None) or upstream.read
        try:
            while True:
                chunk = reader(4096)
                if not chunk:
                    break
                self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii") + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            # 浏览器关掉标签页是常态：流断了不是壳的错误，不用把 traceback 打给用户。
            log.debug("SSE 客户端提前断开，已停止转发")
        finally:
            upstream.close()

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
        # console-next 的写动作全部落在 /api/v1/*（chat/审批/凭据/settings）。
        # 修复前这里直接 405，于是「托盘加载 v2 界面」只是假加载（D4）。
        if path.startswith("/api/"):
            return self._proxy_write(path)
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

    def do_PUT(self) -> None:  # noqa: N802
        if not self._peer_ok():
            return self._error(403, "PEER_REJECTED", "only loopback peers are served")
        path = urlparse(self.path).path
        if not path.startswith("/api/"):
            return self._error(405, "METHOD_NOT_ALLOWED", "只读端点不接受 PUT")
        return self._proxy_write(path)

    def do_DELETE(self) -> None:  # noqa: N802
        return self.do_PUT()

    # --------------------------------------------------------------- helpers
    def _proxy(self, path: str, with_query: bool = False) -> None:
        target = self.path if with_query and "?" in self.path else path
        status, headers, body = self.app.proxy_get(target)
        if status == 0:
            return self._error(503, "DAEMON_OFFLINE", "daemon 未运行或未响应")
        content_type = headers.get("content-type", "application/json; charset=utf-8")
        self._send(status, body, content_type)

    def _proxy_write(self, path: str) -> None:
        """代发 console-next 的写请求（POST/PUT/DELETE）。

        安全要点：壳一旦代发写请求，`x-console-v2` 这道跨源写闸门就必须由**宿主**
        自己校验（console-next 的 serve.mjs 也放在宿主层）。否则任意网页都能
        `POST http://127.0.0.1:<ui_port>/api/v1/settings`，壳会把 Bearer 与 CSRF
        一起注入 —— 等于用壳绕开了 daemon 的 CSRF 防护。
        """
        if self.headers.get(CONSOLE_HEADER) != CONSOLE_HEADER_VALUE:
            return self._error(403, "CONSOLE_HEADER_REQUIRED", "写请求必须带 x-console-v2: 1")
        origin = self.headers.get("origin")
        if origin and origin not in self.app.allowed_origins():
            return self._error(403, "ORIGIN_REJECTED", "Origin 不是本机壳端点")
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return self._error(400, "BAD_REQUEST", "content-length 非法")
        if length > MAX_BODY:
            return self._error(413, "BODY_TOO_LARGE", "请求体过大")
        body = self.rfile.read(length) if length else b""
        relay = self.app.proxy_write(self.command, self.path, body, self.headers.get("content-type"))
        if relay is None:
            return self._error(503, "DAEMON_OFFLINE", "daemon 未运行或未响应")
        status, response, connection = relay
        content_type = response.getheader("content-type", "application/json") or "application/json"
        try:
            if content_type.startswith("text/event-stream"):
                return self._send_stream(status, {"content-type": content_type}, response)
            return self._send(status, response.read(), content_type)
        finally:
            connection.close()

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


class _LoopbackServer(ThreadingHTTPServer):
    """只监听回环的界面服务。

    `allow_reuse_address` 必须关掉：Windows 上 SO_REUSEADDR 允许**两个进程绑同一个端口**，
    于是「换端口」时旧监听还没关，新实例绑定也会成功——两个壳同时应答同一端口，
    请求随机落到其中一个，设置/退出都会作用在错误的对象上（实测踩过）。
    关掉之后端口被占就是 bind 失败，`LocalServer.start()` 的 +1 回退才有意义。
    """

    allow_reuse_address = False
    daemon_threads = True


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
                httpd = _LoopbackServer((BIND_HOST, candidate), Handler)
            except OSError as error:
                last_error = error
                continue
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

    def proxy_write(self, method: str, path: str, body: bytes, content_type: str | None):
        """代发写请求：注入 Bearer 与 CSRF 派生值，**不转发** origin/referer/cookie。

        返回 `(status, response, connection)`；daemon 不在/连不上返回 `None`（调用方报 503）。
        `x-console-v2` 是壳自己的闸门，停在这里，不往上送。
        """
        port = self.controller.daemon_port()
        if not port:
            return None
        token = self.controller.daemon_token()
        headers = {
            "accept": "application/json",
            "host": f"127.0.0.1:{port}",
            "content-type": content_type or "application/json",
        }
        if body:
            headers["content-length"] = str(len(body))
        if token:
            headers["authorization"] = f"Bearer {token}"
            headers[CSRF_HEADER] = csrf_token_for(token)
        # SSE 路由豁免普通超时（daemon 合同 §3.5）；其余沿用 10s 级。
        streaming = any(path.startswith(prefix) for prefix in STREAMING_PREFIXES)
        connection = http.client.HTTPConnection(BIND_HOST, port, timeout=None if streaming else 10.0)
        try:
            connection.request(method, path, body=body or None, headers=headers)
            response = connection.getresponse()  # 每个响应只取一次
            return (response.status, response, connection)
        except (OSError, http.client.HTTPException) as error:
            log.warning("写代理 %s %s 失败：%s", method, path, error)
            connection.close()
            return None

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
