#!/usr/bin/env python
"""paths-probe.py — 直接调用 apps/desktop/aidn 的真实解析函数（author PT-dove）。

为什么这样做：托盘 UI 是 Win32 + pywebview，验收脚本不启动 GUI。但「界面从哪个目录来」
完全由 `aidn/paths.py::console_dir()` 和 `aidn/app.py::_pick_web_root()` 决定，这两个是
普通函数，可以直接 import 并调用 —— 所以本探针证明的是**真实的目录解析层**，不是复刻：

  1. `paths.install_root()` 在安装态 = exe 所在目录，`console_dir()` = 该目录下 `console/`；
  2. `_pick_web_root()` 只看 `console/index.html` 是否存在，存在就用它，否则退回内置 `webui/`；
  3. 把安装根分别指向「仓库开发树」「dist/bundle/win32-x64-v15」「临时目录（console/ 放
     apps/console-next 的副本）」三种情况，看它到底选中哪份 index.html；
  4. 再用真实的 `aidn/server.py::LocalServer` 起一个回环服务（**这是壳自带的那个服务器**），
     实测 GET / 与 POST /api/v1/settings 的响应 —— 证明旧壳的写闸门。

不启动托盘、不写任何别人的文件；临时目录用 tempfile 并在结束时删除。

用法：
    python tests/e2e/shell-link/paths-probe.py            # 人读
    python tests/e2e/shell-link/paths-probe.py --json     # 机器读（单行 JSON）
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DESKTOP = REPO / "apps" / "desktop"
BUNDLE_V15 = REPO / "dist" / "bundle" / "win32-x64-v15"
CONSOLE_NEXT = REPO / "apps" / "console-next"
CONSOLE_OLD = REPO / "apps" / "console"
QA_TOKEN = Path("D:/AIUSE/_qa/int/2026-11-04/secrets/api-token")
DAEMON_URL = ("127.0.0.1", 17511)

sys.path.insert(0, str(DESKTOP))

import aidn.paths as paths  # noqa: E402  真实模块
import aidn.app as app  # noqa: E402
import aidn.server as server  # noqa: E402


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe_page(path: Path) -> dict:
    """一份 index.html 的「新/旧界面」判据。"""
    if not path.is_file():
        return {"path": str(path), "exists": False}
    text = path.read_text(encoding="utf-8", errors="replace")
    title = re.search(r"<title>(.*?)</title>", text, re.S)
    return {
        "path": str(path),
        "exists": True,
        "sha256": sha256_file(path),
        "bytes": path.stat().st_size,
        "data_route_count": len(re.findall(r"data-route=", text)),
        "title": (title.group(1).strip() if title else None),
    }


def probe_pick_web_root(label: str, install_root: Path | None) -> dict:
    """在给定的安装根下调用**真实的** app._pick_web_root()。"""
    original = paths.install_root
    try:
        if install_root is not None:
            paths.install_root = lambda: install_root
        console_dir = paths.console_dir()
        record = {
            "label": label,
            "install_root": str(paths.install_root()),
            "console_dir": str(console_dir),
            "console_index_exists": (console_dir / "index.html").is_file(),
        }
        try:
            root = app._pick_web_root()
            record["picked_web_root"] = str(root)
            record["picked_from_console_dir"] = root == console_dir.resolve()
            record["page"] = describe_page(root / "index.html")
        except Exception as error:  # noqa: BLE001 - 内置界面缺失是合法结局，要如实记录
            record["picked_web_root"] = None
            record["error"] = f"{type(error).__name__}: {error}"
        return record
    finally:
        paths.install_root = original


class StubController:
    """LocalServer 只用到这两个方法；返回值指向真实 daemon 的只读面。"""

    def daemon_port(self) -> int:
        return DAEMON_URL[1] if _daemon_up() else 0

    def daemon_token(self) -> str | None:
        if QA_TOKEN.is_file():
            return QA_TOKEN.read_text(encoding="utf-8").strip() or None
        return None


def _daemon_up() -> bool:
    connection = http.client.HTTPConnection(*DAEMON_URL, timeout=2.0)
    try:
        connection.request("GET", "/healthz", headers={"host": f"{DAEMON_URL[0]}:{DAEMON_URL[1]}"})
        return connection.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def request(port: int, method: str, path: str, body: bytes | None = None,
            headers: dict | None = None) -> dict:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10.0)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        raw = response.read()
        parsed = None
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = None
        return {
            "method": method,
            "path": path,
            "status": response.status,
            "content_type": response.getheader("content-type"),
            "error_code": (parsed or {}).get("error", {}).get("code") if isinstance(parsed, dict) else None,
            "error_message": (parsed or {}).get("error", {}).get("message") if isinstance(parsed, dict) else None,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "body_head": raw[:180].decode("utf-8", "replace"),
            "server": response.getheader("server"),
        }
    finally:
        connection.close()


def exercise_desktop_server(label: str, web_root: Path) -> dict:
    """用真实的 aidn.server.LocalServer 起服务并实测读写闸门。"""
    record: dict = {"label": label, "web_root": str(web_root)}
    if not (web_root / "index.html").is_file():
        record["skipped"] = "web_root has no index.html"
        return record
    if not _daemon_up():
        record["daemon"] = "17511 not running (GET proxy check will be skipped)"
    instance = server.LocalServer(StubController(), web_root, 0)
    try:
        port = instance.start()
        record["port"] = port
        record["url"] = f"http://127.0.0.1:{port}/"
        page = request(port, "GET", "/")
        record["get_index"] = page
        record["served_page_is_web_root_index"] = page["sha256"] == sha256_file(web_root / "index.html")
        # 新界面的两个写动作：POST/PUT 到 /api/v1/*，浏览器会带 x-console-v2: 1
        plain_headers = {"content-type": "application/json", "content-length": "2"}
        v2_headers = dict(plain_headers, **{"x-console-v2": "1"})
        record["post_settings_without_v2"] = request(port, "POST", "/api/v1/settings", b"{}", plain_headers)
        record["post_settings_with_v2"] = request(port, "POST", "/api/v1/settings", b"{}", v2_headers)
        record["put_settings_with_v2"] = request(port, "PUT", "/api/v1/settings", b"{}", v2_headers)
        if _daemon_up():
            record["get_healthz"] = request(port, "GET", "/healthz")
        record["post_shell_api_without_header"] = request(port, "POST", "/shell/api/settings", b"{}", plain_headers)
    finally:
        instance.stop()
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="print one-line JSON")
    options = parser.parse_args()

    result: dict = {
        "probe": "paths-probe.py",
        "repo": str(REPO),
        "python": sys.version.split()[0],
        "daemon_up": _daemon_up(),
        "sources": {
            "paths.py": str(DESKTOP / "aidn" / "paths.py"),
            "app.py": str(DESKTOP / "aidn" / "app.py"),
            "server.py": str(DESKTOP / "aidn" / "server.py"),
        },
        # post-fix expectation (D4)：壳自己升级成 v2 宿主后，`server.py` 的注释会点名
        # console-next；但「目录解析 / 启动决策认 console-next」仍然不成立（那是打包侧职责），
        # 也仍然不拉起 node 宿主（serve.mjs）。
        "shell_sources_mention_console_next": any(
            "console-next" in (DESKTOP / "aidn" / name).read_text(encoding="utf-8", errors="replace")
            for name in ("paths.py", "app.py", "tray.py", "daemon.py")
        ),
        "shell_server_mentions_console_next": any(
            "console-next" in file.read_text(encoding="utf-8", errors="replace")
            for file in (DESKTOP / "aidn").glob("*.py")
        ),
        # 「是否拉起 node 宿主」不能按字符串出现判：server.py 的注释里会引用
        # console-next/serve.mjs（说明闸门同形），那不是拉起。只看真正的子进程调用。
        "shell_sources_launch_node_host": any(
            re.search(r"(?:Popen|subprocess\.(?:run|call|check_output|check_call)|spawn)\s*\([^)]*serve\.mjs",
                      file.read_text(encoding="utf-8", errors="replace"))
            for file in (DESKTOP / "aidn").glob("*.py")
        ),
        "cases": {},
    }

    # 1) 开发树：install_root() 是仓库根，console_dir 是 <repo>/console
    result["cases"]["dev_default"] = probe_pick_web_root("dev_default", None)

    # 2) 已发布的 v15 bundle（rc.3 载荷同源）：安装根 = bundle 根，console/ 就在旁边
    if (BUNDLE_V15 / "console" / "index.html").is_file():
        result["cases"]["bundle_v15"] = probe_pick_web_root("bundle_v15", BUNDLE_V15)
    else:
        result["cases"]["bundle_v15"] = {"label": "bundle_v15", "skipped": "bundle console missing"}

    # 3) 假设把 console-next 当作 console 目录（证明静态层并不排斥新界面文件）
    scratch = Path(tempfile.mkdtemp(prefix="aidn-shell-link-"))
    try:
        if CONSOLE_NEXT.is_dir():
            shutil.copytree(CONSOLE_NEXT, scratch / "console")
            result["cases"]["console_next_as_console"] = probe_pick_web_root("console_next_as_console", scratch)
        else:
            result["cases"]["console_next_as_console"] = {"skipped": "apps/console-next missing"}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    # 4) 真实 LocalServer 的读写闸门：旧界面（bundle）与新界面文件各测一次
    if (BUNDLE_V15 / "console" / "index.html").is_file():
        result["desktop_server_old_console"] = exercise_desktop_server(
            "bundle_v15_console", BUNDLE_V15 / "console")
    else:
        result["desktop_server_old_console"] = {"skipped": "bundle console missing"}

    scratch2 = Path(tempfile.mkdtemp(prefix="aidn-shell-link-v2-"))
    try:
        shutil.copytree(CONSOLE_NEXT, scratch2 / "console")
        result["desktop_server_new_console"] = exercise_desktop_server(
            "console_next_as_console", scratch2 / "console")
    finally:
        shutil.rmtree(scratch2, ignore_errors=True)

    # ---- 断言（可执行判据，供 node --test 与证据引用） ----
    dev = result["cases"]["dev_default"]
    bundle = result["cases"].get("bundle_v15", {})
    next_as = result["cases"].get("console_next_as_console", {})
    old_server = result.get("desktop_server_old_console", {})
    new_server = result.get("desktop_server_new_console", {})
    old_sha = sha256_file(CONSOLE_OLD / "index.html") if (CONSOLE_OLD / "index.html").is_file() else None

    # post-fix expectation (D4)：壳现在会代发 `/api/**` 的写请求。
    # 判据不再用「405 / 501」这种**壳层拒绝码**，而是：
    #   ① 没带 x-console-v2 → 403 CONSOLE_HEADER_REQUIRED（宿主闸门仍在）；
    #   ② 带了 → 请求到达 daemon（daemon 自己的状态/文案）；daemon 离线则 503 DAEMON_OFFLINE。
    daemon_up = result["daemon_up"]

    def reached_daemon(record: dict) -> bool | None:
        if not record:
            return None
        if not daemon_up:
            return record.get("status") == 503 and record.get("error_code") == "DAEMON_OFFLINE"
        if record.get("status") in (200, 400):
            return True
        # daemon 对 POST /api/v1/settings 自己回 405，文案与旧壳的「只读端点不接受 POST」不同。
        message = record.get("error_message") or ""
        return "not supported for this endpoint" in message

    assertions = {
        "console_dir_is_install_root_console": dev.get("console_dir", "").replace("\\", "/").endswith("/console"),
        "shell_launch_sources_do_not_mention_console_next": result["shell_sources_mention_console_next"] is False,
        "shell_sources_do_not_launch_node_host": result["shell_sources_launch_node_host"] is False,
        "bundle_pick_is_bundle_console": bundle.get("picked_web_root", "").replace("\\", "/").endswith("/console"),
        "bundle_pick_serves_old_console_bytes": (
            bundle.get("page", {}).get("sha256") == old_sha and bundle.get("page", {}).get("data_route_count") == 0
        ) if bundle.get("page", {}).get("exists") else None,
        "console_next_files_are_accepted_as_web_root": (
            next_as.get("page", {}).get("data_route_count") == 6
            and next_as.get("page", {}).get("sha256") == sha256_file(CONSOLE_NEXT / "index.html")
        ) if next_as.get("page", {}).get("exists") else None,
        "desktop_server_serves_web_root_index_verbatim": old_server.get("served_page_is_web_root_index"),
        # 无闸门的写请求必须被宿主拦下（跨源表单加不上自定义头）。
        "desktop_server_has_write_gate": (
            old_server.get("post_settings_without_v2", {}).get("status") == 403
            and old_server.get("post_settings_without_v2", {}).get("error_code") == "CONSOLE_HEADER_REQUIRED"
        ) if "post_settings_without_v2" in old_server else None,
        # 带闸门的写请求必须到达 daemon（POST / PUT 各一条）。
        "desktop_server_proxies_post_to_daemon": (
            reached_daemon(old_server.get("post_settings_with_v2", {}))
        ) if "post_settings_with_v2" in old_server else None,
        "desktop_server_proxies_put_to_daemon": (
            reached_daemon(old_server.get("put_settings_with_v2", {}))
        ) if "put_settings_with_v2" in old_server else None,
        "desktop_server_new_console_post_reaches_daemon": (
            reached_daemon(new_server.get("post_settings_with_v2", {}))
        ) if "post_settings_with_v2" in new_server else None,
        "desktop_server_get_proxy_works": (
            old_server.get("get_healthz", {}).get("status") == 200
        ) if "get_healthz" in old_server else None,
        "desktop_shell_only_accepts_shell_api_post": (
            old_server.get("post_shell_api_without_header", {}).get("error_code") == "SHELL_HEADER_REQUIRED"
        ) if "post_shell_api_without_header" in old_server else None,
    }
    result["assertions"] = assertions
    result["all_applicable_assertions_pass"] = all(
        value for value in assertions.values() if value is not None)

    if options.json:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["all_applicable_assertions_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
