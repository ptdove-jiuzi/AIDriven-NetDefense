"""常量注入：owner/repo 写死在代码里，配置与环境变量都改不动它。"""

from __future__ import annotations

import importlib
import os
import unittest

import _support as S  # noqa: F401 - 负责把 apps/desktop 放进 sys.path

from updater import constants, net  # noqa: E402


class ConstantInjectionTest(unittest.TestCase):
    def test_repo_identity_is_the_authorized_pair(self) -> None:
        self.assertEqual(constants.UPDATE_REPO_OWNER, "ptdove-jiuzi")
        self.assertEqual(constants.UPDATE_REPO_NAME, "AIDriven-NetDefense")

    def test_auto_update_is_off_until_first_release(self) -> None:
        # 首个 Release 之前必须是 0：UI 不显示入口，更新器不发请求。
        self.assertEqual(constants.AUTO_UPDATE_ENABLED, 0)
        self.assertFalse(constants.auto_update_enabled())

    def test_manifest_url_points_at_the_fixed_repo(self) -> None:
        self.assertEqual(
            constants.LATEST_MANIFEST_URL,
            "https://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/latest/download/latest.json",
        )
        self.assertTrue(net.is_allowed_url(constants.LATEST_MANIFEST_URL))

    def test_environment_variables_cannot_redirect_the_update_source(self) -> None:
        """ADR-0011 §2 的核心断言：改环境变量不会把更新指向别处。"""
        poisoned = {
            "AIDN_UPDATE_REPO_OWNER": "attacker",
            "AIDN_UPDATE_REPO_NAME": "evil-repo",
            "AIDRIVEN_UPDATE_BASE": "https://evil.example.com/releases",
            "UPDATE_REPO_OWNER": "attacker",
            "UPDATE_REPO_NAME": "evil-repo",
        }
        before = (constants.UPDATE_REPO_OWNER, constants.UPDATE_REPO_NAME, constants.LATEST_MANIFEST_URL)
        try:
            os.environ.update(poisoned)
            reloaded = importlib.reload(constants)
            after = (reloaded.UPDATE_REPO_OWNER, reloaded.UPDATE_REPO_NAME, reloaded.LATEST_MANIFEST_URL)
        finally:
            for key in poisoned:
                os.environ.pop(key, None)
            importlib.reload(constants)
        self.assertEqual(before, after)
        self.assertIn("ptdove-jiuzi", after[2])
        self.assertNotIn("evil", after[2])

    def test_module_reads_no_environment_at_import(self) -> None:
        source = (S.REPO_ROOT / "apps" / "desktop" / "updater" / "constants.py").read_text(encoding="utf-8")
        self.assertNotIn("os.environ", source)
        self.assertNotIn("getenv", source)


class UrlAllowlistTest(unittest.TestCase):
    def test_rejects_http(self) -> None:
        self.assertFalse(net.is_allowed_url("http://github.com/ptdove-jiuzi/AIDriven-NetDefense/x.zip"))

    def test_rejects_other_host(self) -> None:
        self.assertFalse(net.is_allowed_url("https://evil.example.com/ptdove-jiuzi/AIDriven-NetDefense/x.zip"))

    def test_rejects_other_repo_on_same_host(self) -> None:
        # 同一个域名下的别的仓库，仍然不是「我们的」更新源。
        self.assertFalse(net.is_allowed_url("https://github.com/attacker/AIDriven-NetDefense/x.zip"))
        self.assertFalse(net.is_allowed_url("https://github.com/ptdove-jiuzi/other-repo/x.zip"))

    def test_accepts_repo_asset_and_release_cdn(self) -> None:
        self.assertTrue(net.is_allowed_url(S.ASSET_URL))
        self.assertTrue(net.is_allowed_url("https://objects.githubusercontent.com/github-production-release-asset/x"))

    def test_require_allowed_url_raises_with_code(self) -> None:
        from updater.errors import ManifestUntrusted

        with self.assertRaises(ManifestUntrusted) as caught:
            net.require_allowed_url("https://evil.example.com/x.zip")
        self.assertEqual(caught.exception.code, "UPDATE_SOURCE_REJECTED")


if __name__ == "__main__":
    unittest.main()
