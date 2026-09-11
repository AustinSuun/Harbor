@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" harbor_launcher.py
) else (
  python harbor_launcher.py
)
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方提示。源码版需要先安装 Python 和项目依赖。
  pause
)
endlocal
