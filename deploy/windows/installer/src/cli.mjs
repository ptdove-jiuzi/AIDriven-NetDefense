/**
 * cli.mjs — argument parsing for the installer engine.
 *
 * The command grammar is the one published in `release/windows-install.md` §1.1
 * (`/install`, `/uninstall`, `/purge`, `/verify`, `/repair`, `/silent`, `/log <path>`),
 * plus `/S` as the silent alias people type out of habit. `--long` spellings are
 * accepted as well so tests and scripts do not have to shell-quote forward slashes.
 *
 * Unknown arguments are an error (code 10), never ignored: a typo in `/uninstal` that
 * silently fell through to "install" is the kind of mistake that costs a support week.
 */

export const COMMANDS = Object.freeze(['install', 'uninstall', 'purge', 'verify', 'repair', 'rollback']);

const VALUE_FLAGS = new Map([
  ['log', 'logPath'],
  ['root', 'root'],
  ['payload', 'payload'],
  ['version', 'version'],
  ['port', 'apiPort'],
  ['engine-source', 'engineSource'],
  ['rule-pack', 'rulePack'],
  ['mode', 'mode'],
]);

const BOOLEAN_FLAGS = new Map([
  ['silent', 'silent'],
  ['s', 'silent'],
  ['help', 'help'],
  ['h', 'help'],
  ['confirm', 'confirm'],
]);

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

/** Is this token one of *our* flags (as opposed to a path that happens to start with `/`)? */
function isKnownFlag(token) {
  if (!/^(?:\/|--?)[A-Za-z]/u.test(token)) return false;
  const name = token.replace(/^(?:\/|--?)/u, '').toLowerCase();
  if (name === 's') return true;
  return BOOLEAN_FLAGS.has(name) || VALUE_FLAGS.has(name) || COMMANDS.includes(name);
}

/**
 * @param {readonly string[]} argv Arguments after the interpreter and script.
 * @returns {{command: string|null, silent: boolean, confirm: boolean, help: boolean,
 *   logPath: string|null, root: string|null, payload: string|null, version: string|null,
 *   apiPort: number|null, engineSource: string|null, rulePack: string|null, mode: string|null}}
 */
export function parseArgv(argv) {
  const result = {
    command: null,
    silent: false,
    confirm: false,
    help: false,
    logPath: null,
    root: null,
    payload: null,
    version: null,
    apiPort: null,
    engineSource: null,
    rulePack: null,
    mode: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === '') continue;

    // `/S` is case-insensitive; every other flag is not, because `/s` and `/S` meaning
    // different things is how installers get mis-scripted.
    if (/^[/-]S$/u.test(token)) {
      result.silent = true;
      continue;
    }
    if (!/^(?:\/|--?)[A-Za-z]/u.test(token)) {
      throw new CliError(`无法识别的参数：${token}`);
    }

    const name = token.replace(/^(?:\/|--?)/u, '').toLowerCase();
    if (BOOLEAN_FLAGS.has(name)) {
      result[BOOLEAN_FLAGS.get(name)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = argv[index + 1];
      // A value is taken verbatim. Rejecting anything that *looks* like a flag breaks
      // legitimate values: an absolute POSIX-style path such as `/tmp/x.log` starts with a
      // slash and a letter. Missing values and the "next token is a known flag" typo are
      // still caught, which is what the guard was for.
      if (value === undefined || isKnownFlag(String(value))) {
        throw new CliError(`参数 ${token} 需要一个值`);
      }
      const key = VALUE_FLAGS.get(name);
      result[key] = key === 'apiPort' ? Number(value) : String(value);
      if (key === 'apiPort' && !Number.isInteger(result[key])) {
        throw new CliError(`--port 必须是整数：${value}`);
      }
      index += 1;
      continue;
    }
    if (COMMANDS.includes(name)) {
      if (result.command !== null) {
        throw new CliError(`只能给出一个命令：${result.command} 与 ${name}`);
      }
      result.command = name;
      continue;
    }
    throw new CliError(`未知参数：${token}`);
  }

  return result;
}

export const USAGE = `AIDriven NetDefense 安装引擎（Windows，未签名分发形态）

  /install   全新安装；已安装同版本时等价于 /repair
  /repair    同版本重置载荷与清单（不动数据、不动配置）
  /uninstall 停止并注销服务、删除程序区、保留数据
  /purge     删除用户数据（可单独执行，也可接在 /uninstall 之后）
  /verify    只读校验已装文件（不写任何文件）
  /rollback  本次切片未实现（拒绝执行）

  /S, /silent          无人值守
  /log <path>          写安装日志
  /confirm             /purge 在 /silent 下必须显式确认

  --mode armed|disarm  默认 armed；disarm 只允许配合 --root 使用，且不执行任何特权动作
  --root <dir>         disarm 专用：所有写入落在该目录下
  --payload <dir>      已解压的载荷目录（须含 manifests/files.sha256）
  --version <X.Y.Z>    待装版本
  --port <n>           管理 API 端口（默认 8787）
  --rule-pack <file>   规则包来源（默认 <payload>/rules/pack.json）
  --engine-source <dir> 引擎副本来源，用于 ARP 卸载入口

  退出码见 ADR-0009 §10.4；24/25/26 互斥。
`;
