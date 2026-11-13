"""切换、健康检查与回滚：新版起不来时，30 秒内必须回到旧版。"""

from __future__ import annotations

import json
import time
import unittest
import zipfile

import _support as S

from updater import constants, health, store  # noqa: E402
from updater.engine import RuntimeHooks, Updater  # noqa: E402
from updater.errors import ArchiveUnsafe  # noqa: E402


class InstallTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()
        S.make_install_root(self.root, version="0.0.1")
        self.zip = S.build_payload_zip(self.root / "fixture" / S.ASSET_NAME)
        self.asset_bytes = self.zip.read_bytes()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def make_updater(self, *, asset: bytes | None = None, health_timeout: float = 0.3) -> Updater:
        source = self.zip
        if asset is not None:
            # 清单必须描述实际要下载的那份字节，否则先死在 size 校验上，测不到解压安全。
            source = self.root / "fixture" / "asset-under-test.zip"
            source.write_bytes(asset)
        manifest = S.make_manifest(source)
        transport = S.FakeTransport(manifest=manifest, asset=asset if asset is not None else self.asset_bytes)
        return Updater(
            self.root,
            transport=transport,
            clock=lambda: 1_800_000_000.0,
            enabled=True,
            current_version="0.0.1",
            health_timeout=health_timeout,
            # 本组用例测的是「便携 zip 就地更新」这条链路，显式钉住形态。
            install_kind="portable",
        )

    def old_exe(self):
        return store.version_dir(self.root, "0.0.1") / "AIDrivenNetDefense.exe"


class HappyPathTest(InstallTestBase):
    def test_download_verify_extract_switch_and_confirm(self) -> None:
        updater = self.make_updater()
        started: list[str] = []

        def start_runtime(directory):
            started.append(str(directory))
            health.write_marker(directory, note="fake boot ok")

        status = updater.install(hooks=RuntimeHooks(start_runtime=start_runtime))

        self.assertEqual(status.state, "healthy")
        self.assertEqual(store.active_version(self.root), "0.0.2")
        self.assertTrue((store.version_dir(self.root, "0.0.2") / "AIDrivenNetDefense.exe").is_file())
        self.assertIsNone(store.read_pending(self.root), "成功后必须清掉 pending.json")
        self.assertEqual(started, [str(store.version_dir(self.root, "0.0.2"))])
        # 旧版本保留一份，回滚才有路可走。
        self.assertTrue(self.old_exe().is_file())
        self.assertEqual(store.installed_versions(self.root), ["0.0.1", "0.0.2"])

    def test_prune_keeps_at_most_two_versions(self) -> None:
        for version in ("0.0.3", "0.0.4"):
            directory = store.version_dir(self.root, version)
            directory.mkdir(parents=True)
            (directory / "AIDrivenNetDefense.exe").write_bytes(b"MZ")
        # 把指针放到最新版，再收一次
        store.activate(self.root, "0.0.4")
        removed = store.prune(self.root, active="0.0.4")
        # 保留「当前 + 最近的一个」；被删的是最旧的 0.0.1，而不是回滚目标 0.0.3。
        self.assertEqual(removed, ["0.0.1"])
        self.assertEqual(store.installed_versions(self.root), ["0.0.3", "0.0.4"])


class RollbackTest(InstallTestBase):
    def test_health_failure_rolls_back_within_budget(self) -> None:
        """验收 2：健康检查失败 → 预算内回滚，当前版本回到旧版。"""
        self.assertEqual(constants.HEALTH_TIMEOUT_S, 30.0, "默认预算是 30 秒")

        updater = self.make_updater(health_timeout=0.3)
        hooks = RuntimeHooks(
            start_runtime=lambda directory: None,
            probe=lambda: (False, "模拟：新版启动后自检未通过"),
        )

        started = time.monotonic()
        status = updater.install(hooks=hooks)
        elapsed = time.monotonic() - started

        self.assertEqual(status.state, "rolled_back")
        self.assertLess(elapsed, 30.0, "回滚必须落在 30 秒预算内")
        self.assertLess(elapsed, 5.0, "测试预算 0.3 秒，不该拖到秒级")
        self.assertEqual(store.active_version(self.root), "0.0.1")
        self.assertIsNone(store.read_pending(self.root), "回滚后必须清掉 pending.json")
        self.assertIn("健康检查", status.last_error or "")
        self.assertTrue(status.rollback and status.rollback["ok"])

        record = json.loads((self.root / "updates" / "last-rollback.json").read_text(encoding="utf-8"))
        self.assertEqual(record["to"], "0.0.1")
        self.assertTrue(record["ok"])

    def test_start_failure_rolls_back_immediately(self) -> None:
        updater = self.make_updater()

        def boom(_directory):
            raise OSError("模拟：新版本无法启动")

        status = updater.install(hooks=RuntimeHooks(start_runtime=boom))
        self.assertEqual(status.state, "rolled_back")
        self.assertEqual(store.active_version(self.root), "0.0.1")

    def test_startup_reconcile_rolls_back_expired_pending(self) -> None:
        # 模拟「切完指针就断电」：pending 存在、版本没写健康标记、时间已过期。
        store.activate(self.root, "0.0.2")
        store.version_dir(self.root, "0.0.2").mkdir(parents=True, exist_ok=True)
        store.write_pending(
            self.root,
            store.Pending(from_version="0.0.1", to_version="0.0.2", activated_at=1_800_000_000.0 - 120),
        )
        updater = self.make_updater()
        action, record = updater.startup_reconcile()

        self.assertEqual(action, "rolled_back")
        self.assertEqual(store.active_version(self.root), "0.0.1")
        self.assertIsNone(store.read_pending(self.root))
        self.assertEqual(record["to"], "0.0.1")

    def test_startup_reconcile_accepts_healthy_pending(self) -> None:
        store.activate(self.root, "0.0.2")
        target = store.version_dir(self.root, "0.0.2")
        target.mkdir(parents=True, exist_ok=True)
        health.write_marker(target, note="boot ok")
        store.write_pending(
            self.root,
            store.Pending(from_version="0.0.1", to_version="0.0.2", activated_at=1_800_000_000.0 - 5),
        )
        updater = self.make_updater()

        action, _record = updater.startup_reconcile()
        self.assertEqual(action, "healthy")
        self.assertEqual(store.active_version(self.root), "0.0.2")
        self.assertIsNone(store.read_pending(self.root))

    def test_confirm_writes_marker_and_clears_pending(self) -> None:
        store.activate(self.root, "0.0.2")
        expected = store.version_dir(self.root, "0.0.2")
        expected.mkdir(parents=True, exist_ok=True)
        store.write_pending(self.root, store.Pending("0.0.1", "0.0.2", 1_800_000_000.0))

        updater = self.make_updater()
        self.assertTrue(updater.confirm())
        self.assertTrue(health.marker_path(expected).is_file())
        self.assertIsNone(store.read_pending(self.root))


class ArchiveSafetyTest(InstallTestBase):
    def test_zip_slip_is_refused(self) -> None:
        evil = S.build_zip_with_entry(self.root / "fixture" / "evil.zip", "../escaped.txt")
        updater = self.make_updater(asset=evil.read_bytes())
        with self.assertRaises(ArchiveUnsafe):
            updater.install()
        self.assertFalse(store.version_dir(self.root, "0.0.2").exists(), "被拒的包不该留下版本目录")
        self.assertEqual(store.active_version(self.root), "0.0.1")

    def test_symlink_entry_is_refused(self) -> None:
        payload = self.root / "fixture" / "link.zip"
        with zipfile.ZipFile(payload, "w") as bundle:
            bundle.writestr("AIDrivenNetDefense.exe", b"MZ")
            info = zipfile.ZipInfo("link.txt")
            info.external_attr = (0o120777 << 16)
            bundle.writestr(info, "/etc/passwd")
        updater = self.make_updater(asset=payload.read_bytes())
        with self.assertRaises(ArchiveUnsafe):
            updater.install()

    def test_absolute_entry_is_refused(self) -> None:
        evil = S.build_zip_with_entry(self.root / "fixture" / "abs.zip", "C:/Windows/evil.dll")
        updater = self.make_updater(asset=evil.read_bytes())
        with self.assertRaises(ArchiveUnsafe):
            updater.install()


if __name__ == "__main__":
    unittest.main()
