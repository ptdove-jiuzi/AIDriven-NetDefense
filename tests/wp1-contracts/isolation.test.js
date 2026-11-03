import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSnapshotGuard, createTestSandbox, snapshotDirectory } from '@aegisharness/test-support';

import {
  parseTelemetryEvent,
  validateAnalysisReport,
  validateAnalysisRequest,
  validateApproval,
  validateExecutionGrant,
  validateResponseProposal,
  validateTelemetryEvent,
} from '../../packages/contracts/src/index.js';
import {
  validAnalysisReport,
  validAnalysisRequest,
  validApproval,
  validExecutionGrant,
  validResponseProposal,
  validTelemetryEvent,
} from './helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'packages', 'contracts', 'src');

function runWholeRoutine() {
  validateTelemetryEvent(validTelemetryEvent());
  validateAnalysisRequest(validAnalysisRequest(), { allowedSummaryFields: [] });
  validateAnalysisReport(validAnalysisReport());
  validateResponseProposal(validResponseProposal());
  validateApproval(validApproval());
  validateExecutionGrant(validExecutionGrant());
}

test('沙箱受保护目录中的合成事件在校验后保持字节不变', () => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp1-' });
  try {
    const eventPath = join(sandbox.mockRealRoot, 'synthetic-event.json');
    writeFileSync(eventPath, JSON.stringify(validTelemetryEvent()), 'utf8');
    const guard = createSnapshotGuard({
      sandboxRoot: sandbox.root,
      protectedRoot: sandbox.mockRealRoot,
    });
    const before = guard.capture();
    const record = parseTelemetryEvent(readFileSync(eventPath, 'utf8'));
    assert.equal(record.schemaVersion, '1.0');
    assert.equal(guard.assertUnchanged(before), true);
  } finally {
    sandbox.cleanup();
  }
});

test('当前工作目录不在任何临时沙箱内，仓库 fixtures 未被写入', () => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp1-' });
  try {
    const cwd = process.cwd();
    assert.equal(cwd.startsWith(sandbox.root), false);
    /*
     * 原来这里还有一条"cwd 不得位于系统 tmpdir 下"的断言，已移除：它会把
     * 合法的 CI 临时目录检出（cwd=/tmp、$RUNNER_TEMP/...）判成违规，而它想防的
     * "测试跑在被测沙箱里"上一行已经覆盖。
     *
     * 但移除后只剩一条近乎恒真的断言（sandbox.root 是新建的空目录），强度不足。
     * 因此改为两条**有实际区分力**的断言：
     *   1. cwd 必须是一个包含 package.json 的仓库根，而不是随手建的临时目录；
     *   2. cwd 不得落在本测试刚创建的沙箱内（上面一条）。
     */
    assert.equal(
      existsSync(join(cwd, 'package.json')),
      true,
      'contracts 隔离测试必须从仓库根运行（cwd 下应有 package.json）',
    );

    const fixturesRoot = join(REPO_ROOT, 'tests', 'fixtures');
    const before = snapshotDirectory(fixturesRoot);
    runWholeRoutine();
    const after = snapshotDirectory(fixturesRoot);
    assert.deepStrictEqual(after, before);
  } finally {
    sandbox.cleanup();
  }
});

test('校验过程不写任何文件，workRoot 快照前后一致', () => {
  const sandbox = createTestSandbox({ prefix: 'aegisharness-wp1-' });
  try {
    const before = snapshotDirectory(sandbox.workRoot);
    runWholeRoutine();
    assert.deepStrictEqual(snapshotDirectory(sandbox.workRoot), before);
    assert.equal(readdirSync(sandbox.workRoot).length, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('实现源码不读取用户目录或环境变量', () => {
  const files = readdirSync(SRC_ROOT, { recursive: true })
    .map((entry) => String(entry).replaceAll('\\', '/'))
    .filter((entry) => entry.endsWith('.js'));
  assert.ok(files.length >= 15, `期望至少 15 个源文件，实际 ${files.length}`);
  for (const relativePath of files) {
    const text = readFileSync(join(SRC_ROOT, relativePath), 'utf8');
    assert.equal(/process\.env/.test(text), false, `${relativePath} 不应读取环境变量`);
    assert.equal(/homedir|USERPROFILE|node:os/.test(text), false, `${relativePath} 不应访问用户目录`);
  }
});
