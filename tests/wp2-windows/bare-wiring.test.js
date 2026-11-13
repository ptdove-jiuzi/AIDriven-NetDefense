// author: PT-dove
// D3 回归（SEED-04 派生 / UI2-INTEGRATION 遗留 P1）：`--collectors` 裸接线。
//
// 缺陷形态（21:45 前的 daemon 适配器 + 采集器模块）：`attachWindowsSources()` 返回
// `{ name, descriptor, collector, binding }` 包装，`poll()` 在嵌套的 `binding` 上；
// 而 daemon 的 `createCollectorDaemonSource()` 要的是**扁平** binding（顶层 `poll()`）→
// `SOURCE_INVALID: a collector binding exposing poll() is required`，真实 Windows 采集器
// 经 `--collectors <spec>` 无法产源。
//
// 修复取向：不改 daemon 适配器（属 fix-daemon 写域），在 `packages/collectors/**` 侧让
// `attachWindowsSources()` 的返回对象**同时**满足扁平 binding 契约（保留嵌套 `binding`
// 以兼容既有调用方）。本文件覆盖两层：
// 1) 包装对象直接交给 `createCollectorDaemonSource()`（旧 daemon 的消费方式）必须成功；
// 2) 真实 `--collectors` 路径（loadCollectorSpec → buildSourcesFromSpec）必须产源。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCollectorDaemonSource,
  loadCollectorSpec,
  buildSourcesFromSpec,
} from '../../apps/daemon/src/adapters/collector-sources.js';
import {
  createCollectorRuntime,
  createMemoryCursorStore,
} from '../../packages/collectors/common/index.js';
import {
  attachWindowsSources,
  createWindowsSources,
} from '../../packages/collectors/windows/index.js';

const CLOCK = () => 1_700_000_000_000;
const BOOT_ID = '0123456789abcdef0123456789abcdef';

function collectorRuntime() {
  return createCollectorRuntime({
    store: createMemoryCursorStore({ clock: CLOCK }),
    clock: CLOCK,
    bootId: BOOT_ID,
  });
}

test('attachWindowsSources 返回值满足扁平 binding 契约（裸接线核心判据）', () => {
  const runtime = collectorRuntime();
  const sources = createWindowsSources({
    include: ['processes'],
    powershell: { runJson: async () => [] },
    clock: CLOCK,
  });
  const [entry] = attachWindowsSources({ runtime, sources });

  // 嵌套形状保持兼容。
  assert.equal(typeof entry.binding.poll, 'function', 'the nested binding is still exposed');
  assert.equal(entry.descriptor.stableSourceId, 'windows.process-table');

  // 旧 daemon 只认扁平 binding：包装对象本身必须能直接建出源。
  const source = createCollectorDaemonSource(entry, {
    cursorStore: createMemoryCursorStore({ clock: CLOCK }),
    clock: CLOCK,
  });
  assert.equal(typeof source.poll, 'function', 'the daemon source must expose poll()');
  assert.equal(source.id, 'windows.process-table');
  assert.equal(source.kind, 'process');
});

test('--collectors 裸接线：真实采集器模块经 spec 产源', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aidn-d3-wiring-'));
  try {
    const specPath = join(directory, 'collectors.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        collectorModule: fileURLToPath(new URL('../../packages/collectors/windows/index.js', import.meta.url)),
        commonModule: fileURLToPath(new URL('../../packages/collectors/common/index.js', import.meta.url)),
        options: { include: ['processes', 'services'] },
        bootId: BOOT_ID,
      }),
      'utf8',
    );

    const spec = loadCollectorSpec(specPath);
    const wiring = await buildSourcesFromSpec(spec, { clock: CLOCK });

    assert.equal(wiring.sources.length >= 2, true, 'the wiring must produce one daemon source per collector source');
    for (const source of wiring.sources) {
      assert.equal(typeof source.poll, 'function', `${source.id} must expose poll()`);
      assert.match(source.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    }
    assert.equal(
      wiring.sources.some((source) => source.id === 'windows.process-table'),
      true,
      'the real Windows collector module must be wired',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
