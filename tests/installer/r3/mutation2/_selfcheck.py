"""Ad-hoc checks for the installer's pure logic (no GUI, no exe).

Run with any Windows Python that has the app directory on its path:
    python deploy/windows/installer/app/_selfcheck.py

It is a smoke check for the pieces that are cheap to get wrong — version parsing,
path validation, argument parsing — not a substitute for an install/uninstall run.
Author: PT-dove
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import version_info  # noqa: E402
from aidn import constants, paths, selfinfo  # noqa: E402
from main import parse  # noqa: E402

failures: list[str] = []


def check(condition: bool, message: str) -> None:
    print(("ok   " if condition else "FAIL ") + message)
    if not condition:
        failures.append(message)


print("version resource")
check(version_info.version_tuple("0.0.1-rc.1") == (0, 0, 1, 0), "0.0.1-rc.1 -> (0,0,1,0)")
check(version_info.version_tuple("1.2.3.4") == (1, 2, 3, 4), "1.2.3.4 -> (1,2,3,4)")
text = version_info.render("0.0.1-rc.2", "AIDrivenNetDefense-Setup-0.0.1-rc.2")
check("CompanyName', 'PT-dove'" in text, "CompanyName is PT-dove")
check("AIDriven NetDefense" in text, "ProductName present")
check("安装程序" in text and "Setup" in text, "FileDescription is bilingual on one line")
check("\n" not in version_info.description("0.0.1"), "description has no newline")

print("\npath validation")
cases = {
    "": False,
    "   ": False,
    "D:": False,
    str(Path("C:/Windows/System32/x")): False,
    "D:\\AIDN": True,
    "D:\\a" * 1: True,
    "D:\\" + "x" * 200: False,
}
for value, expected in cases.items():
    reason = paths.validate_target(value)
    check((reason is None) is expected, f"{value[:40]!r} accepted={expected} (reason={reason!r})")

print("\nargument parsing")
args = parse(["/S", "/DIR=D:\\AIDN", "/NOREG", "/AUTOSTART"])
check(args.silent and args.target == "D:\\AIDN" and not args.write_registry and args.autostart, "silent install flags")
args = parse(["--uninstall", "--dir=D:\\AIDN", "--keep-data"])
check(args.uninstall and args.keep_data, "long-form uninstall flags")
try:
    parse(["/typo"])
    check(False, "unknown argument is rejected")
except ValueError:
    check(True, "unknown argument is rejected")

print("\nidentity")
check(constants.PRODUCT_NAME == "AIDriven NetDefense", "product name")
check(constants.COMPANY == "PT-dove", "company")
version = selfinfo.product_version()
print(f"     product_version() from source = {version!r}")
check(isinstance(version, str) and version != "", "product_version returns a string")

print()
if failures:
    print(f"{len(failures)} check(s) failed")
    raise SystemExit(1)
print("all checks passed")
