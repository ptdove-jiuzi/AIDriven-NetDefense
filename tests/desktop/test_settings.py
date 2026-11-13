"""设置文件的读写、校验与开机自启（隔离注册表子键，不碰用户真实 Run 键）。"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402

sys.path.insert(0, str(_support.APP_DIR))

from aidn import settings as settings_mod  # noqa: E402


class SettingsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _support.temp_base("settings")
        self.path = self.base / "data" / "shell" / "settings.json"

    def tearDown(self) -> None:
        _support.rm(self.base)

    # ------------------------------------------------------------------ 默认值
    def test_defaults_are_valid_and_written(self) -> None:
        loaded = settings_mod.load(self.path)
        self.assertEqual(loaded.open_mode, "embedded")
        self.assertEqual(loaded.ui_port, settings_mod.DEFAULT_UI_PORT)
        self.assertEqual(loaded.daemon_port, settings_mod.DEFAULT_DAEMON_PORT)
        self.assertTrue(self.path.is_file(), "首次加载必须把默认值落盘")

    def test_normalized_rejects_bad_values(self) -> None:
        raw = settings_mod.Settings(
            open_mode="qt", ui_port=-5, daemon_port=70000,
            window_width=10, window_height=99999, log_dir="relative/dir",
        ).normalized()
        self.assertEqual(raw.open_mode, "embedded")
        self.assertEqual(raw.ui_port, settings_mod.DEFAULT_UI_PORT)
        self.assertEqual(raw.daemon_port, settings_mod.DEFAULT_DAEMON_PORT)
        self.assertEqual(raw.window_width, 960)
        self.assertEqual(raw.window_height, 2160)
        self.assertEqual(raw.log_dir, "", "相对路径的日志目录必须被丢弃")

    def test_absolute_log_dir_is_kept(self) -> None:
        target = str(self.base / "logs2")
        raw = settings_mod.Settings(log_dir=target).normalized()
        self.assertEqual(raw.log_dir, target)

    # ------------------------------------------------------------------ 原子写
    def test_save_is_atomic_and_round_trips(self) -> None:
        original = settings_mod.Settings(ui_port=18900, daemon_port=18901, open_mode="browser")
        settings_mod.save(self.path, original)
        loaded = settings_mod.load(self.path)
        self.assertEqual(loaded.ui_port, 18900)
        self.assertEqual(loaded.daemon_port, 18901)
        self.assertEqual(loaded.open_mode, "browser")

        leftovers = [p.name for p in self.path.parent.iterdir() if p.name.startswith(".settings-")]
        self.assertEqual(leftovers, [], f"临时文件没有清掉：{leftovers}")

    def test_corrupt_file_is_quarantined(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("{ not json", encoding="utf-8")
        loaded = settings_mod.load(self.path)
        self.assertEqual(loaded.ui_port, settings_mod.DEFAULT_UI_PORT)
        self.assertTrue(self.path.with_suffix(".json.bad").is_file(), "损坏的设置必须留档，不能静默丢弃")
        self.assertTrue(self.path.is_file(), "损坏后要立即写好一份可用默认值")

    def test_unknown_keys_do_not_crash(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"ui_port": 18800, "future_key": True}), encoding="utf-8")
        loaded = settings_mod.load(self.path)
        self.assertEqual(loaded.ui_port, 18800)

    # ---------------------------------------------------------- 开机自启（隔离）
    def test_autostart_write_read_delete(self) -> None:
        import os

        previous = os.environ.get("AIDN_RUN_KEY")
        os.environ["AIDN_RUN_KEY"] = r"Software\AIDrivenNetDefenseTest\Run"
        os.environ["AIDN_RUN_VALUE"] = "AIDrivenNetDefenseTest"
        try:
            settings_mod.set_autostart(False)
            self.assertFalse(settings_mod.autostart_state()[0])

            self.assertTrue(settings_mod.set_autostart(True), "写入后读回必须是 True")
            registered, command = settings_mod.autostart_state()
            self.assertTrue(registered)
            self.assertIn("--background", command or "", "自启命令必须带 --background，否则开机就弹窗")

            self.assertFalse(settings_mod.set_autostart(False))
            self.assertFalse(settings_mod.autostart_state()[0])
        finally:
            settings_mod.set_autostart(False)
            for key in ("AIDN_RUN_VALUE",):
                os.environ.pop(key, None)
            if previous is None:
                os.environ.pop("AIDN_RUN_KEY", None)
            else:
                os.environ["AIDN_RUN_KEY"] = previous

    def test_real_run_key_is_untouched_by_tests(self) -> None:
        """测试用的隔离键不能影响真实开机自启项：只读比对，不写。"""
        import os

        os.environ.pop("AIDN_RUN_KEY", None)
        real_state = settings_mod.autostart_state()
        os.environ["AIDN_RUN_KEY"] = r"Software\AIDrivenNetDefenseTest\Run"
        try:
            settings_mod.set_autostart(True)
            settings_mod.set_autostart(False)
        finally:
            os.environ.pop("AIDN_RUN_KEY", None)
        self.assertEqual(real_state, settings_mod.autostart_state(), "真实 HKCU Run 项被测试改动了")


if __name__ == "__main__":
    unittest.main()
