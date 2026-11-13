/**
 * UI2-B11 · 变异验证（"删掉功能必须变红"）
 *
 * 三条必需（lead 指定优先级）：
 * - M1 DOM 三态：删掉 table 的 empty 状态渲染 → 三态断言必须红；
 * - M2 SSE 累积：删掉按 seq 排序 → 累积断言必须红；
 * - M3 凭据 canary：让 credentials/put 回显明文 → canary 零泄漏断言必须红。
 *
 * 方法：复制被测源码到临时目录 → 单点篡改副本 → 用**同一判据函数**分别跑
 * 正式实现（必须绿）与变异副本（必须红）。不改仓库内任何被测文件。
 *
 * 运行：`node --test tests/console-next/mutations.test.js`
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startConsoleApi, chatReadySettings } from '../wp5-daemon/console-fixtures.mjs';
import { startFakeProvider } from './fake-provider.mjs';
import { installDom, visibleText } from './dom-shim.mjs';
import { captureOracle, copyDir, importFresh, makeMutationDir, patchFile, removeDir } from './mutation-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const UI_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'js', 'components', 'ui');
const SSE_DIR = path.join(REPO_ROOT, 'apps', 'console-next', 'js');
const BROKER_DIR = path.join(REPO_ROOT, 'apps', 'model-broker');
const REAL_HOST = path.join(BROKER_DIR, 'bin', 'console-host.js');

function canary() {
  return `sk-canary-mutation-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

/** 同一判据：空态必须渲染出调用方给的标题（DOM 三态之一）。 */
function emptyStateOracle(tableImpl) {
  const dom = installDom();
  try {
    const node = tableImpl({ columns: [{ key: 'rule', label: '规则' }], rows: [], empty: { title: '暂无告警' } });
    assert.ok(visibleText(node).includes('暂无告警'), 'empty table must render the empty-state title');
  } finally {
    dom.cleanup();
  }
}

/** 同一判据：SSE delta 必须按 seq 升序拼成文本。 */
function seqOrderOracle(createAccumulator) {
  const accumulator = createAccumulator();
  accumulator.push({ event: 'delta', data: { seq: 2, text: 'B' } });
  accumulator.push({ event: 'delta', data: { seq: 1, text: 'A' } });
  accumulator.push({ event: 'delta', data: { seq: 3, text: 'C' } });
  assert.equal(accumulator.text, 'ABC', 'SSE text must be ordered by seq, not arrival order');
}

test('M1 变异：删掉 table 的 empty 状态渲染 → DOM 三态判据变红（正式实现保持绿）', async (t) => {
  const dir = makeMutationDir('dom');
  t.after(() => removeDir(dir));
  copyDir(UI_DIR, path.join(dir, 'ui'));
  // 单点删除：empty 分支不再渲染 resolveEmpty(...) 的内容
  patchFile(path.join(dir, 'ui', 'table.js'), '[resolveEmpty(opts.empty)]', '[]');

  const mutant = await importFresh(path.join(dir, 'ui', 'table.js'), 'm1');
  const mutantResult = captureOracle(() => emptyStateOracle(mutant.table));
  const pristine = await importFresh(path.join(UI_DIR, 'table.js'), 'm1-pristine');
  const pristineResult = captureOracle(() => emptyStateOracle(pristine.table));

  assert.equal(pristineResult.ok, true, `pristine table must satisfy the oracle: ${pristineResult.message}`);
  assert.equal(mutantResult.ok, false, 'mutation must be caught (test would be a no-op otherwise)');
  assert.match(mutantResult.message, /暂无告警|empty-state/u);
  t.diagnostic(`M1 RED (mutation caught): ${mutantResult.message}`);
  t.diagnostic('M1 GREEN (pristine): empty state renders "暂无告警"');
});

test('M2 变异：删掉 SSE 按 seq 排序 → 累积判据变红（正式实现保持绿）', async (t) => {
  const dir = makeMutationDir('sse');
  t.after(() => removeDir(dir));
  copyDir(SSE_DIR, path.join(dir, 'js'));
  // 单点删除：recompute() 不再按 seq 排序，退化成 Map 插入顺序
  patchFile(
    path.join(dir, 'js', 'sse.js'),
    'const ordered = [...deltas.entries()].sort((a, b) => a[0] - b[0]);',
    'const ordered = [...deltas.entries()];',
  );

  const mutant = await importFresh(path.join(dir, 'js', 'sse.js'), 'm2');
  const mutantResult = captureOracle(() => seqOrderOracle(mutant.createSseAccumulator));
  const pristine = await importFresh(path.join(SSE_DIR, 'sse.js'), 'm2-pristine');
  const pristineResult = captureOracle(() => seqOrderOracle(pristine.createSseAccumulator));

  assert.equal(pristineResult.ok, true, `pristine SSE must satisfy the oracle: ${pristineResult.message}`);
  assert.equal(mutantResult.ok, false, 'mutation must be caught');
  assert.match(mutantResult.message, /ABC|ordered by seq/u);
  t.diagnostic(`M2 RED (mutation caught): ${mutantResult.message}`);
  t.diagnostic('M2 GREEN (pristine): seq 2,1,3 arrives as "ABC"');
});

test('M3 变异：chat 流里泄漏明文 → canary 零泄漏判据变红（正式 host 保持绿）', async (t) => {
  const dir = makeMutationDir('canary');
  t.after(() => removeDir(dir));
  copyDir(BROKER_DIR, path.join(dir, 'model-broker'));
  const mutantHost = path.join(dir, 'model-broker', 'bin', 'console-host.js');
  // 单点删除"密钥只在 Authorization header"保证：变异 host 在 chat 流里额外发一条 delta，
  // 内容是 readSecretForRuntime() 读出的明文（一个真实的"回显泄漏"缺陷形态）。
  patchFile(
    mutantHost,
    '      const credential = credentialFor(brand, provider);\n      const transport = createChatTransport({ endpoint: brand, credential });',
    '      const credential = credentialFor(brand, provider);\n      const __leaked = requireStore().readSecretForRuntime(provider.id);\n      if (__leaked) notifyChatEvent(requestId, Object.freeze({ type: \'delta\', text: __leaked }));\n      const transport = createChatTransport({ endpoint: brand, credential });',
  );

  const provider = await startFakeProvider(t);
  const key = canary();
  const oracle = async (hostPath) => {
    const harness = await startConsoleApi({ hostPath, settings: chatReadySettings(provider.port), requestTimeoutMs: 10000 });
    try {
      const put = await harness.request('/api/v1/credentials/ollama-local', { method: 'PUT', body: { apiKey: key } });
      assert.equal(put.status, 204);
      assert.equal(put.text, '', 'PUT /credentials must return an empty body');
      const stream = await harness.sse('/api/v1/agent/chat', {
        sessionId: `s_${'a'.repeat(32)}`,
        modelId: 'local-chat',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(stream.status, 200);
      assert.ok(!stream.text.includes(key), 'credential plaintext must never reach the SSE stream');
    } finally {
      await harness.close();
    }
  };

  // 正式 host：必须绿
  await oracle(REAL_HOST);

  // 变异 host：必须红
  let mutantError = null;
  try {
    await oracle(mutantHost);
  } catch (error) {
    mutantError = error;
  }
  assert.ok(mutantError !== null, 'mutation must be caught: chat stream carried the plaintext key');
  assert.match(`${mutantError.name}: ${mutantError.message}`, /plaintext|SSE stream/u);
  t.diagnostic(`M3 RED (mutation caught): ${mutantError.name}: ${mutantError.message}`);
  t.diagnostic('M3 GREEN (real host): SSE stream carries no plaintext credential');
});
