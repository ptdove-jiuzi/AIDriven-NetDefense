/**
 * 提供方凭据。
 *
 * 设计不变量 2：model-broker **独占**提供方凭据和外网。凭据只能来自进程环境
 * 或受保护配置文件，绝不写入仓库、日志、测试、错误消息或 IPC 响应。
 *
 * 这里用一个带私有字段的类而不是裸字符串，是为了让"不小心打印"变成
 * `[REDACTED]` 而不是泄漏：`String(cred)`、`JSON.stringify(cred)`、
 * `console.log(cred)` 三条最常见的事故路径全部被截断。
 */

import fs from 'node:fs';
import util from 'node:util';

import { BrokerError, BROKER_CODES } from './errors.js';

/** 默认环境变量名。名字固定，避免"配了哪个变量"这种不可审计的隐式约定。 */
export const CREDENTIAL_ENV_NAME = 'AEGIS_BROKER_PROVIDER_KEY';
/** 受保护配置文件路径的间接变量：文件本身由安装器设 ACL。 */
export const CREDENTIAL_FILE_ENV_NAME = 'AEGIS_BROKER_PROVIDER_KEY_FILE';

const REDACTED = '[REDACTED]';

function validateSecret(secret, origin) {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (value.length < 8) {
    // 不复述内容，只报来源与长度类别。
    throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'provider credential is missing or too short', {
      origin,
      length_ok: false,
    });
  }
  if (/[\r\n]/u.test(value)) {
    throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'provider credential must be a single line', {
      origin,
    });
  }
  return value;
}

export class ProviderCredential {
  #secret;

  #origin;

  constructor(secret, options = {}) {
    this.#secret = validateSecret(secret, options.origin ?? 'memory');
    this.#origin = options.origin ?? 'memory';
    Object.freeze(this);
  }

  /** 环境变量来源。变量不存在时返回 null，由调用方决定是否失败关闭。 */
  static fromEnv(env = process.env, name = CREDENTIAL_ENV_NAME) {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    return new ProviderCredential(String(raw), { origin: `env:${name}` });
  }

  /**
   * 受保护配置文件来源。
   *
   * POSIX 下强制 `0600`（组/其他人零权限）。Windows 依赖安装器设置的 ACL，
   * 运行期无法廉价重验，因此这里只做"路径/大小/非常规文件"检查并如实记录
   * 未验证项（见状态文件的未验证清单）。
   *
   * 读文件时先 `open` 再 `fstat` **同一个 fd**，并在 `lstat` 阶段拒绝符号链接：
   * 分两次按路径取元数据等于给攻击者一个替换窗口（TOCTOU）。
   */
  static fromFile(filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file path is required');
    }
    let link;
    try {
      link = fs.lstatSync(filePath);
    } catch (error) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file is not readable', {
        origin: 'file',
        cause_code: typeof error?.code === 'string' ? error.code : null,
      });
    }
    if (link.isSymbolicLink()) {
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file must not be a symbolic link', {
        origin: 'file',
      });
    }
    let fd = null;
    let stat;
    let secret;
    try {
      // `O_NOFOLLOW` 在 POSIX 上让末段为符号链接时直接 ELOOP；Windows 上该常量
      // 可能不存在，退回 0 并依赖 `lstat` 与 `fstat` 的 dev/ino 比对。
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential path is not a regular file', {
          origin: 'file',
        });
      }
      // 打开前后必须是同一个对象：路径在校验与打开之间被替换时，dev/ino 会变。
      if (stat.dev !== link.dev || stat.ino !== link.ino) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file changed while being opened', {
          origin: 'file',
        });
      }
      if (stat.size > 4096) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file is unexpectedly large', {
          origin: 'file',
          bytes: stat.size,
        });
      }
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file must not be group/world readable', {
          origin: 'file',
          mode: `0o${(stat.mode & 0o777).toString(8)}`,
        });
      }
      secret = fs.readFileSync(fd, 'utf8');
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(BROKER_CODES.ERR_BROKER_CREDENTIAL, 'credential file could not be read', {
        origin: 'file',
        cause_code: typeof error?.code === 'string' ? error.code : null,
      });
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 关闭失败不改变"已经读到/没读到"的结论。
        }
      }
    }
    return new ProviderCredential(secret, { origin: `file:${options.label ?? 'configured'}` });
  }

  /** 只用于拼装 Authorization header；调用方不得把结果写入日志。 */
  header() {
    return `Bearer ${this.#secret}`;
  }

  get origin() {
    return this.#origin;
  }

  get present() {
    return true;
  }

  toString() {
    return `ProviderCredential(${REDACTED})`;
  }

  toJSON() {
    return REDACTED;
  }

  [util.inspect.custom]() {
    return `ProviderCredential(${REDACTED})`;
  }
}

/**
 * 解析凭据：显式 `credential` > 受保护文件 > 环境变量。
 *
 * 返回 `null` 表示"没有可用凭据"，由 broker 在真正发送前失败关闭；
 * 不在加载阶段抛错，避免把"没配凭据"变成进程启动崩溃。
 */
export function loadProviderCredential(options = {}) {
  if (options.credential instanceof ProviderCredential) return options.credential;
  const env = options.env ?? process.env;
  if (typeof options.filePath === 'string' && options.filePath.length > 0) {
    return ProviderCredential.fromFile(options.filePath, options);
  }
  const fileFromEnv = env?.[options.fileEnvName ?? CREDENTIAL_FILE_ENV_NAME];
  if (typeof fileFromEnv === 'string' && fileFromEnv.trim() !== '') {
    return ProviderCredential.fromFile(fileFromEnv.trim(), options);
  }
  return ProviderCredential.fromEnv(env, options.envName ?? CREDENTIAL_ENV_NAME);
}
