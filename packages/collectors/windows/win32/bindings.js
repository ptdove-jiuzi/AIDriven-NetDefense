/**
 * The concrete Win32 export set used by the hot collectors.
 *
 * Every binding goes through `win32/koffi.js` so library caching, error classification and
 * the availability probe live in one place. Nothing here is created at import time: a host
 * that only runs the script sources never pays for a `koffi.load()`.
 *
 * Names/signatures are the documented ones (`NtQuerySystemInformation`,
 * `GetExtendedTcpTable`, …). `_Out_`/`_Inout_` annotations are unnecessary for koffi and are
 * intentionally absent; passing a plain `uint32 *` with a `koffi.alloc('uint32', 1)` buffer
 * is the supported form for an out-parameter.
 */

import { bind, isAvailable, koffi, loadLibrary } from './koffi.js';
import { WindowsCollectorError } from '../errors.js';

/** Errors raised by the native layer, classified for the sources' degradation reporting. */
export const WIN32_ERROR_CODES = Object.freeze({
  LIBRARY_UNAVAILABLE: 'WIN32_LIBRARY_UNAVAILABLE',
  CALL_FAILED: 'WIN32_CALL_FAILED',
  UNSUPPORTED_PLATFORM: 'WIN32_UNSUPPORTED_PLATFORM',
});

export class Win32CollectorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'Win32CollectorError';
    this.code = code;
    this.details = details;
  }
}

export function statusHex(status) {
  return `0x${(status >>> 0).toString(16).toUpperCase()}`;
}

/**
 * Library/function bindings, built once per process and cached by the caller.
 *
 * @returns {object} the bound Win32 surface
 * @throws {Win32CollectorError} when koffi or a required library/export is unavailable
 */
export function createBindings() {
  const ntdll = loadLibrary('ntdll.dll');
  const kernel32 = loadLibrary('kernel32.dll');
  const iphlpapi = loadLibrary('iphlpapi.dll');

  const required = (library, name, signature) => {
    if (library === null) {
      throw new Win32CollectorError(
        WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE,
        `a native Windows library is unavailable: ${name}`,
        { library: name },
      );
    }
    try {
      return bind(library, signature, name);
    } catch (error) {
      throw new Win32CollectorError(
        WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE,
        error?.message ?? `a required Win32 export is unavailable: ${signature}`,
        { library: name, signature },
      );
    }
  };

  return Object.freeze({
    koffi,

    // Process enumeration / inspection (ntdll + kernel32).
    NtQuerySystemInformation: required(
      ntdll,
      'ntdll.dll',
      'int32 NtQuerySystemInformation(int32 SystemInformationClass, void *SystemInformation, uint32 SystemInformationLength, uint32 *ReturnLength)',
    ),
    NtQueryInformationProcess: required(
      ntdll,
      'ntdll.dll',
      'int32 NtQueryInformationProcess(void *ProcessHandle, int32 ProcessInformationClass, void *ProcessInformation, uint32 ProcessInformationLength, uint32 *ReturnLength)',
    ),
    OpenProcess: required(
      kernel32,
      'kernel32.dll',
      'void *OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)',
    ),
    CloseHandle: required(kernel32, 'kernel32.dll', 'bool CloseHandle(void *hObject)'),
    QueryFullProcessImageNameW: required(
      kernel32,
      'kernel32.dll',
      'bool QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, void *lpExeName, uint32 *lpdwSize)',
    ),
    ReadProcessMemory: required(
      kernel32,
      'kernel32.dll',
      'bool ReadProcessMemory(void *hProcess, void *lpBaseAddress, void *lpBuffer, size_t nSize, size_t *lpNumberOfBytesRead)',
    ),

    // Endpoint tables (iphlpapi).
    GetExtendedTcpTable: required(
      iphlpapi,
      'iphlpapi.dll',
      'uint32 GetExtendedTcpTable(void *pTcpTable, uint32 *pdwSize, bool bOrder, uint32 ulAf, int32 TableClass, uint32 Reserved)',
    ),
    GetExtendedUdpTable: required(
      iphlpapi,
      'iphlpapi.dll',
      'uint32 GetExtendedUdpTable(void *pUdpTable, uint32 *pdwSize, bool bOrder, uint32 ulAf, int32 TableClass, uint32 Reserved)',
    ),

    statusHex,
  });
}

/**
 * Load the bindings, or explain why this host cannot.
 *
 * @returns {Promise<object>} bindings from {@link createBindings}
 * @throws {Win32CollectorError} when the platform, `koffi` or a Win32 export is unavailable
 */
export async function loadBindings() {
  if (!isAvailable()) {
    throw new Win32CollectorError(
      WIN32_ERROR_CODES.UNSUPPORTED_PLATFORM,
      `the native Windows collector path is unavailable on this host (${process.platform})`,
    );
  }
  try {
    return createBindings();
  } catch (error) {
    if (error instanceof Win32CollectorError) {
      throw error;
    }
    throw new Win32CollectorError(
      WIN32_ERROR_CODES.LIBRARY_UNAVAILABLE,
      error?.message ?? String(error),
      { reason: error?.stack ?? null },
    );
  }
}

export { WindowsCollectorError };
