/**
 * Process table via `ntdll!NtQuerySystemInformation(SystemProcessInformation)`.
 *
 * Replaces one `Get-CimInstance Win32_Process` subprocess per poll (1156 ms of CPU on the
 * reference host) with a single kernel query plus one handle per process (~a few ms).
 *
 * Field mapping to the WMI rows the source has always consumed:
 *
 * | WMI column        | native source                                              |
 * |-------------------|------------------------------------------------------------|
 * | ProcessId         | SYSTEM_PROCESS_INFORMATION.UniqueProcessId                 |
 * | ParentProcessId   | SYSTEM_PROCESS_INFORMATION.InheritedFromUniqueProcessId    |
 * | Name              | SYSTEM_PROCESS_INFORMATION.ImageName                       |
 * | ExecutablePath    | PEB.ProcessParameters.ImagePathName (WMI's own source)     |
 * | CommandLine       | PEB.ProcessParameters.CommandLine                          |
 * | CreationDate      | SYSTEM_PROCESS_INFORMATION.CreateTime (FILETIME → ms)      |
 *
 * `ExecutablePath` is read from the PEB on purpose: WMI's `ExecutablePath` *is* the PEB
 * `ImagePathName`, so a `QueryFullProcessImageNameW` answer would differ in letter case and
 * in how a symlinked/aliased launch path is normalised. `QueryFullProcessImageNameW` remains
 * as the per-process fallback when the PEB cannot be read (for example a 32-bit-only account
 * or a packaged app whose parameters are not mapped), which can only add rows, never lose
 * them.
 *
 * Rows are returned in the WMI shape so `normalizeRow` in `sources/processes.js` stays
 * byte-identical: `entityId` (`pid-creationMs`), the digest and the "every image path and
 * command line is blank ⇒ degraded" rule are inherited, not re-implemented.
 */

import { fileTimeToEpochMs } from './format.js';

const STATUS_SUCCESS = 0;
const STATUS_INFO_LENGTH_MISMATCH = -1073741820;
const SYSTEM_PROCESS_INFORMATION = 5;
const PROCESS_BASIC_INFORMATION = 0;

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** x64 offsets; the layout is a documented stable ABI for the whole Windows 10/11 line. */
const SYS_PROCESS = Object.freeze({
  NextEntryOffset: 0x00,
  CreateTime: 0x20,
  ImageNameLength: 0x38,
  ImageNameBuffer: 0x40,
  UniqueProcessId: 0x50,
  InheritedFromUniqueProcessId: 0x58,
});

const PEB = Object.freeze({
  ProcessParameters: 0x20,
});

const RTL_USER_PROCESS_PARAMETERS = Object.freeze({
  ImagePathName: 0x60,
  CommandLine: 0x70,
  /** Enough to cover both UNICODE_STRING headers (ImagePathName .. CommandLine + 16). */
  HeaderBytes: 0x100,
});

const INITIAL_SYSTEM_BUFFER = 1 << 20;
const MAX_SYSTEM_BUFFER = 64 << 20;
const MAX_IMAGE_NAME_CHARS = 32_768;

/** Read a UTF-16LE string out of a buffer we own (the kernel wrote the name in place). */
function utf16FromView(view, offset, byteLength) {
  if (byteLength <= 0 || offset < 0 || offset + byteLength > view.byteLength) {
    return null;
  }
  let text = '';
  for (let index = 0; index < byteLength; index += 2) {
    text += String.fromCharCode(view.getUint16(offset + index, true));
  }
  return text.length === 0 ? null : text;
}

/**
 * Build the reader. Buffers and handles are reused across calls; nothing is allocated per
 * row beyond the returned strings.
 *
 * @param {object} bindings result of `loadBindings()`
 * @returns {() => Array<object>} WMI-shaped rows (`ProcessId`, `ParentProcessId`, `Name`,
 *   `ExecutablePath`, `CommandLine`, `CreationDate`)
 */
export function createProcessTableReader(bindings) {
  const { koffi } = bindings;
  const { NtQuerySystemInformation, NtQueryInformationProcess, OpenProcess, CloseHandle } = bindings;
  const { QueryFullProcessImageNameW, ReadProcessMemory } = bindings;

  let systemBuffer = null;
  let systemBufferSize = INITIAL_SYSTEM_BUFFER;

  const returnLength = koffi.alloc('uint32', 1);
  const processInfo = koffi.alloc('uint8', 64);
  const processInfoReturned = koffi.alloc('uint32', 1);
  const paramsPointer = koffi.alloc('uint64', 1);
  const paramsHeader = koffi.alloc('uint8', RTL_USER_PROCESS_PARAMETERS.HeaderBytes);
  const bytesRead = koffi.alloc('size_t', 1);
  const imagePathBuffer = koffi.alloc('uint16', MAX_IMAGE_NAME_CHARS);
  const imagePathSize = koffi.alloc('uint32', 1);
  const stringBuffer = koffi.alloc('uint16', 4096);

  function readString(hProcess, unicodeStringOffset) {
    const view = new DataView(koffi.view(paramsHeader, RTL_USER_PROCESS_PARAMETERS.HeaderBytes));
    const byteLength = view.getUint16(unicodeStringOffset, true);
    const bufferPointer = Number(view.getBigUint64(unicodeStringOffset + 8, true));
    if (byteLength <= 0 || bufferPointer === 0) {
      return null;
    }
    if (byteLength > 8192) {
      // A longer command line still fits: allocate one exactly sized buffer for that row.
      const sized = koffi.alloc('uint16', Math.ceil(byteLength / 2) + 1);
      if (!ReadProcessMemory(hProcess, bufferPointer, sized, byteLength, bytesRead)) {
        return null;
      }
      return utf16FromView(new DataView(koffi.view(sized, byteLength)), 0, byteLength);
    }
    if (!ReadProcessMemory(hProcess, bufferPointer, stringBuffer, byteLength, bytesRead)) {
      return null;
    }
    return utf16FromView(new DataView(koffi.view(stringBuffer, byteLength)), 0, byteLength);
  }

  function queryFullProcessImageName(hProcess) {
    koffi.encode(imagePathSize, 'uint32', MAX_IMAGE_NAME_CHARS);
    if (!QueryFullProcessImageNameW(hProcess, 0, imagePathBuffer, imagePathSize)) {
      return null;
    }
    const chars = koffi.decode(imagePathSize, 'uint32');
    if (chars <= 0 || chars > MAX_IMAGE_NAME_CHARS) {
      return null;
    }
    return utf16FromView(new DataView(koffi.view(imagePathBuffer, MAX_IMAGE_NAME_CHARS * 2)), 0, chars * 2);
  }

  /**
   * PEB-backed image path + command line.
   *
   * One handle covers both, because they live in the same `RTL_USER_PROCESS_PARAMETERS`
   * block: the header is read once and both `UNICODE_STRING`s are parsed out of it. When the
   * process cannot be opened at all (protected process, other user without SeDebugPrivilege)
   * both fields stay null — exactly what unelevated WMI reports, which is why `image_path`
   * and `command_line` are declared `completeness: admin`.
   */
  function readProcessDetails(pid) {
    const handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (!handle) {
      const imageHandle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!imageHandle) {
        return { executablePath: null, commandLine: null };
      }
      try {
        return { executablePath: queryFullProcessImageName(imageHandle), commandLine: null };
      } finally {
        CloseHandle(imageHandle);
      }
    }
    try {
      let executablePath = null;
      let commandLine = null;
      if (NtQueryInformationProcess(
        handle,
        PROCESS_BASIC_INFORMATION,
        processInfo,
        48,
        processInfoReturned,
      ) === STATUS_SUCCESS) {
        const peb = Number(koffi.decode(processInfo, 8, 'uint64'));
        if (peb !== 0
          && ReadProcessMemory(handle, peb + PEB.ProcessParameters, paramsPointer, 8, bytesRead)) {
          const params = Number(koffi.decode(paramsPointer, 'uint64'));
          if (params !== 0
            && ReadProcessMemory(
              handle,
              params,
              paramsHeader,
              RTL_USER_PROCESS_PARAMETERS.HeaderBytes,
              bytesRead,
            )) {
            executablePath = readString(handle, RTL_USER_PROCESS_PARAMETERS.ImagePathName);
            commandLine = readString(handle, RTL_USER_PROCESS_PARAMETERS.CommandLine);
          }
        }
      }
      if (executablePath === null) {
        executablePath = queryFullProcessImageName(handle);
      }
      return { executablePath, commandLine };
    } finally {
      CloseHandle(handle);
    }
  }

  function querySystemProcesses() {
    if (systemBuffer === null) {
      systemBuffer = koffi.alloc('uint8', systemBufferSize);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const status = NtQuerySystemInformation(
        SYSTEM_PROCESS_INFORMATION,
        systemBuffer,
        systemBufferSize,
        returnLength,
      );
      if (status === STATUS_SUCCESS) {
        return true;
      }
      if (status !== STATUS_INFO_LENGTH_MISMATCH) {
        return false;
      }
      const needed = koffi.decode(returnLength, 'uint32');
      const next = Math.min(MAX_SYSTEM_BUFFER, Math.max(systemBufferSize * 2, needed + 65536));
      if (next <= systemBufferSize) {
        return false;
      }
      systemBufferSize = next;
      systemBuffer = koffi.alloc('uint8', systemBufferSize);
    }
    return false;
  }

  return function readProcessTable() {
    if (!querySystemProcesses()) {
      throw new Error('NtQuerySystemInformation(SystemProcessInformation) failed');
    }
    const base = Number(koffi.address(systemBuffer));
    const view = new DataView(koffi.view(systemBuffer, systemBufferSize));
    const rows = [];
    let offset = 0;
    while (offset + 0x60 <= systemBufferSize) {
      const nextEntryOffset = view.getUint32(offset + SYS_PROCESS.NextEntryOffset, true);
      const pid = Number(BigInt.asUintN(32, view.getBigUint64(offset + SYS_PROCESS.UniqueProcessId, true)));
      const ppid = Number(BigInt.asUintN(32, view.getBigUint64(offset + SYS_PROCESS.InheritedFromUniqueProcessId, true)));
      const nameLength = view.getUint16(offset + SYS_PROCESS.ImageNameLength, true);
      const namePointer = Number(view.getBigUint64(offset + SYS_PROCESS.ImageNameBuffer, true));
      const rawName = utf16FromView(view, namePointer - base, nameLength);
      const createMs = fileTimeToEpochMs(view.getBigInt64(offset + SYS_PROCESS.CreateTime, true));

      // The idle process is the one table entry without an image name. WMI reports it as
      // "System Idle Process"; keeping that literal preserves the old payload for pid 0,
      // whose `name` is a declared `always` field.
      const name = rawName ?? (pid === 0 ? 'System Idle Process' : null);
      const details = readProcessDetails(pid);

      rows.push({
        ProcessId: pid,
        ParentProcessId: ppid,
        Name: name,
        ExecutablePath: details.executablePath,
        CommandLine: details.commandLine,
        CreationDate: createMs,
      });

      if (nextEntryOffset === 0) {
        break;
      }
      offset += nextEntryOffset;
    }
    return rows;
  };
}
