/**
 * seed-data.mjs — build a *real* product data tree for the round-5 power-cut experiment.
 *
 * Round-5 powercut seat (POST-SHIP-PATH / powercut-r5). Same idea as
 * evidence/upgrade/r4/tools/seed-data.mjs (round-4), kept inside this seat's own directory
 * so the evidence can be replayed from one place.
 *
 * Why not `python -c "sqlite3.connect(...)"`: the claim under test is "an interrupted
 * upgrade does not damage the user's data". A hand-made two-column SQLite file proves
 * nothing about the product's own store (WAL mode, schema, canonical digests, audit
 * chain). This opens the repository's own `packages/event-store` and ingests real
 * telemetry through the same `ingestTelemetry` transaction the daemon uses.
 *
 * Layout produced under <data-dir>:
 *   data/store/aegis.db              real SQLite (WAL) with N telemetry events
 *   data/shell/settings.json         product-shaped settings
 *   data/secrets/api-token           64 hex chars
 *   data/rules/builtin-rules.json    small rule pack
 *   data/notes/升级前说明.txt         human sentinel (UTF-8, Chinese)
 *   data/SENTINEL-旧数据.txt          human sentinel (must survive byte-identically)
 *
 * Usage: node seed-data.mjs --data-dir <path> [--events 200] [--sentinel "..."]
 * Prints one JSON line.
 *
 * Author: PT-dove
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

const { openStore, ingestTelemetry } = await import(
  new URL(`file:///${REPO_ROOT.replace(/\\/g, '/')}/packages/event-store/src/index.js`).href
);
const { canonicalDigest } = await import(
  new URL(`file:///${REPO_ROOT.replace(/\\/g, '/')}/packages/event-store/src/util.js`).href
);

function parseArgs(argv) {
  const out = { dataDir: null, events: 200, sentinel: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--data-dir') out.dataDir = argv[++index];
    else if (item === '--events') out.events = Number(argv[++index]);
    else if (item === '--sentinel') out.sentinel = argv[++index];
    else throw new Error(`unknown argument: ${item}`);
  }
  if (!out.dataDir) throw new Error('--data-dir is required');
  if (!Number.isInteger(out.events) || out.events < 1) throw new Error('--events must be a positive integer');
  return out;
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

function uuidFrom(number, salt) {
  const hex = createHash('sha256').update(`${salt}:${number}`).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `8${hex.slice(17, 20)}`, hex.slice(20, 32)].join('-');
}

/** One telemetry event in the shape `@aegisharness/contracts` validates. */
function makeEvent(sequence, baseMs, salt) {
  const observedAt = new Date(baseMs + sequence * 1000).toISOString();
  const payload = {
    process_name: `sentinel-${sequence % 7}.exe`,
    pid: 4000 + sequence,
    command_line: `seeded-event-${sequence}`,
  };
  return {
    schemaVersion: '1.0',
    event_id: uuidFrom(sequence, salt),
    stable_source_id: 'windows.security.4688',
    collector_instance_id: uuidFrom(1, `inst:${salt}`),
    source_generation: 1,
    boot_id: 'a'.repeat(32),
    source_seq: sequence,
    observed_at: observedAt,
    received_at: observedAt,
    type: 'process.start',
    severity: sequence % 11 === 0 ? 'high' : 'low',
    payload,
    integrity: { algorithm: 'sha256', digest: canonicalDigest(payload) },
    native_record_id: `nr-${salt}-${sequence}`,
  };
}

const args = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(args.dataDir);
const storeDir = path.join(dataDir, 'store');
mkdirSync(storeDir, { recursive: true });

const storePath = path.join(storeDir, 'aegis.db');
const salt = sha256Hex(Buffer.from(dataDir, 'utf8')).slice(0, 16);
const baseMs = Date.parse('2026-11-06T09:00:00.000Z');

const store = openStore({ path: storePath, auditKey: 'powercut-seed-audit-key-0123456789abcdef' });
let ingested = 0;
try {
  for (let sequence = 1; sequence <= args.events; sequence += 1) {
    const event = makeEvent(sequence, baseMs, salt);
    ingestTelemetry(store, { event, allowedSummaryFields: [], now: event.received_at });
    ingested += 1;
  }
} finally {
  store.close();
}

// Compare-and-verify: a seed that silently ingested nothing would make "fingerprint
// unchanged" a meaningless claim.
const reader = openStore({ path: storePath, readOnly: true });
let eventCount = 0;
try {
  eventCount = Number(reader.get('SELECT COUNT(*) AS c FROM telemetry_event').c);
} finally {
  reader.close();
}

mkdirSync(path.join(dataDir, 'shell'), { recursive: true });
mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
mkdirSync(path.join(dataDir, 'rules'), { recursive: true });
mkdirSync(path.join(dataDir, 'notes'), { recursive: true });

writeFileSync(
  path.join(dataDir, 'shell', 'settings.json'),
  `${JSON.stringify(
    {
      schemaVersion: '1.0',
      seededBy: 'tests/installer/powercut/tools/seed-data.mjs',
      theme: 'dark',
      language: 'zh-CN',
      seededAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

writeFileSync(path.join(dataDir, 'secrets', 'api-token'), `${sha256Hex(Buffer.from(`token:${salt}`, 'utf8'))}\n`, 'utf8');

writeFileSync(
  path.join(dataDir, 'rules', 'builtin-rules.json'),
  `${JSON.stringify(
    {
      schemaVersion: '1.0',
      rules: [
        { id: 'seed-0001', name: '种子规则：可疑进程名', severity: 'high', enabled: true },
        { id: 'seed-0002', name: '种子规则：异常父进程', severity: 'medium', enabled: true },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const sentinel = args.sentinel ?? '断电实验哨兵：升级中断后这行必须原样还在。';
writeFileSync(
  path.join(dataDir, 'SENTINEL-旧数据.txt'),
  `${sentinel}\nseed-salt=${salt}\nseeded-at=${new Date().toISOString()}\n`,
  'utf8',
);
writeFileSync(
  path.join(dataDir, 'notes', '升级前说明.txt'),
  '这是升级前用户自己放进去的文件。\n本文件与 SENTINEL-旧数据.txt 都必须逐字节存活。\n',
  'utf8',
);

console.log(
  JSON.stringify({
    ok: true,
    dataDir,
    storePath,
    ingested,
    eventCount,
    storeBytes: readFileSync(storePath).length,
    repoRoot: REPO_ROOT,
  }),
);
