"""latest.json 的解析与严格校验：可疑就拒绝，不做「尽力而为」。"""

from __future__ import annotations

import json
import unittest

import _support as S

from updater import manifest  # noqa: E402
from updater.errors import ManifestInvalid, ManifestUntrusted  # noqa: E402


class ManifestParseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = S.TempRoot()
        self.root = self.tmp.__enter__()
        self.zip = S.build_payload_zip(self.root / S.ASSET_NAME)
        self.manifest = S.make_manifest(self.zip)

    def tearDown(self) -> None:
        self.tmp.__exit__(None, None, None)

    def test_valid_manifest_parses(self) -> None:
        release = manifest.parse(json.dumps(self.manifest).encode("utf-8"))
        self.assertEqual(release.version, "0.0.2")
        self.assertEqual(release.notes, "测试版本")
        payload = release.payload()
        self.assertIsNotNone(payload)
        self.assertEqual(payload.name, S.ASSET_NAME)
        self.assertEqual(payload.size, self.zip.stat().st_size)

    def test_version_must_be_semver(self) -> None:
        for bad in ("1.0", "v1.0.0", "latest", "1.0.0.0", ""):
            payload = dict(self.manifest, version=bad)
            with self.assertRaises(ManifestInvalid, msg=bad):
                manifest.parse(payload)

    def test_sha256_must_be_lowercase_64_hex(self) -> None:
        for bad in ("ABC", "A" * 64, "z" * 64, ""):
            payload = S.make_manifest(self.zip, sha256=bad)
            with self.assertRaises(ManifestInvalid, msg=bad):
                manifest.parse(payload)

    def test_size_must_be_positive_int(self) -> None:
        for bad in (0, -1, True, "1024", 1.5):
            payload = S.make_manifest(self.zip, size=bad)  # type: ignore[arg-type]
            with self.assertRaises(ManifestInvalid, msg=repr(bad)):
                manifest.parse(payload)

    def test_name_cannot_contain_path_separators(self) -> None:
        for bad in ("../evil.zip", "a/b.zip", "a\\b.zip"):
            payload = S.make_manifest(self.zip, asset_name=bad, url=S.ASSET_URL)
            with self.assertRaises((ManifestUntrusted, ManifestInvalid), msg=bad):
                manifest.parse(payload)

    def test_url_must_be_https_and_inside_repo(self) -> None:
        cases = [
            "http://github.com/ptdove-jiuzi/AIDriven-NetDefense/releases/download/v/1.zip",
            "https://evil.example.com/ptdove-jiuzi/AIDriven-NetDefense/1.zip",
            "https://github.com/attacker/AIDriven-NetDefense/1.zip",
        ]
        for url in cases:
            payload = S.make_manifest(self.zip, url=url)
            with self.assertRaises(ManifestUntrusted, msg=url) as caught:
                manifest.parse(payload)
            self.assertEqual(caught.exception.code, "UPDATE_SOURCE_REJECTED")

    def test_duplicate_asset_names_rejected(self) -> None:
        payload = S.make_manifest(self.zip)
        payload["assets"].append(dict(payload["assets"][0]))
        with self.assertRaises(ManifestInvalid):
            manifest.parse(payload)

    def test_installer_only_manifest_is_valid(self) -> None:
        """Linux-only / 安装版-only 的 Release 不再因为「没有 portable.zip」被整份判死。"""
        payload = S.make_manifest(self.zip, asset_name=S.INSTALLER_NAME, url=S.asset_url(S.INSTALLER_NAME))
        release = manifest.parse(payload)
        self.assertIsNone(release.payload(), "payload() 只是历史接口，不该假装有 zip")
        self.assertEqual(release.assets[0].name, S.INSTALLER_NAME)

    def test_declared_target_fields_are_carried_and_validated(self) -> None:
        good = S.make_manifest(self.zip)
        good["assets"][0].update({"platform": "win32", "arch": "x64", "kind": "portable"})
        asset = manifest.parse(good).assets[0]
        self.assertEqual((asset.platform, asset.arch, asset.kind), ("win32", "x64", "portable"))
        self.assertEqual(asset.to_dict()["kind"], "portable")

        for field, bad in (("platform", "macos"), ("arch", "riscv64"), ("kind", "appx"), ("kind", 7)):
            payload = S.make_manifest(self.zip)
            payload["assets"][0][field] = bad
            with self.assertRaises(ManifestInvalid, msg=f"{field}={bad!r}"):
                manifest.parse(payload)

    def test_unknown_channel_rejected(self) -> None:
        payload = dict(self.manifest, channel="beta")
        with self.assertRaises(ManifestInvalid):
            manifest.parse(payload)

    def test_broken_json_rejected(self) -> None:
        with self.assertRaises(ManifestInvalid):
            manifest.parse(b"{not json")


class VersionCompareTest(unittest.TestCase):
    def test_ordering(self) -> None:
        self.assertTrue(manifest.is_newer("0.0.2", "0.0.1"))
        self.assertFalse(manifest.is_newer("0.0.1", "0.0.1"))
        self.assertFalse(manifest.is_newer("0.0.1", "0.0.2"))
        self.assertTrue(manifest.is_newer("0.10.0", "0.9.9"))
        self.assertTrue(manifest.is_newer("1.0.0", "0.99.99"))

    def test_prerelease_sorts_below_release(self) -> None:
        self.assertLess(manifest.compare_versions("1.0.0-rc.1", "1.0.0"), 0)
        self.assertGreater(manifest.compare_versions("1.0.0", "1.0.0-rc.1"), 0)

    def test_same_version_reinstall_only_in_0_0_x(self) -> None:
        # ADR-0011 §2：0.0.x 允许同级覆盖安装（热修），更高版本只升不降。
        self.assertTrue(manifest.allows_reinstall("0.0.1"))
        self.assertFalse(manifest.allows_reinstall("0.1.0"))
        self.assertFalse(manifest.allows_reinstall("1.0.0"))

    def test_parse_version_rejects_junk(self) -> None:
        with self.assertRaises(ManifestInvalid):
            manifest.parse_version("nope")


if __name__ == "__main__":
    unittest.main()
