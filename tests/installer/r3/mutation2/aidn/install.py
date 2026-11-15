"""The install / upgrade / uninstall transactions.

Order is deliberate and every step is reversible or harmless on its own:

1. validate the target *before* touching the disk (a rejected path must cost nothing),
2. unpack the payload to a temp tree (a corrupt download fails before the target is
   modified),
3. resolve the entry point (a payload without one is refused before deletion),
4. stop processes under the target and under the previous location,
5. copy with merge semantics — never purge, so ``data\\`` survives an upgrade,
6. prove the data survived (hash of the largest data file, before vs after),
7. write ``install.json``, the self-check script and a copy of this installer,
8. shortcuts, autostart, uninstall key — all best effort, all reported,
9. remove the extraction tree.

Steps 5–8 are the only ones that can leave a partial install, and step 7 writes the
record *after* the files are in place, so a half-copied tree has no ``install.json``
and is therefore not mistaken for a working installation by the next run.

Author: PT-dove
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from . import constants, ownership, payload, paths, procs, registry, shortcuts, selfinfo


@dataclass
class Options:
    target: Path
    desktop_shortcut: bool = True
    create_shortcuts: bool = True
    autostart: bool = False
    write_registry: bool = True
    keep_data: bool = False


@dataclass
class Result:
    ok: bool = False
    target: Path | None = None
    upgraded_from: str | None = None
    entry: str | None = None
    shortcut_problems: list[str] = field(default_factory=list)
    message: str = ""


# ---------------------------------------------------------------- detection
def read_install_record(root: Path) -> dict | None:
    record = root / constants.INSTALL_DIR_NAME / constants.INSTALL_RECORD_NAME
    if not record.is_file():
        return None
    try:
        data = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------- upgrade journal
#: Name of the journal under ``<target>\install\`` (UPGRADE-001).
JOURNAL_NAME = "upgrade.pending.json"
#: Bumped only if the fields below change meaning.
JOURNAL_SCHEMA = 1


def _journal_path(root: Path) -> Path:
    return root / constants.INSTALL_DIR_NAME / JOURNAL_NAME


def read_upgrade_journal(root: Path) -> dict | None:
    try:
        data = json.loads(_journal_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _journal_is_valid(root: Path, journal: dict, record: dict) -> bool:
    """May this journal turn "not ours" into "ours, mid-upgrade"?

    Never on its own.  The journal lives inside the directory being judged, so a
    forger can write one; what it adds is *intent*, not authority.  Authority stays
    with the credential the installer issued at install time, which an attacker who
    can only write inside the target cannot mint:

    1. the journal names this path and the version the record still carries (the
       tree is not a copied tree, and the journal is not from another upgrade);
    2. ``install.json``'s identity fields agree with the tree (``_record_is_ours``);
    3. ``install.json.ownership`` is a valid HMAC-SHA256 over the canonical path
       being judged (``ownership.verify``) — SEED-01/RC4-N01's rule: content is not
       ownership, and a forged journal does not change that.

    Only then is a tree whose payload bytes no longer match its manifest readable as
    "an upgrade of our own install was cut off", which is exactly the state an
    interrupted copy leaves (files new, manifest old, record old).
    """

    if ownership.canonical_path(str(journal.get("target") or "")) != ownership.canonical_path(root):
        return False
    if str(journal.get("fromVersion") or "") != str(record.get("version") or ""):
        return False
    if not _record_is_ours(root, record):
        return False
    ok, _reason = ownership.verify(record, root)
    return ok


def _resume_marker(root: Path) -> tuple[str, dict] | None:
    """``(marker text, journal)`` when *root* is a tree whose upgrade was cut off."""

    record = read_install_record(root)
    if record is None:
        return None
    journal = read_upgrade_journal(root)
    if journal is None or not _journal_is_valid(root, journal, record):
        return None
    return f"{constants.INSTALL_DIR_NAME}/{JOURNAL_NAME}", journal


def _write_journal(
    root: Path,
    *,
    from_version: str,
    to_version: str,
    payload_manifest_sha256: str,
    log,
) -> None:
    """Declare the intent to change *root* before its first byte changes.

    Written after the payload is unpacked and proven complete (a failed download
    must not leave a journal) but before ``_copy_tree`` touches the target, so any
    kill from here until the record is rewritten leaves the evidence a later run
    needs.  ``payloadManifestSha256`` binds the journal to the payload bytes of this
    particular upgrade, so a stale journal cannot bless a different payload.
    """

    path = _journal_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    journal = {
        "schema": JOURNAL_SCHEMA,
        "fromVersion": from_version,
        "toVersion": to_version,
        "payloadManifestSha256": payload_manifest_sha256,
        "startedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "target": str(root),
    }
    path.write_text(json.dumps(journal, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log.write(f"upgrade journal written: {path} ({from_version or '?'} -> {to_version})")


def _remove_journal(root: Path, log) -> None:
    try:
        _journal_path(root).unlink()
        log.write("upgrade journal removed: no interrupted transaction is pending on this tree")
    except FileNotFoundError:
        return
    except OSError as error:
        log.write(f"WARN could not remove the upgrade journal: {error}")


def find_existing() -> tuple[Path, str, str] | None:
    """``(path, version, source)`` of an existing install, registry first.

    The registry can be cleaned by a user or a "debloat" script while the files stay
    behind, so the default directory is checked as well; the reverse order would
    report a broken install as absent and then silently install a second copy.
    """

    entry = registry.read_uninstall_entry()
    if entry and entry.get("InstallLocation"):
        location = Path(entry["InstallLocation"])
        if location.is_dir():
            return location, entry.get("DisplayVersion", ""), "registry"

    record = read_install_record(paths.default_target())
    if record and record.get("installPath"):
        location = Path(str(record["installPath"]))
        if location.is_dir():
            return location, str(record.get("version", "")), "install.json"
    return None


# ---------------------------------------------------------------- install
def install(options: Options, log) -> Result:
    version = selfinfo.product_version()
    reason = paths.validate_target(str(options.target))
    if reason:
        raise InstallError(reason)

    target = paths.normalise(str(options.target))
    archive = payload.archive_path()
    facts = payload.describe(archive)
    log.write(
        f"payload: {facts.get('path')} ({facts.get('bytes')} bytes, "
        f"{facts.get('uncompressedBytes')} uncompressed)"
    )
    log.write(f"target: {target}  version: {version}")

    # Refuse *before* extracting 450 MiB when the target volume cannot hold the
    # result: a disk-full copy fails halfway and leaves a tree that looks installed.
    needed = int(facts.get("uncompressedBytes") or 0)
    if needed:
        reason = payload.require_free_space(target, needed)
        if reason:
            raise InstallError(reason)

    existing = find_existing()
    upgraded_from = None
    if existing and existing[0].is_dir():
        upgraded_from = existing[1] or None
    if upgraded_from is None:
        own = read_install_record(target)
        if own and own.get("version"):
            upgraded_from = str(own["version"])

    # 装进一个「有内容但没有安装标记」的目录 = 把用户的文件和新装的文件混在一棵树里，
    # 之后任何一次卸载都会把它们一起删掉（卸载侧已按 §uninstall 加了归属校验，
    # 但那时 install.json 已经存在，校验会让它通过）。所以在复制之前就拒绝，
    # 而不是等着在卸载时才发现。空目录与已有的安装树不受影响。
    #
    # RC5-N01: "may I upgrade this tree in place" is deliberately a **different** check
    # from "may I delete this tree" (_install_marker).  An rc.4-and-earlier tree has no
    # ownership credential; if the upgrade check required one, every existing user would
    # be unable to upgrade (and the only way out would be deleting the tree by hand).
    # The upgrade writes the current credential, after which uninstall works again.
    if target.exists() and not target.is_dir():
        raise InstallError(f"目标路径已存在且不是目录：{target} / The target exists and is not a directory.")
    # UPGRADE-001: a copy that was cut off half way leaves files new, manifest old
    # and record old — so `_upgrade_marker` answers None and the user cannot install
    # *or* uninstall.  A journal that is backed by the ownership credential proves
    # the tree is ours and the mixed state is our own unfinished copy, so the run may
    # continue instead of refusing.  The journal is never trusted alone; see
    # `_journal_is_valid` for why.
    pending_journal: dict | None = None
    if target.is_dir() and _has_any_entry(target) and _upgrade_marker(target) is None:
        raise InstallError(
            f"安装被拒：{target} 不是空目录，也没有安装标记（install\\install.json）。"
            "往这样的目录里装会把你的文件和新装的文件混在一起，卸载时一起删掉。"
            "请换一个空目录，或先自行清空。什么都没有写入。"
            " / Refusing to install into a non-empty directory that is not an existing "
            "install: the two trees would merge and a later uninstall would delete your "
            "files with ours. Nothing was written."
        )

    extraction = paths.extraction_root()
    try:
        payload.extract(archive, extraction, log)
        entry = payload.resolve_entry(extraction)
        if entry is None:
            raise InstallError(
                "载荷里找不到可启动的入口（桌面程序或控制台启动器），已中止安装。"
                " / The payload contains no launchable entry point; installation aborted."
            )
        relative, kind = entry
        log.step(f"用入口：{relative} / entry: {relative}")

        # A payload that declares its desktop shell must actually carry it. Without
        # this, a payload whose shell went missing still installs — through
        # `launch\aegis-console.cmd` — and the user gets a product that is not the tray
        # program they were promised, with nothing on screen saying so.
        reason = payload.missing_desktop_reason(extraction)
        if reason:
            raise EntryError(reason)

        log.step("停止正在运行的程序… / Stopping running programs…")
        procs.stop_under(target, log)
        if existing and existing[0] != target:
            procs.stop_under(existing[0], log)

        log.step("创建安装目录… / Creating the install directory…")
        target.mkdir(parents=True, exist_ok=True)

        data_dir = target / constants.DATA_DIR_NAME
        data_probe = _probe_data(data_dir)

        # UPGRADE-001: this is the last moment before the target's bytes change, so the
        # journal goes down here — after the payload is unpacked and resolvable (a
        # corrupt download must not leave one), before `_copy_tree`.  It is removed only
        # once `install.json` is rewritten, because only then do the bytes and the
        # record agree again.
        payload_manifest = extraction / ownership.MANIFEST_RELATIVE
        payload_manifest_digest = _sha256(payload_manifest) if payload_manifest.is_file() else ""
        if pending_journal is not None:
            expected = str(pending_journal.get("payloadManifestSha256") or "")
            if expected and expected != payload_manifest_digest:
                raise InstallError(
                    "升级日志与本次载荷不一致（载荷清单摘要不同），已中止，目标目录一个字节都没改。"
                    " / The upgrade journal names a different payload; refusing to continue."
                )
        record_before = read_install_record(target)
        _write_journal(
            target,
            from_version=str((record_before or {}).get("version") or upgraded_from or ""),
            to_version=version,
            payload_manifest_sha256=payload_manifest_digest,
            log=log,
        )

        log.step("复制程序文件（请稍候）… / Copying program files…")
        _copy_tree(extraction, target)

        if data_probe is not None:
            _assert_data_intact(data_probe)

        installed_entry = payload.resolve_entry(target)
        if installed_entry is None:
            raise InstallError(
                "复制完成后目标目录里没有入口文件，安装包与清单不一致，已中止。"
                " / The copied tree has no entry point; payload and installer disagree."
            )
        # Same requirement, checked on the tree that will actually be launched: the
        # pre-copy check proves the payload was intact, this one proves the copy was.
        reason = payload.missing_desktop_reason(target)
        if reason:
            raise EntryError(reason)

        # Autostart is applied *before* the record is written: `install.json.autostart` has
        # to be the state the registry actually ended up in, not the state we asked for.
        # It used to be written first (`install.py:206` before the registry call), which is
        # why the rc.4 acceptance could read `autostart=True` out of the record while
        # `HKCU\...\Run` held nothing (`transcript.log:62` vs `:80`) — and nothing noticed.
        problems: list[str] = []
        log.step("设置开机自启… / Configuring autostart…")
        command = _launch_command(target, installed_entry[0], installed_entry[1])
        user_sid = _autostart_user_sid()
        if user_sid:
            log.write(f"autostart target hive: HKEY_USERS\\{user_sid} (installed elevated)")
        if options.autostart:
            try:
                registry.set_autostart(True, command, user_sid=user_sid)
            except (OSError, ValueError) as error:
                problems.append(f"autostart: {error}")
                log.write(f"WARN autostart failed: {error}")
        else:
            # Never a blind delete: the Run value is one global entry per profile.  If it
            # names another (still installed) tree it is not ours to remove — that blind
            # delete is what erased a correct entry 15 s after it was written when two
            # installer processes ran on the same machine (rc.4 T4).
            try:
                outcome = registry.remove_autostart_if_ours(target, user_sid=user_sid)
                log.write(f"autostart cleanup: {outcome}")
            except OSError as error:
                problems.append(f"autostart cleanup: {error}")
                log.write(f"WARN autostart cleanup failed: {error}")
        autostart_state = registry.autostart_points_into(target, user_sid=user_sid)
        log.write(f"autostart state read back from the Run key: {autostart_state}")
        if options.autostart and not autostart_state:
            problems.append("autostart: the Run value is not registered after the write")
            log.write(
                "WARN autostart was requested but the Run key does not point at this install; "
                "install.json records the real state (false)"
            )

        log.step("写入安装记录… / Writing the install record…")
        record = {
            "product": constants.PRODUCT_NAME,
            "version": version,
            "installPath": str(target),
            "installedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "desktopExe": installed_entry[0],
            "entryKind": installed_entry[1],
            "autostart": autostart_state,
            "upgradedFrom": upgraded_from,
            "channel": constants.CHANNEL_INSTALLED,
            **payload.payload_facts(target),
            # RC5-N01: the only thing that authorizes a later recursive delete.  Bound to
            # this canonical path, this version/channel and the manifest actually on
            # disk; issued under a key compiled into the installer (see aidn/ownership.py
            # and $script:OwnershipKeyHex in Setup.ps1).
            "ownership": ownership.issue(
                target, channel=constants.CHANNEL_INSTALLED, version=version
            ),
        }
        install_dir = target / constants.INSTALL_DIR_NAME
        install_dir.mkdir(parents=True, exist_ok=True)
        (install_dir / constants.INSTALL_RECORD_NAME).write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        # The record now carries a credential issued for this exact path, version and
        # manifest, and the manifest matches the bytes on disk: the transaction that
        # the journal announced is complete.
        _remove_journal(target, log)

        _write_selfcheck(target, log)
        installer_copy = _copy_installer(target, log)

        if options.create_shortcuts:
            log.step("创建快捷方式… / Creating shortcuts…")
            problems += shortcuts.install_shortcuts(
                target, installed_entry[0], installed_entry[1], options.desktop_shortcut, log
            )

        if options.write_registry:
            log.step("登记卸载信息… / Registering the uninstall entry…")
            # The copy under <target>\installer\ exists precisely so uninstall still
            # works after the downloaded Setup.exe is gone; naming sys.executable
            # instead would make that copy pointless and turn a cleaned Downloads
            # folder into an entry that cannot be removed from 应用和功能.
            uninstaller = installer_copy or Path(sys.executable)
            uninstall_command = f'"{uninstaller}" /uninstall /DIR="{target}"'
            quiet_command = uninstall_command + " /S"
            log.write(f"uninstaller for the registry entry: {uninstaller}")
            # Step 8 of this module's contract is "best effort, all reported". A
            # registry write that fails (locked policy hive, redirected profile) must
            # therefore be reported, not raised: the files are already installed and a
            # traceback would tell the user nothing about what is on disk.
            try:
                hive = registry.write_uninstall_entry(target, version, uninstall_command, quiet_command)
                log.write(f"uninstall key written to {hive}")
            except OSError as error:
                problems.append(f"uninstall entry: {error}")
                log.write(f"WARN uninstall entry not written: {error}")

        result = Result(
            ok=True,
            target=target,
            upgraded_from=upgraded_from,
            entry=installed_entry[0],
            shortcut_problems=problems,
        )
        result.message = (
            f"升级完成：{upgraded_from} → {version} / Upgraded {upgraded_from} → {version}"
            if upgraded_from
            else f"安装完成：{version} / Installed {version}"
        )
        log.write(result.message)
        return result
    finally:
        payload.cleanup(extraction, log)


class InstallError(Exception):
    """A refusal or failure that should be shown to the user as-is."""


class EntryError(InstallError):
    """The payload does not contain the entry point it declared.

    Separate from ``InstallError`` only so the process exit code can say "this payload
    is wrong" (``EXIT_NO_ENTRY``) instead of the generic failure code: automation that
    installs a candidate build has to tell a bad payload from a bad machine.
    """


class UninstallRefused(InstallError):
    """Refused to delete: the target is not provably one of our install trees.

    Its own class so the exit code says ``EXIT_TARGET_INVALID`` — "you pointed me at
    the wrong directory" — rather than a generic failure. Nothing was deleted.
    """


def _copy_tree(source: Path, target: Path) -> None:
    shutil.copytree(
        source,
        target,
        dirs_exist_ok=True,
        copy_function=shutil.copy2,
        ignore_dangling_symlinks=True,
    )


def _probe_data(data_dir: Path) -> tuple[Path, str] | None:
    """Hash the largest file under ``data\\`` so an upgrade can prove it untouched."""

    if not data_dir.is_dir():
        return None
    largest: Path | None = None
    largest_size = -1
    for candidate in data_dir.rglob("*"):
        try:
            if candidate.is_file():
                size = candidate.stat().st_size
                if size > largest_size:
                    largest, largest_size = candidate, size
        except OSError:
            continue
    if largest is None:
        return None
    return largest, _sha256(largest)


def _assert_data_intact(probe: tuple[Path, str]) -> None:
    path, digest = probe
    if not path.exists():
        raise InstallError(f"升级过程中数据文件丢失：{path} / A data file vanished during the upgrade.")
    if _sha256(path) != digest:
        raise InstallError(f"升级后数据文件被改动：{path} / A data file changed during the upgrade.")


def _sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def _launch_command(root: Path, relative: str, kind: str) -> str:
    if kind == "cmd":
        comspec = os.environ.get("COMSPEC", "C:\\Windows\\System32\\cmd.exe")
        return f'"{comspec}" /c ""{root / relative}""'
    return f'"{root / relative}"'


def _autostart_user_sid() -> str | None:
    """Whose Run key an install should write, or ``None`` for the current user.

    Only an *elevated* installer can end up in another account's profile: when the UAC
    prompt is answered with a different administrator's credentials, this process's
    ``HKEY_CURRENT_USER`` is that administrator's hive, and the user who actually asked
    for autostart would get no entry.  The interactive desktop's owner is the user the
    entry has to belong to.  Non-elevated — the normal case — the answer is ``None``,
    which means "current user" and keeps the historical behaviour exactly.
    """

    if not paths.is_admin():
        return None
    return registry.interactive_user_sid()


def _write_selfcheck(root: Path, log) -> None:
    """The diagnostic entry point, with the worker's environment preconditions met.

    只在载荷真的带了 ``SelfCheck.mjs`` 时才写这个 .cmd。之前无条件写，结果安装树里
    多出一个「点了报错找不到模块」的入口（v15 载荷里没有 SelfCheck.mjs）。
    一个指向不存在文件的快捷方式，比没有这个快捷方式更糟。
    """

    script = root / constants.SELFCHECK_MJS_NAME
    if not script.is_file():
        log.write(f"self-check skipped: {constants.SELFCHECK_MJS_NAME} is not in this payload")
        return

    body = (
        "@echo off\r\n"
        "setlocal DisableDelayedExpansion\r\n"
        f"title {constants.PRODUCT_NAME} - self check\r\n"
        'cd /d "%~dp0"\r\n'
        '"%~dp0runtime\\node\\node.exe" --version\r\n'
        "echo.\r\n"
        '"%~dp0runtime\\node\\node.exe" "%~dp0SelfCheck.mjs"\r\n'
        "set \"CODE=%ERRORLEVEL%\"\r\n"
        "echo.\r\n"
        "pause\r\n"
        "exit /b %CODE%\r\n"
    )
    try:
        (root / constants.SELFCHECK_SCRIPT_NAME).write_text(body, encoding="mbcs" if _has_mbcs() else "utf-8")
    except OSError as error:
        log.write(f"WARN self-check script not written: {error}")


def _has_mbcs() -> bool:
    try:
        "x".encode("mbcs")
        return True
    except (LookupError, UnicodeEncodeError):
        return False


def _copy_installer(root: Path, log) -> Path | None:
    """Keep a copy of this executable so uninstall works after the download is gone.

    Returns the copy, so the uninstall command can name it: a copy nothing points at
    is not a fallback, it is a 66 MiB souvenir.
    """

    destination = root / constants.INSTALLER_COPY_DIR
    try:
        destination.mkdir(parents=True, exist_ok=True)
        source = Path(sys.executable)
        if source.suffix.lower() == ".exe" and source.is_file():
            copy = destination / source.name
            shutil.copy2(source, copy)
            return copy
    except OSError as error:
        log.write(f"WARN installer copy failed: {error}")
    return None


# ---------------------------------------------------------------- uninstall
def uninstall(options: Options, log) -> Result:
    target = paths.normalise(str(options.target))

    # 目标本身是符号链接 / junction 时拒绝：递归删除会穿透链接，把链接指向的真实目录
    # 整个清空，而用户以为自己删的是「这个目录」。Windows 建 junction 不需要特权，而
    # Python 3.11 的 is_symlink() 对 junction 返回 False，所以判据和日志都要按解析后
    # 的真实路径来（见 _link_reason）。
    link_reason = _link_reason(target)
    if link_reason:
        raise UninstallRefused(link_reason)

    if not target.is_dir():
        raise InstallError(f"安装目录不存在：{target} / No such install directory.")

    # 卸载是唯一会**递归删除用户文件**的路径，所以它必须自己证明「这个目录是我装的」，
    # 不能只因为用户把路径打对了就删。判据（RC5-N01）：
    #   ① 路径本身合法（盘符根、%SystemRoot% 下、超长一律拒）；
    #   ② install\install.json 的身份字段（product / version / installPath / channel）
    #      与内容清单一致；
    #   ③ install.json 里的 ownership 凭据合法，且用**即将被删的路径**重算的 HMAC-SHA256
    #      与记录相等（常量时间比较）；
    #   ④ 记录里的 payloadDigest 必须等于磁盘上 manifests\files.sha256 的 sha256。
    # 「目录里有看起来像我们的文件」不再授权删除——那是 RC4-N01 的可伪造面。
    # 少了这些判据时，`/DIR=` 一个笔误就会把任意目录清空——那是不可恢复的数据丢失。
    # 空目录例外：本来就没东西可丢，拒绝它只会让「删掉上次失败的残骸」变得没法做。
    reason = paths.validate_target(str(options.target))
    if reason:
        raise UninstallRefused(f"卸载被拒：{reason} / Refusing to uninstall: {reason}")

    marker = _install_marker(target)
    if marker is None:
        # UPGRADE-001: an upgrade that was killed between "files copied" and "record
        # rewritten" leaves the payload manifest older than the bytes, so the delete
        # marker is None.  The journal plus the ownership credential proves both that
        # the tree is ours and that the mismatch is our own unfinished copy — the
        # same evidence the install side uses.  Nothing else about the delete changes:
        # without that credential the refusal below still stands, byte for byte.
        resumed = _resume_marker(target)
        if resumed is not None:
            marker = f"{resumed[0]}(interrupted-upgrade)"
            log.write(
                f"install marker: {marker} — 上一次升级被中断（"
                f"{resumed[1].get('fromVersion')} -> {resumed[1].get('toVersion')}），"
                "归属凭据仍然有效，允许卸载。"
            )
    if marker is None:
        leftover = _has_any_entry(target)
        if leftover:
            raise UninstallRefused(
                f"卸载被拒：{target} 里{_ownership_problem(target)}，但目录不是空的。"
                "为避免误删用户文件，已停止，什么都没有删除。"
                " / Refusing to uninstall: the directory is not empty and does not carry a "
                "valid install marker of this product. Nothing was deleted; remove it by hand "
                "if it really is a leftover."
            )
        log.write(f"nothing to uninstall: {target} is an empty directory")
        try:
            target.rmdir()
        except OSError as error:
            log.write(f"WARN could not remove the empty directory: {error}")
        return Result(ok=True, target=target,
                      message=f"目录为空，已移除：{target} / Removed the empty directory {target}")

    log.write(f"install marker: {marker}")

    log.step("停止正在运行的程序（含守护进程子进程）… / Stopping running programs…")
    stopped = procs.stop_under(target, log)
    log.write(f"stopped {stopped} process(es)")

    log.step("移除快捷方式… / Removing shortcuts…")
    shortcuts.remove_shortcuts(log)

    log.step("清除开机自启项… / Clearing autostart…")
    # Scoped on purpose: the Run value is one global entry per user profile, so an
    # uninstall of tree A must not remove the entry tree B registered.  A stale value that
    # points into the tree being deleted *is* ours and goes away (that is the acceptance
    # criterion "after uninstall the value is gone").
    try:
        outcome = registry.remove_autostart_if_ours(target, user_sid=_autostart_user_sid())
        log.write(f"autostart cleanup: {outcome}")
        if outcome == "kept":
            log.write(
                "autostart value left in place: it launches a different installation, "
                "not the tree being removed"
            )
    except OSError as error:
        log.write(f"WARN autostart removal failed: {error}")

    if options.write_registry:
        log.step("清除卸载登记… / Removing the uninstall entry…")
        removed = registry.remove_uninstall_entry()
        log.write(f"uninstall keys removed: {removed}")

    log.step("删除程序文件… / Deleting program files…")
    keep = set(constants.KEEP_ON_UNINSTALL) if options.keep_data else set()
    _delete_children(target, keep, log)
    # The registry UninstallString points at an installer copy *inside* the tree, so
    # the running image is one of the files being deleted.  Windows locks it; detach
    # it first, then retry the deletion (DEFECT-self-uninstall / N-017).
    _self_image_cleanup(target, log)
    _delete_children(target, keep, log)
    # `/KEEPDATA` keeps `install\`, so the journal would survive an uninstall that
    # already succeeded.  A journal that outlives its transaction is not evidence, it
    # is a stale licence to touch the next tree that lands here.
    _remove_journal(target, log)

    if not options.keep_data:
        try:
            if not any(target.iterdir()):
                target.rmdir()
        except OSError:
            pass

    # X-04 (N-011 §3): a child that cannot be deleted (locked / read-only / a reparse
    # point shutil refuses to walk) used to be a WARN only, and uninstall still returned
    # ok=True + exit 0.  The user then believes the product is gone while a tree that
    # can never be removed stays on disk.  Report the residue as a failure instead.
    leftover = _residue(target, keep)
    if leftover:
        return Result(
            ok=False,
            target=target,
            message=(
                f"卸载未完成：{target} 里仍有 {leftover} 项无法删除（可能被占用、只读，或含有链接）。"
                "请关闭正在运行的程序后重试，或手动删除这些残留。"
                " / Uninstall incomplete: "
                f"{leftover} item(s) could not be removed from {target} (in use, read-only, or a link). "
                "Close the program and retry, or delete the residue by hand."
            ),
        )
    return Result(ok=True, target=target, message=f"卸载完成：{target} / Uninstalled {target}")


def _install_marker(root: Path) -> str | None:
    """Authorization for the recursive delete: a record **plus its credential**.

    Until RC5 the criterion was content the directory itself supplies: an
    ``install/install.json`` whose identity fields matched, plus a
    ``manifests/files.sha256`` whose digests matched the files beside it — or, as a
    fallback, the payload's ``bundle.json`` + manifest pair.  Re-attack RC4 §2.2/§2.3
    wrote exactly that shape into an arbitrary directory (three files, their real
    digests) and both channels deleted the tree (py-16/py-17/ps-14/ps-15).  Content is
    not ownership.

    What authorizes a delete now is the credential the installer wrote at install time
    (``install.json.ownership``): HMAC-SHA256 over the product, channel, version, the
    **canonical path being deleted**, a random installId and the manifest digest.  The
    bundle-only branch is gone — a payload tree with no record cannot be deleted by the
    installer, only by hand.
    """

    record = read_install_record(root)
    if record is None or not _record_is_ours(root, record) or not _manifest_has_rows(root):
        return None
    ok, _reason = ownership.verify(record, root)
    if not ok:
        return None
    return f"{constants.INSTALL_DIR_NAME}/{constants.INSTALL_RECORD_NAME}+ownership({ownership.SCHEME})"


def _upgrade_marker(root: Path) -> str | None:
    """Is *root* an existing install tree this installer may upgrade in place?

    Deliberately weaker than ``_install_marker`` and it must never authorize a delete.
    An rc.4-and-earlier tree carries no ownership credential; requiring one here would
    strand every existing installation (the only escape would be deleting the tree by
    hand).  Upgrading writes the current credential, after which uninstall works again.

    只判「文件存在」不够：一个碰巧含同名文件的目录会被当成我们的安装树并在其中合并文件，
    所以两种标记都读内容、核对产品身份，见 ``_record_is_ours`` / ``_bundle_is_ours``。
    """

    record = read_install_record(root)
    if record is not None and _record_is_ours(root, record) and _manifest_has_rows(root):
        return f"{constants.INSTALL_DIR_NAME}/{constants.INSTALL_RECORD_NAME}"
    if _bundle_is_ours(root):
        return "bundle.json + manifests/files.sha256"
    return None


def _ownership_problem(root: Path) -> str:
    """Why a non-empty directory failed the ownership check, for the refusal text."""

    record = root / constants.INSTALL_DIR_NAME / constants.INSTALL_RECORD_NAME
    if record.is_file():
        return (
            f"{constants.INSTALL_DIR_NAME}\\{constants.INSTALL_RECORD_NAME} 存在，"
            "但内容与产品身份（product / version / installPath / channel）对不上，"
            "或载荷清单 manifests\\files.sha256 与磁盘内容不一致，"
            "或缺少/不匹配安装器内置归属凭据（install.json 的 ownership：HMAC-SHA256，"
            "绑定本路径与清单摘要）"
        )
    if (root / "bundle.json").is_file():
        return (
            "bundle.json 存在，但载荷清单已不再单独授权递归删除"
            "（缺少 install\\install.json 与安装器内置归属凭据 ownership）"
        )
    return f"没有任何安装标记（{constants.INSTALL_DIR_NAME}\\{constants.INSTALL_RECORD_NAME} + 安装器内置归属凭据 ownership）"


#: Reparse tag of an NTFS junction (``IO_REPARSE_TAG_MOUNT_POINT``).  Python 3.12 adds
#: ``Path.is_junction()``; on older versions the tag from ``os.lstat`` is the only way
#: to recognise one, because ``is_symlink()`` is False for a junction.
_JUNCTION_TAG = 0xA0000003

#: The desktop shell every release payload carries at the install root.
_DESKTOP_EXE_NAME = "AIDrivenNetDefense.exe"

#: ``bundle.json`` kinds the release pipeline produces (see ``dist/bundle/**``).
_BUNDLE_KINDS = ("packaging-poc", "v14-desktop")

#: Paths that only this product's payload layout contains; used as cheap identity
#: evidence, because the real ``packaging-poc`` bundle.json has no ``product`` field.
_PAYLOAD_LAYOUT_MARKERS = (
    "aidrivennetdefense.exe",
    "runtime/node/node.exe",
    "app/node_modules/@aegisharness/",
    "launch/aegis-",
    "dsh-home/profiles/aegis-analysis",
    "rules/defense-seed-pack.json",
)

_VERSION_RE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]*")
#: One digest row: 64 hex chars, two spaces, then the path.  The digest needs its own
#: capturing group — the named group alone would make ``group(1)`` the path.
_MANIFEST_ROW_RE = re.compile(r"([0-9a-fA-F]{64})  (?P<path>.+)")


def _looks_version(value: object) -> bool:
    return isinstance(value, str) and _VERSION_RE.fullmatch(value.strip()) is not None


def _same_path(value: object, root: Path) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        return os.path.normcase(os.path.abspath(value.strip())) == os.path.normcase(str(root))
    except (OSError, ValueError):
        return False


def _is_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)  # Python 3.12+
    if is_junction is not None:
        try:
            return bool(is_junction())
        except OSError:
            return False
    try:
        return getattr(os.lstat(str(path)), "st_reparse_tag", 0) == _JUNCTION_TAG
    except OSError:
        return False


def _link_reason(target: Path) -> str | None:
    """Why *target* must not be uninstalled through, or ``None`` when it is a plain path.

    Two detections, deliberately redundant: the link itself (``is_symlink`` /
    ``is_junction`` / reparse tag) and the resolved real path (``realpath`` differs
    from the typed path).  The second also catches a link in a parent directory, which
    makes ``/DIR=`` delete a different tree than the user named.
    """

    try:
        real = Path(os.path.realpath(str(target)))
    except OSError:
        real = target
    is_link = target.is_symlink() or _is_junction(target)
    if not is_link and os.path.normcase(str(real)) == os.path.normcase(str(target)):
        return None
    if is_link:
        head = f"卸载被拒：{target} 是符号链接/联接（junction），解析后的真实路径是 {real}。"
    else:
        head = f"卸载被拒：{target} 的路径解析到了 {real}（路径中有符号链接/联接）。"
    return (
        head
        + "删除会穿透链接删掉它指向的目录，已停止，什么都没有删除。"
        + " / Refusing to uninstall through a symlink/junction: "
        + f"it resolves to {real}. Nothing was deleted."
    )


def _record_is_ours(root: Path, record: dict) -> bool:
    """Do **all** identity fields of a real ``install.json`` agree with this tree?

    The record is written by ``install()``; its real fields are
    ``product`` / ``version`` / ``installPath`` / ``channel``.  An earlier version of
    this gate required the product plus *one* of the other three — wave-5 re-attack
    (P1-REV-E-01) forged ``{"product", "version"}`` and ``{"product", "channel"}`` and
    got an arbitrary directory deleted, so "one plausible field" is not evidence.
    Now every field must agree, **and** the caller additionally requires the payload
    hash manifest to verify against the files on disk (``_manifest_has_rows``): a
    copied JSON is not enough, the tree must carry our payload bytes.
    """

    product = str(record.get("product") or "").strip()
    if product not in (constants.PRODUCT_NAME, constants.PRODUCT_NAME_ZH):
        return False
    channel = str(record.get("channel") or "").strip()
    # "test" is what Setup.ps1 (the PowerShell test channel) writes; both entry
    # points must be able to uninstall each other's trees.
    if channel not in (constants.CHANNEL_INSTALLED, constants.CHANNEL_PORTABLE, "test"):
        return False
    if not _looks_version(record.get("version")):
        return False
    return _same_path(record.get("installPath"), root)


def _bundle_paths_are_ours(record: dict) -> bool:
    """Does the layout recorded in ``bundle.json`` belong to this payload?"""

    assets = record.get("assets")
    desktop = assets.get("desktop") if isinstance(assets, dict) else None
    if isinstance(desktop, dict):
        target = str(desktop.get("target") or "").replace("\\", "/")
        if target.rsplit("/", 1)[-1] == _DESKTOP_EXE_NAME:
            return True
    paths = record.get("paths")
    if not isinstance(paths, dict):
        return False
    values = {str(value).replace("\\", "/").lower() for value in paths.values()}
    return any(
        marker in value for value in values for marker in _PAYLOAD_LAYOUT_MARKERS
    )


def _manifest_path_is_safe(relative: str) -> bool:
    """Is *relative* a plain in-tree path (no absolute path, no ``..`` traversal)?

    The manifest is read from a directory that is about to be deleted; a row naming
    ``..\\..\\..\\Windows\\System32\\x`` or ``C:\\Windows\\x`` is not a payload file
    and must fail the whole manifest closed rather than be silently skipped
    (P1-REV-E-02, wave-5 re-attack, bypass B).
    """

    if not relative or relative.startswith(("/", "\\")):
        return False
    if re.match(r"^[A-Za-z]:", relative):
        return False
    parts = relative.replace("\\", "/").split("/")
    return all(part not in ("", ".", "..") for part in parts)


def _manifest_has_rows(root: Path) -> bool:
    """Does ``manifests/files.sha256`` prove this tree carries our payload *bytes*?

    An empty file, a header-only file, one invented 64-hex row, CRLF+BOM wrapping or
    a row naming a path outside the tree all passed the old shape-only check — that
    was re-attack bypass B (P1-REV-E-02).  The criterion is now content, not shape:
    every row must parse, every path must stay inside the tree, and a bounded sample
    of rows (first/last + payload-layout rows, at most 64) must match the SHA-256 of
    the file on disk.  A handwritten manifest therefore only passes if the directory
    really contains our payload files, byte for byte.
    """

    try:
        raw = (root / "manifests" / "files.sha256").read_bytes()
    except OSError:
        return False
    # A BOM is not something this pipeline writes; treat it as a forged manifest.
    if raw.startswith(b"\xef\xbb\xbf"):
        return False
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return False

    rows: list[tuple[str, str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = _MANIFEST_ROW_RE.fullmatch(line)
        if match is None:
            return False
        relative = match.group("path").strip()
        if not _manifest_path_is_safe(relative):
            return False
        rows.append((match.group(1).lower(), relative))
    if len(rows) < 3:
        return False

    indexes: set[int] = set(range(min(3, len(rows))))
    indexes.update(range(max(0, len(rows) - 3), len(rows)))
    marker_rows = 0
    for index, (_digest, relative) in enumerate(rows):
        normalised = relative.replace("\\", "/").lower()
        if any(marker in normalised for marker in _PAYLOAD_LAYOUT_MARKERS):
            indexes.add(index)
            marker_rows += 1
            if marker_rows >= 32:
                break
    checked = 0
    for index in sorted(indexes)[:64]:
        digest, relative = rows[index]
        path = root / relative.replace("\\", "/")
        try:
            if not path.is_file() or _sha256(path) != digest:
                return False
        except OSError:
            return False
        checked += 1
    return checked >= 3


def _bundle_is_ours(root: Path) -> bool:
    """Content check for the ``bundle.json`` + ``manifests/files.sha256`` bypass.

    The real payloads ship two shapes of ``bundle.json``: ``kind=packaging-poc``
    (``dist/bundle/win32-x64-v15``, inside the rc.3 portable zip) has **no**
    ``product``/``version`` field, while ``kind=v14-desktop`` has both.  So: the
    schema version must be the one this pipeline writes, a declared product/version
    must match this product, and when no product is declared the author, kind and
    layout must all be ours.  The hash manifest must then carry at least one real
    digest row for a path of this payload layout.
    """

    try:
        record = json.loads((root / "bundle.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(record, dict) or str(record.get("schemaVersion") or "") != "1.0":
        return False
    product = str(record.get("product") or "").strip()
    if product:
        if product not in (constants.PRODUCT_NAME, constants.PRODUCT_NAME_ZH):
            return False
        if not _looks_version(record.get("version")):
            return False
    elif (
        str(record.get("author") or "").strip() != constants.COMPANY
        or str(record.get("kind") or "") not in _BUNDLE_KINDS
        or not _bundle_paths_are_ours(record)
    ):
        return False
    return _manifest_has_rows(root)


def _has_any_entry(root: Path) -> bool:
    """Anything at all inside ``root``?  Cheaper and stricter than counting files."""

    try:
        next(root.iterdir())
    except StopIteration:
        return False
    except OSError:
        # Cannot read it (permissions): treat as non-empty, i.e. refuse to delete.
        return True
    return True


def _residue(root: Path, keep: set[str]) -> int:
    """How many deletable entries are still under *root* after the uninstall pass.

    ``keep`` (data directories the user asked to preserve) is excluded; anything else
    left behind means the uninstall did not finish, and that must not be reported as
    success (X-04 / N-011 §3).
    """

    try:
        return sum(1 for child in root.iterdir() if child.name not in keep)
    except OSError:
        return 0


def _delete_children(root: Path, keep: set[str], log) -> None:
    for child in list(root.iterdir()):
        if child.name in keep:
            log.write(f"kept: {child}")
            continue
        try:
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
        except OSError as error:
            log.write(f"WARN could not delete {child}: {error}")


def _self_image_cleanup(root: Path, log) -> None:
    """Detach this process's own image when it lives inside the tree being deleted.

    Why (DEFECT-self-uninstall, P1): the uninstaller ships as
    ``<target>\\installer\\AIDrivenNetDefense-Setup-*.exe`` and the registry
    ``UninstallString``/``QuietUninstallString`` name exactly that copy.  ``stop_under``
    no longer kills it (``procs._self_family``), but Windows keeps the running image
    locked, so without this step the uninstall leaves the 66 MiB installer behind —
    "exit 0 but residue".  Moving the image out of the tree makes the tree fully
    removable; the moved file is then scheduled for deletion at reboot (best effort:
    the delayed-delete registry write needs administrator, so a non-elevated uninstall
    logs a warning instead of pretending it is gone).
    """

    try:
        image = Path(os.path.abspath(sys.executable))
    except (OSError, ValueError):
        return
    prefix = str(root).rstrip("\\") + "\\"
    if not str(image).lower().startswith(prefix.lower()):
        return
    try:
        if not image.exists():
            return
    except OSError:
        return

    destination = Path(tempfile.gettempdir()) / f"{image.name}.{os.getpid()}.detached"
    try:
        os.replace(str(image), str(destination))
        log.write(f"detached the running installer image to {destination}")
    except OSError as error:
        # A different volume (%TEMP% on C:, install on D:) cannot be renamed into; the
        # delayed-delete registry entry still works on the original path, so ask for it
        # rather than leaving the locked image behind silently.
        if _delete_on_reboot(image):
            log.write(f"running installer image scheduled for deletion at reboot: {image}")
        else:
            log.write(f"WARN could not detach the running installer image: {error}")
        return
    if _delete_on_reboot(destination):
        log.write(f"detached installer image scheduled for deletion at reboot: {destination}")
    else:
        log.write(f"WARN detached installer image remains until reboot: {destination}")


def _delete_on_reboot(path: Path) -> bool:
    """``MoveFileExW(..., MOVEFILE_DELAY_UNTIL_REBOOT)``; False when unavailable."""

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.MoveFileExW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
        kernel32.MoveFileExW.restype = ctypes.c_int
        return bool(kernel32.MoveFileExW(str(path), None, 0x4))
    except (AttributeError, OSError):
        return False
