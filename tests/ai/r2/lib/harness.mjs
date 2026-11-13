/**
 * harness.mjs — P1-CLOSER round-2 · T2（agent-approval-r2）共享夹具。
 *
 * 只做三件事：起"真 daemon API + 真审批注册表 + 本席位测试替身 host"这套栈、读盘取证、
 * 提供一个可被 probe 与 node:test 共用的确定性观察面。**不写产品目录**。
 *
 * @author PT-dove
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEST_TOKEN,
  chatReadySettings,
  createCaptureLogger,
  openRawSse,
  parseSseText,
  sessionIdFor,
  startConsoleApi,
} from '../../../wp5-daemon/console-fixtures.mjs';

/** Repository root (this file is `tests/ai/r2/lib/`). */
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** This seat's evidence root (round-2 only). */
export const EVIDENCE_DIR = join(REPO, 'evidence', 'p1-close-2', 'agent');
/** Raw logs / JSON of this seat. */
export const RAW_DIR = join(EVIDENCE_DIR, 'raw');
/** The stub host that makes `tool` frames reachable (see its header for the caveat). */
export const STUB_HOST = fileURLToPath(new URL('../stub-approval-host.mjs', import.meta.url));
/** `%TEMP%\p1-close-2\agent` — the canary directory the Agent is told to write into. */
export const CANARY_DIR = join(process.env.TEMP ?? tmpdir(), 'p1-close-2', 'agent');
/** Wall-clock stamp used in canary names. */
export const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');

/** @returns {Promise<void>} Resolves after `ms`. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Count non-overlapping occurrences of a literal.
 *
 * @param {string} text Haystack.
 * @param {string} needle Literal needle.
 * @returns {number} Occurrences.
 */
export function countOf(text, needle) {
  return String(text).split(needle).length - 1;
}

/**
 * `tool` events of a buffered SSE text.
 *
 * @param {string} text Raw SSE text.
 * @returns {{state: string, reason: string|null, callId: string|null, requiresApproval?: boolean, arguments?: object}[]} Tool events.
 */
export function toolEvents(text) {
  return parseSseText(text)
    .events
    .filter((event) => event.event === 'tool')
    .map((event) => ({
      state: event.data.state,
      reason: event.data.reason ?? null,
      callId: event.data.callId ?? null,
      requiresApproval: event.data.requiresApproval,
      arguments: event.data.arguments,
    }));
}

/**
 * SHA-256 of a file.
 *
 * @param {string} filePath Path.
 * @returns {string} Lowercase hex digest.
 */
export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Walk a directory and return every regular file path (depth-limited, never throws).
 *
 * @param {string} root Directory.
 * @param {number} [depth] Current depth.
 * @param {string[]} [output] Accumulator.
 * @returns {string[]} File paths.
 */
export function walkFiles(root, depth = 0, output = []) {
  if (depth > 4) {
    return output;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, depth + 1, output);
    } else if (entry.isFile()) {
      output.push(full);
    }
  }
  return output;
}

/**
 * Search every file under `dataDir` for a literal — the "is there a persistent record?" probe.
 *
 * @param {string} dataDir Data directory of the harness.
 * @param {string} needle Literal (here: the callId).
 * @returns {{filesScanned: number, hits: string[], auditLogExists: boolean, auditLogPath: string}} Result.
 */
export function findPersistentRecords(dataDir, needle) {
  const files = walkFiles(dataDir);
  const hits = [];
  for (const file of files) {
    try {
      if (statSync(file).size > 1_000_000) {
        continue;
      }
      if (readFileSync(file, 'utf8').includes(needle)) {
        hits.push(file.slice(dataDir.length + 1));
      }
    } catch {
      // unreadable file: cannot be a record
    }
  }
  const auditLogPath = join(dataDir, 'console', 'audit.log');
  return { filesScanned: files.length, hits, auditLogExists: existsSync(auditLogPath), auditLogPath };
}

/**
 * Start the real console API stack against the round-2 approval stub host.
 *
 * The returned `close()` also removes the canary file; callers must always close.
 *
 * @param {{
 *   label: string,
 *   mode?: 'tool'|'tool-dup'|'tool-noapproval'|'tool-done',
 *   approvalTimeoutMs?: number,
 *   callId?: string,
 *   canaryPath?: string,
 *   settings?: object
 * }} options Options.
 * @returns {Promise<{
 *   harness: object, capture: object, canary: string, sessionId: string,
 *   spawnLog: string, close: () => Promise<void>
 * }>} Fixture.
 */
export async function startToolHarness(options) {
  const callId = options.callId ?? 'call_r2_1';
  const canary = options.canaryPath ?? join(CANARY_DIR, `canary-${options.label}-${process.pid}-${Date.now()}.txt`);
  rmSync(canary, { force: true });
  const spawnLog = join(process.env.TEMP ?? tmpdir(), 'p1-close-2', 'agent', `spawn-${options.label}-${Date.now()}.log`);
  mkdirSync(join(process.env.TEMP ?? tmpdir(), 'p1-close-2', 'agent'), { recursive: true });
  const capture = createCaptureLogger();
  const harness = await startConsoleApi({
    settings: options.settings ?? chatReadySettings(1),
    hostPath: STUB_HOST,
    childEnv: {
      R2_STUB_MODE: options.mode ?? 'tool',
      R2_CALL_ID: callId,
      R2_CANARY_PATH: canary,
      R2_SPAWN_LOG: spawnLog,
    },
    approvalTimeoutMs: options.approvalTimeoutMs,
    logger: capture.logger,
    sseOptions: { idleMs: 60_000, totalMs: 60_000, heartbeatMs: 30_000 },
  });
  return {
    harness,
    capture,
    canary,
    sessionId: sessionIdFor(`r2-${options.label}`),
    spawnLog,
    close: async () => {
      try {
        await harness.close();
      } finally {
        rmSync(canary, { force: true });
        rmSync(spawnLog, { force: true });
      }
    },
  };
}

/**
 * Open the chat SSE and wait until the stub's `tool proposed` frame reached the client.
 *
 * @param {object} harness Console harness.
 * @param {string} sessionId Session id.
 * @param {number} [timeoutMs] Budget.
 * @returns {Promise<object>} Raw stream handle (`.chunks()`, `.onData()`, `.request`).
 */
export async function openProposalStream(harness, sessionId, timeoutMs = 10_000) {
  const stream = await openRawSse(
    harness.address.port,
    '/api/v1/agent/chat',
    {
      sessionId,
      modelId: 'local-chat',
      messages: [{ role: 'user', content: 'write the canary file' }],
    },
    { token: TEST_TOKEN, csrf: harness.csrfToken },
  );
  await stream.onData((text) => text.includes('"state":"proposed"'), timeoutMs);
  return stream;
}

/**
 * Deterministic registry-level observation: register a proposal, cancel the session, capture the
 * `tool` frame the registry emits. Used to make "denied/STREAM_CLOSED" **observable** instead of
 * merely inferred from `size() === 0`.
 *
 * @param {(options: object) => object} createApprovalRegistry Registry factory (real product export).
 * @returns {object} Observation.
 */
export function observeCancelSession(createApprovalRegistry) {
  const sent = [];
  const channel = { send: (event, payload) => sent.push({ event, payload }) };
  const sessionA = `s_${'a'.repeat(32)}`;
  const sessionB = `s_${'b'.repeat(32)}`;
  const registry = createApprovalRegistry({ timeoutMs: 60_000 });
  try {
    const registeredA = registry.register({ callId: 'call_r2_cancel_a', sessionId: sessionA, channel });
    const registeredB = registry.register({ callId: 'call_r2_cancel_b', sessionId: sessionB, channel });
    const cancelled = registry.cancelSession(sessionA);
    const afterFirst = registry.size();
    const secondCancel = registry.cancelSession(sessionA);
    const toolSends = sent.filter((entry) => entry.event === 'tool');
    return {
      registeredA,
      registeredB,
      cancelled,
      secondCancel,
      sizeAfterCancel: afterFirst,
      sizeAfterSecondCancel: registry.size(),
      toolFrames: toolSends.map((entry) => entry.payload),
      deniedFrame: toolSends.length === 1 ? toolSends[0].payload : null,
    };
  } finally {
    registry.close();
  }
}

export { TEST_TOKEN, chatReadySettings, createCaptureLogger, parseSseText, sessionIdFor, startConsoleApi };

/**
 * Positive control for the canary channel: make sure the canary directory exists and that a file
 * written into it **is** observed. Without this, "canary absent" would be vacuously true when the
 * directory simply does not exist (0.0.1 has no executor, so nothing ever writes there).
 *
 * @returns {{dir: string, dirExistedBefore: boolean, controlDetected: boolean, controlRemoved: boolean}} Control row.
 */
export function ensureCanaryDir() {
  const dirExistedBefore = existsSync(CANARY_DIR);
  mkdirSync(CANARY_DIR, { recursive: true });
  const control = join(CANARY_DIR, `canary-control-${process.pid}-${Date.now()}.txt`);
  let controlDetected = false;
  let controlRemoved = false;
  try {
    writeFileSync(control, 'P1-CLOSE-2-CANARY-POSITIVE-CONTROL\n', 'utf8');
    controlDetected = existsSync(control);
  } finally {
    rmSync(control, { force: true });
    controlRemoved = !existsSync(control);
  }
  return { dir: CANARY_DIR, dirExistedBefore, controlDetected, controlRemoved };
}
