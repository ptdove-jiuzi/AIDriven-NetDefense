"""updater —— GitHub Releases 自动更新（ADR-0011 / DIST-DECISION §3 的实现）。

分层：

* ``constants`` 更新源常量，编译期写死，配置改不动；
* ``assets``    多平台资产选择（平台/架构/形态矩阵），选不到就 ``no-matching-asset``；
* ``manifest``  ``latest.json`` 的解析与严格校验；
* ``net``       只走 https、只走白名单主机、不走系统代理的传输层；
* ``verify``    sha256 + size 校验，不符即删包；
* ``archive``   zip 解压（防 zip slip / 符号链接 / 解压炸弹）；
* ``store``     安装布局、``activeVersion`` 指针、``pending.json``；
* ``health``    健康标记与 30 秒轮询；
* ``engine``    检查 → 下载 → 校验 → 解压 → 切换 → 健康检查 → 回滚；
* ``shell_api`` 与桌面壳 ``(status, body)`` 契约一致的三个动作。

关闭状态（``AUTO_UPDATE_ENABLED = 0``）下整个包是惰性的：不发请求、不建目录。
"""

from __future__ import annotations

from . import assets, constants, health, manifest, net, store, verify
from .constants import (
    AUTO_UPDATE_ENABLED,
    HEALTH_TIMEOUT_S,
    UPDATE_REPO_NAME,
    UPDATE_REPO_OWNER,
)
from .engine import RuntimeHooks, Updater, UpdateStatus
from .errors import (
    AmbiguousAsset,
    ArchiveUnsafe,
    AssetRejected,
    FeatureDisabled,
    HealthCheckFailed,
    ManifestInvalid,
    ManifestUntrusted,
    ManualUpdateRequired,
    NetworkUnavailable,
    NoMatchingAsset,
    RateLimited,
    RollbackFailed,
    UpdateError,
)

__all__ = [
    "AUTO_UPDATE_ENABLED",
    "HEALTH_TIMEOUT_S",
    "UPDATE_REPO_NAME",
    "UPDATE_REPO_OWNER",
    "RuntimeHooks",
    "Updater",
    "UpdateStatus",
    "UpdateError",
    "FeatureDisabled",
    "NetworkUnavailable",
    "RateLimited",
    "ManifestInvalid",
    "ManifestUntrusted",
    "AssetRejected",
    "ArchiveUnsafe",
    "HealthCheckFailed",
    "RollbackFailed",
    "NoMatchingAsset",
    "AmbiguousAsset",
    "ManualUpdateRequired",
    "assets",
    "constants",
    "health",
    "manifest",
    "net",
    "store",
    "verify",
]
