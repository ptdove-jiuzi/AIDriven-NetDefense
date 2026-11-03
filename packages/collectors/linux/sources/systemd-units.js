/**
 * systemd unit metadata source (§5.1 "服务持久化": unit metadata, 60 s).
 *
 * Why declared directories and not D-Bus: a D-Bus read of `ListUnits` needs a session on the
 * system bus, which a sandboxed collector may not have; the unit files themselves are the
 * declarative source of truth and are world-readable on a default install. The design's
 * Windows counterpart is a read-only SCM enumeration, so this is the matching read-only
 * enumeration — not a supervisor, not a controller.
 *
 * What is recorded and what is not:
 * - always: path, unit name/type, size, mode, mtime, inode, whether the file is a symlink
 *   (masked units are symlinks to `/dev/null`), and whether some `*.wants`/`*.requires`
 *   directory links to it;
 * - only when `includeContent: true`: a small allowlist of unit keys (`Description`,
 *   `ExecStart`, `After`, ...). Reading unit content is opt-in because §5.1 says file
 *   collection records metadata and changes by default, not content.
 *
 * Blind spots are declared rather than papered over: drop-in overrides (`*.service.d/*`),
 * units generated at runtime by generators, transient units (`systemd-run`), and units in
 * other search paths of a custom build are not enumerated.
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

export const SYSTEMD_SOURCE_ID = 'linux.systemd-units';
export const SYSTEMD_INTERVAL_MS = 60_000;

export const SYSTEMD_UNIT_DIRS = Object.freeze([
  '/etc/systemd/system',
  '/run/systemd/system',
  '/usr/lib/systemd/system',
]);

export const UNIT_SUFFIXES = Object.freeze([
  '.service',
  '.socket',
  '.timer',
  '.target',
  '.mount',
  '.automount',
  '.path',
  '.slice',
  '.scope',
  '.device',
  '.swap',
]);

/** Directories that hold enablement symlinks for a unit. */
export const WANT_DIR_PATTERN = /\.(wants|requires|upholds)$/;

/** Keys extracted from a unit file when `includeContent` is enabled. */
export const UNIT_CONTENT_KEYS = Object.freeze([
  'Description',
  'ExecStart',
  'ExecStartPre',
  'ExecStartPost',
  'ExecReload',
  'ExecStop',
  'ExecCondition',
  'After',
  'Before',
  'Requires',
  'Wants',
  'EnvironmentFile',
  'User',
  'Group',
  'Restart',
]);

export const SYSTEMD_FIELDS = Object.freeze([
  { name: 'unit_name', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'unit_type', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'path', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'origin', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'size', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'mode', type: 'integer', completeness: 'always', sensitivity: 'D1' },
  { name: 'mtime', type: 'string', completeness: 'always', sensitivity: 'D1' },
  { name: 'masked', type: 'boolean', completeness: 'always', sensitivity: 'D1' },
  { name: 'enabled', type: 'boolean', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'enabled_by', type: 'array', completeness: 'best_effort', sensitivity: 'D1' },
  { name: 'link_target', type: 'string', completeness: 'best_effort', sensitivity: 'D2' },
  { name: 'content_json', type: 'string', completeness: 'opt_in', sensitivity: 'D2' },
]);

export const SYSTEMD_DESCRIPTOR = assertSourceDescriptor({
  stableSourceId: SYSTEMD_SOURCE_ID,
  kind: 'poll',
  intervalMs: SYSTEMD_INTERVAL_MS,
  requiresRoot: false,
  emits: ['linux.systemd-unit'],
  declaredPaths: [...SYSTEMD_UNIT_DIRS],
  permissions: {
    required: ['read+execute on the declared unit directories (world readable on a default install)'],
    optional: ['root for /etc/systemd/system/*/ with a restrictive mode on hardened systems'],
    degradedWithout: ['unit content (only when includeContent is enabled), masked state for directories we cannot list'],
  },
  fields: SYSTEMD_FIELDS,
  blindSpots: [
    'Drop-in overrides (*.service.d/*.conf) are not enumerated, so an override is invisible to this source',
    'Units created at runtime by systemd generators or systemd-run (transient units) are not on disk and are never seen',
    'Only the three declared search paths are scanned; a custom build with extra paths needs an explicit dirs option',
    'Enablement is inferred from *.wants/*.requires symlinks only; `systemctl enable --now` state and alias symlinks outside those directories are approximations',
    'A unit file edited in place is seen on the next 60 s poll; a start/stop transition between polls is not an event of this source',
  ],
  rotation: 'none: units are ordinary files; a replaced file has the same path and a different dev:ino, which surfaces as a changed state on the next poll',
  gapSemantics: [
    'poll: a unit directory that cannot be listed degrades the source and is named in denials; the other directories are still published',
    'poll: no unit at all across the readable directories is reported as an error, because a systemd host always has units',
    'poll: an unchanged unit produces no record; a quiet interval is not a gap',
  ],
  degradation: {
    onDenied: 'status=denied when no declared unit directory can be listed; nothing is published',
    onPartial: 'status=partial when some directories or some unit files are unreadable; the readable units are still published',
    onEmptyTable: 'zero units on a readable host is an error (EMPTY_UNIT_TABLE), never a healthy empty result',
    neverHealthyWhenEmpty: true,
  },
  emittedGapReasons: ['permission_denied', 'io_error'],
});

function originOf(path) {
  if (path.startsWith('/etc/')) {
    return 'etc';
  }
  if (path.startsWith('/run/')) {
    return 'run';
  }
  if (path.startsWith('/usr/lib/')) {
    return 'vendor';
  }
  return 'other';
}

export function hasUnitSuffix(name) {
  return UNIT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Extract allowlisted keys from a unit file. Values of repeated keys are kept as an array so
 * `ExecStartPre` lines are not collapsed into one.
 */
export function parseUnitContent(text, { maxValueChars = 512 } = {}) {
  const content = {};
  if (typeof text !== 'string') {
    return Object.freeze(content);
  }
  const allowed = new Set(UNIT_CONTENT_KEYS);
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    if (!allowed.has(key)) {
      continue;
    }
    const value = line.slice(index + 1).trim().slice(0, maxValueChars);
    if (content[key] === undefined) {
      content[key] = value;
    } else if (Array.isArray(content[key])) {
      content[key].push(value);
    } else {
      content[key] = [content[key], value];
    }
  }
  return Object.freeze(content);
}

export function createSystemdUnitSource({
  fileSystem,
  clock = Date.now,
  dirs = SYSTEMD_UNIT_DIRS,
  intervalMs = SYSTEMD_INTERVAL_MS,
  maxEntities = DEFAULT_MAX_ENTITIES,
  includeContent = false,
  maxContentBytes = 64 * 1024,
  stableSourceId = SYSTEMD_SOURCE_ID,
} = {}) {
  if (!fileSystem || typeof fileSystem.readDir !== 'function' || typeof fileSystem.stat !== 'function') {
    throw new LinuxCollectorError(
      LINUX_ERROR_CODES.INVALID_ARGUMENT,
      'a file system exposing stat/readDir/readText is required',
    );
  }
  assertPositiveInteger('intervalMs', intervalMs);
  assertPositiveInteger('maxEntities', maxEntities);
  assertPositiveInteger('maxContentBytes', maxContentBytes);
  if (!Array.isArray(dirs) || dirs.length === 0) {
    throw new LinuxCollectorError(LINUX_ERROR_CODES.INVALID_ARGUMENT, 'dirs must be a non-empty array');
  }

  const differ = createSnapshotDiffer({ maxEntities });
  const descriptor = assertSourceDescriptor({
    ...SYSTEMD_DESCRIPTOR,
    stableSourceId,
    declaredPaths: dirs,
    permissions: includeContent
      ? {
        ...SYSTEMD_DESCRIPTOR.permissions,
        required: [...SYSTEMD_DESCRIPTOR.permissions.required, 'read access to the unit files themselves (content mode)'],
      }
      : SYSTEMD_DESCRIPTOR.permissions,
  });

  return Object.freeze({
    descriptor,

    async read() {
      const observedAt = clock();
      const denials = [];
      const enablement = new Map();
      const unitEntries = [];
      let readableDirs = 0;
      let truncatedDirs = 0;

      for (const dir of dirs) {
        const listing = await fileSystem.readDir(dir, { maxEntries: 65_536 });
        if (!listing.ok) {
          if (listing.outcome === 'permission_denied') {
            denials.push({ path: dir, code: listing.code, outcome: listing.outcome });
          }
          continue;
        }
        readableDirs += 1;
        if (listing.truncated) {
          truncatedDirs += 1;
        }

        for (const entry of listing.entries) {
          const path = `${dir}/${entry.name}`;
          if (entry.kind === 'directory' && WANT_DIR_PATTERN.test(entry.name)) {
            const wanted = await fileSystem.readDir(path, { maxEntries: 16_384 });
            if (!wanted.ok) {
              if (wanted.outcome === 'permission_denied') {
                denials.push({ path, code: wanted.code, outcome: wanted.outcome });
              }
              continue;
            }
            for (const link of wanted.entries) {
              const list = enablement.get(link.name) ?? [];
              list.push(path);
              enablement.set(link.name, list);
            }
            continue;
          }
          if (!hasUnitSuffix(entry.name)) {
            continue;
          }
          unitEntries.push({ path, name: entry.name, kind: entry.kind });
        }
      }

      if (readableDirs === 0) {
        const denied = denials.length > 0;
        return Object.freeze({
          status: denied ? 'denied' : 'error',
          records: [],
          denials: denials.length > 0
            ? denials
            : dirs.map((dir) => ({ path: dir, code: 'ENOENT', outcome: 'not_found' })),
          permissions: { granted: [], missing: denied ? denials.map((entry) => entry.path) : [] },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: false,
          observedAt,
          error: {
            code: denied ? 'EACCES' : 'ENOENT',
            message: denied
              ? 'no declared systemd unit directory is readable by this account'
              : 'no declared systemd unit directory exists on this system',
          },
        });
      }

      const items = [];
      for (const unit of unitEntries) {
        const stat = await fileSystem.stat(unit.path);
        if (!stat.ok) {
          if (stat.outcome === 'not_found') {
            continue;
          }
          denials.push({ path: unit.path, code: stat.code, outcome: stat.outcome });
          continue;
        }
        const enabledBy = enablement.get(unit.name) ?? [];
        const masked = stat.kind === 'symlink' && stat.linkTarget === '/dev/null';
        let content = null;
        if (includeContent) {
          const read = await fileSystem.readText(unit.path, { maxBytes: maxContentBytes });
          if (read.ok) {
            content = parseUnitContent(read.text);
          } else {
            // "Could not read the content" must not look like "the unit has no keys".
            denials.push({ path: unit.path, code: read.code, outcome: read.outcome, field: 'content' });
            content = null;
          }
        }
        const digest = stateDigest({
          kind: stat.kind,
          size: stat.size,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          linkTarget: stat.linkTarget,
          enabledBy,
          masked,
          content,
        });
        items.push({
          entityId: `systemd-${shortHash(unit.path, 20)}`,
          digest,
          payload: normalizePayload({
            unit_name: unit.name,
            unit_type: unit.name.slice(unit.name.lastIndexOf('.')),
            path: unit.path,
            origin: originOf(unit.path),
            size: stat.size,
            mode: stat.mode,
            uid: stat.uid,
            gid: stat.gid,
            inode: stat.ino,
            dev: stat.dev,
            mtime: new Date(stat.mtimeMs).toISOString(),
            masked,
            enabled: enabledBy.length > 0,
            enabled_by: enabledBy,
            link_target: stat.linkTarget,
            // 合同只接受标量（或同类标量数组），嵌套对象会被 ERR_FIELD_TYPE 拒绝（DEF-04）。
            // 单元内容是有界的键值映射，序列化成一条 JSON 字符串既保留信息又满足合同；
            // 与 Windows 侧"不支持的类型直接丢弃"不同，这是显式声明的 opt-in 字段，
            // 丢弃等于删功能，所以这里选择可逆编码而不是删除。
            ...(content === null ? {} : { content_json: JSON.stringify(content) }),
          }).payload,
        });
      }

      if (items.length === 0 && denials.length === 0) {
        return Object.freeze({
          status: 'error',
          errorCode: 'EMPTY_UNIT_TABLE',
          records: [],
          denials: [],
          permissions: { granted: [], missing: [] },
          nextCursor: null,
          identity: null,
          snapshot: null,
          truncated: truncatedDirs > 0,
          observedAt,
          error: {
            code: 'EMPTY_UNIT_TABLE',
            message: 'the declared unit directories listed no units, which cannot be a systemd host',
          },
        });
      }

      // Suppression is scoped to the unreadable paths: a unit under a directory we could not
      // list may still exist, but a unit under a readable directory that really disappeared
      // must still be reported as removed. A truncated listing is global evidence loss.
      const deniedPaths = denials.map((denial) => denial.path);
      const diff = differ.diff(items, {
        suppressRemovalsFor: (entry) => {
          if (truncatedDirs > 0) {
            return true;
          }
          const path = entry.item.payload.path;
          return typeof path === 'string'
            && deniedPaths.some((denied) => path === denied || path.startsWith(`${denied}/`));
        },
      });
      const records = diff.entries
        .map((entry) => buildSnapshotRecord({
          type: 'linux.systemd-unit',
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
      if (denials.length > 0 || truncatedDirs > 0) {
        status = items.length === 0 ? 'denied' : 'partial';
      }
      const missing = status === 'denied'
        ? denials.map((denial) => denial.path)
        : [];

      return Object.freeze({
        status,
        records,
        denials,
        permissions: { granted: dirs.filter((dir) => !denials.some((d) => d.path === dir)), missing },
        suppressedRemovals: diff.suppressedRemovals,
        nextCursor: null,
        identity: { fileId: stableSourceId, size: items.length },
        snapshot: diff.snapshot,
        truncated: diff.truncated || truncatedDirs > 0,
        observedAt,
        stats: Object.freeze({
          units: items.length,
          readableDirs,
          truncatedDirs,
          enablementLinks: [...enablement.values()].reduce((total, list) => total + list.length, 0),
        }),
        error: null,
      });
    },
  });
}
