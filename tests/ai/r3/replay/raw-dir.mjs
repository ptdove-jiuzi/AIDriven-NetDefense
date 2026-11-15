/**
 * raw-dir.mjs — P1-RECOVERY-2 · agent-fix-r3 复跑入口的产物目录。
 *
 * 为什么需要它：R2 的三个探针把 `RAW_DIR` 硬编码到 `evidence/p1-close-2/agent/raw/`，
 * 该目录在本席（agent-fix-r3）禁写域内。复跑时只替换产物目录，**场景实现原样引用**
 * `tests/ai/r2/lib/scenarios.mjs`，断言 id 与数量与 R2 完全一致。
 *
 * @author PT-dove
 */

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** 仓库根（本文件位于 `tests/ai/r3/replay/`）。 */
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** 本席原始产物目录。 */
export const RAW_DIR = join(REPO, 'evidence', 'p1-recovery', '40-agent', 'raw');
