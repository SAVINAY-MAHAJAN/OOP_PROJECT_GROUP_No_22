@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
    echo Install Node.js 22.19 or newer before starting Nexora.
    exit /b 1
)
if not exist "node_modules\express\package.json" (
    call npm.cmd ci
    if errorlevel 1 exit /b 1
)
if not exist "dist\index.html" (
    call npm.cmd run build
    if errorlevel 1 exit /b 1
)
node server/start.js
exit /b %errorlevel%
