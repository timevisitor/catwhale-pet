// apply.cmd 生成器的单元测试（规格 §6）
// 两条实测出来的硬约束：脚本正文必须纯 ASCII（cmd 按字节跟踪读取位置，多字节会错位）；
// 应用是 detached + windowsHide + stdio:ignore 起的，**没有控制台** → chcp 65001 不生效，
// 所以中文路径不能走文件/代码页，必须由父进程用环境变量传（CreateProcess 走 UTF-16）。
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

const built = buildApplyCmd(BASE);
const text = built.cmd;
const lines = text.split('\r\n');          // 脚本必须是 CRLF，cmd 才认
const L = (s) => lines.includes(s);

test('stamp 是纯 ASCII 的时间戳', () => {
  assert.match(stamp(new Date(2026, 10, 27, 17, 12, 34)), /^20261127-171234$/);
});

test('脚本正文必须纯 ASCII（cmd + 多字节 = 解析错位）', () => {
  assert.ok(!/[^\x00-\x7F]/.test(text), '脚本文本里出现了非 ASCII 字符');
});

test('中文路径走环境变量：5 个 CW_* 值原样给出，脚本里只做 set 固定', () => {
  assert.equal(built.env.CW_INSTALL, BASE.installDir);
  assert.equal(built.env.CW_STAGE, BASE.stageDir);
  assert.equal(built.env.CW_EXE, BASE.exeName);
  assert.equal(built.env.CW_BAK, BASE.backupDir);
  assert.equal(built.env.CW_ARGS, '');
  assert.ok(L('set "INSTALL=%CW_INSTALL%"'));
  assert.ok(L('set "STAGE=%CW_STAGE%"'));
  assert.ok(L('set "EXE=%CW_EXE%"'));
  assert.ok(L('set "BAK=%CW_BAK%"'));
  assert.ok(L('set "ARGS=%CW_ARGS%"'));
});

test('脚本头：@echo off / chcp 65001 / setlocal enabledelayedexpansion', () => {
  assert.equal(lines[0], '@echo off');
  assert.equal(lines[1], 'chcp 65001 >nul');
  assert.equal(lines[2], 'setlocal enabledelayedexpansion');
});

test('cwd 第一条正事就是离开安装目录（否则 move 会锁住目标目录）', () => {
  assert.ok(L('cd /d "%~dp0" 2>nul'), '必须 cd 到脚本自己所在的更新目录');
  assert.ok(!/cd \/d "[A-Z]:\\投递/.test(text), '不许 cd 到安装目录');
});

test('§6 的 ASCII 参数是脚本内固定值', () => {
  assert.ok(L('set "PID=4321"'));
  assert.ok(L('set "FROM=0.7.1"'));
  assert.ok(L('set "TO=0.7.2"'));
  assert.ok(L('set "AT=1764231154"'));
  assert.ok(L('set "LOGNAME=apply-20261127-171234.log"'));
  assert.ok(L('set "LOG=%~dp0apply-20261127-171234.log"'));
  assert.ok(L('set "RESULT=%~dp0last-result.json"'));
});

test('日志第一行是 START from/to/pid', () => {
  assert.ok(L('call :LOG "START from=%FROM% to=%TO% pid=%PID%"'));
});

test('无控制台：脚本里不许有管道，也不许依赖 tasklist / findstr', () => {
  assert.ok(!text.includes('|'), '管道在无控制台的 cmd 里会永久挂住');
  const code = lines.filter((l) => !/^rem /.test(l)).join('\n');
  assert.ok(!/tasklist/i.test(code), 'tasklist 在无控制台时输出为空，判定会永远为假');
  assert.ok(!/findstr/i.test(code), 'findstr 在无控制台时同样无输出');
  assert.ok(L('chcp 65001 >nul'), 'chcp 65001 保留（规格要求；无控制台时它静默失败也无害）');
});

test('§6.1+6.2 等旧进程退出/文件解锁 → 用 move 重试充当真正的门（60 秒）', () => {
  assert.ok(L(':BACKUP'));
  assert.ok(L('move "%INSTALL%" "%BAK%" >nul 2>&1'));
  assert.ok(L('if !STEP! GEQ 60 ('));
  assert.ok(L('  call :LOG "backup failed after 60s: install dir still in use, left untouched"'));
});

test('启动判定用 start 的退出码（ren 判不了：重命名正在运行的 exe 是允许的）', () => {
  const i = lines.indexOf(':START_NEW');
  assert.ok(i > 0);
  const body = lines.slice(i, lines.indexOf(':ROLLBACK_START')).join('\n');
  assert.match(body, /start "" "%INSTALL%\\%EXE%" %ARGS%/);
  assert.match(body, /if not errorlevel 1 goto STARTED/);
  assert.match(body, /if !STEP! GEQ 5 \(/);
});

test('§6.3-6.5 备份 / 换入 / 回滚 / 启动新版（最多 5 次）', () => {
  assert.ok(L('move "%INSTALL%" "%BAK%" >nul 2>&1'));
  assert.ok(L('move "%STAGE%" "%INSTALL%" >nul 2>&1'));
  assert.ok(L('move "%BAK%" "%INSTALL%" >nul 2>&1'));
  assert.ok(L('start "" "%INSTALL%\\%EXE%" %ARGS%'));
  assert.ok(L('if !STEP! GEQ 5 ('));
});

test('§6.3 备份失败不启动任何东西（只写 failed）', () => {
  const iFail = lines.indexOf(':FAILED');
  assert.ok(iFail > 0);
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
  assert.ok(!/[^\x00-\x7F]/.test(line), 'JSON 行里不许有非 ASCII');
  assert.ok(!/INSTALL|STAGE|BAK=|%~dp0/.test(line), 'JSON 里不许塞完整路径');
});

test('§6.7 成功后清理旧目录，失败只保留不报错', () => {
  assert.ok(L('rmdir /s /q "%BAK%" >nul 2>&1'));
  const i = lines.indexOf(':CLEANUP_BAK');
  const j = lines.indexOf(':SLEEP');
  assert.ok(i > 0 && j > i);
  assert.match(lines.slice(i, j).join('\n'), /could not be removed/);
});

test('§6.9 不依赖 PowerShell，sleep 只用 ping', () => {
  assert.ok(!/powershell|pwsh|wmic/i.test(text), '脚本里不许出现 PowerShell / wmic');
  assert.ok(L('ping -n 2 127.0.0.1 >nul'));
});

test('重启带原命令行参数（--user-data-dir / --remote-debugging-port 不能丢）', () => {
  const b2 = buildApplyCmd({
    ...BASE,
    relaunchArgs: ['--user-data-dir=C:\\Users\\u\\AppData\\Roaming\\x', '--remote-debugging-port=9333'],
  });
  assert.equal(b2.env.CW_ARGS, '--user-data-dir=C:\\Users\\u\\AppData\\Roaming\\x --remote-debugging-port=9333');
  const b3 = buildApplyCmd({ ...BASE, relaunchArgs: ['--user-data-dir=C:\\a b\\x'] });
  assert.equal(b3.env.CW_ARGS, '"--user-data-dir=C:\\a b\\x"', '含空格的参数必须带引号，否则 start 会拆成两个');
});

test('参数缺失或日志名非 ASCII 时直接报错（不生成半截脚本）', () => {
  assert.throws(() => buildApplyCmd({ ...BASE, installDir: '' }), /必填/);
  assert.throws(() => buildApplyCmd({ ...BASE, logName: '日志.log' }), /纯 ASCII/);
});

test('quoteArg 的引号规则', () => {
  assert.equal(quoteArg('--flag'), '--flag');
  assert.equal(quoteArg('C:\\a b'), '"C:\\a b"');
  assert.equal(quoteArg('桌宠'), '"桌宠"');
  assert.equal(quoteArg(''), '""');
});
