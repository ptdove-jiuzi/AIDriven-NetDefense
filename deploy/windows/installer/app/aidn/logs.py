"""Logging that works in a windowed (``--noconsole``) executable.

A windowed PyInstaller build has no ``sys.stdout``: ``print()`` raises
``AttributeError`` and an installer that dies on its own progress message is worse
than one that says nothing.  Every message therefore goes to the log file first,
and to stdout only when a stream actually exists (console mode, or a developer
running ``python main.py``).

Author: PT-dove
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from typing import Callable

_Listener = Callable[[str], None]


class Logger:
    """Append-only log file plus optional in-process listeners (the GUI status line)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._listeners: list[_Listener] = []
        self._handle = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = path.open("a", encoding="utf-8", newline="\n")
        except OSError:
            # A read-only temp directory is not a reason to refuse to install;
            # the installer still works, it just leaves no trail.
            self._handle = None

    def add_listener(self, listener: _Listener) -> None:
        self._listeners.append(listener)

    def step(self, message: str) -> None:
        """Progress message: shown in the UI *and* logged."""

        self.write(message)
        for listener in list(self._listeners):
            try:
                listener(message)
            except Exception:  # a broken UI callback must not abort an install
                pass

    def write(self, message: str) -> None:
        line = f"{datetime.now().strftime('%H:%M:%S')}  {message}"
        if self._handle is not None:
            try:
                self._handle.write(line + "\n")
                self._handle.flush()
            except OSError:
                self._handle = None
        stream = sys.stdout
        if stream is not None:
            try:
                stream.write(line + "\n")
                stream.flush()
            except (OSError, ValueError):
                pass

    def error(self, message: str) -> None:
        self.write("ERROR  " + message)
        stream = sys.stderr
        if stream is not None:
            try:
                stream.write(message + "\n")
                stream.flush()
            except (OSError, ValueError):
                pass

    def close(self) -> None:
        if self._handle is not None:
            try:
                self._handle.close()
            finally:
                self._handle = None

    def __enter__(self) -> "Logger":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()
