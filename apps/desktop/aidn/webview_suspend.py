"""webview_suspend.py —— 让内嵌 WebView2 在窗口收起时**真正停下来**（作者 PT-dove）。

为什么要这个文件（PERF-CPU 战役、prof-shell 实测，证据在
`docs/implementation/evidence/perf/prof-shell/`）：

1. 壳的「关窗口」不是销毁，而是 `hide()` 到托盘（`aidn/app.py::_on_closing` 返回 False）；
   隐藏之后 WebView2 的 browser / renderer / gpu / utility 进程全都还在。
2. 隐藏页的前端定时器仍在跑：`webui/app.js:562-569` 的递归 `setTimeout` 实测每 **5.2 s**
   触发一次（标称 3000 ms，隐藏态被 Chromium 节流），每次都要唤醒 renderer。
3. pywebview 5.4 没有公开的「挂起」API，但底层 .NET 栈就是 WebView2 SDK
   1.0.2957.106，`CoreWebView2` 上有 `TrySuspendAsync()` / `Resume()` / `IsSuspended`
   （ICoreWebView2_3；反射证据 `evidence/perf/prof-shell/raw/probe_trysuspend.txt`）。
   拿实例的唯一路径是 pywebview 的私有表
   `webview.platforms.winforms.BrowserView.instances[uid].browser.webview.CoreWebView2`。

设计约束（每条都来自一次真踩坑，别简化掉）：

- **必须在 WinForms UI 线程调用**：CoreWebView2 的所有成员都带线程亲和性，从后台线程直接
  调会抛 `InvalidOperationException`（RPC_E_WRONG_THREAD）。统一用 `form.Invoke(...)` 兜过去。
- **失败只降级，不抛**：窗口/引擎可能还没初始化完、正在导航、被 DevTools 占用。挂起是节能
  优化，不是功能前置条件 —— 拿不到实例、抛异常、引擎返回 false，一律返回 `ok=False` + 原因，
  由调用方记一条日志就完事。
- **幂等**：已经挂起时再 suspend 直接返回；没挂起时 resume 不报错。
- **只在窗口确实不可见时挂起**：由调用方（`app.py`）判断，这里不猜。
"""
from __future__ import annotations

import logging
import time

log = logging.getLogger("aidn.webview")

DEFAULT_UID = "master"
#: TrySuspendAsync 完成等待上限（毫秒）。超过就按「没挂上」处理，不阻塞窗口线程。
SUSPEND_WAIT_MS = 3000


def backend_form(uid: str = DEFAULT_UID):
    """返回 (BrowserForm, 原因)。BrowserForm 上挂着 .browser(EdgeChrome) 与 .webview。

    这是 pywebview 的私有结构，所以每一步都可能不存在 —— 版本升级、后端换成 mshtml/cef、
    窗口还没创建，都会在这里变成一句可读的原因，而不是异常。
    """
    try:
        from webview.platforms import winforms  # type: ignore[import-not-found]
    except Exception as error:  # noqa: BLE001
        return None, f"pywebview 的 winforms 后端不可用：{error}"
    instances = getattr(getattr(winforms, "BrowserView", None), "instances", None)
    if not instances:
        return None, "BrowserView.instances 不可用（pywebview 版本变化？）"
    form = instances.get(uid)
    if form is None:
        return None, f"BrowserView.instances 里没有 uid={uid}"
    return form, ""


def _core_on_ui(form):
    """**在 UI 线程上**取 CoreWebView2 实例：(实例, 原因)。

    为什么不能在调用线程直接读 `widget.CoreWebView2`：WinForms 控件层的 getter 自己会
    检查线程亲和性，后台线程访问抛
    `InvalidCastException: CoreWebView2 can only be accessed from the UI thread`
    （实测：evidence/perf/fix-shell/raw/*.log 里的 wvstatus 回执）。
    所以取实例这一步也必须走 `_invoke`。
    """
    browser = getattr(form, "browser", None)
    widget = getattr(browser, "webview", None)
    if widget is None:
        return None, "浏览器控件未就绪（browser.webview 为空）"
    ok, core, why = _invoke(form, lambda: widget.CoreWebView2)
    if not ok:
        return None, f"CoreWebView2 取不到：{why}"
    if core is None:
        return None, "CoreWebView2 尚未初始化（引擎还在初始化/导航中）"
    return core, ""


def _invoke(form, callback):
    """把 callback 兜到 WinForms UI 线程执行，返回 (ok, value, 原因)。"""
    try:
        from System import Func, Type  # type: ignore[import-not-found]
    except Exception as error:  # noqa: BLE001
        return False, None, f"CLR 不可用：{error}"
    box: dict = {}

    def run():
        try:
            box["value"] = callback()
            box["ok"] = True
        except Exception as error:  # noqa: BLE001
            box["error"] = str(error)
        return None

    try:
        form.Invoke(Func[Type](run))
    except Exception as error:  # noqa: BLE001
        return False, None, f"Invoke 到 UI 线程失败：{error}"
    if box.get("ok"):
        return True, box.get("value"), ""
    return False, None, box.get("error") or "UI 线程调用未返回结果"


def status(window=None) -> dict:
    """读当前挂起状态。拿不到实例时 `{"ok": False, "reason": ...}`。"""
    uid = getattr(window, "uid", DEFAULT_UID) or DEFAULT_UID
    form, why = backend_form(uid)
    if form is None:
        return {"ok": False, "reason": why}
    core, why = _core_on_ui(form)
    if core is None:
        return {"ok": False, "reason": why}
    ok, value, error = _invoke(form, lambda: bool(core.IsSuspended))
    if not ok:
        return {"ok": False, "reason": error}
    return {"ok": True, "suspended": value}


def suspend(window=None, should_continue=None, attempts: int = 1, delay: float = 0.0) -> dict:
    """尝试挂起 WebView2。返回 {ok, suspended, reason, attempts}；**从不抛异常**。

    `attempts` / `delay` 是给「窗口刚隐藏、页面还在加载/导航」用的：TrySuspendAsync 在导航
    进行中会失败，而隐藏是瞬间完成的，所以要允许重试。`should_continue()` 每次重试前调用，
    返回 False 就立刻放弃（例如用户又把窗口点开了）。
    """
    uid = getattr(window, "uid", DEFAULT_UID) or DEFAULT_UID
    result = {"ok": False, "suspended": False, "reason": "", "attempts": 0}
    total = max(1, int(attempts))
    for attempt in range(1, total + 1):
        result["attempts"] = attempt
        if should_continue is not None and not should_continue():
            result["reason"] = "窗口已重新可见，放弃挂起"
            return result

        form, why = backend_form(uid)
        if form is None:
            result["reason"] = why
        else:
            core, why = _core_on_ui(form)
            if core is None:
                result["reason"] = why
            else:
                ok, already, error = _invoke(form, lambda: bool(core.IsSuspended))
                if not ok:
                    result["reason"] = error
                elif already:
                    result.update(ok=True, suspended=True, reason="已经处于挂起状态")
                    return result
                else:
                    ok, task, error = _invoke(form, lambda: core.TrySuspendAsync())
                    if not ok:
                        result["reason"] = f"TrySuspendAsync 调用失败：{error}"
                    else:
                        succeeded = _await_flag(task)
                        ok2, suspended, error2 = _invoke(form, lambda: bool(core.IsSuspended))
                        if not ok2:
                            result["reason"] = error2
                        elif suspended:
                            result.update(ok=True, suspended=True, mode="trysuspend", reason="已挂起")
                            return result
                        else:
                            # 兜底二路：CDP 冻结页面生命周期。TrySuspend 在「页面仍认为可见」
                            # 时可能返回 False（实测 hide() 不会触发 visibilitychange），而
                            # setWebLifecycleState=frozen 直接把 JS 定时器与渲染停掉。
                            frozen = _freeze_via_cdp(form, core)
                            if frozen:
                                result.update(ok=True, suspended=True, mode="cdp-frozen",
                                              reason="TrySuspend 未生效，已用 CDP 冻结页面")
                                return result
                            result["reason"] = (
                                "TrySuspendAsync 返回 False（引擎未就绪/正在导航/被占用）"
                                if succeeded is False
                                else "调用后 IsSuspended 仍为 False"
                            )
        if attempt < total and delay > 0:
            time.sleep(delay)
    return result


def resume(window=None) -> dict:
    """恢复渲染。**从不抛异常**；没挂起时也返回 ok=True。"""
    uid = getattr(window, "uid", DEFAULT_UID) or DEFAULT_UID
    form, why = backend_form(uid)
    if form is None:
        return {"ok": False, "reason": why}
    core, why = _core_on_ui(form)
    if core is None:
        return {"ok": False, "reason": why}
    ok, suspended, error = _invoke(form, lambda: bool(core.IsSuspended))
    if not ok:
        return {"ok": False, "reason": error}
    if not suspended:
        # IsSuspended=False 也可能走了 CDP 冻结的兜底路径：解冻 + 重载一次把页面救回来。
        # （冻结后页面不会自己恢复执行脚本 —— 实测重开后 shell CPU 归零、evaluate_js 一直等
        #  不到回调，见 evidence/perf/fix-shell/raw/REOPEN4*；重载是唯一可靠的复活方式，
        #  代价是同源页面重新加载一次，百毫秒级，用户看到的是正常页面而不是白屏。）
        ok2, why2 = _thaw_and_reload(form, core)
        if not ok2:
            return {"ok": False, "resumed": False, "reason": why2}
        return {"ok": True, "resumed": True, "mode": "thaw+reload",
                "reason": "页面已解冻并重载，恢复正常执行"}
    ok, _value, error = _invoke(form, lambda: core.Resume())
    _thaw_via_cdp(form, core)
    if not ok:
        return {"ok": False, "reason": f"Resume 调用失败：{error}"}
    return {"ok": True, "resumed": True, "reason": "已恢复渲染"}


def _thaw_and_reload(form, core) -> tuple[bool, str]:
    """解冻 + 重载页面：CDP 冻结后页面不会自己恢复执行脚本，重载是可靠的复活方式。"""
    thawed, _value, _why = _invoke(
        form,
        lambda: core.CallDevToolsProtocolMethodAsync(
            "Page.setWebLifecycleState", '{"state":"active"}'
        ),
    )
    reload_ok, _value2, why2 = _invoke(form, lambda: core.Reload())
    if not reload_ok:
        return False, f"页面重载失败：{why2}"
    return True, "" if thawed else "解冻调用未成功，已用重载恢复"


def _freeze_via_cdp(form, core) -> bool:
    """`Page.setWebLifecycleState=frozen`：停掉页面的 JS 定时器与出帧。失败返回 False。

    `AIDN_NO_CDP_FREEZE=1` 专门用于变异验证：关掉这一路（外壳 hide() 之后 WebView2 仍认为
    页面可见，`TrySuspendAsync` 实测返回 False，所以**真正生效的是这一路**）。
    """
    import os

    if os.environ.get("AIDN_NO_CDP_FREEZE") == "1":
        return False
    ok, _value, _error = _invoke(
        form,
        lambda: core.CallDevToolsProtocolMethodAsync(
            "Page.setWebLifecycleState", '{"state":"frozen"}'
        ),
    )
    return bool(ok)


def _thaw_via_cdp(form, core) -> None:
    """把页面生命周期恢复成 active；失败静默（显示窗口之后引擎自己也会恢复）。"""
    _invoke(
        form,
        lambda: core.CallDevToolsProtocolMethodAsync(
            "Page.setWebLifecycleState", '{"state":"active"}'
        ),
    )


def _await_flag(task) -> bool | None:
    """等 .NET Task<bool> 完成，返回其结果；拿不到结果返回 None。"""
    if task is None:
        return None
    try:
        wait = getattr(task, "Wait", None)
        if callable(wait):
            wait(SUSPEND_WAIT_MS)
        if not getattr(task, "IsCompleted", False):
            return None
        return bool(task.Result)
    except Exception as error:  # noqa: BLE001
        log.debug("等待 TrySuspendAsync 结果失败：%s", error)
        return None


