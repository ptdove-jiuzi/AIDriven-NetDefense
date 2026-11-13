#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_local_guard.py —— 回滚席位用的零外联守卫（合同 §4 等价实现，fallback）。

为什么存在
----------
并行交付的 `tests/desktop/updater/e2e/server/egress_guard.py` 在 2026-11-05T16:16 的版本里
把 blocked 列表推导写反了：`blocked = [t for guard in guards if not (t := guard._note_*(...))]`
会把「放行（返回 ""）」收进 blocked、把「真正被拦（返回 target）」排除，于是 loopback
请求抛 EGRESS-BLOCKED、外网反而放行。该缺陷已当场报给 fake-server-dev（见 REPORT §7）。

本文件是本席位**自己写域内**（tests/desktop/updater/e2e/rollback/**）的等价实现，
保证「零外联」证据能继续产出、不被并行依赖卡死。语义与合同 §4 一致：

* 放行：127.0.0.1 / ::1 / localhost / 0.0.0.0 / :: 以及 ``allowed`` 里的字面量；
* 其余：先记账，再 ``raise RuntimeError("EGRESS-BLOCKED ...")``；
* ``getaddrinfo`` 同样拦截，且**拦下时绝不真的去解析**；
* ``report()`` 返回 ``{allowed, blocked, dns_allowed, dns_blocked, external_attempts, ok}``；
* ``ok`` 当且仅当 ``external_attempts == 0``。

一旦官方 guard 通过自检（loopback 真能走通），run_rollback.py 会自动改回用它；
本文件只在官方实现不可用时兜底，报告里会明确标注用了哪一个。
"""

from __future__ import annotations

import ipaddress
import socket
import threading
from typing import Any, Iterable

_LOCAL_LITERALS = frozenset(
    {"127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "0:0:0:0:0:0:0:1"}
)

_LOCK = threading.RLock()
_ACTIVE: list["EgressGuard"] = []
_ORIG: dict[str, Any] = {}

MAX_RECORDS = 5000


def _host_text(host: Any) -> str:
    if host is None:
        return ""
    if isinstance(host, (bytes, bytearray)):
        host = bytes(host).decode("idna", "replace")
    text = str(host).strip().lower()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    if "%" in text:
        text = text.split("%", 1)[0]
    return text


def _is_local(host: Any, allowed: Iterable[str]) -> bool:
    text = _host_text(host)
    if not text or text in _LOCAL_LITERALS:
        return True
    for item in allowed:
        if text == _host_text(item):
            return True
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return False
    if address.is_loopback or address.is_unspecified:
        return True
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(mapped is not None and mapped.is_loopback)


def _format_target(host: Any, port: Any) -> str:
    text = _host_text(host) or "<empty>"
    if ":" in text:
        text = f"[{text}]"
    return f"{text}:{port}" if port is not None else text


def _blocked_message(kind: str, targets: list[str]) -> str:
    return f"EGRESS-BLOCKED: {kind} -> {', '.join(targets)} 不是 loopback（已记入 report）"


def _guarded_connect(sock: socket.socket, address: Any) -> Any:
    if not isinstance(address, tuple):
        return _ORIG["connect"](sock, address)
    host, port = address[0], address[1] if len(address) > 1 else None
    with _LOCK:
        guards = list(_ACTIVE)
    blocked: list[str] = []
    for guard in guards:
        target = guard._note(True, host, port)
        if target:
            blocked.append(target)
    if blocked:
        raise RuntimeError(_blocked_message("connect", blocked))
    return _ORIG["connect"](sock, address)


def _guarded_connect_ex(sock: socket.socket, address: Any) -> Any:
    if not isinstance(address, tuple):
        return _ORIG["connect_ex"](sock, address)
    host, port = address[0], address[1] if len(address) > 1 else None
    with _LOCK:
        guards = list(_ACTIVE)
    blocked = [target for guard in guards if (target := guard._note(True, host, port))]
    if blocked:
        raise RuntimeError(_blocked_message("connect_ex", blocked))
    return _ORIG["connect_ex"](sock, address)


def _guarded_getaddrinfo(host: Any, port: Any, family: int = 0, type: int = 0,  # noqa: A002
                         proto: int = 0, flags: int = 0) -> Any:
    with _LOCK:
        guards = list(_ACTIVE)
    blocked = [target for guard in guards if (target := guard._note(False, host, port))]
    if blocked:
        # 关键：拦下时**不调用**原始 getaddrinfo，绝不发出真实 DNS 查询。
        raise RuntimeError(_blocked_message("DNS 解析", blocked))
    return _ORIG["getaddrinfo"](host, port, family, type, proto, flags)


def _install_patches() -> None:
    if _ORIG:
        return
    _ORIG["connect"] = socket.socket.connect
    _ORIG["connect_ex"] = socket.socket.connect_ex
    _ORIG["getaddrinfo"] = socket.getaddrinfo
    socket.socket.connect = _guarded_connect  # type: ignore[method-assign]
    socket.socket.connect_ex = _guarded_connect_ex  # type: ignore[method-assign]
    socket.getaddrinfo = _guarded_getaddrinfo  # type: ignore[assignment]


def _uninstall_patches() -> None:
    if not _ORIG:
        return
    socket.socket.connect = _ORIG.pop("connect", socket.socket.connect)  # type: ignore[method-assign]
    socket.socket.connect_ex = _ORIG.pop("connect_ex", socket.socket.connect_ex)  # type: ignore[method-assign]
    socket.getaddrinfo = _ORIG.pop("getaddrinfo", socket.getaddrinfo)  # type: ignore[assignment]


class EgressGuard:
    """合同 §4 的零外联守卫（本席位 fallback 实现）。"""

    def __init__(self, allowed: Iterable[str] = ("127.0.0.1", "::1")) -> None:
        self.allowed = tuple(str(item) for item in allowed)
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

    def install(self) -> None:
        with _LOCK:
            if self in _ACTIVE:
                self._installed = True
                return
            _ACTIVE.append(self)
            _install_patches()
            self._installed = True

    def uninstall(self) -> None:
        with _LOCK:
            if self in _ACTIVE:
                _ACTIVE.remove(self)
            if not _ACTIVE:
                _uninstall_patches()
            self._installed = False

    def _note(self, is_connect: bool, host: Any, port: Any) -> str:
        """放行返回 ""，拦下返回 target；同时记账。"""
        target = _format_target(host, port)
        local = _is_local(host, self.allowed)
        with self._lock:
            if is_connect:
                if local:
                    self._n_allowed += 1
                    if len(self._allowed) < MAX_RECORDS:
                        self._allowed.append(target)
                    return ""
                self._n_blocked += 1
                if len(self._blocked) < MAX_RECORDS:
                    self._blocked.append(target)
                return target
            if local:
                self._n_dns_allowed += 1
                if len(self._dns_allowed) < MAX_RECORDS:
                    self._dns_allowed.append(target)
                return ""
            self._n_dns_blocked += 1
            if len(self._dns_blocked) < MAX_RECORDS:
                self._dns_blocked.append(target)
            return target

    def report(self) -> dict:
        with self._lock:
            external = self._n_blocked + self._n_dns_blocked
            return {
                "allowed": list(self._allowed),
                "blocked": list(self._blocked),
                "dns_allowed": list(self._dns_allowed),
                "dns_blocked": list(self._dns_blocked),
                "n_allowed": int(self._n_allowed),
                "n_blocked": int(self._n_blocked),
                "n_dns_allowed": int(self._n_dns_allowed),
                "n_dns_blocked": int(self._n_dns_blocked),
                "external_attempts": int(external),
                "ok": external == 0,
            }
