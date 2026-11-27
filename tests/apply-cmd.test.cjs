// apply.cmd 生成器的单元测试（规格 §6）
// 断言的是「脚本必须有的关键行」：中文路径加引号、chcp 65001、cwd 离开安装目录、
// 等进程退出 / 等文件解锁 / 备份 / 换入 / 回滚 / 清理 / 纯 ASCII 的 last-result.json。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApplyCmd, stamp, quoteArg } = require('../app/apply-cmd.js');

const BASE = {
  installDir: 'H:\\投递\\桌宠 目录\\桌宠',
  stageDir: 'C:\\Users\\u\\AppData\\Local\\catwhale-update\\v0.7.2\\staging',
  exeName: '桌宠.exe',
  pid: 4321,
  backupDir: 'H:\\投递\\桌宠 目录\\桌宠.bak-20261127-171234',
  updateDir: 'C:\\Users\\u\\AppData\\Local\\catwhale-update',
  logName: 'apply-20261127-171234.log',
  fromVersion: '0.7.1',
  toVersion: '0.7.2',
  atUnix: 1764231154,
};

const text = buildApplyCmd(BASE);
const lines = text.split('\r\n');          // 行数组（脚本必须是 CRLF，cmd 才认）
const L = (s) => lines.includes(s);

test('stamp 是纯 ASCII 的时间戳', () => {
  assert.match(stamp(new Date(2026, 10, 27, 17, 12, 34)), /^20261127-171234$/);
});

test('脚本头：@echo off / chcp 65001 / setlocal enabledelayedexpansion', () => {
  assert.equal(lines[0], '@echo off');
  assert.equal(lines[1], 'chcp 65001 >nul');
  assert.equal(lines[2], 'setlocal enabledelayedexpansion');
});

test('cwd 第一条正事就是离开安装目录（否则 move 会锁住目标目录）', () => {
  assert.ok(L('cd /d "C:\\Users\\u\\AppData\\Local\\catwhale-update" 2>nul'),
    '必须 cd 到更新目录，不能在安装目录里跑');
  assert.ok(!lines.some((l) => /^cd \/d "H:\\/.test(l)), '不许 cd 到安装目录');
});

test('§6 的参数全部是脚本内固定值', () => {
  assert.ok(L('set "INSTALL=H:\\投递\\桌宠 目录\\桌宠"'));
  assert.ok(L('set "STAGE=C:\\Users\\u\\AppData\\Local\\catwhale-update\\v0.7.2\\staging"'));
  assert.ok(L('set "EXE=桌宠.exe"'));
  assert.ok(L('set "PID=4321"'));
  assert.ok(L('set "BAK=H:\\投递\\桌宠 目录\\桌宠.bak-20261127-171234"'));
  assert.ok(L('set "LOG=C:\\Users\\u\\AppData\\Local\\catwhale-update\\apply-20261127-171234.log"'));
  assert.ok(L('set "RESULT=C:\\Users\\u\\AppData\\Local\\catwhale-update\\last-result.json"'));
  assert.ok(L('set "FROM=0.7.1"'));
  assert.ok(L('set "TO=0.7.2"'));
});

test('日志第一行是 START from/to/pid', () => {
  assert.ok(L('call :LOG "START from=%FROM% to=%TO% pid=%PID%"'),
    '规格 §6.10：日志第一条必须是 START from=.. to=.. pid=..');
});

test('§6.1 等进程退出：tasklist /FI PID + 180 秒上限 + 20 秒 taskkill 兜底', () => {
  assert.ok(L('tasklist /FI "PID eq %PID%" /NH 2>nul | findstr /R /C:" %PID% " >nul'));
  assert.ok(L('if !STEP! GEQ 180 ('));
  assert.ok(L('if !STEP! EQU 20 ('));
  assert.ok(lines.some((l) => l.trim() === 'taskkill /PID %PID% /F >nul 2>&1'));
});

test('§6.2 等文件解锁：ren 出去再 ren 回来，最多 60 秒', () => {
  assert.ok(L('ren "%INSTALL%\\%EXE%" "%EXE%.cwtest" >nul 2>&1'));
  assert.ok(L('ren "%INSTALL%\\%EXE%.cwtest" "%EXE%" >nul 2>&1'));
  assert.ok(L('if !STEP! GEQ 60 ('));
});

test('§6.3-6.5 备份 / 换入 / 失败回滚 / 启动新版（最多 5 次）', () => {
  assert.ok(L('move "%INSTALL%" "%BAK%" >nul 2>&1'));
  assert.ok(L('move "%STAGE%" "%INSTALL%" >nul 2>&1'));
  assert.ok(L('move "%BAK%" "%INSTALL%" >nul 2>&1'));
  assert.ok(L('start "" "%INSTALL%\\%EXE%" %ARGS%'));
  assert.ok(L('if !STEP! GEQ 5 ('));
});

test('§6.3 备份失败不启动任何东西（只写 failed）', () => {
  const iFail = lines.indexOf(':FAILED');
  const iBak = lines.indexOf(':BACKUP_DONE');
  assert.ok(iFail > 0 && iBak > 0);
  const body = lines.slice(iFail, lines.indexOf(':WRITE_RESULT')).join('\n');
  assert.match(body, /call :WRITE_RESULT failed/);
  assert.ok(!/start ""/.test(body), '失败分支里不能出现 start');
});

test('§6.6 结果 JSON 是纯 ASCII：只有版本号/结果/unix 秒/日志文件名', () => {
  const line = lines.find((l) => l.startsWith('> "%RESULT%" echo {'));
  assert.ok(line, '必须有一条写 last-result.json 的行');
  assert.match(line, /"result":"%~1"/);
  assert.match(line, /"at":%AT%/);
  assert.match(line, /"log":"%LOGNAME%"/);
  assert.ok(!/[\u4e00-\u9fa5]/.test(line), 'JSON 行里不许有中文（cmd 会按 GBK 写，读端按 UTF-8 就废）');
  assert.ok(!/INSTALL|STAGE|BAK=|C:\\/.test(line), 'JSON 里不许塞完整路径');
  assert.ok(L('set "AT=1764231154"'));
});

test('§6.7 成功后清理旧目录，失败只保留不报错', () => {
  assert.ok(L('rmdir /s /q "%BAK%" >nul 2>&1'));
  const i = lines.indexOf(':CLEANUP_BAK');
  const j = lines.indexOf(':SLEEP');
  assert.ok(i > 0 && j > i);
  assert.match(lines.slice(i, j).join('\n'), /旧目录未能删除/);
});

test('§6.9 不依赖 PowerShell，sleep 只用 ping', () => {
  assert.ok(!/powershell|pwsh|wmic/i.test(text), '脚本里不许出现 PowerShell / wmic');
  assert.ok(L('ping -n 2 127.0.0.1 >nul'));
});

test('重启时带上原命令行参数（--user-data-dir / --remote-debugging-port 不能丢）', () => {
  const t2 = buildApplyCmd({
    ...BASE,
    relaunchArgs: ['--user-data-dir=C:\\Users\\u\\AppData\\Roaming\\x', '--remote-debugging-port=9333'],
  });
  assert.ok(t2.includes('set ARGS=--user-data-dir=C:\\Users\\u\\AppData\\Roaming\\x --remote-debugging-port=9333'));
  const t3 = buildApplyCmd({ ...BASE, relaunchArgs: ['--user-data-dir=C:\\a b\\x'] });
  assert.ok(t3.includes('set ARGS="--user-data-dir=C:\\a b\\x"'), '含空格的参数必须带引号，否则 start 会拆成两个');
});

test('参数缺失或 logName 非 ASCII 时直接报错（不生成半截脚本）', () => {
  assert.throws(() => buildApplyCmd({ ...BASE, installDir: '' }), /必填/);
  assert.throws(() => buildApplyCmd({ ...BASE, logName: '日志.log' }), /纯 ASCII/);
});

test('quoteArg 的引号规则', () => {
  assert.equal(quoteArg('--flag'), '--flag');
  assert.equal(quoteArg('C:\\a b'), '"C:\\a b"');
  assert.equal(quoteArg('桌宠'), '"桌宠"');
  assert.equal(quoteArg(''), '""');
});
