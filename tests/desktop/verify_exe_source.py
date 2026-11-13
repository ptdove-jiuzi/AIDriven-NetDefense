"""verify_exe_source.py —— 只回答一个问题：这个 exe 是不是**当前源码**构建出来的（作者 PT-dove）。

为什么不能直接比哈希：PyInstaller 的 onefile 产物**不是逐字节可复现**的。同一份源码、
同一个解释器，连跑两次 `build.py`，产物 sha256 也不同。实测差异只落在一个条目上：
`base_library.zip`（标准库 .pyc 的 zip 里带构建时的文件时间戳），它一变，
压缩后的长度就变，后面的数据整体位移，于是整个文件的哈希全变。

所以这里换一个能失败、也不受时间戳影响的判据：

1. **内嵌字节码 == 当前源码的 compile() 结果**：把 exe 里的 `PYZ.pyz` 拆出来，
   逐个模块递归比较 code object 的每个字段（co_code / co_consts / co_linetable /
   co_exceptiontable …）。不用 `marshal.dumps` 比字节——marshal 会记录字符串的
   intern 标记，同一份源码在不同进程里 dump 出来可能不同，会假报差异。
2. **内嵌数据文件 == 源码目录里的文件**：webui 三个文件 + 规则包。
3. **版本资源**：Company / ProductName / FileDescription（双语一行）/ FileVersion。

用法：
    python tests/desktop/verify_exe_source.py
    python tests/desktop/verify_exe_source.py --exe <path>

退出码：0 = 全部一致；1 = 有不一致（逐条打印）。
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parents[1] / "apps" / "desktop"
REPO_ROOT = HERE.parents[1]
DEFAULT_EXE = REPO_ROOT / "dist" / "desktop" / "AIDrivenNetDefense.exe"

#: 模块名 → 源码相对路径。改壳的时候这个表要跟着改，否则新模块不会被校验。
MODULES = [
    ("main", "main.py"),
    ("aidn", "aidn/__init__.py"),
    ("aidn.paths", "aidn/paths.py"),
    ("aidn.settings", "aidn/settings.py"),
    ("aidn.daemon", "aidn/daemon.py"),
    ("aidn.server", "aidn/server.py"),
    ("aidn.tray", "aidn/tray.py"),
    ("aidn.app", "aidn/app.py"),
    ("aidn.logsetup", "aidn/logsetup.py"),
]

DATA_FILES = [
    (r"webui\index.html", "webui/index.html"),
    (r"webui\app.js", "webui/app.js"),
    (r"webui\styles.css", "webui/styles.css"),
    (r"assets\rules\builtin-rules.json", "assets/rules/builtin-rules.json"),
]

CODE_ATTRS = (
    "co_argcount", "co_posonlyargcount", "co_kwonlyargcount", "co_nlocals", "co_stacksize",
    "co_flags", "co_code", "co_names", "co_varnames", "co_freevars", "co_cellvars",
    "co_filename", "co_name", "co_qualname", "co_firstlineno", "co_linetable", "co_exceptiontable",
)


def code_differences(embedded: types.CodeType, wanted: types.CodeType,
                     path: str = "module") -> list[str]:
    """递归比较两个 code object，返回差异描述（空列表 = 完全一致）。"""
    problems: list[str] = []
    for attribute in CODE_ATTRS:
        left, right = getattr(embedded, attribute), getattr(wanted, attribute)
        if left != right:
            problems.append(f"{path}.{attribute}: {str(left)[:60]!r} != {str(right)[:60]!r}")
    if len(embedded.co_consts) != len(wanted.co_consts):
        problems.append(f"{path}.co_consts 长度 {len(embedded.co_consts)} != {len(wanted.co_consts)}")
    for index, (left, right) in enumerate(zip(embedded.co_consts, wanted.co_consts)):
        if isinstance(left, types.CodeType) and isinstance(right, types.CodeType):
            problems.extend(code_differences(left, right, f"{path}.const[{index}]"))
        elif isinstance(left, types.CodeType) != isinstance(right, types.CodeType):
            problems.append(f"{path}.const[{index}]：一边是 code object，一边不是")
        elif left != right:
            problems.append(f"{path}.const[{index}]: {str(left)[:60]!r} != {str(right)[:60]!r}")
    return problems


def load_archives(exe: Path):
    from PyInstaller.archive.readers import CArchiveReader, ZlibArchiveReader

    archive = CArchiveReader(str(exe))
    scratch = Path(tempfile.mkdtemp(prefix="aidn-verify-pyz-"))
    pyz_path = scratch / "PYZ.pyz"
    pyz_path.write_bytes(archive.extract("PYZ.pyz"))
    return archive, ZlibArchiveReader(str(pyz_path))


def read_version_info(exe: Path) -> dict[str, str]:
    """读 PE 的版本资源（不依赖 pywin32）。"""
    from PyInstaller.utils.win32.versioninfo import read_version_info_from_executable

    info = read_version_info_from_executable(str(exe))
    result: dict[str, str] = {}
    for kid in info.kids:
        if type(kid).__name__ != "StringFileInfo":
            continue
        for table in kid.kids:
            for entry in table.kids:
                # StringStruct 的字段就叫 name / val（不是 key / value）
                result[str(entry.name)] = str(entry.val)
    fixed = getattr(info, "ffi", None)
    if fixed is not None and getattr(fixed, "filevers", None):
        result["_filevers"] = ".".join(str(part) for part in fixed.filevers)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验 exe 是否由当前源码构建")
    parser.add_argument("--exe", default=str(DEFAULT_EXE))
    options = parser.parse_args(argv)

    exe = Path(options.exe).resolve()
    if not exe.is_file():
        raise SystemExit(f"缺少 exe：{exe}")

    rows: list[tuple[bool, str]] = []

    def record(ok: bool, text: str) -> None:
        rows.append((ok, text))
        print(("  [SAME] " if ok else "  [DIFF] ") + text)

    print(f"被测 exe：{exe}")
    print(f"sha256   ：{hashlib.sha256(exe.read_bytes()).hexdigest()}")
    print(f"字节     ：{exe.stat().st_size}")
    print(f"修改时间 ：{exe.stat().st_mtime_ns}")

    print("\n[1] 版本资源")
    try:
        version = read_version_info(exe)
    except Exception as error:  # noqa: BLE001
        record(False, f"版本资源读取失败：{error}")
        version = {}
    expected = {
        "CompanyName": "PT-dove",
        "ProductName": "AIDriven NetDefense",
        "FileVersion": "0.0.1-rc.1",
    }
    for key, want in expected.items():
        got = version.get(key, "")
        record(got == want, f"{key} = {got!r}（期望 {want!r}）")
    description = version.get("FileDescription", "")
    bilingual = ("桌面壳" in description or "网域智防" in description) and "Desktop" in description
    record(bool(description) and bilingual and "\n" not in description,
           f"FileDescription = {description!r}（要求双语单行）")

    print("\n[2] 内嵌字节码 vs 当前源码")
    archive, pyz = load_archives(exe)
    for module, relative in MODULES:
        source = APP_DIR / relative
        try:
            if module == "main":
                import marshal

                embedded = marshal.loads(archive.extract("main"))
            else:
                item = pyz.extract(module)
                embedded = item[0] if isinstance(item, tuple) else item
        except KeyError as error:
            record(False, f"{module}: 归档里没有（{error}）")
            continue
        # dont_inherit=True 是必须的：本文件自己就 `from __future__ import annotations`，
        # 不隔离的话 compile() 会把该 flag 塞进被测源码的 code object（0x1000000），
        # 于是每个没写 future import 的模块都会被误判成「不一致」。
        wanted = compile(source.read_bytes(), embedded.co_filename, "exec",
                         dont_inherit=True, optimize=0)
        problems = code_differences(embedded, wanted)
        if problems:
            record(False, f"{module} <- {relative}")
            for problem in problems[:6]:
                print(f"           {problem}")
        else:
            record(True, f"{module} <- {relative}")

    print("\n[3] 内嵌数据文件 vs 源码目录")
    for entry, relative in DATA_FILES:
        source = APP_DIR / relative
        try:
            embedded_bytes = archive.extract(entry)
        except KeyError:
            record(False, f"{entry}: 归档里没有")
            continue
        record(embedded_bytes == source.read_bytes(), entry)

    failed = [text for ok, text in rows if not ok]
    print(f"\n总计 {len(rows)} 条：一致 {len(rows) - len(failed)} / 不一致 {len(failed)}")
    for text in failed:
        print(f"  - {text}")
    print("结论：" + ("一致（该 exe 由当前源码构建）" if not failed else "不一致（不是当前源码的产物）"))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
