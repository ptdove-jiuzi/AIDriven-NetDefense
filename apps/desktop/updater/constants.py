"""constants.py —— 更新源常量：编译期写死，配置文件与环境变量都改不动。

ADR-0011 §2 的决定：owner/repo 硬编码进二进制。理由不是省事，而是安全边界——
更新源一旦可配置，任何能改配置的人都能把更新指向自己的服务器，自动更新就变成
远程代码执行。仓库地址属于发布者身份，不属于用户设置。

因此本模块**不读环境变量、不读配置文件**：这里是唯一的事实来源。让更新指向别处的
唯一办法是改这份源码并重新打包，那已经换了一个发布者，不再是「配置」。
"""

from __future__ import annotations

#: GitHub owner。由 DIST-DECISION §5 D3 指定，不得由配置覆盖。
UPDATE_REPO_OWNER = "ptdove-jiuzi"

#: GitHub 仓库名。同上。
#: ACTIVE-NOTICE N-001：仓库名是 ``AIDriven-NetDefense``（``AI``/``Net`` 大写），
#: 大小写敏感，旧的小写名只由 GitHub 做 301，不得再写进常量。
UPDATE_REPO_NAME = "AIDriven-NetDefense"

#: 总开关：0 = 关闭（默认）；1 = 打开。
#: 关闭时不显示任何更新入口，更新器不发一个字节的网络请求（ADR-0011 §7）。
#: 打开条件：仓库公开 + 产出第一个带 latest.json 的 Release —— 之后**只改这一行**。
AUTO_UPDATE_ENABLED = 0

#: 清单里所有 URL 必须带这个前缀，否则视为「指向别的仓库」而拒绝。
UPDATE_REPO_PATH = f"/{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}/"

#: 清单地址。固定指向 latest release 的 latest.json，不跟随机跳转。
LATEST_MANIFEST_URL = (
    f"https://github.com/{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}/releases/latest/download/latest.json"
)

#: 给人看的发布页（设置页「打不开就手动去看」的兜底入口）。
RELEASE_PAGE_URL = f"https://github.com/{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}/releases"

#: 允许的主机白名单。
#: - github.com：路径必须带 UPDATE_REPO_PATH；
#: - CDN 主机：GitHub 的 asset 下载会 302 到这里，只发 blob，按主机放行。
ALLOWED_HOSTS = (
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
)

#: 只发 blob 的 CDN 主机（不做仓库路径前缀检查）。
CDN_HOSTS = ALLOWED_HOSTS[1:]

#: 只接受 https；http 一律拒绝（ADR-0011 §3.4）。
REQUIRED_SCHEME = "https"

#: 启动后多久做第一次检查（秒）。不在窗口起来的瞬间抢带宽。
STARTUP_DELAY_S = 30

#: 两次检查的最小间隔（秒）。ETag 缓存与这个窗口配合：窗口内不发请求。
CHECK_INTERVAL_S = 24 * 60 * 60

#: 新版启动后的健康检查预算（秒）。超时即回滚，用户最多看到 30 秒的等待。
HEALTH_TIMEOUT_S = 30.0

#: 健康检查轮询间隔（秒）。
HEALTH_POLL_S = 0.5

#: 更新包下载上限（字节）。超过即中止并删除半包，避免被塞一个无底洞。
MAX_ASSET_BYTES = 512 * 1024 * 1024

#: 解压后总字节上限（防 zip 炸弹）。
MAX_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024

#: 解压后条目数上限。
MAX_EXTRACT_ENTRIES = 200_000

#: 便携包的 zip 后缀。多平台之后它**不再是**「唯一载荷」的判据，
#: 真正的选择规则在 ``assets.py``（安装版选 Setup.exe、linux 选 deb/tar.gz）。
#: 这里保留是因为便携包的自更新载荷仍然是这一份 zip（DIST-DECISION §1）。
UPDATE_ASSET_SUFFIX = "-portable.zip"

#: 保留几个历史版本（含当前版本）。ADR-0011 §4：最多留 2 份。
KEEP_VERSIONS = 2

#: 健康标记文件名。新版启动自检通过后由启动流程写入，回滚判定读它。
HEALTH_MARKER = ".healthy"


def auto_update_enabled() -> bool:
    """开关的布尔读法。唯一的判断口，避免各处各写一遍 ``== 1``。"""
    return AUTO_UPDATE_ENABLED == 1


def release_url_for(asset_name: str) -> str:
    """把 asset 名拼成固定仓库下的下载地址。"""
    return f"https://github.com/{UPDATE_REPO_OWNER}/{UPDATE_REPO_NAME}/releases/latest/download/{asset_name}"
