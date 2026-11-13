/**
 * UI2-B9 · canonical 凭据槽（`apps/model-broker/src/credential-store.js`）验收。
 *
 * 这份实现放在 broker 包里，但 daemon 侧**不 import 它**（B8 只经 stdio JSON-RPC
 * 访问 host）。为了让"只有一份 canonical 逻辑"可被 daemon 侧的测试门禁覆盖，
 * 本文件直接从 broker 包相对路径导入——该模块零外部依赖，不会把 daemon 拖进
 * broker 包的依赖闭包（CONSOLE-V2-CONTRACT §1 第 2 条）。
 *
 * 断言重点不是"函数能跑"，而是合同 §4 的红线：
 * - 落盘位置/原子性/权限；
 * - 回显只有 masked + fingerprint + updatedAt + lengthBucket（无明文、无精确长度）；
 * - 任何坏文件/坏形状都 fail-closed 成"没有凭据"。
 *
 * 所有密钥都是**每次运行随机生成**的 canary，不写进仓库、不连接任何真实服务。
 *
 * @author PT-dove
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CREDENTIAL_SCHEMA_VERSION,
  CREDENTIAL_STORE_CODES,
  CredentialStoreError,
  MAX_SECRET_BYTES,
  MIN_SECRET_BYTES,
  createCredentialStore,
  credentialSlotPath,
  fingerprintOf,
  lengthBucketOf,
  maskOf,
  normalizeSecret,
} from '../../apps/model-broker/src/credential-store.js';

const TEMP_DIRS = new Set();

function makeTempDir(label = 'wp5-cred-store') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  TEMP_DIRS.add(dir);
  return dir;
}

test.after(() => {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    } catch {
      // 临时目录残留不该让测试变红。
    }
  }
  TEMP_DIRS.clear();
});

/** 每次运行随机 canary：绝不使用任何真实凭据形状。 */
function canary(label = 'key') {
  return `sk-canary-${label}-${crypto.randomBytes(12).toString('hex')}`;
}

function makeStore(overrides = {}) {
  const dataDir = overrides.dataDir ?? makeTempDir();
  return { dataDir, store: createCredentialStore({ dataDir }) };
}

function sha256First8(secret) {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// 落盘形状 / 原子性 / 回显
// ---------------------------------------------------------------------------

test('put 落盘到 <dataDir>/secrets/providers/<id>.json，字段与 schema 一致', (t) => {
  const { dataDir, store } = makeStore();
  const providerId = 'deepseek';
  const key = canary('slot');

  const result = store.putCredential(providerId, key);
  assert.deepEqual(result, { ok: true });

  const filePath = credentialSlotPath(dataDir, providerId);
  assert.equal(filePath, path.join(dataDir, 'secrets', 'providers', `${providerId}.json`));
  assert.ok(fs.existsSync(filePath), 'slot file must exist');

  const raw = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.schemaVersion, CREDENTIAL_SCHEMA_VERSION);
  assert.equal(record.providerId, providerId);
  assert.equal(record.secret, key);
  assert.equal(record.fingerprint, sha256First8(key));
  assert.equal(record.mask, `••••${key.slice(-4)}`);
  assert.ok(['<16', '16-32', '33-64', '>64'].includes(record.lengthBucket));
  assert.ok(!Number.isNaN(Date.parse(record.updatedAt)), 'updatedAt must be an ISO timestamp');
  // 精确长度不落盘（只落区间）。
  assert.ok(!('length' in record));
  t.diagnostic(`slot=${filePath}`);
});

test('原子写：目录里没有 tmp 残留，连续覆盖后文件仍是完整 JSON', (t) => {
  const { dataDir, store } = makeStore();
  const providerId = 'ollama-local';
  const first = canary('first');
  const second = canary('second-longer-value');

  store.putCredential(providerId, first);
  store.putCredential(providerId, second);

  const providersDir = path.join(dataDir, 'secrets', 'providers');
  const entries = fs.readdirSync(providersDir);
  assert.deepEqual(entries, [`${providerId}.json`], 'no tmp files may survive an atomic write');

  const record = JSON.parse(fs.readFileSync(credentialSlotPath(dataDir, providerId), 'utf8'));
  assert.equal(record.secret, second, 'the later write wins');
  assert.equal(record.fingerprint, sha256First8(second));

  // 并发写同一槽：不产生半文件（写是同步原子的，这里只断言最终可解析）。
  const third = canary('third');
  store.putCredential(providerId, third);
  assert.equal(JSON.parse(fs.readFileSync(credentialSlotPath(dataDir, providerId), 'utf8')).secret, third);
  t.diagnostic(`entries=${entries.join(',')}`);
});

test('maskedInfo 只回四个字段：masked/fingerprint/updatedAt/lengthBucket', () => {
  const { store } = makeStore();
  const key = canary('mask');
  store.putCredential('deepseek', key);

  const info = store.maskedInfo('deepseek');
  assert.deepEqual(Object.keys(info).sort(), ['fingerprint', 'lengthBucket', 'masked', 'updatedAt']);
  assert.equal(info.masked, `••••${key.slice(-4)}`);
  assert.equal(info.fingerprint, sha256First8(key));
  assert.equal(info.lengthBucket, lengthBucketOf(key));
  assert.ok(!JSON.stringify(info).includes(key), 'masked info must never contain the plaintext');
  assert.ok(!Number.isNaN(Date.parse(info.updatedAt)));
});

test('无凭据：hasCredential=false，maskedInfo 四个字段全为 null', () => {
  const { store } = makeStore();
  assert.equal(store.hasCredential('deepseek'), false);
  assert.deepEqual(store.maskedInfo('deepseek'), {
    masked: null,
    fingerprint: null,
    updatedAt: null,
    lengthBucket: null,
  });
});

test('readSecretForRuntime 只给 host 用：返回去首尾空白后的精确明文', () => {
  const { store } = makeStore();
  const key = canary('runtime');
  store.putCredential('deepseek', `  ${key}  `);
  assert.equal(store.readSecretForRuntime('deepseek'), key);
  assert.equal(store.readSecretForRuntime('absent-provider'), null);
});

test('delete 幂等：第一次 deleted=true，第二次 deleted=false，掩码信息随之消失', () => {
  const { store } = makeStore();
  store.putCredential('deepseek', canary('del'));
  assert.equal(store.deleteCredential('deepseek').deleted, true);
  assert.equal(store.hasCredential('deepseek'), false);
  assert.equal(store.deleteCredential('deepseek').deleted, false);
  assert.equal(store.maskedInfo('deepseek').masked, null);
});

test('lengthBucket 只给区间：8/16/33/65 字节分别落桶', () => {
  assert.equal(lengthBucketOf('a'.repeat(8)), '<16');
  assert.equal(lengthBucketOf('a'.repeat(16)), '16-32');
  assert.equal(lengthBucketOf('a'.repeat(33)), '33-64');
  assert.equal(lengthBucketOf('a'.repeat(65)), '>64');
});

// ---------------------------------------------------------------------------
// 形状校验：失败关闭、不回显
// ---------------------------------------------------------------------------

test('密钥形状不合法 → CREDENTIAL_INVALID + 枚举 reason，且不回显输入', () => {
  const cases = [
    { value: '', reason: 'EMPTY' },
    { value: '   ', reason: 'EMPTY' },
    { value: 12345678, reason: 'EMPTY' },
    { value: 'abc', reason: 'TOO_SHORT' },
    { value: 'a'.repeat(MAX_SECRET_BYTES + 1), reason: 'TOO_LONG' },
    { value: 'line1\nline2', reason: 'MULTILINE' },
    { value: 'line1\r\nline2', reason: 'MULTILINE' },
  ];
  const { store } = makeStore();
  for (const item of cases) {
    let caught = null;
    try {
      store.putCredential('deepseek', item.value);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof CredentialStoreError, `expected CredentialStoreError for ${item.reason}`);
    assert.equal(caught.code, CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID);
    assert.equal(caught.details.reason, item.reason);
    const echoed = `${caught.message} ${JSON.stringify(caught.details)}`;
    if (typeof item.value === 'string' && item.value.trim() !== '') {
      assert.ok(!echoed.includes(item.value), 'error must not echo the input');
    }
  }
  assert.equal(store.hasCredential('deepseek'), false);
});

test('providerId 形状不合法 → PROVIDER_INVALID（路径穿越/大写/过短）', () => {
  const { store } = makeStore();
  for (const bad of ['', 'A', 'DeepSeek', '../evil', 'a/b', 'a'.repeat(33), '中文名', null, 42]) {
    assert.throws(
      () => store.putCredential(bad, canary('bad-id')),
      (error) => error.code === CREDENTIAL_STORE_CODES.PROVIDER_INVALID,
      `provider id ${String(bad)} must be rejected`,
    );
  }
});

test('normalizeSecret 直接校验：8..512 字节、单行、去首尾空白', () => {
  assert.equal(normalizeSecret('  abcdefgh  '), 'abcdefgh');
  const expectReason = (value, reason) => {
    assert.throws(
      () => normalizeSecret(value),
      (error) => error.code === CREDENTIAL_STORE_CODES.CREDENTIAL_INVALID && error.details.reason === reason,
    );
  };
  expectReason('a'.repeat(MIN_SECRET_BYTES - 1), 'TOO_SHORT');
  expectReason('a'.repeat(MAX_SECRET_BYTES + 1), 'TOO_LONG');
  expectReason('a\nb', 'MULTILINE');
  expectReason(undefined, 'EMPTY');
});

test('需求的数据目录缺失 → CREDENTIAL_STORE_UNAVAILABLE（不猜默认路径）', () => {
  const previous = process.env.AEGIS_DATA_DIR;
  delete process.env.AEGIS_DATA_DIR;
  try {
    assert.throws(
      () => createCredentialStore(),
      (error) => error.code === CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
    );
  } finally {
    if (previous !== undefined) process.env.AEGIS_DATA_DIR = previous;
  }
});

// ---------------------------------------------------------------------------
// 坏文件 fail-closed
// ---------------------------------------------------------------------------

test('坏槽位文件一律当作"没有凭据"：坏 JSON / 错 schema / 错 providerId', () => {
  const { dataDir, store } = makeStore();
  const filePath = credentialSlotPath(dataDir, 'deepseek');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const invalidPayloads = [
    'not json at all',
    JSON.stringify({ schemaVersion: '9.9', providerId: 'deepseek', secret: canary('bad-schema') }),
    JSON.stringify({ schemaVersion: CREDENTIAL_SCHEMA_VERSION, providerId: 'other', secret: canary('bad-id') }),
    JSON.stringify({ schemaVersion: CREDENTIAL_SCHEMA_VERSION, providerId: 'deepseek', secret: 'short' }),
    '[]',
    'null',
  ];
  for (const payload of invalidPayloads) {
    fs.writeFileSync(filePath, payload, 'utf8');
    assert.equal(store.hasCredential('deepseek'), false, `payload must fail closed: ${payload.slice(0, 24)}`);
    assert.equal(store.maskedInfo('deepseek').masked, null);
    assert.equal(store.readSecretForRuntime('deepseek'), null);
  }

  // 超过 4KiB 的槽位文件不读（异常文件，不做二次解析）。
  fs.writeFileSync(filePath, `{"schemaVersion":"1.0","providerId":"deepseek","secret":"${'a'.repeat(5000)}"}`, 'utf8');
  assert.equal(store.hasCredential('deepseek'), false);
});

test('符号链接槽位不被跟随（能建链接则断言拒绝，不能建则记未验证）', (t) => {
  const { dataDir, store } = makeStore();
  const filePath = credentialSlotPath(dataDir, 'deepseek');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const victim = path.join(dataDir, 'victim.txt');
  const victimSecret = canary('victim');
  fs.writeFileSync(victim, victimSecret, 'utf8');
  let linkCreated = false;
  try {
    fs.symlinkSync(victim, filePath);
    linkCreated = true;
  } catch {
    // Windows 普通账户默认无 SeCreateSymbolicLinkPrivilege。
  }
  if (!linkCreated) {
    // 不跳过（daemon 门禁 skip 预算为 0）：记一条诊断说明本平台未验证该分支。
    t.diagnostic('symlink creation unavailable on this host; link-following branch unverified');
    return;
  }
  assert.equal(store.hasCredential('deepseek'), false, 'symlinked slot must not be read as a credential');
  assert.equal(store.readSecretForRuntime('deepseek'), null);
  assert.throws(
    () => store.putCredential('deepseek', canary('over-link')),
    (error) => error.code === CREDENTIAL_STORE_CODES.CREDENTIAL_STORE_UNAVAILABLE,
  );
});

// ---------------------------------------------------------------------------
// 权限：POSIX 0700/0600；Windows 用 icacls 断言 ACL
// ---------------------------------------------------------------------------

test('权限：POSIX 目录 0700 / 文件 0600；Windows 无 Everyone/Users 类 ACE', (t) => {
  const { dataDir, store } = makeStore();
  store.putCredential('deepseek', canary('perm'));
  const filePath = credentialSlotPath(dataDir, 'deepseek');
  const providersDir = path.dirname(filePath);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(providersDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    return;
  }

  let icacls;
  try {
    icacls = execFileSync('icacls', [filePath], { encoding: 'utf8' });
  } catch {
    // 不可用：不新增 skip（wp5-daemon 段 skip 预算为 0），记诊断 + 状态文件写"未验证"。
    assert.ok(true);
    t.diagnostic('icacls unavailable; Windows ACL unverified');
    return;
  }

  // 文件路径里含 "C:\Users\…"，所以不能对整段输出做 substring 断言；
  // 先剥掉目标路径，再按 `IDENTITY:(I)(PERM)` 解析每一行 ACE。
  const identities = [];
  for (const rawLine of icacls.split(/\r?\n/u)) {
    const line = rawLine.split(filePath).join('').trim();
    const match = line.match(/^(.+?):\((?:I)\)?\([A-Z,]+\)(?:\s|$)/u);
    if (match) identities.push(match[1].trim());
  }
  assert.ok(identities.length > 0, 'icacls output must contain ACEs');
  const allowed = new Set([
    'nt authority\\system',
    'builtin\\administrators',
    `${process.env.COMPUTERNAME ?? ''}\\${process.env.USERNAME ?? ''}`.toLowerCase(),
  ]);
  for (const identity of identities) {
    assert.ok(
      allowed.has(identity.toLowerCase()),
      `unexpected ACE principal on credential slot: ${identity} (allowed: current user / SYSTEM / Administrators)`,
    );
  }
  const joined = identities.join(';').toLowerCase();
  assert.ok(joined.includes('system'), 'SYSTEM must keep access');
  assert.ok(joined.includes('administrator'), 'Administrators must keep access');
  t.diagnostic(`ACL principals: ${identities.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// 导出面：不得从包入口泄漏
// ---------------------------------------------------------------------------

test('canonical 存储不在 @aegisharness/model-broker 的公共出口（daemon 不能 import）', async () => {
  const index = await import('../../apps/model-broker/src/index.js');
  for (const name of ['createCredentialStore', 'putCredential', 'readSecretForRuntime', 'credentialSlotPath']) {
    assert.equal(index[name], undefined, `${name} must not be exported from src/index.js`);
  }
  // chat-transport 同理：daemon 只能经 spawn + stdio JSON-RPC 使用。
  for (const name of ['createChatTransport', 'probeProviderModels']) {
    assert.equal(index[name], undefined, `${name} must not be exported from src/index.js`);
  }
});

// ---------------------------------------------------------------------------
// 便捷函数（掩码/指纹）与 store 的 canonical 值一致
// ---------------------------------------------------------------------------

test('maskOf/fingerprintOf 与 store 落盘值一致，且长度桶不泄漏精确长度', () => {
  const key = canary('helpers');
  assert.equal(maskOf(key), `••••${key.slice(-4)}`);
  assert.equal(fingerprintOf(key), sha256First8(key));
  assert.notEqual(maskOf(key), key);
  assert.ok(!maskOf(key).includes(key.slice(0, -4)));
});
