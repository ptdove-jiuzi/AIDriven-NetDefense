"""daemon.py —— 把 apps/daemon 作为子进程拉起、探活、停止。

约束来自 `apps/daemon/src/config.js`，这里一条都不能绕：

1. `dataDir` 必须显式给出且为绝对路径；
2. `detection.rulePackPath` 必须落在 `dataDir` 内 —— 所以内置规则包先复制进
   `<data>\\rules\\builtin-rules.json`，再交给 daemon；
3. 绑定地址只能是字面量 `127.0.0.1`；
4. 配置是封闭对象，多写一个键 daemon 直接拒绝启动。

端口策略：壳需要知道 daemon 的真实端口才能做同源代理，所以端口由壳先选好再写进
`shell/daemon.conf.json`。若该端口已被占用，daemon 会启动失败（bind 失败 → 退出码 1），
壳据日志判定为端口冲突，换一个端口并**写回配置**后重试。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import json
import logging
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from . import paths

try:  # 包内导入（正常路径）；被当作顶层模块直接 import 时退回同级导入
    from . import logrotate
except ImportError:  # pragma: no cover - 仅脚本式调用会走到
    import logrotate  # type: ignore[no-redef]

log = logging.getLogger("aidn.daemon")

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200

START_TIMEOUT_S = 25.0
PORT_ATTEMPTS = 4


def _enforce_log_dir(directory: Path) -> None:
    """对日志目录执行一次保留策略（过期删除 / 总量上限）。失败只记 warning。"""
    try:
        logrotate.enforce([directory])
    except Exception as error:  # noqa: BLE001 - 维护动作绝不能影响 daemon 启停
        log.warning("日志保留策略执行失败（%s）", error)


class DaemonError(RuntimeError):
    """可展示给用户的启动/停止失败。"""


# --------------------------------------------------------------------- job object
class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _BASIC_LIMIT(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BASIC_LIMIT),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JobObjectExtendedLimitInformation = 9


def _create_kill_on_close_job() -> int | None:
    """建一个「句柄关闭即杀子进程」的 Job，防止壳被杀后 daemon 变孤儿。"""
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _EXTENDED_LIMIT()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            job, _JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
        )
        if not ok:
            kernel32.CloseHandle(job)
            return None
        return int(job)
    except Exception as error:  # noqa: BLE001 - 非致命，退化为止
        log.warning("创建 Job Object 失败（%s），将退化为退出时显式结束进程", error)
        return None


def _assign_to_job(job: int | None, process: subprocess.Popen) -> bool:
    if not job:
        return False
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        return bool(kernel32.AssignProcessToJobObject(job, int(process._handle)))  # noqa: SLF001
    except Exception as error:  # noqa: BLE001
        log.warning("把 daemon 加入 Job Object 失败（%s）", error)
        return False


# ------------------------------------------------------------------------ helpers
def _http_json(url: str, timeout: float = 2.5, headers: dict[str, str] | None = None) -> tuple[int, dict | None]:
    """只用回环地址，显式禁用代理 —— 本机 http_proxy 会把 127.0.0.1 也塞进代理。"""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers=headers or {}, method="GET")
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = response.read().decode("utf-8", "replace")
            try:
                return response.status, json.loads(payload)
            except json.JSONDecodeError:
                return response.status, None
    except urllib.error.HTTPError as error:
        try:
            payload = error.read().decode("utf-8", "replace")
            return error.code, json.loads(payload)
        except Exception:  # noqa: BLE001
            return error.code, None
    except Exception:  # noqa: BLE001 - 连不上就是离线
        return 0, None


def port_free(port: int, host: str = "127.0.0.1") -> bool:
    """该回环端口现在能不能被绑定。

    **不设 SO_REUSEADDR**：在 Windows 上它允许绑定到别人正在监听的端口，探测会
    把「已被占用」报成「空闲」，然后 daemon 在启动时才发现绑不上。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def candidate_ports(preferred: int = 0, count: int = PORT_ATTEMPTS) -> list[int]:
    """候选端口：优先 preferred，被占用则**逐个 +1**。

    不用「随便让内核分配一个」代替：端口写进设置和配置后要能被用户预测，
    也不能每次重启都变一个数字。preferred 为 0 时才退回内核分配。
    """
    if not preferred:
        return [0]
    candidates: list[int] = []
    port = int(preferred)
    while len(candidates) < count and port <= 65535:
        if port_free(port):
            candidates.append(port)
        port += 1
    return candidates or [0]


def resolve_node() -> Path:
    if os.environ.get("AIDN_NODE"):
        candidate = Path(os.environ["AIDN_NODE"]).expanduser()
        if candidate.exists():
            return candidate
        raise DaemonError(f"AIDN_NODE 指向的运行时不存在：{candidate}")
    for candidate in paths.node_candidates():
        if candidate.exists():
            return candidate
    found = shutil_which("node")
    if found:
        return Path(found)
    raise DaemonError("找不到 node 运行时：安装目录缺少 runtime\\node\\node.exe，PATH 中也没有 node")


def shutil_which(name: str) -> str | None:
    import shutil

    return shutil.which(name)


def resolve_entry() -> Path:
    for candidate in paths.daemon_entry_candidates():
        if candidate.is_file():
            return candidate
    raise DaemonError(
        "找不到 daemon 入口 bin.js；安装目录缺少 daemon\\apps\\daemon\\bin.js"
    )


# ---------------------------------------------------------------------- supervisor
class DaemonSupervisor:
    def __init__(self, settings, config_writer) -> None:
        self._settings = settings
        self._write_settings = config_writer
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._job: int | None = None
        self._port: int = 0
        self._restarts = 0
        self._last_error: str | None = None
        self._started_at = 0.0
        self._node: Path | None = None
        self._entry: Path | None = None
        self._log_handle = None
        self._log_check_at = 0.0
        self._watch_stop = threading.Event()
        self._watcher: threading.Thread | None = None
        self._stopping = False

    # ---------------------------------------------------------------- properties
    @property
    def port(self) -> int:
        return self._port

    @property
    def pid(self) -> int | None:
        return self._process.pid if self._process and self._process.poll() is None else None

    @property
    def restarts(self) -> int:
        return self._restarts

    @property
    def last_error(self) -> str | None:
        return self._last_error

    @property
    def node_path(self) -> str | None:
        return str(self._node) if self._node else None

    @property
    def entry_path(self) -> str | None:
        return str(self._entry) if self._entry else None

    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self._port}" if self._port else "—"

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> bool:
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return True
            self._stopping = False
            paths.ensure_runtime_dirs()
            try:
                self._copy_rules()
                self._node = resolve_node()
                self._entry = resolve_entry()
            except DaemonError as error:
                self._last_error = str(error)
                log.error("daemon 无法启动：%s", error)
                return False

            preferred = int(self._settings.daemon_port or 0)
            last_reason = ""
            for port in candidate_ports(preferred, PORT_ATTEMPTS):
                conf = self._write_conf(port)
                ok, reason = self._spawn_and_wait(port, conf)
                if ok:
                    self._port = port
                    self._started_at = time.time()
                    if self._settings.daemon_port != port:
                        self._settings.daemon_port = port
                        self._write_settings(self._settings)
                        log.info("daemon 端口已写回设置：%d", port)
                    log.info("daemon 就绪：127.0.0.1:%d（pid=%s，node=%s）", port, self.pid, self._node)
                    self._last_error = None
                    return True
                last_reason = reason
                # 只有「端口被抢」值得换端口重试；配置错、规则包错换多少个端口都一样。
                if not _looks_like_bind_failure(reason):
                    break
                log.warning("端口 %d 不可用，按 +1 换端口重试：%s", port, reason)
                self._terminate()
            self._last_error = last_reason or "daemon 启动失败"
            log.error("daemon 启动失败：%s", self._last_error)
            return False

    def stop(self, timeout: float = 8.0) -> None:
        with self._lock:
            self._terminate(timeout)
            self._port = 0

    def restart(self) -> bool:
        with self._lock:
            self._terminate(6.0)
        self._restarts += 1
        return self.start()

    # ------------------------------------------------------------------- internals
    def _copy_rules(self) -> Path:
        """规则包必须落在 dataDir 内；内容有变化才覆盖，避免每次启动都改 mtime。"""
        source = paths.rules_source()
        target = paths.rules_path()
        if not source.is_file():
            raise DaemonError(f"内置规则包缺失：{source}")
        payload = source.read_bytes()
        if target.is_file() and target.read_bytes() == payload:
            return target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        log.info("已部署内置规则包：%s", target)
        return target

    def _write_conf(self, port: int) -> Path:
        conf_path = paths.daemon_conf_path()
        conf = {
            "dataDir": str(paths.data_dir()),
            "mode": "mock",
            "api": {
                "enabled": True,
                "host": "127.0.0.1",
                "port": port,
                "tokenFile": "secrets/api-token",
            },
            "detection": {"rulePackPath": "rules/builtin-rules.json"},
            "logging": {"level": "info"},
        }
        conf_path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(conf, ensure_ascii=False, indent=2) + "\n"
        temporary = conf_path.with_suffix(".json.tmp")
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, conf_path)
        return conf_path

    def _spawn_and_wait(self, port: int, conf: Path) -> tuple[bool, str]:
        log_path = paths.daemon_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # 打开之前先收一次：上一次运行留下的 stderr 日志可能已经很大或很旧。
        _enforce_log_dir(log_path.parent)
        self._log_handle = open(log_path, "ab", buffering=0)
        self._log_handle.write(
            f"\n=== 启动 {time.strftime('%Y-%m-%d %H:%M:%S')} port={port} conf={conf} ===\n".encode()
        )
        # 打开之后再收一次；此时 daemon.stderr.log 已是「最新文件」，任何策略都不会动它。
        _enforce_log_dir(log_path.parent)
        creation = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        # cwd 取「包含 apps 的那一层」：两种布局下都等于安装根/仓库根，daemon 的
        # node_modules 查找因此不依赖壳自己的启动目录。
        workdir = self._entry.parents[2] if len(self._entry.parents) >= 3 else self._entry.parent
        try:
            self._process = subprocess.Popen(
                [str(self._node), str(self._entry), "--config", str(conf)],
                cwd=str(workdir),
                stdin=subprocess.DEVNULL,
                stdout=self._log_handle,
                stderr=self._log_handle,
                creationflags=creation,
                close_fds=True,
            )
        except OSError as error:
            self._process = None
            return False, f"无法创建 daemon 进程：{error}"

        if self._job is None:
            self._job = _create_kill_on_close_job()
        _assign_to_job(self._job, self._process)

        deadline = time.time() + START_TIMEOUT_S
        while time.time() < deadline:
            code, body = _http_json(f"http://127.0.0.1:{port}/healthz", timeout=1.5)
            if code == 200 and isinstance(body, dict):
                self._start_watcher()
                return True, "ok"
            if self._process.poll() is not None:
                return False, self._read_failure()
            time.sleep(0.35)
        self._terminate(3.0)
        return False, f"daemon 在 {START_TIMEOUT_S:.0f}s 内没有响应 /healthz"

    def _read_failure(self) -> str:
        path = paths.daemon_log_path()
        tail = ""
        try:
            with open(path, "rb") as stream:
                stream.seek(0, os.SEEK_END)
                size = stream.tell()
                stream.seek(max(0, size - 8192))
                tail = stream.read().decode("utf-8", "replace")
        except OSError:
            pass
        for line in reversed([item for item in tail.splitlines() if item.strip()]):
            if '"level":"error"' in line or "error" in line.lower():
                return line.strip()[:400]
        code = self._process.poll() if self._process else None
        return f"daemon 进程退出（退出码 {code}）"

    # ------------------------------------------------------------------ 看门狗
    def _start_watcher(self) -> None:
        """盯住子进程：它被别人杀掉时要**马上**知道，而不是等到下一次 HTTP 失败。

        UI 的「服务已断开」靠 /api/v1/status 变 503 也能出来，但状态里会没有原因；
        这里补上原因（退出码），让「最近错误」不是空的。
        """
        if self._watcher is not None and self._watcher.is_alive():
            return
        self._watch_stop.clear()

        def watch() -> None:
            while not self._watch_stop.wait(1.5):
                # 每 ≥60 s 检查一次日志（保留策略 + 活跃文件轮转）；失败只记 warning。
                self.maintain_logs()
                with self._lock:
                    process = self._process
                    stopping = self._stopping
                if process is None or stopping:
                    continue
                code = process.poll()
                if code is None:
                    continue
                with self._lock:
                    self._last_error = f"daemon 进程已退出（退出码 {code}）"
                    self._port = 0
                log.error("daemon 进程已退出，退出码 %s", code)
                return

        self._watcher = threading.Thread(target=watch, name="daemon-watch", daemon=True)
        self._watcher.start()

    def _stop_watcher(self) -> None:
        self._watch_stop.set()

    def maintain_logs(self, min_interval_s: float = 60.0) -> dict[str, object]:
        """周期性日志维护：每 ≥`min_interval_s` 秒做一次保留 + 活跃文件轮转。

        `daemon.stderr.log` 是以 "ab"（O_APPEND）打开的，子进程还继承了这个
        句柄，所以只能「复制到 .1 + 原地 truncate」：重命名会让子进程继续写改名
        后的旧文件，Windows 上还会直接 EPERM；truncate 之后追加回到文件开头，
        句柄依然有效，也不会出现空洞。

        返回一个可断言的小字典（`checked`/`rotated`/`target`/`reason`）；
        任何异常都只记 warning，绝不影响 daemon 启停。
        """
        now = time.monotonic()
        if now - self._log_check_at < min_interval_s:
            return {"checked": False, "rotated": False, "target": None, "reason": "interval"}
        self._log_check_at = now
        log_path = paths.daemon_log_path()
        outcome: dict[str, object] = {"checked": True, "rotated": False, "target": None, "reason": None}
        try:
            _enforce_log_dir(log_path.parent)
            if not log_path.is_file():
                return outcome
            result = logrotate.rotate_active(log_path, logrotate.MAX_FILE_BYTES)
            outcome["target"] = result.get("target")
            if result.get("ok") and result.get("rotated"):
                outcome["rotated"] = True
                log.info(
                    "daemon.stderr.log 已轮转 → %s（%s 字节）", result.get("target"), result.get("bytes")
                )
            elif not result.get("ok"):
                outcome["reason"] = result.get("reason")
                log.warning("daemon.stderr.log 轮转失败：%s", result.get("reason"))
        except Exception as error:  # noqa: BLE001 - 维护动作不能影响 daemon 启停
            outcome["reason"] = str(error)
            log.warning("daemon 日志维护失败（%s）", error)
        return outcome

    def _terminate(self, timeout: float = 6.0) -> None:
        self._stopping = True
        self._stop_watcher()
        process = self._process
        self._process = None
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                pass
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                log.warning("daemon 未在 %.1fs 内退出，强制结束", timeout)
                try:
                    process.kill()
                    process.wait(timeout=3.0)
                except Exception:  # noqa: BLE001
                    pass
            log.info("daemon 已结束（pid=%s）", process.pid)
        if self._log_handle is not None:
            try:
                self._log_handle.close()
            except OSError:
                pass
            self._log_handle = None

    # ---------------------------------------------------------------------- status
    def read_token(self) -> str | None:
        try:
            token = paths.token_path().read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return token or None

    def probe(self) -> dict:
        """一次探活：healthz / readyz / status 三个真实响应。"""
        result = {
            "online": False,
            "host": "127.0.0.1",
            "port": self._port or None,
            "endpoint": self.endpoint(),
            "pid": self.pid,
            "restarts": self._restarts,
            "last_error": self._last_error,
            "healthz": None,
            "readyz": None,
            "status": None,
        }
        if not self._port:
            return result
        code, body = _http_json(f"http://127.0.0.1:{self._port}/healthz", timeout=1.5)
        if code != 200 or not isinstance(body, dict):
            # 「离线」必须带原因：进程已死与进程还在但不应答，是两种完全不同的处置。
            process = self._process
            if process is not None and process.poll() is not None and not self._last_error:
                self._last_error = f"daemon 进程已退出（退出码 {process.poll()}）"
                result["last_error"] = self._last_error
            return result
        result["online"] = True
        result["healthz"] = body
        code_ready, ready = _http_json(f"http://127.0.0.1:{self._port}/readyz", timeout=1.5)
        result["readyz"] = ready if code_ready in (200, 503) else None
        token = self.read_token()
        if token:
            code_status, status = _http_json(
                f"http://127.0.0.1:{self._port}/api/v1/status",
                timeout=2.5,
                headers={"Authorization": f"Bearer {token}"},
            )
            if code_status == 200:
                result["status"] = status
        return result


def _looks_like_bind_failure(reason: str) -> bool:
    lowered = (reason or "").lower()
    return "bind" in lowered or "eaddrinuse" in lowered or "address already in use" in lowered
