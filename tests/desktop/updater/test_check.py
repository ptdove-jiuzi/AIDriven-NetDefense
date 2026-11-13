"""检查更新：24 小时窗口 + ETag；断网/限流静默；清单不可信必须明确失败。"""

from __future__ import annotations

import json
import unittest

import _support as S

from updater import constants, store  # noqa: E402
from updater.engine import Updater  # noqa: E402


class CheckTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()
        S.make_install_root(self.root, version="0.0.1")
        self.now = 1_800_000_000.0
        # 真实 Release 有四种资产；宿主机是安装版 → 应选中 Setup.exe。
        self.bundle = S.build_release_bundle(self.root)
        self.manifest = S.make_multi_manifest(self.bundle)

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def make_updater(self, transport=None, *, enabled: bool = True) -> Updater:
        transport = transport or S.FakeTransport(manifest=self.manifest)
        return Updater(
            self.root,
            transport=transport,
            clock=lambda: self.now,
            enabled=enabled,
            current_version="0.0.1",
        )


class DisabledTest(CheckTestBase):
    def test_disabled_sends_nothing(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        updater = self.make_updater(transport, enabled=False)
        status = updater.check()
        self.assertEqual(status.state, "disabled")
        self.assertFalse(status.enabled)
        self.assertEqual(transport.calls, [])
        self.assertEqual(updater.state(), {"enabled": False, "state": "disabled"})
        # 关闭时连 updates\ 都不该建出来。
        self.assertFalse((self.root / "updates").exists())


class CheckWindowTest(CheckTestBase):
    def test_first_check_then_cached_within_24h(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        updater = self.make_updater(transport)

        first = updater.check()
        self.assertEqual(first.state, "update_available")
        self.assertTrue(first.update_available)
        self.assertEqual(first.latest_version, "0.0.2")
        self.assertEqual(first.current_version, "0.0.1")
        self.assertFalse(first.from_cache)
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual(transport.calls[0]["url"], constants.LATEST_MANIFEST_URL)

        self.now += 3600
        second = updater.check()
        self.assertTrue(second.from_cache)
        self.assertEqual(len(transport.calls), 1, "24 小时窗口内不该再发请求")
        self.assertTrue(second.update_available)

    def test_after_window_uses_etag_and_handles_304(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        updater = self.make_updater(transport)
        updater.check()

        self.now += constants.CHECK_INTERVAL_S + 60
        third = updater.check()
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(transport.calls[1]["headers"].get("if-none-match"), transport.etag)
        self.assertTrue(third.from_cache)
        self.assertEqual(third.state, "update_available")
        self.assertIsNone(third.last_error)

    def test_force_bypasses_window(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        updater = self.make_updater(transport)
        updater.check()
        updater.check(force=True)
        self.assertEqual(len(transport.calls), 2)


class CheckFailureTest(CheckTestBase):
    def test_offline_is_silent_and_retries_next_time(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        transport.mode = "offline"
        updater = self.make_updater(transport)

        status = updater.check()
        self.assertEqual(status.state, "offline")
        self.assertEqual(status.error_code, "UPDATE_OFFLINE")
        self.assertTrue(status.silent, "断网不该弹错误")

        # 失败不占用 24 小时窗口：下一次启动能立刻重试。
        updater.check()
        self.assertEqual(len(transport.calls), 2)

    def test_rate_limit_backs_off_without_hammering(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        transport.mode = "rate"
        updater = self.make_updater(transport)

        status = updater.check()
        self.assertEqual(status.state, "rate_limited")
        self.assertTrue(status.silent)
        cache = json.loads(store.cache_path(self.root).read_text(encoding="utf-8"))
        self.assertGreater(cache["blocked_until"], self.now)

        # 退避期内再检查：不发请求，也不报错。
        calls_before = len(transport.calls)
        self.now += 10
        again = updater.check()
        self.assertEqual(again.state, "rate_limited")
        self.assertEqual(len(transport.calls), calls_before)

        # 退避结束：恢复检查。
        self.now += 200
        transport.mode = "ok"
        recovered = updater.check()
        self.assertEqual(recovered.state, "update_available")

    def test_no_release_is_not_an_error(self) -> None:
        transport = S.FakeTransport(manifest=self.manifest)
        transport.manifest_status = 404
        updater = self.make_updater(transport)
        status = updater.check()
        self.assertEqual(status.state, "no_release")
        self.assertTrue(status.silent)
        self.assertEqual(status.error_code, "UPDATE_NO_RELEASE")

    def test_untrusted_manifest_fails_loudly(self) -> None:
        bad = S.make_manifest(
            self.root / "fixture" / S.ASSET_NAME,
            url="https://evil.example.com/ptdove-jiuzi/AIDriven-NetDefense/x.zip",
        )
        updater = self.make_updater(S.FakeTransport(manifest=bad))
        status = updater.check()
        self.assertEqual(status.state, "failed")
        self.assertEqual(status.error_code, "UPDATE_SOURCE_REJECTED")
        self.assertFalse(status.silent, "来源不对必须让人看见")
        self.assertFalse(status.update_available)

    def test_forced_update_only_when_min_version_is_newer(self) -> None:
        zip_path = self.root / "fixture" / S.ASSET_NAME
        updater = self.make_updater(S.FakeTransport(manifest=S.make_manifest(zip_path, min_version="0.0.2")))
        self.assertTrue(updater.check().forced)

        other = S.TempRoot()
        with other as root:
            S.make_install_root(root, version="0.0.1")
            zip2 = S.build_payload_zip(root / "fixture" / S.ASSET_NAME)
            fresh = Updater(
                root,
                transport=S.FakeTransport(manifest=S.make_manifest(zip2, min_version="0.0.1")),
                clock=lambda: self.now,
                enabled=True,
                current_version="0.0.1",
            )
            self.assertFalse(fresh.check().forced)


class UpToDateTest(CheckTestBase):
    def test_same_version_in_0_0_x_allows_hotfix_reinstall(self) -> None:
        zip_path = self.root / "fixture" / S.ASSET_NAME
        updater = self.make_updater(S.FakeTransport(manifest=S.make_manifest(zip_path, version="0.0.1")))
        status = updater.check()
        self.assertTrue(status.update_available, "0.0.x 允许同级覆盖安装（热修）")


if __name__ == "__main__":
    unittest.main()
