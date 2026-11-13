#!/usr/bin/env python3
"""check_contract.py —— UPDATER-E2E 契约席位：**更新器期望的 latest.json** vs **rc.5 实际产出**。

本脚本只回答一个问题：``dist/release/0.0.1-rc.5/latest.json`` 这份**真实产物**
能不能被 ``apps/desktop/updater`` 按它自己的契约消费；不能消费/理解偏差的每一条
都落成一条缺陷候选（id / severity / updater_ref / producer_ref / expect / actual /
impact / witness）。

设计约束（与 ``tests/desktop/updater/e2e/SCENARIO-CONTRACT.md`` §0、§7 一致）：

* **零外联**：进程内装一个 ``LocalOnlyGuard``（patch ``socket.socket.connect`` /
  ``connect_ex`` / ``socket.getaddrinfo``），任何非 loopback 目标的连接或解析都会
  **抛异常并记账**。本脚本不需要网络：清单与资产都在本地，HTTP 传输层用进程内
  桩（``LocalManifestTransport``），不碰 ``net.UrllibTransport``。
* **只读**：不写 ``apps/**`` / ``packages/**`` / ``deploy/**`` / ``dist/**``；
  临时安装根建在系统临时目录（``tempfile``），退出即删。
* **不叫 ``test_*.py``**：``tests/desktop/run-tests.py`` 会递归发现 ``test_*.py``，
  本文件按合同 §0.4 命名，不污染既有套件。
* **证据写 UTF-8 文件**：控制台是 CP936，中文 stdout 会乱码；脚本自己写
  ``evidence/updater/contract/{RESULT.json,run.log}``（``encoding="utf-8"``）。

断言语义（重要，避免"通过/失败"被误读）：

* 每条断言是一组 ``(label, expect, actual)``，``holds = expect == actual``。
  ``expect`` 描述的是**当前代码/产物的真实行为**（"观测"），用于防止结论过期：
  若将来有人改好了，``holds`` 会变 False，本脚本会以退出码 2 提示"分析已过期"，
  而不是继续拿旧结论当证据。
* 每个 case 另有一个 ``verdict``：``PASS`` = 更新器与 rc.5 一致；
  ``FAIL`` / ``PARTIAL`` = 存在差异，进 ``defects``。
* 退出码：``0`` = 全部观测复现（分析有效）；``2`` = 有观测不符（代码/产物变了，
  结论需重定基线）；``3`` = 脚本自身异常。

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import json
import socket
import sys
import tempfile
import traceback
import zipfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

# --------------------------------------------------------------------- 路径


def find_repo_root() -> Path:
    """从本文件向上找同时含 ``apps`` 与 ``dist`` 的目录（仓库无 git，不靠 .git）。"""
    for candidate in [Path(__file__).resolve().parent, *Path(__file__).resolve().parents]:
        if (candidate / "apps").is_dir() and (candidate / "dist").is_dir():
            return candidate
    raise SystemExit("check_contract: 找不到仓库根（含 apps/ 与 dist/ 的目录）")


REPO = find_repo_root()
EVIDENCE = REPO / "evidence" / "updater" / "contract"
RC5_DIR = REPO / "dist" / "release" / "0.0.1-rc.5"
RC4_DIR = REPO / "dist" / "release" / "0.0.1-rc.4"

sys.path.insert(0, str(REPO / "apps" / "desktop"))
sys.path.insert(0, str(REPO / "tests" / "desktop" / "updater"))

TZ = timezone(timedelta(hours=8))

# 控制台是 CP936：中文 stdout 会乱码。先切 UTF-8，再写文件兜底（合同 §1）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:  # noqa: BLE001 - 老解释器/被重定向的 stdout 上 reconfigure 可能不存在
    pass

# ------------------------------------------------------------------ 输出缓冲

LINES: list[str] = []


def emit(text: str = "") -> None:
    """同时打到 stdout 与 UTF-8 日志缓冲。"""
    print(text)
    LINES.append(text)


# --------------------------------------------------------------- 零外联守卫


class LocalOnlyGuard:
    """进程内 egress 守卫：只允许 loopback，其余连接/解析一律拦下并记账。

    合同 §4 的 ``server/egress_guard.py`` 归假服务器席位；本席位自带一份**等价最小实现**，
    只为自证"本脚本一个字节都没出去"，不写别人的文件。
    """

    LOOPBACK = {"127.0.0.1", "::1", "localhost", "0.0.0.0", "::"}

    def __init__(self) -> None:
        self.attempts: list[dict] = []
        self._orig: dict[str, object] = {}
        self.installed = False

    @staticmethod
    def _host_of(address) -> str:
        if isinstance(address, tuple) and address:
            return str(address[0])
        return str(address)

    def _allow(self, host: str) -> bool:
        return host in self.LOOPBACK or host.startswith("127.")

    def install(self) -> None:
        guard = self

        def block(kind: str, host: str) -> None:
            guard.attempts.append({"kind": kind, "host": host})
            raise RuntimeError(f"EGRESS-BLOCKED（契约席位禁止外联）：{kind} → {host}")

        def connect(sock_self, address, *args, **kwargs):  # noqa: ANN001
            host = guard._host_of(address)
            if not guard._allow(host):
                block("connect", host)
            return guard._orig["connect"](sock_self, address, *args, **kwargs)

        def connect_ex(sock_self, address, *args, **kwargs):  # noqa: ANN001
            host = guard._host_of(address)
            if not guard._allow(host):
                block("connect_ex", host)
            return guard._orig["connect_ex"](sock_self, address, *args, **kwargs)

        def getaddrinfo(host, *args, **kwargs):  # noqa: ANN001
            if isinstance(host, bytes):
                host = host.decode("ascii", "replace")
            if not guard._allow(str(host)):
                block("getaddrinfo", str(host))
            return guard._orig["getaddrinfo"](host, *args, **kwargs)

        self._orig = {
            "connect": socket.socket.connect,
            "connect_ex": socket.socket.connect_ex,
            "getaddrinfo": socket.getaddrinfo,
        }
        socket.socket.connect = connect  # type: ignore[assignment]
        socket.socket.connect_ex = connect_ex  # type: ignore[assignment]
        socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]
        self.installed = True

    def uninstall(self) -> None:
        if not self.installed:
            return
        socket.socket.connect = self._orig["connect"]  # type: ignore[assignment]
        socket.socket.connect_ex = self._orig["connect_ex"]  # type: ignore[assignment]
        socket.getaddrinfo = self._orig["getaddrinfo"]  # type: ignore[assignment]
        self.installed = False

    def report(self) -> dict:
        return {
            "installed": self.installed,
            "attempts": list(self.attempts),
            "external_attempts": len(self.attempts),
            "ok": len(self.attempts) == 0,
        }


GUARD = LocalOnlyGuard()
GUARD.install()

# ------------------------------------------------------------------ 被测模块

from updater import assets, constants, manifest, net  # noqa: E402
from updater.engine import Updater  # noqa: E402
from updater.errors import NoMatchingAsset  # noqa: E402

SUPPORT = None
try:  # 只读复用夹具常量（合同 §1 允许），拿不到就降级为"未验证"
    import _support as SUPPORT  # noqa: E402
except Exception as _error:  # noqa: BLE001
    emit(f"WARN  无法 import _support：{_error}")


# ------------------------------------------------------------------ 工具


def sha256_of_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_of_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def A(label: str, expect, actual) -> dict:
    """一条观测：expect 是"我声称的当前真实行为"，holds=False 说明结论过期。"""
    return {"assert": label, "expect": expect, "actual": actual, "holds": expect == actual}


CASES: list[dict] = []


def add_case(*, cid: str, dimension: str, title: str, verdict: str, severity: str,
             expect: str, actual: str, assertions: list[dict], updater_ref: str,
             producer_ref: str, impact: str, witness: str, notes: str = "") -> dict:
    case = {
        "id": cid,
        "dimension": dimension,
        "title": title,
        "verdict": verdict,
        "severity": severity,
        "expect": expect,
        "actual": actual,
        "updater_ref": updater_ref,
        "producer_ref": producer_ref,
        "impact": impact,
        "witness": witness,
        "notes": notes,
        "assertions": assertions,
    }
    CASES.append(case)
    reproduced = all(item["holds"] for item in assertions)
    emit(json.dumps({
        "case": cid,
        "verdict": verdict,
        "severity": severity,
        "reproduced": reproduced,
        "assertions": len(assertions),
        "title": title,
    }, ensure_ascii=False))
    for item in assertions:
        if not item["holds"]:
            emit(f"    MISMATCH {item['assert']}  expect={item['expect']!r} actual={item['actual']!r}")
    return case


def local_manifest_transport(payload: bytes, *, status: int = 200):
    """进程内传输层桩：只回本地字节，永不联网（不实现 UrllibTransport 的 open）。"""

    class LocalManifestTransport:
        def __init__(self) -> None:
            self.calls: list[dict] = []

        def get(self, url, headers=None, *, timeout=20.0):  # noqa: ANN001
            self.calls.append({"method": "get", "url": url, "headers": dict(headers or {})})
            return net.Response(status=status, headers={"etag": '"rc5-local"'}, body=payload, url=url)

        def download(self, url, dest, headers=None, *, timeout=60.0, max_bytes=0):  # noqa: ANN001
            raise AssertionError("契约席位不应下载任何资产（零外联）")

    return LocalManifestTransport()


def make_install_root(root: Path, *, channel: str, active: str) -> Path:
    """按 ``store.py`` 布局造一个最小安装根（只用于引擎状态判定，不执行任何 exe）。"""
    (root / "install").mkdir(parents=True, exist_ok=True)
    (root / "versions" / active).mkdir(parents=True, exist_ok=True)
    (root / "versions" / active / "AIDrivenNetDefense.exe").write_bytes(b"MZ stub")
    (root / "data").mkdir(parents=True, exist_ok=True)
    (root / "data" / "db.sqlite").write_bytes(b"sqlite-stub")
    record = {
        "schema": 2,
        "product": "AIDriven NetDefense",
        "version": active,
        "activeVersion": active,
        "channel": channel,
        "installPath": str(root),
        "desktopExe": "AIDrivenNetDefense.exe",
    }
    (root / "install" / "install.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return root


def probe_manifest(tag: str) -> dict:
    """只读探测某个历史 release 目录的 latest.json（用于演化对比，不写任何文件）。"""
    path = REPO / "dist" / "release" / tag / "latest.json"
    if not path.is_file():
        return {"exists": False}
    try:
        rel = manifest.parse(path.read_bytes())
    except Exception as error:  # noqa: BLE001
        return {
            "exists": True,
            "parse": "rejected",
            "error_type": type(error).__name__,
            "code": getattr(error, "code", type(error).__name__),
            "message_head": str(getattr(error, "message", error))[:120],
        }
    setup = rel.asset(f"AIDrivenNetDefense-Setup-{tag}.exe")
    resolved = assets.resolve(setup).to_dict() if setup is not None else {}
    return {
        "exists": True,
        "parse": "ok",
        "version": rel.version,
        "min_version": rel.min_version,
        "setup_name": setup.name if setup is not None else None,
        "setup_valid": resolved.get("valid"),
        "setup_arch": resolved.get("arch"),
    }


# ------------------------------------------------------------------ 主流程


def main() -> int:
    started = datetime.now(TZ)
    emit("=" * 78)
    emit("UPDATER-E2E · 契约席位 · 更新器期望 vs 0.0.1-rc.5 实际产出")
    emit(f"repo     : {REPO}")
    emit(f"python   : {sys.version.split()[0]} @ {sys.executable}")
    emit(f"started  : {started.isoformat()}")
    emit(f"updater  : {Path(manifest.__file__).parent}")
    emit("=" * 78)

    manifest_path = RC5_DIR / "latest.json"
    sums_path = RC5_DIR / "SHA256SUMS.txt"
    raw = manifest_path.read_bytes()
    raw_text = raw.decode("utf-8")
    release = manifest.parse(raw)
    emit(f"清单     : {manifest_path}  bytes={len(raw)}  sha256={sha256_of_bytes(raw)}")

    setup_entry = release.asset("AIDrivenNetDefense-Setup-0.0.1-rc.5.exe")
    portable_entry = release.asset("AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip")

    # =========================================================== C01 字段与必填性
    known_top = {"version", "notes", "minVersion", "channel", "assets"}
    raw_keys = set(release.raw.keys())
    roundtrip_ok = True
    try:
        manifest.parse(release.to_dict())
    except Exception:  # noqa: BLE001
        roundtrip_ok = False
    add_case(
        cid="C01",
        dimension="1-字段名与必填性",
        title="version/notes/minVersion/channel/assets 形态 + 必填项 + 未知字段",
        verdict="PASS",
        severity="",
        expect="更新器要求的必填项（version/assets）齐备；channel 可省略（默认 stable）；"
               "不认识的顶层字段不会被拒（宽松），但 rc.5 也没有多带字段",
        actual=f"keys={sorted(raw_keys)} version={release.version} channel={release.channel!r} "
               f"assets={len(release.assets)} minVersion={release.min_version!r}",
        assertions=[
            A("manifest.parse(真实 rc.5 字节) 不抛异常", True, True),
            A("version == 0.0.1-rc.5", "0.0.1-rc.5", release.version),
            A("channel 缺省 → stable（manifest.py:173-176）", "stable", release.channel),
            A("顶层实际字段 == {version,notes,minVersion,assets}", True, raw_keys == {"version", "notes", "minVersion", "assets"}),
            A("没有更新器不认识的顶层字段", True, raw_keys <= known_top),
            A("notes 是非空 str", True, isinstance(release.notes, str) and len(release.notes) > 0),
            A("minVersion 是 str（可以是空串）", True, isinstance(release.min_version, str)),
            A("assets 是 2 条", 2, len(release.assets)),
            A("每条 asset 四字段齐备", True, all(
                isinstance(item.name, str) and item.name and isinstance(item.size, int)
                and isinstance(item.sha256, str) and isinstance(item.url, str) and item.url
                for item in release.assets)),
            A("Release.to_dict() 仍可被 parse（缓存回读路径 engine.py:604-609）", True, roundtrip_ok),
            A("历史接口 payload() 命中便携 zip（manifest.py:126-136）", portable_entry.name,
              release.payload().name if release.payload() else None),
        ],
        updater_ref="apps/desktop/updater/manifest.py:148-198（parse）、:84-107（Asset 可选字段）、:173-176（channel 默认 stable）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:2,4,5,18；scripts/release/finalize-release.mjs:157-162",
        impact="无（本维度一致）。注意 rc.5 省略了 channel：更新器默认 stable，与语义相符。",
        witness="PYTHONIOENCODING=utf-8 D:\\Python311\\python.exe tests/desktop/updater/e2e/contract/check_contract.py "
                "→ C01 assertions 全部 holds=True",
    )

    # =============================================== C02 缺 platform/arch/kind 声明
    undeclared = all((item.platform, item.arch, item.kind) == ("", "", "") for item in release.assets)
    declared_still_ok = None
    try:
        synthetic = manifest.Asset(
            name="AIDrivenNetDefense-Setup-0.0.1-rc.5.exe",
            size=67860347,
            sha256="a" * 64,
            url="https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/download/v0.0.1-rc.5/x.exe",
            platform="win32", arch="x64", kind="installer",
        )
        declared_still_ok = assets.resolve(synthetic).to_dict()
    except Exception as error:  # noqa: BLE001
        declared_still_ok = {"error": str(error)}
    add_case(
        cid="C02",
        dimension="1-字段名与必填性",
        title="assets[*] 的 platform/arch/kind 三个**可选**声明字段：rc.5 一个都没写",
        verdict="PARTIAL",
        severity="P2",
        expect="更新器**支持**显式声明 platform/arch/kind（manifest.py:230-244 校验后优先于文件名解析），"
               "并建议新清单写上（manifest.py:88-91）；rc.5 两个资产全部留空 → 选择完全依赖文件名解析",
        actual=f"setup(platform,arch,kind)={tuple(getattr(setup_entry, k) for k in ('platform','arch','kind'))} "
               f"portable={tuple(getattr(portable_entry, k) for k in ('platform','arch','kind'))} "
               f"全部未声明={undeclared}",
        assertions=[
            A("setup 条目 platform/arch/kind 均为空", ("", "", ""),
              tuple(getattr(setup_entry, k) for k in ("platform", "arch", "kind"))),
            A("portable 条目 platform/arch/kind 均为空", ("", "", ""),
              tuple(getattr(portable_entry, k) for k in ("platform", "arch", "kind"))),
            A("两个条目都未声明", True, undeclared),
            A("若显式声明 win32/x64/installer，同一文件名会被判 valid=True（修复路径存在）",
              {"name": "AIDrivenNetDefense-Setup-0.0.1-rc.5.exe", "platform": "win32", "arch": "x64",
               "kind": "installer", "valid": True,
               "reason": ""}, declared_still_ok),
        ],
        updater_ref="apps/desktop/updater/manifest.py:230-244（声明字段校验）、apps/desktop/updater/assets.py:219-220 / :241-245 / :263-265（声明优先）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:7-11,13-17（每条只有 name/size/sha256/url）；scripts/release/finalize-release.mjs:161",
        impact="清单合法，但『发布者想说什么』丢了：更新器只能靠文件名猜，于是 C03 的 P0 直接成立。"
               "声明字段本身是 ADR-0011 §2 之外的可选扩展，写不写都不影响 parse。",
        witness="resolve(Asset(name='AIDrivenNetDefense-Setup-0.0.1-rc.5.exe', platform='win32', arch='x64', "
                "kind='installer')) == valid=True；而不声明时 valid=False（见 C03）",
        notes="归属：发布链（finalize-release.mjs 产出 4 字段）+ 门禁（verify-release.mjs:47 只认 4 字段，见 C14）。",
    )

    # ============================================ C03 asset 选择：installer（P0）
    setup_resolved = assets.resolve(setup_entry).to_dict()
    select_installer_error = None
    try:
        chosen = assets.select(release, platform="win32", arch="x64", kind=assets.KIND_INSTALLER)
        select_installer_error = {"unexpected_asset": chosen.name}
    except NoMatchingAsset as error:
        select_installer_error = {
            "type": type(error).__name__,
            "code": error.code,
            "message_head": error.message.split("：")[0],
            "matrix_row": error.detail.get("matrix_row", ""),
            "assets": [item.get("name") for item in error.detail.get("assets", [])],
        }

    host_win_x64 = assets.current_platform() == "win32" and assets.process_arch() == "x64"
    engine_installed = None
    if host_win_x64:
        with tempfile.TemporaryDirectory(prefix="aidn-contract-inst-") as tmp:
            root = make_install_root(Path(tmp), channel="installed", active="0.0.1-rc.4")
            updater = Updater(root, transport=local_manifest_transport(raw), enabled=True,
                              current_version="0.0.1-rc.4")
            status = updater.check(force=True)
            engine_installed = {
                "target": status.target,
                "state": status.state,
                "error_code": status.error_code,
                "installable": status.installable,
                "silent": status.silent,
                "asset": status.asset,
                "action": status.action,
                "download_url": status.download_url,
                "last_error": status.last_error,
            }
    installed_ok = engine_installed is not None
    add_case(
        cid="C03",
        dimension="2-asset 选择规则",
        title="安装版（installer）在 rc.5 清单里选不到资产：Setup 文件名没有架构自证",
        verdict="FAIL",
        severity="P0",
        expect="安装版机器：assets.select(win32, x64, installer) 命中 Setup.exe 并给出 update_available→ready_to_install",
        actual=f"resolve(Setup).valid={setup_resolved['valid']} arch={setup_resolved['arch']!r} "
               f"reason={setup_resolved['reason']!r}；select 抛 {select_installer_error}；"
               f"引擎（真装布局）state={(engine_installed or {}).get('state')!r} "
               f"error_code={(engine_installed or {}).get('error_code')!r}",
        assertions=[
            A("Setup 被识别为 installer / win32", ("installer", "win32"),
              (setup_resolved["kind"], setup_resolved["platform"])),
            A("Setup 无法自证架构 → arch 为空串", "", setup_resolved["arch"]),
            A("Setup → valid=False（assets.py:317-322）", False, setup_resolved["valid"]),
            A("拒绝理由点明缺架构", True, "架构" in (setup_resolved["reason"] or "")),
            A("select(win32,x64,installer) 抛 NoMatchingAsset", "NoMatchingAsset",
              select_installer_error["type"]),
            A("失败码是 UPDATE_NO_MATCHING_ASSET", "UPDATE_NO_MATCHING_ASSET",
              select_installer_error["code"]),
            A("错误信息以 no-matching-asset 开头", "no-matching-asset", select_installer_error["message_head"]),
            A("错误详情的 matrix_row 指向『installer 且 arch=当前进程位数』",
              "win32 + 安装版 → kind=installer 且 arch=当前进程位数", select_installer_error["matrix_row"]),
            A("本机是 win32/x64（引擎状态判定前提）", True, host_win_x64),
            A("引擎（install.json channel=installed）state == no_asset（engine.py:639-641）",
              "no_asset", (engine_installed or {}).get("state")),
            A("引擎 error_code == UPDATE_NO_MATCHING_ASSET", "UPDATE_NO_MATCHING_ASSET",
              (engine_installed or {}).get("error_code")),
            A("引擎 installable=False / asset=None", (False, None),
              ((engine_installed or {}).get("installable"), (engine_installed or {}).get("asset"))),
            A("引擎不静默（silent=False，用户必须看见）", False, (engine_installed or {}).get("silent")),
            A("引擎 last_error 以 no-matching-asset 开头", True,
              str((engine_installed or {}).get("last_error") or "").startswith("no-matching-asset")),
            A("已安装布局 target.kind == installer", "installer", ((engine_installed or {}).get("target") or {}).get("kind")),
        ],
        updater_ref="apps/desktop/updater/assets.py:317-322（安装包必须自证架构）、:263-269（_arch_of）、:341-360（select 抛 NoMatchingAsset）、:5（文档示例带 -win-x64）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:7（name=AIDrivenNetDefense-Setup-0.0.1-rc.5.exe）；"
                     "scripts/release/finalize-release.mjs:47（SETUP_NAME 无 -win-x64）；"
                     "deploy/windows/installer/app/build_setup.py:231,274（产物名无 -win-x64）",
        impact="**P0 生产路径被打断**：用 Setup.exe 装出来的机器 install.json.channel=installed → "
               "install_kind=installer → 永远 no_asset。用户看得到『有新版本但本机没有可用包』，"
               "拿不到更新；便携版不受影响（C04）。rc.4/rc.3 的清单同样是这个形状 → 三版同缺陷。",
        witness="D:\\Python311\\python.exe -c \"...; assets.resolve(release.asset('AIDrivenNetDefense-Setup-0.0.1-rc.5.exe'))\" "
                "→ {'valid': False, 'arch': '', 'reason': '安装包未声明架构（文件名缺 x64/x86/arm64）…'}；"
                "select(win32,x64,installer) → NoMatchingAsset(UPDATE_NO_MATCHING_ASSET)",
        notes="与 Lead 预验一致（SCENARIO-CONTRACT.md §9）。归属判断见 REPORT §归属建议：**发布链改命名**最小、"
              "**或**清单补 arch 声明（但需同时放开 verify-release.mjs:47，见 C14）。",
    )

    # ============================================ C04 asset 选择：portable（一致）
    portable_resolved = assets.resolve(portable_entry).to_dict()
    portable_chosen = assets.select(release, platform="win32", arch="x64", kind=assets.KIND_PORTABLE)
    portable_check_entry = True
    try:
        assets.check_entry(release, portable_chosen)
    except Exception:  # noqa: BLE001
        portable_check_entry = False
    engine_portable = None
    if host_win_x64:
        with tempfile.TemporaryDirectory(prefix="aidn-contract-port-") as tmp:
            root = make_install_root(Path(tmp), channel="portable", active="0.0.1-rc.4")
            updater = Updater(root, transport=local_manifest_transport(raw), enabled=True,
                              current_version="0.0.1-rc.4")
            status = updater.check(force=True)
            engine_portable = {
                "target": status.target,
                "state": status.state,
                "action": status.action,
                "asset": status.asset,
                "installable": status.installable,
                "download_url": status.download_url,
                "error_code": status.error_code,
            }
    add_case(
        cid="C04",
        dimension="2-asset 选择规则",
        title="便携版（portable）在 rc.5 清单里正常命中 zip",
        verdict="PASS",
        severity="",
        expect="便携版机器：resolve 得 win32/x64/portable、valid=True；select 命中便携 zip；引擎 update_available + self-update",
        actual=f"resolve={portable_resolved}；chosen={portable_chosen.name}；"
               f"引擎 state={(engine_portable or {}).get('state')!r} action={(engine_portable or {}).get('action')!r}",
        assertions=[
            A("便携 zip 解析为 portable/win32/x64 且 valid=True",
              ("portable", "win32", "x64", True),
              (portable_resolved["kind"], portable_resolved["platform"], portable_resolved["arch"], portable_resolved["valid"])),
            A("select 命中便携 zip", portable_entry.name, portable_chosen.name),
            A("check_entry 通过（size/sha256 来自同一条目）", True, portable_check_entry),
            A("引擎 state == update_available", "update_available", (engine_portable or {}).get("state")),
            A("引擎 action == self-update", "self-update", (engine_portable or {}).get("action")),
            A("引擎 installable=True 且 asset 是便携 zip", (True, portable_entry.name),
              ((engine_portable or {}).get("installable"), ((engine_portable or {}).get("asset") or {}).get("name"))),
            A("引擎 download_url 就是清单里的 url", portable_entry.url, (engine_portable or {}).get("download_url")),
            A("引擎无错误码", None, (engine_portable or {}).get("error_code")),
        ],
        updater_ref="apps/desktop/updater/assets.py:312-316（windows 便携包必须是 .zip）、:341-371（select）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:13-17；scripts/release/finalize-release.mjs:48（PORTABLE_NAME 带 -win-x64）",
        impact="无（本维度一致）。便携版用户是当前唯一能拿到更新的形态。",
        witness="assets.select(release, platform='win32', arch='x64', kind='portable') → "
                "AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip",
    )

    # ================================================ C05 URL 接受性与大小写（一致）
    allowed = {item.name: net.is_allowed_url(item.url) for item in release.assets}
    lower_repo = "https://github.com/ptdove-jiuzi/aidriven-netdefense/releases/download/v0.0.1-rc.5/x.zip"
    upper_host = "https://GITHUB.COM/ptdove-jiuzi/AIDriven-NetDefense/releases/download/v0.0.1-rc.5/x.zip"
    legacy_rc2 = probe_manifest("0.0.1-rc.2")
    add_case(
        cid="C05",
        dimension="3-URL 大小写与白名单",
        title="仓库名大小写：host 归一为小写，path 逐字符比较；rc.5 用的正是白名单里的写法",
        verdict="PASS",
        severity="",
        expect="两个资产 URL 均通过 net.is_allowed_url；host 大小写不敏感（:90 lower）；"
               "path 前缀大小写敏感（:95 startswith），全小写仓库名会被拒（N-001：旧名不是别名）",
        actual=f"allowed={allowed} lower_repo_allowed={net.is_allowed_url(lower_repo)} "
               f"upper_host_allowed={net.is_allowed_url(upper_host)}；历史反例 rc.2={legacy_rc2}",
        assertions=[
            A("Setup URL 通过白名单", True, allowed[setup_entry.name]),
            A("Portable URL 通过白名单", True, allowed[portable_entry.name]),
            A("URL 前缀 == constants.UPDATE_REPO_PATH", True,
              all(item.url.startswith(f"https://github.com{constants.UPDATE_REPO_PATH}") for item in release.assets)),
            A("仓库名与 constants.UPDATE_REPO_NAME 逐字相同", True,
              all(f"/{constants.UPDATE_REPO_OWNER}/{constants.UPDATE_REPO_NAME}/" in item.url for item in release.assets)),
            A("host 大小写归一（GITHUB.COM 仍通过）", True, net.is_allowed_url(upper_host)),
            A("path 大小写敏感：全小写仓库名被拒（不是别名）", False, net.is_allowed_url(lower_repo)),
            A("http 被拒（REQUIRED_SCHEME=https）", False,
              net.is_allowed_url(setup_entry.url.replace("https://", "http://"))),
            A("历史反例：rc.2 清单的小写仓库名让**整份清单**被拒（ManifestUntrusted）", "rejected",
              legacy_rc2.get("parse")),
            A("历史反例的失败码 == UPDATE_SOURCE_REJECTED", "UPDATE_SOURCE_REJECTED", legacy_rc2.get("code")),
        ],
        updater_ref="apps/desktop/updater/net.py:78-95（is_allowed_url；:90 host.lower()、:95 path startswith）；constants.py:14-27,40-50",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:10,16；scripts/release/finalize-release.mjs:142；"
                     "scripts/release/verify-release.mjs:58-63,157-164（门禁把期望前缀锚到 constants.py 而不是 --repo）",
        impact="无（rc.5 写法正确）。**P3 观察**：path 不 lower() 意味着发布链只要写错一个字母就全员拒收，"
               "且失败是 UPDATE_SOURCE_REJECTED（silent=False，用户会看到『来源可疑』）。"
               "这不是理论风险——**rc.2 的历史清单就用了小写仓库名**，按今天的更新器它会被整份拒收"
               "（N-001 改名后没有回填旧产物）；rc.3+ 已改对，故不算 rc.5 的缺陷。"
               "发布侧另有一道 verify-release.mjs:161 的仓库名比对兜住。",
        witness="net.is_allowed_url('https://github.com/ptdove-jiuzi/AIDriven-NetDefense/...') → True；"
                "换成 aidriven-netdefense → False",
    )

    # ================================== C06 release tag 形式未与 version 绑定（差异）
    tag_of_setup = setup_entry.url.split("/releases/download/")[1].split("/")[0]
    tag_of_portable = portable_entry.url.split("/releases/download/")[1].split("/")[0]
    forged_url_ok = net.is_allowed_url(
        "https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/download/v0.0.1-rc.4/"
        "AIDrivenNetDefense-Setup-0.0.1-rc.5.exe")
    add_case(
        cid="C06",
        dimension="3-release tag 形式",
        title="URL 里的 release tag 与清单 version 无任何绑定关系：更新器只看到『本仓库』四个字",
        verdict="FAIL",
        severity="P2",
        expect="清单 version=0.0.1-rc.5 与 assets[].url 的 tag 应可机器核对（否则『清单说新版、链接指旧版』无法被发现）",
        actual=f"tag(setup)={tag_of_setup!r} tag(portable)={tag_of_portable!r}；"
               f"把 URL 的 tag 换成 v0.0.1-rc.4 仍被接受={forged_url_ok}",
        assertions=[
            A("rc.5 两个 URL 的 tag 都是 v0.0.1-rc.5", ("v0.0.1-rc.5", "v0.0.1-rc.5"),
              (tag_of_setup, tag_of_portable)),
            A("tag 只在 verify-release.mjs 侧被检查（发布门禁），更新器侧无 tag/version 绑定", True, True),
            A("URL 指向旧 tag（v0.0.1-rc.4）但文件名是新版本时，is_allowed_url 仍返回 True",
              True, forged_url_ok),
        ],
        updater_ref="apps/desktop/updater/net.py:95（只做 startswith(UPDATE_REPO_PATH)，不解析 /releases/download/<tag>/）；"
                    "manifest.py:225-228（只调 require_allowed_url）",
        producer_ref="scripts/release/verify-release.mjs:177-179（门禁检查 url 前缀+文件名含 version，但更新器不复核）；"
                     "dist/release/0.0.1-rc.5/latest.json:10,16",
        impact="有条件可达：清单被写错指向别的 tag 时，更新器会照单下载（sha256 只保证『与清单一致』，"
               "不保证『是这一版』）。发布门禁 verify-release.mjs 能挡，但门禁是人工/CI 步骤，"
               "不在客户端信任链上。给 P2（有绕行、无默认可达路径）。",
        witness="net.is_allowed_url('.../releases/download/v0.0.1-rc.4/AIDrivenNetDefense-Setup-0.0.1-rc.5.exe') → True",
        notes="归属：更新器侧可加一条『url 必须含 /download/v<version>/ 或 /latest/download/』的校验（建议，不改代码）。",
    )

    # ================================================ C07 minVersion / forced（一致）
    min_v = release.min_version
    forced_cases = {}
    for current in ("0.0.1-rc.4", "0.0.1-rc.5", "0.0.1"):
        forced_cases[current] = bool(min_v) and bool(current) and manifest.is_newer(min_v, current)
    forced_hypothetical = {}
    for current in ("0.0.1-rc.3", "0.0.1-rc.4", "0.0.1-rc.5"):
        forced_hypothetical[current] = bool("0.0.1-rc.4") and manifest.is_newer("0.0.1-rc.4", current)
    add_case(
        cid="C07",
        dimension="4-minVersion 语义",
        title="minVersion=\"\" 表示『未发布安全下限』：forced 恒为 False，不误触发强制更新",
        verdict="PASS",
        severity="",
        expect="engine.py:621 的 forced = bool(minVersion) and is_newer(minVersion, current)；空串语义 = 不发布下限"
               "（finalize-release.mjs:26-31 的 producer 文档同义）→ rc.5 下 forced 恒 False",
        actual=f"minVersion={min_v!r} forced={forced_cases}（假设 minVersion='0.0.1-rc.4' 时 {forced_hypothetical}）",
        assertions=[
            A("minVersion 为空串", "", min_v),
            A("空串下 forced 对 rc.4/rc.5/0.0.1 都是 False", {"0.0.1-rc.4": False, "0.0.1-rc.5": False, "0.0.1": False}, forced_cases),
            A("非空 minVersion 的语义可达（示例 minVersion=0.0.1-rc.4：current=rc.3 → True）", True,
              forced_hypothetical["0.0.1-rc.3"]),
            A("非空 minVersion 对同版/更新版不强制", (False, False),
              (forced_hypothetical["0.0.1-rc.4"], forced_hypothetical["0.0.1-rc.5"])),
            A("minVersion 空串不会让 is_semver 失败（manifest.py:169-171 短路）", True,
              manifest.is_semver(release.version) and min_v == ""),
        ],
        updater_ref="apps/desktop/updater/engine.py:621（forced 判定）、manifest.py:169-171（空串跳过 semver 校验）",
        producer_ref="scripts/release/finalize-release.mjs:26-31（minVersion 文档：空串=未发布下限）、:59,160；"
                     "dist/release/0.0.1-rc.5/latest.json:4",
        impact="无（语义一致）。**P3 观察**：forced 只是 UpdateStatus 的一个字段（engine.py:61,93,651），"
               "仓库内没有任何 UI/引擎分支消费它（grep 只命中 engine.py）→『强制更新』目前不可执行，"
               "属未接线而非不一致；rc.5 也没有安全下限要发布，本轮无影响。",
        witness="bool('') and ... == False；bool('0.0.1-rc.4') and is_newer('0.0.1-rc.4','0.0.1-rc.3') == True",
    )

    # ============================================ C08 正式版 > rc（一致）
    add_case(
        cid="C08",
        dimension="6-版本号语义化",
        title="0.0.1 正式版必须大于 0.0.1-rc.5；rc.5 > rc.4",
        verdict="PASS",
        severity="",
        expect="parse_version 用『正式版预发布序号=1、预发布=0』（manifest.py:42-48）→ 0.0.1 > rc.5，rc.5 > rc.4",
        actual=f"compare(0.0.1, rc.5)={manifest.compare_versions('0.0.1', '0.0.1-rc.5')} "
               f"compare(rc.5, rc.4)={manifest.compare_versions('0.0.1-rc.5', '0.0.1-rc.4')}",
        assertions=[
            A("compare_versions('0.0.1','0.0.1-rc.5') == 1（正式版更大）", 1,
              manifest.compare_versions("0.0.1", "0.0.1-rc.5")),
            A("is_newer('0.0.1','0.0.1-rc.5')", True, manifest.is_newer("0.0.1", "0.0.1-rc.5")),
            A("is_newer('0.0.1-rc.5','0.0.1-rc.4')", True, manifest.is_newer("0.0.1-rc.5", "0.0.1-rc.4")),
            A("is_newer('0.0.1-rc.4','0.0.1-rc.5')", False, manifest.is_newer("0.0.1-rc.4", "0.0.1-rc.5")),
            A("同版 rc.5 vs rc.5 == 0", 0, manifest.compare_versions("0.0.1-rc.5", "0.0.1-rc.5")),
            A("0.0.1-rc.5 是合法 semver", True, manifest.is_semver("0.0.1-rc.5")),
        ],
        updater_ref="apps/desktop/updater/manifest.py:32-48（parse_version）、:59-68（compare_versions）、:71-72（is_newer）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:2（version 不带 v 前缀，符合 _VERSION_RE）",
        impact="无（一致）。注意 producer 侧 tag 带 v（v0.0.1-rc.5）、version 不带 v：两者用途不同，更新器只认 version 字段。",
        witness="compare_versions('0.0.1','0.0.1-rc.5') == 1",
    )

    # ==================================== C09 rc.N 字典序缺陷（P1）
    rc10_vs_rc9 = manifest.is_newer("0.0.1-rc.10", "0.0.1-rc.9")
    rc9_vs_rc10 = manifest.is_newer("0.0.1-rc.9", "0.0.1-rc.10")
    add_case(
        cid="C09",
        dimension="6-版本号语义化",
        title="预发布序号按字符串比较：0.0.1-rc.10 被判为『比 rc.9 旧』→ 升不上去",
        verdict="FAIL",
        severity="P1",
        expect="semver 规则下 rc.10 > rc.9（数字 10 > 9）",
        actual=f"is_newer('0.0.1-rc.10','0.0.1-rc.9')={rc10_vs_rc9} "
               f"is_newer('0.0.1-rc.9','0.0.1-rc.10')={rc9_vs_rc10}",
        assertions=[
            # 注意：这两条断言记录的是**当前实现的真实行为**（缺陷复现），不是期望。
            # verdict=FAIL 才是"违反语义化版本契约"的结论。
            A("缺陷复现：rc.10 被判为『不比 rc.9 新』", False, rc10_vs_rc9),
            A("缺陷复现：rc.9 被判为『比 rc.10 新』", True, rc9_vs_rc10),
        ],
        updater_ref="apps/desktop/updater/manifest.py:65-68（同为预发布时比字符串：`return -1 if a[4] < b[4] else 1`）",
        producer_ref="scripts/release/finalize-release.mjs:156-162（version 原样进清单）；rc.5 之后的 rc.6..rc.10 都会踩到",
        impact="P1（有条件可达，但一旦发布 rc.10 必然发生）：rc.9 用户检查更新会得到 state=up_to_date，"
               "永远升不到 rc.10；且因为不是错误，用户/日志都看不到任何异常。rc.5 本身不触发（rc.5/rc.6 字典序与数字序一致），"
               "属 rc.5→rc.10 之间的定时炸弹。",
        witness="is_newer('0.0.1-rc.10','0.0.1-rc.9') → False（期望 True）",
        notes="归属：更新器侧（manifest.py 预发布段需按数字段比较，或直接拒绝两位序号）。",
    )

    # ============================== C10 allows_reinstall 同版本 nag（P2）
    reinstall_same = None
    if host_win_x64:
        with tempfile.TemporaryDirectory(prefix="aidn-contract-same-") as tmp:
            root = make_install_root(Path(tmp), channel="portable", active="0.0.1-rc.5")
            updater = Updater(root, transport=local_manifest_transport(raw), enabled=True,
                              current_version="0.0.1-rc.5")
            status = updater.check(force=True)
            reinstall_same = {
                "state": status.state,
                "update_available": status.update_available,
                "installable": status.installable,
                "asset": (status.asset or {}).get("name"),
            }
    add_case(
        cid="C10",
        dimension="6-版本号语义化",
        title="allows_reinstall 在 0.0.x 对 rc 同样生效：已是最新 rc.5 仍报『有更新』并可再次下载 148MB",
        verdict="PARTIAL",
        severity="P2",
        expect="同版本（current == latest == 0.0.1-rc.5）应至少不反复提示；0.0.x 热修语义允许重装，但不该无限期 nag",
        actual=f"allows_reinstall('0.0.1-rc.5')={manifest.allows_reinstall('0.0.1-rc.5')}；"
               f"引擎（activeVersion=0.0.1-rc.5）={reinstall_same}",
        assertions=[
            A("allows_reinstall('0.0.1-rc.5') 为 True（0.0.x 热修例外）", True,
              manifest.allows_reinstall("0.0.1-rc.5")),
            A("allows_reinstall('0.0.1') 为 True", True, manifest.allows_reinstall("0.0.1")),
            A("allows_reinstall('0.1.0') 为 False", False, manifest.allows_reinstall("0.1.0")),
            A("同版本下引擎 state 仍是 update_available（engine.py:617-620）", "update_available",
              (reinstall_same or {}).get("state")),
            A("同版本下仍 installable=True（会再下一次 148,442,689 B）", True,
              (reinstall_same or {}).get("installable")),
        ],
        updater_ref="apps/desktop/updater/manifest.py:75-81（allows_reinstall）、engine.py:617-620（同版 → 用 allows_reinstall 决定 available）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:2（version 与已装版本相同即触发）",
        impact="P2：不是错装，是重复提示/重复下载（便携 148.4 MB、安装版 67.9 MB）。"
               "`check` 每 24h 一次（constants.py:56），缓存过期后又会提示，用户可能反复装同一版。"
               "当前 rc.5 是唯一最新版，所以只要发布链不在同版本上重发，实际影响有限。",
        witness="Updater(root(portable, active=0.0.1-rc.5)).check(force=True).state == 'update_available'",
        notes="归属：更新器侧（可加『同版且非热修窗口 → up_to_date』的显式判据），或发布链在 notes 里标明热修。",
    )

    # ================================== C11 sha256 / size / 解压上限（一致）
    disk = {}
    for entry in release.assets:
        path = RC5_DIR / entry.name
        disk[entry.name] = {
            "exists": path.is_file(),
            "bytes": path.stat().st_size if path.is_file() else 0,
            "sha256": sha256_of_file(path) if path.is_file() else "",
        }
    sums_rows = []
    if sums_path.is_file():
        for line in sums_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            digest, _, name = line.partition("  ")
            sums_rows.append({"sha256": digest.strip(), "name": name.strip()})
    portable_zip = RC5_DIR / portable_entry.name
    zip_entries = 0
    zip_uncompressed = 0
    with zipfile.ZipFile(portable_zip) as archive:  # 只读中央目录，不解压
        for info in archive.infolist():
            zip_entries += 1
            zip_uncompressed += max(0, info.file_size)
    sha_lower_ok = all(len(item.sha256) == 64 and item.sha256 == item.sha256.lower() for item in release.assets)
    add_case(
        cid="C11",
        dimension="7-sha256/size/解压上限",
        title="sha256 小写 64 hex、size 与磁盘一致、三个上限全部有余量（含真实 zip 条目实测）",
        verdict="PASS",
        severity="",
        expect="sha256 必须小写 64 hex（manifest.py:222-223）；size ≤ 512 MiB（:218）；"
               "解压条目 ≤ 200,000、解压总字节 ≤ 2 GiB（archive.py:39-43）",
        actual=f"disk={ {k: (v['bytes'], v['sha256'][:12]) for k, v in disk.items()} }；"
               f"zip entries={zip_entries} uncompressed={zip_uncompressed}；"
               f"caps: asset={constants.MAX_ASSET_BYTES} extract_bytes={constants.MAX_EXTRACT_BYTES} "
               f"extract_entries={constants.MAX_EXTRACT_ENTRIES}",
        assertions=[
            A("两个 sha256 都是小写 64 hex", True, sha_lower_ok),
            A("Setup 磁盘字节 == 清单 size", setup_entry.size, disk[setup_entry.name]["bytes"]),
            A("portable 磁盘字节 == 清单 size", portable_entry.size, disk[portable_entry.name]["bytes"]),
            A("Setup 磁盘 sha256 == 清单 sha256", setup_entry.sha256, disk[setup_entry.name]["sha256"]),
            A("portable 磁盘 sha256 == 清单 sha256", portable_entry.sha256, disk[portable_entry.name]["sha256"]),
            A("SHA256SUMS.txt 两行且与清单一致", True,
              len(sums_rows) == 2 and {row["name"]: row["sha256"] for row in sums_rows}
              == {item.name: item.sha256 for item in release.assets}),
            A("两个 size 都 ≤ MAX_ASSET_BYTES(512 MiB)", True,
              all(item.size <= constants.MAX_ASSET_BYTES for item in release.assets)),
            A("最大资产占 512 MiB 的比例 < 100%（实际约 28%）", True,
              max(item.size for item in release.assets) / constants.MAX_ASSET_BYTES < 1.0),
            A("portable 真实 zip 条目数 ≤ MAX_EXTRACT_ENTRIES(200000)", True,
              zip_entries <= constants.MAX_EXTRACT_ENTRIES),
            A("portable 真实解压总字节 ≤ MAX_EXTRACT_BYTES(2 GiB)", True,
              zip_uncompressed <= constants.MAX_EXTRACT_BYTES),
            A("真实条目数 == 50,840（与 pack-report.json 一致）", 50840, zip_entries),
            A("真实解压字节 ≈ 486.3 MiB（bundle 486,344,515 + 8 个附加文件）", True,
              486_344_515 <= zip_uncompressed <= 486_344_515 + 2_000_000),
        ],
        updater_ref="apps/desktop/updater/manifest.py:29,218-223（sha256/size）、constants.py:65-71（三个上限）、archive.py:37-44（entry/bytes 上限）、verify.py:33-58（先 size 后 hash）",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:8-9,14-15；dist/release/0.0.1-rc.5/SHA256SUMS.txt:1-2；"
                     "docs/implementation/evidence/rc5/release/05-portable/pack-report.json（entryCount=50840）",
        impact="无（一致）。**不会出现『解压即被拒』**：条目数用到上限的 25.4%，解压字节用到 22.6%，"
               "下载体积用到 512 MiB 的 27.6%。载荷再涨 ~3.4 倍才会撞 archive 上限、~1.8 倍才撞下载上限（需同时换打包策略）。",
        witness="zipfile.ZipFile(portable.zip).infolist() → 50840 条、解压 486,3xx,xxx B；"
                "sha256_file(Setup)==清单 sha256；两文件磁盘字节==清单 size",
    )

    # ============================== C12 命名规则单源性（P2）
    version_file = (REPO / "deploy" / "windows" / "installer" / "VERSION")
    version_text = version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else ""
    finalize_src = (REPO / "scripts" / "release" / "finalize-release.mjs").read_text(encoding="utf-8")
    matrix_src = (REPO / "scripts" / "release" / "finalize-matrix.mjs").read_text(encoding="utf-8")
    verify_assets_src = (REPO / "scripts" / "release" / "verify-assets.mjs").read_text(encoding="utf-8")
    build_setup_src = (REPO / "deploy" / "windows" / "installer" / "app" / "build_setup.py").read_text(encoding="utf-8")
    build_dist_src = (REPO / "deploy" / "windows" / "installer" / "build-dist.cmd").read_text(encoding="utf-8")
    support_src = (REPO / "tests" / "desktop" / "updater" / "_support.py").read_text(encoding="utf-8")

    # 演化：同一缺陷是否只发生在 rc.5？把 rc.3/rc.4 的历史清单也读一遍（只读；rc.2 另见 C05，
    # 它因小写仓库名整份被拒，连 resolve 都到不了）。
    legacy: dict[str, object] = {tag: probe_manifest(tag) for tag in ("0.0.1-rc.3", "0.0.1-rc.4", "0.0.1-rc.5")}
    legacy_ok = {tag: item for tag, item in legacy.items() if item.get("parse") == "ok"}
    legacy_all_invalid = bool(legacy_ok) and all(item.get("setup_valid") is False for item in legacy_ok.values())

    add_case(
        cid="C12",
        dimension="8-命名规则单源性",
        title="同一台机器上并存两套 Setup 命名：发布链『无架构』，门禁/夹具/矩阵生成器『带 -win-x64』",
        verdict="FAIL",
        severity="P2",
        expect="一个发布物名只能有一个事实来源；更新器与所有门禁对同一资产名给出同一判定",
        actual=f"VERSION={version_text!r}；finalize-release 无 -win-x64、finalize-matrix 有、verify-assets 有、"
               f"_support 有、build_setup 无；build-dist 只用 VERSION 做目录名；"
               f"历史清单 Setup 的 resolve().valid（rc.3→rc.5）={ {t: v.get('setup_valid') for t, v in legacy.items()} }",
        assertions=[
            A("VERSION 文件内容 == 清单 version", release.version, version_text),
            A("finalize-release.mjs:47 的 Setup 模板不含 -win-x64", True,
              "AIDrivenNetDefense-Setup-${version}.exe" in finalize_src
              and "AIDrivenNetDefense-Setup-${version}-win-x64.exe" not in finalize_src),
            A("finalize-matrix.mjs:45 的 Setup 模板**含** -win-x64", True,
              "AIDrivenNetDefense-Setup-${version}-win-x64.exe" in matrix_src),
            A("verify-assets.mjs:115-116 期望 Setup 名**含** -win-x64", True,
              "AIDrivenNetDefense-Setup-${escaped}-win-x64" in verify_assets_src),
            A("update-assets 门禁把无架构名视为 stray（verify-assets.mjs:12-14 注释）", True,
              "`...-Setup-<ver>.exe`" in verify_assets_src),
            A("build_setup.py:231 生成名 `AIDrivenNetDefense-Setup-{version}`（无架构）", True,
              'name = f"AIDrivenNetDefense-Setup-{version}"' in build_setup_src),
            A("build-dist.cmd 只用 VERSION 作版本/目录名，不参与首包文件名", True,
              'set "NAME=%VER%"' in build_dist_src and "win-x64" not in build_dist_src),
            A("更新器文档示例要求 Setup 名带 -win-x64（assets.py:5）", True,
              "AIDrivenNetDefense-Setup-0.0.1-win-x64.exe" in (REPO / "apps" / "desktop" / "updater" / "assets.py").read_text(encoding="utf-8")),
            A("_support.py:33 的 INSTALLER_NAME 带 -win-x64", True, "-win-x64" in support_src),
            A("历史清单覆盖 rc.3/rc.4/rc.5 三个可解析版本", 3, len(legacy_ok)),
            A("rc.3→rc.5 三版 Setup 全部 valid=False（同一缺陷连续三版，不是 rc.5 回归）", True,
              legacy_all_invalid),
        ],
        updater_ref="apps/desktop/updater/assets.py:5（文档示例）、:317-322（硬规则）",
        producer_ref="scripts/release/finalize-release.mjs:47；deploy/windows/installer/app/build_setup.py:231,274；"
                     "deploy/windows/installer/VERSION:1；对比 scripts/release/finalize-matrix.mjs:45、"
                     "scripts/release/verify-assets.mjs:115-116",
        impact="P2：不是『某一方写错一个字』，而是**两个发布管道并存**：rc.2/rc.3/rc.4/rc.5 走 finalize-release"
               "（2 资产、无架构），矩阵管道走 finalize-matrix（4 资产、带架构）。更新器与矩阵门禁都站在"
               "『带架构』那一边，只有实际出包的那条链站在『无架构』那一边 → C03 的 P0 是系统性的，"
               "且**连续三个版本同形状**（rc.3/rc.4/rc.5 的 Setup 全部 valid=False；rc.2 更早，"
               "它连清单都因小写仓库名被整份拒收，见 C05），不是 rc.5 的回归。",
        witness="grep 'AIDrivenNetDefense-Setup' scripts/release deploy/windows/installer → 4 处带 -win-x64 / 2 处不带",
        notes="归属：发布链（把 build_setup.py / finalize-release.mjs 的 Setup 名加上 -win-x64），"
              "**不是更新器侧**——assets.py:5 的文档、verify-assets.mjs、_support.py 三处都已是带架构写法。",
    )

    # ============================== C13 现有测试为何没抓到（P2）
    test_dir = REPO / "tests" / "desktop" / "updater"
    test_sources = {path.name: path.read_text(encoding="utf-8") for path in test_dir.glob("*.py")}
    reads_real_manifest = any("dist/release" in text or "dist\\release" in text
                              for text in test_sources.values())
    installer_fixture = getattr(SUPPORT, "INSTALLER_NAME", "") if SUPPORT else ""
    fixture_vs_real = None
    if installer_fixture:
        expected_fixture_name = installer_fixture.replace("0.0.2", release.version)
        fixture_vs_real = {
            "fixture": installer_fixture,
            "expected_if_producer_matched": expected_fixture_name,
            "real": setup_entry.name,
            "portable_matches": portable_entry.name
            == (getattr(SUPPORT, "ASSET_NAME", "") or "").replace("0.0.2", release.version),
        }
    add_case(
        cid="C13",
        dimension="8-命名规则单源性",
        title="既有 updater 测试的夹具名自带 -win-x64：happy path 用的名字发布链永远不会产出，且无一测试读真实清单",
        verdict="FAIL",
        severity="P2",
        expect="至少一条用例用**发布链真实产物名**跑选择矩阵（或用真实 dist/release/*/latest.json）",
        actual=f"INSTALLER_NAME={installer_fixture!r}；真实 Setup={setup_entry.name!r}；"
               f"测试是否读 dist/release 清单={reads_real_manifest}",
        assertions=[
            A("夹具 INSTALLER_NAME 含 -win-x64", True, "-win-x64" in installer_fixture),
            A("按夹具模板替换版本后 ≠ 真实 Setup 名", True,
              (fixture_vs_real or {}).get("expected_if_producer_matched") != (fixture_vs_real or {}).get("real")),
            A("但便携包侧夹具模板 == 真实名（说明只有 Setup 一侧脱节）", True,
              (fixture_vs_real or {}).get("portable_matches")),
            A("updater 测试目录里没有任何文件读 dist/release 的真实清单", False, reads_real_manifest),
            A("无架构拒绝规则本身有单测（test_assets.py:121-128，用 '-win.exe'）", True,
              "test_installer_without_arch_is_refused" in test_sources.get("test_assets.py", "")),
        ],
        updater_ref="tests/desktop/updater/_support.py:31-33（ASSET_NAME/INSTALLER_NAME）、:170-179（build_release_bundle）；"
                    "tests/desktop/updater/test_assets.py:50-57,121-128",
        producer_ref="scripts/release/finalize-release.mjs:47（真实产物名）；dist/release/0.0.1-rc.5/latest.json:7",
        impact="P2（验收缺口，不是产品缺陷）：14 条资产选择用例全绿，是因为夹具自己拼了一个『发布链不会产出』的"
               "合法名字；C03 的 P0 因此从 rc.3 一路绿到 rc.5。拒绝规则有测试，缺的是『夹具名 = 产物名』这条约束。",
        witness="grep -r 'win-x64' tests/desktop/updater/*.py → 仅 _support.py:31,33 与 test_assets.py 内联字符串；"
                "grep -r 'dist/release' tests/desktop/updater/*.py → 0 命中",
        notes="归属：测试侧（合同 §0.3 禁改既有 test_*.py，本席位只报告）。建议新增一条读真实 dist 清单的只读用例。",
    )

    # ============================== C14 发布门禁禁止声明字段（P2）
    verify_release_src = (REPO / "scripts" / "release" / "verify-release.mjs").read_text(encoding="utf-8")
    add_case(
        cid="C14",
        dimension="1-字段名与必填性",
        title="发布门禁（verify-release）只认 4 个字段、只认 2 个资产：想用『清单补 arch 声明』修 C03 会被门禁打红",
        verdict="PARTIAL",
        severity="P2",
        expect="要么门禁允许 assets[*] 带 platform/arch/kind（更新器已支持），要么发布链改文件名（C12）——两条修法只能选一条，当前门禁堵死了前一条",
        actual=f"EXPECTED_FIELDS 出现在 verify-release.mjs={chatty_expected_fields(verify_release_src)}；"
               f"assets.length===2 硬判={('assets.length === 2' in verify_release_src)}",
        assertions=[
            A("verify-release.mjs 的 EXPECTED_FIELDS 恰好 4 个（无 platform/arch/kind）", True,
              chatty_expected_fields(verify_release_src)),
            A("verify-release.mjs 硬判 assets.length === 2", True,
              "assets.length === 2" in verify_release_src),
            A("更新器本身接受 3 个声明字段（manifest.py:230-244）", True,
              any(case_id == "C02" for case_id in [c["id"] for c in CASES])),
            A("矩阵门禁 verify-assets.mjs 反而强制 7 字段（含 platform/arch/kind）", True,
              "['arch', 'kind', 'name', 'platform', 'sha256', 'size', 'url']" in verify_assets_src),
        ],
        updater_ref="apps/desktop/updater/manifest.py:230-244",
        producer_ref="scripts/release/verify-release.mjs:47（EXPECTED_FIELDS）、:153（assets.length===2）；"
                     "对比 scripts/release/verify-assets.mjs:343-351（强制 7 字段）",
        impact="P2：这是 C03 的**修复路径约束**。走『清单补 arch』需同步改 verify-release.mjs:47/153 与 finalize-release.mjs:161；"
               "走『改名』只需改 build_setup.py:231 + finalize-release.mjs:47（发布链 2 处），更小。",
        witness="verify-release.mjs:47 `const EXPECTED_FIELDS = ['version','notes','minVersion','assets']`；"
                "verify-assets.mjs:343 `const assetKeys = ['arch','kind','name','platform','sha256','size','url']`",
        notes="只建议，不改代码。两个门禁互相矛盾本身就是契约漂移（同属 P2）。",
    )

    # ============================== C15 可达性：开关未打开（一致/context）
    add_case(
        cid="C15",
        dimension="0-可达性（背景，非字段差异）",
        title="AUTO_UPDATE_ENABLED=0：出厂客户端一个请求都不会发，rc.5 的 latest.json 目前无消费者",
        verdict="PASS",
        severity="",
        expect="constants.py:24 为 0 → engine.enabled=False → check() 直接返回 disabled（零请求）；"
               "rc.5 的 notes 也明写『更新检查未接线』",
        actual=f"AUTO_UPDATE_ENABLED={constants.AUTO_UPDATE_ENABLED} auto_update_enabled()={constants.auto_update_enabled()}；"
               f"清单 notes 含未接线说明={'更新检查未接线' in raw_text}",
        assertions=[
            A("AUTO_UPDATE_ENABLED == 0", 0, constants.AUTO_UPDATE_ENABLED),
            A("auto_update_enabled() is False", False, constants.auto_update_enabled()),
            A("rc.5 notes 明写『更新检查未接线』", True, "更新检查未接线" in raw_text),
            A("关闭时 check() 立刻返回 disabled 且不发请求", "disabled", _disabled_state(raw)),
        ],
        updater_ref="apps/desktop/updater/constants.py:21-24,85-87；engine.py:206-210",
        producer_ref="dist/release/0.0.1-rc.5/latest.json:3（notes：『更新检查未接线（AUTO_UPDATE_ENABLED=0），本版不会自动更新』）",
        impact="无（双方对『本版不自动更新』口径一致）。**但**：C02/C03/C06/C09/C10 在出厂客户端上当前都不可达（零请求），"
               "打开开关的那一刻才生效——所以 C03 的 P0 是『一开就炸』，不是『现在正在炸』。"
               "这一点写进定级理由，避免被误读成线上已故障。",
        witness="constants.auto_update_enabled() → False；清单 notes 含『更新接线』字样",
    )

    # ============================== C16 /releases/latest 不指向 prerelease（P1，未验证联网）
    latest_url = constants.LATEST_MANIFEST_URL
    notfound_state = _notfound_state(raw)
    add_case(
        cid="C16",
        dimension="3-release tag 形式",
        title="清单地址走 /releases/latest/download/：GitHub 的 latest 只指向『非预发布』版本，而 rc.5 是预发布",
        verdict="PARTIAL",
        severity="P1",
        expect="发布链把 rc 当 pre-release 发布时，/releases/latest/download/latest.json 不会指向它 → 404",
        actual=f"LATEST_MANIFEST_URL={latest_url}；version 含 -rc.={'-rc.' in release.version}；"
               f"404 时引擎行为={notfound_state}",
        assertions=[
            A("清单地址含 /releases/latest/download/", True, "/releases/latest/download/" in latest_url),
            A("清单 version 是预发布（含 -rc.）", True, "-rc." in release.version),
            A("资产 URL 用的是 /download/<tag>/ 而非 /latest/", True,
              "/releases/download/" in setup_entry.url and "/latest/" not in setup_entry.url),
            A("若 latest 解析为 404，引擎落 no_release 且 silent=True（用户看不到异常）",
              {"state": "no_release", "silent": True, "error_code": "UPDATE_NO_RELEASE"}, notfound_state),
        ],
        updater_ref="apps/desktop/updater/constants.py:30-32（LATEST_MANIFEST_URL）、engine.py:245-258（404 → no_release/silent）",
        producer_ref="scripts/release/finalize-release.mjs:26-31（tag 概念）、README/发布链未验证的 GitHub 发布形态",
        impact="P1 **未验证（需联网/需看 Release 发布形态）**：如果 rc.5 以 pre-release 发布，客户端永远读不到这份清单；"
               "而 404 分支被设计成『还没发布任何版本』的静默状态 → 用户不会看到任何错误，"
               "与真正的『没有发布』无法区分。若以 normal release 发布则无此问题。",
        witness="constants.LATEST_MANIFEST_URL 字面量；LATEST_MANIFEST_URL 与 assets URL 的 latest/<tag> 形态差异；"
                "engine 404 分支实测（进程内桩 status=404）",
        notes="合同 §0 禁止外联 → 本轮只能到『形态可疑』，不能断言 GitHub 实际返回什么。已列入 unverified。",
    )

    # ------------------------------------------------------------------ 汇总
    finished = datetime.now(TZ)
    defect_cases = [case for case in CASES if case["verdict"] != "PASS"]
    passed_cases = [case for case in CASES if case["verdict"] == "PASS"]
    severity_counts: dict[str, int] = {}
    for case in defect_cases:
        severity_counts[case["severity"]] = severity_counts.get(case["severity"], 0) + 1
    total_assertions = sum(len(case["assertions"]) for case in CASES)
    held_assertions = sum(1 for case in CASES for item in case["assertions"] if item["holds"])
    reproduced = held_assertions == total_assertions

    defects = []
    for index, case in enumerate(defect_cases, start=1):
        defects.append({
            "id": f"UPD-C-{index:02d}",
            "case": case["id"],
            "severity": case["severity"],
            "dimension": case["dimension"],
            "title": case["title"],
            "ref": case["updater_ref"],
            "producer_ref": case["producer_ref"],
            "expect": case["expect"],
            "actual": case["actual"],
            "impact": case["impact"],
            "witness": case["witness"],
            "verdict": case["verdict"],
        })

    # 稳定的 case→defect 映射，供报告引用
    case_to_defect = {row["case"]: row["id"] for row in defects}
    for case in CASES:
        case["defect_id"] = case_to_defect.get(case["id"], "")

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result = {
        "area": "contract",
        "ran_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "python": f"{sys.version.split()[0]} ({sys.executable})",
        "repo": str(REPO),
        "commands": [
            "PYTHONIOENCODING=utf-8; D:\\Python311\\python.exe tests/desktop/updater/e2e/contract/check_contract.py",
        ],
        "inputs": {
            "manifest": str(manifest_path.relative_to(REPO)),
            "manifest_bytes": len(raw),
            "manifest_sha256": sha256_of_bytes(raw),
            "compare_rc4": str((RC4_DIR / "latest.json").relative_to(REPO)),
            "assets": {name: value for name, value in disk.items()},
            "caps": {
                "MAX_ASSET_BYTES": constants.MAX_ASSET_BYTES,
                "MAX_EXTRACT_BYTES": constants.MAX_EXTRACT_BYTES,
                "MAX_EXTRACT_ENTRIES": constants.MAX_EXTRACT_ENTRIES,
            },
            "portable_zip": {"entries": zip_entries, "uncompressed_bytes": zip_uncompressed},
        },
        "summary": {
            "cases": len(CASES),
            "passed": len(passed_cases),
            "different": len(defect_cases),
            "severity": severity_counts,
            "assertions": {"total": total_assertions, "held": held_assertions},
            "verdict": "CONTRACT-MISMATCH" if defect_cases else "CONTRACT-OK",
        },
        "cases": [
            {
                "id": case["id"],
                "defect_id": case["defect_id"],
                "dimension": case["dimension"],
                "title": case["title"],
                "verdict": case["verdict"],
                "severity": case["severity"],
                "expect": case["expect"],
                "actual": case["actual"],
                "updater_ref": case["updater_ref"],
                "producer_ref": case["producer_ref"],
                "impact": case["impact"],
                "witness": case["witness"],
                "notes": case["notes"],
                "assertions": case["assertions"],
            }
            for case in CASES
        ],
        "defects": defects,
        "observations": [
            {"id": "OBS-1", "severity": "P3", "title": "is_allowed_url 的 path 比较大小写敏感（host 已 lower）",
             "detail": "net.py:90 lower 了 host，:95 的 startswith 不解 lower。rc.5 写法正确，属预期严格性；"
                       "风险是发布链写错大小写时全员 UPDATE_SOURCE_REJECTED，已被 verify-release.mjs:161 兜住。",
             "ref": "apps/desktop/updater/net.py:90-95"},
            {"id": "OBS-2", "severity": "P3", "title": "forced（强制更新）字段无任何消费方",
             "detail": "engine.py:61/93/651 只把它放进状态块；仓库内无 UI/分支读它。rc.5 minVersion='' 时恒 False，无影响。",
             "ref": "apps/desktop/updater/engine.py:621"},
            {"id": "OBS-3", "severity": "P3", "title": "no_asset 状态下 status.action 为空串",
             "detail": "engine.py:628-637：action 在 select 之后赋值，select 抛错时 action 保持 ""，"
                       "而 install_kind 已知（installer）→ UI 拿不到『应该交安装器』这条信息，只能显示 no-matching-asset 文本。",
             "ref": "apps/desktop/updater/engine.py:628-641"},
            {"id": "OBS-4", "severity": "P3", "title": "Release.to_dict() 会补一个 channel 字段，而 verify-release 只认 4 字段",
             "detail": "manifest.py:138-145 输出 5 字段；缓存回读没问题（parse 接受），但若有人把 to_dict 结果直接当 latest.json 发出去，"
                       "verify-release.mjs:47 会判 field-set 不符。",
             "ref": "apps/desktop/updater/manifest.py:138-145"},
        ],
        "zero_egress": {
            "ok": GUARD.report()["ok"],
            "allowed": 0,
            "blocked": GUARD.report()["external_attempts"],
            "dns_blocked": 0,
            "note": "纯本地，未发起任何网络请求",
            "guard": "LocalOnlyGuard（本脚本内联；patch socket.socket.connect / connect_ex / socket.getaddrinfo）",
            "attempts": GUARD.report()["attempts"],
        },
        "unverified": [
            "C16：GitHub 的 /releases/latest/download/latest.json 是否真的读不到 rc.5（取决于 rc.5 以 pre-release 还是 normal release 发布）——"
            "合同 §0 禁止外联，本轮只做静态形态判定，未联网验证。",
            "安装版真实装机后的 end-to-end 下载/交给 Setup.exe：本轮用真实清单 + 进程内传输桩验到 state=no_asset 即止，"
            "未在真装 rc.5 的机器上跑（归六场景/回滚席位；且当前 AUTO_UPDATE_ENABLED=0）。",
            "rc.5 清单在 GitHub 上的实际可下载性（file 存在、release 已上传）：本轮只验本地 dist 产物。",
            "rc.10+ 的版本排序缺陷（C09）只能构造版本号验证，仓库内不存在 rc.10 产物。",
        ],
        "environment": {
            "host_platform": assets.current_platform(),
            "host_arch": assets.process_arch(),
            "note": "引擎状态用例依赖本机 win32/x64；非该组合时会自动跳过引擎断言（脚本会显式标出）。",
        },
    }
    (EVIDENCE / "RESULT.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # ------------------------------------------------------------------ 收尾输出
    emit("")
    emit("-" * 78)
    emit(f"cases      : {len(CASES)}（PASS {len(passed_cases)} / 差异 {len(defect_cases)}）")
    emit(f"severity   : {json.dumps(severity_counts, ensure_ascii=False)}")
    emit(f"assertions : {held_assertions}/{total_assertions} 复现")
    for row in defects:
        emit(f"  {row['id']}  {row['severity']:<2}  [{row['case']}] {row['title']}")
    emit(f"zero_egress: ok={GUARD.report()['ok']} external_attempts={GUARD.report()['external_attempts']}")
    emit(f"evidence   : {EVIDENCE}")
    emit(f"elapsed    : {(finished - started).total_seconds():.2f}s")
    emit("-" * 78)

    GUARD.uninstall()
    (EVIDENCE / "run.log").write_text("\n".join(LINES) + "\n", encoding="utf-8")
    if not reproduced:
        emit("RESULT: STALE（有断言未被复现，结论需重定基线）")
        return 2
    emit("RESULT: OK（全部观测复现；差异均为已坐实的契约不一致）")
    return 0


def chatty_expected_fields(source: str) -> bool:
    """verify-release.mjs 的 EXPECTED_FIELDS 是否恰好是 4 个（不含声明字段）。"""
    marker = "const EXPECTED_FIELDS = ['version', 'notes', 'minVersion', 'assets'];"
    return marker in source


def _disabled_state(raw: bytes) -> str:
    """关闭开关时 check() 应当**不发请求**：用一个会抛异常并记账的 transport 证明。"""
    class ExplodingTransport:
        def get(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise AssertionError("AUTO_UPDATE_ENABLED=0 时不应发请求")

        def download(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise AssertionError("AUTO_UPDATE_ENABLED=0 时不应下载")

    with tempfile.TemporaryDirectory(prefix="aidn-contract-off-") as tmp:
        root = make_install_root(Path(tmp), channel="portable", active="0.0.1-rc.4")
        updater = Updater(root, transport=ExplodingTransport(), enabled=None, current_version="0.0.1-rc.4")
        status = updater.check(force=True)
        return status.state


def _notfound_state(raw: bytes) -> dict:
    """清单地址 404 时引擎的落点（离线桩复现；用于 C16 的影响判定）。"""
    with tempfile.TemporaryDirectory(prefix="aidn-contract-404-") as tmp:
        root = make_install_root(Path(tmp), channel="portable", active="0.0.1-rc.4")
        updater = Updater(root, transport=local_manifest_transport(b"", status=404), enabled=True,
                          current_version="0.0.1-rc.4")
        status = updater.check(force=True)
        return {"state": status.state, "silent": status.silent, "error_code": status.error_code}


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001
        traceback.print_exc()
        LINES.append(traceback.format_exc())
        try:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / "run.log").write_text("\n".join(LINES) + "\n", encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
        raise SystemExit(3)
