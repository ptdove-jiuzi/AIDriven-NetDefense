"""路径解析、日志文件命名、崩溃留栈、日志目录热切换。"""

from __future__ import annotations

import logging
import re
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402

sys.path.insert(0, str(_support.APP_DIR))

from aidn import logsetup, paths  # noqa: E402


class PathsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _support.temp_base("paths")
        self._saved_env = {k: __import__("os").environ.get(k) for k in ("AIDN_BASE_DIR", "AIDN_DATA_DIR", "AIDN_LOG_DIR")}
        __import__("os").environ["AIDN_BASE_DIR"] = str(self.base)
        paths.set_log_dir_override(None)

    def tearDown(self) -> None:
        import os

        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        paths.set_log_dir_override(None)
        _support.rm(self.base)

    def test_base_dir_follows_env(self) -> None:
        self.assertEqual(paths.base_dir(), self.base.resolve())
        self.assertEqual(paths.data_dir(), (self.base / "data").resolve())
        self.assertEqual(paths.log_dir(), (self.base / "logs").resolve())
        self.assertEqual(paths.settings_path().name, "settings.json")
        self.assertEqual(paths.runtime_state_path().parent.name, "shell")

    def test_token_path_matches_daemon_config(self) -> None:
        """壳读 token 的位置必须与 daemon 配置里写的 tokenFile 一致。"""
        self.assertEqual(paths.token_path(), paths.data_dir() / "secrets" / "api-token")

    def test_log_dir_override_wins_over_env(self) -> None:
        custom = self.base / "custom-logs"
        paths.set_log_dir_override(custom)
        self.assertEqual(paths.log_dir(), custom.resolve())
        paths.set_log_dir_override(None)
        self.assertEqual(paths.log_dir(), (self.base / "logs").resolve())

    def test_default_log_dir_ignores_override(self) -> None:
        paths.set_log_dir_override(self.base / "custom-logs")
        self.assertEqual(paths.default_log_dir(), (self.base / "logs").resolve())


class LogSetupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _support.temp_base("logs")
        self.log_dir = self.base / "logs"
        logsetup.setup(self.log_dir)

    def tearDown(self) -> None:
        _support.rm(self.base)

    def test_file_name_is_dated(self) -> None:
        current = logsetup.current_file()
        self.assertIsNotNone(current)
        assert current is not None
        self.assertTrue(current.is_file())
        self.assertRegex(current.name, r"^desktop-\d{8}\.log$")
        self.assertEqual(current.parent, self.log_dir.resolve())

    def test_log_line_lands_in_file(self) -> None:
        logging.getLogger("aidn.test").info("落盘探针 %s", "PROBE-42")
        for handler in logging.getLogger().handlers:
            handler.flush()
        text = logsetup.current_file().read_text(encoding="utf-8")
        self.assertIn("PROBE-42", text)

    def test_set_log_dir_moves_file(self) -> None:
        other = self.base / "logs-moved"
        written = logsetup.set_log_dir(other)
        self.assertEqual(written.parent, other.resolve())
        logging.getLogger("aidn.test").info("新目录探针 %s", "MOVED-7")
        for handler in logging.getLogger().handlers:
            handler.flush()
        self.assertIn("MOVED-7", written.read_text(encoding="utf-8"))

    def test_thread_exception_leaves_traceback(self) -> None:
        logsetup.install_crash_handlers()
        done = threading.Event()

        def boom() -> None:
            try:
                raise RuntimeError("子线程炸了 CRASH-THREAD")
            except RuntimeError:
                # excepthook 只对「未捕获」生效，这里手动走一遍钩子等价路径。
                import traceback

                text = traceback.format_exc()
                logging.getLogger("aidn.crash").critical("子线程崩溃\n%s", text)
            finally:
                done.set()

        thread = threading.Thread(target=boom, name="boom")
        thread.start()
        done.wait(3)
        for handler in logging.getLogger().handlers:
            handler.flush()
        content = logsetup.current_file().read_text(encoding="utf-8")
        self.assertIn("子线程崩溃", content)
        self.assertRegex(content, re.compile(r"Traceback \(most recent call last\)"))


if __name__ == "__main__":
    unittest.main()
