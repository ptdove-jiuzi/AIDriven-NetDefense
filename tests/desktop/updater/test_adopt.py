"""adopt：便携版就地转安装版 —— data 逐文件哈希不变，且不留第二份载荷。

测试全程在临时目录里跑，注册表用 ``file`` 后端导出「将要写入的值」，
不碰本机真实的卸载键，也不建真实快捷方式。
"""

from __future__ import annotations

import contextlib
import io
import json
import unittest
from pathlib import Path

import _support as S

import adopt  # noqa: E402


def files_under(root: Path, *, payload_only: bool = False) -> dict[str, bytes]:
    """列目录下所有文件（跳过 current 联接，避免同一份文件被数两遍）。"""
    found: dict[str, bytes] = {}
    for item in sorted(root.rglob("*")):
        relative = item.relative_to(root)
        if "current" in relative.parts:
            continue
        parts = str(relative).replace("\\", "/")
        if payload_only and (parts.startswith("data/") or parts.startswith("install/")):
            continue
        if item.is_file():
            found[parts] = item.read_bytes()
    return found


class AdoptBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = S.TempRoot("aidn-adopt-")
        self.root = self._tmp.__enter__() / "AIDriven NetDefense"
        self.root.mkdir(parents=True, exist_ok=True)
        S.make_portable_root(self.root, version="0.0.1")
        self.registry_store = self._tmp.__enter__() / "registry.json"

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def run_adopt(self, **kwargs) -> adopt.AdoptResult:
        options = adopt.AdoptOptions(
            root=self.root,
            registry="file",
            registry_store=self.registry_store,
            shortcuts=False,
            **kwargs,
        )
        return adopt.adopt(options)


class PortableToInstalledTest(AdoptBase):
    def test_adopt_builds_versions_layout(self) -> None:
        result = self.run_adopt()
        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.code, 0)

        version_dir = self.root / "versions" / "0.0.1"
        self.assertTrue((version_dir / "AIDrivenNetDefense.exe").is_file())
        self.assertTrue((version_dir / "console" / "index.html").is_file())
        self.assertFalse((self.root / "AIDrivenNetDefense.exe").exists(), "载荷必须移走，不能在根上留一份")

        record = json.loads((self.root / "install" / "install.json").read_text(encoding="utf-8"))
        self.assertEqual(record["channel"], "installed")
        self.assertEqual(record["activeVersion"], "0.0.1")
        self.assertEqual(record["previousChannel"], "portable")
        self.assertEqual(record["schema"], 2)
        self.assertEqual(record["installPath"], str(self.root.resolve()))

    def test_data_directory_is_byte_identical(self) -> None:
        """验收 3：adopt 后 data 逐文件哈希不变。"""
        before = adopt.hash_tree(self.root / "data")
        self.assertEqual(len(before), 2)
        result = self.run_adopt()
        after = adopt.hash_tree(self.root / "data")

        self.assertTrue(result.ok)
        self.assertTrue(result.data_unchanged)
        self.assertEqual(before, after)
        self.assertEqual(result.data_files, 2)

    def test_no_second_copy_of_payload(self) -> None:
        before = files_under(self.root, payload_only=True)
        result = self.run_adopt()
        after = files_under(self.root, payload_only=True)

        self.assertTrue(result.ok)
        # 载荷文件数量不变 = 只是搬位置，没有复制；字节总量也必须一致。
        self.assertEqual(len(after), len(before))
        self.assertEqual(sum(len(v) for v in after.values()), sum(len(v) for v in before.values()))
        exe_count = sum(1 for path in after if path.endswith("AIDrivenNetDefense.exe"))
        self.assertEqual(exe_count, 1, "载荷只能存在一份")

    def test_reserved_directories_stay_at_root(self) -> None:
        result = self.run_adopt()
        self.assertTrue(result.ok)
        for name in ("data", "install", "installer"):
            self.assertTrue((self.root / name).is_dir(), f"{name}\\ 必须留在原地")
        self.assertFalse((self.root / "versions" / "0.0.1" / "data").exists())

    def test_adopt_is_idempotent(self) -> None:
        first = self.run_adopt()
        self.assertTrue(first.ok)
        second = self.run_adopt()
        self.assertTrue(second.ok)
        self.assertIn("已经是安装版", second.message)
        self.assertEqual(second.code, 0)
        self.assertEqual(sorted(p.name for p in (self.root / "versions").iterdir()), ["0.0.1"])

    def test_uninstall_registry_record(self) -> None:
        result = self.run_adopt()
        self.assertTrue(result.ok)
        record = json.loads(self.registry_store.read_text(encoding="utf-8"))
        self.assertEqual(record["DisplayName"], "AIDriven NetDefense")
        self.assertEqual(record["DisplayVersion"], "0.0.1")
        self.assertEqual(record["Publisher"], "PT-dove")
        self.assertEqual(record["InstallLocation"], str(self.root.resolve()))
        self.assertIn("versions", record["DisplayIcon"])
        self.assertIn("/uninstall", record["UninstallString"])
        self.assertIn("/S /uninstall", record["QuietUninstallString"])


class AdoptRefusalTest(AdoptBase):
    def test_non_portable_channel_is_refused(self) -> None:
        record_path = self.root / "install" / "install.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["channel"] = "test"
        record_path.write_text(json.dumps(record), encoding="utf-8")

        result = self.run_adopt()
        self.assertFalse(result.ok)
        self.assertEqual(result.code, adopt.EXIT_NOT_PORTABLE)
        self.assertFalse((self.root / "versions").exists(), "被拒时不该建 versions\\")

    def test_missing_desktop_exe_is_refused(self) -> None:
        (self.root / "AIDrivenNetDefense.exe").unlink()
        result = self.run_adopt()
        self.assertFalse(result.ok)
        self.assertEqual(result.code, adopt.EXIT_PAYLOAD_MISSING)

    def test_existing_version_directory_is_not_overwritten(self) -> None:
        target = self.root / "versions" / "0.0.1"
        target.mkdir(parents=True)
        (target / "keep.txt").write_text("existing", encoding="utf-8")

        result = self.run_adopt()
        self.assertFalse(result.ok)
        self.assertEqual(result.code, adopt.EXIT_VERSION_EXISTS)
        self.assertTrue((self.root / "AIDrivenNetDefense.exe").is_file(), "拒绝时载荷必须原地不动")

    def test_dry_run_changes_nothing(self) -> None:
        record_before = (self.root / "install" / "install.json").read_text(encoding="utf-8")
        result = self.run_adopt(dry_run=True)
        self.assertTrue(result.ok)
        self.assertIn("演练", result.message)
        self.assertTrue((self.root / "AIDrivenNetDefense.exe").is_file())
        self.assertFalse((self.root / "versions").exists())
        self.assertEqual((self.root / "install" / "install.json").read_text(encoding="utf-8"), record_before)

    def test_missing_record_falls_back_to_bundle_json(self) -> None:
        (self.root / "install" / "install.json").unlink()
        (self.root / "bundle.json").write_text(json.dumps({"version": "0.0.1"}), encoding="utf-8")
        result = self.run_adopt()
        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.version, "0.0.1")


class ShortcutSpecTest(unittest.TestCase):
    def test_specs_point_into_versions(self) -> None:
        root = Path("C:/Program Files/AIDriven NetDefense")
        specs = adopt.shortcut_specs(
            root,
            "0.0.2",
            "AIDrivenNetDefense.exe",
            desktop_dir=Path("C:/Users/x/Desktop"),
            start_menu_dir=Path("C:/Users/x/AppData/Roaming/Microsoft/Windows/Start Menu/Programs"),
        )
        self.assertEqual(len(specs), 2)
        for link, target in specs:
            self.assertEqual(link.suffix, ".lnk")
            self.assertTrue(str(target).endswith("versions\\0.0.2\\AIDrivenNetDefense.exe")
                            or str(target).endswith("versions/0.0.2/AIDrivenNetDefense.exe"))
        self.assertEqual(specs[0][0].name, "AIDriven NetDefense.lnk")
        self.assertEqual(specs[1][0].parent.name, "AIDriven NetDefense")


class CliTest(AdoptBase):
    def test_main_returns_exit_code_and_json(self) -> None:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = adopt.main(["/adopt", str(self.root), "--registry-file", str(self.registry_store),
                               "--no-shortcuts", "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["channel_after"], "installed")
        self.assertEqual(json.loads((self.root / "install" / "install.json").read_text(encoding="utf-8"))["channel"],
                         "installed")

    def test_main_without_directory_returns_2(self) -> None:
        self.assertEqual(adopt.main([]), adopt.EXIT_NOT_PORTABLE)


if __name__ == "__main__":
    unittest.main()
