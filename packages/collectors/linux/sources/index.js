/**
 * Registry of every Linux source, with its declaration.
 *
 * The runtime and the test suite both read from here, so "every source declares permissions,
 * interval, field completeness, blind spots, rotation, gap semantics and degradation" is a
 * property of the registry rather than of each file's prose.
 */

import { AUTH_LOG_DESCRIPTOR, AUTH_LOG_SOURCE_ID } from './auth-log.js';
import { CONNECTION_DESCRIPTOR, CONNECTION_SOURCE_ID } from './procfs-connections.js';
import { CRON_DESCRIPTOR, CRON_SOURCE_ID } from './cron.js';
import {
  DIRECTORY_SOURCE_ID,
  describeDeclaredDirectorySource,
} from './directories.js';
import { JOURNALD_DESCRIPTOR, JOURNALD_SOURCE_ID } from './journald.js';
import { PROCESS_DESCRIPTOR, PROCESS_SOURCE_ID } from './procfs-processes.js';
import { SYSTEMD_DESCRIPTOR, SYSTEMD_SOURCE_ID } from './systemd-units.js';
import { assertSourceDescriptor } from './descriptor.js';

export const LINUX_SOURCE_IDS = Object.freeze({
  process: PROCESS_SOURCE_ID,
  connection: CONNECTION_SOURCE_ID,
  journald: JOURNALD_SOURCE_ID,
  authLog: AUTH_LOG_SOURCE_ID,
  systemd: SYSTEMD_SOURCE_ID,
  cron: CRON_SOURCE_ID,
  directories: DIRECTORY_SOURCE_ID,
});

/**
 * Default declarations for the seven first-version sources. `linux.declared-directories`
 * is described through its factory because its declared paths are configuration.
 */
export function defaultLinuxSourceDescriptors() {
  return Object.freeze([
    PROCESS_DESCRIPTOR,
    CONNECTION_DESCRIPTOR,
    JOURNALD_DESCRIPTOR,
    AUTH_LOG_DESCRIPTOR,
    SYSTEMD_DESCRIPTOR,
    CRON_DESCRIPTOR,
    describeDeclaredDirectorySource(),
  ]);
}

/** Re-validate every declaration; returns the frozen list or throws on the first defect. */
export function assertAllSourceDescriptors(descriptors = defaultLinuxSourceDescriptors()) {
  const validated = descriptors.map((descriptor) => assertSourceDescriptor(descriptor));
  const seen = new Set();
  for (const descriptor of validated) {
    if (seen.has(descriptor.stableSourceId)) {
      throw new Error(`duplicate Linux stable source id: ${descriptor.stableSourceId}`);
    }
    seen.add(descriptor.stableSourceId);
  }
  return Object.freeze(validated);
}

export {
  AUTH_LOG_DESCRIPTOR,
  AUTH_LOG_SOURCE_ID,
  CONNECTION_DESCRIPTOR,
  CONNECTION_SOURCE_ID,
  CRON_DESCRIPTOR,
  CRON_SOURCE_ID,
  DIRECTORY_SOURCE_ID,
  JOURNALD_DESCRIPTOR,
  JOURNALD_SOURCE_ID,
  PROCESS_DESCRIPTOR,
  PROCESS_SOURCE_ID,
  SYSTEMD_DESCRIPTOR,
  SYSTEMD_SOURCE_ID,
  assertSourceDescriptor,
  describeDeclaredDirectorySource,
};
