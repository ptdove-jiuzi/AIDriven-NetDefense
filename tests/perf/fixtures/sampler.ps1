# sampler.ps1 - single resident PowerShell sampler for PERF-CPU idle measurements.
#
# Why a resident process instead of "one powershell per sample point":
#   the thing under measurement IS the cost of spawning powershell.exe every tick.
#   A sampler that spawns a process per sample would be the same order of magnitude
#   of interference, and 200-600 ms children would be born and die between samples.
#
# Two sampling cadences (cost measured in evidence/perf/measure/sampler-cost.md):
#   - fast tick (IntervalMs=400 ms): Toolhelp snapshot of ALL processes + CPU only for
#     a small name set that the product can create/spawn (powershell, node, python,
#     msedgewebview2, conhost, ...). ~2 ms per tick.
#   - full tick (PdhEveryMs=1000 ms): also reads PDH total CPU and GetSystemTimes, and
#     takes CPU of EVERY process (~25 ms) so the non-product sum and the per-process
#     split are complete.
#
# Output lines (node dispatches on the first character; CRLF is stripped node-side):
#   S|<epochMs>|<pdhTotalPct>|<sysTimesTotalPct>|<procs>   full tick
#   T|<epochMs>|<procs>                                    fast tick
#   C|<epochMs>|<pid>|<commandLine>                        node/python cmdlines, every 15 s
#   E|<epochMs>                                            end
#
# <procs> = "pid:ppid:name:cpuSec:createdMs,..."
#   cpu = -1 means "this tick did not read that process's CPU" (fast tick, non-fast name
#   or protected process). node only updates state for entries that carry a real value,
#   so the unread quantum lands in the residual (which the residual rule attributes to
#   the product).
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 decodes a BOM-less
# UTF-8 script as CP936; non-ASCII bytes in comments are harmless in theory but two
# separate sessions in this repo have already been bitten by that path, so keep it ASCII.

param(
  [int]$DurationMs = 60000,
  [int]$IntervalMs = 400,
  [int]$PdhEveryMs = 1000,
  [int]$CimEveryMs = 15000,
  [switch]$Diag
)

$ErrorActionPreference = 'SilentlyContinue'

$Source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PdhProcs
{
    [StructLayout(LayoutKind.Sequential)]
    public struct FMT { public uint CStatus; public double Value; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ITEM { public IntPtr Name; public FMT Fmt; }

    [DllImport("pdh.dll")]
    private static extern uint PdhOpenQueryW(IntPtr src, IntPtr user, out IntPtr q);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern uint PdhAddEnglishCounterW(IntPtr q, string path, IntPtr user, out IntPtr c);
    [DllImport("pdh.dll")]
    private static extern uint PdhCollectQueryData(IntPtr q);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern uint PdhGetFormattedCounterArrayW(IntPtr c, uint fmt, ref uint size, out uint count, IntPtr buf);

    private const uint PDH_MORE_DATA = 0x800007D2;
    private const uint PDH_FMT_DOUBLE_NOCAP = 0x00008200;
    private static IntPtr _q = IntPtr.Zero;
    private static IntPtr _pct = IntPtr.Zero;
    private static IntPtr _id = IntPtr.Zero;
    public static string Error = "";

    public static bool Init()
    {
        uint r = PdhOpenQueryW(IntPtr.Zero, IntPtr.Zero, out _q);
        if (r != 0) { Error = "open:" + r; return false; }
        r = PdhAddEnglishCounterW(_q, "\\Process(*)\\% Processor Time", IntPtr.Zero, out _pct);
        if (r != 0) { Error = "addpct:" + r; return false; }
        r = PdhAddEnglishCounterW(_q, "\\Process(*)\\ID Process", IntPtr.Zero, out _id);
        if (r != 0) { Error = "addid:" + r; return false; }
        PdhCollectQueryData(_q);
        return true;
    }

    private sealed class Row
    {
        public System.Collections.Generic.List<string> Names = new System.Collections.Generic.List<string>(400);
        public System.Collections.Generic.List<double> Values = new System.Collections.Generic.List<double>(400);
    }

    private static Row Read(IntPtr counter)
    {
        Row row = new Row();
        uint size = 0;
        uint count = 0;
        uint r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE_NOCAP, ref size, out count, IntPtr.Zero);
        for (int attempt = 0; attempt < 5 && size > 0; attempt++)
        {
            IntPtr buf = Marshal.AllocHGlobal((int)size);
            try
            {
                uint got = 0;
                r = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE_NOCAP, ref size, out got, buf);
                if (r != 0) { Error = "fill:" + r; continue; }
                int stride = Marshal.SizeOf(typeof(ITEM));
                for (int i = 0; i < (int)got; i++)
                {
                    ITEM item = (ITEM)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + (long)i * stride), typeof(ITEM));
                    string name = Marshal.PtrToStringUni(item.Name);
                    row.Names.Add(name == null ? "" : name);
                    row.Values.Add(item.Fmt.CStatus == 0 ? item.Fmt.Value : -1.0);
                }
                return row;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        return row;
    }

    // "pid:perCorePct,pid:perCorePct,..."  (per-core scale: one saturated core = 100)
    public static string Collect()
    {
        if (_q == IntPtr.Zero) return "";
        PdhCollectQueryData(_q);
        Row pct = Read(_pct);
        Row ids = Read(_id);
        if (pct.Names.Count != ids.Names.Count) { Error = "count-mismatch:" + pct.Names.Count + "/" + ids.Names.Count; }
        StringBuilder sb = new StringBuilder(8192);
        int n = System.Math.Min(pct.Names.Count, ids.Names.Count);
        int orderMismatch = 0;
        for (int i = 0; i < n; i++)
        {
            if (!string.Equals(pct.Names[i], ids.Names[i], StringComparison.Ordinal)) orderMismatch++;
            if (pct.Names[i].Length == 0 || pct.Values[i] < 0) continue;
            if (string.Equals(pct.Names[i], "_Total", StringComparison.OrdinalIgnoreCase)) continue;
            long pid = (long)ids.Values[i];
            if (pid <= 0) continue;
            sb.Append(pid).Append(':').Append(pct.Values[i].ToString("F2", Inv)).Append(',');
        }
        if (orderMismatch > 0) { Error = "instance-order-mismatch:" + orderMismatch + "/" + n; }
        return sb.ToString();
    }

    private static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;
}

public static class PerfSampler
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr hProcess, out long lpCreationTime,
        out long lpExitTime, out long lpKernelTime, out long lpUserTime);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out long lpIdleTime, out long lpKernelTime, out long lpUserTime);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const long FILETIME_UNIX_EPOCH_MS = 11644473600000L;
    private static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;
    private static PerformanceCounter _pc = null;
    public static string LastError = "";

    // Names the product can own or spawn. Only these get a CPU reading on fast ticks.
    private static readonly string[] FAST =
    {
        "powershell", "pwsh", "node", "python", "pythonw", "python3",
        "msedgewebview2", "AIDrivenNetDefense", "conhost", "cmd", "wmiprvse", "taskhostw"
    };

    private static bool FastWanted(string name)
    {
        for (int i = 0; i < FAST.Length; i++)
        {
            if (string.Equals(name, FAST[i], StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    public static bool Prime()
    {
        try
        {
            _pc = new PerformanceCounter("Processor", "% Processor Time", "_Total");
            _pc.NextValue();
        }
        catch (Exception e) { _pc = null; LastError = "pdh:" + e.Message; }
        long idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user)) return false;
        return _pc != null;
    }

    public static double TotalPct()
    {
        if (_pc == null) return -1.0;
        try { return _pc.NextValue(); }
        catch { return -1.0; }
    }

    public static string SysTimes()
    {
        long idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user)) return null;
        long total = kernel + user;
        return idle.ToString(Inv) + "," + total.ToString(Inv);
    }

    public static string Tick(bool full)
    {
        StringBuilder sb = new StringBuilder(16384);
        IntPtr snap = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snap == new IntPtr(-1))
        {
            LastError = "snapshot:" + Marshal.GetLastWin32Error();
            return null;
        }
        try
        {
            PROCESSENTRY32W pe = new PROCESSENTRY32W();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            bool ok = Process32FirstW(snap, ref pe);
            while (ok)
            {
                uint pid = pe.th32ProcessID;
                uint ppid = pe.th32ParentProcessID;
                string name = pe.szExeFile == null ? "?" : pe.szExeFile;
                if (name.Length > 4 && name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    name = name.Substring(0, name.Length - 4);
                bool wanted = full || FastWanted(name);
                double cpu = -1.0;
                long created = 0;
                if (wanted && pid != 0)
                {
                    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                    if (h != IntPtr.Zero)
                    {
                        try
                        {
                            long ct, et, kt, ut;
                            if (GetProcessTimes(h, out ct, out et, out kt, out ut))
                            {
                                cpu = (double)(kt + ut) / 10000000.0;
                                created = (ct / 10000L) - FILETIME_UNIX_EPOCH_MS;
                            }
                        }
                        finally { CloseHandle(h); }
                    }
                }
                ok = Process32NextW(snap, ref pe);
                if (!wanted) continue;
                sb.Append(pid).Append(':').Append(ppid).Append(':').Append(name).Append(':')
                  .Append(cpu < 0 ? "-1" : cpu.ToString("F3", Inv))
                  .Append(':').Append(created.ToString(Inv)).Append(',');
            }
        }
        finally { CloseHandle(snap); }
        return sb.ToString();
    }
}
'@

$added = $true
try {
  Add-Type -TypeDefinition $Source -Language CSharp -ErrorAction Stop
} catch {
  $added = $false
  Write-Output ("X|add-type|" + $_.Exception.Message.Replace("`r", " ").Replace("`n", " "))
}

if ($added) {
  $primed = [PerfSampler]::Prime()
  $pdhProcs = [PdhProcs]::Init()
  if ($Diag) {
    Write-Output ("X|diag|primed={0}|pdh={1}|err={2}" -f $primed, [PerfSampler]::TotalPct(), [PerfSampler]::LastError)
    Write-Output ("X|diag|pdhProcs={0}|pdhErr={1}" -f $pdhProcs, [PdhProcs]::Error)
    Write-Output ("X|diag|fullTickLen={0}" -f ([PerfSampler]::Tick($true)).Length)
    Write-Output ("X|diag|fastTickLen={0}" -f ([PerfSampler]::Tick($false)).Length)
  }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $nextTick = 0
  $nextPdh = 0
  $nextCim = 0
  $sysPrev = $null

  while ($true) {
    $now = $sw.ElapsedMilliseconds
    if ($now -ge $DurationMs) { break }
    $wait = $nextTick - $now
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait; $now = $sw.ElapsedMilliseconds }
    if ($now -ge $DurationMs) { break }

    $emitPdh = ($now -ge $nextPdh)
    $total = -1.0
    $busyPct = -1.0
    if ($emitPdh) {
      $total = [PerfSampler]::TotalPct()
      $sysNow = [PerfSampler]::SysTimes()
      if (($sysNow -ne $null) -and ($sysPrev -ne $null)) {
        $a = $sysNow.Split(',')
        $b = $sysPrev.Split(',')
        $idleDelta = [double]$a[0] - [double]$b[0]
        $totalDelta = [double]$a[1] - [double]$b[1]
        if ($totalDelta -gt 0) { $busyPct = 100.0 * (1.0 - ($idleDelta / $totalDelta)) }
      }
      if ($sysNow -ne $null) { $sysPrev = $sysNow }
      $nextPdh = $now + $PdhEveryMs
      if ($pdhProcs) {
        $pdhEpoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $pdhData = [PdhProcs]::Collect()
        Write-Output ("P|{0}|{1}" -f $pdhEpoch, $pdhData)
        if ([PdhProcs]::Error -ne "") { Write-Output ("X|pdh|" + [PdhProcs]::Error) }
      }
    }

    $procs = [PerfSampler]::Tick($emitPdh)
    if ($procs -eq $null) { $procs = "" }
    $epoch = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($emitPdh) {
      Write-Output ("S|{0}|{1}|{2}|{3}" -f $epoch, $total, $busyPct, $procs)
    } else {
      Write-Output ("T|{0}|{1}" -f $epoch, $procs)
    }

    if ($now -ge $nextCim) {
      $nextCim = $now + $CimEveryMs
      $rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe' OR Name='pythonw.exe'" -Property ProcessId,CommandLine)
      $ce = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      foreach ($r in $rows) {
        $cmd = ([string]$r.CommandLine) -replace '[\r\n]+', ' '
        Write-Output ("C|{0}|{1}|{2}" -f $ce, [int]$r.ProcessId, $cmd)
      }
    }

    $nextTick = $now + $IntervalMs
  }

  Write-Output ("E|{0}" -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
}
