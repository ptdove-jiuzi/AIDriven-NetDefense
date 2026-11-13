/**
 * P1-CLOSE / T2 (downgrade-verifier)：从**已发布产物**里取出 event-store 的字节。
 *
 * 为什么不用仓库 `packages/event-store`：
 * 本席位要回答的是"用户把 rc.6 装出来的库，交给 rc.5 那份出厂二进制，会发生什么"。
 * 仓库工作树是被并行战役改过的（perf / defect-close / ops-diag），它不是任何一份出厂字节。
 * 所以这里只认 `dist/release/0.0.1-rc.{5,6}/…-portable.zip` 里的
 * `app/node_modules/@aegisharness/{event-store,contracts}`：先按同目录 `SHA256SUMS.txt`
 * 校验 zip 自身，再用 bsdtar 只抽取这两个目录（39 个文件，约 0.3 s），
 * 然后按绝对 file URL 动态 import —— 依赖解析走 `app/node_modules`（包布局），
 * 与仓库布局无关。
 *
 * 只读纪律：不写 `dist/**`；所有临时件都落在调用方给的 temp 目录里。
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** 两份冻结产物的位置。`payloadDirName` 是发布记录里对应的载荷目录（仅作溯源交叉核对）。 */
export const DELIVERED = Object.freeze({
  rc5: Object.freeze({
    label: '0.0.1-rc.5',
    releaseDir: path.join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.5'),
    zipName: 'AIDrivenNetDefense-0.0.1-rc.5-win-x64-portable.zip',
    setupName: 'AIDrivenNetDefense-Setup-0.0.1-rc.5.exe',
    payloadDirName: 'win32-x64-v17',
  }),
  rc6: Object.freeze({
    label: '0.0.1-rc.6',
    releaseDir: path.join(REPO_ROOT, 'dist', 'release', '0.0.1-rc.6'),
    zipName: 'AIDrivenNetDefense-0.0.1-rc.6-win-x64-portable.zip',
    setupName: 'AIDrivenNetDefense-Setup-0.0.1-rc.6.exe',
    payloadDirName: 'win32-x64-v18',
  }),
});

/** 冻结产物里 event-store 关键文件的期望 sha256（本席位复算值，见 evidence sha256 TSV）。 */
export const EXPECTED_EVENT_STORE = Object.freeze({
  rc5: Object.freeze({
    'schema.js': 'c49169256fc1a6282ba569ebf0519d121cd3c24ef0876733b7da0d4bb465f4b8',
    'db.js': '5e417e2fe0390863ae25ef7b400591136cb6892c24cd03e7c4168fb11cfbe27c',
    'ingest.js': 'ea93acfb1fb6c22ecfed6da1e85032811ec8825255251c24551bc24624020636',
  }),
  rc6: Object.freeze({
    'schema.js': 'c49169256fc1a6282ba569ebf0519d121cd3c24ef0876733b7da0d4bb465f4b8',
    'db.js': '928bd82f2198b9807b8652651f7f16717ace8637eb5edff73bb7de9141742824',
    'ingest.js': 'e203441551c18a6ef937b7691ae7ef71e16b8ef840bfe8772d86f01a4d2a1b0a',
  }),
});

/** @aegisharness 下要从 zip 里抽取的两个包（event-store 的依赖只有 contracts）。 */
const PACKAGE_PREFIXES = Object.freeze([
  'app/node_modules/@aegisharness/event-store',
  'app/node_modules/@aegisharness/contracts',
]);

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function findTar() {
  const candidates = [
    'tar',
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'),
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** 读 `SHA256SUMS.txt` → Map(basename → 小写 sha256)。 */
export function readSums(releaseDir) {
  const file = path.join(releaseDir, 'SHA256SUMS.txt');
  const map = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match !== null) map.set(path.basename(match[2].trim()), match[1].toLowerCase());
  }
  return map;
}

/**
 * 校验两份产物的 zip/exe 与各自的 SHA256SUMS.txt 逐位一致。
 * 返回可直接落盘的结构化事实（不含断言）。
 */
export function verifyReleaseArtifacts() {
  const facts = {};
  for (const [key, meta] of Object.entries(DELIVERED)) {
    const sums = readSums(meta.releaseDir);
    const zipPath = path.join(meta.releaseDir, meta.zipName);
    const setupPath = path.join(meta.releaseDir, meta.setupName);
    const zipSha = sha256File(zipPath);
    const setupSha = sha256File(setupPath);
    facts[key] = {
      label: meta.label,
      zip: {
        path: zipPath,
        bytes: fs.statSync(zipPath).size,
        sha256: zipSha,
        expected: sums.get(meta.zipName) ?? null,
        match: sums.get(meta.zipName) === zipSha,
      },
      setup: {
        path: setupPath,
        bytes: fs.statSync(setupPath).size,
        sha256: setupSha,
        expected: sums.get(meta.setupName) ?? null,
        match: sums.get(meta.setupName) === setupSha,
      },
    };
  }
  return facts;
}

/**
 * 从冻结 portable zip 里抽出 event-store / contracts 到 `destDir`，返回可 import 的路径与文件清单。
 * 抽出后用 `EXPECTED_EVENT_STORE` 之外的方式复算：调用方负责断言。
 */
export function extractDeliveredPayload(key, destDir) {
  const meta = DELIVERED[key];
  assert.ok(meta !== undefined, `unknown delivered payload: ${key}`);
  const zipPath = path.join(meta.releaseDir, meta.zipName);
  assert.ok(fs.existsSync(zipPath), `delivered zip is missing: ${zipPath}`);

  const sums = readSums(meta.releaseDir);
  const zipSha = sha256File(zipPath);
  assert.equal(sums.get(meta.zipName), zipSha, `${meta.zipName} 与 SHA256SUMS.txt 不一致（产物被改动？）`);

  const tar = findTar();
  assert.ok(tar !== null, '找不到 bsdtar（Windows System32\\tar.exe），无法从 zip 抽取出厂载荷');
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync(tar, ['-xf', zipPath, '-C', destDir, ...PACKAGE_PREFIXES], { encoding: 'utf8' });
  assert.equal(result.status, 0, `bsdtar 抽取失败: ${result.stderr || result.stdout}`);

  const eventStoreDir = path.join(destDir, 'app', 'node_modules', '@aegisharness', 'event-store');
  const contractsDir = path.join(destDir, 'app', 'node_modules', '@aegisharness', 'contracts');
  const eventStoreIndex = path.join(eventStoreDir, 'src', 'index.js');
  assert.ok(fs.existsSync(eventStoreIndex), `抽取后找不到 ${eventStoreIndex}`);

  const files = [];
  for (const pkgDir of [eventStoreDir, contractsDir]) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          files.push({
            path: path.relative(destDir, full).replaceAll('\\', '/'),
            bytes: fs.statSync(full).size,
            sha256: sha256File(full),
          });
        }
      }
    };
    walk(pkgDir);
  }

  return {
    key,
    label: meta.label,
    zip: { path: zipPath, sha256: zipSha, bytes: fs.statSync(zipPath).size },
    destDir,
    eventStoreDir,
    contractsDir,
    eventStoreIndex,
    contractsIndex: path.join(contractsDir, 'src', 'index.js'),
    generatedAt: new Date().toISOString(),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/** 动态 import 出厂 event-store（含 contracts），返回两个模块命名空间。 */
export async function loadDeliveredApi(extracted) {
  const store = await import(pathToFileURL(extracted.eventStoreIndex).href);
  const contracts = await import(pathToFileURL(extracted.contractsIndex).href);
  return { store, contracts };
}

/**
 * 用裸 node:sqlite 只读事实：不经过任何 event-store 版本，避免"被守卫挡在外面看不到真相"。
 * 表不存在返回 null（区别于 0 行）。
 */
export function rawFacts(dbPath) {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table) => {
      try {
        return Number(raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c);
      } catch {
        return null;
      }
    };
    const meta = raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return {
      schemaVersion: meta === undefined ? null : Number(meta.value),
      events: count('telemetry_event'),
      alerts: count('alert'),
      auditRows: count('audit_event'),
      dataGaps: count('data_gap'),
      futureFeatureRows: count('v6_future_feature'),
      migrations: raw.prepare('SELECT version FROM schema_migration ORDER BY version').all()
        .map((row) => Number(row.version)),
      quickCheck: raw.prepare('PRAGMA quick_check').get().quick_check,
      journalMode: String(raw.prepare('PRAGMA journal_mode').get().journal_mode),
    };
  } finally {
    raw.close();
  }
}

/** 主库 + 侧车文件（-wal/-shm）的字节现状；`present` 只列存在的。 */
export function sidecarFacts(dbPath) {
  const facts = { main: sha256File(dbPath), sidecars: [] };
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) {
      facts.sidecars.push({ suffix, bytes: fs.statSync(sidecar).size, sha256: sha256File(sidecar) });
    }
  }
  return facts;
}

/** 取出一个被抛出的 StoreError 的可落盘形状（跨模块实例也能读：只按字段判，不按 instanceof）。 */
export function captureStoreError(fn) {
  try {
    fn();
  } catch (error) {
    return {
      name: error?.name ?? null,
      code: error?.code ?? null,
      message: error?.message ?? null,
      details: error?.details ?? null,
      stackTop: String(error?.stack ?? '').split('\n').slice(0, 2).join(' | '),
    };
  }
  return null;
}

/**
 * 用**出厂 payload 自己的代码**建一个真实 v5 库并写入事件（不是手搓表结构）。
 * `makeEvent` 需要 payload 的 uuid/canonicalDigest，故一并传入。
 */
export function seedCurrentSchemaDb({ storeApi, contracts, dbPath, auditKey, events = 3 }) {
  const { uuid, sha256Hex } = storeApi;
  const canonicalDigest = contracts.canonicalDigest ?? ((value) => sha256Hex(JSON.stringify(value)));
  const store = storeApi.openStore({ path: dbPath, auditKey });
  try {
    for (let index = 0; index < events; index += 1) {
      const payload = { process_name: 'demo.exe', pid: 4000 + index };
      const event = {
        schemaVersion: '1.0',
        event_id: uuid(),
        stable_source_id: 'windows.security.4688',
        collector_instance_id: uuid(),
        source_generation: 1,
        boot_id: 'a'.repeat(32),
        source_seq: 100 + index,
        observed_at: '2026-11-01T00:00:00.000Z',
        received_at: '2026-11-01T00:00:01.000Z',
        type: 'process.start',
        severity: 'high',
        payload,
        integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
      };
      storeApi.ingestTelemetry(store, { event, now: '2026-11-01T00:00:02.000Z' });
    }
  } finally {
    store.close();
  }
  return rawFacts(dbPath);
}

/**
 * 把真实 v5 库改造成"被下一代二进制跑过迁移"的形状：
 * meta.schema_version = nextVersion，追加 schema_migration 行，并真的建一张下一代才有的表。
 * 这不是"只改一个数字"：旧二进制若想悄悄降级/回滚/尽力读，会被 v6 表与迁移记录抓住。
 */
export function makeFutureSchema(dbPath, { nextVersion = 6 } = {}) {
  assert.ok(Number.isInteger(nextVersion) && nextVersion > 0);
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('BEGIN');
    raw.exec('CREATE TABLE v6_future_feature (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT');
    raw.prepare('INSERT INTO v6_future_feature (note) VALUES (?)').run('created by a newer release');
    raw.prepare(
      'INSERT OR REPLACE INTO schema_migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    ).run(nextVersion, 'simulated-v6', 'f'.repeat(64), '2026-11-05T00:00:00.000Z');
    raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(nextVersion));
    raw.exec('COMMIT');
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    raw.close();
  }
  return rawFacts(dbPath);
}

/** 一条断言失败也能把上下文留在报告里的轻量检查器。 */
export function makeChecker() {
  const checks = [];
  const check = (id, predicate, detail) => {
    const pass = predicate === true;
    checks.push({ id, pass, detail });
    return pass;
  };
  return { checks, check };
}
