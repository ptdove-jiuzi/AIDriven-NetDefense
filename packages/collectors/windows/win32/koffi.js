/**
 * koffi loader shared by every native Windows reader in this package.
 *
 * One place owns the library cache, the error taxonomy and the availability probe, so a
 * future source (event log, registry, services) binds through here instead of opening its
 * own `koffi.load()` calls and inventing its own fallback rules.
 *
 * `koffi` is imported statically on purpose: the repository's injection guard forbids
 * *dynamic* loading (`import(`, `require(`, `createRequire`) in collector code, and a
 * static ESM import of a declared dependency is the reviewable form. The consequence is
 * that a host with no `koffi` installed cannot load this module at all — that is a broken
 * install, which `packages/collectors/windows/package.json` now declares as a dependency.
 * What *is* handled gracefully is everything short of that: a missing DLL/export, a
 * non-Windows host, or a failed first call. All of those report `isAvailable() === false`
 * (or throw a `WindowsCollectorError`) and the sources fall back to the script transport.
 */

import koffi from 'koffi';

import { WINDOWS_ERROR_CODES, WindowsCollectorError } from '../errors.js';

/** Libraries every native reader may need. Loaded lazily, cached for the process lifetime. */
const LIBRARY_NAMES = Object.freeze({
  ntdll: 'ntdll.dll',
  kernel32: 'kernel32.dll',
  iphlpapi: 'iphlpapi.dll',
  advapi32: 'advapi32.dll',
  wevtapi: 'wevtapi.dll',
  user32: 'user32.dll',
});

const libraryCache = new Map();
const warnings = [];

/** Record a load/bind problem the sources can report as degraded instead of swallowing it. */
function recordWarning(entry) {
  warnings.push(Object.freeze({ at: new Date().toISOString(), ...entry }));
  if (warnings.length > 32) {
    warnings.shift();
  }
}

/**
 * Load a DLL through koffi, with a process-wide cache.
 *
 * @param {string} name e.g. `'iphlpapi.dll'`, or a key of {@link LIBRARY_NAMES}
 * @returns {object|null} the library handle, or null when it cannot be loaded
 */
export function loadLibrary(name) {
  const resolved = LIBRARY_NAMES[name] ?? name;
  if (libraryCache.has(resolved)) {
    return libraryCache.get(resolved);
  }
  let library = null;
  try {
    library = koffi.load(resolved);
  } catch (error) {
    recordWarning({
      kind: 'library_unavailable',
      library: resolved,
      message: error?.message ?? String(error),
    });
    library = null;
  }
  libraryCache.set(resolved, library);
  return library;
}

/**
 * Bind one exported function.
 *
 * @param {object|null} library result of {@link loadLibrary}
 * @param {string} signature C signature, e.g. `'bool CloseHandle(void *)'`
 * @param {string} [libraryName] for the error message only
 * @returns {Function} callable wrapper
 * @throws {WindowsCollectorError} `COMMAND_FAILED` when the library or the export is missing
 */
export function bind(library, signature, libraryName = 'unknown library') {
  if (library === null || library === undefined) {
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.COMMAND_FAILED,
      `a native Windows library is unavailable: ${libraryName}`,
      { details: { library: libraryName, signature } },
    );
  }
  try {
    return library.func(signature);
  } catch (error) {
    recordWarning({
      kind: 'export_unavailable',
      library: libraryName,
      signature,
      message: error?.message ?? String(error),
    });
    throw new WindowsCollectorError(
      WINDOWS_ERROR_CODES.COMMAND_FAILED,
      `a required Win32 export is unavailable in ${libraryName}: ${signature}`,
      { details: { library: libraryName, signature, reason: error?.message ?? String(error) } },
    );
  }
}

let availability = null;

/**
 * Can this host run the native readers at all?
 *
 * Deliberately cheap: on Windows it checks that the three libraries the hot sources need are
 * loadable, without binding a single export. The answer is cached because a host does not
 * grow ntdll while the collector runs.
 *
 * @returns {boolean}
 */
export function isAvailable() {
  if (availability !== null) {
    return availability;
  }
  if (process.platform !== 'win32') {
    availability = false;
    recordWarning({ kind: 'unsupported_platform', platform: process.platform });
    return availability;
  }
  availability = loadLibrary('ntdll.dll') !== null
    && loadLibrary('kernel32.dll') !== null
    && loadLibrary('iphlpapi.dll') !== null;
  return availability;
}

/** Diagnostics for the fallback path and for the perf/degradation evidence. */
export function diagnostics() {
  return Object.freeze({
    available: isAvailable(),
    libraries: Object.freeze([...libraryCache.keys()].map((name) => Object.freeze({
      name,
      loaded: libraryCache.get(name) !== null,
    }))),
    warnings: Object.freeze([...warnings]),
    koffiVersion: typeof koffi.version === 'string' ? koffi.version : null,
  });
}

export { koffi, LIBRARY_NAMES };
