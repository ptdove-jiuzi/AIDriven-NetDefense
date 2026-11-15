"""The installer-built ownership credential (RC5-N01).

Why this module exists: the uninstaller is the only code path that recursively deletes a
user directory, and until RC5 its proof of ownership was *content the directory itself
could supply* — an ``install.json`` with the right identity fields plus a
``manifests/files.sha256`` whose digests matched the files next to it.  Re-attack RC4
showed that an attacker with write access to the target simply writes both (three
arbitrary files and their real digests) and both channels then delete the whole tree
(``reviews/REATTACK-RC4.md`` §2.2/§2.3, py-16/py-17/ps-14/ps-15).  Consistency is not
ownership.

What replaces it: at install time the installer issues a credential that binds

* the product and the channel,
* the version,
* the canonical target path (so a copied tree does not travel with its credential),
* a random ``installId``,
* the SHA-256 of the payload hash manifest (so the credential is tied to the bytes that
  were installed, not to whatever manifest sits there later),

with an HMAC-SHA256 under a 32-byte key compiled into the installer.  Uninstall
recomputes the token with the path it is about to delete and compares it in constant
time.  ``Setup.ps1`` carries the same key, the same message layout and the same
normalisation rules, so a tree installed by one entry point is removable by the other.

The message is exactly these lines joined with ``\\n`` (UTF-8, no trailing newline)::

    aidn-ownership-v1
    <product>
    <channel>
    <version>
    <canonical target path>
    <installId>
    <payloadDigest>

Notes for anyone changing this file:

* the key must stay byte-identical to ``$script:OwnershipKeyHex`` in ``Setup.ps1``;
  the key itself is *not* a secret against someone holding the installer binary — it
  proves "issued by our installer", which is the property the gate needs.  It is not
  read from the environment or from a file, so an attacker who can only write inside
  the target directory cannot obtain it;
* ``canonical_path`` uses ``normcase(abspath(...))`` on purpose — **not** ``realpath``:
  resolving links would let a junction change what the credential refers to, and it
  must match PowerShell's ``[System.IO.Path]::GetFullPath()`` semantics;
* the payload digest is the digest of the manifest *file*, or the empty string when the
  tree has none.  Both are written into the record and into the signed message.

Author: PT-dove
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import uuid
from pathlib import Path

from . import constants

#: Credential schema name; written into ``install.json.ownership.scheme``.
SCHEME = "hmac-sha256-v1"

#: First line of the signed message.  Changing it invalidates every issued credential.
MESSAGE_HEADER = "aidn-ownership-v1"

#: 32-byte key, hex-encoded.  Must equal ``$script:OwnershipKeyHex`` in ``Setup.ps1``.
#: Recorded in ``docs/implementation/status/FIX-INST-RC5.md`` by its SHA-256.
KEY_HEX = "150dbfb01ae656aef2cff09692e9441e47f7dd42b084f1e61ee67b54eaf5fc23"
KEY = bytes.fromhex(KEY_HEX)

_INSTALL_ID_RE = re.compile(r"[0-9a-f]{32}")
_HEX64_RE = re.compile(r"[0-9a-f]{64}")

#: Percent-independent path of the payload hash manifest inside a tree.
MANIFEST_RELATIVE = Path("manifests") / "files.sha256"


def canonical_path(value: str | Path) -> str:
    """The one spelling of *value* both channels sign: absolute, lowercase, ``\\``.

    ``normcase(abspath(...))`` lowercases and normalises separators on Windows exactly
    like ``GetFullPath(...).ToLowerInvariant().Replace('/','\\')``; the trailing
    separator is removed because ``C:\\x`` and ``C:\\x\\`` are the same directory.
    """

    return os.path.normcase(os.path.abspath(str(value))).rstrip("\\")


def payload_digest(root: str | Path) -> str:
    """SHA-256 of ``<root>\\manifests\\files.sha256``; ``""`` when the file is absent."""

    path = Path(root) / MANIFEST_RELATIVE
    try:
        data = path.read_bytes()
    except OSError:
        return ""
    return hashlib.sha256(data).hexdigest()


def message(
    *,
    product: str,
    channel: str,
    version: str,
    target: str | Path,
    install_id: str,
    digest: str,
) -> bytes:
    """The exact bytes that get signed.  Keep in step with ``New-OwnershipMessage``."""

    lines = [
        MESSAGE_HEADER,
        str(product),
        str(channel),
        str(version),
        canonical_path(target),
        str(install_id),
        str(digest),
    ]
    return "\n".join(lines).encode("utf-8")


def sign(payload: bytes, key: bytes = KEY) -> str:
    """Lowercase hex HMAC-SHA256 of *payload* under *key*."""

    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def new_install_id() -> str:
    """A fresh 32-character lowercase hex identifier."""

    return uuid.uuid4().hex


def issue(
    root: str | Path,
    *,
    channel: str,
    version: str,
    product: str = constants.PRODUCT_NAME,
    install_id: str | None = None,
) -> dict[str, str]:
    """Build the ``install.json.ownership`` block for the tree at *root*."""

    identifier = install_id or new_install_id()
    digest = payload_digest(root)
    token = sign(
        message(
            product=product,
            channel=channel,
            version=version,
            target=root,
            install_id=identifier,
            digest=digest,
        )
    )
    return {
        "scheme": SCHEME,
        "installId": identifier,
        "payloadDigest": digest,
        "token": token,
    }


def verify(record: dict, root: str | Path) -> tuple[bool, str]:
    """Check *record*'s credential against the tree at *root*.

    Returns ``(True, "")`` or ``(False, reason)`` where *reason* is a short stable code
    (``missing`` / ``scheme`` / ``install-id`` / ``token-shape`` /
    ``payload-digest-shape`` / ``payload-digest`` / ``token-mismatch``) so the caller can
    say *which* part failed without inventing text here.

    The token is recomputed with the **target path**, never with the ``installPath``
    stored in the record: otherwise a copied tree would carry its own authorisation.
    """

    block = record.get("ownership") if isinstance(record, dict) else None
    if not isinstance(block, dict):
        return False, "missing"

    if str(block.get("scheme") or "").strip() != SCHEME:
        return False, "scheme"

    install_id = str(block.get("installId") or "").strip()
    if _INSTALL_ID_RE.fullmatch(install_id) is None:
        return False, "install-id"

    token = str(block.get("token") or "").strip()
    if _HEX64_RE.fullmatch(token) is None:
        return False, "token-shape"

    recorded_digest = str(block.get("payloadDigest") or "").strip()
    if recorded_digest and _HEX64_RE.fullmatch(recorded_digest) is None:
        return False, "payload-digest-shape"

    # Double binding: the credential names a digest, and that digest must be the one the
    # manifest on disk has *now*.  This is what makes "replace the manifest" a refusal
    # instead of an alternative way of passing.
    disk_digest = payload_digest(root)
    if recorded_digest != disk_digest:
        return False, "payload-digest"

    expected = sign(
        message(
            product=constants.PRODUCT_NAME,
            channel=str(record.get("channel") or "").strip(),
            version=str(record.get("version") or "").strip(),
            target=root,
            install_id=install_id,
            digest=disk_digest,
        )
    )
    if not hmac.compare_digest(expected, token):
        return False, "token-mismatch"
    return True, ""
