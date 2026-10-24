@echo off
cd /d "%~dp0"
set "ELEC=%~dp0..\app\node_modules\electron\dist\electron.exe"
if exist "%ELEC%" goto run
set "ELEC=%~dp0node_modules\electron\dist\electron.exe"
if exist "%ELEC%" goto run
set "ELEC=H:\hermes project\桌宠\app\node_modules\electron\dist\electron.exe"
if exist "%ELEC%" goto run
echo [错误] 找不到 Electron 运行时。
echo 位置一：%~dp0..\app\node_modules\electron\dist\electron.exe
echo 位置二：本目录 node_modules（npm install electron --save-dev）
pause
exit /b 1
:run
start "" "%ELEC%" "%~dp0."
exit /b 0
