"""The window.

Design constraints, in priority order:

1. **Nothing happens on its own.**  The window opens on a path box and two checkboxes;
   no countdown, no automatic download, no auto-start of the install, and no program
   launched after it finishes.  A user who opens the installer and walks away comes
   back to an unchanged machine.
2. The path is the only required input, and an existing installation pre-fills it.
3. Every failure is shown as text the user can act on, not an exception dialog.
4. The UI thread never blocks: file work runs in a worker thread that posts progress
   back through a queue, so the window keeps painting during a 450 MiB copy.

Bilingual labels are one string each ("开始安装 / Install"), not two labels: the
product ships English-first with Chinese available, and a single line keeps the
layout stable in both cases.

Author: PT-dove
"""

from __future__ import annotations

import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from . import constants, install, paths, payload, procs, registry, selfinfo

TITLE = f"{constants.PRODUCT_NAME} Setup"


class InstallerWindow:
    def __init__(self, log) -> None:
        self.log = log
        self.result: install.Result | None = None
        self._queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self._busy = False

        self.version = selfinfo.product_version()
        self.existing = install.find_existing()

        self.root = tk.Tk()
        self.root.title(f"{TITLE} {self.version}")
        self.root.resizable(False, False)
        self._build()
        self._pump()

    # ------------------------------------------------------------ construction
    def _build(self) -> None:
        frame = ttk.Frame(self.root, padding=18)
        frame.grid(row=0, column=0, sticky="nsew")

        ttk.Label(frame, text=constants.PRODUCT_NAME, font=("Segoe UI", 15, "bold")).grid(
            row=0, column=0, columnspan=3, sticky="w"
        )
        ttk.Label(
            frame,
            text=f"版本 / version {self.version} · Windows x64 · 未签名（见安装说明） / unsigned (see INSTALL.txt)",
            foreground="#555555",
        ).grid(row=1, column=0, columnspan=3, sticky="w", pady=(2, 10))

        if self.existing:
            where, previous, _source = self.existing
            notice = (
                f"检测到已安装：{previous or '未知版本'}（{where}）\n"
                f"Already installed; this will upgrade in place and keep your data."
            )
            colour = "#0a5c2a"
        else:
            notice = "未检测到已安装版本，将执行全新安装。 / No existing installation; this is a fresh install."
            colour = "#555555"
        ttk.Label(frame, text=notice, foreground=colour, justify="left").grid(
            row=2, column=0, columnspan=3, sticky="w", pady=(0, 12)
        )

        ttk.Label(frame, text="安装路径 / Folder").grid(row=3, column=0, sticky="w")
        self.path_var = tk.StringVar(
            value=str(self.existing[0]) if self.existing else str(paths.default_target())
        )
        self.path_entry = ttk.Entry(frame, textvariable=self.path_var, width=58)
        self.path_entry.grid(row=4, column=0, columnspan=2, sticky="we", pady=(4, 0))
        self.browse_button = ttk.Button(frame, text="浏览… / Browse", command=self._browse)
        self.browse_button.grid(row=4, column=2, sticky="e", padx=(8, 0), pady=(4, 0))

        self.desktop_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(frame, text="创建桌面快捷方式 / Desktop shortcut", variable=self.desktop_var).grid(
            row=5, column=0, columnspan=2, sticky="w", pady=(10, 0)
        )

        self.autostart_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            frame,
            text="开机自动启动（可选，写入当前用户启动项） / Start with Windows (optional)",
            variable=self.autostart_var,
        ).grid(row=6, column=0, columnspan=2, sticky="w", pady=(4, 0))

        self.status = ttk.Label(frame, text="准备就绪。 / Ready.", width=64)
        self.status.grid(row=7, column=0, columnspan=3, sticky="w", pady=(14, 4))

        self.progress = ttk.Progressbar(frame, mode="indeterminate", length=520)
        self.progress.grid(row=8, column=0, columnspan=3, sticky="we")

        buttons = ttk.Frame(frame)
        buttons.grid(row=9, column=0, columnspan=3, sticky="e", pady=(14, 0))

        self.uninstall_button = ttk.Button(
            buttons, text="卸载 / Uninstall", command=self._uninstall, state="normal" if self.existing else "disabled"
        )
        self.uninstall_button.grid(row=0, column=0, padx=(0, 8))
        self.install_button = ttk.Button(buttons, text="开始安装 / Install", command=self._install)
        self.install_button.grid(row=0, column=1, padx=(0, 8))
        ttk.Button(buttons, text="关闭 / Close", command=self.root.destroy).grid(row=0, column=2)

        self.log.add_listener(self._status_from_log)

    # ------------------------------------------------------------ helpers
    def _browse(self) -> None:
        chosen = filedialog.askdirectory(initialdir=self.path_var.get() or str(paths.default_target()))
        if chosen:
            self.path_var.set(chosen)

    def _status_from_log(self, message: str) -> None:
        self._queue.put(("status", message))

    def _pump(self) -> None:
        try:
            while True:
                kind, value = self._queue.get_nowait()
                if kind == "status":
                    self.status.configure(text=str(value)[:180])
                elif kind == "done":
                    self._finish(value)
        except queue.Empty:
            pass
        self.root.after(80, self._pump)

    def _set_busy(self, busy: bool) -> None:
        self._busy = busy
        state = "disabled" if busy else "normal"
        self.install_button.configure(state=state)
        self.browse_button.configure(state=state)
        self.path_entry.configure(state=state)
        if busy:
            self.progress.start(12)
        else:
            self.progress.stop()
        self.uninstall_button.configure(state="disabled" if busy or not self.existing else "normal")

    def _options(self) -> install.Options:
        return install.Options(
            target=paths.normalise(self.path_var.get()),
            desktop_shortcut=self.desktop_var.get(),
            create_shortcuts=True,
            autostart=self.autostart_var.get(),
            write_registry=True,
        )

    # ------------------------------------------------------------ actions
    def _install(self) -> None:
        if self._busy:
            return
        options = self._options()
        reason = paths.validate_target(str(options.target))
        if reason:
            messagebox.showerror(TITLE, reason)
            return
        self._set_busy(True)
        threading.Thread(target=self._run_install, args=(options,), daemon=True).start()

    def _run_install(self, options: install.Options) -> None:
        try:
            result = install.install(options, self.log)
            self._queue.put(("done", result))
        except Exception as error:  # surfaced to the user, never swallowed
            self.log.error(str(error))
            self._queue.put(("done", error))

    def _uninstall(self) -> None:
        if self._busy:
            return
        target = paths.normalise(self.path_var.get())
        keep = messagebox.askyesnocancel(
            "确认卸载 / Confirm uninstall",
            f"将卸载：{target}\n\n是否保留数据目录（data\\）？\n选「否」将全部删除。\n\n"
            "Keep your data folder? Choose No to delete everything.",
        )
        if keep is None:
            return
        self._set_busy(True)
        options = install.Options(target=target, keep_data=bool(keep), write_registry=True)
        threading.Thread(target=self._run_uninstall, args=(options,), daemon=True).start()

    def _run_uninstall(self, options: install.Options) -> None:
        try:
            result = install.uninstall(options, self.log)
            self._queue.put(("done", result))
        except Exception as error:
            self.log.error(str(error))
            self._queue.put(("done", error))

    def _finish(self, outcome: object) -> None:
        self._set_busy(False)
        if isinstance(outcome, Exception):
            self.status.configure(text="操作失败。 / Failed.")
            messagebox.showerror(
                "失败 / Failed",
                f"{outcome}\n\n日志 / log: {self.log.path}",
            )
            return

        assert isinstance(outcome, install.Result)
        self.result = outcome
        self.existing = install.find_existing()
        lines = [outcome.message, "", f"路径 / folder: {outcome.target}"]
        if outcome.entry:
            lines.append(f"入口 / entry: {outcome.entry}")
        lines.append(f"日志 / log: {self.log.path}")
        if outcome.shortcut_problems:
            lines.append("")
            lines.append("快捷方式未能全部创建 / some shortcuts failed:")
            lines.extend(f"  - {item}" for item in outcome.shortcut_problems[:4])
        self.status.configure(text=outcome.message[:180])
        messagebox.showinfo("完成 / Done", "\n".join(lines))

    def run(self) -> int:
        self.root.mainloop()
        return constants.EXIT_OK


def run_window(log) -> int:
    try:
        return InstallerWindow(log).run()
    except tk.TclError as error:
        log.error(f"GUI unavailable: {error}")
        return constants.EXIT_ERROR
