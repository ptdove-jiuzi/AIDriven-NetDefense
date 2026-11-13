"""errors.py —— 更新器的失败分类。

三类失败的处置方式不同，必须在类型上就分开，否则 UI 只能一刀切地弹窗：

* **静默**（``silent = True``）：断网、被限流、没有新版。用户没做错任何事，
  提示只会变成噪音。设置页里留一行「上次检查：离线」就够，不弹窗。
* **明确拒绝**（``silent = False`` + 稳定 code）：哈希不符、包结构越界、来源不是
  本仓库。这类必须让用户看到——它意味着「有人动过这个包」，不能悄悄吞掉。
* **可回滚**：新版没通过健康检查。回滚是自动的，UI 只报一次结果，不报一串原因。

每个异常都带 ``code``（给程序判断）与 ``message``（给人看），两个都不为空。
"""

from __future__ import annotations


class UpdateError(Exception):
    """所有更新失败的基类。"""

    #: 稳定代码，供 UI / 日志 / 测试断言使用，改动等于改协议。
    code = "UPDATE_FAILED"
    #: 是否属于「不值得弹窗」的失败。
    silent = False

    def __init__(self, message: str = "", *, detail: dict | None = None) -> None:
        super().__init__(message or self.code)
        self.message = message or self.code
        self.detail = detail or {}

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "silent": self.silent, "detail": self.detail}


class FeatureDisabled(UpdateError):
    """``AUTO_UPDATE_ENABLED == 0``。不是错误，是没开门。"""

    code = "UPDATE_DISABLED"
    silent = True


class NetworkUnavailable(UpdateError):
    """断网、DNS 失败、超时、连接被重置。全部静默。"""

    code = "UPDATE_OFFLINE"
    silent = True


class RateLimited(UpdateError):
    """GitHub 限流（429 / 403 且剩余额度为 0）。静默，等下次。"""

    code = "UPDATE_RATE_LIMITED"
    silent = True

    def __init__(self, message: str = "", *, retry_after_s: float | None = None, **kwargs) -> None:
        super().__init__(message, **kwargs)
        self.retry_after_s = retry_after_s


class ManifestInvalid(UpdateError):
    """清单不是合法 JSON、缺字段、版本号不是语义化版本。"""

    code = "UPDATE_MANIFEST_INVALID"


class ManifestUntrusted(UpdateError):
    """清单里的地址指向了本仓库之外（含 http、跨域跳转）。"""

    code = "UPDATE_SOURCE_REJECTED"


class AssetRejected(UpdateError):
    """下载下来的包与清单对不上（sha256 / size），或超出体积上限。"""

    code = "UPDATE_ASSET_REJECTED"


class ArchiveUnsafe(UpdateError):
    """压缩包里有越界路径、符号链接或解压炸弹。整包拒绝，不挑着解。"""

    code = "UPDATE_ARCHIVE_UNSAFE"


class StagingFailed(UpdateError):
    """解压 / 建目录失败。当前版本完全没被碰过。"""

    code = "UPDATE_STAGING_FAILED"


class ActivationFailed(UpdateError):
    """切 current 指针失败。会尽力切回原版本。"""

    code = "UPDATE_ACTIVATION_FAILED"


class HealthCheckFailed(UpdateError):
    """新版在健康检查预算内没通过。触发自动回滚。"""

    code = "UPDATE_HEALTH_FAILED"


class RollbackFailed(UpdateError):
    """回滚本身失败——最坏情况，必须让用户知道并保留现场。"""

    code = "UPDATE_ROLLBACK_FAILED"


class NoMatchingAsset(UpdateError):
    """当前平台 / 架构 / 安装形态在清单里没有对应资产。

    ``slug`` 是需求里点名的字面量 ``no-matching-asset``，message 也以它开头，
    这样日志、UI 文案、CI 断言都能按同一个词匹配。**绝不回落到别的资产**——
    「随便下一个」是自动更新里最坏的一种「成功」。
    """

    code = "UPDATE_NO_MATCHING_ASSET"
    slug = "no-matching-asset"
    silent = False

    def __init__(self, message: str = "", *, detail: dict | None = None) -> None:
        text = message or f"{self.slug}：没有匹配当前平台与安装形态的资产"
        # 统一前缀：调用方写不写 slug 都能被 grep 到。
        if not text.startswith(self.slug):
            text = f"{self.slug}：{text}"
        super().__init__(text, detail=detail)


class AmbiguousAsset(UpdateError):
    """同一目标下出现多个可用资产。宁可不更新，也不猜哪个才是给本机准备的。"""

    code = "UPDATE_ASSET_AMBIGUOUS"


class ManualUpdateRequired(UpdateError):
    """该形态不支持就地自更新（Linux deb/tar.gz）。

    不是故障：deb 归包管理器，tar.gz 由用户自己换目录。更新器能做的只有
    「告诉你有新版、这是正确的那一个下载链接」。
    """

    code = "UPDATE_MANUAL_REQUIRED"

    def __init__(self, message: str = "", *, download_url: str = "", detail: dict | None = None) -> None:
        super().__init__(message, detail=detail)
        self.download_url = download_url
