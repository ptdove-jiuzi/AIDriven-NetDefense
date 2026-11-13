/**
 * P1-CLOSE / T2 (downgrade-verifier) · 探针：**对真实数据目录里的库**回答
 * "旧版（rc.5 出厂载荷）打开 rc.6 留下的库会怎样"。
 *
 * 与 `probe-schema-too-new.mjs` 的区别：那份用合成库证明判据；这份用**真实恢复出来的库**
 * （`<target>\data` 与 `%LOCALAPPDATA%\AIDriven NetDefense\data`）做三件事：
 *   1. rc.5 出厂代码打开真实库：schema 相同 ⇒ 应当**能打开**（真实库不会误触 TOO_NEW）；
 *      读与写在**副本**上做，原库只做只读事实采集 + sha256 前后比对；
 *   2. rc.6 出厂代码对同一份真实副本做对照；
 *   3. 把真实库副本 bump 成 schema+1（模拟"下一代已迁移过的库"）→ rc.5 必须明确拒绝，
 *      且拒绝前后副本字节不变（这一条是"不静默损坏"的真实数据版）。
 *
 * 全程不写原库（只在 work 目录里操作副本）。零外联。
 *
 * 用法：
 *   node tests/installer/p1-downgrade/probe-real-db-schema.mjs `
 *     --data-dir "%TEMP%\upgrade-path\r4\t1\data" `
 *     --out evidence/p1-close/downgrade/real-db/RESULT.json `
 *     --work "%TEMP%\p1-close\downgrade-verifier\real-db"
 *
 * Author: PT-dove
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  captureStoreError,
  extractDeliveredPayload,
  loadDeliveredApi,
  makeFutureSchema,
  rawFacts,
  sha256File,
  sidecarFacts,
} from './delivered-payload.mjs';

const args = { out: null, work: null, dataDir: null, db: null };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--out') args.out = argv[++index];
  else if (argv[index] === '--work') args.work = argv[++index];
  else if (argv[index] === '--data-dir') args.dataDir = argv[++index];
  else if (argv[index] === '--db') args.db = argv[++index];
}
const workRoot = path.resolve(
  args.work ?? path.join(process.env.TEMP ?? REPO_ROOT, 'p1-close', 'downgrade-verifier', 'real-db'),
);
const outPath = args.out === null ? null : path.resolve(args.out);

const checks = [];
function check(id, expected, actual, predicate) {
  const pass = predicate === true;
  checks.push({ id, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} | expected=${JSON.stringify(expected)} | actual=${JSON.stringify(actual)}`);
  return pass;
}
function copyDb(source, target) {
  fs.copyFileSync(source, target);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${source}${suffix}`)) fs.copyFileSync(`${source}${suffix}`, `${target}${suffix}`);
  }
}
function discoverDbFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(db|sqlite|sqlite3)$/iu.test(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

function makeEvent(api, contracts, sourceSeq, label) {
  const payload = { process_name: `${label}.exe`, pid: 6000 + sourceSeq };
  return {
    schemaVersion: '1.0',
    event_id: api.uuid(),
    stable_source_id: 'windows.security.4688',
    collector_instance_id: api.uuid(),
    source_generation: 1,
    boot_id: 'c'.repeat(32),
    source_seq: sourceSeq,
    observed_at: '2026-11-01T00:00:00.000Z',
    received_at: '2026-11-01T00:00:01.000Z',
    type: 'process.start',
    severity: 'high',
    payload,
    integrity: { algorithm: 'sha256', digest: contracts.canonicalDigest(payload) },
  };
}

async function main() {
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.mkdirSync(workRoot, { recursive: true });

  const extracted = {};
  const apis = {};
  for (const key of ['rc5', 'rc6']) {
    extracted[key] = extractDeliveredPayload(key, path.join(workRoot, 'payload', key));
    apis[key] = await loadDeliveredApi(extracted[key]);
  }

  const sources = args.db !== null
    ? [path.resolve(args.db)]
    : discoverDbFiles(args.dataDir === null ? '' : path.resolve(args.dataDir));
  const result = {
    probe: 'p1-downgrade/real-db-schema',
    startedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    dataDir: args.dataDir === null ? null : path.resolve(args.dataDir),
    workRoot,
    delivered: Object.fromEntries(Object.entries(extracted).map(([key, value]) => [key, {
      zip: value.zip, eventStoreIndex: value.eventStoreIndex,
    }])),
    databases: [],
    totals: null,
  };

  if (sources.length === 0) {
    check('sourceDatabasesFound', '>=1 个真实库文件', args.dataDir ?? args.db, false);
  } else {
    check('sourceDatabasesFound', '>=1 个真实库文件', sources.map((file) => path.basename(file)), true);
  }

  for (const [index, source] of sources.entries()) {
    // 纪律：真实数据目录**只读**。连 rawFacts 也不在原库上开连接——只读连接同样可能建出
    // -wal/-shm 记账文件。所有读取都在这份副本上做；原库前后只做 sha256 比对。
    const factsCopy = path.join(workRoot, `real-${index}-facts.db`);
    copyDb(source, factsCopy);
    const entry = {
      source,
      sourceBytes: fs.statSync(source).size,
      sourceSha256: sha256File(source),
      sourceSidecars: sidecarFacts(source),
      facts: rawFacts(factsCopy),
      rc5: {},
      rc6: {},
      future: {},
    };

    // 1. rc.5 只读打开（真实库不该被 TOO_NEW 拦住；在副本上做，不动原库）。
    entry.rc5.readOnly = { error: captureStoreError(() => apis.rc5.store.openStore({ path: factsCopy, readOnly: true })) };
    check(
      `real[${index}].rc5.opensReadOnly`,
      'rc.5 以只读方式打开真实库不报 TOO_NEW',
      entry.rc5.readOnly.error,
      entry.rc5.readOnly.error === null,
    );

    // 2. rc.5 可写打开**副本**并写一条事件（证明不是"能打开但写不进"）。
    //    daemon 打开库时不注入 auditKey（apps/daemon/src/adapters/event-store.js:443）⇒ 真实库是
    //    placeholder 审计模式；探针同样不注入，才是"旧版以同样方式打开"。
    const rc5Copy = path.join(workRoot, `real-${index}-rc5.db`);
    copyDb(source, rc5Copy);
    const rc5Before = rawFacts(rc5Copy);
    entry.rc5.before = rc5Before;
    let rc5Error = null;
    let rc5OpenOk = false;
    let rc5IngestError = null;
    try {
      const store = apis.rc5.store.openStore({ path: rc5Copy });
      rc5OpenOk = true;
      try {
        const ingest = apis.rc5.store.ingestTelemetry(store, {
          event: makeEvent(apis.rc5.store, apis.rc5.contracts, 700, 'real-rc5'),
          now: '2026-11-01T00:00:09.000Z',
        });
        entry.rc5.ingest = { duplicate: ingest.duplicate, eventId: ingest.event?.event_id ?? null };
      } catch (error) {
        rc5IngestError = captureStoreError(() => { throw error; });
      } finally {
        store.close();
      }
    } catch (error) {
      rc5Error = captureStoreError(() => { throw error; });
    }
    entry.rc5.error = rc5Error;
    entry.rc5.openOk = rc5OpenOk;
    entry.rc5.ingestError = rc5IngestError;
    entry.rc5.after = rawFacts(rc5Copy);
    check(
      `real[${index}].rc5.opensSameSchema`,
      'rc.5 出厂载荷能打开真实 rc.6 库（schema 相同，不应报 TOO_NEW）',
      { openOk: rc5OpenOk, error: rc5Error },
      rc5OpenOk === true,
    );
    check(
      `real[${index}].rc5.writesOneEvent`,
      (entry.rc5.before?.events ?? 0) + 1,
      { events: entry.rc5.after.events, ingestError: rc5IngestError },
      rc5IngestError === null && entry.rc5.after.events === (entry.rc5.before?.events ?? 0) + 1,
    );

    // 3. rc.6 对照写副本。
    const rc6Copy = path.join(workRoot, `real-${index}-rc6.db`);
    copyDb(source, rc6Copy);
    const rc6Before = rawFacts(rc6Copy);
    let rc6Error = null;
    let rc6OpenOk = false;
    let rc6IngestError = null;
    try {
      const store = apis.rc6.store.openStore({ path: rc6Copy });
      rc6OpenOk = true;
      try {
        apis.rc6.store.ingestTelemetry(store, {
          event: makeEvent(apis.rc6.store, apis.rc6.contracts, 701, 'real-rc6'),
          now: '2026-11-01T00:00:10.000Z',
        });
      } catch (error) {
        rc6IngestError = captureStoreError(() => { throw error; });
      } finally {
        store.close();
      }
    } catch (error) {
      rc6Error = captureStoreError(() => { throw error; });
    }
    entry.rc6 = { before: rc6Before, error: rc6Error, openOk: rc6OpenOk, ingestError: rc6IngestError, after: rawFacts(rc6Copy) };
    check(
      `real[${index}].rc6.opensSameSchema`,
      'rc.6 出厂载荷能打开真实库',
      { openOk: rc6OpenOk, error: rc6Error },
      rc6OpenOk === true,
    );
    check(`real[${index}].rc6.writesOneEvent`, (rc6Before.events ?? 0) + 1, entry.rc6.after.events, rc6IngestError === null && entry.rc6.after.events === (rc6Before.events ?? 0) + 1);

    // 4. 真实库副本 bump 到 schema+1 → rc.5 必须明确拒绝且不改字节。
    const futureCopy = path.join(workRoot, `real-${index}-future.db`);
    copyDb(source, futureCopy);
    const futureFacts = makeFutureSchema(futureCopy, { nextVersion: 6 });
    const futureBefore = { sha256: sha256File(futureCopy), sidecars: sidecarFacts(futureCopy), facts: futureFacts };
    const futureError = captureStoreError(() => apis.rc5.store.openStore({ path: futureCopy }));
    const futureAfter = { sha256: sha256File(futureCopy), sidecars: sidecarFacts(futureCopy), facts: rawFacts(futureCopy) };
    entry.future = { before: futureBefore, error: futureError, after: futureAfter };
    check(`real[${index}].future.errorCode`, 'ERR_SCHEMA_TOO_NEW', futureError?.code, futureError?.code === 'ERR_SCHEMA_TOO_NEW');
    check(
      `real[${index}].future.errorMessage`,
      'ERR_SCHEMA_TOO_NEW: database schema 6 is newer than this binary (5)',
      futureError?.message,
      futureError?.message === 'ERR_SCHEMA_TOO_NEW: database schema 6 is newer than this binary (5)',
    );
    check(`real[${index}].future.dbBytesUnchanged`, futureBefore.sha256, futureAfter.sha256, futureBefore.sha256 === futureAfter.sha256);
    check(
      `real[${index}].future.semanticsUnchanged`,
      '真实数据行数/迁移记录不变',
      { events: futureAfter.facts.events, migrations: futureAfter.facts.migrations },
      futureAfter.facts.events === futureBefore.facts.events
        && JSON.stringify(futureAfter.facts.migrations) === JSON.stringify(futureBefore.facts.migrations),
    );

    // 原库在整个探针前后必须逐字节不变（我们只动副本）。
    entry.sourceSha256After = sha256File(source);
    check(`real[${index}].sourceUnchanged`, entry.sourceSha256, entry.sourceSha256After, entry.sourceSha256 === entry.sourceSha256After);

    result.databases.push(entry);
  }

  const failing = checks.filter((entry) => entry.pass !== true);
  result.checks = checks;
  result.totals = { checks: checks.length, pass: checks.length - failing.length, fail: failing.length };
  result.finishedAt = new Date().toISOString();

  if (outPath !== null) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`[probe] wrote ${outPath}`);
  }
  console.log(`[probe] totals: ${result.totals.checks} checks / ${result.totals.pass} pass / ${result.totals.fail} fail`);
  if (failing.length > 0) {
    for (const entry of failing) console.log(`[probe] FAILED ${entry.id}`);
    process.exitCode = 1;
  }
}

await main();
