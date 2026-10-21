@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Install Node.js 20 or newer, then reopen this BAT.
  goto failed
)
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  goto failed
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js with npm enabled.
  goto failed
)
where cargo.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Install Rust with rustup. See README.md for build requirements.
  goto failed
)
where rustup.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] rustup was not found. See README.md for build requirements.
  goto failed
)

if not exist "node_modules\typescript\bin\tsc" (
  echo [SETUP] Installing npm dependencies...
  call npm.cmd ci
  if errorlevel 1 goto failed
)
echo [SETUP] Checking the Rust WebAssembly target...
rustup target add wasm32-unknown-unknown
if errorlevel 1 goto failed

echo [BUILD] Updating the game...
call npm.cmd run build
if errorlevel 1 goto failed

echo [SETUP] Checking Windows Firewall permissions for the game...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-firewall.ps1"
if errorlevel 1 goto failed

echo [START] Starting the game and online match server. Press Ctrl+C to stop.
echo [INFO] Direct connections use this PC. Router permissions are configured separately.
node "scripts\serve.mjs" %*
if errorlevel 1 goto failed
popd
exit /b 0

:failed
echo.
echo [ERROR] Startup failed. Check the messages above.
pause
popd
exit /b 1
