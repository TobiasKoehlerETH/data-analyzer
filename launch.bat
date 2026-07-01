@echo off
setlocal
cd /d "%~dp0frontend"
call npx tauri dev
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" pause
exit /b %exit_code%
