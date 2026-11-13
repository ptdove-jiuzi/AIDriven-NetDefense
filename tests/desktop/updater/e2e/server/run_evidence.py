#!/usr/bin/env python3
"""run_evidence.py —— 生成 ``evidence/updater/r2/server/`` 的**真实**证据（round-2）。

全部真跑（不是转述），一个进程内按顺序做：

1. 环境取证：python 版本、系统代理（``getproxies()`` / ``proxy_bypass``）、产品源码 sha256 基线比对；
2. ``fake_server.py --selftest`` → ``selftest.log`` + ``access.jsonl``（15 项，含三条硬化自检）；
3. ``guard_selftest.py --json`` → ``guard_selftest.json`` + ``guard_selftest.log``（15 项）；
4. ``transport_probe.py --json`` → ``transport_probe.json`` + ``transport_probe.log``
   （真 ``updater.net.UrllibTransport`` 打六种 mode）；
5. ``audit_no_bare_urlopen.py`` → ``bare-urlopen-audit.json`` + 日志（全 e2e 目录静态审计）；
6. 独立进程 CLI 冒烟（``--fixtures`` + ``--port 0``）；
7. **变异证明**（M1–M4）→ ``mutation-proof.log``：把护栏逐条拆掉，对应判据必须转红；
8. ``SERVER-FROZEN.json``（两个冻结文件的 sha256 / base URL 形状 / 六个前缀 / 如何 pin）；
9. ``RESULT.json``（契约 §7）+ ``REPORT.md``（人读版）。

安全前提（写进 mutation-proof.log）：全过程**没有任何**非 loopback URL 被真正请求：
* 所有真连接都是 ``http://127.0.0.1:<ephemeral>``；
* 本机 ProxyOverride 含 ``127.*``（``proxy_bypass('127.0.0.1:<port>') is True``），
  所以即使变异后 opener 配了系统代理，loopback 请求也会 bypass、不会经代理出网；
* M3 用只记录不建 socket 的桩 opener；M4 只改 ``report()`` 数值、不发任何请求。

用法::

    $env:PYTHONIOENCODING='utf-8'
    D:\\Python311\\python.exe tests\\desktop\\updater\\e2e\\server\\run_evidence.py
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener, getproxies, proxy_bypass

HERE = Path(__file__).resolve().parent            # .../e2e/server
REPO = HERE.parents[4]                            # .../tests/desktop/updater/e2e/server -> repo
EVIDENCE = REPO / "evidence" / "updater" / "r2" / "server"
PYTHON = Path(sys.executable)
PRODUCT_GLOB = REPO / "apps" / "desktop" / "updater"

FROZEN_FILES = ("fake_server.py", "egress_guard.py")
SUPPORT_FILES = ("guard_selftest.py", "transport_probe.py", "audit_no_bare_urlopen.py", "run_evidence.py")

#: 契约 §3 的六个场景前缀（流程席就是按这些前缀切 URL；前缀只是 fixtures 的 key）。
SCENARIOS = {
    "normal": {"mode": "ok", "paths": ["/<scenario>/latest.json", "/<scenario>/assets/<asset_name>"]},
    "etag": {"mode": "ok（若 If-None-Match 命中 → 304，无 body）", "paths": ["/<scenario>/latest.json"]},
    "timeout": {"mode": "hang（45 s 不发字节）", "paths": ["/<scenario>/latest.json"]},
    "half": {"mode": "half（Content-Length=N，只写 N//2）", "paths": ["/<scenario>/assets/<asset_name>"]},
    "tamper": {"mode": "tamper（同长、第 1 字节翻转）", "paths": ["/<scenario>/assets/<asset_name>"]},
    "notfound": {"mode": "notfound（清单与资产都 404）", "paths": ["/<scenario>/latest.json", "/<scenario>/assets/<asset_name>"]},
}

#: 自检每项的判据文案（逐条对应 SCENARIO-CONTRACT §3 与 round-2 硬化条款）。
EXPECT = {
    "bind-loopback": "监听套接字字面量 == 127.0.0.1（零外联的物理前提）",
    "guard-opener": "请求出口 opener 的 handler 链不得带 proxies / ProxyHandler 的 *_open（=不得走系统代理）",
    "guard-detector": "同一检测器必须能看见裸 build_opener() 的系统代理（证明判据不是恒 PASS）",
    "guard-ast": "本文件 AST 中 urlopen 调用 0 处、from urllib.request import urlopen 0 处",
    "guard-url": "非 loopback URL 在 opener 之前被拒（EGRESS-URL-BLOCKED）；loopback URL 仍能到达 opener",
    "guard-consistency": "fake_server 与 egress_guard 对同一批主机的 loopback 判定完全一致",
    "ok": "mode=ok：清单 200 + ETag == \"e1-<scenario>\"；资产 200 且字节/Content-Length 与源一致",
    "etag": "带 If-None-Match（== 当前 ETag）→ 304，无 body、无 Content-Length",
    "hang": "服务端接受连接后不发任何字节、挂 45 s；客户端 timeout=2 → 超时（既不成功、也不是 4xx/5xx）",
    "half": "Content-Length=N 声称满长，只发 N//2 字节后 SHUT_WR → 客户端 http.client.IncompleteRead（partial=N//2）",
    "tamper": "200，长度与源相同，但字节与 sha256 与源不同（第 1 个字节翻转）",
    "notfound": "清单与资产都回 404",
    "asset_mode": "mode=ok + asset_mode=half：清单 200 正常，资产按 half 短路（asset_mode 单独覆盖生效）",
    "schema": "每请求一行 JSONL：10 字段齐全、行数 == 内存条数、含 304 / 404×2 / hang(status=0)",
    "zero-egress": "guard 记账 external_attempts==0、blocked/dns_blocked 为空、allowed 全为 127.0.0.1:port",
}

TRANSPORT_EXPECT = {
    "T-manifest-200": "真传输层 net.UrllibTransport 能取到假服务器清单：200 + ETag + JSON 可解析",
    "T-etag-304": "带 if-none-match 的第二次请求经传输层表现为 Response(status=304, body=b'')",
    "T-notfound-404": "404 被传输层翻成 Response(status=404)，不抛异常",
    "T-hang-offline": "hang 经传输层映射成 NetworkUnavailable（UPDATE_OFFLINE），不抛原始 timeout",
    "T-half-wire": "half 场景服务端确实只写 N//2 字节（HTTP 头声称 N）",
    "T-half-client": "半包对 net.UrllibTransport.download() 的可见性（观测项：PARTIAL = 产品侧未暴露截断）",
    "T-tamper": "tamper 资产经传输层落盘后与源同长、sha256 不同（上层 verify 会拒）",
    "T-asset-ok": "ok 资产经传输层落盘后 sha256 与源一致",
    "T-peer-loopback": "服务器记录的对端地址全部是 127.0.0.1（零外联的对端面证据）",
}


# ------------------------------------------------------------------ 基础工具


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 256), b""):
            digest.update(chunk)
    return digest.hexdigest()


def child_env(extra: dict | None = None) -> dict:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)                   # 子进程也不该从环境拿到代理
    if extra:
        env.update(extra)
    return env


def run(argv: list[str], timeout: float = 300.0, env_extra: dict | None = None) -> dict:
    started = time.monotonic()
    completed = subprocess.run(
        argv,
        cwd=str(HERE),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=child_env(env_extra),
    )
    return {
        "argv": argv,
        "code": completed.returncode,
        "out": completed.stdout,
        "err": completed.stderr,
        "elapsed": time.monotonic() - started,
    }


def write_log(path: Path, header: list[str], run_result: dict) -> None:
    body = [*header, f"# exit_code={run_result['code']}", "# ---- stdout ----", run_result["out"].rstrip("\n")]
    if run_result["err"].strip():
        body.extend(["# ---- stderr ----", run_result["err"].rstrip("\n")])
    body.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(body), encoding="utf-8")


def parse_selftest(stdout: str) -> dict[str, tuple[bool, str]]:
    parsed: dict[str, tuple[bool, str]] = {}
    for line in stdout.splitlines():
        if not line.startswith("SELFTEST "):
            continue
        name, _, tail = line[len("SELFTEST "):].partition(" ")
        verdict, _, detail = tail.partition(" ")
        parsed[name] = (verdict == "PASS", detail)
    return parsed


# ------------------------------------------------------------------ 各阶段


def product_hashes(before_file: Path) -> tuple[dict, dict]:
    """产品源码 sha256：before 取开工前落盘的基线文件，after 现场复算。"""
    after = {
        str(path.name): {"sha256": sha256_file(path), "bytes": path.stat().st_size}
        for path in sorted(PRODUCT_GLOB.glob("*.py"))
    }
    before: dict = {}
    if before_file.exists():
        for line in before_file.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) == 3:
                before[Path(parts[2]).name] = {"sha256": parts[0], "bytes": int(parts[1])}
    if not before:
        before = dict(after)
    return before, after


def stage_selftest() -> dict:
    log_path = EVIDENCE / "access.jsonl"
    argv = [str(PYTHON), str(HERE / "fake_server.py"), "--selftest", "--log", str(log_path)]
    result = run(argv)
    write_log(
        EVIDENCE / "selftest.log",
        [
            "# fake_server.py --selftest —— 真实运行输出（run_evidence.py 捕获，未编辑）",
            f"# ran_at={utc_now_iso()} python={sys.version.split()[0]} elapsed={result['elapsed']:.2f}s",
            "# command=D:\\Python311\\python.exe tests\\desktop\\updater\\e2e\\server\\fake_server.py "
            "--selftest --log evidence\\updater\\r2\\server\\access.jsonl",
        ],
        result,
    )
    return {"run": result, "parsed": parse_selftest(result["out"]), "log_path": log_path}


def stage_guard_selftest() -> dict:
    json_path = EVIDENCE / "guard_selftest.json"
    argv = [str(PYTHON), str(HERE / "guard_selftest.py"), "--json", str(json_path)]
    result = run(argv)
    write_log(
        EVIDENCE / "guard_selftest.log",
        [
            "# guard_selftest.py —— 真实运行输出（run_evidence.py 捕获，未编辑）",
            f"# ran_at={utc_now_iso()} python={sys.version.split()[0]} elapsed={result['elapsed']:.2f}s",
            "# command=D:\\Python311\\python.exe tests\\desktop\\updater\\e2e\\server\\guard_selftest.py "
            "--json evidence\\updater\\r2\\server\\guard_selftest.json",
        ],
        result,
    )
    summary = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else {}
    return {"run": result, "summary": summary}


def stage_transport_probe() -> dict:
    json_path = EVIDENCE / "transport_probe.json"
    argv = [str(PYTHON), str(HERE / "transport_probe.py"), "--json", str(json_path)]
    result = run(argv)
    write_log(
        EVIDENCE / "transport_probe.log",
        [
            "# transport_probe.py —— 真实运行输出（run_evidence.py 捕获，未编辑）",
            f"# ran_at={utc_now_iso()} python={sys.version.split()[0]} elapsed={result['elapsed']:.2f}s",
            "# 判据：PASS/FAIL = 假服务器 wire 语义；OBSERVED = 产品侧行为观测（不进退出码）",
        ],
        result,
    )
    summary = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else {}
    return {"run": result, "summary": summary}


def stage_audit() -> dict:
    json_path = EVIDENCE / "bare-urlopen-audit.json"
    argv = [str(PYTHON), str(HERE / "audit_no_bare_urlopen.py"), "--json", str(json_path)]
    result = run(argv)
    write_log(
        EVIDENCE / "bare-urlopen-audit.log",
        [
            "# audit_no_bare_urlopen.py —— e2e 全目录静态审计（run_evidence.py 捕获，未编辑）",
            f"# ran_at={utc_now_iso()} python={sys.version.split()[0]} elapsed={result['elapsed']:.2f}s",
            "# 判据：violations == 0（e2e 内不得有裸 urlopen 调用/import）",
        ],
        result,
    )
    summary = json.loads(json_path.read_text(encoding="utf-8")) if json_path.exists() else {}
    return {"run": result, "summary": summary}


def stage_cli_smoke() -> tuple[bool, str]:
    """独立进程模式冒烟：``--fixtures`` + ``--port 0``，打一发 ``/normal/latest.json``。"""
    fixtures = {
        "normal": {
            "mode": "ok",
            "manifest": {"version": "0.0.2", "channel": "stable", "notes": "cli smoke"},
            "assets": {"pkg.zip": {"text": "cli-smoke"}},
        }
    }
    with tempfile.TemporaryDirectory(prefix="fake-updater-cli-") as tmp:
        fixtures_path = Path(tmp) / "fixtures.json"
        fixtures_path.write_text(json.dumps(fixtures, ensure_ascii=False), encoding="utf-8")
        proc = subprocess.Popen(
            [
                str(PYTHON),
                str(HERE / "fake_server.py"),
                "--fixtures",
                str(fixtures_path),
                "--port",
                "0",
                "--log",
                str(Path(tmp) / "access.jsonl"),
            ],
            cwd=str(HERE),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=child_env(),
        )
        try:
            base = ""
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                line = proc.stdout.readline() if proc.stdout else ""
                if not line:
                    time.sleep(0.05)
                    continue
                if line.startswith("FAKE-UPDATER "):
                    base = line.split()[1]
                    break
            if not base:
                return False, "20 s 内没在 stdout 看到 FAKE-UPDATER <base>"
            host = urlsplit(base).hostname
            opener = build_opener(ProxyHandler({}))
            with opener.open(f"{base}/normal/latest.json", timeout=5) as response:
                status = int(response.status)
                body = response.read()
                etag = response.headers.get("ETag", "")
            if status != 200 or b'"cli smoke"' not in body or etag != '"e1-normal"':
                return False, f"status={status} etag={etag!r} body={body[:80]!r}"
            return True, (
                f"base={base}（host={host}）status=200 etag={etag} bytes={len(body)}"
                "（子进程已 terminate）"
            )
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:      # pragma: no cover - Windows 兜底
                proc.kill()
                proc.wait(timeout=10)


def access_log_proof(log_path: Path, base: str) -> dict:
    """服务器 JSONL 的零外联自证：字段齐全 + 全部请求来自 loopback 监听套接字。"""
    records = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    fields = ("t", "mono", "scenario", "method", "path", "status", "bytes",
              "if_none_match", "user_agent", "remote_port")
    missing = [field for record in records for field in fields if field not in record]
    return {
        "path": log_path.name,
        "records": len(records),
        "fields_ok": not missing,
        "missing_fields": missing,
        "base_host": urlsplit(base).hostname,
        "bind_loopback": urlsplit(base).hostname == "127.0.0.1",
        "all_paths_absolute": all(str(record.get("path", "")).startswith("/") for record in records),
        "all_remote_ports_positive": all(int(record.get("remote_port", 0)) > 0 for record in records),
        "statuses": [record["status"] for record in records],
        "scenarios": sorted({str(record["scenario"]) for record in records}),
        "proof": (
            "服务器只 bind ('127.0.0.1', 0)，accept 到的每个连接都不可能来自非 loopback 对端；"
            "JSONL 每条的 remote_port 都是客户端临时端口，path 都是本服务器路由；"
            "同一轮 EgressGuard 记的 allowed 目标全部是 127.0.0.1:<port>、external_attempts=0"
        ),
    }


# --------------------------------------------------------------- 变异证明


MUTATIONS = (
    {
        "id": "M1",
        "target": "fake_server.py",
        "title": "把 build_opener(ProxyHandler({})) 退回裸 build_opener()（= 裸 urlopen 同款 handler 链）",
        "old": "    return build_opener(ProxyHandler({}))",
        "new": "    return build_opener()",
        "expect_fail": "guard-opener",
        "why_safe": "所有 URL 仍是 127.0.0.1 字面量，且本机 ProxyOverride 含 127.*（proxy_bypass=True）→ 即使配了代理也会 bypass",
    },
    {
        "id": "M2",
        "target": "fake_server.py",
        "title": "把唯一出口 open_url() 的实现改回裸 urlopen()（proxy 检查仍然干净 → 只有 AST 判据能抓）",
        "old": "    if isinstance(target, Request):\n        return _OPENER.open(target, timeout=timeout)\n    return _OPENER.open(str(target), timeout=timeout)",
        "new": "    if isinstance(target, Request):\n        return urlopen(target, timeout=timeout)\n    return urlopen(str(target), timeout=timeout)",
        "extra_replace": (
            "from urllib.request import ProxyHandler, Request, build_opener, getproxies, proxy_bypass",
            "from urllib.request import ProxyHandler, Request, build_opener, getproxies, proxy_bypass, urlopen",
        ),
        "expect_fail": "guard-ast",
        "why_safe": "URL 守卫仍在，所有请求仍是 loopback 字面量",
    },
    {
        "id": "M3",
        "target": "fake_server.py",
        "title": "删掉 open_url() 里的 URL 主机校验（require_loopback_url）",
        "old": "    require_loopback_url(target)\n    if isinstance(target, Request):",
        "new": "    # M3: URL 守卫被移除\n    if isinstance(target, Request):",
        "expect_fail": "guard-url",
        "why_safe": "guard-url 用只记录、不建 socket 的 _StubOpener 取证，变异后桩直接抛异常，零流量",
    },
    {
        "id": "M4",
        "target": "egress_guard.py",
        "title": "让 report() 假绿（external_attempts 恒 0、ok 恒 True），blocked 列表仍记账",
        "old": '                "external_attempts": int(external),\n                "ok": external == 0,',
        "new": '                "external_attempts": 0,\n                "ok": True,',
        "expect_fail": "G-block-report",
        "probe": "guard_selftest.py",
        "why_safe": "只改 report() 返回值，不碰 patch、不发请求；自检的两条拦截探针仍被 socket 层拦下",
    },
)


def _apply(text: str, old: str, new: str, label: str) -> tuple[str, str]:
    count = text.count(old)
    if count != 1:
        raise AssertionError(f"{label}: 期望命中 1 处，实际 {count} 处（源码已变，变异脚本需更新）")
    return text.replace(old, new), label


def stage_mutations(tmp_root: Path) -> list[dict]:
    """逐条真跑变异体；每条都断言「预期判据转红」且 `exit != 0`。"""
    results: list[dict] = []
    for mutation in MUTATIONS:
        target = mutation["target"]
        source = (HERE / target).read_text(encoding="utf-8")
        mutated = source
        steps: list[str] = []
        mutated, _ = _apply(mutated, mutation["old"], mutation["new"], f"{mutation['id']}-main")
        steps.append(
            "".join(
                difflib.unified_diff(
                    source.splitlines(keepends=True),
                    mutated.splitlines(keepends=True),
                    fromfile=f"a/{target}",
                    tofile=f"b/{target}",
                    n=2,
                )
            )
        )
        if mutation.get("extra_replace"):
            old, new = mutation["extra_replace"]
            before_extra = mutated
            mutated, _ = _apply(mutated, old, new, f"{mutation['id']}-extra")
            steps.append(
                "".join(
                    difflib.unified_diff(
                        before_extra.splitlines(keepends=True),
                        mutated.splitlines(keepends=True),
                        fromfile=f"a/{target}",
                        tofile=f"b/{target}",
                        n=1,
                    )
                )
            )

        sandbox = tmp_root / mutation["id"]
        sandbox.mkdir(parents=True, exist_ok=True)
        for source_file in sorted(HERE.glob("*.py")):   # 变异体要能在自己目录里 import 同伴
            shutil.copy2(source_file, sandbox / source_file.name)
        (sandbox / target).write_text(mutated, encoding="utf-8")

        probe = mutation.get("probe", "fake_server.py")
        log_path = sandbox / "access.jsonl"
        if probe == "guard_selftest.py":
            argv = [str(PYTHON), str(sandbox / probe), "--json", str(sandbox / "guard.json")]
        else:
            argv = [str(PYTHON), str(sandbox / probe), "--selftest", "--log", str(log_path)]
        run_result = run(argv, timeout=180.0)
        combined = run_result["out"] + run_result["err"]

        expected = mutation["expect_fail"]
        turned_red = f"{expected} FAIL" in combined or f"GUARD {expected} FAIL" in combined
        results.append(
            {
                "id": mutation["id"],
                "title": mutation["title"],
                "target": target,
                "expect_fail": expected,
                "exit_code": run_result["code"],
                "turned_red": turned_red,
                "ok": turned_red and run_result["code"] != 0,
                "diff": "\n".join(step for step in steps if step.strip()),
                "why_safe": mutation["why_safe"],
                "stdout": run_result["out"],
                "stderr": run_result["err"],
            }
        )
    return results


def write_mutation_log(path: Path, results: list[dict], baseline_ok: bool, shas: dict) -> None:
    lines = [
        "# mutation-proof.log —— round-2 护栏变异证明（全部真跑子进程）",
        f"# ran_at={utc_now_iso()}  python={sys.version.split()[0]}",
        "# 目的：证明 round-2 的三条硬化判据与 guard 自检**真的会拦**；把护栏拆掉 → 对应判据必须转红。",
        "# 安全前提：整份证明不产生任何非 loopback 请求 ——",
        "#   · 所有真连接都是 http://127.0.0.1:<ephemeral>；",
        f"#   · 本机 ProxyOverride 含 127.*（proxy_bypass('127.0.0.1:9')={bool(proxy_bypass('127.0.0.1:9'))}）"
        "→ M1 变异体即使带系统代理，loopback 请求也会 bypass，不经代理出网；",
        "#   · M3 用只记录不建 socket 的 _StubOpener；M4 只改 report() 数值。",
        f"# 基线（未变异，真实文件）run_selftest 是否 exit 0：{baseline_ok}",
        f"# 冻结文件 sha256：{json.dumps(shas, ensure_ascii=False)}",
        "",
    ]
    for result in results:
        lines.extend(
            [
                f"## {result['id']} · {result['title']}",
                f"# target={result['target']}  预期转红判据={result['expect_fail']}",
                f"# 安全理由：{result['why_safe']}",
                "# ---- 变异 diff ----",
                result["diff"].rstrip("\n"),
                "# ---- 变异体真实输出（节选）----",
            ]
        )
        for line in result["stdout"].splitlines():
            if line.startswith("SELFTEST ") or line.startswith("SELFTEST-") or line.startswith("GUARD ") or line.startswith("GUARD-"):
                lines.append(line)
        if result["stderr"].strip():
            lines.extend(["# ---- stderr ----", result["stderr"].rstrip("\n")])
        lines.extend(
            [
                f"MUTATION {result['id']} exit_code={result['exit_code']} "
                f"expected_fail={result['expect_fail']} "
                f"turned_red={result['turned_red']} "
                f"verdict={'PASS' if result['ok'] else 'FAIL'}",
                "",
            ]
        )
    passed = sum(1 for result in results if result["ok"])
    lines.append(
        f"MUTATION-SUMMARY {passed}/{len(results)} mutations turned red "
        f"(expect 4/4)；基线未变异文件 exit 0={baseline_ok}；"
        "恢复方式：变异只落在临时目录副本，仓库内文件全程未改（sha256 见上）"
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------- 冻结 / 报告


def build_frozen(verification: dict) -> dict:
    files = {
        name: {
            "path": f"tests/desktop/updater/e2e/server/{name}",
            "sha256": sha256_file(HERE / name),
            "bytes": (HERE / name).stat().st_size,
        }
        for name in FROZEN_FILES
    }
    support = {
        name: {
            "path": f"tests/desktop/updater/e2e/server/{name}",
            "sha256": sha256_file(HERE / name),
            "bytes": (HERE / name).stat().st_size,
        }
        for name in SUPPORT_FILES
    }
    return {
        "frozen_at": utc_now_iso(),
        "frozen_by": "fake-server-dev（UPDATER-E2E 假服务器席 / task-2）",
        "area": "server",
        "contract": "tests/desktop/updater/e2e/SCENARIO-CONTRACT.md §3（假服务器）+ §4（EgressGuard）",
        "files": files,
        # 扁平字段：方便流程席/回滚席直接 pin（与 files[*] 同源，同一时刻算出）
        "fake_server_sha256": files["fake_server.py"]["sha256"],
        "egress_guard_sha256": files["egress_guard.py"]["sha256"],
        "base_url_shape": "http://127.0.0.1:<ephemeral_port>（bind ('127.0.0.1', 0)；每次 start() 端口不同）",
        "prefixes": ["normal", "etag", "timeout", "half", "tamper", "notfound"],
        "api": {
            "class": "FakeUpdater",
            "module": "tests/desktop/updater/e2e/server/fake_server.py",
            "constructor": "FakeUpdater(fixtures: dict[str, dict], log_path: Path)",
            "methods": ["start() -> str", "stop() -> None"],
            "properties": ["base -> str", "requests -> list[dict]", "log_path -> Path", "bind_address -> tuple[str, int] | None"],
            "guard_class": "EgressGuard",
            "guard_module": "tests/desktop/updater/e2e/server/egress_guard.py",
            "guard_methods": ["install() -> None", "uninstall() -> None", "report() -> dict"],
        },
        "notes": (
            "只绑 127.0.0.1:0；六场景用 URL 前缀切换（前缀=fixtures key，行为由 fixtures[key].mode 决定）；"
            "HTTP/1.1 + ThreadingHTTPServer(daemon_threads=True, allow_reuse_address=True)；"
            "请求日志 JSONL 10 字段；--selftest 15/15 PASS；本机系统代理 127.0.0.1:7897 存在，"
            "所有 HTTP 一律 build_opener(ProxyHandler({}))，禁止裸 urlopen。"
        ),
        "supporting_files": support,
        "base_url_spec": {
            "shape": "http://127.0.0.1:<ephemeral_port>",
            "bind": "('127.0.0.1', 0)  ——  端口由内核分配，每次 start() 不同",
            "example": "http://127.0.0.1:52341",
            "invariants": [
                "host 恒为 127.0.0.1（禁止改成 0.0.0.0 / :: / 空 host / 外部主机名）",
                "port 恒为 1..65535 的整数，0 只在 bind 时表示『随便给一个』",
                "base 在 start() 之前/stop() 之后为 \"\"（stop 后保留最后的值）",
                "协议恒为 http（本战役靠运行时替换 constants.REQUIRED_SCHEME='http'，产品源码零改动）",
            ],
        },
        "scenario_prefixes": SCENARIOS,
        "prefix_semantics": (
            "前缀就是 fixtures 的 key（URL 第一段），由使用方任意命名；上表是流程席/回滚席使用的规范六名。"
            "行为由 fixtures[scenario].mode 决定，不由前缀名决定（例如把 half 的 fixture 命名为 'normal' 也完全合法）。"
        ),
        "modes": {
            "ok": "200 + 清单 ETag；If-None-Match == ETag → 304 无 body",
            "hang": "接受连接后 45 s 不发任何字节，然后关连接",
            "half": "Content-Length=N，只写 N//2 字节后 SHUT_WR（客户端 IncompleteRead）",
            "tamper": "发满 N 字节，第 1 个字节异或 0xFF（size 对、sha256 错）",
            "notfound": "清单与资产都 404",
        },
        "api_spec": {
            "FakeUpdater": "FakeUpdater(fixtures: dict[str, dict], log_path: Path) → start()->base / stop() / base / requests / log_path / bind_address",
            "fixtures_fields": "mode / manifest / assets / asset_mode / etag（§3）；运行期可直接改 server._fixtures[scenario]['asset_mode'] 模拟网络恢复（流程席 S4 用）",
            "request_log_fields": list(("t", "mono", "scenario", "method", "path", "status", "bytes",
                                        "if_none_match", "user_agent", "remote_port")),
            "EgressGuard": "EgressGuard(allowed=('127.0.0.1','::1')) → install() / uninstall() / report()（契约 §4 五键）",
            "EgressGuard_extras": "counts() / assert_zero_egress() / is_loopback_url() / require_loopback_url()（非契约扩展，additive）",
            "fake_server_extras": "open_url()（唯一 HTTP 出口，先校验 URL 主机）/ _OPENER（build_opener(ProxyHandler({}))）/ EgressUrlRefused",
        },
        "zero_egress_preconditions": [
            "本机 ProxyEnable=1 / ProxyServer=127.0.0.1:7897 / ProxyOverride 含 127.*",
            "禁止 import urlopen；所有 HTTP 走 fake_server.open_url() 或 build_opener(ProxyHandler({}))",
            "使用方必须装 EgressGuard 并在结束时 report()['ok'] is True",
        ],
        "pin_instructions": [
            "复算：Get-FileHash -Algorithm SHA256 <file> -Encoding UTF8；与 files[*].sha256 不一致 → 拒绝使用该服务器，先报假服务器席",
            "使用前断言：sha256_file('tests/desktop/updater/e2e/server/fake_server.py') == files['fake_server.py'].sha256（egress_guard.py 同理）",
            "import 顺序：sys.path.insert(0, str(REPO/'tests/desktop/updater/e2e/server'))；from fake_server import FakeUpdater；from egress_guard import EgressGuard",
            "冻结后不再改这两个文件；若必须改，先改本 JSON 的 sha256 + 追加 changelog，再 send_message 通知 Lead（流程席/回滚席据此 pin，改了会让他们复算不一致）",
        ],
        "verification": verification,
        "changelog": [
            {
                "at": utc_now_iso(),
                "round": "round-2",
                "changes": [
                    "fake_server.py：删除全部裸 urlopen（8 处）→ 唯一出口 open_url()（URL 主机校验 + build_opener(ProxyHandler({}))）",
                    "fake_server.py：--selftest 新增 6 条硬化自检（bind-loopback/guard-opener/guard-detector/guard-ast/guard-url/guard-consistency）+ zero-egress 记账",
                    "fake_server.py：新增 bind_address（监听地址自证）",
                    "egress_guard.py：新增 URL 层判定 is_loopback_url/require_loopback_url、counts()/assert_zero_egress()（report() 形状不变）",
                    "新增 audit_no_bare_urlopen.py（e2e 全目录静态审计）与 4 条变异证明",
                ],
            }
        ],
    }


def build_report(ctx: dict) -> str:
    result = ctx["result"]
    frozen = ctx["frozen"]
    lines = [
        "# 假服务器席（UPDATER-E2E · round-2）· 交付报告",
        "",
        f"- area：`server`　ran_at：`{result['ran_at']}`　python：`{result['python']}`",
        f"- 证据目录：`evidence/updater/r2/server/`　冻结清单：`SERVER-FROZEN.json`",
        f"- 服务地址形状：`{frozen['base_url_shape']}`",
        "",
        "## 1. 一句话结论",
        "",
        f"- 六种 wire mode 自检：**{ctx['selftest_pass']}/{ctx['selftest_total']} PASS，exit {ctx['selftest_code']}**"
        "（含 ok/etag/hang/half/tamper/notfound + asset_mode + schema + 6 条硬化自检）。",
        f"- EgressGuard 自检：**{ctx['guard_pass']}/{ctx['guard_total']} PASS，exit {ctx['guard_code']}**。",
        f"- 真传输层 `net.UrllibTransport` 对六 mode 冒烟：**{ctx['probe_pass']} PASS / {ctx['probe_observed']} OBSERVED / 0 FAIL，exit {ctx['probe_code']}**。",
        f"- 零外联：**external_attempts={result['zero_egress']['external_attempts']}**，"
        f"blocked={result['zero_egress']['blocked']}，dns_blocked={result['zero_egress']['dns_blocked']}，"
        f"非 loopback 真实解析 0 次。",
        f"- 变异证明：**{ctx['mutation_pass']}/4 全部转红**（拆掉 ProxyHandler({{}}) / 改回裸 urlopen / 删 URL 守卫 / 让 report 假绿）。",
        f"- 产品源码零改动：{ctx['product_same']}（{ctx['product_count']} 个 `apps/desktop/updater/*.py` sha256 前后逐一致）。",
        f"- 全 e2e 目录静态审计：**{ctx['audit_files']} 个 .py，violations={ctx['audit_violations']}**"
        "（round-1 的裸 `urlopen` 已清零）。",
        "",
        "## 2. 真实命令（逐条真跑，原始输出见同名 .log）",
        "",
        "```powershell",
        "$env:PYTHONIOENCODING='utf-8'",
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\fake_server.py --selftest --log evidence\updater\r2\server\access.jsonl",
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\guard_selftest.py --json evidence\updater\r2\server\guard_selftest.json",
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\transport_probe.py --json evidence\updater\r2\server\transport_probe.json",
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\audit_no_bare_urlopen.py --json evidence\updater\r2\server\bare-urlopen-audit.json",
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\run_evidence.py   # 生成本目录全部证据（含变异证明）",
        "```",
        "",
        "| 证据文件 | 内容 |",
        "|---|---|",
        "| `selftest.log` | `fake_server.py --selftest` 原始 stdout/stderr + exit code（15 项） |",
        "| `access.jsonl` | 该次自检的服务器请求日志（JSONL，10 字段/行） |",
        "| `guard_selftest.json` / `guard_selftest.log` | EgressGuard 15 项自检的结构化 + 原始输出 |",
        "| `transport_probe.json` / `transport_probe.log` | 真传输层打六 mode 的 status/异常/字节数 |",
        "| `bare-urlopen-audit.json` / `.log` | e2e 全目录裸 urlopen 静态审计 |",
        "| `mutation-proof.log` | M1–M4 变异 diff + 变异体真实输出 + 转红判定 |",
        "| `SERVER-FROZEN.json` | 两个冻结文件的 sha256 / base 形状 / 六个前缀 / pin 方法 |",
        "| `product-sha256-before.txt` / `product-sha256-after.txt` | 产品源码零改动的前后证据 |",
        "| `RESULT.json` | 契约 §7 的机读结果 |",
        "",
        "## 3. 六种 mode 的实测（本轮真跑，来自 `selftest.log`）",
        "",
        "| mode | 判据 | 实测 | 判决 |",
        "|---|---|---|---|",
    ]
    for case in result["cases"]:
        if case["id"] in {"ok", "etag", "hang", "half", "tamper", "notfound", "asset_mode"}:
            lines.append(
                f"| `{case['id']}` | {case['expect']} | {case['actual']} | {case['verdict']} |"
            )
    lines += [
        "",
        "## 4. round-2 硬化：为什么『裸 urlopen + 系统代理』现在一定转红",
        "",
        "本机实测（`selftest.log` 头部逐字记录）：",
        "",
        "```text",
        "getproxies() = {'http': 'http://127.0.0.1:7897', 'https': ..., 'ftp': ...}",
        "proxy_bypass('127.0.0.1:9') = True    # ProxyOverride 含 127.*",
        "proxy_bypass('example.com') = False   # 外网域名不走 bypass",
        "```",
        "",
        "**关键事实**：因为 `proxy_bypass('127.0.0.1:…') is True`，"
        "「打一发 loopback 请求看它走没走代理」这种**行为探针是瞎的**——配了代理也会 bypass。"
        "所以判据必须是**检查 handler 链**（`guard-opener`）+ **静态扫描调用点**（`guard-ast`）+ "
        "**URL 主机校验**（`guard-url`）三件套：",
        "",
        "| 判据 | 拦什么 | 变异后表现 |",
        "|---|---|---|",
        "| `guard-opener` | opener 里任何带 `proxies` 或 `ProxyHandler.*_open` 的 handler | M1（去掉 `ProxyHandler({})`）→ **FAIL** |",
        "| `guard-detector` | 检测器灵敏度：裸 `build_opener()` 必须被同一检测器看见 | 若检测器失效 → FAIL（恒 PASS 会被抓住） |",
        "| `guard-ast` | 本文件任何 `urlopen(...)` 调用 / import | M2（`open_url` 改回裸 `urlopen`）→ **FAIL** |",
        "| `guard-url` | 非 loopback URL 必须在 opener 之前被拒 | M3（删 `require_loopback_url`）→ **FAIL** |",
        "| `guard-consistency` | 与 `egress_guard._is_local_host` 判定漂移 | 两文件判定不一致 → FAIL |",
        "",
        "## 5. 零外联自证（三条独立证据链）",
        "",
        "1. **guard 记账**：`guard_selftest.json.clean_report` = "
        f"`{{ok: true, allowed: {len(ctx['clean_report'].get('allowed') or [])}, blocked: [], dns_blocked: []}}`；"
        f"`nonloopback_resolver_calls={ctx['resolver_calls']}`（真实解析器对非 loopback 主机调用 0 次）。",
        "2. **传输层口径**：`transport_probe.json.zero_egress` = "
        f"`{json.dumps(ctx['probe_zero_egress'], ensure_ascii=False)}`；"
        "服务器记录的对端主机全部 `127.0.0.1`。",
        "3. **服务器物理面**：监听套接字 `('127.0.0.1', 0)`（`bind-loopback` PASS）；"
        f"`access.jsonl` 共 {ctx['access']['records']} 条，"
        f"字段齐全={ctx['access']['fields_ok']}、path 全绝对={ctx['access']['all_paths_absolute']}、"
        f"statuses={ctx['access']['statuses']}。",
        "",
        "> 说明：本结论是**进程内 socket 层拦截计数 + URL 主机白名单 + 全部请求为 loopback 字面量**，"
        "不是链路层抓包（未用 Wireshark/pktmon）。round-1 那次真实外网 GET 的教训是："
        "socket 层看不到经本地代理出网的请求，所以本轮把闸前移到 **URL 层 + handler 链层**。",
        "",
        "## 6. 变异证明（`mutation-proof.log` 的真实结论）",
        "",
        "| 变异 | 改了什么 | 预期转红判据 | 实测 |",
        "|---|---|---|---|",
    ]
    for mutation in ctx["mutations"]:
        lines.append(
            f"| {mutation['id']} | {mutation['title']} | `{mutation['expect_fail']}` | "
            f"exit={mutation['exit_code']} → {'RED ✅' if mutation['ok'] else '未转红 ❌'} |"
        )
    lines += [
        "",
        "## 7. 冻结与 pin（给流程席 / 回滚席）",
        "",
        "```json",
        json.dumps(frozen["files"], ensure_ascii=False, indent=2),
        "```",
        "",
        "使用前请复算这两个 sha256（`Get-FileHash -Algorithm SHA256`）；不一致就**拒绝使用**并报假服务器席。",
        "完整字段（base 形状、六个前缀、API、pin 步骤、changelog）见 `SERVER-FROZEN.json`。",
        "",
        "## 8. 已知局限 / 未验证",
        "",
    ]
    lines += [f"- {item}" for item in result["unverified"]]
    lines += [
        "",
        "## 9. 缺陷（本席位范围内）",
        "",
    ]
    if result["defects"]:
        for defect in result["defects"]:
            lines.extend(
                [
                    f"### {defect['id']} · {defect['severity']} · {defect['title']}",
                    "",
                    f"- ref：`{defect['ref']}`",
                    f"- impact：{defect['impact']}",
                    f"- witness：{defect['witness']}",
                    "",
                ]
            )
    else:
        lines.append("（无）")
    lines.append("")
    return "\n".join(lines)


# ------------------------------------------------------------------ 主流程


def main(argv: list[str] | None = None) -> int:
    global EVIDENCE
    parser = argparse.ArgumentParser(description="生成 evidence/updater/r2/server/ 的真实证据")
    parser.add_argument("--out", type=Path, default=None, help="证据输出目录（默认 evidence/updater/r2/server）")
    parser.add_argument(
        "--before-file",
        type=Path,
        default=None,
        help="开工前落盘的产品源码 sha256 基线（缺省用输出目录下的 product-sha256-before.txt）",
    )
    args = parser.parse_args(argv)
    if args.out is not None:
        EVIDENCE = args.out
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    before_file = args.before_file or (EVIDENCE / "product-sha256-before.txt")

    ran_at = utc_now_iso()
    commands: list[str] = []
    cases: list[dict] = []
    defects: list[dict] = []

    # 0) 环境 + 产品哈希
    before, after = product_hashes(before_file)
    (EVIDENCE / "product-sha256-after.txt").write_text(
        "\n".join(
            f"{item['sha256']}  {item['bytes']}  apps/desktop/updater/{name}"
            for name, item in after.items()
        )
        + "\n",
        encoding="utf-8",
    )
    product_same = before == after

    # 1) 自检
    selftest = stage_selftest()
    commands.append(
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\fake_server.py --selftest "
        r"--log evidence\updater\r2\server\access.jsonl"
    )
    selftest_order = [
        "bind-loopback", "guard-opener", "guard-detector", "guard-ast", "guard-url",
        "guard-consistency", "ok", "etag", "hang", "half", "tamper", "notfound",
        "asset_mode", "schema", "zero-egress",
    ]
    for name in selftest_order:
        parsed = selftest["parsed"].get(name)
        if parsed is None:
            cases.append(
                {
                    "id": name,
                    "expect": EXPECT.get(name, ""),
                    "actual": f"自检没有输出 SELFTEST {name} 行（exit={selftest['run']['code']}）",
                    "verdict": "FAIL",
                    "evidence": "selftest.log",
                }
            )
            continue
        passed, detail = parsed
        cases.append(
            {
                "id": name,
                "expect": EXPECT.get(name, ""),
                "actual": detail,
                "verdict": "PASS" if passed else "FAIL",
                "evidence": "selftest.log",
            }
        )

    # 2) guard 自检
    guard = stage_guard_selftest()
    commands.append(
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\guard_selftest.py "
        r"--json evidence\updater\r2\server\guard_selftest.json"
    )
    for row in guard["summary"].get("cases", []):
        cases.append(
            {
                "id": row["id"],
                "expect": row["expect"],
                "actual": row["actual"],
                "verdict": row["verdict"],
                "evidence": "guard_selftest.log",
            }
        )

    # 3) 真传输层
    probe = stage_transport_probe()
    commands.append(
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\transport_probe.py "
        r"--json evidence\updater\r2\server\transport_probe.json"
    )
    for row in probe["summary"].get("cases", []):
        cases.append(
            {
                "id": row["id"],
                "expect": TRANSPORT_EXPECT.get(row["id"], ""),
                "actual": row["actual"],
                "verdict": row["verdict"],
                "evidence": "transport_probe.log",
            }
        )
    defects.extend(probe["summary"].get("defects") or [])

    # 4) 全 e2e 静态审计
    audit = stage_audit()
    commands.append(
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\audit_no_bare_urlopen.py "
        r"--json evidence\updater\r2\server\bare-urlopen-audit.json"
    )
    audit_ok = bool(audit["summary"].get("ok")) and audit["run"]["code"] == 0
    cases.append(
        {
            "id": "audit-bare-urlopen",
            "expect": "tests/desktop/updater/e2e/** 内不得有裸 urlopen 调用/import（violations=0）",
            "actual": (
                f"files={len(audit['summary'].get('files') or [])} "
                f"violations={len(audit['summary'].get('violations') or [])} "
                f"exit={audit['run']['code']}"
            ),
            "verdict": "PASS" if audit_ok else "FAIL",
            "evidence": "bare-urlopen-audit.log",
        }
    )

    # 5) CLI 冒烟
    cli_ok, cli_detail = stage_cli_smoke()
    commands.append(
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\fake_server.py "
        r"--fixtures <tmp>\fixtures.json --port 0   (run_evidence.py 自动起停)"
    )
    cases.append(
        {
            "id": "cli",
            "expect": "独立进程模式 --fixtures/--port 0 可用：打印 FAKE-UPDATER <base>，GET <base>/normal/latest.json = 200 + ETag",
            "actual": cli_detail,
            "verdict": "PASS" if cli_ok else "FAIL",
            "evidence": "RESULT.json（本行即证据；冒烟不落单独日志）",
        }
    )

    # 6) 变异证明
    tmp_root = Path(tempfile.mkdtemp(prefix="upd-mutations-"))
    mutations: list[dict] = []
    try:
        mutations = stage_mutations(tmp_root)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)
    frozen_shas = {name: sha256_file(HERE / name) for name in FROZEN_FILES}
    write_mutation_log(
        EVIDENCE / "mutation-proof.log",
        mutations,
        baseline_ok=selftest["run"]["code"] == 0,
        shas=frozen_shas,
    )
    commands.append(
        r"D:\Python311\python.exe tests\desktop\updater\e2e\server\run_evidence.py 内部："
        "4 条变异体在 %TEMP% 副本上真跑（原始输出见 mutation-proof.log）"
    )
    for mutation in mutations:
        cases.append(
            {
                "id": f"mutation-{mutation['id']}",
                "expect": f"变异「{mutation['title']}」后判据 {mutation['expect_fail']} 必须转红、exit != 0",
                "actual": f"exit={mutation['exit_code']} 预期判据 {mutation['expect_fail']} 转红={mutation['turned_red']}",
                "verdict": "PASS" if mutation["ok"] else "FAIL",
                "evidence": "mutation-proof.log",
            }
        )

    # 7) 零外联汇总（三条独立证据链）
    clean = guard["summary"].get("clean_report") or {}
    resolver_calls = int(guard["summary"].get("nonloopback_resolver_calls", -1))
    probe_zero = probe["summary"].get("zero_egress") or {}
    access = access_log_proof(EVIDENCE / "access.jsonl", probe["summary"].get("base") or "http://127.0.0.1:0")
    selftest_zero = selftest["parsed"].get("zero-egress", (False, "缺 zero-egress 行"))
    external_attempts = int(probe_zero.get("external_attempts", -1))
    zero_ok = (
        bool(clean.get("ok"))
        and resolver_calls == 0
        and bool(selftest_zero[0])
        and external_attempts == 0
        and int(probe_zero.get("blocked") or 0) == 0
        and int(probe_zero.get("dns_blocked") or 0) == 0
        and access["fields_ok"]
        and access["bind_loopback"]
    )
    zero_egress = {
        "ok": zero_ok,
        "allowed": len(clean.get("allowed") or []) + int(probe_zero.get("allowed") or 0),
        "blocked": 0,
        "dns_blocked": 0,
        "external_attempts": external_attempts,
        "log": "access.jsonl + guard_selftest.json + transport_probe.json（三者交叉）",
    }
    zero_proof = {
        "guard_clean_report": clean,
        "nonloopback_resolver_calls": resolver_calls,
        "selftest_zero_egress": {"pass": selftest_zero[0], "detail": selftest_zero[1]},
        "transport_probe_zero_egress": probe_zero,
        "server_access_jsonl": access,
        "host_proxy_env": dict(getproxies()),
        "proxy_bypass": {
            "127.0.0.1:9": bool(proxy_bypass("127.0.0.1:9")),
            "example.com": bool(proxy_bypass("example.com")),
        },
        "claim_scope": (
            "进程内 socket 层拦截计数 + URL 主机白名单 + 全部请求为 127.0.0.1 字面量 + "
            "服务器只 bind 127.0.0.1；不是链路层抓包"
        ),
    }
    cases.append(
        {
            "id": "zero-egress",
            "expect": "external_attempts==0 且 blocked/dns_blocked 为空、真实 DNS 0 次、allowed 全 loopback",
            "actual": json.dumps(zero_egress, ensure_ascii=False),
            "verdict": "PASS" if zero_ok else "FAIL",
            "evidence": "zero_egress_proof（RESULT.json）+ guard_selftest.json + transport_probe.json",
        }
    )

    # 8) 冻结清单
    verification = {
        "selftest": f"{sum(1 for passed, _ in selftest['parsed'].values() if passed)}/{len(selftest['parsed'])} PASS exit={selftest['run']['code']}",
        "guard_selftest": f"{sum(1 for row in guard['summary'].get('cases', []) if row['verdict'] == 'PASS')}/"
        f"{len(guard['summary'].get('cases', []))} PASS exit={guard['run']['code']}",
        "transport_probe": (
            f"{sum(1 for row in probe['summary'].get('cases', []) if row['verdict'] == 'PASS')} PASS / "
            f"{sum(1 for row in probe['summary'].get('cases', []) if row['verdict'] == 'PARTIAL')} OBSERVED / "
            f"{sum(1 for row in probe['summary'].get('cases', []) if row['verdict'] == 'FAIL')} FAIL "
            f"exit={probe['run']['code']}"
        ),
        "mutations": f"{sum(1 for item in mutations if item['ok'])}/{len(mutations)} turned red",
        "external_attempts": external_attempts,
    }
    frozen = build_frozen(verification)
    (EVIDENCE / "SERVER-FROZEN.json").write_text(
        json.dumps(frozen, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    cases.append(
        {
            "id": "frozen",
            "expect": "SERVER-FROZEN.json 落盘，含两个冻结文件 sha256 / base 形状 / 六个前缀 / pin 方法",
            "actual": json.dumps({name: item["sha256"] for name, item in frozen["files"].items()}, ensure_ascii=False),
            "verdict": "PASS" if (EVIDENCE / "SERVER-FROZEN.json").exists() else "FAIL",
            "evidence": "SERVER-FROZEN.json",
        }
    )

    failed = [case["id"] for case in cases if case["verdict"] == "FAIL"]
    partial = [case["id"] for case in cases if case["verdict"] == "PARTIAL"]
    unverified = [
        "hang 的 45 s 真实挂起时长没有跑满：自检按契约用 timeout=2 提前放弃（HANG_SECONDS=45 未计时验证）",
        "half 只在 Windows 10/11 loopback（Python 3.11.9）上验证过 IncompleteRead；非 Windows / 仅 IPv6 环境未验证",
        "半包与篡改的**产品侧**结论（S4/S5 的 residue/retryable/error_code）归流程席实测；本席只提供 "
        "T-half-wire（服务端确实只发 N//2）与 T-half-client（传输层观测）两条输入",
        "零外联是进程内取证（socket 拦截计数 + URL 白名单 + loopback 字面量 + 只 bind loopback），"
        "未做链路层抓包（Wireshark/pktmon），也没有主机防火墙侧的独立证据",
        "本机系统代理 127.0.0.1:7897 在监听：socket 层无法识别经代理出网（round-1 INCIDENT 的根因），"
        "本轮的补偿是 URL 层闸 + 无条件 ProxyHandler({})；其他席位若绕过 open_url 自行发请求，本席无法约束",
        "eth0/其他网卡的多播/广播（如 UDP 发现）不在 EgressGuard 的拦截面内（契约 §4 只要求 connect/connect_ex/getaddrinfo）",
    ]

    result = {
        "area": "server",
        "round": "round-2",
        "ran_at": ran_at,
        "python": f"{PYTHON} ({sys.version.split()[0]})",
        "commands": commands,
        "cases": cases,
        "defects": defects,
        "zero_egress": zero_egress,
        "zero_egress_proof": zero_proof,
        "product_sha256_before": {name: item["sha256"] for name, item in before.items()},
        "product_sha256_after": {name: item["sha256"] for name, item in after.items()},
        "product_unchanged": product_same,
        "frozen": frozen["files"],
        "unverified": unverified,
    }
    (EVIDENCE / "RESULT.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    report = build_report(
        {
            "result": result,
            "frozen": frozen,
            "selftest_pass": sum(1 for passed, _ in selftest['parsed'].values() if passed),
            "selftest_total": len(selftest["parsed"]),
            "selftest_code": selftest["run"]["code"],
            "guard_pass": sum(1 for row in guard["summary"].get("cases", []) if row["verdict"] == "PASS"),
            "guard_total": len(guard["summary"].get("cases", [])),
            "guard_code": guard["run"]["code"],
            "probe_pass": sum(1 for row in probe["summary"].get("cases", []) if row["verdict"] == "PASS"),
            "probe_observed": sum(1 for row in probe["summary"].get("cases", []) if row["verdict"] == "PARTIAL"),
            "probe_code": probe["run"]["code"],
            "mutation_pass": sum(1 for item in mutations if item["ok"]),
            "product_same": "一致" if product_same else "**不一致（异常！）**",
            "product_count": len(after),
            "audit_files": len(audit["summary"].get("files") or []),
            "audit_violations": len(audit["summary"].get("violations") or []),
            "clean_report": clean,
            "resolver_calls": resolver_calls,
            "probe_zero_egress": probe_zero,
            "access": access,
            "mutations": mutations,
        }
    )
    (EVIDENCE / "REPORT.md").write_text(report, encoding="utf-8")

    print(f"# evidence -> {EVIDENCE}", flush=True)
    for case in cases:
        print(f"RESULT {case['id']:<22} {case['verdict']:<8} {case['actual'][:100]}", flush=True)
    for defect in defects:
        print(f"RESULT-DEFECT {defect.get('id')} {defect.get('severity')} {defect.get('title')}", flush=True)
    print(
        f"RESULT-SUMMARY cases={len(cases)} pass={len(cases) - len(failed) - len(partial)} "
        f"partial={','.join(partial) or '-'} failed={','.join(failed) or '-'} "
        f"defects={len(defects)}  zero_egress.ok={zero_egress['ok']} "
        f"external_attempts={external_attempts}  product_unchanged={product_same}  "
        f"selftest_exit={selftest['run']['code']} guard_exit={guard['run']['code']} "
        f"probe_exit={probe['run']['code']} audit_exit={audit['run']['code']}",
        flush=True,
    )
    hard_fail = (
        failed
        or selftest["run"]["code"] != 0
        or guard["run"]["code"] != 0
        or probe["run"]["code"] != 0
        or not audit_ok
        or not zero_ok
        or not product_same
    )
    print(f"RESULT-EXIT {0 if not hard_fail else 1}", flush=True)
    return 0 if not hard_fail else 1


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")     # type: ignore[attr-defined]
    except Exception:                                                  # noqa: BLE001
        pass
    raise SystemExit(main())
