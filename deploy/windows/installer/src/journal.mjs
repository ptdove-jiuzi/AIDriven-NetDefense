/**
 * journal.mjs — the write-ahead log that makes recovery a state machine instead of
 * a guess (ADR-0009 §6.1 / §6.2).
 *
 * The rule that everything else depends on: **the phase is flushed before the action
 * it describes is attempted**. So after any crash the journal can only be *behind*
 * the disk, never ahead of it. Recovery then reads "disk facts + journal intent" and
 * converges; it never trusts the journal alone.
 *
 * Three fields are load-bearing for recovery (`manifestRelPath`,
 * `fromManifestDigest`, `toManifestDigest`): without them nothing can answer "is this
 * `app\` the new version or the old one". If any of them is missing the journal is
 * declared corrupt and the installer drops into read-only diagnosis — it does not
 * guess, and it does not auto-roll-back.
 */

import { randomUUID } from 'node:crypto';

import { pathExists, readJson, writeJsonAtomic } from './fsx.mjs';

/**
 * Every phase in §6.2, including the uninstall branches. Kept in one frozen object so
 * a typo becomes a thrown error rather than a phase nobody handles.
 */
export const PHASES = Object.freeze({
  IDLE: 'IDLE',
  STAGED: 'STAGED',
  SERVICE_STOPPING: 'SERVICE_STOPPING',
  SWAP_A: 'SWAP_A',
  SWAP_B: 'SWAP_B',
  MIGRATING: 'MIGRATING',
  MIGRATED: 'MIGRATED',
  VERIFYING: 'VERIFYING',
  COMMITTED: 'COMMITTED',
  ROLLING_BACK: 'ROLLING_BACK',
  ROLLED_BACK: 'ROLLED_BACK',
  UNINSTALLING: 'UNINSTALLING',
  UNINSTALLED: 'UNINSTALLED',
  PURGING: 'PURGING',
});

const PHASE_SET = new Set(Object.values(PHASES));

/** Phases from which a new transaction may start without recovery first. */
export const TERMINAL_PHASES = Object.freeze(new Set([
  PHASES.IDLE,
  PHASES.COMMITTED,
  PHASES.ROLLED_BACK,
  PHASES.UNINSTALLED,
]));

const OPS = new Set(['install', 'upgrade', 'rollback', 'uninstall', 'purge', 'repair', 'verify']);

/**
 * Keys recovery cannot work without. `fromManifestDigest` is allowed to be `null`
 * (a fresh install has no previous manifest) but the **key must exist** — an absent
 * key is indistinguishable from "the writer never got that far".
 */
const REQUIRED_KEYS = Object.freeze([
  'txid',
  'op',
  'phase',
  'paths',
  'manifestRelPath',
  'toManifestDigest',
  'fromManifestDigest',
]);

export const MANIFEST_REL_PATH = 'manifests/files.sha256';

export class Journal {
  constructor(path, data) {
    this.path = path;
    this.data = data;
  }

  get phase() {
    return this.data.phase;
  }

  get txid() {
    return this.data.txid;
  }

  isTerminal() {
    return TERMINAL_PHASES.has(this.data.phase);
  }

  /** Flush a new phase, then the caller performs the action it names. */
  enter(phase, detail = null) {
    if (!PHASE_SET.has(phase)) {
      throw new Error(`unknown journal phase: ${String(phase)}`);
    }
    this.data.phase = phase;
    this.data.updatedAt = new Date().toISOString();
    this.data.steps.push({ phase, at: this.data.updatedAt, ok: null, detail });
    this.persist();
    return this;
  }

  /** Record the outcome of the phase the caller just attempted. */
  settle(ok, detail = null) {
    const last = this.data.steps[this.data.steps.length - 1];
    if (last !== undefined && last.ok === null) {
      last.ok = ok;
      last.at = new Date().toISOString();
      if (detail !== null) last.detail = detail;
    } else {
      this.data.steps.push({
        phase: this.data.phase,
        at: new Date().toISOString(),
        ok,
        detail,
      });
    }
    this.data.updatedAt = new Date().toISOString();
    this.persist();
    return this;
  }

  /** Patch top-level fields (db schema versions, digests) before the next flush. */
  patch(fields) {
    Object.assign(this.data, fields);
    this.data.updatedAt = new Date().toISOString();
    return this;
  }

  persist() {
    writeJsonAtomic(this.path, this.data);
    return this;
  }
}

/**
 * Start a new transaction.
 *
 * @param {{ path: string, op: string, fromVersion?: string|null, toVersion?: string|null,
 *   paths: Record<string, string|null>, fromManifestDigest?: string|null,
 *   toManifestDigest?: string|null, dbSchemaBefore?: number|null, dbSchemaAfter?: number|null }} input
 */
export function beginJournal({
  path,
  op,
  fromVersion = null,
  toVersion = null,
  paths,
  fromManifestDigest = null,
  toManifestDigest = null,
  dbSchemaBefore = null,
  dbSchemaAfter = null,
}) {
  const now = new Date().toISOString();
  const data = {
    txid: randomUUID(),
    op,
    fromVersion,
    toVersion,
    phase: PHASES.IDLE,
    paths,
    manifestRelPath: MANIFEST_REL_PATH,
    fromManifestDigest,
    toManifestDigest,
    dbSchemaBefore,
    dbSchemaAfter,
    startedAt: now,
    updatedAt: now,
    steps: [],
  };
  const journal = new Journal(path, data);
  journal.persist();
  return journal;
}

/**
 * Read the journal and decide whether it can be trusted.
 *
 * @param {string} path Journal path.
 * @returns {{state: 'absent'} | {state: 'ok', journal: Journal} | {state: 'corrupt', reasons: string[], journal: Journal|null}}
 */
export function loadJournal(path) {
  if (!pathExists(path)) {
    return { state: 'absent' };
  }
  let data;
  try {
    data = readJson(path);
  } catch (error) {
    return { state: 'corrupt', reasons: [`journal.json 不是合法 JSON：${error.message}`], journal: null };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { state: 'corrupt', reasons: ['journal.json 顶层不是对象'], journal: null };
  }

  const reasons = [];
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      reasons.push(`缺少必需字段 ${key}`);
    }
  }
  if (typeof data.phase !== 'string' || !PHASE_SET.has(data.phase)) {
    reasons.push(`phase 非法：${String(data.phase)}`);
  }
  if (typeof data.op === 'string' && !OPS.has(data.op)) {
    reasons.push(`op 非法：${data.op}`);
  }
  if (data.paths === null || typeof data.paths !== 'object' || Array.isArray(data.paths)) {
    reasons.push('paths 不是对象');
  }
  if (reasons.length > 0) {
    return { state: 'corrupt', reasons, journal: null };
  }
  return { state: 'ok', journal: new Journal(path, data) };
}

/** Read-only diagnosis text for a corrupt journal, per §6.1 / R6. */
export function diagnosisReport(layout, loaded) {
  const lines = [
    `journal: ${layout.journalPath}`,
    `phase: ${loaded.state === 'ok' ? loaded.journal.phase : '(不可读)'}`,
    ...loaded.reasons.map((reason) => `原因: ${reason}`),
  ];
  return lines.join('\n');
}
