"""assets.py —— 多平台资产选择：清单里一堆文件，选错就等于装错。

一次 Release 的资产（DIST-DECISION §4 + Linux 追加）::

    AIDrivenNetDefense-Setup-0.0.1-win-x64.exe            installer / win32 / x64
    AIDrivenNetDefense-0.0.1-win-x64-portable.zip         portable  / win32 / x64
    aidrivennetdefense_0.0.1_amd64.deb                    deb       / linux / x64
    AIDrivenNetDefense-0.0.1-linux-x64-portable.tar.gz    portable  / linux / x64

选择矩阵（本模块即唯一事实来源；改这里等于改协议）::

    | 平台  | 当前安装形态        | 选中 kind | 架构规则                 | 更新方式                   |
    |-------|---------------------|-----------|--------------------------|----------------------------|
    | win32 | 安装版（installed） | installer | **必须**等于进程位数     | 下载 Setup.exe，交安装器   |
    | win32 | 便携版（portable）  | portable  | 清单声明了就必须相等     | zip 就地自更新（可回滚）   |
    | linux | deb 包安装          | deb       | 清单声明了就必须相等     | 只提示 + 给下载链接        |
    | linux | 解压运行（tar.gz）  | portable  | 清单声明了就必须相等     | 只提示 + 给下载链接        |

三条硬规则：

1. **找不到就是找不到**：抛 ``NoMatchingAsset``（``no-matching-asset``），不回落、
   不「挑个最像的」。自动更新里最危险的不是更新失败，是更新成了别人的架构。
2. **架构来自进程本身**：``struct.calcsize("P") * 8``，不看安装目录名（带 ``(x86)``
   的那个目录在 32 位系统上装 64 位包时会撒谎），也不看环境变量里的
   ``PROCESSOR_*`` 字符串——那些是外部输入，进程位数才是事实。
3. **安装包必须自证架构**：``installer`` 的文件名/字段里没有架构标记时视为不可用，
   而不是「大概是 x64 吧」。便携包允许架构中立（不声明 = 任意架构可用），
   因为便携包本身就是同一份载荷的压缩。

Linux 一律不自更新：deb 归包管理器管，tar.gz 由用户自己换目录。更新器只负责
「检测到新版本 → 提示 → 给出正确下载链接」，``delivery()`` 用 ``manual`` 表达这一点。
"""

from __future__ import annotations

import re
import struct
import sys
from dataclasses import dataclass

from . import store
from .errors import AmbiguousAsset, AssetRejected, NoMatchingAsset

# --------------------------------------------------------------------- 词表

#: 平台。与 ``sys.platform`` 的对应关系见 ``current_platform()``。
PLATFORM_WINDOWS = "win32"
PLATFORM_LINUX = "linux"
PLATFORMS = (PLATFORM_WINDOWS, PLATFORM_LINUX)

#: 架构。只列发布链真实产出的三种；其余一律不匹配。
ARCH_X64 = "x64"
ARCH_X86 = "x86"
ARCH_ARM64 = "arm64"
ARCHES = (ARCH_X64, ARCH_X86, ARCH_ARM64)

#: 安装形态（资产类型）。
KIND_INSTALLER = "installer"
KIND_PORTABLE = "portable"
KIND_DEB = "deb"
KINDS = (KIND_INSTALLER, KIND_PORTABLE, KIND_DEB)

#: 更新方式：就地自更新 / 交安装器 / 只能手动。
ACTION_SELF_UPDATE = "self-update"
ACTION_INSTALLER = "installer"
ACTION_MANUAL = "manual"

#: ``install.json`` 的 ``channel`` 值 → 安装形态。
#: 老安装器写 ``installed``，adopt 之后也是 ``installed``；便携包写 ``portable``；
#: deb 包由打包脚本写 ``deb``（D2 的 CI 负责）。没有记录 = 解压运行。
INSTALLER_CHANNELS = frozenset({"installed", "installer"})
PORTABLE_CHANNELS = frozenset({"portable", "zip", "tar.gz", "tgz"})
DEB_CHANNELS = frozenset({"deb", "dpkg", "apt"})

#: 文件名里的平台标记。全部按小写 token 匹配，不做子串匹配（``darwin`` 不该命中
#: ``win``）。
_PLATFORM_TOKENS = {
    PLATFORM_WINDOWS: frozenset({"win", "win32", "windows"}),
    PLATFORM_LINUX: frozenset({"linux"}),
}

#: 文件名里的架构标记。``amd64``/``x86_64`` 都归 ``x64``，便于跨工具链统一。
_ARCH_TOKENS = {
    ARCH_X64: frozenset({"x64", "amd64", "x86_64"}),
    ARCH_X86: frozenset({"x86", "i386", "i686", "ia32"}),
    ARCH_ARM64: frozenset({"arm64", "aarch64"}),
}

#: 安装包的标记词。没有这些词、又不是 .msi 的 .exe 不被当成安装包。
_INSTALLER_TOKENS = frozenset({"setup", "installer", "install"})

_TOKEN_SPLIT = re.compile(r"[^a-z0-9]+")


# --------------------------------------------------------------------- 结构


@dataclass(frozen=True)
class Target:
    """「我在什么机器上、以什么形态装着」——选择器的输入。"""

    platform: str
    arch: str
    kind: str

    def to_dict(self) -> dict:
        return {"platform": self.platform, "arch": self.arch, "kind": self.kind}


@dataclass(frozen=True)
class Resolved:
    """一个资产被解读后的结果。``valid=False`` 时 ``reason`` 说明为什么不能用。"""

    asset: object
    name: str
    platform: str = ""
    arch: str = ""
    kind: str = ""
    valid: bool = False
    reason: str = ""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "platform": self.platform,
            "arch": self.arch,
            "kind": self.kind,
            "valid": self.valid,
            "reason": self.reason,
        }


# --------------------------------------------------------------- 进程事实


def process_bits() -> int:
    """当前解释器的位数，**唯一**来源是 ``struct.calcsize("P")``。

    等价写法「最大整数比 2**32 大」也可以，但本仓库只认这一个表达式：
    测试直接 grep 源码，防止有人改回「看目录名」。
    """
    return struct.calcsize("P") * 8


def process_arch(bits: int | None = None) -> str:
    """把位数翻译成资产词表里的架构。无法判定就报 ``no-matching-asset``。"""
    value = process_bits() if bits is None else int(bits)
    if value == 64:
        return ARCH_X64
    if value == 32:
        return ARCH_X86
    raise NoMatchingAsset(
        f"no-matching-asset：无法判定当前进程位数（struct.calcsize('P')*8 = {value}）",
        detail={"bits": value},
    )


def current_platform() -> str:
    """规范化 ``sys.platform``。未支持的系统交给选择器报 no-matching-asset。"""
    raw = sys.platform
    if raw == "win32" or raw.startswith("win"):
        return PLATFORM_WINDOWS
    if raw.startswith("linux"):
        return PLATFORM_LINUX
    return raw


def current_target(kind: str) -> Target:
    return Target(platform=current_platform(), arch=process_arch(), kind=kind)


# ---------------------------------------------------------------- 形态判定


def install_kind(root, platform: str) -> str:
    """从 ``install.json`` 的 ``channel`` 推出当前安装形态。

    * Windows：没有记录也按**安装版**处理——首次安装要跑的就是 Setup.exe；
    * Linux：没有记录按**解压运行**处理（tar.gz），因为 deb 安装一定会由打包脚本
      写下 ``channel=deb``。这两条都是保守假设，写在注释里而不是猜目录名。
    """
    channel = str(store.read_record(root).get("channel") or "").strip().lower()
    if platform == PLATFORM_LINUX:
        if channel in DEB_CHANNELS:
            return KIND_DEB
        return KIND_PORTABLE
    if channel in PORTABLE_CHANNELS:
        return KIND_PORTABLE
    if channel in DEB_CHANNELS:
        # Windows 上出现 deb 记录只可能是记录被改坏了：按安装版处理，选择时会
        # 因为找不到 installer 而明确报 no-matching-asset，而不是悄悄换成便携包。
        return KIND_INSTALLER
    if channel in INSTALLER_CHANNELS or not channel:
        return KIND_INSTALLER
    return KIND_INSTALLER


def delivery(platform: str, kind: str) -> str:
    """这种「平台 + 形态」组合允许哪种更新方式。"""
    if platform == PLATFORM_WINDOWS:
        if kind == KIND_PORTABLE:
            return ACTION_SELF_UPDATE
        if kind == KIND_INSTALLER:
            return ACTION_INSTALLER
    return ACTION_MANUAL


def self_update_supported(platform: str, kind: str) -> bool:
    return delivery(platform, kind) == ACTION_SELF_UPDATE


# ------------------------------------------------------------------ 解析


def _tokens(name: str) -> set[str]:
    return {token for token in _TOKEN_SPLIT.split(name.lower()) if token}


def _declared(asset, field: str) -> str:
    return str(getattr(asset, field, "") or "").strip().lower()


def _kind_of(lower: str, tokens: set[str], declared: str) -> tuple[str, str]:
    if declared:
        if declared not in KINDS:
            return "", f"清单声明的 kind 不认识：{declared}"
        return declared, ""
    if lower.endswith(".deb"):
        return KIND_DEB, ""
    if lower.endswith(".tar.gz") or lower.endswith(".tgz"):
        return KIND_PORTABLE, ""
    if lower.endswith("portable.zip"):
        return KIND_PORTABLE, ""
    if lower.endswith(".msi"):
        return KIND_INSTALLER, ""
    if lower.endswith(".exe") and (tokens & _INSTALLER_TOKENS):
        return KIND_INSTALLER, ""
    return "", "文件名既不是安装包、便携包，也不是 deb/tar.gz"


def _platform_of(tokens: set[str], kind: str, declared: str) -> tuple[str, str]:
    if declared:
        if declared not in PLATFORMS:
            return "", f"清单声明的 platform 不认识：{declared}"
        return declared, ""
    has_win = bool(tokens & _PLATFORM_TOKENS[PLATFORM_WINDOWS])
    has_linux = bool(tokens & _PLATFORM_TOKENS[PLATFORM_LINUX])
    if has_win and has_linux:
        return "", "文件名同时带 win 与 linux 标记，无法判定平台"
    if kind == KIND_DEB:
        return PLATFORM_LINUX, ""
    if has_linux:
        return PLATFORM_LINUX, ""
    if has_win:
        return PLATFORM_WINDOWS, ""
    if kind == KIND_INSTALLER:
        # .exe/.msi 在发布链里只可能是 Windows 安装包；这一条是扩展名本身的语义，
        # 不是从目录名/系统环境猜出来的。
        return PLATFORM_WINDOWS, ""
    return "", "文件名里没有 win/linux 平台标记"


def _arch_of(tokens: set[str], declared: str) -> str:
    if declared:
        return declared if declared in ARCHES else ""
    found = {arch for arch, aliases in _ARCH_TOKENS.items() if tokens & aliases}
    # 同时出现两种架构标记（如手滑写成 win-x64-x86）时返回空：宁可判为「未声明」，
    # 也不按出现顺序挑一个。
    return next(iter(found)) if len(found) == 1 else ""


def resolve(asset) -> Resolved:
    """把一个资产条目解读成 ``(平台, 架构, 形态)``。"""
    name = str(getattr(asset, "name", "") or "")
    lower = name.lower()
    tokens = _tokens(name)

    kind, kind_reason = _kind_of(lower, tokens, _declared(asset, "kind"))
    if not kind:
        return Resolved(asset=asset, name=name, reason=kind_reason)

    platform, platform_reason = _platform_of(tokens, kind, _declared(asset, "platform"))
    if not platform:
        return Resolved(asset=asset, name=name, kind=kind, reason=platform_reason)

    declared_arch = _declared(asset, "arch")
    arch = _arch_of(tokens, declared_arch)
    if declared_arch and not arch:
        return Resolved(
            asset=asset, name=name, platform=platform, kind=kind,
            reason=f"清单声明的 arch 不认识：{declared_arch}",
        )

    # 跨字段一致性：deb 只能属于 linux，installer 只能属于 windows。
    if kind == KIND_DEB and platform != PLATFORM_LINUX:
        return Resolved(
            asset=asset, name=name, platform=platform, kind=kind,
            reason="deb 只能用于 linux",
        )
    if kind == KIND_INSTALLER and platform == PLATFORM_LINUX:
        return Resolved(
            asset=asset, name=name, platform=platform, kind=kind,
            reason="installer 只能用于 windows",
        )
    # 形态必须与平台的文件类型一致：linux 的便携包是 tar.gz，windows 的是 zip。
    # 不拦这一条，一个带 linux 字样的 zip 会被当成 linux 便携包选中。
    if kind == KIND_PORTABLE and platform == PLATFORM_LINUX and not lower.endswith((".tar.gz", ".tgz")):
        return Resolved(
            asset=asset, name=name, platform=platform, kind=kind,
            reason="linux 便携包必须是 tar.gz/tgz",
        )
    if kind == KIND_PORTABLE and platform == PLATFORM_WINDOWS and not lower.endswith(".zip"):
        return Resolved(
            asset=asset, name=name, platform=platform, kind=kind,
            reason="windows 便携包必须是 zip",
        )
    # 安装包必须自证架构：没有架构标记的 Setup.exe 无法证明能在当前进程上跑。
    if kind == KIND_INSTALLER and not arch:
        return Resolved(
            asset=asset, name=name, platform=platform, kind=kind,
            reason="安装包未声明架构（文件名缺 x64/x86/arm64），无法证明与当前进程匹配",
        )

    return Resolved(
        asset=asset, name=name, platform=platform, arch=arch, kind=kind, valid=True
    )


def matches(resolved: Resolved, target: Target) -> bool:
    """``resolved`` 是否可用于 ``target``。架构为空 = 架构中立，任意位数都可用。"""
    if not resolved.valid:
        return False
    if resolved.platform != target.platform or resolved.kind != target.kind:
        return False
    return not resolved.arch or resolved.arch == target.arch


# ------------------------------------------------------------------ 选择


def select(release, *, platform: str, arch: str, kind: str):
    """按矩阵选出一个 ``Asset``。选不到就抛 ``NoMatchingAsset``。

    返回值永远是清单里的**完整条目**（name/size/sha256/url 来自同一对象），
    调用方不得再自己拼字段——那样会出现「名字取自 A、哈希取自 B」的混搭。
    """
    target = Target(platform=platform, arch=arch, kind=kind)
    resolved = [resolve(asset) for asset in release.assets]
    candidates = [item for item in resolved if matches(item, target)]

    if not candidates:
        raise NoMatchingAsset(
            "no-matching-asset：清单里没有适用于 "
            f"{platform}/{arch}/{kind} 的资产",
            detail={
                "target": target.to_dict(),
                "assets": [item.to_dict() for item in resolved],
                "matrix_row": _matrix_row(platform, kind),
            },
        )

    # 先挑精确架构，再允许架构中立（只可能是 portable/tar.gz）。
    exact = [item for item in candidates if item.arch == arch]
    chosen = exact or candidates
    if len(chosen) > 1:
        raise AmbiguousAsset(
            "清单里有多个同样适用于 "
            f"{platform}/{arch}/{kind} 的资产，拒绝随便挑一个",
            detail={"names": [item.name for item in chosen], "target": target.to_dict()},
        )
    return chosen[0].asset


def _matrix_row(platform: str, kind: str) -> str:
    """给错误详情带一行「本应长什么样」，便于用户/CI 对照。"""
    table = {
        (PLATFORM_WINDOWS, KIND_INSTALLER): "win32 + 安装版 → kind=installer 且 arch=当前进程位数",
        (PLATFORM_WINDOWS, KIND_PORTABLE): "win32 + 便携版 → kind=portable（架构中立或有声明则须相等）",
        (PLATFORM_LINUX, KIND_DEB): "linux + deb 安装 → kind=deb",
        (PLATFORM_LINUX, KIND_PORTABLE): "linux + tar.gz → kind=portable",
    }
    return table.get((platform, kind), "未支持的平台/形态组合")


# ------------------------------------------------------------------ 审计


def describe(asset) -> dict:
    """给 UI / 状态块用的资产描述，附带解读结果。"""
    item = resolve(asset)
    return {
        "name": getattr(asset, "name", ""),
        "size": getattr(asset, "size", 0),
        "sha256": getattr(asset, "sha256", ""),
        "url": getattr(asset, "url", ""),
        "kind": item.kind,
        "platform": item.platform,
        "arch": item.arch,
    }


def fingerprint(asset) -> dict:
    """同一 asset 条目的三件套。比较时用这个，别逐字段比。"""
    return {
        "name": getattr(asset, "name", ""),
        "size": getattr(asset, "size", 0),
        "sha256": getattr(asset, "sha256", ""),
    }


def check_entry(release, asset) -> None:
    """确认「选中的条目」就是清单里的那一条，size/sha256 没被别的条目串过来。

    这是防混搭的**代码级**保险：即便将来有人写了「挑 A 的名字、借 B 的哈希」的
    逻辑，也会在这里被拦下，而不是等到校验失败后让用户怀疑包坏了。
    """
    entry = release.asset(getattr(asset, "name", ""))
    if entry is None:
        raise AssetRejected(
            f"选中的资产 {getattr(asset, 'name', '')!r} 不在清单里，已拒绝",
            detail={"name": getattr(asset, "name", "")},
        )
    if fingerprint(entry) != fingerprint(asset):
        raise AssetRejected(
            "资产的 size/sha256 与清单条目不一致（疑似混用了另一个条目的字段），已拒绝",
            detail={"expected": fingerprint(entry), "actual": fingerprint(asset)},
        )
