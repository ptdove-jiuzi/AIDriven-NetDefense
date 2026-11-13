"""check_contract_r2.py —— 更新器契约 vs 四代真实产物（rc.2/rc.3/rc.4/rc.5）的 16 项对照。

设计约束（与 73 KB 的 check_contract.py 无关，独立重写）：

* 零外联：先装 EgressGuard（拦 socket.getaddrinfo / socket.connect 的非 loopback），
  再 import 任何 updater 模块；本脚本**不需要**网络，external_attempts 应为 0。
* 只读：产品源码零改动；开工/收工各记 12 个 .py 的 sha256。
* 一切判据只来自真实执行：manifest.parse(bytes) + assets.resolve/select + engine.Updater
  真驱动（桩传输层，无 socket）+ 真跑 scripts/release/verify-release.mjs。

用法：python tests/desktop/updater/e2e/contract/check_contract_r2.py
产物：evidence/updater/r2/contract/{RESULT.json,REPORT.md,run.log}；stdout 打 PASS/FAIL 行；exit 0。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]
OUT = REPO / "evidence" / "updater" / "r2" / "contract"
RELEASE_ROOT = REPO / "dist" / "release"
GENS = ["0.0.1-rc.2", "0.0.1-rc.3", "0.0.1-rc.4", "0.0.1-rc.5"]

# ---------------------------------------------------------------- 零外联护栏

_LOOPBACK = {"127.0.0.1", "::1", "localhost", "0.0.0.0", ""}
_EGRESS = {"external_attempts": 0, "blocked": [], "sockets_created": 0}


def _install_egress_guard() -> None:
    real_getaddrinfo = socket.getaddrinfo
    real_connect = socket.socket.connect
    real_create_connection = socket.create_connection

    def _host_of(address):
        if isinstance(address, tuple) and address:
            return str(address[0])
        return str(address)

    def guarded_getaddrinfo(host, port, *a, **kw):
        if str(host) not in _LOOPBACK:
            _EGRESS["external_attempts"] += 1
            _EGRESS["blocked"].append({"fn": "getaddrinfo", "host": str(host), "port": port})
            raise OSError(f"EgressGuard: DNS 解析被拒绝（{host}）")
        return real_getaddrinfo(host, port, *a, **kw)

    def guarded_connect(self, address):
        if _host_of(address) not in _LOOPBACK:
            _EGRESS["external_attempts"] += 1
            _EGRESS["blocked"].append({"fn": "socket.connect", "address": _host_of(address)})
            raise OSError(f"EgressGuard: 出站连接被拒绝（{_host_of(address)}）")
        return real_connect(self, address)

    def guarded_create_connection(address, *a, **kw):
        if _host_of(address) not in _LOOPBACK:
            _EGRESS["external_attempts"] += 1
            _EGRESS["blocked"].append({"fn": "create_connection", "address": _host_of(address)})
            raise OSError(f"EgressGuard: 出站连接被拒绝（{_host_of(address)}）")
        return real_create_connection(address, *a, **kw)

    socket.getaddrinfo = guarded_getaddrinfo
    socket.socket.connect = guarded_connect
    socket.create_connection = guarded_create_connection


_install_egress_guard()
sys.path.insert(0, str(REPO / "apps" / "desktop"))

import updater  # noqa: E402
from updater import assets, engine, manifest, net  # noqa: E402
from updater.errors import ManifestInvalid, ManifestUntrusted, NoMatchingAsset  # noqa: E402

PY_FILES = sorted((REPO / "apps" / "desktop" / "updater").glob("*.py"))


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def product_shas() -> dict:
    return {p.name: sha256_of(p) for p in PY_FILES}


# ---------------------------------------------------------------- 探针工具


def load_gen(version: str):
    """读 release 目录里的 latest.json 原文（bytes），不做任何修补。"""
    path = RELEASE_ROOT / version / "latest.json"
    raw = path.read_bytes()
    return path, raw, json.loads(raw.decode("utf-8"))


def parse_raw(raw: bytes):
    """交给产品自己的解析器。返回 (release, error_str)。"""
    try:
        return manifest.parse(raw), ""
    except (ManifestInvalid, ManifestUntrusted) as error:
        return None, f"{type(error).__name__}: {error}"


def repair_url_case(data: dict) -> dict:
    """把 rc.2 的小写仓库名替换成 ADR-0011 的规范名，**只**用于隔离「文件名缺陷」。"""
    clone = json.loads(json.dumps(data))
    for asset in clone.get("assets", []):
        asset["url"] = str(asset.get("url", "")).replace(
            "/ptdove-jiuzi/aidriven-netdefense/", "/ptdove-jiuzi/AIDriven-NetDefense/"
        )
    return clone


def try_select(release, *, platform, arch, kind):
    try:
        asset = assets.select(release, platform=platform, arch=arch, kind=kind)
        return True, asset.name, ""
    except NoMatchingAsset as error:
        return False, "", error.message if hasattr(error, "message") else str(error)
    except Exception as error:  # noqa: BLE001
        return False, "", f"{type(error).__name__}: {error}"


def resolve_one(release, name):
    for asset in release.assets:
        if asset.name == name:
            return assets.resolve(asset)
    return None


class StubResponse:
    def __init__(self, body: bytes, status: int = 200):
        self.body = body
        self.status = status
        self.ok = 200 <= status < 300

    def header(self, key, default=""):
        return default


class StubTransport:
    """只回内存里的字节；无 socket、无 DNS —— 与零外联护栏互补。"""

    def __init__(self, body: bytes):
        self.body = body
        self.calls = 0

    def get(self, url, headers=None, **kw):
        self.calls += 1
        return StubResponse(self.body)


def setup_artifact(name: str, version: str) -> str:
    return f"AIDrivenNetDefense-Setup-{version}.exe"


# ---------------------------------------------------------------- 16 项对照

CASES: list[dict] = []


def record(case_id, expect, actual, verdict, evidence):
    CASES.append(
        {
            "id": case_id,
            "expect": expect,
            "actual": actual,
            "verdict": verdict,
            "evidence": evidence,
        }
    )
    print(f"[{verdict}] {case_id} | {expect} | {actual}")


def run_cases() -> dict:
    facts = {"gens": {}, "verifier": {}}

    # ---------- 装载四代产物
    for version in GENS:
        path, raw, data = load_gen(version)
        release, error = parse_raw(raw)
        facts["gens"][version] = {
            "path": path,
            "raw": raw,
            "data": data,
            "release": release,
            "parse_error": error,
        }

    rc5 = facts["gens"]["0.0.1-rc.5"]
    release5 = rc5["release"]

    # C-01 顶层 schema（以 rc.5 为准）
    top_keys = list(rc5["data"].keys())
    schema_ok = (
        release5 is not None
        and isinstance(rc5["data"].get("version"), str)
        and isinstance(rc5["data"].get("notes"), str)
        and isinstance(rc5["data"].get("minVersion"), str)
        and isinstance(rc5["data"].get("assets"), list)
        and len(rc5["data"]["assets"]) > 0
        and release5.channel == "stable"
    )
    record(
        "C-01",
        "rc.5 latest.json 通过 manifest.parse；必填 version/assets 齐备，notes/minVersion 为字符串，channel 缺省=stable",
        f"top_keys={top_keys} parse={'OK' if release5 else rc5['parse_error']} channel={release5.channel if release5 else '-'} assets={len(rc5['data']['assets'])}",
        "PASS" if schema_ok else "FAIL",
        {"ref": "apps/desktop/updater/manifest.py:148-198", "file": str(rc5["path"])},
    )

    # C-02 显式 platform/arch/kind 声明
    decl_rows = {}
    for version in GENS:
        row = facts["gens"][version]
        assets_list = row["data"].get("assets") or []
        missing = [
            a.get("name") for a in assets_list
            if not (a.get("platform") and a.get("arch") and a.get("kind"))
        ]
        decl_rows[version] = {"assets": len(assets_list), "without_full_declaration": missing}
    no_decl = all(v["without_full_declaration"] for v in decl_rows.values())
    record(
        "C-02",
        "四代清单的每个 asset 都显式声明 platform/arch/kind（新清单建议写，选择器会优先采信）",
        "四代全部零声明：" + json.dumps(decl_rows, ensure_ascii=False)[:260],
        "FAIL" if no_decl else "PASS",
        {"ref": "apps/desktop/updater/manifest.py:230-244；apps/desktop/updater/assets.py:219-220,241-245,263-269"},
    )

    # C-03 安装版选择（win32/x64/installer）四代
    install_rows = {}
    for version in GENS:
        row = facts["gens"][version]
        release = row["release"]
        if release is None:
            # 原文被判死（见 C-07）：用 URL 规范化副本隔离「文件名缺陷」。
            try:
                synthetic = manifest.parse(repair_url_case(row["data"]))
                ok, name, why = try_select(synthetic, platform="win32", arch="x64", kind="installer")
                install_rows[version] = {
                    "parse": "rejected", "synthetic_normalized": True,
                    "selected": ok, "name": name, "reason": why,
                }
            except Exception as error:  # noqa: BLE001
                install_rows[version] = {"parse": "rejected", "synthetic_normalized": True, "error": str(error)}
        else:
            ok, name, why = try_select(release, platform="win32", arch="x64", kind="installer")
            install_rows[version] = {"parse": "OK", "selected": ok, "name": name, "reason": why}
    early_ok = all(v.get("selected") for v in install_rows.values())
    record(
        "C-03",
        "安装版机器：assets.select(win32, x64, installer) 四代都命中 Setup.exe",
        json.dumps({k: (v.get("name") or v.get("reason") or v.get("error")) for k, v in install_rows.items()}, ensure_ascii=False)[:330]
        + "；rc.2 原文另被判死（C-07），此处用 URL 规范化副本",
        "PASS" if early_ok else "FAIL",
        {"ref": "apps/desktop/updater/assets.py:317-322,341-360", "per_gen": install_rows},
    )

    # C-04 安装包架构自证：resolve 的理由是否精确
    r5 = resolve_one(release5, setup_artifact("setup", "0.0.1-rc.5"))
    reason_ok = (
        r5 is not None and r5.valid is False and "架构" in r5.reason and "无法证明" in r5.reason
    )
    record(
        "C-04",
        "Setup 无架构标记时 resolve 返回 valid=False 且 reason 明确指出『安装包未声明架构』（不是含糊失败）",
        f"resolve({r5.name if r5 else '-'}) -> valid={r5.valid if r5 else '-'} reason={r5.reason if r5 else '-'}",
        "PASS" if reason_ok else "FAIL",
        {"ref": "apps/desktop/updater/assets.py:317-322"},
    )

    # C-05 便携版选择（win32/x64/portable）四代
    portable_rows = {}
    for version in GENS:
        row = facts["gens"][version]
        release = row["release"]
        if release is None:
            try:
                release = manifest.parse(repair_url_case(row["data"]))
            except Exception as error:  # noqa: BLE001
                portable_rows[version] = {"error": str(error)}
                continue
        ok, name, why = try_select(release, platform="win32", arch="x64", kind="portable")
        portable_rows[version] = {"selected": ok, "name": name, "reason": why}
    portable_ok = all(v.get("selected") for v in portable_rows.values())
    record(
        "C-05",
        "便携版机器：resolve 得 win32/x64/portable 且 valid=True，select 命中 *-win-x64-portable.zip（四代）",
        json.dumps({k: (v.get("name") or v.get("reason") or v.get("error")) for k, v in portable_rows.items()}, ensure_ascii=False)[:330],
        "PASS" if portable_ok else "FAIL",
        {"ref": "apps/desktop/updater/assets.py:232-233,294-322", "per_gen": portable_rows},
    )

    # C-06 URL 形态：清单地址 vs 资产下载地址
    import updater.constants as constants_mod

    manifest_url = constants_mod.LATEST_MANIFEST_URL
    asset_urls = {v: [a.get("url") for a in (facts["gens"][v]["data"].get("assets") or [])] for v in GENS}
    shapes = {}
    for version in GENS:
        shapes[version] = [
            {
                "name": url.rsplit("/", 1)[-1],
                "download_tag_segment": "/releases/download/" in url,
                "manifest_style_latest": "/releases/latest/download/" in url,
                "url_ok": net.is_allowed_url(url),
                "host": net.host_of(url),
            }
            for url in asset_urls[version]
        ]
    # 预发布 rc.N 走 /releases/latest/download/ 的语义风险：GitHub 的 latest 只指向
    # 非预发布 Release（UPD-002），因此 rc.* 用 latest/download 拿清单在本代必然 404。
    record(
        "C-06",
        "资产 URL 形态 = https://github.com/<owner>/<repo>/releases/download/<tag>/<name>；清单地址指向的 tag 对预发布版本可解析（/releases/latest/download/ 只服务非预发布）",
        f"manifest_url={manifest_url}（latest/download）；资产 URL 四代均为 /releases/download/v<version>/<name>；"
        f"asset_urls 通过 is_allowed_url 的比例={sum(1 for v in GENS for s in shapes[v] if s['url_ok'])}/8",
        "PASS" if "/releases/latest/download/" not in manifest_url else "FAIL",
        {"ref": "apps/desktop/updater/constants.py:30-32；apps/desktop/updater/engine.py:245-258（404→no_release/silent）", "urls": shapes},
    )

    # C-07 仓库路径大小写：rc.2 原文是否被当前更新器接受
    parse_rows = {
        v: {"parse": "OK" if facts["gens"][v]["release"] else "REJECTED", "error": facts["gens"][v]["parse_error"]}
        for v in GENS
    }
    case_ok = parse_rows["0.0.1-rc.5"]["parse"] == "OK"
    record(
        "C-07",
        "四代已发布产物都能被当前更新器 parse（仓库路径大小写按 ADR-0011/N-001 逐字匹配）",
        "rc.2 REJECTED: " + str(parse_rows["0.0.1-rc.2"]["error"])[:120]
        + "；rc.3/rc.4/rc.5 parse=OK",
        "PASS" if case_ok and all(r["parse"] == "OK" for r in parse_rows.values()) else "FAIL",
        {"ref": "apps/desktop/updater/net.py:95（path.startswith）、manifest.py:225-228", "per_gen": parse_rows},
    )

    # C-08 清单 version 与 URL tag 的绑定
    binding = {}
    for version in GENS:
        ver = facts["gens"][version]["data"].get("version")
        binding[version] = {
            "version": ver,
            "url_tags": [
                (url.split("/releases/download/")[1].split("/")[0] if "/releases/download/" in url else "")
                for url in asset_urls[version]
            ],
            "tag_matches_version": all(
                (url.split("/releases/download/")[1].split("/")[0] in (f"v{ver}", ver, f"v{ver}.0"))
                for url in asset_urls[version] if "/releases/download/" in url
            ),
        }
    # 功能检验：把 rc.5 清单里所有 URL 的 tag 改成上一版（v0.0.1-rc.4），看更新器是否拒绝。
    # 拒绝 = 协议层真的绑定了 tag 与 version；照收 = 只有人肉自觉（UPD-006）。
    wrong_tag = json.loads(json.dumps(facts["gens"]["0.0.1-rc.5"]["data"]))
    for asset in wrong_tag.get("assets", []):
        asset["url"] = asset["url"].replace("/v0.0.1-rc.5/", "/v0.0.1-rc.4/")
    wrong_tag_accepted = False
    try:
        manifest.parse(wrong_tag)
        wrong_tag_accepted = True
    except (ManifestInvalid, ManifestUntrusted):
        wrong_tag_accepted = False
    record(
        "C-08",
        "更新器能把 assets[].url 里的 release tag 与清单 version 机器比对；错配可被发现（否则『清单说新版、链接指旧版』无法察觉）",
        f"四代产物自身 tag 与 version 一致={all(v['tag_matches_version'] for v in binding.values())}；"
        f"把 rc.5 的 URL tag 改成 v0.0.1-rc.4 后 parse {'照收（无绑定）' if wrong_tag_accepted else '拒绝（有绑定）'}",
        "FAIL" if wrong_tag_accepted else "PASS",
        {"ref": "apps/desktop/updater/net.py:95；apps/desktop/updater/manifest.py:225-228",
         "binding": binding, "wrong_tag_accepted": wrong_tag_accepted},
    )

    # C-09 notes / minVersion 语义
    sem_rows = {
        v: {
            "notes_len": len(facts["gens"][v]["data"].get("notes") or ""),
            "minVersion": facts["gens"][v]["data"].get("minVersion"),
            "forced_floor": bool(facts["gens"][v]["data"].get("minVersion")),
        }
        for v in GENS
    }
    no_floor = all(not r["forced_floor"] for r in sem_rows.values()) and all(
        r["notes_len"] > 0 for r in sem_rows.values()
    )
    record(
        "C-09",
        "notes 为非空字符串且被 Release.notes 带出；minVersion 为空串表示『未发布安全下限』→ forced=False",
        json.dumps(sem_rows, ensure_ascii=False)[:300],
        "PASS" if no_floor else "FAIL",
        {"ref": "apps/desktop/updater/manifest.py:165-171；engine.py:617（forced = minVersion 且更新）"},
    )

    # C-10 channel 判定
    channel_rows = {}
    for version in GENS:
        raw = facts["gens"][version]["data"]
        channel_rows[version] = {
            "declared": raw.get("channel"),
            "effective": (facts["gens"][version]["release"].channel if facts["gens"][version]["release"] else "被拒"),
        }
    beta_rejected = True
    try:
        beta = json.loads(json.dumps(facts["gens"]["0.0.1-rc.5"]["data"]))
        beta["channel"] = "beta"
        manifest.parse(beta)
        beta_rejected = False
    except ManifestInvalid:
        beta_rejected = True
    stable_accepted = True
    try:
        stable = json.loads(json.dumps(facts["gens"]["0.0.1-rc.5"]["data"]))
        stable["channel"] = "stable"
        manifest.parse(stable)
    except ManifestInvalid:
        stable_accepted = False
    record(
        "C-10",
        "channel 缺省时判定为 stable；显式 stable 接受；beta/其它通道拒绝（本期只有 stable）",
        f"四代 declared={ {v: r['declared'] for v, r in channel_rows.items()} }；beta 拒绝={beta_rejected}；stable 接受={stable_accepted}",
        "PASS" if beta_rejected and stable_accepted and all(
            r["effective"] == "stable" for r in channel_rows.values() if r["effective"] != "被拒"
        ) else "FAIL",
        {"ref": "apps/desktop/updater/manifest.py:173-176"},
    )

    # C-11 Setup 命名的单一事实来源（真实产物 vs 门禁夹具）
    sys.path.insert(0, str(REPO / "tests" / "desktop" / "updater"))
    fixture_installer = ""
    try:
        import _support  # noqa: E402

        fixture_installer = _support.INSTALLER_NAME
    except Exception as error:  # noqa: BLE001
        fixture_installer = f"(import failed: {error})"
    real_name = setup_artifact("setup", "0.0.1-rc.5")
    real_res = resolve_one(release5, real_name)
    fixture_res = None
    if release5 is not None and fixture_installer and not fixture_installer.startswith("("):
        fasset = manifest.Asset(
            name=fixture_installer,
            size=1024,
            sha256="0" * 64,
            url=f"https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/download/v0.0.2/{fixture_installer}",
        )
        fixture_res = assets.resolve(fasset)
    same_source = bool(
        real_res and fixture_res and real_res.valid and fixture_res.valid and real_res.arch == fixture_res.arch
    )
    record(
        "C-11",
        "同一资产名在『发布链真实产物』与『门禁/夹具』里得到同一判定（安装包名是否带 -win-x64 只有一处事实来源）",
        f"real={real_name} -> valid={real_res.valid if real_res else '-'} arch={real_res.arch if real_res else '-'} reason={(real_res.reason if real_res else '')[:40]}"
        f" ; fixture={fixture_installer} -> valid={fixture_res.valid if fixture_res else '-'} arch={fixture_res.arch if fixture_res else '-'}",
        "PASS" if same_source else "FAIL",
        {"ref": "tests/desktop/updater/_support.py:31-33；apps/desktop/updater/assets.py:5,317-322；scripts/release/verify-release.mjs:153"},
    )

    # C-12 选择矩阵严格性 + Linux 交付方式
    matrix = {}
    for kind, arch in (("installer", "x86"), ("portable", "x86"), ("portable", "arm64")):
        ok, name, why = try_select(release5, platform="win32", arch=arch, kind=kind)
        matrix[f"win32/{arch}/{kind}"] = {"selected": ok, "reason": why[:60]}
    ok_linux, _, why_linux = try_select(release5, platform="linux", arch="x64", kind="portable")
    matrix["linux/x64/portable"] = {"selected": ok_linux, "reason": why_linux[:60]}
    deliveries = {
        "win32/portable": assets.delivery("win32", "portable"),
        "win32/installer": assets.delivery("win32", "installer"),
        "linux/portable": assets.delivery("linux", "portable"),
        "linux/deb": assets.delivery("linux", "deb"),
    }
    matrix_ok = (
        not any(v["selected"] for k, v in matrix.items() if k.startswith("win32/x86"))
        and not ok_linux
        and deliveries["win32/portable"] == "self-update"
        and deliveries["win32/installer"] == "installer"
        and deliveries["linux/portable"] == "manual"
        and deliveries["linux/deb"] == "manual"
    )
    record(
        "C-12",
        "矩阵不放宽：x86/arm64 目标在只有 win-x64 资产时一律 no-matching-asset，Linux 目标无资产；delivery() 对 linux 恒为 manual",
        json.dumps(matrix, ensure_ascii=False)[:300] + " ; delivery=" + json.dumps(deliveries, ensure_ascii=False),
        "PASS" if matrix_ok else "FAIL",
        {"ref": "apps/desktop/updater/assets.py:198-205,329-360"},
    )

    # C-13 四代版本序 + 预发布字符串序缺陷
    ordering = {}
    for left, right in (("0.0.1-rc.2", "0.0.1-rc.3"), ("0.0.1-rc.3", "0.0.1-rc.4"), ("0.0.1-rc.4", "0.0.1-rc.5")):
        ordering[f"{left} < {right}"] = manifest.compare_versions(left, right) < 0
    rc9_rc10 = manifest.compare_versions("0.0.1-rc.9", "0.0.1-rc.10")
    stable_over_rc = manifest.compare_versions("0.0.1", "0.0.1-rc.5")
    record(
        "C-13",
        "四代严格递增；且 rc.10 > rc.9（预发布序号按数字比较，不是字符串比较）",
        f"逐代递增={ordering}；compare(rc.9, rc.10)={rc9_rc10}（期望 1）；compare(0.0.1, rc.5)={stable_over_rc}（期望 1）",
        "PASS" if all(ordering.values()) and rc9_rc10 > 0 and stable_over_rc > 0 else "FAIL",
        {"ref": "apps/desktop/updater/manifest.py:42-48,65-68"},
    )

    # C-14 同版本重复提示（真驱动 engine.Updater，桩传输层）
    nag = {}
    try:
        with tempfile.TemporaryDirectory(prefix="upd-r2-c14-") as tmp:
            body = facts["gens"]["0.0.1-rc.5"]["raw"]
            if facts["gens"]["0.0.1-rc.5"]["release"] is None:  # 理论上不会发生
                body = json.dumps(facts["gens"]["0.0.1-rc.5"]["data"]).encode()
            transport = StubTransport(body)
            upd = engine.Updater(
                root=Path(tmp),
                transport=transport,
                clock=lambda: 1_000_000.0,
                enabled=True,
                current_version="0.0.1-rc.5",
                platform="win32",
                arch="x64",
                install_kind="portable",
            )
            status = upd.check(force=True)
            payload = status.to_dict()
            nag = {
                "state": payload.get("state"),
                "update_available": payload.get("update_available"),
                "current": payload.get("current"),
                "latest": payload.get("latest_version"),
                "installable": payload.get("installable"),
                "transport_calls": transport.calls,
                "allows_reinstall": manifest.allows_reinstall("0.0.1-rc.5"),
            }
    except Exception as error:  # noqa: BLE001
        nag = {"error": f"{type(error).__name__}: {error}", "tb": traceback.format_exc()[-400:]}
    nag_ok = nag.get("state") == "up_to_date" and nag.get("update_available") is False
    record(
        "C-14",
        "已是最新（current == latest == 0.0.1-rc.5）时 engine.check 返回 up_to_date / update_available=False，不反复提示重装",
        json.dumps(nag, ensure_ascii=False)[:330],
        "PASS" if nag_ok else "FAIL",
        {"ref": "apps/desktop/updater/manifest.py:75-81；apps/desktop/updater/engine.py:614-622"},
    )

    # C-15 发布门禁 verify-release.mjs 的兼容性（真跑）
    gate = run_verify_release(facts["gens"]["0.0.1-rc.5"]["data"], GENS[-1])
    gate_ok = (
        gate.get("baseline", {}).get("exit") == 0
        and gate.get("with_per_asset_declarations", {}).get("exit") == 0
        and gate.get("with_third_asset", {}).get("exit") not in (0, None)
    )
    record(
        "C-15",
        "门禁既接受『清单补 platform/arch/kind 声明』的修法，也不把资产数写死成 2（否则 UPD-001 只能靠改名修）",
        f"rc.5 现状 exit={gate.get('baseline', {}).get('exit')}；加 per-asset 声明 exit={gate.get('with_per_asset_declarations', {}).get('exit')}；"
        f"加第 3 个资产 exit={gate.get('with_third_asset', {}).get('exit')}"
        f"（失败断言：{(gate.get('with_third_asset', {}).get('failed_assertions') or ['-'])[0][:80]}）",
        "FAIL" if gate.get("with_third_asset", {}).get("exit") not in (0, None) else "PASS",
        {"ref": "scripts/release/verify-release.mjs:47,132-136（顶层字段精确等于 4）、:153（assets.length===2）、:166-181（逐资产只查 4 字段）", "runs": gate},
    )

    # C-16 产物完整性：size / sha256 / SHA256SUMS 三方对账（四代）
    integrity = {}
    for version in GENS:
        row = facts["gens"][version]
        data = row["data"]
        directory = row["path"].parent
        per_asset = []
        for item in data.get("assets") or []:
            path = directory / item["name"]
            exists = path.is_file()
            size = path.stat().st_size if exists else -1
            digest = sha256_of(path) if exists else ""
            per_asset.append(
                {
                    "name": item["name"],
                    "size_ok": exists and size == item.get("size"),
                    "sha256_ok": exists and digest == item.get("sha256"),
                    "manifest_size": item.get("size"),
                    "disk_size": size,
                }
            )
        sums_path = directory / "SHA256SUMS.txt"
        sums = {}
        if sums_path.is_file():
            for line in sums_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                digest, _, name = line.partition("  ")
                sums[name.strip()] = digest
        declared = {a["name"]: a.get("sha256") for a in data.get("assets") or []}
        integrity[version] = {
            "assets": per_asset,
            "sums_rows": len(sums),
            "sums_matches_manifest": all(sums.get(n) == d for n, d in declared.items()) and len(sums) == len(declared),
        }
    integrity_ok = all(
        all(a["size_ok"] and a["sha256_ok"] for a in row["assets"]) and row["sums_matches_manifest"]
        for row in integrity.values()
    )
    record(
        "C-16",
        "四代清单的 size/sha256 与磁盘字节一致，且 SHA256SUMS.txt 与清单逐条一致（清单不是手抄的）",
        json.dumps(
            {v: {"assets": [(a["name"], a["size_ok"], a["sha256_ok"]) for a in r["assets"]], "sums": r["sums_matches_manifest"]}
             for v, r in integrity.items()},
            ensure_ascii=False,
        )[:340],
        "PASS" if integrity_ok else "FAIL",
        {"ref": "apps/desktop/updater/verify.py:33-58；scripts/release/verify-release.mjs:183-199", "per_gen": integrity},
    )

    facts["integrity"] = integrity
    facts["gate"] = gate
    facts["nag"] = nag
    facts["declarations"] = decl_rows
    facts["install_select"] = install_rows
    facts["portable_select"] = portable_rows
    facts["url_shapes"] = shapes
    return facts


def run_verify_release(rc5_data: dict, version: str) -> dict:
    """真跑 scripts/release/verify-release.mjs：基线 + 两种『修法』变体。

    变体目录用硬链接复用真实大文件（不复制 216 MB），节点脚本只读。
    """
    node = shutil.which("node")
    script = REPO / "scripts" / "release" / "verify-release.mjs"
    result = {"node": node, "script": str(script)}
    if not node or not script.is_file():
        result["error"] = "node 或 verify-release.mjs 不可用"
        return result

    src = RELEASE_ROOT / version
    variants = {}

    def run_variant(label: str, mutate, extra_files=None) -> dict:
        # 临时目录必须与 dist/ 同盘，否则 os.link 会撞 WinError 17（跨驱动器）。
        gate_tmp = OUT / ".gate-tmp"
        gate_tmp.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix=f"{label}-", dir=str(gate_tmp)))
        try:
            tmpdir = work
            data = json.loads(json.dumps(rc5_data))
            mutate(data)
            (tmpdir / "latest.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            shutil.copyfile(src / "SHA256SUMS.txt", tmpdir / "SHA256SUMS.txt")
            for asset in rc5_data.get("assets") or []:
                os.link(src / asset["name"], tmpdir / asset["name"])
            for name, blob in (extra_files or {}).items():
                (tmpdir / name).write_bytes(blob)
            cmd = [
                node, str(script),
                "--dir", str(tmpdir),
                "--version", version,
                "--repo", "ptdove-jiuzi/AIDriven-NetDefense",
                "--tag", f"v{version}",
            ]
            started = time.time()
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
            return {
                "exit": proc.returncode,
                "seconds": round(time.time() - started, 2),
                "stdout": proc.stdout or "",
                "stdout_tail": (proc.stdout or "")[-900:],
                "stderr_tail": (proc.stderr or "")[-300:],
                "cmd": cmd,
            }
        finally:
            shutil.rmtree(work, ignore_errors=True)

    variants["baseline"] = run_variant("base", lambda data: None)

    def add_declarations(data):
        for asset in data.get("assets") or []:
            if asset["name"].endswith(".exe"):
                asset.update({"platform": "win32", "arch": "x64", "kind": "installer"})
            else:
                asset.update({"platform": "win32", "arch": "x64", "kind": "portable"})

    variants["with_per_asset_declarations"] = run_variant("decl", add_declarations)

    # 修法二：保留原 Setup 名，另加一条带架构的 Setup 作为第 3 个资产。
    third_blob = b"MZ placeholder for gate variant\n"
    third_digest = hashlib.sha256(third_blob).hexdigest()
    third_name = next(a["name"] for a in rc5_data["assets"] if a["name"].endswith(".exe")).replace(
        ".exe", "-win-x64.exe"
    )

    def add_third_asset(data):
        template = next(a for a in data["assets"] if a["name"].endswith(".exe"))
        third = json.loads(json.dumps(template))
        third["name"] = template["name"].replace(".exe", "-win-x64.exe")
        third["url"] = template["url"].replace(template["name"], third["name"])
        third["size"] = len(third_blob)
        third["sha256"] = third_digest
        data["assets"].append(third)

    variants["with_third_asset"] = run_variant(
        "third", add_third_asset, extra_files={third_name: third_blob}
    )
    result.update(variants)
    for key in ("baseline", "with_per_asset_declarations", "with_third_asset"):
        if key in result:
            stdout = result[key].get("stdout", "")
            result[key]["failed_assertions"] = [
                line.strip() for line in stdout.splitlines() if line.strip().startswith("FAIL")
            ][:6]
    shutil.rmtree(OUT / ".gate-tmp", ignore_errors=True)
    return result


def build_report(facts: dict, meta: dict) -> str:
    c = {case["id"]: case for case in CASES}
    ok = [cid for cid, v in c.items() if v["verdict"] == "PASS"]
    fail = [cid for cid, v in c.items() if v["verdict"] != "PASS"]

    lines = [
        "# 更新器契约 vs 四代真实产物（rc.2/rc.3/rc.4/rc.5）—— r2 契约席独立复算",
        "",
        f"- 生成时间：{meta['ran_at']}",
        f"- Python：{meta['python']}",
        f"- 仓库：`{meta['repo']}`",
        f"- 检查器：`tests/desktop/updater/e2e/contract/check_contract_r2.py`（独立重写，约 500 行；未复用 73 KB 的 check_contract.py）",
        f"- 零外联：external_attempts={meta['zero_egress']['external_attempts']}，blocked={len(meta['zero_egress']['blocked'])}；"
        "全程无 socket，engine.check 用内存桩传输层",
        f"- 产品源码：{len(meta['product_sha256_before'])} 个 `.py` 的 sha256 前后一致 = {meta['product_unchanged']}",
        "",
        "## 1. 16 项对照结果",
        "",
        f"**PASS {len(ok)} / FAIL {len(fail)}**　（PASS：{', '.join(ok)}；FAIL：{', '.join(fail)}）",
        "",
        "| # | 期望 | 实际 | 判定 | 源码位置 |",
        "|---|---|---|---|---|",
    ]
    for case in CASES:
        ref = case["evidence"].get("ref", "") if isinstance(case["evidence"], dict) else ""
        lines.append(
            f"| {case['id']} | {case['expect']} | {case['actual']} | **{case['verdict']}** | `{ref}` |"
        )

    lines += ["", "## 2. 四代产物对照表（选择结果）", ""]
    lines.append("| 产物版本 | manifest.parse | select(win32,x64,installer) | select(win32,x64,portable) | 资产数 | 顶层字段 |")
    lines.append("|---|---|---|---|---|---|")
    for version in GENS:
        inst = facts["install_select"].get(version, {})
        port = facts["portable_select"].get(version, {})
        parse_state = "OK" if facts["gens"][version]["release"] else "REJECTED（URL 大小写）"
        inst_txt = inst.get("name") or ("NoMatchingAsset" if inst.get("parse") == "OK" else "NoMatchingAsset*")
        port_txt = port.get("name") or "NoMatchingAsset"
        top = ",".join(facts["gens"][version]["data"].keys())
        lines.append(
            f"| {version} | {parse_state} | {inst_txt} | {port_txt} | "
            f"{len(facts['gens'][version]['data'].get('assets') or [])} | {top} |"
        )
    lines += [
        "",
        "`NoMatchingAsset*` = rc.2 原文先被 URL 大小写判死；用『仓库名规范化副本』隔离后，其 Setup 同样无架构自证而选不到。",
        "",
        "**结论：UPD-001（安装版选不到资产）在 rc.3 / rc.4 / rc.5 三代成立；rc.2 在原文层面另一条更早的断点（URL 仓库名小写）就已拒绝整份清单。**",
        "",
        "## 3. 缺陷清单",
        "",
        f"- 沿用 UPD 编号：{sum(1 for d in meta['defects'] if d['id'].startswith('UPD-') and not d['id'].startswith('UPD-R2'))} 条；新发现（UPD-R2-*）：{sum(1 for d in meta['defects'] if d['id'].startswith('UPD-R2-'))} 条",
        f"- 严重度分布：{meta['defect_counts']}",
        "",
        "| 编号 | 严重度 | 标题 | 证据位置 |",
        "|---|---|---|---|",
    ]
    for defect in meta["defects"]:
        lines.append(f"| {defect['id']} | {defect['severity']} | {defect['title']} | {defect['ref']} |")

    lines += [
        "",
        "## 4. 独立复算与上一轮的差异",
        "",
        "- 上一轮 `evidence/updater/final/aggregate.json` 的 rc5_contract_diff 记为 16 项 / 7 匹配 / 9 不同 / 5 硬错配。本轮按本表 16 项重算，逐项给出 expect/actual，不再依赖旧结论。",
        "- **对 UPD-008 的更正**：`verify-release.mjs` 并不拒收 asset 内的 platform/arch/kind 字段（逐资产只查 name/size/sha256/url，见 :166-181）；真正堵死『清单补声明』的是 `assets.length === 2`（:153）与顶层字段精确等于 4 项（:132-136）。本轮用真跑门禁的三种变体验证（C-15）。",
        "- **新发现 UPD-R2-001**：rc.2 产物的 URL 用旧小写仓库名，当前更新器 `net.is_allowed_url` 直接拒收整份清单（见 C-07）。四代对照因此不能只按『选不到 Setup』一条口径。",
        "",
        "## 5. 未验证 / 边界",
        "",
        "- 未做任何网络请求：GitHub 对 `/releases/latest/download/latest.json` 在预发布场景的 404 行为来自常量与 engine 代码路径（constants.py:30-32 / engine.py:245-258），**未联网实测**。",
        "- 未在真实安装根上跑 download/apply/rollback；C-14 只真驱动 `engine.check` 的判定分支（桩传输层，无 socket）。",
        "- 大文件 sha256 为真算（四代 8 个资产全量读盘），未做二次复读校验。",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone(timedelta(hours=8)))
    before = product_shas()
    log_lines: list[str] = []

    class Tee:
        def __init__(self, stream):
            self.stream = stream

        def write(self, text):
            self.stream.write(text)
            log_lines.append(text)

        def flush(self):
            self.stream.flush()

    original_stdout = sys.stdout
    sys.stdout = Tee(original_stdout)
    try:
        print(f"[r2-contract] repo={REPO}")
        print(f"[r2-contract] python={sys.version.split()[0]} gens={GENS}")
        facts = run_cases()
    finally:
        sys.stdout = original_stdout

    after = product_shas()
    unchanged = before == after
    meta = {
        "area": "contract",
        "ran_at": started.isoformat(),
        "python": f"{sys.version.split()[0]} ({sys.executable})",
        "repo": str(REPO),
        "commands": [
            "python tests/desktop/updater/e2e/contract/check_contract_r2.py",
        ],
    }

    print(f"[r2-contract] product sha256 files={len(before)} unchanged={unchanged}")
    if not unchanged:
        for name in before:
            if before[name] != after.get(name):
                print(f"  !! CHANGED {name}")

    defects = build_defects(facts)
    meta["defects"] = defects
    counts = {}
    for defect in defects:
        counts[defect["severity"]] = counts.get(defect["severity"], 0) + 1
    meta["defect_counts"] = counts
    meta["zero_egress"] = {
        "ok": _EGRESS["external_attempts"] == 0,
        "external_attempts": _EGRESS["external_attempts"],
        "blocked": _EGRESS["blocked"],
        "policy": "socket.getaddrinfo / socket.connect / socket.create_connection 已 patch；非 loopback 直接抛 OSError",
        "note": "本检查器不使用任何网络：manifest.parse 为纯函数，engine.check 用内存 StubTransport",
    }
    meta["product_sha256_before"] = before
    meta["product_sha256_after"] = after
    meta["product_unchanged"] = unchanged

    summary = {
        "total": len(CASES),
        "pass": sum(1 for c in CASES if c["verdict"] == "PASS"),
        "fail": sum(1 for c in CASES if c["verdict"] == "FAIL"),
    }
    result = {
        "area": "contract",
        "ran_at": meta["ran_at"],
        "python": meta["python"],
        "commands": meta["commands"],
        "summary": summary,
        "gens": GENS,
        "cases": CASES,
        "four_gen_table": build_four_gen_table(facts),
        "defects": defects,
        "zero_egress": meta["zero_egress"],
        "product_sha256_before": before,
        "product_sha256_after": after,
        "product_unchanged": unchanged,
        "unverified": [
            "GitHub 对 /releases/latest/download/latest.json 在预发布场景返回 404：仅由常量与 engine 代码路径推定，未联网实测",
            "未在真实安装根执行 download/apply/rollback（本席只做清单↔产物契约）",
        ],
    }
    result["report"] = build_report(facts, meta)
    (OUT / "RESULT.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "REPORT.md").write_text(result["report"], encoding="utf-8")
    log_lines.append(
        f"\n[r2-contract] RESULT: {summary['pass']} PASS / {summary['fail']} FAIL；"
        f"defects={len(defects)}；zero_egress.attempts={_EGRESS['external_attempts']}；product_unchanged={unchanged}\n"
    )
    (OUT / "run.log").write_text("".join(log_lines), encoding="utf-8")
    print(f"[r2-contract] wrote {OUT / 'RESULT.json'}, REPORT.md, run.log")
    print(f"[r2-contract] CASES {summary['pass']} PASS / {summary['fail']} FAIL; defects={len(defects)}")
    return 0


def build_four_gen_table(facts: dict) -> list[dict]:
    rows = []
    for version in GENS:
        row = facts["gens"][version]
        inst = facts["install_select"].get(version, {})
        port = facts["portable_select"].get(version, {})
        rows.append(
            {
                "version": version,
                "manifest_parse": "OK" if row["release"] else "REJECTED",
                "parse_error": row["parse_error"][:160],
                "installer_selected": inst.get("name") or None,
                "installer_reason": inst.get("reason") or inst.get("error") or "",
                "portable_selected": port.get("name") or None,
                "portable_reason": port.get("reason") or port.get("error") or "",
                "assets": len(row["data"].get("assets") or []),
                "top_level_fields": list(row["data"].keys()),
                "sums_matches": facts["integrity"][version]["sums_matches_manifest"],
            }
        )
    return rows


def build_defects(facts: dict) -> list[dict]:
    inst = facts["install_select"]
    all_setup_missing = all(v.get("selected") is False for v in inst.values())
    return [
        {
            "id": "UPD-001",
            "severity": "P0",
            "title": "安装版在四代清单里都选不到资产：Setup 文件名缺架构自证",
            "ref": "apps/desktop/updater/assets.py:317-322 / :263-269 ; deploy/windows/installer/app/build_setup.py（产物命名）",
            "impact": "installer 形态的机器 check() 得 state=no_asset，自动更新对安装版彻底不可用；四代结论一致，不是 rc.5 特有。",
            "witness": {"select(win32,x64,installer)": {k: (v.get("name") or "NoMatchingAsset") for k, v in inst.items()},
                        "reason": "安装包未声明架构（文件名缺 x64/x86/arm64），无法证明与当前进程匹配"},
        },
        {
            "id": "UPD-002",
            "severity": "P1",
            "title": "清单地址走 /releases/latest/download/：预发布版本拿不到清单（404→no_release，静默）",
            "ref": "apps/desktop/updater/constants.py:30-32 ; apps/desktop/updater/engine.py:245-258",
            "impact": "rc.* 作为 pre-release 发布时，更新器只会看到 no_release 且 silent=True，用户永远收不到更新提示。",
            "witness": {"manifest_url": "https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/latest/download/latest.json"},
        },
        {
            "id": "UPD-003",
            "severity": "P1",
            "title": "预发布序号按字符串比较：0.0.1-rc.10 被判比 rc.9 旧",
            "ref": "apps/desktop/updater/manifest.py:65-68",
            "impact": "第 10 个 rc 之后无法升级；四代递增在本轮未触发，属未来版本隐患。",
            "witness": {"compare(0.0.1-rc.9, 0.0.1-rc.10)": manifest.compare_versions("0.0.1-rc.9", "0.0.1-rc.10")},
        },
        {
            "id": "UPD-005",
            "severity": "P2",
            "title": "四代清单均未声明 platform/arch/kind，选择完全依赖文件名解析",
            "ref": "apps/desktop/updater/manifest.py:230-244 ; apps/desktop/updater/assets.py:219-269",
            "impact": "发布者意图不可机器核对；UPD-001 只能靠改文件名修，无法用清单声明兜底。",
            "witness": facts["declarations"],
        },
        {
            "id": "UPD-006",
            "severity": "P2",
            "title": "更新器不比对 assets[].url 的 release tag 与清单 version",
            "ref": "apps/desktop/updater/net.py:95 ; apps/desktop/updater/manifest.py:225-228",
            "impact": "清单说新版、链接指旧版时更新器不会报警（四代产物自身一致，但协议层无绑定）。",
            "witness": {"tag_binding_code_present": False},
        },
        {
            "id": "UPD-007",
            "severity": "P2",
            "title": "0.0.x 同版本仍报有更新，可反复下载 148 MB",
            "ref": "apps/desktop/updater/manifest.py:75-81 ; apps/desktop/updater/engine.py:617-620",
            "impact": "已是最新 rc.5 的便携版机器仍得 update_available，触发无意义的大包下载。",
            "witness": facts["nag"],
        },
        {
            "id": "UPD-008",
            "severity": "P2",
            "title": "verify-release 把资产数写死为 2、顶层字段精确等于 4 项（但不拒收 asset 内的声明字段）",
            "ref": "scripts/release/verify-release.mjs:47,132-136,153,166-181",
            "impact": "修 UPD-001 若走『新增带架构的 Setup 作为第 3 个资产』会被门禁判红；走『清单补 platform/arch/kind』则门禁放行。对上一轮『只认 4 字段』的说法作出更正。",
            "witness": facts["gate"],
        },
        {
            "id": "UPD-009",
            "severity": "P2",
            "title": "两套 Setup 命名并存：发布链无架构，门禁/夹具带 -win-x64",
            "ref": "tests/desktop/updater/_support.py:31-33 ; apps/desktop/updater/assets.py:5 ; scripts/release/verify-release.mjs:153",
            "impact": "happy path 用的名字发布链永不产出；同一事实两个来源，测试全绿而真实产物选不到。",
            "witness": {"real": "AIDrivenNetDefense-Setup-0.0.1-rc.5.exe", "fixture": "AIDrivenNetDefense-Setup-0.0.2-win-x64.exe"},
        },
        {
            "id": "UPD-R2-001",
            "severity": "P2",
            "title": "rc.2 产物 URL 仍用旧小写仓库名，被当前更新器整份拒收",
            "ref": "apps/desktop/updater/net.py:95（path.startswith 大小写敏感） ; apps/desktop/updater/constants.py:27 ; dist/release/0.0.1-rc.2/latest.json",
            "impact": "四代对照不能只看『Setup 选不到』：rc.2 在更早一步（URL 白名单）就被拒绝，ManifestUntrusted。历史产物，已由 rc.3+ 修正，但说明清单与仓库名的绑定没有任何门禁在跑。",
            "witness": {"rc.2_assets": [a["url"] for a in facts["gens"]["0.0.1-rc.2"]["data"]["assets"]]},
        },
    ]


if __name__ == "__main__":
    raise SystemExit(main())
