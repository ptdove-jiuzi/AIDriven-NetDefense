"""archive.py —— 解压更新载荷，只解到独立版本目录。

压缩包是外部输入，按恶意输入处理：

* **路径越界**：条目名里的 ``..``、绝对路径、盘符一律拒绝（zip slip）；
* **符号链接**：``external_attr`` 标成 symlink 的条目一律拒绝——解压出来的链接可以
  指向任意位置，等于给整包开了一个任意写入口；
* **解压炸弹**：条目数与总解压字节都设上限；
* **半成品**：先解到 ``<dest>.partial``，全部成功后再改名，失败就删掉，
  绝不留一个「看起来像版本目录」的空壳。

任何一条不满足，整包拒绝——不做「跳过坏条目继续解」。
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from . import constants
from .errors import ArchiveUnsafe, StagingFailed

#: 载荷里桌面 exe 可能出现的位置，顺序即优先级（与 Setup.ps1 一致）。
DESKTOP_EXE_CANDIDATES = (
    "AIDrivenNetDefense.exe",
    "app/AIDrivenNetDefense.exe",
    "console/AIDrivenNetDefense.exe",
    "bin/AIDrivenNetDefense.exe",
    "app/bin/AIDrivenNetDefense.exe",
)

#: 目录条目在 unix 模式里的文件类型位。
_S_IFMT = 0o170000
_S_IFLNK = 0o120000


def _entries(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > constants.MAX_EXTRACT_ENTRIES:
        raise ArchiveUnsafe(f"压缩包条目过多（{len(infos)}），已拒绝")
    total = sum(max(0, info.file_size) for info in infos)
    if total > constants.MAX_EXTRACT_BYTES:
        raise ArchiveUnsafe(f"压缩包解压后超过上限（{total} 字节），已拒绝")
    return infos


def _safe_relative(name: str) -> Path:
    """把条目名转成安全的相对路径，不安全就抛。"""
    normalized = name.replace("\\", "/").strip()
    if not normalized:
        raise ArchiveUnsafe("压缩包里出现了空条目名")
    if normalized.startswith("/") or normalized.startswith("//"):
        raise ArchiveUnsafe(f"压缩包里出现了绝对路径，已拒绝：{name}")
    if ":" in normalized.split("/")[0]:
        # Windows 盘符（C:）或 NTFS 交换数据流（name:stream）。
        raise ArchiveUnsafe(f"压缩包里出现了盘符或 ADS，已拒绝：{name}")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise ArchiveUnsafe(f"压缩包里有越界路径（..），已拒绝：{name}")
    return Path(*parts)


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & _S_IFMT
    return mode == _S_IFLNK


def extract_zip(archive: Path, dest: Path) -> Path:
    """把 *archive* 解到 *dest*（必须不存在）。成功返回 *dest*。"""
    if dest.exists():
        raise StagingFailed(f"目标版本目录已存在，拒绝覆盖：{dest}")
    if not archive.is_file():
        raise StagingFailed(f"更新包不存在：{archive}")

    partial = dest.with_name(dest.name + ".partial")
    if partial.exists():
        discard_dir(partial)

    try:
        with zipfile.ZipFile(archive) as bundle:
            infos = _entries(bundle)
            partial.mkdir(parents=True, exist_ok=False)
            for info in infos:
                if info.is_dir():
                    continue
                if _is_symlink(info):
                    raise ArchiveUnsafe(f"压缩包里含符号链接，已拒绝：{info.filename}")
                relative = _safe_relative(info.filename)
                target = partial / relative
                # 二次确认：拼出来的路径必须仍在 partial 之内（防御 symbolic 父目录）。
                try:
                    target.resolve().relative_to(partial.resolve())
                except ValueError as error:
                    raise ArchiveUnsafe(f"条目解析后越界：{info.filename}") from error
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, open(target, "wb") as sink:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        sink.write(chunk)
        partial.replace(dest)
    except ArchiveUnsafe:
        discard_dir(partial)
        raise
    except (zipfile.BadZipFile, OSError, RuntimeError) as error:
        discard_dir(partial)
        raise StagingFailed(f"解压更新包失败：{error}") from error
    return dest


def find_desktop_exe(root: Path) -> tuple[str, Path] | tuple[None, None]:
    """在解压结果里找桌面 exe，返回 ``(相对路径, 绝对路径)``。"""
    for relative in DESKTOP_EXE_CANDIDATES:
        candidate = root / relative
        if candidate.is_file():
            return relative, candidate
    return None, None


def discard_dir(path: Path) -> None:
    import shutil

    try:
        shutil.rmtree(path)
    except OSError:
        pass
