#!/usr/bin/env python3
"""egress_guard.py —— UPDATER-E2E 战役的零外联守卫（假服务器员交付物）。

契约来源：``tests/desktop/updater/e2e/SCENARIO-CONTRACT.md`` §4（逐字实现）。

做一件很窄的事：在**当前进程内**给 ``socket.socket.connect`` /
``socket.socket.connect_ex`` / ``socket.getaddrinfo`` 打桩，只放行 loopback，
其余一律**先记账、后抛错**（``RuntimeError("EGRESS-BLOCKED: ...")``）。

为什么不用防火墙 / hosts：本战役要的是**可复算的进程级证据**——
「这次跑有没有试图出去、出去到哪、被谁拦下」必须写在同一个进程的 report 里，
并且 ``getaddrinfo`` 被拦时**绝不能真的去解析域名**（否则"零外联"只证明了一半）。

用法::

    from egress_guard import EgressGuard
    guard = EgressGuard()          # 允许 127.0.0.1 / ::1 / localhost / 0.0.0.0
    guard.install()
    try:
        ...                        # 被测流程
    finally:
        guard.uninstall()
    print(guard.report())          # {"ok": True, ...} 才算零外联通过

线程安全、可重入：``install()`` 可重复调用（幂等），多个 guard 可同时生效，
最后一个 ``uninstall()`` 才把原始的 socket 函数复原回去。

round-2 硬化（与 ``fake_server.py`` 一起冻结）
---------------------------------------------
1. socket 层拦不住"经本地代理出网"：本机 ``ProxyEnable=1`` / ``ProxyServer=127.0.0.1:7897``
   时，外网请求在 socket 层表现为连到 ``127.0.0.1:7897``（loopback，本守卫合法放行）。
   因此本模块额外提供 **URL 层**判定：``is_loopback_url`` / ``require_loopback_url``
   （错误码 ``EGRESS-URL-BLOCKED``）——发请求前就能识别外网目标，不依赖 socket 层；
2. ``counts()`` 给精确计数（``report()`` 的明细列表有 ``MAX_RECORDS`` 上限）；
   ``assert_zero_egress()`` 是证据脚本用的硬断言（不满足直接 raise）；
3. ``report()`` 的返回形状保持契约 §4 的五个键不变（新增能力全部走独立方法，不做形状漂移）。
"""

from __future__ import annotations

import ipaddress
import socket
import threading
from typing import Any, Callable, Iterable

#: 字面量层面的本地主机名集合（契约 §4 点名的四个 + IPv6 通配）。
_LOOPBACK_LITERALS = frozenset(
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

#: allowed/blocked 明细列表的保留上限（防止长跑把内存吃光）；计数不受影响。
MAX_RECORDS = 5000

#: 正在生效的 guard（模块级，多个实例共享同一套 patch）。
_LOCK = threading.RLock()
_ACTIVE: list["EgressGuard"] = []
_ORIG: dict[str, Any] = {}


# ------------------------------------------------------------------ 判定


def _split_target(address: Any) -> tuple[Any, Any]:
    """把 socket 的 address 拆成 (host, port)；非 tuple（AF_UNIX 等）返回 (None, None)。"""
    if isinstance(address, tuple):
        host = address[0] if len(address) > 0 else None
        port = address[1] if len(address) > 1 else None
        return host, port
    return None, None


def _normalise_host(host: Any) -> str:
    if host is None:
        return ""
    if isinstance(host, (bytes, bytearray)):
        try:
            host = bytes(host).decode("idna", "replace")
        except (UnicodeDecodeError, UnicodeError):        # pragma: no cover - 防御
            host = bytes(host).decode("latin-1", "replace")
    text = str(host).strip().lower()
    if text.startswith("[") and text.endswith("]"):       # "[::1]" 形式
        text = text[1:-1]
    if "%" in text:                                       # link-local 的 scope id
        text = text.split("%", 1)[0]
    return text


def _allowed_networks(allowed: Iterable[str]) -> list[Any]:
    """把 allowed 里的 CIDR（如 ``127.0.0.0/8``）解析成 ip_network；其余按字面量处理。"""
    networks: list[Any] = []
    for item in allowed:
        text = str(item).strip()
        if "/" not in text:
            continue
        try:
            networks.append(ipaddress.ip_network(text, strict=False))
        except ValueError:
            continue
    return networks


def _is_local_host(host: Any, allowed: Iterable[str], networks: Iterable[Any]) -> bool:
    """host 是否本地（loopback / 未指定地址 / allowed 白名单）。空 host 视为本地。"""
    text = _normalise_host(host)
    if text == "":
        return True
    if text in _LOOPBACK_LITERALS:
        return True
    for item in allowed:
        candidate = str(item).strip().lower()
        if not candidate:
            continue
        if "/" not in candidate and text == _normalise_host(candidate):
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
    for network in networks:
        try:
            if ip.version == network.version and ip in network:
                return True
        except TypeError:                                 # pragma: no cover - 版本不匹配
            continue
    return False


def _format_target(host: Any, port: Any) -> str:
    text = _normalise_host(host)
    if not text:
        text = "<empty>"
    if ":" in text:                                       # IPv6 加方括号，便于读
        text = f"[{text}]"
    return f"{text}:{port}" if port is not None else text


# ------------------------------------------------------------------ patch


def _guarded_connect(sock: socket.socket, address: Any) -> Any:
    with _LOCK:
        guards = list(_ACTIVE)
        original = _ORIG.get("connect")
    blocked = [target for guard in guards if (target := guard._note_connect(address))]
    if blocked:
        raise RuntimeError(
            "EGRESS-BLOCKED: connect -> {} 不是 loopback（只有 127.0.0.1/::1/localhost 放行）"
            .format(", ".join(blocked))
        )
    if original is None:                                  # pragma: no cover - 防御
        raise RuntimeError("EGRESS-BLOCKED: guard 状态异常（原始 connect 丢失）")
    return original(sock, address)


def _guarded_connect_ex(sock: socket.socket, address: Any) -> Any:
    with _LOCK:
        guards = list(_ACTIVE)
        original = _ORIG.get("connect_ex")
    blocked = [target for guard in guards if (target := guard._note_connect(address))]
    if blocked:
        raise RuntimeError(
            "EGRESS-BLOCKED: connect_ex -> {} 不是 loopback（只有 127.0.0.1/::1/localhost 放行）"
            .format(", ".join(blocked))
        )
    if original is None:                                  # pragma: no cover - 防御
        raise RuntimeError("EGRESS-BLOCKED: guard 状态异常（原始 connect_ex 丢失）")
    return original(sock, address)


def _guarded_getaddrinfo(
    host: Any,
    port: Any,
    family: int = 0,
    type: int = 0,                                        # noqa: A002 - 标准库签名
    proto: int = 0,
    flags: int = 0,
) -> Any:
    with _LOCK:
        guards = list(_ACTIVE)
        original = _ORIG.get("getaddrinfo")
    blocked = [target for guard in guards if (target := guard._note_dns(host, port))]
    if blocked:
        raise RuntimeError(
            "EGRESS-BLOCKED: DNS 解析 -> {} 不是本地地址（域名解析已在守卫层被拒，未发出真实查询）"
            .format(", ".join(blocked))
        )
    if original is None:                                  # pragma: no cover - 防御
        raise RuntimeError("EGRESS-BLOCKED: guard 状态异常（原始 getaddrinfo 丢失）")
    return original(host, port, family, type, proto, flags)


def _install_patches() -> None:
    """只在第一个 guard install 时执行；保存**原始**函数（不会被二次 patch 污染）。"""
    if _ORIG:
        return
    _ORIG["connect"] = socket.socket.connect
    _ORIG["connect_ex"] = socket.socket.connect_ex
    _ORIG["getaddrinfo"] = socket.getaddrinfo
    socket.socket.connect = _guarded_connect            # type: ignore[method-assign]
    socket.socket.connect_ex = _guarded_connect_ex      # type: ignore[method-assign]
    socket.getaddrinfo = _guarded_getaddrinfo           # type: ignore[assignment]


def _uninstall_patches() -> None:
    """最后一个 guard uninstall 时复原；复原成 install 之前盘上的那个函数。"""
    if not _ORIG:
        return
    original_connect = _ORIG.pop("connect", None)
    original_connect_ex = _ORIG.pop("connect_ex", None)
    original_getaddrinfo = _ORIG.pop("getaddrinfo", None)
    if original_connect is not None:
        socket.socket.connect = original_connect        # type: ignore[method-assign]
    if original_connect_ex is not None:
        socket.socket.connect_ex = original_connect_ex  # type: ignore[method-assign]
    if original_getaddrinfo is not None:
        socket.getaddrinfo = original_getaddrinfo       # type: ignore[assignment]


# ------------------------------------------------------------------ 主体


class EgressGuard:
    """零外联守卫（契约 §4）。

    ``allowed`` 里可以放主机名/地址字面量（``"127.0.0.1"``、``"localhost"``）或 CIDR
    （``"127.0.0.0/8"``）；此外 127.0.0.0/8、::1、0.0.0.0、::、``localhost`` 恒被视为本地。
    """

    def __init__(self, allowed: Iterable[str] = ("127.0.0.1", "::1")) -> None:
        self.allowed: tuple[str, ...] = tuple(str(item) for item in allowed)
        self._networks = _allowed_networks(self.allowed)
        self._lock = threading.RLock()
        self._allowed: list[str] = []
        self._blocked: list[str] = []
        self._dns_allowed: list[str] = []
        self._dns_blocked: list[str] = []
        self._n_allowed = 0
        self._n_blocked = 0
        self._n_dns_allowed = 0
        self._n_dns_blocked = 0
        self._installed = False

    # -- 安装 / 卸载 --------------------------------------------------

    def install(self) -> None:
        """打桩。重复调用幂等；与其它 guard 共用同一套 patch。"""
        with _LOCK:
            if self in _ACTIVE:
                self._installed = True
                return
            _ACTIVE.append(self)
            _install_patches()
            self._installed = True

    def uninstall(self) -> None:
        """撤桩。幂等；最后一个 guard 卸载时才复原原始 socket 函数。"""
        with _LOCK:
            if self in _ACTIVE:
                _ACTIVE.remove(self)
            if not _ACTIVE:
                _uninstall_patches()
            self._installed = False

    # -- 兼容上下文管理器（非契约项，好用而已）------------------------

    def __enter__(self) -> "EgressGuard":
        self.install()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.uninstall()

    # -- 记账（由 patch 调用）----------------------------------------

    def _append(self, bucket: list[str], target: str) -> None:
        if len(bucket) < MAX_RECORDS:
            bucket.append(target)

    def _note_connect(self, address: Any) -> str:
        """返回被拦下的 target（``""`` = 放行）。同时记账。"""
        host, port = _split_target(address)
        if host is None:                     # AF_UNIX 等本地 IPC：不是外联，不记账
            return ""
        target = _format_target(host, port)
        local = _is_local_host(host, self.allowed, self._networks)
        with self._lock:
            if local:
                self._n_allowed += 1
                self._append(self._allowed, target)
                return ""
            self._n_blocked += 1
            self._append(self._blocked, target)
            return target

    def _note_dns(self, host: Any, port: Any) -> str:
        """返回被拦下的 target（``""`` = 放行）。同时记账。**拦下时不解析**。"""
        target = _format_target(host, port)
        local = _is_local_host(host, self.allowed, self._networks)
        with self._lock:
            if local:
                self._n_dns_allowed += 1
                self._append(self._dns_allowed, target)
                return ""
            self._n_dns_blocked += 1
            self._append(self._dns_blocked, target)
            return target

    # -- 报告 ---------------------------------------------------------

    def report(self) -> dict:
        """契约 §4 的结构；``ok`` 当且仅当 ``external_attempts == 0``。"""
        with self._lock:
            external = self._n_blocked + self._n_dns_blocked
            return {
                "allowed": list(self._allowed),
                "blocked": list(self._blocked),
                "dns_allowed": list(self._dns_allowed),
                "dns_blocked": list(self._dns_blocked),
                "external_attempts": int(external),
                "ok": external == 0,
            }

    @property
    def installed(self) -> bool:
        """当前是否处于安装状态（非契约项，自检用）。"""
        with _LOCK:
            return self in _ACTIVE

    def counts(self) -> dict:
        """**非契约项**：精确计数（``report()`` 的明细列表有 ``MAX_RECORDS`` 上限，计数没有）。"""
        with self._lock:
            return {
                "allowed": int(self._n_allowed),
                "blocked": int(self._n_blocked),
                "dns_allowed": int(self._n_dns_allowed),
                "dns_blocked": int(self._n_dns_blocked),
                "external_attempts": int(self._n_blocked + self._n_dns_blocked),
            }

    def assert_zero_egress(self) -> dict:
        """**非契约项**：零外联硬断言。不满足就 raise（证据脚本用它做最后一道自证）。"""
        report = self.report()
        if report["external_attempts"] != 0 or not report["ok"]:
            raise RuntimeError(
                "EGRESS-NOT-ZERO: external_attempts={} blocked={} dns_blocked={}".format(
                    report["external_attempts"], report["blocked"], report["dns_blocked"]
                )
            )
        return report


# ------------------------------------------------------------------ 判定辅助


def is_loopback_host(host: Any, allowed: Iterable[str] = ("127.0.0.1", "::1")) -> bool:
    """**非契约项**：与 patch 内同一套判据，供调用方在**发请求前**自查主机是否本地。"""
    allowed_tuple = tuple(str(item) for item in allowed)
    return _is_local_host(host, allowed_tuple, _allowed_networks(allowed_tuple))


def is_loopback_url(url: str, allowed: Iterable[str] = ("127.0.0.1", "::1")) -> bool:
    """**非契约项**：URL 的主机是否 loopback（无主机/相对 URL 视为本地）。"""
    import urllib.parse

    try:
        host = urllib.parse.urlsplit(str(url)).hostname
    except ValueError:                                # pragma: no cover - 非法 URL
        return False
    return is_loopback_host(host, allowed)


def require_loopback_url(url: str, allowed: Iterable[str] = ("127.0.0.1", "::1")) -> str:
    """**非契约项**：URL 主机不是 loopback 就 raise ``RuntimeError('EGRESS-URL-BLOCKED ...')``。

    这是比 socket 层更早的一道闸：系统代理场景下 socket 层只看到 loopback，
    只有 URL 层才能识别"目标是外网"。
    """
    if not is_loopback_url(url, allowed):
        raise RuntimeError(f"EGRESS-URL-BLOCKED: {url} 不是 loopback（只允许 127.0.0.1/::1/localhost）")
    return str(url)


# ------------------------------------------------------------------ 自检辅助


def no_proxy_opener():
    """返回一个**显式忽略系统代理**的 urllib opener（与产品 ``net.py:136-140`` 同口径）。

    为什么必须有这个：宿主机的「系统代理」常常就设在 ``127.0.0.1:<port>``（本机实测
    ``127.0.0.1:7897`` 正在监听），而 ``urllib`` 会读注册表/环境变量把 ``http://example.com``
    这类请求**转发给本地代理**——从 socket 层看这是合法的 loopback 连接，守卫放行，
    于是请求经由代理真出网。**这不是守卫能拦的层次**，只能从「不要用系统代理」解决：
    产品传输层 ``UrllibTransport`` 已经这么做，测试侧也必须这么做。
    """
    import urllib.request

    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def patched_functions() -> dict[str, Callable[..., Any] | Any]:
    """当前进程里 socket 三个入口的实际对象（自检用：判断是否已打桩 / 是否已复原）。"""
    return {
        "connect": socket.socket.connect,
        "connect_ex": socket.socket.connect_ex,
        "getaddrinfo": socket.getaddrinfo,
    }
