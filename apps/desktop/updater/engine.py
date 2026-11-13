"""engine.py —— 更新器主流程：检查 → 下载 → 校验 → 解压 → 切换 → 健康检查 → 回滚。

节奏（ADR-0011 §2/§4）：

1. **检查**：24 小时窗口 + ETag。窗口内不发网络请求；过了窗口带 ``if-none-match``，
   304 就复用缓存的清单。断网与限流**静默**，只在状态里留一行原因。
2. **下载**：落到 ``updates\\<name>``，流式算，超上限中止并删半包。
3. **校验**：size 先于 sha256；不符就删包并抛 ``AssetRejected``。
4. **解压**：只解到 ``versions\\<new>``，当前版本不动；有半点可疑就整包拒绝。
5. **切换**：写 ``pending.json``（记录 from/to/激活时刻）→ 改 ``activeVersion``。
6. **健康检查**：30 秒预算内等新版的健康标记；等不到就切回旧版并清 ``pending.json``。

失败分三类，见 ``errors.py``：静默（断网/限流）、明确拒绝（哈希/来源）、自动回滚
（健康检查）。三类都不会连弹多个窗口——调用方拿到的永远是一个终态。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import assets, constants, health, manifest, net, store, verify
from .errors import (
    ActivationFailed,
    AssetRejected,
    HealthCheckFailed,
    ManifestInvalid,
    ManifestUntrusted,
    ManualUpdateRequired,
    NetworkUnavailable,
    NoMatchingAsset,
    RateLimited,
    RollbackFailed,
    StagingFailed,
    UpdateError,
)

log = logging.getLogger("aidn.updater.engine")

#: 限流后最早多久再试（秒）。没给 ``retry-after`` 时的兜底。
RATE_LIMIT_BACKOFF_S = 900.0


@dataclass
class UpdateStatus:
    """一次操作之后的状态快照。UI 只认这个结构。"""

    state: str = "idle"
    enabled: bool = True
    current_version: str = ""
    latest_version: str = ""
    notes: str = ""
    min_version: str = ""
    update_available: bool = False
    forced: bool = False
    checked_at: float | None = None
    last_error: str | None = None
    error_code: str | None = None
    silent: bool = False
    from_cache: bool = False
    asset: dict | None = None
    staged_version: str = ""
    restart_required: bool = False
    pending: dict | None = None
    rollback: dict | None = None
    channel: str = ""
    #: 更新方式：self-update（便携 zip 就地更新）/ installer（交 Setup.exe）/ manual（只给链接）。
    action: str = ""
    #: 选中的资产能不能落地（Linux 只有链接，也算能落地，但 action=manual）。
    installable: bool = False
    #: 手动更新的下载链接（Linux deb/tar.gz），或发布页兜底。
    download_url: str = ""
    #: installer 形态下载完成后的 Setup.exe 绝对路径。
    installer: str = ""
    #: 本机的选择输入（平台/架构/形态），写进状态便于用户排错。
    target: dict | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "enabled": self.enabled,
            "current": self.current_version,
            "latest": self.latest_version,
            "notes": self.notes,
            "min_version": self.min_version,
            "update_available": self.update_available,
            "forced": self.forced,
            "checked_at": _iso(self.checked_at),
            "last_error": self.last_error,
            "error_code": self.error_code,
            "silent": self.silent,
            "from_cache": self.from_cache,
            "asset": self.asset,
            "staged_version": self.staged_version,
            "restart_required": self.restart_required,
            "pending": self.pending,
            "rollback": self.rollback,
            "channel": self.channel,
            "action": self.action,
            "installable": self.installable,
            "download_url": self.download_url,
            "installer": self.installer,
            "target": self.target,
        }


@dataclass
class RuntimeHooks:
    """切换版本时必须由外壳提供的三个动作。

    更新器不自己杀进程、不自己起进程：那属于桌面壳的进程模型。这里只声明契约，
    没提供就等于「没人守着」——``apply`` 会在切完指针后直接把控制权交回去。
    """

    stop_runtime: Callable[[], None] | None = None
    start_runtime: Callable[[Path], None] | None = None
    probe: health.HealthProbe | None = None


class Updater:
    """一个安装根的更新器。所有状态都落在磁盘上，进程重启后仍能续上。"""

    def __init__(
        self,
        root: Path | None = None,
        *,
        transport: net.Transport | None = None,
        clock: Callable[[], float] = time.time,
        enabled: bool | None = None,
        current_version: str = "",
        health_timeout: float = constants.HEALTH_TIMEOUT_S,
        sleep: Callable[[float], None] = time.sleep,
        platform: str | None = None,
        arch: str | None = None,
        install_kind: str | None = None,
    ) -> None:
        self.root = Path(root or store.default_install_root())
        self.transport = transport or net.UrllibTransport()
        self._clock = clock
        self._enabled = constants.auto_update_enabled() if enabled is None else bool(enabled)
        self._current_override = current_version
        self.health_timeout = float(health_timeout)
        self._sleep = sleep
        # 平台/架构/形态默认取进程事实与 install.json；测试用参数注入，生产不传。
        self._platform = platform
        self._arch = arch
        self._install_kind = install_kind
        self._release: manifest.Release | None = None
        self._status = UpdateStatus(enabled=self._enabled)
        self._status.channel = store.channel(self.root)

    # ------------------------------------------------------- 本机选择输入

    @property
    def platform(self) -> str:
        return self._platform or assets.current_platform()

    @property
    def arch(self) -> str:
        """当前进程位数对应的架构。32 位判定只用 ``struct.calcsize('P')``。"""
        return self._arch or assets.process_arch()

    @property
    def install_kind(self) -> str:
        if self._install_kind:
            return self._install_kind
        return assets.install_kind(self.root, self.platform)

    def target(self) -> assets.Target:
        return assets.Target(platform=self.platform, arch=self.arch, kind=self.install_kind)

    @property
    def action(self) -> str:
        return assets.delivery(self.platform, self.install_kind)

    # ------------------------------------------------------------------ 只读

    @property
    def enabled(self) -> bool:
        return self._enabled

    def current_version(self) -> str:
        return store.active_version(self.root) or self._current_override

    def state(self) -> dict:
        """给 ``/shell/api/state`` 用的块。关闭时只回 ``enabled: false``。"""
        if not self._enabled:
            return {"enabled": False, "state": "disabled"}
        block = self._status.to_dict()
        block["enabled"] = True
        block["current"] = self.current_version()
        block["channel"] = store.channel(self.root)
        block["release_url"] = constants.RELEASE_PAGE_URL
        pending = store.read_pending(self.root)
        block["pending"] = pending.to_dict() if pending else None
        return block

    # ------------------------------------------------------------------ 检查

    def check(self, *, force: bool = False) -> UpdateStatus:
        """检查更新。永不抛异常：失败体现在返回值的 ``state``/``error_code`` 上。"""
        if not self._enabled:
            self._status = UpdateStatus(state="disabled", enabled=False)
            return self._status

        now = self._clock()
        cache = self._read_cache()
        current = self.current_version()

        blocked_until = float(cache.get("blocked_until") or 0.0)
        if not force and now < blocked_until:
            return self._rate_limited(now, blocked_until)

        if not force and cache and now - float(cache.get("checked_at") or 0) < constants.CHECK_INTERVAL_S:
            # 24 小时窗口内：不发请求，直接用上次结果。
            return self._status_from_cache(cache, current, now, from_cache=True)

        headers = {"accept": "application/vnd.github+json"}
        etag = str(cache.get("etag") or "")
        if etag:
            headers["if-none-match"] = etag

        try:
            response = self.transport.get(constants.LATEST_MANIFEST_URL, headers=headers)
        except RateLimited as error:
            return self._rate_limited(now, now + (error.retry_after_s or RATE_LIMIT_BACKOFF_S), error)
        except (NetworkUnavailable, ManifestUntrusted) as error:
            return self._fail(error, now, cache)
        except UpdateError as error:
            return self._fail(error, now, cache)
        except Exception as error:  # noqa: BLE001 - 检查失败绝不能拖垮启动
            return self._fail(NetworkUnavailable(f"检查更新失败：{error}"), now, cache)

        if response.status == 304 and cache.get("manifest"):
            cache["checked_at"] = now
            self._write_cache(cache)
            return self._status_from_cache(cache, current, now, from_cache=True)

        if response.status == 404:
            # 还没有任何 Release：不是错误，是「还没发布」。
            cache.update({"checked_at": now, "manifest": None, "etag": ""})
            self._write_cache(cache)
            self._status = UpdateStatus(
                state="no_release",
                enabled=True,
                current_version=current,
                checked_at=now,
                last_error="尚未发布任何版本",
                error_code="UPDATE_NO_RELEASE",
                silent=True,
            )
            return self._status

        if not response.ok:
            return self._fail(
                ManifestInvalid(f"检查更新返回 HTTP {response.status}"), now, cache
            )

        try:
            release = manifest.parse(response.body)
        except (ManifestInvalid, ManifestUntrusted) as error:
            # 清单不可信 = 必须让用户知道，不能静默。
            return self._fail(error, now, cache, persist=False)

        self._release = release
        cache = {
            "etag": response.header("etag", etag),
            "checked_at": now,
            "manifest": release.raw,
            "blocked_until": 0.0,
        }
        self._write_cache(cache)
        return self._status_from_release(release, current, now, from_cache=False)

    # ------------------------------------------------------------------ 下载

    def download(self, *, force: bool = False) -> Path:
        """按选择矩阵下载**本机该用的那一个**资产并校验。返回可用路径；失败抛异常。"""
        release = self._ensure_release()
        asset = self._select_asset(release)
        # 下载前先确认 size/sha256 来自同一条目（防「名字取 A、哈希取 B」）。
        assets.check_entry(release, asset)

        if self.action == assets.ACTION_MANUAL:
            # Linux：deb 归包管理器，tar.gz 由用户自己换目录。这里**一个字节都不下**。
            raise ManualUpdateRequired(
                f"当前形态（{self.platform}/{self.install_kind}）不支持就地自更新，"
                "请按提示用包管理器或手动替换",
                download_url=asset.url,
                detail={"target": self.target().to_dict(), "asset": asset.name},
            )

        destination = store.updates_dir(self.root) / asset.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and not force:
            try:
                verify.verify_asset(destination, asset)
                log.info("已存在校验通过的更新包，复用：%s", destination)
                self._status.state = "downloaded"
                return destination
            except AssetRejected:
                verify.discard(destination)

        self._status.state = "downloading"
        log.info("开始下载 %s（%d 字节）", asset.name, asset.size)
        try:
            response = self.transport.download(asset.url, destination)
        except BaseException:
            # 传输层自己会删半包；这里再兜一次，任何实现都不许留下残骸。
            verify.discard(destination)
            self._status.state = "failed"
            raise
        if response.status and not (200 <= response.status < 300):
            verify.discard(destination)
            raise AssetRejected(f"下载失败：HTTP {response.status}")

        verify.verify_asset(destination, asset)
        self._status.state = "downloaded"
        self._status.asset = asset.to_dict()
        log.info("更新包校验通过：%s", destination)
        return destination

    # ------------------------------------------------------------------ 解压

    def stage(self, archive: Path | None = None) -> Path:
        """解压到独立版本目录。当前版本完全不受影响。

        只接受**便携 zip**：installer 是 Setup.exe（由安装器接管目录），deb/tar.gz
        不是 zip。把它们塞进 ``zipfile`` 只会得到一句难懂的 BadZipFile。
        """
        release = self._ensure_release()
        self._require_zip_payload("解压")
        bundle = archive or self.download()
        store.ensure_layout(self.root)
        destination = store.version_dir(self.root, release.version)

        from .archive import discard_dir, extract_zip, find_desktop_exe

        if destination.exists():
            # 上次失败留下的空壳没有意义；有内容的目录绝不覆盖。
            if any(destination.iterdir()):
                raise StagingFailed(f"版本目录已有内容，拒绝覆盖：{destination}")
            discard_dir(destination)

        extract_zip(bundle, destination)
        relative, _ = find_desktop_exe(destination)
        if not relative:
            discard_dir(destination)
            raise StagingFailed("更新包里没有桌面入口（AIDrivenNetDefense.exe），已拒绝")

        self._status.state = "staged"
        self._status.staged_version = release.version
        log.info("已解压到 %s（入口 %s）", destination, relative)
        return destination

    # ------------------------------------------------------------------ 切换

    def apply(
        self,
        *,
        hooks: RuntimeHooks | None = None,
        version: str = "",
        timeout: float | None = None,
    ) -> UpdateStatus:
        """切换指针 → 健康检查 → 失败回滚。返回终态。"""
        release = self._ensure_release()
        self._require_zip_payload("切换")
        target_version = version or release.version
        target_dir = store.version_dir(self.root, target_version)
        if not target_dir.is_dir():
            raise StagingFailed(f"版本目录不存在，无法切换：{target_dir}")

        from .archive import find_desktop_exe

        relative, _ = find_desktop_exe(target_dir)
        if not relative:
            raise StagingFailed("版本目录里没有桌面入口")

        hooks = hooks or RuntimeHooks()
        previous = store.active_version(self.root) or self.current_version()
        activated_at = self._clock()
        self._status.state = "applying"

        if hooks.stop_runtime is not None:
            try:
                hooks.stop_runtime()
            except Exception as error:  # noqa: BLE001
                self._status.state = "failed"
                self._status.last_error = f"无法停止正在运行的实例：{error}"
                self._status.error_code = "UPDATE_RUNTIME_BUSY"
                return self._status

        try:
            store.activate(self.root, target_version, desktop_exe=relative)
        except Exception as error:  # noqa: BLE001
            self._restore_pointer(previous)
            raise ActivationFailed(f"切换 current 指针失败：{error}") from error

        store.write_pending(
            self.root,
            store.Pending(from_version=previous, to_version=target_version, activated_at=activated_at),
        )

        if hooks.start_runtime is not None:
            try:
                hooks.start_runtime(target_dir)
            except Exception as error:  # noqa: BLE001
                log.exception("启动新版本失败")
                return self.rollback(f"新版本启动失败：{error}")

        probe = hooks.probe or health.marker_probe(target_dir)
        budget = self.health_timeout if timeout is None else float(timeout)
        ok, reason = health.await_health(probe, timeout=budget, sleep=self._sleep)
        if not ok:
            return self.rollback(f"健康检查未通过：{reason}")

        store.clear_pending(self.root)
        store.prune(self.root, active=target_version)
        self._status = UpdateStatus(
            state="healthy",
            enabled=True,
            current_version=target_version,
            latest_version=release.version,
            notes=release.notes,
            update_available=False,
            checked_at=self._status.checked_at,
            staged_version="",
            channel=store.channel(self.root),
        )
        log.info("更新成功：%s → %s", previous, target_version)
        return self._status

    def install(self, *, hooks: RuntimeHooks | None = None) -> UpdateStatus:
        """一步到位：检查 → 下载 → 校验 → （按形态）解压/交安装器/只给链接。

        分支由 ``assets.delivery`` 决定，不在内部再猜一次形态：

        * ``self-update``（win + 便携）：下载 → 解压 → 切换 → 健康检查 → 回滚；
        * ``installer``（win + 安装版）：下载并校验 Setup.exe，交给安装器执行，
          不再就地覆盖版本目录——安装器自己负责写 ``install.json`` 与快捷方式；
        * ``manual``（linux）：只回到检查结果，带 ``download_url``，**不下载**。
        """
        status = self.check(force=True)
        if not status.update_available:
            return status
        if status.asset is None:
            # no_asset：清单里没有本机可用的资产，原因已在 status 里。
            return status
        if self.action == assets.ACTION_MANUAL:
            # check() 已把 action/download_url 填好；这里只保证不下任何字节。
            return status

        archive = self.download()
        if self.action == assets.ACTION_INSTALLER:
            # 安装包不归更新器解压：交给 Setup.exe，避免两套安装逻辑打架
            # （DIST-DECISION §2.2「不新增第四套逻辑」）。
            status.state = "ready_to_install"
            status.installer = str(archive)
            status.restart_required = True
            log.info("安装包已就绪，等待安装器执行：%s", archive)
            return status

        self.stage(archive)
        return self.apply(hooks=hooks)

    # ------------------------------------------------------------------ 回滚

    def rollback(self, reason: str) -> UpdateStatus:
        """切回 ``pending.from``。清 ``pending.json``，把原因留成记录。"""
        pending = store.read_pending(self.root)
        target = pending.from_version if pending else ""
        activated = store.active_version(self.root)
        if not target or not store.version_dir(self.root, target).is_dir():
            # 没有可回的目标：保持现状，但必须明确报错，不能假装成功。
            store.clear_pending(self.root)
            record = {
                "at": self._clock(),
                "reason": reason,
                "from": activated,
                "to": "",
                "ok": False,
            }
            self._write_rollback(record)
            self._status.state = "failed"
            self._status.last_error = f"{reason}（且找不到可回滚的旧版本）"
            self._status.error_code = RollbackFailed.code
            self._status.rollback = record
            log.error("回滚失败：%s", self._status.last_error)
            return self._status

        try:
            store.activate(self.root, target)
        except Exception as error:  # noqa: BLE001
            self._status.state = "failed"
            self._status.last_error = f"{reason}；回滚也失败：{error}"
            self._status.error_code = RollbackFailed.code
            raise RollbackFailed(self._status.last_error) from error

        store.clear_pending(self.root)
        record = {
            "at": self._clock(),
            "reason": reason,
            "from": activated,
            "to": target,
            "ok": True,
        }
        self._write_rollback(record)
        self._status = UpdateStatus(
            state="rolled_back",
            enabled=True,
            current_version=target,
            latest_version=(self._release.version if self._release else ""),
            last_error=reason,
            error_code=HealthCheckFailed.code,
            silent=False,
            rollback=record,
            channel=store.channel(self.root),
        )
        log.warning("已回滚到 %s：%s", target, reason)
        return self._status

    # ------------------------------------------------------- 启动时的对账

    def startup_reconcile(self) -> tuple[str, dict]:
        """启动时调用：把上次没走完的更新收尾。

        返回 ``(动作, 记录)``，动作是 ``healthy`` / ``rolled_back`` / ``pending`` /
        ``cleared`` / ``none``。
        """
        pending = store.read_pending(self.root)
        if pending is None:
            return "none", {}
        active = store.active_version(self.root)
        if active != pending.to_version:
            # 指针已经不在待确认的版本上：这条 pending 是残留，清掉即可。
            store.clear_pending(self.root)
            return "cleared", pending.to_dict()

        target_dir = store.version_dir(self.root, pending.to_version)
        if health.marker_path(target_dir).is_file():
            store.clear_pending(self.root)
            store.prune(self.root, active=pending.to_version)
            return "healthy", pending.to_dict()

        now = self._clock()
        if pending.expired(now):
            status = self.rollback(f"新版本在 {int(constants.HEALTH_TIMEOUT_S)} 秒内未完成健康检查")
            return "rolled_back", (status.rollback or pending.to_dict())
        return "pending", pending.to_dict()

    def confirm(self, version: str = "") -> bool:
        """新版启动流程在自检通过后调用：写健康标记并收尾。"""
        target = version or store.active_version(self.root)
        if not target:
            return False
        directory = store.version_dir(self.root, target)
        if not directory.is_dir():
            return False
        health.write_marker(directory, note="startup self-check passed")
        store.clear_pending(self.root)
        store.prune(self.root, active=target)
        return True

    # ------------------------------------------------------------------ 内部

    def _select_asset(self, release: manifest.Release):
        """按本机的（平台, 架构, 形态）选资产。选不到就抛 ``NoMatchingAsset``。"""
        target = self.target()
        return assets.select(
            release,
            platform=target.platform,
            arch=target.arch,
            kind=target.kind,
        )

    def _require_zip_payload(self, what: str) -> None:
        """``stage``/``apply`` 只对便携 zip 成立；其它形态明确拒绝而不是解压失败。"""
        if self.install_kind == assets.KIND_PORTABLE:
            return
        raise ManualUpdateRequired(
            f"{what}只适用于便携 zip 载荷；当前形态是 {self.install_kind}，"
            "安装版请交给 Setup.exe，Linux 请用包管理器或手动替换",
            download_url=constants.RELEASE_PAGE_URL,
            detail={"target": self.target().to_dict()},
        )

    def _restore_pointer(self, previous: str) -> None:
        if previous and store.version_dir(self.root, previous).is_dir():
            try:
                store.activate(self.root, previous)
            except Exception:  # noqa: BLE001
                log.exception("切回 %s 失败", previous)

    def _ensure_release(self) -> manifest.Release:
        if self._release is not None:
            return self._release
        # 缓存里可能已经有一份有效清单（24 小时窗口内重启进程）。
        cache = self._read_cache()
        raw = cache.get("manifest")
        if isinstance(raw, dict):
            try:
                self._release = manifest.parse(raw)
                return self._release
            except (ManifestInvalid, ManifestUntrusted):
                pass
        raise ManifestInvalid("还没有拿到有效的版本清单，请先检查更新")

    def _status_from_release(
        self, release: manifest.Release, current: str, now: float, *, from_cache: bool
    ) -> UpdateStatus:
        available = manifest.is_newer(release.version, current) if current else True
        if not available and current and release.version == current:
            # 0.0.x 允许同版本覆盖安装（热修）；更高版本只升不降。
            available = manifest.allows_reinstall(current)
        forced = bool(release.min_version) and bool(current) and manifest.is_newer(release.min_version, current)

        target = None
        action = ""
        asset_block = None
        selected = None
        failure = None
        try:
            target = self.target()
            selected = self._select_asset(release)
            action = assets.delivery(self.platform, self.install_kind)
            asset_block = assets.describe(selected)
        except NoMatchingAsset as error:
            # 有新版、但**没有给本机准备的文件**：必须明说，绝不换成别的包。
            failure = error
        except Exception as error:  # noqa: BLE001 - 选择失败不能拖垮检查
            failure = NoMatchingAsset(str(error))

        state = "update_available" if available else "up_to_date"
        if available and failure is not None:
            state = "no_asset"

        self._status = UpdateStatus(
            state=state,
            enabled=True,
            current_version=current,
            latest_version=release.version,
            notes=release.notes,
            min_version=release.min_version,
            update_available=available,
            forced=forced,
            checked_at=now,
            from_cache=from_cache,
            last_error=failure.message if failure else None,
            error_code=failure.code if failure else None,
            asset=asset_block,
            installable=selected is not None,
            action=action,
            download_url=(selected.url if selected else constants.RELEASE_PAGE_URL),
            target=target.to_dict() if target else None,
            channel=store.channel(self.root),
        )
        return self._status

    def _status_from_cache(self, cache: dict, current: str, now: float, *, from_cache: bool) -> UpdateStatus:
        raw = cache.get("manifest")
        if not isinstance(raw, dict):
            # 缓存里只有上次失败的原因（没有有效清单）：把原因带出来，
            # 设置页就能显示「上次检查：离线」，而不是一片空白。
            last = cache.get("last_error") or {}
            self._status = UpdateStatus(
                state="idle",
                enabled=True,
                current_version=current,
                checked_at=now,
                from_cache=from_cache,
                last_error=last.get("message"),
                error_code=last.get("code"),
                silent=True,
                channel=store.channel(self.root),
            )
            return self._status
        try:
            release = manifest.parse(raw)
        except (ManifestInvalid, ManifestUntrusted) as error:
            return self._fail(error, now, cache, persist=False)
        checked = float(cache.get("checked_at") or now)
        return self._status_from_release(release, current, checked, from_cache=from_cache)

    def _rate_limited(self, now: float, until: float, error: Exception | None = None) -> UpdateStatus:
        cache = self._read_cache()
        cache["blocked_until"] = max(float(cache.get("blocked_until") or 0.0), until)
        self._write_cache(cache)
        self._status.state = "rate_limited"
        self._status.enabled = True
        self._status.current_version = self.current_version()
        self._status.checked_at = now
        self._status.last_error = str(getattr(error, "message", "") or "更新检查被限流，稍后再试")
        self._status.error_code = RateLimited.code
        self._status.silent = True
        log.info("检查更新被限流，%0.0f 秒后再试", max(0.0, until - now))
        return self._status

    def _fail(
        self, error: Exception, now: float, cache: dict, *, persist: bool = True
    ) -> UpdateStatus:
        code = getattr(error, "code", "UPDATE_FAILED")
        silent = bool(getattr(error, "silent", False))
        message = str(getattr(error, "message", "") or error)
        if persist:
            # 刻意**不动** checked_at：失败不该把 24 小时窗口「用掉」。
            # 断网恢复、限流解除后，下一次启动要能立刻重试（ADR-0011 §2）。
            cache["last_error"] = {"code": code, "message": message, "at": now}
            self._write_cache(cache)
        self._status = UpdateStatus(
            state="offline" if code == NetworkUnavailable.code else ("rate_limited" if code == RateLimited.code else "failed"),
            enabled=True,
            current_version=self.current_version(),
            checked_at=now,
            last_error=message,
            error_code=code,
            silent=silent,
            channel=store.channel(self.root),
        )
        if silent:
            log.info("检查更新失败（静默）：%s", message)
        else:
            log.warning("检查更新失败：%s（%s）", message, code)
        return self._status

    def _read_cache(self) -> dict:
        try:
            raw = json.loads(store.cache_path(self.root).read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _write_cache(self, payload: dict) -> None:
        target = store.cache_path(self.root)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            handle, temp_name = tempfile.mkstemp(prefix=".check-", suffix=".tmp", dir=str(target.parent))
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, target)
        except OSError:
            log.warning("更新检查缓存写入失败（不影响本次检查结果）")

    def _write_rollback(self, record: dict) -> None:
        path = store.updates_dir(self.root) / "last-rollback.json"
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass


def _iso(stamp: float | None) -> str | None:
    if not stamp:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(stamp))
