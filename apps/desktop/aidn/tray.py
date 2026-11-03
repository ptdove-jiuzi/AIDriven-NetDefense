"""tray.py —— 通知区图标（Shell_NotifyIcon），不依赖 pystray / Pillow。

为什么手写 Win32：本机 Python 环境里 `pystray` 与 `PIL` 都没装，而托盘是「关窗口后
程序仍在」的唯一可见证据。Shell_NotifyIcon 只需要 ctypes。

线程模型：托盘图标必须由一个拥有窗口过程的线程创建，菜单也只能在该线程弹出，
所以整个托盘跑在自己的线程里；窗口消息循环是该线程唯一的阻塞点，退出靠 WM_QUIT。

行为约定（与需求一致）：
- 右键菜单：打开界面 / 在浏览器中打开 / 设置 / 退出；
- 左键单击或双击：打开界面；
- 「退出」是**唯一**会结束 daemon 子进程的入口。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import logging
import threading
from pathlib import Path

log = logging.getLogger("aidn.tray")

user32 = ctypes.WinDLL("user32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_COMMAND = 0x0111
WM_NULL = 0x0000
WM_LBUTTONUP = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONUP = 0x0205
WM_CONTEXTMENU = 0x007B
WM_QUIT = 0x0012
WM_APP = 0x8000
WM_TRAY = WM_APP + 1

NIM_ADD = 0x00000000
NIM_MODIFY = 0x00000001
NIM_DELETE = 0x00000002

NIF_MESSAGE = 0x00000001
NIF_ICON = 0x00000002
NIF_TIP = 0x00000004

IMAGE_ICON = 1
LR_LOADFROMFILE = 0x00000010
IDI_APPLICATION = 32512

MF_STRING = 0x00000000
MF_SEPARATOR = 0x00000800
TPM_LEFTALIGN = 0x0000
TPM_RIGHTBUTTON = 0x0002
TPM_RETURNCMD = 0x0100
TPM_NONOTIFY = 0x0080

CS_HREDRAW = 0x0002
CS_VREDRAW = 0x0001

ID_OPEN = 1001
ID_BROWSER = 1002
ID_SETTINGS = 1003
ID_QUIT = 1004

WNDPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t)


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class NOTIFYICONDATAW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uID", wintypes.UINT),
        ("uFlags", wintypes.UINT),
        ("uCallbackMessage", wintypes.UINT),
        ("hIcon", wintypes.HICON),
        ("szTip", wintypes.WCHAR * 128),
        ("dwState", wintypes.DWORD),
        ("dwStateMask", wintypes.DWORD),
        ("szInfo", wintypes.WCHAR * 256),
        ("uVersion", wintypes.UINT),
        ("szInfoTitle", wintypes.WCHAR * 64),
        ("dwInfoFlags", wintypes.DWORD),
        ("guidItem", GUID),
        ("hBalloonIcon", wintypes.HICON),
    ]


class WNDCLASSW(ctypes.Structure):
    _fields_ = [
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", wintypes.HINSTANCE),
        ("hIcon", wintypes.HICON),
        ("hCursor", wintypes.HANDLE),
        ("hbrBackground", wintypes.HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


user32.DefWindowProcW.restype = ctypes.c_ssize_t
user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
user32.RegisterClassW.restype = wintypes.ATOM
user32.CreateWindowExW.restype = wintypes.HWND
user32.CreateWindowExW.argtypes = [
    wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
]
user32.CreatePopupMenu.restype = wintypes.HMENU
user32.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
user32.TrackPopupMenu.restype = ctypes.c_int
user32.TrackPopupMenu.argtypes = [
    wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int,
    ctypes.c_int, wintypes.HWND, wintypes.LPVOID,
]
user32.LoadImageW.restype = wintypes.HANDLE
user32.LoadImageW.argtypes = [
    wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
    ctypes.c_int, ctypes.c_int, wintypes.UINT,
]
# LoadIconW 的第二个参数是资源名，整数 ID 走 MAKEINTRESOURCE，必须按指针传，
# 声明成 LPCWSTR 会让 ctypes 拒绝整数、或把指针截断成 32 位。
user32.LoadIconW.restype = wintypes.HANDLE
user32.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
user32.DestroyMenu.argtypes = [wintypes.HMENU]
user32.DestroyWindow.argtypes = [wintypes.HWND]
user32.PostQuitMessage.argtypes = [ctypes.c_int]
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, ctypes.c_size_t, ctypes.c_ssize_t]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
user32.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
shell32.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NOTIFYICONDATAW)]


class Tray:
    """通知区图标 + 右键菜单。所有方法都可在任意线程调用。"""

    def __init__(self, icon_path: Path | None, tooltip: str, actions: dict) -> None:
        self._icon_path = icon_path
        self._tooltip = tooltip[:127]
        self._actions = actions
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._hwnd: int = 0
        self._icon: int = 0
        self.installed = False
        self.error: str | None = None
        self._nid = NOTIFYICONDATAW()
        # 窗口过程必须是模块级存活的函数指针，否则线程一返回就被回收。
        self._wndproc = WNDPROC(self._on_message)

    # ------------------------------------------------------------------ public
    def start(self, timeout: float = 6.0) -> bool:
        self._thread = threading.Thread(target=self._run, name="aidn-tray", daemon=True)
        self._thread.start()
        return self._ready.wait(timeout) and self.installed

    def stop(self) -> None:
        if self._hwnd:
            user32.PostMessageW(wintypes.HWND(self._hwnd), WM_CLOSE, 0, 0)
        if self._thread is not None:
            self._thread.join(timeout=3.0)

    def set_tooltip(self, text: str) -> None:
        self._tooltip = text[:127]
        if not self.installed:
            return
        self._nid.szTip = self._tooltip
        self._nid.uFlags = NIF_TIP | NIF_ICON | NIF_MESSAGE
        shell32.Shell_NotifyIconW(NIM_MODIFY, ctypes.byref(self._nid))

    # ----------------------------------------------------------------- private
    def _run(self) -> None:
        try:
            self._create_window()
            self._add_icon()
            self._ready.set()
            self._pump()
        except Exception as error:  # noqa: BLE001 - 托盘失败不能拖死整个程序
            self.error = str(error)
            log.exception("托盘初始化失败：%s", error)
            self._ready.set()
        finally:
            self._remove_icon()

    def _create_window(self) -> None:
        hinstance = kernel32.GetModuleHandleW(None)
        class_name = "AIDrivenNetDefenseTrayWnd"
        wc = WNDCLASSW()
        wc.style = CS_HREDRAW | CS_VREDRAW
        wc.lpfnWndProc = self._wndproc
        wc.hInstance = hinstance
        wc.lpszClassName = class_name
        atom = user32.RegisterClassW(ctypes.byref(wc))
        if not atom:
            error = ctypes.get_last_error()
            if error not in (0, 1410):  # 1410 = 类已注册
                raise OSError(f"RegisterClassW 失败：{error}")
        hwnd = user32.CreateWindowExW(
            0, class_name, "AIDriven NetDefense", 0, 0, 0, 0, 0,
            None, None, hinstance, None,
        )
        if not hwnd:
            raise OSError(f"CreateWindowExW 失败：{ctypes.get_last_error()}")
        self._hwnd = int(hwnd)
        log.debug("托盘窗口已创建 hwnd=%s", self._hwnd)

    def _load_icon(self) -> int:
        if self._icon_path is not None and self._icon_path.is_file():
            handle = user32.LoadImageW(None, str(self._icon_path), IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
            if handle:
                return int(handle)
            log.warning("图标文件加载失败：%s", self._icon_path)
        return int(user32.LoadIconW(None, IDI_APPLICATION))

    def _add_icon(self) -> None:
        self._icon = self._load_icon()
        nid = NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(NOTIFYICONDATAW)
        nid.hWnd = wintypes.HWND(self._hwnd)
        nid.uID = 1
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
        nid.uCallbackMessage = WM_TRAY
        nid.hIcon = wintypes.HICON(self._icon)
        nid.szTip = self._tooltip
        self._nid = nid
        if not shell32.Shell_NotifyIconW(NIM_ADD, ctypes.byref(nid)):
            raise OSError(f"Shell_NotifyIconW(NIM_ADD) 失败：{ctypes.get_last_error()}")
        self.installed = True
        log.info("托盘图标已注册")

    def _remove_icon(self) -> None:
        if not self.installed:
            return
        shell32.Shell_NotifyIconW(NIM_DELETE, ctypes.byref(self._nid))
        self.installed = False
        log.info("托盘图标已移除")

    def _pump(self) -> None:
        msg = wintypes.MSG()
        while True:
            result = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if result == 0 or result == -1:
                break
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))

    def _on_message(self, hwnd, message, wparam, lparam):  # noqa: ANN001
        try:
            if message == WM_TRAY:
                if lparam in (WM_RBUTTONUP, WM_CONTEXTMENU):
                    self._show_menu()
                elif lparam in (WM_LBUTTONUP, WM_LBUTTONDBLCLK):
                    self._invoke("show")
                return 0
            if message == WM_COMMAND:
                self._on_command(int(wparam) & 0xFFFF)
                return 0
            if message == WM_CLOSE:
                user32.DestroyWindow(wintypes.HWND(hwnd))
                return 0
            if message == WM_DESTROY:
                user32.PostQuitMessage(0)
                return 0
        except Exception:  # noqa: BLE001
            log.exception("托盘消息处理异常 message=0x%04x", message)
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    def _on_command(self, command: int) -> None:
        mapping = {
            ID_OPEN: "show",
            ID_BROWSER: "browser",
            ID_SETTINGS: "settings",
            ID_QUIT: "quit",
        }
        action = mapping.get(command)
        if action:
            self._invoke(action)

    def _invoke(self, action: str) -> None:
        handler = self._actions.get(action)
        if handler is None:
            log.warning("托盘动作没有绑定处理函数：%s", action)
            return
        try:
            handler()
        except Exception:  # noqa: BLE001
            log.exception("托盘动作执行失败：%s", action)

    def _show_menu(self) -> None:
        menu = user32.CreatePopupMenu()
        if not menu:
            raise OSError("CreatePopupMenu 失败")
        try:
            user32.AppendMenuW(menu, MF_STRING, ID_OPEN, "打开界面")
            user32.AppendMenuW(menu, MF_STRING, ID_BROWSER, "在浏览器中打开")
            user32.AppendMenuW(menu, MF_STRING, ID_SETTINGS, "设置")
            user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
            user32.AppendMenuW(menu, MF_STRING, ID_QUIT, "退出")
            point = POINT()
            user32.GetCursorPos(ctypes.byref(point))
            # 不先置前台，菜单会在点击别处时不消失（经典 Win32 托盘陷阱）。
            user32.SetForegroundWindow(wintypes.HWND(self._hwnd))
            command = user32.TrackPopupMenu(
                menu,
                TPM_LEFTALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                point.x, point.y, 0, wintypes.HWND(self._hwnd), None,
            )
            user32.PostMessageW(wintypes.HWND(self._hwnd), WM_NULL, 0, 0)
            if command:
                self._on_command(int(command))
        finally:
            user32.DestroyMenu(menu)
