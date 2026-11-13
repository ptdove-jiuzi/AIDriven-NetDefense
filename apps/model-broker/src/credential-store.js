/**
 * Provider 凭据槽（credential store）。
 *
 * 目的：让 console v2 的「模型与凭据」页面能**只写不读**地管理每个 provider 的密钥。
 * 本模块是 broker 子进程独占的存储层，daemon 只能经 stdio JSON-RPC 拿到
 * `hasCredential` / `masked` / `fingerprint` / `updatedAt` / `lengthBucket`，
 * 永远拿不到明文（CONSOLE-V2-CONTRACT §4）。
 *
 * 纪律：
 * 1. 一个 provider 一个文件：`<dataDir>/secrets/providers/<providerId>.json`；
 *    文件名只由 `[a-z0-9-]{2,32}` 的 providerId 决定，不存在路径拼接注入面。
 * 2. 落盘原子：同目录 tmp 文件（`wx`、0600）→ fsync → rename。并发写同一槽
 *    「后者胜」，任何时刻磁盘上只有一份完整 JSON，不会出现半文件。
 * 3. 权限：POSIX 目录 0700 / 文件 0600；Windows 没有 mode 位，依赖数据目录继承的
 *    ACL，测试用 `icacls` 断言"除当前用户/SYSTEM/Administrators 外无 ACE"
 *    （不可用时记「未验证」，见状态文件）。
 * 4. 明文只有一个出口 `readSecretForRuntime()`，只给 host 的 `chat`/`provider/test`
 *    两个调用点用；本模块**不导出到 `src/index.js`**，daemon 无法 import。
 * 5. 错误消息与 details 只放枚举/计数，不放密钥、不放文件内容、不放路径。
 *    读取失败一律 fail-closed（当成"没有凭据"），绝不用损坏文件去发请求。
 * 6. **零外部依赖**：只 import `node:` 内置模块。这样 `tests/wp5-daemon/**` 里的
 *    用例可以直接引用同一份 canonical 实现，而不把 daemon 拖进 broker 包的依赖闭包。
 *
 * @author PT-dove
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 落盘 schema 版本（CONSOLE-V2-CONTRACT §4.3）。 */
export const CREDENTIAL_SCHEMA_VERSION = '1.0';

/** 与 endpoint.js / ADR-0010 §2.1 保持一致的 providerId 形状。 */
export const PROVIDER_ID_PATTERN = /^[a-z0-9-]{2,32}$/u;

/** 密钥形状下限（CONSOLE-V2-CONTRACT §2.3：8..512 字节）。 */
export const MIN_SECRET_BYTES = 8;
/** 密钥形状上限。 */
export const MAX_SECRET_BYTES = 512;
/** 单槽文件大小上限：正常记录 < 1 KiB，超过就是异常文件，不读。 */
const MAX_SLOT_BYTES = 4096;

/** 掩码固定前缀：`••••` + 尾 4 位（合同 §4.2）。 */
export const MASK_PREFIX = '••••';

/** 稳定错误码：与 daemon 的 HTTP 错误包络一一对应（合同 §2.1/§2.3）。 */
export const CREDENTIAL_STORE_CODES = Object.freeze({
  /** 密钥形状不合法（不回显内容）。 */
  CREDENTIAL_INVALID: 'CREDENTIAL_INVALID',
  /** 存储不可用：目录不可建、写失败、槽位是符号链接等。 */
  CREDENTIAL_STORE_UNAVAILABLE: 'CREDENTIAL_STORE_UNAVAILABLE',
  /** providerId 形状不合法。 */
  PROVIDER_INVALID: 'PROVIDER_INVALID',
});

/**
 * 凭据存储错误。`details.reason` 只放枚举，绝不回显输入片段。
 */
export class CredentialStoreError extends Error {
  /**
   * @param {string} code `CREDENTIAL_STORE_CODES` 之一。
   * @param {string} message 稳定英文短句（不含密钥/路径）。
   * @param {object} [details] 枚举/计数元数据。
   */
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'CredentialStoreError';
    this.code = code;
    this.details = Object.freeze({ ...(details ?? {}) });
    if (Error.captureStackTrace) Error.captureStackTrace(this, CredentialStoreError);
  }
}

function storeError(code, message, details) {
  return new CredentialStoreError(code, message, details);
}

/** providerId 形状校验：不合法时抛 `PROVIDER_INVALID`。 */
export function assertProviderId(providerId) {
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    throw storeError(CREDENTIAL_STORE_CODES.PROVIDER_INVALID, 'provider id must match [a-z0-9-]{2,32}', {
      field: 'providerId',
    });
  }
  return providerId;
}

/**
 * 密钥形状校验（合同 §2.3）。
 *
 * `details.reason` ∈ `TOO_SHORT | TOO_LONG | MULTILINE | EMPTY`，顺序固定：
 * 先判"去首尾空白后为空"，再判多行，再判长度区间。**任何分支都不复述输入**。
 *
 * @param {unknown} raw
 * @returns {string} 去首尾空白后的密钥。
 */
export function normalizeSecret(raw) {
  if (typeof raw !== 'string') {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID, 'provider credential must be a string', {
      reason: 'EMPTY',
    });
  }
  const value = raw.trim();
  if (value === '') {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID, 'provider credential must not be empty', {
      reason: 'EMPTY',
    });
  }
  if (/[\r\n]/u.test(value)) {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID, 'provider credential must be a single line', {
      reason: 'MULTILINE',
    });
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < MIN_SECRET_BYTES) {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID, 'provider credential is too short', {
      reason: 'TOO_SHORT',
      min_bytes: MIN_SECRET_BYTES,
    });
  }
  if (bytes > MAX_SECRET_BYTES) {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID, 'provider credential is too long', {
      reason: 'TOO_LONG',
      max_bytes: MAX_SECRET_BYTES,
    });
  }
  return value;
}

/** `sha256(secret)` 前 8 位小写 hex（合同 §4.2 的 fingerprint）。 */
export function fingerprintOf(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

/** `••••` + 尾 4 位（合同 §4.2 的 masked）。 */
export function maskOf(secret) {
  return `${MASK_PREFIX}${secret.slice(-4)}`;
}

/**
 * 长度区间（不含精确长度）。
 * @param {string} secret
 * @returns {'<16'|'16-32'|'33-64'|'>64'}
 */
export function lengthBucketOf(secret) {
  const bytes = Buffer.byteLength(secret, 'utf8');
  if (bytes < 16) return '<16';
  if (bytes <= 32) return '16-32';
  if (bytes <= 64) return '33-64';
  return '>64';
}

/**
 * 静态保护（R5-002）：有保护器时只落 `secret_protected`，绝不落明文；
 * 保护器不可用时**明确拒绝**写入（fail-closed），不静默退回明文。
 *
 * @param {string} secret
 * @param {object | null} protectAtRest
 * @returns {{secret: string} | {secret_protected: string, protection: string}}
 */
function protectForAtRest(secret, protectAtRest) {
  if (protectAtRest === null) return { secret };
  if (typeof protectAtRest.available === 'function' && protectAtRest.available() !== true) {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential at-rest protection is not available', {
      reason: 'PROTECTOR_UNAVAILABLE',
    });
  }
  try {
    return {
      secret_protected: protectAtRest.protect(secret),
      protection: typeof protectAtRest.scheme === 'string' ? protectAtRest.scheme : 'unknown',
    };
  } catch {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential at-rest protection failed', {
      reason: 'PROTECTOR_UNAVAILABLE',
    });
  }
}

/** 规范化的完整槽位记录（只用于落盘/内部读取，永不跨进程返回）。 */
function buildRecord(providerId, secret, updatedAt, protectAtRest, exposure) {
  const record = {
    schemaVersion: CREDENTIAL_SCHEMA_VERSION,
    providerId,
    ...protectForAtRest(secret, protectAtRest),
    lengthBucket: lengthBucketOf(secret),
    updatedAt,
  };
  // R5-003：strict 暴露模式下指纹/后 4 位不落盘（磁盘上的 sha256[:8] 是离线校验 oracle）。
  if (exposure !== 'strict') {
    record.fingerprint = fingerprintOf(secret);
    record.mask = maskOf(secret);
  }
  return Object.freeze(record);
}

/** 槽位文件路径：`<dataDir>/secrets/providers/<providerId>.json`。 */
export function credentialSlotPath(dataDir, providerId) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential store data directory is required');
  }
  const id = assertProviderId(providerId);
  const root = path.resolve(dataDir);
  return path.join(root, 'secrets', 'providers', `${id}.json`);
}

function nullMaskedInfo() {
  return Object.freeze({
    masked: null,
    fingerprint: null,
    updatedAt: null,
    lengthBucket: null,
  });
}

function isSymlink(filePath) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 建一个凭据存储。
 *
 * @param {{
 *   dataDir?: string,
 *   platform?: string,
 *   now?: () => Date,
 *   fsImpl?: typeof fs,
 * }} [options]
 */
export function createCredentialStore(options = {}) {
  const dataDir = typeof options.dataDir === 'string' && options.dataDir.trim() !== ''
    ? path.resolve(options.dataDir.trim())
    : (typeof process.env.AEGIS_DATA_DIR === 'string' && process.env.AEGIS_DATA_DIR.trim() !== ''
      ? path.resolve(process.env.AEGIS_DATA_DIR.trim())
      : null);
  if (dataDir === null) {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential store data directory is required', {
      reason: 'DATA_DIR_REQUIRED',
    });
  }
  const platform = options.platform ?? process.platform;
  const now = options.now ?? (() => new Date());
  // R5-002：可选的静态保护器（DPAPI envelope，见 secret-protector.js）。
  const protectAtRest = options.protectAtRest ?? null;
  if (protectAtRest !== null
    && (typeof protectAtRest !== 'object'
      || typeof protectAtRest.protect !== 'function'
      || typeof protectAtRest.unprotect !== 'function')) {
    throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential at-rest protector is invalid', {
      reason: 'PROTECTOR_INVALID',
    });
  }
  // R5-003：strict 暴露模式不返回/不落盘指纹与后 4 位；legacy 保持既有合同形状。
  const exposure = options.exposure === 'strict' ? 'strict' : 'legacy';
  const secretsDir = path.join(dataDir, 'secrets');
  const providersDir = path.join(secretsDir, 'providers');

  /**
   * 保证槽位目录存在且收紧权限。
   * POSIX：目录 0700（mkdir 的 mode 会被 umask 削，所以显式 chmod）；
   * Windows：没有 mode 位，依赖父目录继承 ACL（不伪造一个"看起来安全"的 mode）。
   */
  function ensureDirectories() {
    try {
      fs.mkdirSync(providersDir, { recursive: true, mode: 0o700 });
      if (platform !== 'win32') {
        // 只收紧、不放宽：已存在但更宽的目录也会被拉回 0700。
        fs.chmodSync(secretsDir, 0o700);
        fs.chmodSync(providersDir, 0o700);
      }
    } catch (error) {
      throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential store directory is not writable', {
        step: 'mkdir',
        cause_code: typeof error?.code === 'string' ? error.code : null,
      });
    }
  }

  function slotPath(providerId) {
    return credentialSlotPath(dataDir, providerId);
  }

  /** 读一次槽位并收敛成合同 §2.2 的四字段掩码形状。 */
  function maskedInfoFor(providerId) {
    const record = readSlot(providerId, { wantSecret: false });
    if (record === null) return nullMaskedInfo();
    return Object.freeze({
      masked: record.mask,
      fingerprint: record.fingerprint,
      updatedAt: record.updatedAt,
      lengthBucket: record.lengthBucket,
    });
  }

  /**
   * 原子写：同目录 tmp（`wx`，0600）→ fsync → rename 覆盖目标。
   *
   * 先写 tmp 再 rename 的意义：崩溃/断电只可能留下一个孤儿 tmp，读者看到的
   * 要么是旧完整文件、要么是新完整文件，不会读到半截 JSON。
   */
  function atomicWrite(filePath, text) {
    const dir = path.dirname(filePath);
    const tmp = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // 关闭失败不改变"写失败"的结论。
      }
      fd = null;
      try {
        fs.unlinkSync(tmp);
      } catch {
        // tmp 可能根本没建出来。
      }
      throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot could not be written', {
        step: 'write',
        cause_code: typeof error?.code === 'string' ? error.code : null,
      });
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // 同上。
        }
      }
    }
    try {
      if (platform !== 'win32') fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, filePath);
      if (platform !== 'win32') fs.chmodSync(filePath, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // 清理失败不改变"写失败"的结论。
      }
      throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot could not be replaced', {
        step: 'rename',
        cause_code: typeof error?.code === 'string' ? error.code : null,
      });
    }
  }

  /**
   * 读并校验一个槽位文件。
   *
   * 任何异常（不存在/不是常规文件/符号链接/超大/坏 JSON/字段不符）都返回 `null`：
   * 对调用方来说它等价于"没有凭据"——这是 fail-closed，而不是"带着坏数据继续发请求"。
   *
   * @param {string} providerId
   * @param {{wantSecret: boolean}} options
   * @returns {{providerId: string, secret?: string, fingerprint: string, mask: string, lengthBucket: string, updatedAt: string} | null}
   */
  function readSlot(providerId, { wantSecret }) {
    const filePath = slotPath(providerId);
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot is not readable', {
        step: 'lstat',
        cause_code: typeof error?.code === 'string' ? error.code : null,
      });
    }
    // 符号链接一律不跟：~/.ssh 之类的意外链接不该被当成凭据槽读取。
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    if (stat.size > MAX_SLOT_BYTES) return null;
    let raw;
    try {
      // `O_NOFOLLOW`：POSIX 上末段是符号链接直接 ELOOP；Windows 上没有该常量，
      // 上面的 lstat 已经挡过一轮（这里只是纵深防御，不是唯一判定）。
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      raw = fs.readFileSync(filePath, { encoding: 'utf8', flag: fs.constants.O_RDONLY | noFollow });
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.schemaVersion !== CREDENTIAL_SCHEMA_VERSION) return null;
    if (parsed.providerId !== providerId) return null;
    let secret;
    let atRest = 'none';
    if (typeof parsed.secret_protected === 'string' && parsed.secret_protected !== '') {
      // R5-002：有保护载荷但没有保护器 → 读不出就是"没有可用凭据"（fail-closed）。
      if (protectAtRest === null) return null;
      try {
        secret = normalizeSecret(protectAtRest.unprotect(parsed.secret_protected));
      } catch {
        return null;
      }
      atRest = typeof parsed.protection === 'string' ? parsed.protection : 'protected';
    } else {
      // 旧明文槽位仍可读（迁移路径：migrateLegacySlots() 把它改写成保护格式，不丢数据）。
      try {
        secret = normalizeSecret(parsed.secret);
      } catch {
        return null;
      }
    }
    // 展示字段一律**按密钥重算**：手改文件改不动 UI 上的指纹/掩码。
    const updatedAt = typeof parsed.updatedAt === 'string' && parsed.updatedAt !== ''
      ? parsed.updatedAt
      : null;
    const record = {
      providerId,
      // R5-003：strict 暴露模式下不返回指纹，也不返回后 4 位（masked 只表示"有凭据"）。
      fingerprint: exposure === 'strict' ? null : fingerprintOf(secret),
      mask: exposure === 'strict' ? MASK_PREFIX : maskOf(secret),
      lengthBucket: lengthBucketOf(secret),
      updatedAt,
      atRest,
    };
    if (wantSecret) record.secret = secret;
    return Object.freeze(record);
  }

  return Object.freeze({
    dataDir,
    secretsDir,
    providersDir,
    slotPath,
    /** R5-002：'none' 表示该 store 没有静态保护器（仅 legacy/测试用）。 */
    protection: protectAtRest === null
      ? 'none'
      : (typeof protectAtRest.scheme === 'string' ? protectAtRest.scheme : 'unknown'),
    /** R5-003：'strict' 不暴露指纹/后 4 位；'legacy' 保持既有合同形状。 */
    exposure,

    /**
     * R5-002 迁移：把旧明文槽位改写成静态保护格式（不丢数据、可重复执行）。
     *
     * - 无保护器 → `{ migrated: 0, skipped: 0, failed: 0, reason: 'NO_PROTECTOR' }`，不假装迁移过；
     * - 已是保护格式 / 非普通文件 / 超限 → 计入 skipped；
     * - 任何单槽失败计入 failed，**不会**把明文删掉（失败即保持原样，可回退）。
     */
    migrateLegacySlots() {
      if (protectAtRest === null) {
        return Object.freeze({ migrated: 0, skipped: 0, failed: 0, reason: 'NO_PROTECTOR' });
      }
      let entries = [];
      try {
        entries = fs.readdirSync(providersDir);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return Object.freeze({ migrated: 0, skipped: 0, failed: 0 });
        }
        throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential store directory is not readable', {
          step: 'migrate',
          cause_code: typeof error?.code === 'string' ? error.code : null,
        });
      }
      let migrated = 0;
      let skipped = 0;
      let failed = 0;
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        const filePath = path.join(providersDir, name);
        try {
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SLOT_BYTES) {
            skipped += 1;
            continue;
          }
          const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            skipped += 1;
            continue;
          }
          if (typeof parsed.secret_protected === 'string' && parsed.secret_protected !== '') {
            skipped += 1;
            continue;
          }
          const providerId = assertProviderId(parsed.providerId);
          const secret = normalizeSecret(parsed.secret);
          const updatedAt = typeof parsed.updatedAt === 'string' && parsed.updatedAt !== ''
            ? parsed.updatedAt
            : now().toISOString();
          const record = buildRecord(providerId, secret, updatedAt, protectAtRest, exposure);
          atomicWrite(filePath, `${JSON.stringify(record)}\n`);
          migrated += 1;
        } catch {
          failed += 1;
        }
      }
      return Object.freeze({ migrated, skipped, failed });
    },

    /**
     * 写入/覆盖某 provider 的密钥。
     * 成功不返回掩码或指纹（合同 §2.3：PUT 成功 = 204 无 body）。
     *
     * @returns {{ok: true}}
     */
    putCredential(providerId, rawSecret) {
      const id = assertProviderId(providerId);
      const secret = normalizeSecret(rawSecret);
      const filePath = slotPath(id);
      if (isSymlink(filePath)) {
        throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot must not be a symbolic link', {
          step: 'precheck',
        });
      }
      ensureDirectories();
      const record = buildRecord(id, secret, now().toISOString(), protectAtRest, exposure);
      atomicWrite(filePath, `${JSON.stringify(record)}\n`);
      return Object.freeze({ ok: true });
    },

    /** 删除某 provider 的密钥；不存在也成功（合同 §2.3：DELETE 幂等）。 */
    deleteCredential(providerId) {
      const id = assertProviderId(providerId);
      const filePath = slotPath(id);
      let stat;
      try {
        stat = fs.lstatSync(filePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return Object.freeze({ ok: true, deleted: false });
        }
        throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot is not removable', {
          step: 'lstat',
          cause_code: typeof error?.code === 'string' ? error.code : null,
        });
      }
      // 符号链接本身可以安全删除（不跟随目标）；目录则拒绝。
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot is not a regular file', {
          step: 'delete',
        });
      }
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        throw storeError(CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE, 'credential slot could not be removed', {
          step: 'delete',
          cause_code: typeof error?.code === 'string' ? error.code : null,
        });
      }
      return Object.freeze({ ok: true, deleted: true });
    },

    /** 是否存在可用凭据（不读明文出内存边界）。 */
    hasCredential(providerId) {
      return readSlot(assertProviderId(providerId), { wantSecret: false }) !== null;
    },

    /**
     * 只读掩码信息。无凭据时返回四个 null 字段（合同 §2.2 的 UI 形状）。
     * 绝不返回 secret，也不返回精确长度。
     */
    maskedInfo(providerId) {
      return maskedInfoFor(assertProviderId(providerId));
    },

    /**
     * **仅 host 使用**：取明文密钥去拼 Authorization header。
     *
     * 不导出到 `src/index.js`；daemon 通过 stdio JSON-RPC 只能拿到 maskedInfo。
     * 没有可用凭据时返回 `null`（调用方决定是否失败关闭）。
     */
    readSecretForRuntime(providerId) {
      const record = readSlot(assertProviderId(providerId), { wantSecret: true });
      return record === null ? null : record.secret;
    },

    /**
     * 批量掩码信息：`credentials/info` 的 canonical 实现。
     * @param {string[]} providerIds
     */
    infoBatch(providerIds) {
      if (!Array.isArray(providerIds)) {
        throw storeError(CREDENTIAL_STORE_CODES.PROVIDER_INVALID, 'provider ids must be an array', { field: 'providerIds' });
      }
      if (providerIds.length > 64) {
        throw storeError(CREDENTIAL_STORE_CODES.PROVIDER_INVALID, 'too many provider ids in one request', {
          count: providerIds.length,
        });
      }
      const items = providerIds.map((providerId) => {
        try {
          const id = assertProviderId(providerId);
          const credential = maskedInfoFor(id);
          return Object.freeze({ providerId: id, hasCredential: credential.masked !== null, credential });
        } catch (error) {
          // 批量查询不因一个坏 id 整体失败；该项带枚举 reason 让上层能定位。
          return Object.freeze({
            providerId: typeof providerId === 'string' ? providerId : null,
            hasCredential: false,
            credential: nullMaskedInfo(),
            error: Object.freeze({
              code: typeof error?.code === 'string' ? error.code : CREDENTIAL_STORE_CODES.PROVIDER_INVALID,
              reason: typeof error?.details?.reason === 'string' ? error.details.reason : 'INVALID_PROVIDER_ID',
            }),
          });
        }
      });
      return Object.freeze({ items: Object.freeze(items) });
    },
  });
}
