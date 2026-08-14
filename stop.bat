@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8765
echo.
echo 正在关闭错题练习服务（端口 %PORT%）...
echo.

set KILLED=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo 结束进程 PID=%%P
  taskkill /PID %%P /F >nul 2>&1
  if not errorlevel 1 set KILLED=1
)

REM 再清一次，防止残留
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
  set KILLED=1
)

timeout /t 1 /nobreak >nul
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul
if errorlevel 1 (
  echo 服务已关闭。
) else (
  echo 仍有进程占用端口 %PORT%，请手动结束对应 Python 窗口。
)

echo.
pause
