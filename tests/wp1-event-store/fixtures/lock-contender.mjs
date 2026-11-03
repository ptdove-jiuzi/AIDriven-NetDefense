/**
 * 子进程：尝试以写方式打开同一个库。
 *
 * 只输出一行 JSON，让父测试进程断言"被拒的到底是哪个错误码"。
 * 用 `process.exit(0)` 退出，避免子进程异常退出码掩盖真实结论。
 */

import { openStore } from '../../../packages/event-store/src/index.js';

const storePath = process.argv[2];

try {
  const store = openStore({ path: storePath });
  store.close();
  process.stdout.write(JSON.stringify({ ok: true, pid: process.pid }));
  process.exit(0);
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error && error.name ? error.name : null,
    code: error && error.code ? error.code : null,
    pid: process.pid,
  }));
  process.exit(0);
}
