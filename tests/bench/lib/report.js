/**
 * lib/report.js — 产物写出与门禁判定。
 *
 * 纪律：
 * 1. **机器可读的 JSON 是主产物，Markdown 是它的可读投影**。两者由同一份内存结果生成，
 *    不允许手写 Markdown 里的数字——那是最容易过期的地方。
 * 2. **门禁必须能失败**。每个 check 都有 `expected` 与 `actual` 两个字段，
 *    失败时退出码非零。只打印"看起来不错"的报告等于没有门禁。
 * 3. **未采集的指标写 `null`，不写 0**。0 会被读成"测到零"，null 只能被读成"没测"。
 */

import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './env.js';

/** 产物默认目录（仓库内，允许写入的证据目录）。 */
export const EVIDENCE_DIR = path.join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'bench');

/** 结果结构版本；字段语义变化时必须升。 */
export const RESULT_SCHEMA = 'aegis.bench/1';

/**
 * 把 ISO 时间转成可用于文件名的形式（无冒号，Windows 友好）。
 *
 * @param {string} iso ISO 时间。
 * @returns {string} 例如 `20261102T184000Z`。
 */
export function stampOf(iso) {
  // 只保留到秒，去掉毫秒与冒号（Windows 文件名不允许冒号）。
  return iso.replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
}

/**
 * 追加一条检查项。
 *
 * @param {object[]} sink 收集数组。
 * @param {{
 *   id: string, description: string, expected: unknown, actual: unknown,
 *   passed: boolean, severity?: 'blocker'|'warn', note?: string
 * }} check 检查项。
 * @returns {void}
 */
export function addCheck(sink, check) {
  sink.push({
    id: check.id,
    description: check.description,
    expected: check.expected === undefined ? null : check.expected,
    actual: check.actual === undefined ? null : check.actual,
    passed: check.passed === true,
    severity: check.severity ?? 'blocker',
    ...(check.note === undefined ? {} : { note: check.note }),
  });
}

/**
 * 判定整体结论。
 *
 * 只有 `severity === 'blocker'` 且未通过才算失败；`warn` 不通过只进 `warnings`，
 * 但**仍然要出现在报告里**，否则"警告"就变成了静默。
 *
 * @param {object[]} checks 检查项。
 * @returns {{verdict: 'pass'|'fail', failures: string[], warnings: string[]}} 结论。
 */
export function evaluateChecks(checks) {
  const failures = checks.filter((check) => check.severity === 'blocker' && check.passed === false).map((c) => c.id);
  const warnings = checks.filter((check) => check.severity === 'warn' && check.passed === false).map((c) => c.id);
  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    failures,
    warnings,
  };
}

/**
 * 写出 JSON 与 Markdown。
 *
 * @param {{
 *   outDir?: string, baseName: string, result: object, markdown: string
 * }} options 选项。
 * @returns {{json_path: string, markdown_path: string}} 产物路径。
 */
export function writeArtifacts(options) {
  const outDir = options.outDir ?? EVIDENCE_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${options.baseName}.json`);
  const markdownPath = path.join(outDir, `${options.baseName}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(options.result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, options.markdown, 'utf8');
  return { json_path: jsonPath, markdown_path: markdownPath };
}

/**
 * 把数字格式化成短的、稳定的文本。
 *
 * @param {unknown} value 值。
 * @returns {string} 文本。
 */
function fmt(value) {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return String(value);
    }
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(Number(value.toFixed(3)));
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (typeof value === 'object') {
    return `\`${JSON.stringify(value)}\``;
  }
  return String(value);
}

/**
 * 字节数 → GiB 文本。报告正文给人看，原始字节留在 JSON 里。
 *
 * @param {unknown} bytes 字节。
 * @returns {string} 文本。
 */
function gibOf(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
    return '—';
  }
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * 渲染一个指标表。
 *
 * @param {Array<{name: string, value: unknown, unit?: string, note?: string}>} metrics 指标。
 * @returns {string} Markdown。
 */
function metricsTable(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    return '';
  }
  const lines = ['| 指标 | 值 | 单位 | 说明 |', '|---|---|---|---|'];
  for (const metric of metrics) {
    lines.push(`| ${metric.name} | ${fmt(metric.value)} | ${metric.unit ?? ''} | ${metric.note ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 渲染通用结果（bench 与 soak 共用）。
 *
 * @param {object} result 结果对象。
 * @returns {string} Markdown 全文。
 */
export function renderMarkdown(result) {
  const out = [];
  out.push(`# ${result.kind === 'soak' ? 'M9 短时浸泡报告' : 'M9 性能基准报告'}`);
  out.push('');
  out.push(`- task_id: \`${result.task_id}\``);
  out.push(`- 生成时间: ${result.generated_at}`);
  out.push(`- 结论: **${result.verdict.toUpperCase()}**`);
  out.push(`- 种子: \`${result.seed}\`；档位: \`${result.profile}\``);
  out.push(`- 运行时长: ${(result.duration_ms / 1000).toFixed(1)} s`);
  out.push(`- 结果结构: \`${result.schema}\``);
  out.push('');

  out.push('## 环境');
  out.push('');
  out.push('| 项 | 值 |');
  out.push('|---|---|');
  out.push(`| OS | ${fmt(result.env.platform.os)} ${fmt(result.env.platform.release)} (${fmt(result.env.platform.arch)}) |`);
  out.push(`| CPU | ${fmt(result.env.cpu.model)} / ${fmt(result.env.cpu.logical_cores)} 逻辑核 |`);
  out.push(`| 内存 | ${gibOf(result.env.memory.total_bytes)}（运行前空闲 ${gibOf(result.env.memory.free_bytes_before_run)}） |`);
  out.push(`| Node | ${fmt(result.env.node.version)} |`);
  out.push(`| SQLite | ${fmt(result.env.sqlite_version)} |`);
  out.push(`| 临时目录所在盘可用 | ${gibOf(result.env.disk.temp_root_disk?.free_bytes)} |`);
  out.push(`| GC 可用 | ${fmt(result.env.runtime.gc_exposed)} |`);
  out.push('');

  for (const scenario of result.scenarios ?? []) {
    out.push(`## ${scenario.title}`);
    out.push('');
    if (scenario.summary) {
      out.push(scenario.summary);
      out.push('');
    }
    if (scenario.parameters) {
      out.push(`参数：\`${JSON.stringify(scenario.parameters)}\``);
      out.push('');
    }
    out.push(metricsTable(scenario.metrics));
    if (Array.isArray(scenario.tables)) {
      for (const table of scenario.tables) {
        out.push(`**${table.title}**`);
        out.push('');
        out.push(metricsTable(table.rows));
      }
    }
    if (Array.isArray(scenario.observations) && scenario.observations.length > 0) {
      out.push('观察：');
      out.push('');
      for (const observation of scenario.observations) {
        out.push(`- ${observation}`);
      }
      out.push('');
    }
  }

  if (Array.isArray(result.findings) && result.findings.length > 0) {
    out.push('## 发现（只报告，不修改生产代码）');
    out.push('');
    out.push('| id | 级别 | 说明 | 来源检查 |');
    out.push('|---|---|---|---|');
    for (const finding of result.findings) {
      out.push(`| ${finding.id} | ${finding.severity} | ${finding.title} | \`${finding.source_check}\` |`);
    }
    out.push('');
    for (const finding of result.findings) {
      out.push(`**${finding.id}（${finding.severity}）** ${finding.title}`);
      out.push('');
      out.push(`> ${finding.detail}`);
      out.push('');
    }
  }

  out.push('## 检查项');
  out.push('');
  out.push('| id | 说明 | 期望 | 实测 | 结果 | 级别 |');
  out.push('|---|---|---|---|---|---|');
  for (const check of result.checks ?? []) {
    out.push(
      `| \`${check.id}\` | ${check.description} | ${fmt(check.expected)} | ${fmt(check.actual)} `
        + `| ${check.passed ? 'PASS' : 'FAIL'} | ${check.severity} |`,
    );
  }
  out.push('');
  if (result.failures?.length > 0) {
    out.push(`失败项：${result.failures.map((id) => `\`${id}\``).join('、')}`);
    out.push('');
  }
  if (result.warnings?.length > 0) {
    out.push(`警告项：${result.warnings.map((id) => `\`${id}\``).join('、')}`);
    out.push('');
  }

  if (Array.isArray(result.limitations) && result.limitations.length > 0) {
    out.push('## 已知限制');
    out.push('');
    for (const limitation of result.limitations) {
      out.push(`- ${limitation}`);
    }
    out.push('');
  }

  if (Array.isArray(result.notes) && result.notes.length > 0) {
    out.push('## 说明');
    out.push('');
    for (const note of result.notes) {
      out.push(`- ${note}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('作者：PT-dove');
  out.push('');
  return out.join('\n');
}
