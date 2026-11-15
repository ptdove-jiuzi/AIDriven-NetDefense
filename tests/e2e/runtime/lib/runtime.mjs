/**
 * runtime.mjs — shared plumbing for the UI2 runtime acceptance scripts (author PT-dove).
 *
 * Scope: `tests/e2e/runtime/**` only. This module deliberately does not import from
 * apps/**; it starts those programs as child processes the same way an operator would.
 *
 * What lives here:
 *   - paths (repo root, QA data root, evidence dir, state file) and JSON helpers;
 *   - a bounded HTTP GET that never follows redirects and always reports bytes/status;
 *   - Windows process introspection (port -> pid, pid -> command line) so that
 *     "idempotent" means *proven* reuse, not "I assumed it was already running";
 *   - token file reading that never logs the token.
 *
 * Windows process notes: there is no portable port->pid API in Node, so `netstat -ano`
 * is used for the port map and one `Get-CimInstance Win32_Process` call for command
 * lines. Both are read-only; this module never kills anything (stop-stack.mjs does that,
 * under its own guards).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `tests/e2e/runtime/lib/runtime.mjs` -> repo root. */
export const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = resolve(HERE, '..');
export const REPO_ROOT = resolve(RUNTIME_DIR, '..', '..', '..');

/** Canonical QA data root handed down by the Lead (see status/UI2-INTEGRATION.md). */
export const DEFAULT_QA_ROOT = process.env.AIDN_QA_ROOT || 'qa-int';

/** Evidence root for this task's write domain. */
export const EVIDENCE_ROOT = join(REPO_ROOT, 'docs', 'implementation', 'evidence', 'ui2', 'runtime');

/** Runtime state (owned PIDs, log paths) — not evidence, and safe to delete. */
export const STATE_DIR = join(RUNTIME_DIR, '.state');
export const STATE_FILE = join(STATE_DIR, 'stack-state.json');

/**
 * State file for one QA root. Isolated cold-start roots must not overwrite the canonical
 * root's ownership record, otherwise stop-stack could target the wrong processes.
 */
export function stateFileFor(qaRoot) {
  const key = sha256(String(qaRoot).toLowerCase()).slice(0, 12);
  return join(STATE_DIR, `stack-state-${key}.json`);
}

/** Canonical ports. Only the Lead / this integrator may (re)start the stacks. */
export const CANONICAL = Object.freeze({
  data: { daemonPort: 17511, hostPort: 17512 },
  mock: { daemonPort: 17521, hostPort: 17522 },
});

export const NODE_VERSION = process.version;
export const NODE_EXE = process.execPath;

/** The 72h soak run that must never be touched (ACTIVE-NOTICE N-002). */
export const PROTECTED_PIDS = Object.freeze([21980]);

/** Command lines that mean "long-running evidence producer, hands off". */
export const PROTECTED_CMDLINE = /longrun\.mjs|_soak-run|_soak-freeze|soak72|tests[\\/]soak/iu;

const PS_EXE = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Resolve a possibly-relative path against the repo root. */
export function fromRepo(candidate) {
  return candidate === undefined || candidate === null ? null : resolve(REPO_ROOT, candidate);
}

/** Make a repo-relative display path, so evidence never depends on the checkout location. */
export function displayPath(absolute) {
  if (typeof absolute !== 'string' || absolute === '') return null;
  const rel = relative(REPO_ROOT, absolute);
  return rel === '' ? '.' : rel.startsWith('..') ? absolute : rel.split(sep).join('/');
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Parse `--flag value` / `--bool` arguments.
 *
 * @param {string[]} argv
 * @param {Record<string, string|number|boolean|null>} defaults
 * @param {Set<string>} booleanFlags flags that take no value
 */
export function parseArgs(argv, defaults = {}, booleanFlags = new Set()) {
  const args = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    const name = flag.slice(2);
    if (booleanFlags.has(name)) {
      args[name] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
      continue;
    }
    index += 1;
    args[name] = next;
  }
  return args;
}

/** Split `a,b,c` into trimmed non-empty strings. */
export function splitList(value) {
  if (typeof value !== 'string' || value === '') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * Bounded HTTP GET. Never follows redirects (a 3xx is a finding, not a detour).
 *
 * @returns {Promise<{ok:boolean,status:number|null,bytes:number,headers:Record<string,string>,
 *   text:string|null,json:any,error:string|null,elapsedMs:number}>}
 */
export async function httpGet(url, { headers = {}, timeoutMs = 5000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const responseHeaders = {};
    for (const [key, value] of response.headers) responseHeaders[key.toLowerCase()] = value;
    return {
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      bytes: Buffer.byteLength(text, 'utf8'),
      headers: responseHeaders,
      text,
      json,
      error: null,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      bytes: 0,
      headers: {},
      text: null,
      json: null,
      error: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error),
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a token file the way the console host does; never returns an empty string silently. */
export function readTokenFile(path) {
  if (typeof path !== 'string' || !existsSync(path)) return { token: null, error: 'TOKEN_FILE_MISSING', path };
  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') return { token: null, error: 'TOKEN_FILE_EMPTY', path };
  return { token: raw, error: null, path };
}

/** Run a PowerShell script through the v1.0 host, base64-encoded to dodge quoting. */
function runPowerShell(script, timeoutMs = 20_000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Command lines + creation times for the given PIDs.
 *
 * @param {number[]} pids
 * @returns {Map<number, {pid:number, commandLine:string|null, createdAt:string|null, name:string|null}>}
 */
export function describeProcesses(pids) {
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  const result = new Map();
  if (wanted.length === 0) return result;
  const filter = wanted.map((pid) => `ProcessId=${pid}`).join(' OR ');
  const script = [
    `$rows = @(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId, Name, CommandLine, CreationDate)`,
    'if ($rows.Count -eq 0) { "[]" } else { ConvertTo-Json -InputObject $rows -Compress -Depth 3 }',
  ].join('\n');
  const run = runPowerShell(script);
  if (run.status !== 0 || typeof run.stdout !== 'string' || run.stdout.trim() === '') {
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(run.stdout.trim());
  } catch {
    return result;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    if (!Number.isFinite(pid)) continue;
    result.set(pid, {
      pid,
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : null,
      createdAt: typeof row.CreationDate === 'string' ? row.CreationDate : null,
      name: typeof row.Name === 'string' ? row.Name : null,
    });
  }
  return result;
}

/**
 * pid -> listening TCP port map from `netstat -ano`.
 *
 * @returns {Map<number, number[]>}
 */
export function listeningPortsByPid() {
  const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const map = new Map();
  if (out.status !== 0 || typeof out.stdout !== 'string') return map;
  for (const line of out.stdout.split(/\r?\n/u)) {
    const match = /^\s*TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$/iu.exec(line);
    if (match === null) continue;
    const local = match[1];
    const colon = local.lastIndexOf(':');
    const port = Number(local.slice(colon + 1));
    const pid = Number(match[3]);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    const ports = map.get(pid) ?? [];
    ports.push(port);
    map.set(pid, ports);
  }
  return map;
}

/** Port -> listening pid (or null). */
export function findListeningPid(port) {
  for (const [pid, ports] of listeningPortsByPid()) {
    if (ports.includes(Number(port))) return pid;
  }
  return null;
}

/** Everything we know about whoever currently listens on `port`. */
export function describePort(port) {
  const pid = findListeningPid(port);
  if (pid === null) return { port: Number(port), pid: null, commandLine: null, createdAt: null, name: null };
  const info = describeProcesses([pid]).get(pid) ?? { pid, commandLine: null, createdAt: null, name: null };
  return { port: Number(port), ...info };
}

/** True when the process exists (command line lookup succeeded). */
export function isAlive(pid) {
  return describeProcesses([pid]).has(pid);
}

/**
 * Redact secrets from an arbitrary JSON value before it becomes evidence.
 *
 * Two jobs, both required by the task: (a) no token / csrf / key material may be
 * written, (b) structure (names, types, counts) must survive so the evidence still
 * proves the endpoint is real.
 */
export function redact(value, { keyHint = '', depth = 0 } = {}) {
  const SECRET_KEY = /(?:token|csrf|secret|api[-_]?key|apikey|authorization|password|cookie|bearer)/iu;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    // Redaction is by *key name*, not by looking at the value: a field literally named
    // csrf_token/token/secret is masked no matter what it holds, while identifiers such as
    // `diagnostics.rotateToken` stay visible because they are evidence, not credentials.
    // The live token string is additionally scrubbed by the caller's leak guard.
    if (SECRET_KEY.test(keyHint)) return `<redacted:${value.length}>`;
    if (value.length > 240) return `${value.slice(0, 240)}…<truncated:${value.length}>`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 8) return '<depth-limit>';
  if (Array.isArray(value)) {
    // Primitive lists (key names, ids) are structure and are kept; object arrays are capped.
    const isPrimitiveList = value.every((item) => item === null || typeof item !== 'object');
    const cap = isPrimitiveList ? 40 : 3;
    const head = value.slice(0, cap).map((item) => redact(item, { keyHint, depth: depth + 1 }));
    return value.length > head.length ? [...head, `<truncated:${value.length - head.length} more>`] : head;
  }
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = redact(child, { keyHint: key, depth: depth + 1 });
  }
  return out;
}

/** Replace every occurrence of a live secret inside a string. */
export function scrubString(text, secrets) {
  if (typeof text !== 'string') return text;
  let output = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) output = output.split(secret).join('<redacted>');
  }
  return output;
}

/** Sorted Object.keys() — stable evidence shape. */
export function keysOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

/**
 * Fingerprint of the front-end build that a run actually exercised.
 *
 * The console lives in `apps/console-next` and is served from disk on every request
 * (`cache-control: no-store`), and other agents are actively editing it. A pass/fail table
 * is only interpretable if it is pinned to the exact bytes that were on disk, so every
 * acceptance receipt carries this: file count + one aggregate sha256 over
 * "relative/path:fileSha256" lines.
 *
 * @param {string} consoleRoot e.g. `<repo>/apps/console-next`
 * @param {{extensions?: string[]}} [options]
 */
export function computeBuildFingerprint(consoleRoot, options = {}) {
  const extensions = options.extensions ?? ['.html', '.js', '.mjs', '.css', '.svg', '.json'];
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!extensions.includes(extname(entry.name).toLowerCase())) continue;
      files.push(absolute);
    }
  };
  walk(consoleRoot);
  files.sort((left, right) => left.localeCompare(right));
  const rows = [];
  let totalBytes = 0;
  for (const file of files) {
    let bytes = Buffer.alloc(0);
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    totalBytes += bytes.length;
    rows.push(`${relative(consoleRoot, file).split(sep).join('/')}:${sha256(bytes)}`);
  }
  return {
    root: displayPath(consoleRoot),
    fileCount: rows.length,
    totalBytes,
    sha256: sha256(rows.join('\n')),
    computedAt: nowIso(),
  };
}

export function formatTable(rows, columns) {
  const widths = columns.map((column) => Math.max(
    column.header.length,
    ...rows.map((row) => String(row[column.key] ?? '').length),
  ));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  return [
    line(columns.map((column) => column.header)),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => row[column.key] ?? ''))),
  ].join('\n');
}
