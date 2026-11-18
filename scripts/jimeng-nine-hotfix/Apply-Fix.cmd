@echo off
setlocal
set "FIX_ROOT=%~1"
if not defined FIX_ROOT set /p "FIX_ROOT=Workbench root directory: "
set "FIX_NODE=node.exe"
if exist "%FIX_ROOT%\runtime\node\node.exe" set "FIX_NODE=%FIX_ROOT%\runtime\node\node.exe"
"%FIX_NODE%" "%~dp0apply-fix.cjs" "%FIX_ROOT%"
if errorlevel 1 goto failed
echo.
echo Completed. Read the result above, then start the workbench normally.
pause
exit /b 0
:failed
echo.
echo Update was not completed. Read the error above.
pause
exit /b 1
