@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo 正在启动错题练习...
echo 练习数据保存在 data\user_state.json，关闭服务不会丢失。
echo 关闭服务请双击同目录下的 stop.bat
echo.
python server.py
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Python，并可将 python 加入 PATH。
  pause
)
