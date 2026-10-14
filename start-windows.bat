@echo off
rem Double-click to start TCGBot on Windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org, install it, then run this again.
  pause
  exit /b 1
)
if not exist "node_modules\playwright" (
  echo First run: installing TCGBot's browser automation. This takes a minute...
  call npm run setup
  if errorlevel 1 (
    echo Setup failed. See the messages above.
    pause
    exit /b 1
  )
)
node src\index.js
pause
