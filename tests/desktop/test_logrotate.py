"""日志轮转：大小 + 天数双阈值、活跃文件永不丢，以及 logsetup / daemon 集成。

判据来自 OPS-DIAG（N-037 §4）：灌 200 MB 假日志后目录总量不超阈值（64 MiB），
最新日志不丢。这里的 200 MB 是**真字节**（不是稀疏文件），所以 `bytes_after`
和「Get-ChildItem -Recurse | Measure-Object Length -Sum」得到的是同一个数。

所有临时目录都在 %TEMP% 下，测试结束删除；不碰真实用户目录。
"""

from __future__ import annotations

import faulthandler
import logging
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402

sys.path.insert(0, str(_support.APP_DIR))

from aidn import daemon as daemon_mod  # noqa: E402
from aidn import logrotate, logsetup, paths  # noqa: E402

MiB = 1024 * 1024
DAY_SECONDS = 24 * 60 * 60
LATEST_MARKER = b"MARKER-LATEST-LOG-STILL-HERE\n"


def write_log(path: Path, size: int, *, head: bytes = b"", age_seconds: float = 0.0) -> int:
    """写一个正好 *size* 字节的假日志，并把 mtime 设成 *age_seconds* 秒之前。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    remaining = size - len(head)
    with open(path, "wb") as stream:
        stream.write(head)
        chunk = b"x" * min(MiB, max(1, remaining))
        while remaining > 0:
            piece = chunk[: min(len(chunk), remaining)]
            stream.write(piece)
            remaining -= len(piece)
    stamp = time.time() - age_seconds
    os.utime(path, (stamp, stamp))
    return path.stat().st_size


def total_bytes(directory: Path) -> int:
    """目录里所有普通文件的字节总和（等同于 OS 侧测法）。"""
    return sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())


class PolicyTest(unittest.TestCase):
    def test_constants_match_the_daemon_side_policy(self) -> None:
        self.assertEqual(logrotate.MAX_FILE_BYTES, 8 * MiB)
        self.assertEqual(logrotate.MAX_TOTAL_BYTES, 64 * MiB)
        self.assertEqual(logrotate.KEEP_DAYS, 7)
        self.assertEqual(logrotate.PROTECT_MS, 60 * 60 * 1000)
        self.assertEqual(logrotate.DEFAULT_POLICY["max_file_bytes"], logrotate.MAX_FILE_BYTES)
        self.assertEqual(logrotate.DEFAULT_POLICY["protect_ms"], logrotate.PROTECT_MS)


class EnforceRetentionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _support.temp_base("logrotate")
        self.root = self.base / "logs"
        self.now = time.time()

    def tearDown(self) -> None:
        _support.rm(self.base)

    def test_200mb_tree_is_capped_and_latest_survives(self) -> None:
        root = self.root
        expired = [root / "app-expired.log", root / "nested" / "app-expired-2.stderr.log"]
        old = [root / f"app-old-{index}.log" for index in range(1, 6)]
        tiny = [root / f"tiny-recent-{index}.log" for index in range(1, 5)]
        latest = root / "desktop-20261105.log"

        injected = 0
        injected += write_log(expired[0], 40 * MiB, head=b"EXPIRED-1\n", age_seconds=10 * DAY_SECONDS)
        injected += write_log(expired[1], 10 * MiB, head=b"EXPIRED-2\n", age_seconds=8 * DAY_SECONDS)
        # app-old-1 最旧（age 最大），app-old-5 相对最新，这样「最旧优先」是确定的。
        for index, path in enumerate(old, start=1):
            injected += write_log(path, 30 * MiB, age_seconds=2 * DAY_SECONDS + (6 - index) * 60)
        for index, path in enumerate(tiny, start=1):
            injected += write_log(path, 1024, head=f"TINY-{index}\n".encode(), age_seconds=index * 60)
        injected += write_log(latest, 2 * MiB, head=LATEST_MARKER, age_seconds=0)

        first = logrotate.enforce([root], now=self.now)
        second = logrotate.enforce([root], now=self.now)

        self.assertGreater(injected, 200 * MiB)
        self.assertEqual(first["examined"], 12)
        self.assertEqual(first["bytes_before"], injected)

        on_disk = total_bytes(root)
        self.assertEqual(on_disk, first["bytes_after"])
        self.assertLessEqual(on_disk, logrotate.MAX_TOTAL_BYTES)

        for path in expired:
            self.assertFalse(path.exists(), f"{path.name} 早于 7 天，应被删除")
        self.assertEqual(len(first["deleted"]), 5, "2 个过期 + 3 个最旧的 30 MB")
        for path in old[:3]:
            self.assertFalse(path.exists(), f"{path.name} 最旧，应先被删")
        for path in old[3:]:
            self.assertTrue(path.with_name(path.name + ".1").is_file(), f"{path.name} 应被轮转")

        self.assertTrue(latest.is_file(), "最新日志永不删除")
        with open(latest, "rb") as stream:
            self.assertEqual(stream.read(len(LATEST_MARKER)), LATEST_MARKER)

        for path in tiny:
            self.assertTrue(path.exists(), f"{path.name} 在 1 小时内改过，必须保留")
            self.assertFalse(path.with_name(path.name + ".1").exists(), "活跃文件也不能被改名")
            self.assertTrue(path.read_bytes().startswith(b"TINY-"))

        self.assertEqual(len(first["rotated"]), 2)
        for entry in first["rotated"]:
            self.assertEqual(entry["bytes"], 30 * MiB)
            self.assertEqual(Path(entry["to"]).stat().st_size, 30 * MiB)

        # 幂等
        self.assertEqual(second["deleted"], [])
        self.assertEqual(second["rotated"], [])
        self.assertEqual(second["bytes_after"], first["bytes_after"])
        self.assertEqual(second["bytes_before"], first["bytes_after"])

    def test_active_oversize_file_is_neither_deleted_nor_rotated(self) -> None:
        protected = self.root / "active-big.log"
        write_log(protected, 20 * MiB, head=b"ACTIVE\n", age_seconds=0)
        result = logrotate.enforce([self.root], now=self.now)
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["rotated"], [])
        self.assertTrue(protected.is_file())
        self.assertEqual(protected.stat().st_size, 20 * MiB)
        self.assertFalse(protected.with_name(protected.name + ".1").exists())

    def test_newest_file_survives_even_when_everything_is_expired(self) -> None:
        older = self.root / "older.log"
        newest = self.root / "newest.log"
        write_log(older, 100 * 1024, age_seconds=9 * DAY_SECONDS + 3600)
        write_log(newest, 100 * 1024, age_seconds=9 * DAY_SECONDS)
        result = logrotate.enforce([self.root], now=self.now)
        self.assertEqual(result["deleted"], [str(older)])
        self.assertTrue(newest.is_file())
        self.assertEqual(result["bytes_after"], 100 * 1024)

    def test_missing_directory_is_reported_not_raised(self) -> None:
        result = logrotate.enforce([self.base / "does-not-exist", ""], now=self.now)
        self.assertEqual(result["examined"], 0)
        self.assertEqual(result["bytes_after"], 0)
        reasons = [item["reason"] for item in result["skipped"]]
        self.assertTrue(
            any(reason.startswith("directory-unavailable") or reason == "not-a-directory" for reason in reasons)
        )
        self.assertIn("invalid-directory", reasons)

    def test_nonsense_policy_values_fall_back_to_defaults(self) -> None:
        stale = self.root / "stale-big.log"
        write_log(stale, 10 * MiB, age_seconds=2 * 3600)
        result = logrotate.enforce(
            [self.root],
            now=self.now,
            policy={
                "max_file_bytes": 0,
                "max_total_bytes": -1,
                "max_age_days": float("nan"),
                "protect_ms": float("inf"),
            },
        )
        target = stale.with_name(stale.name + ".1")
        self.assertEqual([entry["to"] for entry in result["rotated"]], [str(target)])
        self.assertTrue(target.is_file())


class RotateActiveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _support.temp_base("logrotate-active")

    def tearDown(self) -> None:
        _support.rm(self.base)

    def test_rotate_keeps_append_handle_valid_and_leaves_no_hole(self) -> None:
        path = self.base / "active.log"
        write_log(path, 12 * MiB, head=b"HEAD-1\n")
        # 模拟 daemon 子进程的写句柄：O_APPEND，永不 rewind。
        handle = open(path, "ab", buffering=0)  # noqa: SIM115
        try:
            handle.write(b"TAIL-BEFORE-ROTATE\n")
            result = logrotate.rotate_active(path, 8 * MiB)
            self.assertTrue(result["ok"])
            self.assertTrue(result["rotated"])
            target = Path(result["target"])
            self.assertTrue(target.is_file(), "必须先有 .1 备份")
            self.assertEqual(path.stat().st_size, 0, "原文件仍在，被原地截断")
            handle.write(b"AFTER-ROTATE\n")  # 截断后同一个句柄继续追加
        finally:
            handle.close()

        self.assertEqual(path.read_bytes(), b"AFTER-ROTATE\n", "截断后写入落在开头，无空洞")
        backup = target.read_bytes()
        self.assertTrue(backup.startswith(b"HEAD-1\n"))
        self.assertIn(b"TAIL-BEFORE-ROTATE", backup, "截断前已写入的内容必须进备份")
        self.assertEqual(result["bytes"], len(backup))

    def test_below_threshold_is_a_noop(self) -> None:
        path = self.base / "small.log"
        write_log(path, 1024)
        result = logrotate.rotate_active(path, 8 * MiB)
        self.assertTrue(result["ok"])
        self.assertFalse(result["rotated"])
        self.assertEqual(result["reason"], "below-threshold")
        self.assertEqual(path.stat().st_size, 1024)
        self.assertFalse((self.base / "small.log.1").exists())

    def test_missing_file_is_reported_not_raised(self) -> None:
        result = logrotate.rotate_active(self.base / "nope.log")
        self.assertFalse(result["ok"])
        self.assertFalse(result["rotated"])
        self.assertEqual(result["reason"], "missing")


class LogSetupIntegrationTest(unittest.TestCase):
    """logsetup 的真实路径：FileHandler + faulthandler 共用当天文件。"""

    def setUp(self) -> None:
        self.base = _support.temp_base("logsetup-rotate")
        self.log_dir = self.base / "logs"
        self.root_logger = logging.getLogger()
        self.saved_handlers = list(self.root_logger.handlers)
        self.saved_level = self.root_logger.level
        logsetup.setup(self.log_dir)
        self.current = logsetup.current_file()
        self.assertIsNotNone(self.current)

    def tearDown(self) -> None:
        for handler in list(self.root_logger.handlers):
            if handler not in self.saved_handlers:
                self.root_logger.removeHandler(handler)
                try:
                    handler.close()
                except Exception:  # noqa: BLE001
                    pass
        for handler in self.saved_handlers:
            if handler not in self.root_logger.handlers:
                self.root_logger.addHandler(handler)
        self.root_logger.setLevel(self.saved_level)
        # 先关 faulthandler，再断开它引用的流（Windows 上句柄不放手会删不掉目录）
        faulthandler.disable()
        stream = logsetup._state.get("faulthandler")
        if stream is not None:
            try:
                stream.close()
            except Exception:  # noqa: BLE001
                pass
            logsetup._state["faulthandler"] = None
        _support.rm(self.base)

    def _flush(self) -> None:
        for handler in logging.getLogger().handlers:
            handler.flush()

    def test_oversize_day_file_rotates_and_keeps_appending(self) -> None:
        current = self.current
        probe = logging.getLogger("aidn.logrotate.probe")
        filler = "A" * (MiB // 2)
        for _ in range(20):  # 约 10 MiB，超过 8 MiB 阈值
            probe.info("%s", filler)
        self._flush()
        self.assertGreater(current.stat().st_size, logrotate.MAX_FILE_BYTES)

        rotated = logsetup.maybe_rotate_active()
        self.assertIsNotNone(rotated)
        assert rotated is not None
        self.assertTrue(rotated.is_file())
        # 当天文件仍然存在，只是被就地截断；轮转之后写的那行 info 会落在文件开头，
        # 所以这里断言「只剩很小的量」，而不是精确 0。
        self.assertLess(current.stat().st_size, 4096, "当天文件被截断，只剩轮转日志一行")
        self.assertIn("A" * 100, rotated.read_text(encoding="utf-8", errors="replace"))

        probe.info("轮转后继续写 PROBE-AFTER-ROTATE")
        self._flush()
        text = current.read_text(encoding="utf-8", errors="replace")
        self.assertIn("PROBE-AFTER-ROTATE", text)
        self.assertNotIn("A" * 100, text, "截断之后不应残留旧内容（否则就是空洞）")

        # faulthandler 的句柄仍然有效：真往里写一次栈，证据落在当天文件里。
        stream = logsetup._state.get("faulthandler")
        self.assertIsNotNone(stream)
        assert stream is not None
        self.assertFalse(stream.closed)
        faulthandler.dump_traceback(file=stream, all_threads=False)
        stream.flush()
        after_dump = current.read_text(encoding="utf-8", errors="replace")
        self.assertIn("most recent call first", after_dump)
        self.assertIn("PROBE-AFTER-ROTATE", after_dump)

    def test_set_log_dir_applies_retention_to_the_new_directory(self) -> None:
        other = self.base / "logs-moved"
        expired = other / "desktop-20200101.log"
        recent = other / "desktop-recent.log"
        write_log(expired, 2 * MiB, age_seconds=10 * DAY_SECONDS)
        write_log(recent, 4 * MiB, age_seconds=2 * DAY_SECONDS)

        target = logsetup.set_log_dir(other)
        self.assertEqual(target.parent, other.resolve())
        self.assertFalse(expired.exists(), "换目录时应顺手删掉 10 天前的日志")
        self.assertTrue(recent.is_file(), "2 天前、4 MiB 的日志应保留")
        self.assertLessEqual(total_bytes(other), logrotate.MAX_TOTAL_BYTES)


class DaemonLogRotationTest(unittest.TestCase):
    """daemon.py 集成：daemon.stderr.log 超 8 MiB 时复制 + 原地截断。"""

    def setUp(self) -> None:
        self.base = _support.temp_base("daemon-rotate")
        self.saved_env = {key: os.environ.get(key) for key in ("AIDN_BASE_DIR", "AIDN_DATA_DIR", "AIDN_LOG_DIR")}
        os.environ["AIDN_BASE_DIR"] = str(self.base)
        for key in ("AIDN_DATA_DIR", "AIDN_LOG_DIR"):
            os.environ.pop(key, None)
        self.supervisor = daemon_mod.DaemonSupervisor(SimpleNamespace(daemon_port=0), lambda settings: None)

    def tearDown(self) -> None:
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        _support.rm(self.base)

    def test_maintain_logs_rotates_an_oversize_stderr_log(self) -> None:
        log_path = paths.daemon_log_path()
        write_log(log_path, 12 * MiB, head=b"DAEMON-HEAD\n")
        # 与 DaemonSupervisor._spawn_and_wait 里完全相同的打开方式（子进程还继承这个句柄）。
        handle = open(log_path, "ab", buffering=0)  # noqa: SIM115
        try:
            handle.write(b"BEFORE-ROTATE\n")
            result = self.supervisor.maintain_logs(min_interval_s=0.0)
            self.assertTrue(result["checked"])
            self.assertTrue(result["rotated"])
            self.assertEqual(log_path.stat().st_size, 0)
            handle.write(b"AFTER-ROTATE\n")  # 截断之后同一个句柄继续追加
        finally:
            handle.close()

        self.assertEqual(log_path.read_bytes(), b"AFTER-ROTATE\n", "截断后追加落在开头，无空洞")
        target = Path(str(result["target"]))
        self.assertTrue(target.is_file())
        backup = target.read_bytes()
        self.assertTrue(backup.startswith(b"DAEMON-HEAD\n"))
        self.assertIn(b"BEFORE-ROTATE", backup)

    def test_maintain_logs_honours_the_60_second_interval(self) -> None:
        first = self.supervisor.maintain_logs(min_interval_s=60.0)
        self.assertTrue(first["checked"])
        log_path = paths.daemon_log_path()
        write_log(log_path, 9 * MiB)
        again = self.supervisor.maintain_logs(min_interval_s=60.0)
        self.assertFalse(again["checked"], "60 s 内不应重复检查")
        self.assertEqual(log_path.stat().st_size, 9 * MiB)


if __name__ == "__main__":
    unittest.main()
