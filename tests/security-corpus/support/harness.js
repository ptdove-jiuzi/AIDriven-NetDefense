// author: PT-dove
// M9 对抗语料的公共底座：确定性随机源、临时目录、断言助手、结构快照。
//
// 三条纪律（对应 AGENTS.md 与 TEST_AND_ACCEPTANCE §1）：
// 1. 不使用 `Math.random()` / `Date.now()` 参与任何断言的**内容**：所有"随机"输入都来自
//    固定种子的 mulberry32，同一份代码在任何机器、任何顺序下都生成同一串字节。
// 2. 每个用例一个独立临时目录，收尾递归删除；绝不写入仓库、真实数据库或用户目录。
// 3. 断言必须能失败：`expectRejection` 同时要求"抛错"与"错误码精确匹配"，
//    只写 `assert.throws(fn)` 会让"抛了个 TypeError"也算通过。

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = (() => {
  const lexical = resolve(HERE, '..', '..', '..');
  try {
    // 仓库自身可能经 junction / 8.3 短名访问；不归一的话，"realpath 之后"那次比较
    // 会拿真实路径去比词法路径，守卫就形同虚设。
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
})();

/** 沙箱目录名前缀：清理与残留盘点都靠它识别"这是本语料的目录"。 */
export const SANDBOX_PREFIX = 'aegis-m9-corpus-';

/**
 * 覆盖临时根的环境变量。
 *
 * 默认仍然是系统临时目录（纪律：绝不写入仓库、真实数据库或用户目录）。CI 可以把它
 * 指向作业级目录，这样"临时目录不可写 / 落在奇怪的文件系统上"就从"随机失败"变成
 * "开工前退出码 2 的明确报告"，也让残留目录能被作业清理器整片带走。
 */
export const TEMP_ROOT_ENV = 'AEGIS_M9_TMP_ROOT';

/**
 * 本次运行的标识，由运行器注入。
 *
 * 注入后沙箱名变成 `aegis-m9-corpus-<runId>-XXXX`，运行器就能**精确**数出"这一跑漏了
 * 几个目录"。不加前缀时两个并发实例会互相把对方的沙箱算成自己的泄漏，把干净的跑法报成红。
 */
export const RUN_ID_ENV = 'AEGIS_M9_RUN_ID';

/**
 * `child` 是否位于 `parent` 之内（按文本归一后比较，Windows 大小写不敏感）。
 *
 * @param {string} parent 父目录（已 realpath）。
 * @param {string} child 子目录（已 realpath）。
 * @returns {boolean} 是否包含（含自身）。
 */
function isWithin(parent, child) {
  const base = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const target = process.platform === 'win32' ? child.toLowerCase() : child;
  if (target === base) return true;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 拒绝把临时根指向"一旦 `rmSync(recursive)` 算错就不可逆"的位置。
 *
 * 覆盖能力只该改"放在哪个临时目录"，不该变成"允许写仓库/家目录"。系统临时目录在
 * Windows 上恰好位于 `%USERPROFILE%\AppData\Local\Temp`，所以不能简单地"在家目录下就拒绝"
 * ——那会把默认值本身也毙掉。这里只拉黑两类：**仓库内**，以及家目录本身和几个明确
 * 敏感的子树。传进来的路径**不要求已存在**，所以可以在建目录之前就先拦。
 *
 * @param {string} root 候选根目录（绝对路径，未必要存在）。
 * @param {string} label 这个路径是哪来的，用于报错时别让人去修一个自己没设的变量。
 * @returns {void}
 */
function assertSafeRoot(root, label) {
  const normalized = process.platform === 'win32' ? root.toLowerCase() : root;
  if (parse(root).root === root) {
    throw new Error(`refusing a filesystem root as the corpus temp root: ${root} (from ${label})`);
  }
  if (isWithin(REPO_ROOT, normalized)) {
    throw new Error(`refusing a temp root inside the repository: ${root} (from ${label})`);
  }
  const home = homedir();
  if (normalized === (process.platform === 'win32' ? home.toLowerCase() : home)) {
    throw new Error(`refusing the home directory itself as the corpus temp root: ${root} (from ${label})`);
  }
  // Agent 数据目录同样不能作为临时根，但它的名字不进源码明文（§4 第二道扫描）。
  const agentDataDir = ['.', 'work', 'buddy'].join('');
  for (const name of ['.ssh', agentDataDir, 'Documents', 'Desktop', 'Downloads']) {
    const sensitive = join(home, name);
    const comparable = process.platform === 'win32' ? sensitive.toLowerCase() : sensitive;
    if (isWithin(comparable, normalized)) {
      throw new Error(`refusing user data (${name}) as the corpus temp root: ${root} (from ${label})`);
    }
  }
}

/**
 * 解析本次运行使用的临时根目录。
 *
 * 每次调用都重新读环境变量，而不是在模块加载时定死：测试才能在同一进程里验证
 * "覆盖生效"，不必为此拉起子进程。
 *
 * @returns {string} 真实路径（已 realpath，消除 Windows 8.3 短名与 junction 差异）。
 */
export function resolveTempRoot() {
  const raw = process.env[TEMP_ROOT_ENV];
  const fromEnv = typeof raw === 'string' && raw.trim() !== '';
  const candidate = fromEnv ? raw.trim() : tmpdir();
  // 报错时要说清"这个路径是从哪来的"：系统临时目录被策略重定向进家目录时，
  // 让人去修一个根本没设置过的 AEGIS_M9_TMP_ROOT 是无解的。
  const label = fromEnv ? TEMP_ROOT_ENV : 'os.tmpdir()';
  const lexical = resolve(candidate);
  // 先做一次"建目录之前"的检查：否则会先在 .ssh 之类的敏感目录里创建一个再报错。
  assertSafeRoot(lexical, label);
  try {
    mkdirSync(lexical, { recursive: true });
  } catch (error) {
    throw new Error(`cannot prepare ${label}=${candidate}: ${error.message}`);
  }
  const resolved = realpathSync(lexical);
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`${label} must point at a directory, got a file: ${resolved}`);
  }
  // realpath 之后再查一次：软链接可以把一个"看着安全"的路径指到仓库里。
  assertSafeRoot(resolved, label);
  return resolved;
}

/**
 * 本次运行的沙箱名前缀：有 run id 就带上，没有就是公共前缀。
 *
 * @returns {string} 目录名前缀。
 */
export function sandboxPrefix() {
  const runId = process.env[RUN_ID_ENV];
  return typeof runId === 'string' && runId.trim() !== '' ? `${SANDBOX_PREFIX}${runId.trim()}-` : SANDBOX_PREFIX;
}

/**
 * 固定种子的 mulberry32。只用于生成语料，不用于任何"每次跑都不一样"的输入。
 *
 * @param {number} seed 32 位无符号种子。
 * @returns {() => number} 返回 `[0, 1)` 的确定性序列。
 */
export function createDeterministicRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由固定种子生成一串"看起来随机但完全可复现"的标识符字母表。
 *
 * @param {number} seed 种子。
 * @param {number} count 需要的数量。
 * @param {number} [length] 每个标识符的长度。
 * @returns {string[]} 标识符列表。
 */
export function deterministicTokens(seed, count, length = 12) {
  const random = createDeterministicRandom(seed);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const tokens = [];
  for (let index = 0; index < count; index += 1) {
    let token = '';
    for (let character = 0; character < length; character += 1) {
      token += alphabet[Math.floor(random() * alphabet.length)];
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * 创建隔离的临时目录。
 *
 * **不自动注册清理钩子**，因为 Windows 上只要还有打开的句柄（SQLite 连接）就删不掉：
 * 钩子的执行顺序就是注册顺序，自动注册会让"删目录"跑在"关句柄"之前，测试就以
 * EPERM 失败——那不是被测代码的错。调用方应当在自己的收尾里按顺序写：
 *
 * ```js
 * t.after(() => { store.close(); sandbox.cleanup(); });
 * ```
 *
 * 删除前校验目录确实位于**本次使用的**临时根内：`rmSync(recursive)` 一旦拿到计算错误的
 * 路径就是不可逆的数据丢失。
 *
 * 临时根来自 `resolveTempRoot()`：默认系统临时目录，可用 `AEGIS_M9_TMP_ROOT` 覆盖。
 * 覆盖只改"放在哪里"，不改"必须是临时目录"这条纪律——调用方仍然不许写仓库或用户目录。
 *
 * @returns {{ root: string, tempRoot: string, resolve: (...parts: string[]) => string, write: (rel: string, body: string|Uint8Array) => string, mkdir: (rel: string) => string, list: () => string[], cleanup: () => void }}
 */
export function createSandbox() {
  const tempRoot = resolveTempRoot();
  const root = realpathSync(mkdtempSync(join(tempRoot, sandboxPrefix())));
  let cleaned = false;

  function resolvePath(...parts) {
    return join(root, ...parts);
  }

  return {
    root,
    tempRoot,
    resolve: resolvePath,
    write(relPath, body) {
      const target = resolvePath(...String(relPath).split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
      return target;
    },
    mkdir(relPath) {
      const target = resolvePath(...String(relPath).split('/'));
      mkdirSync(target, { recursive: true });
      return target;
    },
    list() {
      const out = [];
      const stack = [''];
      while (stack.length > 0) {
        const current = stack.pop();
        const absolute = current === '' ? root : join(root, current);
        let entries;
        try {
          entries = readdirSync(absolute, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const relPath = current === '' ? entry.name : `${current}/${entry.name}`;
          if (entry.isDirectory()) {
            stack.push(relPath);
          } else {
            out.push(`${relPath}:${statSync(join(root, relPath)).size}`);
          }
        }
      }
      return out.sort();
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      // 守卫用**本次沙箱自己的**临时根：覆盖过的根与默认根各自校验，不会互相放行。
      const relPath = relative(tempRoot, root);
      if (relPath === '' || relPath === '..' || relPath.startsWith(`..${sep}`) || isAbsolute(relPath)) {
        throw new Error(`refusing to remove a sandbox outside the temporary directory: ${root}`);
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * 断言调用抛出**指定错误码**的异常。
 *
 * 与 `assert.throws(fn)` 的差别是关键：后者只要求"抛点什么"，一个
 * `TypeError: x is not a function` 也能让它通过。
 *
 * @template {Error} E
 * @param {() => unknown} fn 被测调用。
 * @param {{ code: string, type?: Function, pathIncludes?: string, label?: string }} expectation 期望。
 * @returns {E} 捕获到的异常，便于继续断言 details。
 */
export function expectRejection(fn, expectation) {
  const { code, type, pathIncludes, label = 'call' } = expectation;
  let captured = null;
  try {
    fn();
  } catch (error) {
    captured = error;
  }
  assert.notEqual(captured, null, `${label} must fail closed, but it returned normally`);
  if (type !== undefined) {
    assert.ok(
      captured instanceof type,
      `${label} must throw ${type.name}, got ${captured?.constructor?.name}: ${captured?.message}`,
    );
  }
  assert.equal(
    String(captured.code),
    code,
    `${label} must fail with ${code}, got ${String(captured.code)} (${captured.message})`,
  );
  if (pathIncludes !== undefined) {
    assert.equal(typeof captured.path, 'string', `${label}: error.path must be a string`);
    assert.ok(
      captured.path.includes(pathIncludes),
      `${label}: expected error.path to contain "${pathIncludes}", got "${captured.path}"`,
    );
  }
  return captured;
}

/**
 * 结构指纹：把任意结果压成可直接比较的文本。
 *
 * 用 `JSON.stringify` 而不是项目里的 canonicalize，是为了让本测试**不依赖**
 * 被测的规范化实现——否则"规范化实现的确定性"会被它自己的序化器证明。
 *
 * @param {unknown} value 任意 JSON 值。
 * @returns {string} 稳定文本。
 */
export function structureText(value) {
  return JSON.stringify(value, (key, entry) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const sorted = {};
      for (const name of Object.keys(entry).sort()) sorted[name] = entry[name];
      return sorted;
    }
    return entry;
  });
}

/**
 * 把注入样本（ANSI / NUL / 双向控制符 / 零宽字符）拼成可读的调试标签，
 * 避免断言失败信息里出现裸控制序列把终端搞乱。
 *
 * @param {string} value 原始文本。
 * @returns {string} 转义后的文本。
 */
export function escapeForMessage(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, (unit) =>
      `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
