/**
 * P1-CLOSE / T2 (downgrade-verifier) · 给自建的真实 rc.6 安装树 seed 一份"真实形状"的数据。
 *
 * 为什么不是复制一个测试库：B 要回答"旧版打开**用户真实数据**会怎样"，所以库必须是
 * **rc.6 出厂载荷自己的代码**建出来的（不是仓库工作树代码），并且放在安装器约定的
 * `<target>\data\` 里（卸载 `/KEEPDATA` 会保留它）。daemon 打开库时不注入 auditKey
 * （apps/daemon/src/adapters/event-store.js:443）⇒ 这里同样不注入，审计链走 placeholder 模式。
 *
 * 用法：
 *   node tests/installer/p1-downgrade/seed-target-data.mjs `
 *     --target "%TEMP%\p1-close\down\rc6" `
 *     --out evidence/p1-close/downgrade/a0-install-rc6-own-tree/seed-report.json `
 *     --events 40 --work "%TEMP%\p1-close\downgrade-verifier\seed"
 *
 * Author: PT-dove
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  REPO_ROOT,
  extractDeliveredPayload,
  loadDeliveredApi,
  rawFacts,
  sha256File,
} from './delivered-payload.mjs';

const args = { target: null, out: null, work: null, events: 40 };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--target') args.target = argv[++index];
  else if (argv[index] === '--out') args.out = argv[++index];
  else if (argv[index] === '--work') args.work = argv[++index];
  else if (argv[index] === '--events') args.events = Number(argv[++index]);
}
if (args.target === null) throw new Error('--target is required');

const target = path.resolve(args.target);
if (!fs.existsSync(target)) throw new Error(`install tree does not exist: ${target}`);
const workRoot = path.resolve(
  args.work ?? path.join(process.env.TEMP ?? REPO_ROOT, 'p1-close', 'downgrade-verifier', 'seed'),
);
fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });

// rc.6 出厂载荷（v18 字节）——建数据必须用它，不是仓库工作树。
const extracted = extractDeliveredPayload('rc6', path.join(workRoot, 'payload', 'rc6'));
const { store: api, contracts } = await loadDeliveredApi(extracted);

// 产品真实布局（apps/daemon/src/config.js 解析 data/store/aegis.db）：和 T1 的 t1 保持同一形状，
// 这样"data 两通道 sha256 不变"比较的是同一种树。
const dataDir = path.join(target, 'data');
const storeDir = path.join(dataDir, 'store');
fs.mkdirSync(storeDir, { recursive: true });
const dbPath = path.join(storeDir, 'aegis.db');
if (fs.existsSync(dbPath)) throw new Error(`refusing to overwrite existing data db: ${dbPath}`);

const handle = api.openStore({ path: dbPath });
const written = [];
try {
  for (let index = 0; index < args.events; index += 1) {
    const payload = { process_name: `seed-${index}.exe`, pid: 7000 + index };
    const event = {
      schemaVersion: '1.0',
      event_id: api.uuid(),
      stable_source_id: 'windows.security.4688',
      collector_instance_id: api.uuid(),
      source_generation: 1,
      boot_id: 'e'.repeat(32),
      source_seq: 10 + index,
      observed_at: '2026-11-01T00:00:00.000Z',
      received_at: '2026-11-01T00:00:01.000Z',
      type: 'process.start',
      severity: 'high',
      payload,
      integrity: { algorithm: 'sha256', digest: contracts.canonicalDigest(payload) },
    };
    const result = api.ingestTelemetry(handle, { event, now: '2026-11-01T00:00:02.000Z' });
    written.push(result.event?.event_id ?? event.event_id);
  }
} finally {
  handle.close();
}

// daemon 正常关闭后不应留非空 WAL。若 close() 后仍有 0 字节 wal / shm（SQLite 的残留句柄现象），
// 清掉它们，让"种子数据"处于干净的单文件状态——不然后续 sha256 比对会把 WAL 记账误判成数据变化。
// 注意：这里要被调用两次——`rawFacts()` 自己会用只读连接开一次库，而只读连接同样可能把
// -wal/-shm 重新建出来（那不是数据写入）。所以 fact 采集之后再清一次，最后才算 sha256/清单。
function cleanSidecars() {
  const cleaned = [];
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (!fs.existsSync(sidecar)) continue;
    const bytes = fs.statSync(sidecar).size;
    if (suffix === '-shm' || bytes === 0) {
      fs.unlinkSync(sidecar);
      cleaned.push({ suffix, bytes, action: 'removed' });
    } else {
      cleaned.push({ suffix, bytes, action: 'kept-nonempty-wal' });
    }
  }
  return cleaned;
}
const sidecarCleanup = cleanSidecars();
const facts = rawFacts(dbPath);
const sidecarCleanupAfterFacts = cleanSidecars();

// ---- 其余数据树：产品形状的文件 + 人类哨兵（逐字节存活判据）。
const sentinel = '降级验证哨兵：/KEEPDATA 卸载与 rc.5 覆盖安装之后，这些文件必须逐字节不变。';
const salt = sha256File(dbPath).slice(0, 16);
const extraFiles = [];
function writeExtra(relative, content) {
  const full = path.join(dataDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  extraFiles.push({ path: relative.replaceAll('\\', '/'), bytes: Buffer.byteLength(content) });
}
writeExtra('shell/settings.json', `${JSON.stringify({
  schemaVersion: '1.0',
  seededBy: 'tests/installer/p1-downgrade/seed-target-data.mjs (rc.6 delivered payload)',
  theme: 'dark',
  language: 'zh-CN',
  seededAt: new Date().toISOString(),
}, null, 2)}\n`);
writeExtra('secrets/api-token', `${salt}${salt}\n`);
writeExtra('rules/builtin-rules.json', `${JSON.stringify({
  schemaVersion: '1.0',
  rules: [
    { id: 'seed-0001', name: '种子规则：可疑进程名', severity: 'high', enabled: true },
    { id: 'seed-0002', name: '种子规则：异常父进程', severity: 'medium', enabled: true },
  ],
}, null, 2)}\n`);
writeExtra('SENTINEL-旧数据.txt', `${sentinel}\nseed-salt=${salt}\nseeded-at=${new Date().toISOString()}\n`);
writeExtra('notes/升级前说明.txt', '这是"降级验证"之前用户自己放进去的文件。\n本文件与 SENTINEL-旧数据.txt 都必须逐字节存活。\n');

const report = {
  scenario: 'seed-rc6-real-data',
  at: new Date().toISOString(),
  target,
  dataDir,
  dbPath,
  eventsRequested: args.events,
  eventsWritten: written.length,
  payload: { zip: extracted.zip, eventStoreIndex: extracted.eventStoreIndex, filesChecked: extracted.files.length },
  auditKeyMode: 'none (daemon-like placeholder)',
  facts,
  dbSha256: sha256File(dbPath),
  sentinel,
  extraFiles,
  sidecarCleanup,
  sidecarCleanupAfterFacts,
  sidecars: fs.readdirSync(storeDir).filter((name) => /-(wal|shm)$/u.test(name)),
  dataTreeFiles: (() => {
    const rows = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) rows.push({ path: path.relative(dataDir, full).replaceAll('\\', '/'), bytes: fs.statSync(full).size });
      }
    };
    walk(dataDir);
    return rows.sort((left, right) => left.path.localeCompare(right.path));
  })(),
};

if (args.out !== null) {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[seed] wrote ${outPath}`);
}
console.log(JSON.stringify(report, null, 2));
