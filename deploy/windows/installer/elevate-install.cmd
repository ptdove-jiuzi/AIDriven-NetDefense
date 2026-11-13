@echo off
chcp 936 >nul
setlocal DisableDelayedExpansion
rem ===========================================================================
rem AIDriven NetDefense - elevated install / uninstall launcher
rem Author: PT-dove
rem
rem Use this when the target folder needs administrator rights, e.g.
rem   C:\Program Files\AIDriven Net Defense
rem
rem Double-click it (or run it from a shell) and approve the single UAC prompt.
rem The work itself is done by elevate-install.ps1 next to this file:
rem   1. checks whether this process is elevated;
rem   2. if not, asks Windows for ONE UAC consent and re-runs itself elevated;
rem   3. installs /S into the target, then checks install.json, the uninstall
rem      entry, /healthz, and finally uninstalls and verifies nothing is left.
rem No elevation, no install: if the prompt is dismissed the script exits 8 and
rem nothing has been written.
rem
rem Usage:
rem   elevate-install.cmd                          install into %ProgramFiles%\AIDriven Net Defense
rem   elevate-install.cmd -Dir "D:\AIDN"           install into another folder
rem   elevate-install.cmd -Setup "<path to Setup.exe>"
rem   elevate-install.cmd -Uninstall -Dir "..."    uninstall + verify only
rem   elevate-install.cmd -DryRun                  print the plan, no UAC, no install
rem   elevate-install.cmd -NoRelaunch              prove the refusal branch (exit 7)
rem
rem Set AIDN_NO_PAUSE=1 in the environment to skip the "press any key" at the end.
rem ===========================================================================

set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

if not exist "%HERE%\elevate-install.ps1" (
    echo [ERROR] elevate-install.ps1 not found next to this file.
    echo         Extract the whole folder, do not move the .cmd alone.
    if not defined AIDN_NO_PAUSE pause
    exit /b 2
)

echo ===========================================================================
echo  AIDriven NetDefense - elevated install / uninstall
echo  A single UAC prompt will be shown if administrator rights are needed.
echo  Exit codes: 0 ok, 1 a check failed, 2 bad usage, 7 not elevated,
echo              8 UAC prompt cancelled.
echo ===========================================================================
echo.

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%\elevate-install.ps1" %*
set "CODE=%ERRORLEVEL%"

echo.
echo [exit] %CODE%
if not defined AIDN_NO_PAUSE pause
exit /b %CODE%
