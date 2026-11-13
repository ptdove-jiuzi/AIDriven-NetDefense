// open-store.mjs — does the restored data still open, and is its audit chain intact?
//
// D3 restores `data\` into a freshly installed tree; the sentence users care about is not
// "the files are there" but "the database opens and the audit chain still verifies".
// Uses the repo's own event-store so the check is the product's own code, not a re-implementation.

// Author: PT-dove

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const url = (relative) => new URL(`file:///${REPO_ROOT.replace(/\\/g, '/')}/${relative}`).href;

const { openStore } = await import(url('packages/event-store/src/index.js'));
const { verifyAuditChainInStore } = await import(url('packages/event-store/src/audit.js'));

const argv = process.argv.slice(2);
const read = (flag, fallback) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
};
const dbPath = read('--db');
// The seed used this key; a chain signed with a different key cannot be attested, which is
// itself a result worth seeing rather than an error to swallow.
const auditKey = read('--audit-key', 'powercut-seed-audit-key-0123456789abcdef');
if (!dbPath) throw new Error('--db is required');

const report = { dbPath, opened: false };
let store = null;
try {
  store = openStore({ path: dbPath, auditKey, readOnly: true });
  report.opened = true;
  const counts = store.get(
    `SELECT
       (SELECT COUNT(*) FROM telemetry_event) AS events,
       (SELECT COUNT(*) FROM alert) AS alerts,
       (SELECT COUNT(*) FROM audit_event) AS audit`,
  );
  report.counts = { ...counts };
  try {
    const chain = verifyAuditChainInStore(store);
    report.auditChain = { ok: true, ...chain };
  } catch (error) {
    report.auditChain = { ok: false, error: String(error && error.message ? error.message : error) };
  }
} catch (error) {
  report.error = String(error && error.message ? error.message : error);
} finally {
  try {
    if (store && typeof store.close === 'function') store.close();
  } catch {
    /* closing is best effort */
  }
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
