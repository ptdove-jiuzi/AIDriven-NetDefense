# r3 · UPGRADE-001 复现与修复验证（可照跑）

三步全部在本机离线跑通，单条命令 < 10 s（红态真实 exe 约 4 s）。Python 用系统 Python 3.11+
（带 `py7zr` 与 `winreg`）；`TEMP` 用长路径（8.3 短名会制造假红）。

## 0. 准备（都在 `%TEMP%\p1r2\cross` 下，可整体删掉重来）

```bash
W="$LOCALAPPDATA/Temp/p1r2/cross"
"/c/Program Files/7-Zip/7z.exe" e dist/release/0.0.1-rc.6/AIDrivenNetDefense-0.0.1-rc.6-win-x64-portable.zip \
    AIDrivenNetDefense.exe -o"$(cygpath -w $W)" -y          # 真 rc.6 桌面 exe（sha256 48716d63…）
python tests/installer/r3/tools/make_mini_payload.py "$W/payload-rc5" rc5
python tests/installer/r3/tools/make_mini_payload.py "$W/payload-rc6" rc6 --real-exe "$W/AIDrivenNetDefense.exe"
python tests/installer/r3/tools/make_archive.py "$W/payload-rc6" "$W/payload-rc6.7z"   # 真 py7zr 容器
```

## 1. 造一棵"真"安装树（在它自己的路径上装，凭据才可验）

```bash
python tests/installer/r3/tools/r3_build_tree.py deploy/windows/installer/app "$W/tree-red" "$W/payload-rc5" 0.0.1-rc.5 --data
```
期望：`ok=true, verify="", installMarker/upgradeMarker 非 null`。

## 2. 红：把 4 个文件换成 rc.6 字节、manifest 不动，跑 shipped rc.6

```bash
cp "$W/AIDrivenNetDefense.exe" "$W/tree-red/AIDrivenNetDefense.exe"
# 再覆盖 console/index.html、runtime/node/node.exe、launch/aegis-console.cmd
python tests/installer/fixtures/r3-marker-probe.py deploy/windows/installer/app "$W/tree-red"
#   → installMarker=null / upgradeMarker=null / manifestHasRows=false，但 ownership.verify 仍 true
MSYS2_ARG_CONV_EXCL='*' "dist/release/0.0.1-rc.6/AIDrivenNetDefense-Setup-0.0.1-rc.6.exe" \
    /S /DIR='C:\...\tree-red' /NOREG /NOSHORTCUT        # exit 1，树逐字节不变
MSYS2_ARG_CONV_EXCL='*' "...Setup-0.0.1-rc.6.exe" \
    /S /uninstall /DIR='C:\...\tree-red' /KEEPDATA /NOREG /NOSHORTCUT   # exit 5，零删除
```

## 3. 绿：journal 树 + 修复副本

```bash
python tests/installer/r3/tools/r3_interrupt.py tests/installer/r3/fix "$W/tree-g2" "$W/payload-rc6" 0.0.1-rc.6 4
#   → journal 存在、两 marker 仍 null、resume=true（这一步是"复制一半"的确定性版本：真 _write_journal + 真 _copy_tree）
python tests/installer/r3/tools/run_installer.py tests/installer/r3/fix "$W/payload-rc6.7z" 0.0.1-rc.6 \
    /S /DIR='C:\...\tree-g2' /NOREG /NOSHORTCUT                        # exit 0，record rc.6 / upgradedFrom rc.5
```

## 4. 变异

`mutation/` = 与 `deploy` 原件逐字节相同的回退体（安装 exit 1 / 卸载 exit 5）；
`mutation2/` = 只删安装侧续做分支（安装 exit 1 / 卸载仍 exit 0）。

补丁：`fix/UPGRADE-001.patch`（`git apply --check` 通过；169 insertions / 7 deletions）。
完整数字与三个时点矩阵见 `evidence/p1-recovery/30-upgrade/{RESULT.json,REPORT.md}`。

Author: PT-dove
