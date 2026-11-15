/**
 * fake-executor.mjs — **测试替身**，不是产品代码。
 *
 * 为什么需要它：0.0.1 没有执行器（`apps/daemon/src/api/chat.js:829-836`
 * `executed:false / EXECUTION_DISABLED`，合同 §2.7）。因此"批准也不写文件"是结构性结论，
 * 单看它无法区分"审批门挡住了执行"与"根本没有执行器"。
 * 这个假执行器提供**阳性对照**：把与假 provider 完全相同的 tool_call 参数喂给它，文件必须出现。
 * ⇒ 证明 canary 有牙：将来真出现绕过审批的执行器，C1（未审批 → 文件不存在）会立刻转红。
 *
 * 边界：只写 `<TEMP>\p1r2-side\` 下的路径，不联网、不读 key、不被任何 `apps/**` 引用。
 *
 * @author PT-dove
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 允许写入的唯一沙箱目录（显式用长路径，避免 SUBST 短路径混淆）。 */
export const SANDBOX_DIR = process.env.P1R2_SIDE_DIR ?? 'C:\\Users\\user\\AppData\\Local\\Temp\\p1r2-side';

/**
 * Execute one tool call — **only** for canary evidence.
 *
 * @param {{name: string, arguments: {path?: string, content?: string}}} call Tool call.
 * @returns {{executed: boolean, path: string|null, exists: boolean, sha256: string|null, reason: string|null}} Result.
 */
export function executeToolCall(call) {
  const name = call?.name;
  const args = call?.arguments ?? {};
  if (name !== 'write_file') {
    return { executed: false, path: null, exists: false, sha256: null, reason: 'TOOL_NOT_IN_ALLOWLIST' };
  }
  if (typeof args.path !== 'string' || args.path === '') {
    return { executed: false, path: null, exists: false, sha256: null, reason: 'PATH_MISSING' };
  }
  const target = resolve(args.path);
  const root = resolve(SANDBOX_DIR);
  // 沙箱外一律拒绝：假执行器不得成为任意文件写入器。
  if (!target.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) {
    return { executed: false, path: target, exists: false, sha256: null, reason: 'PATH_OUTSIDE_SANDBOX' };
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(target, typeof args.content === 'string' ? args.content : '', 'utf8');
  const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
  return { executed: true, path: target, exists: existsSync(target), sha256: digest, reason: null };
}
