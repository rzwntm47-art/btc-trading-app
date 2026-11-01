@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the current Node.js LTS from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node desktop.cjs
pause
