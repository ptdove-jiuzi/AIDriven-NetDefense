"""net.py —— 更新器的 HTTP 层：只走 https、只走白名单主机、不走系统代理。

三条硬约束来自 ADR-0011 §3：

1. 拒绝 ``http://``；
2. 拒绝跳到白名单之外的域（GitHub 的 asset 下载会 302 到 CDN，那是白名单内的）；
3. 忽略系统代理——和 model-broker 同口径。代理是用户机器上的中间人，更新包的
   完整性靠 sha256 兜底，但「谁在中间转了一手」不该由代理决定。

传输层抽成 ``Transport`` 协议，是为了让测试能确定性地模拟断网、限流、半包、
篡改，而不必真的去连 GitHub。生产代码永远只用 ``UrllibTransport``。
"""

from __future__ import annotations

import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from . import constants
from .errors import AssetRejected, ManifestUntrusted, NetworkUnavailable, RateLimited

#: 单次读写的块大小。
CHUNK = 256 * 1024

#: 默认超时（秒）。下载会单独给更长的值。
DEFAULT_TIMEOUT_S = 20.0
DOWNLOAD_TIMEOUT_S = 60.0

USER_AGENT = f"AIDrivenNetDefense-Updater/{constants.UPDATE_REPO_NAME}"


@dataclass
class Response:
    """一次 HTTP 结果。``body`` 永远是完整字节，流式下载走 ``download``。"""

    status: int
    headers: dict
    body: bytes = b""
    url: str = ""

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def header(self, name: str, default: str = "") -> str:
        return self.headers.get(name.lower(), default)


class Transport(Protocol):
    """更新器需要的两个动作：拿清单、下大文件。"""

    def get(self, url: str, headers: dict | None = None, *, timeout: float = DEFAULT_TIMEOUT_S) -> Response:
        ...

    def download(
        self,
        url: str,
        dest: Path,
        headers: dict | None = None,
        *,
        timeout: float = DOWNLOAD_TIMEOUT_S,
        max_bytes: int = constants.MAX_ASSET_BYTES,
    ) -> Response:
        ...


# --------------------------------------------------------------------- 地址校验


def host_of(url: str) -> str:
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def is_allowed_url(url: str) -> bool:
    """URL 是否指向本仓库（或其 CDN）。

    规则刻意严格：github.com 上的路径必须带 ``/<owner>/<repo>/``，否则就是把
    「同一个域名下的另一个仓库」当成了自己的更新源。
    """
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if parts.scheme != constants.REQUIRED_SCHEME:
        return False
    host = (parts.hostname or "").lower()
    if host not in constants.ALLOWED_HOSTS:
        return False
    if host in constants.CDN_HOSTS:
        return True
    return parts.path.startswith(constants.UPDATE_REPO_PATH)


def require_allowed_url(url: str, what: str = "地址") -> None:
    """不合规就抛 ``ManifestUntrusted``，带上被拒的地址。"""
    if not is_allowed_url(url):
        raise ManifestUntrusted(
            f"{what}不在本仓库范围内，已拒绝：{url}",
            detail={"url": url, "host": host_of(url)},
        )


# ------------------------------------------------------------------ 真实传输层


class _AllowlistedRedirect(urllib.request.HTTPRedirectHandler):
    """只跟随白名单内的 https 跳转，其余一律拒绝。

    GitHub 的 release asset 下载必然 302 到 ``objects.githubusercontent.com``，
    所以「不跟跳转」在生产环境等于「永远下不到包」。这里的取舍是：跳转必须
    落在白名单主机上，且不允许降到 http。
    """

    max_redirections = 4

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001 - 标准库签名
        target = urllib.parse.urljoin(req.full_url, newurl)
        if not is_allowed_url(target):
            raise ManifestUntrusted(
                f"更新源试图跳到白名单之外的地址，已拒绝：{target}",
                detail={"from": req.full_url, "to": target},
            )
        return super().redirect_request(req, fp, code, msg, headers, target)


class UrllibTransport:
    """基于 ``urllib`` 的实现：无代理、校验跳转、流式落盘。"""

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.timeout = timeout
        # ProxyHandler({}) = 显式不读 http_proxy/https_proxy，避免内网/代理劫持更新源。
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _AllowlistedRedirect(),
            urllib.request.HTTPSHandler(),
        )

    # -- 内部：把 urllib 的异常翻译成更新器的失败分类
    def _open(self, request: urllib.request.Request, timeout: float):
        try:
            return self._opener.open(request, timeout=timeout)
        except ManifestUntrusted:
            raise
        except urllib.error.HTTPError as error:
            if error.code == 429:
                raise RateLimited(
                    "更新检查被 GitHub 限流，下次再试",
                    retry_after_s=_retry_after(error.headers),
                ) from error
            if error.code in (403, 401):
                remaining = (error.headers or {}).get("x-ratelimit-remaining")
                if str(remaining) == "0":
                    raise RateLimited("GitHub 接口额度已用尽，下次再试") from error
            raise
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise NetworkUnavailable(f"连不上更新源：{error}") from error

    def get(self, url: str, headers: dict | None = None, *, timeout: float = DEFAULT_TIMEOUT_S) -> Response:
        require_allowed_url(url, "清单地址")
        request = urllib.request.Request(url, headers={"user-agent": USER_AGENT, **(headers or {})})
        try:
            with self._open(request, timeout) as raw:
                body = raw.read()
                return Response(
                    status=int(getattr(raw, "status", 200)),
                    headers={k.lower(): v for k, v in raw.headers.items()},
                    body=body,
                    url=raw.geturl(),
                )
        except urllib.error.HTTPError as error:  # 403/404 等非限流错误：原样交给上层
            return Response(
                status=int(error.code),
                headers={k.lower(): v for k, v in (error.headers or {}).items()},
                body=b"",
                url=url,
            )

    def download(
        self,
        url: str,
        dest: Path,
        headers: dict | None = None,
        *,
        timeout: float = DOWNLOAD_TIMEOUT_S,
        max_bytes: int = constants.MAX_ASSET_BYTES,
    ) -> Response:
        require_allowed_url(url, "更新包地址")
        request = urllib.request.Request(url, headers={"user-agent": USER_AGENT, **(headers or {})})
        dest.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        try:
            with self._open(request, timeout) as raw, open(dest, "wb") as sink:
                while True:
                    chunk = raw.read(CHUNK)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > max_bytes:
                        raise AssetRejected(
                            f"更新包超过体积上限（{max_bytes} 字节），已中止",
                            detail={"url": url, "limit": max_bytes},
                        )
                    sink.write(chunk)
                sink.flush()
                return Response(
                    status=int(getattr(raw, "status", 200)),
                    headers={k.lower(): v for k, v in raw.headers.items()},
                    body=b"",
                    url=raw.geturl(),
                )
        except BaseException:
            # 半包必须清掉：留着它，下次「续传」的假设会让哈希校验永远失败。
            _discard(dest)
            raise


def _retry_after(headers) -> float | None:  # noqa: ANN001
    try:
        value = (headers or {}).get("retry-after")
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass
