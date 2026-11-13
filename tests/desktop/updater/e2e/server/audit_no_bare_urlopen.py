#!/usr/bin/env python3
"""audit_no_bare_urlopen.py —— 全仓 ``tests/desktop/updater/e2e/**`` 的「裸 urlopen」静态审计。

为什么需要它（round-1 的真实事故）
----------------------------------
本机 ``ProxyEnable=1`` / ``ProxyServer=127.0.0.1:7897``：裸
``urllib.request.urlopen`` 会把外网请求**无感转发**给本地代理，socket 层只看到
loopback，``EgressGuard`` 无从拦截（round-1 在 16:17 就这样发出过一次真实外网 GET，
见 ``evidence/updater/final/INCIDENT-2026-11-05T1617.md``）。

因此本战役的硬规则是：**e2e 目录内不得存在裸 urlopen 调用**——所有 HTTP 必须走
``build_opener(ProxyHandler({}))`` 的 opener，并且（更好）在 opener 之前做 URL 主机
校验。本脚本是这条规则的**可执行判据**：AST 扫描每个 ``*.py``，报出所有
``urlopen(...)`` / ``urllib.request.urlopen(...)`` 调用与 ``from urllib.request
import urlopen``。

判定
----
* ``violations == 0`` → exit 0；
* 否则逐条打印 ``AUDIT <file>:<line> ...`` 并 exit 1（**给写域所有者修，不代改**）。

用法::

    $env:PYTHONIOENCODING='utf-8'
    D:\\Python311\\python.exe tests\\desktop\\updater\\e2e\\server\\audit_no_bare_urlopen.py \
        [--root <e2e dir>] [--json <out.json>]
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent                      # .../e2e


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _dotted(node: ast.AST) -> str:
    """把 ``urllib.request.urlopen`` 这种 Attribute 链还原成点号字符串。"""
    parts: list[str] = []
    cursor: ast.AST | None = node
    while isinstance(cursor, ast.Attribute):
        parts.append(cursor.attr)
        cursor = cursor.value
    if isinstance(cursor, ast.Name):
        parts.append(cursor.id)
    return ".".join(reversed(parts))


def audit_file(path: Path) -> dict:
    """扫一个文件，返回 {file, urlopen_calls, urlopen_imports, proxyless_opener}。"""
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, UnicodeDecodeError, SyntaxError) as error:      # pragma: no cover - 坏文件
        return {
            "file": str(path),
            "parse_error": f"{type(error).__name__}: {error}",
            "urlopen_calls": [],
            "urlopen_imports": [],
            "proxyless_opener": False,
        }

    calls: list[dict[str, Any]] = []
    imports: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _dotted(node.func)
            if name == "urlopen" or name.endswith(".urlopen"):
                calls.append({"line": node.lineno, "call": f"{name}(...)"})
        elif isinstance(node, ast.ImportFrom):
            if node.module in ("urllib.request", "urllib.request.urlopen"):
                for alias in node.names:
                    if alias.name == "urlopen":
                        imports.append(
                            {
                                "line": node.lineno,
                                "statement": f"from {node.module} import urlopen",
                            }
                        )
        elif isinstance(node, ast.Import):
            pass                                     # ``import urllib.request`` 本身不违规

    has_proxyless = "ProxyHandler({" in source or "ProxyHandler()" in source
    url_guard = "EGRESS-URL-BLOCKED" in source
    return {
        "file": str(path),
        "urlopen_calls": calls,
        "urlopen_imports": imports,
        "proxyless_opener": has_proxyless,
        "url_guard": url_guard,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="e2e 目录裸 urlopen 静态审计（零外联）")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="审计根目录（默认 e2e/）")
    parser.add_argument("--json", type=Path, default=None, help="结构化结果落盘路径（UTF-8 JSON）")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    files = sorted(path for path in root.rglob("*.py") if "__pycache__" not in path.parts)
    rows = [audit_file(path) for path in files]

    violations: list[str] = []
    for row in rows:
        if row.get("parse_error"):
            violations.append(f"{row['file']}: {row['parse_error']}")
            continue
        for item in row["urlopen_calls"]:
            violations.append(f"{row['file']}:{item['line']}: 裸调用 {item['call']}")
        for item in row["urlopen_imports"]:
            violations.append(f"{row['file']}:{item['line']}: {item['statement']}")

    print(f"# audit_no_bare_urlopen.py  {_utc_now_iso()}")
    print(f"# root={root}  python={sys.version.split()[0]}  py_files={len(files)}")
    for row in rows:
        rel = Path(row["file"]).relative_to(root) if row["file"].startswith(str(root)) else row["file"]
        if row.get("parse_error"):
            print(f"AUDIT-ERROR {rel} {row['parse_error']}")
            continue
        n_calls = len(row["urlopen_calls"])
        verdict = "PASS" if (n_calls == 0 and not row["urlopen_imports"]) else "FAIL"
        print(
            f"AUDIT {verdict:<4} {str(rel):<34} urlopen_calls={n_calls} "
            f"imports={len(row['urlopen_imports'])} "
            f"proxyless_opener={row['proxyless_opener']} url_guard={row['url_guard']}"
        )
    for violation in violations:
        print(f"AUDIT-VIOLATION {violation}")
    print(
        f"AUDIT-SUMMARY files={len(files)} violations={len(violations)} "
        f"exit={0 if not violations else 1}"
    )

    if args.json is not None:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(
                {
                    "ran_at": _utc_now_iso(),
                    "root": str(root),
                    "python": sys.version.split()[0],
                    "files": rows,
                    "violations": violations,
                    "ok": not violations,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    return 0 if not violations else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
    except Exception:                                                  # noqa: BLE001
        pass
    raise SystemExit(main())
