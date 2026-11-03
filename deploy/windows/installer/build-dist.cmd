@echo off
setlocal EnableExtensions
rem Build the Windows x64 test package.
rem Author: PT-dove
rem
rem Usage: build-dist.cmd [payload-dir] [output-root]
rem Default payload: <repo>\vendor\payloads\win32-x64-v14  (v14 bundle: daemon + console)
rem Default output : <repo>\dist\installer
rem
rem Both defaults are derived from this script location (%~dp0), so the tree
rem stays relocatable: no absolute path is hard-coded here.
rem Pass the arguments explicitly to build from another payload (for example a
rem bundle that has not been migrated into vendor\payloads yet).
rem
rem v13 (kind=packaging-poc) is no longer accepted: it has no desktop entry point,
rem so the shortcuts would have nothing to launch.

set "REPO=%~dp0..\..\.."
for %%I in ("%REPO%") do set "REPO=%%~fI"

set "PAYLOAD=%~1"
if "%PAYLOAD%"=="" set "PAYLOAD=%REPO%\vendor\payloads\win32-x64-v14"
set "OUTROOT=%~2"
if "%OUTROOT%"=="" set "OUTROOT=%REPO%\dist\installer"

set "VER=0.0.1-rc.1"
set "NAME=%VER%"
set "OUT=%OUTROOT%\%NAME%"
set "SEVENZ=%ProgramFiles%\7-Zip\7z.exe"
set "DESKTOP_EXE=AIDrivenNetDefense.exe"

if not exist "%PAYLOAD%\bundle.json" (
    echo [ERROR] payload not found: %PAYLOAD%
    echo         the v14 bundle may not be migrated yet;
    echo         pass the payload dir as argument 1, e.g.
    echo             build-dist.cmd D:\path\to\aegis-embedded-win32-x64-v14
    exit /b 2
)

rem The desktop exe may sit at the bundle root or one level down.
set "HAVEEXE="
if exist "%PAYLOAD%\%DESKTOP_EXE%" set "HAVEEXE=1"
if exist "%PAYLOAD%\app\%DESKTOP_EXE%" set "HAVEEXE=1"
if exist "%PAYLOAD%\console\%DESKTOP_EXE%" set "HAVEEXE=1"
if exist "%PAYLOAD%\bin\%DESKTOP_EXE%" set "HAVEEXE=1"
if exist "%PAYLOAD%\app\console\%DESKTOP_EXE%" set "HAVEEXE=1"
if exist "%PAYLOAD%\app\bin\%DESKTOP_EXE%" set "HAVEEXE=1"
if not defined HAVEEXE (
    echo [ERROR] %DESKTOP_EXE% not found under %PAYLOAD%
    echo         this looks like a v13 packaging-poc payload; the installer needs
    echo         the v14 desktop bundle ^(daemon + console^) so shortcuts can point
    echo         at a real program.
    exit /b 3
)

echo [1/5] preparing %OUT%
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%" 2>nul

echo [2/5] copying payload (this takes a while)
robocopy "%PAYLOAD%" "%OUT%\payload" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
    echo [ERROR] robocopy failed with %ERRORLEVEL%
    exit /b 4
)

echo [3/5] copying installer files
copy /y "%~dp0Setup.cmd" "%OUT%\Setup.cmd" >nul
copy /y "%~dp0Setup.ps1" "%OUT%\Setup.ps1" >nul
copy /y "%~dp0SelfCheck.mjs" "%OUT%\SelfCheck.mjs" >nul
if exist "%~dp0INSTALL.txt" copy /y "%~dp0INSTALL.txt" "%OUT%\INSTALL.txt" >nul

echo [4/5] writing SHA256SUMS.txt
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$out='%OUT%'; $items=@('Setup.cmd','Setup.ps1','SelfCheck.mjs','payload\bundle.json','payload\manifests\files.sha256'); $lines=foreach($i in $items){ $p=Join-Path $out $i; if(Test-Path -LiteralPath $p){ $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower(); '{0}  {1}' -f $h,$i } }; $lines | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS.txt') -Encoding ASCII; $lines"

echo [5/5] packing 7z
if exist "%SEVENZ%" (
    if exist "%OUTROOT%\%NAME%.7z" del /q "%OUTROOT%\%NAME%.7z"
    "%SEVENZ%" a -t7z -mx=3 -mmt=on "%OUTROOT%\%NAME%.7z" "%OUT%\*" >nul
    if errorlevel 1 echo [WARN] 7z packing failed, folder is still usable
) else (
    echo [WARN] 7z not found, skipping archive
)

echo.
echo done: %OUT%
if exist "%OUTROOT%\%NAME%.7z" echo archive: %OUTROOT%\%NAME%.7z
exit /b 0
