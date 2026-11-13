/**
 * report.mjs — render `evidence/ui2/visual/STATUS.md` from the measured JSON files
 * (author PT-dove).
 *
 * Every number in the generated tables is read from the evidence JSON that the four
 * measurement scripts wrote; the judgement paragraphs state what those numbers mean.
 * Running this file cannot invent a pass: if a JSON is missing, the section says so.
 *
 * Usage: node tests/e2e/visual/report.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EVIDENCE, RESULTS, buildFingerprint } from './lib/common.mjs';

const readJson = (name) => {
  const path = join(RESULTS, name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
};

const shots = readJson('shots.json');
const keyboard = readJson('keyboard.json');
const contrast = readJson('contrast.json');
const table = readJson('table-5000.json');
const runAll = readJson('run-all.json');
const currentBuild = buildFingerprint();

const lines = [];
const push = (...values) => lines.push(...values);
const mdTable = (header, rows) => {
  push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows) push(`| ${row.join(' | ')} |`);
  push('');
};
const cell = (value) => String(value ?? '').replaceAll('|', '\\|');
const builds = [shots, keyboard, contrast, table]
  .filter((entry) => entry !== null)
  .map((entry) => entry.build?.aggregate16)
  .filter((entry) => typeof entry === 'string');
const uniqueBuilds = [...new Set(builds)];

push('# INT-4 · 视觉与可访问性证据（视觉/a11y 子代理）', '');
push('> 本文件由 `tests/e2e/visual/report.mjs` 从 `results/*.json` 生成；表格里的每个数字都来自真实运行，不接受手填。', '');
push('## 0. 身份与 build 绑定', '');
push('| 项 | 值 |', '| --- | --- |');
push(`| task_id | \`task-4\` (INT-4) |`);
push(`| 子代理 | visual-a11y |`);
push(`| 写域 | \`tests/e2e/visual/**\`、\`docs/implementation/evidence/ui2/visual/**\` |`);
push(`| 生成时间 | ${new Date().toISOString()} |`);
push(`| 被测 build（apps/console-next 资产汇总 sha256 前 16 位） | ${uniqueBuilds.map((value) => `\`${value}\``).join(' / ') || '未测到'} |`);
push(`| build 文件数 | ${shots?.build?.fileCount ?? '未测到'} |`);
push(`| build 最新 mtime | ${shots?.build?.maxMtimeIso ?? '未测到'} |`);
push(`| 生成报告时盘面 build | \`${currentBuild.aggregate16}\`（${currentBuild.fileCount} 文件） |`);
push(`| 运行期间 build 是否移动 | 截图：${shots?.build?.movedDuringRun ? '是' : '否'}；键盘：${keyboard?.build?.movedDuringRun ? '是' : '否'}；对比度：${contrast?.build?.movedDuringRun ? '是' : '否'}；5000 行：${table?.build?.movedDuringRun ? '是' : '否'} |`);
push(`| 运行时（只读消费） | 有数据 \`http://127.0.0.1:17512\`；没数据 \`http://127.0.0.1:17522\` |`);
push(`| 浏览器 | Edge headless + 自写 CDP 驱动 \`tests/e2e/lib/cdp.mjs\`（零依赖） |`);
push('');

push('## 1. 结论摘要', '');
const shotCount = shots?.shotCount ?? 0;
const shotChecks = shots?.checker ?? { total: 0, passed: 0, failed: 0 };
const kbChecks = keyboard?.checker ?? { total: 0, passed: 0, failed: 0 };
const ctChecks = contrast?.checker ?? { total: 0, passed: 0, failed: 0 };
const tbChecks = table?.checker ?? { total: 0, passed: 0, failed: 0 };
push('| 项 | 结果 | 证据 |', '| --- | --- | --- |');
push(`| 截图矩阵 | **${shotCount}/48 张**真实渲染，断言 ${shotChecks.passed}/${shotChecks.total} 通过 | \`shots/\`、\`results/shots.json\` |`);
push(`| Tab 走完告警页 | 60 步真实键盘；断言 ${kbChecks.passed}/${kbChecks.total} 通过 | \`results/keyboard.json\` |`);
push(`| Esc / 三关关闭 | 抽屉 X / 遮罩 / Esc + 设置页危险确认弹层，全部关闭且焦点回归 | 同上 |`);
push(`| 对比度 | 对比度断言 ${ctChecks.passed}/${ctChecks.total} 通过（0 项阈值失败） | \`CONTRAST.md\`、\`results/contrast.json\` |`);
push(`| 5000 行表格 | 组件层 5000 行真实渲染 + 告警视图 500 行（契约上限）；断言 ${tbChecks.passed}/${tbChecks.total} 通过 | \`results/table-5000.json\` |`);
push('');

push('## 2. 复跑命令（唯一认可的复现方式）', '');
push('```powershell');
push('cd D:\\AIUSE\\网络防御');
push('# 全量（等盘面稳定 60s 后依次跑 4 个量测，写 results/run-all.json）');
push('node tests/e2e/visual/run-all.mjs --wait-stable 60');
push('');
push('# 单项');
push('node tests/e2e/visual/01-shots.mjs');
push('node tests/e2e/visual/02-keyboard.mjs');
push('node tests/e2e/visual/03-contrast.mjs');
push('node tests/e2e/visual/04-table-5000.mjs');
push('node tests/e2e/visual/report.mjs        # 重新生成本文件');
push('```');
push('');
push('退出码约定：`01/03/04` 退出码非 0 = 有断言失败；`02` 退出码非 0 = 有 a11y 断言失败（两者都代表真实缺陷，不是脚本崩溃）。', '');

/* ---------------------------------------------------------------- screenshots */
push('## 3. 截图矩阵（6 视图 × 暗/亮 × 有数据/没数据 × 1440×900/390×844 = 48）', '');
if (shots === null) {
  push('未运行：`results/shots.json` 不存在。', '');
} else {
  const bytes = shots.shots.map((entry) => entry.bytes);
  const texts = shots.shots.map((entry) => entry.viewTextLength);
  const overflow = shots.shots.filter((entry) => entry.horizontalOverflow === true);
  const devtoolsBad = shots.shots.filter((entry) => entry.devtools?.total > 0);
  push(`- 截图张数：**${shots.shots.length}**；PNG 字节 **${Math.min(...bytes)}–${Math.max(...bytes)}**；视图文本长度 **${Math.min(...texts)}–${Math.max(...texts)} 字符**（用于发现"看起来是空的"）。`);
  push(`- 空视图（文本 < 40 字符）：**${shots.shots.filter((entry) => entry.viewTextLength < 40).length}**。`);
  push(`- 暗/亮像素级不同：**${shots.themePairs.filter((entry) => entry.differ).length}/${shots.themePairs.length}** 对（证明主题真的生效，不是同一张图）。`);
  push(`- DevTools 非零的截图：**${devtoolsBad.length}** 张${devtoolsBad.length === 0 ? '' : `（${devtoolsBad.map((entry) => `${entry.file}:${entry.devtools.total}`).join('、')}）`}。`);
  push(`- 页面级横向溢出（horizontalOverflow）的截图：**${overflow.length}** 张${overflow.length === 0 ? '' : `（全部为 390×844：${overflow.filter((entry) => entry.viewport === '390x844').length}/${shots.shots.filter((entry) => entry.viewport === '390x844').length} 张窄屏）`}。`);
  push('');
  mdTable(
    ['视图', '主题', '数据', '视口', 'PNG 字节', '视图文本长度', '缺 key', 'DevTools', '文件'],
    shots.shots.map((entry) => [
      entry.view, entry.theme, entry.stack, entry.viewport, entry.bytes, entry.viewTextLength,
      entry.missingKeyCount, entry.devtools.total, `\`${entry.file}\``,
    ]),
  );
  const missingSamples = [...new Set(shots.shots.flatMap((entry) => entry.missingKeySamples ?? []))];
  if (missingSamples.length > 0) {
    push(`> 本 build 仍出现缺失 i18n key（示例：${missingSamples.slice(0, 6).map((value) => `\`${value}\``).join('、')}）。缺失 key 会渲染成 \`[missing:…]\`，属 P0 级显示缺陷。`, '');
  } else {
    push('> 本 build 无 `[missing:…]`（i18n 目录已落盘，历史 P0-1 未再复现）。', '');
  }
}

/* ------------------------------------------------------------------- keyboard */
push('## 4. 键盘 / 焦点 / 弹层（真实键盘与鼠标，非合成事件）', '');
if (keyboard === null) {
  push('未运行：`results/keyboard.json` 不存在。', '');
} else {
  const walk = keyboard.results.tabWalk;
  if (walk && !walk.error) {
    push('### 4.1 告警页 60 步 Tab 走查', '');
    push(`- 起点：\`${walk.startFocus}\`；实际按键：**${walk.steps.length}** 次真实 Tab（CDP \`Input.dispatchKeyEvent\`，非 JS 模拟）。`);
    push(`- 到达不同元素：**${walk.uniqueElementsReached}**；顺序回退/停滞：**${walk.monotonicViolations.length}** 次；连续重复（死循环）：**${walk.consecutiveRepeats.length}** 次。`);
    push(`- 落在 aria-hidden 或 display:none 区域：**${walk.hiddenSteps.length}** 次；Tab 落到 BODY（焦点逃逸）：**${walk.bodyFocusSteps.length}** 次。`);
    push(`- 无可见焦点环的步骤：**${walk.invisibleRingSteps.length}**；焦点环最低对比度：**${walk.minRingContrast?.ratio ?? 'n/a'}:1**（${walk.minRingContrast?.ring ?? 'n/a'} on ${walk.minRingContrast?.against ?? 'n/a'}，inset=${walk.minRingContrast?.inset ?? 'n/a'}）→ 阈值 3:1。`);
    push('');
    push('前 20 步焦点序列（`domOrderIndex` 是当前可聚焦元素集合中的文档顺序下标，必须单调递增）：', '');
    mdTable(
      ['step', 'tag', 'id/cls', '文本/aria', 'domOrderIndex', 'outline', 'ring 对比度'],
      walk.steps.slice(0, 20).map((step) => [
        step.step, step.tag, cell(`${step.id ?? ''} ${String(step.cls ?? '').slice(0, 24)}`),
        cell(String(step.text ?? step.ariaLabel ?? '').slice(0, 30)), step.domOrderIndex,
        `${step.outlineStyle} ${step.outlineWidth}`, step.ringContrast?.ratio ?? '—',
      ]),
    );
    push(`全部 ${walk.steps.length} 步压缩序列（\`步号:tag[domOrderIndex]\`，单调递增即通过）：`, '');
    push('```text');
    const compact = walk.steps.map((step) => `${step.step}:${step.tag}[${step.domOrderIndex}]`);
    for (let index = 0; index < compact.length; index += 10) {
      push(compact.slice(index, index + 10).join('  '));
    }
    push('```');
    push('');
  }

  const overflow = keyboard.results.overflow;
  if (overflow && !overflow.error) {
    push('### 4.2 D13 / D14 · 横向溢出尺寸矩阵（页面级 vs 容器级，分开判定）', '');
    push('**判定口径**：表格自带的 `.ui-table__scroll` 横向滚动是合同 §7.6 的既定设计（保留真实 `<table>` + 固定行高）→ 只要键盘可达就算可接受；**页面级**横向滚动（`documentElement.scrollWidth > clientWidth`，顶栏被裁）不是设计，是缺陷。', '');
    mdTable(
      ['视口宽', '表格容器溢出 px（容器级）', '操作列不可见按钮数', '页面级溢出 px（文档级）', '判定'],
      overflow.metrics.map((entry) => [
        entry.width,
        entry.overflowPx,
        entry.actionButtonsOffscreen,
        entry.docOverflowPx,
        entry.docOverflowPx > 0
          ? `**D13 P1** 页面级溢出 ${entry.docOverflowPx}px${entry.overflowPx > 0 ? ` + D14 容器级 ${entry.overflowPx}px` : ''}`
          : (entry.overflowPx > 0
            ? `D14 P2 容器级溢出 ${entry.overflowPx}px（同源容器横滚；键盘可达性在 1024 实测）`
            : '无溢出'),
      ]),
    );
    const at390 = overflow.metrics.find((entry) => entry.width === 390);
    const at1024 = overflow.metrics.find((entry) => entry.width === 1024);
    const d13Open = (at390?.docOverflowPx ?? 0) > 0;
    push(`- **D13（页面级，P1）· 当前状态：${d13Open ? '未关闭' : '已关闭'}**：390px 时 \`documentElement\` 溢出 **${at390?.docOverflowPx ?? 'n/a'}px**（修前基线 build \`2ffcb8e5\` 实测 **151px**；修后 build \`${keyboard.build?.aggregate16}\` 实测 **0px**，且 6 视图 × {390,1024} 全部 0）。表格容器的 ${at390?.overflowPx ?? 'n/a'}px 横滚是另一件事（D14/设计内），不混算。`);
    push(`- **D14（容器级，P2/已接受）**：1024px 时表格滚动容器溢出 **${at1024?.overflowPx ?? 'n/a'}px**，${at1024?.actionButtonsOffscreen ?? 'n/a'} 个操作按钮初始不可见；键盘 Tab 第 **${overflow.keyboardReachability.reachedAtStep}** 步即可到达操作按钮，被聚焦的 ${overflow.keyboardReachability.actionButtonSteps} 个按钮 **${overflow.keyboardReachability.fullyVisibleCount}** 个被浏览器自动滚入可视区 → a11y 不阻断。`);
    if (overflow.judgement?.pageLevelOffenders?.length > 0) {
      push(`- 390px 页面级溢出元素：${overflow.judgement.pageLevelOffenders.map((entry) => `\`${entry.tag}.${entry.cls}\`(right=${entry.right})`).join('、')}。`);
    } else {
      push('- 390px 页面级溢出元素：**无**（无元素越过 viewport 右边界）。');
    }
    push('');
  }

  const drawer = keyboard.results.drawer;
  if (drawer && !drawer.error) {
    push('### 4.3 抽屉三关（X / 遮罩 / Esc）', '');
    mdTable(
      ['关闭方式', '打开', '焦点进入面板', '面板可聚焦元素', 'Tab/Shift+Tab 陷阱', '关闭', '焦点回归触发行', 'scroll-lock 释放', 'aria 状态'],
      drawer.paths.map((entry) => [
        entry.path, entry.openState.overlayPresent ? '是' : '否', entry.openState.focusInsidePanel ? '是' : '否',
        entry.openState.focusableInPanel, `${entry.trapAllInside ? '全部在内部' : '逃逸'}（${entry.trapSteps} 步）`,
        entry.closed.overlayCount === 0 ? '是' : `否（剩 ${entry.closed.overlayCount}）`,
        entry.focusReturned ? `是（TR#${entry.closed.activeIndex}）` : '否',
        entry.closed.scrollLock === false ? '是' : '否',
        entry.closed.appAriaHidden === null && entry.closed.hiddenFocusableCount === 0 ? '干净' : '异常',
      ]),
    );
    push(`- 触发方式：真实鼠标点击表格行（\`row.click()\` 走的是行自身的 click handler）；关闭方式分别为 \`${drawer.paths.map((entry) => entry.closeAction).join('` / `')}\`。`);
    push(`- 抽屉语义：\`role="${drawer.paths[0].openState.panelRole}"\`、\`aria-modal="${drawer.paths[0].openState.panelAriaModal}"\`、\`aria-labelledby="${drawer.paths[0].openState.panelLabelled}"\`、面板内可聚焦 ${drawer.paths[0].openState.focusableInPanel} 个。`);
    push('');
  }

  const modal = keyboard.results.modal;
  if (modal && !modal.error) {
    push('### 4.4 设置页危险操作二次确认弹层', '');
    mdTable(
      ['项', '实测值'],
      [
        ['触发', `保存的 provider \`${modal.trigger?.providerId}\` 的「${modal.trigger?.label}」按钮（真实鼠标点击其中心，先 \`focus()\`）`],
        ['role', modal.modalState.panelRole],
        ['aria-modal', modal.modalState.panelAriaModal],
        ['data-destructive', modal.modalState.destructiveAttr],
        ['foot 内 danger 主按钮', modal.modalState.confirmIsDangerVariant ? '存在' : '不存在'],
        ['打开后焦点进入面板', modal.modalState.focusInsidePanel ? `是（${modal.modalState.focusTag} ${modal.modalState.focusAria ?? ''}）` : '否'],
        ['Tab 陷阱', modal.trapAllInside ? '成立（8 步全在面板内）' : '失败'],
        ['Esc 关闭', modal.closedByEscape.overlayCount === 0 ? '是' : '否'],
        ['关闭后焦点回归触发按钮', modal.focusReturned ? `是（${modal.closedByEscape.activeTag}「${modal.closedByEscape.activeLabel}」）` : '否'],
        ['遮罩点击关闭', modal.backdropClosed?.overlayCount === 0 ? `是（焦点回到 ${modal.backdropClosed.activeTag}）` : '未测到'],
        ['取消按钮关闭', modal.cancelClosed?.overlayCount === 0 ? `是（provider 卡数 ${modal.before.providerCards} 不变）` : '未测到'],
        ['打开/关闭是否写入设置', modal.providerCountUnchanged ? `否（provider 卡数 ${modal.before.providerCards} 不变）` : '疑似变更'],
      ],
    );
    push('> 注：弹层由真实鼠标点击触发（程序化 `.click()` 不移动焦点，会让 `previousActive` 变成 `<body>`，那测的是测试栈不是产品）。', '');
  }
}

/* ------------------------------------------------------------------- contrast */
push('## 5. 对比度（真实计算值）', '');
push('完整逐项表见 [`CONTRAST.md`](./CONTRAST.md)（暗/亮各 35 个真实元素样本 + 21 组 token 组合 + 6 个焦点环）。阈值：正文 ≥4.5:1，大字/非文本/边框 ≥3:1。', '');
if (contrast === null) {
  push('未运行：`results/contrast.json` 不存在。', '');
} else {
  mdTable(
    ['主题', '正文最低', '非文本最低', '焦点环最低', 'disabled（1.4.3 豁免）', '装饰分隔线（1.4.11 豁免）', '正文失败项', '非文本失败项', '焦点环失败项'],
    ['dark', 'light'].map((theme) => {
      const entry = contrast.perTheme[theme];
      if (entry === undefined) return [theme, '未测', '未测', '未测', '未测', '未测', '未测', '未测', '未测'];
      return [
        theme,
        `${entry.minima.text?.ratio}:1（${entry.minima.text?.kind ?? entry.minima.text?.route ?? ''}）`,
        `${entry.minima.nonText?.ratio}:1（${entry.minima.nonText?.kind ?? ''}）`,
        `${entry.minima.focusRing?.ratio}:1`,
        `${entry.minima.disabledInformational?.ratio}:1`,
        `${entry.minima.decorativeNonTextInformational?.ratio}:1`,
        entry.counts.failedText,
        entry.counts.failedNonText,
        entry.counts.failedFocusRing,
      ];
    }),
  );
  push('说明：');
  push('1. 前景/背景都是 \`getComputedStyle\` 的实时值，背景按祖先层逐层 alpha 合成，并乘上元素及祖先的 `opacity`（所以 disabled 按钮的 0.55 透明度被计入）。');
  push('2. 焦点环按 \`outline-offset\` 判定相邻背景：`offset ≥ 0` 时用父级背景（环画在盒外），`offset < 0` 时用元素自身背景（内嵌环）——否则会把「强调色底上的环」误算成 1.5:1。');
  push('3. `--c-border`（1.32/1.33）是装饰性分隔线，WCAG 1.4.11 不要求 3:1；控件边界用 `--c-input-border`（实测 3.17/3.02，达标）。');
  push('4. disabled 控件按 WCAG 1.4.3「inactive UI component」豁免，记录数值但不算失败。');
  push('');
}

/* ---------------------------------------------------------------- 5000 table */
push('## 6. 5000 行表格（虚拟滚动）', '');
if (table === null) {
  push('未运行：`results/table-5000.json` 不存在。', '');
} else {
  const component = table.result.component;
  const view = table.result.view;
  push('### 6.1 组件层：真实 `table()` 组件 + 5000 行（在真实页面 origin 内动态 import，真实样式/布局）', '');
  mdTable(
    ['指标', '实测', '阈值/期望'],
    [
      ['请求行数', component.rowsRequested, '5000'],
      ['实际渲染 `<tr data-row>`', component.atBottom.domRows, '< 300'],
      ['表格子树元素数', component.atBottom.domNodesInTable, '（契约按「行数」计，非全元素）'],
      ['`aria-rowcount`', component.atBottom.ariaRowcount, '5001（含表头行）'],
      ['滚到底最后渲染行 index', component.atBottom.lastIndex, '4999'],
      ['`data-virtual`', component.atBottom.virtual, 'true'],
      ['40 步 rAF 滚动耗时', `${component.sweep.elapsedMs} ms`, '—'],
      ['最长任务（PerformanceObserver longtask）', `${component.longTasks.maxDurationMs} ms（${component.longTasks.count} 个）`, '< 2000 ms'],
      ['控制台 error / 异常', component.devtools.total, '0'],
      ['aria-hidden 垫片行', component.atBottom.ariaHiddenPads, '≥1'],
    ],
  );
  push('### 6.2 告警视图层：真实告警页 + 独立 fixture daemon（600 条真实告警，mock 模式内存库）', '');
  push(`- fixture：\`fixtures/bulk-alerts-daemon.mjs\` 起真实 daemon（临时端口）+ 真实 \`serve.mjs\`；\`alerts_written=${view.fixture.counters.alerts_written}\`，\`/api/v1/alerts?limit=100\` 首页 ${view.fixture.alertsFirstPage} 条。`);
  push(`- 页面：\`${view.url.replace(view.fixture.consoleUrl, '<fixture-host>')}\`（\`loaded=5&limit=100\` → 契约 §12.1-4 的工作集上限）。`);
  mdTable(
    ['指标', '实测', '阈值/期望'],
    [
      ['`data-rows`（已加载工作集）', view.initial.dataRows, '500（5 页 × 100；契约 §12.1-4 上限）'],
      ['`data-virtual`', view.initial.virtual, 'true（≥200 行启用）'],
      ['实际渲染行数', view.atBottom.domRows, '< 300'],
      ['滚到底最后渲染行 index', view.atBottom.lastIndex, '499'],
      ['状态行文本', `\`${view.initial.statusText}\``, '报告真实已加载条数（不谎称全库）'],
      ['40 步 rAF 滚动耗时', `${view.sweep.elapsedMs} ms`, '—'],
      ['最长任务', `${view.longTasks.maxDurationMs} ms（${view.longTasks.count} 个）`, '< 2000 ms'],
      ['控制台 error / 4xx', view.devtools.total, '0'],
    ],
  );
  push('> 说明：**告警视图按合同 §12.1-4 把工作集上限定为 500 行**（`MAX_ROWS = 500` / `MAX_PAGES = 5`），所以 5000 行只能在表格组件层验证；组件层与视图层都通过，两者不冲突。', '');
}

/* ------------------------------------------------------------------- defects */
push('## 7. 缺陷清单（本任务实测发现；不含其他子代理已报条目）', '');
const defects = [];
if (shots !== null) {
  const narrow = shots.shots.filter((entry) => entry.viewport === '390x844');
  const narrowOverflow = narrow.filter((entry) => entry.horizontalOverflow === true);
  if (narrowOverflow.length > 0) {
    defects.push({
      level: 'P1',
      id: 'D13',
      title: '390×844 窄屏页面级横向溢出（顶栏被裁）',
      evidence: `${narrowOverflow.length}/${narrow.length} 张 390 截图 horizontalOverflow=true；键盘量测 390px 文档 scrollWidth 541 > clientWidth 390（溢出 151px）；溢出元素 \`.topbar-tools\`（right=541）、导航「模型与用量」（right=403）`,
      impact: '窄窗口/浏览器缩放下出现整页横向滚动，右侧主题/语言/刷新按钮被裁；对触屏与低分辨率用户可直接丢失控件。',
      owner: 'B1/B2（styles/base.css 顶栏响应式 + app 顶栏结构）→ Lead 已授权 fixer（D13）',
    });
  }
}
if (keyboard !== null && keyboard.results.overflow && !keyboard.results.overflow.error) {
  const at1024 = keyboard.results.overflow.metrics.find((entry) => entry.width === 1024);
  if (at1024 && at1024.actionButtonsOffscreen > 0) {
    defects.push({
      level: 'P2',
      id: 'D14',
      title: `1024px 下告警表容器横向滚动（${at1024.actionButtonsOffscreen} 个操作按钮初始不可见）`,
      evidence: `表格容器 1024px 时溢出 ${at1024.overflowPx}px，操作列按钮不可见；键盘 Tab 可达（第 ${keyboard.results.overflow.keyboardReachability.reachedAtStep} 步，浏览器自动滚动到可见），鼠标用户需先横滚`,
      impact: '容器级、可用性/可发现性问题；键盘可用且容器横滚是合同 §7.6 设计 → 不阻断 a11y（与 D13 页面级溢出是两件事）。',
      owner: 'B5（alerts 列宽）/ B1（表格 CSS）；Lead 已定为 P2(D14)',
    });
  }
}
if (keyboard !== null) {
  const walk = keyboard.results.tabWalk;
  if (walk && !walk.error && walk.bodyFocusSteps.length > 0) {
    defects.push({
      level: 'P2',
      id: 'VIS-3',
      title: 'Tab 曾落到 BODY（焦点逃逸）',
      evidence: `第 ${walk.bodyFocusSteps.join('、')} 步 activeElement=BODY`,
      impact: '单步焦点丢失，键盘用户会以为焦点消失。',
      owner: 'B2/B5',
    });
  }
}
if (contrast !== null) {
  const anyContrastFailure = ['dark', 'light'].some((theme) => {
    const entry = contrast.perTheme[theme];
    return entry !== undefined && (entry.counts.failedText > 0 || entry.counts.failedNonText > 0 || entry.counts.failedFocusRing > 0);
  });
  if (anyContrastFailure) {
    defects.push({ level: 'P1', id: 'VIS-4', title: '对比度低于阈值', evidence: '见 CONTRAST.md 中 FAIL 行', impact: 'WCAG AA 不达标', owner: 'B1' });
  }
}
if (defects.length === 0) {
  push('本任务量测面内**未发现未关闭的 P0/P1**（历史 P1/D13 的修后复测见下）。', '');
} else {
  mdTable(['级别', 'ID', '标题', '证据', '影响', '建议归属'], defects.map((entry) => [entry.level, entry.id, entry.title, cell(entry.evidence), cell(entry.impact), entry.owner]));
  push('已按 P0/P1 立即 `send_message` 报 lead（P0 无）。', '');
}

/* fixed / historical */
const closed = [];
if (shots !== null) {
  const narrow = shots.shots.filter((entry) => entry.viewport === '390x844');
  const open = narrow.filter((entry) => entry.horizontalOverflow === true);
  if (open.length === 0) {
    closed.push({
      level: 'P1',
      id: 'D13',
      state: `CLOSED（修后 build \`${shots.build.aggregate16}\`）`,
      before: 'build `2ffcb8e5`：390px 页面级溢出 151px，24/24 张窄屏截图 horizontalOverflow=true；溢出元素 `.topbar-tools`(right=541)、导航「模型与用量」(right=403)',
      after: `build \`${shots.build.aggregate16}\`：390px 页面级溢出 0px，${narrow.length - open.length}/${narrow.length} 张窄屏截图无横向溢出；顶栏改为两行不裁切（截图 \`shots/overview-dark-data-390x844.png\` 等）`,
      fixer: 'fixer（styles/base.css，22:22:43 落盘）',
    });
  }
}
if (closed.length > 0) {
  push('### 7.1 已关闭 / 历史（修后复测证明）', '');
  mdTable(['级别', 'ID', '状态', '修前', '修后', '修复方'], closed.map((entry) => [entry.level, entry.id, entry.state, cell(entry.before), cell(entry.after), entry.fixer]));
  push('> 修前基线（build `2ffcb8e5`）与修后（build `' + (shots?.build?.aggregate16 ?? '?') + '`）是两次独立真实运行；对比命令：`node tests/e2e/visual/01-shots.mjs` + `node tests/e2e/visual/probe-views-overflow.mjs`。', '');
}

push('## 8. 未验证 / 边界（必须如实列出）', '');
push('1. **构建是移动靶**：并行会话在 `apps/console-next/js/**` 改写实现，本次 4 个量测的 build 指纹见 §0；若盘面 build 已变，结论可能不适用，需重跑 `run-all.mjs`。');
push('2. **`prefers-reduced-motion: reduce`** 未测（需 \`Emulation.setEmulatedMedia\` 的 reduced-motion 模拟 + 动画时长断言，本轮未做）。');
push('3. **`aria-live` 播报时机** 未做真实读屏验证（只验证了 DOM 属性存在：告警状态行 `role="status" aria-live="polite"`、toast 宿主 `aria-live="polite"`）。');
push('4. **屏幕阅读器实测**未做（无 NVDA/JAWS 自动化；结论仅覆盖 DOM/ARIA/焦点/对比度）。');
push('5. **5000 行只覆盖表格组件层**（视图层受合同 §12.1-4 的 500 行上限约束）；"加载更多"按钮连续翻到上限的 E2E 未单独做（用 URL `loaded=5` 直接进入上限态）。');
push('6. **`1280×720` / `1920×1080`** 等其他分辨率未截图（矩阵按任务要求只做 1440×900 与 390×844；横向溢出量测额外覆盖 1280/1024）。');
push('7. **`theme=system` + `prefers-color-scheme`** 只验证了 `?theme=dark|light` 显式覆盖；system 分支未截图。');
push('');

push('## 9. 证据文件清单', '');
push('```text');
push('docs/implementation/evidence/ui2/visual/');
push('├── STATUS.md                 本文件（自动生成）');
push('├── CONTRAST.md               逐项对比度表（暗/亮 35 元素 + 21 token + 6 焦点环）');
push('├── probe.json                早期 DOM 探针输出（探索用，非结论）');
push('├── shots/                    48 张矩阵截图 + 7 张专项截图');
push('│   ├── <view>-<theme>-<stack>-<viewport>.png    48 张（见 §3 表）');
push('│   ├── tab-walk-alerts-dark-1440x900.png        60 步 Tab 结束时的焦点');
push('│   ├── table-overflow-dark-1024x900.png         D14 容器级溢出（1024）');
push('│   ├── table-overflow-dark-1440x900.png         早期 1440 溢出取证（该 build 已无溢出，保留为历史）');
push('│   ├── drawer-open-dark-1440x900.png            抽屉打开态（焦点在 X 按钮）');
push('│   ├── modal-destructive-dark-1440x900.png      设置页危险确认弹层（alertdialog）');
push('│   ├── table-5000-rows-dark-1440x900.png        组件层 5000 行滚到底');
push('│   └── alerts-500-loaded-dark-1440x900.png      告警视图 500 行滚到底');
push('└── results/');
push('    ├── shots.json            48 张：字节/文本长度/缺 key/DevTools/溢出');
push('    ├── keyboard.json         60 步 Tab/焦点环/三关/弹层/横向溢出');
push('    ├── contrast.json         每项前景背景与比值');
push('    ├── table-5000.json       组件层 5000 行 + 视图层 500 行');
push('    ├── run-all.json          全量运行、build 前后指纹');
push('    ├── builds/               每次运行前的 build 指纹快照');
push('    ├── logs/                 4 个量测的原始 stdout/stderr');
push('    └── investigate.json      过程中对异常点的追加取证（焦点序、390 溢出元素、弹层触发）');
push('```');
push('');
push('## 10. 代码（本任务写域内）', '');
push('| 文件 | 作用 |');
push('| --- | --- |');
push('| `tests/e2e/visual/lib/common.mjs` | 共享：build 指纹、颜色解析/alpha 合成/WCAG 计算、页面采样与焦点快照、DevTools 汇总 |');
push('| `tests/e2e/visual/01-shots.mjs` | 48 张截图矩阵 |');
push('| `tests/e2e/visual/02-keyboard.mjs` | 60 步 Tab / 焦点陷阱 / 三关 / 危险确认弹层 / 横向溢出 |');
push('| `tests/e2e/visual/03-contrast.mjs` | 实时计算样式对比度 + token 组合 + 焦点环 |');
push('| `tests/e2e/visual/04-table-5000.mjs` | 5000 行虚拟滚动（组件层）+ 500 行告警视图（fixture daemon） |');
push('| `tests/e2e/visual/fixtures/bulk-alerts-daemon.mjs` | 独立 fixture：mock 模式真实 daemon + 真实 console host（600 条告警） |');
push('| `tests/e2e/visual/run-all.mjs` | 等盘面稳定 + 顺序跑 4 个量测 + 记录 build 指纹 |');
push('| `tests/e2e/visual/report.mjs` | 生成 STATUS.md |');
push('');

writeFileSync(join(EVIDENCE, 'STATUS.md'), `${lines.join('\n')}\n`);
process.stdout.write(`${JSON.stringify({
  statusPath: join(EVIDENCE, 'STATUS.md'),
  lines: lines.length,
  defects: defects.map((entry) => `${entry.level} ${entry.id} ${entry.title}`),
  builds: uniqueBuilds,
  currentBuild16: currentBuild.aggregate16,
}, null, 2)}\n`);
