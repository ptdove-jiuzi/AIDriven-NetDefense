"""health.py —— 新版「活着」的判定，以及健康标记的读写。

判定口径刻意简单可验证：新版启动自检通过后，在自己的版本目录里写一个
``.healthy`` 文件（内容为时间戳）。更新器在 30 秒预算内等这个文件：

* 出现 → 这次更新成功，清 ``pending.json``，清理旧版本；
* 超时或启动流程报错 → 回滚到旧版本，清 ``pending.json``，把原因写进状态。

为什么不用「进程还活着」当判据：新版可能在启动 2 秒后崩在 daemon 拉起上，
进程活着但功能全废。标记文件由启动流程在**所有自检通过之后**才写，语义明确。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Protocol

from . import constants

#: 探针签名：返回 ``(是否健康, 原因)``。原因只在失败时有意义。
HealthProbe = Callable[[], tuple[bool, str]]


class SupportsProbe(Protocol):
    def __call__(self) -> tuple[bool, str]:
        ...


def marker_path(version_dir: Path) -> Path:
    return Path(version_dir) / constants.HEALTH_MARKER


def write_marker(version_dir: Path, *, note: str = "") -> Path:
    """由新版启动流程调用：所有自检通过后写标记。"""
    target = marker_path(version_dir)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())
        target.write_text(f"{stamp}\n{note}\n", encoding="utf-8")
    except OSError:
        # 写不出来不该让程序起不来：更新器会把「没有标记」当成失败并回滚，
        # 而这一次启动本身仍然可用。
        pass
    return target


def clear_marker(version_dir: Path) -> None:
    try:
        marker_path(version_dir).unlink(missing_ok=True)
    except OSError:
        pass


def marker_probe(version_dir: Path) -> HealthProbe:
    """默认探针：看标记文件在不在。"""

    def probe() -> tuple[bool, str]:
        if marker_path(version_dir).is_file():
            return True, ""
        return False, "新版未在预算内写下健康标记"

    return probe


def await_health(
    probe: HealthProbe,
    *,
    timeout: float = constants.HEALTH_TIMEOUT_S,
    poll: float = constants.HEALTH_POLL_S,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[bool, str]:
    """轮询探针直到通过或超时。返回 ``(是否健康, 原因)``，不抛异常。

    断言用得到的一个细节：``timeout <= 0`` 时只探一次，绝不进入「永远等一下」。
    """
    started = clock()
    last_reason = ""
    while True:
        try:
            ok, reason = probe()
        except Exception as error:  # noqa: BLE001 - 探针本身崩了也算不健康
            ok, reason = False, f"健康检查异常：{error}"
        if ok:
            return True, ""
        last_reason = reason or "健康检查未通过"
        if clock() - started >= max(0.0, timeout):
            return False, last_reason
        sleep(min(poll, max(0.0, timeout)))
