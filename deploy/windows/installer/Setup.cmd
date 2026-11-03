@echo off
setlocal DisableDelayedExpansion
rem AIDriven NetDefense - Windows x64 test installer launcher
rem Author: PT-dove
rem
rem Usage:
rem   Setup.cmd                      GUI install / upgrade (always reuses the detected path)
rem   Setup.cmd /uninstall           GUI uninstall
rem   Setup.cmd /S /DIR="D:\path"    silent install
rem   Setup.cmd /S /uninstall /DIR="D:\path"
rem   add /NOREG to skip the uninstall registry key (used by the smoke test)
rem   add /NOSHORTCUT to skip Start Menu / desktop shortcuts
rem   add /AUTOSTART to also register the optional HKCU Run entry (off by default)
rem
rem This build is unsigned. Windows SmartScreen may show "unknown publisher".
rem That is expected for the test channel; it is not an installer failure.

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

if not exist "%HERE%\Setup.ps1" (
    echo [ERROR] Setup.ps1 not found next to Setup.cmd.
    echo         Extract the whole archive, do not move Setup.cmd alone.
    pause
    exit /b 2
)

if not exist "%HERE%\payload\bundle.json" (
    echo [ERROR] payload\bundle.json not found.
    echo         The archive is incomplete or partially extracted.
    pause
    exit /b 3
)

set "SILENT=0"
echo %* | findstr /i /c:"/S" >nul 2>&1 && set "SILENT=1"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%\Setup.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
    echo.
    echo [ERROR] Setup exited with code %CODE%.
    echo         Log: %TEMP%\AIDriven-Setup-*.log
    if "%SILENT%"=="0" pause
)
exit /b %CODE%
