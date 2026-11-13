/**
 * P1-CLOSE / T2 (downgrade-verifier) · 快速离线用例：
 * **旧版出厂载荷打开"未来 schema"库**必须明确拒绝（错误码 + 原文 + 库字节不变），
 * 而不是静默损坏 / 尽力读 / 悄悄降级。
 *
 * 与 `tests/wp1-event-store/downgrade-refusal.test.js` 的分工（不重复）：
 * - 那份用**仓库工作树**的 event-store 做单元判据（快、随源码演进）；
 * - 本文件用**已发布产物里的字节**（`dist/release/0.0.1-rc.{5,6}` 的 portable.zip，
 *   先按 `SHA256SUMS.txt` 校验 zip 自身，再用 bsdtar 抽取 `app/node_modules/@aegisharness/*`），
 *   所以它回答的是"用户手里那份 rc.5 二进制会怎么做"，而不是"当前源码会怎么做"。
 *
 * 只读纪律：不写 `dist/**`；临时件落在 OS temp，文件级 after 清理。
 * 运行时间目标 < 3 s（抽取 39 文件 ×2 + 若干次开库）。
 *
 * Author: PT-dove
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { makeTempDir } from './helpers.js';
import {
  DELIVERED,
  EXPECTED_EVENT_STORE,
  captureStoreError,
  extractDeliveredPayload,
  loadDeliveredApi,
  makeFutureSchema,
  rawFacts,
  seedCurrentSchemaDb,
  sha256File,
  sidecarFacts,
  verifyReleaseArtifacts,
} from '../installer/p1-downgrade/delivered-payload.mjs';

const NEWER_SCHEMA_MESSAGE = 'ERR_SCHEMA_TOO_NEW: database schema 6 is newer than this binary (5)';
const AUDIT_KEY = 'p1-close-downgrade-audit-key-0123456789abcdef';

let shared = null;

function artifactsPresent() {
  return ['rc5', 'rc6'].every((key) => {
    const meta = DELIVERED[key];
    return fs.existsSync(path.join(meta.releaseDir, meta.zipName))
      && fs.existsSync(path.join(meta.releaseDir, 'SHA256SUMS.txt'));
  });
}

before(async (t) => {
  if (!artifactsPresent()) {
    shared = { skipped: 'dist/release/0.0.1-rc.{5,6} 的 portable.zip / SHA256SUMS.txt 不在本机（无出厂字节可比）' };
    return;
  }
  const dir = makeTempDir(t, 'p1-downgrade-payload');
  shared = { dir, artifacts: verifyReleaseArtifacts(), payloads: {}, apis: {} };
  for (const key of ['rc5', 'rc6']) {
    shared.payloads[key] = extractDeliveredPayload(key, path.join(dir, 'payload', key));
    shared.apis[key] = await loadDeliveredApi(shared.payloads[key]);
  }
});

after(() => {
  shared = null;
});

function requireShared(t) {
  assert.ok(shared !== null, 'before() 没有初始化上下文');
  if (shared.skipped) {
    t.skip(shared.skipped);
    return null;
  }
  return shared;
}

/** 用 rc.5 出厂代码建真实 v5 库 + 用裸 sqlite 复制成 v6（"下一代二进制跑过迁移"的形状）。 */
function makeFutureDb(ctx, name) {
  const baseDb = path.join(ctx.dir, `seed-${name}.db`);
  seedCurrentSchemaDb({
    storeApi: ctx.apis.rc5.store,
    contracts: ctx.apis.rc5.contracts,
    dbPath: baseDb,
    auditKey: AUDIT_KEY,
    events: 3,
  });
  const futureDb = path.join(ctx.dir, `future-${name}.db`);
  fs.copyFileSync(baseDb, futureDb);
  const futureFacts = makeFutureSchema(futureDb, { nextVersion: 6 });
  return { baseDb, futureDb, futureFacts };
}

test('出厂产物自校验：rc.5 与 rc.6 的 event-store 是不同二进制、但 schema.js 同字节', (t) => {
  const ctx = requireShared(t);
  if (ctx === null) return;

  for (const key of ['rc5', 'rc6']) {
    const artifact = ctx.artifacts[key];
    assert.equal(artifact.zip.match, true, `${key}: portable.zip 与 SHA256SUMS.txt 不一致（产物被改动？）`);
    assert.equal(artifact.setup.match, true, `${key}: Setup.exe 与 SHA256SUMS.txt 不一致（产物被改动？）`);
    for (const [name, expected] of Object.entries(EXPECTED_EVENT_STORE[key])) {
      const file = ctx.payloads[key].files.find((entry) => entry.path.endsWith(`/event-store/src/${name}`));
      assert.ok(file !== undefined, `${key}: 出厂载荷里找不到 event-store/src/${name}`);
      assert.equal(file.sha256, expected, `${key}: ${name} 的字节与登记值不一致`);
    }
  }

  // schema.js 相同 ⇒ 两代之间没有 schema 迁移；db.js 不同 ⇒ 我们确实在测两份不同的二进制。
  assert.equal(EXPECTED_EVENT_STORE.rc5['schema.js'], EXPECTED_EVENT_STORE.rc6['schema.js']);
  assert.notEqual(EXPECTED_EVENT_STORE.rc5['db.js'], EXPECTED_EVENT_STORE.rc6['db.js']);
});

test('rc.5 出厂载荷打开"未来 schema"库：ERR_SCHEMA_TOO_NEW + 原文可读 + 库字节不变', (t) => {
  const ctx = requireShared(t);
  if (ctx === null) return;

  const { futureDb, futureFacts } = makeFutureDb(ctx, 'rc5');
  const before = sidecarFacts(futureDb);

  const error = captureStoreError(() => ctx.apis.rc5.store.openStore({ path: futureDb, auditKey: AUDIT_KEY }));
  assert.ok(error !== null, '打开未来 schema 库必须抛错，而不是"尽力读"');
  // 三件套之一：错误码。
  assert.equal(error.code, 'ERR_SCHEMA_TOO_NEW');
  // 三件套之二：可读原文（要能看懂"库比二进制新"，且带两个版本号）。
  assert.equal(error.message, NEWER_SCHEMA_MESSAGE);
  assert.equal(error.details.database, 6);
  assert.equal(error.details.binary, 5);
  // 三件套之三：库文件一个 bit 都没变（拒绝不是"打开→回滚"，也不是"删了重建"）。
  const after = sidecarFacts(futureDb);
  assert.equal(after.main, before.main, '拒绝打开不得改写数据库主文件');
  assert.deepEqual(after.sidecars, [], '拒绝打开不得留下 -wal/-shm（那意味着真的写过）');

  const factsAfter = rawFacts(futureDb);
  assert.deepEqual(factsAfter, futureFacts, '拒绝后语义必须与拒绝前逐项相同（版本/行数/迁移/新一代表）');
  assert.equal(factsAfter.schemaVersion, 6);
  assert.equal(factsAfter.events, 3);
  assert.equal(factsAfter.quickCheck, 'ok');
});

test('拒绝是确定性的：连续 3 次重试都不改库字节、也没有写入成功', (t) => {
  const ctx = requireShared(t);
  if (ctx === null) return;

  const { futureDb, futureFacts } = makeFutureDb(ctx, 'retry');
  const beforeHash = sha256File(futureDb);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const error = captureStoreError(() => ctx.apis.rc5.store.openStore({ path: futureDb, auditKey: AUDIT_KEY }));
    assert.equal(error?.code, 'ERR_SCHEMA_TOO_NEW', `第 ${attempt + 1} 次重试也必须拒绝`);
    assert.equal(sha256File(futureDb), beforeHash, `第 ${attempt + 1} 次重试改动了库字节`);
  }

  // 没有"拒绝之后又写进去"的路径：行数与迁移记录仍是拒绝前那份。
  assert.deepEqual(rawFacts(futureDb), futureFacts);
});

test('rc.6 出厂载荷（对照）对同一形状的未来库同样拒绝', (t) => {
  const ctx = requireShared(t);
  if (ctx === null) return;

  const { futureDb } = makeFutureDb(ctx, 'rc6');
  const before = sidecarFacts(futureDb);
  const error = captureStoreError(() => ctx.apis.rc6.store.openStore({ path: futureDb, auditKey: AUDIT_KEY }));
  assert.equal(error?.code, 'ERR_SCHEMA_TOO_NEW');
  assert.equal(error?.message, NEWER_SCHEMA_MESSAGE);
  const after = sidecarFacts(futureDb);
  assert.equal(after.main, before.main);
  assert.deepEqual(after.sidecars, []);
});

test('只读打开未来库同样被拒（不是"只读就尽力读"）', (t) => {
  const ctx = requireShared(t);
  if (ctx === null) return;

  const { futureDb } = makeFutureDb(ctx, 'readonly');
  const before = sidecarFacts(futureDb);
  const error = captureStoreError(
    () => ctx.apis.rc5.store.openStore({ path: futureDb, readOnly: true }),
  );
  assert.equal(error?.code, 'ERR_SCHEMA_TOO_NEW');
  assert.equal(error?.details.database, 6);
  assert.equal(sidecarFacts(futureDb).main, before.main);
});

test('同级 v5 库在 rc.5 与 rc.6 出厂载荷下都能打开并写入（拒绝只针对"更新 schema"）', (t) => {
  const ctx = requireShared(t);
  if (ctx === null) return;

  const dbPath = path.join(ctx.dir, 'same-level-v5.db');
  seedCurrentSchemaDb({
    storeApi: ctx.apis.rc5.store,
    contracts: ctx.apis.rc5.contracts,
    dbPath,
    auditKey: AUDIT_KEY,
    events: 3,
  });
  assert.equal(rawFacts(dbPath).events, 3);

  let seq = 500;
  for (const key of ['rc5', 'rc6']) {
    const api = ctx.apis[key];
    const store = api.store.openStore({ path: dbPath, auditKey: AUDIT_KEY });
    try {
      seq += 1;
      const payload = { process_name: `same-level-${key}.exe`, pid: 5000 + seq };
      const canonicalDigest = api.contracts.canonicalDigest;
      const event = {
        schemaVersion: '1.0',
        event_id: api.store.uuid(),
        stable_source_id: 'windows.security.4688',
        collector_instance_id: api.store.uuid(),
        source_generation: 1,
        boot_id: 'b'.repeat(32),
        source_seq: seq,
        observed_at: '2026-11-01T00:00:00.000Z',
        received_at: '2026-11-01T00:00:01.000Z',
        type: 'process.start',
        severity: 'high',
        payload,
        integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
      };
      const result = api.store.ingestTelemetry(store, { event, now: '2026-11-01T00:00:05.000Z' });
      assert.equal(result.duplicate, false, `${key}: 同级库必须能真的写入`);
    } finally {
      store.close();
    }
    const facts = rawFacts(dbPath);
    assert.equal(facts.schemaVersion, 5, `${key}: 旧版不得改 schema_version`);
    assert.equal(facts.quickCheck, 'ok');
  }

  assert.equal(rawFacts(dbPath).events, 5, '两个版本各写 1 条后应为 5 条');
});
