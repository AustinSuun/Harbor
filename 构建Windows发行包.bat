@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
python build_windows.py
if errorlevel 1 (
  echo 构建失败，请查看日志。
) else (
  echo 构建完成，请查看 release 目录。
)
pause
endlocal
