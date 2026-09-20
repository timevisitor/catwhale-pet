@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 桌宠 Demo 本地服务 (关闭本窗口即停止)

if not exist "index.html" (
  echo [错误] 没找到 index.html，请把本脚本放在 web 目录里运行。
  pause & exit /b 1
)

where python >nul 2>nul && set HAVE_PY=1 || set HAVE_PY=0
if "%HAVE_PY%"=="0" (
  echo [提示] 未检测到 python，直接双击 index.html 也能看效果（透明命中判定会退化为矩形）。
  start "" "index.html"
  pause & exit /b 0
)

echo 正在启动本地服务 http://127.0.0.1:8899/index.html ...
echo 浏览器会自动打开；本窗口关掉服务就停了。
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8899/index.html"
python -m http.server 8899 --bind 127.0.0.1
pause
