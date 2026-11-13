#!/usr/bin/env python3
"""guard_selftest.py —— EgressGuard（契约 §4）的自检：真连、真拦、真复原。

只做三件事，全程**零真实外网流量**：

1. 装 Guard 后连 ``http://127.0.0.1:1/x``（必然被拒）→ 必须记为 **allowed**，
   ``report()["ok"] is True``（"正常跑一次流程不会产生外联"）。
2. 装 Guard 后 ``urlopen("http://example.com/")`` → 必须在 **DNS 层**被拦下并抛
   ``RuntimeError("EGRESS-BLOCKED: ...")``；同时用一个 tripwire 证明**真实解析器
   一次都没被调用**（也就是没有真的去解析 example.com）。
3. 直接 ``connect`` / ``connect_ex`` 一个 TEST-NET 地址（203.0.113.7 / 198.51.100.9，
   文档保留段，本机不可路由）→ 必须被拦；然后 ``uninstall()`` 必须把
   ``socket.socket.connect`` / ``connect_ex`` / ``socket.getaddrinfo`` 复原成 install 之前的对象。

**两道独立保险（因为宿主机装了系统代理）**

* 所有 HTTP 探针都走 ``ProxyHandler({})`` 的 opener——本机实测系统代理在
  ``127.0.0.1:7897`` 且 ``proxy_bypass("example.com") is False``，裸 ``urlopen``
  会把外网请求**转发给本地代理**（socket 层看是 loopback，守卫无权拦）。产品
  ``net.py:136-140`` 也是这个口径，自检必须一致。
* tripwire 对任何非 loopback 的 ``getaddrinfo`` **先计数再 raise**——即使守卫将来
  再次回归成放行，也不会有一次真实 DNS 查询或 TCP 连接发出去。

用 ``D:\\Python311\\python.exe guard_selftest.py`` 跑：
逐行 ``GUARD <id> PASS|FAIL <detail>``，全过 exit 0。
``--json PATH`` 会把结构化摘要（给 RESULT.json 用）写成 UTF-8 JSON。
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener, getproxies
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from egress_guard import EgressGuard, _is_local_host, patched_functions  # noqa: E402

#: 非 loopback 的探针地址：RFC 5737 文档保留段，即便真的发出去也不可达，
#: 但本自检根本不发——Guard 在 connect 系统调用之前就 raise 了。
_PROBE_IPV4_A = "203.0.113.7"
_PROBE_IPV4_B = "198.51.100.9"

_LOOPBACK_PROBE = "http://127.0.0.1:1/zero-egress-probe"
_DNS_PROBE = "http://example.com/"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class _Checks:
    """极简断言收集器：一条 PASS/FAIL + 明细，失败不中断后续检查。"""

    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    def run(self, case_id: str, expect: str, func: Any) -> None:
        try:
            actual = str(func())
            verdict = "PASS"
        except Exception as error:                       # noqa: BLE001 - 自检要如实报告
            actual = f"{type(error).__name__}: {error}"
            verdict = "FAIL"
        self.rows.append(
            {"id": case_id, "expect": expect, "actual": actual, "verdict": verdict}
        )

    @property
    def ok(self) -> bool:
        return all(row["verdict"] == "PASS" for row in self.rows)


def _urlopen_error(opener: Any, url: str) -> BaseException:
    """打开 url 并返回**抛出的异常**（用于把"必须失败"的路径写成可断言的值）。"""
    try:
        with opener.open(url, timeout=3) as response:    # noqa: S310 - 只打 loopback / 必被拦的域名
            response.read()
    except BaseException as error:                       # noqa: BLE001
        return error
    raise AssertionError(f"{url} 竟然成功了（不该有服务在监听）")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="EgressGuard 自检（零外联）")
    parser.add_argument("--json", type=Path, default=None, help="结构化摘要输出路径（UTF-8 JSON）")
    args = parser.parse_args(argv)

    real = patched_functions()
    resolver_calls = {"nonloopback": 0}
    opener = build_opener(ProxyHandler({}))          # 直连：不读系统代理（见模块 docstring）
    host_proxies = getproxies()

    def tripwire(host: Any, port: Any, family: int = 0, type: int = 0,  # noqa: A002
                 proto: int = 0, flags: int = 0) -> Any:
        """包住**真实** getaddrinfo：非本地主机先计数、再 **raise**（绝不放行真实解析）。"""
        if not _is_local_host(host, (), ()):
            resolver_calls["nonloopback"] += 1
            raise RuntimeError(
                f"SELFTEST-TRIPWIRE: 拒绝真实解析 {host!r}"
                "（本自检不允许任何真实 DNS 查询）"
            )
        return real["getaddrinfo"](host, port, family, type, proto, flags)

    # 先装 tripwire 再取「install 之前的盘上对象」：guard 复原后必须回到指纹一致的那个对象。
    socket.getaddrinfo = tripwire                     # type: ignore[assignment]
    original = patched_functions()

    checks = _Checks()
    clean_report: dict = {}
    block_report: dict = {}
    guard_clean = EgressGuard()
    guard_block = EgressGuard()
    exit_code = 1

    print(f"# guard_selftest.py  {_utc_now_iso()}")
    print(f"# python={sys.version.split()[0]}  urllib_probe={_LOOPBACK_PROBE}")
    print(f"# allowed 默认 = ('127.0.0.1', '::1')；127.0.0.0/8、::1、0.0.0.0、::、localhost 恒本地")
    print(f"# 宿主机系统代理 = {host_proxies or '无'}；本自检一律 ProxyHandler({{}}) 直连（同 net.py:136-140）")

    try:
        checks.run(
            "G-no-proxy",
            "探针 opener 的 ProxyHandler 为空（有系统代理且代理在 loopback 时，裸 urllib 会经它真出网）",
            lambda: _assert_no_proxy(opener),
        )

        # ---------------------------------------------------------- Phase A
        guard_clean.install()
        installed = patched_functions()
        checks.run(
            "G-install",
            "install() 之后 socket.connect/connect_ex/getaddrinfo 均已被替换",
            lambda: (
                "connect/connect_ex/getaddrinfo 均已打桩"
                if installed["connect"] is not original["connect"]
                and installed["connect_ex"] is not original["connect_ex"]
                and installed["getaddrinfo"] is not original["getaddrinfo"]
                else (_ for _ in ()).throw(AssertionError("仍有入口未被替换"))
            ),
        )
        checks.run(
            "G-classify",
            "loopback 判定：127.0.0.1/::1/localhost/0.0.0.0 本地；example.com/203.0.113.7 非本地",
            lambda: _assert_classification(),
        )

        refused = _urlopen_error(opener, _LOOPBACK_PROBE)
        checks.run(
            "G-allow-loopback",
            "urlopen(127.0.0.1:1) 放行到系统调用层（连接被拒也应记为 allowed，不是 blocked）",
            lambda: _assert_refused(refused),
        )
        checks.run(
            "G-localhost-dns",
            "socket.getaddrinfo('localhost', 0) 放行并记入 dns_allowed",
            lambda: _assert_localhost_resolves(),
        )
        checks.run(
            "G-empty-host",
            "空主机/None 不得被当成外联拦下（放行到标准库；结果记入 dns_allowed，不 raise EGRESS-BLOCKED）",
            lambda: _assert_empty_host_lenient(),
        )

        clean_report = guard_clean.report()
        checks.run(
            "G-clean-report",
            "只打 loopback 时 report(): external_attempts==0、blocked/dns_blocked 为空、ok is True",
            lambda: _assert_clean_report(clean_report),
        )
        guard_clean.uninstall()
        restored = patched_functions()
        checks.run(
            "G-restore-clean",
            "uninstall() 后 socket 三个入口复原为 install 之前的对象",
            lambda: _assert_restored(restored, original),
        )

        # ---------------------------------------------------------- Phase B
        guard_block.install()
        runtime_errors: list[str] = []

        def _dns_probe() -> str:
            error = _urlopen_error(opener, _DNS_PROBE)
            runtime_errors.append(type(error).__name__)
            if isinstance(error, URLError):
                raise AssertionError(f"被包成了 URLError（{error.reason!r}），应在 DNS 层直接 EGRESS-BLOCKED")
            if not isinstance(error, RuntimeError):
                raise AssertionError(f"异常类型 {type(error).__name__} 不是 RuntimeError")
            text = str(error)
            if "SELFTEST-TRIPWIRE" in text:
                raise AssertionError(f"守卫没拦住，被 tripwire 兜住了（守卫回归）：{text}")
            if "EGRESS-BLOCKED" not in text:
                raise AssertionError(f"异常文案没有 EGRESS-BLOCKED：{text}")
            if "example.com" not in text:
                raise AssertionError(f"异常文案没带目标：{text}")
            return f"RuntimeError('{text}')"

        checks.run(
            "G-dns-block",
            "urlopen('http://example.com/') 在 getaddrinfo 层被拦，raise RuntimeError('EGRESS-BLOCKED: ...')",
            _dns_probe,
        )

        def _connect_probe() -> str:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                try:
                    sock.connect((_PROBE_IPV4_A, 443))
                except RuntimeError as error:
                    if "EGRESS-BLOCKED" not in str(error):
                        raise AssertionError(f"异常文案没有 EGRESS-BLOCKED：{error}")
                    return f"RuntimeError('{error}')"
                raise AssertionError("connect 竟然没被拦（根本没发出去才对）")
            finally:
                sock.close()

        checks.run(
            "G-connect-block",
            "socket.connect(('203.0.113.7', 443)) 被拦并记入 blocked",
            _connect_probe,
        )

        def _connect_ex_probe() -> str:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                try:
                    sock.connect_ex((_PROBE_IPV4_B, 80))
                except RuntimeError as error:
                    if "EGRESS-BLOCKED" not in str(error):
                        raise AssertionError(f"异常文案没有 EGRESS-BLOCKED：{error}")
                    return f"RuntimeError('{error}')"
                raise AssertionError("connect_ex 竟然没被拦（返回了错误码而不是 raise）")
            finally:
                sock.close()

        checks.run(
            "G-connect_ex-block",
            "socket.connect_ex(('198.51.100.9', 80)) 被拦并 raise（不是返回错误码）",
            _connect_ex_probe,
        )

        block_report = guard_block.report()
        checks.run(
            "G-block-report",
            "attempts 全部记账：blocked=2、dns_blocked=1、external_attempts==3、ok is False",
            lambda: _assert_block_report(block_report),
        )
        guard_block.uninstall()
        checks.run(
            "G-restore-block",
            "uninstall() 后 socket 三个入口复原为 install 之前的对象",
            lambda: _assert_restored(patched_functions(), original),
        )

        # ---------------------------------------------------------- 全局
        checks.run(
            "G-no-real-dns",
            "全过程真实解析器对非 loopback 主机的调用次数 == 0（example.com 从未被真正解析）",
            lambda: _assert_zero_resolver_calls(resolver_calls),
        )
        checks.run(
            "G-no-guard-left",
            "自检结束时没有残留的 patch（guard 全部 uninstall）",
            lambda: (
                "无残留"
                if patched_functions()["getaddrinfo"] is original["getaddrinfo"]
                and patched_functions()["connect"] is original["connect"]
                else (_ for _ in ()).throw(AssertionError("仍有 patch 残留"))
            ),
        )

        for row in checks.rows:
            print(f"GUARD {row['id']} {row['verdict']} {row['actual']}", flush=True)
        exit_code = 0 if checks.ok else 1
        passed = sum(1 for row in checks.rows if row["verdict"] == "PASS")
        print(
            f"GUARD-SUMMARY {passed}/{len(checks.rows)} pass  "
            f"nonloopback_resolver_calls={resolver_calls['nonloopback']}  exit={exit_code}",
            flush=True,
        )
    except Exception:                                  # noqa: BLE001 - 兜底，保证复原
        traceback.print_exc()
        for row in checks.rows:
            print(f"GUARD {row['id']} {row['verdict']} {row['actual']}", flush=True)
        print("GUARD-SUMMARY aborted exit=1", flush=True)
        exit_code = 1
    finally:
        try:
            guard_clean.uninstall()
            guard_block.uninstall()
        except Exception:                              # noqa: BLE001
            traceback.print_exc()
        socket.getaddrinfo = real["getaddrinfo"]       # type: ignore[assignment]
        socket.socket.connect = real["connect"]        # type: ignore[method-assign]
        socket.socket.connect_ex = real["connect_ex"]  # type: ignore[method-assign]

    summary = {
        "ran_at": _utc_now_iso(),
        "python": sys.version.split()[0],
        "cases": checks.rows,
        "clean_report": clean_report,
        "block_report": block_report,
        "nonloopback_resolver_calls": resolver_calls["nonloopback"],
        "ok": checks.ok,
        "exit_code": exit_code,
        "probes": {"loopback": _LOOPBACK_PROBE, "dns": _DNS_PROBE, "connect": _PROBE_IPV4_A},
    }
    if args.json is not None:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return exit_code


# ------------------------------------------------------------------ 断言实现


def _assert_no_proxy(opener: Any) -> str:
    """``ProxyHandler({})`` 的语义：空映射时它**不注册任何 http_open 入口**，
    所以正确的不变量是「opener 里没有任何带非空 proxies 的 handler」，
    而不是「handlers 列表里必须能数出一个 ProxyHandler 实例」。
    """
    active = [getattr(handler, "proxies", None) for handler in opener.handlers]
    non_empty = [item for item in active if item]
    if non_empty:
        raise AssertionError(f"opener 仍带代理 {non_empty}（会被转发到本地代理真出网）")
    proxies = getproxies()
    return (
        "opener 无任何带 proxies 的 handler（proxies={}）；"
        f"宿主机系统代理 {proxies or '无'} 被忽略"
    )


def _assert_classification() -> str:
    local = ("127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "127.5.6.7")
    remote = ("example.com", "203.0.113.7", "github.com", "objects.githubusercontent.com")
    bad = [host for host in local if not _is_local_host(host, (), ())]
    leaked = [host for host in remote if _is_local_host(host, (), ())]
    if bad:
        raise AssertionError(f"本地主机被误判为外网：{bad}")
    if leaked:
        raise AssertionError(f"外网主机被误判为本地：{leaked}")
    return f"本地 {len(local)} 个全通过；外网 {len(remote)} 个全拒绝"


def _assert_refused(error: BaseException) -> str:
    if isinstance(error, URLError):
        reason = error.reason
        if isinstance(reason, (ConnectionRefusedError, TimeoutError, OSError)):
            return f"URLError(reason={type(reason).__name__}: {reason}) —— 已到系统调用层，说明 loopback 被放行"
        raise AssertionError(f"URLError 但 reason 类型意外：{reason!r}")
    if isinstance(error, RuntimeError) and "EGRESS-BLOCKED" in str(error):
        raise AssertionError(f"loopback 被自己的守卫拦了：{error}")
    raise AssertionError(f"异常类型意外：{type(error).__name__}: {error}")


def _assert_localhost_resolves() -> str:
    infos = socket.getaddrinfo("localhost", 0)
    if not infos:
        raise AssertionError("getaddrinfo('localhost', 0) 返回空")
    families = sorted({info[0] for info in infos})
    return f"返回 {len(infos)} 条地址，family={families}"


def _assert_empty_host_lenient() -> str:
    """空主机 / None **不是外联**：契约 §4 只要求拦"非 loopback 的目标地址"。

    别的席位（回滚员的 fallback 守卫）在这里把 ``getaddrinfo("")`` 当外联拦下，会误伤
    测试自身（``http.client`` 在某些路径上会带空 host）。本实现对空/None 主机记为
    ``dns_allowed`` 并放行到标准库——标准库自己可能抛 ``gaierror``，那不是守卫的判决。
    """
    outcomes: list[str] = []
    for host in ("", None):
        try:
            infos = socket.getaddrinfo(host, 0)
            outcomes.append(f"{host!r}=ok({len(infos)})")
        except RuntimeError as error:
            if "EGRESS-BLOCKED" in str(error):
                raise AssertionError(f"空主机 {host!r} 被守卫当成外联拦下了：{error}")
            raise
        except socket.gaierror as error:
            outcomes.append(f"{host!r}=gaierror({error.errno})")
    return "；".join(outcomes) + "（均未被 EGRESS-BLOCKED 拦；gaierror 属标准库语义，非守卫判决）"


def _assert_clean_report(report: dict) -> str:
    if report.get("external_attempts") != 0:
        raise AssertionError(f"external_attempts={report.get('external_attempts')} != 0")
    if report.get("blocked") or report.get("dns_blocked"):
        raise AssertionError(f"blocked={report.get('blocked')} dns_blocked={report.get('dns_blocked')}")
    if report.get("ok") is not True:
        raise AssertionError("report.ok 不是 True")
    if not any(entry.startswith("127.0.0.1:1") for entry in report.get("allowed", [])):
        raise AssertionError(f"allowed 里没有 127.0.0.1:1：{report.get('allowed')}")
    return (
        f"allowed={report['allowed']} dns_allowed={report['dns_allowed']} "
        f"blocked={report['blocked']} dns_blocked={report['dns_blocked']} ok=True"
    )


def _assert_block_report(report: dict) -> str:
    if report.get("external_attempts") != 3:
        raise AssertionError(f"external_attempts={report.get('external_attempts')} != 3")
    if report.get("ok") is not False:
        raise AssertionError("有外联尝试时 report.ok 必须是 False")
    blocked = report.get("blocked", [])
    dns_blocked = report.get("dns_blocked", [])
    if len(blocked) != 2:
        raise AssertionError(f"blocked={blocked}（应为 2 条）")
    if not any(_PROBE_IPV4_A in item for item in blocked):
        raise AssertionError(f"blocked 里没有 {_PROBE_IPV4_A}：{blocked}")
    if not any(_PROBE_IPV4_B in item for item in blocked):
        raise AssertionError(f"blocked 里没有 {_PROBE_IPV4_B}：{blocked}")
    if not any("example.com" in item for item in dns_blocked):
        raise AssertionError(f"dns_blocked 里没有 example.com：{dns_blocked}")
    return f"blocked={blocked} dns_blocked={dns_blocked} external_attempts=3 ok=False"


def _assert_restored(now: dict, original: dict) -> str:
    problems = [name for name in ("connect", "connect_ex", "getaddrinfo")
                if now[name] is not original[name]]
    if problems:
        raise AssertionError(f"未复原：{problems}")
    return "connect/connect_ex/getaddrinfo 均 === install 之前的对象"


def _assert_zero_resolver_calls(counter: dict) -> str:
    if counter["nonloopback"] != 0:
        raise AssertionError(
            f"非 loopback 主机被真实解析了 {counter['nonloopback']} 次（违反零外联）"
        )
    return "非 loopback 主机真实解析次数 = 0"


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
    except Exception:                                                  # noqa: BLE001
        pass
    raise SystemExit(main())
