/**
 * Public surface of `@aegisharness/collector-linux`.
 *
 * Layer map:
 *   errors.js        typed errors + filesystem outcome classification
 *   fs-reader.js     the injectable file/procfs abstraction (node-backed and memory-backed)
 *   command.js       the allowlisted process runner (`journalctl` only) + a scripted double
 *   diff.js          snapshot identity/digest/diff for table-like sources
 *   payload.js       contract-safe payload shaping (snake_case keys, C0/C1/bidi stripping,
 *                    16 KiB total budget) — the Linux counterpart of the Windows shaper
 *   json-guard.js    duplicate-key detection shared by the JSON-lines parsers (DEF-07)
 *   sources/*        one module per Linux source, each with a validated declaration
 *   runtime.js       wiring into `packages/collectors/common` + the degradation policy
 *
 * Nothing here knows about detection, storage or the daemon: platform differences stay on
 * this side of the `common` boundary.
 */

export * from './errors.js';
export * from './fs-reader.js';
export * from './command.js';
export * from './diff.js';
export * from './payload.js';
export * from './json-guard.js';
export * from './sources/descriptor.js';
export * from './runtime.js';

export {
  DEFAULT_PROC_ROOT,
  CLOCK_TICKS_PER_SECOND,
  PROCESS_FIELDS,
  PROCESS_INTERVAL_MS,
  PROCESS_DESCRIPTOR,
  PROCESS_SOURCE_ID,
  createProcfsProcessSource,
  isNumericName,
  parseBtime,
  parseCmdline,
  parseProcStat,
  parseProcStatus,
} from './sources/procfs-processes.js';

export {
  CONNECTION_DESCRIPTOR,
  CONNECTION_FIELDS,
  CONNECTION_INTERVAL_MS,
  CONNECTION_SOURCE_ID,
  DEFAULT_MAX_OWNER_SCAN,
  DEFAULT_NET_ROOT,
  TCP_STATES,
  createProcfsConnectionSource,
  decodeAddress,
  decodeIpv4,
  decodeIpv6,
  parseNetTable,
  scanSocketOwners,
} from './sources/procfs-connections.js';

export {
  AUTH_IDENTIFIERS,
  JOURNALD_DESCRIPTOR,
  JOURNALD_FIELDS,
  JOURNALD_OUTPUT_FIELDS,
  JOURNALD_PRIORITY_SEVERITY,
  JOURNALD_PROBE_INTERVAL_MS,
  JOURNALD_SEVERITY_NAMES,
  JOURNALD_SOURCE_ID,
  JOURNAL_PATHS,
  classifyJournalctlFailure,
  createJournaldAuthSource,
  createJournaldSource,
  describeJournald,
  isAuthIdentifier,
  nativeIdForCursor,
  parseJournaldEntry,
  parseJournaldOutput,
  severityForPriority,
  severityName,
} from './sources/journald.js';

export {
  AUTH_LOG_DESCRIPTOR,
  AUTH_LOG_FIELDS,
  AUTH_LOG_INTERVAL_MS,
  AUTH_LOG_SOURCE_ID,
  DEFAULT_AUTH_LOG_PATHS,
  createAuthLogSource,
  parseAuthLine,
  severityForAuthLine,
} from './sources/auth-log.js';

export {
  SYSTEMD_DESCRIPTOR,
  SYSTEMD_FIELDS,
  SYSTEMD_INTERVAL_MS,
  SYSTEMD_SOURCE_ID,
  SYSTEMD_UNIT_DIRS,
  UNIT_CONTENT_KEYS,
  UNIT_SUFFIXES,
  WANT_DIR_PATTERN,
  createSystemdUnitSource,
  hasUnitSuffix,
  parseUnitContent,
} from './sources/systemd-units.js';

export {
  CRON_DESCRIPTOR,
  CRON_FIELDS,
  CRON_FILES,
  CRON_INTERVAL_MS,
  CRON_SCRIPT_DIRS,
  CRON_SOURCE_ID,
  CRON_SPECIALS,
  CRON_TAB_DIRS,
  createCronSource,
  parseCrontab,
} from './sources/cron.js';

export {
  DEFAULT_MAX_DEPTH,
  DEFAULT_ROOTS,
  DIRECTORY_FIELDS,
  DIRECTORY_INTERVAL_MS,
  DIRECTORY_SOURCE_ID,
  MAX_DECLARED_ROOTS,
  createDeclaredDirectorySource,
  describeDeclaredDirectorySource,
} from './sources/directories.js';

export {
  LINUX_SOURCE_IDS,
  assertAllSourceDescriptors,
  defaultLinuxSourceDescriptors,
} from './sources/index.js';
