/**
 * 凭据静态保护（at-rest protector）—— ADR-0010 §2.3「凭据只进 keyring/DPAPI 保护的文件」。
 *
 * 为什么是 envelope 而不是"每条密钥都过一次 DPAPI"：DPAPI（经 PowerShell 调用
 * `System.Security.Cryptography.ProtectedData`）每次往返约 1.2–1.7 s，而凭据读写在
 * console host 的生命周期里是热路径。这里只把**一个随机数据密钥**交给 DPAPI 保护，
 * 每条密钥用 AES-256-GCM 加密（同进程内微秒级）：
 *
 *   <dataDir>/secrets/.data-key.dpapi   ← DPAPI(CurrentUser) 保护的 32 字节数据密钥
 *   <dataDir>/secrets/providers/x.json  ← AES-256-GCM 密文（v1:iv:tag:ct）
 *
 * 安全性质：只有同一 Windows 用户能解出数据密钥；落盘文件不含明文、不含 sha256 指纹。
 * 可回退：删掉 `.data-key.dpapi` 不会丢数据（旧文件解不开就是"没有凭据"，fail-closed），
 * 迁移路径见 `credential-store.migrateLegacySlots()`。
 *
 * 本模块只依赖 node: 内置模块；不 import broker 其它模块（避免循环依赖）。
 *
 * @author PT-dove
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 保护方案标识（写进槽位文件，便于审计与迁移）。 */
export const PROTECTOR_SCHEME = 'dpapi-aes-256-gcm';

/** 稳定错误原因（只放枚举，不放密钥/路径）。 */
export const PROTECTOR_REASONS = Object.freeze({
  UNAVAILABLE: 'PROTECTOR_UNAVAILABLE',
  PROTECT_FAILED: 'PROTECT_FAILED',
  UNPROTECT_FAILED: 'UNPROTECT_FAILED',
});

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BLOB_PREFIX = 'v1';
const KEY_FILE_NAME = '.data-key.dpapi';
const MAX_KEY_FILE_BYTES = 4096;

const DPAPI_PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$b64 = [Console]::In.ReadToEnd().Trim()',
  '$plain = [Text.Encoding]::UTF8.GetBytes($b64)',
  '$blob = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($blob))',
].join('\n');

const DPAPI_UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$b64 = [Console]::In.ReadToEnd().Trim()',
  '$blob = [Convert]::FromBase64String($b64)',
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
].join('\n');

/**
 * 跑一次 DPAPI（PowerShell 子进程，stdin 传 base64，**不把密钥放进命令行**：
 * 命令行会被进程列表看到，stdin 不会）。
 *
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
function runDpapi(script, inputBase64) {
  const shell = typeof process.env.AEGIS_POWERSHELL === 'string' && process.env.AEGIS_POWERSHELL.trim() !== ''
    ? process.env.AEGIS_POWERSHELL.trim()
    : 'powershell.exe';
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: inputBase64,
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, error: typeof result.error.code === 'string' ? result.error.code : 'spawn_error' };
  }
  if (result.status !== 0) return { ok: false, error: `exit_${String(result.status)}` };
  const value = String(result.stdout ?? '').trim();
  if (value === '') return { ok: false, error: 'empty_output' };
  return { ok: true, value };
}

function protectorError(reason, message) {
  const error = new Error(`${PROTECTOR_REASONS[reason] ?? reason}: ${message}`);
  error.name = 'ProtectorError';
  error.code = PROTECTOR_REASONS[reason] ?? reason;
  return error;
}

/**
 * 建一个 DPAPI envelope 保护器。
 *
 * @param {{ dataDir: string, platform?: string }} options
 */
export function createDpapiEnvelopeProtector(options = {}) {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : '';
  if (dataDir === '') {
    throw protectorError('UNAVAILABLE', 'a data directory is required for at-rest protection');
  }
  const platform = options.platform ?? process.platform;
  const secretsDir = path.join(path.resolve(dataDir), 'secrets');
  const keyPath = path.join(secretsDir, KEY_FILE_NAME);
  let cachedKey = null;
  let cachedAvailability = null;

  /** Windows 才有 DPAPI；非 Windows 明确不可用（由调用方决定 fail-closed）。 */
  function available() {
    if (cachedAvailability !== null) return cachedAvailability;
    cachedAvailability = platform === 'win32';
    return cachedAvailability;
  }

  function ensureKey() {
    if (cachedKey !== null) return cachedKey;
    if (!available()) throw protectorError('UNAVAILABLE', 'DPAPI is only available on Windows');
    let blob = null;
    try {
      const stat = fs.lstatSync(keyPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_KEY_FILE_BYTES) {
        blob = fs.readFileSync(keyPath, 'utf8').trim();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw protectorError('UNPROTECT_FAILED', 'the protected data key could not be read');
      }
    }
    if (blob === null) {
      const fresh = crypto.randomBytes(KEY_BYTES).toString('base64');
      const protectedResult = runDpapi(DPAPI_PROTECT_SCRIPT, fresh);
      if (!protectedResult.ok) throw protectorError('UNAVAILABLE', `DPAPI protect failed (${protectedResult.error})`);
      fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyPath, `${protectedResult.value}\n`, { mode: 0o600 });
      cachedKey = Buffer.from(fresh, 'base64');
      return cachedKey;
    }
    const unprotected = runDpapi(DPAPI_UNPROTECT_SCRIPT, blob);
    if (!unprotected.ok) throw protectorError('UNPROTECT_FAILED', `DPAPI unprotect failed (${unprotected.error})`);
    const key = Buffer.from(unprotected.value, 'base64');
    if (key.length !== KEY_BYTES) throw protectorError('UNPROTECT_FAILED', 'the protected data key has the wrong length');
    cachedKey = key;
    return cachedKey;
  }

  return Object.freeze({
    scheme: PROTECTOR_SCHEME,
    persistent: true,
    keyPath,
    available,

    /** @param {string} plaintext @returns {string} `v1:iv:tag:ct`（全 base64） */
    protect(plaintext) {
      const key = ensureKey();
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${BLOB_PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
    },

    /** @param {string} blob @returns {string} */
    unprotect(blob) {
      if (typeof blob !== 'string' || blob === '') throw protectorError('UNPROTECT_FAILED', 'protected blob is missing');
      const parts = blob.split(':');
      if (parts.length !== 4 || parts[0] !== BLOB_PREFIX) {
        throw protectorError('UNPROTECT_FAILED', 'protected blob has an unknown format');
      }
      let iv;
      let tag;
      let ciphertext;
      try {
        iv = Buffer.from(parts[1], 'base64');
        tag = Buffer.from(parts[2], 'base64');
        ciphertext = Buffer.from(parts[3], 'base64');
      } catch {
        throw protectorError('UNPROTECT_FAILED', 'protected blob is not valid base64');
      }
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw protectorError('UNPROTECT_FAILED', 'protected blob has invalid iv/tag');
      }
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', ensureKey(), iv, { authTagLength: TAG_BYTES });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        // 不区分"密钥错/密文坏"：任何失败都是"没有可用凭据"（fail-closed）。
        throw protectorError('UNPROTECT_FAILED', 'protected blob could not be decrypted');
      }
    },
  });
}
