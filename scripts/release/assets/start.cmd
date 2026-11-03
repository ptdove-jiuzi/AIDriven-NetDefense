@echo off
setlocal DisableDelayedExpansion
rem AIDriven NetDefense portable launcher (pre-release, author PT-dove).
rem Every path is derived from this file's own location, so the package can be
rem extracted to any directory (spaces, non-ASCII, another drive).
rem No PATH lookup for the runtime, no registry, no service, no ProgramData.

for %%I in ("%~dp0.") do set "AIDND_ROOT=%%~fI"
if not defined AIDND_ROOT ( echo [start] cannot resolve package root 1>&2 & exit /b 92 )

set "AIDND_NODE=%AIDND_ROOT%\runtime\node\node.exe"
if not exist "%AIDND_NODE%" ( echo [start] bundled runtime missing: "%AIDND_NODE%" 1>&2 & exit /b 90 )

rem The package must not be instrumented from outside: clear the Node and proxy
rem variables the launch plan declares as cleared before starting the launcher.
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE_EXTRA_CA_CERTS="
set "NODE_TLS_REJECT_UNAUTHORIZED="
set "NODE_V8_COVERAGE="
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "npm_config_registry="

"%AIDND_NODE%" "%AIDND_ROOT%\launcher\aidnd-launch.mjs" %*
set "AIDND_EXIT=%ERRORLEVEL%"
if not "%AIDND_EXIT%"=="0" echo [start] launcher exited with code %AIDND_EXIT% 1>&2
exit /b %AIDND_EXIT%
