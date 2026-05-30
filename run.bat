@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js first.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please install Node.js with npm first.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing game dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

set "PORT="
for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=5173; while ($p -lt 5200 -and (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { $p++ }; if ($p -ge 5200) { exit 1 }; $p"') do set "PORT=%%P"

if not defined PORT (
  echo No available local port was found between 5173 and 5199.
  pause
  exit /b 1
)

echo Starting The Moon Adventure at http://127.0.0.1:%PORT%
if not "%MOON_NO_BROWSER%"=="1" (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"
)
call npm run dev -- --port %PORT% --strictPort
pause
