"""daemon 端口选择：占用则逐个 +1，不做随机跳号；绑定失败与配置错误要能区分。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support  # noqa: E402

sys.path.insert(0, str(_support.APP_DIR))

from aidn import daemon, paths, settings as settings_mod  # noqa: E402


class PortSelectionTest(unittest.TestCase):
    def test_candidate_ports_starts_at_preferred(self) -> None:
        port = _support.free_port()
        self.assertEqual(daemon.candidate_ports(port, 3)[0], port)

    def test_busy_port_moves_up_by_one(self) -> None:
        port = _support.free_port()
        holder = _support.hold_port(port)
        try:
            candidates = daemon.candidate_ports(port, 3)
            self.assertNotIn(port, candidates, "被占用的端口不能出现在候选里")
            self.assertEqual(candidates[0], port + 1, "占用后必须 +1，而不是随机跳号")
        finally:
            holder.close()

    def test_zero_means_kernel_assigned(self) -> None:
        self.assertEqual(daemon.candidate_ports(0, 3), [0])

    def test_bind_failure_detection(self) -> None:
        self.assertTrue(daemon._looks_like_bind_failure("listen EADDRINUSE: address already in use"))
        self.assertTrue(daemon._looks_like_bind_failure("bind failed"))
        self.assertFalse(daemon._looks_like_bind_failure("full mode requires at least one collector source"))
        self.assertFalse(daemon._looks_like_bind_failure("configuration error"))

    def test_port_free_reports_holder(self) -> None:
        port = _support.free_port()
        self.assertTrue(daemon.port_free(port))
        holder = _support.hold_port(port)
        try:
            self.assertFalse(daemon.port_free(port), "别人在监听时端口必须报为不可用")
        finally:
            holder.close()


class DaemonConfigTest(unittest.TestCase):
    """壳写出的 daemon 配置必须能被 daemon 自己的 config.js 接受。"""

    def setUp(self) -> None:
        self.base = _support.temp_base("daemonconf")
        import os

        self._old = {k: os.environ.get(k) for k in ("AIDN_BASE_DIR",)}
        os.environ["AIDN_BASE_DIR"] = str(self.base)
        paths.set_log_dir_override(None)

    def tearDown(self) -> None:
        import os

        for key, value in self._old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        _support.rm(self.base)

    def test_written_config_shape(self) -> None:
        supervisor = daemon.DaemonSupervisor(settings_mod.Settings(daemon_port=17999), lambda _s: None)
        paths.ensure_runtime_dirs()
        conf = supervisor._write_conf(17999)
        payload = __import__("json").loads(conf.read_text(encoding="utf-8"))
        self.assertEqual(payload["mode"], "mock", "bin.js 不注入采集源，full 模式必然拒绝启动")
        self.assertEqual(payload["api"]["host"], "127.0.0.1")
        self.assertEqual(payload["api"]["port"], 17999)
        self.assertEqual(payload["detection"]["rulePackPath"], "rules/builtin-rules.json")
        self.assertEqual(payload["dataDir"], str(paths.data_dir()))
        # 封闭对象：daemon 的 config.js 遇到未知键会直接拒绝启动
        self.assertEqual(
            set(payload), {"dataDir", "mode", "api", "detection", "logging"},
            "多写一个顶层键 daemon 就起不来",
        )


if __name__ == "__main__":
    unittest.main()
