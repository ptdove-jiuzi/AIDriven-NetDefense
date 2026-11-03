/**
 * cron / at persistence source (§5.1 "任务/启动持久化": declared paths, 60 s).
 *
 * Why "declared paths" and not a full persistence sweep: the design explicitly limits this
 * source to the paths it declares, so it can never claim coverage of every persistence
 * technique. System-wide crontabs, `/etc/cron.d`, user spool files and the
 * `cron.{hourly,daily,weekly,monthly}` script directories are enumerated; `systemd` timers
 * belong to the unit source, and shell rc files / profile.d are out of scope.
 *
 * Two record kinds, on purpose:
 * - `linux.cron.file` — one per declared file, always emitted, including `readable: false`.
 *   This is what keeps a permission-denied spool file from looking like "nothing declared".
 * - `linux.cron.entry` — one per parsed schedule line, only when the file is readable.
 *
 * The spool directories are `0700`/`0600 root` on every distribution, so a non-root
 * collector *will* be denied there. That is reported, not hidden: the file record says
 * `readable: false` and the read result carries the path in `denials`.
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

export const CRON_SOURCE_ID = 'linux.cron';
export const CRON_INTERVAL_MS = 60_000;

/** Files with the standard `/etc/crontab` layout (five fields + user + command). */
export const CRON_FILES = Object.freeze(['/etc/crontab', '/etc/anacrontab']);

/** Directories whose entries are crontab files. */
export const CRON_TAB_DIRS = Object.freeze(['/etc/cron.d', '/var/spool/cron', '/var/spool/cron/crontabs']);

/** Directories whose entries are executables run by cron, metadata only. */
export const CRON_SCRIPT_DIRS = Object.freeze([
  '/etc/cron.hourly',
  '/etc/cron.daily',
  '/etc/cron.weekly',
  '/etc/cron.monthly',
]);

export const CRON_SPECIALS = Object.freeze([
  '@reboot',
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]);

export const CRON_FIELDS = Object.freeze([
  { name: 'path', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'kind', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'readable', type: 'boolean', completeness: 'always', sensitivity: 'D1' },
  { name: 'entry_count', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'schedule', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'user', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'command', type: 'string', completeness: 'best_effort', sensitivity: 'D3' },
  { name: 'line_number', type: 'integer', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'size', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'mtime', type: 'string', completeness: 'always', sensitivity: 'D1' },
]);

export const CRON_DESCRIPTOR = assertSourceDescriptor({
  stableSourceId: CRON_SOURCE_ID,
  kind: 'poll',
  intervalMs: CRON_INTERVAL_MS,
  requiresRoot: false,
  emits: ['linux.cron.file', 'linux.cron.entry'],
  declaredPaths: [...CRON_FILES, ...CRON_TAB_DIRS, ...CRON_SCRIPT_DIRS],
  permissions: {
    required: ['read access to /etc/crontab and /etc/cron.d (world readable on a default install)'],
    optional: [
      'root for /var/spool/cron and /var/spool/cron/crontabs, which are 0700/0600 root by design',
      'root to read another user spool file content; without it only the file metadata is known',
    ],
    degradedWithout: ['spool crontab content', 'entry-level records for the spool directories'],
  },
  fields: CRON_FIELDS,
  blindSpots: [
    'Spool crontabs are 0600 root: without root only their metadata is visible, never their schedules',
    'A user crontab edited through `crontab -e` is a rewritten file, so an edit may appear as a full added/removed pair instead of a changed entry',
    'crond reloads on mtime change; a schedule that is present but not loaded (crond not running) is still reported as declared',
    'at jobs (the at spool) and systemd timers are other mechanisms and are not covered here',
    'A pattern that hides content (for example an unusual ACL) degrades the entry records but keeps the file record',
  ],
  rotation: 'none: crontab files are replaced or rewritten in place; a rewrite is detected as changed entry content or as an added/removed pair, and a deleted file is a removed file record',
  gapSemantics: [
    'poll: an unreadable declared file is published as a file record with readable=false and is named in denials; it is never silently absent',
    'poll: a missing declared path is normal on a distribution without it and is not a gap',
    'poll: the read is bounded by maxFiles and maxEntries; exceeding either marks the read partial instead of dropping data silently',
  ],
  degradation: {
    onDenied: 'status=denied only when no declared path can be stat-ed at all; otherwise the readable subset is published as partial',
    onPartial: 'status=partial when any declared file is unreadable or the file/entry caps were hit',
    onEmptyTable: 'zero declared files is an error (EMPTY_CRON_TABLE), because /etc/crontab exists on every cron installation; a host without cron is reported, not assumed empty',
    neverHealthyWhenEmpty: true,
  },
  emittedGapReasons: ['permission_denied', 'io_error'],
});

/**
 * Parse a crontab body. `hasUserField` is true for `/etc/crontab` and `/etc/cron.d/*`
 * (system crontabs carry a user column), false for user spool crontabs.
 */
export function parseCrontab(text, { hasUserField = true, maxCommandChars = 1024 } = {}) {
  const entries = [];
  const malformed = [];
  if (typeof text !== 'string') {
    return Object.freeze({ entries: Object.freeze(entries), malformed: Object.freeze(malformed), variables: 0 });
  }
  let variables = 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    // Environment assignment: `SHELL=/bin/sh`, `MAILTO=""`.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(trimmed)) {
      variables += 1;
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    // A special schedule starts with `@`; the separator after it may be a tab, not a space.
    if (tokens[0].startsWith('@')) {
      if (!CRON_SPECIALS.includes(tokens[0])) {
        malformed.push({ lineNumber: index + 1, reason: `unknown special ${tokens[0]}` });
        continue;
      }
      const rest = tokens.slice(1);
      if (rest.length === 0) {
        malformed.push({ lineNumber: index + 1, reason: 'missing command' });
        continue;
      }
      const user = hasUserField && rest.length > 1 ? rest[0] : null;
      const command = (user === null ? rest : rest.slice(1)).join(' ');
      entries.push(Object.freeze({
        schedule: tokens[0],
        special: true,
        user,
        command: command.slice(0, maxCommandChars),
        commandTruncated: command.length > maxCommandChars,
        lineNumber: index + 1,
      }));
      continue;
    }

    const fields = tokens;
    const minimum = hasUserField ? 7 : 6;
    if (fields.length < minimum) {
      malformed.push({ lineNumber: index + 1, reason: 'too few fields' });
      continue;
    }
    const schedule = fields.slice(0, 5).join(' ');
    const user = hasUserField ? fields[5] : null;
    const command = (hasUserField ? fields.slice(6) : fields.slice(5)).join(' ');
    entries.push(Object.freeze({
      schedule,
      special: false,
      user,
      command: command.slice(0, maxCommandChars),
      commandTruncated: command.length > maxCommandChars,
      lineNumber: index + 1,
    }));
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    malformed: Object.freeze(malformed),
    variables,
  });
}

export function createCronSource({
  fileSystem,
  clock = Date.now,
  files = CRON_FILES,
  tabDirs = CRON_TAB_DIRS,
  scriptDirs = CRON_SCRIPT_DIRS,
  intervalMs = CRON_INTERVAL_MS,
  maxFiles = 512,
  maxEntries = 10_000,
  maxFileBytes = 256 * 1024,
  stableSourceId = CRON_SOURCE_ID,
} = {}) {
  if (!fileSystem || typeof fileSystem.stat !== 'function' || typeof fileSystem.readDir !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a file system exposing stat/readDir/readText is required',
    );
  }
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('maxFiles', maxFiles);
  assertPositiveInteger('maxEntries', maxEntries);
  assertPositiveInteger('maxFileBytes', maxFileBytes);

  const differ = createSnapshotDiffer({ maxEntities: DEFAULT_MAX_ENTITIES });
  const declared = [...files, ...tabDirs, ...scriptDirs];
  const descriptor = assertSourceDescriptor({
    ...CRON_DESCRIPTOR,
    stableSourceId,
    declaredPaths: declared,
  });

  function fileRecord({ path, kind, stat, readable, parsed, errorCode }) {
    const entryDigest = parsed === undefined || parsed === null
      ? null
      : parsed.entries.map((entry) => `${entry.schedule}|${entry.user ?? ''}|${entry.command}`);
    return {
      entityId: `cronf-${shortHash(path, 20)}`,
      digest: stateDigest({
        kind,
        readable,
        size: stat === null ? null : stat.size,
        mtimeMs: stat === null ? null : stat.mtimeMs,
        dev: stat === null ? null : stat.dev,
        ino: stat === null ? null : stat.ino,
        entryDigest,
        errorCode: errorCode ?? null,
      }),
      payload: normalizePayload({
        path,
        kind,
        readable,
        entry_count: parsed === undefined || parsed === null ? 0 : parsed.entries.length,
        malformed_count: parsed === undefined || parsed === null ? 0 : parsed.malformed.length,
        variables: parsed === undefined || parsed === null ? 0 : parsed.variables,
        size: stat === null ? null : stat.size,
        mode: stat === null ? null : stat.mode,
        uid: stat === null ? null : stat.uid,
        gid: stat === null ? null : stat.gid,
        inode: stat === null ? null : stat.ino,
        dev: stat === null ? null : stat.dev,
        mtime: stat === null || stat.mtimeMs === 0 ? null : new Date(stat.mtimeMs).toISOString(),
        error_code: errorCode ?? null,
      }).payload,
    };
  }

  return Object.freeze({
    descriptor,

    async read() {
      const observedAt = clock();
      const denials = [];
      const items = [];
      let fileCount = 0;
      let entryCount = 0;
      let malformedTotal = 0;
      let capped = false;

      async function ingestFile({ path, kind, hasUserField }) {
        if (fileCount >= maxFiles) {
          capped = true;
          return;
        }
        fileCount += 1;
        const stat = await fileSystem.stat(path);
        if (!stat.ok) {
          if (stat.outcome === 'permission_denied') {
            denials.push({ path, code: stat.code, outcome: stat.outcome });
            items.push(fileRecord({ path, kind, stat: null, readable: false, errorCode: stat.code }));
          }
          // A missing declared path is normal; it is not declared content and not a gap.
          return;
        }
        const content = await fileSystem.readText(path, { maxBytes: maxFileBytes });
        if (!content.ok) {
          const denied = content.outcome === 'permission_denied';
          if (denied) {
            denials.push({ path, code: content.code, outcome: content.outcome });
          }
          items.push(fileRecord({
            path,
            kind,
            stat,
            readable: false,
            errorCode: content.code,
          }));
          return;
        }
        const parsed = parseCrontab(content.text, { hasUserField });
        malformedTotal += parsed.malformed.length;
        items.push(fileRecord({ path, kind, stat, readable: true, parsed }));

        for (const entry of parsed.entries) {
          if (entryCount >= maxEntries) {
            capped = true;
            break;
          }
          entryCount += 1;
          const key = `${path}\u0000${entry.schedule}\u0000${entry.user ?? ''}\u0000${entry.command}`;
          items.push({
            entityId: `crone-${shortHash(key, 20)}`,
            digest: stateDigest({ schedule: entry.schedule, user: entry.user, command: entry.command }),
            payload: normalizePayload({
              path,
              kind: 'entry',
              readable: true,
              schedule: entry.schedule,
              special: entry.special,
              user: entry.user,
              command: entry.command,
              command_truncated: entry.commandTruncated,
              line_number: entry.lineNumber,
            }).payload,
          });
        }
      }

      for (const path of files) {
        await ingestFile({ path, kind: 'system-crontab', hasUserField: true });
      }

      for (const dir of tabDirs) {
        const listing = await fileSystem.readDir(dir, { maxEntries: maxFiles });
        if (!listing.ok) {
          if (listing.outcome === 'permission_denied') {
            denials.push({ path: dir, code: listing.code, outcome: listing.outcome });
            items.push(fileRecord({
              path: dir,
              kind: 'tab-directory',
              stat: null,
              readable: false,
              errorCode: listing.code,
            }));
          }
          continue;
        }
        if (listing.truncated) {
          capped = true;
        }
        // Emit the directory row on the success path too: otherwise the "declared but
        // unreadable" row emitted on denial would look like a removal on recovery.
        const dirStat = await fileSystem.stat(dir);
        items.push(fileRecord({
          path: dir,
          kind: 'tab-directory',
          stat: dirStat.ok ? dirStat : null,
          readable: true,
          parsed: null,
        }));
        for (const entry of listing.entries) {
          if (entry.kind !== 'file' && entry.kind !== 'symlink') {
            continue;
          }
          await ingestFile({ path: `${dir}/${entry.name}`, kind: 'crontab-file', hasUserField: true });
        }
      }

      for (const dir of scriptDirs) {
        const listing = await fileSystem.readDir(dir, { maxEntries: maxFiles });
        if (!listing.ok) {
          if (listing.outcome === 'permission_denied') {
            denials.push({ path: dir, code: listing.code, outcome: listing.outcome });
          }
          continue;
        }
        for (const entry of listing.entries) {
          if (entry.kind !== 'file' && entry.kind !== 'symlink') {
            continue;
          }
          if (fileCount >= maxFiles) {
            capped = true;
            break;
          }
          fileCount += 1;
          const path = `${dir}/${entry.name}`;
          const stat = await fileSystem.stat(path);
          if (!stat.ok) {
            continue;
          }
          // Script directories hold executables: declared metadata only, never content.
          items.push({
            entityId: `cronx-${shortHash(path, 20)}`,
            digest: stateDigest({
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              mode: stat.mode,
              dev: stat.dev,
              ino: stat.ino,
            }),
            payload: normalizePayload({
              path,
              kind: 'script',
              readable: true,
              executable: (stat.mode & 0o111) !== 0,
              size: stat.size,
              mode: stat.mode,
              uid: stat.uid,
              gid: stat.gid,
              inode: stat.ino,
              dev: stat.dev,
              mtime: new Date(stat.mtimeMs).toISOString(),
            }).payload,
          });
        }
      }

      if (items.length === 0 && denials.length === 0) {
        return Object.freeze({
          status: 'error',
          errorCode: 'EMPTY_CRON_TABLE',
          records: [],
          denials: [],
          permissions: { granted: [], missing: [] },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: false,
          observedAt,
          error: {
            code: 'EMPTY_CRON_TABLE',
            message: 'none of the declared cron paths exist, which cannot be a host with cron installed',
          },
        });
      }

      // Suppression is scoped to the paths we could not read: a cron entry under a denied
      // spool directory may still exist, but an entry under a readable file that really lost
      // its line must still be reported as removed. A capped scan is global evidence loss,
      // so it suppresses every removal.
      const deniedPaths = denials.map((denial) => denial.path);
      const diff = differ.diff(items, {
        suppressRemovalsFor: (entry) => {
          if (capped) {
            return true;
          }
          const path = entry.item.payload.path;
          return typeof path === 'string'
            && deniedPaths.some((denied) => path === denied || path.startsWith(`${denied}/`));
        },
      });
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: entry.item.payload.kind === 'entry' ? 'linux.cron.entry' : 'linux.cron.file',
          entityId: entry.entityId,
          digest: entry.digest,
          observedAt,
          change: entry.kind === 'snapshot' ? 'snapshot' : entry.kind,
          payload: normalizePayload(entry.kind === 'removed'
            ? { ...entry.item.payload, present: false }
            : { ...entry.item.payload, present: true }).payload,
        }))
        .sort((left, right) => (left.nativeRecordId < right.nativeRecordId ? -1 : 1));

      let status = 'ok';
      if (denials.length > 0 || malformedTotal > 0 || capped || diff.truncated) {
        status = items.length === 0 ? 'denied' : 'partial';
      }
      const missing = status === 'denied'
        ? denials.map((denial) => denial.path)
        : [];

      return Object.freeze({
        status,
        records,
        denials,
        permissions: { granted: [], missing },
        suppressedRemovals: diff.suppressedRemovals,
        nextCursor: null,
        identity: { fileId: stableSourceId, size: items.length },
        snapshot: diff.snapshot,
        truncated: diff.truncated || capped,
        observedAt,
        stats: Object.freeze({
          files: fileCount,
          entries: entryCount,
          malformed: malformedTotal,
          capped,
        }),
        error: null,
      });
    },
  });
}
