@echo off
rem ===========================================================================
rem AIDriven NetDefense 0.0.1-rc.5 - real-machine installation acceptance
rem Author: PT-dove
rem
rem Double-click this file. Exactly ONE UAC prompt appears and it is requested from
rem inside the acceptance driver (accept-rc5.ps1 self-relaunches with
rem Start-Process -Verb RunAs), the same mechanism the rc.4 acceptance used. The
rem elevated session only installs, checks and uninstalls; every browser step and the
rem dry run stay in this non-elevated process, because rc.4 lost a whole run to
rem spawning headless Edge from the elevated window (ACTIVE-NOTICE N-028).
rem
rem Full sequence (see docs\implementation\evidence\rc5\accept\run-all-rc5.ps1):
rem   A baseline snapshot (read-only)
rem   B non-elevated dry run in %TEMP%: /S /DIR=<tmp> /AUTOSTART /NOREG
rem     -> 4 checks -> uninstall through the tree-internal copy -> tree gone
rem     (a dry-run failure stops here WITHOUT spending the UAC prompt)
rem   C ONE UAC: /S /DIR="$ProgramFiles\AIDriven Net Defense" /AUTOSTART
rem     -> 1 tree -> 2 install.json incl. the rc.5 ownership credential (64 hex)
rem     -> 3 uninstall entry (QuietUninstallString -> tree-internal exe)
rem     -> 4 /healthz 200 with the status recorded verbatim
rem     -> then the driver WAITS, so this process can load the six pages in headless
rem        Edge (zh + ?lang=en&static=1), copy the tree for the anti-misfire test,
rem        and release the handshake
rem     -> silent uninstall through the registered QuietUninstallString -> zero residue
rem   D anti-misfire on the copied tree: ownership removed / forged -> must REFUSE and
rem     leave the tree intact; ownership restored -> must uninstall successfully
rem
rem Results: docs\implementation\evidence\rc5\accept\run-<timestamp>\
rem          RUN-RESULT.json / SUMMARY.json / per-phase directories
rem A cmd-level receipt (start, end, elapsed, exit code, Setup hash) is written to
rem docs\implementation\evidence\rc5\accept\cmd-receipt-<timestamp>.log
rem ===========================================================================
setlocal DisableDelayedExpansion
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
for %%i in ("%HERE%\..\..\..\..") do set "REPO=%%~fi"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

set "RUNDIR=%REPO%\docs\implementation\evidence\rc5\accept"
set "DRIVER=%RUNDIR%\run-all-rc5.ps1"
set "SETUP=%REPO%\dist\release\0.0.1-rc.5\AIDrivenNetDefense-Setup-0.0.1-rc.5.exe"

if not exist "%DRIVER%" (
    echo [ERROR] acceptance driver not found: "%DRIVER%"
    if not defined AIDN_NO_PAUSE pause
    exit /b 2
)
if not exist "%SETUP%" (
    echo [ERROR] rc.5 Setup.exe not found: "%SETUP%"
    echo         Wait for the rc.5 release build to finish, then run this file again.
    echo         Nothing was installed.
    if not defined AIDN_NO_PAUSE pause
    exit /b 2
)

rem Timestamp + duration are taken from PowerShell: %DATE%/%TIME% differ per locale
rem (this host is zh-CN) and would make the receipt unparseable.
rem `for /f ... in ('... "quoted cmd" ...')` breaks on the doubled quotes (measured:
rem the first run produced an empty STAMP and wrote "cmd-receipt-.log"), so the value is
rem written to a file and read back with set /p instead.
"%PS%" -NoProfile -Command "(Get-Date).ToString('yyyyMMdd-HHmmss')" > "%TEMP%\rc5-accept-stamp.txt"
set "STAMP="
set /p STAMP=<"%TEMP%\rc5-accept-stamp.txt"
del "%TEMP%\rc5-accept-stamp.txt" >nul 2>&1
if not defined STAMP set "STAMP=unknown"
set "RECEIPT=%RUNDIR%\cmd-receipt-%STAMP%.log"
set "STARTFILE=%TEMP%\rc5-accept-start-%STAMP%.txt"
set "ENDFILE=%TEMP%\rc5-accept-end-%STAMP%.txt"

echo ===========================================================================
echo  AIDriven NetDefense 0.0.1-rc.5 - installation acceptance
echo  ONE UAC prompt. dry run -^> install -^> 4 checks -^> 6 pages zh/en
echo  -^> silent uninstall through the registered tree-internal exe -^> zero residue
echo  -^> anti-misfire on a copy of the real tree.
echo  Expect 25-40 minutes. Leave this window open.
echo ===========================================================================
echo.

"%PS%" -NoProfile -Command "(Get-Date).ToString('o')" > "%STARTFILE%"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%DRIVER%" -Setup "%SETUP%" -Version 0.0.1-rc.5 %*
set "CODE=%ERRORLEVEL%"
"%PS%" -NoProfile -Command "(Get-Date).ToString('o')" > "%ENDFILE%"

rem The whole receipt is written by one PowerShell call: ISO timestamps, elapsed seconds,
rem exit code and the Setup hash, all locale-proof (%DATE%/%TIME% are not).
set "RC5_SETUP=%SETUP%"
set "RC5_DRIVER=%DRIVER%"
set "RC5_RECEIPT=%RECEIPT%"
set "RC5_CODE=%CODE%"
set "RC5_STARTFILE=%STARTFILE%"
set "RC5_ENDFILE=%ENDFILE%"
"%PS%" -NoProfile -Command "try { $s=[datetime]::Parse((Get-Content -Raw '%STARTFILE%').Trim()); $e=[datetime]::Parse((Get-Content -Raw '%ENDFILE%').Trim()); $fs=[System.IO.File]::OpenRead($env:RC5_SETUP); try { $h=[System.BitConverter]::ToString((New-Object System.Security.Cryptography.SHA256Managed).ComputeHash($fs)).Replace('-','').ToLower() } finally { $fs.Dispose() }; $lines=@('cmd-receipt-start=' + $s.ToString('o'), 'cmd-receipt-end=' + $e.ToString('o'), 'elapsed_seconds=' + [math]::Round(($e-$s).TotalSeconds,1), 'exit=' + $env:RC5_CODE, 'setup=' + $env:RC5_SETUP, 'setup_bytes=' + (Get-Item -LiteralPath $env:RC5_SETUP).Length, 'setup_sha256=' + $h, 'driver=' + $env:RC5_DRIVER, 'user=' + [Security.Principal.WindowsIdentity]::GetCurrent().Name, 'powershell=' + $PSVersionTable.PSVersion.ToString() + ' ' + $PSVersionTable.PSEdition); Set-Content -LiteralPath $env:RC5_RECEIPT -Value $lines -Encoding UTF8 } catch { Set-Content -LiteralPath $env:RC5_RECEIPT -Value ('receipt-error=' + $_.Exception.Message + ' start=' + $env:RC5_STARTFILE + ' end=' + $env:RC5_ENDFILE + ' exit=' + $env:RC5_CODE) -Encoding UTF8 }" 2>nul
del "%STARTFILE%" >nul 2>&1
del "%ENDFILE%" >nul 2>&1

echo.
echo [exit] %CODE%
echo [receipt] %RECEIPT%
echo [results] %RUNDIR%\run-*
if not defined AIDN_NO_PAUSE pause
exit /b %CODE%
