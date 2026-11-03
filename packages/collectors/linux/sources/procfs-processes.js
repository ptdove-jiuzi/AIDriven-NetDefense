/**
 * Process table source (§5.1 "进程": procfs scan, 5 s).
 *
 * Why procfs and not `ps`: `ps` collapses the fields we need into formatted text and adds
 * its own permission behaviour. Reading `/proc/<pid>/{stat,status,cmdline,exe}` gives the
 * parent pid, the boot-relative start time and the raw argv without parsing a table.
 *
 * Identity: `pid + starttime` (jiffies since boot, field 22 of `/proc/<pid>/stat`). A
 * recycled pid therefore becomes a different entity instead of a silently mutated one.
 * When a boot id is supplied it is folded into the entity id, because `starttime` restarts
 * from zero after a reboot and `pid 1 + starttime 0` would otherwise collide across boots.
 *
 * Permission model (this source never requires root):
 * - `stat`, `status` and `comm` are readable for every visible pid → `completeness: always`.
 * - `cmdline` and `exe` of *other users'* processes are readable only as root, or when
 *   `hidepid=0/1` plus matching ownership → `completeness: admin`.
 * - With `hidepid=2` the other users' `/proc/<pid>` directories are not even listed, so the
 *   table is structurally incomplete. That is reported as `partial` (some denied) or
 *   `denied` (nothing visible) — never as a healthy table with fewer rows.
 */

import {
  DEFAULT_MAX_ENTITIES,
  buildSnapshotRecord,
  createSnapshotDiffer,
  shortHash,
  stateDigest,
} from '../diff.js';
import {
  LINUX_ERROR_CODES,
  LinuxCollectorError,
  assertPositiveInteger,
} from '../errors.js';
import { assertSourceDescriptor } from './descriptor.js';
import { normalizePayload } from '../payload.js';

export const PROCESS_SOURCE_ID = 'linux.procfs-processes';
export const PROCESS_INTERVAL_MS = 5_000;
export const DEFAULT_PROC_ROOT = '/proc';
export const CLOCK_TICKS_PER_SECOND = 100;

export const PROCESS_FIELDS = Object.freeze([
  { name: 'pid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'ppid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'state', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'uid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'gid', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'threads', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'start_ticks', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'start_time', type: 'string', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'exe_path', type: 'string', completeness: 'admin', sensitivity: 'D2' },
  { name: 'cmdline', type: 'string', completeness: 'admin', sensitivity: 'D2' },
]);

export const PROCESS_DESCRIPTOR = assertSourceDescriptor({
  stableSourceId: PROCESS_SOURCE_ID,
  kind: 'poll',
  intervalMs: PROCESS_INTERVAL_MS,
  requiresRoot: false,
  emits: ['linux.process'],
  declaredPaths: [`${DEFAULT_PROC_ROOT}/*/stat`, `${DEFAULT_PROC_ROOT}/*/status`, `${DEFAULT_PROC_ROOT}/stat`],
  permissions: {
    required: [`read+execute on ${DEFAULT_PROC_ROOT} (always granted to any local user)`],
    optional: [
      'root (or matching uid) for /proc/<pid>/cmdline and /proc/<pid>/exe of other users',
      '/proc mounted with hidepid=0 or hidepid=1, otherwise other users processes are not listed',
    ],
    degradedWithout: ['exe_path', 'cmdline'],
  },
  fields: PROCESS_FIELDS,
  blindSpots: [
    'A process that starts and exits between two polls (shorter than 5 s) is never observed; PID 1 and the poll itself are the only guaranteed rows',
    'With hidepid=2 the /proc/<pid> directories of other users are absent from readdir, so they cannot even be counted as restricted',
    'Kernel threads are included (they are regular /proc entries) but have no cmdline content',
    'startTime is derived from /proc/stat btime plus starttime/CLK_TCK and assumes CLK_TCK=100; it is declared best_effort, startTicks is authoritative',
  ],
  rotation: 'none: the process table is a point-in-time snapshot; identity is pid plus starttime, so pid reuse yields a new entity and a reboot is distinguished by the boot tag when one is supplied',
  gapSemantics: [
    'poll: a fully denied read advances nothing and produces no records; the source becomes unavailable instead of reporting an empty-but-healthy table',
    'poll: a denied /proc/<pid>/stat or /proc/<pid>/status publishes the visible processes, keeps the source degraded, and suppresses the removals of the pids that became invisible',
    'poll: a denied cmdline/exe is a field gap (fieldGaps [cmdline, exe_path]), not a degraded read, because that is the documented non-root state on any host',
    'poll: an empty table while the directory read succeeded is treated as denied, because a real Linux system always has at least one process',
    'poll: two consecutive successful reads with identical content produce no records at all; a quiet interval is not a gap',
  ],
  degradation: {
    onDenied: 'status=denied, permissions.missing names /proc, nothing is published and the cursor does not advance',
    onPartial: 'status=partial when a process entry itself was unreadable; visible processes are published and the source stays degraded until a fully readable read succeeds',
    onEmptyTable: 'status=denied with an explicit "no visible process entries" reason, never status=ok with zero records',
    neverHealthyWhenEmpty: true,
  },
  emittedGapReasons: ['permission_denied', 'io_error'],
});

/** Parse `/proc/<pid>/stat` without being confused by spaces or `)` inside `comm`. */
export function parseProcStat(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, 'proc stat content is empty');
  }
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.PARSE_FAILED,
      'proc stat is missing the (comm) field',
      { length: text.length },
    );
  }
  const pid = Number.parseInt(text.slice(0, open).trim(), 10);
  if (!Number.isSafeInteger(pid) || pid < 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.PARSE_FAILED, 'proc stat has a non-numeric pid');
  }
  const comm = text.slice(open + 1, close);
  const rest = text.slice(close + 2).trim().split(/\s+/);
  // rest[0] is field 3 (state); field N maps to rest[N - 3].
  const field = (index) => rest[index - 3];
  const toInt = (value) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  return Object.freeze({
    pid,
    comm,
    state: field(3) ?? null,
    ppid: toInt(field(4)),
    threads: toInt(field(20)),
    startTicks: toInt(field(22)),
    rssPages: toInt(field(24)),
  });
}

/** Parse the few `/proc/<pid>/status` fields that carry identity and ownership. */
export function parseProcStatus(text) {
  const result = { name: null, uid: null, gid: null, threads: null, vmRssKb: null };
  if (typeof text !== 'string') {
    return Object.freeze(result);
  }
  for (const line of text.split('\n')) {
    const index = line.indexOf(':');
    if (index < 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === 'Name') {
      result.name = value;
    } else if (key === 'Uid') {
      const effective = value.split(/\s+/)[1] ?? value.split(/\s+/)[0];
      result.uid = Number.parseInt(effective ?? '', 10);
      if (!Number.isSafeInteger(result.uid)) {
        result.uid = null;
      }
    } else if (key === 'Gid') {
      const effective = value.split(/\s+/)[1] ?? value.split(/\s+/)[0];
      result.gid = Number.parseInt(effective ?? '', 10);
      if (!Number.isSafeInteger(result.gid)) {
        result.gid = null;
      }
    } else if (key === 'Threads') {
      const parsed = Number.parseInt(value, 10);
      result.threads = Number.isSafeInteger(parsed) ? parsed : null;
    } else if (key === 'VmRSS') {
      const parsed = Number.parseInt(value, 10);
      result.vmRssKb = Number.isSafeInteger(parsed) ? parsed : null;
    }
  }
  return Object.freeze(result);
}

/** `/proc/<pid>/cmdline` is NUL-separated argv with a trailing NUL. */
export function parseCmdline(buffer) {
  const text = typeof buffer === 'string' ? buffer : '';
  const trimmed = text.replace(/\0+$/, '');
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.split('\0').join(' ');
}

/** `btime` from `/proc/stat`, in epoch seconds. */
export function parseBtime(text) {
  if (typeof text !== 'string') {
    return null;
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('btime ')) {
      const parsed = Number.parseInt(line.slice(6).trim(), 10);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
  }
  return null;
}

export function isNumericName(name) {
  return /^\d+$/.test(name);
}

function bootTagOf(bootId) {
  if (typeof bootId !== 'string' || bootId.length === 0) {
    return 'noboot';
  }
  return shortHash(bootId, 8);
}

export function createProcfsProcessSource({
  fileSystem,
  clock = Date.now,
  intervalMs = PROCESS_INTERVAL_MS,
  procRoot = DEFAULT_PROC_ROOT,
  maxEntities = DEFAULT_MAX_ENTITIES,
  bootId = null,
  maxCmdlineChars = 2048,
} = {}) {
  if (!fileSystem || typeof fileSystem.readDir !== 'function' || typeof fileSystem.stat !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a file system exposing stat/readDir/readText is required',
    );
  }
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('maxEntities', maxEntities);
  assertPositiveInteger('maxCmdlineChars', maxCmdlineChars);

  const differ = createSnapshotDiffer({ maxEntities });
  const bootTag = bootTagOf(bootId);
  const descriptor = Object.freeze({ ...PROCESS_DESCRIPTOR, intervalMs });

  async function readOne(pid, denials, fieldDenials) {
    const dir = `${procRoot}/${pid}`;
    const statResult = await fileSystem.stat(`${dir}/stat`);
    if (!statResult.ok) {
      if (statResult.outcome === 'not_found' || statResult.outcome === 'not_directory') {
        // The process exited between readdir and stat: normal churn, not a gap.
        return null;
      }
      denials.push({ path: `${dir}/stat`, code: statResult.code, outcome: statResult.outcome });
      return null;
    }

    const statText = await fileSystem.readText(`${dir}/stat`, { maxBytes: 4096 });
    if (!statText.ok) {
      denials.push({ path: `${dir}/stat`, code: statText.code, outcome: statText.outcome });
      return null;
    }
    let parsed;
    try {
      parsed = parseProcStat(statText.text);
    } catch {
      // A malformed row is not a permission problem; skip it and let the read succeed.
      return null;
    }

    // Two separate flags on purpose: `fieldRestricted` means an `admin` field (cmdline/exe)
    // was unavailable, which is the documented non-root state; `statusDenied` means the
    // `always` fields (uid/gid/threads) were lost, which is a structural denial.
    let fieldRestricted = false;
    let statusDenied = false;

    let uid = null;
    let gid = null;
    let statusName = null;
    let statusThreads = null;
    const statusResult = await fileSystem.readText(`${dir}/status`, { maxBytes: 8192 });
    if (statusResult.ok) {
      const status = parseProcStatus(statusResult.text);
      uid = status.uid;
      gid = status.gid;
      statusName = status.name;
      statusThreads = status.threads;
    } else if (statusResult.outcome === 'permission_denied') {
      statusDenied = true;
      denials.push({ path: `${dir}/status`, code: statusResult.code, outcome: statusResult.outcome });
    }

    let cmdline = null;
    let exePath = null;
    const cmdResult = await fileSystem.readText(`${dir}/cmdline`, { maxBytes: maxCmdlineChars * 4 });
    if (cmdResult.ok) {
      cmdline = parseCmdline(cmdResult.text);
      if (cmdline !== null && cmdline.length > maxCmdlineChars) {
        cmdline = cmdline.slice(0, maxCmdlineChars);
      }
    } else if (cmdResult.outcome === 'permission_denied') {
      fieldRestricted = true;
      fieldDenials.push({ path: `${dir}/cmdline`, code: cmdResult.code, field: 'cmdline' });
    }

    const exeResult = await fileSystem.readLink(`${dir}/exe`);
    if (exeResult.ok) {
      exePath = exeResult.target.endsWith(' (deleted)')
        ? exeResult.target.slice(0, -' (deleted)'.length)
        : exeResult.target;
    } else if (exeResult.outcome === 'permission_denied') {
      fieldRestricted = true;
      fieldDenials.push({ path: `${dir}/exe`, code: exeResult.code, field: 'exe_path' });
    }

    const startTicks = parsed.startTicks;
    if (startTicks === null) {
      return null;
    }
    const name = (statusName ?? parsed.comm ?? '').slice(0, 64);
    const digest = stateDigest({
      ppid: parsed.ppid,
      name,
      state: parsed.state,
      uid,
      gid,
      exePath,
      cmdline,
    });

    return {
      entityId: `${bootTag}-${pid}-${startTicks}`,
      digest,
      restricted: fieldRestricted || statusDenied,
      fieldRestricted,
      payload: {
        pid,
        ppid: parsed.ppid,
        name,
        state: parsed.state,
        uid,
        gid,
        threads: parsed.threads ?? statusThreads,
        start_ticks: startTicks,
        exe_path: exePath,
        cmdline,
        restricted: fieldRestricted || statusDenied,
        field_restricted: fieldRestricted,
        status_denied: statusDenied,
      },
    };
  }

  return Object.freeze({
    descriptor,

    async read() {
      const observedAt = clock();
      const listing = await fileSystem.readDir(procRoot, { maxEntries: 262_144 });
      if (!listing.ok) {
        return Object.freeze({
          status: listing.outcome === 'permission_denied' ? 'denied' : 'error',
          errorCode: listing.code,
          records: [],
          denials: [{ path: procRoot, code: listing.code, outcome: listing.outcome }],
          permissions: {
            granted: [],
            missing: listing.outcome === 'permission_denied' ? [procRoot] : [],
          },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: false,
          error: { code: listing.code, message: `cannot list ${procRoot}` },
        });
      }

      const pidNames = listing.entries
        .filter((entry) => entry.kind === 'directory' && isNumericName(entry.name))
        .map((entry) => Number.parseInt(entry.name, 10))
        .filter((pid) => Number.isSafeInteger(pid))
        .sort((left, right) => left - right);

      if (pidNames.length === 0) {
        return Object.freeze({
          status: 'denied',
          errorCode: 'EMPTY_PROC_TABLE',
          records: [],
          denials: [{ path: procRoot, code: 'EACCES_HIDDEN', outcome: 'permission_denied' }],
          permissions: {
            granted: [],
            missing: [`${procRoot}: no visible process entries (likely hidepid=2 or a restricted namespace)`],
          },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: false,
          error: {
            code: 'EMPTY_PROC_TABLE',
            message: 'the process table listed zero entries, which cannot be a healthy Linux system',
          },
        });
      }

      const bootTimeResult = await fileSystem.readText(`${procRoot}/stat`, { maxBytes: 65_536 });
      const bootSeconds = bootTimeResult.ok ? parseBtime(bootTimeResult.text) : null;

      const denials = [];
      const fieldDenials = [];
      const items = [];
      let restrictedCount = 0;
      for (const pid of pidNames) {
        const item = await readOne(pid, denials, fieldDenials);
        if (item === null) {
          continue;
        }
        if (item.fieldRestricted) {
          restrictedCount += 1;
        }
        // startTime is derived, so it must not influence the digest: a different btime
        // reading would otherwise look like a state change on every process.
        item.payload.start_time = bootSeconds === null
          ? null
          : new Date(bootSeconds * 1000 + item.payload.start_ticks * (1000 / CLOCK_TICKS_PER_SECOND)).toISOString();
        items.push({
          entityId: item.entityId,
          digest: item.digest,
          payload: item.payload,
        });
      }

      // Only a pid whose own /proc/<pid>/{stat,status} was denied is indistinguishable from
      // a pid that exited; suppressing a removal for any other process would itself be a lie.
      const deniedPids = new Set();
      for (const denial of denials) {
        // A denial on /proc/<pid>/stat or /proc/<pid>/status is the only case where the pid
        // itself is invisible; a denied cmdline still leaves a perfectly visible process.
        const match = /(\d+)\/(?:stat|status)$/.exec(denial.path);
        if (match !== null) {
          deniedPids.add(Number.parseInt(match[1], 10));
        }
      }
      // `>` matches diff()'s own truncation test: exactly at the cap nothing was cut, so the
      // table is complete and removals are trustworthy.
      const entityCapReached = items.length > maxEntities;
      const diff = differ.diff(items, {
        suppressRemovalsFor: (entry) => entityCapReached || deniedPids.has(entry.item.payload.pid),
      });
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: 'linux.process',
          entityId: entry.entityId,
          digest: entry.digest,
          observedAt,
          change: entry.kind === 'snapshot' ? 'snapshot' : entry.kind,
          payload: normalizePayload(entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true }).payload,
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      // `denied` means "we produced nothing and we know why". Removals are already
      // suppressed above, so an empty item list can no longer be dressed up as output.
      let status = 'ok';
      if (denials.length > 0) {
        status = items.length === 0 ? 'denied' : 'partial';
      }

      return Object.freeze({
        status,
        records,
        denials,
        permissions: {
          granted: [procRoot],
          missing: status === 'denied'
            ? [`${procRoot}: every process entry was unreadable`]
            : [],
        },
        restrictedCount,
        fieldGaps: restrictedCount > 0 ? Object.freeze(['cmdline', 'exe_path']) : Object.freeze([]),
        fieldDenials: Object.freeze(fieldDenials.slice(0, 32)),
        suppressedRemovals: diff.suppressedRemovals,
        nextCursor: null,
        identity: { fileId: PROCESS_SOURCE_ID, size: items.length },
        snapshot: diff.snapshot,
        truncated: diff.truncated,
        observedAt,
        error: null,
      });
    },
  });
}
