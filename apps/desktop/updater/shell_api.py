"""shell_api.py —— 把更新器接进桌面壳的 HTTP 动作。

与 ``aidn/server.py`` 的 ``dispatch_post`` 同一契约：返回 ``(status, body)``。
壳侧只需要在路由表里加几行（见本模块末尾的接入说明），其余逻辑都在这里，
这样「更新」这个功能不会把壳的 server 撑大。

关闭状态（``AUTO_UPDATE_ENABLED=0``）下三个动作都只回 ``{"enabled": false}``，
不发请求、不建目录、不碰网络——ADR-0011 §7 要求 UI 干脆不显示入口。
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from . import constants, store
from .engine import RuntimeHooks, Updater
from .errors import FeatureDisabled, UpdateError

log = logging.getLogger("aidn.updater.shell_api")

#: 单例与钩子。壳在启动时用 :func:`configure` 注入，避免这里反向依赖 app.py。
_updater: Updater | None = None
_hooks_provider = None
_lock = threading.Lock()


def configure(
    *,
    root: Path | None = None,
    hooks_provider=None,
    transport=None,
    enabled: bool | None = None,
    current_version: str = "",
) -> Updater:
    """由壳在启动时调用一次。重复调用会替换实例（测试用）。"""
    global _updater, _hooks_provider
    with _lock:
        _hooks_provider = hooks_provider
        _updater = Updater(
            root,
            transport=transport,
            enabled=enabled,
            current_version=current_version,
        )
        return _updater


def updater() -> Updater:
    global _updater
    with _lock:
        if _updater is None:
            _updater = Updater(store.default_install_root())
        return _updater


def hooks() -> RuntimeHooks:
    if _hooks_provider is None:
        return RuntimeHooks()
    try:
        return _hooks_provider()
    except Exception:  # noqa: BLE001 - 钩子坏了不该让更新入口消失
        log.exception("获取运行时钩子失败，按「无人值守」处理")
        return RuntimeHooks()


def state_block() -> dict:
    return updater().state()


def handle_check(payload: dict | None = None) -> tuple[int, dict]:
    engine = updater()
    if not engine.enabled:
        return (200, {"ok": True, "update": {"enabled": False, "state": "disabled"}})
    force = bool((payload or {}).get("force"))
    status = engine.check(force=force)
    return (200, {"ok": True, "update": status.to_dict()})


def handle_install(payload: dict | None = None) -> tuple[int, dict]:
    """下载并安装。失败按分类返回：静默类 200（UI 只更新一行状态），其余 4xx/5xx。"""
    engine = updater()
    if not engine.enabled:
        return (200, {"ok": True, "update": {"enabled": False, "state": "disabled"}})

    check = engine.check(force=False)
    if not check.update_available:
        return (200, {"ok": True, "update": check.to_dict()})
    if check.state == "no_asset":
        # 有新版、但没有给这台机器准备的文件：这不是「成功」，必须明确拒绝。
        return (
            409,
            {
                "ok": False,
                "error": {
                    "code": check.error_code,
                    "message": check.last_error or "no-matching-asset",
                    "silent": False,
                },
                "update": check.to_dict(),
            },
        )

    try:
        status = engine.install(hooks=hooks())
    except FeatureDisabled as error:
        return (200, {"ok": True, "update": {"enabled": False, **error.to_dict()}})
    except UpdateError as error:
        # 静默失败不给错误码：UI 显示一行「本次更新未完成」即可，不弹窗。
        if error.silent:
            return (200, {"ok": False, "update": {**engine.state(), **error.to_dict()}})
        return (409, {"ok": False, "error": error.to_dict(), "update": engine.state()})
    except Exception as error:  # noqa: BLE001
        log.exception("安装更新失败")
        return (500, {"ok": False, "error": {"code": "UPDATE_FAILED", "message": str(error)}})
    return (200, {"ok": True, "update": status.to_dict()})


def handle_confirm(payload: dict | None = None) -> tuple[int, dict]:
    """新版启动自检通过后由壳调用：写健康标记、清 pending、清理旧版本。"""
    version = str((payload or {}).get("version") or "")
    ok = updater().confirm(version)
    return (200 if ok else 409, {"ok": ok, "version": version or store.active_version(store.default_install_root())})


#: 壳侧接入（三行，写在 ``aidn/server.py`` 的 ``dispatch_post`` 路由表里）::
#:
#:     "/shell/api/update/check":   lambda: updater_api.handle_check(payload),
#:     "/shell/api/update/install": lambda: updater_api.handle_install(payload),
#:     "/shell/api/update/confirm": lambda: updater_api.handle_confirm(payload),
#:
#: 状态块写进 ``ShellController.state()``::
#:
#:     "update": updater_api.state_block(),
#:
#: 启动时注入钩子（main.py，daemon 起来之后）::
#:
#:     updater_api.configure(
#:         current_version=SHELL_VERSION,
#:         hooks_provider=lambda: RuntimeHooks(
#:             stop_runtime=controller.supervisor.stop,
#:             start_runtime=lambda directory: launch(directory),
#:         ),
#:     )
