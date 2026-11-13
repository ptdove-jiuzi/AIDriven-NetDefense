"""tests/desktop 的单元测试入口。

    python tests/desktop/run-tests.py            # 跑全部单元测试
    python tests/desktop/run-tests.py -v         # 逐条

单元测试不启动 GUI、不启动 daemon、不写真实用户目录；端到端验收在
`tests/desktop/acceptance.py`（会真的拉起打包好的 exe）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "apps" / "desktop"))


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    verbosity = 2 if ("-v" in argv or "--verbose" in argv) else 1
    keywords = [item for item in argv if not item.startswith("-")]

    loader = unittest.TestLoader()
    if keywords:
        suite = unittest.TestSuite(loader.loadTestsFromName(name) for name in keywords)
    else:
        suite = loader.discover(start_dir=str(HERE), pattern="test_*.py", top_level_dir=str(HERE))

    result = unittest.TextTestRunner(verbosity=verbosity).run(suite)
    total = result.testsRun
    failed = len(result.failures) + len(result.errors)
    skipped = len(result.skipped)
    print(f"\n总计 {total} 条：通过 {total - failed - skipped} / 失败 {failed} / 跳过 {skipped}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
