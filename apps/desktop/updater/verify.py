"""verify.py —— 下载产物的完整性校验（sha256 + size）。

校验顺序刻意是**先 size 后 hash**：size 不符说明包根本没下完（或清单被换过），
没必要再花几十秒算哈希；hash 不符才是「内容被动过」。

校验失败的处理只有一种：删除文件、抛异常、当前版本一个字节都不动。不存在
「先装上再检查」的路径。
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .errors import AssetRejected

#: 读盘块大小。太大占内存，太小 syscall 多；1 MiB 是折中。
CHUNK = 1024 * 1024


def sha256_file(path: Path) -> str:
    """流式计算文件 sha256，不把整包读进内存。"""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_file(path: Path, *, sha256: str, size: int, label: str = "更新包") -> None:
    """校验一个文件。不符即删文件并抛 ``AssetRejected``。"""
    if not path.is_file():
        raise AssetRejected(f"{label}不存在：{path}", detail={"path": str(path)})

    actual_size = path.stat().st_size
    if actual_size != size:
        discard(path)
        raise AssetRejected(
            f"{label}大小不符（预期 {size}，实际 {actual_size}），已删除",
            detail={"expected": size, "actual": actual_size, "path": str(path)},
        )

    actual_digest = sha256_file(path)
    if actual_digest != sha256:
        discard(path)
        raise AssetRejected(
            f"{label}的 sha256 与清单不符，已拒绝安装（清单 {sha256[:12]}…，实际 {actual_digest[:12]}…）",
            detail={
                "expected": sha256,
                "actual": actual_digest,
                "path": str(path),
            },
        )
    # 校验通过：把实际值带回去给调用方记录，避免它再算一遍。
    return None


def verify_asset(path: Path, asset) -> None:  # noqa: ANN001 - 避免与 manifest 循环导入
    verify_file(path, sha256=asset.sha256, size=asset.size, label=f"更新包 {asset.name}")


def discard(path: Path) -> None:
    """删除临时文件。删不掉也不掩盖原始错误。"""
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
