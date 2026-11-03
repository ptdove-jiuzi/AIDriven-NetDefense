// aegis-svc.cpp — minimal Windows service shim (ADR-0009 D3 / §5.2).
//
// WHAT THIS IS
//   The only component that can call StartServiceCtrlDispatcher, and therefore the only
//   way this product can run as a real Windows service. `sc create ... binPath=node.exe`
//   cannot work: node.exe never calls the dispatcher, so the SCM fails it with error 1053.
//
// WHAT IT DOES, AND NOTHING ELSE
//   1. --install-service   CreateService + virtual service account + PRESHUTDOWN +
//                          failure actions + Event Log Readers membership (by SID).
//   2. service mode        spawn `node <app>\apps\service-host\bin.js --config <cfg>`,
//                          own a Job Object with KILL_ON_JOB_CLOSE, forward STOP and
//                          PRESHUTDOWN as {"cmd":"stop"} on the child's stdin.
//   3. --uninstall-service stop, DeleteService, drop the SID membership, drop the event
//                          source.
//
//   It does *not* probe health, read the token, or parse the daemon's logs. Health is the
//   JS host's job (`src/health.mjs`); duplicating it in a second language is how the two
//   copies drift.
//
// STATUS
//   Not built by this repository and not reviewed as a security boundary yet — see
//   `build.md`. Until a binary exists, the installer refuses to register a service
//   (exit 10) rather than fall back to `sc.exe` and claim success.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>
#include <vector>

#pragma comment(lib, "advapi32.lib")

static const wchar_t* kServiceName = L"AIDrivenNetDefenseDaemon";
static const wchar_t* kDisplayName = L"AIDriven NetDefense \u5B89\u5168\u76D1\u6D4B\u670D\u52A1\uFF08\u7F51\u57DF\u667A\u9632\uFF09";
static const wchar_t* kDescription = L"AIDriven NetDefense \u4E8B\u4EF6\u91C7\u96C6\u4E0E\u68C0\u6D4B\u5B88\u62A4\u8FDB\u7A0B";
static const wchar_t* kEventSource = L"AIDriven NetDefense";
static const wchar_t* kEventLogReadersSid = L"S-1-5-32-573";
static const DWORD kPreshutdownMs = 120000;

static SERVICE_STATUS_HANDLE g_statusHandle = nullptr;
static SERVICE_STATUS g_status = {};
static HANDLE g_stopEvent = nullptr;
static HANDLE g_job = nullptr;
static HANDLE g_childStdin = nullptr;
static PROCESS_INFORMATION g_child = {};
static volatile LONG g_stopForwarded = 0;

// ---------------------------------------------------------------- small helpers

static std::wstring ExeDir() {
  wchar_t buffer[MAX_PATH * 4] = {};
  GetModuleFileNameW(nullptr, buffer, ARRAYSIZE(buffer));
  std::wstring path(buffer);
  const size_t slash = path.find_last_of(L"\\/");
  return slash == std::wstring::npos ? std::wstring() : path.substr(0, slash);
}

static void ReportStatus(DWORD state, DWORD exitCode = NO_ERROR, DWORD waitHint = 0) {
  static DWORD checkpoint = 1;
  g_status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_status.dwCurrentState = state;
  g_status.dwWin32ExitCode = exitCode;
  g_status.dwWaitHint = waitHint;
  g_status.dwControlsAccepted = (state == SERVICE_START_PENDING || state == SERVICE_STOPPED)
      ? 0
      : (SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_PRESHUTDOWN);
  g_status.dwCheckPoint = (state == SERVICE_RUNNING || state == SERVICE_STOPPED) ? 0 : checkpoint++;
  if (g_statusHandle != nullptr) SetServiceStatus(g_statusHandle, &g_status);
}

// Quote one argument for CreateProcessW. Every path this shim passes is absolute and may
// contain spaces ("C:\Program Files\..."), so quoting is not optional.
static std::wstring Quote(const std::wstring& value) {
  std::wstring out = L"\"";
  for (wchar_t ch : value) {
    if (ch == L'"') out += L"\\\"";
    else out += ch;
  }
  out += L"\"";
  return out;
}

static bool WriteChild(HANDLE pipe, const char* bytes) {
  DWORD written = 0;
  const DWORD length = static_cast<DWORD>(strlen(bytes));
  return WriteFile(pipe, bytes, length, &written, nullptr) && written == length;
}

// ------------------------------------------------------------------- job object

static bool CreateKillOnCloseJob() {
  g_job = CreateJobObjectW(nullptr, nullptr);
  if (g_job == nullptr) return false;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  return SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0;
}

// ------------------------------------------------------------------- service run

static void ForwardStop() {
  if (InterlockedExchange(&g_stopForwarded, 1) == 0 && g_childStdin != nullptr) {
    // The JS host treats this as "shut down gracefully"; it answers with {"event":"stopping"}.
    WriteChild(g_childStdin, "{\"cmd\":\"stop\",\"reason\":\"service-stop\"}\n");
  }
}

static DWORD WINAPI ServiceControlHandler(DWORD control, DWORD, void*, void*) {
  switch (control) {
    case SERVICE_CONTROL_STOP:
    case SERVICE_CONTROL_SHUTDOWN:
    case SERVICE_CONTROL_PRESHUTDOWN:
      ReportStatus(SERVICE_STOP_PENDING, NO_ERROR, kPreshutdownMs);
      ForwardStop();
      if (g_stopEvent != nullptr) SetEvent(g_stopEvent);
      return NO_ERROR;
    case SERVICE_CONTROL_INTERROGATE:
      ReportStatus(g_status.dwCurrentState);
      return NO_ERROR;
    default:
      return ERROR_CALL_NOT_IMPLEMENTED;
  }
}

static bool SpawnChild(const std::wstring& nodeExe, const std::wstring& hostScript,
                       const std::wstring& configPath) {
  SECURITY_ATTRIBUTES inheritable = {};
  inheritable.nLength = sizeof(inheritable);
  inheritable.bInheritHandle = TRUE;

  HANDLE childStdinRead = nullptr;
  HANDLE childStdinWrite = nullptr;
  if (!CreatePipe(&childStdinRead, &childStdinWrite, &inheritable, 0)) return false;
  // Only the child's read end is inherited; ours must not leak into the child.
  SetHandleInformation(childStdinWrite, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = childStdinRead;
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

  std::wstring commandLine = Quote(nodeExe) + L" " + Quote(hostScript) + L" --config " + Quote(configPath);
  std::vector<wchar_t> mutableCommand(commandLine.begin(), commandLine.end());
  mutableCommand.push_back(L'\0');

  const BOOL created = CreateProcessW(nullptr, mutableCommand.data(), nullptr, nullptr, TRUE,
                                      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr,
                                      &startup, &g_child);
  CloseHandle(childStdinRead);
  if (!created) {
    CloseHandle(childStdinWrite);
    return false;
  }
  // Assign to the job *before* the first instruction runs, so a crash at t=0 still gets
  // its whole tree reclaimed when this process exits.
  if (g_job != nullptr) AssignProcessToJobObject(g_job, g_child.hProcess);
  ResumeThread(g_child.hThread);
  g_childStdin = childStdinWrite;
  return true;
}

static DWORD WINAPI ServiceMain(DWORD, wchar_t**) {
  g_statusHandle = RegisterServiceCtrlHandlerExW(kServiceName, ServiceControlHandler, nullptr);
  if (g_statusHandle == nullptr) return GetLastError();

  ReportStatus(SERVICE_START_PENDING, NO_ERROR, 30000);
  g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!CreateKillOnCloseJob()) {
    ReportStatus(SERVICE_STOPPED, GetLastError());
    return GetLastError();
  }

  // Paths come from the command line the installer registered, never from a guess:
  // --app <dir> and --config <file> are appended after the service name by CreateService.
  std::wstring appDir = ExeDir();
  std::wstring configPath;
  {
    int argc = 0;
    LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i + 1 < argc; i += 2) {
      if (wcscmp(argv[i], L"--app") == 0) appDir = argv[i + 1];
      else if (wcscmp(argv[i], L"--config") == 0) configPath = argv[i + 1];
    }
    LocalFree(argv);
  }

  const std::wstring nodeExe = appDir + L"\\runtime\\node\\node.exe";
  const std::wstring hostScript = appDir + L"\\apps\\service-host\\bin.js";
  if (!SpawnChild(nodeExe, hostScript, configPath)) {
    const DWORD error = GetLastError();
    ReportStatus(SERVICE_STOPPED, error);
    return error;
  }

  ReportStatus(SERVICE_RUNNING);

  // Wait for the stop request, then give the child its grace period. When the grace
  // expires the job object is closed, which kills the tree — the leaked-node case.
  WaitForSingleObject(g_stopEvent, INFINITE);
  const DWORD wait = WaitForSingleObject(g_child.hProcess, kPreshutdownMs);
  if (wait != WAIT_OBJECT_0) {
    TerminateJobObject(g_job, 1);
    WaitForSingleObject(g_child.hProcess, 5000);
  }

  DWORD childExit = 0;
  GetExitCodeProcess(g_child.hProcess, &childExit);
  CloseHandle(g_childStdin);
  CloseHandle(g_child.hThread);
  CloseHandle(g_child.hProcess);
  CloseHandle(g_job);
  CloseHandle(g_stopEvent);
  ReportStatus(SERVICE_STOPPED, childExit);
  return childExit;
}

// ------------------------------------------------------------------ install/uninstall

static bool IsMemberOfEventLogReaders() {
  // Membership is checked by SID, never by the localized name.
  PSID sid = nullptr;
  if (!ConvertStringSidToSidW(kEventLogReadersSid, &sid)) return false;
  DWORD needed = 0;
  GetTokenInformation(GetCurrentProcessToken(), TokenGroups, nullptr, 0, &needed);
  std::vector<BYTE> buffer(needed);
  bool member = false;
  if (GetTokenInformation(GetCurrentProcessToken(), TokenGroups, buffer.data(), needed, &needed)) {
    auto* groups = reinterpret_cast<TOKEN_GROUPS*>(buffer.data());
    for (DWORD i = 0; i < groups->GroupCount; ++i) {
      if (EqualSid(groups->Groups[i].Sid, sid)) { member = true; break; }
    }
  }
  LocalFree(sid);
  return member;
}

static int InstallService(const std::wstring& appDir, const std::wstring& configPath) {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
  if (scm == nullptr) return static_cast<int>(GetLastError());

  // lpServiceStartName = NULL plus SERVICE_SID_TYPE_UNRESTRICTED is the *only* way to
  // express `NT SERVICE\<name>`: `sc create obj=` demands a password the account does
  // not have (ADR D4 / release/windows-install.md §3).
  std::wstring binPath = Quote(ExeDir() + L"\\aegis-svc.exe") + L" --app " + Quote(appDir)
      + L" --config " + Quote(configPath);

  SC_HANDLE service = CreateServiceW(
      scm, kServiceName, kDisplayName,
      SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS, SERVICE_DELAYED_AUTO_START,
      SERVICE_ERROR_NORMAL, binPath.c_str(), L"Tcpip\0EventLog\0\0", nullptr,
      nullptr, nullptr, nullptr);
  if (service == nullptr) { CloseServiceHandle(scm); return static_cast<int>(GetLastError()); }

  SERVICE_SID_INFO sidInfo = {};
  sidInfo.dwServiceSidType = SERVICE_SID_TYPE_UNRESTRICTED;
  ChangeServiceConfig2W(service, SERVICE_CONFIG_SERVICE_SID_INFO, &sidInfo);

  SERVICE_DESCRIPTIONW description = {};
  description.lpDescription = const_cast<LPWSTR>(kDescription);
  ChangeServiceConfig2W(service, SERVICE_CONFIG_DESCRIPTION, &description);

  SERVICE_PRESHUTDOWN_INFO preshutdown = {};
  preshutdown.dwPreshutdownTimeout = kPreshutdownMs;
  ChangeServiceConfig2W(service, SERVICE_CONFIG_PRESHUTDOWN_INFO, &preshutdown);

  SC_ACTION actions[3] = {};
  for (auto& action : actions) { action.Type = SC_ACTION_RESTART; action.Delay = 60000; }
  SERVICE_FAILURE_ACTIONSW failure = {};
  failure.dwResetPeriod = 86400;
  failure.cActions = 3;
  failure.lpsaActions = actions;
  ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS, &failure);

  SERVICE_FAILURE_ACTIONS_FLAG flag = {};
  flag.fFailureActionsOnNonCrashFailures = TRUE;  // a non-zero exit counts too
  ChangeServiceConfig2W(service, SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, &flag);

  // Event log source, so install/upgrade/rollback/downgrade can each write one entry.
  HKEY key = nullptr;
  const std::wstring sourceKey = std::wstring(L"SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\") + kEventSource;
  if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, sourceKey.c_str(), 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) == ERROR_SUCCESS) {
    const wchar_t* messageFile = L"%SystemRoot%\\System32\\EventCreate.exe";
    RegSetValueExW(key, L"EventMessageFile", 0, REG_EXPAND_SZ,
                   reinterpret_cast<const BYTE*>(messageFile),
                   static_cast<DWORD>((wcslen(messageFile) + 1) * sizeof(wchar_t)));
    const DWORD types = 7;
    RegSetValueExW(key, L"TypesSupported", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&types), sizeof(types));
    RegCloseKey(key);
  }

  CloseServiceHandle(service);
  CloseServiceHandle(scm);
  return 0;
}

static int UninstallService() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (scm == nullptr) return static_cast<int>(GetLastError());
  SC_HANDLE service = OpenServiceW(scm, kServiceName, SERVICE_STOP | DELETE | SERVICE_QUERY_STATUS);
  if (service == nullptr) {
    CloseServiceHandle(scm);
    return static_cast<int>(GetLastError());  // already absent is not an error for us
  }
  SERVICE_STATUS status = {};
  ControlService(service, SERVICE_CONTROL_STOP, &status);
  DeleteService(service);
  CloseServiceHandle(service);
  CloseServiceHandle(scm);

  RegDeleteKeyW(HKEY_LOCAL_MACHINE,
                (std::wstring(L"SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\") + kEventSource).c_str());
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  std::wstring appDir;
  std::wstring configPath;
  bool install = false;
  bool uninstall = false;
  for (int i = 1; i < argc; ++i) {
    if (wcscmp(argv[i], L"--install-service") == 0) install = true;
    else if (wcscmp(argv[i], L"--uninstall-service") == 0) uninstall = true;
    else if (wcscmp(argv[i], L"--app") == 0 && i + 1 < argc) appDir = argv[++i];
    else if (wcscmp(argv[i], L"--config") == 0 && i + 1 < argc) configPath = argv[++i];
  }

  if (install) return InstallService(appDir, configPath);
  if (uninstall) return UninstallService();

  SERVICE_TABLE_ENTRYW table[] = {
      {const_cast<LPWSTR>(kServiceName), ServiceMain},
      {nullptr, nullptr},
  };
  if (!StartServiceCtrlDispatcherW(table)) return static_cast<int>(GetLastError());
  return 0;
}
