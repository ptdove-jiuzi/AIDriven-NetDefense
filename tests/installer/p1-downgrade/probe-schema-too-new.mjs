/**
 * P1-CLOSE / T2 (downgrade-verifier) · 探针：**旧版出厂载荷打开"未来 schema"库**会怎样。
 *
 * 判据三件（缺一不算"明确拒绝+提示"）：
 *   ① 错误码 = ERR_SCHEMA_TOO_NEW（不是静默降级、不是尽力读、不是崩溃在别处）；
 *   ② 消息可读（含"database schema N is newer than this binary (M)"，N>M）；
 *   ③ 库文件字节未变（主库 sha256 前后相同、无 -wal/-shm 残留、语义事实与拒绝前逐项相同）。
 * 另加对照组：
 *   - rc.6 出厂载荷对同一库也拒绝（说明这不是"只有旧版才拦"的偶然）；
 *   - **同级库**（v5）在 rc.5 / rc.6 下都能打开并写入（说明拒绝只针对"更新 schema"，不是一律拒）；
 *   - 只读打开同样拒绝（不是"只读就放行→尽力读"）。
 *
 * 用法：
 *   & 'C:\Program Files\nodejs\node.exe' tests/installer/p1-downgrade/probe-schema-too-new.mjs `
 *       --out evidence/p1-close/downgrade/schema-too-new/RESULT.json `
 *       --work "%TEMP%\p1-close\downgrade-verifier\schema-probe"
 *
 * Author: PT-dove
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  DELIVERED,
  EXPECTED_EVENT_STORE,
  REPO_ROOT,
  captureStoreError,
  extractDeliveredPayload,
  loadDeliveredApi,
  makeFutureSchema,
  rawFacts,
  seedCurrentSchemaDb,
  sha256File,
  sidecarFacts,
  verifyReleaseArtifacts,
} from './delivered-payload.mjs';

function parseArgs(argv) {
  const args = { out: null, work: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') args.out = argv[index + 1];
    else if (argv[index] === '--work') args.work = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const workRoot = path.resolve(
  args.work ?? path.join(process.env.TEMP ?? REPO_ROOT, 'p1-close', 'downgrade-verifier', 'schema-probe'),
);
const outPath = args.out === null ? null : path.resolve(args.out);

/** StoreError 的 message 带错误码前缀（errors.js 的格式），所以断言按"原文全文"比对。 */
const NEWER_SCHEMA_MESSAGE = 'ERR_SCHEMA_TOO_NEW: database schema 6 is newer than this binary (5)';

const checks = [];
const raw = { startedAt: new Date().toISOString(), workRoot, outPath };
const lines = [];

function log(line) {
  lines.push(line);
  console.log(line);
}

function check(id, expected, actual, predicate, extra = {}) {
  const pass = predicate === true;
  checks.push({ id, expected, actual, pass, ...(Object.keys(extra).length > 0 ? { extra } : {}) });
  log(`${pass ? 'PASS' : 'FAIL'} ${id} | expected=${JSON.stringify(expected)} | actual=${JSON.stringify(actual)}`);
  return pass;
}

function copyDb(source, target) {
  fs.copyFileSync(source, target);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${source}${suffix}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${target}${suffix}`);
  }
}

function main() {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  // ---------------------------------------------------------------- 1. 产物自校验
  const artifacts = verifyReleaseArtifacts();
  raw.artifacts = artifacts;
  for (const [key, fact] of Object.entries(artifacts)) {
    check(
      `artifact.zip.${key}`,
      { name: DELIVERED[key].zipName, expected: fact.zip.expected },
      { sha256: fact.zip.sha256, bytes: fact.zip.bytes },
      fact.zip.match === true,
    );
    check(
      `artifact.setup.${key}`,
      { name: DELIVERED[key].setupName, expected: fact.setup.expected },
      { sha256: fact.setup.sha256, bytes: fact.setup.bytes },
      fact.setup.match === true,
    );
  }

  // ---------------------------------------------------------------- 2. 抽取两份出厂 event-store
  const extracted = {};
  for (const key of ['rc5', 'rc6']) {
    extracted[key] = extractDeliveredPayload(key, path.join(workRoot, 'payload', key));
    for (const [name, expected] of Object.entries(EXPECTED_EVENT_STORE[key])) {
      const file = extracted[key].files.find((entry) => entry.path.endsWith(`/event-store/src/${name}`));
      check(
        `payload.${key}.${name}.sha256`,
        expected,
        file?.sha256 ?? null,
        file !== undefined && file.sha256 === expected,
      );
    }
  }
  raw.extracted = Object.fromEntries(
    Object.entries(extracted).map(([key, value]) => [key, { zip: value.zip, destDir: value.destDir, files: value.files }]),
  );
  check(
    'payload.rc5.dbBytesDifferFromRc6',
    'rc.5 与 rc.6 的 db.js 字节不同（两份二进制不是同一份）',
    { rc5: EXPECTED_EVENT_STORE.rc5['db.js'], rc6: EXPECTED_EVENT_STORE.rc6['db.js'] },
    EXPECTED_EVENT_STORE.rc5['db.js'] !== EXPECTED_EVENT_STORE.rc6['db.js'],
  );

  // 动态 import 是 async：同步段落（校验 + 抽取）与异步段落（加载 + 开库）分开写，
  // 见文件末尾 run()。
  return { extracted, workRoot };
}

async function run() {
  const { extracted } = main();
  const apis = {};
  for (const key of ['rc5', 'rc6']) {
    apis[key] = await loadDeliveredApi(extracted[key]);
    raw.versions = raw.versions ?? {};
    raw.versions[key] = {
      CURRENT_SCHEMA_VERSION: apis[key].store.CURRENT_SCHEMA_VERSION,
      MIN_READABLE_SCHEMA_VERSION: apis[key].store.MIN_READABLE_SCHEMA_VERSION,
      eventStoreIndex: extracted[key].eventStoreIndex,
    };
    check(
      `payload.${key}.CURRENT_SCHEMA_VERSION`,
      5,
      apis[key].store.CURRENT_SCHEMA_VERSION,
      apis[key].store.CURRENT_SCHEMA_VERSION === 5,
    );
  }

  // ---------------------------------------------------------------- 3. 用 rc.5 出厂代码建真实 v5 库
  const dbDir = path.join(workRoot, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const auditKey = 'p1-close-downgrade-audit-key-0123456789abcdef';
  const baseDb = path.join(dbDir, 'rc5-current-v5.db');
  const baseFacts = seedCurrentSchemaDb({ storeApi: apis.rc5.store, contracts: apis.rc5.contracts, dbPath: baseDb, auditKey, events: 3 });
  raw.baseDb = { path: baseDb, facts: baseFacts, sha256: sha256File(baseDb), sidecars: sidecarFacts(baseDb) };
  check('baseDb.schemaVersion', 5, baseFacts.schemaVersion, baseFacts.schemaVersion === 5);
  check('baseDb.events', 3, baseFacts.events, baseFacts.events === 3);
  check('baseDb.quickCheck', 'ok', baseFacts.quickCheck, baseFacts.quickCheck === 'ok');

  // ---------------------------------------------------------------- 4. 合成"未来库"（v6）
  const futureDb = path.join(dbDir, 'future-v6.db');
  copyDb(baseDb, futureDb);
  const futureFacts = makeFutureSchema(futureDb, { nextVersion: 6 });
  const futureBefore = { sha256: sha256File(futureDb), sidecars: sidecarFacts(futureDb), facts: futureFacts };
  raw.futureDb = { path: futureDb, before: futureBefore };
  check('futureDb.schemaVersion', 6, futureFacts.schemaVersion, futureFacts.schemaVersion === 6);
  check('futureDb.events', 3, futureFacts.events, futureFacts.events === 3);
  check('futureDb.futureFeatureRows', 1, futureFacts.futureFeatureRows, futureFacts.futureFeatureRows === 1);
  check('futureDb.quickCheck', 'ok', futureFacts.quickCheck, futureFacts.quickCheck === 'ok');

  // ---------------------------------------------------------------- 5. rc.5 出厂载荷打开未来库（主判据）
  const rc5Attempt = { before: sidecarFacts(futureDb) };
  rc5Attempt.error = captureStoreError(() => apis.rc5.store.openStore({ path: futureDb, auditKey }));
  rc5Attempt.after = sidecarFacts(futureDb);
  rc5Attempt.factsAfter = rawFacts(futureDb);
  raw.rc5OpenFuture = rc5Attempt;
  check('rc5.future.errorThrown', true, rc5Attempt.error !== null, rc5Attempt.error !== null);
  check('rc5.future.errorCode', 'ERR_SCHEMA_TOO_NEW', rc5Attempt.error?.code, rc5Attempt.error?.code === 'ERR_SCHEMA_TOO_NEW');
  check(
    'rc5.future.errorMessage',
    NEWER_SCHEMA_MESSAGE,
    rc5Attempt.error?.message,
    rc5Attempt.error?.message === NEWER_SCHEMA_MESSAGE,
  );
  check(
    'rc5.future.errorDetails',
    { database: 6, binary: 5 },
    rc5Attempt.error?.details ?? null,
    rc5Attempt.error?.details?.database === 6 && rc5Attempt.error?.details?.binary === 5,
  );
  check('rc5.future.dbBytesUnchanged', rc5Attempt.before.main, rc5Attempt.after.main, rc5Attempt.before.main === rc5Attempt.after.main);
  check(
    'rc5.future.noSidecarCreated',
    [],
    rc5Attempt.after.sidecars.map((entry) => entry.suffix),
    rc5Attempt.after.sidecars.length === 0,
  );
  const semanticSame = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  check(
    'rc5.future.semanticsUnchanged',
    'schema_version/事件/告警/审计/迁移记录/新一代表/quick_check 全部与拒绝前相同',
    rc5Attempt.factsAfter,
    semanticSame(futureBefore.facts, rc5Attempt.factsAfter),
  );
  check(
    'rc5.future.noWriteSucceeded',
    '拒绝后事件数仍为 3、审计行数与迁移记录未增加',
    { events: rc5Attempt.factsAfter.events, migrations: rc5Attempt.factsAfter.migrations },
    rc5Attempt.factsAfter.events === 3 && semanticSame(futureBefore.facts.migrations, rc5Attempt.factsAfter.migrations),
  );

  // 连续 3 次重试：拒绝必须确定性，且每次都不改字节（"失败也写了一半"也算损坏）。
  const repeatHashes = [];
  for (let index = 0; index < 3; index += 1) {
    captureStoreError(() => apis.rc5.store.openStore({ path: futureDb, auditKey }));
    repeatHashes.push(sha256File(futureDb));
  }
  raw.rc5RepeatAttempts = repeatHashes;
  check(
    'rc5.future.repeatedAttemptsLeaveBytesIdentical',
    futureBefore.sha256,
    repeatHashes,
    repeatHashes.every((hash) => hash === futureBefore.sha256),
  );

  // ---------------------------------------------------------------- 6. rc.6 出厂载荷对同一库（对照）
  const rc6Copy = path.join(dbDir, 'future-v6-for-rc6.db');
  copyDb(baseDb, rc6Copy);
  makeFutureSchema(rc6Copy, { nextVersion: 6 });
  const rc6Before = sidecarFacts(rc6Copy);
  const rc6Error = captureStoreError(() => apis.rc6.store.openStore({ path: rc6Copy, auditKey }));
  const rc6After = sidecarFacts(rc6Copy);
  raw.rc6OpenFuture = { before: rc6Before, error: rc6Error, after: rc6After, factsAfter: rawFacts(rc6Copy) };
  check('rc6.future.errorCode', 'ERR_SCHEMA_TOO_NEW', rc6Error?.code, rc6Error?.code === 'ERR_SCHEMA_TOO_NEW');
  check('rc6.future.errorMessage', NEWER_SCHEMA_MESSAGE, rc6Error?.message, rc6Error?.message === NEWER_SCHEMA_MESSAGE);
  check('rc6.future.dbBytesUnchanged', rc6Before.main, rc6After.main, rc6Before.main === rc6After.main);

  // ---------------------------------------------------------------- 7. 只读打开也拒绝（不是"只读就尽力读"）
  const readonlyCopy = path.join(dbDir, 'future-v6-readonly.db');
  copyDb(baseDb, readonlyCopy);
  makeFutureSchema(readonlyCopy, { nextVersion: 6 });
  const readonlyBefore = sidecarFacts(readonlyCopy);
  const readonlyError = captureStoreError(() => apis.rc5.store.openStore({ path: readonlyCopy, readOnly: true }));
  const readonlyAfter = sidecarFacts(readonlyCopy);
  raw.rc5ReadOnlyFuture = { before: readonlyBefore, error: readonlyError, after: readonlyAfter };
  check('rc5.future.readOnly.errorCode', 'ERR_SCHEMA_TOO_NEW', readonlyError?.code, readonlyError?.code === 'ERR_SCHEMA_TOO_NEW');
  check('rc5.future.readOnly.dbBytesUnchanged', readonlyBefore.main, readonlyAfter.main, readonlyBefore.main === readonlyAfter.main);

  // ---------------------------------------------------------------- 8. 同级库对照：v5 在 rc.5 / rc.6 下都能打开并写入
  const sameLevel = path.join(dbDir, 'same-level-v5.db');
  copyDb(baseDb, sameLevel);
  const sameLevelBefore = rawFacts(sameLevel);

  const rc5Same = { before: sameLevelBefore };
  let store = apis.rc5.store.openStore({ path: sameLevel, auditKey });
  try {
    const { uuid, sha256Hex } = apis.rc5.store;
    const canonicalDigest = apis.rc5.contracts.canonicalDigest ?? ((value) => sha256Hex(JSON.stringify(value)));
    const payload = { process_name: 'same-level-rc5.exe', pid: 5001 };
    const event = {
      schemaVersion: '1.0',
      event_id: uuid(),
      stable_source_id: 'windows.security.4688',
      collector_instance_id: uuid(),
      source_generation: 1,
      boot_id: 'b'.repeat(32),
      source_seq: 501,
      observed_at: '2026-11-01T00:00:00.000Z',
      received_at: '2026-11-01T00:00:01.000Z',
      type: 'process.start',
      severity: 'high',
      payload,
      integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    };
    rc5Same.write = apis.rc5.store.ingestTelemetry(store, { event, now: '2026-11-01T00:00:03.000Z' });
  } finally {
    store.close();
  }
  rc5Same.after = rawFacts(sameLevel);
  raw.sameLevelRc5 = rc5Same;
  check('sameLevel.rc5.opened', true, rc5Same.after.schemaVersion, rc5Same.after.schemaVersion === 5);
  check('sameLevel.rc5.wroteEvent', 4, rc5Same.after.events, rc5Same.after.events === 4);

  const rc6Same = { before: rc5Same.after };
  store = apis.rc6.store.openStore({ path: sameLevel, auditKey });
  try {
    const { uuid, sha256Hex } = apis.rc6.store;
    const canonicalDigest = apis.rc6.contracts.canonicalDigest ?? ((value) => sha256Hex(JSON.stringify(value)));
    const payload = { process_name: 'same-level-rc6.exe', pid: 5002 };
    const event = {
      schemaVersion: '1.0',
      event_id: uuid(),
      stable_source_id: 'windows.security.4688',
      collector_instance_id: uuid(),
      source_generation: 1,
      boot_id: 'b'.repeat(32),
      source_seq: 502,
      observed_at: '2026-11-01T00:00:00.000Z',
      received_at: '2026-11-01T00:00:01.000Z',
      type: 'process.start',
      severity: 'high',
      payload,
      integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    };
    rc6Same.write = apis.rc6.store.ingestTelemetry(store, { event, now: '2026-11-01T00:00:04.000Z' });
  } finally {
    store.close();
  }
  rc6Same.after = rawFacts(sameLevel);
  raw.sameLevelRc6 = rc6Same;
  check('sameLevel.rc6.opened', true, rc6Same.after.schemaVersion, rc6Same.after.schemaVersion === 5);
  check('sameLevel.rc6.wroteEvent', 5, rc6Same.after.events, rc6Same.after.events === 5);

  // ---------------------------------------------------------------- 9. 汇总
  const failing = checks.filter((entry) => entry.pass !== true);
  const result = {
    probe: 'p1-downgrade/schema-too-new',
    startedAt: raw.startedAt,
    finishedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    workRoot,
    delivered: Object.fromEntries(Object.entries(DELIVERED).map(([key, meta]) => [key, {
      label: meta.label, zipName: meta.zipName, setupName: meta.setupName, payloadDirName: meta.payloadDirName,
    }])),
    raw,
    checks,
    totals: { checks: checks.length, pass: checks.length - failing.length, fail: failing.length },
  };

  if (outPath !== null) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    log(`[probe] wrote ${outPath}`);
  }
  log(`[probe] totals: ${result.totals.checks} checks / ${result.totals.pass} pass / ${result.totals.fail} fail`);
  if (failing.length > 0) {
    for (const entry of failing) log(`[probe] FAILED ${entry.id}`);
    process.exitCode = 1;
  }
  return result;
}

await run();
