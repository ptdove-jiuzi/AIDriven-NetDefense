"""多平台资产选择：选错文件比不更新更糟，所以每条拒绝路径都要有断言。

覆盖（对应需求 1–4）：

* 架构不匹配（x86 包 vs 64 位进程、无架构声明的 Setup.exe）；
* kind 不匹配（安装版只给便携包、便携版只给安装包）；
* 资产缺失（清单里没有本平台的任何文件）→ ``no-matching-asset``；
* 哈希 / 大小不符 → 删临时文件；
* 四资产同时存在时各形态各取所需；
* Linux 分支：只提示 + 正确链接，零下载；
* 32 位判定来自 ``struct.calcsize('P')``，不来自目录名。
"""

from __future__ import annotations

import unittest
from pathlib import Path

import _support as S

from updater import assets, constants, manifest, store  # noqa: E402
from updater.engine import Updater  # noqa: E402
from updater.errors import (  # noqa: E402
    AmbiguousAsset,
    AssetRejected,
    ManualUpdateRequired,
    NoMatchingAsset,
)


def parse(bundle: dict[str, bytes], **kwargs) -> manifest.Release:
    return manifest.parse(S.make_multi_manifest(bundle, **kwargs))


class SelectionMatrixTest(unittest.TestCase):
    """四种资产同时存在时，每种「平台 + 形态」必须拿到自己的那一个。"""

    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()
        self.bundle = S.build_release_bundle(self.root)
        self.release = parse(self.bundle)

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def pick(self, platform: str, arch: str, kind: str):
        return assets.select(self.release, platform=platform, arch=arch, kind=kind)

    def test_windows_installed_gets_the_installer(self) -> None:
        chosen = self.pick("win32", "x64", assets.KIND_INSTALLER)
        self.assertEqual(chosen.name, S.INSTALLER_NAME)
        self.assertTrue(chosen.name.endswith(".exe"))

    def test_windows_portable_gets_the_portable_zip(self) -> None:
        chosen = self.pick("win32", "x64", assets.KIND_PORTABLE)
        self.assertEqual(chosen.name, S.ASSET_NAME)
        self.assertTrue(chosen.name.endswith("-portable.zip"))

    def test_linux_deb_install_gets_the_deb(self) -> None:
        chosen = self.pick("linux", "x64", assets.KIND_DEB)
        self.assertEqual(chosen.name, S.DEB_NAME)

    def test_linux_tar_gz_gets_the_tarball(self) -> None:
        chosen = self.pick("linux", "x64", assets.KIND_PORTABLE)
        self.assertEqual(chosen.name, S.LINUX_TAR_NAME)

    def test_selected_entry_is_the_whole_entry_from_the_manifest(self) -> None:
        """size/sha256/url 必须与同名条目逐字段一致（防名字取 A、哈希取 B）。"""
        chosen = self.pick("win32", "x64", assets.KIND_INSTALLER)
        entry = self.release.asset(chosen.name)
        self.assertIsNotNone(entry)
        self.assertEqual(assets.fingerprint(entry), assets.fingerprint(chosen))
        assets.check_entry(self.release, chosen)  # 不抛即通过

    def test_check_entry_rejects_a_mixed_entry(self) -> None:
        chosen = self.pick("win32", "x64", assets.KIND_INSTALLER)
        forged = manifest.Asset(
            name=chosen.name,
            size=chosen.size + 1,
            sha256="b" * 64,
            url=chosen.url,
        )
        with self.assertRaises(AssetRejected) as caught:
            assets.check_entry(self.release, forged)
        self.assertEqual(caught.exception.code, "UPDATE_ASSET_REJECTED")


class NoMatchTest(unittest.TestCase):
    """找不到就是找不到：不回落到「随便下一个」。"""

    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def test_arch_mismatch_is_refused(self) -> None:
        bundle = {"AIDrivenNetDefense-Setup-0.0.2-win-x86.exe": b"MZ setup-x86"}
        release = parse(bundle)
        with self.assertRaises(NoMatchingAsset) as caught:
            assets.select(release, platform="win32", arch="x64", kind=assets.KIND_INSTALLER)
        self.assertEqual(caught.exception.code, "UPDATE_NO_MATCHING_ASSET")
        self.assertTrue(caught.exception.message.startswith("no-matching-asset"))

    def test_kind_mismatch_is_refused_without_fallback(self) -> None:
        # 安装版机器上只有便携包：不能「差不多就用 zip」。
        bundle = {S.ASSET_NAME: b"PK fake portable"}
        release = parse(bundle)
        with self.assertRaises(NoMatchingAsset):
            assets.select(release, platform="win32", arch="x64", kind=assets.KIND_INSTALLER)

    def test_missing_platform_asset_is_refused(self) -> None:
        bundle = {S.INSTALLER_NAME: b"MZ setup", S.ASSET_NAME: b"PK portable"}
        release = parse(bundle)
        with self.assertRaises(NoMatchingAsset) as caught:
            assets.select(release, platform="linux", arch="x64", kind=assets.KIND_DEB)
        self.assertIn("matrix_row", caught.exception.detail)

    def test_installer_without_arch_is_refused(self) -> None:
        # 架构不明 = 无法证明能跑；不猜「大概是 x64」。
        bundle = {"AIDrivenNetDefense-Setup-0.0.2-win.exe": b"MZ setup-noarch"}
        release = parse(bundle)
        with self.assertRaises(NoMatchingAsset) as caught:
            assets.select(release, platform="win32", arch="x64", kind=assets.KIND_INSTALLER)
        reasons = [item["reason"] for item in caught.exception.detail["assets"]]
        self.assertTrue(any("架构" in reason for reason in reasons), reasons)

    def test_duplicate_candidates_are_refused_as_ambiguous(self) -> None:
        bundle = {
            "AIDrivenNetDefense-0.0.2-win-x64-portable.zip": b"one",
            "AIDrivenNetDefense-0.0.2-win-x64-extra-portable.zip": b"two",
        }
        release = parse(bundle)
        with self.assertRaises(AmbiguousAsset) as caught:
            assets.select(release, platform="win32", arch="x64", kind=assets.KIND_PORTABLE)
        self.assertEqual(caught.exception.code, "UPDATE_ASSET_AMBIGUOUS")

    def test_linux_portable_must_be_tarball(self) -> None:
        # 名字带 linux 的 zip 不算 linux 便携包：形态与文件类型必须一致。
        bundle = {"AIDrivenNetDefense-0.0.2-linux-x64-portable.zip": b"PK linux-but-zip"}
        release = parse(bundle)
        with self.assertRaises(NoMatchingAsset):
            assets.select(release, platform="linux", arch="x64", kind=assets.KIND_PORTABLE)

    def test_non_package_assets_are_ignored(self) -> None:
        # Release 里还有 SHA256SUMS.txt / latest.json，不能让它们干扰选择。
        bundle = {S.INSTALLER_NAME: b"MZ setup"}
        payload = S.make_multi_manifest(bundle)
        for extra in ("SHA256SUMS.txt", "latest.json"):
            payload["assets"].append(
                {"name": extra, "size": 1, "sha256": "a" * 64, "url": S.asset_url(extra)}
            )
        release = manifest.parse(payload)
        chosen = assets.select(release, platform="win32", arch="x64", kind=assets.KIND_INSTALLER)
        self.assertEqual(chosen.name, S.INSTALLER_NAME)


class BitnessTest(unittest.TestCase):
    """32 位判定只看进程本身。"""

    def test_process_bits_comes_from_pointer_size(self) -> None:
        self.assertEqual(assets.process_bits(), __import__("struct").calcsize("P") * 8)
        self.assertEqual(assets.process_arch(64), "x64")
        self.assertEqual(assets.process_arch(32), "x86")
        with self.assertRaises(NoMatchingAsset):
            assets.process_arch(16)

    def test_source_never_guesses_arch_from_directory_names(self) -> None:
        source = (S.REPO_ROOT / "apps" / "desktop" / "updater" / "assets.py").read_text(encoding="utf-8")
        self.assertIn('struct.calcsize("P")', source)
        for forbidden in ("Program Files", "platform.machine", "PROCESSOR_ARCHITECTURE", "sys.maxsize"):
            self.assertNotIn(forbidden, source, f"不得用 {forbidden} 猜位数")

    def test_32bit_process_does_not_get_64bit_installer(self) -> None:
        bundle = {
            "AIDrivenNetDefense-Setup-0.0.2-win-x64.exe": b"MZ x64",
            "AIDrivenNetDefense-Setup-0.0.2-win-x86.exe": b"MZ x86",
        }
        release = parse(bundle)
        self.assertEqual(
            assets.select(release, platform="win32", arch="x86", kind=assets.KIND_INSTALLER).name,
            "AIDrivenNetDefense-Setup-0.0.2-win-x86.exe",
        )
        self.assertEqual(
            assets.select(release, platform="win32", arch="x64", kind=assets.KIND_INSTALLER).name,
            "AIDrivenNetDefense-Setup-0.0.2-win-x64.exe",
        )


class InstallKindTest(unittest.TestCase):
    """``install.json`` 的 channel 决定形态；缺记录时按平台给保守默认。"""

    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def test_channel_drives_kind(self) -> None:
        S.make_install_root(self.root, channel="installed")
        self.assertEqual(assets.install_kind(self.root, "win32"), assets.KIND_INSTALLER)
        S.make_portable_root(self.root)
        self.assertEqual(assets.install_kind(self.root, "win32"), assets.KIND_PORTABLE)
        record = store.read_record(self.root)
        record["channel"] = "deb"
        store.write_record(self.root, record)
        self.assertEqual(assets.install_kind(self.root, "linux"), assets.KIND_DEB)

    def test_linux_without_record_is_tarball_not_deb(self) -> None:
        self.assertEqual(assets.install_kind(self.root, "linux"), assets.KIND_PORTABLE)

    def test_delivery_matrix(self) -> None:
        self.assertEqual(assets.delivery("win32", "portable"), assets.ACTION_SELF_UPDATE)
        self.assertEqual(assets.delivery("win32", "installer"), assets.ACTION_INSTALLER)
        self.assertEqual(assets.delivery("linux", "deb"), assets.ACTION_MANUAL)
        self.assertEqual(assets.delivery("linux", "portable"), assets.ACTION_MANUAL)


class EngineWiringTest(unittest.TestCase):
    """选择器接进引擎后的三种落法：no_asset / ready_to_install / manual。"""

    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()
        S.make_install_root(self.root, version="0.0.1")
        self.bundle = S.build_release_bundle(self.root)
        self.manifest = S.make_multi_manifest(self.bundle)
        self.now = 1_800_000_000.0

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def updater(self, **kwargs) -> Updater:
        transport = S.FakeTransport(manifest=self.manifest, assets=self.bundle)
        return Updater(
            self.root,
            transport=transport,
            clock=lambda: self.now,
            enabled=True,
            current_version="0.0.1",
            **kwargs,
        )

    def test_installed_windows_reports_installer_action(self) -> None:
        status = self.updater(platform="win32", arch="x64").check()
        self.assertEqual(status.state, "update_available")
        self.assertEqual(status.action, assets.ACTION_INSTALLER)
        self.assertEqual(status.asset["name"], S.INSTALLER_NAME)
        self.assertEqual(status.download_url, S.asset_url(S.INSTALLER_NAME))

    def test_installed_windows_downloads_setup_exe_and_stops(self) -> None:
        updater = self.updater(platform="win32", arch="x64")
        status = updater.install()
        self.assertEqual(status.state, "ready_to_install")
        self.assertTrue(status.restart_required)
        self.assertTrue(Path(status.installer).is_file())
        self.assertTrue(Path(status.installer).name.endswith(".exe"))
        self.assertFalse(
            store.version_dir(self.root, "0.0.2").exists(),
            "安装版不就地解压，版本目录不该被创建",
        )

    def test_linux_check_gives_link_without_downloading(self) -> None:
        updater = self.updater(platform="linux", arch="x64", install_kind="deb")
        status = updater.check()
        self.assertEqual(status.action, assets.ACTION_MANUAL)
        self.assertEqual(status.asset["name"], S.DEB_NAME)
        self.assertEqual(status.download_url, S.asset_url(S.DEB_NAME))

        before = len(updater.transport.calls)
        again = updater.install()
        self.assertEqual(again.state, "update_available")
        downloads = [call for call in updater.transport.calls[before:] if call["method"] == "download"]
        self.assertEqual(downloads, [], "Linux 分支一个字节都不该下")

    def test_linux_download_is_refused_by_type(self) -> None:
        updater = self.updater(platform="linux", arch="x64", install_kind="deb")
        updater.check()
        with self.assertRaises(ManualUpdateRequired) as caught:
            updater.download()
        self.assertEqual(caught.exception.code, "UPDATE_MANUAL_REQUIRED")
        self.assertEqual(caught.exception.download_url, S.asset_url(S.DEB_NAME))

    def test_no_matching_asset_surfaces_as_no_asset_state(self) -> None:
        # 只有 Linux 资产的 Release 出现在 Windows 安装版机器上。
        bundle = {S.DEB_NAME: b"!<arch>\n", S.LINUX_TAR_NAME: b"\x1f\x8b"}
        self.manifest = S.make_multi_manifest(bundle)
        updater = self.updater(platform="win32", arch="x64")
        status = updater.check()
        self.assertEqual(status.state, "no_asset")
        self.assertEqual(status.error_code, "UPDATE_NO_MATCHING_ASSET")
        self.assertIn("no-matching-asset", status.last_error or "")
        self.assertIsNone(status.asset)
        self.assertFalse(status.installable)
        self.assertFalse(status.silent, "平台没有可用包必须让人看见")

    def test_wrong_platform_bytes_are_rejected_and_temp_file_removed(self) -> None:
        # 清单声称是 installer，但实际下到的字节哈希不符 → 删包、不进入安装。
        self.manifest = S.make_multi_manifest(
            self.bundle,
            overrides={S.INSTALLER_NAME: {"sha256": "c" * 64}},
        )
        updater = self.updater(platform="win32", arch="x64")
        with self.assertRaises(AssetRejected):
            updater.install()
        leftovers = list((self.root / "updates").glob("*.exe"))
        self.assertEqual(leftovers, [], "哈希不符的临时文件必须删除")
        self.assertEqual(store.active_version(self.root), "0.0.1")

    def test_status_reports_target_for_diagnostics(self) -> None:
        status = self.updater(platform="win32", arch="x86").check()
        self.assertEqual(status.target, {"platform": "win32", "arch": "x86", "kind": "installer"})
        # 只有 x64 安装包时，32 位进程必须拿不到东西。
        self.assertEqual(status.state, "no_asset")


if __name__ == "__main__":
    unittest.main()
