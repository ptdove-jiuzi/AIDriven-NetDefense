@echo off
setlocal DisableDelayedExpansion
rem AIDriven NetDefense portable stopper (pre-release, author PT-dove).
rem Asks the running launcher to shut down over loopback, waits for it, and
rem reports whether any process was left behind. Safe to run when nothing is up.

for %%I in ("%~dp0.") do set "AIDND_ROOT=%%~fI"
if not defined AIDND_ROOT ( echo [stop] cannot resolve package root 1>&2 & exit /b 92 )

set "AIDND_NODE=%AIDND_ROOT%\runtime\node\node.exe"
if not exist "%AIDND_NODE%" ( echo [stop] bundled runtime missing: "%AIDND_NODE%" 1>&2 & exit /b 90 )

set "NODE_OPTIONS="
set "NODE_PATH="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="

"%AIDND_NODE%" "%AIDND_ROOT%\launcher\aidnd-stop.mjs" %*
set "AIDND_EXIT=%ERRORLEVEL%"
exit /b %AIDND_EXIT%
