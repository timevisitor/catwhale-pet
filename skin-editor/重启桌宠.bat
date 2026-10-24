@echo off
cd /d "%~dp0"
echo 正在重启猫鲸桌宠（桌宠位置和聊天记录都会保留）...
python "%~dp0restart_pet.py"
if errorlevel 1 (
  echo.
  echo 自动重启失败。请手动：托盘右键退出桌宠，再双击 dist\桌宠\桌宠.exe
  pause
)
