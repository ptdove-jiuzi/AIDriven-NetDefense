"""校验：sha256 被改过就拒绝安装，且当前版本一个字节都不动。"""

from __future__ import annotations

import unittest

import _support as S

from updater import store, verify  # noqa: E402
from updater.engine import Updater  # noqa: E402
from updater.errors import AssetRejected, NetworkUnavailable  # noqa: E402


class VerifyFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()
        self.file = self.root / "pkg.zip"
        self.file.write_bytes(b"payload-bytes")
        self.size = self.file.stat().st_size
        self.digest = S.sha256_of(self.file)

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def test_matching_file_passes(self) -> None:
        verify.verify_file(self.file, sha256=self.digest, size=self.size)
        self.assertTrue(self.file.is_file())

    def test_size_mismatch_deletes_the_file(self) -> None:
        with self.assertRaises(AssetRejected) as caught:
            verify.verify_file(self.file, sha256=self.digest, size=self.size + 1)
        self.assertEqual(caught.exception.code, "UPDATE_ASSET_REJECTED")
        self.assertFalse(self.file.exists())

    def test_hash_mismatch_deletes_the_file(self) -> None:
        with self.assertRaises(AssetRejected):
            verify.verify_file(self.file, sha256="0" * 64, size=self.size)
        self.assertFalse(self.file.exists())

    def test_missing_file_rejected(self) -> None:
        with self.assertRaises(AssetRejected):
            verify.verify_file(self.root / "nope.zip", sha256=self.digest, size=self.size)


class TamperedManifestTest(unittest.TestCase):
    """验收 1：把 latest.json 里的 sha256 改掉 → 下载后拒绝安装。"""

    def setUp(self) -> None:
        self._tmp = S.TempRoot()
        self.root = self._tmp.__enter__()
        S.make_install_root(self.root, version="0.0.1")
        self.zip = S.build_payload_zip(self.root / "fixture" / S.ASSET_NAME)
        self.asset_bytes = self.zip.read_bytes()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def _updater(self, manifest: dict, *, mode: str = "ok") -> Updater:
        transport = S.FakeTransport(manifest=manifest, asset=self.asset_bytes)
        transport.mode = mode
        return Updater(
            self.root,
            transport=transport,
            clock=lambda: 1_800_000_000.0,
            enabled=True,
            current_version="0.0.1",
            install_kind="portable",
        )

    def test_tampered_sha256_is_refused_and_nothing_changes(self) -> None:
        old_exe = store.version_dir(self.root, "0.0.1") / "AIDrivenNetDefense.exe"
        old_digest = S.sha256_of(old_exe)
        record_before = (self.root / "install" / "install.json").read_text(encoding="utf-8")

        tampered = S.make_manifest(self.zip, sha256="a" * 64)
        updater = self._updater(tampered)

        with self.assertRaises(AssetRejected) as caught:
            updater.install()
        self.assertEqual(caught.exception.code, "UPDATE_ASSET_REJECTED")
        self.assertFalse(caught.exception.silent, "哈希不符必须明确报错")

        # 半包被删掉
        leftovers = [p for p in (self.root / "updates").glob("*.zip")]
        self.assertEqual(leftovers, [], "被篡改的包不允许留在磁盘上")
        # 当前版本完全没动
        self.assertEqual(S.sha256_of(old_exe), old_digest)
        self.assertEqual((self.root / "install" / "install.json").read_text(encoding="utf-8"), record_before)
        self.assertEqual(store.active_version(self.root), "0.0.1")
        self.assertFalse(store.version_dir(self.root, "0.0.2").exists(), "校验失败不该解压出新版本目录")

    def test_tampered_size_is_refused(self) -> None:
        tampered = S.make_manifest(self.zip, size=self.zip.stat().st_size + 1024)
        with self.assertRaises(AssetRejected):
            self._updater(tampered).install()

    def test_interrupted_download_leaves_no_partial_file(self) -> None:
        updater = self._updater(S.make_manifest(self.zip), mode="truncate")
        with self.assertRaises(NetworkUnavailable):
            updater.install()
        leftovers = list((self.root / "updates").glob("*.zip"))
        self.assertEqual(leftovers, [], "断网必须清理临时文件，不留半包")
        self.assertEqual(store.active_version(self.root), "0.0.1")


if __name__ == "__main__":
    unittest.main()
