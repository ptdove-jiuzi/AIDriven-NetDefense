# REATTACK-RC4 / seed01 — 卸载器双通道第三方再攻击（一键复跑）

本目录是 **REATTACK-RC4 战役 seed01-installer 席位**的自写测试：对 AIDriven NetDefense
**两条卸载路径**做独立第三方再攻击，不采信任何“已修复”自证，只以本脚本在当前工作树跑出的
原始输出为准。

- 席位：`seed01-installer`（独立攻击者）
- 作者：PT-dove
- 结论与完整证据：`docs/implementation/evidence/review/reattack-rc4/seed01/REPORT.md`
- 机器可读结果：`docs/implementation/evidence/review/reattack-rc4/seed01/RESULT.json`

## 攻击面

| 通道 | 入口 | 拒删契约 |
|---|---|---|
| A. Python（rc.4 出厂 Setup.exe 的实际卸载链） | `python deploy/windows/installer/app/main.py /uninstall /DIR=<path> /NOREG`（cwd = `deploy/windows/installer/app`） | 退出码 `EXIT_TARGET_INVALID = 5`，目标树逐字节不变 |
| B. PowerShell（folder/脚本包通道） | `AIDN_SETUP_TEST_DOTSOURCE=1` 点源 `deploy/windows/installer/Setup.ps1`，再调 `Uninstall-Target -Target <path> -KeepData $false -SkipRegistry $true -OnStep $null` | 函数 `throw`，目标树逐字节不变 |

覆盖的目标类别（两通道各一份）：

1. 随手非空用户目录（sentinel 文件 + 子目录 + 子文件）；
2. 伪造 `install\install.json` 至少 4 变体：仅 install.json / install.json + 空 manifests /
   install.json + 全假 sha 清单 / 伪造 `bundle.json`（schemaVersion=1.0 + product/version）+ 清单；
   另加 N-011 X-03 的“两个空文件冒充安装标记”变体；
3. 半套文件：只有 bundle.json 无 manifests、manifest 指向不存在的文件；
4. 链接：目标自身是 junction、目标内部含 junction（外部哨兵树）、父目录是 junction；
5. 路径形态：`..`、8.3 短名、`\\?\` 扩展前缀、空目录特例；
6. 边界（单列、不混入强制矩阵）：自洽伪造标记、清单中间插入大量假行；
7. 正例（防过度修复）：自洽“真安装树”、`dist/bundle/win32-x64-v16` 真实载荷树完整副本；
8. 变异验证：5 次（删 Python 归属门 / 注释 PS `Assert-UninstallOwnership` / `Test-ManifestProof` 恒真 /
   `_manifest_has_rows` 恒真 / `_link_reason` 恒空），每次必须“应拒用例变红 + 还原 sha256 逐字节一致 + 复绿”。

## 前置条件

- Windows x64；PowerShell 7（`pwsh`，脚本用 `$PSHOME\pwsh.exe` 起子进程）；
- Python 3.11：默认 `D:\Python311\python.exe`，可用环境变量 `AIDN_PYTHON` 覆盖；
- 在仓库根目录运行（脚本默认从 `$PSScriptRoot` 上溯 4 层定位仓库；也可用 `-RepoRoot` 显式指定）；
- 无需管理员权限；无需网络。

## 运行

```powershell
# 快速检查（默认）：攻击矩阵 + 单元探针，不复制 464 MiB 真实载荷树。约 60–90 s。
pwsh -NoProfile -ExecutionPolicy Bypass -File tests/security/reattack-rc4/seed01/run-reattack.ps1 -Mode check

# 完整：额外做真实 v16 载荷树（50,832 文件 / 486,339,774 B）复制→卸载正例。约 3 min。
pwsh -NoProfile -ExecutionPolicy Bypass -File tests/security/reattack-rc4/seed01/run-reattack.ps1 -Mode full

# 变异：5 次最小变异 + 还原 + 复绿（会临时编辑 2 个产品文件，备份/还原与哈希见证据）。约 1 min。
pwsh -NoProfile -ExecutionPolicy Bypass -File tests/security/reattack-rc4/seed01/run-reattack.ps1 -Mode mutate
```

可选参数：

| 参数 | 说明 |
|---|---|
| `-EvidenceDir <path>` | 证据输出目录；默认 `%TEMP%\reattack-rc4-seed01\evidence-<stamp>` |
| `-RepoRoot <path>` | 仓库根；默认脚本上溯 4 层 |
| `-SkipRealTree` / `-SkipUnitProbes` | 跳过对应阶段（`-Mode full` 时可用） |
| `-WithMutations` | 等价于 `-Mode mutate` 的变异阶段开关 |

## 判据与退出码

每个用例新建目标 → 运行前/后对目标树与外部哨兵树做快照（相对路径 + 每文件 sha256 + 目录清单 +
链接项 → 树 digest）→ 记录退出码/throw、拒绝文案、安装器日志。

- **强制矩阵**（`kind=refusal/penetration`）：必须拒绝且目标树逐字节不变；**任一删除 = BYPASSED(P0)**；
- **正例**（`kind=positive`）：合法树必须能被卸载（防过度修复）；
- **边界**（`kind=boundary`）：只记录事实（自洽伪造/采样），不计入强制矩阵；
- 空目录（`kind=design`）：两通道均删除并成功 = 源码注释明示的“空目录例外”，判为设计允许。

脚本退出码：

| 退出码 | 含义 |
|---|---|
| `0` | 全部强制矩阵 CLOSED、正例可卸载、产品文件无 drift |
| `2` | 强制矩阵出现 BYPASSED（P0，需立刻上报 Lead） |
| `3` | 运行期间产品文件 sha256 漂移（见证据 `RESULT.json.drift`） |
| `4` | 正例（合法树）卸不掉 —— 过度修复回归 |

## 已跑结果（2026-11-05 02:09，当前工作树）

- 34 用例：**CLOSED 30 / BYPASSED 4 / unreproducible 0**；drift `unchanged=true`。
- 4 条 BYPASSED 全部是**边界类**（`py-16`/`ps-14` 自洽伪造标记；`py-17`/`ps-15` 清单采样淹没），
  与 fix-wave 自身正例 fixture 同形，属设计边界，单列不混入强制矩阵（详见 REPORT §3.7）。
- 强制矩阵：Python 8/8 + PS 8/8 全部拒删；目标 junction、内部 junction 两通道均无穿透；
  `\\?\`/UNC 的路径检查绕过为纵深防御缺口（P3，最终归属门仍生效）；
  PS 静默模式退出码为 1 而非 5（P2 契约不一致）；PS 缺少 Python 的 realpath 判据（P3）。
- 变异 5/5 转红、还原 sha256 全部与改前一致、复绿。
- 正例：自洽真树 + 真实 `dist/bundle/win32-x64-v16` 副本（50,832 文件 / 486,339,774 B）均 exit=0 且被删除。

## 安全与副作用

- 所有目标均在 `%TEMP%\reattack-rc4-seed01\run-<stamp>` 下新建；
- Python 用 `PYTHONDONTWRITEBYTECODE=1`（不在产品目录写 `.pyc`），`/NOREG` 不动注册表；
- `TEMP/TMP`、`AIDN_SETUP_STARTMENU_DIR`、`AIDN_SETUP_DESKTOP_DIR` 每用例重定向，不触碰真实开始菜单/桌面；
- PS 通道用 `-SkipRegistry $true`；
- `-Mode mutate` 只改 `app/aidn/install.py` 与 `deploy/windows/installer/Setup.ps1` 各 1–2 行，
  改前备份到 `%TEMP%`、记录 before/mutated/restored sha256，用例内立即还原；结束统一 drift 校验，
  不一致则 exit 3。**变异不会留在工作树**。

## 已知未覆盖

symlink（本机无特权，用 junction 覆盖同类面）、UNC 端到端（需管理员共享）、提权场景、
TOCTOU 竞态、rc.4 出厂 Setup.exe 的实际二进制行为（本脚本打的是当前源码树；Python 链文件与
`dist/_rc4-freeze/installer-app-20261105-003012` 一致，PS 通道不在 rc.4 exe 内）。
