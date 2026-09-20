/**
 * check-channels.js — preload ↔ main 通道一致性检查（防回归）
 *
 * 为什么需要：2026-09-19 一次大块代码替换把 main.js 里两个 ipcMain 处理器
 * （`pet:interactive` / `pet:save`）**静默删掉**了——它们不是 function 声明，
 * 语法检查（node --check）和"未定义函数扫描"都抓不到，结果是"打开面板后同屏窗口全都点不动"
 * 这种严重且难查的问题。这个脚本按 preload 的通道清单核对 main 侧是否齐活。
 *
 * 用法：node tools/check-channels.js         （退出码 0 = 通过）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const APP = process.env.PET_APP_DIR || path.join(__dirname, '..', 'app');
const pre = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');

const uniq = (a) => [...new Set(a)];
const sends = uniq([...pre.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1]));
const invokes = uniq([...pre.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]));
const listens = uniq([...pre.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]));

// 先剥掉注释，避免把注释里提到的旧写法当成真实调用（踩过这个误报）
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const mainCode = strip(main);

const mainOn = new Set([...mainCode.matchAll(/ipcMain\.on\('([^']+)'/g)].map((m) => m[1]));
const mainHandle = new Set([...mainCode.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));

const problems = [];
for (const c of sends) if (!mainOn.has(c)) problems.push(`主进程缺 ipcMain.on('${c}') 处理器（preload 会 send 它）`);
for (const c of invokes) if (!mainHandle.has(c)) problems.push(`主进程缺 ipcMain.handle('${c}') 处理器（preload 会 invoke 它）`);
for (const c of listens) {
  if (!main.includes(`'${c}'`)) problems.push(`主进程从不发送 '${c}'（preload 在监听它）`);
}
// 反向：main 发给页面 / 从页面收的通道是否都有对端
for (const c of mainOn) if (!sends.includes(c)) problems.push(`main 注册了 '${c}'，但 preload 从不 send 它（可能是残留）`);

// 关键的鼠标穿透开关必须存在且只有一处开关（这是"吞鼠标"事故的现场）
const ime = [...mainCode.matchAll(/setIgnoreMouseEvents\(([^)]*)\)/g)].map((m) => m[1].trim());
const guard = [];
if (!mainCode.includes("ipcMain.on('pet:interactive'")) guard.push("缺少 pet:interactive 处理器 → 窗口会永久吞鼠标");
if (ime.length > 2) guard.push(`setIgnoreMouseEvents 调用点 ${ime.length} 处（应 ≤2：初始化 + 交互开关）`);
if (!main.includes('focusWindow') && !main.includes("ipcMain.on('pet:focus'")) guard.push('缺少 pet:focus 处理器');

const bad = problems.length + guard.length;
console.log(`通道检查：preload send=${sends.length} invoke=${invokes.length} listen=${listens.length}`);
console.log(`          main  on=${mainOn.size} handle=${mainHandle.size}`);
console.log(`          setIgnoreMouseEvents 调用点 ${ime.length} 处：${ime.map((s) => '‘' + s + '’').join(', ')}`);
for (const p of problems) console.log('  ✘ ' + p);
for (const g of guard) console.log('  ✘ ' + g);
console.log(bad ? `\n===> 不通过（${bad} 项）` : '\n===> 全部通过 CHANNELS-PASS');
process.exit(bad ? 1 : 0);
