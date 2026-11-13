# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 规格：把桌面壳打成一个带界面、无控制台的 exe（作者 PT-dove）。

关键点：

1. **onefile + noconsole**：双击就是一个窗口，没有黑框。
2. **webui/assets 打进包内**（datas），运行期从 `sys._MEIPASS` 读；若安装目录下
   存在 `console\\index.html`，壳会改用它（界面可单独升级，不必重打包 exe）。
3. **pywebview 的 .NET 桥**必须显式收集：`webview/lib/*.dll` 是 WebView2 的
   托管封装，PyInstaller 的静态分析看不到它们；漏了就是「exe 能启动但白屏」。
4. **pythonnet（clr）**同理，`Python.Runtime.dll` 要随包。
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

APP_DIR = Path(SPECPATH)  # apps/desktop

datas = [
    (str(APP_DIR / "webui"), "webui"),
    (str(APP_DIR / "assets" / "app.ico"), "assets"),
    (str(APP_DIR / "assets" / "rules"), "assets/rules"),
]
datas += collect_data_files("webview")
datas += collect_dynamic_libs("webview")
datas += collect_data_files("clr_loader")

hiddenimports = [
    "webview.platforms.edgechromium",
    "webview.platforms.winforms",
    "clr",
    "pythonnet",
    "clr_loader",
    "aidn",
    "aidn.app",
    "aidn.daemon",
    "aidn.logsetup",
    "aidn.paths",
    "aidn.server",
    "aidn.settings",
    "aidn.tray",
]

a = Analysis(
    [str(APP_DIR / "main.py")],
    pathex=[str(APP_DIR)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 只排除确定用不到的 GUI 工具包。distutils/setuptools 不能排：PyInstaller 的
    # pre-safe-import 钩子会给它们建别名，排掉会直接让分析阶段抛 ValueError。
    excludes=["tkinter", "test"],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="AIDrivenNetDefense",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(APP_DIR / "assets" / "app.ico"),
    version=str(APP_DIR / "assets" / "version_info.txt"),
)
