#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tcp_monitor_r2.py —— 进程外 OS 层 netstat 监视器（**python 实现**，与 round-2 Lead 的 pwsh 版同口径）。

为什么不用 pwsh 版：本轮实测 pwsh 运行时自身会向 `20.50.88.x:443` 发起后台连接（窗口-1/2 各留下
20/6 条 pwsh 记录），会污染"本席进程有没有外联"的归因。python 监视器只调 `netstat -ano`，
自身不发起任何网络连接，因此"监视器进程本身"不会制造记录。

口径（与 `evidence/updater/r2/lead/tcp-monitor.ps1` 一致）：
  * 每秒采一次 `netstat -ano`，只记 **非 loopback 远端** 的 TCP 行；
  * 按 (local, remote, pid) 去重，避免同一连接被反复计数；
  * 每 60 次采样写一条 heartbeat，证明监视器活着；
  * 收到 stop 文件或到 max-seconds 后写 monitor_stop（含 samples / ran_seconds / nonloopback_total）。

输出 JSONL 行类型：monitor_start / nonloopback_tcp / heartbeat / monitor_stop
（字段与 pwsh 版兼容，`analyze_monitor_r2.py` 可直接吃）。

用法：
    D:\\Python311\\python.exe tests\\desktop\\updater\\r2\\tcp_monitor_r2.py \
        --log <jsonl> --stop <stopfile> --max-seconds 120 --interval-ms 300
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TCP_LINE = re.compile(r"^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$")


def fhost_of(foreign: str) -> str:
    if foreign.startswith("["):
        match = re.match(r"^\[(.*)\]:(\d+)$", foreign)
        if match:
            return match.group(1)
    match = re.match(r"^(.*):(\d+)$", foreign)
    return match.group(1) if match else foreign


def is_loopback(host: str) -> bool:
    return (host == "127.0.0.1" or host == "::1" or host.startswith("127.")
            or host.startswith("::ffff:127"))


def netstat_rows() -> list[str]:
    try:
        out = subprocess.run(["netstat.exe", "-ano"], capture_output=True, text=True,
                             encoding="mbcs", errors="replace", timeout=20)
        return out.stdout.splitlines()
    except Exception:  # noqa: BLE001
        return []


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True)
    ap.add_argument("--stop", required=True)
    ap.add_argument("--max-seconds", type=float, default=120.0)
    ap.add_argument("--interval-ms", type=int, default=500)
    args = ap.parse_args()

    log_path = Path(args.log)
    stop_path = Path(args.stop)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    stop_path.unlink(missing_ok=True)

    def write_line(obj: dict) -> None:
        with open(log_path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(obj, ensure_ascii=False) + "\n")

    started = time.time()
    proc_cache: dict[int, str] = {}
    seen: set[str] = set()
    samples = 0
    hits = 0

    write_line({"type": "monitor_start", "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "pid": __import__("os").getpid(), "impl": "python",
                "interval_ms": args.interval_ms})

    def pid_name(pid: int) -> str:
        if pid in proc_cache:
            return proc_cache[pid]
        try:
            task = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                  capture_output=True, text=True, encoding="mbcs",
                                  errors="replace", timeout=20)
            name = "unknown"
            for row in task.stdout.splitlines():
                parts = [p.strip('"') for p in row.split('","')]
                if len(parts) >= 2 and parts[1].strip().isdigit() and int(parts[1]) == pid:
                    name = parts[0].strip('"')
                    break
        except Exception:  # noqa: BLE001
            name = "unknown"
        proc_cache[pid] = name
        return name

    while (time.time() - started) < args.max_seconds:
        if stop_path.exists():
            break
        rows = netstat_rows()
        samples += 1
        for line in rows:
            match = TCP_LINE.match(line)
            if not match:
                continue
            local, foreign, state, pid = match.group(1), match.group(2), match.group(3), int(match.group(4))
            fhost = fhost_of(foreign)
            if fhost in ("0.0.0.0", "::", "*"):
                continue
            if is_loopback(fhost):
                continue
            key = f"{local}|{foreign}|{pid}"
            if key in seen:
                continue
            seen.add(key)
            hits += 1
            write_line({"type": "nonloopback_tcp", "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        "local": local, "remote": foreign, "state": state, "pid": pid,
                        "proc": pid_name(pid)})
        if samples % 60 == 0:
            write_line({"type": "heartbeat", "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        "samples": samples, "nonloopback_total": hits})
        time.sleep(max(0.05, args.interval_ms / 1000.0))

    write_line({"type": "monitor_stop", "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "samples": samples, "nonloopback_total": hits,
                "ran_seconds": round(time.time() - started, 1)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
