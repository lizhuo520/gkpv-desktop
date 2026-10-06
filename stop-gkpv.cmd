@echo off
chcp 65001 >nul
rem Stop the local gkpv server (whatever listens on port 8777).
set "PORT=8777"
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  taskkill /f /pid %%a >nul 2>&1
  set FOUND=1
)
if "%FOUND%"=="1" (echo gkpv server stopped.) else (echo gkpv server was not running.)
timeout /t 3 /nobreak >nul
exit /b 0
