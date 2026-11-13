/**
 * jobobj.mjs — Windows Job Object 会计（perf-measure 席位）。
 *
 * 为什么主口径是它：残差法（整机总量 − 非产品）在这台机器上被并行战役污染的短命进程打穿，
 * 而 Job 会计是**内核按 job 记账**的 CPU 累计值：
 *   - 包含**已经退出**的子进程（短命 powershell 一个不漏）；
 *   - 别的进程烧 CPU 完全不影响它（负载无关）；
 *   - 一次 1 s 调用只花微秒级，不额外扰动被测量对象。
 *
 * 会计值单位是 100 ns，`TotalUserTime + TotalKernelTime` 即 job 内所有进程（含已退出）的累计 CPU。
 *
 * 只在 Windows 上可用；koffi 是仓库已有依赖（node_modules/koffi）。
 */

import koffi from 'koffi';

const ACCOUNTING_STRUCT = koffi.struct('JOBOBJECT_BASIC_ACCOUNTING_INFORMATION', {
  TotalUserTime: 'int64_t',
  TotalKernelTime: 'int64_t',
  ThisPeriodTotalUserTime: 'int64_t',
  ThisPeriodTotalKernelTime: 'int64_t',
  TotalPageFaultCount: 'uint32_t',
  TotalProcesses: 'uint32_t',
  ActiveProcesses: 'uint32_t',
  TotalTerminatedProcesses: 'uint32_t',
});

// JobObjectInformationClass（winnt.h）
export const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
export const JOB_OBJECT_BASIC_LIMIT_INFORMATION = 2;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;

const JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
const JOB_OBJECT_QUERY = 0x0004;
const JOB_OBJECT_TERMINATE = 0x0008;
const JOB_OBJECT_SET_ATTRIBUTES = 0x0002;
const JOB_OBJECT_ALL_ACCESS = 0x1f001f;

const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function loadApi() {
  const kernel32 = koffi.load('kernel32.dll');
  const api = {
    CreateJobObjectW: kernel32.func('void * __stdcall CreateJobObjectW(void *lpJobAttributes, str16 lpName)'),
    OpenJobObjectW: kernel32.func('void * __stdcall OpenJobObjectW(uint32_t dwDesiredAccess, int bInheritHandle, str16 lpName)'),
    QueryInformationJobObject: kernel32.func(
      'int __stdcall QueryInformationJobObject(void *hJob, int JobObjectInfoClass, _Out_ JOBOBJECT_BASIC_ACCOUNTING_INFORMATION *lpJobObjectInfo, uint32_t cbJobObjectInfoLength, void *lpReturnLength)',
    ),
    AssignProcessToJobObject: kernel32.func('int __stdcall AssignProcessToJobObject(void *hJob, void *hProcess)'),
    QueryJobBuffer: kernel32.func(
      'int __stdcall QueryInformationJobObject(void *hJob, int JobObjectInfoClass, void *lpJobObjectInfo, uint32_t cbJobObjectInfoLength, void *lpReturnLength)',
    ),
    IsProcessInJob: kernel32.func('int __stdcall IsProcessInJob(void *hProcess, void *hJobObject, _Out_ int *result)'),
    OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)'),
    GetCurrentProcess: kernel32.func('void * __stdcall GetCurrentProcess()'),
    TerminateJobObject: kernel32.func('int __stdcall TerminateJobObject(void *hJob, uint32_t uExitCode)'),
    TerminateProcess: kernel32.func('int __stdcall TerminateProcess(void *hProcess, uint32_t uExitCode)'),
    CloseHandle: kernel32.func('int __stdcall CloseHandle(void *hObject)'),
    GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
  };
  return api;
}

let cached = null;

/** 懒加载 Win32 句柄；非 Windows 直接抛，调用方据此降级。 */
export function jobApi() {
  if (process.platform !== 'win32') throw new Error('jobobj: Windows only');
  if (cached === null) cached = buildApi(loadApi());
  return cached;
}

function buildApi(raw) {
  const check = (ok, what) => {
    if (ok !== 0) return;
    const code = raw.GetLastError();
    const error = new Error(`${what} failed (win32 error ${code})`);
    error.win32Error = code;
    throw error;
  };

  const api = {
    /** 建一个命名 job。name 必须是全局唯一的；同名已存在时返回错误。 */
    createJob(name) {
      const handle = raw.CreateJobObjectW(null, name);
      if (handle === null) {
        const code = raw.GetLastError();
        const error = new Error(`CreateJobObjectW(${name}) failed (win32 error ${code})`);
        error.win32Error = code;
        throw error;
      }
      return { handle, name };
    },

    /** 按名字打开已有 job（用于测量进程隔着进程边界读账本）。 */
    openJob(name, { access = JOB_OBJECT_QUERY | JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_TERMINATE } = {}) {
      const handle = raw.OpenJobObjectW(access, 0, name);
      if (handle === null) return null;
      return { handle, name };
    },

    closeHandle(handle) {
      if (handle === null || handle === undefined) return;
      raw.CloseHandle(handle);
    },

    /** 把进程放进 job。目标进程若已在别的 job 里会失败（win32 error 5 / 87）。 */
    assignPid(job, pid) {
      const processHandle = raw.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (processHandle === null) {
        const error = new Error(`OpenProcess(${pid}) failed (win32 error ${raw.GetLastError()})`);
        error.win32Error = raw.GetLastError();
        return { ok: false, error };
      }
      try {
        const ok = raw.AssignProcessToJobObject(job.handle, processHandle);
        if (ok === 0) {
          const code = raw.GetLastError();
          const error = new Error(`AssignProcessToJobObject(pid=${pid}) failed (win32 error ${code})`);
          error.win32Error = code;
          return { ok: false, error };
        }
        return { ok: true, error: null };
      } finally {
        raw.CloseHandle(processHandle);
      }
    },

    /** 把当前进程放进 job：之后 spawn 的子进程天然继承会员资格（最稳的收编方式）。 */
    assignSelf(job) {
      const ok = raw.AssignProcessToJobObject(job.handle, raw.GetCurrentProcess());
      if (ok === 0) {
        const code = raw.GetLastError();
        const error = new Error(`AssignProcessToJobObject(self) failed (win32 error ${code})`);
        error.win32Error = code;
        return { ok: false, error };
      }
      return { ok: true, error: null };
    },

    isPidInJob(pid) {
      const processHandle = raw.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (processHandle === null) return null;
      try {
        const result = [0];
        const ok = raw.IsProcessInJob(processHandle, null, result);
        if (ok === 0) return null;
        return result[0] !== 0;
      } finally {
        raw.CloseHandle(processHandle);
      }
    },

    /** 读会计账本。CPU 时间以秒返回（原生 100 ns）。 */
    queryAccounting(job) {
      const info = {};
      const ok = raw.QueryInformationJobObject(
        job.handle,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        info,
        koffi.sizeof(ACCOUNTING_STRUCT),
        null,
      );
      serr(ok === 0 ? `QueryInformationJobObject failed (win32 error ${raw.GetLastError()})` : null);
      const hundredNsToSec = (value) => Number(value) / 1e7;
      const user = hundredNsToSec(info.TotalUserTime ?? 0);
      const kernel = hundredNsToSec(info.TotalKernelTime ?? 0);
      return {
        userSec: user,
        kernelSec: kernel,
        totalSec: user + kernel,
        thisPeriodUserSec: hundredNsToSec(info.ThisPeriodTotalUserTime ?? 0),
        thisPeriodKernelSec: hundredNsToSec(info.ThisPeriodTotalKernelTime ?? 0),
        pageFaults: Number(info.TotalPageFaultCount ?? 0),
        totalProcesses: Number(info.TotalProcesses ?? 0),
        activeProcesses: Number(info.ActiveProcesses ?? 0),
        totalTerminated: Number(info.TotalTerminatedProcesses ?? 0),
      };
    },

    /**
     * job 内**当前**进程 PID 列表（内核权威答案）。
     * 用途：验证 WebView2 / 壳拉起的 mock daemon 是否真的在 job 里（breakaway 会在这里露馅）。
     */
    queryProcessIdList(job) {
      const headerSize = 8;
      const perPid = process.arch === 'x64' || process.arch === 'arm64' ? 8 : 4;
      let capacity = 64;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const buffer = Buffer.alloc(headerSize + perPid * capacity);
        const ok = raw.QueryJobBuffer(job.handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, buffer, buffer.length, null);
        if (ok === 0) {
          const code = raw.GetLastError();
          // ERROR_MORE_DATA = 234：容纳不下，按它给的数量扩容再来
          if (code === 234) {
            const needed = buffer.readUInt32LE(4);
            capacity = Math.max(capacity * 2, needed + 8);
            continue;
          }
          return { ok: false, error: code, pids: [] };
        }
        const declared = buffer.readUInt32LE(4);
        const pids = [];
        const limit = Math.min(declared, capacity);
        for (let index = 0; index < limit; index += 1) {
          const offset = headerSize + index * perPid;
          const pid = perPid === 8 ? Number(buffer.readBigUInt64LE(offset)) : buffer.readUInt32LE(offset);
          if (pid > 0) pids.push(pid);
        }
        return { ok: true, error: null, pids };
      }
      return { ok: false, error: 'grow-loop-exhausted', pids: [] };
    },

    terminateJob(job, exitCode = 1) {
      const ok = raw.TerminateJobObject(job.handle, exitCode);
      return { ok: ok !== 0, error: ok === 0 ? raw.GetLastError() : null };
    },

    terminatePid(pid, exitCode = 1) {
      const processHandle = raw.OpenProcess(PROCESS_TERMINATE, 0, pid);
      if (processHandle === null) return { ok: false, error: raw.GetLastError() };
      try {
        const ok = raw.TerminateProcess(processHandle, exitCode);
        return { ok: ok !== 0, error: ok === 0 ? raw.GetLastError() : null };
      } finally {
        raw.CloseHandle(processHandle);
      }
    },

    constants: {
      JOB_OBJECT_ASSIGN_PROCESS,
      JOB_OBJECT_QUERY,
      JOB_OBJECT_TERMINATE,
      JOB_OBJECT_SET_ATTRIBUTES,
      JOB_OBJECT_ALL_ACCESS,
    },
  };
  return api;
}

function serr(message) {
  if (message !== null) throw new Error(message);
}

export { ACCOUNTING_STRUCT };
