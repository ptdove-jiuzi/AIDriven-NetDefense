"""win_probe.py —— 桌面壳验收用的 Win32 探针（作者 PT-dove）。

只做「读窗口 / 发一条消息」，不改被测程序：

    python tests/desktop/win_probe.py list
    python tests/desktop/win_probe.py find --class AIDrivenNetDefenseTrayWnd
    python tests/desktop/win_probe.py close --pid 1234          # 发 WM_CLOSE（等价点窗口关闭按钮）
    python tests/desktop/win_probe.py tray-command --id 1004    # 发 WM_COMMAND（等价点托盘菜单项）

之所以不直接调壳自己的 HTTP 接口：验收要证明的是「用户点窗口 / 点托盘」这条真实路径，
HTTP 接口走的是另一条分支，测不出 pywebview 的 closing 事件与托盘消息循环是否真的接上了。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json

user32 = ctypes.WinDLL("user32", use_last_error=True)

WM_CLOSE = 0x0010
WM_COMMAND = 0x0111

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _iter_windows() -> list[dict]:
    found: list[dict] = []

    def callback(hwnd, _lparam):  # noqa: ANN001
        length = user32.GetWindowTextLengthW(hwnd)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        klass = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, klass, 256)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        found.append(
            {
                "hwnd": int(hwnd),
                "pid": int(pid.value),
                "class": klass.value,
                "title": buffer.value,
                "visible": bool(user32.IsWindowVisible(hwnd)),
            }
        )
        return True

    user32.EnumWindows(WNDENUMPROC(callback), 0)
    return found


def cmd_list(args) -> int:
    rows = _iter_windows()
    if args.pid:
        rows = [row for row in rows if row["pid"] == args.pid]
    if args.visible:
        rows = [row for row in rows if row["visible"]]
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


def _pick(args) -> list[dict]:
    rows = _iter_windows()
    if args.pid:
        rows = [row for row in rows if row["pid"] == args.pid]
    if args.class_name:
        rows = [row for row in rows if row["class"] == args.class_name]
    if args.title_contains:
        rows = [row for row in rows if args.title_contains in row["title"]]
    return rows


def cmd_find(args) -> int:
    rows = _pick(args)
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0 if rows else 1


def cmd_close(args) -> int:
    rows = _pick(args)
    if not rows:
        print(json.dumps({"ok": False, "error": "没有匹配的窗口"}))
        return 1
    posted = []
    for row in rows:
        ok = bool(user32.PostMessageW(wintypes.HWND(row["hwnd"]), WM_CLOSE, 0, 0))
        posted.append({"hwnd": row["hwnd"], "title": row["title"], "posted": ok})
    print(json.dumps({"ok": True, "posted": posted}, ensure_ascii=False, indent=2))
    return 0


def cmd_tray_command(args) -> int:
    rows = _pick(args)
    if not rows:
        print(json.dumps({"ok": False, "error": "没有匹配的托盘窗口"}))
        return 1
    posted = []
    for row in rows:
        ok = bool(
            user32.PostMessageW(wintypes.HWND(row["hwnd"]), WM_COMMAND, int(args.id), 0)
        )
        posted.append({"hwnd": row["hwnd"], "class": row["class"], "posted": ok, "command": args.id})
    print(json.dumps({"ok": True, "posted": posted}, ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="桌面壳 Win32 验收探针")
    parser.add_argument("command", choices=("list", "find", "close", "tray-command"))
    parser.add_argument("--pid", type=int, default=None)
    parser.add_argument("--class", dest="class_name", default=None)
    parser.add_argument("--title-contains", dest="title_contains", default=None)
    parser.add_argument("--visible", action="store_true")
    parser.add_argument("--id", type=int, default=1004, help="托盘菜单命令 ID（1004=退出）")
    args = parser.parse_args(argv)

    handlers = {
        "list": cmd_list,
        "find": cmd_find,
        "close": cmd_close,
        "tray-command": cmd_tray_command,
    }
    return handlers[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
