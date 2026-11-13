"""build.py —— 把桌面壳打成单文件 exe：dist\\desktop\\AIDrivenNetDefense.exe。

为什么是脚本而不是手敲命令行：路径全用绝对路径算出来，`--add-data` 的分隔符
（Windows 是 `;`）和 `--onefile` 的临时解包目录（`_MEIPASS`）都不能靠记性维护。

打包约束（来自任务书）：
- 单文件、`--noconsole`（双击不弹黑框）、带图标；
- 产物固定落在 `dist\\desktop\\`；
- 不做安装程序、不签名、不联网 —— 那是安装器与发布流程的事。

用法：
    python apps/desktop/build.py                                  # 构建（版本取 version_info.txt 现值）
    python apps/desktop/build.py --clean                          # 先清空 dist\\desktop 再构建
    python apps/desktop/build.py --clean --version 0.0.1-rc.3     # 按发布版本盖版本资源

关于 `--version`：`assets\\version_info.txt` 是**模板**，里面三处硬编码的版本号只是默认值。
发布时必须传 `--version`，否则壳的「属性 → 详细信息」会停在模板那版的旧值上——安装包是
rc.3、壳却自报 rc.1，用户右键一看就是两个版本（RC3-ASSEMBLY §8-N2 就是这么来的）。
重写发生在**临时渲染文件**上，模板本身不动：手改模板里的常量下一版必然又漂。
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parents[1]
DIST_DIR = REPO_ROOT / "dist" / "desktop"
BUILD_DIR = DIST_DIR / "_build"
SPEC_DIR = DIST_DIR / "_spec"
EXE_NAME = "AIDrivenNetDefense"
ICON = APP_DIR / "assets" / "app.ico"
VERSION_FILE = APP_DIR / "assets" / "version_info.txt"
#: 每次构建按 `--version` 渲染出来的临时版本资源，落在产物目录里（`--clean` 会先删掉）。
VERSION_FILE_RENDERED_NAME = "version_info.build.txt"

#: 发布版本号（`0.0.1-rc.3` 这种）。只用于校验 `--version`，不做语义比较。
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$")
#: 模板里任何一处版本号字面量，用来在 FileDescription 里换掉内嵌的那个。
VERSION_TOKEN = r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?"

# 只保留真正用得到的后端。默认钩子会把 Qt / GTK / tkinter 一起拖进来，单文件体积
# 从十几 MB 涨到上百 MB，而 WebView2 是唯一在用的渲染后端。
EXCLUDES = [
    "PyQt5", "PyQt6", "PySide2", "PySide6", "PySide", "gi", "cefpython3",
    "tkinter", "_tkinter", "matplotlib", "numpy", "scipy", "pandas", "IPython",
    "pytest", "setuptools", "pip", "wheel",
]


def check() -> None:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        raise SystemExit("缺少 PyInstaller：请用装了 pyinstaller 的 Python 运行本脚本")
    if not (APP_DIR / "main.py").is_file():
        raise SystemExit(f"缺少入口：{APP_DIR / 'main.py'}")
    if not (APP_DIR / "webui" / "index.html").is_file():
        raise SystemExit(f"缺少界面：{APP_DIR / 'webui' / 'index.html'}")
    if not ICON.is_file():
        raise SystemExit(f"缺少图标：{ICON}")
    if not VERSION_FILE.is_file():
        raise SystemExit(f"缺少版本资源：{VERSION_FILE}")


def _version_field(template: str, field: str) -> str:
    """取出模板里 `StringStruct('<field>', '<value>')` 的 value。"""

    found = re.search(r"StringStruct\('" + re.escape(field) + r"',\s*'([^']*)'\)", template)
    if found is None:
        raise SystemExit(f"版本资源模板缺少字段 {field}：{VERSION_FILE}")
    return found.group(1)


def default_version(template: str | None = None) -> str:
    """模板里现写的版本号，也就是不传 `--version` 时的行为。"""

    text = template if template is not None else VERSION_FILE.read_text(encoding="utf-8")
    return _version_field(text, "FileVersion")


def render_version_file(template: str, version: str) -> str:
    """把三处版本号换成 `version`，其余字节原样保留。

    三处（`version_info.txt` 第 25/26/31 行那一批）：
      - `FileDescription` —— 里嵌了一个版本号，换成新值（其余文案不动）；
      - `FileVersion`     —— 资源管理器「文件版本」显示的就是这个字符串；
      - `ProductVersion`  —— 「产品版本」。

    `filevers` / `prodvers` 那两个四段整数**不动**：任务口径是「重写三处字符串」，
    而且 Windows 的数值比较用的是它们，擅自推导 `-rc.3 → (0,0,1,3)` 会凭空多出一个
    版本语义（rc 不是 revision 的等价物）。要改那段是另一件事，先说话。
    """

    if not VERSION_PATTERN.match(version):
        raise SystemExit(f"--version 不像版本号：{version!r}（期望形如 0.0.1-rc.3）")

    text = template

    # FileDescription：只替换内嵌的版本 token，文案（双语那一行）保持模板原样。
    description = _version_field(text, "FileDescription")
    if re.search(VERSION_TOKEN, description) is None:
        raise SystemExit(f"FileDescription 里没有版本号可替换：{description!r}")
    new_description = re.sub(VERSION_TOKEN, version, description, count=1)
    text = re.sub(
        r"(StringStruct\('FileDescription',\s*')[^']*('\))",
        lambda match: match.group(1) + new_description + match.group(2),
        text,
        count=1,
    )

    # FileVersion / ProductVersion：整值替换，且必须恰好命中一处。
    for field in ("FileVersion", "ProductVersion"):
        text, count = re.subn(
            r"(StringStruct\('" + field + r"',\s*')[^']*('\))",
            lambda match: match.group(1) + version + match.group(2),
            text,
        )
        if count != 1:
            raise SystemExit(f"版本资源模板里 {field} 出现 {count} 次（期望 1 次）：{VERSION_FILE}")

    return text


def write_version_file(version: str, destination: Path) -> Path:
    """渲染一份临时版本资源，供 PyInstaller `--version-file` 使用。"""

    template = VERSION_FILE.read_text(encoding="utf-8")
    rendered = render_version_file(template, version)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(rendered, encoding="utf-8")
    return destination



def clean(dist_dir: Path = DIST_DIR) -> None:
    for target in (dist_dir / EXE_NAME, dist_dir / "_build", dist_dir / "_spec",
                   dist_dir / f"{EXE_NAME}.exe", dist_dir / VERSION_FILE_RENDERED_NAME):
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists():
            target.unlink()


def build(dist_dir: Path = DIST_DIR, version: str | None = None) -> Path:
    dist_dir.mkdir(parents=True, exist_ok=True)
    # 工作目录跟着产物目录走：默认仍是 dist\desktop\_build、_spec（与手工 build.py 一致），
    # 换成 --dist 时也不会去动默认目录里别人的构建现场。
    work_dir = dist_dir / "_build"
    spec_dir = dist_dir / "_spec"

    # 版本资源先渲染成临时文件：模板（assets\version_info.txt）保持原样，
    # 每次构建按 --version 重新生成，改完就扔——模板里的常量不会再被当成"当前版本"引用。
    resolved_version = version if version is not None else default_version()
    rendered_version_file = write_version_file(
        resolved_version, dist_dir / VERSION_FILE_RENDERED_NAME
    )
    print(f"version: {resolved_version}  (version file: {rendered_version_file})")

    args = [
        str(APP_DIR / "main.py"),
        "--name", EXE_NAME,
        "--onefile",
        "--noconsole",
        "--noconfirm",
        "--clean",
        "--icon", str(ICON),
        # 注意：PyInstaller 自己的 `--version` 是「打印版本号然后退出」，会静默吞掉整个
        # 构建（退出码 0、没有 exe）。版本资源必须用 `--version-file`。
        "--version-file", str(rendered_version_file),
        "--distpath", str(dist_dir),
        "--workpath", str(work_dir),
        "--specpath", str(spec_dir),
        "--add-data", f"{APP_DIR / 'webui'}{';'}webui",
        "--add-data", f"{APP_DIR / 'assets'}{';'}assets",
        "--paths", str(APP_DIR),
        "--collect-submodules", "webview",
        "--hidden-import", "webview.platforms.edgechromium",
        "--hidden-import", "clr_loader",
        "--hidden-import", "pythonnet",
    ]
    for module in EXCLUDES:
        args += ["--exclude-module", module]

    started = time.time()
    completed = subprocess.run(
        [sys.executable, "-m", "PyInstaller", *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    exe = dist_dir / f"{EXE_NAME}.exe"
    log = dist_dir / "build.log"
    log.write_text(
        f"$ pyinstaller {' '.join(args)}\n\n=== stdout ===\n{completed.stdout}\n=== stderr ===\n{completed.stderr}\n",
        encoding="utf-8",
    )
    if completed.returncode != 0 or not exe.is_file():
        tail = "\n".join((completed.stderr or completed.stdout or "").splitlines()[-25:])
        raise SystemExit(f"打包失败（退出码 {completed.returncode}）。日志：{log}\n{tail}")

    # 中间产物（PyInstaller 的 work/spec 目录）留 20MB 在 dist 里没有意义：
    # 产物只有一个 exe，下次构建也是 --clean 重来。
    for scratch in (BUILD_DIR, SPEC_DIR):
        shutil.rmtree(scratch, ignore_errors=True)

    print(f"OK {exe}  {exe.stat().st_size / 1048576:.1f} MB  {time.time() - started:.0f}s")
    return exe


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 AIDriven NetDefense 桌面壳单文件 exe")
    parser.add_argument("--clean", action="store_true", help="构建前清空产物目录")
    parser.add_argument("--dist", default=str(DIST_DIR),
                        help="产物目录（默认 dist\\desktop；验收/回归可指到临时目录，避免踩到会话的产物）")
    parser.add_argument("--version", default=None,
                        help="写进版本资源的发布版本号（如 0.0.1-rc.3）；默认读 assets\\version_info.txt 现值")
    options = parser.parse_args(argv)

    dist_dir = Path(options.dist).resolve()
    check()
    version = options.version if options.version else default_version()
    if options.clean:
        clean(dist_dir)
    build(dist_dir, version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
