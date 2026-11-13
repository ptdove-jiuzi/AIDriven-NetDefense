#!/usr/bin/env python3
"""transport_probe.py —— 假服务器 × 产品传输层（``net.UrllibTransport``）的接口冒烟。

这不是流程员的场景判据，只回答两个问题：

1. **我的假服务器能不能被产品代码的真传输层正常消费**（合同 §2 的注入配方 + §3 的六种 mode）；
2. 对每个 mode，**产品侧实际暴露出来的是什么**（这一步是给流程员 S1–S6 归因用的原始观测）。

全部在进程内 monkeypatch ``constants``，不改产品源码；全过程装 ``EgressGuard`` 同时证明零外联。

判决口径：``PASS/FAIL`` = 我的服务器 wire 语义是否达标（决定退出码）；
``OBSERVED`` = 产品侧行为观测（不影响退出码，供流程员/Lead 归因）。

    $env:PYTHONIOENCODING='utf-8'
    D:\\Python311\\python.exe tests\\desktop\\updater\\e2e\\server\\transport_probe.py
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parents[4]
sys.path.insert(0, str(_REPO / "apps" / "desktop"))
sys.path.insert(0, str(_HERE))

from updater import constants, net                       # noqa: E402
from updater.errors import NetworkUnavailable            # noqa: E402

from egress_guard import EgressGuard                     # noqa: E402
from fake_server import FakeUpdater                      # noqa: E402

PAYLOAD = b"PK\x03\x04" + bytes(range(256)) * 8
MANIFEST = {
    "version": "0.0.2",
    "channel": "stable",
    "assets": [
        {
            "name": "pkg.zip",
            "size": len(PAYLOAD),
            "sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        }
    ],
}

#: 产品侧观测到的可疑缺陷（供流程员 S4 归因；不在本探针里定级，severity 是建议值）。
DEFECTS: list[dict] = []


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fixtures() -> dict:
    assets = {"pkg.zip": PAYLOAD}
    table = {
        "ok": "ok",
        "etag": "ok",
        "hang": "hang",
        "half": "half",
        "tamper": "tamper",
        "notfound": "notfound",
    }
    return {
        name: {"mode": mode, "manifest": dict(MANIFEST), "assets": dict(assets)}
        for name, mode in table.items()
    }


class Probe:
    """三种判决：PASS/FAIL（我的服务器 wire 语义）、OBSERVED（产品侧行为观测）。"""

    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []

    def run(self, case_id: str, func) -> None:            # noqa: ANN001
        try:
            self.rows.append((case_id, "PASS", str(func())))
        except Exception as error:                        # noqa: BLE001 - 如实报告
            self.rows.append((case_id, "FAIL", f"{type(error).__name__}: {error}"))

    def observe(self, case_id: str, func) -> None:        # noqa: ANN001
        try:
            self.rows.append((case_id, "OBSERVED", str(func())))
        except Exception as error:                        # noqa: BLE001
            self.rows.append((case_id, "OBSERVED", f"{type(error).__name__}: {error}"))

    @property
    def ok(self) -> bool:
        return all(verdict != "FAIL" for _, verdict, _ in self.rows)


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="假服务器 × 产品传输层冒烟")
    parser.add_argument("--json", type=Path, default=None, help="结构化摘要输出路径（UTF-8 JSON）")
    args = parser.parse_args(argv)

    evidence = _REPO / "evidence" / "updater" / "r2" / "server"
    log_path = evidence / "transport_probe_access.jsonl"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    server = FakeUpdater(fixtures(), log_path)
    base = server.start()
    server_bind = server.bind_address

    originals = {
        key: getattr(constants, key)
        for key in ("REQUIRED_SCHEME", "ALLOWED_HOSTS", "CDN_HOSTS", "LATEST_MANIFEST_URL")
    }
    # 合同 §2 的测试侧注入（只在本进程内生效；产品源码零改动）
    constants.REQUIRED_SCHEME = "http"
    constants.ALLOWED_HOSTS = ("127.0.0.1",)
    constants.CDN_HOSTS = ("127.0.0.1",)
    constants.LATEST_MANIFEST_URL = f"{base}/ok/latest.json"

    transport = net.UrllibTransport()
    guard = EgressGuard()
    probe = Probe()
    tmpdir = Path(tempfile.mkdtemp(prefix="upd-probe-"))
    report: dict = {}

    print(f"# transport_probe.py  base={base}  bind={server_bind}  python={sys.version.split()[0]}")
    print(
        f"# REQUIRED_SCHEME={constants.REQUIRED_SCHEME} "
        f"ALLOWED_HOSTS={constants.ALLOWED_HOSTS} CDN_HOSTS={constants.CDN_HOSTS}"
    )

    guard.install()
    try:
        def _manifest_ok() -> str:
            response = transport.get(constants.LATEST_MANIFEST_URL)
            body = response.body
            etag = response.header("etag")
            if not response.ok:
                raise AssertionError(f"status={response.status} 不是 2xx")
            if json.loads(body.decode("utf-8"))["version"] != "0.0.2":
                raise AssertionError(f"body 不对：{body[:80]!r}")
            if not etag.startswith('"e1-'):
                raise AssertionError(f"ETag={etag!r}")
            return f"status=200 bytes={len(body)} etag={etag}"

        def _etag_304() -> str:
            first = transport.get(constants.LATEST_MANIFEST_URL)
            second = transport.get(
                constants.LATEST_MANIFEST_URL,
                headers={"if-none-match": first.header("etag")},
            )
            if second.status != 304:
                raise AssertionError(f"second status={second.status} != 304")
            if second.body != b"":
                raise AssertionError(f"304 body={second.body[:40]!r} 不是空")
            return f"first=200 etag={first.header('etag')} second=304 body_bytes=0"

        def _notfound() -> str:
            response = transport.get(f"{base}/notfound/latest.json")
            if response.status != 404:
                raise AssertionError(f"status={response.status} != 404")
            return "status=404（net.UrllibTransport.get 把 HTTPError 翻成 Response）"

        def _hang() -> str:
            try:
                transport.get(f"{base}/hang/latest.json", timeout=2)
            except NetworkUnavailable as error:
                return (
                    f"NetworkUnavailable(code={getattr(error, 'code', None)})"
                    " —— hang 被映射成离线，不抛原始 timeout"
                )
            except Exception as error:                    # noqa: BLE001
                return f"抛的是 {type(error).__name__}: {error}（未映射成 NetworkUnavailable）"
            raise AssertionError("hang 竟然成功返回了")

        def _half_wire() -> str:
            """我的交付判据：服务端确实只写了 N//2 字节（头声称 N）。"""
            records = [
                record for record in server.requests
                if record["path"] == "/half/assets/pkg.zip"
            ]
            if not records:
                raise AssertionError("服务器没收到 half 资产请求")
            record = records[-1]
            if record["status"] != 200:
                raise AssertionError(f"status={record['status']} != 200")
            if record["bytes"] != len(PAYLOAD) // 2:
                raise AssertionError(
                    f"服务端写了 {record['bytes']}B，不是 N//2={len(PAYLOAD) // 2}B"
                )
            return (
                f"服务端 status=200 只写 {record['bytes']}B（N={len(PAYLOAD)}，半包）"
            )

        def _half_client() -> str:
            """产品侧观测：截断响应是否被 net.UrllibTransport.download() 暴露。"""
            dest = tmpdir / "half.zip"
            try:
                transport.download(f"{base}/half/assets/pkg.zip", dest, timeout=5)
            except Exception as error:                    # noqa: BLE001 - 记录真实类型
                return (
                    f"客户端抛 {type(error).__name__}: {error}；"
                    f"半包残留={dest.exists()}"
                )
            size = dest.stat().st_size if dest.exists() else -1
            DEFECTS.append(
                {
                    "id": "UPD-SERVER-OBS-1",
                    "severity": "P2",
                    "title": "net.UrllibTransport.download() 对截断响应不报错，半包落盘且不清理",
                    "ref": "apps/desktop/updater/net.py:196-214",
                    "impact": (
                        "HTTP 头声称 N 字节、实际只到 N//2 时，download() 正常返回、"
                        f"落盘 {size}B 截断文件且不删除；只能靠后续 sha256 兜底，"
                        "错误分类会落到「资产被拒」而不是「下载不完整/网络错误」"
                    ),
                    "witness": (
                        "D:\\Python311\\python.exe tests\\desktop\\updater\\e2e\\server\\"
                        "transport_probe.py  → PROBE T-half-client"
                    ),
                }
            )
            return (
                f"客户端**没有抛异常**（download 正常返回），落盘 {size}B / 源 {len(PAYLOAD)}B；"
                f"半包残留={dest.exists()} → 截断在传输层未被检测（只能靠后续 sha256 兜底）"
            )

        def _tamper() -> str:
            dest = tmpdir / "tamper.zip"
            transport.download(f"{base}/tamper/assets/pkg.zip", dest, timeout=5)
            data = dest.read_bytes()
            source = hashlib.sha256(PAYLOAD).hexdigest()
            got = hashlib.sha256(data).hexdigest()
            if len(data) != len(PAYLOAD):
                raise AssertionError(f"长度 {len(data)} != {len(PAYLOAD)}")
            if got == source:
                raise AssertionError("sha256 竟然与源一致（篡改没生效）")
            return (
                f"bytes={len(data)}（同长）sha256 {source[:12]}≠{got[:12]} → 上层 verify 会拒"
            )

        def _asset_ok() -> str:
            dest = tmpdir / "ok.zip"
            transport.download(f"{base}/ok/assets/pkg.zip", dest, timeout=5)
            got = hashlib.sha256(dest.read_bytes()).hexdigest()
            if got != hashlib.sha256(PAYLOAD).hexdigest():
                raise AssertionError("落盘 sha256 与源不一致")
            return f"bytes={dest.stat().st_size} sha256 与源一致"

        probe.run("T-manifest-200", _manifest_ok)
        probe.run("T-etag-304", _etag_304)
        probe.run("T-notfound-404", _notfound)
        probe.run("T-hang-offline", _hang)
        # 先让客户端真打一次 half（产生服务器日志），再核对服务端写的字节数
        probe.observe("T-half-client", _half_client)
        probe.run("T-half-wire", _half_wire)
        probe.run("T-tamper", _tamper)
        probe.run("T-asset-ok", _asset_ok)
    finally:
        guard.uninstall()
        report = guard.report()
        counts = guard.counts()
        server.stop()
        for key, value in originals.items():
            setattr(constants, key, value)

    print(
        f"# server 记录 {len(server.requests)} 次请求，"
        f"status 序列 = {[record['status'] for record in server.requests]}"
    )
    for case_id, verdict, detail in probe.rows:
        print(f"PROBE {case_id:<16} {verdict:<8} {detail}")
    for defect in DEFECTS:
        print(
            f"PROBE-DEFECT {defect['id']} {defect['severity']} {defect['title']} "
            f"ref={defect['ref']}"
        )
    passed = sum(1 for _, verdict, _ in probe.rows if verdict == "PASS")
    observed = sum(1 for _, verdict, _ in probe.rows if verdict == "OBSERVED")
    failed = [case_id for case_id, verdict, _ in probe.rows if verdict == "FAIL"]
    print(
        f"PROBE-SUMMARY {passed} PASS / {observed} OBSERVED / {len(failed)} FAIL  "
        f"zero_egress={{'ok': {report.get('ok')}, "
        f"'external_attempts': {counts.get('external_attempts')}, "
        f"'allowed': {len(report.get('allowed') or [])}, "
        f"'blocked': {len(report.get('blocked') or [])}, "
        f"'dns_blocked': {len(report.get('dns_blocked') or [])}}}  "
        f"bind={server_bind}  defects={len(DEFECTS)}"
    )
    ok = probe.ok and report.get("ok") is True and int(counts.get("external_attempts", -1)) == 0
    print(f"PROBE-EXIT {0 if ok else 1}")
    if args.json is not None:
        summary = {
            "ran_at": _utc_now_iso(),
            "python": sys.version.split()[0],
            "base": base,
            "server_bind": list(server_bind or ()),
            "zero_egress": {
                "ok": bool(report.get("ok")),
                "allowed": len(report.get("allowed") or []),
                "blocked": len(report.get("blocked") or []),
                "dns_blocked": len(report.get("dns_blocked") or []),
                "external_attempts": int(counts.get("external_attempts", -1)),
                "counts": counts,
                "all_allowed_loopback": all(
                    str(entry).startswith("127.0.0.1:") for entry in (report.get("allowed") or [])
                ),
            },
            "cases": [
                {
                    "id": case_id,
                    # 合同 §7 只认 PASS/FAIL/PARTIAL：产品侧观测记 PARTIAL（不是我的交付失败）
                    "verdict": "PARTIAL" if verdict == "OBSERVED" else verdict,
                    "actual": detail,
                }
                for case_id, verdict, detail in probe.rows
            ],
            "defects": DEFECTS,
            "ok": ok,
            "exit_code": 0 if ok else 1,
        }
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
    except Exception:                                                  # noqa: BLE001
        pass
    raise SystemExit(main())
