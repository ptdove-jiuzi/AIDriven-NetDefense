"""_support.py —— 更新器/显示名/adopt 测试的共用夹具。

原则：**所有落盘都在临时目录里**，测试不碰真实安装目录、真实 data、真实注册表。
网络用 ``FakeTransport`` 完全替身，测试不依赖 GitHub 可达、也不受本机代理影响。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import tempfile
import zipfile
from pathlib import Path

#: 默认把更新器/采纳器的日志压掉：测试输出只留断言结果。
#: 需要看内部日志时设 ``AIDN_TEST_LOG=1``。
if os.environ.get("AIDN_TEST_LOG") != "1":
    logging.disable(logging.CRITICAL)

#: 仓库根（tests/desktop/updater/_support.py 往上三级）。
REPO_ROOT = Path(__file__).resolve().parents[3]

#: 让 ``import updater`` / ``import settings`` / ``import adopt`` 都能成立。
for candidate in (REPO_ROOT / "apps" / "desktop", REPO_ROOT / "deploy" / "windows" / "installer" / "app"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

ASSET_NAME = "AIDrivenNetDefense-0.0.2-win-x64-portable.zip"
#: 一次 Release 的四种资产（DIST-DECISION §4 + linux 追加）。
INSTALLER_NAME = "AIDrivenNetDefense-Setup-0.0.2-win-x64.exe"
LINUX_TAR_NAME = "AIDrivenNetDefense-0.0.2-linux-x64-portable.tar.gz"
DEB_NAME = "aidriven-netdefense_0.0.2_amd64.deb"
RELEASE_TAG = "v0.0.2"


def asset_url(name: str, *, tag: str = RELEASE_TAG) -> str:
    return f"https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/download/{tag}/{name}"


ASSET_URL = asset_url(ASSET_NAME)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class FakeTransport:
    """确定性的传输替身：可模拟正常、304、断网、限流、半包。

    ``assets`` 按文件名（URL 最后一段）分派字节，用于「一次 Release 多个资产」；
    ``asset`` 是单资产场景的简写。
    """

    def __init__(
        self,
        *,
        manifest: bytes | dict | None = None,
        asset: bytes | None = None,
        assets: dict[str, bytes] | None = None,
    ) -> None:
        self.manifest_bytes = (
            manifest if isinstance(manifest, bytes) else json.dumps(manifest or {}).encode("utf-8")
        )
        self.asset_bytes = asset if asset is not None else b""
        self.assets = dict(assets or {})
        self.etag = '"etag-1"'
        self.mode = "ok"  # ok | offline | rate | truncate
        self.manifest_status = 200
        self.calls: list[dict] = []

    # -- Transport 协议
    def get(self, url: str, headers: dict | None = None, *, timeout: float = 20.0):
        from updater import net

        self.calls.append({"method": "get", "url": url, "headers": dict(headers or {})})
        if self.mode == "offline":
            from updater.errors import NetworkUnavailable

            raise NetworkUnavailable("模拟断网：DNS 解析失败")
        if self.mode == "rate":
            from updater.errors import RateLimited

            raise RateLimited("模拟限流：429", retry_after_s=120.0)
        if str((headers or {}).get("if-none-match") or "") == self.etag:
            return net.Response(status=304, headers={"etag": self.etag}, body=b"", url=url)
        if self.manifest_status != 200:
            return net.Response(status=self.manifest_status, headers={}, body=b"", url=url)
        return net.Response(
            status=200,
            headers={"etag": self.etag, "content-type": "application/json"},
            body=self.manifest_bytes,
            url=url,
        )

    def download(self, url: str, dest: Path, headers: dict | None = None, *, timeout: float = 60.0,
                 max_bytes: int = 0):
        from updater import net

        self.calls.append({"method": "download", "url": url, "headers": dict(headers or {})})
        # 多资产场景按文件名取字节；单资产场景回落到 asset_bytes。
        payload = self.assets.get(url.rsplit("/", 1)[-1], self.asset_bytes)
        if self.mode == "offline":
            from updater.errors import NetworkUnavailable

            raise NetworkUnavailable("模拟下载中断：连接被重置")
        if self.mode == "truncate":
            # 刻意先写半包再抛：用来验证「不留半成品」是引擎的责任，不只传输层的。
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(payload[: max(1, len(payload) // 2)])
            from updater.errors import NetworkUnavailable

            raise NetworkUnavailable("模拟下载中途断网")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        return net.Response(status=200, headers={}, body=b"", url=url)


def build_payload_zip(path: Path, *, version: str = "0.0.2", exe_name: str = "AIDrivenNetDefense.exe") -> Path:
    """造一个最小可用的载荷包（桌面 exe + 一个静态资源）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(exe_name, f"MZ fake-desktop-{version}".encode("utf-8"))
        bundle.writestr("console/index.html", f"<html><body>{version}</body></html>")
        bundle.writestr("assets/app.ico", b"\x00" * 32)
    return path


def build_zip_with_entry(path: Path, entry_name: str) -> Path:
    """用于 zip slip / 符号链接用例。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.writestr("AIDrivenNetDefense.exe", b"MZ")
        bundle.writestr(entry_name, b"payload")
    return path


def make_manifest(
    asset_path: Path,
    *,
    version: str = "0.0.2",
    asset_name: str = ASSET_NAME,
    url: str = ASSET_URL,
    sha256: str | None = None,
    size: int | None = None,
    min_version: str = "",
    notes: str = "测试版本",
) -> dict:
    return {
        "version": version,
        "notes": notes,
        "minVersion": min_version,
        "assets": [
            {
                "name": asset_name,
                "size": size if size is not None else asset_path.stat().st_size,
                "sha256": sha256 if sha256 is not None else sha256_of(asset_path),
                "url": url,
            }
        ],
    }


def build_release_bundle(root: Path, *, version: str = "0.0.2") -> dict[str, bytes]:
    """造出一次 Release 的四种资产字节：win 安装包/便携包 + linux deb/tar.gz。"""
    portable_name = ASSET_NAME.replace("0.0.2", version)
    zip_path = build_payload_zip(root / "fixture" / portable_name, version=version)
    return {
        INSTALLER_NAME.replace("0.0.2", version): b"MZ setup-" + version.encode("utf-8"),
        portable_name: zip_path.read_bytes(),
        LINUX_TAR_NAME.replace("0.0.2", version): b"\x1f\x8b fake-tar " + version.encode("utf-8"),
        DEB_NAME.replace("0.0.2", version): b"!<arch>\n fake-deb " + version.encode("utf-8"),
    }


def make_multi_manifest(
    bundle: dict[str, bytes],
    *,
    version: str = "0.0.2",
    min_version: str = "",
    notes: str = "测试版本",
    include: tuple[str, ...] | None = None,
    overrides: dict[str, dict] | None = None,
) -> dict:
    """把资产字节表变成 ``latest.json``。每个条目自己算 size/sha256，互不串用。"""
    entries = []
    for name, data in bundle.items():
        if include is not None and name not in include:
            continue
        entry = {
            "name": name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "url": asset_url(name, tag=f"v{version}"),
        }
        entry.update((overrides or {}).get(name, {}))
        entries.append(entry)
    return {"version": version, "notes": notes, "minVersion": min_version, "assets": entries}


class TempRoot:
    """临时安装根，退出时整棵删掉。"""

    def __init__(self, prefix: str = "aidn-upd-") -> None:
        self._dir = tempfile.TemporaryDirectory(prefix=prefix)
        self.path = Path(self._dir.name)

    def __enter__(self) -> Path:
        return self.path

    def __exit__(self, *_exc) -> None:
        self._dir.cleanup()


def make_install_root(
    root: Path,
    *,
    version: str = "0.0.1",
    channel: str = "installed",
    data_files: dict[str, bytes] | None = None,
    with_versions: bool = True,
) -> Path:
    """造一个已安装的根目录：install\\install.json + versions\\<v>\\ + data\\。"""
    record_dir = root / "install"
    record_dir.mkdir(parents=True, exist_ok=True)
    exe = "AIDrivenNetDefense.exe"
    if with_versions:
        version_dir = root / "versions" / version
        version_dir.mkdir(parents=True, exist_ok=True)
        (version_dir / exe).write_bytes(b"MZ old-desktop")
    (root / "data").mkdir(parents=True, exist_ok=True)
    for name, payload in (data_files or {"db.sqlite": b"sqlite-bytes", "rules/a.json": b"{}"}).items():
        target = root / "data" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
    (record_dir / "install.json").write_text(
        json.dumps(
            {
                "schema": 2 if with_versions else 1,
                "product": "AIDriven NetDefense",
                "version": version,
                "activeVersion": version if with_versions else "",
                "channel": channel,
                "installPath": str(root),
                "desktopExe": exe,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return root


def make_portable_root(root: Path, *, version: str = "0.0.1", with_bundle: bool = False) -> Path:
    """造一个便携目录：载荷散在根上，install\\install.json 里 channel=portable。"""
    (root / "install").mkdir(parents=True, exist_ok=True)
    (root / "AIDrivenNetDefense.exe").write_bytes(b"MZ portable desktop")
    (root / "console").mkdir(parents=True, exist_ok=True)
    (root / "console" / "index.html").write_text("<html>portable</html>", encoding="utf-8")
    (root / "runtime").mkdir(parents=True, exist_ok=True)
    (root / "runtime" / "node.exe").write_bytes(b"MZ node")
    (root / "data").mkdir(parents=True, exist_ok=True)
    (root / "data" / "db.sqlite").write_bytes(b"sqlite-bytes")
    (root / "data" / "rules").mkdir(parents=True, exist_ok=True)
    (root / "data" / "rules" / "builtin.json").write_bytes(b'{"rules":[]}')
    (root / "installer").mkdir(parents=True, exist_ok=True)
    (root / "installer" / "Setup.cmd").write_text("@echo off\n", encoding="utf-8")
    (root / "install" / "install.json").write_text(
        json.dumps(
            {
                "product": "AIDriven NetDefense",
                "version": version,
                "installPath": str(root),
                "channel": "portable",
                "desktopExe": "AIDrivenNetDefense.exe",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    if with_bundle:
        (root / "bundle.json").write_text(json.dumps({"version": version, "kind": "portable"}), encoding="utf-8")
    return root
