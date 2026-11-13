"""manifest.py —— ``latest.json`` 的解析与严格校验。

清单是更新链上唯一的「发布者意图」载体，所以这里的默认答案是**拒绝**：

- 版本号必须是语义化版本（``X.Y.Z`` 或 ``X.Y.Z-pre``），不接受 ``v1``/``latest``；
- 每个 asset 必须有 ``name`` / ``size`` / ``sha256`` / ``url``，缺一即整份失效；
- ``sha256`` 必须是 64 位十六进制，不「宽容」地接受大写混写以外的写法；
- ``url`` 必须 https 且落在本仓库（或其 CDN）上，见 ``net.is_allowed_url``；
- ``name`` 不能带路径分隔符（它会被当成落盘文件名）。

清单加载失败与内容不可信是两种失败，分别对应 ``ManifestInvalid`` 与
``ManifestUntrusted``：前者是「坏了」，后者是「不对劲」。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from . import constants, net
from .assets import ARCHES as _ARCHES, KINDS as _KINDS, PLATFORMS as _PLATFORMS
from .errors import ManifestInvalid, ManifestUntrusted

#: 语义化版本：主.次.修订，可选 ``-预发布``。构建元数据 ``+build`` 一律不接受。
_VERSION_RE = re.compile(r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
                         r"(?:-(?P<pre>[0-9A-Za-z.-]+))?$")

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def parse_version(text: str) -> tuple[int, int, int, int, str]:
    """把版本号拆成可比较的元组。

    返回 ``(major, minor, patch, 预发布序号, 预发布串)``：正式版预发布序号为 1，
    预发布为 0 —— 这样 ``1.0.0 > 1.0.0-rc.1`` 天然成立，不需要额外分支。
    """
    match = _VERSION_RE.match(str(text).strip())
    if not match:
        raise ManifestInvalid(f"版本号不是语义化版本：{text!r}")
    pre = match.group("pre") or ""
    return (
        int(match.group("major")),
        int(match.group("minor")),
        int(match.group("patch")),
        0 if pre else 1,
        pre,
    )


def is_semver(text: str) -> bool:
    try:
        parse_version(text)
        return True
    except ManifestInvalid:
        return False


def compare_versions(left: str, right: str) -> int:
    """左小于右返回 -1，相等 0，大于 1。"""
    a, b = parse_version(left), parse_version(right)
    for index in range(4):
        if a[index] != b[index]:
            return -1 if a[index] < b[index] else 1
    # 同为预发布再比字符串，只为给出稳定顺序，不追求 semver 的完整序。
    if a[4] == b[4]:
        return 0
    return -1 if a[4] < b[4] else 1


def is_newer(latest: str, current: str) -> bool:
    return compare_versions(latest, current) > 0


def allows_reinstall(version: str) -> bool:
    """``0.0.x`` 阶段允许同版本覆盖安装（ADR-0011 §2 的热修例外）。"""
    try:
        major, minor, _patch, _pre, _ = parse_version(version)
    except ManifestInvalid:
        return False
    return major == 0 and minor == 0


@dataclass
class Asset:
    """清单里的一个文件。

    ``platform`` / ``arch`` / ``kind`` 是**可选**的显式声明：老清单没有这三个字段，
    选择器会退到文件名解析（见 ``assets.resolve``）。新清单建议写上，因为
    「文件名说了什么」和「发布者想说什么」本该一致，写出来就能被机器核对。
    """

    name: str
    size: int
    sha256: str
    url: str
    platform: str = ""
    arch: str = ""
    kind: str = ""

    def to_dict(self) -> dict:
        block = {"name": self.name, "size": self.size, "sha256": self.sha256, "url": self.url}
        for key, value in (("platform", self.platform), ("arch", self.arch), ("kind", self.kind)):
            if value:
                block[key] = value
        return block


@dataclass
class Release:
    """一份通过校验的 Release 清单。"""

    version: str
    notes: str = ""
    min_version: str = ""
    assets: list[Asset] = field(default_factory=list)
    channel: str = "stable"
    raw: dict = field(default_factory=dict)

    def asset(self, name: str) -> Asset | None:
        for candidate in self.assets:
            if candidate.name == name:
                return candidate
        return None

    def payload(self) -> Asset | None:
        """**历史接口**：第一个便携 zip。

        多平台之后「唯一载荷」的假设已经不成立（安装版要 Setup.exe、Linux 要
        deb/tar.gz），真正的选择走 ``assets.select``。保留本方法只为兼容旧调用方，
        新代码不得用它决定下载哪个文件。
        """
        for candidate in self.assets:
            if candidate.name.endswith(constants.UPDATE_ASSET_SUFFIX):
                return candidate
        return None

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "notes": self.notes,
            "minVersion": self.min_version,
            "channel": self.channel,
            "assets": [a.to_dict() for a in self.assets],
        }


def parse(payload: bytes | str | dict) -> Release:
    """解析并校验清单。任何疑点都抛异常，不做「尽力而为」。"""
    if isinstance(payload, dict):
        data = payload
    else:
        text = payload.decode("utf-8", "strict") if isinstance(payload, bytes) else payload
        try:
            data = json.loads(text)
        except (ValueError, UnicodeDecodeError) as error:
            raise ManifestInvalid(f"latest.json 不是合法 JSON：{error}") from error
    if not isinstance(data, dict):
        raise ManifestInvalid("latest.json 顶层必须是对象")

    version = data.get("version")
    if not isinstance(version, str) or not is_semver(version):
        raise ManifestInvalid(f"latest.json 的 version 缺失或非法：{version!r}")

    notes = data.get("notes") or ""
    if not isinstance(notes, str):
        raise ManifestInvalid("latest.json 的 notes 必须是字符串")

    min_version = data.get("minVersion") or ""
    if min_version and not is_semver(min_version):
        raise ManifestInvalid(f"latest.json 的 minVersion 非法：{min_version!r}")

    channel = data.get("channel") or "stable"
    if channel != "stable":
        # 本期只有 stable；beta 字段预留但不接受，防止误发。
        raise ManifestInvalid(f"不支持的通道：{channel!r}（本期只有 stable）")

    raw_assets = data.get("assets")
    if not isinstance(raw_assets, list) or not raw_assets:
        raise ManifestInvalid("latest.json 的 assets 必须是非空数组")

    assets: list[Asset] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_assets):
        assets.append(_parse_asset(item, index, seen))

    release = Release(
        version=version,
        notes=notes,
        min_version=min_version,
        assets=assets,
        channel=channel,
        raw=data,
    )
    # 这里**不再**要求清单里必须有 `*-portable.zip`：Linux-only 的 Release
    # 只有 deb/tar.gz，那样会被整份判死。有没有「能用的」资产由
    # assets.select() 按当前平台/形态判定，失败即 no-matching-asset。
    return release


def _parse_asset(item: object, index: int, seen: set[str]) -> Asset:
    if not isinstance(item, dict):
        raise ManifestInvalid(f"assets[{index}] 必须是对象")

    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ManifestInvalid(f"assets[{index}].name 缺失")
    if "/" in name or "\\" in name or name in (".", ".."):
        # 名字会直接当落盘文件名，带路径分隔符就等于让清单决定写到哪。
        raise ManifestUntrusted(f"assets[{index}].name 含路径分隔符，已拒绝：{name!r}")
    if name in seen:
        raise ManifestInvalid(f"assets 里 {name!r} 重复")
    seen.add(name)

    size = item.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise ManifestInvalid(f"assets[{index}].size 必须是正整数（{name}）")
    if size > constants.MAX_ASSET_BYTES:
        raise ManifestInvalid(f"assets[{index}].size 超过上限（{name}，{size} 字节）")

    digest = item.get("sha256")
    if not isinstance(digest, str) or not _SHA256_RE.match(digest):
        raise ManifestInvalid(f"assets[{index}].sha256 必须是 64 位小写十六进制（{name}）")

    url = item.get("url")
    if not isinstance(url, str) or not url:
        raise ManifestInvalid(f"assets[{index}].url 缺失（{name}）")
    net.require_allowed_url(url, f"assets[{index}].url")

    declared = {}
    for key, allowed in (
        ("platform", _PLATFORMS),
        ("arch", _ARCHES),
        ("kind", _KINDS),
    ):
        value = item.get(key)
        if value is None or value == "":
            declared[key] = ""
            continue
        if not isinstance(value, str) or value.strip().lower() not in allowed:
            raise ManifestInvalid(
                f"assets[{index}].{key} 取值非法（{name}）：{value!r}"
            )
        declared[key] = value.strip().lower()

    return Asset(
        name=name,
        size=size,
        sha256=digest,
        url=url,
        platform=declared["platform"],
        arch=declared["arch"],
        kind=declared["kind"],
    )
