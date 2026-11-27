// apply.cmd 生成器（规格 §6）
//
// 一个纯函数：输入参数 → 返回脚本文本。不碰磁盘、不 require electron，方便单测。
// 调用方（update-engine.js）负责把文本写成 UTF-8 无 BOM 的 apply-<ts>.cmd 并 spawn。
//
// 铁律（都是踩过的坑）：
//   · 子进程 CWD 绝不能是安装目录 —— 脚本里第一件正事就是 cd 到更新目录；
//   · last-result.json 必须是纯 ASCII（cmd 重定向按当前代码页写字，塞中文就成 GBK 了），
//     所以 JSON 里只有版本号/结果/unix 秒/日志文件名，中文解释只进 .log；
//   · 路径可能含中文与空格 → 一律 " 包起来，且先 chcp 65001；
//   · 不依赖 PowerShell，只用 cmd 内建命令；sleep 只用 ping。
'use strict';

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** 20261127-171234（本地时间，用于文件名与日志） */
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 判断一个参数是否需要加引号（含空格/中文一律加，最稳） */
function quoteArg(a) {
  const s = String(a == null ? '' : a);
  if (!s) return '""';
  if (/^[^\s"]+$/.test(s) && !/[^\x00-\x7F]/.test(s)) return s;
  return '"' + s.replace(/"/g, '') + '"';
}

/** cmd 里 set 的值：set "VAR=value" 形式，值里不能有裸引号 */
function setLine(name, value) {
  return `set "${name}=${String(value == null ? '' : value).replace(/"/g, '')}"`;
}

/**
 * 带引号的值（重启参数）用普通 set 形式，保留内部引号；把 cmd 元字符转义掉，
 * 否则 `--user-data-dir=C:\a b` 这种带空格的参数会被 start 拆成两个。
 */
function setRawLine(name, value) {
  const s = String(value == null ? '' : value)
    .replace(/\^/g, '^^')
    .replace(/([&|<>])/g, '^$1');
  return `set ${name}=${s}`;
}

/**
 * 生成 apply.cmd 全文。
 * @param {Object} p
 * @param {string} p.installDir  安装目录绝对路径
 * @param {string} p.stageDir    staging 目录（内容就是包根）
 * @param {string} p.exeName     主 exe 文件名，如 桌宠.exe
 * @param {number} p.pid         当前进程 pid
 * @param {string} p.backupDir   备份目录（<install>.bak-<ts>）
 * @param {string} p.updateDir   %LOCALAPPDATA%\catwhale-update
 * @param {string} p.logName     apply-<ts>.log
 * @param {string} p.fromVersion
 * @param {string} p.toVersion
 * @param {string[]} [p.relaunchArgs] 重启时带上的原命令行参数（--user-data-dir / --remote-debugging-port 等）
 * @param {number} [p.atUnix]    生成时刻的 unix 秒（写进 last-result.json 的 at）
 */
function buildApplyCmd(p) {
  const o = p || {};
  const install = String(o.installDir || '');
  const stage = String(o.stageDir || '');
  const exe = String(o.exeName || '');
  const pid = Number(o.pid) || 0;
  const bak = String(o.backupDir || '');
  const updateDir = String(o.updateDir || '');
  const logName = String(o.logName || 'apply.log');
  const from = String(o.fromVersion || '');
  const to = String(o.toVersion || '');
  const at = Number.isFinite(o.atUnix) ? Math.floor(o.atUnix) : Math.floor(Date.now() / 1000);
  const args = (Array.isArray(o.relaunchArgs) ? o.relaunchArgs : []).map(quoteArg).join(' ');

  if (!install || !stage || !exe || !bak || !updateDir) {
    throw new Error('buildApplyCmd: installDir/stageDir/exeName/backupDir/updateDir 都是必填');
  }
  if (!/^[0-9A-Za-z._-]+\.log$/.test(logName)) {
    throw new Error('buildApplyCmd: logName 必须是纯 ASCII 文件名（cmd 重定向不认非 ASCII 里的花活）');
  }

  const L = [];
  L.push('@echo off');
  L.push('chcp 65001 >nul');
  L.push('setlocal enabledelayedexpansion');
  L.push('rem ================================================================');
  L.push('rem 猫鲸桌宠 在线升级脚本（应用生成，勿手改；协议见 在线升级-共享规格 §6）');
  L.push('rem 流程：等进程退出 -> 等文件解锁 -> 备份 -> 换入 -> 启动新版 -> 写结果 -> 清理');
  L.push('rem ================================================================');
  // 铁律：CWD 必须离开安装目录，否则 move 会把目标目录锁住
  L.push('cd /d "' + updateDir + '" 2>nul');
  L.push(setLine('INSTALL', install));
  L.push(setLine('STAGE', stage));
  L.push(setLine('EXE', exe));
  L.push(setLine('PID', pid));
  L.push(setLine('BAK', bak));
  L.push(setLine('UPDATEDIR', updateDir));
  L.push(setLine('LOGNAME', logName));
  L.push(setLine('LOG', updateDir + '\\' + logName));
  L.push(setLine('RESULT', updateDir + '\\last-result.json'));
  L.push(setLine('FROM', from));
  L.push(setLine('TO', to));
  L.push(setLine('AT', at));
  L.push(setRawLine('ARGS', args));   // 里面的引号要留着，否则带空格的 --flag="a b" 会被拆开
  L.push('set "STEP=0"');
  L.push('call :LOG "START from=%FROM% to=%TO% pid=%PID%"');
  L.push('call :LOG "INSTALL=%INSTALL%"');
  L.push('call :LOG "STAGE=%STAGE%"');
  L.push('call :LOG "BAK=%BAK%"');
  L.push('call :LOG "CWD=%CD%"');
  L.push('');
  // ---- 1. 等旧进程退出 ----
  L.push('rem ---- 1. 等旧进程退出（最多 180 秒；20 秒时 taskkill /F 兜底一次）----');
  L.push(':WAIT_PID');
  L.push('call :SLEEP');
  L.push('tasklist /FI "PID eq %PID%" /NH 2>nul | findstr /R /C:" %PID% " >nul');
  L.push('if errorlevel 1 goto WAIT_PID_DONE');
  L.push('set /a STEP+=1');
  L.push('if !STEP! EQU 20 (');
  L.push('  call :LOG "已等 20 秒进程仍在，执行一次 taskkill /F 兜底"');
  L.push('  taskkill /PID %PID% /F >nul 2>&1');
  L.push(')');
  L.push('if !STEP! GEQ 180 (');
  L.push('  call :LOG "等旧进程退出超时（180 秒），放弃升级"');
  L.push('  goto FAILED');
  L.push(')');
  L.push('goto WAIT_PID');
  L.push(':WAIT_PID_DONE');
  L.push('call :LOG "旧进程已退出（等了 !STEP! 个 tick）"');
  L.push('');
  // ---- 2. 等文件解锁 ----
  L.push('rem ---- 2. 等主程序文件解锁（ren 出去再 ren 回来，最多 60 秒）----');
  L.push('set "STEP=0"');
  L.push(':WAIT_FILE');
  L.push('if not exist "%INSTALL%\\%EXE%" goto WAIT_FILE_DONE');
  L.push('ren "%INSTALL%\\%EXE%" "%EXE%.cwtest" >nul 2>&1');
  L.push('if not errorlevel 1 goto FILE_UNLOCKED');
  L.push('set /a STEP+=1');
  L.push('if !STEP! GEQ 60 (');
  L.push('  call :LOG "等主程序解锁超时（60 秒），放弃升级"');
  L.push('  goto FAILED');
  L.push(')');
  L.push('call :SLEEP');
  L.push('goto WAIT_FILE');
  L.push(':FILE_UNLOCKED');
  L.push('ren "%INSTALL%\\%EXE%.cwtest" "%EXE%" >nul 2>&1');
  L.push('call :LOG "主程序已解锁（等了 !STEP! 个 tick）"');
  L.push(':WAIT_FILE_DONE');
  L.push('');
  // ---- 3. 备份 ----
  L.push('rem ---- 3. 备份旧目录（失败就写 failed，不启动任何东西）----');
  L.push('set "STEP=0"');
  L.push(':BACKUP');
  L.push('move "%INSTALL%" "%BAK%" >nul 2>&1');
  L.push('if not errorlevel 1 goto BACKUP_DONE');
  L.push('set /a STEP+=1');
  L.push('if !STEP! GEQ 20 (');
  L.push('  call :LOG "备份失败：旧目录无法移动（可能仍被别的进程占用），旧目录保持原状"');
  L.push('  goto FAILED');
  L.push(')');
  L.push('call :SLEEP');
  L.push('goto BACKUP');
  L.push(':BACKUP_DONE');
  L.push('call :LOG "已备份旧目录 -> %BAK%"');
  L.push('');
  // ---- 4. 换入 ----
  L.push('rem ---- 4. 换入新目录（失败就回滚 + 重启旧版）----');
  L.push('move "%STAGE%" "%INSTALL%" >nul 2>&1');
  L.push('if not errorlevel 1 goto SWAP_DONE');
  L.push('call :LOG "换入失败，开始回滚"');
  L.push('move "%BAK%" "%INSTALL%" >nul 2>&1');
  L.push('if errorlevel 1 (');
  L.push('  call :LOG "回滚失败！旧目录保留在 %BAK%，请手动改名回去"');
  L.push(') else (');
  L.push('  call :LOG "已回滚到旧版本"');
  L.push(')');
  L.push('call :WRITE_RESULT failed swap-failed');
  L.push('set "STEP=0"');
  L.push('goto START_OLD');
  L.push(':SWAP_DONE');
  L.push('call :LOG "已换入新目录"');
  L.push('');
  // ---- 5. 启动新版 ----
  L.push('rem ---- 5. 启动新版（最多 5 次）----');
  L.push('set "STEP=0"');
  L.push(':START_NEW');
  L.push('start "" "%INSTALL%\\%EXE%" %ARGS%');
  L.push('call :SLEEP');
  L.push('tasklist /FI "IMAGENAME eq %EXE%" /NH 2>nul | findstr /I /C:"%EXE%" >nul');
  L.push('if not errorlevel 1 goto STARTED');
  L.push('set /a STEP+=1');
  L.push('if !STEP! GEQ 5 (');
  L.push('  call :LOG "新版本启动失败（重试 5 次），回滚"');
  L.push('  goto ROLLBACK_START');
  L.push(')');
  L.push('call :LOG "新版本没起来，重试（第 !STEP! 次）"');
  L.push('goto START_NEW');
  L.push(':STARTED');
  L.push('call :LOG "新版本已启动"');
  L.push('call :WRITE_RESULT ok ""');
  L.push('call :CLEANUP_BAK');
  L.push('goto DONE');
  L.push('');
  L.push(':ROLLBACK_START');
  L.push('move "%INSTALL%" "%BAK%.new" >nul 2>&1');
  L.push('move "%BAK%" "%INSTALL%" >nul 2>&1');
  L.push('if errorlevel 1 (');
  L.push('  call :LOG "回滚失败！旧目录在 %BAK%，新目录在 %BAK%.new"');
  L.push(') else (');
  L.push('  call :LOG "已回滚到旧版本"');
  L.push(')');
  L.push('call :WRITE_RESULT failed start-failed');
  L.push('set "STEP=0"');
  L.push(':START_OLD');
  L.push('if not exist "%INSTALL%\\%EXE%" goto DONE');
  L.push('start "" "%INSTALL%\\%EXE%" %ARGS%');
  L.push('call :SLEEP');
  L.push('tasklist /FI "IMAGENAME eq %EXE%" /NH 2>nul | findstr /I /C:"%EXE%" >nul');
  L.push('if not errorlevel 1 goto DONE');
  L.push('set /a STEP+=1');
  L.push('if !STEP! GEQ 5 goto DONE');
  L.push('goto START_OLD');
  L.push('');
  L.push(':FAILED');
  L.push('call :WRITE_RESULT failed wait-or-move-failed');
  L.push('goto DONE');
  L.push('');
  // ---- 子程序 ----
  L.push('rem ---- 子程序 ----');
  L.push(':WRITE_RESULT');
  L.push('> "%RESULT%" echo {"from":"%FROM%","to":"%TO%","result":"%~1","at":%AT%,"log":"%LOGNAME%","logPath":"%LOGNAME%","error":"%~2"}');
  L.push('call :LOG "结果已写入 %RESULT%（result=%~1 error=%~2）"');
  L.push('exit /b 0');
  L.push('');
  L.push(':CLEANUP_BAK');
  L.push('rmdir /s /q "%BAK%" >nul 2>&1');
  L.push('if exist "%BAK%" (');
  L.push('  call :LOG "旧目录未能删除，保留：%BAK%"');
  L.push(') else (');
  L.push('  call :LOG "已清理旧目录"');
  L.push(')');
  L.push('exit /b 0');
  L.push('');
  L.push(':SLEEP');
  L.push('ping -n 2 127.0.0.1 >nul');
  L.push('exit /b 0');
  L.push('');
  L.push(':LOG');
  L.push('>>"%LOG%" echo [%DATE% %TIME%] %~1');
  L.push('exit /b 0');
  L.push('');
  L.push(':DONE');
  L.push('call :LOG "脚本结束"');
  L.push('exit /b 0');
  return L.join('\r\n') + '\r\n';
}

module.exports = { buildApplyCmd, stamp, quoteArg };
