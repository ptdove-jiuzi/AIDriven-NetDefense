"""logrotate.py —— 日志保留策略（大小 + 天数双阈值）。

与 daemon 侧的 `apps/daemon/src/log-rotate.js` **同一套策略常量**：

- `MAX_FILE_BYTES` = 8 MiB：单个日志文件的软上限；超过就轮转（不是删除）。
- `MAX_TOTAL_BYTES` = 64 MiB：日志目录总量的硬上限，超了按**最旧优先**删除。
- `KEEP_DAYS` = 7：早于 7 天的日志直接删。
- `PROTECT_MS` = 1 小时：**1 小时内改过的文件是活跃文件**，绝不删除、不重命名、不截断。

为什么桌面壳需要自己的实现：壳的日志是 `desktop-YYYYMMDD.log`（按天分文件）与
`daemon.stderr.log`（子进程继承的写句柄），两者都**在被写入的同时**需要被约束。
Node 侧那套「重命名成 .1」在这里不安全：

- `logging.FileHandler` 与 `faulthandler` 持有以 O_APPEND 打开的文件句柄，
  重命名后它们的写入会落到**改名后的旧文件**上，当天的日志从此静默丢失；
- Windows 上重命名一个正被打开的文件还会直接失败（EPERM）。

所以桌面侧轮转活跃文件用 `rotate_active()`：**先复制到 `<name>.1`，再原地
`truncate(0)`**。`truncate` 不改变文件身份，O_APPEND 的写入回到文件开头继续追加，
句柄依旧有效，崩溃栈仍然写当天那个文件，也不会出现「半截旧内容 + 新内容」的空洞。

本模块同样遵守 daemon 侧的两条硬规则：

1. **绝不抛异常给调用方**：所有失败记进返回值的 `skipped` / `reason`，
   日志维护动作不能把壳或 daemon 带崩。
2. **不跟随符号链接**：链接只报告不处理；动作前用 `realpath` 证明路径确实落在
   给定目录内（Windows junction 指向用户目录时，删「穿」过去就是数据事故）。
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Iterable

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
KEEP_DAYS = 7
PROTECT_MS = 60 * 60 * 1000

#: 与 Node 侧 `DEFAULT_LOG_POLICY` 等价的字典形式（键名用 Python 风格）。
DEFAULT_POLICY = {
    "max_file_bytes": MAX_FILE_BYTES,
    "max_total_bytes": MAX_TOTAL_BYTES,
    "max_age_days": KEEP_DAYS,
    "protect_ms": PROTECT_MS,
}

_DAY_SECONDS = 24 * 60 * 60
_COPY_CHUNK = 1024 * 1024
_MAX_COPY_PASSES = 3
_MAX_ROTATE_SUFFIX = 100
_LOG_NAME = re.compile(r"\.log(?:\.|$)", re.IGNORECASE)
#: 允许调用方传 Node 风格的驼峰键，两端策略配置可以互相照抄。
_POLICY_ALIASES = {
    "maxFileBytes": "max_file_bytes",
    "maxTotalBytes": "max_total_bytes",
    "maxAgeDays": "max_age_days",
    "protectMs": "protect_ms",
}


def is_log_name(name: str) -> bool:
    """`*.log`、`*.log.1`、`*.stderr.log` 都算日志文件。"""
    return bool(_LOG_NAME.search(name))


def _positive(value: Any, fallback: float) -> float:
    """0、负数、NaN、inf 一律回落到文档默认值。

    调用方误写 `max_total_bytes=0` 时不能变成"删光所有日志"。
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if value != value or value in (float("inf"), float("-inf")) or value <= 0:
        return fallback
    return float(value)


def _normalize_policy(policy: dict | None) -> dict[str, float]:
    source = dict(policy) if isinstance(policy, dict) else {}
    for alias, real in _POLICY_ALIASES.items():
        if alias in source and real not in source:
            source[real] = source[alias]
    return {
        "max_file_bytes": _positive(source.get("max_file_bytes"), DEFAULT_POLICY["max_file_bytes"]),
        "max_total_bytes": _positive(source.get("max_total_bytes"), DEFAULT_POLICY["max_total_bytes"]),
        "max_age_days": _positive(source.get("max_age_days"), DEFAULT_POLICY["max_age_days"]),
        "protect_ms": _positive(source.get("protect_ms"), DEFAULT_POLICY["protect_ms"]),
    }


def _now_seconds(now: Any) -> float:
    """接受 None / epoch 秒 / `datetime`。"""
    if now is None:
        return time.time()
    if hasattr(now, "timestamp"):
        try:
            return float(now.timestamp())
        except (TypeError, ValueError, OSError):
            return time.time()
    try:
        return float(now)
    except (TypeError, ValueError):
        return time.time()


def _is_inside(root: str, candidate: str) -> bool:
    """`candidate` 是否严格位于 `root` 内（Windows 下大小写不敏感）。"""
    try:
        common = os.path.commonpath([root, candidate])
    except ValueError:
        return False
    return os.path.normcase(common) == os.path.normcase(root) and os.path.normcase(candidate) != os.path.normcase(root)


def _normalize_roots(log_dirs: Any, skipped: list[dict]) -> list[str]:
    if log_dirs is None:
        return []
    if isinstance(log_dirs, (str, os.PathLike)):
        candidates: Iterable[Any] = [log_dirs]
    else:
        try:
            candidates = list(log_dirs)
        except TypeError:
            skipped.append({"path": str(log_dirs), "reason": "invalid-directory"})
            return []
    roots: list[str] = []
    for entry in candidates:
        if not isinstance(entry, (str, os.PathLike)) or str(entry) == "":
            skipped.append({"path": str(entry), "reason": "invalid-directory"})
            continue
        try:
            root = os.path.realpath(os.fspath(entry))
            if not os.path.isdir(root):
                skipped.append({"path": str(entry), "reason": "not-a-directory"})
                continue
            roots.append(root)
        except OSError as error:
            skipped.append({"path": str(entry), "reason": f"directory-unavailable: {error}"})
    return roots


def _collect(root: str, skipped: list[dict]) -> list[dict]:
    """递归收集 `root` 下的日志文件（不跟随符号链接）。"""
    found: list[dict] = []
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            with os.scandir(directory) as iterator:
                entries = list(iterator)
        except OSError as error:
            skipped.append({"path": str(directory), "reason": f"unreadable-directory: {error}"})
            continue
        for entry in entries:
            full = entry.path
            try:
                if entry.is_symlink():
                    skipped.append({"path": str(full), "reason": "symlink-not-followed"})
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append(full)
                    continue
                if not entry.is_file(follow_symlinks=False) or not is_log_name(entry.name):
                    continue
                info = entry.stat(follow_symlinks=False)
            except OSError as error:
                skipped.append({"path": str(full), "reason": f"stat-failed: {error}"})
                continue
            try:
                resolved = os.path.realpath(full)
            except OSError as error:
                skipped.append({"path": str(full), "reason": f"realpath-failed: {error}"})
                continue
            if not _is_inside(root, resolved):
                skipped.append({"path": str(full), "reason": "outside-directory"})
                continue
            found.append({"path": Path(full), "size": int(info.st_size), "mtime": float(info.st_mtime), "deleted": False})
    return found


def _next_rotation_target(file: Path) -> Path:
    """`<name>.1`，已存在则用时间戳后缀，再退到序号。"""
    first = file.with_name(f"{file.name}.1")
    if not first.exists():
        return first
    stamped = file.with_name(f"{file.name}.{int(time.time() * 1000)}")
    if not stamped.exists():
        return stamped
    for index in range(2, _MAX_ROTATE_SUFFIX):
        candidate = stamped.with_name(f"{stamped.name}.{index}")
        if not candidate.exists():
            return candidate
    raise OSError("no free rotation suffix")


def _copy_prefix(source: Path, target: Path, expected: int) -> int:
    """把 `source` 前 `expected` 字节复制进 `target`（覆盖写），返回复制字节数。"""
    copied = 0
    with open(source, "rb") as reader, open(target, "wb") as writer:
        while copied < expected:
            chunk = reader.read(min(_COPY_CHUNK, expected - copied))
            if not chunk:
                break
            writer.write(chunk)
            copied += len(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    return copied


def rotate_active(path: str | os.PathLike, max_bytes: int = MAX_FILE_BYTES) -> dict:
    """把正在被追加的文件轮转掉，**不重命名**。

    做法：复制到 `<name>.1`（或时间戳后缀），确认复制成功后再 `os.truncate(0)`。
    O_APPEND 打开的句柄在 truncate 之后写入位置回到文件开头，因此：

    - 原句柄仍然有效（`faulthandler` / `logging.FileHandler` / 子进程继承的 fd 都不用重开）；
    - 后续追加落在当天文件的开头之后，没有空洞；
    - 顺序保证「先有备份，后截断」——复制失败就保持原文件不动。

    返回值（**不抛异常**）::

        {"ok": bool, "rotated": bool, "path": str, "target": str | None,
         "bytes": int, "reason": str | None}

    `bytes` 是复制进轮转文件的实际字节数；`reason` 在未轮转时说明原因
    （`below-threshold` / `missing` / 具体错误）。
    """
    target_file = Path(path)
    result: dict[str, Any] = {
        "ok": True,
        "rotated": False,
        "path": str(target_file),
        "target": None,
        "bytes": 0,
        "reason": None,
    }
    try:
        if not target_file.is_file():
            return {**result, "ok": False, "reason": "missing"}
        size = target_file.stat().st_size
    except OSError as error:
        return {**result, "ok": False, "reason": f"stat-failed: {error}"}
    if size <= max_bytes:
        return {**result, "reason": "below-threshold", "bytes": size}

    rotation_target: Path | None = None
    try:
        rotation_target = _next_rotation_target(target_file)
        copied = 0
        # 复制期间可能有新的追加：按当前长度复核并补复制（最多 3 轮），
        # 之后以已复制的长度为准确认。
        for _ in range(_MAX_COPY_PASSES):
            copied = _copy_prefix(target_file, rotation_target, target_file.stat().st_size)
            if target_file.stat().st_size <= copied:
                break
        os.truncate(target_file, 0)
        return {**result, "rotated": True, "target": str(rotation_target), "bytes": copied}
    except OSError as error:
        # 复制没成功就绝不截断：原日志保持完整，残留的半截轮转文件删掉。
        if rotation_target is not None:
            try:
                rotation_target.unlink()
            except OSError:
                pass
        return {**result, "ok": False, "reason": f"rotate-failed: {error}"}


def enforce(
    log_dirs: Any = None,
    now: Any = None,
    policy: dict | None = None,
) -> dict:
    """对一组目录执行保留策略（与 Node 侧 `enforceLogRetention` 同顺序、同形状）。

    顺序是契约的一部分：先按天删过期 → 再按总量删最旧 → 最后把仍然过大的
    非活跃文件重命名成 `.1`（重命名不改变字节总量，不会把目录再次撑爆）。

    :returns: `{"examined", "deleted", "rotated", "truncated", "bytes_before",
        "bytes_after", "skipped"}`；`deleted` 是路径字符串列表，
        `rotated` 是 `[{"path", "to", "bytes"}]`，`skipped` 是
        `[{"path", "reason"}]`。`truncated` 恒为空（保留键以与 Node 侧同形状）。
    """
    result: dict[str, Any] = {
        "examined": 0,
        "deleted": [],
        "rotated": [],
        "truncated": [],
        "bytes_before": 0,
        "bytes_after": 0,
        "skipped": [],
    }
    effective = _normalize_policy(policy)
    timestamp = _now_seconds(now)
    roots = _normalize_roots(log_dirs, result["skipped"])
    records: list[dict] = []
    for root in roots:
        records.extend(_collect(root, result["skipped"]))
    result["examined"] = len(records)
    result["bytes_before"] = sum(record["size"] for record in records)

    protect_seconds = effective["protect_ms"] / 1000.0

    def is_active(record: dict) -> bool:
        return timestamp - record["mtime"] < protect_seconds

    newest: dict | None = None
    for record in records:
        key = (record["mtime"], str(record["path"]))
        if newest is None or key > (newest["mtime"], str(newest["path"])):
            newest = record

    def deletable(record: dict) -> bool:
        return not record["deleted"] and record is not newest and not is_active(record)

    def oldest_first(record: dict) -> tuple[float, str]:
        return (record["mtime"], str(record["path"]).lower())

    def remove_record(record: dict) -> bool:
        try:
            os.unlink(record["path"])
            record["deleted"] = True
            result["deleted"].append(str(record["path"]))
            return True
        except OSError as error:
            result["skipped"].append({"path": str(record["path"]), "reason": f"delete-failed: {error}"})
            if isinstance(error, FileNotFoundError):
                record["deleted"] = True
                return True
            return False

    # 1) 过期（按天保留）。
    expired_before = timestamp - effective["max_age_days"] * _DAY_SECONDS
    for record in sorted(records, key=oldest_first):
        if record["mtime"] >= expired_before:
            continue
        if not deletable(record):
            continue
        remove_record(record)

    # 2) 总量上限：最旧优先删。
    total = sum(0 if record["deleted"] else record["size"] for record in records)
    if total > effective["max_total_bytes"]:
        for record in sorted(records, key=oldest_first):
            if total <= effective["max_total_bytes"]:
                break
            if not deletable(record):
                continue
            before = record["size"]
            if remove_record(record):
                total -= before

    # 3) 仍然过大的非活跃文件：重命名成 .1（不截断、不丢字节）。
    for record in records:
        if record["deleted"] or record["size"] <= effective["max_file_bytes"]:
            continue
        if is_active(record) or not str(record["path"]).lower().endswith(".log"):
            continue
        try:
            destination = _next_rotation_target(record["path"])
            os.replace(record["path"], destination)
            result["rotated"].append({"path": str(record["path"]), "to": str(destination), "bytes": record["size"]})
            record["path"] = destination
        except OSError as error:
            result["skipped"].append({"path": str(record["path"]), "reason": f"rotate-failed: {error}"})

    after = 0
    for record in records:
        if record["deleted"]:
            continue
        try:
            after += os.stat(record["path"]).st_size
        except OSError:
            continue
    result["bytes_after"] = after
    return result
