#!/usr/bin/env node
/**
 * main.mjs — installer entry point.
 *
 * Everything that decides *where* to write happens here, in one place, and it happens
 * before any file is created:
 *
 * 1. parse arguments (a bad argument never reaches the filesystem);
 * 2. refuse an unsafe disarm root, or demand elevation for an armed one;
 * 3. build the layout, dispatch, print the exit code with its ADR label.
 *
 * The engine deliberately has no GUI and no self-extractor. It is the P1 slice: the
 * state machine, the hash gate and the service wiring. The signed single-file Setup
 * EXE of ADR D1 is a packaging step on top of this, not a different engine.
 */

import { pathToFileURL } from 'node:url';

import { EXIT, EXIT_LABELS } from './src/exit-codes.mjs';
import { CliError, parseArgv, USAGE } from './src/cli.mjs';
import { buildLayout, rejectDisarmRoot } from './src/paths.mjs';
import { createLogger } from './src/log.mjs';
import { createOps, isElevated } from './src/ops.mjs';
import { runInstall } from './src/install.mjs';
import { runPurge, runUninstall } from './src/uninstall.mjs';
import { runVerify } from './src/verify.mjs';

/**
 * Resolve mode/root and refuse the combinations that blur the safety boundary.
 * Returned as a value rather than thrown so every refusal has a precise exit code.
 */
function resolveMode(args, env) {
  const mode = args.mode ?? (args.root === null ? 'armed' : 'disarm');
  if (mode !== 'armed' && mode !== 'disarm') {
    return { ok: false, code: EXIT.PRECHECK, reason: `--mode 只能是 armed 或 disarm：${mode}` };
  }
  if (mode === 'disarm') {
    if (args.root === null) {
      return { ok: false, code: EXIT.PRECHECK, reason: 'disarm 模式必须显式给出 --root' };
    }
    const reasons = rejectDisarmRoot(args.root, env);
    if (reasons.length > 0) {
      return { ok: false, code: EXIT.PRECHECK, reason: reasons.join('；') };
    }
  }
  if (mode === 'armed') {
    if (process.platform !== 'win32') {
      return { ok: false, code: EXIT.PRECHECK, reason: 'armed 模式只支持 Windows' };
    }
    if (!isElevated(env)) {
      return { ok: false, code: EXIT.ELEVATION, reason: '需要管理员权限（写 Program Files / 注册服务 / 写 HKLM）' };
    }
  }
  return { ok: true, code: EXIT.OK, mode };
}

/**
 * @param {readonly string[]} argv
 * @param {{ env?: object, stdout?: NodeJS.WritableStream }} [options]
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv, { env = process.env, stdout = process.stdout } = {}) {
  let args;
  try {
    args = parseArgv(argv);
  } catch (error) {
    if (error instanceof CliError) {
      stdout.write(`${error.message}\n\n${USAGE}`);
      return EXIT.PRECHECK;
    }
    throw error;
  }

  if (args.help) {
    stdout.write(USAGE);
    return EXIT.OK;
  }
  if (args.command === null) {
    stdout.write(`缺少命令（/install、/uninstall、/purge、/verify）\n\n${USAGE}`);
    return EXIT.PRECHECK;
  }

  const logger = createLogger({ logPath: args.logPath, stdout });
  logger.info('安装引擎启动', { argv: argv.map((value) => String(value)), command: args.command });

  const resolved = resolveMode(args, env);
  if (!resolved.ok) {
    logger.error('前置检查失败', resolved.reason);
    logger.info(`exit=${resolved.code}`, EXIT_LABELS[resolved.code]);
    return resolved.code;
  }

  let layout;
  try {
    layout = buildLayout({ mode: resolved.mode, root: args.root, version: args.version, env });
  } catch (error) {
    logger.error('无法解析安装布局', error.message);
    return EXIT.PRECHECK;
  }

  const ops = createOps({ mode: resolved.mode, layout, logger });
  let result;

  try {
    switch (args.command) {
      case 'install':
      case 'repair': {
        if (args.payload === null) {
          result = { code: EXIT.PRECHECK, message: '缺少 --payload（已解压的载荷目录）' };
          break;
        }
        if (args.version === null) {
          result = { code: EXIT.PRECHECK, message: '缺少 --version' };
          break;
        }
        result = await runInstall({
          layout: buildLayout({ mode: resolved.mode, root: args.root, version: args.version, env }),
          options: {
            payload: args.payload,
            toVersion: args.version,
            apiPort: args.apiPort ?? undefined,
            rulePack: args.rulePack,
            engineSource: args.engineSource,
          },
          logger,
          ops,
        });
        break;
      }
      case 'uninstall':
        result = await runUninstall({ layout, logger, ops });
        break;
      case 'purge':
        if (args.silent && !args.confirm) {
          result = { code: EXIT.PRECHECK, message: '/purge 在 /silent 下必须显式 /confirm（清除不可撤销）' };
          break;
        }
        result = await runPurge({ layout, logger, ops });
        break;
      case 'verify':
        result = await runVerify({ layout, logger });
        break;
      case 'rollback':
        result = {
          code: EXIT.ROLLBACK_REFUSED,
          message: '本切片未实现回滚（无 app.prev 创建路径）；拒绝执行，未做任何动作',
        };
        break;
      default:
        result = { code: EXIT.PRECHECK, message: `未实现的命令：${args.command}` };
    }
  } catch (error) {
    logger.error('未捕获的引擎错误', error.stack ?? error.message);
    result = { code: EXIT.PRECHECK, message: `引擎错误：${error.message}` };
  }

  logger.info(result.message);
  logger.info(`exit=${result.code}`, EXIT_LABELS[result.code] ?? 'UNKNOWN');
  if (result.report !== undefined && result.report !== null) {
    logger.info('校验报告', result.report);
  }
  return result.code;
}

/**
 * Run only when executed directly. Comparing `pathToFileURL` hrefs is the only reliable
 * test on Windows, where `file://` plus a rewritten path can differ by case or by the
 * drive-letter form the shell handed us.
 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`安装引擎致命错误：${error?.message ?? 'unknown'}\n`);
    process.exitCode = EXIT.PRECHECK;
  });
}
