"""显示名：默认英文，可切中文，且只改「看到的字」。

验收 4：切换语言后重启仍然保持 —— 这里用**独立进程**读盘来证明，不靠同一进程的
内存状态。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

import _support as S

import settings  # noqa: E402  （apps/desktop/settings 包）
from settings import branding, display  # noqa: E402


class PackageWiringTest(unittest.TestCase):
    def test_settings_resolves_to_the_new_package(self) -> None:
        # apps/desktop 下同时存在 histórico 的 settings.py 与新的 settings\ 包，
        # 包优先；这里把这件事钉住，避免哪天被单文件悄悄顶掉。
        self.assertTrue(str(settings.__file__).replace("\\", "/").endswith("settings/__init__.py"))


class BrandingTest(unittest.TestCase):
    def test_default_is_english(self) -> None:
        self.assertEqual(branding.DEFAULT_LANGUAGE, "en")
        self.assertEqual(branding.display_name(), "AIDriven NetDefense")
        self.assertEqual(branding.display_name(None), "AIDriven NetDefense")

    def test_chinese_display_name(self) -> None:
        self.assertEqual(branding.display_name("zh"), "网域智防")
        self.assertEqual(branding.display_name("zh-CN"), "网域智防")
        self.assertEqual(branding.display_name("ZH_hans"), "网域智防")

    def test_unknown_language_falls_back_to_english(self) -> None:
        self.assertEqual(branding.normalize_language("fr"), "en")
        self.assertEqual(branding.normalize_language(""), "en")
        self.assertEqual(branding.normalize_language(None), "en")
        self.assertEqual(branding.normalize_language(42), "en")

    def test_window_title_follows_language_and_version(self) -> None:
        self.assertEqual(branding.window_title("en"), "AIDriven NetDefense")
        self.assertEqual(branding.window_title("zh"), "网域智防")
        self.assertEqual(branding.window_title("en", "0.0.1"), "AIDriven NetDefense · 0.0.1")
        self.assertEqual(branding.window_title("zh", "0.0.1"), "网域智防 · 0.0.1")

    def test_tray_labels(self) -> None:
        en = branding.tray_labels("en")
        zh = branding.tray_labels("zh")
        self.assertEqual(en["show"], "Open Window")
        self.assertEqual(zh["show"], "打开界面")
        self.assertNotIn("check_update", en)
        self.assertIn("check_update", branding.tray_labels("en", include_update=True))
        self.assertLessEqual(len(branding.tray_tooltip("zh", "0.0.1")), 127)

    def test_identity_is_language_independent(self) -> None:
        """切语言不许动文件名、注册表键、安装路径、数据目录。"""
        identity = dict(branding.IDENTITY)
        for code in branding.LANGUAGES:
            # 身份常量本身与语言无关：同一个字典，不随语言变形。
            self.assertEqual(branding.IDENTITY, identity, code)
        for key, value in identity.items():
            self.assertFalse(any("\u4e00" <= ch <= "\u9fff" for ch in value), f"{key} 不该含中文")
        self.assertEqual(identity["exe"], "AIDrivenNetDefense.exe")
        self.assertEqual(identity["run_value"], "AIDrivenNetDefense")
        self.assertEqual(identity["uninstall_key"], "AIDrivenNetDefense")
        self.assertEqual(identity["install_dir"], "AIDriven NetDefense")


class PersistenceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = S.TempRoot("aidn-display-")
        self.data = self._tmp.__enter__()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def test_default_when_no_file(self) -> None:
        loaded, problem = display.load(self.data)
        self.assertEqual(loaded.language, "en")
        self.assertIsNone(problem)

    def test_switch_persists_on_disk(self) -> None:
        display.set_language("zh", self.data)
        path = display.path_for(self.data)
        self.assertTrue(path.is_file())
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["language"], "zh")
        loaded, _problem = display.load(self.data)
        self.assertEqual(loaded.language, "zh")
        self.assertEqual(loaded.display_name, "网域智防")

    def test_language_survives_process_restart(self) -> None:
        """真·重启：另起一个进程，从同一个数据目录读回设置。"""
        display.set_language("zh", self.data)
        env = dict(os.environ)
        env["AIDN_DATA_DIR"] = str(self.data)
        env["PYTHONPATH"] = str(S.REPO_ROOT / "apps" / "desktop")
        completed = subprocess.run(
            [sys.executable, "-B", "-c", "import settings.display as d; print(d.load()[0].language)"],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "zh")

    def test_language_file_is_separate_from_shell_settings(self) -> None:
        shell_dir = self.data / "shell"
        shell_dir.mkdir(parents=True, exist_ok=True)
        shell_settings = shell_dir / "settings.json"
        shell_settings.write_text(json.dumps({"open_mode": "embedded", "ui_port": 17801}), encoding="utf-8")
        before = shell_settings.read_bytes()

        display.set_language("zh", self.data)
        self.assertEqual(shell_settings.read_bytes(), before, "显示设置不该改写壳的 settings.json")

        # 反过来：壳重写整份 settings.json 也不该抹掉语言。
        shell_settings.write_text(json.dumps({"open_mode": "browser"}), encoding="utf-8")
        self.assertEqual(display.load(self.data)[0].language, "zh")

    def test_corrupt_file_falls_back_and_is_preserved(self) -> None:
        path = display.path_for(self.data)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        loaded, problem = display.load(self.data)
        self.assertEqual(loaded.language, "en")
        self.assertIsNotNone(problem)
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")

    def test_illegal_value_normalized_on_load(self) -> None:
        path = display.path_for(self.data)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"language": "klingon"}), encoding="utf-8")
        loaded, problem = display.load(self.data)
        self.assertIsNone(problem)
        self.assertEqual(loaded.language, "en")


class ShellApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = S.TempRoot("aidn-display-api-")
        self.data = self._tmp.__enter__()

    def tearDown(self) -> None:
        self._tmp.__exit__(None, None, None)

    def test_state_block_carries_everything_the_ui_needs(self) -> None:
        display.set_language("en", self.data)
        block = settings.shell_api.state_block(data_dir=self.data, version="0.0.1")
        self.assertEqual(block["language"], "en")
        self.assertEqual(block["display_name"], "AIDriven NetDefense")
        self.assertEqual(block["window_title"], "AIDriven NetDefense · 0.0.1")
        self.assertEqual([item["code"] for item in block["languages"]], ["en", "zh"])
        self.assertIn("identity", block)

    def test_handle_switches_language(self) -> None:
        status, body = settings.shell_api.handle({"language": "zh"}, data_dir=self.data)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["display"]["display_name"], "网域智防")
        self.assertEqual(display.load(self.data)[0].language, "zh")

    def test_handle_rejects_bad_payload(self) -> None:
        self.assertEqual(settings.shell_api.handle({}, data_dir=self.data)[0], 400)
        self.assertEqual(settings.shell_api.handle({"language": 1}, data_dir=self.data)[0], 400)

    def test_apply_to_window_uses_set_title(self) -> None:
        class FakeWindow:
            def __init__(self) -> None:
                self.title = ""

            def set_title(self, value: str) -> None:
                self.title = value

        window = FakeWindow()
        title = settings.shell_api.apply_to_window(window, "zh", "0.0.1")
        self.assertEqual(title, "网域智防 · 0.0.1")
        self.assertEqual(window.title, title)

    def test_apply_to_window_falls_back_to_document_title(self) -> None:
        class OldWindow:
            def __init__(self) -> None:
                self.js = ""

            def evaluate_js(self, script: str) -> None:
                self.js = script

        window = OldWindow()
        settings.shell_api.apply_to_window(window, "en", "0.0.1")
        self.assertIn("document.title", window.js)


if __name__ == "__main__":
    unittest.main()
