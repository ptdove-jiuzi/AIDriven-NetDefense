#!/usr/bin/env python3
"""fake_server.py —— UPDATER-E2E 战役的假更新服务器（假服务器员交付物）。

契约来源：``tests/desktop/updater/e2e/SCENARIO-CONTRACT.md`` §3（逐字实现）。
纯标准库（``http.server`` / ``threading`` / ``json``），**只绑 ``("127.0.0.1", 0)``**，
因此物理上不可能产生外网流量。

被测形状（六个场景用 URL 前缀切换，互不需要重启）::

    GET /<scenario>/latest.json
    GET /<scenario>/assets/<asset_name>
    未知 scenario / 未知路径 / 未知资产 → 404

``fixtures[scenario]`` 字段（§3）：``mode`` / ``manifest`` / ``assets`` / ``asset_mode`` / ``etag``。

五个 wire mode：

* ``ok``        —— 正常 200 + 清单 ``ETag``；``If-None-Match`` 命中当前 ETag → 304 无 body。
* ``hang``      —— 读完请求后**一个字节都不发**，挂 ``HANG_SECONDS``（45 s）再关连接。
* ``half``      —— 发 ``Content-Length: N`` 头，只写 ``N // 2`` 字节，然后 ``SHUT_WR`` 硬关
                   （客户端侧表现为 ``http.client.IncompleteRead``）。
* ``tamper``    —— 发满 ``N`` 字节，但把**第 1 个字节**翻转（size 对、sha256 错）。
* ``notfound``  —— 清单与资产都回 404。

另外接受 ``mode="etag"`` 作为 ``ok`` 的别名（本实现的兼容扩展，不影响上表语义；
见 REPORT.md「接口清单 / 已知局限」）。

零外联硬化（round-2，**本文件禁止出现裸 urlopen**）
---------------------------------------------------
本机 ``ProxyEnable=1`` / ``ProxyServer=127.0.0.1:7897``。裸
``urllib.request.urlopen`` 会把外网请求**无感转发**给本地代理：从 socket 层看仍是
loopback，``EgressGuard`` 无从拦截（round-1 在 16:17 就这样发过一次真实外网 GET，
见 ``evidence/updater/final/INCIDENT-2026-11-05T1617.md``）。所以本模块：

1. ``from urllib.request import urlopen`` **不存在**；唯一出口是 ``open_url()``；
2. ``_OPENER = build_no_proxy_opener()`` = ``build_opener(ProxyHandler({}))``，
   与产品 ``net.py:136-140`` 同口径（显式忽略系统代理）；
3. ``open_url()`` 先做 **URL 主机校验**（只放行 loopback 字面量），非 loopback 在
   建立任何 socket 之前抛 ``EgressUrlRefused('EGRESS-URL-BLOCKED ...')``；
4. ``--selftest`` 开头有三条硬化自检，**任一条会在"退回裸 urlopen + 系统代理"下转红**：
   ``guard-opener``（opener 的 handler 链不得带 proxies / http_open）、
   ``guard-ast``（本文件不得有裸 urlopen 调用或 import）、
   ``guard-url``（非 loopback URL 必须在 opener 之前被拒）。
   变异证明见 ``evidence/updater/r2/server/mutation-proof.log``。

用法（其他席位 import，见 REPORT.md）::

    import sys
    sys.path.insert(0, str(REPO / "tests" / "desktop" / "updater" / "e2e" / "server"))
    from fake_server import FakeUpdater
    srv = FakeUpdater({...fixtures...}, Path(evidence_dir) / "access.jsonl")
    base = srv.start()          # -> "http://127.0.0.1:52341"
    ...                          # 把 constants.LATEST_MANIFEST_URL 指到 f"{base}/<scenario>/latest.json"
    srv.stop()
    srv.requests                # 与 access.jsonl 同内容的 list[dict]

CLI::

    D:\\Python311\\python.exe fake_server.py --selftest        # 六种 mode 真连自证，全过 exit 0
    D:\\Python311\\python.exe fake_server.py --port 0 --fixtures fixtures.json   # 独立进程复用
"""

from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import ipaddress
import json
import socket
import sys
import threading
import time
from datetime import datetime, timezone
from http.client import IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import ProxyHandler, Request, build_opener, getproxies, proxy_bypass

#: 契约 §3 的 mode 全集。``etag`` 只是 ``ok`` 的别名（兼容入口）。
MODES: tuple[str, ...] = ("ok", "etag", "hang", "half", "tamper", "notfound")

#: 真正改变线上字节的 mode；``etag`` 归一化成 ``ok``。
_WIRE_ALIASES = {"etag": "ok"}

#: 契约 §3：hang 模式挂 45 s 再关。
HANG_SECONDS: float = 45.0

#: 单次写 socket 的超时（秒）。不设会让「客户端提前断开」把线程永久钉住。
_SOCKET_TIMEOUT: float = 60.0

_JSON_CT = "application/json; charset=utf-8"
_BIN_CT = "application/octet-stream"

_LOG_FIELDS = (
    "t", "mono", "scenario", "method", "path",
    "status", "bytes", "if_none_match", "user_agent", "remote_port",
)


# --------------------------------------------------------------------- 小工具


def _utc_now_iso() -> str:
    """ISO8601（毫秒精度、UTC，``Z`` 结尾）。"""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _error_body(code: int, detail: str) -> bytes:
    return json.dumps({"error": detail, "code": int(code)}, ensure_ascii=False).encode("utf-8")


def _as_bytes(value: Any) -> bytes:
    """资产值归一化成 bytes：bytes/bytearray 原样，str 按 UTF-8 编码。"""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("utf-8")
    raise TypeError(f"资产必须是 bytes / bytearray / str，收到 {type(value).__name__}")


def _manifest_bytes(fixture: dict) -> bytes:
    """清单响应体：dict → JSON(UTF-8，不转义非 ASCII)；bytes/str 原样。"""
    raw = fixture.get("manifest")
    if raw is None:
        raw = {"version": "0.0.0", "note": "empty manifest fixture"}
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    if isinstance(raw, str):
        return raw.encode("utf-8")
    return json.dumps(raw, ensure_ascii=False).encode("utf-8")


def _etag_of(fixture: dict, scenario: str) -> str:
    value = fixture.get("etag")
    if value is None:
        return '"e1-{}"'.format(scenario)          # 契约默认值，含双引号
    return str(value)


def _tamper_bytes(body: bytes) -> bytes:
    """翻转第 1 个字节（与 0xFF 异或）；空 body 原样返回（长度无从翻转）。"""
    if not body:
        return body
    return bytes([body[0] ^ 0xFF]) + body[1:]


def _effective_mode(fixture: dict, kind: str) -> str:
    raw = fixture.get("asset_mode") if kind == "asset" else None
    if raw is None:
        raw = fixture.get("mode", "ok")
    mode = str(raw).strip().lower()
    return _WIRE_ALIASES.get(mode, mode)


def default_log_path() -> Path:
    """``--selftest`` 的默认落盘位置：``<repo>/evidence/updater/r2/server/access.jsonl``。"""
    script = Path(__file__).resolve()
    try:
        repo = script.parents[5]      # server -> e2e -> updater -> desktop -> tests -> repo
    except IndexError:                # pragma: no cover - 文件被搬走时的兜底
        return Path.cwd() / "access.jsonl"
    return repo / "evidence" / "updater" / "r2" / "server" / "access.jsonl"


# ------------------------------------------------- 零外联请求出口（硬化的唯一出口）


#: URL 里允许出现的主机字面量（与 ``egress_guard.EgressGuard`` 的默认 allowed 同口径）。
#: 只有这些主机才会被 ``open_url`` 放进 opener；其余在**建立任何 socket 之前**就被拒。
LOOPBACK_URL_HOSTS: frozenset[str] = frozenset(
    {
        "127.0.0.1",
        "::1",
        "localhost",
        "0.0.0.0",
        "::",
        "0:0:0:0:0:0:0:1",
        "ip6-localhost",
        "ip6-loopback",
    }
)

#: IPv4 loopback 整段（127.0.0.0/8）都算本地，与 guard 的判定保持一致。
_LOOPBACK_NET = ipaddress.ip_network("127.0.0.0/8")


class EgressUrlRefused(RuntimeError):
    """URL 主机不是 loopback：在 opener 之前拒绝（错误码 ``EGRESS-URL-BLOCKED``）。"""


def _is_loopback_host(host: Any) -> bool:
    """主机是否本地。空主机（相对 URL）视为本地——它不会产生任何外联。"""
    if not host:
        return True
    text = str(host).strip().lower()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    if "%" in text:                                   # link-local 的 scope id
        text = text.split("%", 1)[0]
    if text in LOOPBACK_URL_HOSTS:
        return True
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_unspecified:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None and mapped.is_loopback:
        return True
    try:
        return ip.version == 4 and ip in _LOOPBACK_NET
    except TypeError:                                 # pragma: no cover - 防御
        return False


def require_loopback_url(target: Any) -> str:
    """校验 URL（str 或 ``Request``）的主机是 loopback；否则抛 ``EgressUrlRefused``。"""
    url = target.full_url if isinstance(target, Request) else str(target)
    host = urlsplit(url).hostname
    if not _is_loopback_host(host):
        raise EgressUrlRefused(
            f"EGRESS-URL-BLOCKED: {url} 的主机 {host!r} 不是 loopback"
            "（本战役所有 HTTP 只允许 127.0.0.1 / ::1 / localhost）"
        )
    return url


def build_no_proxy_opener() -> Any:
    """构造**显式忽略系统代理**的 opener（与产品 ``net.py:136-140`` 同口径）。

    why：本机 ``ProxyEnable=1`` / ``ProxyServer=127.0.0.1:7897``，裸
    ``urllib.request.urlopen`` 会把外网请求转发给本地代理——从 socket 层看仍是
    loopback，``EgressGuard`` 无从拦截。``ProxyHandler({})`` 让 handler 链里
    **不注册任何 ``http_open``/``https_open``**，于是根本不存在"走代理"这条路径。
    """
    return build_opener(ProxyHandler({}))


#: 模块级唯一 HTTP 出口。``--selftest`` 的 ``guard-url`` 会临时把它换成只记录、不建
#: socket 的桩，用来在**零流量**前提下证明「非 loopback URL 在 opener 之前就被拒」。
_OPENER = build_no_proxy_opener()


def open_url(target: Any, timeout: float = 5.0) -> Any:
    """唯一的 HTTP 出口：先做 URL 主机校验，再用无代理 opener 打开。

    ``target`` 可以是 URL 字符串或 ``urllib.request.Request``。返回值是 urllib 的
    响应对象（``with`` 可用）。
    """
    require_loopback_url(target)
    if isinstance(target, Request):
        return _OPENER.open(target, timeout=timeout)
    return _OPENER.open(str(target), timeout=timeout)


# --------------------------------------------------------------- HTTP 管线


def _write_headers(handler: BaseHTTPRequestHandler, status: int, headers: dict[str, str]) -> None:
    handler.send_response(int(status))
    for key, value in headers.items():
        handler.send_header(str(key), str(value))
    handler.end_headers()


def _write_full(
    handler: BaseHTTPRequestHandler,
    status: int,
    body: bytes,
    content_type: str,
    extra_headers: dict[str, str] | None = None,
) -> bool:
    """带 Content-Length 的一次完整响应。返回是否真的写出去了。"""
    headers = {"Content-Type": content_type}
    headers.update(extra_headers or {})
    headers["Content-Length"] = str(len(body))
    try:
        _write_headers(handler, status, headers)
    except OSError:
        handler.close_connection = True
        return False
    try:
        handler.wfile.write(body)
        handler.wfile.flush()
        return True
    except OSError:
        handler.close_connection = True
        return False


def _stop_writing(handler: BaseHTTPRequestHandler) -> None:
    """半包 / 挂起后的「硬关」：只 shutdown(SHUT_WR)，让客户端拿到干净的 EOF(FIN)。

    不用 ``RST``：RST 会让客户端抛 ``ConnectionResetError``，而契约 §3 要求
    ``half`` 触发 ``IncompleteRead``——只有 QUIC 意义上的「干净半包 EOF」才能稳定
    得到 ``IncompleteRead``。真正的 fd 关闭交给 socketserver 的 ``shutdown_request``。
    """
    try:
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    try:
        handler.connection.shutdown(socket.SHUT_WR)
    except OSError:
        pass


class _FakeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"          # 契约 §3
    server_version = "FakeUpdater/1.0"
    sys_version = ""

    def setup(self) -> None:               # noqa: D401 - 标准库钩子
        super().setup()
        try:
            self.connection.settimeout(_SOCKET_TIMEOUT)
        except OSError:
            pass

    def log_message(self, fmt: str, *args: Any) -> None:   # noqa: A003 - 标准库签名
        """静音标准库访问日志：本服务器自己写 JSONL，stdout 留给证据。"""

    def do_GET(self) -> None:  # noqa: N802 - 标准库签名
        owner = getattr(self.server, "owner", None)
        if owner is None:                                   # pragma: no cover - 防御
            self.send_error(500, "fake server not bound")
            return
        owner._serve(self)               # noqa: SLF001 - 内部协作


class _FakeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True               # 契约 §3：挂起线程不得阻塞进程退出
    allow_reuse_address = True          # 契约 §3
    block_on_close = False              # 双保险：server_close() 不等 daemon 线程

    def handle_error(self, request: Any, client_address: Any) -> None:   # noqa: ANN401
        """客户端提前断开（half / hang）是**预期路径**，不要往 stderr 打 traceback。"""


# ------------------------------------------------------------------ 主体


class FakeUpdater:
    """契约 §3 的假更新服务器。

    参数
    ----
    fixtures:
        ``{scenario: {"mode": ..., "manifest": ..., "assets": {name: bytes}, ...}}``。
        构造时就校验 mode 取值，写错立刻 ``ValueError``（避免后面收到莫名的 404）。
    log_path:
        请求日志 JSONL 落盘位置。``start()`` 时以 ``w`` 打开（**每次 start 清空**）。
    """

    def __init__(self, fixtures: dict[str, dict], log_path: Path) -> None:
        if not isinstance(fixtures, dict):
            raise TypeError(f"fixtures 必须是 dict[str, dict]，收到 {type(fixtures).__name__}")
        self._fixtures: dict[str, dict] = {}
        for name, fixture in fixtures.items():
            if not isinstance(fixture, dict):
                raise TypeError(
                    f"fixtures[{name!r}] 必须是 dict，收到 {type(fixture).__name__}"
                )
            for key in ("mode", "asset_mode"):
                if fixture.get(key) is None:
                    continue
                value = str(fixture[key]).strip().lower()
                if value not in MODES:
                    raise ValueError(
                        f"fixtures[{name!r}][{key!r}] = {fixture[key]!r} 不是合法 mode；"
                        f"合法值：{', '.join(MODES)}"
                    )
            self._fixtures[str(name)] = dict(fixture)
        self._log_path = Path(log_path)
        self._log_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._requests: list[dict] = []
        self._log_fh = None
        self._httpd: _FakeHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._base = ""
        self._bind_port = 0            # 仅供 CLI ``--port`` 使用；类契约仍是 ("127.0.0.1", 0)

    # -- 契约属性 -----------------------------------------------------

    @property
    def base(self) -> str:
        """``http://127.0.0.1:<port>``；未 start 时为 ``""``，stop 后保留最后的值。"""
        return self._base

    @property
    def requests(self) -> list[dict]:
        """与 ``log_path`` 的 JSONL 同内容（浅拷贝，调用方随便改）。"""
        with self._log_lock:
            return [dict(record) for record in self._requests]

    @property
    def log_path(self) -> Path:
        """请求日志路径（非契约项，证据脚本用）。"""
        return self._log_path

    @property
    def bind_address(self) -> tuple[str, int] | None:
        """监听套接字地址（非契约项，零外联自证用）；未 start 时 ``None``。

        永远是 ``("127.0.0.1", <port>)``——服务器在构造时只 bind 这个地址，
        所以它**物理上**不可能承载外网流量。
        """
        httpd = self._httpd
        if httpd is None:
            return None
        host, port = httpd.socket.getsockname()[:2]
        return (str(host), int(port))

    # -- 生命周期 -----------------------------------------------------

    def start(self) -> str:
        """起服务并返回 base。重复调用幂等（返回同一 base，不重复 bind）。"""
        with self._lifecycle_lock:
            if self._httpd is not None:
                return self._base
            httpd = _FakeHTTPServer(("127.0.0.1", int(self._bind_port)), _FakeHandler)
            httpd.owner = self                      # type: ignore[attr-defined]
            try:
                self._log_path.parent.mkdir(parents=True, exist_ok=True)
                self._log_fh = open(self._log_path, "w", encoding="utf-8", newline="\n")
            except OSError:
                httpd.server_close()
                raise
            host, port = httpd.socket.getsockname()[:2]
            self._base = f"http://{host}:{int(port)}"
            thread = threading.Thread(
                target=httpd.serve_forever,
                kwargs={"poll_interval": 0.05},
                name=f"fake-updater-{int(port)}",
                daemon=True,
            )
            self._httpd = httpd
            self._thread = thread
            thread.start()
            return self._base

    def stop(self) -> None:
        """停服务；幂等。挂起中的 hang 线程是 daemon，不会拖住这里（实测 < 0.2 s）。"""
        with self._lifecycle_lock:
            httpd = self._httpd
            thread = self._thread
            self._httpd = None
            self._thread = None
        if httpd is not None:
            try:
                httpd.shutdown()
            except Exception:                       # noqa: BLE001 - 停服务不抛出
                pass
            try:
                httpd.server_close()
            except Exception:                       # noqa: BLE001
                pass
        if thread is not None:
            thread.join(timeout=5.0)
        with self._log_lock:
            if self._log_fh is not None:
                try:
                    self._log_fh.close()
                except OSError:
                    pass
                self._log_fh = None

    def __enter__(self) -> "FakeUpdater":
        self.start()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.stop()

    # -- 路由 ---------------------------------------------------------

    def _route(self, path: str) -> tuple[str, str, str]:
        """返回 ``(scenario, kind, asset_name)``；kind ∈ manifest/asset/unknown/bad_path。"""
        parts = [part for part in path.split("/") if part]
        if not parts:
            return ("", "bad_path", "")
        scenario = parts[0]
        if scenario not in self._fixtures:
            return (scenario, "unknown", "")
        if len(parts) == 2 and parts[1] == "latest.json":
            return (scenario, "manifest", "")
        if len(parts) >= 3 and parts[1] == "assets":
            return (scenario, "asset", "/".join(parts[2:]))
        return (scenario, "bad_path", "")

    # -- 记账 ---------------------------------------------------------

    def _record(
        self,
        *,
        mono: float,
        scenario: str,
        method: str,
        path: str,
        status: int,
        nbytes: int,
        if_none_match: str,
        user_agent: str,
        remote_port: int,
    ) -> dict:
        entry = {
            "t": _utc_now_iso(),
            "mono": float(mono),
            "scenario": scenario,
            "method": method,
            "path": path,
            "status": int(status),
            "bytes": int(nbytes),
            "if_none_match": if_none_match or "",
            "user_agent": user_agent or "",
            "remote_port": int(remote_port or 0),
        }
        with self._log_lock:
            self._requests.append(entry)
            if self._log_fh is not None:
                try:
                    self._log_fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
                    self._log_fh.flush()
                except (OSError, ValueError):       # 日志写失败不该影响被测行为
                    pass
        return entry

    # -- 请求处理 -----------------------------------------------------

    def _serve(self, handler: BaseHTTPRequestHandler) -> None:
        mono = time.monotonic()
        method = getattr(handler, "command", "") or ""
        raw_path = getattr(handler, "path", "") or ""
        client = getattr(handler, "client_address", None)
        remote_port = int(client[1]) if client and len(client) > 1 else 0
        if_none_match = (handler.headers.get("If-None-Match", "") or "").strip()
        user_agent = handler.headers.get("User-Agent", "") or ""
        scenario, kind, asset_name = self._route(unquote(urlsplit(raw_path).path))

        def emit(status: int, nbytes: int) -> None:
            self._record(
                mono=mono,
                scenario=scenario,
                method=method,
                path=raw_path,
                status=status,
                nbytes=nbytes,
                if_none_match=if_none_match,
                user_agent=user_agent,
                remote_port=remote_port,
            )

        # 未知 scenario / 形状不对 → 404（契约 §3）
        if kind in ("unknown", "bad_path"):
            body = _error_body(404, f"unknown path: {raw_path}")
            sent = _write_full(handler, 404, body, _JSON_CT)
            emit(404, len(body) if sent else 0)
            return

        fixture = self._fixtures[scenario]
        if kind == "manifest":
            body = _manifest_bytes(fixture)
            content_type = _JSON_CT
            etag = _etag_of(fixture, scenario)
            is_manifest = True
        else:
            assets = fixture.get("assets") or {}
            if not isinstance(assets, dict) or asset_name not in assets:
                detail = _error_body(404, f"unknown asset: {asset_name}")
                sent = _write_full(handler, 404, detail, _JSON_CT)
                emit(404, len(detail) if sent else 0)
                return
            try:
                body = _as_bytes(assets[asset_name])
            except TypeError as error:
                body = _error_body(500, str(error))
                sent = _write_full(handler, 500, body, _JSON_CT)
                emit(500, len(body) if sent else 0)
                return
            content_type = _BIN_CT
            etag = ""
            is_manifest = False

        mode = _effective_mode(fixture, kind)

        # 契约 §3：notfound = 清单与资产都 404
        if mode == "notfound":
            body_404 = _error_body(404, f"scenario {scenario!r} is in notfound mode")
            sent = _write_full(handler, 404, body_404, _JSON_CT)
            emit(404, len(body_404) if sent else 0)
            return

        # 契约 §3：hang = 接受连接后不发任何字节，挂 45 s 再关
        if mode == "hang":
            # 先记账再挂起：其他席位在客户端 20 s 超时后仍能在日志里看到这次请求。
            emit(0, 0)
            time.sleep(HANG_SECONDS)
            handler.close_connection = True
            _stop_writing(handler)
            return

        # 契约 §3：half = Content-Length 对，但只发 N//2 字节然后硬关
        if mode == "half":
            total = len(body)
            half = total // 2
            try:
                _write_headers(
                    handler,
                    200,
                    {"Content-Type": content_type, "Content-Length": str(total)},
                )
            except OSError:
                handler.close_connection = True
                emit(200, 0)
                return
            sent = 0
            if half:
                try:
                    handler.wfile.write(body[:half])
                    handler.wfile.flush()
                    sent = half
                except OSError:
                    pass
            handler.close_connection = True
            _stop_writing(handler)
            emit(200, sent)
            return

        # 契约 §3：tamper = 发满 N 字节但第 1 个字节翻转
        if mode == "tamper":
            tampered = _tamper_bytes(body)
            extra = {"ETag": etag} if is_manifest else None
            sent = _write_full(handler, 200, tampered, content_type, extra)
            emit(200, len(tampered) if sent else 0)
            return

        # mode == "ok"（含 etag 别名）
        if is_manifest and if_none_match and if_none_match == etag:
            try:
                _write_headers(handler, 304, {"ETag": etag})
            except OSError:
                handler.close_connection = True
            handler.close_connection = True
            emit(304, 0)
            return

        extra = {"ETag": etag} if is_manifest else None
        sent = _write_full(handler, 200, body, content_type, extra)
        emit(200, len(body) if sent else 0)


# ------------------------------------------------------------ fixtures 加载


def load_fixtures_json(path: Path) -> dict[str, dict]:
    """独立进程模式的 fixtures JSON 加载器。

    形状::

        {"normal": {"mode": "ok",
                    "manifest": {"version": "0.0.2", "channel": "stable"},
                    "assets": {"pkg.zip": "文本" | {"text": "文本"} | {"b64": "UEsDBA..."}}}}
    """
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{path}: 顶层必须是 {{scenario: fixture}} 对象")
    fixtures: dict[str, dict] = {}
    for scenario, fixture in raw.items():
        if not isinstance(fixture, dict):
            raise ValueError(f"{path}: fixtures[{scenario!r}] 必须是对象")
        fixture = dict(fixture)
        assets = fixture.get("assets") or {}
        if not isinstance(assets, dict):
            raise ValueError(f"{path}: fixtures[{scenario!r}].assets 必须是对象")
        converted: dict[str, bytes] = {}
        for name, value in assets.items():
            if isinstance(value, str):
                converted[str(name)] = value.encode("utf-8")
            elif isinstance(value, dict) and "b64" in value:
                converted[str(name)] = base64.b64decode(str(value["b64"]))
            elif isinstance(value, dict) and "text" in value:
                converted[str(name)] = str(value["text"]).encode("utf-8")
            elif isinstance(value, (bytes, bytearray)):
                converted[str(name)] = bytes(value)
            else:
                raise ValueError(
                    f"{path}: fixtures[{scenario!r}].assets[{name!r}] 无法识别，"
                    "用 str / {'text': ...} / {'b64': ...}"
                )
        fixture["assets"] = converted
        fixtures[str(scenario)] = fixture
    return fixtures


# ---------------------------------------------------------------- 自检


def _selftest_fixtures() -> tuple[bytes, dict]:
    """自检用的确定性夹具（内容固定，便于断言字节数 / sha256）。"""
    payload = b"PK\x03\x04" + bytes(range(256)) * 4
    manifest = {
        "version": "0.0.2",
        "channel": "stable",
        "notes": "fake_server.py --selftest fixture",
        "assets": [
            {
                "name": "payload.zip",
                "size": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        ],
    }
    assets = {"payload.zip": payload}
    fixtures = {}
    for scenario, mode in (
        ("ok", "ok"),
        ("etag", "ok"),          # 304 走 ok 路径，靠 If-None-Match 触发
        ("hang", "hang"),
        ("half", "half"),
        ("tamper", "tamper"),
        ("notfound", "notfound"),
    ):
        fixtures[scenario] = {"mode": mode, "manifest": manifest, "assets": dict(assets)}
    # asset_mode 单独覆盖：清单正常、资产走 half（契约 §3 的可选字段）
    fixtures["assetmode"] = {
        "mode": "ok",
        "asset_mode": "half",
        "manifest": manifest,
        "assets": dict(assets),
    }
    return payload, fixtures


# ------------------------------------------------- 硬化自检（零外联护栏本身）


class _StubCalled(RuntimeError):
    """``guard-url`` 的桩被调用（= URL 守卫没拦住）。"""


class _StubOpener:
    """只记录、**绝不建立 socket** 的桩 opener：用来在零流量前提下取证 URL 守卫。"""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def open(self, target: Any, *args: Any, **kwargs: Any) -> Any:   # noqa: ANN401
        url = getattr(target, "full_url", target)
        self.calls.append(str(url))
        raise _StubCalled(str(url))


def _proxy_handlers_of(opener: Any) -> list[str]:
    """列出 opener 里所有**会启用代理**的痕迹（proxies 映射或 ProxyHandler 的 ``*_open``）。

    注意：``HTTPHandler.http_open`` / ``HTTPSHandler.https_open`` 是**直连**处理器，
    不是代理痕迹——只有 ``ProxyHandler``（``hasattr(h, 'proxy_open')``）在 proxies
    非空时才会注册 ``http_open`` 等入口把请求转发出去。
    """
    offenders: list[str] = []
    for handler in getattr(opener, "handlers", []):
        proxies = getattr(handler, "proxies", None)
        if proxies:
            try:
                shown = dict(proxies)
            except (TypeError, ValueError):          # pragma: no cover - 防御
                shown = proxies
            offenders.append(f"{type(handler).__name__}.proxies={shown!r}")
        if not hasattr(handler, "proxy_open"):
            continue                                  # 非代理处理器：直连，不算
        for method in ("http_open", "https_open", "ftp_open"):
            if getattr(handler, method, None) is not None:
                offenders.append(f"{type(handler).__name__}.{method} 已注册（=会走代理）")
    return offenders


def _check_guard_opener() -> str:
    """判据：请求出口的 opener **不得**携带任何会启用系统代理的 handler。

    这是本轮最关键的硬化判据。把 ``build_no_proxy_opener()`` 退回 ``build_opener()``
    （= 裸 ``urlopen`` 的默认 handler 链）时，在本机（``getproxies()`` 为
    ``http/https/ftp = 127.0.0.1:7897``）会立刻转红。

    为什么不能改用"打一发 loopback 请求看走没走代理"：Windows 的 ProxyOverride 含
    ``127.*``，``proxy_bypass('127.0.0.1:<port>') is True`` —— 即使配了代理，loopback
    请求也会被 bypass，行为探针对这个缺陷是**瞎的**；只有检查 handler 链才看得见。
    """
    system_proxies = getproxies()
    offenders = _proxy_handlers_of(_OPENER)
    if offenders:
        raise AssertionError(
            "出口 opener 仍会走系统代理 " + "；".join(offenders) + "（= 裸 urlopen 同款缺陷）"
        )
    return (
        f"handlers={len(_OPENER.handlers)} 个，无任何 proxies / http_open 入口；"
        f"宿主机系统代理={system_proxies or '无'}（被 ProxyHandler({{}}) 显式忽略）；"
        f"proxy_bypass('127.0.0.1:9')={bool(proxy_bypass('127.0.0.1:9'))}、"
        f"proxy_bypass('example.com')={bool(proxy_bypass('example.com'))}"
    )


def _check_proxy_detector_sensitive() -> str:
    """证明上一条判据不是"无论怎样都 PASS"：裸 ``build_opener()`` 必须被同一检测器看见。

    只构造 handler 链（读注册表/环境变量），**不发请求、不建 socket**。
    """
    system_proxies = getproxies()
    if not system_proxies:
        return "宿主机无系统代理：灵敏度在本机无法验证（主判据 guard-opener 仍然有效）"
    leaked = _proxy_handlers_of(build_opener())
    if not leaked:
        raise AssertionError(
            "检测器对裸 build_opener() 也报「无代理」→ 检测器失效，guard-opener 不可信"
        )
    return f"裸 build_opener() 被检出代理 {leaked}；本模块 _OPENER 未被检出"


def _is_urlopen_ref(node: ast.AST) -> bool:
    """``urlopen(...)`` / ``urllib.request.urlopen(...)`` 形式的调用引用。"""
    if isinstance(node, ast.Name) and node.id == "urlopen":
        return True
    return isinstance(node, ast.Attribute) and node.attr == "urlopen"


def _check_no_bare_urlopen() -> str:
    """静态判据：本文件里**不得**存在任何裸 ``urlopen`` 调用或 import。

    为什么需要它：``guard-opener`` 只看 ``_OPENER``，存在盲区——有人把 ``open_url``
    的实现改回裸 ``urlopen(...)`` 时 ``_OPENER`` 仍然干净，运行期检查会**假绿**。
    AST 判据盯的是**调用点**，这种变异必红（M2，见 mutation-proof.log）。
    """
    source = Path(__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    calls = [
        f"line {node.lineno}"
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and _is_urlopen_ref(node.func)
    ]
    imports = [
        f"line {node.lineno} from urllib.request import urlopen"
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom)
        and node.module == "urllib.request"
        for alias in node.names
        if alias.name == "urlopen"
    ]
    problems = calls + imports
    if problems:
        raise AssertionError(
            f"本文件仍有裸 urlopen 调用/import：{problems}（{Path(__file__).name}）"
        )
    return (
        f"AST 扫描 {len(source.splitlines())} 行：urlopen 调用 0 处、"
        f"from urllib.request import urlopen 0 处；唯一出口=open_url()"
    )


def _check_url_guard() -> str:
    """判据：非 loopback URL 在 opener 之前被拒；loopback URL 仍能到达 opener。

    取证方式：把 ``_OPENER`` 临时换成 ``_StubOpener``（只记录、不建 socket）。这样
    **即使 URL 守卫被删掉也不会产生任何真实流量**（桩立刻抛 ``_StubCalled``），
    同时让"守卫缺失"立刻转红（M3）。
    """
    global _OPENER
    original = _OPENER
    stub = _StubOpener()
    _OPENER = stub
    externals = (
        "http://example.com/latest.json",
        "https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases",
        "https://objects.githubusercontent.com/assets/pkg.zip",
        "http://203.0.113.9:8080/latest.json",
    )
    try:
        for url in externals:
            try:
                open_url(url, timeout=1)
            except EgressUrlRefused as error:
                assert "EGRESS-URL-BLOCKED" in str(error), f"文案缺少 EGRESS-URL-BLOCKED：{error}"
            else:                                   # pragma: no cover - 守卫被删时到这里
                raise AssertionError(f"{url} 没有被 URL 守卫拒绝（已到 opener）")
        try:
            open_url("http://127.0.0.1:9/latest.json", timeout=1)
        except _StubCalled:
            pass                                    # 预期：loopback 通过守卫并到达桩
        else:                                       # pragma: no cover - 守卫误杀时到这里
            raise AssertionError("loopback URL 竟没到达 opener（URL 守卫误杀）")
    finally:
        _OPENER = original
    opened_external = [call for call in stub.calls if not _is_loopback_host(urlsplit(call).hostname)]
    if opened_external:                             # pragma: no cover - 与上面重复兜底
        raise AssertionError(f"非 loopback URL 到达了 opener：{opened_external}")
    return (
        f"非 loopback {len(externals)} 条 URL 全部在 opener 之前被拒"
        f"（EGRESS-URL-BLOCKED，opener 实际打开外网 {len(opened_external)} 次）；"
        f"loopback 1 条到达桩"
    )


def _check_guard_consistency() -> str:
    """本文件的 URL 分类必须与 ``egress_guard._is_local_host`` 判定一致。

    两个文件各自冻结、各自被其他席位 import；判定漂移会让"守卫说本地、
    opener 说外网"这种自相矛盾悄悄发生。
    """
    from egress_guard import _is_local_host        # 同目录，其他席位也用同一份

    hosts = (
        "127.0.0.1", "127.5.6.7", "::1", "localhost", "0.0.0.0", "::",
        "example.com", "github.com", "objects.githubusercontent.com",
        "203.0.113.9", "198.51.100.9",
    )
    disagree = [
        host
        for host in hosts
        if _is_loopback_host(host) != _is_local_host(host, (), ())
    ]
    if disagree:
        raise AssertionError(f"fake_server 与 egress_guard 判定不一致：{disagree}")
    return f"{len(hosts)} 个主机的判定与 egress_guard._is_local_host 完全一致"


def _check_ok(base: str, payload: bytes, manifest: dict) -> str:
    with open_url(f"{base}/ok/latest.json", timeout=5) as response:      # noqa: S310 - loopback
        status = int(response.status)
        body = response.read()
        etag = response.headers.get("ETag", "")
        content_type = response.headers.get("Content-Type", "")
    expected = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
    assert status == 200, f"status={status} != 200"
    assert etag == '"e1-ok"', f'ETag={etag!r} != \'"e1-ok"\''
    assert body == expected, f"清单字节不一致：got {len(body)}B / want {len(expected)}B"
    assert "application/json" in content_type, f"Content-Type={content_type!r}"
    with open_url(f"{base}/ok/assets/payload.zip", timeout=5) as response:   # noqa: S310
        asset_status = int(response.status)
        asset_body = response.read()
        asset_len = response.headers.get("Content-Length", "")
    assert asset_status == 200, f"asset status={asset_status} != 200"
    assert asset_body == payload, f"资产字节不一致：got {len(asset_body)}B"
    assert int(asset_len) == len(payload), f"Content-Length={asset_len} != {len(payload)}"
    return (
        f"manifest 200 bytes={len(body)} etag={etag}; "
        f"asset 200 bytes={len(asset_body)} content-length={asset_len}"
    )


def _check_etag(base: str) -> str:
    """304 的线上语义。

    注意（实测、也是标准库语义）：urllib 的 ``HTTPErrorProcessor`` 对 304 会抛
    ``HTTPError(304)`` 而不是返回响应对象（非 2xx 全算错误）——本模块的 ``open_url``
    走的是同一套 processor，所以这里按 ``HTTPError.code == 304`` 断言。
    服务器侧的语义是对的（304 + 无 body）；并检查它**没有** body / 没有 Content-Length。
    更新器的 ``net.UrllibTransport.get`` 会把这种 HTTPError 转成
    ``Response(status=304, body=b"")``。
    """
    with open_url(f"{base}/etag/latest.json", timeout=5) as response:    # noqa: S310
        first_status = int(response.status)
        first_body = response.read()
        etag = response.headers.get("ETag", "")
        assert first_status == 200, f"first status={first_status} != 200"
        assert first_body, "first body 不应为空"
        assert etag, "first 响应没有 ETag"

    request = Request(f"{base}/etag/latest.json", headers={"If-None-Match": etag})
    second_status = 0
    second_body = b""
    second_etag = ""
    second_length = "缺失"
    try:
        with open_url(request, timeout=5) as response:                    # noqa: S310
            second_status = int(response.status)
            second_body = response.read()
            second_etag = response.headers.get("ETag", "")
    except HTTPError as error:
        second_status = int(error.code)
        second_etag = (error.headers or {}).get("ETag", "")
        second_length = (error.headers or {}).get("Content-Length", "缺失")
        try:
            second_body = error.read() or b""
        except Exception:                     # noqa: BLE001 - 304 无 body，读不出来是预期
            second_body = b""
        error.close()

    assert second_status == 304, f"second status={second_status} != 304"
    assert second_body == b"", f"304 不应有 body，收到 {len(second_body)}B"
    assert second_etag == etag, f"304 ETag={second_etag!r} != {etag!r}"
    assert second_length == "缺失", f"304 不该带 Content-Length，收到 {second_length!r}"
    return (
        f"first=200(etag={etag}) second=304 无 body 无 Content-Length "
        f"(urllib 的 HTTPErrorProcessor 表现为 HTTPError(304)，net.UrllibTransport.get 会转成 Response(status=304))"
    )


def _check_hang(base: str) -> str:
    started = time.monotonic()
    failure = ""
    caught = ""
    try:
        with open_url(f"{base}/hang/latest.json", timeout=2) as response:  # noqa: S310
            response.read()
    except (TimeoutError, socket.timeout) as error:
        caught = f"{type(error).__name__}: {error}"
    except URLError as error:
        reason = getattr(error, "reason", error)
        if isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason).lower():
            caught = f"URLError(reason={type(reason).__name__}: {reason})"
        else:
            failure = f"URLError 但不是超时：{reason!r}"
    else:
        failure = "请求竟然成功了（hang 模式没有挂起）"
    elapsed = time.monotonic() - started
    assert not failure, failure
    assert caught, "既没有成功也没有异常？"
    assert elapsed < 10.0, f"超时耗时 {elapsed:.2f}s，超出预期（应≈timeout=2）"
    return f"{caught}; 客户端 {elapsed:.2f}s 放弃（服务端仍挂 {HANG_SECONDS:.0f}s，无字节发出）"


def _check_half(base: str, payload: bytes) -> str:
    failure = ""
    caught = ""
    try:
        with open_url(f"{base}/half/assets/payload.zip", timeout=5) as response:  # noqa: S310
            body = response.read()
        failure = f"半包竟然读完了：{len(body)}B"
    except IncompleteRead as error:
        partial = error.partial if isinstance(error.partial, bytes) else b""
        caught = (
            f"IncompleteRead partial={len(partial)}B "
            f"missing={getattr(error, 'expected', None)}B of {len(payload)}B"
        )
        assert len(partial) == len(payload) // 2, (
            f"半包长度 {len(partial)}B != N//2={len(payload) // 2}B"
        )
    except Exception as error:                       # noqa: BLE001 - 如实暴露真实异常类型
        failure = f"实际异常 {type(error).__name__}: {error}"
    assert not failure, failure
    return caught + "（Content-Length 声称满长、实际只发 N//2）"


def _check_tamper(base: str, payload: bytes) -> str:
    with open_url(f"{base}/tamper/assets/payload.zip", timeout=5) as response:  # noqa: S310
        status = int(response.status)
        body = response.read()
    assert status == 200, f"status={status} != 200"
    assert len(body) == len(payload), f"长度变了：{len(body)} != {len(payload)}"
    assert body != payload, "字节居然和源一致（篡改没生效）"
    source_sha = hashlib.sha256(payload).hexdigest()
    tampered_sha = hashlib.sha256(body).hexdigest()
    assert source_sha != tampered_sha, "sha256 竟然相同"
    diff = body[0] ^ payload[0]
    assert diff != 0, "第 1 个字节没变"
    return (
        f"status=200 bytes={len(body)}（同长）字节不同 "
        f"sha256 {source_sha[:12]}≠{tampered_sha[:12]} byte0_xor=0x{diff:02x}"
    )


def _check_notfound(base: str) -> str:
    codes: list[int] = []
    for suffix in ("notfound/latest.json", "notfound/assets/payload.zip"):
        try:
            with open_url(f"{base}/{suffix}", timeout=5) as response:      # noqa: S310
                response.read()
            codes.append(int(response.status))
        except HTTPError as error:
            codes.append(int(error.code))
            error.close()
    assert codes == [404, 404], f"期望 [404, 404]，实际 {codes}"
    return "manifest=404 asset=404"


def _check_asset_mode(base: str, payload: bytes) -> str:
    """``asset_mode`` 只覆盖资产侧：清单 200 正常、资产走 half（契约 §3 可选字段）。"""
    with open_url(f"{base}/assetmode/latest.json", timeout=5) as response:   # noqa: S310
        manifest_status = int(response.status)
        manifest_body = response.read()
    assert manifest_status == 200, f"清单 status={manifest_status} != 200"
    assert manifest_body, "清单不应为空（asset_mode 不该影响清单）"
    failure = ""
    caught = ""
    try:
        with open_url(f"{base}/assetmode/assets/payload.zip", timeout=5) as response:  # noqa: S310
            body = response.read()
        failure = f"asset_mode=half 没生效，资产读完了 {len(body)}B"
    except IncompleteRead as error:
        partial = error.partial if isinstance(error.partial, bytes) else b""
        caught = f"IncompleteRead partial={len(partial)}B of {len(payload)}B"
        assert len(partial) == len(payload) // 2, f"partial={len(partial)}B != N//2"
    except Exception as error:                   # noqa: BLE001
        failure = f"实际异常 {type(error).__name__}: {error}"
    assert not failure, failure
    return f"manifest 200 bytes={len(manifest_body)}（正常）; asset 走 half → {caught}"


def _check_log_schema(log_path: Path, requests: Iterable[dict]) -> str:
    records = list(requests)
    assert len(records) >= 9, f"请求数 {len(records)} < 9（六个 mode 至少 9 次请求）"
    for record in records:
        missing = [field for field in _LOG_FIELDS if field not in record]
        assert not missing, f"JSONL 缺字段 {missing}：{record}"
        assert isinstance(record["status"], int), f"status 不是 int：{record}"
        assert isinstance(record["bytes"], int), f"bytes 不是 int：{record}"
        assert isinstance(record["mono"], float), f"mono 不是 float：{record}"
        assert isinstance(record["remote_port"], int), f"remote_port 不是 int：{record}"
    lines = [
        line for line in Path(log_path).read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    assert len(lines) == len(records), f"JSONL 行数 {len(lines)} != 内存条数 {len(records)}"
    for line in lines:
        json.loads(line)
    assert any(record["status"] == 304 for record in records), "日志里没有 304 记录"
    assert sum(1 for record in records if record["status"] == 404) == 2, "404 记录数不是 2"
    assert any(record["status"] == 0 for record in records), "日志里没有 hang（status=0）记录"
    assert any(record["if_none_match"] for record in records), "日志里没有 if_none_match 记录"
    return f"records={len(records)} fields={len(_LOG_FIELDS)} jsonl_lines={len(lines)}"


def _check_bind_loopback(server: "FakeUpdater") -> str:
    """判据：监听套接字字面量就是 ``127.0.0.1``（零外联的物理前提）。"""
    address = server.bind_address
    assert address is not None, "服务器未启动，拿不到监听地址"
    assert address[0] == "127.0.0.1", f"监听地址 {address!r} 不是 127.0.0.1"
    assert address[1] > 0, f"端口 {address[1]} 非法"
    return f"监听 {address[0]}:{address[1]}（只绑 127.0.0.1，物理上不具备外网可达性）"


def run_selftest(log_path: Path, stream: Any = None) -> int:
    """六种 wire mode 各真连一遍 + 硬化自检；逐条 ``SELFTEST <id> PASS|FAIL <detail>``。"""
    out = stream or sys.stdout
    payload, fixtures = _selftest_fixtures()
    manifest = fixtures["ok"]["manifest"]
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    checks: list[tuple[str, Any]] = [
        # 先证明"出口"可信（代理 / 裸 urlopen / URL 主机），再谈六种 mode 的线上语义。
        ("guard-opener", lambda base: _check_guard_opener()),
        ("guard-detector", lambda base: _check_proxy_detector_sensitive()),
        ("guard-ast", lambda base: _check_no_bare_urlopen()),
        ("guard-url", lambda base: _check_url_guard()),
        ("guard-consistency", lambda base: _check_guard_consistency()),
        # 契约 §3 的六种 wire mode
        ("ok", lambda base: _check_ok(base, payload, manifest)),
        ("etag", _check_etag),
        ("hang", _check_hang),
        ("half", lambda base: _check_half(base, payload)),
        ("tamper", lambda base: _check_tamper(base, payload)),
        ("notfound", _check_notfound),
        ("asset_mode", lambda base: _check_asset_mode(base, payload)),
    ]

    results: list[tuple[str, bool, str]] = []
    lines: list[str] = []
    system_proxies = getproxies()
    lines.append(f"# fake_server.py --selftest  {_utc_now_iso()}")
    lines.append(f"# python={sys.version.split()[0]} log={log_path}")
    lines.append(f"# HANG_SECONDS={HANG_SECONDS}  bind=127.0.0.1:0  protocol=HTTP/1.1")
    lines.append(
        f"# 宿主机系统代理={system_proxies or '无'}；出口 opener 已 ProxyHandler({{}}) 忽略它"
        f"（proxy_bypass('127.0.0.1:9')={bool(proxy_bypass('127.0.0.1:9'))}）"
    )

    server = FakeUpdater(fixtures, log_path)
    started = time.monotonic()
    base = server.start()
    lines.append(f"# base={base}  bind={server.bind_address}")
    guard = None
    guard_report: dict = {}
    guard_note = ""
    stop_cost = 0.0
    try:
        try:
            from egress_guard import EgressGuard      # 同目录，其他席位也用同一份

            guard = EgressGuard()
            guard.install()
            lines.append(
                "# EgressGuard installed：127.0.0.1/::1/localhost 放行；"
                "connect/connect_ex/getaddrinfo 其余先计数再 raise，DNS 拦下时绝不真解析"
            )
        except Exception as error:                    # noqa: BLE001 - 首要目标仍是 six mode
            guard_note = f"{type(error).__name__}: {error}"
            lines.append(f"# WARN egress_guard 未装载：{guard_note}")

        try:
            results.append(("bind-loopback", True, _check_bind_loopback(server)))
        except Exception as error:                    # noqa: BLE001
            results.append(("bind-loopback", False, f"{type(error).__name__}: {error}"))

        for mode, check in checks:
            try:
                detail = str(check(base))
                results.append((mode, True, detail))
            except Exception as error:               # noqa: BLE001 - 自检要如实报告
                results.append((mode, False, f"{type(error).__name__}: {error}"))
        try:
            schema_detail = _check_log_schema(log_path, server.requests)
            results.append(("schema", True, schema_detail))
        except Exception as error:                   # noqa: BLE001
            results.append(("schema", False, f"{type(error).__name__}: {error}"))

        # 零外联：guard 的记账 + 服务器日志的 loopback 自证
        records = server.requests
        if guard is not None:
            guard_report = guard.report()
        allowed = list(guard_report.get("allowed") or [])
        loopback_only = bool(allowed) and all(
            entry.startswith("127.0.0.1:") for entry in allowed
        )
        zero_ok = (
            guard is not None
            and bool(guard_report.get("ok"))
            and int(guard_report.get("external_attempts", -1)) == 0
            and loopback_only
        )
        results.append(
            (
                "zero-egress",
                zero_ok,
                f"external_attempts={guard_report.get('external_attempts', 'n/a')} "
                f"allowed={len(guard_report.get('allowed') or [])}（全部 127.0.0.1:port={loopback_only}） "
                f"blocked={len(guard_report.get('blocked') or [])} "
                f"dns_blocked={len(guard_report.get('dns_blocked') or [])} "
                f"server_requests={len(records)}"
                + ("" if guard is not None else f"；guard 未装载：{guard_note}")
            )
        )
    finally:
        if guard is not None:
            try:
                guard.uninstall()
            except Exception:                        # noqa: BLE001 - 卸载失败不该掩盖结果
                pass
        stop_started = time.monotonic()
        server.stop()
        stop_cost = time.monotonic() - stop_started

    for mode, passed, detail in results:
        lines.append(f"SELFTEST {mode} {'PASS' if passed else 'FAIL'} {detail}")

    passed_count = sum(1 for _, passed, _ in results if passed)
    total = len(results)
    failed = [mode for mode, passed, _ in results if not passed]
    lines.append(
        f"SELFTEST-SUMMARY {passed_count}/{total} pass  "
        f"total={time.monotonic() - started:.2f}s stop_cost={stop_cost:.2f}s  "
        f"failed={','.join(failed) if failed else '-'}"
    )
    lines.append(f"SELFTEST-EXIT {0 if not failed else 1}")

    for line in lines:
        print(line, flush=True)
    return 0 if not failed else 1


# ------------------------------------------------------------------ CLI


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="UPDATER-E2E 假更新服务器（只绑 127.0.0.1，纯标准库）"
    )
    parser.add_argument(
        "--selftest", action="store_true", help="六个 mode 各真连一遍，全过 exit 0"
    )
    parser.add_argument(
        "--log",
        type=Path,
        default=None,
        help="请求日志 JSONL 路径（--selftest 默认 evidence/updater/r2/server/access.jsonl）",
    )
    parser.add_argument("--port", type=int, default=0, help="独立进程模式端口（0=随机）")
    parser.add_argument("--fixtures", type=Path, default=None, help="独立进程模式 fixtures JSON")
    args = parser.parse_args(argv)

    if args.selftest:
        return run_selftest(args.log or default_log_path())

    if args.fixtures:
        fixtures = load_fixtures_json(args.fixtures)
        server = FakeUpdater(fixtures, args.log or Path("access.jsonl"))
        server._bind_port = max(0, int(args.port))      # noqa: SLF001 - 只用 CLI 的私有入口
        base = server.start()
        print(f"FAKE-UPDATER {base} scenarios={sorted(fixtures)} log={server.log_path}", flush=True)
        try:
            while True:
                time.sleep(0.5)
        except KeyboardInterrupt:
            print("FAKE-UPDATER stopping (KeyboardInterrupt)", flush=True)
        finally:
            server.stop()
        return 0

    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
    except Exception:                                                  # noqa: BLE001
        pass
    raise SystemExit(main())
