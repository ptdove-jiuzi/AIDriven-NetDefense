@echo off
rem ===========================================================================
rem  AIDriven NetDefense - rc.5 acceptance, ONE-CLICK entry for the user
rem
rem  Double-click this file.  It spends EXACTLY ONE Windows UAC consent prompt
rem  and nothing else: the prompt appears within a few seconds, you press "Yes",
rem  and the acceptance then runs unattended (install -> four checks -> six UI
rem  pages -> silent uninstall -> zero residue -> credential anti-misfire).
rem
rem  If the UAC dialog is ignored it is auto-denied after about two minutes and
rem  NOTHING is installed; just double-click again when you are at the machine.
rem
rem  Author: PT-dove
rem  Self-test without spending a UAC prompt:
rem      set AIDN_ENTRY_PRECHECK=1 && elevate-accept-rc5.cmd
rem ===========================================================================
setlocal EnableExtensions
title AIDriven NetDefense 0.0.1-rc.5 - acceptance (one UAC)

set "HERE=%~dp0"
for %%I in ("%HERE%..\..\..\..") do set "REPO=%%~fI"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "RUNALL=%REPO%\docs\implementation\evidence\rc5\accept\run-all-rc5.ps1"
set "ACCDIR=%REPO%\docs\implementation\evidence\rc5\accept"
set "SETUP=%REPO%\dist\release\0.0.1-rc.5\AIDrivenNetDefense-Setup-0.0.1-rc.5.exe"
set "VERSION=0.0.1-rc.5"

echo ===========================================================================
echo  AIDriven NetDefense %VERSION% - installation acceptance
echo.
echo  1. A Windows UAC consent dialog will appear in a few seconds.
echo     Press YES within about 2 minutes.  Nothing happens without it.
echo  2. Then (unattended, 10-20 minutes):
echo     install to %%ProgramFiles%%\AIDriven Net Defense
echo     -^> four checks (tree / install.json + ownership / uninstall entry / healthz)
echo     -^> six console pages in zh and en (headless Edge, non-elevated)
echo     -^> silent uninstall through the registered tree-internal uninstaller
echo     -^> zero residue check
echo     -^> credential anti-misfire test on a copy of the tree
echo  3. This window prints the verdict and writes a receipt.  Keep it open.
echo.
echo  repo:  %REPO%
echo  setup: %SETUP%
echo ===========================================================================
echo.

if not exist "%PS%" (
    echo [ERROR] Windows PowerShell 5.1 not found: %PS%
    echo [ERROR] Nothing was installed.
    goto :fail_pause
)
if not exist "%RUNALL%" (
    echo [ERROR] acceptance orchestrator not found: %RUNALL%
    echo [ERROR] Nothing was installed.
    goto :fail_pause
)
if not exist "%SETUP%" (
    echo [ERROR] rc.5 Setup not found: %SETUP%
    echo [ERROR] Nothing was installed.
    goto :fail_pause
)

rem --- timestamps without the 'for /f "quoted command"' trap -----------------
set "STAMPFILE=%TEMP%\aidn-accept-stamp.txt"
set "STARTFILE=%TEMP%\aidn-accept-start.txt"
set "ENDFILE=%TEMP%\aidn-accept-end.txt"
del /q "%STAMPFILE%" "%STARTFILE%" "%ENDFILE%" 2>nul
"%PS%" -NoProfile -Command "[IO.File]::WriteAllText('%TEMP%\aidn-accept-stamp.txt',(Get-Date).ToString('yyyyMMdd-HHmmss'))" >nul 2>&1
set "STAMP=unknown"
if exist "%STAMPFILE%" set /p STAMP=<"%STAMPFILE%"
if "%STAMP%"=="" set "STAMP=unknown"

echo [1/2] Starting the orchestrator (run-all-rc5.ps1 -SkipDryRun) at %DATE% %TIME%
echo       -> the UAC dialog appears within a few seconds: press YES now.
echo.

if /i "%AIDN_ENTRY_PRECHECK%"=="1" (
    echo [PRECHECK] all inputs exist; command that would run:
    echo   "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%RUNALL%" -SkipDryRun
    echo [PRECHECK] no UAC prompt was requested.
    goto :done_nopause
)

"%PS%" -NoProfile -Command "[IO.File]::WriteAllText('%STARTFILE%',(Get-Date).ToString('o'))" >nul 2>&1
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%RUNALL%" -SkipDryRun
set "CODE=%ERRORLEVEL%"
"%PS%" -NoProfile -Command "[IO.File]::WriteAllText('%ENDFILE%',(Get-Date).ToString('o'))" >nul 2>&1

echo.
echo [2/2] orchestrator exit code: %CODE%

rem --- receipt: newest run dir + verdict + setup hash (no Get-FileHash here) --
set "RECEIPT=%ACCDIR%\user-receipt-%STAMP%.log"
set "RC5_SETUP=%SETUP%"
set "RC5_RECEIPT=%RECEIPT%"
set "RC5_CODE=%CODE%"
set "RC5_STARTFILE=%STARTFILE%"
set "RC5_ENDFILE=%ENDFILE%"
set "RC5_ACCDIR=%ACCDIR%"
set "RC5_VERSION=%VERSION%"
"%PS%" -NoProfile -Command "try { $dir = Get-ChildItem -LiteralPath $env:RC5_ACCDIR -Directory -Filter 'run-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; $res = if ($dir) { Join-Path $dir.FullName 'RUN-RESULT.json' } else { '' }; $overall = ''; $lines = @(); if ($res -and (Test-Path -LiteralPath $res)) { $j = Get-Content -LiteralPath $res -Raw -Encoding UTF8 | ConvertFrom-Json; $overall = [string]$j.overall; foreach ($c in @($j.checks)) { $tag = if ($c.ok) { 'PASS' } else { 'FAIL' }; $lines += ('  [' + $tag + '] ' + $c.name + ' :: ' + $c.detail) } }; $fs = [IO.File]::OpenRead($env:RC5_SETUP); try { $h = [BitConverter]::ToString((New-Object System.Security.Cryptography.SHA256Managed).ComputeHash($fs)).Replace('-','').ToLower() } finally { $fs.Dispose() }; $s = [datetime]::Parse((Get-Content -Raw $env:RC5_STARTFILE).Trim()); $e = [datetime]::Parse((Get-Content -Raw $env:RC5_ENDFILE).Trim()); $out = @('user-acceptance-receipt ' + $env:RC5_VERSION, 'entry=elevate-accept-rc5.cmd', 'start=' + $s.ToString('o'), 'end=' + $e.ToString('o'), 'elapsed_seconds=' + [math]::Round(($e-$s).TotalSeconds,1), 'orchestrator_exit=' + $env:RC5_CODE, 'run_dir=' + $(if ($dir) { $dir.FullName } else { '(none)' }), 'result=' + $(if ($res) { $res } else { '(none)' }), 'overall=' + $overall, 'setup=' + $env:RC5_SETUP, 'setup_sha256=' + $h, 'uac_prompts_requested=1', 'note=blocked(uac-cancelled) means the consent dialog was not answered within about 2 minutes; nothing was installed', 'checks:'); $out += $lines; Set-Content -LiteralPath $env:RC5_RECEIPT -Value $out -Encoding UTF8 } catch { Set-Content -LiteralPath $env:RC5_RECEIPT -Value ('receipt-error=' + $_.Exception.Message + ' exit=' + $env:RC5_CODE) -Encoding UTF8 }" 2>nul

del /q "%STAMPFILE%" "%STARTFILE%" "%ENDFILE%" 2>nul

echo.
if exist "%RECEIPT%" (
    echo Receipt:
    type "%RECEIPT%"
) else (
    echo [WARN] receipt was not written; the run directory still holds RUN-RESULT.json.
)
echo.
if "%AIDN_NO_PAUSE%"=="1" goto :done_nopause
echo Press any key to close this window.
pause >nul
endlocal
exit /b %CODE%

:fail_pause
if "%AIDN_NO_PAUSE%"=="1" goto :done_nopause
pause >nul
endlocal
exit /b 2

:done_nopause
endlocal
exit /b %CODE%
