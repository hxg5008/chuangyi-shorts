@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-stop.ps1" %*
set "HUOBAO_EXIT=%ERRORLEVEL%"
if not "%HUOBAO_EXIT%"=="0" pause
exit /b %HUOBAO_EXIT%
