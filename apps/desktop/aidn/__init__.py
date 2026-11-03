"""aidn —— AIDriven NetDefense 桌面壳（作者 PT-dove）。

包内模块按职责分层，互不反向依赖：

- ``paths``    只回答「文件在哪」，不做 IO；
- ``settings`` 只读写 ``shell/settings.json``；
- ``daemon``   只管 daemon 子进程的生命周期；
- ``server``   只提供本地静态页 + 同源代理 + 少量壳管理接口；
- ``tray``     只负责通知区图标与菜单；
- ``app``      把上面拼起来，是唯一知道全部模块的类。
"""

__all__ = ["paths", "settings", "daemon", "server", "tray", "app"]

PRODUCT_NAME = "AIDriven NetDefense"
PRODUCT_NAME_CN = "网域智防"
AUTHOR = "PT-dove"
SHELL_VERSION = "0.0.1-rc.1"
