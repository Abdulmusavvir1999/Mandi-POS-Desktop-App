@echo off
rem Double-click this to open the Mandi POS Launcher.
rem Opening index.html directly in a browser will NOT work - there is no
rem preload bridge outside Electron, so every button reports "no bridge".
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing Electron, this only happens once...
  call npm install || goto :fail
)
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo.
echo npm install failed. Make sure Node.js is installed and you have internet access.
pause
