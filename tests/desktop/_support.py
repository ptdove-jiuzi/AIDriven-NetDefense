"""_support.py —— tests/desktop 共用的隔离与探测工具。

两条铁律，这个文件就是为它们服务的：

1. **绝不碰真实用户目录。** 所有测试都用 `AIDN_BASE_DIR` / `AIDN_DATA_DIR` /
   `AIDN_LOG_DIR` 指到 `%TEMP%` 下的独立目录；开机自启用 `AIDN_RUN_KEY` 指到
   一个测试专用的注册表子键。测试前后对真实 `%LOCALAPPDATA%\\AIDriven NetDefense`
   做文件快照比对，断言「0 个文件被改动」。
2. **不走系统代理。** 本机设了 http_proxy 且 no_proxy 为空，回环请求必须显式
   绕过代理，否则测的是代理而不是本地服务。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2] / "apps" / "desktop"
REPO_ROOT = APP_DIR.parents[1]

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

CURRENT_USER = os.environ.get("USERPROFILE", str(Path.home()))
REAL_BASE = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "AIDriven NetDefense"


def python_executable() -> str:
    return sys.executable


def make_env(base: Path | None = None, **extra: str) -> dict[str, str]:
    """构造一个隔离的进程环境。"""
    base = base or Path(tempfile.mkdtemp(prefix="aidn-test-"))
    env = dict(os.environ)
    env["AIDN_BASE_DIR"] = str(base)
    env["AIDN_RUN_KEY"] = r"Software\AIDrivenNetDefenseTest\Run"
    env["AIDN_NO_OPEN"] = "1"
    env["PYTHONPATH"] = str(APP_DIR)
    env["PYTHONIOENCODING"] = "utf-8"
    # 不继承可能存在的调试开关
    for key in ("AIDN_DATA_DIR", "AIDN_LOG_DIR", "AIDN_NODE", "AIDN_DAEMON_ENTRY"):
        env.pop(key, None)
    env.update(extra)
    return env


def temp_base(name: str = "case") -> Path:
    path = Path(tempfile.mkdtemp(prefix=f"aidn-{name}-"))
    return path


def http(url: str, timeout: float = 6.0, method: str = "GET", payload: dict | None = None,
         headers: dict[str, str] | None = None) -> tuple[int, dict | None]:
    """回环 HTTP，绕开代理。返回 (status, json)。连不上返回 (0, None)。"""
    data = None
    request_headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["content-type"] = "application/json"
    request_headers.update(headers or {})
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            try:
                return response.status, json.loads(body)
            except json.JSONDecodeError:
                return response.status, None
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return error.code, None
    except Exception:  # noqa: BLE001
        return 0, None


def shell_post(port: int, path: str, payload: dict | None = None, timeout: float = 40.0) -> tuple[int, dict | None]:
    """桌面壳的写接口（需要 x-aidn-shell 头）。"""
    return http(f"http://127.0.0.1:{port}{path}", timeout=timeout, method="POST",
                payload=payload or {}, headers={"x-aidn-shell": "1"})


def wait_until(predicate, timeout: float, interval: float = 0.2, label: str = "条件"):
    """轮询到 predicate 为真，返回耗时；超时抛 AssertionError。"""
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        value = predicate()
        if value:
            return time.monotonic() - started
        time.sleep(interval)
    raise AssertionError(f"{label} 在 {timeout:.1f}s 内没有成立")


def free_port(start: int = 0) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", start))
        return sock.getsockname()[1]


def hold_port(port: int) -> socket.socket:
    """占住一个端口，用于验证「占用后自动 +1」。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", port))
    sock.listen(1)
    return sock


# --------------------------------------------------------------- 进程与文件快照
def process_commandline(needle: str) -> list[dict]:
    """用 CIM 查命令行里含 needle 的进程（Windows）。"""
    script = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -like '*" + needle.replace("'", "''") + "*' } | "
        "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    text = (completed.stdout or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else [data]


def pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        completed = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return str(pid) in (completed.stdout or "")


def kill_pid(pid: int) -> None:
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        pass


def snapshot(root: Path) -> dict[str, tuple[int, int]]:
    """目录快照：相对路径 → (大小, mtime_ns)。不存在时为空。"""
    result: dict[str, tuple[int, int]] = {}
    if not root.exists():
        return result
    for path in root.rglob("*"):
        if path.is_file():
            try:
                stat = path.stat()
                result[str(path.relative_to(root))] = (stat.st_size, stat.st_mtime_ns)
            except OSError:
                continue
    return result


def diff_snapshot(before: dict, after: dict) -> list[str]:
    changed = []
    for key in sorted(set(before) | set(after)):
        if before.get(key) != after.get(key):
            changed.append(key)
    return changed


def rm(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
