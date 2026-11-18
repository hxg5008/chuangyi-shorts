@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Apply-Fix.ps1" %*
if errorlevel 1 echo Patch was not applied. Read the message above.
pause
